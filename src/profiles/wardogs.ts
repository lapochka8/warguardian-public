import { boundedBody } from '../client';
import type { WardogsServerConfig } from '../config';
import { AgentError } from '../errors';
import type { AgentCommand } from '../protocol';
import {
  errorResponse,
  unsupportedRoute,
  type CommandResponse,
  type ProfileHandler,
} from './types';

/** The WARDOGS routes the agent forwards. The panel applies the same list. */
const exactRoutes = new Set([
  'GET /v1/status',
  'GET /v1/players',
  'GET /v1/capabilities',
  'GET /v1/catalog/maps',
  'GET /v1/catalog/lightings',
  'GET /v1/catalog/experiences',
  'GET /v1/rotation',
  'GET /v1/health',
  'GET /v1/server-id',
  'GET /v1/bans',
  'GET /v1/reserved-slots',
  'GET /v1/config',
  'GET /v1/sponsor',
  'PATCH /v1/settings',
  'POST /v1/broadcast',
  'POST /v1/bans',
  'POST /v1/match/end',
  'POST /v1/match/restart',
  'POST /v1/match/map',
  'PUT /v1/world/lighting',
  'POST /v1/config/validate',
  'PUT /v1/config',
]);

export function wardogsRouteAllowed(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (path.length > 300) return false;
  return (
    exactRoutes.has(`${verb} ${path}`) ||
    (verb === 'GET' &&
      /^\/v1\/audit\?limit=(?:[1-9]|[1-9]\d|1\d\d|200)$/.test(path)) ||
    (verb === 'GET' &&
      /^\/v1\/catalog\/maps\/[^/?#]{1,150}\/(?:experiences|alternators)$/.test(
        path,
      )) ||
    (['POST', 'PATCH'].includes(verb) &&
      /^\/v1\/players\/\d{17,20}(?:\/(?:kick|kill|message))?$/.test(path)) ||
    (verb === 'DELETE' && /^\/v1\/bans\/\d{17,20}$/.test(path))
  );
}

/** Forward allowlisted WARDOGS RCON routes to the local RCON origin. */
export function createWardogsProfile(
  server: WardogsServerConfig,
  fetcher: typeof fetch = fetch,
): ProfileHandler {
  const rconUrl = server.rconUrl;
  const rconToken = server.rconToken;
  return {
    profile: 'wardogs',
    start() {},
    async close() {},
    secrets: () => (rconToken ? [rconToken] : []),
    async handle(command: AgentCommand): Promise<CommandResponse> {
      if (!wardogsRouteAllowed(command.method, command.path))
        return unsupportedRoute();
      if (!rconUrl || !rconToken)
        return errorResponse(
          new AgentError(
            503,
            'not-configured',
            'Set rconUrl and rconToken for this server.',
          ),
        );
      let response: Response;
      try {
        response = await fetcher(new URL(command.path, rconUrl), {
          method: command.method,
          headers: {
            Authorization: `Bearer ${rconToken}`,
            ...(command.contentType
              ? { 'Content-Type': command.contentType }
              : {}),
            ...(command.revision
              ? { 'If-Match': `"${command.revision}"` }
              : {}),
          },
          body: command.body,
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        return errorResponse(
          new AgentError(
            503,
            'game-unavailable',
            'The local WARDOGS RCON origin is unavailable.',
          ),
        );
      }
      let body: Buffer;
      try {
        body = await boundedBody(response, 1_048_576);
      } catch {
        return errorResponse(
          new AgentError(
            502,
            'oversized',
            'The local RCON response exceeds 1 MiB.',
          ),
        );
      }
      const contentType = response.headers.get('content-type');
      const etag = response.headers.get('etag');
      return {
        status: response.status,
        ...(contentType ? { contentType } : {}),
        ...(etag ? { etag } : {}),
        body,
      };
    },
  };
}
