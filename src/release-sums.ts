import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { AgentError } from './errors';
import type { AgentTargetId } from './protocol';

/**
 * The release check that install.sh makes too. Each release publishes
 * `SHA256SUMS`, the SHA-256 of every release file in the `sha256sum`
 * format, and `SHA256SUMS.sig`, a raw Ed25519 signature over it. The
 * release key is kept offline. Its public key is the `release_public_key`
 * of install.sh and is pinned in the agent at build time.
 */

/** An Ed25519 SubjectPublicKeyInfo in base64, as install.sh holds it. */
export const releaseKeyPattern = /^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/;

export const releaseChecksumsName = 'SHA256SUMS';
export const releaseSignatureName = 'SHA256SUMS.sig';
/** The largest `SHA256SUMS` read. */
export const releaseChecksumsMaxBytes = 16 * 1024;

/** The release file of the agent for each target. */
export const releaseFileNames: Record<AgentTargetId, string> = {
  'linux-x64': 'warguardian-agent-linux-x64',
  'linux-arm64': 'warguardian-agent-linux-arm64',
  'win-x64': 'warguardian-agent-win-x64.exe',
};

/** The Windows installer of a release. Its name carries the version. */
export function releaseInstallerName(version: string): string {
  return `WarGuardianAgentSetup-${version}.exe`;
}

/** The pinned release key, or null when `line` is not an Ed25519 key. */
export function releasePublicKey(line: string): KeyObject | null {
  if (!releaseKeyPattern.test(line)) return null;
  try {
    const key = createPublicKey({
      key: Buffer.from(line, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

/** The digests of `SHA256SUMS` by file name, or null when a line is malformed or repeated. */
export function parseChecksums(text: string): Map<string, string> | null {
  const digests = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]{1,128})$/.exec(line);
    if (!match || digests.has(match[2]!)) return null;
    digests.set(match[2]!, match[1]!);
  }
  return digests;
}

function refused(message: string): AgentError {
  return new AgentError(502, 'update-failed', message);
}

/**
 * The SHA-256 of the agent for `target` that a signed `SHA256SUMS` of
 * `version` lists. The signature must match the release key, and the list
 * must name this version's Windows installer, so the list of an earlier
 * release cannot stand in for it.
 */
export function releaseDigest(options: {
  checksums: Buffer;
  signature: Buffer;
  key: KeyObject;
  version: string;
  target: AgentTargetId;
}): string {
  if (
    options.signature.length !== 64 ||
    !verify(null, options.checksums, options.key, options.signature)
  )
    throw refused(
      'The signature of SHA256SUMS does not match the release key.',
    );
  const digests = parseChecksums(options.checksums.toString('utf8'));
  if (!digests) throw refused('SHA256SUMS is malformed.');
  if (!digests.has(releaseInstallerName(options.version)))
    throw refused(`SHA256SUMS does not belong to version ${options.version}.`);
  const digest = digests.get(releaseFileNames[options.target]);
  if (!digest)
    throw refused(
      `SHA256SUMS does not list ${releaseFileNames[options.target]}.`,
    );
  return digest;
}
