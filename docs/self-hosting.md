# WarGuardian self-hosting direction

**Status: planning.** WarGuardian is currently a hosted service. There is no public self-hosting package, supported installation procedure or application license available in this repository. Do not treat this page as a download announcement.

## Intended split

The proposed self-hostable application would let a community operate its own game server administration panel. Optional WarGuardian-operated services would add shared player intelligence and community ban data from participating sources.

| Area | Proposed responsibility |
| --- | --- |
| Local RCON administration | Community-operated application connects to its own supported game servers |
| Staff roles and local moderation | Managed by the community for its own servers |
| Local records and export | Community retains access to its own records |
| Shared intelligence | Optional connected subscription with its own availability and usage terms |
| Installation, updates and backups | Self-hosting operator manages its environment |
| Hosted service | WarGuardian operates the panel for communities choosing managed hosting |

This is a design direction. It does not certify that every hosted feature already works without WarGuardian's services.

## Core use should remain useful

Our intended model keeps local server controls, local ban records and access to a community's own information useful without an intelligence subscription. A community should choose connected intelligence for the additional information and ongoing service it provides, rather than to unlock records it already created.

The public release needs a clear feature matrix showing what runs locally, what requires an external service and how disconnected operation behaves. It also needs usable installation, upgrade, backup/restore and export instructions before it can be described as supported self-hosting.

## Pricing and licensing

Self-hosting license terms and any fees remain undecided. Operating your own application still incurs your hosting and maintenance costs. Optional shared-intelligence access would be a separate service from running local software.

An open-source license permits rights beyond simply viewing source code. We will identify the actual license before describing a release as open source. This planning page grants no current right to use unpublished application code.

## Relationship to service continuity

Self-hosting during normal operation and a release after permanent shutdown are separate matters. The existing [continuity commitment](service-continuity.md) still covers all WarGuardian-owned code and models if WarGuardian permanently ceases operation. The self-hosting plan does not reduce that scope.

## Feedback

Tell us which games you run, how many servers you manage and which workflows must work without a central connection. Use a [feature suggestion](https://github.com/lapochka8/warguardian-public/issues/new/choose) for general requirements or [Discord support](https://discord.gg/uw8HStQBAq) for private deployment questions. Do not upload private configurations or credentials.
