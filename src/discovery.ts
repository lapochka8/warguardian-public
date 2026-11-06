import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { posix, win32 } from 'node:path';
import { z } from 'zod';
import {
  GameFileUnreadable,
  battleyeConfigFile,
  battleyeFileName,
  checkedPassword,
  parseBattlEyeConfig,
  readText,
} from './games/game-config';
import { discoveredServer, type DiscoveredServer } from './protocol';

/**
 * One running process: the executable path the system reports, the
 * arguments, and the working directory and account where readable. A
 * process chooses its own arguments, including `argv[0]`, so only
 * `executable` and `uid` say where the game is installed and who runs it.
 */
export type ProcessEntry = {
  pid: number;
  executable: string | null;
  argv: string[];
  cwd: string | null;
  /** Linux: the effective user ID from `/proc/<pid>/status`. */
  uid?: number | null;
  /** Windows: the SID of the account that runs the process. */
  sid?: string | null;
};

/**
 * A discovered server. `summary` goes to WarGuardian at enrollment. `id`,
 * `rconConfigured`, `rconFiles` and `settings` stay on this host.
 * Discovery offers Arma 3, DayZ and Arma Reforger. Squad family servers are
 * set up by hand.
 */
export type DiscoveredInstance = {
  id: string;
  profile: 'battleye' | 'arma-reforger';
  summary: DiscoveredServer;
  /** True when the game configuration holds a usable RCON password. */
  rconConfigured: boolean;
  /** Why the RCON settings could not be read, for local output. */
  problem?: string;
  /** The RCON configuration files the profile reads at runtime. */
  rconFiles?: string[];
  /**
   * The configuration the process names failed the checks: it is no
   * BattlEye file, its path holds a link, or it belongs to another account
   * than the process. Nothing was read from it and setup never picks this
   * server on its own.
   */
  rejected?: true;
  settings: Record<string, unknown>;
  /** The game process, so the installer can check who owns its files. */
  pid?: number;
};

/**
 * `discover --output FILE`: the servers found by a privileged discovery,
 * which `enroll --discovered FILE` uses instead of looking again.
 */
export const discoveredInstances = z
  .array(
    z.object({
      id: z.string().regex(/^[a-z0-9-]{1,64}$/),
      profile: z.enum(['battleye', 'arma-reforger']),
      summary: discoveredServer,
      rconConfigured: z.boolean(),
      problem: z.string().max(1_000).optional(),
      rconFiles: z.array(z.string().max(4_096)).max(8).optional(),
      rejected: z.literal(true).optional(),
      settings: z.record(z.string(), z.unknown()),
      pid: z.number().int().positive().optional(),
    }),
  )
  .max(16);

/** A path that can be printed as one line. */
export function printablePath(path: string): boolean {
  if (!path) return false;
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/** Save discovered servers for a later `enroll`. Readable by its owner only. */
export async function writeDiscoveryFile(
  file: string,
  instances: DiscoveredInstance[],
): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(instances)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

/** Read servers saved by `discover --output`. */
export async function readDiscoveryFile(
  file: string,
): Promise<DiscoveredInstance[]> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new Error('The discovery file cannot be read.');
  }
  const parsed = discoveredInstances.safeParse(value);
  if (!parsed.success) throw new Error('The discovery file is invalid.');
  return parsed.data as DiscoveredInstance[];
}

/** Optional ports, omitted when unknown. */
function ports(values: {
  rconPort?: number | null;
  gamePort?: number | null;
  queryPort?: number | null;
}) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => typeof value === 'number'),
  ) as {
    rconPort?: number;
    gamePort?: number;
    queryPort?: number;
  };
}

type KnownServer =
  | { profile: 'battleye'; game: 'arma3' | 'dayz' }
  | { profile: 'arma-reforger'; game: 'arma-reforger' };

/** Server executables by base name, without extension or Unreal build suffix. */
const knownServers: Record<string, KnownServer> = {
  arma3server: { profile: 'battleye', game: 'arma3' },
  arma3server_x64: { profile: 'battleye', game: 'arma3' },
  dayzserver: { profile: 'battleye', game: 'dayz' },
  dayzserver_x64: { profile: 'battleye', game: 'dayz' },
  armareforgerserver: { profile: 'arma-reforger', game: 'arma-reforger' },
};

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

export function serverKind(
  executable: string,
  platform: NodeJS.Platform,
): KnownServer | null {
  const base = pathApi(platform)
    .basename(executable)
    .toLowerCase()
    .replace(/\.(?:exe|sh)$/, '')
    .replace(/-(?:linux|win64)-shipping$/, '')
    .replace(/-shipping$/, '');
  return knownServers[base] ?? null;
}

/** Split a Windows command line as `CommandLineToArgvW` does. */
export function splitWindowsCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '\\') {
      let slashes = 0;
      while (line[index] === '\\') {
        slashes += 1;
        index += 1;
      }
      if (line[index] === '"') {
        current += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) current += '"';
        else quoted = !quoted;
      } else {
        current += '\\'.repeat(slashes);
        index -= 1;
      }
      started = true;
      continue;
    }
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && (character === ' ' || character === '\t')) {
      if (started) args.push(current);
      current = '';
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) args.push(current);
  return args;
}

/** The value of `-name=value` or `-name value`, case-insensitive. */
export function argumentValue(argv: string[], name: string): string | null {
  const lower = name.toLowerCase();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!.replace(/^"|"$/g, '');
    const plain = argument.toLowerCase();
    if (plain.startsWith(`${lower}=`))
      return argument.slice(name.length + 1).replace(/^"|"$/g, '') || null;
    if (
      plain === lower &&
      index + 1 < argv.length &&
      !argv[index + 1]!.startsWith('-')
    )
      return argv[index + 1]!;
  }
  return null;
}

/** The effective user ID on the `Uid:` line of `/proc/<pid>/status`. */
async function processAccount(file: string): Promise<number | null> {
  try {
    const match = /^Uid:\s+\d+\s+(\d+)\b/m.exec(
      await fs.readFile(file, 'utf8'),
    );
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Linux: `/proc/<pid>/cmdline` and `status`, and `exe` and `cwd` where this user may read them. */
export async function linuxProcesses(
  procRoot = '/proc',
): Promise<ProcessEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(procRoot);
  } catch {
    return [];
  }
  const entries: ProcessEntry[] = [];
  for (const name of names) {
    if (!/^\d{1,10}$/.test(name)) continue;
    const base = posix.join(procRoot, name);
    let argv: string[];
    try {
      const raw = await fs.readFile(posix.join(base, 'cmdline'));
      if (!raw.length || raw.length > 64 * 1024) continue;
      argv = raw.toString('utf8').split('\0');
      if (argv[argv.length - 1] === '') argv.pop();
    } catch {
      continue;
    }
    const link = async (file: string) => {
      try {
        return await fs.readlink(posix.join(base, file));
      } catch {
        return null;
      }
    };
    entries.push({
      pid: Number(name),
      executable: await link('exe'),
      argv,
      cwd: await link('cwd'),
      uid: await processAccount(posix.join(base, 'status')),
    });
  }
  return entries;
}

const windowsQuery =
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(arma3server|dayzserver|armareforgerserver)' } | Select-Object ProcessId,ExecutablePath,CommandLine,@{n='OwnerSid';e={(Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid}} | ConvertTo-Json -Compress";

/** Windows: server processes from `Win32_Process`. */
export async function windowsProcesses(): Promise<ProcessEntry[]> {
  const output = await new Promise<string>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', windowsQuery],
      { timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? '' : stdout),
    );
  });
  return parseWindowsProcessJson(output);
}

export function parseWindowsProcessJson(output: string): ProcessEntry[] {
  if (!output.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return [];
  }
  const rows = Array.isArray(value) ? value : [value];
  const entries: ProcessEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { ProcessId, ExecutablePath, CommandLine, OwnerSid } = row as Record<
      string,
      unknown
    >;
    if (typeof ProcessId !== 'number') continue;
    const argv =
      typeof CommandLine === 'string'
        ? splitWindowsCommandLine(CommandLine)
        : [];
    // Without the right to query a process, Windows gives no path. The
    // command line alone names the game, never its folder.
    const executable =
      typeof ExecutablePath === 'string' && ExecutablePath
        ? ExecutablePath
        : null;
    if (!executable && !argv.length) continue;
    entries.push({
      pid: ProcessId,
      executable,
      argv: argv.length ? argv : [executable!],
      cwd: null,
      ...(typeof OwnerSid === 'string' && sidPattern.test(OwnerSid)
        ? { sid: OwnerSid }
        : {}),
    });
  }
  return entries;
}

const sidPattern = /^S-1-\d{1,3}(?:-\d{1,10}){1,15}$/;

/** The owner of a Windows file and the accounts an allow entry lets write it, as SIDs. */
export type FileSecurity = { owner: string; writers: string[] };
export type FileSecurityReader = (path: string) => Promise<FileSecurity | null>;

/**
 * Reads the owner and the writers from the file's access list. The path
 * goes to PowerShell on stdin, never on its command line.
 */
const fileSecurityScript = [
  "$ErrorActionPreference = 'Stop'",
  '$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))',
  '$sid = [System.Security.Principal.SecurityIdentifier]',
  '$acl = Get-Acl -LiteralPath $path',
  '$mask = 0x2 -bor 0x4 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000',
  "$writers = @($acl.GetAccessRules($true, $true, $sid) | Where-Object { $_.AccessControlType -eq 'Allow' -and -not ($_.PropagationFlags -band 2) -and (($_.FileSystemRights.value__ -band $mask) -ne 0) } | ForEach-Object { $_.IdentityReference.Value })",
  'ConvertTo-Json -Compress @{ owner = $acl.GetOwner($sid).Value; writers = $writers }',
].join('\n');

/** Windows: the owner and writers of `path`, or null when they cannot be read. */
export async function windowsFileSecurity(
  path: string,
): Promise<FileSecurity | null> {
  const output = await new Promise<string>((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', fileSecurityScript],
      { windowsHide: true, timeout: 20_000 },
    );
    let text = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (text.length < 64 * 1024) text += chunk;
    });
    child.once('error', () => resolve(''));
    child.once('close', (code) => resolve(code === 0 ? text : ''));
    child.stdin.end(Buffer.from(path, 'utf8').toString('base64'));
  });
  return parseFileSecurity(output);
}

export function parseFileSecurity(output: string): FileSecurity | null {
  try {
    const value = JSON.parse(output) as { owner?: unknown; writers?: unknown };
    const writers = Array.isArray(value.writers)
      ? value.writers
      : typeof value.writers === 'string'
        ? [value.writers]
        : [];
    if (typeof value.owner !== 'string' || !sidPattern.test(value.owner))
      return null;
    return {
      owner: value.owner,
      writers: writers.filter(
        (item): item is string =>
          typeof item === 'string' && sidPattern.test(item),
      ),
    };
  } catch {
    return null;
  }
}

/** Groups every local account belongs to: Everyone, Users, Authenticated Users and Interactive. */
const everyoneSids = new Set([
  'S-1-1-0',
  'S-1-5-32-545',
  'S-1-5-11',
  'S-1-5-4',
]);

function stableId(game: string, key: string): string {
  return `${game}-${createHash('sha256').update(key.toLowerCase()).digest('hex').slice(0, 10)}`;
}

/** A local description of a read problem, with the full path. */
function describeProblem(error: unknown): string {
  if (error instanceof GameFileUnreadable)
    return `Permission denied: ${error.path}. Give the agent's service account read access.`;
  return error instanceof Error
    ? error.message
    : 'The game configuration could not be read.';
}

function port(value: string | null): number | null {
  if (!value || !/^\d{1,5}$/.test(value)) return null;
  const number = Number(value);
  return number >= 1 && number <= 65_535 ? number : null;
}

function passwordFound(password: string | undefined): boolean {
  try {
    checkedPassword(password);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real path of `file` when discovery may use it for the process, or
 * why not. The file must be a BattlEye configuration with no link in any
 * part of its path, and it must belong to the account that runs the
 * process: on Linux the same user ID owns it. On Windows the same SID owns
 * it, or that account may write it while no group of every user may.
 */
async function checkGameFile(
  file: string,
  entry: ProcessEntry,
  platform: NodeJS.Platform,
  readSecurity: FileSecurityReader,
): Promise<{ real: string } | { problem: string }> {
  const path = pathApi(platform);
  let real: string;
  try {
    real = await fs.realpath(file);
  } catch {
    return { problem: `${file} cannot be resolved.` };
  }
  if (!battleyeFileName.test(path.basename(real)))
    return { problem: `${file} is not a BattlEye configuration file.` };
  const named = path.resolve(file);
  if (
    platform === 'win32'
      ? real.toLowerCase() !== named.toLowerCase()
      : real !== named
  )
    return { problem: `${file} has a link in its path.` };
  if (platform !== 'win32') {
    if (typeof entry.uid !== 'number')
      return {
        problem: `The account of process ${entry.pid} cannot be read.`,
      };
    const stat = await fs.lstat(real).catch(() => null);
    if (stat?.uid !== entry.uid)
      return {
        problem: `${file} belongs to another account than the game server.`,
      };
    return { real };
  }
  if (!entry.sid)
    return {
      problem: `The account of process ${entry.pid} cannot be read.`,
    };
  const security = await readSecurity(real);
  if (!security) return { problem: `The owner of ${file} cannot be read.` };
  const writableByAll = security.writers.some((sid) => everyoneSids.has(sid));
  if (
    security.owner !== entry.sid &&
    (writableByAll || !security.writers.includes(entry.sid))
  )
    return {
      problem: `${file} belongs to another account than the game server.`,
    };
  return { real };
}

/** Inspect one process. Returns null for other programs and unreadable layouts. */
export async function inspectProcess(
  entry: ProcessEntry,
  platform: NodeJS.Platform,
  readSecurity: FileSecurityReader = windowsFileSecurity,
): Promise<DiscoveredInstance | null> {
  const path = pathApi(platform);
  const executable = entry.executable ?? entry.argv[0] ?? '';
  const kind = serverKind(executable, platform);
  if (!kind) return null;
  const absolute = (value: string | null, base: string | null) =>
    !value
      ? null
      : path.isAbsolute(value)
        ? path.normalize(value)
        : base
          ? path.resolve(base, value)
          : null;
  const executablePath = absolute(executable, entry.cwd);
  const executableDirectory = executablePath
    ? path.dirname(executablePath)
    : null;
  const workingDirectory = entry.cwd ?? executableDirectory;
  // The folder the system reports for the executable, never one from argv.
  const gameFolder =
    entry.executable && path.isAbsolute(entry.executable)
      ? path.dirname(path.normalize(entry.executable))
      : null;

  if (kind.profile === 'battleye') {
    const bepath = absolute(
      argumentValue(entry.argv, '-bepath'),
      workingDirectory,
    );
    const profiles = absolute(
      argumentValue(entry.argv, '-profiles'),
      workingDirectory,
    );
    // A server started with -bepath reads its configuration from there
    // only. Otherwise it uses the BattlEye folder of -profiles or of the game
    // folder. Each file must still belong to the account of the process.
    const candidates = bepath
      ? [bepath]
      : [
          profiles && path.join(profiles, 'BattlEye'),
          gameFolder && path.join(gameFolder, 'battleye'),
          gameFolder && path.join(gameFolder, 'BattlEye'),
        ].filter((item): item is string => !!item);
    let file: string | null = null;
    let problem: string | undefined;
    let rejection =
      candidates.length || gameFolder
        ? undefined
        : `The game folder of process ${entry.pid} cannot be read.`;
    for (const candidate of candidates) {
      try {
        file = await battleyeConfigFile(candidate);
      } catch (error) {
        problem ??= describeProblem(error);
      }
      if (file) break;
    }
    if (!file && bepath && (await fs.stat(bepath).catch(() => null))?.isFile())
      rejection = `${bepath} is not a BattlEye configuration file.`;
    if (file) {
      const checked = await checkGameFile(file, entry, platform, readSecurity);
      if ('problem' in checked) {
        rejection = checked.problem;
        file = null;
      } else file = checked.real;
    }
    let settings = {};
    if (file)
      try {
        settings = parseBattlEyeConfig(await readText(file));
      } catch (error) {
        problem = describeProblem(error);
      }
    if (rejection) problem = rejection;
    else if (!file && !problem) problem = 'BEServer_x64.cfg was not found.';
    const found = settings as { port?: number; password?: string };
    const gamePort = port(argumentValue(entry.argv, '-port'));
    return {
      // BattlEye renames its file on every server start, so the ID follows
      // the folder and stays the same across restarts.
      id: stableId(
        kind.game,
        (file && path.dirname(file)) ?? executablePath ?? String(entry.pid),
      ),
      profile: 'battleye',
      summary: {
        gameId: kind.game,
        ...ports({
          rconPort: found.port,
          gamePort,
          queryPort: gamePort && kind.game === 'arma3' ? gamePort + 1 : null,
        }),
      },
      rconConfigured: passwordFound(found.password),
      ...(problem ? { problem } : {}),
      ...(file ? { rconFiles: [file] } : {}),
      ...(rejection ? { rejected: true as const } : {}),
      settings: {
        game: kind.game,
        ...(file ? { battleyeConfig: path.dirname(file) } : {}),
        ...(profiles && !rejection ? { logDirectory: profiles } : {}),
      },
    };
  }

  const config = absolute(
    argumentValue(entry.argv, '-config'),
    workingDirectory,
  );
  const profile = absolute(
    argumentValue(entry.argv, '-profile'),
    workingDirectory,
  );
  return {
    id: stableId(kind.game, config ?? executablePath ?? String(entry.pid)),
    profile: 'arma-reforger',
    summary: { gameId: 'arma-reforger' },
    rconConfigured: false,
    // The host tools run this executable, so it must be the one the system reports.
    settings:
      config && profile && gameFolder
        ? { executable: path.normalize(entry.executable!), config, profile }
        : {},
  };
}

/** Every game server this host runs that the agent recognizes, without duplicates. */
export async function discoverServers(
  options: {
    platform?: NodeJS.Platform;
    processes?: () => Promise<ProcessEntry[]>;
    readSecurity?: FileSecurityReader;
  } = {},
): Promise<DiscoveredInstance[]> {
  const platform = options.platform ?? process.platform;
  const list =
    options.processes ??
    (platform === 'win32' ? windowsProcesses : () => linuxProcesses());
  const found = new Map<string, DiscoveredInstance>();
  for (const entry of await list()) {
    const instance = await inspectProcess(
      entry,
      platform,
      options.readSecurity,
    ).catch(() => null);
    if (instance && !found.has(instance.id))
      found.set(instance.id, { ...instance, pid: entry.pid });
    if (found.size >= 16) break;
  }
  return [...found.values()];
}
