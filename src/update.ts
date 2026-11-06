import { execFile } from 'node:child_process';
import { createHash, randomBytes, type KeyObject } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { posix, win32 } from 'node:path';
import { boundedBody } from './client';
import { agentLocations } from './config';
import { AgentError } from './errors';
import {
  releaseChecksumsMaxBytes,
  releaseChecksumsName,
  releaseDigest,
  releasePublicKey,
  releaseSignatureName,
} from './release-sums';
import {
  agentPaths,
  verifyAgentUpdate,
  type AgentTargetId,
  type UpdateManifest,
} from './protocol';

/** The service manager restarts the agent after this exit code. */
export const restartExitCode = 75;
/** A new version must report healthy within this time, or the previous one returns. */
export const healthDeadlineMs = 120_000;
/** Starts of a pending version before it is rolled back. */
export const maximumPendingStarts = 3;
/** A version that failed its trial is not installed again for this long. */
export const blockLifetimeMs = 24 * 3_600_000;

const versionPattern = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;

/**
 * Installed layouts that support self-update:
 * - Linux: `<root>/versions/<v>/warguardian-agent`, started through the
 *   `<root>/current` symlink.
 * - Windows: `<root>\versions\<v>\warguardian-agent.exe`. WinSW starts the
 *   installed `<root>\warguardian-agent.exe service`, which runs the version
 *   named in `<state>\current-version`. The service account never writes
 *   the WinSW configuration, which elevated setup reads.
 */
export type UpdateLayout =
  | { kind: 'linux'; root: string; version: string }
  | { kind: 'windows'; root: string; version: string; stateDirectory: string };

export function detectLayout(
  execPath: string,
  platform: NodeJS.Platform,
  stateDirectory = agentLocations(platform).stateDirectory,
): UpdateLayout | null {
  const path = platform === 'win32' ? win32 : posix;
  const binary =
    platform === 'win32' ? 'warguardian-agent.exe' : 'warguardian-agent';
  if (path.basename(execPath).toLowerCase() !== binary) return null;
  const versionDirectory = path.dirname(execPath);
  const versions = path.dirname(versionDirectory);
  if (path.basename(versions) !== 'versions') return null;
  const version = path.basename(versionDirectory);
  if (!versionPattern.test(version)) return null;
  const root = path.dirname(versions);
  return platform === 'win32'
    ? { kind: 'windows', root, version, stateDirectory }
    : { kind: 'linux', root, version };
}

function layoutPath(layout: UpdateLayout) {
  return layout.kind === 'windows' ? win32 : posix;
}

export function binaryPath(layout: UpdateLayout, version: string): string {
  const path = layoutPath(layout);
  return path.join(
    layout.root,
    'versions',
    version,
    layout.kind === 'windows' ? 'warguardian-agent.exe' : 'warguardian-agent',
  );
}

/** The Windows version pointer: the version the service runs next. */
export function versionPointerFile(stateDirectory: string): string {
  return win32.join(stateDirectory, 'current-version');
}

export async function readVersionPointer(
  stateDirectory: string,
): Promise<string | null> {
  try {
    const value = (
      await fs.readFile(versionPointerFile(stateDirectory), 'utf8')
    ).trim();
    return versionPattern.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Replace the pointer with a file written beside it, so a reader never sees half of it. */
export async function writeVersionPointer(
  stateDirectory: string,
  version: string,
): Promise<void> {
  if (!versionPattern.test(version))
    throw new AgentError(500, 'update-failed', 'The version is invalid.');
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const file = versionPointerFile(stateDirectory);
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${version}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

/**
 * The version the Windows launcher starts instead of itself: the pointer,
 * when it names a newer version than the installed one and that build is a
 * plain file. A newer installer therefore wins over an older self-update.
 */
export async function selectVersion(options: {
  root: string;
  stateDirectory: string;
  installed: string;
}): Promise<{ version: string; binary: string } | null> {
  const version = await readVersionPointer(options.stateDirectory);
  if (!version || compareVersions(version, options.installed) <= 0) return null;
  const binary = win32.join(
    options.root,
    'versions',
    version,
    'warguardian-agent.exe',
  );
  const stat = await fs.lstat(binary).catch(() => null);
  return stat?.isFile() ? { version, binary } : null;
}

/** Semantic version order. A prerelease sorts before its release. */
export function compareVersions(left: string, right: string): number {
  const split = (value: string) => {
    const [core, pre] = value.split('-', 2) as [string, string | undefined];
    return { parts: core.split('.').map(Number), pre };
  };
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === undefined) return 1;
  if (b.pre === undefined) return -1;
  return a.pre < b.pre ? -1 : 1;
}

export type UpdateState = {
  v: 1;
  status: 'pending' | 'committed' | 'rolled-back';
  from: string;
  to: string;
  switchedAt: number;
  starts: number;
  /**
   * Versions that failed their health check. Earlier releases read only this
   * list and never install them again.
   */
  blocked: string[];
  /**
   * When each blocked version failed and the SHA-256 of that build. A block
   * ends after `blockLifetimeMs`, or when a manifest offers another build of
   * the version. A version without an entry counts from `switchedAt`.
   */
  blocks?: Record<string, { at: number; sha256?: string }>;
  /** The SHA-256 of the pending version's download. */
  toSha256?: string;
};

const sha256Pattern = /^[0-9a-f]{64}$/;

export function updateStateFile(stateDirectory: string): string {
  return (stateDirectory.includes('\\') ? win32 : posix).join(
    stateDirectory,
    'update.json',
  );
}

export async function readUpdateState(
  file: string,
): Promise<UpdateState | null> {
  try {
    const value = JSON.parse(
      await fs.readFile(file, 'utf8'),
    ) as Partial<UpdateState>;
    if (
      value?.v !== 1 ||
      !['pending', 'committed', 'rolled-back'].includes(
        value.status as string,
      ) ||
      typeof value.from !== 'string' ||
      typeof value.to !== 'string' ||
      !Number.isSafeInteger(value.switchedAt) ||
      !Number.isSafeInteger(value.starts)
    )
      return null;
    const blocked = Array.isArray(value.blocked)
      ? value.blocked.filter((item) => typeof item === 'string').slice(-20)
      : [];
    const saved: Record<string, unknown> =
      value.blocks && typeof value.blocks === 'object' ? value.blocks : {};
    const blocks: NonNullable<UpdateState['blocks']> = {};
    for (const version of blocked) {
      const entry = saved[version] as
        | { at?: unknown; sha256?: unknown }
        | undefined;
      if (!entry || !Number.isSafeInteger(entry.at)) continue;
      blocks[version] = {
        at: entry.at as number,
        ...(typeof entry.sha256 === 'string' && sha256Pattern.test(entry.sha256)
          ? { sha256: entry.sha256 }
          : {}),
      };
    }
    const { blocks: _blocks, toSha256, ...rest } = value as UpdateState;
    return {
      ...rest,
      blocked,
      ...(Object.keys(blocks).length ? { blocks } : {}),
      ...(typeof toSha256 === 'string' && sha256Pattern.test(toSha256)
        ? { toSha256 }
        : {}),
    };
  } catch {
    return null;
  }
}

/** When the block of `version` started. */
function blockedAt(state: UpdateState, version: string): number {
  return state.blocks?.[version]?.at ?? state.switchedAt;
}

/** True while `version` is blocked for the build with `sha256`. */
export function isBlocked(
  state: UpdateState | null,
  version: string,
  sha256: string,
  now: number,
): boolean {
  if (!state?.blocked.includes(version)) return false;
  if (now - blockedAt(state, version) >= blockLifetimeMs) return false;
  const failed = state.blocks?.[version]?.sha256;
  return !failed || failed === sha256;
}

/** The blocks still in force, without the versions in `except`. */
function currentBlocks(
  state: UpdateState | null,
  now: number,
  except: readonly string[] = [],
): Pick<UpdateState, 'blocked' | 'blocks'> {
  if (!state) return { blocked: [] };
  const blocked = state.blocked.filter(
    (version) =>
      !except.includes(version) &&
      now - blockedAt(state, version) < blockLifetimeMs,
  );
  const blocks = Object.fromEntries(
    blocked.flatMap((version) => {
      const entry = state.blocks?.[version];
      return entry ? [[version, entry] as const] : [];
    }),
  );
  return { blocked, ...(Object.keys(blocks).length ? { blocks } : {}) };
}

/** `state` rolled back, with its pending version blocked from `now`. */
function blockPending(state: UpdateState, now: number): UpdateState {
  const kept = currentBlocks(state, now, [state.to]);
  const { toSha256, ...rest } = state;
  return {
    ...rest,
    status: 'rolled-back',
    blocked: [...kept.blocked, state.to].slice(-20),
    blocks: {
      ...kept.blocks,
      [state.to]: { at: now, ...(toSha256 ? { sha256: toSha256 } : {}) },
    },
  };
}

export async function writeUpdateState(
  file: string,
  state: UpdateState,
): Promise<void> {
  const directory = (file.includes('\\') ? win32 : posix).dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

/**
 * What a starting process does with the saved state:
 * - `continue`: nothing pending for this version;
 * - `trial`: this is the new version, keep it until it reports healthy;
 * - `rollback`: the new version failed, return to the previous one;
 * - `settled`: the previous version runs again after a rollback.
 */
export type StartupDecision = 'continue' | 'trial' | 'rollback' | 'settled';

export function startupDecision(
  state: UpdateState | null,
  running: string,
  now: number,
): StartupDecision {
  if (!state || state.status !== 'pending') return 'continue';
  if (running === state.to)
    return state.starts >= maximumPendingStarts ||
      now - state.switchedAt > healthDeadlineMs
      ? 'rollback'
      : 'trial';
  if (running === state.from) return 'settled';
  return 'continue';
}

/** Switch back to the previous version of a pending update and block the failed one. */
async function returnToPrevious(
  layout: UpdateLayout,
  file: string,
  state: UpdateState,
  now: number,
): Promise<UpdateState> {
  await switchVersion(layout, state.from);
  const next = blockPending(state, now);
  await writeUpdateState(file, next);
  return next;
}

/**
 * The running version could not start its servers, for example because it
 * cannot read the configuration or its arguments. When it is a pending
 * update, the previous version returns at once. This needs no configuration,
 * so it works for failures before the updater starts. Returns true when the
 * process must restart on the previous version.
 */
export async function abandonFailedUpdate(options: {
  layout: UpdateLayout;
  stateDirectory: string;
  running: string;
  log: (message: string) => void;
}): Promise<boolean> {
  const file = updateStateFile(options.stateDirectory);
  const state = await readUpdateState(file);
  if (state?.status !== 'pending' || state.to !== options.running) return false;
  await returnToPrevious(options.layout, file, state, Date.now());
  options.log(
    `Version ${state.to} could not start. Returning to ${state.from}.`,
  );
  return true;
}

/** Point the service at `version`: the `current` symlink, or the Windows version pointer. */
export async function switchVersion(
  layout: UpdateLayout,
  version: string,
): Promise<void> {
  if (layout.kind === 'linux') {
    const current = posix.join(layout.root, 'current');
    const temporary = `${current}.${randomBytes(6).toString('hex')}`;
    await fs.symlink(posix.join('versions', version), temporary);
    try {
      await fs.rename(temporary, current);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    return;
  }
  await writeVersionPointer(layout.stateDirectory, version);
}

/** The version the service starts next: from the symlink or the Windows version pointer. */
export async function configuredVersion(
  layout: UpdateLayout,
): Promise<string | null> {
  try {
    if (layout.kind === 'linux')
      return posix.basename(
        await fs.readlink(posix.join(layout.root, 'current')),
      );
    return await readVersionPointer(layout.stateDirectory);
  } catch {
    return null;
  }
}

/**
 * Keys that sign updates. Both are pinned at build time. The panel signs the
 * manifest with an online key. The offline release key signs the
 * `SHA256SUMS` of each release, and both must name the download's digest.
 */
export type UpdateKeys = {
  /** Raw Ed25519 public keys in base64url that may sign the manifest envelope. */
  manifestKeys: readonly string[];
  /** The Ed25519 release key, the `release_public_key` of install.sh. */
  releaseKey: KeyObject;
};

/** The pinned keys of a build, or null when self-update is off because one is missing. */
export function updateKeysFor(info: {
  manifestKeys: readonly string[];
  releaseKey: string;
}): UpdateKeys | null {
  const releaseKey = releasePublicKey(info.releaseKey);
  if (!info.manifestKeys.length || !releaseKey) return null;
  return { manifestKeys: info.manifestKeys, releaseKey };
}

/** The largest artifact read when the manifest gives no size. */
const maximumArtifactBytes = 512 * 1024 * 1024;

/**
 * Fetch and verify the signed manifest of the current release. Returns null
 * when updates are unavailable or no newer version exists for this host.
 */
export async function fetchUpdate(options: {
  panel: string;
  target: AgentTargetId;
  running: string;
  keys: UpdateKeys;
  fetcher?: typeof fetch;
  now?: () => number;
}): Promise<UpdateManifest | null> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(new URL(agentPaths.update, options.panel), {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await boundedBody(response, 128 * 1024);
  // 503: the panel has no signing key or no release.
  if (response.status === 503 || response.status === 404) return null;
  if (!response.ok)
    throw new AgentError(
      502,
      'update-failed',
      `The update check failed (${response.status}).`,
    );
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AgentError(
      502,
      'update-failed',
      'The update response is not JSON.',
    );
  }
  const manifest = verifyAgentUpdate(
    body,
    options.keys.manifestKeys,
    (options.now ?? Date.now)(),
  );
  if (!manifest)
    throw new AgentError(
      502,
      'update-failed',
      'The update manifest does not match a pinned key, or it expired.',
    );
  if (compareVersions(manifest.version, options.running) <= 0) return null;
  if (!manifest.artifacts[options.target]) return null;
  return manifest;
}

/** A small release file beside the artifact, at most `maxBytes`. */
async function releaseFile(
  url: URL,
  maxBytes: number,
  fetcher: typeof fetch,
): Promise<Buffer> {
  const response = await fetcher(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new AgentError(
      502,
      'update-failed',
      `The release file ${url.pathname.split('/').pop()} could not be downloaded (${response.status}).`,
    );
  return boundedBody(response, maxBytes);
}

/**
 * Download an artifact to `destination`. First `SHA256SUMS` and
 * `SHA256SUMS.sig` come from the folder of the artifact: the signature must
 * match the pinned release key, the list must belong to the manifest's
 * version, and its digest for this host must equal the manifest's. The
 * download is then checked against that digest and its size while it
 * streams. A failed check removes the file.
 */
export async function downloadArtifact(options: {
  panel: string;
  manifest: UpdateManifest;
  target: AgentTargetId;
  releaseKey: KeyObject;
  destination: string;
  fetcher?: typeof fetch;
}): Promise<void> {
  if (!options.releaseKey)
    throw new AgentError(
      500,
      'update-failed',
      'No release key is pinned, so the update download cannot be checked.',
    );
  const artifact = options.manifest.artifacts[options.target];
  if (!artifact)
    throw new AgentError(
      502,
      'update-failed',
      'The manifest has no artifact for this host.',
    );
  const limit = artifact.size ?? maximumArtifactBytes;
  const fetcher = options.fetcher ?? fetch;
  const location = new URL(artifact.url, options.panel);
  const checksums = await releaseFile(
    new URL(releaseChecksumsName, location),
    releaseChecksumsMaxBytes,
    fetcher,
  );
  const signature = await releaseFile(
    new URL(releaseSignatureName, location),
    128,
    fetcher,
  );
  const signed = releaseDigest({
    checksums,
    signature,
    key: options.releaseKey,
    version: options.manifest.version,
    target: options.target,
  });
  if (signed !== artifact.sha256)
    throw new AgentError(
      502,
      'update-failed',
      'The SHA-256 of the manifest differs from the one in SHA256SUMS.',
    );
  const response = await fetcher(location, {
    redirect: 'follow',
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok || !response.body)
    throw new AgentError(
      502,
      'update-failed',
      `The update download failed (${response.status}).`,
    );
  const sha256 = createHash('sha256');
  const output = createWriteStream(options.destination, {
    flags: 'wx',
    mode: 0o700,
  });
  let size = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new AgentError(
          502,
          'update-failed',
          'The update download is larger than the manifest says.',
        );
      }
      sha256.update(value);
      if (!output.write(value))
        await new Promise<void>((resolve) =>
          output.once('drain', () => resolve()),
        );
    }
    await new Promise<void>((resolve, reject) =>
      output.end((error?: Error | null) => (error ? reject(error) : resolve())),
    );
    if (
      (artifact.size !== undefined && size !== artifact.size) ||
      sha256.digest('hex') !== signed
    )
      throw new AgentError(
        502,
        'update-failed',
        'The update download does not match its checksum.',
      );
  } catch (error) {
    // Wait for the stream to close, so the file is not created after it is removed.
    await new Promise<void>((resolve) => {
      if (output.closed) return resolve();
      output.once('close', () => resolve());
      output.destroy();
    });
    await fs.rm(options.destination, { force: true });
    throw error;
  }
}

/** Run `<binary> version --json` and require the expected version. */
export function preflight(binary: string, version: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ['version', '--json'],
      { timeout: 30_000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(false);
        try {
          resolve(
            (JSON.parse(stdout) as { version?: unknown }).version === version,
          );
        } catch {
          resolve(false);
        }
      },
    );
  });
}

export type UpdaterOptions = {
  layout: UpdateLayout;
  stateDirectory: string;
  running: string;
  target: AgentTargetId;
  panel: string;
  keys: UpdateKeys;
  log: (message: string) => void;
  /** Ends the process so the service manager starts the configured version. */
  restart: () => void;
  fetcher?: typeof fetch;
  now?: () => number;
  verifyBinary?: (binary: string, version: string) => Promise<boolean>;
};

/**
 * Install a newer signed version, switch to it and restart. The new version
 * stays on trial until a signed poll succeeds. If it does not within two
 * minutes, or it fails to start three times, the previous version returns.
 */
export function createUpdater(options: UpdaterOptions) {
  const now = options.now ?? Date.now;
  const stateFile = updateStateFile(options.stateDirectory);
  const path = layoutPath(options.layout);
  let trialTimer: NodeJS.Timeout | undefined;
  let state: UpdateState | null = null;
  let checking = false;
  const versionsDirectory = path.join(options.layout.root, 'versions');

  /**
   * Delete version folders, never one in `keep`. A rolled-back build goes,
   * so `versions` keeps the running version and the one before it. Staging
   * folders of downloads interrupted over an hour ago go too.
   */
  async function removeVersions(names: readonly string[], keep: Set<string>) {
    const present = await fs
      .readdir(versionsDirectory)
      .catch(() => [] as string[]);
    for (const name of present) {
      const folder = path.join(versionsDirectory, name);
      let remove = names.includes(name) && !keep.has(name);
      if (name.startsWith('.'))
        remove =
          now() -
            (await fs.stat(folder).catch(() => ({ mtimeMs: now() }))).mtimeMs >
          3_600_000;
      if (remove)
        await fs
          .rm(folder, { recursive: true, force: true })
          .catch(() => undefined);
    }
  }

  async function rollBack(reason: string) {
    if (!state) return;
    const failed = state.to;
    state = await returnToPrevious(options.layout, stateFile, state, now());
    options.log(`Version ${failed} ${reason}. Returning to ${state.from}.`);
    options.restart();
  }

  return {
    /** Apply the saved state at start. Returns false when the process must restart. */
    async start(): Promise<boolean> {
      state = await readUpdateState(stateFile);
      const decision = startupDecision(state, options.running, now());
      if (decision === 'rollback') {
        await rollBack('did not report healthy');
        return false;
      }
      if (decision === 'settled' && state) {
        state = blockPending(state, now());
        await writeUpdateState(stateFile, state);
      }
      if (state?.status === 'rolled-back')
        await removeVersions(
          state.blocked,
          new Set([
            options.running,
            (await configuredVersion(options.layout)) ?? '',
          ]),
        );
      if (decision === 'trial' && state) {
        state = { ...state, starts: state.starts + 1 };
        await writeUpdateState(stateFile, state);
        const remaining = Math.max(
          0,
          state.switchedAt + healthDeadlineMs - now(),
        );
        trialTimer = setTimeout(() => {
          if (state?.status === 'pending')
            void rollBack('did not report healthy');
        }, remaining);
        trialTimer.unref();
      }
      return true;
    },

    /** A signed poll succeeded. */
    async healthy(): Promise<void> {
      if (state?.status !== 'pending' || options.running !== state.to) return;
      clearTimeout(trialTimer);
      state = { ...state, status: 'committed' };
      await writeUpdateState(stateFile, state);
      options.log(`Version ${state.to} is healthy.`);
      const keep = new Set([state.to, state.from]);
      const versions = path.join(options.layout.root, 'versions');
      const names = await fs.readdir(versions).catch(() => [] as string[]);
      await removeVersions(
        names.filter((name) => !name.startsWith('.')),
        keep,
      );
    },

    /** Check for a newer version and install it. Restarts the process on success. */
    async check(): Promise<'current' | 'blocked' | 'installed' | 'busy'> {
      if (checking || state?.status === 'pending') return 'busy';
      checking = true;
      const lock = path.join(options.stateDirectory, 'update.lock');
      let locked = false;
      try {
        await fs.mkdir(options.stateDirectory, {
          recursive: true,
          mode: 0o700,
        });
        try {
          await fs.writeFile(lock, String(process.pid), {
            flag: 'wx',
            mode: 0o600,
          });
          locked = true;
        } catch {
          const age =
            now() -
            (await fs.stat(lock).catch(() => ({ mtimeMs: now() }))).mtimeMs;
          if (age < 15 * 60_000) return 'busy';
          await fs.writeFile(lock, String(process.pid), { mode: 0o600 });
          locked = true;
        }
        const manifest = await fetchUpdate({
          panel: options.panel,
          target: options.target,
          running: options.running,
          keys: options.keys,
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        });
        if (!manifest) return 'current';
        const artifact = manifest.artifacts[options.target]!;
        const saved = await readUpdateState(stateFile);
        if (isBlocked(saved, manifest.version, artifact.sha256, now()))
          return 'blocked';
        const versions = path.join(options.layout.root, 'versions');
        const staging = path.join(
          versions,
          `.${manifest.version}.${randomBytes(6).toString('hex')}`,
        );
        await fs.mkdir(staging, { recursive: true, mode: 0o755 });
        const name =
          options.layout.kind === 'windows'
            ? 'warguardian-agent.exe'
            : 'warguardian-agent';
        try {
          await downloadArtifact({
            panel: options.panel,
            manifest,
            target: options.target,
            releaseKey: options.keys.releaseKey,
            destination: path.join(staging, name),
            ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          });
          if (options.layout.kind === 'linux')
            await fs.chmod(path.join(staging, name), 0o755);
          const final = path.join(versions, manifest.version);
          await fs.rm(final, { recursive: true, force: true });
          await fs.rename(staging, final);
        } catch (error) {
          await fs.rm(staging, { recursive: true, force: true });
          throw error;
        }
        const binary = binaryPath(options.layout, manifest.version);
        if (
          !(await (options.verifyBinary ?? preflight)(binary, manifest.version))
        ) {
          await fs.rm(path.dirname(binary), { recursive: true, force: true });
          throw new AgentError(
            502,
            'update-failed',
            `Version ${manifest.version} did not start.`,
          );
        }
        state = {
          v: 1,
          status: 'pending',
          from: options.running,
          to: manifest.version,
          switchedAt: now(),
          starts: 0,
          ...currentBlocks(saved, now(), [manifest.version]),
          toSha256: artifact.sha256,
        };
        await writeUpdateState(stateFile, state);
        await switchVersion(options.layout, manifest.version);
        options.log(`Installed version ${manifest.version}. Restarting.`);
        options.restart();
        return 'installed';
      } finally {
        if (locked) await fs.rm(lock, { force: true });
        checking = false;
      }
    },

    close() {
      clearTimeout(trialTimer);
    },
  };
}
