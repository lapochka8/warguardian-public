import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

/** An updater is a separate owned process group, never the game's group. */
export async function ownedReforgerJobActive(id: string, group?: number) {
  if (process.platform !== 'linux') return false;
  const marker = Buffer.from(`WARGUARDIAN_UPDATER_JOB=${id}\0`);
  for (const pid of (await fs.readdir('/proc')).filter((value) =>
    /^\d+$/.test(value),
  )) {
    try {
      const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8'),
        fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') continue;
      if (group && Number(fields[2]) === group && Number(fields[3]) === group)
        return true;
      if ((await fs.readFile(`/proc/${pid}/environ`)).includes(marker))
        return true;
    } catch {
      /* Other processes can exit or belong to another service account. */
    }
  }
  return false;
}
export async function runReforgerOwnedUpdate(input: {
  executable: string;
  installation: string;
  id: string;
  signal: AbortSignal;
  onSpawn: (group: number) => Promise<void>;
  output: (text: string) => Promise<void>;
  timeoutMs?: number;
}) {
  if (process.platform !== 'linux')
    throw new Error('Owned update groups require Linux.');
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
      detached: true,
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
  const signal = (value: NodeJS.Signals) => {
    try {
      process.kill(-group, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    signal('SIGTERM');
    force = setTimeout(() => signal('SIGKILL'), 10000);
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
    while (await ownedReforgerJobActive(input.id, group))
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (stopping || code !== 0)
      throw new Error(
        'The owned SteamCMD update did not complete successfully. Its processes have exited; inspect the retained installation before retrying.',
      );
    return 'SteamCMD update process completed. Review configuration and Workshop pins, then start the instance explicitly.';
  } catch (error) {
    stop();
    await exit;
    while (await ownedReforgerJobActive(input.id, group))
      await new Promise((resolve) => setTimeout(resolve, 100));
    throw error;
  } finally {
    clearTimeout(timer);
    if (force) clearTimeout(force);
    input.signal.removeEventListener('abort', stop);
  }
}
