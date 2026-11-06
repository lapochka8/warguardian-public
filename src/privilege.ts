import { execFile } from 'node:child_process';
import { promises as fs, type Stats } from 'node:fs';
import { posix, win32 } from 'node:path';
import { detectLayout } from './update';

/** The exit code of a command refused because it runs as root or an administrator. */
export const privilegedExitCode = 77;

/**
 * Windows rights that let a process read, write or take any file. A token
 * with one of them is an elevated administrator, SYSTEM or a backup
 * operator. The service account holds none of them.
 */
const windowsAdministratorRights = new Set([
  'SeBackupPrivilege',
  'SeRestorePrivilege',
  'SeTakeOwnershipPrivilege',
  'SeDebugPrivilege',
  'SeTcbPrivilege',
  'SeLoadDriverPrivilege',
]);

/** True when `whoami /priv /fo csv /nh` lists an administrator right. Names are not translated. */
export function windowsPrivileged(output: string): boolean {
  for (const line of output.split(/\r?\n/)) {
    const name = /^"([^"]+)"/.exec(line.trim())?.[1];
    if (name && windowsAdministratorRights.has(name)) return true;
  }
  return false;
}

/** True when this process runs as root, or as an elevated Windows administrator. */
export async function processPrivileged(
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== 'win32') return process.geteuid?.() === 0;
  const whoami = win32.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'whoami.exe',
  );
  const output = await new Promise<string>((resolve) => {
    execFile(
      whoami,
      ['/priv', '/fo', 'csv', '/nh'],
      { timeout: 10_000, windowsHide: true },
      (error, stdout) => resolve(error ? '' : stdout),
    );
  });
  return windowsPrivileged(output);
}

type FileChecks = {
  lstat?: (path: string) => Promise<Stats>;
  realpath?: (path: string) => Promise<string>;
};

/**
 * True when root may run this copy of the agent: on Linux root owns the
 * file and every folder above it, and no group or other account may write
 * any of them. On Windows the copy is not one that self-update installed in
 * the `versions` folder, which the service account may change.
 */
export async function trustedCopy(
  executable: string,
  platform: NodeJS.Platform = process.platform,
  checks: FileChecks = {},
): Promise<boolean> {
  if (platform === 'win32') return detectLayout(executable, 'win32') === null;
  const lstat = checks.lstat ?? ((path: string) => fs.lstat(path));
  const realpath = checks.realpath ?? ((path: string) => fs.realpath(path));
  let path: string;
  try {
    path = await realpath(executable);
  } catch {
    return false;
  }
  for (let first = true; ; first = false) {
    const stat = await lstat(path).catch(() => null);
    if (
      !stat ||
      stat.isSymbolicLink() ||
      !(first ? stat.isFile() : stat.isDirectory()) ||
      stat.uid !== 0 ||
      stat.mode & 0o022
    )
      return false;
    const parent = posix.dirname(path);
    if (parent === path) return true;
    path = parent;
  }
}

/** Commands any account may run. They read and write no file. */
const harmless = new Set(['version', '--version', 'help', '--help']);

export function harmlessCommand(command: string | undefined): boolean {
  return command !== undefined && harmless.has(command);
}

/**
 * Why a privileged process may not run this command, or null. The service
 * never runs privileged. On Linux, root runs only `discover` from a
 * root-owned copy, as install.sh does with `--output`. On Windows, the
 * installer runs `enroll`, `access` and `discover` from its own copy.
 */
export function privilegeProblem(options: {
  platform: NodeJS.Platform;
  command: string | undefined;
  trusted: boolean;
}): string | null {
  const { command, trusted } = options;
  if (harmlessCommand(command)) return null;
  const service =
    command === undefined ||
    command === 'run' ||
    command === 'service' ||
    command.startsWith('--');
  if (options.platform === 'win32') {
    if (service)
      return 'Do not run the WarGuardian Agent as an administrator. The WarGuardian Agent service runs it.';
    if (['enroll', 'access', 'discover'].includes(command!) && trusted)
      return null;
    return 'As an administrator, run the WarGuardian Agent only from its installer.';
  }
  if (service)
    return 'Do not run the WarGuardian Agent as root. The warguardian-agent service runs it.';
  if (command === 'discover')
    return trusted
      ? null
      : 'Run discover as root only from a root-owned copy of the agent.';
  return `Do not run warguardian-agent as root. Run: sudo -u warguardian-agent warguardian-agent ${command}`;
}
