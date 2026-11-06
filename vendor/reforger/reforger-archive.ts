import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGunzip, createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const limit = 536870912;
const safePath = (raw: string) => {
  const value = raw.replace(/^\.\//, '').replace(/\/$/, '');
  for (let index = 0; index < value.length; index++)
    if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127)
      throw new Error('Archive contains an unsafe path.');
  if (
    !value ||
    value.length > 512 ||
    /[\\:]/.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Archive contains an unsafe path.');
  return value;
};
const text = (bytes: Uint8Array) =>
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const field = (bytes: Buffer) => {
  const end = bytes.indexOf(0);
  return text(end < 0 ? bytes : bytes.subarray(0, end));
};
const octal = (bytes: Buffer) => {
  const value = field(bytes).trim();
  if (!/^[0-7]+$/.test(value))
    throw new Error('Unsupported archive numeric field.');
  const result = parseInt(value, 8);
  if (!Number.isSafeInteger(result))
    throw new Error('Archive numeric field is too large.');
  return result;
};

/** Format interoperability only; no third-party extractor or panel code is used. */
export async function convertReforgerHostArchive(
  input: string,
  output: string,
) {
  const source = createReadStream(input),
    decoded = createGunzip();
  source.on('error', (error) => decoded.destroy(error));
  source.pipe(decoded);
  const iterator = decoded[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0),
    inflated = 0,
    consumed = 0;
  async function read(length: number, eof = false): Promise<Buffer | null> {
    const parts: Buffer[] = [];
    let needed = length;
    while (needed) {
      if (!pending.length) {
        const next = await iterator.next();
        if (next.done) {
          if (eof && needed === length) return null;
          throw new Error('Archive is truncated.');
        }
        pending = Buffer.from(next.value);
        inflated += pending.length;
        if (inflated > limit + 16777216)
          throw new Error('Archive expands beyond 528 MiB.');
      }
      const count = Math.min(needed, pending.length);
      parts.push(pending.subarray(0, count));
      pending = pending.subarray(count);
      needed -= count;
      consumed += count;
    }
    return Buffer.concat(parts, length);
  }
  const result = {
    files: 0,
    bytes: 0,
    omitted: 0,
    config: null as Record<string, unknown> | null,
    excluded: [] as string[],
  };
  const entries = new Map<string, string>(),
    parents = new Set<string>();
  let count = 0,
    allBytes = 0,
    profile = false,
    configSeen = false;
  let longName: string | null = null;
  function clean(value: unknown, prefix = ''): unknown {
    if (Array.isArray(value))
      return value.map((item, index) => clean(item, `${prefix}[${index}]`));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) => {
          const path = prefix ? `${prefix}.${key}` : key;
          if (
            /rcon|password|secret|token|apikey|credential|authorization/i.test(
              key,
            ) ||
            ['__proto__', 'constructor', 'prototype'].includes(key)
          ) {
            if (result.excluded.length < 100) result.excluded.push(path);
            return [];
          }
          return [[key, clean(item, path)]];
        }),
      );
    return value;
  }
  async function* records() {
    yield (
      JSON.stringify({
        type: 'header',
        format: 'warguardian-reforger-profile',
        version: 1,
      }) + '\n'
    );
    while (true) {
      const header = await read(512);
      if (!header) throw new Error('Archive has no terminator.');
      if (header.every((byte) => byte === 0)) {
        if (longName || !(await read(512))!.every((byte) => byte === 0))
          throw new Error('Invalid archive terminator.');
        let padding: Buffer | null;
        while ((padding = await read(512, true)))
          if (padding.some((byte) => byte !== 0))
            throw new Error('Unexpected archive trailer.');
        break;
      }
      if (++count > 10000) throw new Error('Archive exceeds 10,000 entries.');
      let checksum = 0;
      for (let index = 0; index < 512; index++)
        checksum += index >= 148 && index < 156 ? 32 : header[index];
      if (
        octal(header.subarray(148, 156)) !== checksum ||
        field(header.subarray(257, 263)).slice(0, 5) !== 'ustar'
      )
        throw new Error('Invalid or unsupported tar header.');
      const size = octal(header.subarray(124, 136)),
        kind = String.fromCharCode(header[156]);
      if (size > 268435456 || (allBytes += size) > limit)
        throw new Error('Archive exceeds its file or total size limit.');
      if (kind === 'L') {
        if (longName || size < 1 || size > 513)
          throw new Error('Invalid GNU long path.');
        longName = field((await read(size))!);
        await read((512 - (size % 512)) % 512);
        continue;
      }
      if (!['0', '\0', '5'].includes(kind))
        throw new Error(
          'Archive links, extensions and special files are unsupported.',
        );
      const prefix = header[262] === 0 ? field(header.subarray(345, 500)) : '';
      const path = safePath(
        longName ??
          `${prefix ? prefix + '/' : ''}${field(header.subarray(0, 100))}`,
      );
      longName = null;
      if (
        !(
          path === 'config.json' ||
          path === 'profile' ||
          path.startsWith('profile/') ||
          path === 'tmp' ||
          path.startsWith('tmp/')
        )
      )
        throw new Error(
          'Archive has entries outside config.json, profile/ and tmp/.',
        );
      const key = path.normalize('NFC').toLowerCase();
      if (entries.has(key))
        throw new Error('Archive contains duplicate or ambiguous paths.');
      if (kind !== '5' && parents.has(key))
        throw new Error('Archive file and directory paths conflict.');
      const parts = key.split('/');
      for (let index = 1; index < parts.length; index++) {
        const parent = parts.slice(0, index).join('/');
        if (entries.has(parent) && entries.get(parent) !== '5')
          throw new Error('Archive file and directory paths conflict.');
        parents.add(parent);
      }
      entries.set(key, kind);
      if (kind === '5' && size)
        throw new Error('Archive directory contains file bytes.');
      if (path === 'config.json' && kind === '5')
        throw new Error('Archive configuration is not a file.');
      if (path === 'profile' && kind !== '5')
        throw new Error('Archive profile is not a directory.');
      const selected = path.startsWith('profile/');
      if (path === 'profile' || selected) profile = true;
      const mapped = selected ? safePath(path.slice(8)) : '';
      if (selected && kind === '5')
        yield JSON.stringify({ type: 'directory', path: mapped }) + '\n';
      if (selected && kind !== '5') {
        result.files++;
        result.bytes += size;
        yield JSON.stringify({ type: 'file', path: mapped, size }) + '\n';
      } else if (!selected && path !== 'profile') result.omitted++;
      const digest = createHash('sha256'),
        config: Buffer[] = [];
      if (path === 'config.json' && size > 60000)
        throw new Error('Archive configuration exceeds 60 kB.');
      for (let remaining = size; remaining > 0;) {
        const bytes = (await read(Math.min(131072, remaining)))!;
        remaining -= bytes.length;
        if (selected) {
          digest.update(bytes);
          yield (
            JSON.stringify({ type: 'chunk', data: bytes.toString('base64') }) +
              '\n'
          );
        } else if (path === 'config.json') config.push(bytes);
      }
      if (selected && kind !== '5')
        yield (
          JSON.stringify({ type: 'end-file', sha256: digest.digest('hex') }) +
            '\n'
        );
      if (path === 'config.json') {
        let raw;
        try {
          raw = JSON.parse(text(Buffer.concat(config)));
        } catch {
          throw new Error('Archive has an invalid native configuration.');
        }
        if (
          !raw ||
          typeof raw !== 'object' ||
          Array.isArray(raw) ||
          !raw.game ||
          typeof raw.game !== 'object' ||
          Array.isArray(raw.game)
        )
          throw new Error('Archive has an invalid native configuration.');
        result.config = clean(raw) as Record<string, unknown>;
        configSeen = true;
      }
      await read((512 - (size % 512)) % 512);
    }
    if (!profile || !configSeen)
      throw new Error(
        'Reforger Host archive requires config.json and profile/.',
      );
    yield (
      JSON.stringify({
        type: 'complete',
        files: result.files,
        bytes: result.bytes,
      }) + '\n'
    );
  }
  try {
    await pipeline(
      Readable.from(records()),
      createGzip(),
      createWriteStream(output, { flags: 'wx', mode: 0o600 }),
    );
    const handle = await fs.open(output, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return result;
  } catch (error) {
    await fs.rm(output, { force: true });
    throw error;
  } finally {
    source.destroy();
    decoded.destroy();
    // Keep the byte accounting explicit even if the decoder rejects its CRC.
    void consumed;
  }
}
