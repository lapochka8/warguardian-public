import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { AgentError } from '../errors';
import {
  ReplyMissing,
  gameUnavailable,
  loginRejected,
} from './battleye-session';

/**
 * Source RCON over TCP with the Squad family dialect, following the Valve
 * Developer Community protocol description. A packet is a little-endian
 * int32 size, an int32 ID, an int32 type, a body and two NUL bytes.
 *
 * Squad dialect:
 * - each command is followed by an empty response packet with a second ID,
 *   and the reply ends at the first packet carrying that ID;
 * - Squad answers the empty packet twice, the second time with a size field
 *   7 bytes shorter than the packet;
 * - chat and admin events arrive as packets of type 1.
 */

export const sourceRconPacketType = Object.freeze({
  auth: 3,
  authResponse: 2,
  execCommand: 2,
  responseValue: 0,
  squadEvent: 1,
} as const);

const headerBytes = 8;
const minimumPacketSize = 10;
const maximumRequestSize = 4096;
const highestRequestId = 2_147_483_646;
const recentMarkerLimit = 8;
const squadMarkerTail = Buffer.from([0, 1, 0, 0, 0, 0, 0]);

export type SourceRconPacket = {
  id: number;
  type: number;
  body: Buffer;
  wellFormed: boolean;
};

export function encodeSourceRconPacket(
  id: number,
  type: number,
  body: string,
): Buffer {
  const bytes = Buffer.from(body, 'utf8');
  if (bytes.includes(0))
    throw new RangeError('A Source RCON body cannot contain a NUL byte.');
  const size = headerBytes + bytes.length + 2;
  if (size > maximumRequestSize)
    throw new RangeError('The Source RCON packet is too large.');
  const packet = Buffer.alloc(4 + size);
  packet.writeInt32LE(size, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  bytes.copy(packet, 12);
  return packet;
}

export class SourceRconProtocolError extends Error {
  constructor() {
    super('The game server broke the RCON framing.');
    this.name = 'SourceRconProtocolError';
  }
}

/** Split a TCP stream into packets, reading Squad's short second marker answer. */
export class SourceRconDecoder {
  readonly #maxPacketSize: number;
  #held: Buffer = Buffer.alloc(0);
  #broken = false;
  #emptyIds: number[] = [];

  constructor(maxPacketSize: number) {
    this.#maxPacketSize = maxPacketSize;
  }

  push(chunk: Uint8Array): SourceRconPacket[] {
    if (this.#broken) throw new SourceRconProtocolError();
    const bytes = this.#held.length
      ? Buffer.concat([this.#held, chunk])
      : Buffer.from(chunk);
    const packets: SourceRconPacket[] = [];
    let offset = 0;
    while (bytes.length - offset >= 4) {
      const size = bytes.readInt32LE(offset);
      if (size < minimumPacketSize || size > this.#maxPacketSize) {
        this.#broken = true;
        this.#held = Buffer.alloc(0);
        throw new SourceRconProtocolError();
      }
      if (bytes.length - offset - 4 < size) break;
      const start = offset + 4;
      const id = bytes.readInt32LE(start);
      const type = bytes.readInt32LE(start + 4);
      const payload = bytes.subarray(start + headerBytes, start + size);
      const terminated =
        payload[payload.length - 1] === 0 && payload[payload.length - 2] === 0;
      const empty =
        terminated &&
        size === minimumPacketSize &&
        type === sourceRconPacketType.responseValue;
      if (empty && this.#emptyIds.includes(id)) {
        const available = Math.min(
          bytes.length - start - size,
          squadMarkerTail.length,
        );
        const tail = bytes.subarray(start + size, start + size + available);
        if (tail.equals(squadMarkerTail.subarray(0, available))) {
          if (available < squadMarkerTail.length) break;
          this.#emptyIds = this.#emptyIds.filter((seen) => seen !== id);
          packets.push({ id, type, body: Buffer.alloc(0), wellFormed: false });
          offset = start + size + squadMarkerTail.length;
          continue;
        }
      }
      if (empty) {
        this.#emptyIds.push(id);
        if (this.#emptyIds.length > recentMarkerLimit) this.#emptyIds.shift();
      }
      let end = payload.length;
      if (terminated) end -= 2;
      else while (end > 0 && payload[end - 1] === 0) end -= 1;
      const body = Buffer.from(payload.subarray(0, end));
      packets.push({
        id,
        type,
        body,
        wellFormed: terminated && !body.includes(0),
      });
      offset = start + size;
    }
    this.#held = Buffer.from(bytes.subarray(offset));
    return packets;
  }
}

export type SourceRconEndpoint = {
  host: string;
  port: number;
  password: string;
};

export type SourceRconSessionOptions = {
  endpoint: () => Promise<SourceRconEndpoint>;
  onMessage?: (text: string, at: number) => void;
  authTimeoutMs?: number;
  commandTimeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
};

type PendingCommand = {
  replyId: number;
  markerId: number;
  parts: Buffer[];
  bytes: number;
  timer: NodeJS.Timeout;
  resolve(text: string): void;
  reject(error: Error): void;
};

/** True for printable text without control characters, within one packet. */
function commandText(text: string): boolean {
  if (typeof text !== 'string' || !text.trim()) return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return (
    Buffer.byteLength(text, 'utf8') <=
    maximumRequestSize - minimumPacketSize - 4
  );
}

/**
 * One authenticated connection that sends one command at a time. A dropped
 * connection is reopened on the next command with a new epoch. A command in
 * flight when the connection drops is never resent.
 */
export class SourceRconSession {
  /** Random per session object, so references from another process never match. */
  readonly key = randomBytes(12).toString('base64url');
  readonly #options: Required<Omit<SourceRconSessionOptions, 'onMessage'>> &
    Pick<SourceRconSessionOptions, 'onMessage'>;
  #socket: Socket | undefined;
  #epoch = 0;
  #closed = false;
  #tail: Promise<unknown> = Promise.resolve();
  #pending: PendingCommand | undefined;
  #markers: number[] = [];
  #lastId = 0;

  constructor(options: SourceRconSessionOptions) {
    this.#options = {
      authTimeoutMs: 5_000,
      commandTimeoutMs: 10_000,
      maxResponseBytes: 1024 * 1024,
      now: Date.now,
      ...options,
    };
  }

  get epoch(): number {
    return this.#epoch;
  }

  get connected(): boolean {
    return !!this.#socket;
  }

  /** Run reads and a write in one connection without another caller in between. */
  exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(() => {
      if (this.#closed) throw gameUnavailable();
      return run();
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Open the connection when needed and return its epoch. Use inside `exclusive`. */
  async connectInSession(): Promise<number> {
    if (this.#closed) throw gameUnavailable();
    if (!this.#socket) await this.#dial();
    return this.#epoch;
  }

  /** Send one command in this epoch. Use inside `exclusive`. */
  async commandInSession(text: string, epoch: number): Promise<string> {
    if (!commandText(text))
      throw new AgentError(
        400,
        'invalid-operation',
        'The command line is invalid.',
      );
    const socket = this.#socket;
    if (!socket || this.#epoch !== epoch) throw gameUnavailable();
    return this.#exchange(socket, text);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#socket) this.#drop(this.#socket);
  }

  #takeId(): number {
    this.#lastId = this.#lastId >= highestRequestId ? 1 : this.#lastId + 1;
    return this.#lastId;
  }

  async #dial(): Promise<void> {
    const { host, port, password } = await this.#options.endpoint();
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host, port, family: 4, noDelay: true });
      const decoder = new SourceRconDecoder(
        Math.max(
          maximumRequestSize,
          this.#options.maxResponseBytes + minimumPacketSize,
        ),
      );
      const authId = this.#takeId();
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const onData = (chunk: Buffer) => {
        let packets: SourceRconPacket[];
        try {
          packets = decoder.push(chunk);
        } catch {
          return fail(gameUnavailable());
        }
        for (let index = 0; index < packets.length; index += 1) {
          const packet = packets[index]!;
          if (packet.type !== sourceRconPacketType.authResponse) continue;
          if (packet.id === -1) return fail(loginRejected());
          if (packet.id !== authId) continue;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.off('data', onData);
          this.#attach(socket, decoder);
          for (const later of packets.slice(index + 1))
            if (!this.#accept(socket, later)) break;
          resolve();
          return;
        }
      };
      const timer = setTimeout(
        () => fail(gameUnavailable()),
        this.#options.authTimeoutMs,
      );
      socket.on('error', () => undefined);
      socket.on('data', onData);
      // Squad closes the socket without a reply after a wrong password.
      socket.once('close', () => fail(gameUnavailable()));
      socket.once('connect', () => {
        socket.write(
          encodeSourceRconPacket(authId, sourceRconPacketType.auth, password),
        );
      });
    });
  }

  #attach(socket: Socket, decoder: SourceRconDecoder) {
    if (this.#closed) {
      socket.destroy();
      return;
    }
    this.#socket = socket;
    this.#epoch += 1;
    this.#markers = [];
    socket.on('data', (chunk: Buffer) => {
      if (socket !== this.#socket) return;
      let packets: SourceRconPacket[];
      try {
        packets = decoder.push(chunk);
      } catch {
        this.#drop(socket);
        return;
      }
      for (const packet of packets) if (!this.#accept(socket, packet)) return;
    });
    socket.once('close', () => this.#drop(socket));
  }

  #accept(socket: Socket, packet: SourceRconPacket): boolean {
    if (socket !== this.#socket) return false;
    if (packet.type === sourceRconPacketType.squadEvent) {
      this.#options.onMessage?.(
        packet.body.toString('utf8'),
        this.#options.now(),
      );
      return true;
    }
    const pending = this.#pending;
    if (pending && packet.id === pending.markerId) {
      this.#finish(pending);
      return true;
    }
    if (this.#markers.includes(packet.id)) return true;
    if (!packet.wellFormed) {
      this.#drop(socket);
      return false;
    }
    if (
      pending &&
      packet.id === pending.replyId &&
      packet.type === sourceRconPacketType.responseValue
    ) {
      pending.bytes += packet.body.length;
      if (pending.bytes > this.#options.maxResponseBytes) {
        this.#drop(socket);
        return false;
      }
      pending.parts.push(packet.body);
    }
    return true;
  }

  #exchange(socket: Socket, text: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const replyId = this.#takeId();
      const markerId = this.#takeId();
      this.#pending = {
        replyId,
        markerId,
        parts: [],
        bytes: 0,
        resolve,
        reject,
        timer: setTimeout(
          () => this.#drop(socket),
          this.#options.commandTimeoutMs,
        ),
      };
      socket.write(
        Buffer.concat([
          encodeSourceRconPacket(
            replyId,
            sourceRconPacketType.execCommand,
            text,
          ),
          encodeSourceRconPacket(
            markerId,
            sourceRconPacketType.responseValue,
            '',
          ),
        ]),
      );
    });
  }

  #finish(pending: PendingCommand) {
    this.#pending = undefined;
    clearTimeout(pending.timer);
    this.#markers.push(pending.markerId);
    if (this.#markers.length > recentMarkerLimit) this.#markers.shift();
    try {
      pending.resolve(
        new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.concat(pending.parts),
        ),
      );
    } catch {
      pending.reject(new ReplyMissing());
    }
  }

  #drop(socket: Socket) {
    if (socket !== this.#socket) return;
    this.#socket = undefined;
    socket.destroy();
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new ReplyMissing());
    }
  }
}
