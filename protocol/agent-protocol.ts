import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { z } from 'zod';

/**
 * The WarGuardian Agent protocol. The panel and the agent both import this
 * module, so it depends on `zod` and `node:crypto` only. Security rests on the
 * per-agent secret, the request and response signatures and the checks on
 * both ends, not on the secrecy of this contract.
 */

export const agentServerId = z.string().regex(/^[a-z0-9-]{1,32}$/);
export const agentNonce = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/);
export const agentRequestId = z.uuid();

export const agentPollRequestSchema = z.object({}).strict();

export const agentCommandSchema = z
  .object({
    id: agentRequestId,
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().min(1).max(1800),
    body: z.string().max(65_536).optional(),
    contentType: z.string().max(200).optional(),
    revision: z.string().max(300).optional(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
  .refine(
    (command) =>
      command.path.startsWith('/reforger/v1/host/') ||
      command.path.length <= 300,
    'The WARDOGS agent path is too long.',
  )
  .refine(
    (command) => agentCommandAllowed(command.method, command.path),
    'The command is outside the outbound-agent allowlist.',
  )
  .refine(
    (command) => nativeCommandBodyAllowed(command),
    'A native command carries one typed operation.',
  )
  .meta({ id: 'agentCommand' });

export const agentPollResponseSchema = z
  .object({
    command: agentCommandSchema.nullable(),
    retryAfterMs: z.number().int().min(0).max(2_000),
  })
  .strict()
  .meta({ id: 'agentPollResponse' });

export function agentResponseBodyForbidden(status: number) {
  return status === 204 || status === 205 || status === 304;
}

export const agentResult = z
  .object({
    requestId: agentRequestId,
    status: z.number().int().min(200).max(599),
    contentType: z.string().max(200).optional(),
    etag: z.string().max(300).optional(),
    body: z
      .string()
      .max(1_398_104)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
  })
  .strict()
  .superRefine((result, context) => {
    if (agentResponseBodyForbidden(result.status) && result.body !== '')
      context.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'This HTTP status cannot include a response body.',
      });
  })
  .meta({ id: 'agentResult' });

export const agentAcceptedSchema = z
  .object({ accepted: z.literal(true) })
  .strict()
  .meta({ id: 'agentAccepted' });

export type AgentCommand = z.infer<typeof agentCommandSchema>;

const exactRoutes = new Set([
  'GET /v1/status',
  'GET /v1/players',
  'GET /v1/capabilities',
  'GET /v1/catalog/maps',
  'GET /v1/catalog/lightings',
  'GET /v1/catalog/experiences',
  'GET /v1/rotation',
  'GET /v1/health',
  'GET /v1/server-id',
  'GET /v1/bans',
  'GET /v1/reserved-slots',
  'GET /v1/config',
  'GET /v1/sponsor',
  'PATCH /v1/settings',
  'POST /v1/broadcast',
  'POST /v1/bans',
  'POST /v1/match/end',
  'POST /v1/match/restart',
  'POST /v1/match/map',
  'PUT /v1/world/lighting',
  'POST /v1/config/validate',
  'PUT /v1/config',
]);

/**
 * The agent is a narrow bridge, never a general HTTP proxy. It runs the
 * WARDOGS routes, the Arma Reforger host routes and the native relay routes.
 */
export function agentCommandAllowed(method: string, path: string) {
  const verb = method.toUpperCase();
  if (nativeRelayCommandAllowed(verb, path)) return true;
  if (verb === 'POST' && path === '/reforger/v1/host/command') return true;
  if (
    verb === 'GET' &&
    /^\/reforger\/v1\/host\/(?:status|config|logs|modpacks|mod-cache|mod-updates|backups|backup-import|scenarios|saves|instances)$/.test(
      path,
    )
  )
    return true;
  if (
    verb === 'GET' &&
    // `logs` is in both groups: the plain tail has no query, and live log
    // pages carry a cursor. The panel sends a cursor only to an agent that
    // reports the `logs-tail` capability.
    /^\/reforger\/v1\/host\/(?:files|file|backup-chunk|workshop|workshop-detail|workshop-servers|workshop-server-mods|job|telemetry|stability|logs|log-chunk)\?[a-zA-Z0-9%_.~=&-]{1,1500}$/.test(
      path,
    )
  )
    return true;
  if (exactRoutes.has(`${verb} ${path}`)) return true;
  if (
    verb === 'GET' &&
    /^\/v1\/audit\?limit=(?:[1-9]|[1-9]\d|1\d\d|200)$/.test(path)
  )
    return true;
  if (
    verb === 'GET' &&
    /^\/v1\/catalog\/maps\/[^/?#]{1,150}\/(?:experiences|alternators)$/.test(
      path,
    )
  )
    return true;
  if (
    ['POST', 'PATCH'].includes(verb) &&
    /^\/v1\/players\/\d{17,20}(?:\/(?:kick|kill|message))?$/.test(path)
  )
    return true;
  return verb === 'DELETE' && /^\/v1\/bans\/\d{17,20}$/.test(path);
}

export function agentBodyDigest(body: string | Uint8Array) {
  return createHash('sha256').update(body).digest('base64url');
}

export function agentSignature(
  secret: string,
  input: {
    direction: 'request' | 'response';
    method: string;
    path: string;
    serverId: string;
    at: number;
    nonce: string;
    body: string | Uint8Array;
  },
) {
  return createHmac('sha256', secret)
    .update(
      [
        'warguardian-agent-v1',
        input.direction,
        input.method.toUpperCase(),
        input.path,
        input.serverId,
        String(input.at),
        input.nonce,
        agentBodyDigest(input.body),
      ].join('\n'),
    )
    .digest('base64url');
}

export function agentSignatureMatches(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Agent profiles

/** The profile an enrolled agent runs. It follows the server's game. */
export const agentProfiles = [
  'wardogs',
  'arma-reforger',
  'battleye',
  'squad-family',
] as const;
export const agentProfileSchema = z.enum(agentProfiles);
export type AgentProfile = z.infer<typeof agentProfileSchema>;

/**
 * The games a server binding may name: the storable games of this release.
 * Squad 44 and Beyond the Wire are not among them, so no server of theirs
 * can enroll.
 */
export const agentGameIds = [
  'wardogs',
  'arma-reforger',
  'arma3',
  'dayz',
] as const;
/**
 * The games an agent reports from its host. The agent keeps its Squad family
 * profile for servers set up by hand, but discovery does not offer them.
 */
export const agentDiscoverableGameIds = [
  'wardogs',
  'arma-reforger',
  'arma3',
  'dayz',
] as const;

/** The agent build targets. */
export const agentPlatforms = ['linux-x64', 'linux-arm64', 'win-x64'] as const;
export const agentPlatformSchema = z.enum(agentPlatforms);
export type AgentPlatform = z.infer<typeof agentPlatformSchema>;
/**
 * Release artifacts: one executable per build target, and the Windows
 * installer that setup pages link to.
 */
export const agentArtifactKeys = [
  ...agentPlatforms,
  'win-x64-installer',
] as const;
export const agentArtifactKeySchema = z.enum(agentArtifactKeys);
export type AgentArtifactKey = z.infer<typeof agentArtifactKeySchema>;

export const agentVersionSchema = z
  .string()
  .regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/);
export const agentSecretSchema = z.string().regex(/^wga_[A-Za-z0-9_-]{43}$/);

// Native relay

/**
 * The native relay routes. The agent holds the RCON session on its host and
 * runs only the typed operations below. It builds each command line itself,
 * never accepts a raw command and never sends `#shutdown`. A conditional
 * operation checks the target and sends the command in one RCON login.
 */
export const nativeRelayPaths = Object.freeze({
  op: '/native/v1/op',
  events: '/native/v1/events',
  identity: '/native/v1/identity',
});

const nativeFeedPath =
  /^\/native\/v1\/(?:events|identity)(?:\?cursor=[A-Za-z0-9_-]{1,64})?$/;

function nativeRelayCommandAllowed(verb: string, path: string) {
  if (verb === 'POST') return path === nativeRelayPaths.op;
  return verb === 'GET' && nativeFeedPath.test(path);
}

/** The relay path of one feed read, with the cursor of the previous read. */
export function nativeFeedPathFor(
  feed: 'events' | 'identity',
  cursor?: string,
) {
  if (cursor !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(cursor))
    throw new RangeError(
      'A native feed cursor is 1 to 64 URL-safe characters.',
    );
  return `${nativeRelayPaths[feed]}${cursor === undefined ? '' : `?cursor=${cursor}`}`;
}

/** The agent kind that may receive a command for this path. */
export type AgentCommandKind = 'wardogs' | 'reforger-host' | 'native';
export function agentCommandKind(path: string): AgentCommandKind {
  if (path.startsWith('/reforger/v1/host/')) return 'reforger-host';
  if (path.startsWith('/native/v1/')) return 'native';
  return 'wardogs';
}

/**
 * Control characters (U+0000 to U+001F and U+007F to U+009F), the line and
 * paragraph separators and unpaired surrogates. Any of them can end or split
 * a game command line.
 */
function forbiddenCodePoint(codePoint: number) {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  );
}

function gameTextAllowed(
  text: string,
  maxChars: number,
  maxBytes: number,
  forbidden?: RegExp,
) {
  if (!text.trim()) return false;
  let chars = 0,
    bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    chars += 1;
    bytes +=
      codePoint < 0x80
        ? 1
        : codePoint < 0x800
          ? 2
          : codePoint < 0x10000
            ? 3
            : 4;
    if (forbiddenCodePoint(codePoint) || chars > maxChars || bytes > maxBytes)
      return false;
  }
  return !forbidden?.test(text);
}

function gameText(maxChars: number, maxBytes: number, forbidden?: RegExp) {
  return z
    .string()
    .max(maxChars * 2)
    .refine(
      (text) => gameTextAllowed(text, maxChars, maxBytes, forbidden),
      'The text cannot be sent to the game server.',
    );
}

/** Text limits of the game command builders. */
export const nativeTextLimits = Object.freeze({
  battleye: { maxChars: 200, maxBytes: 400 },
  squadReason: { maxChars: 200, maxBytes: 600 },
  squadMessage: { maxChars: 300, maxBytes: 900 },
});
/** Characters the Squad family console can read as a command separator. */
export const squadForbiddenText = /["\\;`|]/u;

const battleyeGuid = z.string().regex(/^[0-9a-f]{32}$/);
const battleyePlayer = z.number().int().min(0).max(65_535);
const battleyeText = gameText(
  nativeTextLimits.battleye.maxChars,
  nativeTextLimits.battleye.maxBytes,
);
const steamId = z.string().regex(/^7656119\d{10}$/);
const squadPlayer = z.number().int().min(0).max(999_999);
const squadReason = gameText(
  nativeTextLimits.squadReason.maxChars,
  nativeTextLimits.squadReason.maxBytes,
  squadForbiddenText,
);
const squadMessage = gameText(
  nativeTextLimits.squadMessage.maxChars,
  nativeTextLimits.squadMessage.maxBytes,
  squadForbiddenText,
);

const battleye = { profile: z.literal('battleye') };
const squad = { profile: z.literal('squad-family') };

/** Arma 3 and DayZ. BattlEye ban lengths are minutes. */
export const battleyeOperationSchema = z.discriminatedUnion('op', [
  z.object({ ...battleye, op: z.literal('players') }).strict(),
  z.object({ ...battleye, op: z.literal('bans') }).strict(),
  z
    .object({
      ...battleye,
      op: z.literal('kickIfGuid'),
      player: battleyePlayer,
      guid: battleyeGuid,
      reason: battleyeText,
    })
    .strict(),
  z
    .object({
      ...battleye,
      op: z.literal('sayIfGuid'),
      player: battleyePlayer,
      guid: battleyeGuid,
      message: battleyeText,
    })
    .strict(),
  z
    .object({ ...battleye, op: z.literal('broadcast'), message: battleyeText })
    .strict(),
  z
    .object({
      ...battleye,
      op: z.literal('addBan'),
      guid: battleyeGuid,
      minutes: z.union([
        z.literal('permanent'),
        z.number().int().min(1).max(5_256_000),
      ]),
      reason: battleyeText,
    })
    .strict(),
  z
    .object({
      ...battleye,
      op: z.literal('removeBanForGuid'),
      guid: battleyeGuid,
    })
    .strict(),
]);

/** The Squad family profile. Squad family ban lengths are days. */
export const squadOperationSchema = z.discriminatedUnion('op', [
  z.object({ ...squad, op: z.literal('players') }).strict(),
  z.object({ ...squad, op: z.literal('bans') }).strict(),
  z
    .object({
      ...squad,
      op: z.literal('kickIfSteamId'),
      player: squadPlayer,
      steamId,
      reason: squadReason,
    })
    .strict(),
  z
    .object({
      ...squad,
      op: z.literal('warnIfSteamId'),
      player: squadPlayer,
      steamId,
      message: squadMessage,
    })
    .strict(),
  z
    .object({ ...squad, op: z.literal('broadcast'), message: squadMessage })
    .strict(),
  z
    .object({
      ...squad,
      op: z.literal('addBan'),
      steamId,
      days: z.union([
        z.literal('permanent'),
        z.number().int().min(1).max(3_650),
      ]),
      reason: squadReason,
    })
    .strict(),
  z
    .object({ ...squad, op: z.literal('removeBanForSteamId'), steamId })
    .strict(),
]);

/** The body of `POST /native/v1/op`. Nothing else is accepted. */
export const nativeOperationSchema = z
  .union([battleyeOperationSchema, squadOperationSchema])
  .meta({ id: 'nativeAgentOperation' });
export type NativeOperation = z.infer<typeof nativeOperationSchema>;

/** The largest serialized operation. */
export const nativeOperationMaxBytes = 4_096;

/** One typed operation from a command body, or null. */
export function parseNativeOperationBody(
  body: string | undefined,
): NativeOperation | null {
  if (
    typeof body !== 'string' ||
    Buffer.byteLength(body) > nativeOperationMaxBytes
  )
    return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = nativeOperationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function nativeCommandBodyAllowed(command: {
  method: string;
  path: string;
  body?: string;
}) {
  if (agentCommandKind(command.path) !== 'native') return true;
  if (command.method === 'GET') return command.body === undefined;
  return parseNativeOperationBody(command.body) !== null;
}

/**
 * The agent's answer to one operation:
 *
 * - `read`: the game server's reply to `players` or `bans`, unparsed. The
 *   panel parses it with the same parsers as a direct connection.
 * - `sent`: the command went out in the login that checked its target.
 * - `target-changed`: that player number no longer holds that identity.
 * - `not-found`: no ban entry holds that identity.
 * - `unsupported`: this agent or game cannot run the operation.
 */
export const nativeOperationResultSchema = z
  .discriminatedUnion('outcome', [
    z
      .object({
        outcome: z.literal('read'),
        reply: z.string().max(1_000_000),
        observedAt: z.number().int().positive(),
      })
      .strict(),
    z
      .object({ outcome: z.literal('sent'), reply: z.string().max(65_536) })
      .strict(),
    z.object({ outcome: z.literal('target-changed') }).strict(),
    z.object({ outcome: z.literal('not-found') }).strict(),
    z.object({ outcome: z.literal('unsupported') }).strict(),
  ])
  .meta({ id: 'nativeAgentOperationResult' });
export type NativeOperationResult = z.infer<typeof nativeOperationResultSchema>;

/** Operations that change the game server. The others only read. */
export const nativeWriteOperations: ReadonlySet<NativeOperation['op']> =
  new Set([
    'kickIfGuid',
    'sayIfGuid',
    'broadcast',
    'addBan',
    'removeBanForGuid',
    'kickIfSteamId',
    'warnIfSteamId',
    'removeBanForSteamId',
  ]);

/**
 * Error codes of a non-2xx answer `{error, message}`. A command that was sent
 * without a reply is answered with `nativeReplyMissingStatus` and
 * `reply-missing`: it may have run, and the agent never sends it again.
 */
export const nativeErrorCodes = [
  'invalid-operation',
  'invalid-text',
  'reply-missing',
  'game-unavailable',
  'login-rejected',
  'not-configured',
  'unsupported',
] as const;
export const nativeReplyMissingStatus = 504;
export const nativeOperationErrorSchema = z
  .object({
    error: z.enum(nativeErrorCodes),
    message: z.string().max(1_000).optional(),
  })
  .strict();

/**
 * What the panel makes of one operation: the agent's result, or
 * `unconfirmed` when a change was sent and no reply came. An unconfirmed
 * change may have run.
 */
export const nativeOperationOutcomeSchema = z
  .union([
    nativeOperationResultSchema,
    z.object({ outcome: z.literal('unconfirmed') }).strict(),
  ])
  .meta({ id: 'nativeAgentOperationOutcome' });
export type NativeOperationOutcome = z.infer<
  typeof nativeOperationOutcomeSchema
>;

const feedCursor = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** `GET /native/v1/events`: pushed RCON lines after the cursor, unparsed. */
export const nativeEventFeedSchema = z
  .object({
    cursor: feedCursor,
    lines: z
      .array(
        z
          .object({
            at: z.number().int().positive(),
            text: z.string().max(4_096),
          })
          .strict(),
      )
      .max(500),
    dropped: z.number().int().min(0),
  })
  .strict()
  .meta({ id: 'nativeAgentEventFeed' });

/**
 * `GET /native/v1/identity`: identities the agent read from host logs after
 * the cursor, such as the Steam ID of a connecting player.
 */
export const nativeIdentityFeedSchema = z
  .object({
    cursor: feedCursor,
    entries: z
      .array(
        z
          .object({
            at: z.number().int().positive(),
            name: z.string().max(128),
            steamId: steamId.optional(),
            guid: battleyeGuid.optional(),
          })
          .strict(),
      )
      .max(500),
    dropped: z.number().int().min(0),
  })
  .strict()
  .meta({ id: 'nativeAgentIdentityFeed' });

// Enrollment

/** Crockford base32 without I, L, O and U. */
export const enrollmentCodeAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** `WG-` and two groups of five: 10 characters, 50 bits. */
export const enrollmentCodePattern =
  /^WG-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;
/** A code expires 15 minutes after it is issued. */
export const enrollmentCodeLifetimeMs = 15 * 60_000;

/**
 * The canonical form of a typed code, or null. Case, spaces and dashes are
 * ignored, and O, I and L read as 0, 1 and 1, as Crockford base32 defines.
 */
export function normalizeEnrollmentCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  let text = value.toUpperCase().replace(/[\s-]/g, '');
  if (text.length === 12 && text.startsWith('WG')) text = text.slice(2);
  text = text.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{10}$/.test(text)) return null;
  return `WG-${text.slice(0, 5)}-${text.slice(5)}`;
}

/** A server the agent found on its host. Unknown entries are dropped. */
export const agentDiscoveredServerSchema = z.object({
  gameId: z.enum(agentDiscoverableGameIds),
  rconPort: z.number().int().min(1).max(65_535).optional(),
  gamePort: z.number().int().min(1).max(65_535).optional(),
  queryPort: z.number().int().min(1).max(65_535).optional(),
});
export type AgentDiscoveredServer = z.infer<typeof agentDiscoveredServerSchema>;

/** `POST /api/agent/v1/enroll`. */
export const agentEnrollRequestSchema = z
  .object({
    code: z.string().min(1).max(64),
    host: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    os: z.enum(['linux', 'win']),
    arch: z.enum(['x64', 'arm64']),
    version: agentVersionSchema,
    discovered: z.array(z.unknown()).max(32).optional(),
  })
  .meta({ id: 'agentEnrollRequest' });
export type AgentEnrollRequest = z.infer<typeof agentEnrollRequestSchema>;

/** The discovered servers this release understands, at most 16. */
export function agentDiscoveredServers(
  entries: readonly unknown[] | undefined,
): AgentDiscoveredServer[] {
  return (entries ?? [])
    .flatMap((entry) => {
      const parsed = agentDiscoveredServerSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, 16);
}

/** The one-time answer to an enrollment. The secret is never shown again. */
export const agentEnrollResponseSchema = z
  .object({
    serverId: agentServerId,
    gameId: z.enum(agentGameIds),
    profile: agentProfileSchema,
    secret: agentSecretSchema,
  })
  .strict()
  .meta({ id: 'agentEnrollResponse' });

/** `/etc/warguardian/agent.json`. The agent may keep more fields. */
export const agentConfigFileSchema = z.looseObject({
  panel: z.url(),
  serverId: agentServerId.optional(),
  secret: agentSecretSchema.optional(),
  profile: agentProfileSchema.optional(),
});

// Updates

export const agentUpdateFormat = 'warguardian-agent-update-v1';

function downloadUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

/**
 * One release file: an executable or the Windows installer. `sha256` is the
 * digest of the file, `sig` its detached minisign signature and `url` an
 * HTTPS address.
 */
export const agentArtifactSchema = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sig: z
      .string()
      .min(1)
      .max(2_048)
      .regex(/^[\x20-\x7e\n]+$/),
    url: z.string().max(2_048).refine(downloadUrl),
    size: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024)
      .optional(),
  })
  .strict();

/** The signed payload of `GET /api/agent/v1/update`. */
export const agentUpdateManifestSchema = z
  .object({
    version: agentVersionSchema,
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    artifacts: z.partialRecord(agentArtifactKeySchema, agentArtifactSchema),
  })
  .strict();
export type AgentUpdateManifest = z.infer<typeof agentUpdateManifestSchema>;

/**
 * The update envelope. `signature` is Ed25519 over the format name, a line
 * feed and the exact `payload` text. `keyId` names the signing key.
 */
export const agentUpdateEnvelopeSchema = z
  .object({
    format: z.literal(agentUpdateFormat),
    keyId: z.string().regex(/^[0-9a-f]{16}$/),
    payload: z.string().min(2).max(65_536),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict()
  .meta({ id: 'agentUpdate' });
export type AgentUpdateEnvelope = z.infer<typeof agentUpdateEnvelopeSchema>;

export function agentUpdateSigningInput(payload: string) {
  return Buffer.from(`${agentUpdateFormat}\n${payload}`, 'utf8');
}

/** The ID of a raw 32-byte Ed25519 public key. */
export function agentUpdateKeyId(publicKey: Uint8Array) {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
}

/**
 * The manifest when one of the pinned keys signed it and it has not expired,
 * otherwise null. Keys are raw 32-byte Ed25519 public keys in base64url.
 */
export function verifyAgentUpdate(
  value: unknown,
  pinnedKeys: readonly string[],
  now = Date.now(),
): AgentUpdateManifest | null {
  const envelope = agentUpdateEnvelopeSchema.safeParse(value);
  if (!envelope.success) return null;
  const key = pinnedKeys.find(
    (candidate) =>
      agentUpdateKeyId(Buffer.from(candidate, 'base64url')) ===
      envelope.data.keyId,
  );
  if (!key || Buffer.from(key, 'base64url').length !== 32) return null;
  const signed = verify(
    null,
    agentUpdateSigningInput(envelope.data.payload),
    createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: key },
      format: 'jwk',
    }),
    Buffer.from(envelope.data.signature, 'base64url'),
  );
  if (!signed) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(envelope.data.payload);
  } catch {
    return null;
  }
  const manifest = agentUpdateManifestSchema.safeParse(payload);
  if (
    !manifest.success ||
    manifest.data.expiresAt <= now ||
    manifest.data.issuedAt > now + 300_000
  )
    return null;
  return manifest.data;
}
