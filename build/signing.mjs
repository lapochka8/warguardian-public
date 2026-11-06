import { spawnSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Release signing, driven by environment variables. A step without its
 * configuration is skipped and the build is marked unsigned.
 *
 * Authenticode (Windows executables, WinSW and the installer):
 * - `WARGUARDIAN_SIGNTOOL`: path to signtool.exe.
 * - Azure Trusted Signing: `WARGUARDIAN_TRUSTED_SIGNING_DLIB` and
 *   `WARGUARDIAN_TRUSTED_SIGNING_METADATA`.
 * - Any other certificate: `WARGUARDIAN_SIGNTOOL_ARGS`, a JSON array of
 *   signtool arguments placed before the file, such as
 *   `["sign","/fd","SHA256","/tr","<timestamp URL>","/td","SHA256","/sha1","<thumbprint>"]`.
 *
 * Minisign (Linux artifacts and the update manifest):
 * - `WARGUARDIAN_MINISIGN_KEY`: an Ed25519 private key file in PKCS#8 PEM.
 * - `WARGUARDIAN_MINISIGN_KEY_ID`: optional 16 hex digits.
 * - `WARGUARDIAN_AGENT_RELEASE_PUBLIC_KEY`: the minisign public key to pin
 *   when the private key is kept elsewhere.
 *
 * Update manifests (signed by the panel at request time):
 * - `WARGUARDIAN_AGENT_MANIFEST_PUBLIC_KEYS`: comma-separated raw Ed25519
 *   public keys in base64url, or `WARGUARDIAN_AGENT_UPDATE_KEY_FILE`, the
 *   panel's PKCS#8 PEM private key, to derive the key from.
 */

const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');

export function authenticodeConfig(env = process.env) {
  const signtool = env.WARGUARDIAN_SIGNTOOL;
  if (!signtool) return null;
  if (!existsSync(signtool))
    throw new Error('WARGUARDIAN_SIGNTOOL does not name a file.');
  if (env.WARGUARDIAN_TRUSTED_SIGNING_DLIB) {
    if (!env.WARGUARDIAN_TRUSTED_SIGNING_METADATA)
      throw new Error(
        'Set WARGUARDIAN_TRUSTED_SIGNING_METADATA with WARGUARDIAN_TRUSTED_SIGNING_DLIB.',
      );
    return {
      mode: 'trusted-signing',
      signtool,
      args: [
        'sign',
        '/v',
        '/fd',
        'SHA256',
        '/tr',
        env.WARGUARDIAN_TRUSTED_SIGNING_TIMESTAMP ||
          'http://timestamp.acs.microsoft.com',
        '/td',
        'SHA256',
        '/dlib',
        env.WARGUARDIAN_TRUSTED_SIGNING_DLIB,
        '/dmdf',
        env.WARGUARDIAN_TRUSTED_SIGNING_METADATA,
      ],
    };
  }
  if (!env.WARGUARDIAN_SIGNTOOL_ARGS)
    throw new Error(
      'Set WARGUARDIAN_SIGNTOOL_ARGS or the Trusted Signing settings.',
    );
  const args = JSON.parse(env.WARGUARDIAN_SIGNTOOL_ARGS);
  if (
    !Array.isArray(args) ||
    !args.every((item) => typeof item === 'string') ||
    args[0] !== 'sign'
  )
    throw new Error(
      'WARGUARDIAN_SIGNTOOL_ARGS must be a JSON array of strings that starts with "sign".',
    );
  return { mode: 'signtool', signtool, args };
}

/** Sign a file in place and verify the signature chain. */
export function authenticodeSign(config, file) {
  for (const args of [
    [...config.args, file],
    ['verify', '/pa', file],
  ]) {
    const result = spawnSync(config.signtool, args, {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new Error(`signtool ${args[0]} failed for ${file}.`);
  }
}

/** The ISCC `/S` value that signs the installer and its uninstaller. */
export function innoSignTool(config) {
  const quote = (value) => `$q${value}$q`;
  return [
    quote(config.signtool),
    ...config.args.map((item) => (/\s/.test(item) ? quote(item) : item)),
    quote('$f'),
  ].join(' ');
}

export function minisignPublicKeyLine(publicKeyDer, keyId) {
  return Buffer.concat([
    Buffer.from('Ed'),
    keyId,
    publicKeyDer.subarray(spkiPrefix.length),
  ]).toString('base64');
}

export function minisignConfig(env = process.env) {
  const file = env.WARGUARDIAN_MINISIGN_KEY;
  if (!file) {
    const pinned = env.WARGUARDIAN_AGENT_RELEASE_PUBLIC_KEY?.trim();
    return pinned
      ? {
          privateKey: null,
          publicKeyLine: pinned
            .split(/\r?\n/)
            .filter(
              (line) => line && !line.startsWith('untrusted comment:'),
            )[0],
        }
      : null;
  }
  const privateKey = createPrivateKey(readFileSync(file));
  if (privateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('WARGUARDIAN_MINISIGN_KEY must be an Ed25519 key.');
  const publicDer = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  });
  const keyId = env.WARGUARDIAN_MINISIGN_KEY_ID
    ? Buffer.from(env.WARGUARDIAN_MINISIGN_KEY_ID, 'hex')
    : createHash('sha256').update(publicDer).digest().subarray(0, 8);
  if (keyId.length !== 8)
    throw new Error('WARGUARDIAN_MINISIGN_KEY_ID must be 16 hex digits.');
  return {
    privateKey,
    keyId,
    publicKeyLine: minisignPublicKeyLine(publicDer, keyId),
  };
}

/** A minisign public key file. */
export function minisignPublicKeyFile(publicKeyLine) {
  const keyId = Buffer.from(publicKeyLine, 'base64').subarray(2, 10);
  return `untrusted comment: minisign public key ${Buffer.from(keyId).reverse().toString('hex').toUpperCase()}\n${publicKeyLine}\n`;
}

/** A prehashed (`ED`) minisign signature of `message`. */
export function minisignSign(config, message, trustedComment) {
  if (!config.privateKey)
    throw new Error('No minisign private key is configured.');
  const digest = createHash('blake2b512').update(message).digest();
  const signature = sign(null, digest, config.privateKey);
  const comment = trustedComment.replace(/[\r\n]/g, ' ');
  const global = sign(
    null,
    Buffer.concat([signature, Buffer.from(comment, 'utf8')]),
    config.privateKey,
  );
  return [
    'untrusted comment: signature from WarGuardian release key',
    Buffer.concat([Buffer.from('ED'), config.keyId, signature]).toString(
      'base64',
    ),
    `trusted comment: ${comment}`,
    global.toString('base64'),
    '',
  ].join('\n');
}

/** The ID the panel gives a raw 32-byte Ed25519 public key. */
export function updateKeyId(publicKey) {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
}

/** Raw Ed25519 public keys, base64url, that may sign update manifests. */
export function manifestPublicKeys(env = process.env) {
  const keys = (env.WARGUARDIAN_AGENT_MANIFEST_PUBLIC_KEYS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (env.WARGUARDIAN_AGENT_UPDATE_KEY_FILE) {
    const privateKey = createPrivateKey(
      readFileSync(env.WARGUARDIAN_AGENT_UPDATE_KEY_FILE),
    );
    if (privateKey.asymmetricKeyType !== 'ed25519')
      throw new Error(
        'WARGUARDIAN_AGENT_UPDATE_KEY_FILE must be an Ed25519 key.',
      );
    keys.push(createPublicKey(privateKey).export({ format: 'jwk' }).x);
  }
  for (const key of keys)
    if (Buffer.from(key, 'base64url').length !== 32)
      throw new Error('Each manifest public key is 32 bytes in base64url.');
  return [...new Set(keys)];
}
