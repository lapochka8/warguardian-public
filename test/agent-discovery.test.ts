import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import {
  argumentValue,
  discoverServers,
  inspectProcess,
  linuxProcesses,
  parseWindowsProcessJson,
  printablePath,
  readDiscoveryFile,
  serverKind,
  splitWindowsCommandLine,
  windowsFileSecurity,
  writeDiscoveryFile,
} from '../src/discovery';
import { stat } from 'node:fs/promises';
import {
  GameFileUnreadable,
  battleyeConfigFile,
  parseBattlEyeConfig,
  parseSquadRconConfig,
  rconHost,
  readText,
} from '../src/games/game-config';
import { rconAccessList } from '../src/access';
import { parseAgentConfig } from '../src/config';
import { discoveredServer } from '../src/protocol';
import {
  connectionReader,
  readArma3Connection,
  readDayzConnection,
} from '../src/profiles/log-tail';

const password = 'Fake-Rcon#Password9';

/** The account of this test process, as discovery reads it for a game server. */
const uid = process.getuid?.() ?? null;
const sid =
  process.platform === 'win32'
    ? (/"(S-1-[\d-]+)"\s*$/.exec(
        execFileSync(
          join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'whoami.exe',
          ),
          ['/user', '/fo', 'csv', '/nh'],
          { encoding: 'utf8', windowsHide: true },
        ),
      )?.[1] ?? null)
    : null;

async function withDirectory<T>(run: (directory: string) => Promise<T>) {
  // The real path, so paths compare equal to the resolved paths discovery reports.
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'wg-agent-discovery-')),
  );
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test('BEServer_x64.cfg and Rcon.cfg settings are read by key', () => {
  assert.deepEqual(
    parseBattlEyeConfig(
      `\uFEFFRConPassword ${password}\r\nrconport 2306\nRConIP 127.0.0.1\nMaxPing 300\n`,
    ),
    { password, port: 2306, host: '127.0.0.1' },
  );
  assert.deepEqual(parseBattlEyeConfig('RConPort 99999\nRConIP not-an-ip\n'), {
    port: undefined,
  });
  assert.deepEqual(
    parseSquadRconConfig(
      `// Rcon.cfg\nIP=0.0.0.0\nPort=21114 // the RCON port\nPassword=${password}\nMaxConnections=5\n`,
    ),
    { host: '0.0.0.0', port: 21114, password, maxConnections: 5 },
  );
});

void test('the newest active BattlEye configuration wins over the plain file', async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, 'BEServer_x64.cfg'), 'RConPort 1\n');
    assert.equal(
      await battleyeConfigFile(directory),
      join(directory, 'BEServer_x64.cfg'),
    );
    const older = join(directory, 'beserver_x64_active_aaaa.cfg');
    const newer = join(directory, 'BEServer_x64_active_bbbb.cfg');
    await writeFile(older, 'RConPort 2\n');
    await writeFile(newer, 'RConPort 3\n');
    await utimes(older, new Date(1_000_000), new Date(1_000_000));
    assert.equal(await battleyeConfigFile(directory), newer);
    assert.equal(await battleyeConfigFile(newer), newer);
    assert.equal(await battleyeConfigFile(join(directory, 'missing')), null);
  });
});

void test('the RCON address stays on this host', () => {
  assert.equal(rconHost(undefined, undefined), '127.0.0.1');
  assert.equal(rconHost(undefined, '0.0.0.0'), '127.0.0.1');
  assert.equal(rconHost('127.0.0.2', '0.0.0.0'), '127.0.0.2');
  assert.throws(
    () => rconHost(undefined, '198.51.100.7'),
    /not an address of this host/,
  );
});

void test('Windows command lines split like CommandLineToArgvW', () => {
  assert.deepEqual(
    splitWindowsCommandLine(
      '"C:\\Games\\Arma 3\\arma3server_x64.exe" -port=2302 "-profiles=C:\\Games\\Arma 3\\profiles" -name=server',
    ),
    [
      'C:\\Games\\Arma 3\\arma3server_x64.exe',
      '-port=2302',
      '-profiles=C:\\Games\\Arma 3\\profiles',
      '-name=server',
    ],
  );
  assert.deepEqual(splitWindowsCommandLine('a\\\\"b c" d\\"e'), [
    'a\\b c',
    'd"e',
  ]);
  assert.equal(
    argumentValue(['x', '-config', '/srv/config.json'], '-config'),
    '/srv/config.json',
  );
  assert.equal(argumentValue(['x', '"-bepath=C:\\be"'], '-bepath'), 'C:\\be');
  assert.deepEqual(
    parseWindowsProcessJson(
      '{"ProcessId":12,"ExecutablePath":"C:\\\\S\\\\SquadGameServer.exe","CommandLine":"SquadGameServer.exe Port=7787"}',
    ),
    [
      {
        pid: 12,
        executable: 'C:\\S\\SquadGameServer.exe',
        argv: ['SquadGameServer.exe', 'Port=7787'],
        cwd: null,
      },
    ],
  );
  assert.deepEqual(parseWindowsProcessJson('not json'), []);
});

void test('server executables map to their profile and game', () => {
  assert.deepEqual(serverKind('/srv/arma3/arma3server_x64', 'linux'), {
    profile: 'battleye',
    game: 'arma3',
  });
  assert.deepEqual(serverKind('C:\\DayZ\\DayZServer_x64.exe', 'win32'), {
    profile: 'battleye',
    game: 'dayz',
  });
  // Squad family servers are set up by hand. Discovery does not offer them.
  for (const [executable, platform] of [
    [
      '/srv/s/PostScriptum/Binaries/Linux/PostScriptumServer-Linux-Shipping',
      'linux',
    ],
    ['C:\\PS\\PostScriptumServer.exe', 'win32'],
    ['/srv/b/BeyondTheWireServer', 'linux'],
    ['/srv/s/SquadGameServer', 'linux'],
  ] as const)
    assert.equal(serverKind(executable, platform), null, executable);
  assert.equal(serverKind('/usr/bin/bash', 'linux'), null);
});

void test('an Arma 3 process yields its BattlEye configuration, ports and profile directory without the password', async () => {
  await withDirectory(async (directory) => {
    const profiles = join(directory, 'profiles');
    await mkdir(join(profiles, 'BattlEye'), { recursive: true });
    await writeFile(
      join(profiles, 'BattlEye', 'BEServer_x64.cfg'),
      `RConPassword ${password}\nRConPort 2306\n`,
    );
    const found = await inspectProcess(
      {
        pid: 41,
        executable: join(
          directory,
          process.platform === 'win32'
            ? 'arma3server_x64.exe'
            : 'arma3server_x64',
        ),
        argv: ['arma3server_x64', '-port=2302', `-profiles=${profiles}`],
        cwd: directory,
        uid,
        sid,
      },
      process.platform,
    );
    assert.ok(found);
    assert.deepEqual(
      discoveredServer.strict().parse(found.summary),
      found.summary,
    );
    assert.deepEqual(found.summary, {
      gameId: 'arma3',
      rconPort: 2306,
      gamePort: 2302,
      queryPort: 2303,
    });
    assert.match(found.id, /^arma3-[0-9a-f]{10}$/);
    assert.equal(found.rconConfigured, true);
    assert.equal(found.problem, undefined);
    assert.deepEqual(found.settings, {
      game: 'arma3',
      battleyeConfig: join(profiles, 'BattlEye'),
      logDirectory: profiles,
    });
    // The file that needs read access, for install.sh. It stays on the host.
    assert.deepEqual(found.rconFiles, [
      join(profiles, 'BattlEye', 'BEServer_x64.cfg'),
    ]);
    assert.ok(!JSON.stringify(found).includes(password));
  });
});

void test('a server keeps its ID while BattlEye renames its configuration on each start', async () => {
  await withDirectory(async (directory) => {
    const battleye = join(directory, 'battleye');
    await mkdir(battleye, { recursive: true });
    const plain = join(battleye, 'BEServer_x64.cfg');
    await writeFile(plain, `RConPassword ${password}\nRConPort 2306\n`);
    const inspect = () =>
      inspectProcess(
        {
          pid: 7,
          executable: join(
            directory,
            process.platform === 'win32' ? 'DayZServer_x64.exe' : 'DayZServer',
          ),
          argv: ['DayZServer', `-bepath=${battleye}`],
          cwd: directory,
          uid,
          sid,
        },
        process.platform,
      );
    const stopped = await inspect();
    const first = join(battleye, 'BEServer_x64_active_1a2b3c4d.cfg');
    await rename(plain, first);
    const running = await inspect();
    const second = join(battleye, 'BEServer_x64_active_5e6f7a8b.cfg');
    await rename(first, second);
    const restarted = await inspect();
    assert.match(stopped!.id, /^dayz-[0-9a-f]{10}$/);
    assert.deepEqual([running!.id, restarted!.id], [stopped!.id, stopped!.id]);
    assert.deepEqual(
      [stopped!.rconFiles, running!.rconFiles, restarted!.rconFiles],
      [[plain], [first], [second]],
    );
  });
});

void test(
  'Linux discovery reads cmdline, exe, cwd and the account from a proc tree and drops duplicates',
  { skip: process.platform === 'win32' && 'needs symlinks' },
  async () => {
    await withDirectory(async (directory) => {
      const proc = join(directory, 'proc');
      const game = join(directory, 'game');
      await mkdir(join(game, 'battleye'), { recursive: true });
      await writeFile(
        join(game, 'battleye', 'BEServer_x64.cfg'),
        'RConPort 2306\n',
      );
      const account = uid ?? 1000;
      for (const pid of ['100', '101']) {
        await mkdir(join(proc, pid), { recursive: true });
        await writeFile(
          join(proc, pid, 'cmdline'),
          `${join(game, 'arma3server_x64')}\0-port=2302\0`,
        );
        await writeFile(
          join(proc, pid, 'status'),
          `Name:\tarma3server_x64\nUid:\t${account}\t${account}\t${account}\t${account}\n`,
        );
        await symlink(join(game, 'arma3server_x64'), join(proc, pid, 'exe'));
      }
      await mkdir(join(proc, 'self'), { recursive: true });
      await mkdir(join(proc, '102'), { recursive: true });
      await writeFile(join(proc, '102', 'cmdline'), '/usr/bin/sleep\x0010\0');
      const entries = await linuxProcesses(proc);
      assert.deepEqual(
        entries.map((entry) => entry.pid).sort((a, b) => a - b),
        [100, 101, 102],
      );
      assert.deepEqual(entries.find((entry) => entry.pid === 100)?.argv, [
        join(game, 'arma3server_x64'),
        '-port=2302',
      ]);
      assert.equal(entries.find((entry) => entry.pid === 100)?.uid, account);
      assert.equal(entries.find((entry) => entry.pid === 102)?.uid, null);
      const found = await discoverServers({
        platform: process.platform,
        processes: async () => entries,
      });
      assert.equal(found.length, 1);
      // The installer checks the server's files against this process.
      assert.ok([100, 101].includes(found[0]?.pid ?? 0));
      assert.equal(found[0]?.rconConfigured, false);
      assert.deepEqual(found[0]?.summary, {
        gameId: 'arma3',
        rconPort: 2306,
        gamePort: 2302,
        queryPort: 2303,
      });
    });
  },
);

void test('a missing BattlEye file is reported instead of skipped', async () => {
  await withDirectory(async (directory) => {
    const arma = await inspectProcess(
      {
        pid: 1,
        executable: join(directory, 'arma3server_x64'),
        argv: ['arma3server_x64'],
        cwd: directory,
        uid,
        sid,
      },
      process.platform,
    );
    assert.equal(arma?.problem, 'BEServer_x64.cfg was not found.');
    assert.equal(arma?.rconFiles, undefined);
  });
});

const canDenyRead = process.platform !== 'win32' && process.getuid?.() !== 0;

void test(
  'a game file the service account cannot read is reported as a permission problem',
  { skip: !canDenyRead && 'needs a non-root POSIX account' },
  async () => {
    await withDirectory(async (directory) => {
      const config = join(directory, 'battleye');
      await mkdir(config, { recursive: true });
      const file = join(config, 'BEServer_x64.cfg');
      await writeFile(file, `RConPort 2305\nRConPassword ${password}\n`);
      await chmod(file, 0o000);
      try {
        const found = await inspectProcess(
          {
            pid: 3,
            executable: join(directory, 'DayZServer'),
            argv: ['DayZServer'],
            cwd: directory,
            uid,
            sid,
          },
          process.platform,
        );
        assert.equal(
          found?.problem,
          `Permission denied: ${file}. Give the agent's service account read access.`,
        );
        // install.sh grants read access to exactly this file.
        assert.deepEqual(found?.rconFiles, [file]);
        await assert.rejects(
          readText(file),
          (error: Error) =>
            error instanceof GameFileUnreadable &&
            !error.message.includes(directory),
        );
      } finally {
        await chmod(file, 0o600);
      }
    });
  },
);

void test('a privileged discovery is saved for enroll, readable by its owner only', async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, 'discovery.json');
    const found = [
      {
        id: 'dayz-0123456789',
        profile: 'battleye' as const,
        summary: { gameId: 'dayz' as const, rconPort: 2305 },
        rconConfigured: true,
        rconFiles: ['/srv/dayz/battleye/BEServer_x64.cfg'],
        settings: { game: 'dayz', battleyeConfig: '/srv/dayz/battleye' },
      },
    ];
    await writeDiscoveryFile(file, found);
    if (process.platform !== 'win32')
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readDiscoveryFile(file), found);
    for (const damaged of [
      'not json',
      JSON.stringify([{ ...found[0], id: '../x' }]),
      JSON.stringify([{ ...found[0], summary: { gameId: 'squad44' } }]),
      JSON.stringify({ servers: found }),
    ]) {
      await writeFile(file, damaged);
      await assert.rejects(readDiscoveryFile(file), /discovery file/);
    }
  });
  assert.equal(printablePath('/srv/dayz/battleye/BEServer_x64.cfg'), true);
  assert.equal(printablePath('/srv/a\nb/BEServer_x64.cfg'), false);
  assert.equal(printablePath(''), false);
});

void test('the access list names exactly the RCON files of the configured servers', async () => {
  await withDirectory(async (directory) => {
    const battleye = join(directory, 'arma', 'battleye');
    await mkdir(battleye, { recursive: true });
    for (const name of [
      'BEServer_x64.cfg',
      'BEServer_x64_active_1a2b.cfg',
      'bans.txt',
      'scripts.txt',
    ])
      await writeFile(join(battleye, name), `RConPassword ${password}\n`);
    const rcon = join(directory, 'squad44', 'Rcon.cfg');
    await mkdir(join(directory, 'squad44'));
    await writeFile(rcon, `Password=${password}\n`);
    const secret = `wga_${'A'.repeat(43)}`;
    const list = await rconAccessList(
      parseAgentConfig({
        panel: 'https://panel.example.test',
        servers: [
          {
            serverId: 'arma-one',
            secret,
            profile: 'battleye',
            game: 'arma3',
            battleyeConfig: battleye,
          },
          {
            serverId: 'squad-one',
            secret,
            profile: 'squad-family',
            game: 'squad44',
            rconConfig: rcon,
          },
          { serverId: 'dayz-one', secret, profile: 'battleye', game: 'dayz' },
        ],
      }),
    );
    assert.deepEqual(
      list.map((entry) => `${entry.kind} ${entry.path}`).sort(),
      [
        `file ${join(battleye, 'BEServer_x64.cfg')}`,
        `file ${join(battleye, 'BEServer_x64_active_1a2b.cfg')}`,
        `file ${rcon}`,
        `folder ${battleye}`,
      ].sort(),
    );
  });
});

void test('Arma 3 and DayZ server log lines give the joining player and Steam ID', () => {
  const steam = '76561198000000901';
  assert.deepEqual(
    readArma3Connection(`10:53:48 Player Field Medic connected (id=${steam}).`),
    { name: 'Field Medic', steam64: steam },
  );
  // The form a live DayZ server printed in its .RPT on connect.
  assert.deepEqual(
    readDayzConnection(
      `10:53:48.277 Player "Field Medic" (steamID=${steam} pos=<10747.1, 2538.3, 6.1>) is connected`,
    ),
    { name: 'Field Medic', steam64: steam },
  );
  // The admin log names the DayZ ID, which is no Steam ID.
  assert.equal(
    readDayzConnection(
      '10:53:48 | Player "Field Medic" (id=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= pos=<10747.1, 2538.3, 6.1>) is connected',
    ),
    null,
  );
  assert.equal(
    readDayzConnection(
      `Player "x" (steamID=${steam} pos=<1, 2, 3>) has been disconnected`,
    ),
    null,
  );
  assert.equal(connectionReader('dayz'), readDayzConnection);
  assert.equal(connectionReader('arma3'), readArma3Connection);
  assert.equal(connectionReader('squad44'), null);
});

/** A DayZ process of this test account, as discovery reads one. */
function dayzProcess(
  game: string,
  argv: string[],
  account: { uid?: number | null; sid?: string | null } = { uid, sid },
) {
  return {
    pid: 9,
    executable: join(
      game,
      process.platform === 'win32' ? 'DayZServer_x64.exe' : 'DayZServer',
    ),
    argv: ['DayZServer', ...argv],
    cwd: game,
    ...account,
  };
}

/** An account that owns none of the test files. */
const stranger =
  process.platform === 'win32'
    ? { sid: 'S-1-5-21-1000000001-1000000002-1000000003-1001' }
    : { uid: (uid ?? 0) + 1 };

void test('discovery accepts a BattlEye configuration of the process account in its BattlEye path, profiles or game folder', async () => {
  await withDirectory(async (directory) => {
    const game = join(directory, 'game');
    // A profiles folder outside the install folder, as many hosts use.
    const profiles = join(directory, 'profiles');
    await mkdir(join(game, 'battleye'), { recursive: true });
    await mkdir(join(profiles, 'BattlEye'), { recursive: true });
    const own = join(game, 'battleye', 'BEServer_x64.cfg');
    await writeFile(own, `RConPassword ${password}\nRConPort 2305\n`);
    const outside = join(profiles, 'BattlEye', 'BEServer_x64.cfg');
    await writeFile(outside, `RConPassword ${password}\nRConPort 2405\n`);
    const secretFile = join(directory, 'secret.txt');
    await writeFile(secretFile, `RConPassword ${password}\nRConPort 2505\n`);
    const inspect = (
      argv: string[],
      account?: Parameters<typeof dayzProcess>[2],
    ) => inspectProcess(dayzProcess(game, argv, account), process.platform);

    for (const [argv, file] of [
      [[`-bepath=${join(game, 'battleye')}`], own],
      [[], own],
      [[`-profiles=${profiles}`], outside],
      [
        [`-profiles=${profiles}`, `-bepath=${join(profiles, 'BattlEye')}`],
        outside,
      ],
    ] as const) {
      const found = await inspect([...argv]);
      assert.equal(found?.rejected, undefined, argv.join(' '));
      assert.equal(found?.problem, undefined, argv.join(' '));
      assert.deepEqual(found?.rconFiles, [file]);
      assert.equal(found?.settings.battleyeConfig, join(file, '..'));
      assert.equal(found?.rconConfigured, true);
    }
    const withProfiles = await inspect([`-profiles=${profiles}`]);
    assert.equal(withProfiles?.settings.logDirectory, profiles);
    assert.equal(withProfiles?.summary.rconPort, 2405);

    // Another account's process that names these files gets nothing.
    for (const argv of [
      [`-bepath=${join(game, 'battleye')}`],
      [`-profiles=${profiles}`],
    ]) {
      const found = await inspect(argv, stranger);
      assert.equal(found?.rejected, true, argv.join(' '));
      assert.match(found?.problem ?? '', /belongs to another account/);
      assert.equal(found?.rconFiles, undefined);
      assert.equal(found?.settings.battleyeConfig, undefined);
      assert.equal(found?.settings.logDirectory, undefined);
      // Nothing is read from a rejected file.
      assert.equal(found?.summary.rconPort, undefined);
      assert.equal(found?.rconConfigured, false);
    }

    const named = await inspect([`-bepath=${secretFile}`]);
    assert.equal(named?.rejected, true);
    assert.match(named?.problem ?? '', /is not a BattlEye configuration file/);

    // A link anywhere in the path is refused, even to the account's own file.
    await symlink(
      join(profiles, 'BattlEye'),
      join(game, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const linked = await inspect([`-bepath=${join(game, 'linked')}`]);
    assert.equal(linked?.rejected, true);
    assert.match(linked?.problem ?? '', /has a link in its path/);

    // The executable path comes from the system, never from argv[0].
    const unknown = await inspectProcess(
      { ...dayzProcess(game, []), executable: null },
      process.platform,
    );
    assert.equal(unknown?.rejected, true);
    assert.match(unknown?.problem ?? '', /game folder of process 9/);

    // Without the account of the process, nothing is accepted.
    const noAccount = await inspect([`-bepath=${join(game, 'battleye')}`], {});
    assert.equal(noAccount?.rejected, true);
    assert.match(noAccount?.problem ?? '', /account of process 9/);
  });
});

void test(
  'on Windows the account that runs the game may also write the file instead of owning it',
  { skip: process.platform !== 'win32' && 'needs Windows paths' },
  async () => {
    await withDirectory(async (directory) => {
      const game = join(directory, 'game');
      await mkdir(join(game, 'battleye'), { recursive: true });
      const file = join(game, 'battleye', 'BEServer_x64.cfg');
      await writeFile(file, `RConPassword ${password}\nRConPort 2305\n`);
      const service = 'S-1-5-21-1000000001-1000000002-1000000003-1002';
      const administrators = 'S-1-5-32-544';
      const inspect = (security: { owner: string; writers: string[] }) =>
        inspectProcess(
          dayzProcess(game, [], { sid: service }),
          'win32',
          async () => security,
        );
      // An administrator copied the files, and the game account may change them.
      const accepted = await inspect({
        owner: administrators,
        writers: [administrators, service],
      });
      assert.equal(accepted?.rejected, undefined);
      assert.deepEqual(accepted?.rconFiles, [file]);
      // A file every user may change belongs to no one in particular.
      for (const everyone of ['S-1-1-0', 'S-1-5-32-545', 'S-1-5-11']) {
        const refused = await inspect({
          owner: administrators,
          writers: [service, everyone],
        });
        assert.equal(refused?.rejected, true, everyone);
      }
      const unreadable = await inspectProcess(
        dayzProcess(game, [], { sid: service }),
        'win32',
        async () => null,
      );
      assert.match(unreadable?.problem ?? '', /owner of .* cannot be read/);
      // The real reader returns this account as the owner of its own file.
      const real = await windowsFileSecurity(file);
      assert.equal(real?.owner, sid);
    });
  },
);

void test('a rejected discovery round-trips through the discovery file', async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, 'discovery.json');
    const found = [
      {
        id: 'dayz-0123456789',
        profile: 'battleye' as const,
        summary: { gameId: 'dayz' as const },
        rconConfigured: false,
        rejected: true as const,
        problem: '/srv/x is outside the game folder /srv/dayz.',
        settings: { game: 'dayz' },
      },
    ];
    await writeDiscoveryFile(file, found);
    assert.deepEqual(await readDiscoveryFile(file), found);
  });
});

void test('the access list prints only existing absolute paths that are safe on a command line', async () => {
  await withDirectory(async (directory) => {
    const squad = join(directory, 'squad44');
    await mkdir(squad);
    const rcon = join(squad, 'Rcon.cfg');
    await writeFile(rcon, `Password=${password}\n`);
    const battleye = join(directory, 'battleye');
    await mkdir(battleye);
    await writeFile(join(battleye, 'BEServer_x64.cfg'), 'RConPort 2306\n');
    const notes = join(directory, 'notes.txt');
    await writeFile(notes, `Password=${password}\n`);
    const secret = `wga_${'A'.repeat(43)}`;
    const squadEntry = (serverId: string, rconConfig: string) => ({
      serverId,
      secret,
      profile: 'squad-family',
      game: 'squad44',
      rconConfig,
    });
    const injected = `${rcon}" /grant *S-1-1-0:F /T "`;
    const config = parseAgentConfig({
      panel: 'https://panel.example.test',
      servers: [
        squadEntry('injected', injected),
        squadEntry('missing', join(directory, 'missing', 'Rcon.cfg')),
        squadEntry('wrong-name', notes),
        squadEntry('folder', squad),
        {
          serverId: 'not-battleye',
          secret,
          profile: 'battleye',
          game: 'dayz',
          battleyeConfig: notes,
        },
        squadEntry('squad-one', rcon),
        {
          serverId: 'arma-one',
          secret,
          profile: 'battleye',
          game: 'arma3',
          battleyeConfig: battleye,
        },
      ],
    });
    const skipped: string[] = [];
    const errors = mock.method(console, 'error', (line: unknown) => {
      skipped.push(String(line));
    });
    let list;
    try {
      list = await rconAccessList(config);
    } finally {
      errors.mock.restore();
    }
    assert.deepEqual(
      list.map((entry) => `${entry.kind} ${entry.path}`).sort(),
      [
        `file ${rcon}`,
        `folder ${battleye}`,
        `file ${join(battleye, 'BEServer_x64.cfg')}`,
      ].sort(),
    );
    assert.equal(skipped.length, 5, skipped.join('\n'));
    for (const path of list.map((entry) => entry.path))
      assert.ok(!path.includes('"'));
  });
});
