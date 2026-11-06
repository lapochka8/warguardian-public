import {
  promises as fs,
  createReadStream,
  createWriteStream,
  constants,
} from 'node:fs';
import {
  resolve,
  join,
  dirname,
  relative,
  isAbsolute,
  basename,
} from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { loadavg } from 'node:os';
import { z } from 'zod';
import {
  reforgerHostCommand,
  reforgerLogDownloadMax,
  reforgerLogPageMax,
  reforgerLogSession,
  reforgerLogSource,
  reforgerLogsCapability,
  reforgerMod,
  reforgerModpack,
  reforgerScenarioAddonsCapability,
  type reforgerScenarioPreset,
  type reforgerModpackReport,
  type reforgerPackRevision,
  type reforgerLifecycleEvent,
  type reforgerModUpdateEntry,
} from '../games/reforger-host';
import {
  redactReforgerConfig as redactConfig,
  reforgerKeepSecret as keepSecret,
  reforgerSecretKey as secretKey,
  validateReforgerHostConfig,
} from '../games/reforger-host-config';
import { createReforgerWorkshopClient } from './reforger-workshop';
import { readReforgerJournal } from './reforger-telemetry';
import { convertReforgerHostArchive } from './reforger-archive';
import { createReforgerModCache } from './reforger-mod-cache';
import {
  ownedReforgerJobActive,
  runReforgerOwnedUpdate,
} from './reforger-owned-job';
import {
  createReforgerConsoleWatcher,
  createReforgerGameEventAssembler,
  type ReforgerGameEvent,
  type ReforgerStatsSample,
} from './reforger-stability';
import {
  readReforgerScenarioListing,
  type ScenarioSource,
} from '../games/reforger-scenarios';
import {
  reforgerScannedScenarios,
  reforgerScenarioScanAddons,
  reforgerScenarioScanArguments,
  reforgerServerDataScenarios,
  type ReforgerScanAddon,
} from './reforger-scenario-scan';
import {
  createReforgerInstanceRegistry,
  reforgerConfigPorts,
} from './reforger-instances';
import {
  createReforgerResourceSampler,
  type ReforgerResourceSample,
} from './reforger-resources';
import {
  listReforgerLogSessions,
  readReforgerLogRange,
  redactReforgerLogText,
  reforgerConfigSecrets,
  reforgerLogFiles,
  reforgerLogSize,
  rotateReforgerConsole,
} from './reforger-logs';

type Options = {
  serverName: string;
  serverId?: string;
  profile: string;
  config: string;
  executable: string;
  stateDirectory: string;
  steamcmd?: string;
  installDirectory?: string;
  maxFps?: number;
  logStatsMs?: number;
  telemetryAddonsDirectory?: string;
  instancesDirectory?: string;
  workshopClient?: ReturnType<typeof createReforgerWorkshopClient>;
  /** Console rotation limits. Tests use small values. */
  logRotation?: { maxBytes?: number; keepBytes?: number; intervalMs?: number };
  /** Starts the game process of a scenario scan. Tests replace the game. */
  spawnScenarioScan?: typeof spawn;
};
type Job = {
  id: string;
  action: string;
  state: 'running' | 'succeeded' | 'failed' | 'unknown';
  message: string;
  group?: number;
};
type State = {
  version: 1;
  process: {
    pid: number;
    start: string;
    configRevision?: string;
    launchedAt?: number;
    logStats?: boolean;
  } | null;
  lifecycle?: z.infer<typeof reforgerLifecycleEvent>[];
  lifecycleSeq?: number;
  stabilityGeneration?: string;
  /** Changes each time `console.log` is truncated in place. */
  consoleGeneration?: string;
  addressSalt?: string;
  modUpdates?: {
    checkedAt: number;
    error: string | null;
    mods: z.infer<typeof reforgerModUpdateEntry>[];
  } | null;
  autoRestart: boolean;
  restartTimes?: number[];
  job: Job | null;
  jobs?: Job[];
  modpacks: z.infer<typeof reforgerModpack>[];
  scenarios?: z.infer<typeof reforgerScenarioPreset>[];
  rotation?: { order: string[]; next: number };
  nextSave?: { mode: 'default' | 'save' | 'fresh'; saveId: string | null };
  saveArchive?: {
    id: string;
    scenario: string;
    playthrough: string;
    at: number;
    bytes: number;
  }[];
  discoveredScenarios?: {
    at: number;
    items: {
      scenarioId: string;
      name: string | null;
      source?: ScenarioSource;
    }[];
    error: string | null;
    /** The modpack whose cached mods the scan loaded. */
    modpackId?: string | null;
  } | null;
  modpackHistory?: z.infer<typeof reforgerPackRevision>[];
  modpackReports?: Record<string, z.infer<typeof reforgerModpackReport>>;
  backups: {
    id: string;
    at: number;
    bytes: number;
    files: number;
    sha256: string;
    source?: 'reforger-host-v1';
  }[];
  backupUpload?: {
    id: string;
    name: string;
    bytes: number;
    at: number;
    excludedManifest?: string[];
  } | null;
  importDraft?: {
    backupId: string;
    source: 'reforger-host-v1';
    config: Record<string, unknown>;
    excluded: string[];
    omitted: number;
  } | null;
  receipts: Record<
    string,
    { ok: true; message: string; jobId?: string } | null
  >;
};
const hash = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const safeRelative = (value: string, empty = false) => {
  if (
    (empty && value === '') ||
    (value.length <= 512 &&
      value !== '' &&
      !value.includes('\\') &&
      !value.includes(':') &&
      !value.includes('\0') &&
      !isAbsolute(value) &&
      value
        .split('/')
        .every((part) => part !== '.' && part !== '..' && part !== ''))
  )
    return value;
  throw new Error('Use a relative path inside this server profile.');
};
async function exists(path: string) {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function syncDirectory(path: string) {
  if (process.platform !== 'linux') return;
  const directory = await fs.open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function atomic(path: string, text: string | Uint8Array) {
  const temp = `${path}.wg-${randomUUID()}`,
    handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temp, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}
function restoreSecrets(value: unknown, previous: unknown): unknown {
  if (value === keepSecret) {
    if (typeof previous !== 'string')
      throw new Error(
        'A hidden secret no longer exists. Reload configuration.',
      );
    return previous;
  }
  if (Array.isArray(value))
    return value.map((item, index) =>
      restoreSecrets(
        item,
        Array.isArray(previous) ? previous[index] : undefined,
      ),
    );
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        restoreSecrets(item, object(previous)[key]),
      ]),
    );
  return value;
}

// The configuration rules are shared with the panel. They stay exported
// here for the callers of this module.
export {
  redactReforgerConfig,
  reforgerKeepSecret,
  reforgerSecretKey,
  validateReforgerHostConfig,
} from '../games/reforger-host-config';

export async function createReforgerHostController(options: Options) {
  const profile = resolve(options.profile),
    configPath = resolve(options.config),
    stateRoot = resolve(options.stateDirectory),
    exe = resolve(options.executable);
  if (
    !options.serverName ||
    !isAbsolute(options.profile) ||
    !isAbsolute(options.config) ||
    !isAbsolute(options.stateDirectory) ||
    !isAbsolute(options.executable)
  )
    throw new Error('Use absolute host paths and the configured server name.');
  if (
    stateRoot === profile ||
    (!relative(profile, stateRoot).startsWith('..') &&
      !isAbsolute(relative(profile, stateRoot)))
  )
    throw new Error(
      'Agent state and backups must be outside the game profile.',
    );
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(dirname(profile), { recursive: true });
  if (
    (await fs.realpath(stateRoot)) !== stateRoot ||
    (await fs.realpath(dirname(profile))) !== dirname(profile)
  )
    throw new Error(
      'Use canonical agent state and profile-parent paths without symlinks.',
    );
  const journalPath = join(stateRoot, 'restore-journal.json');
  if (await exists(journalPath)) {
    const journal = z
      .object({
        profile: z.string(),
        staging: z.string(),
        predecessor: z.string(),
      })
      .parse(JSON.parse(await fs.readFile(journalPath, 'utf8')));
    if (
      journal.profile !== profile ||
      dirname(journal.staging) !== dirname(profile) ||
      !basename(journal.staging).startsWith('.wg-reforger-restore-') ||
      dirname(journal.predecessor) !== dirname(profile) ||
      !journal.predecessor.startsWith(profile + '.wg-before-') ||
      !z
        .uuid()
        .safeParse(journal.predecessor.slice((profile + '.wg-before-').length))
        .success
    )
      throw new Error(
        'Restore recovery paths do not match the configured profile. Inspect the host before continuing.',
      );
    const current = await exists(profile),
      previous = await exists(journal.predecessor),
      staging = await exists(journal.staging);
    for (const path of [profile, journal.predecessor, journal.staging])
      if ((await exists(path)) && (await fs.lstat(path)).isSymbolicLink())
        throw new Error('Restore recovery paths cannot be symlinks.');
    if (!current && previous) {
      await fs.rename(journal.predecessor, profile);
      await syncDirectory(dirname(profile));
    } else if (!current || (current && previous && staging))
      throw new Error(
        'Restore recovery is ambiguous. Source profiles are retained for host inspection.',
      );
    if (staging) {
      if ((await fs.lstat(journal.staging)).isSymbolicLink())
        throw new Error('Restore recovery staging is a symlink.');
      await fs.rm(journal.staging, { recursive: true, force: true });
    }
    await fs.unlink(journalPath);
    await syncDirectory(stateRoot);
  }
  await fs.mkdir(profile, { recursive: true });
  if (
    (await fs.realpath(profile)) !== profile ||
    (await fs.realpath(stateRoot)) !== stateRoot
  )
    throw new Error(
      'Profile and agent state paths must be canonical paths without symlinks.',
    );
  const statePath = join(stateRoot, 'state.json'),
    logPath = join(stateRoot, 'console.log');
  let state: State = {
    version: 1,
    process: null,
    autoRestart: false,
    job: null,
    modpacks: [],
    backups: [],
    receipts: {},
  };
  if (await exists(statePath)) {
    const saved = JSON.parse(await fs.readFile(statePath, 'utf8')) as State;
    if (saved.version !== 1)
      throw new Error('Unsupported WarGuardian Agent state.');
    state = saved;
    if (state.job?.state === 'running')
      state.job = {
        ...state.job,
        state: 'unknown',
        message:
          'The WarGuardian Agent restarted during this job. Inspect the host. The job is not sent again.',
      };
  }
  let queue = Promise.resolve(),
    child: ChildProcess | undefined,
    jobAbort: AbortController | undefined,
    activeJob: Promise<unknown> | undefined,
    closing = false,
    maintenance = false;
  const workshop = options.workshopClient ?? createReforgerWorkshopClient();
  state.modpackReports ??= {};
  state.modpackHistory ??= [];
  function rememberPack(pack: z.infer<typeof reforgerModpack>) {
    const revision = hash(JSON.stringify(pack));
    state.modpackHistory = [
      { revision, at: Date.now(), pack },
      ...state.modpackHistory!.filter(
        (entry) => !(entry.pack.id === pack.id && entry.revision === revision),
      ),
    ].slice(0, 50);
    while (Buffer.byteLength(JSON.stringify(state.modpackHistory)) > 200000)
      state.modpackHistory.pop();
  }
  function validateLibrary(
    packs: State['modpacks'],
    reports: NonNullable<State['modpackReports']>,
  ) {
    if (
      Buffer.byteLength(
        JSON.stringify({ modpacks: packs, reports: Object.values(reports) }),
      ) > 650000
    )
      throw new Error(
        'This modpack library reached its transfer limit. Export and remove an unused pack before adding more content.',
      );
  }
  state.jobs ??= [];
  state.scenarios ??= [];
  state.rotation ??= { order: [], next: 0 };
  state.discoveredScenarios ??= null;
  state.nextSave ??= { mode: 'default', saveId: null };
  state.saveArchive ??= [];
  state.lifecycle ??= [];
  state.lifecycleSeq ??= 0;
  state.stabilityGeneration ??= randomUUID();
  state.consoleGeneration ??= randomBytes(8).toString('hex');
  state.addressSalt ??= randomBytes(32).toString('hex');
  state.modUpdates ??= null;
  const logStatsMs = Math.max(0, Math.min(600000, options.logStatsMs ?? 60000));
  const performancePath = join(stateRoot, 'performance.json');
  type StoredSample = ReforgerStatsSample & { seq: number; at: number };
  let performance: StoredSample[] = [],
    performanceSeq = 0,
    performanceSavedAt = 0;
  try {
    const saved = JSON.parse(await fs.readFile(performancePath, 'utf8')) as {
      seq?: number;
      samples?: StoredSample[];
    };
    performance = Array.isArray(saved.samples) ? saved.samples.slice(-720) : [];
    performanceSeq = Number(saved.seq) || performance.at(-1)?.seq || 0;
  } catch {
    performance = [];
  }
  const instances = createReforgerInstanceRegistry({
    directory: resolve(
      options.instancesDirectory ??
        join(dirname(exe), '.warguardian-instances'),
    ),
    serverId: options.serverId ?? options.serverName,
    serverName: options.serverName,
    profile,
    config: configPath,
  });
  async function announce() {
    let ports = null;
    try {
      ports = reforgerConfigPorts((await readConfig()).raw);
    } catch {
      ports = null;
    }
    await instances.write({ gamePid: state.process?.pid ?? null, ports });
  }
  const resourcesPath = join(stateRoot, 'resources.json');
  type StoredResource = ReforgerResourceSample & { seq: number; at: number };
  let resources: StoredResource[] = [],
    resourceSeq = 0,
    resourcesSavedAt = 0;
  try {
    const saved = JSON.parse(await fs.readFile(resourcesPath, 'utf8')) as {
      seq?: number;
      samples?: StoredResource[];
    };
    resources = Array.isArray(saved.samples) ? saved.samples.slice(-1440) : [];
    resourceSeq = Number(saved.seq) || resources.at(-1)?.seq || 0;
  } catch {
    resources = [];
  }
  const sampleResources = createReforgerResourceSampler({
    disks: [
      { label: 'Game profile', path: profile },
      { label: 'Agent state', path: stateRoot },
      ...(options.installDirectory
        ? [{ label: 'Game install', path: resolve(options.installDirectory) }]
        : []),
    ],
    pid: () => state.process?.pid ?? null,
  });
  function recordEvent(
    event: Omit<
      z.infer<typeof reforgerLifecycleEvent>,
      | 'seq'
      | 'at'
      | 'pid'
      | 'code'
      | 'signal'
      | 'uptimeSeconds'
      | 'configRevision'
      | 'logStats'
      | 'mods'
    > &
      Partial<z.infer<typeof reforgerLifecycleEvent>>,
  ) {
    state.lifecycleSeq = (state.lifecycleSeq ?? 0) + 1;
    state.lifecycle = [
      ...state.lifecycle!,
      {
        pid: null,
        code: null,
        signal: null,
        uptimeSeconds: null,
        configRevision: null,
        logStats: null,
        mods: null,
        ...event,
        seq: state.lifecycleSeq,
        at: Date.now(),
      },
    ].slice(-300);
  }
  const uptime = () =>
    state.process?.launchedAt
      ? Math.round((Date.now() - state.process.launchedAt) / 1000)
      : null;
  function launchMods(raw: unknown) {
    const parsed = z
      .array(reforgerMod)
      .max(300)
      .safeParse(object(object(raw).game).mods ?? []);
    return parsed.success
      ? parsed.data.map((mod) => ({
          modId: mod.modId,
          ...(mod.name ? { name: mod.name.slice(0, 120) } : {}),
          ...(mod.version ? { version: mod.version } : {}),
        }))
      : null;
  }
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  const restartTimes = state.restartTimes ?? [];
  state.restartTimes = restartTimes;
  const save = () => atomic(statePath, JSON.stringify(state));
  await save();
  const modCache = await createReforgerModCache(
    profile,
    stateRoot,
    protectEnrolledPaths,
  );
  async function procIdentity(pid: number) {
    try {
      const text = await fs.readFile(`/proc/${pid}/stat`, 'utf8'),
        end = text.lastIndexOf(')');
      const fields = text.slice(end + 2).split(' ');
      return fields[19] ?? null;
    } catch {
      return null;
    }
  }
  async function ownedRunning() {
    if (!state.process) return false;
    if (
      child &&
      child.pid === state.process.pid &&
      child.exitCode === null &&
      !child.killed
    )
      return true;
    const start = await procIdentity(state.process.pid);
    if (!start || start !== state.process.start) return false;
    try {
      return (
        (await fs.realpath(`/proc/${state.process.pid}/exe`)) ===
        (await fs.realpath(exe))
      );
    } catch {
      return false;
    }
  }
  async function matchingProcess() {
    if (process.platform !== 'linux') return null;
    const entries = await fs.readdir('/proc');
    for (const entry of entries.filter((item) => /^\d+$/.test(item))) {
      try {
        if (
          (await fs.realpath(`/proc/${entry}/exe`)) !== (await fs.realpath(exe))
        )
          continue;
        const args = (await fs.readFile(`/proc/${entry}/cmdline`))
          .toString()
          .split('\0');
        const index = args.indexOf('-config');
        if (index >= 0 && resolve(args[index + 1] ?? '') === configPath)
          return Number(entry);
      } catch {
        /* Another process may exit while inspected. */
      }
    }
    return null;
  }
  async function stopped(ownJob?: string) {
    if (await exists(journalPath))
      throw new Error(
        'An interrupted profile restore needs a WarGuardian Agent restart and recovery before this instance can start or change.',
      );
    if ((await ownedRunning()) || (await matchingProcess()))
      throw new Error(
        'Stop this game instance before modifying its files, configuration or backups.',
      );
    if (
      state.job?.state === 'running' &&
      state.job.id !== ownJob &&
      state.job.action !== 'resolve-modpack'
    )
      throw new Error('Wait for the current host job to finish.');
    if (state.job?.state === 'unknown')
      throw new Error(
        'An interrupted host job needs a host manager review before starting or modifying this instance.',
      );
  }
  async function pathInside(path: string, allowMissing = false) {
    safeRelative(path, true);
    const result = join(profile, path);
    const parts = path ? path.split('/') : [];
    let current = profile;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink())
          throw new Error('Symlinks are outside profile operations.');
        if (i < parts.length - 1 && !stat.isDirectory())
          throw new Error('A profile path parent is not a directory.');
      } catch (error) {
        if (
          allowMissing &&
          i === parts.length - 1 &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        )
          break;
        throw error;
      }
    }
    if (
      result !== profile &&
      !(
        relative(profile, result) &&
        !relative(profile, result).startsWith('..') &&
        !isAbsolute(relative(profile, result))
      )
    )
      throw new Error('Profile path escapes its root.');
    if (result === configPath)
      throw new Error(
        'Use the configuration editor for the server configuration.',
      );
    return result;
  }
  async function readConfig() {
    const bytes = await fs.readFile(configPath);
    if (bytes.length > 60000)
      throw new Error('Configuration exceeds the 60 kB editor limit.');
    return {
      raw: JSON.parse(bytes.toString('utf8')) as unknown,
      revision: hash(bytes),
    };
  }
  function protectEnrolledPaths(target: string) {
    for (const protectedPath of [configPath, exe, stateRoot]) {
      const inside = relative(target, protectedPath);
      if (
        target === protectedPath ||
        (inside && !inside.startsWith('..') && !isAbsolute(inside))
      )
        throw new Error(
          'This path contains the server configuration, executable or agent state. It cannot be renamed or removed through profile tools.',
        );
    }
  }
  async function saveConfig(raw: unknown, revision: string, ownJob?: string) {
    await stopped(ownJob);
    const previous = await readConfig();
    if (previous.revision !== revision)
      throw new Error(
        'Configuration changed. Reload and review the new revision.',
      );
    const next = restoreSecrets(raw, previous.raw);
    validateReforgerHostConfig(next);
    for (const field of ['address', 'port', 'password', 'permission'])
      if (
        object(object(next).rcon)[field] !==
        object(object(previous.raw).rcon)[field]
      )
        throw new Error(
          'RCON address, port, password and role are bound to this server connection. Use a reviewed connection change before changing them on the host.',
        );
    // Retain the exact predecessor before replacing the configuration.
    await atomic(
      join(stateRoot, `config-${Date.now()}-${randomUUID()}.json`),
      JSON.stringify(previous.raw, null, 2),
    );
    await atomic(configPath, JSON.stringify(next, null, 2) + '\n');
    // A changed secret is redacted from the next log page on.
    logSecrets = null;
  }
  const rotation = {
    maxBytes: options.logRotation?.maxBytes ?? 10485760,
    keepBytes: options.logRotation?.keepBytes ?? 2097152,
    intervalMs: options.logRotation?.intervalMs ?? 60000,
  };
  /**
   * Truncate `console.log` in place above its limit and start a new console
   * generation. The game keeps its append descriptor. Runs inside `serial`.
   */
  async function rotateConsole() {
    if (
      await rotateReforgerConsole(
        logPath,
        join(stateRoot, 'console.previous.log'),
        rotation,
        atomic,
      )
    ) {
      state.consoleGeneration = randomBytes(8).toString('hex');
      await save();
    }
  }
  async function log(text: string) {
    const redacted = await redactText(text);
    await rotateConsole();
    await fs.appendFile(logPath, redacted, { mode: 0o600 });
  }
  const hashAddress = (ip: string) =>
    createHmac('sha256', state.addressSalt!)
      .update(ip)
      .digest('hex')
      .slice(0, 24);
  let logSecrets: { at: number; values: string[] } | null = null;
  /**
   * Secret values of the server configuration and of the JSON files in the
   * profile, re-read at most once a minute. Mod and log folders are skipped.
   */
  async function logSecretValues() {
    if (logSecrets && Date.now() - logSecrets.at < 60000)
      return logSecrets.values;
    const values = new Set<string>();
    try {
      reforgerConfigSecrets((await readConfig()).raw, values);
    } catch {
      /* An unreadable configuration adds no values. */
    }
    const folders: [string, number][] = [[profile, 0]];
    let files = 0;
    while (folders.length && files < 50) {
      const [folder, depth] = folders.shift()!;
      let entries;
      try {
        entries = await fs.readdir(folder, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (depth < 3 && !['addons', 'logs', '.backend'].includes(entry.name))
            folders.push([path, depth + 1]);
        } else if (
          entry.isFile() &&
          entry.name.endsWith('.json') &&
          files < 50
        ) {
          files++;
          try {
            if ((await fs.lstat(path)).size <= 65536)
              reforgerConfigSecrets(
                JSON.parse(await fs.readFile(path, 'utf8')),
                values,
              );
          } catch {
            /* Not a readable JSON file. */
          }
        }
      }
    }
    logSecrets = { at: Date.now(), values: [...values].slice(0, 500) };
    return logSecrets.values;
  }
  async function logRedactor() {
    const secrets = await logSecretValues();
    return (text: string) => redactReforgerLogText(text, secrets, hashAddress);
  }
  /** The file, generation and session list of one log source and session. */
  async function logTarget(params: URLSearchParams) {
    const source = reforgerLogSource.safeParse(
        params.get('source') ?? 'console',
      ),
      session = reforgerLogSession.safeParse(
        params.get('session') ?? 'current',
      );
    if (!source.success || !session.success)
      throw new Error('Choose a valid log source and session.');
    let sessions: Awaited<ReturnType<typeof listReforgerLogSessions>> = [],
      unlisted: unknown = null;
    try {
      sessions = await listReforgerLogSessions(await pathInside('logs'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unlisted = error;
    }
    // The current console is agent state. It stays readable when the game's
    // log folder is a symlink or cannot be listed.
    if (source.data === 'console' && session.data === 'current')
      return {
        session: 'current',
        sessions,
        path: logPath,
        live: true,
        gen: state.consoleGeneration!,
      };
    if (unlisted) throw unlisted;
    if (
      session.data !== 'current' &&
      !sessions.some((item) => item.name === session.data)
    )
      throw new Error('This log session is not available.');
    const name = session.data === 'current' ? sessions[0]?.name : session.data;
    if (!name)
      return {
        session: 'current',
        sessions,
        path: null,
        live: true,
        gen: 'none',
      };
    const path = await pathInside(
      `logs/${name}/${reforgerLogFiles[source.data]}`,
      true,
    );
    let gen = hash(`${name}\n${source.data}`).slice(0, 16);
    try {
      const stat = await fs.lstat(path);
      gen = hash(
        `${name}\n${source.data}\n${stat.ino}\n${stat.birthtimeMs}`,
      ).slice(0, 16);
    } catch {
      /* A missing file keeps the session generation. */
    }
    return {
      session: session.data === 'current' ? 'current' : name,
      sessions,
      path,
      live: session.data === 'current',
      gen,
    };
  }
  const offsetParam = (value: string | null) => {
    if (value === null || !/^\d{1,15}$/.test(value))
      throw new Error('Choose a valid log position.');
    return Number(value);
  };
  /** One page of whole, redacted lines after the cursor, or the tail. */
  async function readLogPage(params: URLSearchParams) {
    const target = await logTarget(params);
    const requested = params.get('max'),
      max =
        requested === null
          ? reforgerLogPageMax
          : Math.min(
              reforgerLogPageMax,
              Math.max(4096, offsetParam(requested)),
            ),
      after = params.has('after') ? offsetParam(params.get('after')) : null,
      gen = params.get('gen');
    const redact = await logRedactor();
    const size = target.path ? await reforgerLogSize(target.path) : 0;
    const rotated = after !== null && (gen !== target.gen || after > size);
    // A new or rotated cursor starts at the tail, or at the start of a short
    // file. A cursor more than four pages behind skips to the tail.
    let from: number | 'tail' = 'tail';
    if (rotated) from = size <= max ? 0 : 'tail';
    else if (after !== null && size - after <= max * 4) from = after;
    const page = target.path
      ? await readReforgerLogRange(target.path, {
          from,
          max,
          final: !target.live,
          redact,
        })
      : { size: 0, from: 0, to: 0, text: '' };
    return {
      // A rotation during this read is seen by the next cursor: the page then
      // carries the new console generation, and an old offset beyond the new
      // size starts again from the beginning.
      gen: target.path === logPath ? state.consoleGeneration! : target.gen,
      session: target.session,
      sessions: target.sessions,
      size: page.size,
      from: page.from,
      to: page.to,
      text: page.text,
      rotated,
      truncatedBefore:
        after === null || rotated ? page.from > 0 : page.from > after,
    };
  }
  /** One download chunk of whole, redacted lines from the last 32 MiB. */
  async function readLogChunk(params: URLSearchParams) {
    const target = await logTarget(params),
      offset = offsetParam(params.get('offset')),
      gen = params.get('gen');
    if (gen !== null && gen !== target.gen)
      throw new Error('The log changed. Download it again.');
    if (!target.path)
      return { offset: 0, size: 0, text: '', next: null, gen: target.gen };
    const redact = await logRedactor();
    const size = await reforgerLogSize(target.path);
    if (offset > size) throw new Error('The log changed. Download it again.');
    const start = Math.max(offset, size - reforgerLogDownloadMax),
      page = await readReforgerLogRange(target.path, {
        from: start,
        max: reforgerLogPageMax,
        final: !target.live,
        redact,
      });
    // The console rotated while this chunk was read.
    if (target.path === logPath && state.consoleGeneration !== target.gen)
      throw new Error('The log changed. Download it again.');
    return {
      offset: page.from,
      size: page.size,
      text: page.text,
      next: page.to > start && page.to < page.size ? page.to : null,
      gen: target.gen,
    };
  }
  async function redactText(text: string) {
    try {
      const config = (await readConfig()).raw;
      const secrets: string[] = [];
      const walk = (value: unknown) => {
        if (value && typeof value === 'object')
          for (const [key, item] of Object.entries(value)) {
            if (
              secretKey.test(key) &&
              typeof item === 'string' &&
              item.length >= 3
            )
              secrets.push(item);
            else walk(item);
          }
      };
      walk(config);
      for (const secret of secrets)
        text = text.split(secret).join('[redacted]');
    } catch {
      /* No config content is included in this diagnostic. */
    }
    return text;
  }
  async function start(ownJob?: string) {
    if (closing) throw new Error('The WarGuardian Agent is shutting down.');
    await stopped(ownJob);
    const current = await readConfig();
    validateReforgerHostConfig(current.raw);
    await instances.assertStartable(reforgerConfigPorts(current.raw));
    const stat = await fs.stat(exe);
    if (!stat.isFile())
      throw new Error('The configured game executable is unavailable.');
    const output = await fs.open(logPath, 'a', 0o600);
    child = spawn(
      exe,
      [
        '-config',
        configPath,
        '-profile',
        profile,
        '-maxFPS',
        String(Math.min(240, Math.max(10, options.maxFps ?? 60))),
        ...(logStatsMs ? ['-logStats', String(logStatsMs)] : []),
        ...(state.nextSave?.mode === 'save' && state.nextSave.saveId
          ? ['-loadSessionSave', state.nextSave.saveId]
          : state.nextSave?.mode === 'fresh'
            ? ['-backendFreshSession']
            : []),
        ...(options.telemetryAddonsDirectory
          ? [
              '-addonsDir',
              resolve(options.telemetryAddonsDirectory),
              '-gproj',
              join(
                resolve(options.telemetryAddonsDirectory),
                'WarGuardianTelemetry/addon.gproj',
              ),
            ]
          : []),
      ],
      {
        cwd: dirname(exe),
        stdio: ['ignore', output.fd, output.fd],
        detached: process.platform === 'linux',
        windowsHide: true,
        shell: false,
      },
    );
    const launched = child;
    try {
      await new Promise<void>((resolve, reject) => {
        launched.once('spawn', resolve);
        launched.once('error', reject);
      });
    } finally {
      await output.close();
    }
    launched.unref();
    if (state.nextSave?.mode !== 'default')
      state.nextSave = { mode: 'default', saveId: null };
    state.process = {
      pid: launched.pid!,
      start: (await procIdentity(launched.pid!)) ?? `child:${launched.pid}`,
      configRevision: current.revision,
      launchedAt: Date.now(),
      logStats: logStatsMs > 0,
    };
    recordEvent({
      kind: 'started',
      pid: launched.pid!,
      configRevision: current.revision,
      logStats: logStatsMs > 0,
      mods: launchMods(current.raw),
      message: 'Game started by WarGuardian.',
    });
    await save();
    launched.once('exit', (code, signal) => {
      if (child === launched) child = undefined;
      void serial(() =>
        processExited(launched.pid!, { code, signal: signal ?? null }),
      ).catch(() => {});
    });
  }
  async function processExited(
    pid: number,
    exit?: { code: number | null; signal: string | null },
  ) {
    if (state.process?.pid !== pid) return;
    const seconds = uptime();
    recordEvent(
      !exit
        ? {
            kind: 'exited',
            pid,
            uptimeSeconds: seconds,
            message: 'The process ended. Its exit status is not available.',
          }
        : exit.code === 0 && !exit.signal
          ? {
              kind: 'exited',
              pid,
              code: 0,
              uptimeSeconds: seconds,
              message: 'The process exited with code 0.',
            }
          : {
              kind: 'crashed',
              pid,
              code: exit.code,
              signal: exit.signal,
              uptimeSeconds: seconds,
              message: `The process ended unexpectedly${exit.signal ? ` (${exit.signal})` : ` with code ${exit.code}`}.`,
            },
    );
    state.process = null;
    await save();
    if (!closing && !maintenance && state.autoRestart) {
      const now = Date.now();
      while (restartTimes[0] && restartTimes[0] < now - 3600000)
        restartTimes.shift();
      if (restartTimes.length < 3) {
        restartTimes.push(now);
        recordEvent({
          kind: 'restart-scheduled',
          message: 'Crash recovery restarts the game in 10 seconds.',
        });
        await save();
        restartTimer = setTimeout(() => {
          void serial(start).catch(() => {});
        }, 10000);
        restartTimer.unref();
      } else {
        recordEvent({
          kind: 'restart-limit',
          message: 'Crash recovery stopped after 3 restarts in one hour.',
        });
        await save();
        await log('Automatic restart limit reached; inspect the instance.\n');
      }
    }
  }
  async function stop() {
    maintenance = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (!(await ownedRunning()))
      throw new Error(
        'No game started by WarGuardian is running. Take over the running game before stopping it.',
      );
    const pid = state.process!.pid;
    process.kill(pid, 'SIGTERM');
    const until = Date.now() + 15000;
    while ((await ownedRunning()) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (await ownedRunning())
      throw new Error(
        'The game has not stopped. No forced kill was sent. Inspect the host before changing files.',
      );
    recordEvent({
      kind: 'stopped',
      pid,
      uptimeSeconds: uptime(),
      message: 'The game was stopped on request.',
    });
    state.process = null;
    await save();
  }
  function serial<T>(run: () => Promise<T>) {
    const result = queue.then(run);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function job(action: string, run: () => Promise<string>) {
    if (state.job?.state === 'running')
      throw new Error('A host job is already running.');
    if (state.job)
      state.jobs = [
        state.job,
        ...state.jobs!.filter((item) => item.id !== state.job!.id),
      ].slice(0, 100);
    const id = randomUUID();
    state.job = { id, action, state: 'running', message: 'Host job started.' };
    await save();
    activeJob = run().then(
      (message) =>
        serial(async () => {
          if (state.job?.id === id) {
            state.job = { id, action, state: 'succeeded', message };
            await save();
          }
        }),
      (error) =>
        serial(async () => {
          if (state.job?.id === id) {
            const message = await redactText(
              error instanceof Error
                ? error.message.slice(0, 512)
                : 'Host job failed.',
            );
            state.job = { id, action, state: 'failed', message };
            await log(`Host job ${action} failed: ${message}\n`);
            await save();
          }
        }),
    );
    return {
      ok: true as const,
      message: 'Host job started. Follow its saved status.',
      jobId: id,
    };
  }
  async function saveRoot() {
    for (const candidate of [
      join(profile, 'profile', '.save', 'game'),
      join(profile, '.save', 'game'),
    ]) {
      const stat = await fs.lstat(candidate).catch(() => null);
      if (stat?.isDirectory() && !stat.isSymbolicLink()) return candidate;
    }
    return null;
  }
  async function treeBytes(path: string, budget = { entries: 0 }) {
    let total = 0;
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      if (++budget.entries > 20000) break;
      const child = join(path, entry.name);
      if (entry.isDirectory()) total += await treeBytes(child, budget);
      else if (entry.isFile()) total += (await fs.stat(child)).size;
    }
    return total;
  }
  const folderName = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,159}$/;
  async function folders(path: string) {
    return (await fs.readdir(path, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && folderName.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  }
  async function readSaves() {
    const root = await saveRoot();
    const scenarios = [];
    if (root)
      for (const scenario of (await folders(root)).slice(0, 50)) {
        const playthroughs = [];
        for (const playthrough of (await folders(join(root, scenario))).slice(
          -50,
        )) {
          const savePoints = [];
          for (const folder of (
            await folders(join(root, scenario, playthrough))
          ).slice(-200)) {
            const path = join(root, scenario, playthrough, folder);
            let meta: Record<string, unknown> = {};
            try {
              const bytes = await fs.readFile(join(path, 'meta-info.json'));
              if (bytes.length <= 65536)
                meta = object(JSON.parse(bytes.toString('utf8')));
            } catch {
              meta = {};
            }
            const number = (key: string) =>
              typeof meta[key] === 'number' ? (meta[key] as number) : null;
            savePoints.push({
              folder,
              id:
                typeof meta.m_Id === 'string' &&
                /^[0-9a-f-]{36}$/i.test(meta.m_Id)
                  ? meta.m_Id
                  : null,
              number: number('m_iSavePointNr'),
              savedAt:
                number('m_iSavedAtUnix') === null
                  ? null
                  : number('m_iSavedAtUnix')! * 1000,
              playtimeSeconds: number('m_iPlaytimeSeconds'),
              gameVersion:
                typeof meta.m_sGameVersion === 'string'
                  ? meta.m_sGameVersion.slice(0, 64)
                  : null,
              addons: Array.isArray(meta.m_aUsedAddons)
                ? meta.m_aUsedAddons.length
                : null,
              bytes: await treeBytes(path).catch(() => 0),
            });
          }
          playthroughs.push({ folder: playthrough, savePoints });
        }
        const guid = /^([A-Fa-f0-9]{16})-/.exec(scenario)?.[1] ?? null;
        scenarios.push({ folder: scenario, scenarioGuid: guid, playthroughs });
      }
    return {
      root: root ? relative(profile, root) : null,
      scenarios,
      archived: state.saveArchive,
      nextLaunch: state.nextSave,
    };
  }
  /** The cached mods that a scan of the modpack loads. */
  async function scenarioScanMods(modpackId: string) {
    const pack = state.modpacks.find((item) => item.id === modpackId);
    if (!pack) throw new Error('The modpack was not found.');
    return {
      modpackId,
      addons: reforgerScenarioScanAddons(
        pack,
        await modCache.scan([], [], '', 'stopped'),
      ),
    };
  }
  async function listScenarios(
    mods: { modpackId: string; addons: ReforgerScanAddon[] } | null = null,
  ) {
    const scan = join(stateRoot, 'scenario-scan');
    await fs.rm(scan, { recursive: true, force: true });
    await fs.mkdir(scan, { recursive: true, mode: 0o700 });
    const lines: string[] = [];
    let error: string | null = null;
    // Loading mods takes longer than the official listing.
    const minutes = mods ? 5 : 2;
    await new Promise<void>((resolve) => {
      const scanner = (options.spawnScenarioScan ?? spawn)(
        exe,
        reforgerScenarioScanArguments(
          scan,
          mods && {
            directory: modCache.root,
            ids: mods.addons.map((addon) => addon.modId),
          },
        ),
        {
          cwd: dirname(exe),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
          shell: false,
        },
      );
      let buffered = '',
        size = 0,
        dashes = 0,
        finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (scanner.exitCode === null) scanner.kill('SIGKILL');
        resolve();
      };
      const timer = setTimeout(() => {
        error = `The game did not finish listing scenarios within ${minutes} minutes.`;
        finish();
      }, minutes * 60000);
      const take = (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4194304) return finish();
        buffered += chunk.toString('utf8');
        const parts = buffered.split(/\r?\n/);
        buffered = parts.pop() ?? '';
        for (const line of parts) {
          lines.push(line);
          if (/-{20,}\s*$/.test(line) && ++dashes >= 5) finish();
        }
      };
      scanner.stdout!.on('data', take);
      scanner.stderr!.on('data', take);
      scanner.once('error', (cause) => {
        error = cause.message.slice(0, 200);
        finish();
      });
      scanner.once('exit', () => {
        if (buffered) lines.push(buffered);
        finish();
      });
    });
    const logs: string[][] = [];
    try {
      for (const file of await fs.readdir(scan, { recursive: true }))
        if (String(file).endsWith('.log'))
          logs.push(
            (await fs.readFile(join(scan, String(file)), 'utf8'))
              .slice(0, 4194304)
              .split(/\r?\n/),
          );
    } catch {
      /* The console output is enough when no log was written. */
    }
    // A mod's Workshop data can name the scenarios it adds.
    const owners = new Map<string, ReforgerScanAddon>();
    for (const addon of mods?.addons ?? []) {
      try {
        for (const scenarioId of reforgerServerDataScenarios(
          await modCache.serverData(addon.folder),
        ))
          if (!owners.has(scenarioId)) owners.set(scenarioId, addon);
      } catch {
        /* The scenario keeps an unnamed mod source. */
      }
    }
    const items = reforgerScannedScenarios(
      readReforgerScenarioListing(lines, ...logs),
      mods?.addons ?? null,
      owners,
    );
    const added = items.filter((item) => item.source.kind === 'mod').length;
    await serial(async () => {
      state.discoveredScenarios = {
        at: Date.now(),
        items,
        error: !items.length
          ? (error ?? 'The game listed no scenarios.')
          : mods && !added
            ? 'The modpack added no scenarios.'
            : null,
        modpackId: mods?.modpackId ?? null,
      };
      await save();
    });
    await fs.rm(scan, { recursive: true, force: true }).catch(() => {});
    return mods
      ? `${items.length} scenarios found, ${added} from mods.`
      : `${items.length} scenarios found.`;
  }
  async function backup() {
    const id = randomUUID(),
      path = join(stateRoot, `${id}.wgbackup.gz`);
    let files = 0,
      total = 0,
      entries = 0;
    async function* lines(
      directory: string,
      prefix = '',
    ): AsyncGenerator<string> {
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        if (++entries > 10000)
          throw new Error('Backup exceeds the 10,000 entry limit.');
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        safeRelative(key);
        const source = join(directory, entry.name),
          stat = await fs.lstat(source);
        if (source === configPath) continue; // Credentials and the active connection are not profile backup contents.
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
          throw new Error('Backup contains a link or unsupported file.');
        if (stat.isDirectory()) {
          yield JSON.stringify({ type: 'directory', path: key }) + '\n';
          yield* lines(source, key);
          continue;
        }
        if (
          ++files > 10000 ||
          stat.size > 268435456 ||
          (total += stat.size) > 536870912
        )
          throw new Error('Backup exceeds the 10,000 file / 512 MiB limit.');
        yield (
          JSON.stringify({ type: 'file', path: key, size: stat.size }) + '\n'
        );
        let readBytes = 0;
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(source, {
          highWaterMark: 131072,
        })) {
          readBytes += (chunk as Buffer).length;
          digest.update(chunk as Buffer);
          yield (
            JSON.stringify({
              type: 'chunk',
              data: Buffer.from(chunk as Buffer).toString('base64'),
            }) + '\n'
          );
        }
        const after = await fs.stat(source);
        if (
          readBytes !== stat.size ||
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs
        )
          throw new Error(
            'A profile file changed while backing up. No completed backup was published.',
          );
        yield (
          JSON.stringify({ type: 'end-file', sha256: digest.digest('hex') }) +
            '\n'
        );
      }
    }
    async function* archive() {
      yield (
        JSON.stringify({
          type: 'header',
          format: 'warguardian-reforger-profile',
          version: 1,
        }) + '\n'
      );
      yield* lines(profile);
      yield JSON.stringify({ type: 'complete', files, bytes: total }) + '\n';
    }
    try {
      await pipeline(
        Readable.from(archive()),
        createGzip(),
        createWriteStream(path, { flags: 'wx', mode: 0o600 }),
      );
      const archived = await fs.open(path, 'r+');
      try {
        await archived.sync();
      } finally {
        await archived.close();
      }
      await syncDirectory(stateRoot);
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(path))
        digest.update(chunk as Buffer);
      const entry = {
        id,
        at: Date.now(),
        bytes: (await fs.stat(path)).size,
        files,
        sha256: digest.digest('hex'),
      };
      await serial(async () => {
        state.backups = [entry, ...state.backups].slice(0, 50);
        await save();
      });
      return `Profile backup completed (${files} files). Server configuration predecessors are retained separately on the host.`;
    } catch (error) {
      await fs.rm(path, { force: true });
      throw error;
    }
  }
  async function restore(id: string) {
    const entry = state.backups.find((item) => item.id === id);
    if (!entry) throw new Error('Unknown backup.');
    const path = join(stateRoot, `${id}.wgbackup.gz`),
      digest = createHash('sha256');
    for await (const chunk of createReadStream(path))
      digest.update(chunk as Buffer);
    if (digest.digest('hex') !== entry.sha256)
      throw new Error('Backup checksum differs.');
    const staging = await fs.mkdtemp(
      join(dirname(profile), '.wg-reforger-restore-'),
    );
    let buffer = '',
      file: Awaited<ReturnType<typeof fs.open>> | null = null,
      fileDigest: ReturnType<typeof createHash> | null = null,
      expected = 0,
      written = 0,
      total = 0,
      count = 0,
      records = 0,
      entryCount = 0,
      header = false,
      complete = false;
    try {
      for await (const chunk of createReadStream(path).pipe(createGunzip())) {
        buffer += Buffer.from(chunk).toString('utf8');
        if (buffer.length > 1048576)
          throw new Error('Oversized backup record.');
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          const record = object(JSON.parse(line));
          if (++records > 50000)
            throw new Error('Backup has too many records.');
          if (complete) throw new Error('Unexpected backup trailer.');
          if (!header) {
            if (
              record.type !== 'header' ||
              record.format !== 'warguardian-reforger-profile' ||
              record.version !== 1
            )
              throw new Error('Unsupported backup format.');
            header = true;
            continue;
          }
          if (record.type === 'directory') {
            if (++entryCount > 10000)
              throw new Error('Too many backup entries.');
            if (file) throw new Error('Unfinished backup file.');
            await fs.mkdir(join(staging, safeRelative(String(record.path))), {
              recursive: true,
              mode: 0o700,
            });
          } else if (record.type === 'file') {
            if (++entryCount > 10000)
              throw new Error('Too many backup entries.');
            if (
              file ||
              ++count > 10000 ||
              !Number.isInteger(record.size) ||
              Number(record.size) < 0 ||
              Number(record.size) > 268435456
            )
              throw new Error('Invalid backup file.');
            const target = join(staging, safeRelative(String(record.path)));
            await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
            file = await fs.open(target, 'wx', 0o600);
            fileDigest = createHash('sha256');
            expected = Number(record.size);
            written = 0;
          } else if (record.type === 'chunk') {
            if (
              !file ||
              typeof record.data !== 'string' ||
              record.data.length > 174764 ||
              !/^[A-Za-z0-9+/]*={0,2}$/.test(record.data)
            )
              throw new Error('Invalid backup chunk.');
            const bytes = Buffer.from(record.data, 'base64');
            if (!bytes.length) throw new Error('Empty backup chunk.');
            written += bytes.length;
            total += bytes.length;
            if (written > expected || total > 536870912)
              throw new Error('Backup size differs.');
            fileDigest!.update(bytes);
            await file.writeFile(bytes);
          } else if (record.type === 'end-file') {
            if (
              !file ||
              written !== expected ||
              fileDigest!.digest('hex') !== record.sha256
            )
              throw new Error('Backup file checksum differs.');
            await file.sync();
            await file.close();
            file = null;
          } else if (record.type === 'complete') {
            if (
              file ||
              record.files !== count ||
              record.bytes !== total ||
              count !== entry.files
            )
              throw new Error('Incomplete backup.');
            complete = true;
          } else throw new Error('Unknown backup record.');
        }
      }
      if (!complete || buffer.trim()) throw new Error('Incomplete backup.');
      const configRelative = relative(profile, configPath);
      if (
        configRelative &&
        !configRelative.startsWith('..') &&
        !isAbsolute(configRelative)
      ) {
        const preserved = await fs.readFile(configPath),
          target = join(staging, configRelative);
        await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await atomic(target, preserved.toString('utf8'));
      }
      const syncTree = async (path: string) => {
        for (const entry of await fs.readdir(path, { withFileTypes: true }))
          if (entry.isDirectory()) await syncTree(join(path, entry.name));
        await syncDirectory(path);
      };
      await syncTree(staging);
      // Keep the complete previous profile beside the replacement for recovery.
      const predecessor = `${profile}.wg-before-${randomUUID()}`;
      await atomic(
        journalPath,
        JSON.stringify({ profile, staging, predecessor }),
      );
      await fs.rename(profile, predecessor);
      await syncDirectory(dirname(profile));
      try {
        await fs.rename(staging, profile);
        await syncDirectory(dirname(profile));
      } catch (error) {
        if (!(await exists(profile))) {
          await fs.rename(predecessor, profile);
          await syncDirectory(dirname(profile));
        }
        throw error;
      }
      await fs.unlink(journalPath);
      await syncDirectory(stateRoot);
      return 'Profile restore completed. The previous profile is retained beside it on the host. Start the game explicitly after review.';
    } catch (error) {
      if (file) await file.close();
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  async function execute(raw: unknown, requestId: string) {
    return serial(async () => {
      if (closing) throw new Error('The WarGuardian Agent is closing.');
      const command = reforgerHostCommand.parse(raw);
      if (!/^[a-f0-9-]{36}$/i.test(requestId))
        throw new Error('Invalid WarGuardian Agent request ID.');
      if (requestId in state.receipts) {
        const prior = state.receipts[requestId];
        if (!prior)
          throw new Error(
            'This operation was previously dispatched without a saved result. Inspect the host; it will not be repeated.',
          );
        return prior;
      }
      state.receipts[requestId] = null;
      const keys = Object.keys(state.receipts);
      for (const key of keys.slice(0, -1000)) delete state.receipts[key];
      await save();
      let receipt: { ok: true; message: string; jobId?: string } = {
        ok: true,
        message: 'Host change saved.',
      };
      if (
        'confirmation' in command &&
        command.action !== 'remove-file' &&
        command.action !== 'remove-backup' &&
        command.confirmation !== (options.serverId ?? options.serverName)
      )
        throw new Error('Confirm the selected server identity.');
      if (
        command.action.endsWith('-backup-import') &&
        state.job?.state === 'unknown'
      )
        throw new Error(
          'Review the interrupted host job before importing an archive.',
        );
      if (command.action === 'quarantine-mod-cache') {
        await stopped();
        const current = await readConfig();
        if (current.revision !== command.configRevision)
          throw new Error(
            'Server configuration changed. Refresh before continuing.',
          );
        const inventory = await readModCache(current, false);
        await modCache.quarantine(
          command.modId,
          command.revision,
          command.allowReferenced,
          inventory,
        );
        receipt.message =
          'Cache quarantined. Retained content can be restored.';
      } else if (command.action === 'restore-mod-cache') {
        await stopped();
        await modCache.restore(command.id);
        receipt.message = 'Cached content restored. Game start is explicit.';
      } else if (command.action === 'remove-quarantined-mod-cache') {
        if (state.job?.state === 'running' || state.job?.state === 'unknown')
          throw new Error(
            'Finish or review the current host job before removing retained content.',
          );
        await modCache.remove(command.id);
        receipt.message = 'Quarantined files removed.';
      } else if (command.action === 'start') {
        maintenance = false;
        await start();
        receipt.message =
          'Game started. Readiness still needs a successful roster or query check.';
      } else if (command.action === 'begin-backup-import') {
        if (state.backupUpload)
          throw new Error('Resume or cancel the current archive upload.');
        if (state.backups.length >= 50)
          throw new Error('Backup library is full.');
        if (state.job?.state === 'running')
          throw new Error('A host job is running.');
        const handle = await fs.open(
          join(stateRoot, `${command.id}.import.part`),
          'wx',
          0o600,
        );
        await handle.close();
        state.backupUpload = {
          id: command.id,
          name: command.name,
          bytes: command.bytes,
          at: Date.now(),
          excludedManifest: Object.keys(command.manifest)
            .filter((key) => key !== 'version')
            .slice(0, 100)
            .map((key) => `manifest.${key.slice(0, 120)}`),
        };
        receipt.message = 'Archive upload opened.';
      } else if (command.action === 'append-backup-import') {
        const upload = state.backupUpload;
        if (!upload || upload.id !== command.id)
          throw new Error('Archive upload was not found.');
        if (state.job?.state === 'running')
          throw new Error('A host job is running.');
        const bytes = Buffer.from(command.data, 'base64');
        if (
          !bytes.length ||
          bytes.length > 32768 ||
          command.offset + bytes.length > upload.bytes
        )
          throw new Error('Invalid archive chunk.');
        const file = await fs.open(
          join(stateRoot, `${upload.id}.import.part`),
          constants.O_RDWR | constants.O_NOFOLLOW,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > upload.bytes)
            throw new Error('Invalid archive upload file.');
          if (command.offset < stat.size) {
            if (command.offset + bytes.length > stat.size)
              throw new Error('Archive retry overlaps unacknowledged bytes.');
            const prior = Buffer.alloc(bytes.length);
            const read = await file.read(
              prior,
              0,
              prior.length,
              command.offset,
            );
            if (read.bytesRead !== bytes.length || !prior.equals(bytes))
              throw new Error('Archive retry contains different bytes.');
          } else {
            if (command.offset !== stat.size)
              throw new Error('Archive upload offset differs.');
            let written = 0;
            while (written < bytes.length) {
              const part = await file.write(
                bytes,
                written,
                bytes.length - written,
                command.offset + written,
              );
              if (!part.bytesWritten)
                throw new Error('Archive chunk write stopped.');
              written += part.bytesWritten;
            }
            await file.sync();
          }
        } finally {
          await file.close();
        }
        receipt.message = 'Archive chunk saved.';
      } else if (command.action === 'cancel-backup-import') {
        if (!state.backupUpload || state.backupUpload.id !== command.id)
          throw new Error('Archive upload was not found.');
        if (state.job?.state === 'running')
          throw new Error('Wait for archive validation to finish.');
        await fs.unlink(join(stateRoot, `${command.id}.import.part`));
        state.backupUpload = null;
        receipt.message = 'Archive upload cancelled.';
      } else if (command.action === 'finish-backup-import') {
        const upload = state.backupUpload;
        if (!upload || upload.id !== command.id)
          throw new Error('Archive upload was not found.');
        if (state.backups.length >= 50)
          throw new Error('Backup library is full.');
        const input = join(stateRoot, `${upload.id}.import.part`);
        if (
          (await fs.lstat(input)).size !== upload.bytes ||
          (await fs.lstat(input)).isSymbolicLink()
        )
          throw new Error('Archive upload is incomplete.');
        receipt = await job('import-backup', async () => {
          const id = randomUUID(),
            output = join(stateRoot, `${id}.wgbackup.gz`);
          try {
            const report = await convertReforgerHostArchive(input, output);
            validateReforgerHostConfig(report.config);
            if ((await fs.stat(output)).size > 536870912)
              throw new Error('Converted backup exceeds 512 MiB.');
            const digest = createHash('sha256');
            for await (const chunk of createReadStream(output))
              digest.update(chunk as Buffer);
            await serial(async () => {
              state.backups.unshift({
                id,
                at: Date.now(),
                bytes: (await fs.stat(output)).size,
                files: report.files,
                sha256: digest.digest('hex'),
                source: 'reforger-host-v1',
              });
              state.importDraft = {
                backupId: id,
                source: 'reforger-host-v1',
                config: report.config!,
                excluded: [
                  ...(upload.excludedManifest ?? []),
                  ...report.excluded,
                ],
                omitted: report.omitted,
              };
              state.backupUpload = null;
              await save();
            });
            await fs.unlink(input).catch(() => {});
            return `Archive imported: ${report.files} profile files.`;
          } catch (error) {
            if (!state.backups.some((entry) => entry.id === id))
              await fs.rm(output, { force: true });
            throw error;
          }
        });
      } else if (command.action === 'stop') {
        await stop();
        receipt.message = 'Game stopped.';
      } else if (command.action === 'adopt') {
        const pid = await matchingProcess();
        if (!pid)
          throw new Error(
            'No process matches the configured executable and exact configuration path.',
          );
        state.process = { pid, start: (await procIdentity(pid))! };
        recordEvent({
          kind: 'adopted',
          pid,
          message: 'WarGuardian took over the running game.',
        });
        await save();
        receipt.message = 'Running game taken over.';
      } else if (command.action === 'auto-restart') {
        state.autoRestart = command.enabled;
        if (!command.enabled && restartTimer) {
          clearTimeout(restartTimer);
          restartTimer = undefined;
        }
        await save();
      } else if (command.action === 'restart-instance') {
        if (state.job?.state === 'running' || state.job?.state === 'unknown')
          throw new Error(
            'Review or wait for the current host job before restarting.',
          );
        if (!(await ownedRunning()))
          throw new Error(
            'Only a game started by WarGuardian can be restarted.',
          );
        receipt = await job('restart-instance', async () => {
          const id = state.job!.id;
          await stop();
          maintenance = false;
          await start(id);
          return 'The game restarted. Check RCON and query readiness before admitting players.';
        });
      } else if (command.action === 'check-mod-updates') {
        if (updateCheck)
          throw new Error('A mod update check is already running.');
        startUpdateCheck();
        receipt.message =
          'Mod update check started. Results appear when every mod is read.';
      } else if (command.action === 'review-job') {
        if (state.job?.state !== 'unknown')
          throw new Error('There is no interrupted host job to review.');
        if (
          state.job.action === 'update' &&
          (await ownedReforgerJobActive(state.job.id, state.job.group))
        )
          throw new Error(
            'The interrupted update is still running on the host. Wait or inspect the host.',
          );
        state.job = {
          ...state.job,
          state: 'failed',
          message:
            'Interrupted job reviewed by the host manager. Source data is retained. Review the installation and rerun validation before starting the game.',
        };
        await save();
      } else if (command.action === 'save-config') {
        await saveConfig(command.config, command.revision);
        receipt.message =
          'Configuration saved with its predecessor retained. Start the stopped game explicitly to apply it.';
      } else if (command.action === 'save-modpack') {
        const current = state.modpacks.find(
          (pack) => pack.id === command.modpack.id,
        );
        if (
          command.revision !== undefined &&
          command.revision !== (current ? hash(JSON.stringify(current)) : null)
        )
          throw new Error(
            'This modpack changed. Reload the saved pack before saving your draft.',
          );
        if (
          state.modpacks.length >= 100 &&
          !state.modpacks.some((pack) => pack.id === command.modpack.id)
        )
          throw new Error('This host has 100 saved modpacks.');
        validateLibrary(
          [
            command.modpack,
            ...state.modpacks.filter((pack) => pack.id !== command.modpack.id),
          ],
          Object.fromEntries(
            Object.entries(state.modpackReports!).filter(
              ([id]) => id !== command.modpack.id,
            ),
          ),
        );
        if (current) rememberPack(current);
        rememberPack(command.modpack);
        state.modpacks = [
          command.modpack,
          ...state.modpacks.filter((pack) => pack.id !== command.modpack.id),
        ];
        delete state.modpackReports![command.modpack.id];
        await save();
      } else if (command.action === 'import-modpacks') {
        const ids = new Set(command.modpacks.map((pack) => pack.id));
        for (const pack of command.modpacks) {
          const current = state.modpacks.find((item) => item.id === pack.id);
          if (
            !Object.hasOwn(command.revisions, pack.id) ||
            command.revisions[pack.id] !==
              (current ? hash(JSON.stringify(current)) : null)
          )
            throw new Error(
              `Import target ${pack.id} changed. Reload the library and review conflicts again.`,
            );
        }
        const next = [
          ...command.modpacks,
          ...state.modpacks.filter((pack) => !ids.has(pack.id)),
        ];
        if (next.length > 100)
          throw new Error('Import exceeds the 100-pack library limit.');
        const reports = Object.fromEntries(
          Object.entries(state.modpackReports!).filter(([id]) => !ids.has(id)),
        );
        validateLibrary(next, reports);
        for (const pack of command.modpacks) {
          const previous = state.modpacks.find((item) => item.id === pack.id);
          if (previous) rememberPack(previous);
          rememberPack(pack);
        }
        state.modpacks = next;
        state.modpackReports = reports;
        await save();
        receipt.message = `${command.modpacks.length} modpacks imported from ${command.source}. Server configuration and running games were unchanged.`;
      } else if (command.action === 'remove-modpack') {
        state.modpacks = state.modpacks.filter(
          (pack) => pack.id !== command.id,
        );
        delete state.modpackReports![command.id];
        await save();
      } else if (command.action === 'resolve-modpack') {
        const pack = state.modpacks.find((item) => item.id === command.id);
        if (!pack) throw new Error('Modpack not found.');
        const predecessor = JSON.stringify(pack);
        receipt = await job('resolve-modpack', async () => {
          const result = await workshop.resolve(pack);
          await serial(async () => {
            if (
              JSON.stringify(
                state.modpacks.find((item) => item.id === command.id),
              ) !== predecessor
            )
              throw new Error(
                'The modpack changed while resolving. No stale result was saved.',
              );
            validateLibrary(
              state.modpacks.map((item) =>
                item.id === command.id ? result.pack : item,
              ),
              { ...state.modpackReports, [command.id]: result.report },
            );
            rememberPack(pack);
            rememberPack(result.pack);
            state.modpacks = state.modpacks.map((item) =>
              item.id === command.id ? result.pack : item,
            );
            state.modpackReports![command.id] = result.report;
            await save();
          });
          return `Community dependency check completed for ${result.pack.mods.length} mods. Review reported engine targets and launch validation before applying.`;
        });
      } else if (command.action === 'apply-modpack') {
        const pack = state.modpacks.find((item) => item.id === command.id);
        if (!pack) throw new Error('Modpack not found.');
        if (
          command.packRevision &&
          hash(JSON.stringify(pack)) !== command.packRevision
        )
          throw new Error(
            'This modpack changed. Review the new pack before applying it.',
          );
        const activeMods = pack.mods
          .filter((mod) => mod.enabled !== false)
          .map(({ enabled: _enabled, origin: _origin, ...mod }) => mod);
        const config = await readConfig(),
          raw = object(config.raw),
          game = object(raw.game),
          prior = z.array(reforgerMod).parse(game.mods ?? []);
        const mods =
          command.mode === 'replace'
            ? activeMods
            : [
                ...prior.filter(
                  (mod) => !activeMods.some((item) => item.modId === mod.modId),
                ),
                ...activeMods,
              ];
        await saveConfig({ ...raw, game: { ...game, mods } }, command.revision);
        receipt.message =
          'Modpack staged in the stopped server configuration. The game downloads and validates Workshop content on its next start.';
      } else if (command.action === 'save-scenario') {
        const others = state.scenarios!.filter(
          (item) => item.id !== command.scenario.id,
        );
        if (others.length >= 30)
          throw new Error('This host has 30 scenarios. Remove one first.');
        if (
          command.scenario.modpackId &&
          !state.modpacks.some((pack) => pack.id === command.scenario.modpackId)
        )
          throw new Error('The selected modpack is not in the library.');
        state.scenarios = [...others, command.scenario].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        await save();
        receipt.message = 'Scenario saved.';
      } else if (command.action === 'remove-scenario') {
        state.scenarios = state.scenarios!.filter(
          (item) => item.id !== command.id,
        );
        state.rotation = {
          order: state.rotation!.order.filter((id) => id !== command.id),
          next: 0,
        };
        await save();
        receipt.message = 'Scenario removed.';
      } else if (command.action === 'save-rotation') {
        if (
          new Set(command.order).size !== command.order.length ||
          command.order.some(
            (id) => !state.scenarios!.some((item) => item.id === id),
          )
        )
          throw new Error(
            'The rotation lists an unknown or repeated scenario.',
          );
        state.rotation = { order: command.order, next: 0 };
        await save();
        receipt.message = 'Rotation saved. It starts from the first scenario.';
      } else if (
        command.action === 'switch-scenario' ||
        command.action === 'rotate-scenario'
      ) {
        if (state.job?.state === 'running' || state.job?.state === 'unknown')
          throw new Error(
            'Review or wait for the current host job before switching scenarios.',
          );
        const rotating = command.action === 'rotate-scenario';
        const order = state.rotation!.order;
        if (rotating && !order.length)
          throw new Error('Save a rotation before rotating scenarios.');
        const id = rotating
          ? order[state.rotation!.next % order.length]!
          : command.id;
        const preset = state.scenarios!.find((item) => item.id === id);
        if (!preset) throw new Error('Scenario not found.');
        const pack = preset.modpackId
          ? state.modpacks.find((item) => item.id === preset.modpackId)
          : null;
        if (preset.modpackId && !pack)
          throw new Error('The scenario modpack was removed from the library.');
        const wasRunning = await ownedRunning();
        receipt = await job(command.action, async () => {
          const jobId = state.job!.id;
          if (wasRunning) await stop();
          try {
            const config = await readConfig(),
              raw = object(config.raw),
              game = object(raw.game);
            await saveConfig(
              {
                ...raw,
                game: {
                  ...game,
                  scenarioId: preset.scenarioId,
                  ...(preset.maxPlayers
                    ? { maxPlayers: preset.maxPlayers }
                    : {}),
                  ...(pack
                    ? {
                        mods: pack.mods
                          .filter((mod) => mod.enabled !== false)
                          .map(
                            ({ enabled: _enabled, origin: _origin, ...mod }) =>
                              mod,
                          ),
                      }
                    : {}),
                },
              },
              config.revision,
              jobId,
            );
            if (rotating)
              await serial(async () => {
                state.rotation = {
                  order: state.rotation!.order,
                  next: (state.rotation!.next + 1) % Math.max(1, order.length),
                };
                await save();
              });
          } finally {
            maintenance = false;
            if (wasRunning) await start(jobId);
          }
          return wasRunning
            ? `Switched to ${preset.name} and started the game. Check RCON and query readiness before admitting players.`
            : `Switched the stopped server to ${preset.name}.`;
        });
      } else if (command.action === 'list-scenarios') {
        await stopped();
        // A modpack scan loads cached mods only, so it is refused before the
        // job starts when one is missing.
        const mods = command.modpackId
          ? await scenarioScanMods(command.modpackId)
          : null;
        receipt = await job('list-scenarios', () => listScenarios(mods));
      } else if (command.action === 'set-next-save') {
        if (command.mode === 'save' && !command.saveId)
          throw new Error('Choose the save point to load.');
        state.nextSave = {
          mode: command.mode,
          saveId: command.mode === 'save' ? command.saveId : null,
        };
        await save();
        receipt.message =
          command.mode === 'save'
            ? 'The next start loads the chosen save point.'
            : command.mode === 'fresh'
              ? 'The next start begins a new playthrough. Existing saves stay on disk.'
              : 'The next start uses the configured save behavior.';
      } else if (command.action === 'archive-playthrough') {
        await stopped();
        const root = await saveRoot();
        if (!root) throw new Error('No save folder exists in this profile.');
        const source = join(root, command.scenario, command.playthrough);
        const stat = await fs.lstat(source).catch(() => null);
        if (!stat?.isDirectory() || stat.isSymbolicLink())
          throw new Error('This playthrough folder was not found.');
        if (state.saveArchive!.length >= 100)
          throw new Error(
            '100 playthroughs are archived. Restore or keep fewer.',
          );
        const id = randomUUID(),
          target = join(stateRoot, 'save-archive', id);
        await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const bytes = await treeBytes(source);
        await fs.rename(source, target);
        await syncDirectory(dirname(target));
        state.saveArchive = [
          {
            id,
            scenario: command.scenario,
            playthrough: command.playthrough,
            at: Date.now(),
            bytes,
          },
          ...state.saveArchive!,
        ];
        await save();
        receipt.message =
          'Playthrough moved to the agent archive. Restore it here at any time.';
      } else if (command.action === 'restore-playthrough') {
        await stopped();
        const entry = state.saveArchive!.find((item) => item.id === command.id);
        if (!entry) throw new Error('Unknown archived playthrough.');
        const root =
          (await saveRoot()) ?? join(profile, 'profile', '.save', 'game');
        const target = join(root, entry.scenario, entry.playthrough);
        if (await exists(target))
          throw new Error(
            'A playthrough with this name exists. Archive it before restoring.',
          );
        await fs.mkdir(dirname(target), { recursive: true });
        await fs.rename(join(stateRoot, 'save-archive', entry.id), target);
        await syncDirectory(dirname(target));
        state.saveArchive = state.saveArchive!.filter(
          (item) => item.id !== entry.id,
        );
        await save();
        receipt.message = 'Playthrough restored to the game profile.';
      } else if (command.action === 'backup') {
        await stopped();
        if (state.backups.length >= 50)
          throw new Error(
            'This host has 50 backups. Remove an obsolete archive before creating another.',
          );
        receipt = await job('backup', backup);
      } else if (command.action === 'restore') {
        await stopped();
        receipt = await job('restore', () => restore(command.id));
      } else if (command.action === 'remove-backup') {
        if (state.job?.state === 'running')
          throw new Error('Wait for the current host job to finish.');
        if (
          command.confirmation !== command.id ||
          !state.backups.some((item) => item.id === command.id)
        )
          throw new Error('Confirm a saved backup ID.');
        await fs.unlink(join(stateRoot, `${command.id}.wgbackup.gz`));
        state.backups = state.backups.filter((item) => item.id !== command.id);
        if (state.importDraft?.backupId === command.id)
          state.importDraft = null;
        await save();
        receipt.message = 'The selected backup archive was removed.';
      } else if (command.action === 'update') {
        await stopped();
        const siblings = await instances.runningSiblings();
        if (siblings.length)
          throw new Error(
            `${siblings.map((item) => item.serverName).join(', ')} ${siblings.length === 1 ? 'is' : 'are'} running from this installation. Stop ${siblings.length === 1 ? 'it' : 'them'} before updating.`,
          );
        if (!options.steamcmd || !options.installDirectory)
          throw new Error(
            'Configure absolute SteamCMD and installation paths on the host to enable updates.',
          );
        if (
          !isAbsolute(options.steamcmd) ||
          !isAbsolute(options.installDirectory) ||
          resolve(options.installDirectory) !== dirname(exe)
        )
          throw new Error(
            'The update directory must be the configured executable directory.',
          );
        if (
          !(await fs.stat(options.steamcmd)).isFile() ||
          !(await fs.stat(options.installDirectory)).isDirectory()
        )
          throw new Error('The configured update paths are unavailable.');
        receipt = await job('update', async () => {
          const pending = state.job!,
            abort = new AbortController();
          jobAbort = abort;
          try {
            return await runReforgerOwnedUpdate({
              executable: options.steamcmd!,
              installation: options.installDirectory!,
              id: pending.id,
              signal: abort.signal,
              output: log,
              onSpawn: (group) =>
                serial(async () => {
                  if (state.job?.id === pending.id) {
                    state.job = { ...state.job, group };
                    await save();
                  }
                }),
            });
          } finally {
            jobAbort = undefined;
          }
        });
      } else if (command.action === 'mkdir') {
        await stopped();
        await fs.mkdir(await pathInside(command.path, true));
      } else if (command.action === 'write-file') {
        await stopped();
        const target = await pathInside(command.path, true);
        let before: string | null = null;
        if (await exists(target)) {
          if ((await fs.stat(target)).size > 32768)
            throw new Error('This file exceeds the editor limit.');
          const bytes = await fs.readFile(target);
          before = hash(bytes);
          if ((await redactText(bytes.toString())) !== bytes.toString())
            throw new Error(
              'This file contains protected configuration values and is read-only in the panel.',
            );
        }
        if (before !== command.revision)
          throw new Error(
            'The file changed. Reload its revision before saving.',
          );
        if (command.path.toLowerCase().endsWith('.json'))
          JSON.parse(command.text);
        await atomic(target, command.text);
      } else if (command.action === 'rename-file') {
        await stopped();
        const source = await pathInside(command.path),
          destination = await pathInside(command.destination, true);
        protectEnrolledPaths(source);
        protectEnrolledPaths(destination);
        if (await exists(destination))
          throw new Error('The destination already exists.');
        await fs.rename(source, destination);
      } else if (command.action === 'remove-file') {
        await stopped();
        if (command.confirmation !== command.path)
          throw new Error('Type the exact profile path to confirm removal.');
        const target = await pathInside(command.path);
        protectEnrolledPaths(target);
        await fs.rm(target, { recursive: true });
      }
      state.receipts[requestId] = receipt;
      await save();
      return receipt;
    });
  }
  async function readModCache(
    current: Awaited<ReturnType<typeof readConfig>>,
    running: boolean,
  ) {
    const game = object(object(current.raw).game);
    const mods = z
      .array(reforgerMod)
      .max(300)
      .parse(game.mods ?? [])
      .map((mod) => ({
        ...mod,
        required: mod.required ?? game.modsRequiredByDefault !== false,
      }));
    return modCache.scan(
      mods,
      state.modpacks,
      current.revision,
      !running
        ? 'stopped'
        : !state.process?.configRevision
          ? 'unrecorded'
          : state.process.configRevision === current.revision
            ? 'unchanged'
            : 'changed',
    );
  }
  async function read(
    resource: string,
    params = new URLSearchParams(),
  ): Promise<unknown> {
    return serial(async () => {
      if (closing) throw new Error('The WarGuardian Agent is closing.');
      if (resource === 'telemetry') {
        try {
          return await readReforgerJournal(
            await pathInside('profile/WarGuardianTelemetry/events.jsonl'),
            Number(params.get('offset') ?? 0),
            params.get('generation'),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            throw new Error(
              'The WarGuardian telemetry file is missing. Install and enable the WarGuardian telemetry addon on this game host.',
            );
          throw error;
        }
      }
      if (resource === 'stability') {
        const perfAfter = Number(params.get('perfAfter') ?? 0),
          eventAfter = Number(params.get('eventAfter') ?? 0),
          gameAfter = Number(params.get('gameAfter') ?? 0),
          resourceAfter = Number(params.get('resourceAfter') ?? 0);
        const running = await ownedRunning();
        return {
          generation: state.stabilityGeneration,
          logStatsMs,
          running: running
            ? {
                launchedAt: state.process?.launchedAt ?? null,
                logStats: state.process?.logStats ?? null,
              }
            : null,
          performance: performance
            .filter((sample) => sample.seq > perfAfter)
            .slice(0, 500),
          events: state
            .lifecycle!.filter((event) => event.seq > eventAfter)
            .slice(0, 200),
          perfSeq: performanceSeq,
          eventSeq: state.lifecycleSeq ?? 0,
          gameEvents: gameEvents
            .filter((event) => event.seq > gameAfter)
            .slice(0, 500),
          gameSeq,
          resources: resources
            .filter((sample) => sample.seq > resourceAfter)
            .slice(0, 500),
          resourceSeq,
        };
      }
      if (resource === 'mod-updates')
        return {
          checkedAt: state.modUpdates?.checkedAt ?? null,
          running: !!updateCheck,
          startedAt: updateCheck?.startedAt ?? null,
          progress: updateCheck
            ? { done: updateCheck.done, total: updateCheck.total }
            : null,
          error: state.modUpdates?.error ?? null,
          nextAutomaticAt: state.modUpdates?.checkedAt
            ? state.modUpdates.checkedAt + updateIntervalMs
            : null,
          mods: state.modUpdates?.mods ?? [],
        };
      if (resource === 'status') {
        const managed = await ownedRunning(),
          external = managed ? null : await matchingProcess();
        let memoryBytes: number | null = null;
        if (managed)
          try {
            const status = await fs.readFile(
              `/proc/${state.process!.pid}/status`,
              'utf8',
            );
            const match = /^VmRSS:\s+(\d+) kB/m.exec(status);
            if (match) memoryBytes = Number(match[1]) * 1024;
          } catch {
            /* Unsupported host telemetry stays absent. */
          }
        let freeDiskBytes: number | null = null;
        try {
          const info = await fs.statfs(profile);
          freeDiskBytes = Number(info.bavail) * Number(info.bsize);
        } catch {
          /* No estimate. */
        }
        return {
          running: managed || !!external,
          managed,
          pid: managed ? state.process!.pid : external,
          job: state.job,
          autoRestart: state.autoRestart,
          memoryBytes,
          loadAverage: process.platform === 'linux' ? loadavg()[0] : null,
          freeDiskBytes,
          capabilities: [
            'lifecycle',
            'config',
            'modpacks',
            'mod-cache',
            'profile-files',
            'logs',
            reforgerLogsCapability,
            reforgerScenarioAddonsCapability,
            'backups',
            'stability',
            'mod-updates',
            'resources',
            'instances',
            ...(options.steamcmd && options.installDirectory ? ['update'] : []),
          ],
          message: external
            ? 'A game started outside WarGuardian is running. Take it over to stop or restart it.'
            : 'WarGuardian manages only this executable, configuration and profile.',
        };
      }
      if (resource === 'job') {
        const id = z.uuid().parse(params.get('id'));
        return {
          job:
            state.job?.id === id
              ? state.job
              : (state.jobs!.find((item) => item.id === id) ?? null),
        };
      }
      if (resource === 'config') {
        const current = await readConfig();
        return {
          revision: current.revision,
          config: redactConfig(current.raw),
          warnings: validateReforgerHostConfig(current.raw),
        };
      }
      if (resource === 'mod-cache')
        return readModCache(
          await readConfig(),
          (await ownedRunning()) || !!(await matchingProcess()),
        );
      if (resource === 'modpacks')
        return {
          modpacks: state.modpacks,
          reports: Object.values(state.modpackReports!),
          history: state.modpackHistory,
          revisions: Object.fromEntries(
            state.modpacks.map((pack) => [pack.id, hash(JSON.stringify(pack))]),
          ),
        };
      if (resource === 'workshop')
        return workshop.search(
          params.get('search') ?? '',
          Number(params.get('page') ?? 1),
          params.get('sort') ?? 'popularity',
        );
      if (resource === 'workshop-detail')
        return workshop.inspect(params.get('id') ?? '');
      if (resource === 'workshop-servers')
        return workshop.servers(params.get('search') ?? '');
      if (resource === 'workshop-server-mods')
        return workshop.serverMods(params.get('id') ?? '');
      if (resource === 'backups') return { backups: state.backups };
      if (resource === 'saves') return readSaves();
      if (resource === 'instances')
        return {
          installation: basename(dirname(exe)),
          instances: (await instances.list()).map((item) => ({
            serverId: item.serverId,
            serverName: item.serverName,
            active: item.active,
            running: item.active && item.gamePid !== null,
            ports: item.ports,
            updatedAt: item.updatedAt,
          })),
        };
      if (resource === 'scenarios') {
        let current: string | null = null;
        try {
          const scenarioId = object(
            object((await readConfig()).raw).game,
          ).scenarioId;
          current = typeof scenarioId === 'string' ? scenarioId : null;
        } catch {
          current = null;
        }
        return {
          current,
          scenarios: state.scenarios,
          rotation: state.rotation,
          discovered: state.discoveredScenarios,
        };
      }
      if (resource === 'backup-import') {
        const upload = state.backupUpload;
        return {
          upload: upload
            ? {
                ...upload,
                received: (
                  await fs.stat(join(stateRoot, `${upload.id}.import.part`))
                ).size,
              }
            : null,
          draft: state.importDraft ?? null,
        };
      }
      if (resource === 'logs') {
        // A server with live logs sends a cursor. Every other server receives
        // the 128 KiB console tail. Reading never truncates the file.
        if (
          ['source', 'session', 'after', 'gen', 'max'].some((name) =>
            params.has(name),
          )
        )
          return readLogPage(params);
        if (!(await exists(logPath)))
          return {
            text: 'No managed process output has been recorded.',
            truncated: false,
          };
        const tail = await readReforgerLogRange(logPath, {
          from: 'tail',
          max: 131072,
          final: true,
          redact: await logRedactor(),
        });
        return { text: tail.text, truncated: tail.from > 0 };
      }
      if (resource === 'log-chunk') return readLogChunk(params);
      if (resource === 'files') {
        const path = safeRelative(params.get('path') ?? '', true),
          root = await pathInside(path),
          entries = await fs.readdir(root, { withFileTypes: true });
        if (entries.length > 1000)
          throw new Error(
            'This directory exceeds the 1,000 entry browser limit.',
          );
        return {
          path,
          entries: await Promise.all(
            entries.map(async (entry) => {
              const stat = await fs.lstat(join(root, entry.name));
              return {
                name: entry.name,
                directory: stat.isDirectory(),
                bytes: stat.size,
                readable:
                  !stat.isSymbolicLink() &&
                  (stat.isFile() || stat.isDirectory()) &&
                  join(root, entry.name) !== configPath,
              };
            }),
          ),
        };
      }
      if (resource === 'file') {
        const path = safeRelative(params.get('path') ?? ''),
          target = await pathInside(path);
        const stat = await fs.stat(target);
        if (!stat.isFile() || stat.size > 32768)
          throw new Error('This file exceeds the 32 kB text editor limit.');
        const bytes = await fs.readFile(target);
        const text = new TextDecoder('utf8', { fatal: true }).decode(bytes),
          masked = await redactText(text);
        return {
          path,
          text: masked,
          redacted: text !== masked,
          revision: hash(bytes),
        };
      }
      if (resource === 'backup-chunk') {
        const id = z.uuid().parse(params.get('id')),
          entry = state.backups.find((item) => item.id === id),
          offset = Number(params.get('offset'));
        if (
          !entry ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > entry.bytes
        )
          throw new Error('Invalid backup chunk.');
        const handle = await fs.open(join(stateRoot, `${id}.wgbackup.gz`), 'r');
        try {
          const bytes = Buffer.alloc(Math.min(524288, entry.bytes - offset));
          const read = await handle.read(bytes, 0, bytes.length, offset);
          return {
            offset,
            data: bytes.subarray(0, read.bytesRead).toString('base64'),
            done: offset + read.bytesRead === entry.bytes,
          };
        } finally {
          await handle.close();
        }
      }
      throw new Error('Unsupported host resource.');
    });
  }
  const consoleWatcher = await createReforgerConsoleWatcher(logPath);
  const gameEventsPath = join(stateRoot, 'game-events.json');
  type StoredGameEvent = ReforgerGameEvent & { seq: number; at: number };
  let gameEvents: StoredGameEvent[] = [],
    gameSeq = 0,
    gameSavedAt = 0;
  try {
    const saved = JSON.parse(await fs.readFile(gameEventsPath, 'utf8')) as {
      seq?: number;
      events?: StoredGameEvent[];
    };
    gameEvents = Array.isArray(saved.events) ? saved.events.slice(-2000) : [];
    gameSeq = Number(saved.seq) || gameEvents.at(-1)?.seq || 0;
  } catch {
    gameEvents = [];
  }
  const assembler = createReforgerGameEventAssembler(hashAddress);
  let consoleScan: Promise<void> | undefined;
  /** One console scan at a time. A rotation waits for it to finish. */
  function scanConsole() {
    consoleScan ??= consoleWatcher
      .scan()
      .then(async ({ stats, hangs, game }) => {
        const at = Date.now();
        for (const event of assembler.push(game))
          gameEvents.push({ ...event, seq: ++gameSeq, at });
        if (gameEvents.length > 2000) gameEvents = gameEvents.slice(-2000);
        if (game.length && at - gameSavedAt > 15000) {
          gameSavedAt = at;
          await atomic(
            gameEventsPath,
            JSON.stringify({ seq: gameSeq, events: gameEvents }),
          );
        }
        for (const sample of stats)
          performance.push({ ...sample, seq: ++performanceSeq, at });
        if (performance.length > 720) performance = performance.slice(-720);
        if (stats.length && at - performanceSavedAt > 60000) {
          performanceSavedAt = at;
          await atomic(
            performancePath,
            JSON.stringify({ seq: performanceSeq, samples: performance }),
          );
        }
        if (hangs.length)
          await serial(async () => {
            for (const hang of hangs.slice(0, 10))
              recordEvent({
                kind: 'hang',
                pid: state.process?.pid ?? null,
                uptimeSeconds: uptime(),
                message: hang.seconds
                  ? `The engine reported a ${hang.seconds} s freeze.`
                  : 'The engine reported a freeze.',
              });
            await save();
          });
      })
      .catch(() => {})
      .finally(() => {
        consoleScan = undefined;
      });
    return consoleScan;
  }
  const stabilityTimer = setInterval(() => {
    if (!closing) void scanConsole();
  }, 15000);
  stabilityTimer.unref();
  // The console is scanned before each rotation, so no line written before
  // the truncation is missed by the stability and game event watcher.
  const rotationTimer = setInterval(() => {
    if (!closing)
      void scanConsole()
        .then(() => (closing ? undefined : serial(rotateConsole)))
        .catch(() => {});
  }, rotation.intervalMs);
  rotationTimer.unref();
  const resourceTimer = setInterval(() => {
    if (closing) return;
    void sampleResources()
      .then(async (sample) => {
        const at = Date.now();
        resources.push({ ...sample, seq: ++resourceSeq, at });
        if (resources.length > 1440) resources = resources.slice(-1440);
        if (at - resourcesSavedAt > 300000) {
          resourcesSavedAt = at;
          await atomic(
            resourcesPath,
            JSON.stringify({ seq: resourceSeq, samples: resources }),
          );
        }
      })
      .catch(() => {});
  }, 60000);
  resourceTimer.unref();
  void sampleResources().catch(() => {});
  const instanceTimer = setInterval(() => {
    if (!closing) void announce().catch(() => {});
  }, 15000);
  instanceTimer.unref();
  void announce().catch(() => {});
  const updateIntervalMs = 12 * 3600000;
  let updateCheck:
    | { startedAt: number; done: number; total: number }
    | undefined;
  function startUpdateCheck() {
    const progress = { startedAt: Date.now(), done: 0, total: 0 };
    updateCheck = progress;
    void checkModUpdates(progress)
      .catch(async (error) => {
        await serial(async () => {
          state.modUpdates = {
            checkedAt: Date.now(),
            error: await redactText(
              error instanceof Error
                ? error.message.slice(0, 400)
                : 'The mod update check failed.',
            ),
            mods: state.modUpdates?.mods ?? [],
          };
          await save();
        });
      })
      .finally(() => {
        if (updateCheck === progress) updateCheck = undefined;
      });
  }
  async function checkModUpdates(progress: { done: number; total: number }) {
    const { current, cached } = await serial(async () => {
      const config = await readConfig();
      let cache: Awaited<ReturnType<typeof readModCache>> | null = null;
      try {
        cache = await readModCache(
          config,
          (await ownedRunning()) || !!(await matchingProcess()),
        );
      } catch {
        cache = null;
      }
      return { current: config, cached: cache };
    });
    const configured = z
      .array(reforgerMod)
      .max(300)
      .safeParse(object(object(current.raw).game).mods ?? []);
    const entries = new Map<
      string,
      {
        name: string | null;
        configured: boolean;
        pinned: string | null;
        packs: string[];
      }
    >();
    for (const mod of configured.success ? configured.data : [])
      entries.set(mod.modId, {
        name: mod.name ?? null,
        configured: true,
        pinned: mod.version ?? null,
        packs: [],
      });
    for (const pack of state.modpacks)
      for (const mod of pack.mods) {
        const entry = entries.get(mod.modId) ?? {
          name: mod.name ?? null,
          configured: false,
          pinned: mod.version ?? null,
          packs: [],
        };
        if (!entry.packs.includes(pack.name) && entry.packs.length < 50)
          entry.packs.push(pack.name);
        entries.set(mod.modId, entry);
      }
    const ids = [...entries.keys()].slice(0, 300),
      known = new Set(ids);
    progress.total = ids.length;
    const results: z.infer<typeof reforgerModUpdateEntry>[] = [];
    let error: string | null = null;
    for (const modId of ids) {
      if (closing)
        throw new Error(
          'The WarGuardian Agent closed during the update check.',
        );
      const entry = entries.get(modId)!,
        cachedVersion =
          cached?.mods.find((mod) => mod.modId === modId && mod.folder)
            ?.version ?? null;
      try {
        const detail = await workshop.inspect(modId);
        const latest = detail.mod.version || null;
        const status = detail.mod.private
          ? 'private'
          : detail.mod.obsolete
            ? 'obsolete'
            : entry.pinned && latest && entry.pinned !== latest
              ? 'update-available'
              : !entry.pinned &&
                  entry.configured &&
                  latest &&
                  cachedVersion &&
                  cachedVersion !== latest
                ? 'downloads-on-start'
                : 'current';
        results.push({
          modId,
          name: detail.mod.name.slice(0, 160) || entry.name,
          configured: entry.configured,
          packs: entry.packs,
          pinned: entry.pinned,
          cached: cachedVersion,
          latest,
          gameVersion: detail.mod.gameVersion ?? null,
          state: status,
          newDependencies: entry.configured
            ? detail.mod.dependencies
                .filter((dependency) => !known.has(dependency.id.toUpperCase()))
                .slice(0, 100)
                .map((dependency) => ({
                  id: dependency.id.toUpperCase(),
                  name: dependency.name ?? null,
                }))
            : [],
          message: null,
        });
      } catch (cause) {
        const text = cause instanceof Error ? cause.message : '';
        if (/\(404\)/.test(text))
          results.push({
            modId,
            name: entry.name,
            configured: entry.configured,
            packs: entry.packs,
            pinned: entry.pinned,
            cached: cachedVersion,
            latest: null,
            gameVersion: null,
            state: 'delisted',
            newDependencies: [],
            message: 'The Workshop listing was not found.',
          });
        else if (/rate-limited|temporarily unavailable/i.test(text)) {
          error =
            'Community metadata is rate-limited. The check stopped early.';
          break;
        } else
          results.push({
            modId,
            name: entry.name,
            configured: entry.configured,
            packs: entry.packs,
            pinned: entry.pinned,
            cached: cachedVersion,
            latest: null,
            gameVersion: null,
            state: 'unavailable',
            newDependencies: [],
            message: text.slice(0, 300) || 'Metadata is unavailable.',
          });
      }
      progress.done++;
    }
    await serial(async () => {
      state.modUpdates = { checkedAt: Date.now(), error, mods: results };
      await save();
    });
  }
  const updateTimer = setInterval(() => {
    if (
      !closing &&
      !updateCheck &&
      Date.now() - (state.modUpdates?.checkedAt ?? 0) >= updateIntervalMs
    )
      void readConfig()
        .then((current) => {
          const mods = object(object(current.raw).game).mods;
          if (
            (Array.isArray(mods) && mods.length) ||
            state.modpacks.some((pack) => pack.mods.length)
          )
            startUpdateCheck();
        })
        .catch(() => {});
  }, 600000);
  updateTimer.unref();
  const supervisorTimer = setInterval(() => {
    if (!closing && state.process && !child) {
      const pid = state.process.pid;
      void ownedRunning()
        .then((running) => {
          if (!running) return serial(() => processExited(pid));
        })
        .catch(() => {});
    }
  }, 2000);
  supervisorTimer.unref();
  return {
    execute,
    read,
    describeError: async (error: unknown) =>
      await redactText(
        error instanceof Error
          ? error.message.slice(0, 2000)
          : 'Host request refused.',
      ),
    async close() {
      if (closing) return;
      closing = true;
      maintenance = true;
      clearInterval(supervisorTimer);
      clearInterval(stabilityTimer);
      clearInterval(rotationTimer);
      clearInterval(resourceTimer);
      clearInterval(instanceTimer);
      clearInterval(updateTimer);
      if (restartTimer) clearTimeout(restartTimer);
      child?.removeAllListeners('exit');
      jobAbort?.abort();
      workshop.close();
      await activeJob;
      await queue;
      await save();
    },
  };
}
