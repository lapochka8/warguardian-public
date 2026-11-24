import { promises as fs } from 'node:fs';
import { loadavg } from 'node:os';

/** One process as the host reports it. Fields the account cannot read are null. */
export type ReforgerProcessInfo = {
  pid: number;
  /** The start time the host reports. With the PID it names one process. */
  start: string;
  /** The canonical path of the executable. */
  executable: string | null;
  argv: string[];
};

/** CPU time counters. `total` and a process's `ticks` share one unit. */
export type ReforgerMachineUsage = {
  cpu: { total: number; idle: number } | null;
  memory: { total: number; used: number } | null;
};
export type ReforgerProcessUsage = {
  ticks: number | null;
  memoryBytes: number | null;
};

/**
 * What the host controller asks of the operating system. The controller
 * runs on Linux by default. The Agent supplies the Windows host.
 */
export type ReforgerHostPlatform = {
  /**
   * One live process, or null when it is gone or cannot be read. This and
   * `running` reject when the host cannot be asked, so a failed query never
   * reads as a stopped game.
   */
  inspect(pid: number): Promise<ReforgerProcessInfo | null>;
  /** The readable processes that run `executable`, a canonical path. */
  running(executable: string): Promise<ReforgerProcessInfo[]>;
  /** Whether two absolute paths name the same file on this host. */
  samePath(a: string, b: string): boolean;
  /** Start the game outside the Agent's own process group or job. */
  detached: boolean;
  /**
   * Whether `stop` lets the game shut down by itself. The controller words
   * a game that keeps running by this.
   */
  gracefulStop: boolean;
  /** Ask the game to stop and return at once. */
  stop(pid: number): void;
  machine(): Promise<ReforgerMachineUsage>;
  usage(pid: number): Promise<ReforgerProcessUsage>;
  loadAverage(): number | null;
  updater: {
    detached: boolean;
    /** Called once the updater `root` has started. */
    track?(root: number): Promise<void>;
    /** Stop the updater `root` and every process it started. */
    stop(root: number, force: boolean): void;
    /** True while the updater of job `id` or a process it started runs. */
    active(id: string, root?: number): Promise<boolean>;
  };
};

/** Reads total and idle CPU time from the first line of /proc/stat. */
export function parseProcStat(text: string) {
  const line = text.split('\n').find((row) => row.startsWith('cpu '));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some((value) => !Number.isFinite(value)))
    return null;
  const idle = values[3] + (values[4] ?? 0);
  return { total: values.slice(0, 8).reduce((a, b) => a + b, 0), idle };
}
/** Reads user plus system CPU ticks of one process from /proc/<pid>/stat. */
export function parseProcessStat(text: string) {
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  const user = Number(fields[11]),
    system = Number(fields[12]);
  return Number.isFinite(user) && Number.isFinite(system)
    ? user + system
    : null;
}
export function parseMemInfo(text: string) {
  const value = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = value('MemTotal'),
    available = value('MemAvailable');
  return total === null || available === null
    ? null
    : { total, used: total - available };
}

/** The fields of /proc/<pid>/stat after the command name. */
const statFields = (text: string) =>
  text.slice(text.lastIndexOf(')') + 2).split(' ');

/**
 * Linux through /proc. Missing files leave values empty instead of
 * estimating them, so on another system every read comes back empty.
 */
export function createLinuxReforgerPlatform(
  read: (path: string) => Promise<string> = (path) => fs.readFile(path, 'utf8'),
): ReforgerHostPlatform {
  async function inspect(pid: number): Promise<ReforgerProcessInfo | null> {
    let start: string | undefined;
    try {
      start = statFields(await read(`/proc/${pid}/stat`))[19];
    } catch {
      return null;
    }
    if (!start) return null;
    let executable: string | null = null,
      argv: string[] = [];
    try {
      executable = await fs.realpath(`/proc/${pid}/exe`);
      argv = (await fs.readFile(`/proc/${pid}/cmdline`)).toString().split('\0');
    } catch {
      /* The process exited, or it belongs to another service account. */
    }
    return { pid, start, executable, argv };
  }
  /** An updater is a separate owned process group, never the game's group. */
  async function updaterActive(id: string, group?: number) {
    if (process.platform !== 'linux') return false;
    const marker = Buffer.from(`WARGUARDIAN_UPDATER_JOB=${id}\0`);
    for (const pid of (await fs.readdir('/proc')).filter((value) =>
      /^\d+$/.test(value),
    )) {
      try {
        const fields = statFields(
          await fs.readFile(`/proc/${pid}/stat`, 'utf8'),
        );
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
  return {
    inspect,
    async running(executable) {
      let entries: string[];
      try {
        entries = await fs.readdir('/proc');
      } catch {
        return [];
      }
      const found: ReforgerProcessInfo[] = [];
      for (const entry of entries.filter((item) => /^\d+$/.test(item))) {
        const info = await inspect(Number(entry));
        if (info?.executable === executable) found.push(info);
      }
      return found;
    },
    samePath: (a, b) => a === b,
    detached: process.platform === 'linux',
    gracefulStop: true,
    stop(pid) {
      process.kill(pid, 'SIGTERM');
    },
    async machine() {
      return {
        cpu: await read('/proc/stat')
          .then(parseProcStat)
          .catch(() => null),
        memory: await read('/proc/meminfo')
          .then(parseMemInfo)
          .catch(() => null),
      };
    },
    async usage(pid) {
      return {
        ticks: await read(`/proc/${pid}/stat`)
          .then(parseProcessStat)
          .catch(() => null),
        memoryBytes: await read(`/proc/${pid}/status`)
          .then((text) => {
            const match = /^VmRSS:\s+(\d+) kB/m.exec(text);
            return match ? Number(match[1]) * 1024 : null;
          })
          .catch(() => null),
      };
    },
    loadAverage: () => (process.platform === 'linux' ? loadavg()[0] : null),
    updater: {
      detached: true,
      stop(group, force) {
        try {
          process.kill(-group, force ? 'SIGKILL' : 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      },
      active: updaterActive,
    },
  };
}
