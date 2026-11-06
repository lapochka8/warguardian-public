import { createSocket, type RemoteInfo } from 'node:dgram';
import { once } from 'node:events';
import { crc32 } from 'node:zlib';

/**
 * An original in-process BattlEye RCon server for tests. It frames packets
 * with zlib's CRC-32, so it shares no code with the client under test. It
 * keeps a player list, a ban list and a mission list, and it changes them
 * when it receives kick, addBan and removeBan.
 */

export function fakeBattlEyePacket(payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([0xff]), payload]);
  const header = Buffer.alloc(6);
  header.write('BE');
  header.writeUInt32LE(crc32(body), 2);
  return Buffer.concat([header, body]);
}

function fakePayload(packet: Buffer): Buffer | null {
  if (packet.length < 8 || packet.toString('latin1', 0, 2) !== 'BE')
    return null;
  if (packet[6] !== 0xff) return null;
  if (packet.readUInt32LE(2) !== crc32(packet.subarray(6))) return null;
  return packet.subarray(7);
}

export type FakePlayer = {
  number: number;
  address: string;
  ping: number;
  /** Null shows `-` in the GUID column. */
  guid: string | null;
  /** False shows `(?)` after the GUID. Default true. */
  verified?: boolean;
  name: string;
  lobby?: boolean;
};

export type FakeBan = {
  kind: 'guid' | 'ip';
  value: string;
  minutes: number | 'perm' | '-';
  reason: string;
};

export type FakeCommand = { sequence: number; text: string };

export type FakeReplyPlan = {
  /** Split replies longer than this many bytes into parts. */
  partBytes: number;
  order: 'forward' | 'reverse' | 'repeat-first';
};

/**
 * Replace the default reply. Return the payloads to send, an empty array to
 * stay silent, or undefined for the default.
 */
export type FakeOverride = (command: FakeCommand) => Buffer[] | undefined;

export type BattlEyeFakeOptions = {
  password: string;
  /** False makes the server ignore every packet, like RCon turned off. */
  rconEnabled?: boolean;
  players?: FakePlayer[];
  bans?: FakeBan[];
  missions?: string[];
  parts?: FakeReplyPlan;
};

const adminCommand =
  /^(?:(?:kick|ban|addBan|removeBan|say|writeBans|loadBans)(?: |$)|#)/;

export function formatFakePlayers(players: readonly FakePlayer[]): string {
  const rows = players.map((player) => {
    const guid =
      player.guid === null
        ? '-'
        : `${player.guid}(${player.verified === false ? '?' : 'OK'})`;
    const name = player.lobby ? `${player.name} (Lobby)` : player.name;
    return `${String(player.number).padEnd(4)}${player.address.padEnd(22)}${String(player.ping).padEnd(5)}${guid} ${name}`;
  });
  return [
    'Players on server:',
    '[#] [IP Address]:[Port] [Ping] [GUID] [Name]',
    '--------------------------------------------------',
    ...rows,
    `(${players.length} players in total)`,
  ].join('\n');
}

export function formatFakeBans(bans: readonly FakeBan[]): string {
  const ordered = [
    ...bans.filter((ban) => ban.kind === 'guid'),
    ...bans.filter((ban) => ban.kind === 'ip'),
  ];
  const row = (ban: FakeBan) =>
    `${String(ordered.indexOf(ban)).padEnd(4)}${ban.value.padEnd(34)}${String(ban.minutes).padEnd(6)}${ban.reason}`;
  return [
    'GUID Bans:',
    '[#] [GUID] [Minutes left] [Reason]',
    '----------------------------------------',
    ...ordered.filter((ban) => ban.kind === 'guid').map(row),
    '',
    'IP Bans:',
    '[#] [IP Address] [Minutes left] [Reason]',
    '----------------------------------------------',
    ...ordered.filter((ban) => ban.kind === 'ip').map(row),
  ].join('\n');
}

export async function startBattlEyeFake(options: BattlEyeFakeOptions) {
  const socket = createSocket('udp4');
  const state = {
    rconEnabled: options.rconEnabled ?? true,
    players: [...(options.players ?? [])],
    bans: [...(options.bans ?? [])],
    missions: [...(options.missions ?? [])],
    parts: options.parts,
    override: undefined as FakeOverride | undefined,
  };
  const clients = new Map<string, { peer: RemoteInfo; nextMessage: number }>();
  const commands: FakeCommand[] = [];
  const ignored: FakeCommand[] = [];
  const acks: number[] = [];
  const resends = new Map<string, ReturnType<typeof setInterval>>();
  let logins = 0;
  let rejectedLogins = 0;

  const key = (peer: RemoteInfo) => `${peer.address}:${peer.port}`;
  function sendTo(peer: RemoteInfo, payload: Buffer, corrupt = false) {
    const packet = fakeBattlEyePacket(payload);
    if (corrupt) packet[2] ^= 0xff;
    socket.send(packet, peer.port, peer.address);
  }

  function reorder<T>(items: T[], order: FakeReplyPlan['order']): T[] {
    if (order === 'reverse') return [...items].reverse();
    if (order === 'repeat-first') return [items[0]!, ...items, items[0]!];
    return items;
  }

  function replyPayloads(sequence: number, text: string): Buffer[] {
    const body = Buffer.from(text, 'utf8');
    const plan = state.parts;
    if (!plan || body.length <= plan.partBytes)
      return [Buffer.concat([Buffer.from([1, sequence]), body])];
    const chunks: Buffer[] = [];
    for (let at = 0; at < body.length; at += plan.partBytes)
      chunks.push(body.subarray(at, at + plan.partBytes));
    const payloads = chunks.map((chunk, index) =>
      Buffer.concat([
        Buffer.from([1, sequence, 0, chunks.length, index]),
        chunk,
      ]),
    );
    return reorder(payloads, plan.order);
  }

  function pushToAll(text: string, copies = 1) {
    for (const client of clients.values()) {
      const sequence = client.nextMessage;
      client.nextMessage = (sequence + 1) & 0xff;
      deliver(client.peer, sequence, text, copies);
    }
  }

  /** Send a server message and repeat it until the client acknowledges it. */
  function deliver(
    peer: RemoteInfo,
    sequence: number,
    text: string,
    copies: number,
    resendMs = 40,
    maxSends = 5,
  ) {
    const payload = Buffer.concat([
      Buffer.from([2, sequence]),
      Buffer.from(text, 'utf8'),
    ]);
    for (let copy = 0; copy < copies; copy += 1) sendTo(peer, payload);
    const id = `${key(peer)}#${sequence}`;
    clearInterval(resends.get(id));
    let sends = copies;
    const timer = setInterval(() => {
      if (sends >= maxSends) {
        clearInterval(timer);
        resends.delete(id);
        return;
      }
      sends += 1;
      sendTo(peer, payload);
    }, resendMs);
    resends.set(id, timer);
  }

  function run(command: FakeCommand): string {
    const [verb = '', ...rest] = command.text.split(' ');
    if (command.text === '') return '';
    if (verb === 'players') return formatFakePlayers(state.players);
    if (verb === 'bans') return formatFakeBans(state.bans);
    if (verb === 'missions')
      return ['Missions on server:', ...state.missions].join('\n');
    if (verb === 'kick') {
      const number = Number(rest[0]);
      const player = state.players.find((entry) => entry.number === number);
      if (player) {
        state.players = state.players.filter((entry) => entry !== player);
        pushToAll(
          `Player #${number} ${player.name} has been kicked by BattlEye: Admin Kick (${rest.slice(1).join(' ')})`,
        );
      }
      return '';
    }
    if (verb === 'addBan') {
      const [guid = '', minutes = '0', ...reason] = rest;
      state.bans.push({
        kind: 'guid',
        value: guid,
        minutes: minutes === '0' ? 'perm' : Number(minutes),
        reason: reason.join(' '),
      });
      return '';
    }
    if (verb === 'removeBan') {
      const ordered = [
        ...state.bans.filter((ban) => ban.kind === 'guid'),
        ...state.bans.filter((ban) => ban.kind === 'ip'),
      ];
      const target = ordered[Number(rest[0])];
      state.bans = state.bans.filter((ban) => ban !== target);
      return '';
    }
    if (verb === 'say') {
      if (rest[0] === '-1')
        pushToAll(`RCon admin #0: (Global) ${rest.slice(1).join(' ')}`);
      return '';
    }
    return 'Unknown command';
  }

  socket.on('message', (packet, peer) => {
    if (!state.rconEnabled) return;
    const payload = fakePayload(packet);
    if (!payload || payload.length < 1) return;
    const type = payload[0];
    if (type === 0) {
      const password = payload.subarray(1).toString('latin1');
      if (password === options.password) {
        logins += 1;
        clients.set(key(peer), { peer, nextMessage: 0 });
        sendTo(peer, Buffer.from([0, 1]));
      } else {
        rejectedLogins += 1;
        clients.delete(key(peer));
        sendTo(peer, Buffer.from([0, 0]));
      }
      return;
    }
    if (payload.length < 2) return;
    // The server ignores packets from a client that is not logged in.
    if (!clients.has(key(peer))) {
      if (type === 1)
        ignored.push({
          sequence: payload[1]!,
          text: payload.subarray(2).toString('utf8'),
        });
      return;
    }
    if (type === 2) {
      acks.push(payload[1]!);
      const id = `${key(peer)}#${payload[1]}`;
      clearInterval(resends.get(id));
      resends.delete(id);
      return;
    }
    if (type !== 1) return;
    const command: FakeCommand = {
      sequence: payload[1]!,
      text: payload.subarray(2).toString('utf8'),
    };
    commands.push(command);
    const replaced = state.override?.(command);
    const payloads = replaced ?? replyPayloads(command.sequence, run(command));
    for (const reply of payloads) sendTo(peer, reply);
  });

  socket.bind(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();

  return {
    host: '127.0.0.1',
    port,
    state,
    /** Every command packet, keep-alives included as empty text. */
    commands,
    /** Command packets from clients that are not logged in. */
    ignored,
    /** Administrative commands only. Reads and keep-alives do not count. */
    adminCommands: () =>
      commands
        .map((command) => command.text)
        .filter((text) => adminCommand.test(text)),
    acks,
    logins: () => logins,
    rejectedLogins: () => rejectedLogins,
    /** Server messages for every client, each sent `copies` times at first. */
    pushMessage: pushToAll,
    /** Send a raw payload to every client, optionally with a broken CRC. */
    sendRaw(payload: Buffer, corrupt = false) {
      for (const client of clients.values())
        sendTo(client.peer, payload, corrupt);
    },
    /** Forget every login, like a server restart. */
    forgetClients() {
      clients.clear();
    },
    async close() {
      for (const timer of resends.values()) clearInterval(timer);
      resends.clear();
      socket.close();
      await once(socket, 'close');
    },
  };
}

export type BattlEyeFake = Awaited<ReturnType<typeof startBattlEyeFake>>;
