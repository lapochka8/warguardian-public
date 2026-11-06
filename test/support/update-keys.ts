import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  agentUpdateFormat,
  agentUpdateKeyId,
  agentUpdateManifestSchema,
  agentUpdateSigningInput,
  type AgentUpdateEnvelope,
  type AgentUpdateManifest,
} from '../../protocol/agent-protocol';

/**
 * A throwaway Ed25519 release key, with its public key in the form that
 * install.sh pins: a base64 SubjectPublicKeyInfo.
 */
export function releaseKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const line = publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
  return {
    publicKey,
    line,
    /** `SHA256SUMS` of the files, sorted by name, and its raw signature. */
    sums(files: Record<string, Buffer>) {
      const checksums = Buffer.from(
        Object.keys(files)
          .sort()
          .map(
            (name) =>
              `${createHash('sha256').update(files[name]!).digest('hex')}  ${name}\n`,
          )
          .join(''),
      );
      return { checksums, signature: sign(null, checksums, privateKey) };
    },
  };
}

export type ReleaseKey = ReturnType<typeof releaseKey>;

/**
 * Routes for one release folder: each file, `SHA256SUMS` and its signature.
 * The Windows installer of the version is listed too, as a release lists it.
 * `files` is read at each request, so a test can change a file.
 */
export function releaseRoutes(
  release: ReleaseKey,
  folder: string,
  version: string,
  files: () => Record<string, Buffer>,
): Record<string, () => Response> {
  const all = () => ({
    [`WarGuardianAgentSetup-${version}.exe`]: Buffer.from(
      `installer ${version}`,
    ),
    ...files(),
  });
  const routes: Record<string, () => Response> = {
    [`${folder}/SHA256SUMS`]: () =>
      new Response(new Uint8Array(release.sums(all()).checksums)),
    [`${folder}/SHA256SUMS.sig`]: () =>
      new Response(new Uint8Array(release.sums(all()).signature)),
  };
  for (const name of Object.keys(all()))
    routes[`${folder}/${name}`] = () =>
      new Response(new Uint8Array(all()[name]!));
  return routes;
}

/** A throwaway update manifest key, as the panel's key file holds it. */
export function manifestKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x!;
  return {
    signing: {
      key: privateKey,
      keyId: agentUpdateKeyId(Buffer.from(raw, 'base64url')),
    },
    raw,
  };
}

export type Signing = { key: KeyObject; keyId: string };

/** Update envelopes stay valid for a day. */
const envelopeLifetimeMs = 24 * 3_600_000;

/**
 * An update envelope for a release, signed as the protocol defines:
 * Ed25519 over the format name, a line feed and the exact payload.
 */
export function envelope(
  signing: Signing,
  release: Omit<AgentUpdateManifest, 'issuedAt' | 'expiresAt'>,
  now = Date.now(),
): AgentUpdateEnvelope {
  const payload = JSON.stringify(
    agentUpdateManifestSchema.parse({
      version: release.version,
      issuedAt: now,
      expiresAt: now + envelopeLifetimeMs,
      artifacts: release.artifacts,
    }),
  );
  return {
    format: agentUpdateFormat,
    keyId: signing.keyId,
    payload,
    signature: sign(
      null,
      agentUpdateSigningInput(payload),
      signing.key,
    ).toString('base64url'),
  };
}

/** A fetch that answers from routes by path, and 404 otherwise. */
export function fakeFetch(
  routes: Record<string, () => Response>,
): typeof fetch {
  return async (input) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    const route = routes[url.pathname];
    return route ? route() : new Response('not found', { status: 404 });
  };
}
