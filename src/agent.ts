import {
  PanelRequestFailed,
  createSignedClient,
  type SignedClient,
} from './client';
import { AgentError, errorMessage, redact } from './errors';
import {
  agentCommand,
  agentCommandMaxLifetimeMs,
  agentPaths,
  agentPollResponse,
  agentPollResponseMaxBytes,
  agentRequestId,
  agentResponseBodyForbidden,
  agentResultBodyMaxBytes,
  agentResultResponseMaxBytes,
  type AgentCommand,
} from './protocol';
import type { CommandResponse, ProfileHandler } from './profiles/types';

export type Logger = {
  info(message: string): void;
  error(message: string): void;
};

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
};

function sized(response: CommandResponse): CommandResponse {
  if (
    !Number.isInteger(response.status) ||
    response.status < 200 ||
    response.status > 599
  )
    return {
      status: 502,
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({
          error: 'invalid-status',
          message: 'The local server returned an invalid status.',
        }),
      ),
    };
  if (agentResponseBodyForbidden(response.status))
    return { ...response, body: Buffer.alloc(0) };
  if (response.body.length > agentResultBodyMaxBytes)
    return {
      status: 413,
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({
          error: 'oversized',
          message: 'The result exceeds 1 MiB.',
        }),
      ),
    };
  return response;
}

/** The route without IDs, for log lines. */
export function routeLabel(
  command: Pick<AgentCommand, 'method' | 'path'>,
): string {
  return `${command.method} ${command.path.split('?')[0]!.replace(/\d{17,20}/g, '*')}`;
}

export type ServerLoopOptions = {
  serverId: string;
  client: SignedClient;
  handler: ProfileHandler;
  logger?: Logger;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** A number in [0, 1) for the reconnect jitter. */
  random?: () => number;
  /** Called after each poll whose signed response verified. */
  onHealthy?: () => void;
  secrets?: () => string[];
};

export function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Poll for one command at a time, run it through the profile and post the
 * result. The agent opens no listener. A command is run at most once: a
 * result that cannot be delivered is not retried.
 */
export function createServerLoop(options: ServerLoopOptions) {
  const logger = options.logger ?? consoleLogger;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const clean = (message: string) =>
    redact(message, [
      ...(options.secrets?.() ?? []),
      ...options.handler.secrets(),
    ]);

  async function respond(requestId: string, response: CommandResponse) {
    const checked = sized(response);
    await options.client.post(
      agentPaths.result,
      {
        requestId,
        status: checked.status,
        ...(checked.contentType
          ? { contentType: checked.contentType.slice(0, 200) }
          : {}),
        ...(checked.etag ? { etag: checked.etag.slice(0, 300) } : {}),
        body: checked.body.toString('base64'),
      },
      agentResultResponseMaxBytes,
    );
    return checked.status;
  }

  /** One poll and, when a command arrives, its result. */
  /**
   * `signal` ends a waiting poll at once. A command that already arrived
   * still runs and its result is still posted.
   */
  async function step(
    signal?: AbortSignal,
  ): Promise<{ worked: boolean; retryAfterMs: number }> {
    const polled = agentPollResponse.safeParse(
      await options.client.post(
        agentPaths.poll,
        {},
        agentPollResponseMaxBytes,
        signal,
      ),
    );
    if (!polled.success)
      throw new AgentError(
        502,
        'panel-unavailable',
        'WarGuardian sent an invalid poll response.',
      );
    options.onHealthy?.();
    const raw = polled.data.command;
    if (raw === undefined || raw === null)
      return {
        worked: false,
        retryAfterMs: Math.min(
          2_000,
          Math.max(250, polled.data.retryAfterMs ?? 250),
        ),
      };
    const parsed = agentCommand.safeParse(raw);
    if (!parsed.success) {
      const id = agentRequestId.safeParse((raw as { id?: unknown })?.id);
      if (!id.success)
        throw new AgentError(
          502,
          'panel-unavailable',
          'WarGuardian sent an invalid command.',
        );
      await respond(id.data, {
        status: 400,
        contentType: 'application/json',
        body: Buffer.from(
          JSON.stringify({
            error: 'unsupported',
            message: 'Unsupported agent command.',
          }),
        ),
      });
      logger.error(`${options.serverId}: refused an unsupported command.`);
      return { worked: true, retryAfterMs: 0 };
    }
    const command = parsed.data;
    const at = now();
    if (
      command.expiresAt <= at ||
      command.expiresAt > at + agentCommandMaxLifetimeMs
    ) {
      logger.error(
        `Skipped an expired command for ${options.serverId}: ${routeLabel(command)}.`,
      );
      return { worked: true, retryAfterMs: 0 };
    }
    let response: CommandResponse;
    try {
      response = await options.handler.handle(command);
    } catch (error) {
      logger.error(
        clean(
          `Command failed for ${options.serverId}: ${errorMessage(error, 'unknown error')}`,
        ),
      );
      response = {
        status: 500,
        contentType: 'application/json',
        body: Buffer.from(
          JSON.stringify({
            error: 'internal',
            message: 'The agent could not run the command.',
          }),
        ),
      };
    }
    const status = await respond(command.id, response);
    if (status >= 400)
      logger.error(`${options.serverId}: ${routeLabel(command)} (${status}).`);
    return { worked: true, retryAfterMs: 0 };
  }

  async function run(signal: AbortSignal) {
    let delay = 250;
    /** The reconnect wait before jitter. It doubles after each failure. */
    let backoff = 250;
    let lastError = '';
    while (!signal.aborted) {
      try {
        const result = await step(signal);
        delay = result.worked ? 0 : result.retryAfterMs;
        backoff = 250;
        if (lastError)
          logger.info(`${options.serverId}: connected to WarGuardian.`);
        lastError = '';
      } catch (error) {
        if (signal.aborted) break;
        const message =
          error instanceof PanelRequestFailed && error.status === 401
            ? 'WarGuardian refused the agent secret. Set up this server again with a new code.'
            : errorMessage(error, 'request failed');
        if (message !== lastError)
          logger.error(
            clean(`${options.serverId}: WarGuardian unavailable: ${message}`),
          );
        lastError = message;
        // Each wait is drawn from the upper half of the backoff, so agents
        // that lost WarGuardian together do not reconnect in step.
        backoff = Math.min(30_000, backoff * 2);
        delay = Math.round(backoff / 2 + random() * (backoff / 2));
      }
      if (!signal.aborted && delay > 0) await sleep(delay, signal);
    }
  }

  return { step, run };
}

export function createServerClient(
  panel: string,
  serverId: string,
  secret: string,
  options: { fetcher?: typeof fetch; version?: string } = {},
) {
  return createSignedClient({
    panel,
    serverId,
    secret,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.version ? { version: options.version } : {}),
  });
}
