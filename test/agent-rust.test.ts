import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentConfig } from '../src/config';
import {
  rustBanId,
  rustBanListed,
  rustKick,
  rustPlayerState,
  rustSay,
  rustToolLines,
  rustUnban,
} from '../src/games/rust-commands';
import {
  createRustProfile,
  rustConfigValue,
  rustFeedLine,
} from '../src/profiles/rust';
import {
  nativeEventFeed,
  nativeFeedLineMaxChars,
  nativeOperationResult,
  parseNativeOperation,
  rustOperation,
  type AgentCommand,
} from '../src/protocol';

const secret = `wga_${'A'.repeat(43)}`;
const password = 'Fake-Rcon+Password9';
const steam = '76561198000000011';
const other = '76561198000000012';

type Listener = (event: { data?: unknown }) => void;

/** A Rust server behind one in-process socket. It answers from a table. */
function fakeServer(replies: Record<string, string | null> = {}) {
  const lines: string[] = [];
  const urls: string[] = [];
  let players: { SteamID: string; DisplayName: string }[] = [];
  let push: ((message: object) => void) | undefined;
  const connect = (url: string) => {
    urls.push(url);
    const listeners: Record<string, Listener[]> = {};
    const emit = (type: string, event: { data?: unknown } = {}) =>
      (listeners[type] ?? []).forEach((listener) => listener(event));
    const socket = {
      readyState: 0,
      send(data: string) {
        const request = JSON.parse(data) as {
          Identifier: number;
          Message: string;
        };
        lines.push(request.Message);
        const line = request.Message;
        const reply =
          line in replies
            ? replies[line]
            : line === 'playerlist'
              ? JSON.stringify(players)
              : line === 'version'
                ? 'Protocol: 1'
                : line.startsWith('kick ')
                  ? `Kicked: ${players.find((player) => line.includes(player.SteamID))?.DisplayName ?? ''}`
                  : '';
        if (reply === null || reply === undefined) return;
        queueMicrotask(() =>
          emit('message', {
            data: JSON.stringify({
              Identifier: request.Identifier,
              Message: reply,
              Type: 'Generic',
            }),
          }),
        );
      },
      close() {
        socket.readyState = 3;
        emit('close');
      },
      addEventListener(type: string, listener: Listener) {
        (listeners[type] ??= []).push(listener);
      },
    };
    push = (message) => emit('message', { data: JSON.stringify(message) });
    queueMicrotask(() => {
      socket.readyState = 1;
      emit('open');
    });
    return socket;
  };
  return {
    connect,
    lines,
    urls,
    setPlayers: (next: typeof players) => (players = next),
    push: (message: object) => push?.(message),
    sent: (start: string) => lines.filter((line) => line.startsWith(start)),
  };
}

function profileFor(server: ReturnType<typeof fakeServer>) {
  const config = parseAgentConfig({
    panel: 'https://panel.example.test',
    servers: [
      {
        serverId: 'island',
        secret,
        profile: 'rust',
        game: 'rust',
        rconPort: 28016,
        rconPassword: password,
      },
    ],
  });
  const entry = config.servers[0]!;
  assert.equal(entry.profile, 'rust');
  if (entry.profile !== 'rust') throw new Error('not a Rust entry');
  return createRustProfile(entry, {
    session: { connect: server.connect, commandTimeoutMs: 200 },
    settleMs: 1,
  });
}

let sequence = 0;
const command = (body: unknown): AgentCommand => ({
  id: `c${(sequence += 1)}`,
  method: 'POST',
  path: '/native/v1/op',
  body: typeof body === 'string' ? body : JSON.stringify(body),
  expiresAt: Date.now() + 30_000,
});

async function operate(
  profile: ReturnType<typeof createRustProfile>,
  body: unknown,
) {
  const response = await profile.handle(command(body));
  const value: unknown = JSON.parse(response.body.toString('utf8'));
  return {
    status: response.status,
    value,
    result: response.status === 200 ? nativeOperationResult.parse(value) : null,
  };
}

void test('Rust console lines are built from checked values only', () => {
  assert.equal(rustKick(steam, 'Rule 1'), `kick ${steam} "Rule 1"`);
  assert.equal(
    rustBanId(steam, 'permanent', 'Aimbot'),
    `banid ${steam} "${steam}" "Aimbot"`,
  );
  assert.equal(
    rustBanId(steam, 90, 'Aimbot'),
    `banid ${steam} "${steam}" "Aimbot" 90m`,
  );
  assert.equal(rustUnban(steam), `unban ${steam}`);
  assert.equal(rustSay('Wipe at six'), 'say Wipe at six');
  assert.equal(rustToolLines.restart(300, 'Update'), 'restart 300 "Update"');
  assert.equal(rustToolLines.kickAll('Wipe'), 'kickall "" "Wipe"');
  assert.equal(rustToolLines.setting('maxPlayers', 60), 'server.maxplayers 60');
  assert.equal(rustToolLines.setting('url', ''), 'server.url ""');
  assert.equal(
    rustToolLines.pluginReload('carbon', 'Vanish'),
    'c.reload Vanish',
  );
  for (const build of [
    () => rustKick('Player', 'x'),
    () => rustKick(steam, 'a"; quit'),
    () => rustBanId(steam, 0, 'x'),
    () => rustSay('a;b'),
    () => rustToolLines.restart(5),
    () => rustToolLines.setting('name', 'a"b'),
    () => rustToolLines.setting('maxPlayers', 'ten'),
    () => rustToolLines.pluginReload('oxide', 'Bad Name; quit'),
  ])
    assert.throws(build);
});

void test('the player list and the ban list are read for one Steam ID', () => {
  const list = JSON.stringify([
    { SteamID: steam, DisplayName: 'Alpha' },
    { SteamID: other, DisplayName: `fake ${steam}` },
  ]);
  assert.deepEqual(rustPlayerState(list, steam), {
    online: true,
    name: 'Alpha',
    shadowed: true,
    count: 2,
  });
  assert.equal(rustPlayerState('[]', steam)?.online, false);
  assert.equal(rustPlayerState('<html>', steam), null);
  assert.equal(rustPlayerState('[{"SteamID":5}]', steam), null);
  const bans = `1 ${steam} "${steam}" "Aimbot" -1\n2 ${other} "x" "y" 5`;
  assert.equal(rustBanListed(bans, steam), true);
  assert.equal(rustBanListed(`1 ${other} "${steam}" "y" -1`, steam), false);
  assert.equal(rustBanListed('', steam), false);
});

void test('the password and port are read from server.cfg, and a pushed message becomes one feed line', () => {
  const text =
    'rcon.port 28016\nrcon.password "Pass word"\nserver.hostname "x"';
  assert.equal(rustConfigValue(text, 'rcon.password'), 'Pass word');
  assert.equal(rustConfigValue(text, 'rcon.port'), '28016');
  assert.equal(rustConfigValue(text, 'rcon.web'), null);
  const line = rustFeedLine({
    at: 5,
    channel: 'console',
    severity: 'warning',
    identifier: 0,
    text: `one\n\ttwo ${'x'.repeat(9_000)}`,
  });
  assert.ok(line.length <= nativeFeedLineMaxChars);
  const read = JSON.parse(line) as {
    c: string;
    s: string;
    i: number;
    m: string;
  };
  assert.deepEqual([read.c, read.s, read.i], ['console', 'warning', 0]);
  assert.ok(read.m.startsWith('one\n\ttwo '));
});

void test('the operation schema takes typed Rust operations and never a raw line', () => {
  const parse = (body: unknown) =>
    parseNativeOperation(rustOperation, JSON.stringify(body));
  assert.ok(parse({ profile: 'rust', op: 'players' }));
  assert.ok(
    parse({ profile: 'rust', op: 'restart', seconds: 300, reason: 'Update' }),
  );
  assert.ok(parse({ profile: 'rust', op: 'info' }));
  assert.ok(parse({ profile: 'rust', op: 'positions' }));
  assert.ok(
    parse({ profile: 'rust', op: 'lookup', kind: 'combat', steamId: steam }),
  );
  for (const body of [
    { profile: 'rust', op: 'lookup', kind: 'combat', steamId: 'a; quit' },
    { profile: 'rust', op: 'lookup', kind: 'inventory', steamId: steam },
    { profile: 'rust', op: 'info', line: 'quit' },
    { profile: 'rust', op: 'command', line: 'quit' },
    { profile: 'rust', op: 'console', line: 'quit' },
    { profile: 'rust', op: 'players', line: 'quit' },
    { profile: 'rust', op: 'kickIfSteamId', steamId: 'Player', reason: 'x' },
    { profile: 'rust', op: 'kickIfSteamId', steamId: steam, reason: 'a";b' },
    { profile: 'rust', op: 'broadcast', message: 'a;quit' },
    { profile: 'rust', op: 'restart', seconds: 1 },
    { profile: 'rust', op: 'setSettings', values: { name: 'a"b' } },
    { profile: 'rust', op: 'setSettings', values: { other: 'x' } },
    { profile: 'rust', op: 'reloadPlugin', plugin: 'a b' },
    { profile: 'battleye', op: 'players' },
  ])
    assert.equal(parse(body), null, JSON.stringify(body));
});

void test('the Rust profile runs typed operations in one local connection', async () => {
  const server = fakeServer({
    banlistex: `1 ${other} "${other}" "Old" -1`,
    [`banid ${steam} "${steam}" "Aimbot" 60m`]: `Banned User for 1h: ${steam} - "${steam}" for "Aimbot"`,
    [`unban ${other}`]: `Unbanned User: ${other}`,
    'server.writecfg': 'Config Saved',
    'server.hostname': 'server.hostname: "Island"',
    'server.description': 'server.description: ""',
    'server.url': 'server.url: ""',
    'server.headerimage': 'server.headerimage: ""',
    'server.maxplayers': 'server.maxplayers: "50"',
    'server.maxplayers 60': 'server.maxplayers: "60"',
    'restart 300 "Update"': 'Restarting in 300 seconds',
    serverinfo: '{"Framerate":60}',
    playerlistpos: 'SteamID DisplayName POS ROT ',
    'server.worldsize': 'server.worldsize: "3000"',
    [`combatlog ${steam}`]: 'invalid player',
    [`teaminfo ${steam}`]: 'Player not found',
    'c.version': null,
    'oxide.version': null,
  });
  const profile = profileFor(server);
  try {
    server.setPlayers([{ SteamID: steam, DisplayName: 'Alpha' }]);
    const players = await operate(profile, { profile: 'rust', op: 'players' });
    assert.equal(players.result?.outcome, 'read');
    // The password is the path of the local address and a secret for logs.
    assert.deepEqual(server.urls, [`ws://127.0.0.1:28016/${password}`]);
    assert.deepEqual(profile.secrets(), [password]);
    // A new connection turns on the settings that print events.
    assert.equal(server.sent('server.printreportstoconsole true').length, 1);

    // A kick goes only to a player who is online under that Steam ID.
    const kicked = await operate(profile, {
      profile: 'rust',
      op: 'kickIfSteamId',
      steamId: steam,
      reason: 'Rule 1',
    });
    assert.deepEqual(kicked.result, {
      outcome: 'sent',
      reply: JSON.stringify({ reply: 'Kicked: Alpha', name: 'Alpha' }),
    });
    assert.deepEqual(server.sent('kick'), [`kick ${steam} "Rule 1"`]);
    for (const list of [
      [],
      [
        { SteamID: steam, DisplayName: 'Alpha' },
        { SteamID: other, DisplayName: `x ${steam}` },
      ],
    ]) {
      server.setPlayers(list);
      assert.deepEqual(
        (
          await operate(profile, {
            profile: 'rust',
            op: 'kickIfSteamId',
            steamId: steam,
            reason: 'Rule 1',
          })
        ).result,
        { outcome: 'target-changed' },
      );
    }
    assert.equal(server.sent('kick').length, 1);

    // A ban change is written to the server's config.
    const banned = await operate(profile, {
      profile: 'rust',
      op: 'addBan',
      steamId: steam,
      minutes: 60,
      reason: 'Aimbot',
    });
    assert.equal(banned.result?.outcome, 'sent');
    assert.equal(server.sent('server.writecfg').length, 1);
    assert.deepEqual(
      (
        await operate(profile, {
          profile: 'rust',
          op: 'removeBanForSteamId',
          steamId: steam,
        })
      ).result,
      { outcome: 'not-found' },
    );
    assert.deepEqual(server.sent('unban'), []);
    assert.equal(
      (
        await operate(profile, {
          profile: 'rust',
          op: 'removeBanForSteamId',
          steamId: other,
        })
      ).result?.outcome,
      'sent',
    );

    // The performance, the positions and the lookups are fixed lines.
    const reads = async (op: Record<string, unknown>) => {
      const done = await operate(profile, { profile: 'rust', ...op } as never);
      assert.equal(done.result?.outcome, 'read');
      return done.result?.outcome === 'read' ? done.result.reply : '';
    };
    assert.equal(await reads({ op: 'info' }), '{"Framerate":60}');
    assert.deepEqual(JSON.parse(await reads({ op: 'positions' })), {
      list: 'SteamID DisplayName POS ROT ',
      size: 'server.worldsize: "3000"',
    });
    assert.equal(
      await reads({ op: 'lookup', kind: 'combat', steamId: steam }),
      'invalid player',
    );
    assert.equal(
      await reads({ op: 'lookup', kind: 'team', steamId: steam }),
      'Player not found',
    );

    // Settings are read and set by name, and saved.
    const settings = await operate(profile, {
      profile: 'rust',
      op: 'settings',
    });
    assert.equal(settings.result?.outcome, 'read');
    if (settings.result?.outcome === 'read')
      assert.deepEqual(JSON.parse(settings.result.reply), {
        name: 'server.hostname: "Island"',
        description: 'server.description: ""',
        url: 'server.url: ""',
        headerImage: 'server.headerimage: ""',
        maxPlayers: 'server.maxplayers: "50"',
      });
    const saved = await operate(profile, {
      profile: 'rust',
      op: 'setSettings',
      values: { maxPlayers: 60 },
    });
    assert.deepEqual(saved.result, {
      outcome: 'sent',
      reply: JSON.stringify({
        replies: { maxPlayers: 'server.maxplayers: "60"' },
        saved: 'Config Saved',
      }),
    });
    assert.equal(
      (
        await operate(profile, {
          profile: 'rust',
          op: 'restart',
          seconds: 300,
          reason: 'Update',
        })
      ).result?.outcome,
      'sent',
    );

    // Without a plugin framework there is no list and no reload.
    const plugins = await operate(profile, { profile: 'rust', op: 'plugins' });
    if (plugins.result?.outcome === 'read')
      assert.deepEqual(JSON.parse(plugins.result.reply), {
        framework: null,
        version: '',
        plugins: '',
      });
    else assert.fail('plugins is a read');
    assert.deepEqual(
      (
        await operate(profile, {
          profile: 'rust',
          op: 'reloadPlugin',
          plugin: 'Vanish',
        })
      ).result,
      { outcome: 'unsupported' },
    );

    // Anything but a typed operation is refused before a line is built.
    const before = server.lines.length;
    for (const body of [
      { profile: 'rust', op: 'command', line: 'quit' },
      { profile: 'battleye', op: 'players' },
      'quit',
    ]) {
      const refused = await operate(profile, body);
      assert.equal(refused.status, 400);
    }
    assert.equal(server.lines.length, before);

    // Pushed messages are served as feed lines after the cursor.
    server.push({ Identifier: 0, Type: 'Generic', Message: 'hello\nworld' });
    server.push({ Identifier: -1, Type: 'Chat', Message: '{"Message":"hi"}' });
    const feed = nativeEventFeed.parse(
      JSON.parse(
        (
          await profile.handle({
            id: 'feed',
            method: 'GET',
            path: '/native/v1/events',
            expiresAt: Date.now() + 30_000,
          })
        ).body.toString('utf8'),
      ),
    );
    assert.deepEqual(
      feed.lines.map((line) => JSON.parse(line.text) as unknown),
      [
        { c: 'console', s: 'info', i: 0, m: 'hello\nworld' },
        { c: 'chat', s: 'info', i: -1, m: '{"Message":"hi"}' },
      ],
    );
  } finally {
    await profile.close();
  }
});

void test('a command without a reply is reported and never sent again', async () => {
  const server = fakeServer({ 'server.save': null });
  const profile = profileFor(server);
  try {
    const response = await profile.handle(
      command({ profile: 'rust', op: 'save' }),
    );
    assert.notEqual(response.status, 200);
    assert.equal(
      (JSON.parse(response.body.toString('utf8')) as { error: string }).error,
      'reply-missing',
    );
    assert.equal(server.sent('server.save').length, 1);
  } finally {
    await profile.close();
  }
});
