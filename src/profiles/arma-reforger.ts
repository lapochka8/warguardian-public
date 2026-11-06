import type { ReforgerServerConfig } from '../config';
import { AgentError } from '../errors';
import type { AgentCommand } from '../protocol';
import {
  jsonResponse,
  type CommandResponse,
  type ProfileHandler,
} from './types';

const hostPrefix = '/reforger/v1/host/';

/** The v1 host connector answered unsupported routes with this body. */
const unsupportedHostCommand = () =>
  jsonResponse(400, { error: 'Unsupported host command.' });

/**
 * Arma Reforger host management through the bundled host controller. It
 * needs Linux process identity checks and runs one server per process, under
 * the profile lock taken at start.
 */
export async function createReforgerProfile(
  server: ReforgerServerConfig,
): Promise<ProfileHandler> {
  if (process.platform !== 'linux')
    throw new AgentError(
      400,
      'unsupported',
      'Arma Reforger host management needs Linux.',
    );
  const host = server.host;
  if (!host)
    throw new AgentError(
      400,
      'not-configured',
      'Set the host settings for this Arma Reforger server.',
    );
  const { createReforgerHostController } =
    await import('../../vendor/reforger/reforger-host-controller');
  const controller = await createReforgerHostController({
    serverId: server.serverId,
    serverName: host.serverName ?? server.serverId,
    profile: host.profile,
    config: host.config,
    executable: host.executable,
    stateDirectory: host.stateDirectory,
    maxFps: host.maxFps,
    logStatsMs: host.logStatsMs,
    ...(host.steamcmd ? { steamcmd: host.steamcmd } : {}),
    ...(host.installDirectory
      ? { installDirectory: host.installDirectory }
      : {}),
    ...(host.instancesDirectory
      ? { instancesDirectory: host.instancesDirectory }
      : {}),
    ...(host.telemetryAddonsDirectory
      ? { telemetryAddonsDirectory: host.telemetryAddonsDirectory }
      : {}),
  });
  return {
    profile: 'arma-reforger',
    start() {},
    secrets: () => [],
    close: () => controller.close(),
    async handle(command: AgentCommand): Promise<CommandResponse> {
      if (!command.path.startsWith(hostPrefix)) return unsupportedHostCommand();
      try {
        const path = new URL(command.path, 'http://agent.invalid');
        const resource = path.pathname.slice(hostPrefix.length);
        if (command.method === 'POST' && resource === 'command')
          return jsonResponse(
            200,
            await controller.execute(
              JSON.parse(command.body ?? 'null'),
              command.id,
            ),
          );
        if (command.method === 'GET')
          return jsonResponse(
            200,
            await controller.read(resource, path.searchParams),
          );
        return unsupportedHostCommand();
      } catch (error) {
        return jsonResponse(409, {
          error: await controller.describeError(error),
        });
      }
    },
  };
}
