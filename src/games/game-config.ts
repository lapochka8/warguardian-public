import { promises as fs } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { basename, join } from 'node:path';
import { AgentError } from '../errors';

/**
 * Readers for the RCON settings in local game configuration. The password is
 * read on every login and never leaves this host.
 */

export type RconSettings = { host?: string; port?: number; password?: string };

function port(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,5}$/.test(value)) return undefined;
  const number = Number(value);
  return number >= 1 && number <= 65_535 ? number : undefined;
}

const ipv4 = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

/** `BEServer_x64.cfg`: `RConPassword`, `RConPort` and `RConIP`, one per line. */
export function parseBattlEyeConfig(text: string): RconSettings {
  const settings: RconSettings = {};
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const match = /^\s*(RConPassword|RConPort|RConIP)\s+(\S+)\s*$/i.exec(raw);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!;
    if (key === 'rconpassword') settings.password = value;
    else if (key === 'rconport') settings.port = port(value);
    else if (ipv4.test(value)) settings.host = value;
  }
  return settings;
}

/** `ServerConfig/Rcon.cfg`: `Key=Value` lines with `//` comments. */
export function parseSquadRconConfig(
  text: string,
): RconSettings & { maxConnections?: number } {
  const settings: RconSettings & { maxConnections?: number } = {};
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    const match = /^(IP|Port|Password|MaxConnections)\s*=\s*(.*)$/i.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === 'password') settings.password = value;
    else if (key === 'port') settings.port = port(value);
    else if (key === 'maxconnections') settings.maxConnections = port(value);
    else if (ipv4.test(value)) settings.host = value;
  }
  return settings;
}

/** `BEServer.cfg`, `BEServer_x64.cfg` and the files BattlEye renames them to while it runs. */
export const battleyeFileName =
  /^beserver(?:_x64)?(?:_active_[^/\\]{1,64})?\.cfg$/i;

/**
 * The active BattlEye configuration in a directory. A running server renames
 * `BEServer_x64.cfg` to `BEServer_x64_active_<id>.cfg`, so the newest active
 * file wins. A file is accepted only under one of those names.
 */
export async function battleyeConfigFile(
  pathOrDirectory: string,
): Promise<string | null> {
  let stat;
  try {
    stat = await fs.stat(pathOrDirectory);
  } catch (error) {
    if (denied(error)) throw unreadable(pathOrDirectory);
    return null;
  }
  if (stat.isFile())
    return battleyeFileName.test(basename(pathOrDirectory))
      ? pathOrDirectory
      : null;
  if (!stat.isDirectory()) return null;
  let names: string[];
  try {
    names = await fs.readdir(pathOrDirectory);
  } catch (error) {
    if (denied(error)) throw unreadable(pathOrDirectory);
    return null;
  }
  const active: { file: string; at: number }[] = [];
  let plain: string | null = null;
  for (const name of names) {
    const lower = name.toLowerCase();
    if (/^beserver(?:_x64)?_active_[^/\\]{1,64}\.cfg$/.test(lower)) {
      const file = join(pathOrDirectory, name);
      try {
        active.push({ file, at: (await fs.stat(file)).mtimeMs });
      } catch {
        // Removed while listing.
      }
    } else if (
      lower === 'beserver_x64.cfg' ||
      (lower === 'beserver.cfg' && !plain)
    ) {
      plain = join(pathOrDirectory, name);
    }
  }
  active.sort((a, b) => b.at - a.at);
  return active[0]?.file ?? plain;
}

/** True for loopback and for addresses of this host's interfaces. */
export function localAddress(host: string): boolean {
  if (host.startsWith('127.')) return true;
  for (const entries of Object.values(networkInterfaces()))
    for (const entry of entries ?? [])
      if (entry.family === 'IPv4' && entry.address === host) return true;
  return false;
}

/**
 * The address to connect to: an override, a specific local `RConIP`, or
 * loopback. A non-local address is refused, so the agent never relays RCON
 * to another host.
 */
export function rconHost(
  override: string | undefined,
  configured: string | undefined,
): string {
  const host =
    override ??
    (configured && configured !== '0.0.0.0' ? configured : '127.0.0.1');
  if (!localAddress(host))
    throw new AgentError(
      400,
      'not-configured',
      'The RCON address is not an address of this host.',
    );
  return host;
}

export function checkedPassword(password: string | undefined): string {
  if (typeof password !== 'string' || !/^[\x21-\x7e]{3,512}$/.test(password))
    throw new AgentError(
      503,
      'not-configured',
      'The game configuration has no usable RCON password.',
    );
  return password;
}

function denied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

/**
 * The agent's service account may not read a game file. The message names
 * the file but not its folder, because it can reach the panel.
 */
export class GameFileUnreadable extends AgentError {
  /** The full path, for local output only. */
  readonly path: string;
  constructor(path: string) {
    super(
      503,
      'not-configured',
      `The WarGuardian Agent cannot read ${basename(path)}. Give its service account read access.`,
    );
    this.name = 'GameFileUnreadable';
    this.path = path;
  }
}

function unreadable(path: string): GameFileUnreadable {
  return new GameFileUnreadable(path);
}

export async function readText(
  file: string,
  maxBytes = 256 * 1024,
): Promise<string> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch (error) {
    if (denied(error)) throw unreadable(file);
    throw new AgentError(
      503,
      'not-configured',
      `${basename(file)} was not found.`,
    );
  }
  try {
    const { size } = await handle.stat();
    if (size > maxBytes)
      throw new AgentError(
        400,
        'not-configured',
        'The game configuration file is too large.',
      );
    return (await handle.readFile()).toString('utf8');
  } finally {
    await handle.close();
  }
}
