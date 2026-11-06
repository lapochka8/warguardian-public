/** Values the release build defines. Development runs use the fallbacks. */
declare const __WARGUARDIAN_AGENT_VERSION__: string | undefined;
declare const __WARGUARDIAN_AGENT_MANIFEST_KEYS__: string | undefined;
declare const __WARGUARDIAN_AGENT_RELEASE_KEY__: string | undefined;
declare const __WARGUARDIAN_AGENT_PANEL__: string | undefined;

export const buildInfo = Object.freeze({
  version:
    typeof __WARGUARDIAN_AGENT_VERSION__ === 'string'
      ? __WARGUARDIAN_AGENT_VERSION__
      : '0.0.0-dev',
  /**
   * Raw Ed25519 keys, base64url, that may sign update manifests. Self-update
   * runs only when these and `releaseKey` are both set.
   */
  manifestKeys: Object.freeze(
    (typeof __WARGUARDIAN_AGENT_MANIFEST_KEYS__ === 'string'
      ? __WARGUARDIAN_AGENT_MANIFEST_KEYS__
      : ''
    )
      .split(',')
      .filter(Boolean),
  ),
  /**
   * The Ed25519 release key that signs `SHA256SUMS` of each release, the
   * `release_public_key` of install.sh. Empty: self-update is off.
   */
  releaseKey:
    typeof __WARGUARDIAN_AGENT_RELEASE_KEY__ === 'string'
      ? __WARGUARDIAN_AGENT_RELEASE_KEY__
      : '',
  /** The default WarGuardian address for `enroll`. */
  panel:
    typeof __WARGUARDIAN_AGENT_PANEL__ === 'string'
      ? __WARGUARDIAN_AGENT_PANEL__
      : '',
});

export function agentTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
) {
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  return null;
}
