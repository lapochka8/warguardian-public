# WarGuardian product overview

## What is WarGuardian?

WarGuardian is a hosted WARDOGS RCON panel for community server administrators. It combines server controls with player moderation, staff access, shared ban lists and evidence review.

## Does it replace game hosting?

No. Your dedicated game server stays with its existing hosting provider. WarGuardian connects to the server’s supported RCON endpoint.

## How do I connect a WARDOGS server?

Obtain the RCON address, port and password from your hosting provider, then follow the [official WarGuardian setup guide](https://warguardian.app/wardogs-rcon/setup). Keep connection credentials private.

## Do all staff need the RCON password?

Connect the server and assign staff access through WarGuardian. Staff permissions determine which actions each person can perform.

## Does a player flag prove cheating?

No. Player evidence reviews support staff investigation. Review the available evidence before taking a moderation action.

## Which games are available?

WARDOGS is publicly supported. Arma Reforger, Squad and Arma 3 integrations are planned. They are not currently available on the public service. [Integration details](integrations.md).

## Where are current prices and support?

[Pricing and beta terms](https://warguardian.app/pricing) · [Discord support](https://discord.gg/uw8HStQBAq) · [Legal and policies](https://warguardian.app/legal)

## How does community ban sharing work?

WarGuardian supports private community-list workflows for participating communities. Owners choose what to share and which servers are involved. Staff should review a source decision and its evidence in context; another community's ban is not automatically a finding that the same rule was violated elsewhere.

The proposed expanded shared-intelligence subscription is a separate future service. Publishing that plan does not make existing private records public or introduce a new charge for existing list sharing. [Shared-intelligence proposal](shared-intelligence.md).

## What is the difference between RCON and the kill feed?

RCON provides the game's supported remote administration interface. It supplies current server/player information and supported management commands. A configured event feed supplies combat records used for feed-based history and player evidence review.

Check source availability before assuming that a connected server has complete combat history. Missing events cannot be recovered by treating an empty statistic as proof that nothing happened.

## Can WarGuardian run several servers?

Yes. Communities can administer multiple supported WARDOGS servers with access scoped to the relevant communities and servers. Server allowances and beta terms depend on the current plan. Planned support for other games is not yet public mixed-game availability.

## Can I self-host WarGuardian?

Not through a public distribution today. A self-hosted edition is being planned, with local management separated from optional shared-intelligence services. Package availability, license terms and release dates have not been announced. [Self-hosting direction](self-hosting.md).

## Is WarGuardian open source?

The application is proprietary today, and this is its public documentation repository. If WarGuardian permanently ceases operation, its existing policy commits to releasing all WarGuardian-owned code and models, including scoring rules, model files and training/evaluation code, under open-source licenses. Private data, credentials and nonredistributable third-party material are excluded. [Full continuity commitment](service-continuity.md).

## How should I compare WARDOGS RCON tools?

List the tasks your staff actually performs: connecting servers, assigning moderators, reviewing reports, coordinating bans, changing rotations and running announcements. Verify each tool's current WARDOGS support, event requirements, hosting responsibilities and price.

WarGuardian's current offer is hosted administration with community permissions, ban workflows and evidence review. The proposed self-hosted edition should be evaluated as a future option until it is released. [Current WARDOGS guide](https://warguardian.app/wardogs-rcon).
