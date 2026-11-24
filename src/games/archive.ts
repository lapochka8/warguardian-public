import { gunzipSync, inflateRawSync } from 'node:zlib';

/**
 * Readers for the two archive forms that plugin frameworks are released in:
 * zip and gzipped tar. An archive is read from memory into a list of plain
 * files. Every name is checked: it is relative, has no `..` part, no drive
 * and no control character, so an entry can only land below the folder it
 * is written to. Links and devices are left out.
 */

export type ArchiveFile = {
  /** A relative path with `/` separators. */
  name: string;
  data: Buffer;
  /** The Unix permission bits, when the archive has them. */
  mode: number | null;
};

export type ArchiveLimits = { maxFiles: number; maxBytes: number };

const defaults: ArchiveLimits = { maxFiles: 5_000, maxBytes: 400_000_000 };

class ArchiveUnreadable extends Error {
  constructor(message = 'The archive cannot be read.') {
    super(message);
    this.name = 'ArchiveUnreadable';
  }
}

/** The text before the first NUL character. */
function untilNul(value: string): string {
  const end = value.indexOf(String.fromCharCode(0));
  return end < 0 ? value : value.slice(0, end);
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** The name as a safe relative path, or null for a name that is refused. */
export function archivePath(raw: string): string | null {
  const name = raw.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (
    !name ||
    name.length > 400 ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    hasControl(name)
  )
    return null;
  const parts = name.split('/').filter((part) => part !== '' && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) return null;
  return parts.join('/');
}

function counted(limits: ArchiveLimits) {
  let files = 0;
  let bytes = 0;
  return (size: number) => {
    files += 1;
    bytes += size;
    if (files > limits.maxFiles || bytes > limits.maxBytes)
      throw new ArchiveUnreadable('The archive is too large.');
  };
}

/** The files of a zip archive. Zip64 and encrypted entries are refused. */
export function readZip(
  zip: Buffer,
  limits: ArchiveLimits = defaults,
): ArchiveFile[] {
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 65_557); at--)
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  if (end < 0) throw new ArchiveUnreadable();
  const entries = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const count = counted(limits);
  const files: ArchiveFile[] = [];
  for (let index = 0; index < entries; index++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50)
      throw new ArchiveUnreadable();
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const madeBy = zip.readUInt16LE(at + 4) >> 8;
    const attributes = zip.readUInt32LE(at + 38);
    const local = zip.readUInt32LE(at + 42);
    const raw = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at +=
      46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    // A folder entry holds no data.
    if (raw.endsWith('/') || raw.endsWith('\\')) continue;
    const mode = madeBy === 3 ? (attributes >>> 16) & 0o7777 : null;
    // A Unix link is stored as a file whose type bits say link.
    if (madeBy === 3 && ((attributes >>> 16) & 0o170000) === 0o120000) continue;
    const name = archivePath(raw);
    if (!name) throw new ArchiveUnreadable('The archive holds an unsafe path.');
    if (
      flags & 1 ||
      (method !== 0 && method !== 8) ||
      packed === 0xffffffff ||
      size === 0xffffffff ||
      local + 30 > zip.length ||
      zip.readUInt32LE(local) !== 0x04034b50
    )
      throw new ArchiveUnreadable();
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + packed > zip.length) throw new ArchiveUnreadable();
    count(size);
    const stored = zip.subarray(start, start + packed);
    let data: Buffer;
    try {
      data =
        method === 0
          ? Buffer.from(stored)
          : inflateRawSync(stored, { maxOutputLength: size + 1 });
    } catch {
      throw new ArchiveUnreadable();
    }
    if (data.length !== size) throw new ArchiveUnreadable();
    files.push({ name, data, mode });
  }
  return files;
}

const octal = (block: Buffer, at: number, length: number) =>
  parseInt(
    untilNul(block.toString('latin1', at, at + length)).trim() || '0',
    8,
  );
const text = (block: Buffer, at: number, length: number) =>
  untilNul(block.toString('utf8', at, at + length));

/** The files of a gzipped tar archive, with GNU and pax long names. */
export function readTarGz(
  archive: Buffer,
  limits: ArchiveLimits = defaults,
): ArchiveFile[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, {
      maxOutputLength: limits.maxBytes + 10_000_000,
    });
  } catch {
    throw new ArchiveUnreadable();
  }
  const count = counted(limits);
  const files: ArchiveFile[] = [];
  let longName: string | null = null;
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length)
      throw new ArchiveUnreadable();
    const type = String.fromCharCode(header[156] || 0x30);
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = untilNul(body.toString('utf8'));
      continue;
    }
    if (type === 'x') {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (path) longName = path[1]!;
      continue;
    }
    const prefix = text(header, 345, 155);
    const raw = longName ?? (prefix ? `${prefix}/` : '') + text(header, 0, 100);
    longName = null;
    // Only plain files are written. Folders come from the file paths.
    if (type !== '0') continue;
    const name = archivePath(raw);
    if (!name) throw new ArchiveUnreadable('The archive holds an unsafe path.');
    count(size);
    files.push({
      name,
      data: Buffer.from(body),
      mode: octal(header, 100, 8) & 0o7777,
    });
  }
  return files;
}
