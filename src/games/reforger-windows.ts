import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { win32 } from 'node:path';
import type {
  ReforgerHostPlatform,
  ReforgerProcessInfo,
} from '../../vendor/reforger/reforger-platform';
import { splitWindowsCommandLine, windowsPowerShell } from '../discovery';

/** One row of `Win32_Process`. */
export type WindowsProcessRow = {
  pid: number;
  parent: number | null;
  /** Creation time as a Windows file time. Empty when Windows gives none. */
  start: string;
  executable: string | null;
  argv: string[];
  memoryBytes: number | null;
  /** Kernel plus user CPU time in milliseconds. */
  cpuMs: number | null;
};

const select =
  "Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,WorkingSetSize,KernelModeTime,UserModeTime,@{n='Start';e={if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc().ToString() } else { '' }}} | ConvertTo-Json -Compress";

/** The `Win32_Process` query, for every process or for one PID. */
export function windowsProcessQuery(pid?: number): string {
  if (pid !== undefined && !(Number.isSafeInteger(pid) && pid > 0))
    throw new Error('The process ID is invalid.');
  return `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process${pid === undefined ? '' : ` -Filter "ProcessId = ${pid}"`} | ${select}`;
}

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;

export function parseWindowsProcessRows(output: string): WindowsProcessRow[] {
  if (!output.trim()) return [];
  const value: unknown = JSON.parse(output);
  const rows: WindowsProcessRow[] = [];
  for (const row of Array.isArray(value) ? value : [value]) {
    if (!row || typeof row !== 'object') continue;
    const fields = row as Record<string, unknown>;
    if (typeof fields.ProcessId !== 'number' || fields.ProcessId <= 0) continue;
    const kernel = count(fields.KernelModeTime),
      user = count(fields.UserModeTime);
    rows.push({
      pid: fields.ProcessId,
      parent: count(fields.ParentProcessId),
      start:
        typeof fields.Start === 'string' && /^\d{1,20}$/.test(fields.Start)
          ? fields.Start
          : '',
      executable:
        typeof fields.ExecutablePath === 'string' && fields.ExecutablePath
          ? fields.ExecutablePath
          : null,
      argv:
        typeof fields.CommandLine === 'string'
          ? splitWindowsCommandLine(fields.CommandLine)
          : [],
      memoryBytes: count(fields.WorkingSetSize),
      // Windows counts both in units of 100 nanoseconds.
      cpuMs: kernel === null || user === null ? null : (kernel + user) / 10_000,
    });
  }
  return rows;
}

/** Windows: processes from `Win32_Process`. Rejects when the query fails. */
function listWindowsProcesses(pid?: number): Promise<WindowsProcessRow[]> {
  const powershell = windowsPowerShell();
  return new Promise((resolve, reject) => {
    execFile(
      powershell.command,
      ['-NoProfile', '-NonInteractive', '-Command', windowsProcessQuery(pid)],
      {
        env: powershell.env,
        timeout: 20_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => {
        try {
          if (error) throw error;
          resolve(parseWindowsProcessRows(stdout));
        } catch {
          reject(new Error('Windows did not report the running processes.'));
        }
      },
    );
  });
}

export type WindowsReforgerSystem = {
  list: (pid?: number) => Promise<WindowsProcessRow[]>;
  /** Whether a process with this ID exists. */
  alive: (pid: number) => boolean;
  /** End one process at once. */
  kill: (pid: number) => void;
  /** End one process and every process it started. */
  killTree: (pid: number) => void;
  realpath: (path: string) => Promise<string>;
  now: () => number;
};

const windowsSystem: WindowsReforgerSystem = {
  list: listWindowsProcesses,
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  kill(pid) {
    process.kill(pid);
  },
  killTree(pid) {
    execFile(
      win32.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'taskkill.exe',
      ),
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 20_000 },
      () => {},
    );
  },
  realpath: (path) => fs.realpath(path),
  now: Date.now,
};

/** How long the identity of a live PID is trusted without asking again. */
const identityMs = 30_000;
/** How long one reading of a process's CPU time and memory is reused. */
const usageMs = 10_000;
/** How long one list of every process answers `running`. */
const listMs = 2_000;

const samePath = (a: string, b: string) =>
  win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();

const later = (start: string, than: string) => {
  try {
    return BigInt(start) >= BigInt(than);
  } catch {
    return false;
  }
};

/**
 * The Windows host of the Arma Reforger controller. Windows has no signal
 * that asks a process to stop, so `stop` ends the game at once. The game is
 * started outside the Agent's job, so it survives an Agent restart. The
 * updater stays inside that job and ends with the Agent.
 */
export function createWindowsReforgerPlatform(
  system: WindowsReforgerSystem = windowsSystem,
): ReforgerHostPlatform {
  const identities = new Map<
    number,
    { at: number; info: ReforgerProcessInfo }
  >();
  let measured: {
    pid: number;
    at: number;
    usage: { ticks: number | null; memoryBytes: number | null };
  } | null = null;
  let listed: { at: number; rows: Promise<WindowsProcessRow[]> } | null = null;
  /** Updater root PID to the PIDs of its tree and their start times. */
  const trees = new Map<number, Map<number, string>>();

  async function canonical(path: string) {
    try {
      return await system.realpath(path);
    } catch {
      return path;
    }
  }
  async function info(row: WindowsProcessRow): Promise<ReforgerProcessInfo> {
    return {
      pid: row.pid,
      start: row.start,
      executable: row.executable ? await canonical(row.executable) : null,
      argv: row.argv,
    };
  }
  async function inspect(pid: number) {
    if (!system.alive(pid)) {
      identities.delete(pid);
      return null;
    }
    const known = identities.get(pid);
    if (known && system.now() - known.at < identityMs) return known.info;
    identities.delete(pid);
    const row = (await system.list(pid)).find((item) => item.pid === pid);
    if (!row?.start) return null;
    const found = await info(row);
    identities.set(pid, { at: system.now(), info: found });
    return found;
  }
  function everyProcess() {
    if (!listed || system.now() - listed.at >= listMs) {
      const rows = system.list();
      listed = { at: system.now(), rows };
      rows.catch(() => {
        if (listed?.rows === rows) listed = null;
      });
    }
    return listed.rows;
  }
  /** The live processes of the updater tree under `root`. */
  async function tree(root: number) {
    const rows = await system.list();
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    let known = trees.get(root);
    if (!known) {
      // An updater this Agent did not track: whatever holds its PID counts.
      known = new Map([[root, byPid.get(root)?.start || '0']]);
      trees.set(root, known);
    }
    for (let grew = true; grew;) {
      grew = false;
      for (const row of rows) {
        if (!row.start || row.parent === null || known.has(row.pid)) continue;
        const parentStart = known.get(row.parent);
        if (parentStart === undefined || !later(row.start, parentStart))
          continue;
        // A PID that another process took over is no parent of this tree.
        const holder = byPid.get(row.parent);
        if (holder && holder.start !== parentStart) continue;
        known.set(row.pid, row.start);
        grew = true;
      }
    }
    const live = rows.filter((row) => known.get(row.pid) === row.start);
    if (!live.length) trees.delete(root);
    return live;
  }
  return {
    inspect,
    async running(executable) {
      const name = win32.basename(executable).toLowerCase();
      const found: ReforgerProcessInfo[] = [];
      for (const row of await everyProcess()) {
        if (
          !row.start ||
          !row.executable ||
          win32.basename(row.executable).toLowerCase() !== name
        )
          continue;
        const candidate = await info(row);
        if (samePath(candidate.executable!, executable)) found.push(candidate);
      }
      return found;
    },
    samePath,
    detached: true,
    gracefulStop: false,
    stop(pid) {
      listed = null;
      system.kill(pid);
    },
    async machine() {
      let total = 0,
        idle = 0;
      for (const core of cpus()) {
        idle += core.times.idle;
        total +=
          core.times.user +
          core.times.nice +
          core.times.sys +
          core.times.idle +
          core.times.irq;
      }
      const memory = totalmem();
      return {
        cpu: total > 0 ? { total, idle } : null,
        memory: { total: memory, used: memory - freemem() },
      };
    },
    async usage(pid) {
      if (measured?.pid === pid && system.now() - measured.at < usageMs)
        return measured.usage;
      try {
        const row = (await system.list(pid)).find((item) => item.pid === pid);
        const usage = {
          ticks: row?.cpuMs ?? null,
          memoryBytes: row?.memoryBytes ?? null,
        };
        measured = { pid, at: system.now(), usage };
        return usage;
      } catch {
        return { ticks: null, memoryBytes: null };
      }
    },
    loadAverage: () => null,
    updater: {
      detached: false,
      async track(root) {
        const row = (await system.list(root)).find((item) => item.pid === root);
        trees.set(root, new Map([[root, row?.start || '0']]));
      },
      stop(root) {
        void tree(root)
          .then((live) => {
            for (const row of live) system.killTree(row.pid);
          })
          .catch(() => {});
      },
      async active(_id, root) {
        return !!root && root > 0 && (await tree(root)).length > 0;
      },
    },
  };
}
