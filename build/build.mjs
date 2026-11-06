import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveNodeBinary, sha256 } from './node-binaries.mjs';
import {
  authenticodeConfig,
  manifestPublicKeys,
  updateKeyId,
  authenticodeSign,
  innoSignTool,
  minisignConfig,
  minisignPublicKeyFile,
  minisignSign,
} from './signing.mjs';
import { installerReleaseKey } from './release.mjs';

export const agentTargets = ['linux-x64', 'linux-arm64', 'win-x64'];

/** WinSW 2.12.0 x64, as published on its GitHub release. */
export const winswSha256 =
  '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da';

const seaFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.status}.`);
  return result;
}

function artifactName(target) {
  return target === 'win-x64'
    ? 'warguardian-agent-win-x64.exe'
    : `warguardian-agent-${target}`;
}

/** Release keys of the built files: each executable and the Windows installer. */
const releaseKeys = (artifacts) => [
  ...agentTargets
    .filter((target) => artifacts[target])
    .map((target) => [target, artifacts[target]]),
  ...(artifacts.installer ? [['win-x64-installer', artifacts.installer]] : []),
];

/**
 * The release file for the panel: one entry per executable and one for the
 * Windows installer, each with its SHA-256, minisign signature, size and
 * download path.
 */
export function releaseFor({
  version,
  artifacts,
  downloadBase = '/downloads/agent',
}) {
  return {
    version,
    artifacts: Object.fromEntries(
      releaseKeys(artifacts).map(([key, artifact]) => [
        key,
        {
          sha256: artifact.sha256,
          sig: artifact.sig,
          url: `${downloadBase}/${version}/${artifact.file}`,
          size: artifact.size,
        },
      ]),
    ),
  };
}

/**
 * Where the build finds its inputs, relative to `root`:
 * - `entry`: the agent command line module;
 * - `license`: the license shown by the Windows installer;
 * - `serviceXml` and `installerScript`: the WinSW configuration and the
 *   Inno Setup script;
 * - `installScript`: install.sh, whose `release_public_key` the agent pins
 *   to check `SHA256SUMS` during self-update;
 * - `alias`: optional import prefixes, as `{ find, replacement }` with the
 *   replacement relative to `root`.
 */
function sourcesFor(options) {
  const sources = options.sources;
  for (const name of [
    'entry',
    'license',
    'serviceXml',
    'installerScript',
    'installScript',
  ])
    if (typeof sources?.[name] !== 'string')
      throw new Error(`Name the ${name} file in the build sources.`);
  return sources;
}

/**
 * Self-update needs both pinned keys: the manifest key of the panel and the
 * release key of install.sh. A manifest key without the release key would
 * let the online key alone install a build, so that build is refused. A
 * release key alone leaves self-update off.
 */
export function checkUpdateKeys(manifestKeys, releaseKeyLine) {
  if (manifestKeys.length && !releaseKeyLine)
    throw new Error(
      'Manifest public keys are set, but install.sh holds no release_public_key.',
    );
}

/** The `release_public_key` of install.sh, the one release key of the agent and its installer. */
function pinnedReleaseKey(root, sources) {
  return installerReleaseKey(
    readFileSync(join(root, sources.installScript), 'utf8'),
  );
}

/** Bundle the agent into one CommonJS file with its build values. */
async function bundle({
  root,
  sources,
  work,
  version,
  manifestKeys,
  releaseKey,
  panel,
}) {
  const { build } = await import('vite');
  await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    resolve: {
      alias: (sources.alias ?? []).map(({ find, replacement }) => ({
        find,
        replacement: resolve(root, replacement),
      })),
    },
    define: {
      __WARGUARDIAN_AGENT_VERSION__: JSON.stringify(version),
      __WARGUARDIAN_AGENT_MANIFEST_KEYS__: JSON.stringify(
        manifestKeys.join(','),
      ),
      __WARGUARDIAN_AGENT_RELEASE_KEY__: JSON.stringify(releaseKey ?? ''),
      __WARGUARDIAN_AGENT_PANEL__: JSON.stringify(panel ?? ''),
    },
    ssr: { target: 'node', noExternal: true },
    build: {
      ssr: resolve(root, sources.entry),
      target: 'node22',
      outDir: work,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      rolldownOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'warguardian-agent.cjs',
          codeSplitting: false,
        },
      },
    },
  });
  return join(work, 'warguardian-agent.cjs');
}

/** The version to build: `WARGUARDIAN_AGENT_VERSION` or the package version. */
function versionFor(root, env) {
  return (
    env.WARGUARDIAN_AGENT_VERSION ||
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  );
}

/**
 * Remove the Authenticode signature of a PE file in place: clear the
 * certificate table entry and the checksum, and cut the table from the end
 * of the file. The Node.js runtime is signed by its publisher, and that
 * signature no longer matches once the agent is injected.
 */
export function stripAuthenticode(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 64 || bytes.toString('latin1', 0, 2) !== 'MZ')
    throw new Error(`${file} is not a Windows executable.`);
  const header = bytes.readUInt32LE(0x3c);
  if (bytes.toString('latin1', header, header + 4) !== 'PE\0\0')
    throw new Error(`${file} has no PE header.`);
  const optional = header + 24;
  const magic = bytes.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b)
    throw new Error(`${file} has an unknown optional header.`);
  const directories = optional + (magic === 0x20b ? 112 : 96);
  if (bytes.readUInt32LE(directories - 4) <= 4) return false;
  const entry = directories + 4 * 8;
  const offset = bytes.readUInt32LE(entry);
  const size = bytes.readUInt32LE(entry + 4);
  if (!offset || !size) return false;
  bytes.writeUInt32LE(0, entry);
  bytes.writeUInt32LE(0, entry + 4);
  bytes.writeUInt32LE(0, optional + 64);
  // The table is the last item of a signed file, padded to 8 bytes.
  const last = offset <= bytes.length && offset + size >= bytes.length - 8;
  writeFileSync(file, last ? bytes.subarray(0, offset) : bytes);
  return true;
}

/**
 * Build the agent bundle, the single executables, the Windows installer and
 * the manifests in `outDir`. Signing runs only where it is configured.
 * `pinnedNode` embeds the pinned nodejs.org runtime for every target, the
 * host target included, and downloads it when the cache does not hold it.
 */
export async function buildAgent(options) {
  const root = options.root;
  const sources = sourcesFor(options);
  const env = options.env ?? process.env;
  const version = versionFor(root, env);
  const outDir = resolve(options.outDir ?? join(root, 'dist/agent', version));
  const work = join(outDir, '.work');
  const targets = options.targets ?? agentTargets;
  const authenticode = authenticodeConfig(env);
  const minisign = minisignConfig(env);
  const manifestKeys = manifestPublicKeys(env);
  const releaseKey = pinnedReleaseKey(root, sources);
  checkUpdateKeys(manifestKeys, releaseKey);
  const downloadBase = (
    env.WARGUARDIAN_AGENT_DOWNLOAD_BASE || '/downloads/agent'
  ).replace(/\/$/, '');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const bundlePath = await bundle({
    root,
    sources,
    work,
    version,
    manifestKeys,
    releaseKey,
    panel: env.WARGUARDIAN_AGENT_PANEL,
  });
  copyFileSync(bundlePath, join(outDir, 'warguardian-agent.cjs'));

  const seaConfig = join(work, 'sea-config.json');
  const blob = join(work, 'sea-prep.blob');
  writeFileSync(
    seaConfig,
    JSON.stringify({
      main: bundlePath,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    }),
  );
  run(process.execPath, ['--experimental-sea-config', seaConfig]);
  const blobBytes = readFileSync(blob);
  const { inject } = await import('postject');

  const artifacts = {};
  const record = (name, extra = {}) => {
    const file = join(outDir, name);
    const bytes = readFileSync(file);
    const entry = {
      file: name,
      size: statSync(file).size,
      sha256: sha256(bytes),
      ...extra,
    };
    if (minisign?.privateKey) {
      const sig = minisignSign(
        minisign,
        bytes,
        `file:${name} version:${version} sha256:${entry.sha256}`,
      );
      writeFileSync(`${file}.minisig`, sig);
      entry.sig = sig;
    }
    return entry;
  };
  artifacts.bundle = record('warguardian-agent.cjs');

  const runtimes = {};
  const skipped = {};
  for (const target of targets) {
    let runtime;
    try {
      runtime = await resolveNodeBinary(target, {
        env,
        cacheDirectory:
          options.cacheDirectory ?? join(root, 'dist/agent-node-cache'),
        fetch: !!options.fetchNode || !!options.pinnedNode,
        pinned: !!options.pinnedNode,
      });
    } catch (error) {
      if (options.requireAll) throw error;
      skipped[target] = error.message;
      console.warn(`Skipped ${target}: ${error.message}`);
      continue;
    }
    const name = artifactName(target);
    const file = join(outDir, name);
    copyFileSync(runtime.path, file);
    chmodSync(file, 0o755);
    if (target === 'win-x64') stripAuthenticode(file);
    await inject(file, 'NODE_SEA_BLOB', blobBytes, {
      sentinelFuse: seaFuse,
      overwrite: true,
    });
    if (target === 'win-x64' && authenticode)
      authenticodeSign(authenticode, file);
    runtimes[target] = { node: runtime.version, source: runtime.source };
    artifacts[target] = record(name, { target, node: runtime.version });
  }

  const hostTarget =
    process.platform === 'win32' && process.arch === 'x64'
      ? 'win-x64'
      : process.platform === 'linux'
        ? `linux-${process.arch}`
        : null;
  if (hostTarget && artifacts[hostTarget]) {
    const result = spawnSync(
      join(outDir, artifactName(hostTarget)),
      ['version', '--json'],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    if (result.status !== 0 || JSON.parse(result.stdout).version !== version)
      throw new Error(
        `The ${hostTarget} executable did not report version ${version}.`,
      );
  }

  let installer = null;
  if (options.installer !== false && artifacts['win-x64'])
    installer = buildInstaller({
      root,
      sources,
      env,
      outDir,
      work,
      executable: join(outDir, 'warguardian-agent-win-x64.exe'),
      version,
      authenticode,
    });
  if (installer) artifacts.installer = record(installer, { target: 'win-x64' });
  else if (options.installer !== false && artifacts['win-x64'])
    skipped.installer = 'WARGUARDIAN_ISCC or WARGUARDIAN_WINSW is not set.';

  const unsigned = [
    ...(authenticode
      ? []
      : ['Authenticode: Windows executable, WinSW and installer']),
    ...(minisign?.privateKey
      ? []
      : ['minisign: executables, bundle and installer (no release.json)']),
    ...(manifestKeys.length ? [] : ['self-update: no update keys are pinned']),
  ];
  const summary = {
    v: 1,
    product: 'warguardian-agent',
    version,
    builtAt: new Date().toISOString(),
    signed: { authenticode: !!authenticode, minisign: !!minisign?.privateKey },
    selfUpdate: manifestKeys.length > 0 && !!releaseKey,
    releaseKeyPinned: !!releaseKey,
    manifestKeyIds: manifestKeys.map((key) =>
      updateKeyId(Buffer.from(key, 'base64url')),
    ),
    runtimes,
    artifacts,
    skipped,
  };
  writeFileSync(
    join(outDir, 'artifacts.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  if (minisign?.publicKeyLine)
    writeFileSync(
      join(outDir, 'warguardian-agent.pub'),
      minisignPublicKeyFile(minisign.publicKeyLine),
    );

  // The release file the panel reads to fill install.sh and sign update manifests.
  if (minisign?.privateKey) {
    const text = `${JSON.stringify(releaseFor({ version, artifacts, downloadBase }), null, 2)}\n`;
    writeFileSync(join(outDir, 'release.json'), text);
    // WARGUARDIAN_AGENT_RELEASE_FILE: also publish into a panel tree, with the
    // executables in <release folder>/<version>/.
    const published = env.WARGUARDIAN_AGENT_RELEASE_FILE;
    if (published) {
      const folder = join(dirname(resolve(published)), version);
      mkdirSync(folder, { recursive: true });
      for (const [, artifact] of releaseKeys(artifacts))
        copyFileSync(join(outDir, artifact.file), join(folder, artifact.file));
      writeFileSync(resolve(published), text);
    }
  }
  if (unsigned.length) {
    writeFileSync(
      join(outDir, 'UNSIGNED.txt'),
      `Unsigned build ${version}\n${unsigned.map((item) => `- ${item}`).join('\n')}\n`,
    );
    console.warn(`Unsigned build: ${unsigned.join('; ')}.`);
  }
  rmSync(work, { recursive: true, force: true });
  return { outDir, summary };
}

/**
 * Build only the Windows installer around an agent executable that was built
 * and signed before, such as the `warguardian-agent-win-x64.exe` of a
 * release. Returns the installer path. ISCC and WinSW must be set.
 */
export function buildWindowsInstaller(options) {
  const root = options.root;
  const sources = sourcesFor(options);
  const env = options.env ?? process.env;
  const version = versionFor(root, env);
  const executable = resolve(options.executable);
  if (!existsSync(executable))
    throw new Error(`${options.executable} does not name a file.`);
  const outDir = resolve(options.outDir);
  const work = join(outDir, '.installer-work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const installer = buildInstaller({
      root,
      sources,
      env,
      outDir,
      work,
      executable,
      version,
      authenticode: authenticodeConfig(env),
    });
    if (!installer)
      throw new Error('Set WARGUARDIAN_ISCC and WARGUARDIAN_WINSW.');
    return join(outDir, installer);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Compile the Inno Setup installer. Returns its file name, or null when the tools are not set. */
function buildInstaller({
  root,
  sources,
  env,
  outDir,
  work,
  executable,
  version,
  authenticode,
}) {
  const iscc = env.WARGUARDIAN_ISCC;
  const winsw = env.WARGUARDIAN_WINSW;
  if (!iscc || !winsw) return null;
  if (!existsSync(iscc))
    throw new Error('WARGUARDIAN_ISCC does not name a file.');
  if (!existsSync(winsw))
    throw new Error('WARGUARDIAN_WINSW does not name a file.');
  const winswBytes = readFileSync(winsw);
  if (sha256(winswBytes) !== winswSha256)
    throw new Error('WARGUARDIAN_WINSW is not WinSW 2.12.0 x64.');
  const staging = join(work, 'installer');
  mkdirSync(staging, { recursive: true });
  copyFileSync(executable, join(staging, 'warguardian-agent.exe'));
  copyFileSync(winsw, join(staging, 'warguardian-agent-service.exe'));
  if (authenticode)
    authenticodeSign(
      authenticode,
      join(staging, 'warguardian-agent-service.exe'),
    );
  copyFileSync(
    join(root, sources.serviceXml),
    join(staging, 'warguardian-agent-service.xml'),
  );
  const license = join(root, sources.license);
  if (existsSync(license)) copyFileSync(license, join(staging, 'LICENSE.txt'));
  else
    console.warn(
      `${sources.license} is missing. The installer has no license page.`,
    );
  const base = `WarGuardianAgentSetup-${version}`;
  const numeric = /^\d+\.\d+\.\d+/.exec(version)?.[0] ?? '0.0.0';
  run(iscc, [
    '/Qp',
    `/DAgentVersion=${version}`,
    `/DAgentNumericVersion=${numeric}`,
    `/DStagingDir=${staging}`,
    `/DPanelDefault=${env.WARGUARDIAN_AGENT_PANEL ?? ''}`,
    ...(existsSync(license) ? ['/DWithLicense=1'] : []),
    ...(authenticode
      ? [`/Swgsign=${innoSignTool(authenticode)}`, '/DSignToolName=wgsign']
      : []),
    `/O${outDir}`,
    `/F${base}`,
    join(root, sources.installerScript),
  ]);
  return `${base}.exe`;
}
