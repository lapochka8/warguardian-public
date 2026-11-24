import { z } from 'zod';

/**
 * Steam Workshop rules shared by the panel and the WarGuardian Agent for the
 * Arma 3 and DayZ mod managers. Everything here is pure, so the Agent, the
 * route and the browser apply the same rules.
 *
 * - Mods are Steam published file IDs of the game's Workshop app (107410 for
 *   Arma 3, 221100 for DayZ). SteamCMD downloads them into
 *   `steamapps/workshop/content/<app>/<id>`.
 * - The Agent links each enabled mod into the server folder as `@<id>`. A
 *   numeric folder name is the same on every host and has no case to fold,
 *   which Arma 3 on Linux needs.
 * - Client mods go to `-mod=` and server-side mods to `-serverMod=`, in list
 *   order. The game loads them in that order.
 * - The `.bikey` files of client mods go into the server `keys` folder, so
 *   players with the same signed mods can join.
 */

export const bohemiaWorkshopGames = ['arma3', 'dayz'] as const;
export type BohemiaWorkshopGame = (typeof bohemiaWorkshopGames)[number];

export function isBohemiaWorkshopGame(
  value: unknown,
): value is BohemiaWorkshopGame {
  return (bohemiaWorkshopGames as readonly unknown[]).includes(value);
}

/** The Steam app IDs of each game: its Workshop and its dedicated server. */
export const bohemiaSteamApps: Readonly<
  Record<BohemiaWorkshopGame, { workshop: number; server: number }>
> = Object.freeze({
  arma3: Object.freeze({ workshop: 107410, server: 233780 }),
  dayz: Object.freeze({ workshop: 221100, server: 223350 }),
});

/** A Steam published file ID: a decimal number of up to 20 digits. */
export const steamWorkshopId = z
  .string()
  .regex(/^[1-9]\d{0,19}$/, 'Use a Steam Workshop ID.');

/** One mod of a server's list, in load order. */
export const bohemiaMod = z
  .object({
    id: steamWorkshopId,
    name: z.string().max(160).optional(),
    /** Absent means enabled. */
    enabled: z.boolean().optional(),
    /** Absent means a client mod (`-mod=`). True loads it with `-serverMod=`. */
    serverOnly: z.boolean().optional(),
    origin: z.enum(['selected', 'dependency']).optional(),
  })
  .strict();
export type BohemiaMod = z.infer<typeof bohemiaMod>;

export const bohemiaModListLimit = 300;

/** A list without duplicate IDs. */
export const bohemiaModList = z
  .array(bohemiaMod)
  .max(bohemiaModListLimit)
  .refine(
    (mods) => new Set(mods.map((mod) => mod.id)).size === mods.length,
    'A mod list cannot contain the same Workshop ID twice.',
  );

/** The server folder name of a Workshop mod. */
export function bohemiaModFolder(id: string): string {
  return `@${steamWorkshopId.parse(id)}`;
}

/** The `-mod=` and `-serverMod=` values of a list. Empty means omitted. */
export function bohemiaLaunchMods(mods: readonly BohemiaMod[]): {
  mod: string;
  serverMod: string;
} {
  const enabled = mods.filter((mod) => mod.enabled !== false);
  const join = (list: readonly BohemiaMod[]) =>
    list.map((mod) => bohemiaModFolder(mod.id)).join(';');
  return {
    mod: join(enabled.filter((mod) => !mod.serverOnly)),
    serverMod: join(enabled.filter((mod) => mod.serverOnly)),
  };
}

/** The launch arguments for the mods. Each is one argument, never a shell string. */
export function bohemiaModArguments(mods: readonly BohemiaMod[]): string[] {
  const { mod, serverMod } = bohemiaLaunchMods(mods);
  return [
    ...(mod ? [`-mod=${mod}`] : []),
    ...(serverMod ? [`-serverMod=${serverMod}`] : []),
  ];
}

/**
 * Mod IDs from pasted text: bare IDs, Workshop links (`?id=`), or an Arma 3
 * Launcher preset (HTML with `filedetails/?id=` links). Order is kept and
 * repeats are dropped.
 */
export function parseWorkshopIds(text: string): string[] {
  const found: string[] = [];
  const add = (value: string) => {
    if (steamWorkshopId.safeParse(value).success && !found.includes(value))
      found.push(value);
  };
  for (const match of text.matchAll(/[?&]id=(\d{1,20})/g)) add(match[1]!);
  const withoutLinks = text.replace(/[?&]id=\d{1,20}/g, ' ');
  for (const match of withoutLinks.matchAll(/(?<![\w.-])(\d{6,20})(?![\w.-])/g))
    add(match[1]!);
  return found.slice(0, bohemiaModListLimit);
}

/**
 * The list with every dependency placed before the first mod that needs it.
 * Steam lists a mod's required items as its children. A missing dependency
 * is added as `origin: 'dependency'`, enabled, with the dependent's side.
 * A cycle is refused, so a partial order is never applied.
 */
export function orderWithDependencies(
  mods: readonly BohemiaMod[],
  dependencies: ReadonlyMap<string, readonly string[]>,
  names: ReadonlyMap<string, string> = new Map(),
):
  | { ok: true; mods: BohemiaMod[]; added: string[] }
  | { ok: false; cycle: string[] } {
  const byId = new Map(mods.map((mod) => [mod.id, mod]));
  const result: BohemiaMod[] = [];
  const placed = new Set<string>();
  const added: string[] = [];
  const visiting: string[] = [];
  const visit = (id: string, side: boolean | undefined): string[] | null => {
    if (placed.has(id)) return null;
    const at = visiting.indexOf(id);
    if (at >= 0) return [...visiting.slice(at), id];
    if (visiting.length > bohemiaModListLimit) return [...visiting, id];
    visiting.push(id);
    for (const child of dependencies.get(id) ?? []) {
      if (!steamWorkshopId.safeParse(child).success || child === id) continue;
      const cycle = visit(child, byId.get(id)?.serverOnly ?? side);
      if (cycle) return cycle;
    }
    visiting.pop();
    let mod = byId.get(id);
    if (!mod) {
      const name = names.get(id);
      mod = {
        id,
        ...(name ? { name: name.slice(0, 160) } : {}),
        ...(side ? { serverOnly: true } : {}),
        origin: 'dependency',
      };
      added.push(id);
    }
    placed.add(id);
    result.push(mod);
    return null;
  };
  for (const mod of mods) {
    const cycle = visit(mod.id, mod.serverOnly);
    if (cycle) return { ok: false, cycle };
  }
  if (result.length > bohemiaModListLimit) return { ok: false, cycle: [] };
  return { ok: true, mods: result, added };
}

/** Enabled mods whose required items are missing or disabled. */
export function missingDependencies(
  mods: readonly BohemiaMod[],
  dependencies: ReadonlyMap<string, readonly string[]>,
): { id: string; needs: string }[] {
  const enabled = new Set(
    mods.filter((mod) => mod.enabled !== false).map((mod) => mod.id),
  );
  const missing: { id: string; needs: string }[] = [];
  for (const mod of mods)
    if (mod.enabled !== false)
      for (const child of dependencies.get(mod.id) ?? [])
        if (!enabled.has(child)) missing.push({ id: mod.id, needs: child });
  return missing;
}

export type BohemiaModUpdate =
  | 'current'
  | 'update-available'
  | 'not-installed'
  | 'unknown';

/**
 * Compares the Workshop's `time_updated` with the time SteamCMD recorded for
 * the installed copy (`appworkshop_<app>.acf`, `timeupdated`), both in Unix
 * seconds. A missing Workshop time is unknown, never current.
 */
export function bohemiaModUpdateState(
  installedAt: number | null | undefined,
  workshopUpdatedAt: number | null | undefined,
): BohemiaModUpdate {
  if (installedAt === null || installedAt === undefined) return 'not-installed';
  if (workshopUpdatedAt === null || workshopUpdatedAt === undefined)
    return 'unknown';
  return workshopUpdatedAt > installedAt ? 'update-available' : 'current';
}

/**
 * The installed items recorded in SteamCMD's `appworkshop_<app>.acf`, as
 * `{ id: timeupdated }`. The file is Valve KeyValues text. Unreadable entries
 * are skipped.
 */
export function readWorkshopManifest(text: string): Map<string, number> {
  const installed = new Map<string, number>();
  const start = text.indexOf('"WorkshopItemsInstalled"');
  if (start < 0) return installed;
  const open = text.indexOf('{', start);
  if (open < 0) return installed;
  let depth = 0,
    end = -1;
  for (let index = open; index < text.length; index++) {
    if (text[index] === '{') depth++;
    else if (text[index] === '}' && --depth === 0) {
      end = index;
      break;
    }
  }
  if (end < 0) return installed;
  const section = text.slice(open + 1, end);
  for (const item of section.matchAll(/"(\d{1,20})"\s*\{([^{}]*)\}/g)) {
    const time = /"timeupdated"\s*"(\d{1,12})"/.exec(item[2]!);
    if (time) installed.set(item[1]!, Number(time[1]));
  }
  return installed;
}

/**
 * Whether a file inside a mod is a BattlEye public key the server may copy.
 * Mods ship keys in `keys`, `Keys` or `key`. Only plain names are accepted.
 */
export function isModKeyFile(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/);
  if (parts.length !== 2) return false;
  const [folder, name] = parts as [string, string];
  return (
    /^(?:keys?|Keys?|KEYS?)$/.test(folder) &&
    /^[A-Za-z0-9_.@+-]{1,120}\.bikey$/i.test(name) &&
    !name.startsWith('.')
  );
}

/** A community pack entry. A server-side mod is stored as not required by clients. */
export type BohemiaPackEntry = {
  source: 'steam-workshop';
  id: string;
  appId: number;
  name?: string;
  required?: boolean;
  enabled?: boolean;
  origin?: 'selected' | 'dependency';
};

export function bohemiaPackEntry(
  game: BohemiaWorkshopGame,
  mod: BohemiaMod,
): BohemiaPackEntry {
  return {
    source: 'steam-workshop',
    id: mod.id,
    appId: bohemiaSteamApps[game].workshop,
    ...(mod.name ? { name: mod.name } : {}),
    ...(mod.serverOnly ? { required: false } : {}),
    ...(mod.enabled === false ? { enabled: false } : {}),
    ...(mod.origin ? { origin: mod.origin } : {}),
  };
}

/** The server list of a community pack. Entries of another source or game are left out. */
export function bohemiaModsFromPack(
  game: BohemiaWorkshopGame,
  entries: readonly {
    source: string;
    id: string;
    appId?: number | undefined;
    name?: string | undefined;
    required?: boolean | undefined;
    enabled?: boolean | undefined;
    origin?: 'selected' | 'dependency' | undefined;
  }[],
): BohemiaMod[] {
  const seen = new Set<string>();
  const result: BohemiaMod[] = [];
  for (const entry of entries) {
    if (
      entry.source !== 'steam-workshop' ||
      (entry.appId !== undefined &&
        entry.appId !== bohemiaSteamApps[game].workshop) ||
      !steamWorkshopId.safeParse(entry.id).success ||
      seen.has(entry.id)
    )
      continue;
    seen.add(entry.id);
    result.push({
      id: entry.id,
      ...(entry.name ? { name: entry.name.slice(0, 160) } : {}),
      ...(entry.required === false ? { serverOnly: true } : {}),
      ...(entry.enabled === false ? { enabled: false } : {}),
      ...(entry.origin ? { origin: entry.origin } : {}),
    });
  }
  return result.slice(0, bohemiaModListLimit);
}
