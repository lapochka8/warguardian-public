# WarGuardian Agent

The WarGuardian Agent connects game servers on your host to
[WarGuardian](https://warguardian.app). It runs beside the game, keeps the
RCON session on this host and polls WarGuardian over HTTPS. It opens no
inbound port.

The Agent is source available under the PolyForm Shield License 1.0.0 in
[LICENSE](LICENSE). You may use and change it to run your own servers with
WarGuardian, but not in a competing product.

## Supported games

| Game          | Profile         | Hosts          |
| ------------- | --------------- | -------------- |
| WARDOGS       | `wardogs`       | Linux, Windows |
| Arma Reforger | `arma-reforger` | Linux          |
| Arma 3, DayZ  | `battleye`      | Linux, Windows |

## What the Agent does

- Finds running game servers and their RCON ports. It sends WarGuardian the
  game and its ports, never the password or local paths.
- Uses a BattlEye file only from the `-bepath` or `-profiles` folder of the
  server process, or from its game folder. The file must belong to the
  account that runs the game, and no link may lead to it. Setup prints the
  folder it chose.
- Reads the RCON password from the game configuration on every login. The
  password never leaves the host.
- Runs only the operations WarGuardian defines: reading players and bans,
  kicking, messaging, banning and unbanning. It builds every command line
  itself.
- Checks the target player and sends the command in the same RCON login.
- Authenticates every request with the server secret and checks every
  response.
- Installs a new version only when the manifest that WarGuardian signs and
  the `SHA256SUMS` of the release, signed with the release key, both name
  the SHA-256 of the download. A version that does not reach WarGuardian
  within two minutes is replaced by the previous one. A release that
  failed its health check on this host is held back for a day, by the Agent
  and by the installer. The Agent tries a new build of that release sooner.

## What the Agent does not do

- It accepts no raw RCON command and never sends `#shutdown`.
- It opens no listening port and forwards no other traffic.
- It sends no file, log or password to WarGuardian. From Arma 3 and DayZ
  server logs (`.rpt`) it sends only the name and Steam ID of each joining
  player.
- It does not change game configuration, except through the Arma Reforger
  host tools that you use in WarGuardian.
- The installer changes no folder permissions and no file other than the
  RCON files of the servers that you set up.

## Install on Linux

1. Open the server in WarGuardian and choose **Set up the WarGuardian Agent**.
2. Copy the command from the setup card and run it on the game host:

   ```sh
   curl -fsSL https://github.com/lapochka8/warguardian-public/releases/download/agent-v<version>/install.sh |
     sudo bash -s -- --panel https://warguardian.app
   ```

3. Enter the setup code from the card when the installer asks for it.
4. Wait for **Connected** on the setup card.

The code expires after 15 minutes and works once. The installer reads it
from the terminal, so it does not appear in the process list. For an
unattended install, write the code to a file that only root can read and
pass `--code-file FILE`. `--panel` names your WarGuardian address. It
defaults to `https://warguardian.app`.

The installer needs systemd, OpenSSL 3 and an x64 or arm64 processor. Before
it changes anything on the host, it downloads `SHA256SUMS`, `SHA256SUMS.sig`
and the Agent from the same release. It then checks:

1. the Ed25519 signature of `SHA256SUMS` with the release key in
   `install.sh`;
2. that `SHA256SUMS` belongs to this version;
3. the SHA-256 of the Agent.

It stops at the first check that fails. Then it creates the
`warguardian-agent` account and connects the host with the code.

Root owns the program in `/opt/warguardian-agent`. The service runs and
updates itself in `/opt/warguardian-agent/service`, which the
`warguardian-agent` account owns. The installer never runs a file from that
folder as root. It runs setup as the account, in a session without your
terminal.

The installer looks for running game servers as root and lists each one
with its ID. The `warguardian-agent` account then gets read access to
exactly the RCON file of the server that the code sets up, with `setfacl`:

- Arma 3 and DayZ: `BEServer_x64*.cfg` in the BattlEye folder.

The installer grants access only when the file belongs to the game: owned
by the account that runs the game server, with no link on the way. It prints
the path it grants. Folders and other files keep their permissions. When
`setfacl` is missing, the file does not pass these checks, or a folder on the
way is closed to the account, the installer names each file or folder that
needs a change. BattlEye renames its file while the server runs, so the
account must also be able to list the BattlEye folder.

## Install on Windows

1. Download `WarGuardianAgentSetup-<version>.exe` from the
   [releases](https://github.com/lapochka8/warguardian-public/releases).
2. Check it as shown in [Verify a download](#verify-a-download).
3. Run it as an administrator.
4. Enter the WarGuardian address and the setup code.
5. Wait for **Connected** on the setup card.

The installer puts the Agent in `C:\Program Files\WarGuardian Agent` and its
settings in `C:\ProgramData\WarGuardian`. The **WarGuardian Agent** service
runs as the virtual account `NT SERVICE\WarGuardianAgent`. That account may:

- read the settings and write the Agent's state and logs;
- install updates in its `versions` folder;
- read the RCON files of the servers set up on this host, and list their
  BattlEye folders.

Administrators and SYSTEM keep full control of both folders. Setup stops
when `C:\ProgramData\WarGuardian` already exists and another account owns
it. Remove that folder and run setup again.

For an unattended install, pass the code and address:

```bat
WarGuardianAgentSetup-<version>.exe /VERYSILENT /CODE=WG-XXXXX-XXXXX /PANEL=https://warguardian.app
```

## Add another server on the same host

Create a new code for that server in WarGuardian and run the same command
again. Enter the new code when the installer asks for it.

The installer adds the server to `/etc/warguardian/agent.json` and keeps the
servers that are already set up. One `warguardian-agent` service runs them
all. If several servers of the same game run on the host, the next code takes
a server that no other binding uses. To choose one, add `--instance` with an
ID that the installer listed:

```sh
curl -fsSL https://github.com/lapochka8/warguardian-public/releases/download/agent-v<version>/install.sh |
  sudo bash -s -- --panel https://warguardian.app --instance dayz-0123456789
```

The running version changes only after setup succeeds. A release older than
the running one is not installed. To install a release that is held back
after a failed health check, add `--allow-blocked`.

On Windows, run the installer again with the new code.

## Arma Reforger hosts

An Arma Reforger server manages its game files as the account that owns the
installation, so it does not run in the hardened `warguardian-agent`
service. That service skips Arma Reforger servers. Keep
`reforger-host-connector@.service` for each Reforger server and point its
`ExecStart` at the new executable:

```ini
ExecStart=/opt/warguardian-agent/current/warguardian-agent run
```

Its environment file keeps working unchanged. The installer reports an Arma
Reforger code and leaves the shared service stopped when it has no other
server.

## Files

| Item     | Linux                             | Windows                                 |
| -------- | --------------------------------- | --------------------------------------- |
| Program  | `/opt/warguardian-agent`          | `C:\Program Files\WarGuardian Agent`    |
| Settings | `/etc/warguardian/agent.json`     | `C:\ProgramData\WarGuardian\agent.json` |
| State    | `/var/lib/warguardian-agent`      | `C:\ProgramData\WarGuardian\state`      |
| Logs     | `journalctl -u warguardian-agent` | `C:\ProgramData\WarGuardian\logs`       |

## Commands

| Command                                   | Use                                              |
| ----------------------------------------- | ------------------------------------------------ |
| `warguardian-agent run`                   | Run the servers set up on this host.             |
| `warguardian-agent enroll --code-stdin`   | Set up a server with a one-time code on stdin.   |
| `warguardian-agent enroll WG-XXXXX-XXXXX` | Set up a server with a code on the command line. |
| `warguardian-agent discover`              | List the game servers the Agent finds.           |
| `warguardian-agent access`                | List the RCON files the Agent reads.             |
| `warguardian-agent version`               | Show the version.                                |

The Agent does not run as root or as an administrator. Only `version`,
`help` and the steps its installers run are allowed there.

## Upgrade from the first Agent

The first WARDOGS Agent and the Arma Reforger host agent read environment
files. This Agent reads the same variables. Point the existing service at
`warguardian-agent run` and keep its environment file. To run several
environment files in one service, pass `--env-file` for each one.

## Uninstall

On Linux, the second command removes the read access that the installer
gave to the RCON files. Run it before you delete the settings.

```sh
sudo systemctl disable --now warguardian-agent
sudo grep -o '"battleyeConfig": "[^"]*"' /etc/warguardian/agent.json | cut -d '"' -f 4 |
  while IFS= read -r folder; do sudo find "$folder" -maxdepth 1 -iname 'beserver*.cfg' -exec setfacl -x u:warguardian-agent {} +; done
sudo rm /etc/systemd/system/warguardian-agent.service /usr/local/bin/warguardian-agent
sudo systemctl daemon-reload
sudo rm -rf /opt/warguardian-agent /etc/warguardian/agent.json /var/lib/warguardian-agent
sudo userdel warguardian-agent
```

On Windows, open **Settings** > **Apps** and uninstall **WarGuardian Agent**.
This removes the service, its RCON file access, the program and
`C:\ProgramData\WarGuardian`.

Remove the server's Agent connection in WarGuardian as well, so its secret
stops working.

## Verify a download

Each release lists `SHA256SUMS`, the SHA-256 of every file, and
`SHA256SUMS.sig`, its Ed25519 signature. The release key is the
`release_public_key` line of `install.sh` in this repository.

On Linux, with OpenSSL 3, in the folder with the downloaded files:

```sh
sed -n "s/^release_public_key='\(.*\)'$/\1/p" install.sh |
  { printf -- '-----BEGIN PUBLIC KEY-----\n'; cat; printf -- '-----END PUBLIC KEY-----\n'; } >release.pub
openssl pkeyutl -verify -pubin -inkey release.pub -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig
sha256sum --check --ignore-missing SHA256SUMS
```

Take `install.sh` from this repository, not from the release you are
checking.

On Windows, in PowerShell, compare the SHA-256 with its line in
`SHA256SUMS`, and check the Authenticode signature:

```powershell
(Get-FileHash .\WarGuardianAgentSetup-<version>.exe -Algorithm SHA256).Hash.ToLower()
Get-AuthenticodeSignature .\WarGuardianAgentSetup-<version>.exe
```

The release notes say when a release is unsigned or its Windows files carry
no Authenticode signature.

## How releases are built

GitHub Actions builds every release from a tag `agent-v<version>` in this
repository, with [agent-release.yml](.github/workflows/agent-release.yml):

1. The tests and the type check run first. The tag must match the version in
   `package.json`.
2. Node.js 24.22.1 from nodejs.org, checked against its pinned SHA-256, becomes
   the runtime of each executable. Linux x64 and arm64 build on their own
   runners, and Windows x64 on a Windows runner.
3. The Windows installer is built with a pinned Inno Setup and WinSW 2.12.0,
   each checked against its SHA-256.
4. When Azure Trusted Signing is set up, both Windows files get an
   Authenticode signature.
5. `SHA256SUMS` lists every file, and the release key signs it.

Every action is pinned to a commit. The release files are:

| File                                  | Use                               |
| ------------------------------------- | --------------------------------- |
| `warguardian-agent-linux-x64`         | Agent for Linux on x64            |
| `warguardian-agent-linux-arm64`       | Agent for Linux on arm64          |
| `warguardian-agent-win-x64.exe`       | Agent for Windows on x64          |
| `WarGuardianAgentSetup-<version>.exe` | Windows installer                 |
| `install.sh`                          | Linux installer                   |
| `SHA256SUMS`                          | SHA-256 of each file              |
| `SHA256SUMS.sig`                      | Ed25519 signature of `SHA256SUMS` |

## Build from source

Node.js 24.22.1 and npm are required.

```sh
npm ci
npm test
node build/build-agent.mjs --target linux-x64 --no-installer
```

The build writes the executables and `artifacts.json` with a SHA-256 per
file. It pins the `release_public_key` of `install.sh`. Without that key
and the manifest key of WarGuardian, a build cannot update itself.

| Folder     | Contents                                               |
| ---------- | ------------------------------------------------------ |
| `src`      | The Agent                                              |
| `protocol` | The contract between the Agent and WarGuardian         |
| `vendor`   | Arma Reforger host tools and their shared rules        |
| `build`    | The build and the release files                        |
| `deploy`   | The systemd unit, the Inno Setup script and WinSW file |
| `test`     | Tests that run with `npm test`                         |

## Security

To report a security problem, see [SECURITY.md](SECURITY.md).
