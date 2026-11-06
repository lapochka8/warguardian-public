import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stripAuthenticode } from '../build/build.mjs';
import {
  checksumsFor,
  installerReleaseKey,
  prepareRelease,
  publicKeyLine,
  releaseAssetNames,
  signChecksums,
  stampInstaller,
  verifyChecksums,
} from '../build/release.mjs';
import { agentFiles } from './support/agent-files';

const installer = readFileSync(agentFiles.installer, 'utf8');

function withDirectory<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'wg-agent-release-'));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function withKey(script: string, line: string) {
  return script.replace(
    /\nrelease_public_key='[^'\n]*'\n/,
    `\nrelease_public_key='${line}'\n`,
  );
}

void test('a release publishes exactly these files', () => {
  const names = releaseAssetNames('1.2.3');
  assert.deepEqual([...names.files, names.checksums, names.signature].sort(), [
    'SHA256SUMS',
    'SHA256SUMS.sig',
    'WarGuardianAgentSetup-1.2.3.exe',
    'install.sh',
    'warguardian-agent-linux-arm64',
    'warguardian-agent-linux-x64',
    'warguardian-agent-win-x64.exe',
  ]);
});

void test('the release sets the version in install.sh once and refuses other values', () => {
  const stamped = stampInstaller(installer, '1.2.3');
  assert.ok(stamped.includes("\nWARGUARDIAN_AGENT_VERSION='1.2.3'\n"));
  assert.equal(stamped.split('\n').length, installer.split('\n').length);
  for (const version of ['1.2', '1.2.3; rm -rf /', "1.2.3'", ''])
    assert.throws(() => stampInstaller(installer, version), /release version/);
  assert.throws(
    () => stampInstaller(stamped, '1.2.4'),
    /WARGUARDIAN_AGENT_VERSION once/,
  );
});

void test('install.sh holds an Ed25519 public key line or nothing', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const line = publicKeyLine(privateKey);
  assert.match(line, /^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/);
  assert.equal(installerReleaseKey(withKey(installer, line)), line);
  assert.equal(installerReleaseKey(withKey(installer, '')), null);
  assert.equal(installerReleaseKey(withKey(installer, 'placeholder')), null);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
  assert.throws(() => publicKeyLine(rsa), /Ed25519/);
  assert.throws(
    () => installerReleaseKey('#!/bin/sh\n'),
    /release_public_key once/,
  );
});

void test('SHA256SUMS lists every file in the sha256sum format, sorted', () => {
  withDirectory((directory) => {
    writeFileSync(join(directory, 'b.exe'), 'second');
    writeFileSync(join(directory, 'a'), 'first');
    const sums = checksumsFor(directory, ['b.exe', 'a']);
    const digest = (text: string) =>
      createHash('sha256').update(text).digest('hex');
    assert.equal(sums, `${digest('first')}  a\n${digest('second')}  b.exe\n`);
  });
});

void test('only the key that install.sh names may sign SHA256SUMS', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const line = publicKeyLine(privateKey);
  const sums = `${'a'.repeat(64)}  install.sh\n`;
  const signature = signChecksums(sums, pem, line);
  assert.equal(signature.length, 64);
  assert.equal(verifyChecksums(sums, signature, line), true);
  assert.equal(verifyChecksums(`${sums}x`, signature, line), false);
  const other = generateKeyPairSync('ed25519').privateKey;
  assert.throws(
    () => signChecksums(sums, pem, publicKeyLine(other)),
    /does not match the public key in install.sh/,
  );
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.throws(
    () =>
      signChecksums(
        sums,
        rsa.export({ format: 'pem', type: 'pkcs8' }).toString(),
        line,
      ),
    /Ed25519/,
  );
});

void test('a release folder gets install.sh, SHA256SUMS, its signature and notes', () => {
  withDirectory((directory) => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const line = publicKeyLine(privateKey);
    const source = join(directory, 'source-install.sh');
    writeFileSync(source, withKey(installer, line));
    const release = join(directory, 'release');
    const names = releaseAssetNames('1.2.3');
    rmSync(release, { recursive: true, force: true });
    for (const name of names.files.filter((file) => file !== 'install.sh'))
      writeFileSync(join(directory, name), name);
    const notes = join(directory, 'notes.md');
    // Unsigned first: no key, no signature, and the notes say so.
    let result = prepareRelease({
      version: '1.2.3',
      directory,
      installer: source,
      notes,
      windowsSigned: false,
      signingKey: null,
    });
    assert.equal(result.signed, false);
    let text = readFileSync(notes, 'utf8');
    assert.match(text, /^WarGuardian Agent 1\.2\.3\./);
    assert.match(text, /Unsigned: this release has no `SHA256SUMS\.sig`/);
    assert.match(text, /Windows files unsigned/);
    assert.throws(() => statSync(join(directory, names.signature)));
    assert.ok(
      readFileSync(join(directory, 'install.sh'), 'utf8').includes(
        "\nWARGUARDIAN_AGENT_VERSION='1.2.3'\n",
      ),
    );
    result = prepareRelease({
      version: '1.2.3',
      directory,
      installer: source,
      notes,
      windowsSigned: true,
      signingKey: privateKey
        .export({ format: 'pem', type: 'pkcs8' })
        .toString(),
    });
    assert.equal(result.signed, true);
    const sums = readFileSync(join(directory, names.checksums), 'utf8');
    assert.equal(sums.trimEnd().split('\n').length, names.files.length);
    for (const file of names.files) assert.ok(sums.includes(`  ${file}\n`));
    assert.equal(
      verifyChecksums(
        sums,
        readFileSync(join(directory, names.signature)),
        line,
      ),
      true,
    );
    text = readFileSync(notes, 'utf8');
    assert.match(text, /`SHA256SUMS\.sig` is the Ed25519 signature/);
    assert.match(text, /carry an Authenticode signature/);
    assert.ok(text.includes(sums.trimEnd()));
  });
});

/** A small PE32+ image with a certificate table at its end. */
function signedImage() {
  const header = 0x80;
  const optional = header + 24;
  const directories = optional + 112;
  const certificate = 0x400;
  const bytes = Buffer.alloc(certificate + 0x20);
  bytes.write('MZ', 0, 'latin1');
  bytes.writeUInt32LE(header, 0x3c);
  bytes.write('PE\0\0', header, 'latin1');
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(0x1234, optional + 64);
  bytes.writeUInt32LE(16, directories - 4);
  bytes.writeUInt32LE(certificate, directories + 32);
  bytes.writeUInt32LE(0x20, directories + 36);
  bytes.fill(0xaa, certificate);
  return { bytes, optional, directories, certificate };
}

void test('the runtime signature is removed before the agent is injected', () => {
  withDirectory((directory) => {
    const file = join(directory, 'node.exe');
    const image = signedImage();
    writeFileSync(file, image.bytes);
    assert.equal(stripAuthenticode(file), true);
    const stripped = readFileSync(file);
    assert.equal(stripped.length, image.certificate);
    assert.equal(stripped.readUInt32LE(image.directories + 32), 0);
    assert.equal(stripped.readUInt32LE(image.directories + 36), 0);
    assert.equal(stripped.readUInt32LE(image.optional + 64), 0);
    assert.equal(stripAuthenticode(file), false, 'nothing left to remove');
    writeFileSync(file, 'not an image');
    assert.throws(() => stripAuthenticode(file), /not a Windows executable/);
  });
});
