# Security

## Report a vulnerability

Report security problems in the WarGuardian Agent privately through GitHub:
open [Report a vulnerability](https://github.com/lapochka8/warguardian-public/security/advisories/new)
on the **Security** tab of this repository.

Do not open a public issue or pull request for a vulnerability.

Include:

- the Agent version (`warguardian-agent version`) and the operating system;
- the steps that show the problem, and what an attacker gains;
- whether the problem needs access to the game host, the network or
  WarGuardian.

Do not include RCON passwords, Agent secrets or setup codes. Replace them with
made-up values.

## Scope

- The Agent in `src/`, `protocol/` and `vendor/`.
- The Linux installer `install.sh` and the systemd unit.
- The Windows installer and its service configuration.
- The release workflow and the release files: `SHA256SUMS`,
  `SHA256SUMS.sig` and the signatures of the Windows files.

Problems in the WarGuardian website or panel are also welcome through the same
form.

## Supported versions

Security fixes go into the latest release. To install it, run the Linux
command or the Windows installer of that release.
