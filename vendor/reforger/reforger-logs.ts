import { promises as fs, constants } from 'node:fs';
import { isIPv6 } from 'node:net';
import { join } from 'node:path';
import {
  reforgerLogSessionName,
  type reforgerLogSource,
} from '../games/reforger-host';
import type { z } from 'zod';

// Log pages for the live log viewer. A page always ends at a line boundary,
// so a secret or an address is redacted on its whole line before it leaves
// the host. The partial last line of a growing file waits for the next page.

export type ReforgerLogSource = z.infer<typeof reforgerLogSource>;

/** The fixed file name of each log source inside a session folder. */
export const reforgerLogFiles: Record<ReforgerLogSource, string> = {
  console: 'console.log',
  script: 'script.log',
  error: 'error.log',
  crash: 'crash.log',
};

/** The JSON size of the redacted text of one agent result stays below this. */
const resultTextLimit = 900_000;
/** A page is never shrunk below this many bytes. */
const smallestPage = 4096;
const newline = 0x0a;

// An address next to letters, such as `ip=192.0.2.4` or `v192.0.2.4`, is still
// found. Only digits, dots and colons that continue it end a match. Octets
// may carry leading zeros (`010`); each is checked to be at most 255.
const ipv4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)/g;
// Every pattern below does a bounded amount of work at each position, so a
// long line cannot stall the agent.
// A maximal run of hex digits, dots and colons. An IPv6 address is looked for
// inside each run, which also finds one after a `key:` separator, before a
// trailing `:` or `.` and in front of an appended port.
const addressRun = /[0-9A-Fa-f.:]+/g;
/** A letter or underscore that is never part of an address. */
const wordLetter = /^[G-Zg-z_]$/;
const urlCredentials = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/@'"<>]+@/gi;
const webhookToken = /(\/api\/webhooks\/\d+\/)[A-Za-z0-9_.-]+/gi;
// A quoted value is redacted up to its closing quote, so a secret with spaces
// or commas is never shown in part.
const secretPair =
  /\b([A-Za-z_]{0,32}(?:password|passwd|secret|token|api[_-]?key)[A-Za-z_]{0,32})("?[ \t]{0,8}[:=][ \t]{0,8})("[^"\r\n]*"|'[^'\r\n]*'|"?[^\s",;]+)/gi;
/**
 * A four-part version number such as `version 1.2.0.102` is not an address.
 * One with a port is always hashed.
 */
const versionBefore = /\bversion[\s:=]*$/i;

/**
 * The IPv6 address inside a run of hex digits, dots and colons, and the part
 * of the run it replaces. The address may follow a `key:` separator, and
 * sentence dots, a trailing `:` or an appended port may follow it. The whole
 * run except a leading `:` and that trailing punctuation is replaced, so no
 * group of an ambiguous address stays visible.
 */
function ipv6Within(run: string) {
  const first = run.indexOf(':');
  if (first < 0 || first === run.lastIndexOf(':')) return null;
  let end = run.length;
  while (end > 0 && run[end - 1] === '.') end--;
  if (run[end - 1] === ':' && run[end - 2] !== ':') end--;
  const ends = [run.length, end],
    port = run.lastIndexOf(':', end - 1);
  if (port > 0 && port < end - 1 && run[port - 1] !== ':') ends.push(port);
  const starts = run[first + 1] === ':' ? [0] : [0, first + 1];
  for (const stop of ends)
    for (const start of starts) {
      const value = run.slice(start, stop);
      if (value.length > 2 && isIPv6(value))
        return {
          value,
          start: run.startsWith(':') && run[1] !== ':' ? 1 : 0,
          stop: end,
        };
    }
  return null;
}

/**
 * Redact one block of whole log lines: known secret values, URL credentials,
 * webhook tokens and secret-named key and value pairs are replaced, and every
 * IPv4 and IPv6 address becomes its keyed hash.
 */
export function redactReforgerLogText(
  text: string,
  secrets: readonly string[],
  hashAddress: (ip: string) => string,
) {
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    if (secret) text = text.split(secret).join('[redacted]');
  text = text
    .replace(urlCredentials, '$1[redacted]@')
    .replace(webhookToken, '$1[redacted]')
    .replace(
      secretPair,
      (_match, key: string, separator: string, value: string) => {
        const quote = value[0] === '"' || value[0] === "'" ? value[0] : '',
          closed = !!quote && value.length > 1 && value.endsWith(quote);
        return `${key}${separator}${quote}[redacted]${closed ? quote : ''}`;
      },
    );
  const address = (ip: string) => `[ip:${hashAddress(ip)}]`;
  text = text.replace(addressRun, (run, offset: number, whole: string) => {
    const found = ipv6Within(run);
    if (!found) return run;
    const { value, start, stop } = found;
    // A scope operator such as `SCR_BaseGameMode::OnGameStateChanged` or
    // `Class::Create` reads like a short address. It is part of a word.
    const before = start ? ':' : (whole[offset - 1] ?? ''),
      after = stop < run.length ? run[stop]! : (whole[offset + stop] ?? '');
    if (
      value.includes('::') &&
      ((run[start] !== ':' && wordLetter.test(before)) ||
        (run[stop - 1] !== ':' && wordLetter.test(after)))
    )
      return run;
    return run.slice(0, start) + address(value) + run.slice(stop);
  });
  return text.replace(ipv4, (match, offset: number, whole: string) =>
    match.split('.').some((octet) => Number(octet) > 255) ||
    (versionBefore.test(whole.slice(Math.max(0, offset - 12), offset)) &&
      !/^:\d/.test(
        whole.slice(offset + match.length, offset + match.length + 2),
      ))
      ? match
      : address(match),
  );
}

/** Secret values in a parsed JSON configuration. */
export function reforgerConfigSecrets(
  value: unknown,
  into = new Set<string>(),
) {
  if (Array.isArray(value)) {
    for (const item of value) reforgerConfigSecrets(item, into);
  } else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string') {
        if (
          (/password|passwd|secret|token|api_?key/i.test(key) &&
            item.length >= 3) ||
          (/key$/i.test(key) && item.length >= 8)
        )
          into.add(item);
      } else reforgerConfigSecrets(item, into);
    }
  return into;
}

async function openLog(path: string) {
  try {
    return await fs.open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** The byte size of a log file. A missing file or a folder has size 0. */
export async function reforgerLogSize(path: string) {
  const handle = await openLog(path);
  if (!handle) return 0;
  try {
    const stat = await handle.stat();
    return stat.isFile() ? stat.size : 0;
  } finally {
    await handle.close();
  }
}

export type ReforgerLogRange = {
  size: number;
  from: number;
  to: number;
  text: string;
};

/**
 * Read whole lines from `from` for at most `max` bytes. A start inside a line
 * moves to the next line. A growing file keeps its partial last line for the
 * next read. A `final` file, which no longer grows, includes it. A line longer
 * than one page is skipped, so no part of it is shown unredacted.
 */
export async function readReforgerLogRange(
  path: string,
  options: {
    from: number | 'tail';
    max: number;
    final: boolean;
    redact: (text: string) => string;
  },
): Promise<ReforgerLogRange> {
  const handle = await openLog(path);
  if (!handle) return { size: 0, from: 0, to: 0, text: '' };
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { size: 0, from: 0, to: 0, text: '' };
    const size = stat.size;
    let max = options.max;
    while (true) {
      const start = Math.min(
        size,
        options.from === 'tail' ? Math.max(0, size - max) : options.from,
      );
      const range = await lines(handle, start, size, max, options.final);
      const text = options.redact(range.text);
      if (
        max <= smallestPage ||
        Buffer.byteLength(JSON.stringify(text)) <= resultTextLimit
      )
        return { size, from: range.from, to: range.to, text };
      max = Math.max(smallestPage, Math.floor(max / 2));
    }
  } finally {
    await handle.close();
  }
}

async function lines(
  handle: fs.FileHandle,
  start: number,
  size: number,
  max: number,
  final: boolean,
) {
  const end = Math.min(size, start + max);
  if (start >= end) return { from: start, to: start, text: '' };
  const lead = start > 0 ? 1 : 0,
    buffer = Buffer.alloc(end - start + lead),
    read = await handle.read(buffer, 0, buffer.length, start - lead);
  const bytes = buffer.subarray(0, read.bytesRead);
  // The file shrank after its size was read.
  if (bytes.length <= lead) return { from: start, to: start, text: '' };
  let first = 0;
  if (lead) {
    if (bytes[0] === newline) first = 1;
    else {
      const next = bytes.indexOf(newline, 1);
      // The whole window is inside one line that started before it.
      if (next < 0) {
        const to = start - lead + bytes.length;
        return { from: to, to, text: '' };
      }
      first = next + 1;
    }
  }
  const from = start - lead + first;
  let body = bytes.subarray(first);
  const last = body.lastIndexOf(newline);
  if (!(final && end === size)) {
    if (last >= 0) body = body.subarray(0, last + 1);
    else if (end < size)
      // One line fills the page. It is skipped instead of being split.
      return { from: from + body.length, to: from + body.length, text: '' };
    else body = body.subarray(0, 0);
  }
  return {
    from,
    to: from + body.length,
    text: new TextDecoder('utf8').decode(body).replace(/\r(?=\n)/g, ''),
  };
}

export type ReforgerLogSessionEntry = {
  name: string;
  at: number | null;
  sources: ReforgerLogSource[];
};

/** The time in a session folder name, read as the host's local time. */
export function reforgerLogSessionTime(name: string) {
  const match = /^logs_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(
    name,
  );
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map(Number) as [number, number, number, number, number, number];
  const at = new Date(year, month - 1, day, hour, minute, second).getTime();
  return Number.isFinite(at) ? at : null;
}

/**
 * The newest 50 game log sessions in `directory`, newest first. Symlinked
 * folders and files are not listed.
 */
export async function listReforgerLogSessions(
  directory: string,
): Promise<ReforgerLogSessionEntry[]> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
  const names = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        reforgerLogSessionName.safeParse(entry.name).success,
    )
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 50);
  return Promise.all(
    names.map(async (name) => {
      const sources: ReforgerLogSource[] = [];
      for (const [source, file] of Object.entries(reforgerLogFiles) as [
        ReforgerLogSource,
        string,
      ][])
        try {
          if ((await fs.lstat(join(directory, name, file))).isFile())
            sources.push(source);
        } catch {
          /* The game did not write this file for this log. */
        }
      return { name, at: reforgerLogSessionTime(name), sources };
    }),
  );
}

/**
 * Rotate the console file in place. The game writes it through an inherited
 * append descriptor, so it is never renamed: the last `keepBytes` (from a line
 * start) are copied to `previousPath` and the file is truncated to zero. The
 * game's next write lands at the new end. Returns true after a rotation.
 */
export async function rotateReforgerConsole(
  path: string,
  previousPath: string,
  limits: { maxBytes: number; keepBytes: number },
  write: (path: string, bytes: Uint8Array) => Promise<void>,
) {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, 'r+');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size <= limits.maxBytes) return false;
    const length = Math.min(size, limits.keepBytes),
      buffer = Buffer.alloc(length),
      read = await handle.read(buffer, 0, length, size - length);
    let kept = buffer.subarray(0, read.bytesRead);
    if (size > length) {
      const start = kept.indexOf(newline);
      kept = start < 0 ? kept.subarray(0, 0) : kept.subarray(start + 1);
    }
    await write(previousPath, kept);
    await handle.truncate(0);
    return true;
  } finally {
    await handle.close();
  }
}
