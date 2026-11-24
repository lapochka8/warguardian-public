import { AgentError } from '../errors';
import {
  ReplyMissing,
  gameUnavailable,
  loginRejected,
} from './battleye-session';

/**
 * One local Rust WebRCON connection, held by the agent. A request is JSON
 * `{Identifier, Message, Name}` and its reply carries the same identifier.
 * Every other message is pushed output: console lines, chat and player reports.
 *
 * The password is the path of the WebSocket address, as the game expects.
 * The connection goes to a local address only, and the address is never
 * logged or reported.
 */

export type RustEndpoint = { host: string; port: number; password: string };

/** A pushed message in the form the panel reads. */
export type RustPushed = {
  at: number;
  channel: 'chat' | 'report' | 'console';
  severity: 'info' | 'warning' | 'error';
  identifier: number;
  text: string;
};

type Socket = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: { data?: unknown }) => void,
  ): void;
};

export type RustWebRconSessionOptions = {
  endpoint: () => Promise<RustEndpoint>;
  onMessage: (message: RustPushed) => void;
  /** Runs on each new connection, such as the settings that print events. */
  onOpen?: (session: RustWebRconSession) => void;
  commandTimeoutMs?: number;
  openTimeoutMs?: number;
  maxMessageBytes?: number;
  /** For tests. Default: the runtime's `WebSocket`. */
  connect?: (url: string) => Socket;
  now?: () => number;
};

type Pending = {
  resolve: (reply: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const firstIdentifier = 1_000;
const lastIdentifier = 2_000_000_000;

export class RustWebRconSession {
  #options: RustWebRconSessionOptions;
  #socket: Socket | undefined;
  #opening: Promise<Socket> | undefined;
  #pending = new Map<number, Pending>();
  #identifier = firstIdentifier;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: RustWebRconSessionOptions) {
    this.#options = options;
  }

  get connected(): boolean {
    return !!this.#socket && this.#socket.readyState === 1;
  }

  /** Run `task` after every earlier task, so a check and its command are not split. */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Open the connection if it is not open. */
  async connect(): Promise<void> {
    await this.#open();
  }

  async #open(): Promise<Socket> {
    if (this.#closed) throw gameUnavailable();
    if (this.#socket && this.#socket.readyState === 1) return this.#socket;
    this.#opening ??= this.#dial().finally(() => {
      this.#opening = undefined;
    });
    return this.#opening;
  }

  async #dial(): Promise<Socket> {
    const endpoint = await this.#options.endpoint();
    if (
      !endpoint.password ||
      /["#<>?\\^`{}\s]/.test(endpoint.password) ||
      /(?:^|\/)\.{1,2}(?:\/|$)/.test(endpoint.password)
    )
      throw new AgentError(
        503,
        'not-configured',
        'The RCON password cannot be used in a WebRCON address.',
      );
    const url = `ws://${endpoint.host}:${endpoint.port}/${endpoint.password}`;
    const connect =
      this.#options.connect ??
      ((address: string) => new WebSocket(address) as unknown as Socket);
    const maxBytes = this.#options.maxMessageBytes ?? 8 * 1024 * 1024;
    return new Promise<Socket>((resolve, reject) => {
      let socket: Socket;
      let settled = false;
      try {
        socket = connect(url);
      } catch {
        reject(gameUnavailable());
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(gameUnavailable());
      }, this.#options.openTimeoutMs ?? 5_000);
      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#socket = socket;
        resolve(socket);
        this.#options.onOpen?.(this);
      });
      const lost = () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          // A Rust server closes the socket at once for a wrong password.
          reject(loginRejected());
        }
        if (this.#socket === socket) this.#socket = undefined;
        for (const [identifier, pending] of this.#pending) {
          clearTimeout(pending.timer);
          this.#pending.delete(identifier);
          pending.reject(new ReplyMissing());
        }
      };
      socket.addEventListener('close', lost);
      socket.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(gameUnavailable());
        }
      });
      socket.addEventListener('message', (event) => {
        const data = typeof event.data === 'string' ? event.data : '';
        if (!data || data.length > maxBytes) return;
        this.#receive(data);
      });
    });
  }

  #receive(data: string) {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    if (!value || typeof value !== 'object') return;
    const fields = value as Record<string, unknown>;
    const identifier = fields['Identifier'];
    const text = fields['Message'];
    if (typeof identifier !== 'number' || typeof text !== 'string') return;
    const pending = this.#pending.get(identifier);
    if (pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(identifier);
      pending.resolve(text);
      return;
    }
    const type = typeof fields['Type'] === 'string' ? fields['Type'] : '';
    this.#options.onMessage({
      at: (this.#options.now ?? Date.now)(),
      channel:
        type === 'Chat' ? 'chat' : type === 'Report' ? 'report' : 'console',
      severity:
        type === 'Warning' ? 'warning' : type === 'Error' ? 'error' : 'info',
      identifier,
      text,
    });
  }

  /**
   * Send one console line and wait for its reply. `ReplyMissing` means the
   * line left and no reply came: it may have run and is never sent again.
   */
  async command(line: string): Promise<string> {
    const socket = await this.#open();
    return new Promise<string>((resolve, reject) => {
      do
        this.#identifier =
          this.#identifier >= lastIdentifier
            ? firstIdentifier
            : this.#identifier + 1;
      while (this.#pending.has(this.#identifier));
      const identifier = this.#identifier;
      const pending: Pending = {
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.#pending.get(identifier) !== pending) return;
          this.#pending.delete(identifier);
          reject(new ReplyMissing());
        }, this.#options.commandTimeoutMs ?? 10_000),
      };
      this.#pending.set(identifier, pending);
      try {
        socket.send(
          JSON.stringify({
            Identifier: identifier,
            Message: line,
            Name: 'WarGuardian',
          }),
        );
      } catch {
        clearTimeout(pending.timer);
        this.#pending.delete(identifier);
        reject(gameUnavailable());
      }
    });
  }

  /**
   * Ask a command the server may not have. Rust answers in order and never
   * answers an unknown command, so a later command that answers first means
   * there is no reply. Gives null then.
   */
  async probe(line: string): Promise<string | null> {
    const asked = this.command(line).then(
      (reply) => ({ reply }),
      () => ({ reply: null }),
    );
    const next = this.command('version').then(
      () => ({ reply: null }),
      () => ({ reply: null }),
    );
    return (await Promise.race([asked, next])).reply;
  }

  close(): void {
    this.#closed = true;
    this.#socket?.close();
    this.#socket = undefined;
  }
}
