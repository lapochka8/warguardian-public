import { spawn } from 'node:child_process';
import {
  createLinuxReforgerPlatform,
  type ReforgerHostPlatform,
} from './reforger-platform';

const linux = createLinuxReforgerPlatform();

/** An updater is a separate owned process group, never the game's group. */
export const ownedReforgerJobActive = (id: string, group?: number) =>
  linux.updater.active(id, group);
export async function runReforgerOwnedUpdate(input: {
  executable: string;
  installation: string;
  id: string;
  signal: AbortSignal;
  onSpawn: (group: number) => Promise<void>;
  output: (text: string) => Promise<void>;
  timeoutMs?: number;
  platform?: ReforgerHostPlatform;
}) {
  if (!input.platform && process.platform !== 'linux')
    throw new Error('Owned update groups require Linux.');
  const updater = (input.platform ?? linux).updater;
  if (input.signal.aborted)
    throw new Error('Update cancelled before dispatch.');
  const child = spawn(
    input.executable,
    [
      '+force_install_dir',
      input.installation,
      '+login',
      'anonymous',
      '+app_update',
      '1874900',
      'validate',
      '+quit',
    ],
    {
      detached: updater.detached,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WARGUARDIAN_UPDATER_JOB: input.id },
    },
  );
  let code: number | null = null,
    stopping = false,
    force: ReturnType<typeof setTimeout> | undefined;
  const exit = new Promise<void>((resolve) =>
    child.once('exit', (value) => {
      code = value;
      resolve();
    }),
  );
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const group = child.pid!;
  await updater.track?.(group).catch(() => {});
  const stop = () => {
    if (stopping) return;
    stopping = true;
    updater.stop(group, false);
    force = setTimeout(() => updater.stop(group, true), 10000);
  };
  const timer = setTimeout(stop, input.timeoutMs ?? 1800000);
  input.signal.addEventListener('abort', stop, { once: true });
  child.stdout?.on('data', (bytes: Buffer) => {
    void input.output(bytes.toString()).catch(() => {});
  });
  child.stderr?.on('data', (bytes: Buffer) => {
    void input.output(bytes.toString()).catch(() => {});
  });
  try {
    await input.onSpawn(group);
    if (input.signal.aborted) stop();
    await exit;
    while (await updater.active(input.id, group))
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (stopping || code !== 0)
      throw new Error(
        'The owned SteamCMD update did not complete successfully. Its processes have exited; inspect the retained installation before retrying.',
      );
    return 'SteamCMD update process completed. Review configuration and Workshop pins, then start the instance explicitly.';
  } catch (error) {
    stop();
    await exit;
    while (await updater.active(input.id, group))
      await new Promise((resolve) => setTimeout(resolve, 100));
    throw error;
  } finally {
    clearTimeout(timer);
    if (force) clearTimeout(force);
    input.signal.removeEventListener('abort', stop);
  }
}
