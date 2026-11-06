/** Official scenarios listed by the game's -listScenarios output (1.6.0)
 * and the resource database of 1.8.0.13. Mod scenarios come from a scan. */
export const reforgerOfficialScenarios: { scenarioId: string; name: string }[] =
  [
    {
      scenarioId: '{ECC61978EDCC2B5A}Missions/23_Campaign.conf',
      name: 'Conflict - Everon',
    },
    {
      scenarioId: '{C41618FD18E9D714}Missions/23_Campaign_Arland.conf',
      name: 'Conflict - Arland',
    },
    {
      scenarioId: '{9C6054B42A044DEC}Missions/23_Campaign_Cain.conf',
      name: 'Conflict - Kolguyev',
    },
    {
      scenarioId: '{C700DB41F0C546E1}Missions/23_Campaign_NorthCentral.conf',
      name: 'Conflict - Northern Everon',
    },
    {
      scenarioId: '{28802845ADA64D52}Missions/23_Campaign_SWCoast.conf',
      name: 'Conflict - Southern Everon',
    },
    {
      scenarioId: '{94992A3D7CE4FF8A}Missions/23_Campaign_Western.conf',
      name: 'Conflict - Western Everon',
    },
    {
      scenarioId: '{FDE33AFE2ED7875B}Missions/23_Campaign_Montignac.conf',
      name: 'Conflict - Montignac',
    },
    {
      scenarioId: '{0220741028718E7F}Missions/23_Campaign_HQC_Everon.conf',
      name: 'Conflict: HQ Commander - Everon',
    },
    {
      scenarioId: '{68D1240A11492545}Missions/23_Campaign_HQC_Arland.conf',
      name: 'Conflict: HQ Commander - Arland',
    },
    {
      scenarioId: '{BB5345C22DD2B655}Missions/23_Campaign_HQC_Cain.conf',
      name: 'Conflict: HQ Commander - Kolguyev',
    },
    {
      scenarioId: '{59AD59368755F41A}Missions/21_GM_Eden.conf',
      name: 'Game Master - Everon',
    },
    {
      scenarioId: '{2BBBE828037C6F4B}Missions/22_GM_Arland.conf',
      name: 'Game Master - Arland',
    },
    {
      scenarioId: '{F45C6C15D31252E6}Missions/27_GM_Cain.conf',
      name: 'Game Master - Kolguyev',
    },
    {
      scenarioId: '{DAA03C6E6099D50F}Missions/24_CombatOps.conf',
      name: 'Combat Ops - Arland',
    },
    {
      scenarioId: '{DFAC5FABD11F2390}Missions/26_CombatOpsEveron.conf',
      name: 'Combat Ops - Everon',
    },
    {
      scenarioId: '{CB347F2F10065C9C}Missions/CombatOpsCain.conf',
      name: 'Combat Ops - Kolguyev',
    },
    {
      scenarioId: '{3F2E005F43DBD2F8}Missions/CAH_Briars_Coast.conf',
      name: 'Capture & Hold - Briars',
    },
    {
      scenarioId: '{F1A1BEA67132113E}Missions/CAH_Castle.conf',
      name: 'Capture & Hold - Montfort Castle',
    },
    {
      scenarioId: '{589945FB9FA7B97D}Missions/CAH_Concrete_Plant.conf',
      name: 'Capture & Hold - Concrete Plant',
    },
    {
      scenarioId: '{9405201CBD22A30C}Missions/CAH_Factory.conf',
      name: 'Capture & Hold - Almara Factory',
    },
    {
      scenarioId: '{1CD06B409C6FAE56}Missions/CAH_Forest.conf',
      name: "Capture & Hold - Simon's Wood",
    },
    {
      scenarioId: '{7C491B1FCC0FF0E1}Missions/CAH_LeMoule.conf',
      name: 'Capture & Hold - Le Moule',
    },
    {
      scenarioId: '{6EA2E454519E5869}Missions/CAH_Military_Base.conf',
      name: 'Capture & Hold - Camp Blake',
    },
    {
      scenarioId: '{2B4183DF23E88249}Missions/CAH_Morton.conf',
      name: 'Capture & Hold - Morton',
    },
  ];

/** The part of a -listScenarios listing that a scenario line was printed in. */
export type ScenarioListingSection = 'official' | 'workshop' | null;

/**
 * Reads the console lines printed by -listScenarios, one or more outputs in
 * order. Each scenario line holds a {GUID}path.conf resource, optionally
 * followed by its name. A "… scenarios (N entries)" heading starts a part:
 * Official, or Workshop for scenarios of loaded mods. Each output starts
 * outside a part, and the first listing of a scenario is kept.
 */
export function readReforgerScenarioListing(
  ...outputs: readonly (readonly string[])[]
) {
  const items = new Map<
    string,
    {
      scenarioId: string;
      name: string | null;
      section: ScenarioListingSection;
    }
  >();
  for (const lines of outputs) {
    let section: ScenarioListingSection = null;
    for (const line of lines) {
      const match =
        /(\{[0-9A-Fa-f]{16}\}[^\r\n(){}"\\]{1,240}?\.conf)(?:\s+\(([^)\r\n]{1,160})\))?\s*$/.exec(
          line,
        );
      if (!match) {
        const heading = /\b(\w+)\s+scenarios\s*\(\d+\s+entr(?:y|ies)\)/i.exec(
          line,
        );
        if (heading) {
          const kind = heading[1]!.toLowerCase();
          section =
            kind === 'official'
              ? 'official'
              : ['workshop', 'addon', 'addons', 'mod', 'mods'].includes(kind)
                ? 'workshop'
                : null;
        }
        continue;
      }
      const scenarioId = match[1]!.trim();
      if (!items.has(scenarioId))
        items.set(scenarioId, {
          scenarioId,
          name: match[2]?.trim() || null,
          section,
        });
    }
  }
  return [...items.values()].slice(0, 500);
}

/** Parses the console lines printed by -listScenarios. Each scenario line
 * holds a {GUID}path.conf resource, optionally followed by its name. */
export function parseReforgerScenarioListing(lines: readonly string[]) {
  return readReforgerScenarioListing(lines).map(({ scenarioId, name }) => ({
    scenarioId,
    name,
  }));
}

/** Where a scanned scenario comes from. A scan without one is on the host. */
export type ScenarioSource = {
  kind: 'official' | 'host' | 'mod';
  modId?: string;
  modName?: string;
};

/** One scenario that the editors offer by name. */
export type ScenarioOption = {
  scenarioId: string;
  name: string;
  source: 'official' | 'host' | 'mod';
  modName?: string;
};

/** The name of a scenario the scan did not name: its resource path. */
export const scenarioPathName = (scenarioId: string) =>
  scenarioId.replace(/^\{[^}]+\}/, '');

/**
 * The official scenarios followed by the scanned ones, each listed once. A
 * scanned official scenario keeps its official name and group.
 */
export function scenarioCatalogue(
  discovered: readonly {
    scenarioId: string;
    name: string | null;
    source?: ScenarioSource;
  }[] = [],
): ScenarioOption[] {
  const options: ScenarioOption[] = reforgerOfficialScenarios.map((item) => ({
    ...item,
    source: 'official',
  }));
  const seen = new Set(options.map((item) => item.scenarioId));
  for (const item of discovered) {
    if (seen.has(item.scenarioId)) continue;
    seen.add(item.scenarioId);
    const source = item.source?.kind ?? 'host',
      modName = source === 'mod' ? item.source?.modName?.trim() : undefined;
    options.push({
      scenarioId: item.scenarioId,
      name: item.name?.trim() || scenarioPathName(item.scenarioId),
      source,
      ...(modName ? { modName } : {}),
    });
  }
  return options;
}
