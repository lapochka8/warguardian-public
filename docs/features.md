# Current WarGuardian features

WarGuardian is a hosted WARDOGS RCON panel for community server administration, moderation and player evidence review. This catalog describes current product workflows. A feature's availability depends on the connected game build, staff permissions, enabled integrations and applicable plan terms.

For other games, see [integration status](integrations.md). Arma Reforger, Squad and Arma 3 remain planned public integrations.

## Multi-server dashboard and live players

- See each connected server's map, population, connection state and last update.
- Open the selected server's administration workspace.
- Search and sort the live player roster by available fields.
- View reported faction, kills, deaths, cash, ping and join time.
- Open a player's profile and permitted moderation actions.

An online connection and fresh data are different signals. Stale, offline, waiting and unconfigured states help staff distinguish an empty server from missing observations.

## Moderation and server bans

Staff with the required permissions can send private messages, warn players, kick, ban, unban, change faction, respawn a player and manage priority access where the game supports those actions.

Ban workflows include reasons, timed bans, permanent bans, offline-player bans and appeal-message configuration. Offline bans may remain queued until the player joins. Timed removals require WarGuardian to remain running and the server to become reachable. Staff can inspect action history and uncertain delivery outcomes before trying again.

Bulk input supports moderation of several account IDs without relying on display names. Confirm the player, server, reason and duration before applying a ban.

## Community bans and private shared lists

Community owners and authorized staff can maintain moderation records, review reasons and evidence, and coordinate bans across selected servers. Private lists support explicitly authorized sharing with other communities and controlled subscription/enforcement workflows.

Publishing, receiving a list, selecting enforcement scope and viewing shared evidence have distinct permissions. Sharing a list does not grant general access to the issuing community's private notes or unrelated player history. Staff should inspect source attribution, status and evidence before treating an outside decision as relevant to their own rules.

List changes and withdrawals must be understood alongside independent local decisions. A community record and a confirmed game-server ban are not interchangeable states.

The [public ban-list directory](https://warguardian.app/public/ban-lists) provides a separate view of explicitly published lists and their published records/evidence. Public publication and private list sharing are different choices; a private list does not become public just because another community follows it.

## Player history, Steam context and watchlists

Recorded profiles bring together earlier names, visits, play time, match periods, staff notes, review history and command history. Staff can search by current name, recorded alias or Steam ID.

Where the Steam integration can obtain the data, profiles show visibility, account age, VAC bans and game bans. Cached timestamps and unavailable fields matter: a missing response is not a clean ban history.

Review statuses include Watching, Needs review, Reviewed and Not flagged. Staff can retain a reason and evidence links. Watchlist activity helps staff notice a flagged account returning or changing its name. A watch flag does not apply a ban by itself.

Player-network views distinguish confirmed Steam friendships from possible groups inferred from recorded shared activity. A connection between accounts does not establish common ownership or cheating.

## Player review and combat evidence

Player review provides summary and evidence views for retained records, including combat measurements, weapon comparisons, counts and source coverage. Authorized network comparisons can supply context alongside the selected server. Missing measurements remain unavailable rather than becoming zero.

Staff can copy a summary or evidence for a report, inspect relevant recorded activity and retain a community review decision. Review priority and statistical indicators help select cases for investigation; they are not a cheating probability or an automatic sanction.

Optional AI summaries use a configured community/personal provider or an available WarGuardian trial. Their availability and limits depend on configuration. Staff explicitly request a summary and should verify it against the evidence. AI output does not automatically ban players, open tickets or replace a staff decision.

## Live kill feed and suspicious-play alerts

The configured WARDOGS feed supplies recorded combat events with players, weapon/cause, time and distance where reported. Filters help staff inspect players, weapons, kill types and distance. Available badges distinguish headshots, team kills and suicides.

Feed configuration and data coverage are separate from the RCON connection. An empty server can legitimately be waiting for its first event. Some feed changes require a game-server restart before events arrive.

Suspicious-play alerts bring relevant recorded events to staff attention for review. An alert is not proof of cheating and does not automatically apply a ban. Feed-dependent policies need their required source and validation state.

## Reports and ticket inbox

Communities can offer enabled player-report links. Reporters choose the incident server and submit through the configured sign-in flow. Staff use a community inbox to claim or assign tickets, reply, keep internal notes, link reported players and resolve reports with an outcome.

Player links and internal notes remain staff material. Linking a reported player does not notify that player or grant access to the report. Eligible staff and server permissions control which tickets can be handled. Configured Discord notifications help staff notice reports.

## Priority queues, reserved slots and whitelist access

Priority access supports reserved-player lists, slot counts and whitelist-style entry where the game permits it. Bulk Steam-ID input helps owners add existing lists while identifying invalid or duplicate entries.

Streamer-whitelist controls can prepare access for configured streamers, existing players and qualifying regulars. Owners review the intended changes before applying them. Shared priority lists coordinate selected destinations, while configured seeding rewards can grant temporary reserved access to qualifying players.

## Maps, match controls and configuration

Server tools expose supported WARDOGS status, map/rotation and match controls, with settings access separated by permission. Owners can administer connections for their communities and keep server history when a connection is disabled.

Use configuration tools and their confirmations for supported changes. Commands and settings depend on the game's API and the hosting environment; an administration panel cannot provide an upstream capability that the server does not expose.

## Server history and analytics

Server history and analytics help staff inspect recorded server activity and player participation over the available periods. Use those records alongside live status and player review when investigating what happened during a session or match. Coverage depends on the retained observations and connected sources; an interruption in collection can leave gaps.

## Automation and community rules

| Rule or tool | Purpose and important condition |
| --- | --- |
| Team balancer | Balance factions, apply supported population limits and group clans where possible; dry run supports review before live changes. |
| Team-switch locks | Restrict later switches from match start or a configured score threshold; score-based locking needs reported scores. |
| Infected mode | Run configured faction-conversion gameplay using eligible recorded kills/deaths and supported faction changes. |
| Ping lock | Warn and then kick for sustained high ping after configured grace and duration; requires fresh roster observations. |
| Idle cleanup | Apply configured inactivity policy; separate from seeding protection. |
| Names and protected tags | Apply supported offensive-name and protected-tag policies. |
| White-faction cleanup | Apply the configured policy for players remaining on the non-playing faction. |
| Team-kill limits | Apply configured team-kill policy using its required event coverage. |
| Weapon restrictions | Kick after a reported kill violates a block/allow policy; this rule does not add bans. |
| Steam ban and connect rules | Apply configured join policies using available account information and supported actions. |
| Review indicators | Show configured review context and indicators for staff investigation. |
| Seeding protection | Run a configured respawn cycle below the population threshold to reset AFK timers; it affects connected players, including active players. |
| Seeding rewards | Award configured temporary priority access for qualifying recorded seeding time. |
| Empty-server reset | Apply configured map behavior when the server empties. |
| Weather cycle | Apply supported configured weather changes. |
| Outage alerts | Notify through configured channels about server availability. |
| Player messages | Send configured player-facing messages for supported events. |
| Announcements | Run enabled recurring broadcast schedules with message sequences and population conditions. |
| Restart warnings | Deliver configured restart notifications. |
| Custom rules | Combine supported schedule/player/map triggers with conditions and broadcasts, private messages, warnings or kicks. |

Rules need explicit configuration and the permissions and data sources their actions require. Dry run or preview is available for supported workflows; it should not be assumed to exist for every rule. Inspect recent results and action history when a saved rule does not produce the expected game-server behavior.

## Public pages, Discord and integrations

Communities can enable public leaderboards, player career pages and report entry points. Optional community branding follows current plan terms. Publishing community pages does not publish all staff records or player evidence.

Discord integrations support configured staff notifications and community workflows. API access supports authorized bots and scripts; permissions and server scope still apply. MCP review integration lets compatible clients retrieve authorized player evidence. These integrations do not grant unrestricted access to other communities.

## Communities, roles and access

Communities use Discord sign-in, staff roles, scoped invitations and server assignments. Owners can manage membership and access, while staff receive the actions their role permits. Signed-in device controls allow session revocation.

Supported interface/interaction surfaces include English, German, Turkish and Spanish, with explicit English fallback where a translation is unavailable. Custom authored message templates retain their saved wording.

## Setup, pricing and support

- [Connect your WARDOGS server](https://warguardian.app/wardogs-rcon/setup).
- [Current hosted plans and beta terms](https://warguardian.app/pricing).
- [Support](../SUPPORT.md) for account or connection issues.
- [Private security reporting](../SECURITY.md) for vulnerabilities.
- [Service continuity commitment](service-continuity.md) for the existing shutdown policy.

WarGuardian's first hosted WARDOGS server is free under the current offer. This catalog does not change pricing, announce new distributions or grant access to application source code.
