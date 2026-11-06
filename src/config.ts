import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { AgentError } from './errors';
import {
  agentSecret,
  agentServerId,
  battleyeGameIds,
  squadFamilyGameIds,
} from './protocol';

export type AgentPlatform = 'linux' | 'win32';

export type AgentLocations = {
  configFile: string;
  stateDirectory: string;
};

/** Default file locations. Linux: `/etc/warguardian`. Windows: `%ProgramData%\WarGuardian`. */
export function agentLocations(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): AgentLocations {
  if (platform === 'win32') {
    const base = win32.join(
      env.ProgramData || 'C:\\ProgramData',
      'WarGuardian',
    );
    return {
      configFile: win32.join(base, 'agent.json'),
      stateDirectory: win32.join(base, 'state'),
    };
  }
  return {
    configFile: '/etc/warguardian/agent.json',
    stateDirectory: '/var/lib/warguardian-agent',
  };
}

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** An HTTPS origin, or HTTP on loopback for local development. */
export function panelOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentError(
      400,
      'not-configured',
      'The WarGuardian address is not a URL.',
    );
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && loopbackHosts.has(url.hostname))
    )
  )
    throw new AgentError(
      400,
      'not-configured',
      'The WarGuardian address must be an HTTPS origin. HTTP is accepted on loopback only.',
    );
  return url;
}

const origin = z
  .string()
  .max(300)
  .refine((value) => {
    try {
      panelOrigin(value);
      return true;
    } catch {
      return false;
    }
  }, 'Use an HTTPS origin.')
  .transform((value) => panelOrigin(value).origin);

const localOrigin = z
  .string()
  .max(300)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, 'Use an HTTP or HTTPS origin.');

const absolutePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) => posix.isAbsolute(value) || win32.isAbsolute(value),
    'Use an absolute path.',
  );

const ipv4 = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/);
const port = z.number().int().min(1).max(65_535);

const serverFields = {
  serverId: agentServerId,
  secret: agentSecret,
  /** Defaults to the top-level `panel`. */
  panel: origin.optional(),
  /** The `id` of the discovered local server, recorded at enrollment. */
  instance: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .optional(),
};

export const wardogsServerConfig = z
  .object({
    ...serverFields,
    profile: z.literal('wardogs'),
    rconUrl: localOrigin.optional(),
    rconToken: z.string().min(1).max(512).optional(),
  })
  .strict();

export const reforgerServerConfig = z
  .object({
    ...serverFields,
    profile: z.literal('arma-reforger'),
    host: z
      .object({
        profile: absolutePath,
        config: absolutePath,
        executable: absolutePath,
        stateDirectory: absolutePath,
        steamcmd: absolutePath.optional(),
        installDirectory: absolutePath.optional(),
        instancesDirectory: absolutePath.optional(),
        telemetryAddonsDirectory: absolutePath.optional(),
        serverName: z.string().min(1).max(120).optional(),
        maxFps: z.number().int().min(10).max(240).default(60),
        logStatsMs: z.number().int().min(0).max(600_000).default(60_000),
      })
      .strict()
      .optional(),
  })
  .strict();

export const battleyeServerConfig = z
  .object({
    ...serverFields,
    profile: z.literal('battleye'),
    game: z.enum(battleyeGameIds),
    /** `BEServer_x64.cfg`, or the BattlEye directory holding it. */
    battleyeConfig: absolutePath.optional(),
    /** Overrides `RConIP` and `RConPort` from the BattlEye configuration. */
    rconHost: ipv4.optional(),
    rconPort: port.optional(),
    /** The server profile directory with `.rpt` logs, for Steam IDs. */
    logDirectory: absolutePath.optional(),
  })
  .strict();

export const squadServerConfig = z
  .object({
    ...serverFields,
    profile: z.literal('squad-family'),
    game: z.enum(squadFamilyGameIds),
    /** `ServerConfig/Rcon.cfg` of the game installation. */
    rconConfig: absolutePath.optional(),
    rconHost: ipv4.optional(),
    rconPort: port.optional(),
  })
  .strict();

export const serverConfig = z.discriminatedUnion('profile', [
  wardogsServerConfig,
  reforgerServerConfig,
  battleyeServerConfig,
  squadServerConfig,
]);
export type ServerConfig = z.infer<typeof serverConfig>;
export type WardogsServerConfig = z.infer<typeof wardogsServerConfig>;
export type ReforgerServerConfig = z.infer<typeof reforgerServerConfig>;
export type BattlEyeServerConfig = z.infer<typeof battleyeServerConfig>;
export type SquadServerConfig = z.infer<typeof squadServerConfig>;

/** `agent.json`. Every field added later needs a default or must be optional. */
export const agentConfig = z
  .object({
    v: z.literal(2).default(2),
    panel: origin.optional(),
    servers: z.array(serverConfig).max(32).default([]),
    update: z
      .object({ enabled: z.boolean().default(true) })
      .strict()
      .default({ enabled: true }),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = new Set<string>();
    config.servers.forEach((server, index) => {
      if (ids.has(server.serverId))
        context.addIssue({
          code: 'custom',
          path: ['servers', index, 'serverId'],
          message: 'Duplicate server ID.',
        });
      ids.add(server.serverId);
      if (!server.panel && !config.panel)
        context.addIssue({
          code: 'custom',
          path: ['servers', index, 'panel'],
          message: 'Set the WarGuardian address.',
        });
    });
  });
export type AgentConfig = z.infer<typeof agentConfig>;

/** The WarGuardian address of one server entry. */
export function serverPanel(config: AgentConfig, server: ServerConfig): string {
  const value = server.panel ?? config.panel;
  if (!value)
    throw new AgentError(400, 'not-configured', 'Set the WarGuardian address.');
  return value;
}

/**
 * Parse an environment file as systemd `EnvironmentFile` and `node
 * --env-file` read it: `NAME=value` lines, `#` comments, optional `export`,
 * and single or double quotes.
 */
export function parseEnvironmentFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (!match) continue;
    let value = match[2]!;
    const quote = value[0];
    if (
      (quote === '"' || quote === "'") &&
      value.length >= 2 &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
      if (quote === '"')
        value = value.replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1');
    } else value = value.replace(/\s+#.*$/, '');
    values[match[1]!] = value;
  }
  return values;
}

/** True when the variables hold a v1 agent binding. */
export function hasV1Binding(env: Record<string, string | undefined>): boolean {
  return Boolean(env.WARGUARDIAN_AGENT_SERVER_ID?.trim());
}

/**
 * Convert the variables of a v1 agent (WARDOGS outbound agent or Arma
 * Reforger host connector) to a server entry. The v1 variables keep their
 * meaning, so a v1 service upgrades by replacing its executable.
 */
export function serverFromV1Environment(
  env: Record<string, string | undefined>,
): {
  panel: string;
  server: ServerConfig;
} {
  const value = (name: string) => env[name]?.trim() || undefined;
  const required = (name: string) => {
    const found = value(name);
    if (!found)
      throw new AgentError(400, 'not-configured', `${name} is required.`);
    return found;
  };
  const panel = required('WARGUARDIAN_AGENT_URL');
  const base = {
    serverId: required('WARGUARDIAN_AGENT_SERVER_ID'),
    secret: required('WARGUARDIAN_AGENT_SECRET'),
    panel,
  };
  let server: unknown;
  if (value('WARGUARDIAN_HOST_PROFILE')) {
    const number = (name: string, fallback: number) => {
      const found = value(name);
      return found === undefined ? fallback : Number(found);
    };
    server = {
      ...base,
      profile: 'arma-reforger',
      host: {
        profile: required('WARGUARDIAN_HOST_PROFILE'),
        config: required('WARGUARDIAN_HOST_CONFIG'),
        executable: required('WARGUARDIAN_HOST_EXECUTABLE'),
        stateDirectory: required('WARGUARDIAN_HOST_STATE'),
        steamcmd: value('WARGUARDIAN_HOST_STEAMCMD'),
        installDirectory: value('WARGUARDIAN_HOST_INSTALL'),
        instancesDirectory: value('WARGUARDIAN_HOST_INSTANCES'),
        telemetryAddonsDirectory: value('WARGUARDIAN_HOST_TELEMETRY_ADDONS'),
        serverName: value('WARGUARDIAN_HOST_SERVER_NAME'),
        maxFps: number('WARGUARDIAN_HOST_MAX_FPS', 60),
        logStatsMs: number('WARGUARDIAN_HOST_LOG_STATS_MS', 60_000),
      },
    };
  } else if (value('WARDOGS_RCON_URL')) {
    server = {
      ...base,
      profile: 'wardogs',
      rconUrl: required('WARDOGS_RCON_URL'),
      rconToken: required('WARDOGS_RCON_TOKEN'),
    };
  } else
    throw new AgentError(
      400,
      'not-configured',
      'The v1 environment names neither WARDOGS_RCON_URL nor WARGUARDIAN_HOST_PROFILE.',
    );
  const parsed = serverConfig.safeParse(server);
  if (!parsed.success)
    throw new AgentError(
      400,
      'not-configured',
      `The v1 environment is invalid: ${describeIssues(parsed.error)}`,
    );
  return { panel: panelOrigin(panel).origin, server: parsed.data };
}

/** Issue paths without values, so a secret never reaches a log. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
    .join(', ');
}

/** Top-level keys of the file itself. Any other top-level key belongs to the first server. */
const fileKeys = new Set(['v', 'panel', 'servers', 'update']);

/**
 * The file keeps its first server at the top level, as `{panel, serverId,
 * secret, profile, ...}`, and any further servers in `servers`.
 */
export function normalizeAgentConfigFile(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.serverId === undefined) return value;
  const top: Record<string, unknown> = {};
  const first: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record))
    (fileKeys.has(key) ? top : first)[key] = item;
  const rest = Array.isArray(record.servers) ? record.servers : [];
  return { ...top, servers: [first, ...rest] };
}

/** The file form of a configuration: the first server at the top level. */
export function agentConfigFile(config: AgentConfig): Record<string, unknown> {
  const [first, ...rest] = config.servers;
  const { panel, ...server } = first ?? ({} as Partial<ServerConfig>);
  return {
    v: config.v,
    panel: config.panel ?? panel,
    ...(first ? server : {}),
    ...(rest.length ? { servers: rest } : {}),
    update: config.update,
  };
}

export function parseAgentConfig(value: unknown): AgentConfig {
  const parsed = agentConfig.safeParse(normalizeAgentConfigFile(value));
  if (!parsed.success)
    throw new AgentError(
      400,
      'not-configured',
      `The agent configuration is invalid: ${describeIssues(parsed.error)}`,
    );
  return parsed.data;
}

export async function readAgentConfig(
  file: string,
): Promise<AgentConfig | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new AgentError(
      500,
      'not-configured',
      'The agent configuration cannot be read.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new AgentError(
      400,
      'not-configured',
      'The agent configuration is not valid JSON.',
    );
  }
  return parseAgentConfig(value);
}

/** Write atomically with mode 0600. On Windows the directory ACL protects the file. */
export async function writeAgentConfig(
  file: string,
  config: AgentConfig,
): Promise<void> {
  const checked = parseAgentConfig(config);
  const directory = file.includes('\\')
    ? win32.dirname(file)
    : posix.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  // A root `enroll` keeps the owner of an existing file, so the service account can still read it.
  const previous = await fs.stat(file).catch(() => null);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify(agentConfigFile(checked), null, 2)}\n`,
      'utf8',
    );
    await handle.sync();
    if (previous && process.platform !== 'win32' && process.getuid?.() === 0)
      await handle.chown(previous.uid, previous.gid);
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  if (process.platform !== 'win32') await fs.chmod(file, 0o600);
}

export type LoadedServers = {
  config: AgentConfig;
  /** Where each entry came from, for messages. */
  sources: Map<string, string>;
};

/**
 * The servers this process runs. A process started with v1 variables and
 * without `--config` or `--env-file` runs exactly that v1 server, as the v1
 * service did. Otherwise it runs `agent.json` plus each `--env-file`.
 */
export async function loadServers(options: {
  configFile: string;
  configExplicit: boolean;
  envFiles: string[];
  env: Record<string, string | undefined>;
}): Promise<LoadedServers> {
  const sources = new Map<string, string>();
  if (
    !options.configExplicit &&
    !options.envFiles.length &&
    hasV1Binding(options.env)
  ) {
    const { panel, server } = serverFromV1Environment(options.env);
    sources.set(server.serverId, 'environment');
    return { config: parseAgentConfig({ panel, servers: [server] }), sources };
  }
  const saved = await readAgentConfig(options.configFile);
  if (!saved && options.configExplicit)
    throw new AgentError(
      400,
      'not-configured',
      'The agent configuration file does not exist.',
    );
  const config: AgentConfig = saved ?? parseAgentConfig({});
  for (const server of config.servers)
    sources.set(server.serverId, 'agent.json');
  for (const file of options.envFiles) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      throw new AgentError(
        400,
        'not-configured',
        'An environment file cannot be read.',
      );
    }
    const { panel, server } = serverFromV1Environment(
      parseEnvironmentFile(text),
    );
    if (sources.has(server.serverId))
      throw new AgentError(
        400,
        'not-configured',
        `Server ${server.serverId} is configured twice.`,
      );
    sources.set(server.serverId, file);
    config.servers.push({ ...server, panel: server.panel ?? panel });
  }
  return { config: parseAgentConfig(config), sources };
}
