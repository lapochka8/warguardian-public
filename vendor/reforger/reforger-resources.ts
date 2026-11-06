import { promises as fs } from 'node:fs';
import { cpus, loadavg } from 'node:os';

export type ReforgerDiskSample = {
  label: string;
  freeBytes: number;
  totalBytes: number;
};
export type ReforgerResourceSample = {
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  gameCpuPercent: number | null;
  gameMemoryBytes: number | null;
  loadAverage: number | null;
  cores: number;
  disks: ReforgerDiskSample[];
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
const percent = (value: number) => Math.round(value * 1000) / 10;

/** Samples machine CPU, memory and disk use plus the owned game process.
 * Each CPU figure is the share of the whole machine since the last sample,
 * so the first sample has no CPU value. Missing Linux files leave values
 * empty instead of estimating them. */
export function createReforgerResourceSampler(options: {
  disks: { label: string; path: string }[];
  pid: () => number | null;
  read?: (path: string) => Promise<string>;
}) {
  const read = options.read ?? ((path: string) => fs.readFile(path, 'utf8'));
  let previous: {
    total: number;
    idle: number;
    pid: number | null;
    ticks: number | null;
  } | null = null;
  return async function sample(): Promise<ReforgerResourceSample> {
    const cpu = await read('/proc/stat')
      .then(parseProcStat)
      .catch(() => null);
    const memory = await read('/proc/meminfo')
      .then(parseMemInfo)
      .catch(() => null);
    const pid = options.pid();
    let ticks: number | null = null,
      gameMemoryBytes: number | null = null;
    if (pid) {
      ticks = await read(`/proc/${pid}/stat`)
        .then(parseProcessStat)
        .catch(() => null);
      gameMemoryBytes = await read(`/proc/${pid}/status`)
        .then((text) => {
          const match = /^VmRSS:\s+(\d+) kB/m.exec(text);
          return match ? Number(match[1]) * 1024 : null;
        })
        .catch(() => null);
    }
    let cpuPercent: number | null = null,
      gameCpuPercent: number | null = null;
    if (cpu && previous && cpu.total > previous.total) {
      const total = cpu.total - previous.total;
      cpuPercent = percent(1 - (cpu.idle - previous.idle) / total);
      if (ticks !== null && previous.pid === pid && previous.ticks !== null)
        gameCpuPercent = percent(Math.max(0, ticks - previous.ticks) / total);
    }
    if (cpu) previous = { ...cpu, pid, ticks };
    const disks: ReforgerDiskSample[] = [];
    const seen = new Set<string>();
    for (const disk of options.disks) {
      try {
        const [info, stat] = await Promise.all([
          fs.statfs(disk.path),
          fs.stat(disk.path),
        ]);
        const device = String(stat.dev);
        if (seen.has(device)) continue;
        seen.add(device);
        disks.push({
          label: disk.label,
          freeBytes: Number(info.bavail) * Number(info.bsize),
          totalBytes: Number(info.blocks) * Number(info.bsize),
        });
      } catch {
        /* A missing path has no disk figure. */
      }
    }
    return {
      cpuPercent:
        cpuPercent === null ? null : Math.min(100, Math.max(0, cpuPercent)),
      memoryUsedBytes: memory?.used ?? null,
      memoryTotalBytes: memory?.total ?? null,
      gameCpuPercent:
        gameCpuPercent === null
          ? null
          : Math.min(100, Math.max(0, gameCpuPercent)),
      gameMemoryBytes,
      loadAverage: process.platform === 'linux' ? loadavg()[0] : null,
      cores: cpus().length,
      disks,
    };
  };
}
