import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { mock, test } from 'node:test';
import { readAgentConfig } from '../src/config';
import {
  writeDiscoveryFile,
  type DiscoveredInstance,
} from '../src/discovery';
import { main, notConfiguredExitCode } from '../src/main';
import {
  chooseInstance,
  enroll,
  enrollHostName,
} from '../src/enroll';
import {
  enrollRequest,
  normalizeEnrollmentCode,
} from '../src/protocol';

const secret = `wga_${'E'.repeat(43)}`;

/** The test runs the commands as the service account would, also when the test runner is root. */
const asOperator = { privileged: async () => false };

type Reply = { status: number; body: unknown };

/** A panel enrollment endpoint that records requests and answers from `reply`. */
async function fakeEnrollment(reply: (body: unknown) => Reply) {
  const requests: {
    path: string;
    body: unknown;
    contentType: string | undefined;
  }[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({
      path: request.url ?? '',
      body,
      contentType: request.headers['content-type'],
    });
    const { status, body: answer } = reply(body);
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(answer));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    panel: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const arma: DiscoveredInstance = {
  id: 'arma3-0123456789',
  profile: 'battleye',
  summary: { gameId: 'arma3', rconPort: 2306, gamePort: 2302, queryPort: 2303 },
  rconConfigured: true,
  settings: {
    game: 'arma3',
    battleyeConfig: '/srv/arma3/profiles/BattlEye',
    logDirectory: '/srv/arma3/profiles',
  },
};
const dayz: DiscoveredInstance = {
  id: 'dayz-abcdef0123',
  profile: 'battleye',
  summary: { gameId: 'dayz', rconPort: 2305, gamePort: 2302 },
  rconConfigured: true,
  rconFiles: ['/srv/dayz/battleye/BEServer_x64.cfg'],
  settings: { game: 'dayz', battleyeConfig: '/srv/dayz/battleye' },
};

async function withDirectory<T>(run: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'wg-agent-enroll-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test('enrollment codes normalize Crockford look-alikes and refuse other forms', () => {
  assert.equal(normalizeEnrollmentCode('wg-7kq4m-2xdpa'), 'WG-7KQ4M-2XDPA');
  assert.equal(normalizeEnrollmentCode(' WG 7KQ4M 2XDPA '), 'WG-7KQ4M-2XDPA');
  assert.equal(normalizeEnrollmentCode('7KQ4M2XDPO'), 'WG-7KQ4M-2XDP0');
  assert.equal(normalizeEnrollmentCode('WG-7KQ4M-2XDPI'), 'WG-7KQ4M-2XDP1');
  for (const value of [
    'WG-7KQ4M-2XDP',
    'WG-7KQ4M-2XDPAU',
    'WG-7KQ4M-2XDP#',
    '',
    42,
  ])
    assert.equal(normalizeEnrollmentCode(value), null, String(value));
  assert.equal(enrollHostName('game host (eu) #1'), 'game-host--eu---1');
  assert.equal(enrollHostName('-x'), 'x');
  assert.equal(enrollHostName('***'), 'host');
});

void test('enroll sends the code and discovered ports, then saves the secret for the chosen server', async () => {
  const fake = await fakeEnrollment(() => ({
    status: 200,
    body: {
      serverId: 'arma-one',
      gameId: 'arma3',
      profile: 'battleye',
      secret,
    },
  }));
  try {
    await withDirectory(async (directory) => {
      const configFile = join(directory, 'agent.json.new');
      // install.sh writes the address first, then runs enroll with --config.
      await writeFile(configFile, JSON.stringify({ panel: fake.panel }));
      const outcome = await enroll({
        code: 'wg-7kq4m-2xdpa',
        configFile,
        stateDirectory: directory,
        version: '1.1.0',
        platform: 'linux',
        arch: 'x64',
        discover: async () => [arma, dayz],
      });
      assert.deepEqual(outcome, {
        serverId: 'arma-one',
        profile: 'battleye',
        missing: [],
        instance: 'arma3-0123456789',
        serviceServers: 1,
        paths: [
          { label: 'BattlEye folder', path: '/srv/arma3/profiles/BattlEye' },
        ],
      });
      const [request] = fake.requests;
      assert.equal(request?.path, '/api/agent/v1/enroll');
      assert.equal(request?.contentType, 'application/json');
      const body = enrollRequest.parse(request?.body);
      assert.equal(body.code, 'WG-7KQ4M-2XDPA');
      assert.deepEqual(
        [body.os, body.arch, body.version],
        ['linux', 'x64', '1.1.0'],
      );
      assert.deepEqual(body.discovered, [arma.summary, dayz.summary]);
      const sent = JSON.stringify(request?.body);
      assert.ok(
        !sent.includes('/srv/') && !sent.includes(arma.id),
        'local paths and IDs stay on the host',
      );
      const saved = await readAgentConfig(configFile);
      assert.equal(saved?.panel, fake.panel);
      assert.deepEqual(saved?.servers, [
        {
          serverId: 'arma-one',
          secret,
          instance: arma.id,
          profile: 'battleye',
          game: 'arma3',
          battleyeConfig: '/srv/arma3/profiles/BattlEye',
          logDirectory: '/srv/arma3/profiles',
        },
      ]);
      assert.match(await readFile(configFile, 'utf8'), /wga_/);
    });
  } finally {
    await fake.close();
  }
});

void test('a second enrollment adds a server, and the same server again keeps its place', async () => {
  let reply: Reply = {
    status: 200,
    body: {
      serverId: 'dayz-one',
      gameId: 'dayz',
      profile: 'battleye',
      secret,
    },
  };
  const fake = await fakeEnrollment(() => reply);
  try {
    await withDirectory(async (directory) => {
      const configFile = join(directory, 'agent.json');
      const options = {
        code: 'WG-7KQ4M-2XDPA',
        configFile,
        stateDirectory: directory,
        panel: fake.panel,
        version: '1.1.0',
        platform: 'win32' as const,
        arch: 'x64',
        discover: async () => [arma, dayz],
      };
      await enroll(options);
      reply = {
        status: 200,
        body: {
          serverId: 'arma-one',
          gameId: 'arma3',
          profile: 'battleye',
          secret,
        },
      };
      await enroll(options);
      reply = {
        status: 200,
        body: {
          serverId: 'dayz-one',
          gameId: 'dayz',
          profile: 'battleye',
          secret: `wga_${'F'.repeat(43)}`,
        },
      };
      await enroll(options);
      const saved = await readAgentConfig(configFile);
      assert.deepEqual(
        saved?.servers.map((server) => [
          server.serverId,
          server.secret.slice(4, 5),
        ]),
        [
          ['dayz-one', 'F'],
          ['arma-one', 'E'],
        ],
      );
      assert.equal((fake.requests[0]!.body as { os: string }).os, 'win');
    });
  } finally {
    await fake.close();
  }
});

void test('an invalid code, a refusal and an invalid response leave the configuration unchanged', async () => {
  let reply: Reply = {
    status: 401,
    body: { error: 'This code is invalid, used or expired.' },
  };
  const fake = await fakeEnrollment(() => reply);
  try {
    await withDirectory(async (directory) => {
      const configFile = join(directory, 'agent.json');
      const options = {
        code: 'WG-7KQ4M-2XDPA',
        configFile,
        stateDirectory: directory,
        panel: fake.panel,
        version: '1.1.0',
        platform: 'linux' as const,
        arch: 'x64',
        discover: async () => [],
      };
      await assert.rejects(enroll(options), /invalid, used or expired/);
      reply = {
        status: 409,
        body: { error: 'This server cannot use the WarGuardian Agent.' },
      };
      await assert.rejects(enroll(options), /cannot use the WarGuardian Agent/);
      reply = {
        status: 200,
        body: {
          serverId: 'arma-one',
          gameId: 'arma3',
          profile: 'battleye',
          secret: 'not-a-secret',
        },
      };
      await assert.rejects(enroll(options), /invalid setup response/);
      reply = { status: 429, body: {} };
      await assert.rejects(enroll(options), /Too many/);
      assert.equal(await readAgentConfig(configFile), null);
      await assert.rejects(
        enroll({ ...options, code: 'nope' }),
        /WG-XXXXX-XXXXX/,
      );
      await assert.rejects(
        enroll({ ...options, panel: 'http://panel.example.com' }),
        /HTTPS/,
      );
      await assert.rejects(
        enroll({ ...options, instance: 'arma3-missing' }),
        /discover/,
      );
      assert.equal(fake.requests.length, 4, 'local refusals send nothing');
    });
  } finally {
    await fake.close();
  }
});

void test('several servers of one game need an instance, and a missing match records the missing setting', async () => {
  const second: DiscoveredInstance = {
    ...arma,
    id: 'arma3-other',
    settings: { ...arma.settings, battleyeConfig: '/srv/two/BattlEye' },
  };
  const response = {
    serverId: 'x',
    gameId: 'arma3',
    profile: 'battleye',
    secret,
  } as const;
  assert.equal(chooseInstance(response, [arma, second]), null);
  assert.equal(chooseInstance(response, [arma, second], 'arma3-other'), second);
  assert.equal(chooseInstance(response, [arma, dayz], dayz.id), null);
  const fake = await fakeEnrollment(() => ({
    status: 200,
    body: { serverId: 'dayz-one', gameId: 'dayz', profile: 'battleye', secret },
  }));
  try {
    await withDirectory(async (directory) => {
      const outcome = await enroll({
        code: 'WG-7KQ4M-2XDPA',
        configFile: join(directory, 'agent.json'),
        stateDirectory: directory,
        panel: fake.panel,
        version: '1.1.0',
        platform: 'linux',
        arch: 'arm64',
        discover: async () => [arma],
      });
      assert.deepEqual(outcome.missing, ['battleyeConfig']);
      assert.equal(outcome.instance, undefined);
    });
  } finally {
    await fake.close();
  }
});

void test('a second code for the same game takes the server that no binding uses yet', async () => {
  const other: DiscoveredInstance = {
    ...dayz,
    id: 'dayz-9876543210',
    rconFiles: ['/srv/dayz-two/battleye/BEServer_x64.cfg'],
    settings: { game: 'dayz', battleyeConfig: '/srv/dayz-two/battleye' },
  };
  let serverId = 'dayz-one';
  const fake = await fakeEnrollment(() => ({
    status: 200,
    body: { serverId, gameId: 'dayz', profile: 'battleye', secret },
  }));
  try {
    await withDirectory(async (directory) => {
      const configFile = join(directory, 'agent.json');
      let discovered = 0;
      const options = {
        code: 'WG-7KQ4M-2XDPA',
        configFile,
        stateDirectory: directory,
        panel: fake.panel,
        version: '1.1.0',
        platform: 'linux' as const,
        arch: 'x64',
        discover: async () => {
          discovered += 1;
          return [];
        },
        // install.sh passes what discovery found as root.
        discovered: [dayz, other],
      };
      const first = await enroll({ ...options, instance: dayz.id });
      assert.deepEqual(first.missing, []);
      serverId = 'dayz-two';
      const second = await enroll(options);
      assert.deepEqual(second.missing, []);
      assert.deepEqual([first.instance, second.instance], [dayz.id, other.id]);
      assert.equal(second.serviceServers, 2);
      assert.equal(discovered, 0, 'a saved discovery is not repeated');
      const saved = await readAgentConfig(configFile);
      assert.deepEqual(
        saved?.servers.map((server) => [server.serverId, server.instance]),
        [
          ['dayz-one', dayz.id],
          ['dayz-two', other.id],
        ],
      );
      // A third DayZ code finds no free server and records the missing setting.
      serverId = 'dayz-three';
      const third = await enroll(options);
      assert.deepEqual(third.missing, ['battleyeConfig']);
      assert.equal(third.instance, undefined);
    });
  } finally {
    await fake.close();
  }
});

void test('enroll --json prints one line without the secret, and run skips the profiles of other services', async () => {
  const fake = await fakeEnrollment(() => ({
    status: 200,
    body: { serverId: 'dayz-one', gameId: 'dayz', profile: 'battleye', secret },
  }));
  const printed: string[] = [];
  const log = mock.method(console, 'log', (line: unknown) => {
    printed.push(String(line));
  });
  const errors = mock.method(console, 'error', () => undefined);
  try {
    await withDirectory(async (directory) => {
      const configFile = join(directory, 'agent.json');
      const discovery = join(directory, 'discovery.json');
      await writeDiscoveryFile(discovery, [dayz]);
      assert.equal(
        await main(
          [
            'enroll',
            'WG-7KQ4M-2XDPA',
            '--panel',
            fake.panel,
            '--config',
            configFile,
            '--discovered',
            discovery,
            '--json',
          ],
          asOperator,
        ),
        0,
      );
      assert.equal(printed.length, 1);
      // install.sh grants read access to the RCON files of this instance only.
      assert.deepEqual(JSON.parse(printed[0]!), {
        serverId: 'dayz-one',
        profile: 'battleye',
        missing: [],
        serviceServers: 1,
        instance: 'dayz-abcdef0123',
      });
      assert.ok(
        !printed[0]!.includes('wga_') && !printed[0]!.includes('/srv/'),
      );
      // A configuration with only an Arma Reforger server leaves the shared
      // service with nothing to run: it exits with 78 and starts nothing.
      const reforger = join(directory, 'reforger.json');
      await writeFile(
        reforger,
        JSON.stringify({
          panel: fake.panel,
          serverId: 'reforger-one',
          secret,
          profile: 'arma-reforger',
        }),
      );
      assert.equal(
        await main(
          ['run', '--config', reforger, '--skip-profile', 'arma-reforger'],
          asOperator,
        ),
        notConfiguredExitCode,
      );
      await assert.rejects(
        main(
          ['run', '--config', reforger, '--skip-profile', 'squad'],
          asOperator,
        ),
        /Unknown profile/,
      );
      const empty = join(directory, 'empty.json');
      await writeFile(empty, JSON.stringify({ panel: fake.panel }));
      assert.equal(
        await main(['run', '--config', empty], asOperator),
        notConfiguredExitCode,
      );
      assert.equal(notConfiguredExitCode, 78);
    });
  } finally {
    log.mock.restore();
    errors.mock.restore();
    await fake.close();
  }
});

void test('a server whose configuration path failed the discovery checks is never picked on its own', async () => {
  const rejected: DiscoveredInstance = {
    id: 'dayz-1111111111',
    profile: 'battleye',
    summary: { gameId: 'dayz', gamePort: 2402 },
    rconConfigured: false,
    rejected: true,
    problem:
      '/srv/other/battleye/BEServer_x64.cfg is outside the game folder /srv/b.',
    settings: { game: 'dayz' },
  };
  const response = {
    serverId: 'x',
    gameId: 'dayz',
    profile: 'battleye',
    secret,
  } as const;
  assert.equal(chooseInstance(response, [rejected]), null);
  // The checked server is picked, the rejected one does not count.
  assert.equal(chooseInstance(response, [rejected, dayz]), dayz);
  // Naming it records the instance, without a path.
  assert.equal(chooseInstance(response, [rejected], rejected.id), rejected);
});

void test('enroll reads the code from stdin and prints the RCON path it set up', async () => {
  const fake = await fakeEnrollment(() => ({
    status: 200,
    body: { serverId: 'dayz-one', gameId: 'dayz', profile: 'battleye', secret },
  }));
  const printed: string[] = [];
  const log = mock.method(console, 'log', (line: unknown) => {
    printed.push(String(line));
  });
  const errors: string[] = [];
  const error = mock.method(console, 'error', (line: unknown) => {
    errors.push(String(line));
  });
  try {
    await withDirectory(async (directory) => {
      const configFile = join(directory, 'agent.json');
      const discovery = join(directory, 'discovery.json');
      await writeDiscoveryFile(discovery, [dayz]);
      const setup = (stdin: string, ...extra: string[]) =>
        main(
          [
            'enroll',
            ...extra,
            '--panel',
            fake.panel,
            '--config',
            configFile,
            '--discovered',
            discovery,
          ],
          { ...asOperator, stdin: Readable.from([stdin]) },
        );
      assert.equal(await setup(' wg-7kq4m-2xdpa \r\n', '--code-stdin'), 0);
      assert.equal(
        (fake.requests[0]?.body as { code?: string } | undefined)?.code,
        'WG-7KQ4M-2XDPA',
      );
      assert.ok(printed.includes('Set up dayz-one (battleye).'));
      assert.ok(
        printed.includes('BattlEye folder: /srv/dayz/battleye'),
        printed.join('\n'),
      );
      // One code at a time: from stdin or from the command line.
      await assert.rejects(
        setup('WG-7KQ4M-2XDPA\n', '--code-stdin', 'WG-7KQ4M-2XDPA'),
        /one setup code/,
      );
      await assert.rejects(setup('', '--code-stdin'), /WG-XXXXX-XXXXX/);
      // The code as an argument still works for earlier installers.
      printed.length = 0;
      assert.equal(await setup('', 'WG-7KQ4M-2XDPA', '--json'), 0);
      assert.equal(printed.length, 1);
      assert.ok(errors.includes('BattlEye folder: /srv/dayz/battleye'));
    });
  } finally {
    log.mock.restore();
    error.mock.restore();
    await fake.close();
  }
});
