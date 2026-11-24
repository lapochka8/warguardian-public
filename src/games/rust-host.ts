import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { loadavg } from 'node:os';
import type { BohemiaJob } from '../../vendor/games/bohemia-host';
import {
  isRustLevelUrl,
  parseRustUsers,
  pngWidth,
  rustConfigMaxBytes,
  rustPluginConfigFolder,
  rustPluginConfigMaxBytes,
  rustPluginConfigText,
  rustPluginFileProblem,
  rustPluginUploadChunkBytes,
  rustMapChunkBytes,
  rustMapFileName,
  rustMapMarginPixels,
  rustMapMaxBytes,
  rustHostCommand,
  rustWipeFile,
  rustLogPageMax,
  rustSecretPlaceholder,
  type RustFrameworkName,
  type RustHostCommand,
  type RustHostReceipt,
  type RustPluginUpdates,
  type RustHostResource,
  type RustHostStatus,
  type RustWipeKind,
} from '../../vendor/games/rust-host';
import { absolutePath } from '../config';

type RustHostJob = BohemiaJob;
import { AgentError } from '../errors';
import { readTarGz, readZip } from './archive';
import { nodeBohemiaSystem, type BohemiaHostSystem } from './bohemia-host';

/**
 * The Rust game host on the machine of the WarGuardian Agent: start and
 * stop, the SteamCMD update, `server.cfg`, logs, backups, wipes and plugin
 * files. Every path comes from the settings file of the server and from
 * fixed names. Every process argument is built here. No shell runs.
 *
 * A wipe and an update stop the server first, and start it again when it
 * ran. A server this Agent did not start is never stopped by it.
 */

/** The Steam app of the Rust dedicated server. */
export const rustServerAppId = 258550;

/** Names the Agent sets itself, refused in `launchArguments`. */
const managedArguments = new Set([
  '+server.identity',
  '+server.seed',
  '+server.worldsize',
  '-logfile',
  '-batchmode',
  '-nographics',
]);

/**
 * One extra launch parameter: `+server.port 28015`, `+rcon.web 1` or
 * `-silent-crashes`. The name and its value are passed as two arguments,
 * never through a shell.
 */
const launchArgument = z
  .string()
  .regex(
    /^[+-][A-Za-z][A-Za-z0-9_.-]{0,60}(?: [^\r\n"]{1,1024})?$/,
    'Use +name value or -name.',
  )
  .refine(
    (value) => !managedArguments.has(value.split(' ')[0]!.toLowerCase()),
    'The Agent sets the identity, the seed and the log file itself.',
  );

/** Version 1 of the host settings file. Unknown keys are ignored. */
export const rustHostSettings = z.object({
  v: z.literal(1).default(1),
  /** `RustDedicated` or `RustDedicated.exe`, with its full path. */
  executable: absolutePath,
  /** The server installation, which holds the `server` folder. */
  serverDirectory: absolutePath,
  /** `+server.identity`: the folder name below `server`. */
  identity: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  steamcmd: absolutePath.optional(),
  /** `+server.seed`, when the Agent sets it. A wipe may then change it. */
  seed: z.number().int().min(1).max(2_147_483_647).optional(),
  /** `+server.worldsize`, when the Agent sets it. A wipe may then change it. */
  worldSize: z.number().int().min(1_000).max(6_000).optional(),
  /**
   * `+server.levelurl`: the address of a custom map. With it the Agent
   * sets no seed and no world size, as Rust asks for a custom map.
   */
  levelUrl: z.string().max(300).refine(isRustLevelUrl).optional(),
  launchArguments: z.array(launchArgument).max(60).default([]),
  /** Start the server again when it ends without a stop from WarGuardian. */
  autoRestart: z.boolean().default(false),
});
export { rustWipeFile };
export type RustHostSettings = z.output<typeof rustHostSettings>;

const job = z.object({
  id: z.string().max(80),
  action: z.string().max(40),
  state: z.enum(['running', 'succeeded', 'failed', 'unknown']),
  message: z.string().max(400),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().nullable(),
});

/** Version 1 of the host state file. Every field has a default. */
export const rustHostState = z.object({
  v: z.literal(1).default(1),
  pid: z.number().int().positive().nullable().default(null),
  startedAt: z.number().int().nonnegative().nullable().default(null),
  job: job.nullable().default(null),
  history: z.array(job).max(20).default([]),
  /** The server was started here and not stopped since. */
  wanted: z.boolean().default(false),
  /** When the server was started again after it ended by itself. */
  restarts: z.array(z.number().int().nonnegative()).max(10).default([]),
});
export type RustHostState = z.output<typeof rustHostState>;

const stopWaitMs = 60_000;
const terminateWaitMs = 15_000;
const startCheckMs = 20_000;
const updateTimeoutMs = 60 * 60_000;
const backupLimitBytes = 2_147_483_648;
const backupLimitFiles = 20_000;
const backupKeep = 20;
const logKeep = 20;
const pluginMaxBytes = 4 * 1024 * 1024;

const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const fail = (message: string, status = 409) =>
  new AgentError(status, 'host-refused', message);

const passwordLine = /^(\s*rcon\.password\s+")([^"\r\n]*)(")/gim;

/** `rcon.password "x"` with the value replaced, so it never reaches the panel. */
export function redactRustConfig(text: string): {
  text: string;
  secret: string | null;
} {
  let secret: string | null = null;
  const redacted = text.replace(
    passwordLine,
    (match, head: string, value: string, tail: string) => {
      if (!value) return match;
      secret = value;
      return `${head}${rustSecretPlaceholder}${tail}`;
    },
  );
  return { text: redacted, secret };
}

/** Put the stored password back where the editor kept the placeholder. */
export function restoreRustConfig(edited: string, secret: string | null) {
  return edited.replace(
    passwordLine,
    (match, head: string, value: string, tail: string) => {
      if (value !== rustSecretPlaceholder) return match;
      if (secret === null) throw fail('Enter a value for rcon.password.', 400);
      return `${head}${secret}${tail}`;
    },
  );
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

/** The hosts a release download may redirect to. */
const redirectHosts = /(?:^|\.)(?:github\.com|githubusercontent\.com)$/;

/**
 * Download one file over HTTPS. A redirect is followed up to three times,
 * and only to the hosts that serve release files.
 */
function downloadFile(
  url: string,
  maxBytes: number,
  redirects = 0,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const operation = httpsRequest(
      url,
      {
        method: 'GET',
        headers: { 'User-Agent': 'WarGuardian-Agent' },
        timeout: 30_000,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          let next: URL | null = null;
          try {
            next = new URL(String(response.headers.location ?? ''), url);
          } catch {
            // Refused below.
          }
          if (
            !next ||
            next.protocol !== 'https:' ||
            !redirectHosts.test(next.hostname) ||
            redirects >= 3
          )
            reject(fail('The file could not be downloaded.', 502));
          else
            downloadFile(next.href, maxBytes, redirects + 1).then(
              resolve,
              reject,
            );
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(
            fail(
              status === 404
                ? 'The file was not found.'
                : 'The file could not be downloaded.',
              502,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            operation.destroy();
            reject(fail('The file is too large.', 502));
          } else chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', () =>
          reject(fail('The file could not be downloaded.', 502)),
        );
      },
    );
    operation.on('timeout', () => operation.destroy());
    operation.on('error', () =>
      reject(fail('The file could not be downloaded.', 502)),
    );
    operation.end();
  });
}

/**
 * The release file of each plugin framework, by platform. Oxide publishes
 * its latest release under a fixed name. Carbon keeps its production build
 * under a fixed tag.
 */
export const rustFrameworkReleases = {
  oxide: {
    name: 'Oxide',
    marker: 'RustDedicated_Data/Managed/Oxide.Rust.dll',
    win32: {
      url: 'https://github.com/OxideMod/Oxide.Rust/releases/latest/download/Oxide.Rust.zip',
      form: 'zip',
    },
    linux: {
      url: 'https://github.com/OxideMod/Oxide.Rust/releases/latest/download/Oxide.Rust-linux.zip',
      form: 'zip',
    },
  },
  carbon: {
    name: 'Carbon',
    marker: 'carbon/managed/',
    win32: {
      url: 'https://github.com/CarbonCommunity/Carbon/releases/download/production_build/Carbon.Windows.Release.zip',
      form: 'zip',
    },
    linux: {
      url: 'https://github.com/CarbonCommunity/Carbon/releases/download/production_build/Carbon.Linux.Release.tar.gz',
      form: 'tar',
    },
  },
} as const;
const frameworkMaxBytes = 100 * 1024 * 1024;

type Options = {
  serverId: string;
  settings: RustHostSettings;
  /** Where the settings came from, so a wipe can save a new seed. */
  settingsFile?: string;
  stateDirectory: string;
  system?: BohemiaHostSystem;
  startCheckMs?: number;
  stopWaitMs?: number;
  /** Ask the running server to save and quit, over its console. */
  quit?: () => Promise<void>;
  /** A game server answers on this server's RCON port, started by anyone. */
  externalRunning?: () => boolean;
  /**
   * Reload one plugin over the console of the running server. True when the
   * server confirmed it. Without it, an updated plugin is not reloaded.
   */
  reloadPlugin?: (name: string) => Promise<boolean>;
  /** For tests. Default: HTTPS without redirects. */
  download?: (url: string, maxBytes: number) => Promise<Buffer>;
};

/** Reads the settings file. Null when there is none. */
export async function readRustHostSettings(
  file: string,
): Promise<RustHostSettings | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  const parsed = rustHostSettings.safeParse(adoptManagedArguments(value));
  if (!parsed.success)
    throw new AgentError(
      503,
      'not-configured',
      'The host settings file is not valid.',
    );
  return parsed.data;
}

/**
 * A settings file written by hand may still name a parameter the Agent sets
 * itself. Such a parameter leaves the extra parameters, and a seed or world
 * size given that way becomes the setting when the file has none. The file
 * then stays usable instead of stopping every host tool.
 */
function adoptManagedArguments(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const settings = { ...(value as Record<string, unknown>) };
  if (!Array.isArray(settings.launchArguments)) return settings;
  const kept: unknown[] = [];
  for (const argument of settings.launchArguments) {
    const [name, given] =
      typeof argument === 'string' ? argument.split(' ') : [];
    if (!name || !managedArguments.has(name.toLowerCase())) {
      kept.push(argument);
      continue;
    }
    const field =
      name.toLowerCase() === '+server.seed'
        ? 'seed'
        : name.toLowerCase() === '+server.worldsize'
          ? 'worldSize'
          : null;
    const number = Number(given);
    if (field && settings[field] === undefined && Number.isInteger(number))
      settings[field] = number;
  }
  settings.launchArguments = kept;
  return settings;
}

export async function createRustHostController(options: Options) {
  const system = options.system ?? nodeBohemiaSystem;
  let settings = options.settings;
  const directory = options.stateDirectory;
  const stateFile = join(directory, 'state.json');
  const backupDirectory = join(directory, 'backups');
  const logDirectory = join(directory, 'logs');
  const previousDirectory = join(directory, 'plugins-previous');
  for (const folder of [backupDirectory, logDirectory, previousDirectory])
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const saveDirectory = join(
    settings.serverDirectory,
    'server',
    settings.identity,
  );
  const configFile = join(saveDirectory, 'cfg', 'server.cfg');
  const download = options.download ?? downloadFile;

  const state = await load();
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

  async function load(): Promise<RustHostState> {
    try {
      const parsed = rustHostState.safeParse(
        JSON.parse(await fs.readFile(stateFile, 'utf8')),
      );
      if (parsed.success) return parsed.data;
      throw fail('The host state file is unreadable. It was kept.', 503);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return rustHostState.parse({});
      throw error;
    }
  }
  async function save() {
    await writeAtomic(stateFile, JSON.stringify(state));
  }

  const running = () => state.pid !== null && system.alive(state.pid);
  const external = () => !running() && (options.externalRunning?.() ?? false);

  function startJob(action: string, work: () => Promise<string>) {
    if (active || state.job?.state === 'running')
      throw fail('Another host job is running.');
    const record: RustHostJob = {
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

  async function framework(): Promise<'oxide' | 'carbon' | null> {
    if (await exists(join(settings.serverDirectory, 'carbon', 'managed')))
      return 'carbon';
    if (
      await exists(
        join(
          settings.serverDirectory,
          'RustDedicated_Data',
          'Managed',
          'Oxide.Rust.dll',
        ),
      )
    )
      return 'oxide';
    return null;
  }

  async function pruneLogs() {
    const names = (await fs.readdir(logDirectory).catch(() => [] as string[]))
      .filter((name) => /^server-\d+\.log$/.test(name))
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - logKeep)))
      await fs.rm(join(logDirectory, name), { force: true });
  }

  // Process control.
  async function startProcess() {
    if (running()) throw fail('The server is already running.');
    if (external())
      throw fail(
        'A server that WarGuardian did not start is running. Stop it first.',
      );
    await pruneLogs();
    const custom = settings.levelUrl;
    const args = [
      '-batchmode',
      '-nographics',
      '+server.identity',
      settings.identity,
      // A custom map takes no seed and no world size.
      ...(custom !== undefined
        ? ['+server.levelurl', custom]
        : [
            ...(settings.seed === undefined
              ? []
              : ['+server.seed', String(settings.seed)]),
            ...(settings.worldSize === undefined
              ? []
              : ['+server.worldsize', String(settings.worldSize)]),
          ]),
      ...settings.launchArguments.flatMap((argument) => {
        const space = argument.indexOf(' ');
        const name = space < 0 ? argument : argument.slice(0, space);
        // The address above replaces one in the launch parameters.
        if (custom !== undefined && name.toLowerCase() === '+server.levelurl')
          return [];
        return space < 0 ? [argument] : [name, argument.slice(space + 1)];
      }),
      '-logfile',
      join(logDirectory, `server-${system.now()}.log`),
    ];
    child = system.spawn(settings.executable, args, {
      cwd: settings.serverDirectory,
      // The server outlives the Agent, also across its self-update.
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
    state.wanted = true;
    await save();
    const until = system.now() + (options.startCheckMs ?? startCheckMs);
    while (system.now() < until) {
      if (!system.alive(pid)) {
        state.pid = null;
        state.startedAt = null;
        await save();
        throw fail('The server stopped right after it started. Read its log.');
      }
      await system.sleep(500);
    }
    return 'Started.';
  }

  async function waitForExit(pid: number, ms: number) {
    const until = system.now() + ms;
    while (system.now() < until) {
      if (!system.alive(pid)) return true;
      await system.sleep(500);
    }
    return !system.alive(pid);
  }

  async function stopProcess() {
    // A stop from here is wanted, so the watch does not start it again.
    state.wanted = false;
    const pid = state.pid;
    if (pid === null || !system.alive(pid)) {
      if (external())
        throw fail(
          'WarGuardian did not start this server, so it cannot stop it.',
        );
      state.pid = null;
      state.startedAt = null;
      await save();
      return 'Already stopped.';
    }
    // `quit` saves the world first. The process is ended only if it stays.
    await options.quit?.().catch(() => undefined);
    let gone = await waitForExit(
      pid,
      options.quit ? (options.stopWaitMs ?? stopWaitMs) : 0,
    );
    if (!gone) {
      try {
        system.terminate(pid);
      } catch {
        // The process ended in between.
      }
      gone = await waitForExit(pid, terminateWaitMs);
    }
    if (!gone) throw fail('The server did not stop.');
    state.pid = null;
    state.startedAt = null;
    await save();
    return 'Stopped.';
  }

  /**
   * Start the server again when it ended by itself: at most three times in
   * ten minutes, so a server that cannot start is left alone.
   */
  async function watch() {
    if (
      !settings.autoRestart ||
      !state.wanted ||
      active ||
      state.job?.state === 'running' ||
      running() ||
      external()
    )
      return false;
    const now = system.now();
    state.restarts = state.restarts.filter((at) => now - at < 600_000);
    if (state.restarts.length >= 3) {
      state.wanted = false;
      await save();
      return false;
    }
    state.restarts.push(now);
    startJob('auto-restart', startProcess);
    return true;
  }
  const watchTimer = settings.autoRestart
    ? setInterval(() => void watch().catch(() => undefined), 15_000)
    : undefined;
  watchTimer?.unref();

  /** Stop the server for a job, run it, then start again if it ran. */
  async function whileStopped(work: () => Promise<string>) {
    if (external())
      throw fail(
        'A server that WarGuardian did not start is running. Stop it first.',
      );
    const wasRunning = running();
    if (wasRunning) await stopProcess();
    const message = await work();
    if (!wasRunning) return message;
    await startProcess();
    return `${message} Server started.`;
  }

  async function update() {
    const steamcmd = settings.steamcmd;
    if (!steamcmd) throw fail('Set steamcmd in the host settings first.');
    const before = await framework();
    return whileStopped(async () => {
      const code = await new Promise<number | null>((resolve, reject) => {
        const job = system.spawn(
          steamcmd,
          [
            '+force_install_dir',
            settings.serverDirectory,
            '+login',
            'anonymous',
            '+app_update',
            String(rustServerAppId),
            'validate',
            '+quit',
          ],
          { cwd: settings.serverDirectory, detached: false, output: true },
        );
        const timer = setTimeout(() => {
          job.kill();
          reject(fail('The update took too long and was stopped.'));
        }, updateTimeoutMs);
        job.stdout?.resume();
        job.stderr?.resume();
        job.once('error', () => {
          clearTimeout(timer);
          reject(fail('SteamCMD could not be started.'));
        });
        job.once('exit', (exit) => {
          clearTimeout(timer);
          resolve(exit);
        });
      });
      if (code !== 0) throw fail(`SteamCMD ended with code ${code}.`);
      // A game update replaces the files Oxide changed, and a new game
      // build needs the framework build made for it. So the newest release
      // of the installed framework is written before the server starts.
      if (!before) return 'Updated.';
      const name = rustFrameworkReleases[before].name;
      return writeFramework(before).then(
        () => `Updated. ${name} was updated too.`,
        () => `Updated. ${name} could not be updated: install it again.`,
      );
    });
  }

  /** Download the release of a framework and write it into the server folder. */
  async function writeFramework(name: RustFrameworkName) {
    const release = rustFrameworkReleases[name];
    const source = release[system.platform];
    const archive = await download(source.url, frameworkMaxBytes);
    let files;
    try {
      files = source.form === 'zip' ? readZip(archive) : readTarGz(archive);
    } catch {
      throw fail('The downloaded release cannot be read.', 502);
    }
    if (!files.some((file) => file.name.startsWith(release.marker)))
      throw fail('The downloaded release is not the expected one.', 502);
    for (const file of files) {
      const target = join(settings.serverDirectory, ...file.name.split('/'));
      await fs.mkdir(dirname(target), { recursive: true });
      await writeAtomic(target, file.data);
      if (
        system.platform === 'linux' &&
        file.mode !== null &&
        file.mode & 0o111
      )
        await fs.chmod(target, 0o755).catch(() => undefined);
    }
    return files.length;
  }

  async function installFramework(name: RustFrameworkName) {
    const present = await framework();
    if (present && present !== name)
      throw fail(
        `This server has ${rustFrameworkReleases[present].name}. A server runs one plugin framework.`,
      );
    return whileStopped(async () => {
      const count = await writeFramework(name);
      return `Installed ${rustFrameworkReleases[name].name}: ${count} files.`;
    });
  }

  /**
   * Remove the files of the installed framework. Oxide changes files of the
   * game, so SteamCMD then checks the game files and puts them back. The
   * plugin folders stay.
   */
  async function removeFramework() {
    const present = await framework();
    if (!present) throw fail('This server has no plugin framework.');
    const name = rustFrameworkReleases[present].name;
    await whileStopped(async () => {
      const root = settings.serverDirectory;
      if (present === 'oxide') {
        const managed = join(root, 'RustDedicated_Data', 'Managed');
        for (const entry of await fs.readdir(managed).catch(() => []))
          if (/^Oxide\.[A-Za-z0-9.]+\.dll$/.test(entry))
            await fs.rm(join(managed, entry), { force: true });
        for (const entry of await fs.readdir(root).catch(() => []))
          if (entry.startsWith('Oxide.Compiler'))
            await fs.rm(join(root, entry), { force: true });
      } else {
        for (const entry of ['managed', 'tools', 'native', 'developer'])
          await fs.rm(join(root, 'carbon', entry), {
            recursive: true,
            force: true,
          });
        for (const entry of [
          'winhttp.dll',
          'doorstop_config.ini',
          'Carbon.targets',
        ])
          await fs.rm(join(root, entry), { force: true });
      }
      return '';
    });
    if (!settings.steamcmd)
      return `Removed ${name}. Update the game to put its files back.`;
    await update();
    return `Removed ${name}. The game files were checked.`;
  }

  // Config.
  async function readConfig() {
    let raw = '';
    try {
      raw = await fs.readFile(configFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (Buffer.byteLength(raw) > rustConfigMaxBytes)
      throw fail('The config file is larger than 48 KiB.', 413);
    return {
      raw,
      view: {
        revision: digest(raw),
        file: 'server.cfg',
        text: redactRustConfig(raw).text,
      },
    };
  }

  // Logs.
  async function readLogs(name: string | null) {
    const names = (await fs.readdir(logDirectory).catch(() => [] as string[]))
      .filter((entry) => /^server-\d+\.log$/.test(entry))
      .sort()
      .reverse()
      .slice(0, 50);
    const files = [];
    for (const entry of names) {
      const stat = await fs.stat(join(logDirectory, entry)).catch(() => null);
      if (stat)
        files.push({
          name: entry,
          kind: 'log' as const,
          bytes: stat.size,
          modifiedAt: Math.floor(stat.mtimeMs),
        });
    }
    const chosen = name ?? files[0]?.name ?? null;
    if (chosen !== null && !names.includes(chosen))
      throw fail('That log file is not available.', 404);
    let text = '';
    let truncated = false;
    if (chosen) {
      const handle = await fs.open(join(logDirectory, chosen), 'r');
      try {
        const { size } = await handle.stat();
        const length = Math.min(size, rustLogPageMax - 4_096);
        truncated = size > length;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        text = buffer.toString('utf8');
      } finally {
        await handle.close();
      }
      const secret = redactRustConfig((await readConfig()).raw).secret;
      if (secret && secret.length >= 3)
        text = text.split(secret).join('[redacted]');
    }
    return {
      files,
      name: chosen,
      text: text.slice(0, rustLogPageMax),
      truncated,
    };
  }

  // Backups: the identity folder and the plugin settings and data.
  async function backupSources() {
    const found = await framework();
    return [
      { from: saveDirectory, to: 'server' },
      ...(found === 'oxide'
        ? ['plugins', 'config', 'data', 'lang'].map((name) => ({
            from: join(settings.serverDirectory, 'oxide', name),
            to: join('oxide', name),
          }))
        : found === 'carbon'
          ? ['plugins', 'configs', 'data', 'lang'].map((name) => ({
              from: join(settings.serverDirectory, 'carbon', name),
              to: join('carbon', name),
            }))
          : []),
    ];
  }

  /** Copy a folder with plain files and folders only, within the limits. */
  async function copyTree(
    from: string,
    to: string,
    count: { files: number; bytes: number },
  ) {
    let entries;
    try {
      entries = await fs.readdir(from, { withFileTypes: true });
    } catch {
      return;
    }
    await fs.mkdir(to, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      if (entry.isDirectory()) await copyTree(source, target, count);
      else if (entry.isFile()) {
        const { size } = await fs.stat(source);
        count.files += 1;
        count.bytes += size;
        if (count.files > backupLimitFiles || count.bytes > backupLimitBytes)
          throw fail('The backup is larger than 2 GiB or 20000 files.');
        await fs.copyFile(source, target);
      }
    }
  }

  const backupMeta = z.object({
    name: z.string().max(80).default(''),
    createdAt: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative().default(0),
    files: z.number().int().nonnegative().default(0),
  });

  async function listBackups() {
    const names = await fs.readdir(backupDirectory).catch(() => [] as string[]);
    const backups = [];
    for (const id of names) {
      if (!/^[a-z0-9-]{1,80}$/.test(id)) continue;
      try {
        const meta = backupMeta.parse(
          JSON.parse(
            await fs.readFile(join(backupDirectory, id, 'meta.json'), 'utf8'),
          ),
        );
        backups.push({ id, ...meta });
      } catch {
        // A folder without a readable description is not a finished backup.
      }
    }
    return {
      backups: backups.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50),
    };
  }

  async function createBackup(name: string) {
    const id = `${new Date(system.now())
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const target = join(backupDirectory, id);
    const count = { files: 0, bytes: 0 };
    try {
      for (const source of await backupSources())
        await copyTree(source.from, join(target, source.to), count);
      await writeAtomic(
        join(target, 'meta.json'),
        JSON.stringify({
          name,
          createdAt: system.now(),
          bytes: count.bytes,
          files: count.files,
        }),
      );
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true });
      throw error;
    }
    const { backups } = await listBackups();
    for (const old of backups.slice(backupKeep))
      await fs.rm(join(backupDirectory, old.id), {
        recursive: true,
        force: true,
      });
    return `Backed up ${count.files} files.`;
  }

  async function restoreBackup(id: string) {
    const source = join(backupDirectory, id);
    if (!(await exists(join(source, 'meta.json'))))
      throw fail('That backup does not exist.', 404);
    if (running() || external()) throw fail('Stop the server first.');
    const count = { files: 0, bytes: 0 };
    for (const part of await backupSources())
      if (await exists(join(source, part.to)))
        await copyTree(join(source, part.to), part.from, count);
    return `Restored ${count.files} files.`;
  }

  // Wipes.
  async function wipedAt() {
    const names = await fs.readdir(saveDirectory).catch(() => [] as string[]);
    let first: number | null = null;
    for (const name of names) {
      if (!/\.sav$/i.test(name)) continue;
      const stat = await fs.stat(join(saveDirectory, name)).catch(() => null);
      const at = stat ? Math.floor(stat.birthtimeMs || stat.mtimeMs) : null;
      if (at !== null && (first === null || at < first)) first = at;
    }
    return first;
  }

  async function wipe(
    kind: RustWipeKind,
    seed: number | undefined,
    worldSize?: number,
    levelUrl?: string,
  ) {
    if (seed !== undefined && settings.seed === undefined)
      throw fail('The seed of this server is not set by WarGuardian.');
    if (worldSize !== undefined && settings.worldSize === undefined)
      throw fail('The world size of this server is not set by WarGuardian.');
    // A new size makes a new map, so the old map must go with it.
    if (worldSize !== undefined && kind === 'blueprints')
      throw fail('A new world size needs a map wipe.');
    if (levelUrl !== undefined && kind === 'blueprints')
      throw fail('Another map needs a map wipe.');
    if (levelUrl && (seed !== undefined || worldSize !== undefined))
      throw fail('A custom map has no seed and no world size.');
    return whileStopped(async () => {
      const entries = await fs
        .readdir(saveDirectory, { withFileTypes: true })
        .catch(() => []);
      let removed = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !rustWipeFile(entry.name, kind)) continue;
        await fs.rm(join(saveDirectory, entry.name), { force: true });
        removed += 1;
      }
      if (
        seed !== undefined ||
        worldSize !== undefined ||
        levelUrl !== undefined
      ) {
        const next = {
          ...settings,
          ...(seed === undefined ? {} : { seed }),
          ...(worldSize === undefined ? {} : { worldSize }),
        };
        // An empty address, a new seed or a new size means a procedural map.
        if (levelUrl) next.levelUrl = levelUrl;
        else delete next.levelUrl;
        settings = next;
        if (options.settingsFile)
          await writeAtomic(options.settingsFile, JSON.stringify(settings));
      }
      return `Wiped ${removed} files.`;
    });
  }

  // Plugins.
  async function pluginDirectory() {
    const found = await framework();
    if (!found) throw fail('Install Oxide or Carbon on this server first.');
    return join(settings.serverDirectory, found, 'plugins');
  }

  async function listPlugins() {
    const found = await framework();
    if (!found) return { framework: null, plugins: [] };
    const folder = join(settings.serverDirectory, found, 'plugins');
    const names = (await fs.readdir(folder).catch(() => [] as string[]))
      .filter((name) => /^[A-Za-z0-9_]{1,80}\.cs$/.test(name))
      .sort()
      .slice(0, 500);
    const plugins = [];
    for (const file of names) {
      const stat = await fs.stat(join(folder, file)).catch(() => null);
      if (!stat?.isFile()) continue;
      plugins.push({
        name: file.slice(0, -3),
        bytes: stat.size,
        modifiedAt: Math.floor(stat.mtimeMs),
        previous: await exists(join(previousDirectory, file)),
      });
    }
    return {
      framework: found,
      plugins,
      // This Agent takes an uploaded plugin file.
      upload: true,
      ...(pluginUpdates ? { updates: pluginUpdates } : {}),
    };
  }

  /** The parts of the plugin file that is being uploaded. Memory only. */
  let pluginUpload:
    | { name: string; total: number; sha256: string; parts: Buffer[] }
    | undefined;

  /**
   * Take one part of an uploaded plugin file. The part at offset 0 starts
   * the file. After the last part the whole file is checked and written to
   * `<plugins folder>/<Name>.cs`. The file it replaces is kept as the
   * earlier file, as for an install.
   */
  async function uploadPlugin(command: {
    name: string;
    offset: number;
    total: number;
    sha256: string;
    data: string;
  }) {
    const folder = await pluginDirectory();
    const interrupted = () =>
      fail('The upload was interrupted. Send the file again.');
    if (command.offset === 0)
      pluginUpload = {
        name: command.name,
        total: command.total,
        sha256: command.sha256,
        parts: [],
      };
    const upload = pluginUpload;
    const received = upload
      ? upload.parts.reduce((sum, part) => sum + part.length, 0)
      : 0;
    if (
      !upload ||
      upload.name !== command.name ||
      upload.total !== command.total ||
      upload.sha256 !== command.sha256 ||
      received !== command.offset
    ) {
      pluginUpload = undefined;
      throw interrupted();
    }
    const part = Buffer.from(command.data, 'base64');
    if (
      !part.length ||
      part.length > rustPluginUploadChunkBytes ||
      received + part.length > upload.total
    ) {
      pluginUpload = undefined;
      throw interrupted();
    }
    upload.parts.push(part);
    if (received + part.length < upload.total)
      return `Received ${received + part.length} of ${upload.total} bytes.`;
    pluginUpload = undefined;
    const file = Buffer.concat(upload.parts);
    if (digest(file) !== upload.sha256) throw interrupted();
    const problem = rustPluginFileProblem(file);
    if (problem) throw fail(problem, 400);
    // The name holds letters, digits and underscores only, so the file
    // stays in the plugin folder. A link or a folder is never replaced.
    const target = join(folder, `${command.name}.cs`);
    const stat = await fs.lstat(target).catch(() => null);
    if (stat && !stat.isFile()) throw fail('That file cannot be replaced.');
    await fs.mkdir(folder, { recursive: true });
    if (stat)
      await fs.copyFile(target, join(previousDirectory, `${command.name}.cs`));
    await writeAtomic(target, file);
    return `Uploaded ${command.name}.`;
  }

  async function installPlugin(name: string) {
    const folder = await pluginDirectory();
    const file = await download(
      `https://umod.org/plugins/${name}.cs`,
      pluginMaxBytes,
    ).catch((error: unknown) => {
      throw error instanceof AgentError &&
        error.message === 'The file was not found.'
        ? fail('uMod has no plugin with this name.', 502)
        : error;
    });
    const text = file.toString('utf8');
    // A plugin is C# source that names its plugin class.
    if (
      file.includes(0) ||
      !/\bnamespace\s+(?:Oxide|Carbon)\.Plugins\b/.test(text)
    )
      throw fail('The downloaded file is not a plugin.', 502);
    const target = join(folder, `${name}.cs`);
    await fs.mkdir(folder, { recursive: true });
    if (await exists(target))
      await fs.copyFile(target, join(previousDirectory, `${name}.cs`));
    await writeAtomic(target, file);
    return `Installed ${name}.`;
  }

  /** The last update of every plugin. Kept in memory only. */
  let pluginUpdates: { at: number; results: RustPluginUpdates } | undefined;

  /**
   * Download every installed plugin from uMod again, one after the other. A
   * plugin whose file did not change is left alone. A plugin that uMod does
   * not list is left alone as well. Each plugin that got a new file is then
   * reloaded on the running server, and the result says whether the server
   * confirmed the reload.
   */
  async function updatePlugins() {
    const folder = await pluginDirectory();
    const { plugins } = await listPlugins();
    const results: RustPluginUpdates = [];
    for (const { name } of plugins) {
      if (results.length) await system.sleep(500);
      const target = join(folder, `${name}.cs`);
      try {
        const file = await download(
          `https://umod.org/plugins/${name}.cs`,
          pluginMaxBytes,
        );
        if (
          file.includes(0) ||
          !/\bnamespace\s+(?:Oxide|Carbon)\.Plugins\b/.test(
            file.toString('utf8'),
          )
        ) {
          results.push({ name, result: 'failed' });
          continue;
        }
        const current = await fs.readFile(target);
        if (current.equals(file)) {
          results.push({ name, result: 'current' });
          continue;
        }
        await writeAtomic(join(previousDirectory, `${name}.cs`), current);
        await writeAtomic(target, file);
        results.push({ name, result: 'updated' });
      } catch (error) {
        results.push({
          name,
          result:
            error instanceof Error &&
            error.message === 'The file was not found.'
              ? 'not-listed'
              : 'failed',
        });
      }
    }
    for (const entry of results)
      if (entry.result === 'updated')
        entry.reloaded =
          (await options.reloadPlugin?.(entry.name).catch(() => false)) ??
          false;
    pluginUpdates = { at: system.now(), results };
    const count = (result: RustPluginUpdates[number]['result']) =>
      results.filter((entry) => entry.result === result).length;
    return `Updated ${count('updated')} of ${results.length} plugins.`;
  }

  // Plugin settings files.
  async function pluginConfigFile(name: string) {
    const found = await framework();
    if (!found) throw fail('Install Oxide or Carbon on this server first.');
    // The name holds letters, digits and underscores only, so the file
    // stays in the settings folder of the framework.
    if (!/^[A-Za-z0-9_]{1,80}$/.test(name))
      throw fail('That plugin is not installed.', 404);
    return join(
      settings.serverDirectory,
      found,
      rustPluginConfigFolder[found],
      `${name}.json`,
    );
  }

  async function readPluginConfig(name: string) {
    const file = await pluginConfigFile(name);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat)
      return {
        raw: null,
        view: { name, exists: false, revision: digest(''), text: '' },
      };
    if (!stat.isFile()) throw fail('That file cannot be read.', 404);
    if (stat.size > rustPluginConfigMaxBytes)
      throw fail('The settings file is larger than 40 KiB.', 413);
    const raw = await fs.readFile(file, 'utf8');
    return {
      raw,
      view: {
        name,
        exists: true,
        revision: digest(raw),
        text: raw.replace(/^\uFEFF/, ''),
      },
    };
  }

  async function savePluginConfig(
    name: string,
    revision: string,
    text: string,
  ) {
    const file = await pluginConfigFile(name);
    const { raw } = await readPluginConfig(name);
    if (raw === null) throw fail('This plugin has no settings file.', 404);
    if (digest(raw) !== revision)
      throw fail('The settings file changed. Reload it before saving.');
    if (rustPluginConfigText(text) === null)
      throw fail('The settings are not valid JSON.', 400);
    await writeAtomic(join(previousDirectory, `${name}.json`), raw);
    await writeAtomic(file, text);
    return 'Saved.';
  }

  async function rollbackPlugin(name: string) {
    const folder = await pluginDirectory();
    const previous = join(previousDirectory, `${name}.cs`);
    if (!(await exists(previous)))
      throw fail('There is no earlier file of this plugin.', 404);
    const target = join(folder, `${name}.cs`);
    const current = (await exists(target)) ? await fs.readFile(target) : null;
    await writeAtomic(target, await fs.readFile(previous));
    if (current) await writeAtomic(previous, current);
    else await fs.rm(previous, { force: true });
    return `Put back the earlier ${name}.`;
  }

  async function removePlugin(name: string) {
    const folder = await pluginDirectory();
    const target = join(folder, `${name}.cs`);
    if (!(await exists(target)))
      throw fail('That plugin is not installed.', 404);
    await fs.copyFile(target, join(previousDirectory, `${name}.cs`));
    await fs.rm(target, { force: true });
    return `Removed ${name}.`;
  }

  async function status(): Promise<RustHostStatus> {
    const alive = running();
    let memoryBytes: number | null = null;
    if (alive && system.platform === 'linux')
      try {
        const text = await fs.readFile(`/proc/${state.pid}/status`, 'utf8');
        const kb = /VmRSS:\s+(\d+)\s+kB/.exec(text);
        if (kb) memoryBytes = Number(kb[1]) * 1024;
      } catch {
        // The process may have exited.
      }
    let freeDiskBytes: number | null = null;
    try {
      const disk = await fs.statfs(settings.serverDirectory);
      freeDiskBytes = disk.bavail * disk.bsize;
    } catch {
      // Not reported on this file system.
    }
    return {
      configured: true,
      running: alive || external(),
      managed: alive,
      pid: alive ? state.pid : null,
      startedAt: alive ? state.startedAt : null,
      memoryBytes,
      loadAverage: system.platform === 'linux' ? (loadavg()[0] ?? null) : null,
      freeDiskBytes,
      steamcmd: !!settings.steamcmd,
      job: state.job,
      restartPending: false,
      platform: system.platform,
      framework: await framework(),
      seed: settings.seed ?? null,
      worldSize: settings.worldSize ?? null,
      levelUrl: settings.levelUrl ?? null,
      wipedAt: await wipedAt(),
    };
  }

  const receipt = (
    message: string,
    record: RustHostJob | null = null,
  ): RustHostReceipt => ({ ok: true, message, job: record });

  return {
    async read(resource: RustHostResource, params: URLSearchParams) {
      switch (resource) {
        case 'status':
          return status();
        case 'config':
          return (await readConfig()).view;
        case 'logs': {
          const name = params.get('name');
          if (name !== null && !/^server-\d{1,16}\.log$/.test(name))
            throw fail('That log file is not available.', 404);
          return readLogs(name);
        }
        case 'backups':
          return listBackups();
        case 'plugins':
          return listPlugins();
        case 'map': {
          const offset = Number(params.get('offset') ?? 0);
          const names = (
            await fs.readdir(settings.serverDirectory).catch(() => [])
          ).filter((name) => rustMapFileName.test(name));
          let newest: { name: string; at: number; size: number } | null = null;
          for (const name of names) {
            const stat = await fs
              .stat(join(settings.serverDirectory, name))
              .catch(() => null);
            if (stat && (!newest || stat.mtimeMs > newest.at))
              newest = { name, at: stat.mtimeMs, size: stat.size };
          }
          const none = {
            name: null,
            width: 0,
            margin: rustMapMarginPixels,
            total: 0,
            offset: 0,
            data: '',
            modifiedAt: 0,
          };
          if (
            !newest ||
            newest.size > rustMapMaxBytes ||
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            offset > newest.size
          )
            return none;
          const file = await fs.open(
            join(settings.serverDirectory, newest.name),
            'r',
          );
          try {
            const head = Buffer.alloc(24);
            await file.read(head, 0, 24, 0);
            const part = Buffer.alloc(
              Math.min(rustMapChunkBytes, newest.size - offset),
            );
            await file.read(part, 0, part.length, offset);
            return {
              name: newest.name,
              width: pngWidth(head),
              margin: rustMapMarginPixels,
              total: newest.size,
              offset,
              data: part.toString('base64'),
              modifiedAt: Math.trunc(newest.at),
            };
          } finally {
            await file.close();
          }
        }
        case 'plugin-config':
          return (await readPluginConfig(params.get('name') ?? '')).view;
        case 'admins':
          return parseRustUsers(
            await fs
              .readFile(join(saveDirectory, 'cfg', 'users.cfg'), 'utf8')
              .catch(() => ''),
          );
      }
    },
    async execute(value: unknown): Promise<RustHostReceipt> {
      const parsed = rustHostCommand.safeParse(value);
      if (!parsed.success)
        throw new AgentError(
          400,
          'invalid-operation',
          'The host command is not valid.',
        );
      const command: RustHostCommand = parsed.data;
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
        case 'update':
          return receipt('Updating', startJob('update', update));
        case 'save-config': {
          const { raw } = await readConfig();
          if (digest(raw) !== command.revision)
            throw fail('The config file changed. Reload it before saving.');
          const text = restoreRustConfig(
            command.text,
            redactRustConfig(raw).secret,
          );
          if (Buffer.byteLength(text) > rustConfigMaxBytes)
            throw fail('The config file is larger than 48 KiB.', 413);
          await fs.mkdir(join(saveDirectory, 'cfg'), { recursive: true });
          if (raw) await writeAtomic(`${configFile}.wg-previous`, raw);
          await writeAtomic(configFile, text);
          return receipt(running() ? 'Saved. Restart to apply.' : 'Saved.');
        }
        case 'wipe':
          return receipt(
            'Wiping',
            startJob('wipe', async () => {
              const saved = await createBackup(`Before ${command.kind} wipe`)
                .then(() => '')
                .catch(() => ' No backup was made: the save is too large.');
              return `${await wipe(command.kind, command.seed, command.worldSize, command.levelUrl)}${saved}`;
            }),
          );
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
        case 'remove-backup': {
          const target = join(backupDirectory, command.id);
          if (!(await exists(join(target, 'meta.json'))))
            throw fail('That backup does not exist.', 404);
          await fs.rm(target, { recursive: true, force: true });
          return receipt('Removed.');
        }
        case 'install-framework':
          return receipt(
            'Installing',
            startJob('install-framework', () =>
              installFramework(command.framework),
            ),
          );
        case 'remove-framework':
          return receipt(
            'Removing',
            startJob('remove-framework', removeFramework),
          );
        case 'install-plugin':
          return receipt(
            'Installing',
            startJob('install-plugin', () => installPlugin(command.name)),
          );
        case 'rollback-plugin':
          return receipt(await rollbackPlugin(command.name));
        case 'remove-plugin':
          return receipt(await removePlugin(command.name));
        case 'save-plugin-config':
          return receipt(
            await savePluginConfig(
              command.name,
              command.revision,
              command.text,
            ),
          );
        case 'update-plugins':
          return receipt('Updating', startJob('update-plugins', updatePlugins));
        case 'upload-plugin':
          return receipt(await uploadPlugin(command));
      }
    },
    /** For tests: wait for the running job. */
    async idle() {
      await active;
    },
    /** One pass of the crash watch. The timer calls it every 15 seconds. */
    watch,
    async close() {
      clearInterval(watchTimer);
      await active?.catch(() => {});
    },
    /** The name of the file a path names, for log lines. */
    describe: () => basename(settings.executable),
  };
}
export type RustHostController = Awaited<
  ReturnType<typeof createRustHostController>
>;
