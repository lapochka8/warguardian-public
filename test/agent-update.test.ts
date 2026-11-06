import assert from 'node:assert/strict';
import { createHash, type KeyObject } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { test } from 'node:test';
import {
  parseChecksums,
  releasePublicKey,
} from '../src/release-sums';
import {
  abandonFailedUpdate,
  binaryPath,
  compareVersions,
  configuredVersion,
  createUpdater,
  detectLayout,
  downloadArtifact,
  fetchUpdate,
  healthDeadlineMs,
  readUpdateState,
  startupDecision,
  switchVersion,
  updateStateFile,
  writeUpdateState,
  type UpdateKeys,
  type UpdateLayout,
  type UpdateState,
} from '../src/update';
import {
  envelope,
  fakeFetch,
  manifestKey,
  releaseKey,
  releaseRoutes,
} from './support/update-keys';

const panel = 'https://panel.example.test';

void test('versions compare by number and a prerelease sorts first', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.1.0', '1.1.0'), 0);
  assert.equal(compareVersions('1.1.0-rc.1', '1.1.0'), -1);
  assert.equal(compareVersions('1.0.9', '1.1.0-rc.1'), -1);
});

void test('the installed layout is recognized from the executable path', () => {
  assert.deepEqual(
    detectLayout(
      '/opt/warguardian-agent/versions/1.1.0/warguardian-agent',
      'linux',
    ),
    {
      kind: 'linux',
      root: '/opt/warguardian-agent',
      version: '1.1.0',
    },
  );
  assert.deepEqual(
    detectLayout(
      'C:\\Program Files\\WarGuardian Agent\\versions\\1.1.0\\warguardian-agent.exe',
      'win32',
      'C:\\ProgramData\\WarGuardian\\state',
    ),
    {
      kind: 'windows',
      root: 'C:\\Program Files\\WarGuardian Agent',
      version: '1.1.0',
      stateDirectory: 'C:\\ProgramData\\WarGuardian\\state',
    },
  );
  assert.equal(detectLayout('/usr/bin/node', 'linux'), null);
  assert.equal(
    detectLayout('/opt/x/versions/latest/warguardian-agent', 'linux'),
    null,
  );
});

void test('startup decisions keep, trial or roll back a pending version', () => {
  const pending: UpdateState = {
    v: 1,
    status: 'pending',
    from: '1.1.0',
    to: '1.2.0',
    switchedAt: 1_000_000,
    starts: 0,
    blocked: [],
  };
  assert.equal(startupDecision(null, '1.1.0', 0), 'continue');
  assert.equal(
    startupDecision({ ...pending, status: 'committed' }, '1.2.0', 0),
    'continue',
  );
  assert.equal(startupDecision(pending, '1.2.0', 1_000_000 + 10_000), 'trial');
  assert.equal(
    startupDecision(pending, '1.2.0', 1_000_000 + healthDeadlineMs + 1),
    'rollback',
  );
  assert.equal(
    startupDecision({ ...pending, starts: 3 }, '1.2.0', 1_000_001),
    'rollback',
  );
  assert.equal(startupDecision(pending, '1.1.0', 1_000_001), 'settled');
});

/** A manifest entry. The agent checks `sha256` against the signed SHA256SUMS. */
function artifactFor(
  bytes: Buffer,
  url = `${panel}/downloads/agent/1.2.0/warguardian-agent-win-x64.exe`,
) {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sig: 'unsigned',
    url,
    size: bytes.length,
  };
}

void test('the update manifest must carry a pinned key signature, be current and name a newer version', async () => {
  const release = releaseKey();
  const manifest = manifestKey();
  const bytes = Buffer.from('new agent');
  const keys: UpdateKeys = {
    manifestKeys: [manifest.raw],
    releaseKey: release.publicKey,
  };
  const body = {
    version: '1.2.0',
    artifacts: { 'win-x64': artifactFor(bytes) },
  };
  const routes = (value: unknown, status = 200) =>
    fakeFetch({
      '/api/agent/v1/update': () => Response.json(value, { status }),
    });
  const good = envelope(manifest.signing, body);
  const check = (
    value: unknown,
    running = '1.1.0',
    target: 'win-x64' | 'linux-x64' = 'win-x64',
    status = 200,
  ) =>
    fetchUpdate({
      panel,
      target,
      running,
      keys,
      fetcher: routes(value, status),
    });
  assert.equal((await check(good))?.version, '1.2.0');
  assert.equal(await check(good, '1.2.0'), null);
  assert.equal(await check(good, '1.1.0', 'linux-x64'), null);
  assert.equal(
    await check(
      { error: 'not configured', reason: 'signing-key' },
      '1.1.0',
      'win-x64',
      503,
    ),
    null,
  );
  const forged = { ...good, payload: good.payload.replace('1.2.0', '1.3.0') };
  await assert.rejects(check(forged), /pinned key/);
  await assert.rejects(
    check(envelope(manifestKey().signing, body)),
    /pinned key/,
  );
  await assert.rejects(
    check(envelope(manifest.signing, body, Date.now() - 2 * 24 * 3_600_000)),
    /expired/,
  );
});

async function withDirectory<T>(run: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'wg-agent-update-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test('a download must match the signed SHA256SUMS of its release, the manifest and its size', async () => {
  const release = releaseKey();
  const bytes = Buffer.from('new agent binary');
  const folder = '/downloads/agent/1.2.0';
  const name = 'warguardian-agent-win-x64.exe';
  await withDirectory(async (directory) => {
    const run = async (
      label: string,
      options: {
        artifact?: ReturnType<typeof artifactFor>;
        served?: Buffer;
        routes?: Record<string, () => Response>;
        key?: KeyObject | null;
        version?: string;
      } = {},
    ) =>
      downloadArtifact({
        panel,
        manifest: {
          version: options.version ?? '1.2.0',
          issuedAt: 1,
          expiresAt: 2,
          artifacts: { 'win-x64': options.artifact ?? artifactFor(bytes) },
        },
        target: 'win-x64',
        releaseKey: (options.key === undefined
          ? release.publicKey
          : options.key) as KeyObject,
        destination: join(directory, label),
        fetcher: fakeFetch({
          ...releaseRoutes(release, folder, '1.2.0', () => ({
            [name]: bytes,
          })),
          ...(options.served
            ? {
                [`${folder}/${name}`]: () =>
                  new Response(new Uint8Array(options.served!)),
              }
            : {}),
          ...options.routes,
        }),
      });
    await run('good');
    assert.deepEqual(await readFile(join(directory, 'good')), bytes);
    // The file differs from the digest that both lists name.
    await assert.rejects(
      run('changed', { served: Buffer.from('new agent binarz') }),
      /checksum/,
    );
    await assert.rejects(
      run('larger', { served: Buffer.concat([bytes, bytes]) }),
      /larger|checksum/,
    );
    // The panel's manifest names another digest than the signed list.
    await assert.rejects(
      run('manifest-differs', {
        artifact: artifactFor(Buffer.from('another build')),
        served: Buffer.from('another build'),
      }),
      /differs from the one in SHA256SUMS/,
    );
    // A list signed by another key, or changed after signing.
    const other = releaseKey();
    const otherSums = other.sums({ [name]: bytes });
    await assert.rejects(
      run('other-key', {
        routes: {
          [`${folder}/SHA256SUMS`]: () =>
            new Response(new Uint8Array(otherSums.checksums)),
          [`${folder}/SHA256SUMS.sig`]: () =>
            new Response(new Uint8Array(otherSums.signature)),
        },
      }),
      /does not match the release key/,
    );
    const signed = release.sums({
      [name]: bytes,
      'WarGuardianAgentSetup-1.2.0.exe': Buffer.from('installer 1.2.0'),
    });
    await assert.rejects(
      run('changed-list', {
        routes: {
          [`${folder}/SHA256SUMS`]: () =>
            new Response(
              new Uint8Array(
                Buffer.concat([signed.checksums, Buffer.from('\n')]),
              ),
            ),
          [`${folder}/SHA256SUMS.sig`]: () =>
            new Response(new Uint8Array(signed.signature)),
        },
      }),
      /does not match the release key/,
    );
    // The signed list of an earlier release cannot stand in for a later version.
    await assert.rejects(
      run('other-version', { version: '1.3.0' }),
      /does not belong to version 1\.3\.0/,
    );
    // Without SHA256SUMS or its signature nothing is downloaded.
    await assert.rejects(
      run('no-signature', {
        routes: {
          [`${folder}/SHA256SUMS.sig`]: () =>
            new Response('not found', { status: 404 }),
        },
      }),
      /SHA256SUMS\.sig could not be downloaded/,
    );
    const { size: _size, ...unsized } = artifactFor(bytes);
    await run('unsized', {
      artifact: { ...unsized, size: undefined } as never,
    });
    // The offline release key is required: a manifest signed by the panel
    // alone cannot install a build.
    await assert.rejects(
      run('without-release-key', { key: null }),
      /release key/,
    );
    assert.deepEqual((await readdir(directory)).sort(), ['good', 'unsized']);
  });
});

void test('a release list names each file once in the sha256sum form', () => {
  const digest = 'a'.repeat(64);
  assert.deepEqual(
    [
      ...(parseChecksums(
        `${digest}  install.sh\n${'b'.repeat(64)}  SHA256SUMS.sig\n`,
      ) ?? []),
    ],
    [
      ['install.sh', digest],
      ['SHA256SUMS.sig', 'b'.repeat(64)],
    ],
  );
  for (const text of [
    `${digest} install.sh\n`,
    `${digest}  install.sh\n${digest}  install.sh\n`,
    `${digest}  ../install.sh\n`,
    `${digest.toUpperCase()}  install.sh\n`,
  ])
    assert.equal(parseChecksums(text), null, text);
  assert.equal(releasePublicKey('not a key'), null);
  assert.ok(releasePublicKey(releaseKey().line));
});

/** The WinSW configuration the installer writes: the launcher in the program folder. */
function serviceXml(directory: string) {
  return `<service>\n  <id>WarGuardianAgent</id>\n  <executable>${win32.join(directory, 'warguardian-agent.exe')}</executable>\n  <arguments>service</arguments>\n</service>\n`;
}

/**
 * A Windows layout in a temporary folder: the program folder with the
 * service configuration, and the state folder beside it that holds the
 * update state and the version pointer.
 */
async function windowsLayout(directory: string): Promise<UpdateLayout> {
  const root = win32.join(directory, 'program');
  const layout: UpdateLayout = {
    kind: 'windows',
    root,
    version: '1.1.0',
    stateDirectory: win32.join(directory, 'state'),
  };
  await mkdir(win32.join(root, 'versions', '1.1.0'), { recursive: true });
  await writeFile(
    win32.join(root, 'warguardian-agent-service.xml'),
    serviceXml(root),
  );
  return layout;
}

/** A Linux layout: versions/1.1.0 and the current symlink. */
async function linuxLayout(directory: string): Promise<UpdateLayout> {
  await mkdir(posix.join(directory, 'versions', '1.1.0'), { recursive: true });
  const layout: UpdateLayout = {
    kind: 'linux',
    root: directory,
    version: '1.1.0',
  };
  await switchVersion(layout, '1.1.0');
  return layout;
}

async function selfUpdateFlow(kind: 'windows' | 'linux') {
  const release = releaseKey();
  const manifest = manifestKey();
  const bytes = Buffer.from('agent 1.2.0');
  const target = kind === 'windows' ? 'win-x64' : 'linux-x64';
  const file =
    kind === 'windows'
      ? 'warguardian-agent-win-x64.exe'
      : 'warguardian-agent-linux-x64';
  const path = `/downloads/agent/1.2.0/${file}`;
  const fetcher = fakeFetch({
    '/api/agent/v1/update': () =>
      Response.json(
        envelope(manifest.signing, {
          version: '1.2.0',
          artifacts: {
            [target]: artifactFor(bytes, `${panel}${path}`),
          },
        }),
      ),
    ...releaseRoutes(release, '/downloads/agent/1.2.0', '1.2.0', () => ({
      [file]: bytes,
    })),
  });
  await withDirectory(async (directory) => {
    const layout =
      kind === 'windows'
        ? await windowsLayout(directory)
        : await linuxLayout(directory);
    const state = join(directory, 'state');
    let clock = Date.now();
    let restarts = 0;
    const updater = (running: string, verify = true) =>
      createUpdater({
        layout,
        stateDirectory: state,
        running,
        target,
        panel,
        keys: { manifestKeys: [manifest.raw], releaseKey: release.publicKey },
        log: () => undefined,
        restart: () => {
          restarts += 1;
        },
        fetcher,
        now: () => clock,
        verifyBinary: async () => verify,
      });

    const current = updater('1.1.0');
    assert.equal(await current.start(), true);
    assert.equal(await current.check(), 'installed');
    assert.equal(restarts, 1);
    assert.equal(await configuredVersion(layout), '1.2.0');
    assert.deepEqual(await readFile(binaryPath(layout, '1.2.0')), bytes);
    assert.equal(
      (await readUpdateState(updateStateFile(state)))?.status,
      'pending',
    );

    const candidate = updater('1.2.0');
    clock += 5_000;
    assert.equal(await candidate.start(), true);
    await candidate.healthy();
    assert.equal(
      (await readUpdateState(updateStateFile(state)))?.status,
      'committed',
    );
    candidate.close();

    // A pending version that misses the health deadline returns to the previous one.
    await writeUpdateState(updateStateFile(state), {
      v: 1,
      status: 'pending',
      from: '1.1.0',
      to: '1.2.0',
      switchedAt: clock,
      starts: 0,
      blocked: [],
    });
    clock += healthDeadlineMs + 1;
    const late = updater('1.2.0');
    assert.equal(await late.start(), false);
    assert.equal(await configuredVersion(layout), '1.1.0');
    const rolledBack = await readUpdateState(updateStateFile(state));
    assert.deepEqual(
      [rolledBack?.status, rolledBack?.blocked],
      ['rolled-back', ['1.2.0']],
    );
    assert.equal(restarts, 2);

    // The previous version starts, removes the rolled-back build and an old
    // staging folder, and keeps itself.
    const staging = (kind === 'windows' ? win32 : posix).join(
      layout.root,
      'versions',
      '.1.3.0.abcdef',
    );
    await mkdir(staging, { recursive: true });
    const old = new Date(Date.now() - 2 * 3_600_000);
    await utimes(staging, old, old);
    clock = Date.now();
    const again = updater('1.1.0');
    await again.start();
    assert.equal(await exists(binaryPath(layout, '1.2.0')), false);
    assert.equal(await exists(staging), false);
    assert.equal(
      await exists(
        (kind === 'windows' ? win32 : posix).join(
          layout.root,
          'versions',
          '1.1.0',
        ),
      ),
      true,
    );
    // The failed version is not installed again.
    assert.equal(await again.check(), 'blocked');

    // A binary that does not start is never switched to.
    await writeUpdateState(updateStateFile(state), {
      ...rolledBack!,
      blocked: [],
    });
    const broken = updater('1.1.0', false);
    await broken.start();
    await assert.rejects(broken.check(), /did not start/);
    assert.equal(await configuredVersion(layout), '1.1.0');
  });
}

const onWindows = process.platform === 'win32';

void test(
  'Windows self-update switches the version pointer, commits when healthy and rolls back otherwise',
  { skip: !onWindows && 'needs Windows paths' },
  () => selfUpdateFlow('windows'),
);

void test(
  'Linux self-update switches the current symlink, commits when healthy and rolls back otherwise',
  { skip: onWindows && 'needs symlinks' },
  () => selfUpdateFlow('linux'),
);

void test(
  'a Windows switch replaces the version pointer in the state folder and leaves the service configuration alone',
  { skip: !onWindows && 'needs Windows paths' },
  async () => {
    await withDirectory(async (directory) => {
      // Elevated setup runs the service wrapper with this configuration, so
      // the service account never writes it.
      const layout = await windowsLayout(directory);
      await mkdir(win32.join(layout.root, 'versions', '1.2.0'), {
        recursive: true,
      });
      const xml = win32.join(layout.root, 'warguardian-agent-service.xml');
      const before = (await readdir(layout.root)).sort();
      await switchVersion(layout, '1.2.0');
      assert.deepEqual((await readdir(layout.root)).sort(), before);
      assert.equal(await readFile(xml, 'utf8'), serviceXml(layout.root));
      assert.equal(await configuredVersion(layout), '1.2.0');
      const state = win32.join(directory, 'state');
      assert.deepEqual(await readdir(state), ['current-version']);
      assert.equal(
        await readFile(win32.join(state, 'current-version'), 'utf8'),
        '1.2.0\n',
      );
      await switchVersion(layout, '1.1.0');
      assert.equal(await configuredVersion(layout), '1.1.0');
      assert.deepEqual(await readdir(state), ['current-version']);
    });
  },
);

void test('a failed version is blocked for a day, and a rebuilt release of that version is tried again', async () => {
  const release = releaseKey();
  const manifest = manifestKey();
  const target = onWindows ? 'win-x64' : 'linux-x64';
  const file = onWindows
    ? 'warguardian-agent-win-x64.exe'
    : 'warguardian-agent-linux-x64';
  const path = `/downloads/agent/1.2.0/${file}`;
  let bytes = Buffer.from('agent 1.2.0');
  const fetcher = fakeFetch({
    '/api/agent/v1/update': () =>
      Response.json(
        envelope(manifest.signing, {
          version: '1.2.0',
          artifacts: {
            [target]: artifactFor(bytes, `${panel}${path}`),
          },
        }),
      ),
    ...releaseRoutes(release, '/downloads/agent/1.2.0', '1.2.0', () => ({
      [file]: bytes,
    })),
  });
  const digest = (value: Buffer) =>
    createHash('sha256').update(value).digest('hex');
  await withDirectory(async (directory) => {
    const layout = onWindows
      ? await windowsLayout(directory)
      : await linuxLayout(directory);
    const state = join(directory, 'state');
    let clock = Date.now();
    const updater = (running = '1.1.0') =>
      createUpdater({
        layout,
        stateDirectory: state,
        running,
        target,
        panel,
        keys: { manifestKeys: [manifest.raw], releaseKey: release.publicKey },
        log: () => undefined,
        restart: () => undefined,
        fetcher,
        now: () => clock,
        verifyBinary: async () => true,
      });
    const rolledBack = (at: number, sha256?: string): UpdateState => ({
      v: 1,
      status: 'rolled-back',
      from: '1.1.0',
      to: '1.2.0',
      switchedAt: at,
      starts: 1,
      blocked: ['1.2.0'],
      ...(sha256 ? { blocks: { '1.2.0': { at, sha256 } } } : {}),
    });

    // The build that failed an hour ago stays blocked.
    await writeUpdateState(
      updateStateFile(state),
      rolledBack(clock - 3_600_000, digest(bytes)),
    );
    assert.equal(await updater().check(), 'blocked');
    // A state saved by the previous release names the version only. Its
    // block counts from the switch.
    await writeUpdateState(
      updateStateFile(state),
      rolledBack(clock - 3_600_000),
    );
    assert.equal(await updater().check(), 'blocked');

    // A day later the version is tried again, for example after an outage
    // kept the trial from reaching WarGuardian.
    clock += 24 * 3_600_000;
    assert.equal(await updater().check(), 'installed');
    const pending = await readUpdateState(updateStateFile(state));
    assert.equal(pending?.status, 'pending');
    assert.equal(pending?.toSha256, digest(bytes));
    assert.deepEqual(pending?.blocked, [], 'the expired block is dropped');

    // A trial that misses its deadline blocks that build with its digest.
    clock += healthDeadlineMs + 1;
    assert.equal(await updater('1.2.0').start(), false);
    const blocked = await readUpdateState(updateStateFile(state));
    assert.deepEqual(blocked?.blocked, ['1.2.0']);
    assert.deepEqual(blocked?.blocks?.['1.2.0'], {
      at: clock,
      sha256: digest(bytes),
    });
    await switchVersion(layout, '1.1.0');
    assert.equal(await updater().check(), 'blocked');

    // A rebuilt 1.2.0 with another digest is not the build that failed.
    bytes = Buffer.from('agent 1.2.0 rebuilt');
    assert.equal(await updater().check(), 'installed');
  });
});

async function trialTimeout(kind: 'windows' | 'linux') {
  const { publicKey } = releaseKey();
  await withDirectory(async (directory) => {
    const layout =
      kind === 'windows'
        ? await windowsLayout(directory)
        : await linuxLayout(directory);
    await mkdir(
      (kind === 'windows' ? win32 : posix).join(
        layout.root,
        'versions',
        '1.2.0',
      ),
      { recursive: true },
    );
    await switchVersion(layout, '1.2.0');
    const state = join(directory, 'state');
    await writeUpdateState(updateStateFile(state), {
      v: 1,
      status: 'pending',
      from: '1.1.0',
      to: '1.2.0',
      switchedAt: Date.now() - healthDeadlineMs + 50,
      starts: 1,
      blocked: [],
    });
    let restarted = false;
    const updater = createUpdater({
      layout,
      stateDirectory: state,
      running: '1.2.0',
      target: kind === 'windows' ? 'win-x64' : 'linux-x64',
      panel,
      keys: { manifestKeys: [manifestKey().raw], releaseKey: publicKey },
      log: () => undefined,
      restart: () => {
        restarted = true;
      },
    });
    assert.equal(await updater.start(), true);
    const until = Date.now() + 3_000;
    while (!restarted && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(restarted, true);
    assert.equal(await configuredVersion(layout), '1.1.0');
    assert.equal((await readUpdateState(updateStateFile(state)))?.starts, 2);
  });
}

void test(
  'a Windows trial that does not report healthy rolls back on its own timer',
  { skip: !onWindows && 'needs Windows paths' },
  () => trialTimeout('windows'),
);

void test(
  'a Linux trial that does not report healthy rolls back on its own timer',
  { skip: onWindows && 'needs symlinks' },
  () => trialTimeout('linux'),
);

/**
 * A new version that fails before its updater starts, for example on a
 * configuration it cannot read, returns to the previous version at once.
 */
async function failedStart(kind: 'windows' | 'linux') {
  await withDirectory(async (directory) => {
    const layout =
      kind === 'windows'
        ? await windowsLayout(directory)
        : await linuxLayout(directory);
    await mkdir(
      (kind === 'windows' ? win32 : posix).join(
        layout.root,
        'versions',
        '1.2.0',
      ),
      { recursive: true },
    );
    await switchVersion(layout, '1.2.0');
    const state = join(directory, 'state');
    await writeUpdateState(updateStateFile(state), {
      v: 1,
      status: 'pending',
      from: '1.1.0',
      to: '1.2.0',
      switchedAt: Date.now(),
      starts: 0,
      blocked: [],
    });
    const logged: string[] = [];
    const options = {
      layout,
      stateDirectory: state,
      log: (message: string) => logged.push(message),
    };
    // The previous version is not on trial, so its failures change nothing.
    assert.equal(
      await abandonFailedUpdate({ ...options, running: '1.1.0' }),
      false,
    );
    assert.equal(await configuredVersion(layout), '1.2.0');
    assert.equal(
      await abandonFailedUpdate({ ...options, running: '1.2.0' }),
      true,
    );
    assert.equal(await configuredVersion(layout), '1.1.0');
    const saved = await readUpdateState(updateStateFile(state));
    assert.deepEqual(
      [saved?.status, saved?.blocked],
      ['rolled-back', ['1.2.0']],
    );
    assert.deepEqual(logged, [
      'Version 1.2.0 could not start. Returning to 1.1.0.',
    ]);
    // Nothing is pending any more.
    assert.equal(
      await abandonFailedUpdate({ ...options, running: '1.2.0' }),
      false,
    );
    assert.equal(await configuredVersion(layout), '1.1.0');
  });
}

void test(
  'a Windows update that fails before its updater starts returns at once',
  { skip: !onWindows && 'needs Windows paths' },
  () => failedStart('windows'),
);

void test(
  'a Linux update that fails before its updater starts returns at once',
  { skip: onWindows && 'needs symlinks' },
  () => failedStart('linux'),
);

void test(
  'the Linux current symlink switches atomically',
  { skip: onWindows && 'needs symlinks' },
  async () => {
    await withDirectory(async (directory) => {
      const layout: UpdateLayout = {
        kind: 'linux',
        root: directory,
        version: '1.1.0',
      };
      await mkdir(posix.join(directory, 'versions', '1.1.0'), {
        recursive: true,
      });
      await mkdir(posix.join(directory, 'versions', '1.2.0'), {
        recursive: true,
      });
      await switchVersion(layout, '1.1.0');
      await switchVersion(layout, '1.2.0');
      assert.equal(
        await readlink(posix.join(directory, 'current')),
        'versions/1.2.0',
      );
      assert.equal(await configuredVersion(layout), '1.2.0');
    });
  },
);
