import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync, gzipSync } from 'node:zlib';
import {
  archivePath,
  readTarGz,
  readZip,
} from '../src/games/archive';
import {
  createRustHostController,
  redactRustConfig,
  restoreRustConfig,
  rustHostSettings,
  rustWipeFile,
} from '../src/games/rust-host';

// The Rust game host of the Agent on a temporary server folder. No game and
// no SteamCMD runs: the system calls are replaced.

const plugin = (name: string, body = '') =>
  `namespace Oxide.Plugins\n{\n  class ${name} : RustPlugin { ${body} }\n}\n`;

async function fixture(
  options: { oxide?: boolean; steamcmd?: boolean; autoRestart?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'wg-rust-host-'));
  const serverDirectory = join(root, 'rust');
  const save = join(serverDirectory, 'server', 'main');
  await mkdir(join(save, 'cfg'), { recursive: true });
  await writeFile(
    join(save, 'cfg', 'server.cfg'),
    'server.hostname "Island"\nrcon.password "Secret-Pass9"\n',
  );
  for (const name of [
    'proceduralmap.3000.5.290.map',
    'proceduralmap.3000.5.290.sav',
    'proceduralmap.3000.5.290.sav.1',
    'proceduralmap.3000.5.290.navmesh',
    'proceduralmap.3000.5.290_occlusion_3.dat',
    'player.blueprints.19.db',
    'player.blueprints.19.db-wal',
    'player.states.290.db',
    'clans.290.db',
    'Log.EAC.txt',
  ])
    await writeFile(join(save, name), name);
  if (options.oxide) {
    await mkdir(join(serverDirectory, 'RustDedicated_Data', 'Managed'), {
      recursive: true,
    });
    await writeFile(
      join(serverDirectory, 'RustDedicated_Data', 'Managed', 'Oxide.Rust.dll'),
      '',
    );
    await mkdir(join(serverDirectory, 'oxide', 'plugins'), { recursive: true });
    await mkdir(join(serverDirectory, 'oxide', 'config'), { recursive: true });
    await writeFile(
      join(serverDirectory, 'oxide', 'config', 'Vanish.json'),
      '{}',
    );
  }
  const settingsFile = join(root, 'island.json');
  const settings = rustHostSettings.parse({
    executable: join(serverDirectory, 'RustDedicated'),
    serverDirectory,
    identity: 'main',
    seed: 5,
    worldSize: 3000,
    ...(options.steamcmd ? { steamcmd: join(root, 'steamcmd.sh') } : {}),
    autoRestart: !!options.autoRestart,
    launchArguments: ['+server.port 28015', '+rcon.web 1', '-silent-crashes'],
  });
  await writeFile(settingsFile, JSON.stringify(settings));
  let clock = 1_800_000_000_000;
  let nextPid = 100;
  const alive = new Set<number>();
  const spawned: { file: string; args: string[] }[] = [];
  let quits = 0;
  const downloads = new Map<string, string | Buffer>();
  const steam: { ran?: () => Promise<void> } = {};
  const controller = await createRustHostController({
    serverId: 'island',
    settings,
    settingsFile,
    stateDirectory: join(root, 'state'),
    startCheckMs: 1_000,
    stopWaitMs: 2_000,
    quit: async () => {
      quits += 1;
      alive.clear();
    },
    download: async (url) => {
      const file = downloads.get(url);
      if (file === undefined)
        throw new Error('uMod has no plugin with this name.');
      return Buffer.from(file);
    },
    system: {
      platform: 'linux',
      spawn(file, args) {
        spawned.push({ file, args: [...args] });
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          unref(): void;
          kill(): void;
          stdout: null;
          stderr: null;
        };
        child.pid = nextPid += 1;
        child.unref = () => undefined;
        child.kill = () => undefined;
        child.stdout = null;
        child.stderr = null;
        if (file.endsWith('steamcmd.sh'))
          void (steam.ran?.() ?? Promise.resolve()).then(() =>
            child.emit('exit', 0),
          );
        else alive.add(child.pid);
        return child as never;
      },
      alive: (pid) => alive.has(pid),
      terminate: (pid) => void alive.delete(pid),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  });
  const run = async (command: unknown) => {
    const receipt = await controller.execute(command);
    await controller.idle();
    const status = (await controller.read('status', new URLSearchParams())) as {
      job: { state: string; message: string } | null;
      running: boolean;
    };
    return { receipt, job: status.job, running: status.running };
  };
  return {
    root,
    save,
    serverDirectory,
    settingsFile,
    controller,
    run,
    spawned,
    downloads,
    steam,
    quits: () => quits,
    crash: () => alive.clear(),
    advance: (ms: number) => {
      clock += ms;
    },
    files: async () => (await readdir(save)).sort(),
    close: async () => {
      await controller.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

void test('the settings refuse launch parameters that the Agent sets itself', () => {
  const base = {
    executable: '/srv/rust/RustDedicated',
    serverDirectory: '/srv/rust',
    identity: 'main',
  };
  assert.ok(rustHostSettings.safeParse(base).success);
  for (const launchArguments of [
    ['+server.identity other'],
    ['+server.seed 9'],
    ['-logfile /tmp/x'],
    ['server.port 1'],
    ['+server.hostname "quoted"'],
    ['+a b\nc'],
  ])
    assert.ok(
      !rustHostSettings.safeParse({ ...base, launchArguments }).success,
      launchArguments[0],
    );
  assert.ok(!rustHostSettings.safeParse({ ...base, identity: '../x' }).success);
});

void test('a wipe names the map files, and a full wipe the player databases too', () => {
  for (const name of [
    'proceduralmap.3000.5.290.map',
    'proceduralmap.3000.5.290.sav',
    'proceduralmap.3000.5.290.sav.2',
    'proceduralmap.3000.5.290.navmesh',
    'proceduralmap.3000.5.290_occlusion_3.dat',
  ])
    assert.ok(rustWipeFile(name, 'map'), name);
  for (const name of [
    'player.blueprints.19.db',
    'player.blueprints.19.db-wal',
    'player.states.290.db',
    'player.tokens.db',
    'sv.files.290.db',
  ]) {
    assert.ok(!rustWipeFile(name, 'map'), name);
    assert.ok(rustWipeFile(name, 'full'), name);
  }
  for (const name of ['clans.290.db', 'Log.EAC.txt', 'server.cfg', 'cfg'])
    assert.ok(!rustWipeFile(name, 'full'), name);
});

void test('the RCON password never leaves the host and is kept when the editor keeps the placeholder', () => {
  const raw = 'rcon.port 28016\nrcon.password "Secret-Pass9"\n';
  const redacted = redactRustConfig(raw);
  assert.ok(!redacted.text.includes('Secret-Pass9'));
  assert.equal(redacted.secret, 'Secret-Pass9');
  assert.equal(restoreRustConfig(redacted.text, redacted.secret), raw);
  assert.equal(
    restoreRustConfig('rcon.password "New-Pass1"\n', redacted.secret),
    'rcon.password "New-Pass1"\n',
  );
  assert.throws(() => restoreRustConfig(redacted.text, null));
});

void test('the host starts, stops, wipes and updates the server with arguments it builds itself', async () => {
  const host = await fixture({ steamcmd: true });
  try {
    const started = await host.run({ action: 'start' });
    assert.equal(started.job?.state, 'succeeded');
    assert.equal(started.running, true);
    const launch = host.spawned[0]!;
    assert.ok(launch.file.endsWith('RustDedicated'));
    assert.deepEqual(launch.args.slice(0, 13), [
      '-batchmode',
      '-nographics',
      '+server.identity',
      'main',
      '+server.seed',
      '5',
      '+server.worldsize',
      '3000',
      '+server.port',
      '28015',
      '+rcon.web',
      '1',
      '-silent-crashes',
    ]);
    assert.equal(launch.args.at(-2), '-logfile');
    // A second start is refused while it runs.
    assert.equal((await host.run({ action: 'start' })).job?.state, 'failed');

    // A map wipe stops with a save, backs up, removes the map files, sets
    // the new seed and starts again.
    const wiped = await host.run({
      action: 'wipe',
      kind: 'map',
      seed: 77,
      worldSize: 4000,
      confirmation: 'island',
    });
    assert.equal(wiped.job?.state, 'succeeded', wiped.job?.message);
    assert.equal(host.quits(), 1);
    assert.deepEqual(await host.files(), [
      'Log.EAC.txt',
      'cfg',
      'clans.290.db',
      'player.blueprints.19.db',
      'player.blueprints.19.db-wal',
      'player.states.290.db',
    ]);
    assert.equal(wiped.running, true);
    assert.deepEqual(host.spawned.at(-1)!.args.slice(4, 8), [
      '+server.seed',
      '77',
      '+server.worldsize',
      '4000',
    ]);
    assert.equal(
      (
        JSON.parse(await readFile(host.settingsFile, 'utf8')) as {
          seed: number;
        }
      ).seed,
      77,
    );
    const backups = (await host.controller.read(
      'backups',
      new URLSearchParams(),
    )) as { backups: { id: string; name: string; files: number }[] };
    assert.equal(backups.backups[0]?.name, 'Before map wipe');
    assert.ok(backups.backups[0]!.files >= 10);

    // A full wipe removes the player databases as well.
    await host.run({ action: 'wipe', kind: 'full', confirmation: 'island' });
    assert.deepEqual(await host.files(), [
      'Log.EAC.txt',
      'cfg',
      'clans.290.db',
    ]);

    // A restore needs a stopped server and puts the files back.
    const id = backups.backups[0]!.id;
    assert.equal(
      (await host.run({ action: 'restore', id, confirmation: 'island' })).job
        ?.state,
      'failed',
    );
    assert.equal(
      (await host.run({ action: 'stop', confirmation: 'island' })).running,
      false,
    );
    assert.equal(
      (await host.run({ action: 'restore', id, confirmation: 'island' })).job
        ?.state,
      'succeeded',
    );
    assert.ok((await host.files()).includes('proceduralmap.3000.5.290.sav'));

    // The update runs SteamCMD with fixed anonymous arguments.
    const updated = await host.run({
      action: 'update',
      confirmation: 'island',
    });
    assert.equal(updated.job?.message, 'Updated.');
    const steam = host.spawned.at(-1)!;
    assert.ok(steam.file.endsWith('steamcmd.sh'));
    assert.deepEqual(steam.args, [
      '+force_install_dir',
      host.serverDirectory,
      '+login',
      'anonymous',
      '+app_update',
      '258550',
      'validate',
      '+quit',
    ]);
    // It did not run before, so it is not started.
    assert.equal(updated.running, false);

    // Anything but a known command is refused.
    for (const command of [
      { action: 'run', line: 'rm -rf /' },
      { action: 'wipe', kind: 'everything', confirmation: 'island' },
      { action: 'install-plugin', name: '../x' },
      { action: 'restore', id: '../../etc', confirmation: 'island' },
    ])
      await assert.rejects(host.controller.execute(command));
  } finally {
    await host.close();
  }
});

void test('a server that ends by itself is started again, but not without end', async () => {
  const host = await fixture({ autoRestart: true });
  try {
    // Nothing is started that was never started here.
    assert.equal(await host.controller.watch(), false);
    await host.run({ action: 'start' });
    assert.equal(await host.controller.watch(), false);
    for (let round = 0; round < 3; round++) {
      host.crash();
      assert.equal(await host.controller.watch(), true, `round ${round}`);
      await host.controller.idle();
      host.advance(60_000);
    }
    const status = (await host.controller.read(
      'status',
      new URLSearchParams(),
    )) as { running: boolean; job: { action: string } };
    assert.equal(status.running, true);
    assert.equal(status.job.action, 'auto-restart');
    // The fourth crash within ten minutes is left alone.
    host.crash();
    assert.equal(await host.controller.watch(), false);
    assert.equal(await host.controller.watch(), false);
    // A stop from the panel is never undone.
    await host.run({ action: 'start' });
    await host.run({ action: 'stop', confirmation: 'island' });
    host.advance(3_600_000);
    assert.equal(await host.controller.watch(), false);
  } finally {
    await host.close();
  }
  // Without the setting a crash is left alone.
  const plain = await fixture();
  try {
    await plain.run({ action: 'start' });
    plain.crash();
    assert.equal(await plain.controller.watch(), false);
  } finally {
    await plain.close();
  }
});

void test('the config is read without the password and saved against its revision', async () => {
  const host = await fixture();
  try {
    const config = (await host.controller.read(
      'config',
      new URLSearchParams(),
    )) as { revision: string; file: string; text: string };
    assert.equal(config.file, 'server.cfg');
    assert.ok(!config.text.includes('Secret-Pass9'));
    await assert.rejects(
      host.controller.execute({
        action: 'save-config',
        revision: '0'.repeat(64),
        text: config.text,
      }),
    );
    await host.controller.execute({
      action: 'save-config',
      revision: config.revision,
      text: config.text.replace('Island', 'Mainland'),
    });
    const saved = await readFile(join(host.save, 'cfg', 'server.cfg'), 'utf8');
    assert.equal(
      saved,
      'server.hostname "Mainland"\nrcon.password "Secret-Pass9"\n',
    );
    // A wipe cannot change the seed of a server whose seed it does not set.
  } finally {
    await host.close();
  }
});

/** A zip archive of the given files, deflated. */
function zipOf(files: [name: string, body: string][]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const body = Buffer.from(text);
    const data = deflateRawSync(body);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(Buffer.byteLength(name), 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(Buffer.byteLength(name), 28);
    entry.writeUInt32LE(offset, 42);
    local.push(header, Buffer.from(name), data);
    central.push(entry, Buffer.from(name));
    offset += 30 + Buffer.byteLength(name) + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/** A gzipped tar archive of the given files. */
function tarGzOf(files: [name: string, body: string, mode?: number][]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text, mode = 0o644] of files) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write(mode.toString(8).padStart(7, '0'), 100, 8);
    header.write(body.length.toString(8).padStart(11, '0'), 124, 12);
    header.write('0', 156, 1);
    header.write('ustar', 257, 6);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

void test('an archive is read into plain files, and an unsafe path refuses it whole', () => {
  const zip = readZip(
    zipOf([
      ['oxide/readme.txt', 'read me'],
      ['RustDedicated_Data\\Managed\\Oxide.Rust.dll', 'dll'],
    ]),
  );
  assert.deepEqual(
    zip.map((file) => [file.name, file.data.toString()]),
    [
      ['oxide/readme.txt', 'read me'],
      ['RustDedicated_Data/Managed/Oxide.Rust.dll', 'dll'],
    ],
  );
  const tar = readTarGz(
    tarGzOf([
      ['./carbon/managed/Carbon.dll', 'dll'],
      ['carbon/tools/environment.sh', '#!/bin/sh', 0o755],
    ]),
  );
  assert.deepEqual(
    tar.map((file) => [file.name, file.mode]),
    [
      ['carbon/managed/Carbon.dll', 0o644],
      ['carbon/tools/environment.sh', 0o755],
    ],
  );
  for (const name of ['../evil', '/etc/passwd', 'C:/Windows/x', 'a/../../b'])
    assert.equal(archivePath(name), null, name);
  assert.equal(archivePath('./a//b'), 'a/b');
  assert.throws(() => readZip(zipOf([['../evil.dll', 'x']])));
  assert.throws(() => readTarGz(tarGzOf([['../../evil', 'x']])));
  assert.throws(() => readZip(Buffer.from('<html>')));
  assert.throws(() => readTarGz(Buffer.from('<html>')));
  assert.throws(() =>
    readZip(zipOf([['a.txt', 'x'.repeat(100)]]), { maxFiles: 5, maxBytes: 10 }),
  );
});

void test('Oxide or Carbon is installed from its release, never both, and Oxide returns after a game update', async () => {
  const host = await fixture({ steamcmd: true });
  const oxide =
    'https://github.com/OxideMod/Oxide.Rust/releases/latest/download/Oxide.Rust-linux.zip';
  const carbon =
    'https://github.com/CarbonCommunity/Carbon/releases/download/production_build/Carbon.Linux.Release.tar.gz';
  const marker = join(
    host.serverDirectory,
    'RustDedicated_Data',
    'Managed',
    'Oxide.Rust.dll',
  );
  try {
    // A release with an unsafe path, or without the framework, writes nothing.
    host.downloads.set(oxide, zipOf([['../outside.dll', 'x']]));
    assert.equal(
      (
        await host.run({
          action: 'install-framework',
          framework: 'oxide',
          confirmation: 'island',
        })
      ).job?.state,
      'failed',
    );
    host.downloads.set(oxide, zipOf([['readme.txt', 'x']]));
    assert.equal(
      (
        await host.run({
          action: 'install-framework',
          framework: 'oxide',
          confirmation: 'island',
        })
      ).job?.message,
      'The downloaded release is not the expected one.',
    );
    assert.deepEqual(await readdir(host.root), [
      'island.json',
      'rust',
      'state',
    ]);

    host.downloads.set(
      oxide,
      zipOf([
        ['RustDedicated_Data/Managed/Oxide.Rust.dll', 'oxide'],
        ['RustDedicated_Data/Managed/Oxide.Core.dll', 'core'],
      ]),
    );
    await host.run({ action: 'start' });
    const installed = await host.run({
      action: 'install-framework',
      framework: 'oxide',
      confirmation: 'island',
    });
    assert.equal(
      installed.job?.message,
      'Installed Oxide: 2 files. Server started.',
    );
    assert.equal(await readFile(marker, 'utf8'), 'oxide');
    assert.equal(
      (
        (await host.controller.read('status', new URLSearchParams())) as {
          framework: string;
        }
      ).framework,
      'oxide',
    );
    // A server runs one framework.
    host.downloads.set(
      carbon,
      tarGzOf([['carbon/managed/Carbon.dll', 'carbon']]),
    );
    const second = await host.run({
      action: 'install-framework',
      framework: 'carbon',
      confirmation: 'island',
    });
    assert.equal(second.job?.state, 'failed');
    assert.ok(second.job?.message.includes('one plugin framework'));

    // The game update removes Oxide, and the Agent puts it back.
    host.steam.ran = () => rm(marker);
    const updated = await host.run({
      action: 'update',
      confirmation: 'island',
    });
    assert.equal(
      updated.job?.message,
      'Updated. Oxide was updated too. Server started.',
    );
    assert.equal(await readFile(marker, 'utf8'), 'oxide');
  } finally {
    await host.close();
  }
  // Carbon on a server without a framework.
  const bare = await fixture();
  try {
    bare.downloads.set(
      carbon,
      tarGzOf([
        ['carbon/managed/Carbon.dll', 'carbon'],
        ['carbon/tools/environment.sh', '#!/bin/sh', 0o755],
      ]),
    );
    const installed = await bare.run({
      action: 'install-framework',
      framework: 'carbon',
      confirmation: 'island',
    });
    assert.equal(installed.job?.message, 'Installed Carbon: 2 files.');
    assert.deepEqual(
      await bare.controller.read('plugins', new URLSearchParams()),
      { framework: 'carbon', plugins: [], upload: true },
    );
  } finally {
    await bare.close();
  }
});

void test('plugins are installed from uMod by name, and the replaced file is kept', async () => {
  const bare = await fixture();
  try {
    assert.deepEqual(
      await bare.controller.read('plugins', new URLSearchParams()),
      { framework: null, plugins: [] },
    );
    assert.equal(
      (await bare.run({ action: 'install-plugin', name: 'Vanish' })).job?.state,
      'failed',
    );
  } finally {
    await bare.close();
  }
  const host = await fixture({ oxide: true });
  try {
    host.downloads.set(
      'https://umod.org/plugins/Vanish.cs',
      plugin('Vanish', '/* 1 */'),
    );
    host.downloads.set(
      'https://umod.org/plugins/Page.cs',
      '<html>Not found</html>',
    );
    const first = await host.run({ action: 'install-plugin', name: 'Vanish' });
    assert.equal(first.job?.message, 'Installed Vanish.');
    // A file that is not a plugin is not written.
    assert.equal(
      (await host.run({ action: 'install-plugin', name: 'Page' })).job?.state,
      'failed',
    );
    assert.equal(
      (await host.run({ action: 'install-plugin', name: 'Missing' })).job
        ?.state,
      'failed',
    );
    const folder = join(host.serverDirectory, 'oxide', 'plugins');
    assert.deepEqual(await readdir(folder), ['Vanish.cs']);
    // An update keeps the earlier file, and a rollback puts it back.
    host.downloads.set(
      'https://umod.org/plugins/Vanish.cs',
      plugin('Vanish', '/* 2 */'),
    );
    await host.run({ action: 'install-plugin', name: 'Vanish' });
    assert.ok(
      (await readFile(join(folder, 'Vanish.cs'), 'utf8')).includes('/* 2 */'),
    );
    const listed = (await host.controller.read(
      'plugins',
      new URLSearchParams(),
    )) as { framework: string; plugins: { name: string; previous: boolean }[] };
    assert.equal(listed.framework, 'oxide');
    assert.deepEqual(
      listed.plugins.map((entry) => [entry.name, entry.previous]),
      [['Vanish', true]],
    );
    await host.controller.execute({
      action: 'rollback-plugin',
      name: 'Vanish',
    });
    assert.ok(
      (await readFile(join(folder, 'Vanish.cs'), 'utf8')).includes('/* 1 */'),
    );
    await host.controller.execute({
      action: 'remove-plugin',
      name: 'Vanish',
      confirmation: 'island',
    });
    assert.deepEqual(await readdir(folder), []);
    // The removed file can still be put back.
    await host.controller.execute({
      action: 'rollback-plugin',
      name: 'Vanish',
    });
    assert.deepEqual(await readdir(folder), ['Vanish.cs']);
  } finally {
    await host.close();
  }
});

void test('an uploaded plugin file arrives in parts and is written like an install', async () => {
  const host = await fixture({ oxide: true });
  try {
    const folder = join(host.serverDirectory, 'oxide', 'plugins');
    await writeFile(join(folder, 'Vanish.cs'), plugin('Vanish', '/* 1 */'));
    const listed = (await host.controller.read(
      'plugins',
      new URLSearchParams(),
    )) as { upload?: boolean };
    assert.equal(listed.upload, true);
    // The parts of one file, three bytes each unless a size is given.
    const parts = (name: string, file: Buffer, size = 3) =>
      Array.from({ length: Math.ceil(file.length / size) }, (_, at) => ({
        action: 'upload-plugin',
        name,
        offset: at * size,
        total: file.length,
        sha256: createHash('sha256').update(file).digest('hex'),
        data: file.subarray(at * size, at * size + size).toString('base64'),
      }));
    const send = async (commands: object[]) => {
      let message = '';
      for (const command of commands)
        message = (await host.controller.execute(command)).message;
      return message;
    };

    // A new plugin, sent in many parts.
    const vault = Buffer.from(plugin('TeamVault', '/* 1 */'));
    assert.equal(
      await send(parts('TeamVault', vault, 40)),
      'Uploaded TeamVault.',
    );
    assert.equal(
      await readFile(join(folder, 'TeamVault.cs'), 'utf8'),
      vault.toString(),
    );
    // A file for an installed plugin keeps the earlier file for a rollback.
    const next = Buffer.from(plugin('Vanish', '/* 2 */'));
    await send(parts('Vanish', next, 40_960));
    assert.ok(
      (await readFile(join(folder, 'Vanish.cs'), 'utf8')).includes('/* 2 */'),
    );
    await host.controller.execute({
      action: 'rollback-plugin',
      name: 'Vanish',
    });
    assert.ok(
      (await readFile(join(folder, 'Vanish.cs'), 'utf8')).includes('/* 1 */'),
    );

    // A part out of order ends the upload, and nothing is written.
    const [first, , third] = parts('Kits', Buffer.from(plugin('Kits')), 20);
    assert.ok(first && third);
    await host.controller.execute(first);
    await assert.rejects(host.controller.execute(third), /interrupted/);
    await assert.rejects(host.controller.execute(third), /interrupted/);
    // A file that does not match its SHA-256 is not written.
    const wrong = parts('Kits', Buffer.from(plugin('Kits')), 40_960).map(
      (part) => ({ ...part, sha256: 'a'.repeat(64) }),
    );
    await assert.rejects(send(wrong), /interrupted/);
    // The whole file is checked again here: text that names a plugin class.
    for (const body of [
      Buffer.from('PK\u0003\u0004 archive'),
      Buffer.concat([Buffer.from(plugin('Kits')), Buffer.from([0])]),
      Buffer.from([0xff, 0xfe, 0x41]),
    ])
      await assert.rejects(
        send(parts('Kits', body, 40_960)),
        /not a plugin source/,
      );
    // A name that could leave the folder is not a valid command.
    for (const name of ['../Kits', 'Kits.cs', 'a/b', ''])
      await assert.rejects(
        send(parts(name, Buffer.from(plugin('Kits')), 40_960)),
        /not valid/,
      );
    // A part larger than one relay command holds is not a valid command.
    await assert.rejects(
      send(parts('Kits', Buffer.alloc(60_000, 0x20), 50_000)),
      /not valid/,
    );
    // A folder or a link under the name of the plugin file is not replaced.
    await mkdir(join(folder, 'Folder.cs'));
    await assert.rejects(
      send(parts('Folder', Buffer.from(plugin('Folder')), 40_960)),
      /cannot be replaced/,
    );
    assert.deepEqual((await readdir(folder)).sort(), [
      'Folder.cs',
      'TeamVault.cs',
      'Vanish.cs',
    ]);
  } finally {
    await host.close();
  }
});

void test('every plugin is downloaded again, and each one reports what happened', async () => {
  const host = await fixture({ oxide: true });
  try {
    const folder = join(host.serverDirectory, 'oxide', 'plugins');
    await writeFile(join(folder, 'Vanish.cs'), plugin('Vanish', '/* 1 */'));
    await writeFile(join(folder, 'Kits.cs'), plugin('Kits'));
    await writeFile(join(folder, 'Page.cs'), plugin('Page'));
    await writeFile(join(folder, 'Own.cs'), plugin('Own'));
    host.downloads.set(
      'https://umod.org/plugins/Vanish.cs',
      plugin('Vanish', '/* 2 */'),
    );
    host.downloads.set('https://umod.org/plugins/Kits.cs', plugin('Kits'));
    host.downloads.set('https://umod.org/plugins/Page.cs', '<html></html>');
    const done = await host.run({ action: 'update-plugins' });
    assert.equal(done.job?.message, 'Updated 1 of 4 plugins.');
    const listed = (await host.controller.read(
      'plugins',
      new URLSearchParams(),
    )) as {
      plugins: { name: string; previous: boolean }[];
      updates?: { results: { name: string; result: string }[] };
    };
    // The download of the fixture has no file for `Own`, as a failed read.
    // This host has no console, so the new file is not reloaded.
    assert.deepEqual(listed.updates?.results, [
      { name: 'Kits', result: 'current' },
      { name: 'Own', result: 'failed' },
      { name: 'Page', result: 'failed' },
      { name: 'Vanish', result: 'updated', reloaded: false },
    ]);
    // Only the changed plugin was written, and its earlier file is kept.
    assert.deepEqual(
      listed.plugins
        .filter((entry) => entry.previous)
        .map((entry) => entry.name),
      ['Vanish'],
    );
    assert.ok(
      (await readFile(join(folder, 'Vanish.cs'), 'utf8')).includes('/* 2 */'),
    );
    assert.equal(
      await readFile(join(folder, 'Page.cs'), 'utf8'),
      plugin('Page'),
    );
    await host.controller.execute({
      action: 'rollback-plugin',
      name: 'Vanish',
    });
    assert.ok(
      (await readFile(join(folder, 'Vanish.cs'), 'utf8')).includes('/* 1 */'),
    );
  } finally {
    await host.close();
  }
});

void test('a plugin that uMod does not list is reported as such, and an updated plugin is reloaded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wg-rust-umod-'));
  try {
    const serverDirectory = join(root, 'rust');
    await mkdir(join(serverDirectory, 'carbon', 'managed'), {
      recursive: true,
    });
    await mkdir(join(serverDirectory, 'carbon', 'plugins'), {
      recursive: true,
    });
    for (const name of ['Kits', 'Own', 'Vanish'])
      await writeFile(
        join(serverDirectory, 'carbon', 'plugins', `${name}.cs`),
        plugin(name),
      );
    const reloads: string[] = [];
    const controller = await createRustHostController({
      serverId: 'island',
      settings: rustHostSettings.parse({
        executable: join(serverDirectory, 'RustDedicated'),
        serverDirectory,
        identity: 'main',
      }),
      stateDirectory: join(root, 'state'),
      // The Agent's own download answers a 404 with this message.
      download: async (url) => {
        const name = /\/(\w+)\.cs$/.exec(url)?.[1];
        if (name === 'Own') throw new Error('The file was not found.');
        return Buffer.from(plugin(name!, '/* 2 */'));
      },
      // The server confirms one reload. The other gets no reply.
      reloadPlugin: async (name) => {
        reloads.push(name);
        if (name === 'Vanish') throw new Error('No reply.');
        return true;
      },
    });
    await controller.execute({ action: 'update-plugins' });
    await controller.idle();
    const listed = (await controller.read(
      'plugins',
      new URLSearchParams(),
    )) as { updates?: { results: unknown[] } };
    assert.deepEqual(listed.updates?.results, [
      { name: 'Kits', result: 'updated', reloaded: true },
      { name: 'Own', result: 'not-listed' },
      { name: 'Vanish', result: 'updated', reloaded: false },
    ]);
    // Only a plugin that got a new file is reloaded, once.
    assert.deepEqual(reloads, ['Kits', 'Vanish']);
    await controller.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a plugin settings file is saved as JSON against its revision, and the earlier file is kept', async () => {
  const host = await fixture({ oxide: true });
  try {
    const read = (name: string) =>
      host.controller.read(
        'plugin-config',
        new URLSearchParams({ name }),
      ) as Promise<{ exists: boolean; revision: string; text: string }>;
    const file = join(host.serverDirectory, 'oxide', 'config', 'Vanish.json');
    const config = await read('Vanish');
    assert.equal(config.exists, true);
    assert.equal(config.text, '{}');
    assert.equal((await read('Kits')).exists, false);
    // A name cannot leave the settings folder.
    for (const name of [
      '../../server/main/cfg/server',
      'a/b',
      'Vanish.json',
      '',
    ])
      await assert.rejects(read(name), `name ${name}`);
    const save = (change: Record<string, unknown>) =>
      host.controller.execute({
        action: 'save-plugin-config',
        name: 'Vanish',
        revision: config.revision,
        text: '{"visible": false}',
        ...change,
      });
    await assert.rejects(save({ revision: 'a'.repeat(64) }), /changed/);
    await assert.rejects(save({ text: '{"visible": ' }), /not valid JSON/);
    await assert.rejects(save({ text: `"${'a'.repeat(41_000)}"` }));
    await assert.rejects(save({ name: '../Vanish' }));
    await assert.rejects(save({ name: 'Kits' }), /no settings file/);
    assert.equal(await readFile(file, 'utf8'), '{}');
    assert.equal((await save({})).message, 'Saved.');
    assert.equal(await readFile(file, 'utf8'), '{"visible": false}');
    assert.equal(
      await readFile(
        join(host.root, 'state', 'plugins-previous', 'Vanish.json'),
        'utf8',
      ),
      '{}',
    );
    // The saved file has a new revision, so the old one no longer saves.
    await assert.rejects(save({}), /changed/);
  } finally {
    await host.close();
  }
});
