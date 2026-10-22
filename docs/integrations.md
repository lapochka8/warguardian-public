# Game integration status

WarGuardian's publicly available game integration is WARDOGS. The other games below are expansion targets, not currently supported connections. This page describes product scope, rather than an installation guide for unreleased integrations.

| Game | Status | Planned focus |
| --- | --- | --- |
| WARDOGS | Publicly available | RCON server administration, moderation and community operations |
| Arma Reforger | Planned | Reforger server administration, scenarios, mods and player moderation |
| Squad | Planned | Squad administration, layers, factions and player moderation |
| Arma 3 | Planned | BattlEye RCON administration, missions and player moderation |

The planned integrations are not currently available on the public service. Release dates have not been announced. Features will depend on each game’s supported interfaces and permissions.

Support for one game does not imply that its commands, player identities or host controls work with another game. Detailed combat records require an appropriate event source; RCON access alone does not establish combat-statistics coverage.

## WARDOGS — available

The hosted WARDOGS RCON panel combines player moderation, community and server staff access, supported map/match controls, automation, private shared lists and player evidence review. A configured event feed is required for feed-based combat history. Individual controls depend on game capabilities and staff permissions.

Start with the [WARDOGS RCON guide](https://warguardian.app/wardogs-rcon) and [connection instructions](https://warguardian.app/wardogs-rcon/setup). Obtain credentials privately from your hosting provider.

## Arma Reforger — planned

The planned Reforger integration targets its server administration, supported scenarios, mod profiles and player moderation. Game administration and host operations are distinct: changing installed mods or restarting a process requires suitable hosting access, beyond a generic RCON connection.

Reforger's game identities, cross-platform behavior and event sources need their own support. Arma 3 setup instructions must not be assumed to work for Reforger. No public Reforger onboarding or launch date is offered yet.

## Squad — planned

The planned Squad RCON integration targets player moderation, layers, factions and supported server operations. Squad's Source RCON variant, game commands and events require Squad-specific support. Generic RCON compatibility does not establish working layer rotation or complete player history.

No public Squad onboarding or launch date is offered yet. Keep your existing management workflow until a supported migration path is announced.

## Arma 3 — planned

The planned Arma 3 integration targets BattlEye RCON administration, mission management and player moderation. Steam identities, BattlEye GUIDs and temporary player slots have different meanings. Mission files, mod presets and process controls need separately supported host access.

No public Arma 3 onboarding or launch date is offered yet. It is a separate integration from Arma Reforger.

## Connected services

| Offering | Current status |
| --- | --- |
| Hosted WARDOGS panel | Available; current plans and beta terms apply |
| Existing private shared-list workflows | Available within the hosted product's permissions and scope |

A roadmap entry is not a promise that all features or games will be released together.

[Current WARDOGS capabilities](https://warguardian.app/wardogs-rcon) · [Integration questions](https://discord.gg/uw8HStQBAq)
