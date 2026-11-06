import { hostname } from 'node:os';
import { posix } from 'node:path';
import { boundedBody } from './client';
import {
  describeIssues,
  panelOrigin,
  parseAgentConfig,
  readAgentConfig,
  serverConfig,
  writeAgentConfig,
  type AgentConfig,
  type ServerConfig,
} from './config';
import { discoverServers, type DiscoveredInstance } from './discovery';
import { AgentError } from './errors';
import {
  agentPaths,
  enrollRequest,
  enrollResponse,
  normalizeEnrollmentCode,
  type EnrollResponse,
} from './protocol';

export type EnrollOptions = {
  code: string;
  configFile: string;
  stateDirectory: string;
  /** Required unless `agent.json` or the build names the WarGuardian address. */
  panel?: string;
  /** The `id` from `discover`, when several servers of the game run here. */
  instance?: string;
  version: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetcher?: typeof fetch;
  discover?: () => Promise<DiscoveredInstance[]>;
  /** Servers found by `discover --output` as root. Used instead of `discover`. */
  discovered?: DiscoveredInstance[];
  env?: Record<string, string | undefined>;
};

export type EnrollOutcome = {
  serverId: string;
  profile: ServerConfig['profile'];
  /** Settings still missing before the profile can run. */
  missing: string[];
  /** The local ID of the server this binding runs, when one was found. */
  instance?: string;
  /** Why the chosen server's RCON settings could not be read. */
  problem?: string;
  /**
   * Servers the shared service runs after this setup. Arma Reforger servers
   * run in their own service.
   */
  serviceServers: number;
  /** The local RCON paths saved for this server, for the operator. */
  paths: { label: string; path: string }[];
};

/** A host name the panel accepts: letters, digits, `.`, `_` and `-`. */
export function enrollHostName(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 253);
  return cleaned || 'host';
}

/**
 * The local server of the binding's game, or null when none or several match.
 * Servers that other bindings in the configuration already use are skipped,
 * so a second code for the same game picks the server that is left. A
 * server whose configuration path failed the discovery checks is picked
 * only when named.
 */
export function chooseInstance(
  response: EnrollResponse,
  discovered: DiscoveredInstance[],
  instance?: string,
  taken: ReadonlySet<string> = new Set(),
): DiscoveredInstance | null {
  // The secret is already issued here, so a mismatch leaves settings missing instead of failing.
  if (instance) {
    const chosen = discovered.find((item) => item.id === instance);
    return chosen?.summary.gameId === response.gameId ? chosen : null;
  }
  const matching = discovered.filter(
    (item) =>
      item.summary.gameId === response.gameId &&
      !taken.has(item.id) &&
      !item.rejected,
  );
  return matching.length === 1 ? matching[0]! : null;
}

/**
 * The profiles that the shared `warguardian-agent.service` runs. Arma
 * Reforger keeps `reforger-host-connector@.service`.
 */
const sharedServiceProfiles: ReadonlySet<string> = new Set([
  'wardogs',
  'battleye',
  'squad-family',
]);

function entryFor(
  response: EnrollResponse,
  instance: DiscoveredInstance | null,
  options: { stateDirectory: string; env: Record<string, string | undefined> },
): { server: ServerConfig; missing: string[] } {
  const base = {
    serverId: response.serverId,
    secret: response.secret,
    ...(instance ? { instance: instance.id } : {}),
  };
  const missing: string[] = [];
  let candidate: Record<string, unknown>;
  switch (response.profile) {
    case 'wardogs': {
      const rconUrl = options.env.WARDOGS_RCON_URL?.trim();
      const rconToken = options.env.WARDOGS_RCON_TOKEN?.trim();
      if (!rconUrl) missing.push('rconUrl');
      if (!rconToken) missing.push('rconToken');
      candidate = {
        ...base,
        profile: 'wardogs',
        ...(rconUrl ? { rconUrl } : {}),
        ...(rconToken ? { rconToken } : {}),
      };
      break;
    }
    case 'arma-reforger': {
      const found = instance?.settings ?? {};
      const host =
        found.executable && found.config && found.profile
          ? {
              ...found,
              stateDirectory: posix.join(
                options.stateDirectory,
                'reforger',
                response.serverId,
              ),
            }
          : undefined;
      if (!host) missing.push('host');
      candidate = {
        ...base,
        profile: 'arma-reforger',
        ...(host ? { host } : {}),
      };
      break;
    }
    case 'battleye':
    case 'squad-family': {
      candidate = {
        ...base,
        profile: response.profile,
        ...instance?.settings,
        game: response.gameId,
      };
      const file =
        response.profile === 'battleye' ? 'battleyeConfig' : 'rconConfig';
      if (!candidate[file]) missing.push(file);
      break;
    }
  }
  const parsed = serverConfig.safeParse(candidate);
  if (!parsed.success)
    throw new AgentError(
      502,
      'enroll-failed',
      `WarGuardian assigned a game this profile cannot run: ${describeIssues(parsed.error)}`,
    );
  return { server: parsed.data, missing };
}

/** The panel's error text, bounded and on one line. */
function panelError(raw: Buffer): string | null {
  try {
    const value = JSON.parse(raw.toString('utf8')) as { error?: unknown };
    return typeof value.error === 'string'
      ? value.error.replace(/\s+/g, ' ').slice(0, 300)
      : null;
  } catch {
    return null;
  }
}

/**
 * Exchange a one-time code for this server's secret and save the binding.
 * The secret is written to the configuration file only and never printed.
 */
export async function enroll(options: EnrollOptions): Promise<EnrollOutcome> {
  const code = normalizeEnrollmentCode(options.code);
  if (!code)
    throw new AgentError(
      400,
      'invalid-code',
      'Enter the code in the form WG-XXXXX-XXXXX.',
    );
  const saved: AgentConfig =
    (await readAgentConfig(options.configFile)) ?? parseAgentConfig({});
  const panelValue = options.panel ?? saved.panel;
  if (!panelValue)
    throw new AgentError(
      400,
      'not-configured',
      'Pass --panel with the WarGuardian address.',
    );
  const panel = panelOrigin(panelValue).origin;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== 'linux' && platform !== 'win32')
    throw new AgentError(
      400,
      'unsupported',
      'The agent runs on Linux and Windows.',
    );
  if (arch !== 'x64' && arch !== 'arm64')
    throw new AgentError(
      400,
      'unsupported',
      'The agent runs on x64 and arm64.',
    );
  const discovered =
    options.discovered ??
    (await (options.discover ?? (() => discoverServers({ platform })))());
  if (
    options.instance &&
    !discovered.some((item) => item.id === options.instance)
  )
    throw new AgentError(
      400,
      'not-configured',
      `No running server has the ID ${options.instance}. Run: warguardian-agent discover`,
    );
  const request = enrollRequest.parse({
    code,
    host: enrollHostName(hostname()),
    os: platform === 'win32' ? 'win' : 'linux',
    arch,
    version: options.version,
    discovered: discovered.map((item) => item.summary).slice(0, 16),
  });
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(new URL(agentPaths.enroll, panel), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new AgentError(
      503,
      'panel-unavailable',
      'WarGuardian could not be reached.',
    );
  }
  const raw = await boundedBody(response, 16_384);
  if ([401, 404, 410].includes(response.status))
    throw new AgentError(
      response.status,
      'invalid-code',
      'The code is invalid, used or expired. Create a new code in WarGuardian.',
    );
  if (response.status === 429)
    throw new AgentError(
      429,
      'rate-limited',
      'Too many setup attempts. Try again in a few minutes.',
    );
  if (!response.ok)
    throw new AgentError(
      response.status >= 400 && response.status < 500 ? response.status : 502,
      'enroll-failed',
      panelError(raw) ?? `Setup failed (${response.status}).`,
    );
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AgentError(
      502,
      'enroll-failed',
      'WarGuardian sent an invalid setup response.',
    );
  }
  const parsed = enrollResponse.safeParse(body);
  if (!parsed.success)
    throw new AgentError(
      502,
      'enroll-failed',
      'WarGuardian sent an invalid setup response.',
    );
  const taken = new Set(
    saved.servers.flatMap((item) =>
      item.serverId !== parsed.data.serverId && item.instance
        ? [item.instance]
        : [],
    ),
  );
  const instance = chooseInstance(
    parsed.data,
    discovered,
    options.instance,
    taken,
  );
  const { server, missing } = entryFor(parsed.data, instance, {
    stateDirectory: options.stateDirectory,
    env: options.env ?? process.env,
  });
  const entry =
    saved.panel && saved.panel !== panel ? { ...server, panel } : server;
  // The same server keeps its place, so the first server stays at the top of the file.
  const servers = [...saved.servers];
  const index = servers.findIndex((item) => item.serverId === server.serverId);
  if (index >= 0) servers[index] = entry;
  else servers.push(entry);
  await writeAgentConfig(options.configFile, {
    ...saved,
    panel: saved.panel ?? panel,
    servers,
  });
  return {
    serverId: server.serverId,
    profile: server.profile,
    missing,
    ...(instance ? { instance: instance.id } : {}),
    ...(instance?.problem ? { problem: instance.problem } : {}),
    serviceServers: servers.filter((item) =>
      sharedServiceProfiles.has(item.profile),
    ).length,
    paths: [
      ...(server.profile === 'battleye' && server.battleyeConfig
        ? [{ label: 'BattlEye folder', path: server.battleyeConfig }]
        : []),
      ...(server.profile === 'squad-family' && server.rconConfig
        ? [{ label: 'Rcon.cfg', path: server.rconConfig }]
        : []),
    ],
  };
}
