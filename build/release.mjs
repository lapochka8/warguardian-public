import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * Release files of one WarGuardian Agent version. `SHA256SUMS` lists the
 * SHA-256 of every other file. `SHA256SUMS.sig` is a raw 64-byte Ed25519
 * signature over `SHA256SUMS`, which install.sh checks with
 * `openssl pkeyutl -verify -rawin`.
 */
export function releaseAssetNames(version) {
  return {
    files: [
      'warguardian-agent-linux-x64',
      'warguardian-agent-linux-arm64',
      'warguardian-agent-win-x64.exe',
      `WarGuardianAgentSetup-${version}.exe`,
      'install.sh',
    ],
    checksums: 'SHA256SUMS',
    signature: 'SHA256SUMS.sig',
  };
}

export const releaseVersionPattern =
  /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;

/** The release public key line of install.sh, or null when it is not set. */
export function installerReleaseKey(script) {
  const match = /\nrelease_public_key='([^'\n]*)'\n/.exec(script);
  if (!match)
    throw new Error('install.sh must assign release_public_key once.');
  const value = match[1];
  if (!/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const key = createPublicKey({
    key: Buffer.from(value, 'base64'),
    format: 'der',
    type: 'spki',
  });
  if (key.asymmetricKeyType !== 'ed25519') return null;
  return value;
}

/** The base64 SubjectPublicKeyInfo line for an Ed25519 key, as install.sh holds it. */
export function publicKeyLine(key) {
  const publicKey = key?.type === 'public' ? key : createPublicKey(key);
  if (publicKey.asymmetricKeyType !== 'ed25519')
    throw new Error('The release key must be an Ed25519 key.');
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}

/** install.sh with the release version set, the form a release publishes. */
export function stampInstaller(script, version) {
  if (!releaseVersionPattern.test(version))
    throw new Error(`${version} is not a release version.`);
  const line = "\nWARGUARDIAN_AGENT_VERSION=''\n";
  if (script.split(line).length !== 2)
    throw new Error('install.sh must assign WARGUARDIAN_AGENT_VERSION once.');
  return script.replace(line, `\nWARGUARDIAN_AGENT_VERSION='${version}'\n`);
}

/** `SHA256SUMS` in the `sha256sum` format, sorted by file name. */
export function checksumsFor(directory, files) {
  return [...files]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      (file) =>
        `${createHash('sha256')
          .update(readFileSync(join(directory, file)))
          .digest('hex')}  ${file}\n`,
    )
    .join('');
}

/**
 * Sign `SHA256SUMS` with the release key, a PKCS#8 PEM Ed25519 key. The key
 * must match the public key that install.sh holds, or the installer could
 * not check the release.
 */
export function signChecksums(checksums, privateKeyPem, installerKey) {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('The release key must be an Ed25519 key.');
  if (publicKeyLine(privateKey) !== installerKey)
    throw new Error(
      'The release key does not match the public key in install.sh.',
    );
  const signature = sign(null, Buffer.from(checksums, 'utf8'), privateKey);
  if (!verifyChecksums(checksums, signature, installerKey))
    throw new Error('The signature of SHA256SUMS does not verify.');
  return signature;
}

/** Check a `SHA256SUMS.sig` against the public key line of install.sh. */
export function verifyChecksums(checksums, signature, installerKey) {
  const key = createPublicKey({
    key: Buffer.from(installerKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return (
    signature.length === 64 &&
    verify(null, Buffer.from(checksums, 'utf8'), key, signature)
  );
}

/** The release body: version, files with sizes, checksums and what is unsigned. */
export function releaseNotes({
  version,
  directory,
  files,
  checksums,
  signed,
  windowsSigned,
}) {
  const names = releaseAssetNames(version);
  const rows = [...files, names.checksums, ...(signed ? [names.signature] : [])]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((file) => `| \`${file}\` | ${statSync(join(directory, file)).size} |`);
  return [
    `WarGuardian Agent ${version}.`,
    '',
    '| File | Bytes |',
    '| --- | --- |',
    ...rows,
    '',
    '```text',
    checksums.trimEnd(),
    '```',
    '',
    signed
      ? '`SHA256SUMS.sig` is the Ed25519 signature of `SHA256SUMS`.'
      : 'Unsigned: this release has no `SHA256SUMS.sig`, so install.sh stops.',
    windowsSigned
      ? 'The Windows files carry an Authenticode signature.'
      : 'Windows files unsigned: no Authenticode signature.',
    '',
  ].join('\n');
}

/**
 * Prepare the release folder: copy install.sh with the version set, write
 * `SHA256SUMS`, sign it when `AGENT_RELEASE_SIGNING_KEY` holds the key, and
 * write the release body.
 */
export function prepareRelease({
  version,
  directory,
  installer,
  notes,
  windowsSigned,
  signingKey,
}) {
  const names = releaseAssetNames(version);
  const script = readFileSync(installer, 'utf8');
  const installerKey = installerReleaseKey(script);
  writeFileSync(join(directory, 'install.sh'), stampInstaller(script, version));
  for (const file of names.files) statSync(join(directory, file));
  const checksums = checksumsFor(directory, names.files);
  writeFileSync(join(directory, names.checksums), checksums);
  let signed = false;
  if (signingKey) {
    if (!installerKey) throw new Error('install.sh has no release public key.');
    writeFileSync(
      join(directory, names.signature),
      signChecksums(checksums, signingKey, installerKey),
    );
    signed = true;
  }
  writeFileSync(
    notes,
    releaseNotes({
      version,
      directory,
      files: names.files,
      checksums,
      signed,
      windowsSigned,
    }),
  );
  return { signed, checksums, files: names.files };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      dir: { type: 'string' },
      installer: { type: 'string' },
      notes: { type: 'string' },
      'windows-authenticode': { type: 'boolean' },
    },
  });
  if (!values.version || !values.dir || !values.installer || !values.notes)
    throw new Error(
      'Usage: release.mjs --version X.Y.Z --dir DIR --installer install.sh --notes FILE [--windows-authenticode]',
    );
  const { signed } = prepareRelease({
    version: values.version,
    directory: values.dir,
    installer: values.installer,
    notes: values.notes,
    windowsSigned: !!values['windows-authenticode'],
    signingKey: process.env.AGENT_RELEASE_SIGNING_KEY || null,
  });
  console.log(
    signed
      ? 'SHA256SUMS and SHA256SUMS.sig written.'
      : 'SHA256SUMS written. AGENT_RELEASE_SIGNING_KEY is not set, so the release is unsigned.',
  );
}
