import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';

/**
 * Official Node.js runtimes for the single executables, pinned by the
 * SHA-256 that nodejs.org publishes in SHASUMS256.txt.
 */
export const pinnedNode = Object.freeze({
  version: '24.22.1',
  archives: Object.freeze({
    'linux-x64': {
      file: 'node-v24.22.1-linux-x64.tar.gz',
      sha256:
        'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c',
      member: 'node-v24.22.1-linux-x64/bin/node',
    },
    'linux-arm64': {
      file: 'node-v24.22.1-linux-arm64.tar.gz',
      sha256:
        '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3',
      member: 'node-v24.22.1-linux-arm64/bin/node',
    },
    'win-x64': {
      file: 'node-v24.22.1-win-x64.zip',
      sha256:
        'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
      member: 'node-v24.22.1-win-x64/node.exe',
    },
  }),
});

const environmentNames = {
  'linux-x64': 'WARGUARDIAN_AGENT_NODE_LINUX_X64',
  'linux-arm64': 'WARGUARDIAN_AGENT_NODE_LINUX_ARM64',
  'win-x64': 'WARGUARDIAN_AGENT_NODE_WIN_X64',
};

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** The text of a NUL-terminated header field. */
function field(bytes, encoding = 'utf8') {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString(encoding);
}

function octal(bytes) {
  const text = field(bytes, 'latin1').trim();
  return text ? parseInt(text, 8) : 0;
}

/** One regular file from a tar stream, with GNU long names and pax paths. */
export function tarMember(tar, wanted) {
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 48);
    const body = offset + 512;
    const next = body + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = field(tar.subarray(body, body + size));
      offset = next;
      continue;
    }
    if (type === 'x') {
      const record = tar.subarray(body, body + size).toString('utf8');
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(record);
      if (path) longName = path[1];
      offset = next;
      continue;
    }
    const name = field(header.subarray(0, 100));
    const prefix = field(header.subarray(345, 500));
    const path = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    if ((type === '0' || type === '\0') && path === wanted)
      return Buffer.from(tar.subarray(body, body + size));
    offset = next;
  }
  throw new Error(`The archive has no ${wanted}.`);
}

/** One file from a zip archive, stored or deflated. */
export function zipMember(zip, wanted) {
  let end = -1;
  for (
    let index = zip.length - 22;
    index >= Math.max(0, zip.length - 65_557);
    index -= 1
  )
    if (zip.readUInt32LE(index) === 0x06054b50) {
      end = index;
      break;
    }
  if (end < 0) throw new Error('The zip archive has no central directory.');
  const entries = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  for (let entry = 0; entry < entries; entry += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('The zip central directory is damaged.');
    const method = zip.readUInt16LE(offset + 10);
    const compressed = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (name !== wanted) continue;
    if (zip.readUInt32LE(local) !== 0x04034b50)
      throw new Error('The zip entry is damaged.');
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    const output =
      method === 0
        ? Buffer.from(data)
        : method === 8
          ? inflateRawSync(data)
          : null;
    if (!output || output.length !== size)
      throw new Error('The zip entry could not be read.');
    return output;
  }
  throw new Error(`The archive has no ${wanted}.`);
}

/**
 * The Node.js runtime for a target:
 * 1. `WARGUARDIAN_AGENT_NODE_<TARGET>`: a runtime the operator supplies;
 * 2. this Node.js, when it matches the target and `pinned` is not set;
 * 3. the pinned official archive in the cache, checked against its SHA-256;
 * 4. with `fetch`, the pinned archive downloaded from nodejs.org and checked.
 */
export async function resolveNodeBinary(
  target,
  {
    env = process.env,
    cacheDirectory,
    fetch: allowFetch = false,
    pinned = false,
  },
) {
  const supplied = env[environmentNames[target]];
  if (supplied) {
    if (!existsSync(supplied))
      throw new Error(`${environmentNames[target]} does not name a file.`);
    return {
      path: supplied,
      source: 'supplied',
      version: env[`${environmentNames[target]}_VERSION`] || null,
    };
  }
  const host =
    process.platform === 'linux' && process.arch === 'x64'
      ? 'linux-x64'
      : process.platform === 'linux' && process.arch === 'arm64'
        ? 'linux-arm64'
        : process.platform === 'win32' && process.arch === 'x64'
          ? 'win-x64'
          : null;
  if (host === target && !pinned)
    return {
      path: process.execPath,
      source: 'host',
      version: process.version.slice(1),
    };
  const archive = pinnedNode.archives[target];
  const binaryName = target.startsWith('win') ? 'node.exe' : 'node';
  const extracted = join(
    cacheDirectory,
    `node-v${pinnedNode.version}-${target}`,
    binaryName,
  );
  const archivePath = join(cacheDirectory, archive.file);
  if (!existsSync(archivePath)) {
    if (!allowFetch)
      throw new Error(
        `No Node.js runtime for ${target}. Set ${environmentNames[target]}, place ${archive.file} in ${cacheDirectory}, or pass --fetch-node.`,
      );
    mkdirSync(cacheDirectory, { recursive: true });
    const response = await fetch(
      `https://nodejs.org/dist/v${pinnedNode.version}/${archive.file}`,
      {
        redirect: 'error',
      },
    );
    if (!response.ok)
      throw new Error(
        `nodejs.org returned ${response.status} for ${archive.file}.`,
      );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== archive.sha256)
      throw new Error(`${archive.file} does not match its pinned SHA-256.`);
    writeFileSync(`${archivePath}.partial`, bytes);
    renameSync(`${archivePath}.partial`, archivePath);
  }
  const bytes = readFileSync(archivePath);
  if (sha256(bytes) !== archive.sha256)
    throw new Error(`${archive.file} does not match its pinned SHA-256.`);
  const binary = archive.file.endsWith('.zip')
    ? zipMember(bytes, archive.member)
    : tarMember(gunzipSync(bytes), archive.member);
  mkdirSync(join(cacheDirectory, `node-v${pinnedNode.version}-${target}`), {
    recursive: true,
  });
  writeFileSync(extracted, binary, { mode: 0o755 });
  return { path: extracted, source: 'pinned', version: pinnedNode.version };
}
