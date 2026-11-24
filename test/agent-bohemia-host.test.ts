import assert from 'node:assert/strict';
import { execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  bohemiaHostBackups,
  bohemiaHostConfig,
  bohemiaHostLogs,
  bohemiaHostMods,
  bohemiaHostStatus,
  bohemiaSecretPlaceholder,
} from '../vendor/games/bohemia-host';
import { parseAgentConfig } from '../src/config';
import {
  bohemiaHostSettings,
  bohemiaHostState,
  createBohemiaHostController,
  redactConfigSecrets,
  restoreConfigSecrets,
  type BohemiaHostSystem,
} from '../src/games/bohemia-host';
import { bohemiaHostLocations } from '../src/profiles/battleye';
import { bohemiaHostCommand } from '../vendor/games/bohemia-host';
import { nativeHostActions } from '../protocol/agent-protocol';
import { idleExecutable } from './support/idle-executable';

const config = `hostname = "Demo Arma 3";
password = "join-secret";
passwordAdmin = "admin-secret";
serverCommandPassword = "";
maxPlayers = 40;
verifySignatures = 2;
`;

type Spawned = { file: string; args: readonly string[]; detached: boolean };

/** A host whose game and SteamCMD are fakes. */
async function fixture(
  options: {
    steam?: (args: readonly string[]) => Promise<number>;
    /** What SteamCMD prints. */
    steamOutput?: string;
    /** Runs when the game starts, such as writing its log. */
    started?: (profiles: string) => void;
    /** Runs on each wait of the controller, with its count. */
    waited?: (count: number, profiles: string) => void;
    /** A game server answers on the RCON port. */
    externalRunning?: () => boolean;
    /** The game exits as soon as it starts. */
    crash?: () => boolean;
    settings?: Record<string, unknown>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'wg-bohemia-host-'));
  const server = join(root, 'server');
  const profiles = join(root, 'profiles');
  const workshop = join(root, 'workshop');
  const state = join(root, 'state');
  await mkdir(server, { recursive: true });
  await mkdir(profiles, { recursive: true });
  await mkdir(workshop, { recursive: true });
  await writeFile(join(server, 'server.cfg'), config);
  await writeFile(
    join(profiles, 'arma3server_x64_2026-11-12_10-00-00.rpt'),
    'line one\nPlayer joined with join-secret\n',
  );
  const spawned: Spawned[] = [];
  const alive = new Set<number>();
  let nextPid = 4000;
  let waits = 0;
  let now = 1_800_000_000_000;
  const system: BohemiaHostSystem = {
    platform: process.platform === 'win32' ? 'win32' : 'linux',
    spawn(file, args, { detached }) {
      spawned.push({ file, args, detached });
      const child = new EventEmitter() as unknown as ChildProcess & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      Object.assign(child, {
        pid: ++nextPid,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        unref() {},
        kill() {
          return true;
        },
      });
      if (file.endsWith('steamcmd')) {
        setImmediate(async () => {
          const code = options.steam ? await options.steam(args) : 0;
          child.stdout.emit(
            'data',
            Buffer.from(options.steamOutput ?? 'Success. Downloaded item.\n'),
          );
          child.emit('exit', code);
        });
      } else if (!options.crash?.()) {
        alive.add(child.pid!);
        options.started?.(profiles);
      }
      return child;
    },
    alive: (pid) => alive.has(pid),
    terminate: (pid) => alive.delete(pid),
    now: () => (now += 1000),
    sleep: async () => {
      waits += 1;
      options.waited?.(waits, profiles);
    },
  };
  const settings = bohemiaHostSettings.parse({
    executable: join(server, 'arma3server_x64'),
    serverDirectory: server,
    config: join(server, 'server.cfg'),
    profiles,
    port: 2302,
    steamcmd: join(root, 'steamcmd'),
    steamUser: 'wg_host',
    workshopDirectory: workshop,
    ...options.settings,
  });
  const controller = await createBohemiaHostController({
    serverId: 'demo-arma3',
    game: 'arma3',
    settings,
    stateDirectory: state,
    system,
    ...(options.externalRunning
      ? { externalRunning: options.externalRunning }
      : {}),
  });
  return {
    root,
    server,
    profiles,
    workshop,
    state,
    controller,
    spawned,
    alive,
  };
}

/** Writes what SteamCMD leaves behind for one Workshop item. */
async function download(
  workshop: string,
  id: string,
  time: number,
  key?: string,
) {
  const content = join(
    workshop,
    'steamapps',
    'workshop',
    'content',
    '107410',
    id,
  );
  await mkdir(join(content, 'addons'), { recursive: true });
  await writeFile(join(content, 'meta.cpp'), `name = "Mod ${id}";\n`);
  if (key) {
    await mkdir(join(content, 'keys'), { recursive: true });
    await writeFile(join(content, 'keys', key), 'key');
  }
  const manifest = join(
    workshop,
    'steamapps',
    'workshop',
    'appworkshop_107410.acf',
  );
  let items = '';
  try {
    items =
      /"WorkshopItemsInstalled"\s*\{([\s\S]*?)\n\t\}/.exec(
        await readFile(manifest, 'utf8'),
      )?.[1] ?? '';
  } catch {
    /* First item. */
  }
  items += `\n\t\t"${id}"\n\t\t{\n\t\t\t"timeupdated"\t\t"${time}"\n\t\t}`;
  await writeFile(
    manifest,
    `"AppWorkshop"\n{\n\t"WorkshopItemsInstalled"\n\t{${items}\n\t}\n}\n`,
  );
}

void test('settings and state from an earlier build still read', () => {
  // A settings file with only the required paths gets the defaults.
  const settings = bohemiaHostSettings.parse({
    executable: '/srv/arma3/arma3server_x64',
    serverDirectory: '/srv/arma3',
    config: '/srv/arma3/server.cfg',
    profiles: '/srv/arma3/profiles',
    extra: 'from a later release',
  });
  assert.equal(settings.port, 2302);
  assert.equal(settings.v, 1);
  assert.deepEqual(settings.launchArguments, []);
  // A mods read from an Agent before revert existed.
  assert.equal(
    bohemiaHostMods.parse({
      revision: 'a'.repeat(64),
      mods: [],
      installed: [],
      launched: null,
      keys: [],
      checkedAt: null,
    }).previous,
    null,
  );
  // A state file saved before mods, keys or jobs existed.
  const state = bohemiaHostState.parse({ v: 1, pid: null });
  assert.deepEqual(state.mods, []);
  assert.deepEqual(state.applied, []);
  assert.deepEqual(state.keys, []);
  assert.equal(state.job, null);
  assert.equal(state.launched, null);
  assert.equal(state.previous, null);
  assert.deepEqual(bohemiaHostState.parse({}).history, []);
});

void test('extra launch parameters follow the fixed ones and cannot replace them', async () => {
  const base = {
    executable: 'C:\\a3\\arma3server_x64.exe',
    serverDirectory: 'C:\\a3',
    config: 'C:\\a3\\server.cfg',
    profiles: 'C:\\a3\\profiles',
  };
  for (const refused of [
    '-mod=@1',
    '-serverMod=@1',
    '-config=C:\\other.cfg',
    '-PORT=2402',
    'cfg=basic.cfg',
    '-cfg="a"',
  ])
    assert.equal(
      bohemiaHostSettings.safeParse({ ...base, launchArguments: [refused] })
        .success,
      false,
      refused,
    );
  const host = await fixture({
    settings: {
      launchArguments: ['-cfg=C:\\a3\\basic.cfg', '-name=server', '-dologs'],
    },
  });
  try {
    await host.controller.execute({ action: 'start' });
    await host.controller.idle();
    assert.deepEqual(host.spawned.at(-1)?.args.slice(3), [
      '-cfg=C:\\a3\\basic.cfg',
      '-name=server',
      '-dologs',
    ]);
  } finally {
    await host.controller.close();
    await rm(host.root, { recursive: true, force: true });
  }
});

void test('a server that exits right after start fails the job', async () => {
  const host = await fixture({ crash: () => true });
  try {
    await host.controller.execute({ action: 'start' });
    await host.controller.idle();
    const status = bohemiaHostStatus.parse(
      await host.controller.read('status', new URLSearchParams()),
    );
    assert.equal(status.job?.state, 'failed');
    assert.match(status.job!.message, /stopped \d+ s after it started/);
    assert.equal(status.running, false);
    assert.equal(status.pid, null);
  } finally {
    await host.controller.close();
    await rm(host.root, { recursive: true, force: true });
  }
});

void test('a running server that logs a missing addon requirement fails the job', async () => {
  const host = await fixture({
    started: (profiles) =>
      writeFileSync(
        join(profiles, 'arma3server_x64_2026-11-13_16-44-28.rpt'),
        "16:44:35 Warning Message: Addon 'zen_main' requires addon 'cba_main'\n",
      ),
  });
  try {
    await host.controller.execute({ action: 'start' });
    await host.controller.idle();
    const status = bohemiaHostStatus.parse(
      await host.controller.read('status', new URLSearchParams()),
    );
    assert.equal(status.job?.state, 'failed');
    assert.equal(
      status.job?.message,
      "The server is running, but a mod is missing a requirement: Addon 'zen_main' requires addon 'cba_main'. Add the required mod.",
    );
    assert.equal(status.running, true);
  } finally {
    await host.controller.close();
    await rm(host.root, { recursive: true, force: true });
  }
});

void test('a requirement logged long after the start still fails the job', async () => {
  let written = false;
  const host = await fixture({
    // The line appears on the 60th wait, well after the 20 second check.
    waited: (count, profiles) => {
      if (count < 60 || written) return;
      written = true;
      writeFileSync(
        join(profiles, 'arma3server_x64_2026-11-13_21-52-51.rpt'),
        "21:53:37 Warning Message: Addon 'zen_main' requires addon 'cba_main'\n",
      );
    },
  });
  try {
    await host.controller.execute({ action: 'start' });
    await host.controller.idle();
    const status = bohemiaHostStatus.parse(
      await host.controller.read('status', new URLSearchParams()),
    );
    assert.equal(written, true);
    assert.equal(status.job?.state, 'failed');
    assert.match(status.job!.message, /requires addon 'cba_main'/);
  } finally {
    await host.controller.close();
    await rm(host.root, { recursive: true, force: true });
  }
});

void test('a start ends as soon as the server log says it is ready', async () => {
  let waits = 0;
  const host = await fixture({
    started: (profiles) =>
      writeFileSync(
        join(profiles, 'arma3server_x64_2026-11-13_22-06-10.rpt'),
        '22:06:55 Starting mission:\n',
      ),
    waited: (count) => {
      waits = count;
    },
  });
  try {
    await host.controller.execute({ action: 'start' });
    await host.controller.idle();
    const status = bohemiaHostStatus.parse(
      await host.controller.read('status', new URLSearchParams()),
    );
    assert.equal(status.job?.state, 'succeeded');
    // Only the 20 second check waited. The ready wait did not run.
    assert.ok(waits <= 25, String(waits));
  } finally {
    await host.controller.close();
    await rm(host.root, { recursive: true, force: true });
  }
});

void test('a restart starts again while the old RCON login still looks open', async () => {
  // The login of the stopped server stays open, as BattlEye keeps it.
  let started = false;
  const host = await fixture({
    started: () => {
      started = true;
    },
    externalRunning: () => started,
  });
  try {
    await host.controller.execute({ action: 'start' });
    await host.controller.idle();
    await host.controller.execute({ action: 'restart', confirmation: 'x' });
    await host.controller.idle();
    const status = bohemiaHostStatus.parse(
      await host.controller.read('status', new URLSearchParams()),
    );
    assert.equal(status.job?.state, 'succeeded', status.job?.message);
    assert.equal(status.managed, true);
    assert.equal(host.spawned.length, 2);
  } finally {
    await host.controller.close();
    await rm(host.root, { recursive: true, force: true });
  }
});

void test('a SteamCMD timeout is tried once more', async () => {
  let runs = 0;
  let workshop = '';
  const host = await fixture({
    steam: async () => {
      runs += 1;
      if (runs === 2) await download(workshop, '450814997', 1_700_000_000);
      return runs === 1 ? 5 : 0;
    },
    steamOutput: 'Waiting for user info...ERROR! (Timed out)\n',
  });
  workshop = host.workshop;
  try {
    await host.controller.execute({
      action: 'install-mods',
      ids: ['450814997'],
    });
    await host.controller.idle();
    assert.equal(runs, 2);
  } finally {
    await host.controller.close();
    await rm(host.root, { recursive: true, force: true });
  }
});

void test('SteamCMD without a cached sign-in says how to sign in', async () => {
  const host = await fixture({
    steam: async () => 5,
    steamOutput:
      'Logging in user \x27wg_host\x27 to Steam Public...\nFAILED (Cached credentials not found)\n',
  });
  try {
    await host.controller.execute({
      action: 'install-mods',
      ids: ['450814997'],
    });
    await host.controller.idle();
    const status = bohemiaHostStatus.parse(
      await host.controller.read('status', new URLSearchParams()),
    );
    assert.equal(status.job?.state, 'failed');
    assert.equal(
      status.job?.message,
      'SteamCMD has no saved login for wg_host. Log in once on the host with steamcmd +login wg_host.',
    );
  } finally {
    await host.controller.close();
    await rm(host.root, { recursive: true, force: true });
  }
});

void test('a mod list that breaks the server reverts to the previous list', async () => {
  let crash = false;
  const host = await fixture({ crash: () => crash });
  try {
    await download(host.workshop, '450814997', 1_700_000_000, 'cba_3.bikey');
    await download(host.workshop, '463939057', 1_700_000_000, 'ace_3.bikey');
    const save = async (ids: string[]) => {
      const current = bohemiaHostMods.parse(
        await host.controller.read('mods', new URLSearchParams()),
      );
      await host.controller.execute({
        action: 'save-mods',
        revision: current.revision,
        mods: ids.map((id) => ({ id })),
      });
      return bohemiaHostMods.parse(
        await host.controller.read('mods', new URLSearchParams()),
      ).revision;
    };
    const apply = async (revision: string) => {
      await host.controller.execute({
        action: 'apply-mods',
        revision,
        restart: true,
      });
      await host.controller.idle();
      return bohemiaHostStatus.parse(
        await host.controller.read('status', new URLSearchParams()),
      );
    };
    // There is nothing to revert to before the first apply.
    await assert.rejects(
      host.controller.execute({
        action: 'revert-mods',
        restart: false,
        confirmation: 'x',
      }),
      /no earlier mod list/,
    );
    assert.equal(
      (await apply(await save(['450814997']))).job?.state,
      'succeeded',
    );
    crash = true;
    const broken = await apply(await save(['450814997', '463939057']));
    assert.equal(broken.job?.state, 'failed');
    assert.match(broken.job!.message, /revert to the previous mods/);
    let mods = bohemiaHostMods.parse(
      await host.controller.read('mods', new URLSearchParams()),
    );
    assert.deepEqual(mods.previous, [{ id: '450814997' }]);

    crash = false;
    await host.controller.execute({
      action: 'revert-mods',
      restart: true,
      confirmation: 'x',
    });
    await host.controller.idle();
    const status = bohemiaHostStatus.parse(
      await host.controller.read('status', new URLSearchParams()),
    );
    assert.equal(status.job?.state, 'succeeded', status.job?.message);
    assert.equal(status.running, true);
    mods = bohemiaHostMods.parse(
      await host.controller.read('mods', new URLSearchParams()),
    );
    assert.deepEqual(mods.mods, [{ id: '450814997' }]);
    assert.deepEqual(host.spawned.at(-1)?.args.slice(3), ['-mod=@450814997']);
    assert.deepEqual(await readdir(join(host.server, 'keys')), ['cba_3.bikey']);
  } finally {
    await host.controller.close();
    await rm(host.root, { recursive: true, force: true });
  }
});

void test('agent.json of the previous release is unchanged by host settings', () => {
  // Host settings live in a separate file, so a battleye server entry keeps
  // the exact shape an earlier Agent reads.
  const parsed = parseAgentConfig({
    panel: 'https://warguardian.app',
    servers: [
      {
        serverId: 'demo-arma3',
        secret: `wga_${'x'.repeat(43)}`,
        profile: 'battleye',
        game: 'arma3',
      },
    ],
  });
  assert.equal(parsed.servers[0]!.profile, 'battleye');
  assert.deepEqual(
    bohemiaHostLocations('demo-arma3', {
      configFile: '/etc/warguardian/agent.json',
      stateDirectory: '/var/lib/warguardian-agent',
    }),
    {
      settingsFile: '/etc/warguardian/hosts/demo-arma3.json',
      stateDirectory: '/var/lib/warguardian-agent/hosts/demo-arma3',
    },
  );
  assert.deepEqual(
    bohemiaHostLocations('demo-dayz', {
      configFile: 'C:\\ProgramData\\WarGuardian\\agent.json',
      stateDirectory: 'C:\\ProgramData\\WarGuardian\\state',
    }),
    {
      settingsFile: 'C:\\ProgramData\\WarGuardian\\hosts\\demo-dayz.json',
      stateDirectory: 'C:\\ProgramData\\WarGuardian\\state\\hosts\\demo-dayz',
    },
  );
});

void test('config secrets never leave the host and survive a save', () => {
  const { text, secrets } = redactConfigSecrets(config);
  assert.ok(!text.includes('join-secret'));
  assert.ok(!text.includes('admin-secret'));
  assert.ok(text.includes(`password = "${bohemiaSecretPlaceholder}";`));
  // An empty password stays visible as empty.
  assert.ok(text.includes('serverCommandPassword = "";'));
  const edited = text.replace('maxPlayers = 40', 'maxPlayers = 60');
  const restored = restoreConfigSecrets(edited, secrets);
  assert.ok(restored.includes('password = "join-secret";'));
  assert.ok(restored.includes('passwordAdmin = "admin-secret";'));
  assert.ok(restored.includes('maxPlayers = 60'));
  // A new value replaces the stored one.
  assert.ok(
    restoreConfigSecrets(
      edited.replace(
        `password = "${bohemiaSecretPlaceholder}"`,
        'password = "new"',
      ),
      secrets,
    ).includes('password = "new";'),
  );
});

void test('start, stop and restart run the game with fixed arguments', async () => {
  const host = await fixture();
  try {
    let status = bohemiaHostStatus.parse(
      await host.controller.read('status', new URLSearchParams()),
    );
    assert.equal(status.running, false);
    assert.equal(status.steamcmd, true);
    const started = await host.controller.execute({ action: 'start' });
    assert.equal(started.job?.state, 'running');
    await host.controller.idle();
    status = bohemiaHostStatus.parse(
      await host.controller.read('status', new URLSearchParams()),
    );
    assert.equal(status.running, true);
    assert.equal(status.managed, true);
    assert.equal(status.job?.state, 'succeeded');
    assert.deepEqual(host.spawned.at(-1)?.args, [
      `-config=${join(host.server, 'server.cfg')}`,
      `-profiles=${host.profiles}`,
      '-port=2302',
    ]);
    assert.equal(host.spawned.at(-1)?.detached, true);
    await assert.rejects(
      host.controller.execute({ action: 'stop' }),
      /not valid/,
    );
    await host.controller.execute({ action: 'restart', confirmation: 'x' });
    await host.controller.idle();
    assert.equal(host.spawned.length, 2);
    await host.controller.execute({ action: 'stop', confirmation: 'x' });
    await host.controller.idle();
    status = bohemiaHostStatus.parse(
      await host.controller.read('status', new URLSearchParams()),
    );
    assert.equal(status.running, false);
    assert.equal(status.job?.action, 'stop');
  } finally {
    await host.controller.close();
    await rm(host.root, { recursive: true, force: true });
  }
});

void test('a server that WarGuardian did not start is never started twice or stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wg-bohemia-external-'));
  try {
    await mkdir(join(root, 'p'), { recursive: true });
    await writeFile(join(root, 'server.cfg'), config);
    const controller = await createBohemiaHostController({
      serverId: 'demo-dayz',
      game: 'dayz',
      settings: bohemiaHostSettings.parse({
        executable: join(root, 'DayZServer_x64'),
        serverDirectory: root,
        config: join(root, 'server.cfg'),
        profiles: join(root, 'p'),
      }),
      stateDirectory: join(root, 'state'),
      externalRunning: () => true,
      system: {
        platform: 'linux',
        spawn: () => assert.fail('must not spawn'),
        alive: () => false,
        terminate: () => assert.fail('must not stop'),
        now: Date.now,
        sleep: async () => {},
      },
    });
    const status = bohemiaHostStatus.parse(
      await controller.read('status', new URLSearchParams()),
    );
    assert.equal(status.running, true);
    assert.equal(status.managed, false);
    assert.equal(status.steamcmd, false);
    await controller.execute({ action: 'start' });
    await controller.idle();
    const after = bohemiaHostStatus.parse(
      await controller.read('status', new URLSearchParams()),
    );
    assert.equal(after.job?.state, 'failed');
    assert.match(after.job!.message, /did not start/);
    await controller.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('config edits check the revision and keep the previous file', async () => {
  const host = await fixture();
  try {
    const view = bohemiaHostConfig.parse(
      await host.controller.read('config', new URLSearchParams()),
    );
    assert.equal(view.file, 'server.cfg');
    assert.ok(!view.text.includes('admin-secret'));
    await assert.rejects(
      host.controller.execute({
        action: 'save-config',
        revision: 'a'.repeat(64),
        text: view.text,
      }),
      /changed/,
    );
    await host.controller.execute({
      action: 'save-config',
      revision: view.revision,
      text: view.text.replace('maxPlayers = 40', 'maxPlayers = 64'),
    });
    const saved = await readFile(join(host.server, 'server.cfg'), 'utf8');
    assert.ok(saved.includes('maxPlayers = 64'));
    assert.ok(saved.includes('passwordAdmin = "admin-secret";'));
    assert.equal(
      await readFile(join(host.server, 'server.cfg.wg-previous'), 'utf8'),
      config,
    );
  } finally {
    await host.controller.close();
    await rm(host.root, { recursive: true, force: true });
  }
});

void test('logs list profile files and redact config passwords', async () => {
  const host = await fixture();
  try {
    await writeFile(join(host.profiles, 'DayZServer.ADM'), 'admin log');
    await writeFile(join(host.profiles, 'notes.txt'), 'ignored');
    const logs = bohemiaHostLogs.parse(
      await host.controller.read('logs', new URLSearchParams()),
    );
    assert.deepEqual(logs.files.map((file) => file.kind).sort(), [
      'adm',
      'rpt',
    ]);
    const rpt = bohemiaHostLogs.parse(
      await host.controller.read(
        'logs',
        new URLSearchParams({
          name: 'arma3server_x64_2026-11-12_10-00-00.rpt',
        }),
      ),
    );
    assert.ok(rpt.text.includes('[redacted]'));
    assert.ok(!rpt.text.includes('join-secret'));
    await assert.rejects(
      host.controller.read(
        'logs',
        new URLSearchParams({ name: '../server.cfg' }),
      ),
    );
  } finally {
    await host.controller.close();
    await rm(host.root, { recursive: true, force: true });
  }
});

void test('mods download with SteamCMD, link as @id, copy keys and launch in order', async () => {
  const host = await fixture({
    steam: async (args) => {
      const ids: string[] = [];
      args.forEach((arg, index) => {
        if (arg === '+workshop_download_item') ids.push(args[index + 2]!);
      });
      for (const id of ids)
        await download(
          host.workshop,
          id,
          1_700_000_000,
          id === '450814997' ? 'cba_3.bikey' : undefined,
        );
      return 0;
    },
  });
  try {
    let mods = bohemiaHostMods.parse(
      await host.controller.read('mods', new URLSearchParams()),
    );
    await host.controller.execute({
      action: 'save-mods',
      revision: mods.revision,
      mods: [
        { id: '450814997', name: 'CBA_A3' },
        { id: '1779063631', serverOnly: true },
        { id: '333310405', enabled: false },
      ],
    });
    await assert.rejects(
      host.controller.execute({
        action: 'save-mods',
        revision: mods.revision,
        mods: [],
      }),
      /changed/,
    );
    mods = bohemiaHostMods.parse(
      await host.controller.read('mods', new URLSearchParams()),
    );
    // Applying before the download names the missing mods.
    await host.controller.execute({
      action: 'apply-mods',
      revision: mods.revision,
      restart: false,
    });
    await host.controller.idle();
    let status = bohemiaHostStatus.parse(
      await host.controller.read('status', new URLSearchParams()),
    );
    assert.equal(status.job?.state, 'failed');
    assert.match(status.job!.message, /450814997, 1779063631/);

    await host.controller.execute({
      action: 'install-mods',
      ids: ['450814997', '1779063631'],
    });
    await host.controller.idle();
    const steam = host.spawned.find((call) => call.file.endsWith('steamcmd'))!;
    assert.deepEqual(steam.args, [
      '+force_install_dir',
      host.workshop,
      '+login',
      'wg_host',
      '+workshop_download_item',
      '107410',
      '450814997',
      'validate',
      '+workshop_download_item',
      '107410',
      '1779063631',
      'validate',
      '+quit',
    ]);
    mods = bohemiaHostMods.parse(
      await host.controller.read('mods', new URLSearchParams()),
    );
    assert.deepEqual(
      mods.installed
        .map((mod) => [mod.id, mod.installedAt, mod.name])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [
        ['1779063631', 1_700_000_000, 'Mod 1779063631'],
        ['450814997', 1_700_000_000, 'Mod 450814997'],
      ],
    );

    // An existing key that WarGuardian did not copy is never replaced.
    await mkdir(join(host.server, 'keys'), { recursive: true });
    await writeFile(join(host.server, 'keys', 'a3.bikey'), 'bohemia');

    await host.controller.execute({
      action: 'apply-mods',
      revision: mods.revision,
      restart: true,
    });
    await host.controller.idle();
    status = bohemiaHostStatus.parse(
      await host.controller.read('status', new URLSearchParams()),
    );
    assert.equal(status.job?.state, 'succeeded', status.job?.message);
    assert.equal(status.running, true);
    assert.equal(status.restartPending, false);
    const link = join(host.server, '@450814997');
    assert.ok((await lstat(link)).isSymbolicLink());
    assert.match(await readlink(link), /450814997/);
    assert.deepEqual((await readdir(join(host.server, 'keys'))).sort(), [
      'a3.bikey',
      'cba_3.bikey',
    ]);
    assert.deepEqual(host.spawned.at(-1)!.args.slice(3), [
      '-mod=@450814997',
      '-serverMod=@1779063631',
    ]);

    // Removing a mod removes its link and only the key WarGuardian copied.
    mods = bohemiaHostMods.parse(
      await host.controller.read('mods', new URLSearchParams()),
    );
    assert.deepEqual(mods.keys, ['cba_3.bikey']);
    await host.controller.execute({
      action: 'save-mods',
      revision: mods.revision,
      mods: [{ id: '1779063631', serverOnly: true }],
    });
    mods = bohemiaHostMods.parse(
      await host.controller.read('mods', new URLSearchParams()),
    );
    await host.controller.execute({
      action: 'apply-mods',
      revision: mods.revision,
      restart: false,
    });
    await host.controller.idle();
    status = bohemiaHostStatus.parse(
      await host.controller.read('status', new URLSearchParams()),
    );
    assert.equal(status.restartPending, true);
    await assert.rejects(lstat(link));
    assert.deepEqual(await readdir(join(host.server, 'keys')), ['a3.bikey']);
  } finally {
    await host.controller.close();
    await rm(host.root, { recursive: true, force: true });
  }
});

void test('a failed SteamCMD download fails the job and links nothing', async () => {
  const host = await fixture({ steam: async () => 5 });
  try {
    await host.controller.execute({
      action: 'install-mods',
      ids: ['450814997'],
    });
    await host.controller.idle();
    const status = bohemiaHostStatus.parse(
      await host.controller.read('status', new URLSearchParams()),
    );
    assert.equal(status.job?.state, 'failed');
    assert.match(status.job!.message, /SteamCMD failed for 450814997/);
    assert.deepEqual(
      (await readdir(host.server)).filter((name) => name.startsWith('@')),
      [],
    );
  } finally {
    await host.controller.close();
    await rm(host.root, { recursive: true, force: true });
  }
});

void test('backups restore the profiles folder and config after checks', async () => {
  const host = await fixture();
  try {
    await host.controller.execute({ action: 'backup', name: 'Before wipe' });
    await host.controller.idle();
    const { backups } = bohemiaHostBackups.parse(
      await host.controller.read('backups', new URLSearchParams()),
    );
    assert.equal(backups.length, 1);
    assert.equal(backups[0]!.name, 'Before wipe');
    assert.equal(backups[0]!.files, 1);
    await writeFile(join(host.profiles, 'new.log'), 'after');
    await writeFile(join(host.server, 'server.cfg'), 'hostname = "changed";\n');
    await host.controller.execute({
      action: 'restore',
      id: backups[0]!.id,
      confirmation: 'x',
    });
    await host.controller.idle();
    const status = bohemiaHostStatus.parse(
      await host.controller.read('status', new URLSearchParams()),
    );
    assert.equal(status.job?.state, 'succeeded', status.job?.message);
    assert.deepEqual(await readdir(host.profiles), [
      'arma3server_x64_2026-11-12_10-00-00.rpt',
    ]);
    assert.equal(
      await readFile(join(host.server, 'server.cfg'), 'utf8'),
      config,
    );
    assert.ok(
      (await readdir(`${host.profiles}.wg-previous`)).includes('new.log'),
    );
    await host.controller.execute({
      action: 'remove-backup',
      id: backups[0]!.id,
      confirmation: 'x',
    });
    assert.deepEqual(
      bohemiaHostBackups.parse(
        await host.controller.read('backups', new URLSearchParams()),
      ).backups,
      [],
    );
  } finally {
    await host.controller.close();
    await rm(host.root, { recursive: true, force: true });
  }
});

void test('a job that was running when the Agent stopped becomes unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wg-bohemia-restart-'));
  try {
    await mkdir(join(root, 'state'), { recursive: true });
    await writeFile(
      join(root, 'state', 'state.json'),
      JSON.stringify({
        v: 1,
        job: {
          id: 'job-1',
          action: 'install-mods',
          state: 'running',
          message: 'Running',
          startedAt: 1,
          finishedAt: null,
        },
      }),
    );
    const controller = await createBohemiaHostController({
      serverId: 'demo-arma3',
      game: 'arma3',
      settings: bohemiaHostSettings.parse({
        executable: join(root, 'arma3server_x64'),
        serverDirectory: root,
        config: join(root, 'server.cfg'),
        profiles: root,
      }),
      stateDirectory: join(root, 'state'),
    });
    const status = bohemiaHostStatus.parse(
      await controller.read('status', new URLSearchParams()),
    );
    assert.equal(status.job?.state, 'unknown');
    await controller.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('the relay passes every host action to the Agent', () => {
  assert.deepEqual(
    [...nativeHostActions].sort(),
    bohemiaHostCommand.options
      .map((option) => option.shape.action.value)
      .sort(),
  );
});

const windows = process.platform === 'win32' && process.arch === 'x64';

void test(
  'on Windows the game server outlives the Agent that started it and a SteamCMD download does not',
  { skip: !windows, timeout: 120_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'wg-bohemia-win-'));
    const server = join(root, 'server');
    const game = join(server, 'arma3server_x64.exe');
    const steamcmd = join(root, 'steamcmd.exe');
    for (const name of ['server', 'profiles', 'workshop'])
      await mkdir(join(root, name));
    await writeFile(join(server, 'server.cfg'), config);
    await idleExecutable(server, 'arma3server_x64.exe');
    await link(game, steamcmd);
    /** One Agent process that runs a host command and exits. */
    const agent = async (mode: string) =>
      bohemiaHostStatus.parse(
        JSON.parse(
          (
            await promisify(execFile)(process.execPath, [
              ...process.execArgv,
              join(import.meta.dirname, 'support/bohemia-host-process.ts'),
              root,
              mode,
            ])
          ).stdout,
        ),
      );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const gone = async (pid: number) => {
      for (let wait = 0; wait < 100 && alive(pid); wait += 1)
        await new Promise((resolve) => setTimeout(resolve, 50));
      return !alive(pid);
    };
    const started: number[] = [];
    try {
      const status = await agent('start');
      assert.equal(status.job?.message, 'Server started.');
      const pid = status.pid!;
      started.push(pid);
      assert.equal(Number(await readFile(`${game}.pid`, 'utf8')), pid);
      // The Agent process has ended. Give Windows time to end its children.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(alive(pid), true);
      // The next Agent process still manages that server and stops it.
      const stopped = await agent('stop');
      assert.equal(stopped.job?.message, 'Server stopped.');
      assert.equal(stopped.running, false);
      assert.equal(await gone(pid), true);

      const downloading = await agent('download');
      assert.equal(downloading.job?.action, 'install-mods');
      const steam = Number(await readFile(`${steamcmd}.pid`, 'utf8'));
      started.push(steam);
      assert.equal(await gone(steam), true);
    } finally {
      for (const pid of started)
        try {
          process.kill(pid);
        } catch {
          /* It ended. */
        }
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 250,
      });
    }
  },
);
