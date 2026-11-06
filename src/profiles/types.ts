import { AgentError } from '../errors';
import {
  nativeReplyMissingStatus,
  type AgentCommand,
  type AgentProfileId,
} from '../protocol';

export type CommandResponse = {
  status: number;
  contentType?: string;
  etag?: string;
  body: Buffer;
};

/** One server binding: the routes it accepts and the local resources it holds. */
export type ProfileHandler = {
  readonly profile: AgentProfileId;
  /** Open long-lived local sessions. Failures are retried in the background. */
  start(): void;
  handle(command: AgentCommand): Promise<CommandResponse>;
  close(): Promise<void>;
  /** Values to redact from log lines. */
  secrets(): string[];
};

export function jsonResponse(status: number, value: unknown): CommandResponse {
  return {
    status,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(value)),
  };
}

/** The panel-facing form of an error. Unknown errors carry no detail. */
export function errorResponse(error: unknown): CommandResponse {
  if (error instanceof AgentError)
    return jsonResponse(error.status, {
      error: error.code,
      message: error.message,
    });
  return jsonResponse(500, {
    error: 'internal',
    message: 'The agent could not run the command.',
  });
}

export function unsupportedRoute(): CommandResponse {
  return jsonResponse(400, {
    error: 'unsupported',
    message: 'Unsupported agent command.',
  });
}

/** The command was sent and no reply came. It may have run. */
export function replyMissing(): AgentError {
  return new AgentError(
    nativeReplyMissingStatus,
    'reply-missing',
    'The game server did not answer the command. Check the server before you send it again.',
  );
}
