/**
 * Plugin permissions of a Rust server with Oxide or Carbon: the console
 * lines for groups and their permissions, and readers for the replies. Both
 * frameworks take the same commands, Oxide under `oxide.` and Carbon under
 * `c.`. The reply forms follow the frameworks' documentation and were not
 * read from a live server, so a reader takes what it can recognize and
 * leaves the rest out.
 *
 * The module has no imports, so the WarGuardian Agent uses it too.
 */

export const rustGroupName = /^[A-Za-z0-9_-]{1,40}$/;
export const rustPermissionName = /^[A-Za-z0-9_.*-]{1,80}$/;
const steam64 = /^7656119\d{10}$/;

export type RustFramework = 'oxide' | 'carbon';

const prefix = (framework: RustFramework) =>
  framework === 'carbon' ? 'c' : 'oxide';

function checked(value: string, pattern: RegExp, what: string): string {
  if (typeof value !== 'string' || !pattern.test(value))
    throw new RangeError(`Use a valid ${what}.`);
  return value;
}

export const rustPermissionLines = Object.freeze({
  groups: (framework: RustFramework) => `${prefix(framework)}.show groups`,
  group: (framework: RustFramework, group: string) =>
    `${prefix(framework)}.show group ${checked(group, rustGroupName, 'group name')}`,
  grant: (framework: RustFramework, group: string, permission: string) =>
    `${prefix(framework)}.grant group ${checked(group, rustGroupName, 'group name')} ${checked(permission, rustPermissionName, 'permission')}`,
  revoke: (framework: RustFramework, group: string, permission: string) =>
    `${prefix(framework)}.revoke group ${checked(group, rustGroupName, 'group name')} ${checked(permission, rustPermissionName, 'permission')}`,
  addPlayer: (framework: RustFramework, steamId: string, group: string) =>
    `${prefix(framework)}.usergroup add ${checked(steamId, steam64, 'Steam64 ID')} ${checked(group, rustGroupName, 'group name')}`,
  removePlayer: (framework: RustFramework, steamId: string, group: string) =>
    `${prefix(framework)}.usergroup remove ${checked(steamId, steam64, 'Steam64 ID')} ${checked(group, rustGroupName, 'group name')}`,
});

/** The names of a comma or line separated list that match `pattern`. */
function names(text: string, pattern: RegExp, limit: number): string[] {
  const found = new Set<string>();
  for (const part of text.split(/[,\r\n]+/)) {
    const name = part.trim();
    if (pattern.test(name)) found.add(name);
    if (found.size >= limit) break;
  }
  return [...found];
}

/** `show groups`: a heading, then the group names. */
export function parseRustGroups(reply: string): string[] {
  const at = reply.indexOf(':');
  return names(at < 0 ? reply : reply.slice(at + 1), rustGroupName, 100);
}

/** The text after a heading that ends with `<word>:`, up to an empty line. */
function section(reply: string, word: string): string {
  const lines = reply.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    new RegExp(`\\b${word}\\s*:`, 'i').test(line),
  );
  if (start < 0) return '';
  const first = lines[start]!.slice(lines[start]!.lastIndexOf(':') + 1);
  const rest: string[] = [first];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /:\s*$/.test(line)) break;
    rest.push(line);
  }
  return rest.join('\n');
}

/**
 * `show group <name>`: the players of the group by Steam64 ID, and its
 * permissions.
 */
export function parseRustGroup(reply: string): {
  players: string[];
  permissions: string[];
} {
  return {
    players: [
      ...new Set(
        // Oxide prints `players`, and Carbon prints `users`.
        (section(reply, 'players') || section(reply, 'users')).match(
          /7656119\d{10}/g,
        ) ?? [],
      ),
    ].slice(0, 500),
    permissions: names(
      section(reply, 'permissions'),
      rustPermissionName,
      500,
    ).filter((name) => name.includes('.')),
  };
}

/** Whether a reply to a change names what changed and reports no problem. */
export function rustPermissionChanged(reply: string, named: string): boolean {
  return (
    reply.toLowerCase().includes(named.toLowerCase()) &&
    /\b(?:granted|revoked|added|removed)\b/i.test(reply) &&
    !/\b(?:not|error|fail|already|doesn't|invalid|unknown)\b/i.test(reply)
  );
}
