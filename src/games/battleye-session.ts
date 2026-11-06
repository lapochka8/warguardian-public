import { randomInt } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { AgentError } from '../errors';

/**
 * A BattlEye RCon client over UDP, following the published BERConProtocol
 * description. Payload types are login (0), command (1) and server message
 * (2). Sequence numbers are one byte. A long reply arrives in parts with a
 * `0, count, index` header. The server drops a client that sends nothing for
 * 45 seconds and repeats a server message until it is acknowledged.
 */

export function battleyePacket(payload: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from([255]), payload]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const packet = Buffer.alloc(6 + body.length);
  packet.write('BE');
  packet.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 2);
  body.copy(packet, 6);
  return packet;
}

export function battleyePayload(packet: Buffer): Buffer | null {
  if (
    packet.length < 8 ||
    packet[0] !== 66 ||
    packet[1] !== 69 ||
    packet[6] !== 255
  )
    return null;
  const payload = packet.subarray(7);
  return battleyePacket(payload).equals(packet) ? payload : null;
}

const packetType = { login: 0, command: 1, message: 2 } as const;
const maxParts = 255;
const maxReplyBytes = 1024 * 1024;
const maxCommandBytes = 4096;
const recentMessageWindow = 128;

function hasLineBreak(text: string): boolean {
  return text.includes('\r') || text.includes('\n') || text.includes('\u0000');
}

/** Login numbers start at a random offset, so a reference from another process never matches. */
let lastLogin = randomInt(1, 1_000_000_000);

export function gameUnavailable(): AgentError {
  return new AgentError(
    503,
    'game-unavailable',
    'The game server RCON connection is unavailable.',
  );
}

export function loginRejected(): AgentError {
  return new AgentError(
    502,
    'login-rejected',
    'The game server rejected the RCON password.',
  );
}

/** The command was sent and no complete reply arrived. It must not be sent again. */
export class ReplyMissing extends AgentError {
  constructor() {
    super(
      504,
      'game-unavailable',
      'The game server did not answer the command.',
    );
    this.name = 'ReplyMissing';
  }
}

/** The login of a pinned command ended before sending. Nothing was sent. */
export class LoginChanged extends AgentError {
  constructor() {
    super(409, 'game-unavailable', 'The game server login changed.');
    this.name = 'LoginChanged';
  }
}

export type BattlEyeEndpoint = { host: string; port: number };

export type BattlEyeSessionOptions = {
  endpoint: () => Promise<BattlEyeEndpoint & { password: string }>;
  onMessage?: (text: string, at: number) => void;
  keepAliveMs?: number;
  commandTimeoutMs?: number;
  now?: () => number;
};

type Pending =
  | {
      kind: 'login';
      resolve(epoch: number): void;
      reject(error: unknown): void;
      timer: NodeJS.Timeout;
    }
  | {
      kind: 'command';
      sequence: number;
      resolve(reply: string): void;
      reject(error: unknown): void;
      timer: NodeJS.Timeout;
      count?: number;
      parts: Map<number, Buffer>;
      bytes: number;
    };

const utf8 = new TextDecoder('utf-8', { fatal: true });
const lenientUtf8 = new TextDecoder('utf-8');

export class BattlEyeSession {
  readonly #options: Required<Omit<BattlEyeSessionOptions, 'onMessage'>> &
    Pick<BattlEyeSessionOptions, 'onMessage'>;
  readonly #heartbeat: NodeJS.Timeout;
  #socket: Socket | null = null;
  #connected = false;
  #closed = false;
  #epoch = 0;
  #sequence = 0;
  #lastSentAt = 0;
  #lastReceivedAt = 0;
  #pending: Pending | null = null;
  #tail: Promise<unknown> = Promise.resolve();
  #queued = 0;
  #recent = new Map<number, Buffer>();

  constructor(options: BattlEyeSessionOptions) {
    this.#options = {
      keepAliveMs: 30_000,
      commandTimeoutMs: 5_000,
      now: Date.now,
      ...options,
    };
    this.#heartbeat = setInterval(() => this.#keepAlive(), 1_000);
    this.#heartbeat.unref();
  }

  get connected(): boolean {
    return this.#connected;
  }

  /**
   * True when the server answered a login or command of this login within
   * `milliseconds`. Server messages do not count: they repeat until acknowledged.
   */
  answeredWithin(milliseconds: number): boolean {
    return (
      this.#connected &&
      this.#options.now() - this.#lastReceivedAt <= milliseconds
    );
  }

  /** Log in when needed and return the current login number. */
  connect(): Promise<number> {
    return this.#exclusive(async () => {
      if (!this.#connected) await this.#login();
      return this.#epoch;
    });
  }

  /**
   * Send one command and return its reply. With `epoch`, the command is sent
   * only in that login. Commands run one at a time in call order.
   */
  command(text: string, options: { epoch?: number } = {}): Promise<string> {
    if (
      typeof text !== 'string' ||
      Buffer.byteLength(text) > maxCommandBytes ||
      hasLineBreak(text)
    )
      return Promise.reject(
        new AgentError(
          400,
          'invalid-operation',
          'The command line is invalid.',
        ),
      );
    return this.#exclusive(async () => {
      if (options.epoch !== undefined) {
        if (!this.#connected || this.#epoch !== options.epoch)
          throw new LoginChanged();
      } else if (!this.#connected) await this.#login();
      return this.#send(text);
    });
  }

  /** Run reads and a write in one login without another caller in between. */
  exclusive<T>(run: () => Promise<T>): Promise<T> {
    return this.#exclusive(run);
  }

  /** `command` for use inside `exclusive`. */
  async commandInLogin(text: string, epoch: number): Promise<string> {
    if (!this.#connected || this.#epoch !== epoch) throw new LoginChanged();
    if (Buffer.byteLength(text) > maxCommandBytes || hasLineBreak(text))
      throw new AgentError(
        400,
        'invalid-operation',
        'The command line is invalid.',
      );
    return this.#send(text);
  }

  /** `connect` for use inside `exclusive`. */
  async connectInLogin(): Promise<number> {
    if (!this.#connected) await this.#login();
    return this.#epoch;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeat);
    this.#disconnect();
  }

  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    this.#queued += 1;
    const result = this.#tail.then(() => {
      if (this.#closed) throw gameUnavailable();
      return run();
    });
    const release = () => {
      this.#queued -= 1;
    };
    this.#tail = result.then(release, release);
    return result;
  }

  #keepAlive() {
    if (
      this.#closed ||
      !this.#connected ||
      this.#queued > 0 ||
      this.#options.now() - this.#lastSentAt < this.#options.keepAliveMs
    )
      return;
    const epoch = this.#epoch;
    void this.#exclusive(async () => {
      if (this.#connected && this.#epoch === epoch) await this.#send('');
    }).catch(() => undefined);
  }

  async #login(): Promise<number> {
    this.#disconnect();
    const { host, port, password } = await this.#options.endpoint();
    const socket = createSocket('udp4');
    socket.unref();
    this.#socket = socket;
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => this.#fail(gameUnavailable()),
        this.#options.commandTimeoutMs,
      );
      this.#pending = { kind: 'login', resolve, reject, timer };
      socket.on('error', () => this.#socketFailed(socket));
      socket.on('message', (packet) => {
        if (this.#socket === socket) this.#receive(packet);
      });
      socket.connect(port, host, (error?: Error) => {
        if (this.#socket !== socket) return;
        if (error) return this.#socketFailed(socket);
        this.#write(
          Buffer.concat([
            Buffer.from([packetType.login]),
            Buffer.from(password, 'ascii'),
          ]),
        );
      });
    });
  }

  #send(text: string): Promise<string> {
    const sequence = this.#sequence;
    this.#sequence = (sequence + 1) & 0xff;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => this.#fail(new ReplyMissing()),
        this.#options.commandTimeoutMs,
      );
      this.#pending = {
        kind: 'command',
        sequence,
        resolve,
        reject,
        timer,
        parts: new Map(),
        bytes: 0,
      };
      this.#lastSentAt = this.#options.now();
      this.#write(
        Buffer.concat([
          Buffer.from([packetType.command, sequence]),
          Buffer.from(text, 'utf8'),
        ]),
      );
    });
  }

  #write(payload: Buffer) {
    const socket = this.#socket;
    if (!socket) return;
    try {
      socket.send(battleyePacket(payload), (error) => {
        if (error) this.#socketFailed(socket);
      });
    } catch {
      this.#socketFailed(socket);
    }
  }

  #socketFailed(socket: Socket) {
    if (this.#socket !== socket) return;
    this.#fail(
      this.#pending?.kind === 'command'
        ? new ReplyMissing()
        : gameUnavailable(),
    );
  }

  #fail(error: unknown) {
    const pending = this.#pending;
    this.#pending = null;
    this.#disconnect();
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  #disconnect() {
    this.#connected = false;
    const pending = this.#pending;
    this.#pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(
        pending.kind === 'command' ? new ReplyMissing() : gameUnavailable(),
      );
    }
    const socket = this.#socket;
    this.#socket = null;
    if (!socket) return;
    socket.removeAllListeners('message');
    socket.on('error', () => undefined);
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }

  #receive(packet: Buffer) {
    const payload = battleyePayload(packet);
    if (!payload || payload.length < 2) return;
    const type = payload[0];
    if (type === packetType.login) this.#loginReply(payload);
    else if (type === packetType.message) this.#serverMessage(payload);
    else if (type === packetType.command) this.#commandReply(payload);
  }

  #loginReply(payload: Buffer) {
    const pending = this.#pending;
    if (pending?.kind !== 'login') return;
    if (payload.length !== 2 || payload[1]! > 1)
      return this.#fail(gameUnavailable());
    if (payload[1] === 0) return this.#fail(loginRejected());
    clearTimeout(pending.timer);
    this.#pending = null;
    this.#connected = true;
    lastLogin += 1;
    this.#epoch = lastLogin;
    this.#sequence = 0;
    this.#recent.clear();
    this.#lastSentAt = this.#options.now();
    this.#lastReceivedAt = this.#lastSentAt;
    pending.resolve(this.#epoch);
  }

  #serverMessage(payload: Buffer) {
    const sequence = payload[1]!;
    this.#write(Buffer.from([packetType.message, sequence]));
    if (!this.#connected) return;
    const body = payload.subarray(2);
    const prior = this.#recent.get(sequence);
    if (prior?.equals(body)) return;
    this.#recent.delete(sequence);
    this.#recent.set(sequence, Buffer.from(body));
    if (this.#recent.size > recentMessageWindow)
      this.#recent.delete(this.#recent.keys().next().value!);
    this.#options.onMessage?.(lenientUtf8.decode(body), this.#options.now());
  }

  #commandReply(payload: Buffer) {
    const pending = this.#pending;
    if (pending?.kind !== 'command' || payload[1] !== pending.sequence) return;
    const body = payload.subarray(2);
    let reply: Buffer;
    if (body.length > 0 && body[0] === 0) {
      if (body.length < 3) return this.#fail(new ReplyMissing());
      const count = body[1]!;
      const index = body[2]!;
      if (
        count === 0 ||
        count > maxParts ||
        index >= count ||
        (pending.count !== undefined && pending.count !== count)
      )
        return this.#fail(new ReplyMissing());
      pending.count = count;
      const part = body.subarray(3);
      const prior = pending.parts.get(index);
      if (prior) {
        if (!prior.equals(part)) this.#fail(new ReplyMissing());
        return;
      }
      pending.bytes += part.length;
      if (pending.bytes > maxReplyBytes) return this.#fail(new ReplyMissing());
      pending.parts.set(index, Buffer.from(part));
      if (pending.parts.size < count) return;
      reply = Buffer.concat(
        Array.from({ length: count }, (_, i) => pending.parts.get(i)!),
      );
    } else {
      if (pending.count !== undefined || body.length > maxReplyBytes)
        return this.#fail(new ReplyMissing());
      reply = body;
    }
    let text: string;
    try {
      text = utf8.decode(reply);
    } catch {
      return this.#fail(new ReplyMissing());
    }
    clearTimeout(pending.timer);
    this.#pending = null;
    this.#lastReceivedAt = this.#options.now();
    pending.resolve(text);
  }
}
