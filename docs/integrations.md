# Game integration status

WarGuardian is publicly available for WARDOGS. Arma Reforger, Arma 3 and DayZ are available in beta. The other games below are planned, not currently supported connections.

| Game | Status | Focus |
| --- | --- | --- |
| WARDOGS | Available | RCON server administration, moderation and community operations |
| Arma Reforger | Beta | RCON moderation and server status. Game host control, mods, backups and updates with the WarGuardian Agent |
| Arma 3 | Beta | BattlEye RCON moderation, live players, chat and bans. Steam checks, Workshop mods and game host control with the WarGuardian Agent |
| DayZ | Beta | BattlEye RCON moderation, live players, chat and bans. Steam checks, Workshop mods and game host control with the WarGuardian Agent |
| Squad | Planned | Player moderation, layers, factions and supported rotation actions |
| Hell Let Loose | Planned | Map rotation, player lists, messages, kicks and bans |
| Rust | Planned | Player lists, messages, kicks, bans and supported server commands |

The planned integrations are not currently available on the public service. Release dates have not been announced. Features will depend on the supported interfaces and permissions of each game.

Support for one game does not imply that its commands, player identities or host controls work with another game. Detailed combat records require an appropriate event source. RCON access alone does not establish combat-statistics coverage.

## WARDOGS: available

The hosted WARDOGS RCON panel combines player moderation, community and server staff access, supported map/match controls, automation, private shared lists and player evidence review. A configured event feed is required for feed-based combat history. Individual controls depend on game capabilities and staff permissions.

A WARDOGS server connects by RCON and does not use the WarGuardian Agent.

Start with the [WARDOGS RCON guide](https://warguardian.app/wardogs-rcon) and [connection instructions](https://warguardian.app/wardogs-rcon/setup). Obtain credentials privately from your hosting provider.

## Arma Reforger: beta

Moderation and server status need only RCON. Game host control, mods, backups and updates need the WarGuardian Agent on a Linux host that you control. Rented game servers usually give RCON access only.

Choose Arma Reforger when you add the server. [Arma Reforger guide](https://warguardian.app/arma-reforger-rcon).

## Arma 3 and DayZ: beta

Live players, chat, bans and join screening need only BattlEye RCON. The WarGuardian Agent adds Steam checks, Workshop mods and game host control: start, stop and restart, the configuration file, logs and backups. It also connects a host that keeps its RCON port closed.

Steam identities, BattlEye GUIDs and temporary player slots have different meanings. Arma 3 and DayZ are separate integrations from Arma Reforger.

[Arma 3 guide](https://warguardian.app/arma-3-rcon) · [DayZ guide](https://warguardian.app/dayz-rcon)

## WarGuardian Agent

The WarGuardian Agent runs on the game host and connects out to WarGuardian over encrypted HTTPS, so the host opens no port. It is used with Arma Reforger, Arma 3 and DayZ. Its source is in this repository. See the [README](../README.md).

## Squad, Hell Let Loose and Rust: planned

Servers of these games cannot currently be connected. Each game needs its own support for its RCON variant, commands, identities and events. Generic RCON compatibility does not establish working rotation controls or complete player history.

No public onboarding or launch date is offered yet. Keep your existing management workflow until a supported migration path is announced.

[Squad](https://warguardian.app/squad-rcon) · [Hell Let Loose](https://warguardian.app/hell-let-loose-rcon) · [Rust](https://warguardian.app/rust-rcon)

## Connected services

| Offering | Current status |
| --- | --- |
| Hosted WARDOGS panel | Available. Current plans and beta terms apply |
| Arma Reforger, Arma 3 and DayZ | Beta. Current plans and beta terms apply |
| Existing private shared-list workflows | Available within the permissions and scope of the hosted product |

A roadmap entry is not a promise that all features or games will be released together.

[Current WARDOGS capabilities](https://warguardian.app/wardogs-rcon) · [Integration questions](https://discord.gg/uw8HStQBAq)
