import type { z } from 'zod';
import {
  reforgerScenarioId,
  type reforgerModCache,
  type reforgerModpack,
} from '../games/reforger-host';
import {
  reforgerOfficialScenarios,
  type ScenarioListingSection,
  type ScenarioSource,
} from '../games/reforger-scenarios';

// A scenario scan runs the game with -listScenarios in a throwaway profile.
// A modpack scan also loads that pack's mods from the addon cache, so the
// scenarios they add are listed. It never downloads: every enabled mod of the
// pack must already be cached.

/** One cached mod that a modpack scan loads. */
export type ReforgerScanAddon = { modId: string; name: string; folder: string };
type Inventory = z.infer<typeof reforgerModCache>;
type Pack = z.infer<typeof reforgerModpack>;

/** A modpack scan loads at most this many cached mods. */
export const reforgerScanAddonLimit = 300;

/** The game arguments of a scenario scan in the profile `scanProfile`. */
export function reforgerScenarioScanArguments(
  scanProfile: string,
  addons: { directory: string; ids: readonly string[] } | null,
): string[] {
  return [
    '-listScenarios',
    '-profile',
    scanProfile,
    ...(addons?.ids.length
      ? ['-addonsDir', addons.directory, '-addons', addons.ids.join(',')]
      : []),
  ];
}

/**
 * The cached mods a scan of `pack` loads: each enabled mod of the pack, then
 * the cached mods their projects depend on. A dependency outside the cache,
 * such as the base game, is left to the game. Throws when an enabled mod is
 * not cached.
 */
export function reforgerScenarioScanAddons(
  pack: Pack,
  inventory: Inventory,
): ReforgerScanAddon[] {
  const cached = new Map(
    inventory.mods
      .filter((row) => row.status === 'cached' && row.folder)
      .map((row) => [row.modId, row]),
  );
  const enabled = pack.mods
    .filter((mod) => mod.enabled !== false)
    .map((mod) => mod.modId.toUpperCase());
  if (!enabled.length) throw new Error('This modpack has no enabled mods.');
  if (enabled.some((modId) => !cached.has(modId)))
    throw new Error('Download mods first.');
  const loaded = new Map<string, ReforgerScanAddon>();
  const queue = [...enabled];
  for (let next = queue.shift(); next; next = queue.shift()) {
    const row = cached.get(next);
    if (!row || loaded.has(next)) continue;
    if (loaded.size >= reforgerScanAddonLimit)
      throw new Error('A scenario scan loads at most 300 mods.');
    loaded.set(next, { modId: next, name: row.name, folder: row.folder });
    queue.push(...row.dependencies.map((modId) => modId.toUpperCase()));
  }
  return [...loaded.values()];
}

/**
 * Scenario IDs that a cached mod's `ServerData.json` lists under
 * `revision.scenarios`. The list exists in the cache format, but its entry
 * shape is not yet confirmed on a live host, so an entry counts only when it
 * holds a valid scenario resource ID.
 */
export function reforgerServerDataScenarios(serverData: unknown): string[] {
  const record = (value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const entries = record(record(serverData).revision).scenarios;
  if (!Array.isArray(entries)) return [];
  const ids = new Set<string>();
  for (const entry of entries.slice(0, 200))
    for (const value of typeof entry === 'string'
      ? [entry]
      : ['gameId', 'scenarioId', 'resourceName'].map(
          (key) => record(entry)[key],
        ))
      if (
        typeof value === 'string' &&
        reforgerScenarioId.safeParse(value.trim()).success
      )
        ids.add(value.trim());
  return [...ids];
}

const official = new Set(
  reforgerOfficialScenarios.map((item) => item.scenarioId),
);

/**
 * The source of each scanned scenario. Official scenarios stay official. In a
 * modpack scan, every other scenario comes from the loaded mods: from the mod
 * whose data lists it, from the only loaded mod, or else from an unnamed mod.
 * A scan without mods finds the rest on the host.
 */
export function reforgerScannedScenarios(
  items: readonly {
    scenarioId: string;
    name: string | null;
    section: ScenarioListingSection;
  }[],
  addons: readonly ReforgerScanAddon[] | null,
  owners: ReadonlyMap<string, ReforgerScanAddon> = new Map(),
) {
  const mod = (addon: ReforgerScanAddon): ScenarioSource => ({
    kind: 'mod',
    modId: addon.modId,
    modName: addon.name.slice(0, 160),
  });
  return items.map(({ scenarioId, name, section }) => {
    const owner = owners.get(scenarioId);
    const source: ScenarioSource =
      official.has(scenarioId) || section === 'official'
        ? { kind: 'official' }
        : !addons?.length
          ? { kind: 'host' }
          : owner
            ? mod(owner)
            : addons.length === 1
              ? mod(addons[0]!)
              : { kind: 'mod' };
    return { scenarioId, name, source };
  });
}
