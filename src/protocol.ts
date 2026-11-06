import { z } from 'zod';
import {
  agentArtifactKeySchema,
  agentArtifactSchema,
  agentCommandSchema,
  agentDiscoveredServerSchema,
  agentEnrollRequestSchema,
  agentEnrollResponseSchema,
  agentGameIds as sharedAgentGameIds,
  agentPlatformSchema,
  agentPlatforms,
  agentProfileSchema,
  agentProfiles,
  agentRequestId,
  agentResult,
  agentSecretSchema,
  agentServerId,
  agentUpdateManifestSchema,
  battleyeOperationSchema,
  nativeEventFeedSchema,
  nativeIdentityFeedSchema,
  nativeErrorCodes,
  nativeOperationMaxBytes,
  nativeOperationResultSchema,
  nativeRelayPaths,
  squadOperationSchema,
  type AgentCommand,
  type AgentDiscoveredServer,
  type AgentEnrollRequest,
  type AgentProfile,
  type AgentUpdateManifest,
  type NativeOperationResult,
} from '../protocol/agent-protocol';

/**
 * The agent side of the WarGuardian Agent contract. Schemas, signing and
 * update verification come from the shared protocol module, which the panel
 * imports too and which depends on `zod` and `node:crypto` only. This module
 * adds the agent's names, paths and limits.
 */

export {
  agentBodyDigest,
  agentResponseBodyForbidden,
  agentSignature,
  agentSignatureMatches,
  agentUpdateKeyId,
  enrollmentCodePattern,
  nativeOperationMaxBytes,
  nativeReplyMissingStatus,
  nativeTextLimits,
  normalizeEnrollmentCode,
  verifyAgentUpdate,
} from '../protocol/agent-protocol';
export type {
  AgentCommand,
  AgentProfile,
  AgentUpdateManifest,
  NativeOperationResult,
};

export const agentPaths = Object.freeze({
  poll: '/api/agent/v1/poll',
  result: '/api/agent/v1/result',
  enroll: '/api/agent/v1/enroll',
  update: '/api/agent/v1/update',
} as const);

export const agentHeaders = Object.freeze({
  agent: 'X-WarGuardian-Agent',
  time: 'X-WarGuardian-Time',
  nonce: 'X-WarGuardian-Nonce',
  signature: 'X-WarGuardian-Signature',
  /** The running agent version, unsigned and optional. */
  version: 'X-WarGuardian-Agent-Version',
} as const);

/** Signed timestamps more than this far from the local clock are refused. */
export const agentMaximumSkewMs = 60_000;
/** Largest poll response, in bytes. */
export const agentPollResponseMaxBytes = 100_000;
/** Largest result acknowledgement, in bytes. */
export const agentResultResponseMaxBytes = 10_000;
/** Largest result body before base64, in bytes. */
export const agentResultBodyMaxBytes = 1_048_576;
/** A command may not expire later than this after it is received. */
export const agentCommandMaxLifetimeMs = 30_000;

export { agentRequestId, agentResult, agentServerId };
export const agentSecret = agentSecretSchema;
/** One command from the panel. Commands outside the shared allowlist fail to parse. */
export const agentCommand = agentCommandSchema;

/** The command is parsed separately, so an unknown form can be answered with 400. */
export const agentPollResponse = z.object({
  command: z.unknown().optional(),
  retryAfterMs: z.number().int().min(0).max(60_000).optional(),
});

export const agentProfileIds = agentProfiles;
export const agentProfileId = agentProfileSchema;
export type AgentProfileId = AgentProfile;

export const agentGameIds = sharedAgentGameIds;
export const agentGameId = z.enum(sharedAgentGameIds);
export type AgentGameId = z.infer<typeof agentGameId>;
export const battleyeGameIds = ['arma3', 'dayz'] as const;
export const squadFamilyGameIds = ['squad44', 'beyond-the-wire'] as const;

export const agentTargetIds = agentPlatforms;
export const agentTargetId = agentPlatformSchema;
export type AgentTargetId = z.infer<typeof agentPlatformSchema>;

// Setup with a one-time code

/** A server found on this host. It never carries a password or a path. */
export const discoveredServer = agentDiscoveredServerSchema;
export type DiscoveredServer = AgentDiscoveredServer;
export const enrollRequest = agentEnrollRequestSchema;
export type EnrollRequest = AgentEnrollRequest;
export const enrollResponse = agentEnrollResponseSchema;
export type EnrollResponse = z.infer<typeof agentEnrollResponseSchema>;

// Native games

export const nativePaths = nativeRelayPaths;
export const battleyeOperation = battleyeOperationSchema;
export type BattlEyeOperation = z.infer<typeof battleyeOperationSchema>;
export const squadOperation = squadOperationSchema;
export type SquadOperation = z.infer<typeof squadOperationSchema>;
export const nativeOperationResult = nativeOperationResultSchema;
export const nativeEventFeed = nativeEventFeedSchema;
export type NativeEventFeed = z.infer<typeof nativeEventFeedSchema>;
export const nativeIdentityFeed = nativeIdentityFeedSchema;
export type NativeIdentityFeed = z.infer<typeof nativeIdentityFeedSchema>;

/** An opaque feed position. */
export const nativeCursor = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** At most this many lines or entries per feed read. */
export const nativeFeedMaxItems = 500;
/** Longer pushed lines are cut to this many characters. */
export const nativeFeedLineMaxChars = 4_096;

/**
 * Error codes of a non-2xx native answer `{error, message}`, shared with the
 * panel. A command that was sent without a reply is answered with
 * `nativeReplyMissingStatus` and `reply-missing`: it may have run and is
 * never sent again. The panel reports it as unconfirmed.
 */
export { nativeErrorCodes };

/** The body of `POST /native/v1/op` for one profile's schema, or null. */
export function parseNativeOperation<T extends z.ZodType>(
  schema: T,
  body: string | undefined,
): z.infer<T> | null {
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
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// Self-update

export const updateArtifact = agentArtifactSchema;
export const updateManifest = agentUpdateManifestSchema;
export type UpdateManifest = AgentUpdateManifest;

/**
 * `release.json`, written by the build. The panel reads it to fill
 * `install.sh`, to link the Windows installer (`win-x64-installer`) and to
 * sign update manifests. URLs are HTTPS addresses or paths on the panel.
 */
export const releaseFile = z
  .object({
    version: z.string(),
    artifacts: z.partialRecord(
      agentArtifactKeySchema,
      agentArtifactSchema.extend({
        url: z
          .string()
          .max(2_048)
          .refine((url) =>
            url.startsWith('/') && !url.startsWith('//')
              ? true
              : agentArtifactSchema.shape.url.safeParse(url).success,
          ),
      }),
    ),
  })
  .strict();
