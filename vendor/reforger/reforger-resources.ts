import { promises as fs } from 'node:fs';
import { cpus } from 'node:os';
import {
  createLinuxReforgerPlatform,
  type ReforgerHostPlatform,
} from './reforger-platform';

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

export {
  parseMemInfo,
  parseProcessStat,
  parseProcStat,
} from './reforger-platform';

const percent = (value: number) => Math.round(value * 1000) / 10;

/** Samples machine CPU, memory and disk use plus the owned game process.
 * Each CPU figure is the share of the whole machine since the last sample,
 * so the first sample has no CPU value. Values the host cannot report stay
 * empty instead of being estimated. */
export function createReforgerResourceSampler(options: {
  disks: { label: string; path: string }[];
  pid: () => number | null;
  read?: (path: string) => Promise<string>;
  platform?: ReforgerHostPlatform;
}) {
  const platform =
    options.platform ?? createLinuxReforgerPlatform(options.read);
  let previous: {
    total: number;
    idle: number;
    pid: number | null;
    ticks: number | null;
  } | null = null;
  return async function sample(): Promise<ReforgerResourceSample> {
    const { cpu, memory } = await platform.machine();
    const pid = options.pid();
    const { ticks, memoryBytes: gameMemoryBytes } = pid
      ? await platform.usage(pid)
      : { ticks: null, memoryBytes: null };
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
      loadAverage: platform.loadAverage(),
      cores: cpus().length,
      disks,
    };
  };
}
