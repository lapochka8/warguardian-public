import { promises as fs } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { AgentConfig } from './config';
import { printablePath } from './discovery';
import { battleyeFileName } from './games/game-config';

/** One path the service account must read: a file, or a folder it lists. */
export type AccessEntry = { kind: 'file' | 'folder'; path: string };

const squadFileName = /^rcon\.cfg$/i;

/**
 * True for a path that a privileged installer may place on an `icacls` or
 * `setfacl` command line in double quotes: absolute, below a root, with no
 * quote, control character or trailing separator, and not starting with an
 * option character. On Windows only paths that start with a drive letter,
 * a colon and a backslash pass, with backslashes as separators.
 */
export function commandLinePath(
  path: string,
  platform: NodeJS.Platform,
): boolean {
  if (!printablePath(path) || path.includes('"') || path.length > 1024)
    return false;
  if (platform === 'win32')
    return (
      /^[A-Za-z]:\\[^\\/]/.test(path) &&
      !path.includes('/') &&
      !path.endsWith('\\') &&
      !path.slice(3).includes(':') &&
      win32.normalize(path) === path
    );
  return (
    path.startsWith('/') &&
    path.length > 1 &&
    !path.endsWith('/') &&
    posix.normalize(path) === path
  );
}

/**
 * The real path of `path` when it exists as the expected kind and is safe
 * on a command line, or why it is skipped.
 */
async function checkedPath(
  path: string,
  kind: AccessEntry['kind'],
  name: RegExp | null,
  platform: NodeJS.Platform,
): Promise<{ path: string } | { problem: string }> {
  const api = platform === 'win32' ? win32 : posix;
  if (!commandLinePath(path, platform))
    return { problem: 'not a plain absolute path' };
  let real: string;
  try {
    real = await fs.realpath(path);
  } catch {
    return { problem: 'not found' };
  }
  if (!commandLinePath(real, platform))
    return { problem: 'not a plain absolute path' };
  const stat = await fs.lstat(real).catch(() => null);
  if (!(kind === 'file' ? stat?.isFile() : stat?.isDirectory()))
    return { problem: kind === 'file' ? 'not a file' : 'not a folder' };
  if (name && !name.test(api.basename(real)))
    return { problem: 'not an RCON configuration file' };
  return { path: real };
}

/**
 * The game files of the configured servers that the agent reads. A
 * BattlEye folder is listed as well, because the server renames its
 * configuration while it runs. Only existing files with the expected names
 * are listed, by their real paths, and each skipped path is reported on
 * stderr.
 */
export async function rconAccessList(
  config: AgentConfig,
  platform: NodeJS.Platform = process.platform,
): Promise<AccessEntry[]> {
  const entries = new Map<string, AccessEntry>();
  const add = async (
    kind: AccessEntry['kind'],
    path: string,
    name: RegExp | null,
  ) => {
    const checked = await checkedPath(path, kind, name, platform);
    if ('problem' in checked) {
      console.error(
        `Skipped ${printablePath(path) ? path : JSON.stringify(path)}: ${checked.problem}.`,
      );
      return null;
    }
    entries.set(`${kind} ${checked.path}`, { kind, path: checked.path });
    return checked.path;
  };
  for (const server of config.servers) {
    if (server.profile === 'squad-family' && server.rconConfig)
      await add('file', server.rconConfig, squadFileName);
    if (server.profile !== 'battleye' || !server.battleyeConfig) continue;
    const target = server.battleyeConfig;
    const stat = await fs.stat(target).catch(() => null);
    if (stat?.isFile()) {
      if (!battleyeFileName.test(win32.basename(target))) {
        console.error(
          `Skipped ${printablePath(target) ? target : JSON.stringify(target)}: not an RCON configuration file.`,
        );
        continue;
      }
      await add('file', target, battleyeFileName);
    }
    const folder = await add(
      'folder',
      stat?.isDirectory()
        ? target
        : (platform === 'win32' ? win32 : posix).dirname(target),
      null,
    );
    if (!folder) continue;
    const names = await fs.readdir(folder).catch(() => [] as string[]);
    for (const name of names)
      if (battleyeFileName.test(name))
        await add(
          'file',
          (platform === 'win32' ? win32 : posix).join(folder, name),
          battleyeFileName,
        );
  }
  return [...entries.values()];
}
