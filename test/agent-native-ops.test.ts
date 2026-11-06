import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  nativeEventFeedSchema,
  nativeIdentityFeedSchema,
  nativeOperationResultSchema,
} from '../protocol/agent-protocol';
import { parseAgentConfig } from '../src/config';
import {
  battleyeAddBan,
  battleyeKick,
  battleyeRemoveBan,
  battleyeSay,
} from '../src/games/battleye-commands';
import { squadBroadcast } from '../src/games/squad-commands';
import { createBattlEyeProfile } from '../src/profiles/battleye';
import type { ProfileHandler } from '../src/profiles/types';
import {
  agentResultBodyMaxBytes,
  battleyeOperation,
  parseNativeOperation,
  squadOperation,
  type AgentCommand,
} from '../src/protocol';
import {
  startBattlEyeFake,
  type BattlEyeFake,
} from './support/battleye-fake';

const secret = `wga_${'A'.repeat(43)}`;
const password = 'Fake-Rcon#Password9';
const guid = '0123456789abcdef0123456789abcdef';
const otherGuid = 'fedcba9876543210fedcba9876543210';
const steam = '76561190000000001';

function op(body: unknown): AgentCommand {
  return {
    id: randomUUID(),
    method: 'POST',
    path: '/native/v1/op',
    body: JSON.stringify(body),
    expiresAt: Date.now() + 20_000,
  };
}

function feed(path: string): AgentCommand {
  return {
    id: randomUUID(),
    method: 'GET',
    path,
    expiresAt: Date.now() + 20_000,
  };
}

/** Run one command. Every 2xx answer must parse with the shared protocol schema. */
async function call(handler: ProfileHandler, command: AgentCommand) {
  const response = await handler.handle(command);
  const body = JSON.parse(response.body.toString('utf8'));
  if (response.status === 200) {
    const path = command.path.split('?')[0];
    const schema =
      path === '/native/v1/op'
        ? nativeOperationResultSchema
        : path === '/native/v1/events'
          ? nativeEventFeedSchema
          : nativeIdentityFeedSchema;
    assert.deepEqual(schema.parse(body), body);
  }
  return { status: response.status, body };
}

async function withDirectory<T>(run: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'wg-agent-native-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const be = { profile: 'battleye' } as const;
const sq = { profile: 'squad-family' } as const;

void test('typed operations refuse raw command strings, unknown fields and the other profile', () => {
  for (const body of [
    { ...be, op: 'raw', command: '#shutdown' },
    { ...be, op: 'command', line: 'players' },
    { ...be, op: 'broadcast', message: 'hello', command: '#shutdown' },
    { ...be, op: 'players', line: '#shutdown' },
    { ...be, op: 'addBan', guid: 'not-a-guid', minutes: 10, reason: 'x' },
    { ...be, op: 'addBan', guid, minutes: 0, reason: 'x' },
    { ...be, op: 'kickIfGuid', player: 1, guid, reason: 'x', line: 'kick 1' },
    { op: 'players' },
    { ...sq, op: 'players' },
    '#shutdown',
  ])
    assert.equal(
      battleyeOperation.safeParse(body).success,
      false,
      JSON.stringify(body),
    );
  for (const body of [
    { ...sq, op: 'raw', command: 'AdminKill 1' },
    {
      ...sq,
      op: 'addBan',
      steamId: steam,
      days: 1,
      reason: 'x',
      raw: 'AdminBan',
    },
    { ...sq, op: 'addBan', steamId: '1234', days: 1, reason: 'x' },
    { ...be, op: 'players' },
  ])
    assert.equal(
      squadOperation.safeParse(body).success,
      false,
      JSON.stringify(body),
    );
  assert.equal(parseNativeOperation(battleyeOperation, 'not json'), null);
  assert.equal(
    parseNativeOperation(
      battleyeOperation,
      JSON.stringify({ ...be, op: 'broadcast', message: 'x'.repeat(5_000) }),
    ),
    null,
  );
});

void test('agent command builders write the game command lines and refuse injected text', () => {
  assert.equal(battleyeKick(3, 'Rule 1'), 'kick 3 Rule 1');
  assert.equal(battleyeSay(-1, 'Restart soon'), 'say -1 Restart soon');
  assert.equal(battleyeSay(7, 'Hello'), 'say 7 Hello');
  assert.equal(
    battleyeAddBan(guid, 60, 'Cheating'),
    `addBan ${guid} 60 Cheating`,
  );
  assert.equal(
    battleyeAddBan(guid, 'permanent', 'Cheating'),
    `addBan ${guid} 0 Cheating`,
  );
  assert.equal(battleyeRemoveBan(4), 'removeBan 4');
  assert.equal(squadBroadcast('Restart soon'), 'AdminBroadcast Restart soon');
  for (const text of [
    'line\nbreak',
    'nul\0byte',
    '   ',
    'bell\u0007',
    'x'.repeat(201),
  ])
    assert.throws(() => battleyeKick(1, text), /cannot be sent/);
  for (const text of [
    'a | AdminKill 1',
    'a; b',
    'quote"',
    'back\\slash',
    'tick`',
  ])
    assert.throws(() => squadBroadcast(text), /cannot be sent/);
  assert.throws(() => battleyeAddBan(guid, 0, 'x'));
});

async function battleyeServer(
  fake: BattlEyeFake,
  directory: string,
  game: 'arma3' | 'dayz' = 'arma3',
  probeAfterMs?: number,
): Promise<ProfileHandler> {
  const battleye = join(directory, 'battleye');
  await mkdir(battleye, { recursive: true });
  await writeFile(
    join(battleye, 'BEServer_x64_active_1a2b.cfg'),
    `RConPassword ${password}\r\nRConPort ${fake.port}\r\nRConIP 127.0.0.1\r\n`,
  );
  const config = parseAgentConfig({
    panel: 'https://panel.example.test',
    servers: [
      {
        serverId: 'arma-one',
        secret,
        profile: 'battleye',
        game,
        battleyeConfig: battleye,
      },
    ],
  });
  return createBattlEyeProfile(config.servers[0] as never, {
    session: { commandTimeoutMs: 1_000 },
    reconnectMs: 60_000,
    ...(probeAfterMs === undefined ? {} : { probeAfterMs }),
  });
}

void test('BattlEye operations check the player and send in one agent login', async () => {
  const fake = await startBattlEyeFake({
    password,
    players: [
      {
        number: 3,
        address: '198.51.100.7:2304',
        ping: 40,
        guid,
        name: 'Fake Player',
      },
      {
        number: 4,
        address: '198.51.100.8:2304',
        ping: 41,
        guid: otherGuid,
        verified: false,
        name: 'Unverified',
      },
    ],
    bans: [
      { kind: 'guid', value: guid, minutes: 30, reason: 'First' },
      { kind: 'guid', value: guid, minutes: 'perm', reason: 'Second' },
    ],
  });
  try {
    await withDirectory(async (directory) => {
      const handler = await battleyeServer(fake, directory);
      try {
        const players = await call(handler, op({ ...be, op: 'players' }));
        assert.equal(players.status, 200);
        assert.equal(players.body.outcome, 'read');
        assert.match(players.body.reply, /Fake Player/);
        assert.ok(Number.isSafeInteger(players.body.observedAt));
        const bans = await call(handler, op({ ...be, op: 'bans' }));
        assert.match(bans.body.reply, /GUID Bans:/);

        const changed = await call(
          handler,
          op({
            ...be,
            op: 'kickIfGuid',
            player: 3,
            guid: otherGuid,
            reason: 'Rule 1',
          }),
        );
        assert.deepEqual(changed.body, { outcome: 'target-changed' });
        const unverified = await call(
          handler,
          op({
            ...be,
            op: 'sayIfGuid',
            player: 4,
            guid: otherGuid,
            message: 'Hello',
          }),
        );
        assert.deepEqual(unverified.body, { outcome: 'target-changed' });
        assert.deepEqual(
          fake.adminCommands(),
          [],
          'a refused check sends nothing',
        );

        const kicked = await call(
          handler,
          op({ ...be, op: 'kickIfGuid', player: 3, guid, reason: 'Rule 1' }),
        );
        assert.deepEqual(kicked.body, { outcome: 'sent', reply: '' });
        const banned = await call(
          handler,
          op({
            ...be,
            op: 'addBan',
            guid: otherGuid,
            minutes: 'permanent',
            reason: 'Cheating',
          }),
        );
        assert.equal(banned.body.outcome, 'sent');
        const removed = await call(
          handler,
          op({ ...be, op: 'removeBanForGuid', guid }),
        );
        assert.equal(removed.body.outcome, 'sent');
        const absent = await call(
          handler,
          op({
            ...be,
            op: 'removeBanForGuid',
            guid: 'abcdefabcdefabcdefabcdefabcdefab',
          }),
        );
        assert.deepEqual(absent.body, { outcome: 'not-found' });
        const broadcast = await call(
          handler,
          op({ ...be, op: 'broadcast', message: 'Restart soon' }),
        );
        assert.equal(broadcast.body.outcome, 'sent', JSON.stringify(broadcast));

        assert.deepEqual(fake.adminCommands(), [
          'kick 3 Rule 1',
          `addBan ${otherGuid} 0 Cheating`,
          'removeBan 1',
          'say -1 Restart soon',
        ]);
        assert.equal(fake.logins(), 1, 'one login serves every operation');
        assert.ok(
          fake.commands.every((command) => !command.text.startsWith('#')),
        );

        const raw = await call(
          handler,
          op({ ...be, op: 'raw', command: '#shutdown' }),
        );
        assert.deepEqual(
          [raw.status, raw.body.error],
          [400, 'invalid-operation'],
        );
        const other = await call(handler, op({ ...sq, op: 'players' }));
        assert.equal(other.status, 400);
        const route = await call(handler, feed('/v1/status'));
        assert.equal(route.status, 400);
      } finally {
        await handler.close();
      }
    });
  } finally {
    await fake.close();
  }
});

void test('after a game restart, reads and player checks log in again once and the write is sent once', async () => {
  const fake = await startBattlEyeFake({
    password,
    players: [
      {
        number: 3,
        address: '198.51.100.7:2304',
        ping: 40,
        guid,
        name: 'Fake Player',
      },
    ],
  });
  try {
    await withDirectory(async (directory) => {
      const handler = await battleyeServer(fake, directory);
      try {
        assert.equal(
          (await call(handler, op({ ...be, op: 'players' }))).body.outcome,
          'read',
        );
        // The restarted game no longer knows the login, so it ignores it.
        fake.forgetClients();
        const players = await call(handler, op({ ...be, op: 'players' }));
        assert.equal(players.body.outcome, 'read');
        assert.equal(fake.logins(), 2);
        fake.forgetClients();
        const kicked = await call(
          handler,
          op({ ...be, op: 'kickIfGuid', player: 3, guid, reason: 'Rule 1' }),
        );
        assert.deepEqual(kicked.body, { outcome: 'sent', reply: '' });
        assert.equal(fake.logins(), 3);
        assert.deepEqual(fake.adminCommands(), ['kick 3 Rule 1']);
      } finally {
        await handler.close();
      }
      // A write with no read first checks a quiet login with the keep-alive.
      const probing = await battleyeServer(fake, directory, 'arma3', 0);
      try {
        await call(probing, op({ ...be, op: 'players' }));
        fake.forgetClients();
        const broadcast = await call(
          probing,
          op({ ...be, op: 'broadcast', message: 'Back online' }),
        );
        assert.equal(broadcast.body.outcome, 'sent', JSON.stringify(broadcast));
        assert.deepEqual(
          fake.adminCommands().filter((line) => line.startsWith('say')),
          ['say -1 Back online'],
        );
      } finally {
        await probing.close();
      }
    });
  } finally {
    await fake.close();
  }
});

void test('a BattlEye command without a reply reports reply-missing and is not sent again', async () => {
  const fake = await startBattlEyeFake({ password, players: [] });
  try {
    await withDirectory(async (directory) => {
      const handler = await battleyeServer(fake, directory);
      try {
        await call(handler, op({ ...be, op: 'players' }));
        fake.state.override = (command) =>
          command.text.startsWith('say') ? [] : undefined;
        const silent = await call(
          handler,
          op({ ...be, op: 'broadcast', message: 'Hello' }),
        );
        assert.deepEqual(
          [silent.status, silent.body.error],
          [504, 'reply-missing'],
        );
        assert.equal(
          fake.adminCommands().filter((line) => line.startsWith('say')).length,
          1,
        );
      } finally {
        await handler.close();
      }
    });
  } finally {
    await fake.close();
  }
});

void test('BattlEye server messages are buffered and read by cursor', async () => {
  const fake = await startBattlEyeFake({ password, players: [] });
  try {
    await withDirectory(async (directory) => {
      const handler = await battleyeServer(fake, directory, 'dayz');
      try {
        handler.start();
        const until = Date.now() + 3_000;
        while (fake.logins() < 1 && Date.now() < until) await delay(10);
        fake.pushMessage('(Global) Fake Player: hello');
        fake.pushMessage('Player #0 Fake Player (198.51.100.7:2304) connected');
        let page = await call(handler, feed('/native/v1/events'));
        while (page.body.lines.length < 2 && Date.now() < until) {
          await delay(10);
          page = await call(handler, feed('/native/v1/events'));
        }
        assert.deepEqual(
          page.body.lines.map((line: { text: string }) => line.text),
          [
            '(Global) Fake Player: hello',
            'Player #0 Fake Player (198.51.100.7:2304) connected',
          ],
        );
        assert.match(page.body.cursor, /^[A-Za-z0-9_-]{1,64}$/);
        assert.equal(page.body.dropped, 0);
        const next = await call(
          handler,
          feed(`/native/v1/events?cursor=${page.body.cursor}`),
        );
        assert.deepEqual(next.body.lines, []);
        assert.equal(next.body.cursor, page.body.cursor);
        const other = await call(
          handler,
          feed('/native/v1/events?cursor=AAAAAAAAAAAAAAAA1'),
        );
        assert.equal(
          other.body.lines.length,
          2,
          'a cursor from another process starts at the oldest line',
        );
        const identity = await call(handler, feed('/native/v1/identity'));
        assert.deepEqual(identity.body.entries, []);
      } finally {
        await handler.close();
      }
    });
  } finally {
    await fake.close();
  }
});

void test('a flood of control characters keeps every event page under the result limit', async () => {
  const fake = await startBattlEyeFake({ password, players: [] });
  try {
    await withDirectory(async (directory) => {
      const handler = await battleyeServer(fake, directory, 'dayz');
      try {
        handler.start();
        const until = Date.now() + 20_000;
        while (fake.logins() < 1 && Date.now() < until) await delay(10);
        // U+0001 takes six bytes in JSON and U+0085 two in UTF-8, so a page
        // sized by string length exceeds 1 MiB.
        const flood = 'x\u0001\u0085'.repeat(1_365);
        const count = 100;
        // A few datagrams at a time, so none is lost on the loopback socket.
        for (let index = 0; index < count; index += 1) {
          fake.pushMessage(`${index} ${flood}`);
          if (index % 4 === 3) await delay(15);
        }
        let page = await call(handler, feed('/native/v1/events'));
        let response = await handler.handle(feed('/native/v1/events'));
        while (page.body.lines.length < count && Date.now() < until) {
          await delay(20);
          response = await handler.handle(feed('/native/v1/events'));
          page = {
            status: response.status,
            body: JSON.parse(String(response.body)),
          };
        }
        assert.equal(page.body.lines.length, count);
        assert.equal(response.status, 200);
        assert.ok(
          response.body.length <= agentResultBodyMaxBytes,
          `${response.body.length} bytes`,
        );
        assert.ok(page.body.lines.length > 0);
        for (const line of page.body.lines as { text: string }[]) {
          // Only the digits, the space and the x characters are left.
          assert.match(line.text, /^\d+ x+$/);
        }
        // The pages together hold every line, and each page fits.
        let cursor = '';
        let total = 0;
        for (let pages = 0; pages < 20 && total < count; pages += 1) {
          const next = await handler.handle(
            feed(`/native/v1/events${cursor ? `?cursor=${cursor}` : ''}`),
          );
          assert.ok(next.body.length <= agentResultBodyMaxBytes);
          const body = JSON.parse(String(next.body));
          total += body.lines.length;
          cursor = body.cursor;
          if (!body.lines.length) break;
        }
        assert.equal(total, count);
      } finally {
        await handler.close();
      }
    });
  } finally {
    await fake.close();
  }
});

void test('a wrong or missing BattlEye password reports a fixed error without the password', async () => {
  const fake = await startBattlEyeFake({ password: 'Another-Password#1' });
  try {
    await withDirectory(async (directory) => {
      const handler = await battleyeServer(fake, directory);
      try {
        const response = await call(handler, op({ ...be, op: 'players' }));
        assert.deepEqual(
          [response.status, response.body.error],
          [502, 'login-rejected'],
        );
        assert.ok(!JSON.stringify(response.body).includes(password));
        assert.deepEqual(handler.secrets(), [password]);
      } finally {
        await handler.close();
      }
      const missing = createBattlEyeProfile(
        parseAgentConfig({
          panel: 'https://panel.example.test',
          servers: [
            {
              serverId: 'arma-two',
              secret,
              profile: 'battleye',
              game: 'arma3',
            },
          ],
        }).servers[0] as never,
      );
      const response = await call(missing, op({ ...be, op: 'players' }));
      assert.deepEqual(
        [response.status, response.body.error],
        [503, 'not-configured'],
      );
      await missing.close();
    });
  } finally {
    await fake.close();
  }
});
