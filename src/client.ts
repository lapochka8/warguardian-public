import { randomBytes } from 'node:crypto';
import { AgentError } from './errors';
import {
  agentHeaders,
  agentMaximumSkewMs,
  agentSignature,
  agentSignatureMatches,
} from './protocol';

/** Read at most `maximum` bytes of a response body. */
export async function boundedBody(
  response: Response,
  maximum: number,
): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum)
    throw new AgentError(502, 'oversized', 'The response is too large.');
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximum) {
      await reader.cancel();
      throw new AgentError(502, 'oversized', 'The response is too large.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export type SignedClientOptions = {
  panel: string;
  serverId: string;
  secret: string;
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /**
   * The running agent version, sent as `X-WarGuardian-Agent-Version`. The
   * header is outside the signature, so a panel that ignores it, such as
   * 1.0.0, accepts the request unchanged.
   */
  version?: string;
};

/** The HTTP status of a failed panel request, for backoff and health decisions. */
export class PanelRequestFailed extends AgentError {
  constructor(status: number) {
    super(
      status,
      'panel-unavailable',
      `WarGuardian request failed (${status}).`,
    );
    this.name = 'PanelRequestFailed';
  }
}

/**
 * Signed POST requests to the panel. Each response must carry a valid
 * signature over the request nonce, within the clock skew.
 */
export function createSignedClient(options: SignedClientOptions) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const origin = new URL(options.panel);

  /** `signal` ends the request early, for example when the service stops. */
  async function post(
    path: string,
    value: unknown,
    maximum: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
    const body = JSON.stringify(value);
    const at = now();
    const nonce = randomBytes(18).toString('base64url');
    const response = await fetcher(new URL(path, origin), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [agentHeaders.agent]: options.serverId,
        [agentHeaders.time]: String(at),
        [agentHeaders.nonce]: nonce,
        ...(options.version ? { [agentHeaders.version]: options.version } : {}),
        [agentHeaders.signature]: agentSignature(options.secret, {
          direction: 'request',
          method: 'POST',
          path,
          serverId: options.serverId,
          at,
          nonce,
          body,
        }),
      },
      body,
      redirect: 'error',
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    const raw = await boundedBody(response, maximum);
    if (!response.ok) throw new PanelRequestFailed(response.status);
    const responseAt = Number(response.headers.get(agentHeaders.time));
    const responseNonce = response.headers.get(agentHeaders.nonce) ?? '';
    const supplied = response.headers.get(agentHeaders.signature) ?? '';
    if (
      !Number.isSafeInteger(responseAt) ||
      Math.abs(now() - responseAt) > agentMaximumSkewMs ||
      responseNonce !== nonce ||
      !agentSignatureMatches(
        supplied,
        agentSignature(options.secret, {
          direction: 'response',
          method: 'POST',
          path,
          serverId: options.serverId,
          at: responseAt,
          nonce: responseNonce,
          body: raw,
        }),
      )
    )
      throw new AgentError(
        502,
        'panel-unauthenticated',
        'WarGuardian response authentication failed.',
      );
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AgentError(
        502,
        'panel-unauthenticated',
        'WarGuardian sent an invalid response.',
      );
    }
  }

  return { post };
}
export type SignedClient = ReturnType<typeof createSignedClient>;
