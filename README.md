# WarGuardian — WARDOGS RCON and community server management

[WarGuardian](https://warguardian.app/) is a hosted **WARDOGS RCON tool, moderation dashboard and game server administration panel**. Community owners and staff can manage players, bans, maps, automation and evidence reviews from a browser. It supports communities running one WARDOGS dedicated server or several servers with different staff assignments.

Your game server stays with its existing hosting provider. Your first WARDOGS server is free; additional server allowances and optional services follow the [current pricing and beta terms](https://warguardian.app/pricing).

- [Open WarGuardian](https://warguardian.app/)
- [WARDOGS RCON capabilities](https://warguardian.app/wardogs-rcon)
- [Connect a WARDOGS server](https://warguardian.app/wardogs-rcon/setup)
- [Discord support](https://discord.gg/uw8HStQBAq)
- [Game integration status](docs/integrations.md)
- [Service continuity commitment](docs/service-continuity.md)

## WARDOGS administration capabilities

| Area | What staff can do |
| --- | --- |
| Live players | View the current roster, player identity, faction and available match statistics. |
| Player moderation | Issue supported warnings and messages, kick players, manage bans and record moderation decisions. |
| Community ban management | Maintain community ban records and share private lists with participating communities. |
| Staff permissions | Assign access by community and server, with individual sign-ins and recorded staff actions. |
| Player history | Review observed sessions, names, moderation history and available account context. |
| Combat evidence | Use the connected kill feed and player reviews to investigate reported or flagged activity. |
| Server controls | Manage supported maps, rotations, match settings and priority queue access. |
| Automation | Configure supported scheduled announcements, player policies and server rules. |
| Discord and integrations | Connect community notifications and authorized bot or script workflows. |

Controls depend on the game server's exposed capabilities, connected event sources and the staff member's permissions. A saved moderation decision and a confirmed game-server action are different outcomes; staff should check the reported result.

### Player moderation and community bans

WarGuardian brings WARDOGS player management and community moderation into the same workspace. Staff can investigate a player, record a reason and apply supported actions without giving every moderator the server's RCON password. Timed bans and offline moderation support cases where a player has already left.

Community ban records and shared lists help participating server owners coordinate their rules. Sharing remains a deliberate community decision. A ban recorded by another community is attributed information to review, not proof that the player violated your rules. Review the source, reason, evidence and intended server scope before applying it.

Private ban-list sharing is available in the hosted product, within each community's permissions and sharing choices.

### Player history, kill feeds and evidence review

The live roster shows who is connected now. Player history gives staff context from earlier observations, while a configured WARDOGS kill feed supplies combat records for investigation. These serve different purposes: an RCON connection alone does not establish complete combat-event coverage.

Use the available history, match context and evidence together when reviewing a report. Names can change; inspect the recorded account identity rather than treating a display-name match as conclusive. Review flags and statistical scores help prioritize investigation. They do not prove cheating, establish a person's identity or guarantee that a sanction is justified.

### Staff access and accountability

Invite staff through their own sign-ins and assign permissions for the communities and servers they manage. A trial moderator and a community owner do not need the same access. Staff action records help owners understand who took an action and why.

Community ownership, account access and private player evidence belong in authenticated support channels. This public repository does not expose customer staff lists, ban records or server connection details.

### Maps, automation and everyday server operations

Use supported WARDOGS map and match controls, manage rotations and configure priority access alongside player moderation. Automation supports recurring community work such as announcements, broadcasts and supported player or server policies. Available actions vary by server capability and configuration.

Common workflows include connecting a new server, inviting moderators, reviewing a player report, applying a timed ban, coordinating a private shared list and checking a scheduled announcement. Follow the [connection guide](https://warguardian.app/wardogs-rcon/setup) for the initial RCON setup, then configure the workflows your community actually needs.

## Connect your first WARDOGS server

1. Open WarGuardian and sign in.
2. Create or select your community.
3. Obtain your RCON address, port and password from the game hosting provider. The RCON port may differ from the player connection port.
4. Follow the connection guide and check the connection result.
5. Assign staff access and configure the optional event feed and integrations you need.

Keep passwords and tokens private. Your community does not need to move its dedicated server or install a separate web panel to use the hosted service. If the connection fails, use [support](SUPPORT.md) with a redacted error message rather than posting credentials.

## Supported games and planned integrations

| Game | Public status | Focus |
| --- | --- | --- |
| WARDOGS | Available | RCON administration, moderation, community bans and evidence review. |
| Arma Reforger | Planned; not publicly available | Reforger administration, scenarios, mods and player moderation. |
| Squad | Planned; not publicly available | Squad RCON administration, layers, factions and moderation. |
| Arma 3 | Planned; not publicly available | BattlEye RCON administration, missions and moderation. |

No release dates are announced for the planned integrations. WARDOGS support does not imply that another game's protocol, commands, account identifiers or event sources are supported. See the [integration status page](docs/integrations.md) for the boundaries of each planned game.

## Open-source and service continuity commitment

The existing [service continuity policy](https://warguardian.app/legal) states:

> If WarGuardian permanently ceases operation, we will release all WarGuardian-owned code and models under open-source licenses.
>
> The release will include scoring rules, model files, and training and evaluation code.
>
> Private community and player data, credentials, and third-party material that we cannot redistribute will be excluded.
>
> Existing refund and data export rights remain unchanged.

This is a shutdown continuity commitment. It is not a claim that the application source or models are open source today. See [the commitment and its scope](docs/service-continuity.md).

## Choosing a WARDOGS RCON panel

When comparing WarGuardian, BattleMetrics RCON, Warcon or another server administration tool, verify the capabilities for your actual WARDOGS build. Check individual staff access, moderation records, community ban workflows, event coverage, hosting responsibilities and total cost.

WarGuardian is intended for communities seeking hosted WARDOGS server management with staff permissions, shared community bans and evidence review in one workspace. A self-hosted tool may suit an owner who wants to operate the software directly. No single tool is best for every server or community; compare current capabilities rather than assuming that a feature available for one game works for another.

## Support, security and documentation

- [Product questions](docs/overview.md): hosting, RCON access, staff roles and evidence coverage.
- [Support](SUPPORT.md): connection issues, account questions and useful redacted report details.
- [Security reporting](SECURITY.md): private vulnerability reports through GitHub Security Advisories.
- [Contributing](CONTRIBUTING.md): documentation corrections and feature suggestions.
- [Legal and policies](https://warguardian.app/legal): current service terms and continuity commitment.

## About this public repository

This repository publishes WarGuardian product information and documentation. The application remains proprietary today; this repository does not contain its source code, model implementation, private operating material or customer data. Future software releases will carry their own explicit license and distribution instructions.

WarGuardian is an independent community tool. It is not affiliated with BULKHEAD, Team17, Bohemia Interactive, Offworld Industries, Valve or the other tools named for comparison. Game and product names belong to their respective owners.
