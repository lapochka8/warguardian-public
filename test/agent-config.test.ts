import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentConfigFileSchema } from '../protocol/agent-protocol';
import {
  agentLocations,
  loadServers,
  panelOrigin,
  parseAgentConfig,
  parseEnvironmentFile,
  readAgentConfig,
  serverFromV1Environment,
  writeAgentConfig,
} from '../src/config';

const secret = `wga_${'A'.repeat(43)}`;
const otherSecret = `wga_${'B'.repeat(43)}`;

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'wg-agent-config-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test('the v1 WARDOGS agent environment file becomes a wardogs entry', () => {
  const env = parseEnvironmentFile(
    [
      '# WarGuardian Agent',
      'WARGUARDIAN_AGENT_URL=https://panel.example.com',
      'WARGUARDIAN_AGENT_SERVER_ID=server-example',
      `WARGUARDIAN_AGENT_SECRET=${secret}`,
      'WARDOGS_RCON_URL=http://127.0.0.1:9006',
      'WARDOGS_RCON_TOKEN="local token #1"',
      '',
    ].join('\n'),
  );
  assert.equal(env.WARDOGS_RCON_TOKEN, 'local token #1');
  const { panel, server } = serverFromV1Environment(env);
  assert.equal(panel, 'https://panel.example.com');
  assert.deepEqual(server, {
    serverId: 'server-example',
    secret,
    panel: 'https://panel.example.com',
    profile: 'wardogs',
    rconUrl: 'http://127.0.0.1:9006',
    rconToken: 'local token #1',
  });
});

void test('the v1 Reforger host connector environment becomes an arma-reforger entry with its defaults', () => {
  const env = parseEnvironmentFile(
    [
      'export WARGUARDIAN_AGENT_URL=https://panel.example.com',
      'WARGUARDIAN_AGENT_SERVER_ID=reforger-east',
      `WARGUARDIAN_AGENT_SECRET='${secret}'`,
      'WARGUARDIAN_HOST_PROFILE=/srv/reforger/east/profile',
      'WARGUARDIAN_HOST_CONFIG=/srv/reforger/east/config.json',
      'WARGUARDIAN_HOST_EXECUTABLE=/srv/reforger/east/ArmaReforgerServer',
      'WARGUARDIAN_HOST_STATE=/srv/warguardian/east',
      'WARGUARDIAN_HOST_MAX_FPS=90',
    ].join('\r\n'),
  );
  const { server } = serverFromV1Environment(env);
  assert.equal(server.profile, 'arma-reforger');
  assert.ok(server.profile === 'arma-reforger' && server.host);
  assert.equal(server.host.maxFps, 90);
  assert.equal(server.host.logStatsMs, 60_000);
  assert.equal(server.host.executable, '/srv/reforger/east/ArmaReforgerServer');
  assert.equal(server.host.steamcmd, undefined);
});

void test('a v1 environment without a profile or with an invalid secret is refused without echoing values', () => {
  assert.throws(
    () =>
      serverFromV1Environment({
        WARGUARDIAN_AGENT_URL: 'https://panel.example.com',
        WARGUARDIAN_AGENT_SERVER_ID: 'server-example',
        WARGUARDIAN_AGENT_SECRET: secret,
      }),
    /neither WARDOGS_RCON_URL nor WARGUARDIAN_HOST_PROFILE/,
  );
  assert.throws(
    () =>
      serverFromV1Environment({
        WARGUARDIAN_AGENT_URL: 'https://panel.example.com',
        WARGUARDIAN_AGENT_SERVER_ID: 'server-example',
        WARGUARDIAN_AGENT_SECRET: 'wga_short-secret-value',
        WARDOGS_RCON_URL: 'http://127.0.0.1:9006',
        WARDOGS_RCON_TOKEN: 'token',
      }),
    (error: Error) =>
      /secret/.test(error.message) &&
      !error.message.includes('wga_short-secret-value'),
  );
});

void test('an agent.json saved without the later fields parses with their defaults', () => {
  const saved = {
    panel: 'https://panel.example.com/',
    servers: [
      { serverId: 'arma-one', secret, profile: 'battleye', game: 'arma3' },
    ],
  };
  const config = parseAgentConfig(saved);
  assert.equal(config.v, 2);
  assert.equal(config.panel, 'https://panel.example.com');
  assert.deepEqual(config.update, { enabled: true });
  assert.deepEqual(parseAgentConfig({}), {
    v: 2,
    servers: [],
    update: { enabled: true },
  });
});

void test('agent.json refuses duplicate servers, a missing address and unknown fields', () => {
  const server = {
    serverId: 'arma-one',
    secret,
    profile: 'battleye',
    game: 'arma3',
  };
  assert.throws(
    () =>
      parseAgentConfig({
        panel: 'https://panel.example.com',
        servers: [server, server],
      }),
    /Duplicate/,
  );
  assert.throws(() => parseAgentConfig({ servers: [server] }), /address/);
  assert.throws(() =>
    parseAgentConfig({
      panel: 'https://panel.example.com',
      servers: [{ ...server, rconPassword: 'x' }],
    }),
  );
});

void test('the WarGuardian address is an HTTPS origin, or HTTP on loopback', () => {
  assert.equal(
    panelOrigin('https://panel.example.com').origin,
    'https://panel.example.com',
  );
  assert.equal(
    panelOrigin('http://127.0.0.1:3000').origin,
    'http://127.0.0.1:3000',
  );
  for (const value of [
    'http://panel.example.com',
    'https://user:pass@panel.example.com',
    'https://panel.example.com/path',
    'https://panel.example.com/?q=1',
    'ftp://panel.example.com',
    'not a url',
  ])
    assert.throws(() => panelOrigin(value), value);
});

void test('agent.json is written atomically and readable only by its owner', async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, 'nested', 'agent.json');
    await writeAgentConfig(
      file,
      parseAgentConfig({
        panel: 'https://panel.example.com',
        servers: [
          {
            serverId: 'squad-one',
            secret,
            profile: 'squad-family',
            game: 'squad44',
          },
        ],
      }),
    );
    const read = await readAgentConfig(file);
    assert.equal(read?.servers[0]?.serverId, 'squad-one');
    if (process.platform !== 'win32')
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.match(await readFile(file, 'utf8'), /"squad44"/);
  });
});

void test('a process started with v1 variables runs exactly that server', async () => {
  await withDirectory(async (directory) => {
    const configFile = join(directory, 'agent.json');
    await writeFile(
      configFile,
      JSON.stringify({
        panel: 'https://panel.example.com',
        servers: [
          {
            serverId: 'arma-one',
            secret: otherSecret,
            profile: 'battleye',
            game: 'arma3',
          },
        ],
      }),
    );
    const loaded = await loadServers({
      configFile,
      configExplicit: false,
      envFiles: [],
      env: {
        WARGUARDIAN_AGENT_URL: 'https://panel.example.com',
        WARGUARDIAN_AGENT_SERVER_ID: 'server-example',
        WARGUARDIAN_AGENT_SECRET: secret,
        WARDOGS_RCON_URL: 'http://127.0.0.1:9006',
        WARDOGS_RCON_TOKEN: 'token',
      },
    });
    assert.deepEqual(
      loaded.config.servers.map((server) => server.serverId),
      ['server-example'],
    );
  });
});

void test('agent.json and v1 environment files load together, and a repeated server is refused', async () => {
  await withDirectory(async (directory) => {
    const configFile = join(directory, 'agent.json');
    const envFile = join(directory, 'reforger-east.env');
    await writeFile(
      configFile,
      JSON.stringify({
        panel: 'https://panel.example.com',
        servers: [
          {
            serverId: 'arma-one',
            secret: otherSecret,
            profile: 'battleye',
            game: 'arma3',
          },
        ],
      }),
    );
    await writeFile(
      envFile,
      [
        'WARGUARDIAN_AGENT_URL=https://other.example.com',
        'WARGUARDIAN_AGENT_SERVER_ID=server-example',
        `WARGUARDIAN_AGENT_SECRET=${secret}`,
        'WARDOGS_RCON_URL=http://127.0.0.1:9006',
        'WARDOGS_RCON_TOKEN=token',
      ].join('\n'),
    );
    const loaded = await loadServers({
      configFile,
      configExplicit: false,
      envFiles: [envFile],
      env: {},
    });
    assert.deepEqual(
      loaded.config.servers.map((server) => [
        server.serverId,
        server.panel ?? loaded.config.panel,
      ]),
      [
        ['arma-one', 'https://panel.example.com'],
        ['server-example', 'https://other.example.com'],
      ],
    );
    await assert.rejects(
      loadServers({
        configFile,
        configExplicit: false,
        envFiles: [envFile, envFile],
        env: {},
      }),
      /configured twice/,
    );
    await assert.rejects(
      loadServers({
        configFile: join(directory, 'missing.json'),
        configExplicit: true,
        envFiles: [],
        env: {},
      }),
      /does not exist/,
    );
  });
});

void test('default locations follow the platform', () => {
  assert.deepEqual(agentLocations('linux', {}), {
    configFile: '/etc/warguardian/agent.json',
    stateDirectory: '/var/lib/warguardian-agent',
  });
  assert.deepEqual(
    agentLocations('win32', { ProgramData: 'C:\\ProgramData' }),
    {
      configFile: 'C:\\ProgramData\\WarGuardian\\agent.json',
      stateDirectory: 'C:\\ProgramData\\WarGuardian\\state',
    },
  );
});

void test('the file keeps the first server at the top level in the form the installer expects', async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, 'agent.json');
    // install.sh writes only the address before setup.
    await writeFile(file, '{"panel":"https://panel.example.com"}\n');
    assert.deepEqual((await readAgentConfig(file))?.servers, []);
    await writeAgentConfig(
      file,
      parseAgentConfig({
        panel: 'https://panel.example.com',
        servers: [
          { serverId: 'arma-one', secret, profile: 'battleye', game: 'arma3' },
          {
            serverId: 'squad-one',
            secret: otherSecret,
            profile: 'squad-family',
            game: 'squad44',
          },
        ],
      }),
    );
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(agentConfigFileSchema.parse(saved).serverId, 'arma-one');
    assert.deepEqual(
      [saved.panel, saved.serverId, saved.secret, saved.profile, saved.game],
      ['https://panel.example.com', 'arma-one', secret, 'battleye', 'arma3'],
    );
    assert.deepEqual(
      saved.servers.map((server: { serverId: string }) => server.serverId),
      ['squad-one'],
    );
    assert.deepEqual(
      (await readAgentConfig(file))?.servers.map((server) => server.serverId),
      ['arma-one', 'squad-one'],
    );
  });
});
