/**
 * An error with an HTTP status and a stable code for the panel. Messages
 * never contain a password, a secret or a local path.
 */
export class AgentError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AgentError';
    this.status = status;
    this.code = code;
  }
}

/** Replace every known secret value in a message before it is logged. */
export function redact(message: string, secrets: readonly string[]): string {
  let result = message;
  for (const secret of secrets)
    if (secret && secret.length >= 3)
      result = result.split(secret).join('[redacted]');
  return result.slice(0, 1000);
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
