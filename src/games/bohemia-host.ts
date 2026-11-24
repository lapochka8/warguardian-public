import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { loadavg } from 'node:os';
import { join, posix, relative, sep, win32 } from 'node:path';
import { createGunzip, gzipSync } from 'node:zlib';
import { z } from 'zod';
import {
  bohemiaConfigMaxBytes,
  bohemiaHostCommand,
  bohemiaLogName,
  bohemiaLogPageMax,
  bohemiaSecretPlaceholder,
  type BohemiaHostBackups,
  type BohemiaHostCommand,
  type BohemiaHostConfig,
  type BohemiaHostLogs,
  type BohemiaHostMods,
  type BohemiaHostReceipt,
  type BohemiaHostResource,
  type BohemiaHostStatus,
  type BohemiaInstalledMod,
  type BohemiaJob,
} from '../../vendor/games/bohemia-host';
import {
  bohemiaMod,
  bohemiaModArguments,
  bohemiaModFolder,
  bohemiaSteamApps,
  isModKeyFile,
  readWorkshopManifest,
  type BohemiaMod,
  type BohemiaWorkshopGame,
} from '../../vendor/games/bohemia-workshop';
import { AgentError } from '../errors';

/**
 * Game host management for Arma 3 and DayZ on Linux and Windows. It starts
 * and stops the server it started, edits its config file, reads its logs,
 * keeps backups of its profiles folder, downloads Workshop mods with
 * SteamCMD, links them into the server folder and keeps their keys.
 *
 * The settings come from `hosts/<serverId>.json` beside `agent.json`, not
 * from `agent.json`, so an earlier Agent still reads its configuration. The
 * state lives in `<state>/hosts/<serverId>/`.
 *
 * Every process argument and path is built here. Nothing from the panel
 * becomes a path, an argument or a shell string except validated Workshop
 * IDs, log names and backup IDs.
 */

const absolutePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) => posix.isAbsolute(value) || win32.isAbsolute(value),
    'Use an absolute path.',
  );

/** Names the Agent sets itself, refused in `launchArguments`. */
const managedArguments = new Set([
  'config',
  'profiles',
  'port',
  'mod',
  'servermod',
]);
/**
 * One extra launch parameter, such as `-cfg=C:\server\basic.cfg`,
 * `-bepath=...`, `-name=server` or `-dologs`. It is passed as one argument,
 * never through a shell.
 */
const launchArgument = z
  .string()
  .regex(
    /^-[A-Za-z][A-Za-z0-9_]{0,40}(?:=[^\r\n"]{1,1024})?$/,
    'Use -name or -name=value.',
  )
  .refine(
    (value) =>
      !managedArguments.has(value.slice(1).split('=')[0]!.toLowerCase()),
    'The Agent sets -config, -profiles, -port, -mod and -serverMod itself.',
  );

/** Version 1 of the host settings file. Unknown keys are ignored. */
export const bohemiaHostSettings = z.object({
  v: z.literal(1).default(1),
  /** `arma3server_x64` or `DayZServer_x64`, with its full path. */
  executable: absolutePath,
  /** The server installation, which holds `keys` and the `@` mod folders. */
  serverDirectory: absolutePath,
  /** `server.cfg` or `serverDZ.cfg`. */
  config: absolutePath,
  /** `-profiles`, which holds `.rpt`, `.ADM` and `.log` files. */
  profiles: absolutePath,
  port: z.number().int().min(1).max(65_535).default(2302),
  steamcmd: absolutePath.optional(),
  /** A SteamCMD account that already signed in on this host. */
  steamUser: z
    .string()
    .regex(/^[A-Za-z0-9_]{2,64}$/)
    .optional(),
  /** `+force_install_dir` for Workshop downloads. */
  workshopDirectory: absolutePath.optional(),
  /** Extra launch parameters, after the ones the Agent sets. */
  launchArguments: z.array(launchArgument).max(40).default([]),
});
export type BohemiaHostSettings = z.output<typeof bohemiaHostSettings>;

const job = z.object({
  id: z.string().max(80),
  action: z.string().max(40),
  state: z.enum(['running', 'succeeded', 'failed', 'unknown']),
  message: z.string().max(400),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().nullable(),
});

/**
 * Version 1 of the host state file. Every field has a default, so a file
 * from an earlier build of this module, or an empty object, still reads.
 */
export const bohemiaHostState = z.object({
  v: z.literal(1).default(1),
  /** The saved list. */
  mods: z.array(bohemiaMod).max(300).default([]),
  /** The list linked into the server folder by the last apply. */
  applied: z.array(bohemiaMod).max(300).default([]),
  /** The list the apply before the last one linked, for a revert. */
  previous: z.array(bohemiaMod).max(300).nullable().default(null),
  /** The list the running process was started with. */
  launched: z.array(bohemiaMod).max(300).nullable().default(null),
  /** `@` links this Agent created. */
  links: z
    .array(z.string().regex(/^@\d{1,20}$/))
    .max(600)
    .default([]),
  /** Keys this Agent copied into `keys`, with the mod they came from. */
  keys: z
    .array(z.object({ file: z.string().max(160), mod: z.string().max(20) }))
    .max(600)
    .default([]),
  pid: z.number().int().positive().nullable().default(null),
  startedAt: z.number().int().nonnegative().nullable().default(null),
  job: job.nullable().default(null),
  history: z.array(job).max(20).default([]),
  checkedAt: z.number().int().nonnegative().nullable().default(null),
});
export type BohemiaHostState = z.output<typeof bohemiaHostState>;

/** The parts of the host the controller uses. Tests replace them. */
export type BohemiaHostSystem = {
  platform: 'linux' | 'win32';
  spawn: (
    file: string,
    args: readonly string[],
    /** `output` pipes stdout and stderr, for short jobs such as SteamCMD. */
    options: { cwd: string; detached: boolean; output?: boolean },
  ) => ChildProcess;
  alive: (pid: number) => boolean;
  /** Ask the process to stop. Never a forced kill. */
  terminate: (pid: number) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export const nodeBohemiaSystem: BohemiaHostSystem = {
  platform: process.platform === 'win32' ? 'win32' : 'linux',
  spawn: (file, args, options) =>
    spawn(file, [...args], {
      cwd: options.cwd,
      detached: options.detached,
      shell: false,
      windowsHide: true,
      stdio: options.output ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    }),
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  terminate(pid) {
    process.kill(pid, 'SIGTERM');
  },
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const stopWaitMs = 15_000;
/** A server that exits this soon after start failed to start. */
const startCheckMs = 20_000;
/** How long a start waits for the server log to say it is ready. */
const startReadyMs = 180_000;
/** How much of a new server log a start reads. */
const startLogBytes = 4_194_304;
/** How long the RCON login of a stopped server may still look open. */
const rconLingerMs = 30_000;
const downloadTimeoutMs = 30 * 60_000;
const backupLimitBytes = 536_870_912;
const backupLimitFiles = 10_000;
const backupKeep = 50;
const logFileLimit = 50;
const secretKeys = ['password', 'passwordAdmin', 'serverCommandPassword'];

const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const listRevision = (mods: readonly BohemiaMod[]) =>
  digest(JSON.stringify(mods));
const fail = (message: string, status = 409) =>
  new AgentError(status, 'host-refused', message);

/** `password = "x";` lines, matched so a value never reaches the panel. */
function secretPattern() {
  return new RegExp(
    `^(\\s*(?:${secretKeys.join('|')})\\s*=\\s*")([^"\\r\\n]*)("\\s*;)`,
    'gim',
  );
}
export function redactConfigSecrets(text: string): {
  text: string;
  secrets: Map<string, string>;
} {
  const secrets = new Map<string, string>();
  const redacted = text.replace(
    secretPattern(),
    (_match, head: string, value: string, tail: string) => {
      const key = head.trim().split(/\s*=/)[0]!.toLowerCase();
      secrets.set(key, value);
      return value ? `${head}${bohemiaSecretPlaceholder}${tail}` : _match;
    },
  );
  return { text: redacted, secrets };
}
/** Put stored values back where the editor kept the placeholder. */
export function restoreConfigSecrets(
  edited: string,
  secrets: ReadonlyMap<string, string>,
): string {
  return edited.replace(
    secretPattern(),
    (match, head: string, value: string, tail: string) => {
      if (value !== bohemiaSecretPlaceholder) return match;
      const key = head.trim().split(/\s*=/)[0]!.toLowerCase();
      const stored = secrets.get(key);
      if (stored === undefined)
        throw fail(`Enter a value for ${head.trim().split(/\s*=/)[0]}.`, 400);
      return `${head}${stored}${tail}`;
    },
  );
}
function redactText(text: string, secrets: Iterable<string>) {
  let result = text;
  for (const secret of secrets)
    if (secret.length >= 3) result = result.split(secret).join('[redacted]');
  return result;
}

async function exists(path: string) {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}
async function writeAtomic(path: string, data: string | Buffer) {
  const temporary = `${path}.wg-${randomUUID()}.tmp`;
  await fs.writeFile(temporary, data, { mode: 0o600 });
  await fs.rename(temporary, path);
}
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return (
    !!rel &&
    !rel.startsWith('..') &&
    !posix.isAbsolute(rel) &&
    !win32.isAbsolute(rel)
  );
}

type Options = {
  serverId: string;
  game: BohemiaWorkshopGame;
  settings: BohemiaHostSettings;
  stateDirectory: string;
  system?: BohemiaHostSystem;
  /** How long a start waits to see the server stay up. */
  startCheckMs?: number;
  /** How long a start waits for the server log to say it is ready. */
  startReadyMs?: number;
  /** A game server answers on this server's RCON port, started by anyone. */
  externalRunning?: () => boolean;
};

/** Reads the settings file. Null when there is none. */
export async function readBohemiaHostSettings(
  file: string,
): Promise<BohemiaHostSettings | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = bohemiaHostSettings.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new AgentError(
      503,
      'not-configured',
      'The host settings file is not valid.',
    );
  return parsed.data;
}

export async function createBohemiaHostController(options: Options) {
  const system = options.system ?? nodeBohemiaSystem;
  const { settings, game } = options;
  const directory = options.stateDirectory;
  const stateFile = join(directory, 'state.json');
  const backupDirectory = join(directory, 'backups');
  await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });

  const state = await load();
  // A job that was running when the Agent stopped has an unknown outcome.
  if (state.job?.state === 'running') {
    state.job = {
      ...state.job,
      state: 'unknown',
      message: 'The Agent restarted during this job. Check the server.',
      finishedAt: system.now(),
    };
    await save();
  }
  let active: Promise<void> | null = null;
  let child: ChildProcess | null = null;
  const stopped = new AbortController();

  async function load(): Promise<BohemiaHostState> {
    try {
      const parsed = bohemiaHostState.safeParse(
        JSON.parse(await fs.readFile(stateFile, 'utf8')),
      );
      if (parsed.success) return parsed.data;
      throw fail('The host state file is unreadable. It was kept.', 503);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return bohemiaHostState.parse({});
      throw error;
    }
  }
  async function save() {
    await writeAtomic(stateFile, JSON.stringify(state));
  }

  function running() {
    return state.pid !== null && system.alive(state.pid);
  }
  /** When this Agent last saw its own server stop. */
  let ownStopAt = Number.NEGATIVE_INFINITY;
  /**
   * A server this Agent did not start answers on the RCON port. The RCON
   * login of a server this Agent just stopped stays open for a while, so it
   * is not counted for a short time after that stop.
   */
  function external() {
    return (
      !running() &&
      system.now() - ownStopAt > rconLingerMs &&
      (options.externalRunning?.() ?? false)
    );
  }

  // Jobs: one at a time, saved before and after.
  function startJob(action: string, work: () => Promise<string>) {
    if (active || state.job?.state === 'running')
      throw fail('Another host job is running.');
    const record: BohemiaJob = {
      id: randomUUID(),
      action,
      state: 'running',
      message: 'Running',
      startedAt: system.now(),
      finishedAt: null,
    };
    state.job = record;
    const finish = async (ok: boolean, message: string) => {
      state.job = {
        ...record,
        state: ok ? 'succeeded' : 'failed',
        message: message.slice(0, 400),
        finishedAt: system.now(),
      };
      state.history = [state.job, ...state.history].slice(0, 20);
      await save();
    };
    active = save()
      .then(work)
      .then(
        (message) => finish(true, message),
        (error: unknown) =>
          finish(
            false,
            error instanceof Error ? error.message : 'The job failed.',
          ),
      )
      .finally(() => {
        active = null;
      });
    return record;
  }

  // Process control.
  function modsReady(list: readonly BohemiaMod[]) {
    return Promise.all(
      list
        .filter((mod) => mod.enabled !== false)
        .map(async (mod) =>
          (await exists(
            join(settings.serverDirectory, bohemiaModFolder(mod.id)),
          ))
            ? null
            : mod.id,
        ),
    ).then((missing) => missing.filter((id): id is string => !!id));
  }
  async function startProcess() {
    if (running()) throw fail('The server is already running.');
    if (external())
      throw fail(
        'A server that WarGuardian did not start is running. Stop it first.',
      );
    const missing = await modsReady(state.applied);
    if (missing.length)
      throw fail(`Download and apply these mods first: ${missing.join(', ')}.`);
    const logsBefore = new Set(await serverLogNames());
    const args = [
      `-config=${settings.config}`,
      `-profiles=${settings.profiles}`,
      `-port=${settings.port}`,
      ...settings.launchArguments,
      ...bohemiaModArguments(state.applied),
    ];
    child = system.spawn(settings.executable, args, {
      cwd: settings.serverDirectory,
      // The server outlives the Agent, also across its self-update. Windows
      // ends a child that is not detached together with the Agent.
      detached: true,
    });
    const pid = child.pid;
    if (!pid) throw fail('The server did not start.');
    child.once('exit', () => {
      child = null;
    });
    child.unref?.();
    state.pid = pid;
    state.startedAt = system.now();
    state.launched = state.applied.map((mod) => ({ ...mod }));
    await save();
    // A broken mod or launch parameter usually ends the process at once.
    const until = system.now() + (options.startCheckMs ?? startCheckMs);
    while (system.now() < until) {
      if (!system.alive(pid)) {
        const seconds = Math.max(
          1,
          Math.round((system.now() - state.startedAt) / 1000),
        );
        state.pid = null;
        state.launched = null;
        await save();
        throw fail(
          `The server stopped ${seconds} s after it started. Check the newest .rpt log${state.previous ? ' or revert to the previous mods' : ''}.`,
        );
      }
      await system.sleep(500);
    }
    // Arma 3 keeps running without a required addon and only logs it, and a
    // busy host logs it late. Read the new log until the server is ready.
    const readyUntil = system.now() + (options.startReadyMs ?? startReadyMs);
    for (;;) {
      const log = await readStartLog(logsBefore);
      if (log.requirement)
        throw fail(
          `The server is running, but a mod is missing a requirement: ${log.requirement}. Add the required mod${state.previous ? ' or revert to the previous mods' : ''}.`,
        );
      if (log.ready || system.now() >= readyUntil) break;
      if (!system.alive(pid)) {
        state.pid = null;
        state.launched = null;
        await save();
        throw fail(
          `The server stopped while it was starting. Check the newest .rpt log${state.previous ? ' or revert to the previous mods' : ''}.`,
        );
      }
      await system.sleep(1000);
    }
    return 'Server started.';
  }
  /** The server `.rpt` files in the profiles folder. */
  async function serverLogNames() {
    try {
      return (await fs.readdir(settings.profiles)).filter((name) =>
        /\.rpt$/i.test(name),
      );
    } catch {
      return [];
    }
  }
  /**
   * What the logs written since the start say: the first "requires addon"
   * line, and whether the server reached its mission (Arma 3) or finished
   * its init sequence (DayZ).
   */
  async function readStartLog(before: ReadonlySet<string>) {
    let ready = false;
    for (const name of await serverLogNames()) {
      if (before.has(name)) continue;
      try {
        const handle = await fs.open(join(settings.profiles, name), 'r');
        try {
          const { buffer, bytesRead } = await handle.read(
            Buffer.alloc(startLogBytes),
            0,
            startLogBytes,
            0,
          );
          const text = buffer.subarray(0, bytesRead).toString('utf8');
          const found =
            /Addon '[^'\r\n]{1,80}' requires addon '[^'\r\n]{1,80}'/.exec(text);
          if (found) return { requirement: found[0], ready };
          ready ||=
            /Starting mission:|Init sequence finished|Player connect enabled/.test(
              text,
            );
        } finally {
          await handle.close();
        }
      } catch {
        /* The log may still be opening. */
      }
    }
    return { requirement: null, ready };
  }
  async function stopProcess() {
    if (!running()) {
      if (external())
        throw fail(
          'WarGuardian did not start this server, so it cannot stop it.',
        );
      state.pid = null;
      state.launched = null;
      await save();
      return 'The server was not running.';
    }
    system.terminate(state.pid!);
    const until = system.now() + stopWaitMs;
    while (system.now() < until) {
      if (!running()) break;
      await system.sleep(250);
    }
    if (running())
      throw fail(
        'The server did not stop within 15 seconds. It was not forced to stop.',
      );
    ownStopAt = system.now();
    state.pid = null;
    state.launched = null;
    await save();
    return 'Server stopped.';
  }

  // Config.
  async function readConfig(): Promise<{
    raw: string;
    view: BohemiaHostConfig;
  }> {
    const stat = await fs.stat(settings.config);
    if (stat.size > bohemiaConfigMaxBytes)
      throw fail('The config file is larger than 48 KiB.', 413);
    const raw = await fs.readFile(settings.config, 'utf8');
    return {
      raw,
      view: {
        revision: digest(raw),
        file: settings.config.split(/[\\/]/).pop() ?? 'server.cfg',
        text: redactConfigSecrets(raw).text,
      },
    };
  }
  async function configSecrets() {
    try {
      const raw = await fs.readFile(settings.config, 'utf8');
      return [...redactConfigSecrets(raw).secrets.values()];
    } catch {
      return [];
    }
  }

  // Logs.
  async function logFiles() {
    const entries = await fs.readdir(settings.profiles, {
      withFileTypes: true,
    });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !bohemiaLogName.safeParse(entry.name).success)
        continue;
      const stat = await fs.stat(join(settings.profiles, entry.name));
      const extension = entry.name.split('.').pop()!.toLowerCase();
      files.push({
        name: entry.name,
        kind: extension as 'rpt' | 'adm' | 'log',
        bytes: stat.size,
        modifiedAt: Math.floor(stat.mtimeMs),
      });
    }
    return files
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .slice(0, logFileLimit);
  }
  async function readLogs(name: string | null): Promise<BohemiaHostLogs> {
    const files = await logFiles();
    const chosen = name ? files.find((file) => file.name === name) : files[0];
    if (name && !chosen) throw fail('That log file is not available.', 404);
    if (!chosen) return { files, name: null, text: '', truncated: false };
    const path = join(settings.profiles, chosen.name);
    const handle = await fs.open(path, 'r');
    try {
      const length = Math.min(chosen.bytes, bohemiaLogPageMax);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, chosen.bytes - length));
      let text = buffer.toString('utf8');
      if (chosen.bytes > length) text = text.slice(text.indexOf('\n') + 1);
      return {
        files,
        name: chosen.name,
        text: redactText(text, await configSecrets()),
        truncated: chosen.bytes > length,
      };
    } finally {
      await handle.close();
    }
  }

  // Backups: `<id>.wgbackup.gz`, a gzip of length-prefixed JSON headers and file bytes.
  async function walk(
    root: string,
    base: string,
    out: { path: string; size: number }[],
  ) {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const full = join(root, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full, base, out);
      else if (entry.isFile()) {
        const stat = await fs.stat(full);
        out.push({
          path: relative(base, full).split(sep).join('/'),
          size: stat.size,
        });
      }
      if (out.length > backupLimitFiles)
        throw fail('The profiles folder has more than 10,000 files.', 413);
    }
  }
  async function createBackup(name: string) {
    const files: { path: string; size: number }[] = [];
    await walk(settings.profiles, settings.profiles, files);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > backupLimitBytes)
      throw fail('The profiles folder is larger than 512 MiB.', 413);
    const parts: Buffer[] = [];
    const add = (header: object, data: Buffer) => {
      const head = Buffer.from(JSON.stringify(header));
      const size = Buffer.alloc(4);
      size.writeUInt32BE(head.length);
      parts.push(size, head, data);
    };
    const config = await fs.readFile(settings.config);
    add(
      { kind: 'config', size: config.length, sha256: digest(config) },
      config,
    );
    for (const file of files) {
      const data = await fs.readFile(join(settings.profiles, file.path));
      add(
        {
          kind: 'profile',
          path: file.path,
          size: data.length,
          sha256: digest(data),
        },
        data,
      );
    }
    const id = `${new Date(system.now())
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const archive = gzipSync(Buffer.concat(parts));
    await writeAtomic(join(backupDirectory, `${id}.wgbackup.gz`), archive);
    await writeAtomic(
      join(backupDirectory, `${id}.json`),
      JSON.stringify({
        id,
        name: name || 'Backup',
        createdAt: system.now(),
        bytes: archive.length,
        files: files.length,
      }),
    );
    const list = (await listBackups()).backups;
    for (const old of list.slice(backupKeep)) await removeBackup(old.id);
    return `Backup saved with ${files.length} files.`;
  }
  async function listBackups(): Promise<BohemiaHostBackups> {
    const backups = [];
    for (const name of await fs.readdir(backupDirectory)) {
      if (!name.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(
          await fs.readFile(join(backupDirectory, name), 'utf8'),
        );
        if (typeof meta.id === 'string' && /^[a-z0-9-]{1,80}$/.test(meta.id))
          backups.push({
            id: meta.id,
            name: String(meta.name ?? '').slice(0, 80),
            createdAt: Number(meta.createdAt) || 0,
            bytes: Number(meta.bytes) || 0,
            files: Number(meta.files) || 0,
          });
      } catch {
        /* An unreadable entry is left out. */
      }
    }
    return {
      backups: backups.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50),
    };
  }
  async function removeBackup(id: string) {
    await fs.rm(join(backupDirectory, `${id}.wgbackup.gz`), { force: true });
    await fs.rm(join(backupDirectory, `${id}.json`), { force: true });
    return 'Backup removed.';
  }
  async function restoreBackup(id: string) {
    if (running()) throw fail('Stop the server before restoring a backup.');
    const file = join(backupDirectory, `${id}.wgbackup.gz`);
    if (!(await exists(file))) throw fail('That backup is not available.', 404);
    const data = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      createReadStream(file)
        .pipe(createGunzip())
        .on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > backupLimitBytes + 64 * 1024 * 1024)
            reject(fail('The backup is larger than its limit.', 413));
          chunks.push(chunk);
        })
        .on('end', () => resolve(Buffer.concat(chunks)))
        .on('error', reject);
    });
    const staging = `${settings.profiles}.wg-restore-${randomUUID().slice(0, 8)}`;
    await fs.mkdir(staging, { recursive: true });
    let config: Buffer | null = null;
    try {
      let offset = 0,
        count = 0;
      while (offset < data.length) {
        const length = data.readUInt32BE(offset);
        const header = z
          .object({
            kind: z.enum(['config', 'profile']),
            path: z.string().max(1024).optional(),
            size: z.number().int().nonnegative(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(
            JSON.parse(
              data.subarray(offset + 4, offset + 4 + length).toString(),
            ),
          );
        offset += 4 + length;
        const body = data.subarray(offset, offset + header.size);
        offset += header.size;
        if (body.length !== header.size || digest(body) !== header.sha256)
          throw fail('The backup failed its checksum. Nothing was changed.');
        if (header.kind === 'config') {
          config = Buffer.from(body);
          continue;
        }
        const target = join(staging, ...(header.path ?? '').split('/'));
        if (!header.path || !inside(staging, target))
          throw fail('The backup has an unsafe path. Nothing was changed.');
        await fs.mkdir(join(target, '..'), { recursive: true });
        await fs.writeFile(target, body);
        if (++count > backupLimitFiles)
          throw fail('The backup has too many files.');
      }
      const previous = `${settings.profiles}.wg-previous`;
      await fs.rm(previous, { recursive: true, force: true });
      if (await exists(settings.profiles))
        await fs.rename(settings.profiles, previous);
      await fs.rename(staging, settings.profiles);
      if (config) {
        await fs
          .copyFile(settings.config, `${settings.config}.wg-previous`)
          .catch(() => {});
        await writeAtomic(settings.config, config);
      }
      return `Backup restored with ${count} files. The previous profiles folder was kept.`;
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  // Mods.
  const app = bohemiaSteamApps[game].workshop;
  function contentDirectory(id: string) {
    if (!settings.workshopDirectory) return null;
    return join(
      settings.workshopDirectory,
      'steamapps',
      'workshop',
      'content',
      String(app),
      id,
    );
  }
  async function installedMods(): Promise<BohemiaInstalledMod[]> {
    if (!settings.workshopDirectory) return [];
    let manifest = new Map<string, number>();
    try {
      manifest = readWorkshopManifest(
        await fs.readFile(
          join(
            settings.workshopDirectory,
            'steamapps',
            'workshop',
            `appworkshop_${app}.acf`,
          ),
          'utf8',
        ),
      );
    } catch {
      /* No download yet. */
    }
    const root = join(
      settings.workshopDirectory,
      'steamapps',
      'workshop',
      'content',
      String(app),
    );
    let ids: string[] = [];
    try {
      ids = (await fs.readdir(root)).filter((name) => /^\d{1,20}$/.test(name));
    } catch {
      return [];
    }
    const result: BohemiaInstalledMod[] = [];
    for (const id of ids.slice(0, 600)) {
      const folder = join(root, id);
      const keys: string[] = [];
      for (const keyFolder of ['keys', 'Keys', 'key', 'Key'])
        try {
          for (const name of await fs.readdir(join(folder, keyFolder)))
            if (isModKeyFile(`${keyFolder}/${name}`) && !keys.includes(name))
              keys.push(name);
        } catch {
          /* No key folder of this name. */
        }
      let name: string | null = null;
      for (const meta of ['meta.cpp', 'mod.cpp'])
        try {
          const text = await fs.readFile(join(folder, meta), 'utf8');
          const found = /^\s*name\s*=\s*"([^"]{1,160})"/m.exec(text);
          if (found) {
            name = found[1]!;
            break;
          }
        } catch {
          /* Optional file. */
        }
      result.push({
        id,
        installedAt: manifest.get(id) ?? null,
        bytes: null,
        keys: keys.slice(0, 50),
        name,
      });
    }
    return result;
  }
  async function downloadMods(ids: readonly string[]) {
    if (
      !settings.steamcmd ||
      !settings.workshopDirectory ||
      !settings.steamUser
    )
      throw fail(
        'Set steamcmd, steamUser and workshopDirectory in the host settings.',
        503,
      );
    const steamcmd = settings.steamcmd,
      workshop = settings.workshopDirectory;
    const args = [
      '+force_install_dir',
      workshop,
      '+login',
      settings.steamUser,
      ...ids.flatMap((id) => [
        '+workshop_download_item',
        String(app),
        id,
        'validate',
      ]),
      '+quit',
    ];
    // One SteamCMD run. Steam sometimes times out on the first request.
    const attempt = async () => {
      const steam = system.spawn(steamcmd, args, {
        cwd: workshop,
        detached: false,
        output: true,
      });
      let tail = '';
      const keep = (chunk: Buffer) => {
        tail = (tail + chunk.toString('utf8')).slice(-4000);
      };
      steam.stdout?.on('data', keep);
      steam.stderr?.on('data', keep);
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          steam.kill();
          reject(fail('SteamCMD did not finish within 30 minutes.'));
        }, downloadTimeoutMs);
        const abort = () => {
          clearTimeout(timer);
          steam.kill();
          reject(fail('The Agent stopped during the download.'));
        };
        stopped.signal.addEventListener('abort', abort, { once: true });
        steam.once('error', (error) => {
          clearTimeout(timer);
          reject(fail(`SteamCMD could not start: ${error.message}`));
        });
        steam.once('exit', (exitCode) => {
          clearTimeout(timer);
          stopped.signal.removeEventListener('abort', abort);
          resolve(exitCode);
        });
      });
      const lines = tail
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const failed = lines.filter((line) =>
        /ERROR!|FAILED|Login Failure|password/i.test(line),
      );
      const missing: string[] = [];
      for (const id of ids)
        if (!(await exists(contentDirectory(id)!))) missing.push(id);
      return { code, lines, failed, missing };
    };
    let result = await attempt();
    if (
      result.missing.length &&
      result.failed.some((line) => /timed out|timeout/i.test(line))
    )
      result = await attempt();
    const { code, lines, failed, missing } = result;
    if (
      failed.some((line) =>
        /Login Failure|Cached credentials|password/i.test(line),
      )
    )
      throw fail(
        `SteamCMD has no saved login for ${settings.steamUser}. Log in once on the host with steamcmd +login ${settings.steamUser}.`,
      );
    if (code !== 0 || failed.length || missing.length)
      throw fail(
        `SteamCMD failed${missing.length ? ` for ${missing.join(', ')}` : ''}: ${redactText(
          (failed.at(-1) ?? lines.at(-1) ?? `exit code ${code}`).replace(
            /password\S*/gi,
            '[redacted]',
          ),
          [],
        )}`.slice(0, 400),
      );
    return `Downloaded ${ids.length} ${ids.length === 1 ? 'mod' : 'mods'}.`;
  }
  async function link(target: string, path: string) {
    await fs.symlink(
      target,
      path,
      system.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  async function applyMods() {
    const list = state.mods;
    const enabled = list.filter((mod) => mod.enabled !== false);
    const missing: string[] = [];
    for (const mod of enabled) {
      const content = contentDirectory(mod.id);
      if (!content || !(await exists(content))) missing.push(mod.id);
    }
    if (missing.length)
      throw fail(`Download these mods first: ${missing.join(', ')}.`);
    const wanted = new Set(enabled.map((mod) => bohemiaModFolder(mod.id)));
    // Remove links this Agent made that the list no longer has.
    for (const name of state.links)
      if (!wanted.has(name)) {
        const path = join(settings.serverDirectory, name);
        try {
          if ((await fs.lstat(path)).isSymbolicLink()) await fs.unlink(path);
        } catch {
          /* Already gone. */
        }
      }
    const links: string[] = [];
    for (const mod of enabled) {
      const name = bohemiaModFolder(mod.id);
      const path = join(settings.serverDirectory, name);
      const content = contentDirectory(mod.id)!;
      try {
        const stat = await fs.lstat(path);
        if (!stat.isSymbolicLink())
          throw fail(
            `${name} already exists in the server folder and is not a link.`,
          );
        if (
          (await fs.readlink(path)).replace(/[\\/]+$/, '') !==
          content.replace(/[\\/]+$/, '')
        ) {
          await fs.unlink(path);
          await link(content, path);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await link(content, path);
      }
      links.push(name);
    }
    // Keys of client mods.
    const keyDirectory = join(settings.serverDirectory, 'keys');
    await fs.mkdir(keyDirectory, { recursive: true });
    const nextKeys: { file: string; mod: string }[] = [];
    const ours = new Set(state.keys.map((key) => key.file));
    for (const mod of enabled.filter((item) => !item.serverOnly)) {
      const content = contentDirectory(mod.id)!;
      for (const folder of ['keys', 'Keys', 'key', 'Key']) {
        let names: string[] = [];
        try {
          names = await fs.readdir(join(content, folder));
        } catch {
          continue;
        }
        for (const name of names) {
          if (!isModKeyFile(`${folder}/${name}`)) continue;
          const target = join(keyDirectory, name);
          if (nextKeys.some((key) => key.file === name)) continue;
          if ((await exists(target)) && !ours.has(name)) continue;
          await fs.copyFile(join(content, folder, name), target);
          nextKeys.push({ file: name, mod: mod.id });
        }
      }
    }
    for (const key of state.keys)
      if (!nextKeys.some((next) => next.file === key.file))
        await fs.rm(join(keyDirectory, key.file), { force: true });
    state.links = links;
    state.keys = nextKeys;
    if (listRevision(state.applied) !== listRevision(list))
      state.previous = state.applied.map((mod) => ({ ...mod }));
    state.applied = list.map((mod) => ({ ...mod }));
    await save();
    return `Applied ${enabled.length} mods and ${nextKeys.length} keys.`;
  }

  async function status(): Promise<BohemiaHostStatus> {
    const alive = running();
    let memoryBytes: number | null = null;
    if (alive && system.platform === 'linux')
      try {
        const text = await fs.readFile(`/proc/${state.pid}/status`, 'utf8');
        const kb = /VmRSS:\s+(\d+)\s+kB/.exec(text);
        if (kb) memoryBytes = Number(kb[1]) * 1024;
      } catch {
        /* The process may have exited. */
      }
    let freeDiskBytes: number | null = null;
    try {
      const disk = await fs.statfs(settings.serverDirectory);
      freeDiskBytes = disk.bavail * disk.bsize;
    } catch {
      /* Not reported on this file system. */
    }
    const load = system.platform === 'linux' ? (loadavg()[0] ?? null) : null;
    return {
      configured: true,
      running: alive || external(),
      managed: alive,
      pid: alive ? state.pid : null,
      startedAt: alive ? state.startedAt : null,
      memoryBytes,
      loadAverage: load,
      freeDiskBytes,
      steamcmd: !!(
        settings.steamcmd &&
        settings.steamUser &&
        settings.workshopDirectory
      ),
      job: state.job,
      restartPending:
        alive &&
        state.launched !== null &&
        listRevision(state.launched) !== listRevision(state.applied),
      platform: system.platform,
    };
  }

  async function mods(): Promise<BohemiaHostMods> {
    return {
      revision: listRevision(state.mods),
      mods: state.mods,
      installed: await installedMods(),
      launched: running() ? state.launched : null,
      previous: state.previous,
      keys: state.keys.map((key) => key.file),
      checkedAt: state.checkedAt,
    };
  }

  function receipt(
    message: string,
    record: BohemiaJob | null = null,
  ): BohemiaHostReceipt {
    return { ok: true, message, job: record };
  }

  return {
    async read(resource: BohemiaHostResource, params: URLSearchParams) {
      switch (resource) {
        case 'status':
          return status();
        case 'config':
          return (await readConfig()).view;
        case 'logs': {
          const name = params.get('name');
          if (name !== null && !bohemiaLogName.safeParse(name).success)
            throw fail('That log file is not available.', 404);
          return readLogs(name);
        }
        case 'backups':
          return listBackups();
        case 'mods':
          return mods();
      }
    },
    async execute(value: unknown): Promise<BohemiaHostReceipt> {
      const parsed = bohemiaHostCommand.safeParse(value);
      if (!parsed.success)
        throw new AgentError(
          400,
          'invalid-operation',
          'The host command is not valid.',
        );
      const command: BohemiaHostCommand = parsed.data;
      switch (command.action) {
        case 'start':
          return receipt('Starting', startJob('start', startProcess));
        case 'stop':
          return receipt('Stopping', startJob('stop', stopProcess));
        case 'restart':
          return receipt(
            'Restarting',
            startJob('restart', async () => {
              await stopProcess();
              return startProcess();
            }),
          );
        case 'save-config': {
          const { raw } = await readConfig();
          if (digest(raw) !== command.revision)
            throw fail('The config file changed. Reload it before saving.');
          const text = restoreConfigSecrets(
            command.text,
            redactConfigSecrets(raw).secrets,
          );
          if (Buffer.byteLength(text) > bohemiaConfigMaxBytes)
            throw fail('The config file is larger than 48 KiB.', 413);
          await fs.copyFile(settings.config, `${settings.config}.wg-previous`);
          await writeAtomic(settings.config, text);
          return receipt(running() ? 'Saved. Restart to apply.' : 'Saved.');
        }
        case 'save-mods':
          if (listRevision(state.mods) !== command.revision)
            throw fail('The mod list changed. Reload it before saving.');
          state.mods = command.mods;
          await save();
          return receipt('Saved.');
        case 'install-mods':
          return receipt(
            'Downloading',
            startJob('install-mods', () => downloadMods(command.ids)),
          );
        case 'apply-mods':
          if (listRevision(state.mods) !== command.revision)
            throw fail('The mod list changed. Reload it before applying.');
          if (command.restart && external())
            throw fail(
              'WarGuardian did not start this server, so it cannot restart it.',
            );
          return receipt(
            'Applying',
            startJob('apply-mods', async () => {
              const applied = await applyMods();
              if (!command.restart) return applied;
              await stopProcess();
              await startProcess();
              return `${applied} Server restarted.`;
            }),
          );
        case 'revert-mods': {
          const previous = state.previous;
          if (!previous) throw fail('There is no earlier mod list.');
          if (command.restart && external())
            throw fail(
              'WarGuardian did not start this server, so it cannot restart it.',
            );
          return receipt(
            'Reverting',
            startJob('revert-mods', async () => {
              state.mods = previous.map((mod) => ({ ...mod }));
              const applied = await applyMods();
              if (!command.restart) return `Reverted. ${applied}`;
              await stopProcess();
              await startProcess();
              return `Reverted. ${applied} Server restarted.`;
            }),
          );
        }
        case 'check-mod-updates':
          state.checkedAt = system.now();
          await save();
          return receipt('Checked.');
        case 'backup':
          return receipt(
            'Backing up',
            startJob('backup', () => createBackup(command.name)),
          );
        case 'restore':
          return receipt(
            'Restoring',
            startJob('restore', () => restoreBackup(command.id)),
          );
        case 'remove-backup':
          return receipt(await removeBackup(command.id));
      }
    },
    /** For tests: wait for the running job. */
    async idle() {
      await active;
    },
    async close() {
      stopped.abort();
      await active?.catch(() => {});
    },
  };
}
export type BohemiaHostController = Awaited<
  ReturnType<typeof createBohemiaHostController>
>;
