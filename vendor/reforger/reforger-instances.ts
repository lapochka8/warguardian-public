import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type ReforgerInstancePorts = {
  game: number;
  query: number | null;
  rcon: number | null;
};
export type ReforgerInstanceEntry = {
  version: 1;
  serverId: string;
  serverName: string;
  profile: string;
  config: string;
  connectorPid: number;
  gamePid: number | null;
  ports: ReforgerInstancePorts | null;
  updatedAt: number;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const port = (value: unknown, fallback: number | null) =>
  Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535
    ? Number(value)
    : fallback;

/** UDP ports a Reforger configuration listens on. Omitted ports use the
 * game defaults, so two configurations that both omit a port still clash. */
export function reforgerConfigPorts(raw: unknown): ReforgerInstancePorts {
  const config = object(raw),
    a2s = object(config.a2s),
    rcon = object(config.rcon);
  return {
    game: port(config.bindPort, 2001)!,
    query: Object.keys(a2s).length ? port(a2s.port, 17777) : null,
    rcon: Object.keys(rcon).length ? port(rcon.port, 19999) : null,
  };
}
export function reforgerPortClashes(
  own: ReforgerInstancePorts,
  other: ReforgerInstancePorts,
) {
  const mine = [own.game, own.query, own.rcon].filter(
    (value): value is number => value !== null,
  );
  return [other.game, other.query, other.rcon].filter(
    (value): value is number => value !== null && mine.includes(value),
  );
}
const fresh = (entry: ReforgerInstanceEntry, now: number) =>
  now - entry.updatedAt < 60000;

/** Connectors that share one game installation record themselves in a
 * small directory beside it. An entry older than one minute belongs to a
 * stopped connector and is ignored, so a crash never blocks other servers. */
export function createReforgerInstanceRegistry(options: {
  directory: string;
  serverId: string;
  serverName: string;
  profile: string;
  config: string;
}) {
  const file = (serverId: string) =>
    join(options.directory, `${serverId.replace(/[^a-z0-9-]/g, '')}.json`);
  async function list(now = Date.now()) {
    let names: string[] = [];
    try {
      names = await fs.readdir(options.directory);
    } catch {
      return [];
    }
    const entries: (ReforgerInstanceEntry & { active: boolean })[] = [];
    for (const name of names
      .filter((item) => item.endsWith('.json'))
      .slice(0, 64)) {
      try {
        const entry = JSON.parse(
          await fs.readFile(join(options.directory, name), 'utf8'),
        ) as ReforgerInstanceEntry;
        if (entry.version !== 1 || entry.serverId === options.serverId)
          continue;
        entries.push({ ...entry, active: fresh(entry, now) });
      } catch {
        /* A partly written or foreign file is not an instance. */
      }
    }
    return entries.sort((a, b) => a.serverName.localeCompare(b.serverName));
  }
  return {
    list,
    async write(state: {
      gamePid: number | null;
      ports: ReforgerInstancePorts | null;
    }) {
      await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
      const entry: ReforgerInstanceEntry = {
        version: 1,
        serverId: options.serverId,
        serverName: options.serverName,
        profile: options.profile,
        config: options.config,
        connectorPid: process.pid,
        gamePid: state.gamePid,
        ports: state.ports,
        updatedAt: Date.now(),
      };
      const target = file(options.serverId),
        temporary = `${target}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
      await fs.rename(temporary, target);
    },
    async remove() {
      await fs.rm(file(options.serverId), { force: true });
    },
    /** Refuses a start whose ports, profile or configuration another live
     * connector on this installation already uses. */
    async assertStartable(ports: ReforgerInstancePorts, now = Date.now()) {
      for (const other of await list(now)) {
        if (!other.active) continue;
        if (
          other.profile === options.profile ||
          other.config === options.config
        )
          throw new Error(
            `${other.serverName} uses the same profile or configuration on this host.`,
          );
        const clashes = other.ports
          ? reforgerPortClashes(ports, other.ports)
          : [];
        if (clashes.length)
          throw new Error(
            `UDP port ${clashes.join(', ')} is used by ${other.serverName} on this host. Change the game, query or RCON port before starting.`,
          );
      }
    },
    async runningSiblings(now = Date.now()) {
      return (await list(now)).filter(
        (other) => other.active && other.gamePid !== null,
      );
    },
  };
}
