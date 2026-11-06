import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Follow the newest file with an extension in a directory and hand each new
 * complete line to `onLine`. Reading starts at the end of the file found
 * first, so earlier history is not replayed. Each pass reads at most
 * `maxBytes`.
 */
export function followNewestLog(options: {
  directory: string;
  extension: string;
  onLine: (line: string) => void;
  intervalMs?: number;
  maxBytes?: number;
}) {
  const maxBytes = options.maxBytes ?? 256 * 1024;
  let file: string | null = null;
  let offset = 0;
  let partial = '';
  let first = true;
  let running = false;

  async function newest(): Promise<string | null> {
    let names: string[];
    try {
      names = await fs.readdir(options.directory);
    } catch {
      return null;
    }
    let best: { name: string; at: number } | null = null;
    for (const name of names) {
      if (!name.toLowerCase().endsWith(options.extension)) continue;
      try {
        const stat = await fs.stat(join(options.directory, name));
        if (stat.isFile() && (!best || stat.mtimeMs > best.at))
          best = { name, at: stat.mtimeMs };
      } catch {
        // Removed while listing.
      }
    }
    return best ? join(options.directory, best.name) : null;
  }

  async function pass() {
    if (running) return;
    running = true;
    try {
      const current = await newest();
      if (!current) return;
      const { size } = await fs.stat(current);
      if (current !== file || size < offset) {
        file = current;
        offset = first ? size : 0;
        partial = '';
      }
      first = false;
      if (size <= offset) return;
      const length = Math.min(size - offset, maxBytes);
      const handle = await fs.open(current, 'r');
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        offset += bytesRead;
        const lines = (
          partial + buffer.subarray(0, bytesRead).toString('utf8')
        ).split(/\r?\n/);
        partial = lines.pop() ?? '';
        if (partial.length > 4096) partial = '';
        for (const line of lines) options.onLine(line);
      } finally {
        await handle.close();
      }
    } catch {
      // A missing or rotated file is read again on the next pass.
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void pass(), options.intervalMs ?? 5_000);
  timer.unref();
  void pass();
  return {
    pass,
    close: () => clearInterval(timer),
  };
}

const arma3Connected =
  /\bPlayer (.{1,64}?) connected \(id=(7656119\d{10})\)\.?\s*$/;

/** The name and Steam64 ID of an Arma 3 server log `connected` line. */
export function readArma3Connection(
  line: string,
): { name: string; steam64: string } | null {
  if (line.length > 512) return null;
  const match = arma3Connected.exec(line);
  return match ? { name: match[1]!, steam64: match[2]! } : null;
}

const dayzConnected =
  /\bPlayer "(.{1,64}?)" \(steamID=(7656119\d{10}) pos=<[^<>]{0,96}>\) is connected\s*$/;

/**
 * The name and Steam64 ID of a DayZ server log (`.RPT`) `is connected`
 * line. The admin log names the DayZ ID instead, which cannot give a Steam
 * ID.
 */
export function readDayzConnection(
  line: string,
): { name: string; steam64: string } | null {
  if (line.length > 512) return null;
  const match = dayzConnected.exec(line);
  return match ? { name: match[1]!, steam64: match[2]! } : null;
}

/** The reader of a game's server log `connected` lines, or null for none. */
export function connectionReader(game: string) {
  return game === 'arma3'
    ? readArma3Connection
    : game === 'dayz'
      ? readDayzConnection
      : null;
}
