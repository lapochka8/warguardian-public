#!/usr/bin/env bash
# Installs the WarGuardian Agent on a Linux host with systemd, or adds one
# more server to an agent that is already installed.
#
#   curl -fsSL https://github.com/lapochka8/warguardian-public/releases/download/agent-v<version>/install.sh |
#     sudo bash -s -- --panel https://warguardian.app
#
# The installer asks for the setup code in the terminal. --code-file FILE
# reads it from a file that only its owner can read instead. Run the same
# command with a new code to add another server. When several servers of one
# game run here, add --instance ID with an ID that the installer lists.
#
# The installer downloads SHA256SUMS, SHA256SUMS.sig and the Agent for this
# processor from the same release. It checks the Ed25519 signature of
# SHA256SUMS with the release key below, then the SHA-256 of the Agent,
# before it changes anything on this host.
#
# Root owns the program in /opt/warguardian-agent. The service runs and
# updates itself in /opt/warguardian-agent/service, which its account owns.
# The installer runs nothing from that tree as root and writes there only as
# the service account.
#
# The release build sets WARGUARDIAN_AGENT_VERSION. A WarGuardian panel that
# serves this file may set WARGUARDIAN_PANEL and, per processor,
# "<sha256> <url>". The release checksum must then equal that SHA-256 as
# well. The address in the value is not used.
set -euo pipefail
export LC_ALL=C

WARGUARDIAN_PANEL=''
WARGUARDIAN_AGENT_VERSION=''
WARGUARDIAN_AGENT_LINUX_X64=''
WARGUARDIAN_AGENT_LINUX_ARM64=''

# The public half of the release signing key: base64 of the DER
# SubjectPublicKeyInfo of an Ed25519 key, as between the PEM armor lines.
release_public_key='MCowBQYDK2VwAyEASxV/q9z24JuH6rZguwiw8PNFVk70idTMxFfI6TEpMlE='
release_repository=https://github.com/lapochka8/warguardian-public
default_panel=https://warguardian.app

agent_user=warguardian-agent
install_root=/opt/warguardian-agent
state_dir=/var/lib/warguardian-agent
config_dir=/etc/warguardian
config_file=$config_dir/agent.json
unit_name=warguardian-agent.service
unit_file=/etc/systemd/system/$unit_name
bin_link=/usr/local/bin/warguardian-agent
systemd_runtime=/run/systemd/system
service_root=$install_root/service
blocked_file=$install_root/blocked-versions
# A version that failed its health check here is held back for a day, as
# the agent's own self-update holds it back.
block_seconds=86400
version_pattern='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
code_pattern='^WG-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$'

fail() {
  printf 'warguardian-agent install: %s\n' "$1" >&2
  exit "${2:-1}"
}

usage='Usage: install.sh [WG-XXXXX-XXXXX] [--instance ID] [--panel URL] [--code-file FILE] [--allow-blocked]'
code=''
if [ "$#" -gt 0 ] && [[ $1 != --* ]]; then
  code=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')
  shift
fi
instance=''
code_file=''
allow_blocked=0
panel=${WARGUARDIAN_PANEL:-$default_panel}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --instance)
      if [ "$#" -lt 2 ] || ! [[ $2 =~ ^[a-z0-9-]{1,64}$ ]]; then
        fail "$usage" 2
      fi
      instance=$2
      shift 2
      ;;
    --panel)
      if [ "$#" -lt 2 ]; then
        fail "$usage" 2
      fi
      panel=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
      shift 2
      ;;
    --code-file)
      if [ "$#" -lt 2 ] || [ -z "$2" ] || [ -n "$code" ]; then
        fail "$usage" 2
      fi
      code_file=$2
      shift 2
      ;;
    --allow-blocked)
      allow_blocked=1
      shift
      ;;
    *)
      fail "$usage" 2
      ;;
  esac
done
if [ -n "$code" ] && ! [[ $code =~ $code_pattern ]]; then
  fail 'The code must look like WG-XXXXX-XXXXX.' 2
fi
# An HTTPS origin, or plain HTTP to a panel on this host.
panel=${panel%/}
if ! [[ $panel =~ ^https://[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$ ]] &&
  ! [[ $panel =~ ^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?$ ]]; then
  fail 'The WarGuardian address must be an https:// origin, such as https://warguardian.app.' 2
fi
WARGUARDIAN_PANEL=$panel

if [ -z "$WARGUARDIAN_AGENT_VERSION" ]; then
  fail 'No WarGuardian Agent release is available.'
fi
if ! [[ $WARGUARDIAN_AGENT_VERSION =~ $version_pattern ]]; then
  fail 'The release version is invalid.'
fi
if ! [[ $release_public_key =~ ^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$ ]]; then
  fail 'This installer has no release key. Download install.sh from a WarGuardian Agent release.'
fi

if [ "$(id -u)" -ne 0 ]; then
  fail 'Run the installer as root, for example with sudo.'
fi
for tool in curl sha256sum install useradd runuser setsid realpath stat; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    fail "Install $tool first."
  fi
done
# OpenSSL 3 checks Ed25519 signatures with pkeyutl -rawin. LibreSSL and
# OpenSSL 1.1 cannot, so the installer stops instead of skipping the check.
openssl_version=$(openssl version 2>/dev/null || true)
if ! [[ $openssl_version =~ ^OpenSSL\ ([3-9]|[1-9][0-9]+)\. ]]; then
  fail 'Install OpenSSL 3 to check the release signature, then run the installer again.'
fi

# The setup code comes from a file that only its owner can read, or from the
# terminal. It reaches the agent on stdin and stays out of every command line.
if [ -n "$code_file" ]; then
  if [ -L "$code_file" ] || [ ! -f "$code_file" ] ||
    ! [[ $(stat -c %a -- "$code_file") =~ ^[46]00$ ]]; then
    fail 'The code file must be a plain file that only its owner can read.' 2
  fi
  IFS= read -r code <"$code_file" || true
elif [ -z "$code" ]; then
  if ! (: </dev/tty) 2>/dev/null; then
    fail 'Enter the setup code in a terminal, or pass --code-file FILE.' 2
  fi
  printf 'WarGuardian setup code: ' >/dev/tty
  IFS= read -rs code </dev/tty || true
  printf '\n' >/dev/tty
fi
code=$(printf '%s' "$code" | tr -d ' \r\t' | tr '[:lower:]' '[:upper:]')
if ! [[ $code =~ $code_pattern ]]; then
  fail 'The code must look like WG-XXXXX-XXXXX.' 2
fi

machine=$(uname -m)
case "$machine" in
  x86_64 | amd64)
    platform=linux-x64
    expected=$WARGUARDIAN_AGENT_LINUX_X64
    ;;
  aarch64 | arm64)
    platform=linux-arm64
    expected=$WARGUARDIAN_AGENT_LINUX_ARM64
    ;;
  *)
    fail "This processor is not supported: $machine."
    ;;
esac
asset=warguardian-agent-$platform
expected=${expected%% *}
if [ -n "$expected" ] && ! [[ $expected =~ ^[0-9a-f]{64}$ ]]; then
  fail 'The release digest is invalid.'
fi
release_base=$release_repository/releases/download/agent-v$WARGUARDIAN_AGENT_VERSION

work=$(mktemp -d)
runner=''
trap 'rm -rf "$work" ${runner:+"$runner"}' EXIT
download() {
  if ! curl --fail --silent --show-error --location --proto '=https' \
    --proto-redir '=https' --retry 3 --output "$2" "$release_base/$1"; then
    fail "Could not download $1 from WarGuardian Agent $WARGUARDIAN_AGENT_VERSION."
  fi
}
# The SHA-256 that SHA256SUMS lists for one file, or nothing.
listed_digest() {
  sed -n "s/^\([0-9a-f]\{64\}\)  ${1//./\\.}\$/\1/p" "$work/SHA256SUMS"
}

printf 'Downloading WarGuardian Agent %s for %s.\n' "$WARGUARDIAN_AGENT_VERSION" "$platform"
download SHA256SUMS "$work/SHA256SUMS"
download SHA256SUMS.sig "$work/SHA256SUMS.sig"
printf -- '-----BEGIN PUBLIC KEY-----\n%s\n-----END PUBLIC KEY-----\n' \
  "$release_public_key" >"$work/release-key.pem"
if ! openssl pkeyutl -verify -pubin -inkey "$work/release-key.pem" -rawin \
  -in "$work/SHA256SUMS" -sigfile "$work/SHA256SUMS.sig" >/dev/null 2>&1; then
  fail 'The signature of SHA256SUMS does not match the WarGuardian Agent release key.'
fi
# The Windows installer name carries the version, so this SHA256SUMS
# belongs to this release and not to an earlier one.
if [ -z "$(listed_digest "WarGuardianAgentSetup-$WARGUARDIAN_AGENT_VERSION.exe")" ]; then
  fail "SHA256SUMS does not belong to WarGuardian Agent $WARGUARDIAN_AGENT_VERSION."
fi
digest=$(listed_digest "$asset")
if ! [[ $digest =~ ^[0-9a-f]{64}$ ]]; then
  fail "SHA256SUMS does not list $asset."
fi
if [ -n "$expected" ] && [ "$expected" != "$digest" ]; then
  fail 'The release does not match the SHA-256 that WarGuardian expects.'
fi
download "$asset" "$work/warguardian-agent"
actual=$(sha256sum "$work/warguardian-agent" | cut -d ' ' -f 1)
if [ "$actual" != "$digest" ]; then
  fail 'The download does not match its SHA-256 digest in SHA256SUMS.'
fi
printf 'Checked the signature and SHA-256 of WarGuardian Agent %s.\n' "$WARGUARDIAN_AGENT_VERSION"

if [ ! -d "$systemd_runtime" ] || ! command -v systemctl >/dev/null 2>&1; then
  fail 'The WarGuardian Agent needs systemd.'
fi
# Earlier releases let the service account own the program tree. After
# setup succeeds, that tree becomes the service tree.
earlier_tree=0
if [ -e "$install_root" ] || [ -L "$install_root" ]; then
  if [ -L "$install_root" ] || [ ! -d "$install_root" ]; then
    fail "$install_root must be a folder."
  fi
  if [ "$(stat -c %u -- "$install_root")" != 0 ]; then
    earlier_tree=1
  fi
fi
if [ "$earlier_tree" -eq 0 ] && [ -L "$service_root" ]; then
  fail "$service_root must be a folder."
fi

if ! id -u "$agent_user" >/dev/null 2>&1; then
  shell=$(command -v nologin || printf '/bin/false')
  useradd --system --user-group --home-dir "$state_dir" --no-create-home \
    --shell "$shell" "$agent_user"
fi

# Commands of the service account run in a new session, so they have no
# terminal of root's to type into.
as_agent() {
  setsid --wait runuser -u "$agent_user" -- "$@"
}
# Their messages are shown without control characters.
show_errors() {
  tr -d '\000-\010\013-\037\177' <"$1" >&2
}

# The version the service runs now, if any. `current` changes only after
# setup succeeds.
if [ "$earlier_tree" -eq 1 ]; then
  running_tree=$install_root
else
  running_tree=$service_root
fi
running=''
if [ -L "$running_tree/current" ]; then
  running=$(basename -- "$(readlink -- "$running_tree/current")")
  if ! [[ $running =~ $version_pattern ]] ||
    [ ! -f "$running_tree/versions/$running/warguardian-agent" ]; then
    running=''
  fi
fi

# Versions that failed their health check here. Root keeps the list, with the
# time it first saw each version. The self-update reports failures in its
# state file, which its account can change, so the file is read as that
# account and a reported version is held back for a day at most.
now=$(date +%s)
declare -A first_seen=()
if [ "$earlier_tree" -eq 0 ] && [ -f "$blocked_file" ] && [ ! -L "$blocked_file" ] &&
  [ "$(stat -c %u -- "$blocked_file")" = 0 ]; then
  while read -r listed seen; do
    if [[ $listed =~ $version_pattern ]] && [[ $seen =~ ^[0-9]{1,12}$ ]]; then
      first_seen[$listed]=$seen
    fi
  done <"$blocked_file"
fi
reported=$(as_agent head -c 65536 -- "$state_dir/update.json" </dev/null 2>/dev/null |
  sed -n 's/.*"blocked":\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | tr -d '" ' || true)
for listed in $reported; do
  if [[ $listed =~ $version_pattern ]] && [ -z "${first_seen[$listed]+set}" ]; then
    first_seen[$listed]=$now
  fi
done
switch_version=1
if [ -n "$running" ] && [ "$running" != "$WARGUARDIAN_AGENT_VERSION" ]; then
  seen=${first_seen[$WARGUARDIAN_AGENT_VERSION]:-}
  if [ -n "$seen" ] && [ $((seen + block_seconds)) -gt "$now" ] && [ "$allow_blocked" -eq 0 ]; then
    switch_version=0
    printf 'Version %s failed its health check on this host. %s stays in place. Run again with --allow-blocked to install it.\n' \
      "$WARGUARDIAN_AGENT_VERSION" "$running"
  elif [ "$(printf '%s\n%s\n' "$running" "$WARGUARDIAN_AGENT_VERSION" | sort -V | tail -n 1)" = "$running" ]; then
    switch_version=0
    printf 'Version %s is newer than %s and stays in place.\n' \
      "$running" "$WARGUARDIAN_AGENT_VERSION"
  fi
fi
if [ "$switch_version" -eq 1 ]; then
  active_version=$WARGUARDIAN_AGENT_VERSION
else
  active_version=$running
fi

umask 077
install -d -m 0700 -o "$agent_user" -g "$agent_user" "$state_dir"
install -d -m 0755 "$config_dir"

# Root's verified copy, in a folder only root can change. Discovery runs it
# as root, so it can read the game processes. Setup runs it as the service
# account, which may run it but not change it.
if [ ! -d "$(dirname -- "$install_root")" ]; then
  install -d -m 0755 "$(dirname -- "$install_root")"
fi
runner=$(mktemp -d "$(dirname -- "$install_root")/.warguardian-agent-setup.XXXXXX")
chmod 0711 "$runner"
install -m 0755 "$work/warguardian-agent" "$runner/warguardian-agent"
if [ "$switch_version" -eq 1 ]; then
  setup_binary=$runner/warguardian-agent
else
  setup_binary=$running_tree/versions/$running/warguardian-agent
fi

# Only the game and its ports go to WarGuardian. The RCON files discovery
# found follow, one `<server ID> <process ID> <file>` line each.
rcon_files=$work/rcon-files
discovered=1
if ! "$runner/warguardian-agent" discover --output "$work/discovery.json" >"$rcon_files"; then
  discovered=0
  : >"$rcon_files"
  printf 'Server discovery failed. Setup continues without it.\n' >&2
fi

# Setup works on copies in root's work folder. The service account reads the
# discovery and writes the configuration in its own folder there, and root
# reads the result back as that account.
chmod 0711 "$work"
found=$work/found
stage=$work/setup
install -d -m 0750 -o root -g "$agent_user" "$found"
install -d -m 0700 -o "$agent_user" -g "$agent_user" "$stage"
if [ "$discovered" -eq 1 ]; then
  install -m 0640 -o root -g "$agent_user" "$work/discovery.json" "$found/discovery.json"
fi
# A new server is added to the existing configuration. A server that is set
# up again keeps its place.
if [ -f "$config_file" ]; then
  as_agent /bin/sh -c 'umask 077; cat >"$1"' sh "$stage/agent.json" <"$config_file"
else
  printf '{"panel":"%s"}\n' "$WARGUARDIAN_PANEL" |
    as_agent /bin/sh -c 'umask 077; cat >"$1"' sh "$stage/agent.json"
fi
setup=(enroll --code-stdin --config "$stage/agent.json" --panel "$WARGUARDIAN_PANEL" --json)
if [ "$discovered" -eq 1 ]; then
  setup+=(--discovered "$found/discovery.json")
fi
if [ -n "$instance" ]; then
  setup+=(--instance "$instance")
fi
if ! outcome=$(printf '%s\n' "$code" | as_agent "$setup_binary" "${setup[@]}" 2>"$work/setup-errors"); then
  show_errors "$work/setup-errors"
  fail 'Setup did not finish. Create a new code in WarGuardian and run the installer again.'
fi
show_errors "$work/setup-errors"

# The setup answer is one line of JSON with fixed field names.
field() {
  printf '%s' "$outcome" | sed -n "s/.*\"$1\":\\([^,}]*\\).*/\\1/p" | tr -d '"'
}
server_id=$(field serverId)
profile=$(field profile)
service_servers=$(field serviceServers)
chosen=$(field instance)
missing=$(printf '%s' "$outcome" | sed -n 's/.*"missing":\[\([^]]*\)\].*/\1/p' | tr -d '"' | sed 's/,/, /g')
if ! [[ $server_id =~ ^[a-z0-9-]{1,32}$ ]] || ! [[ $service_servers =~ ^[0-9]{1,3}$ ]] ||
  ! [[ $chosen =~ ^[a-z0-9-]{0,64}$ ]]; then
  fail 'The agent sent an unreadable setup answer.'
fi
as_agent head -c 1048576 -- "$stage/agent.json" </dev/null >"$work/agent.json"
if [ ! -s "$work/agent.json" ]; then
  fail 'Setup wrote no configuration. Create a new code in WarGuardian and run the installer again.'
fi

# Setup succeeded, so the host changes from here.
if [ "$earlier_tree" -eq 1 ]; then
  previous=$(mktemp -d "$(dirname -- "$install_root")/.warguardian-agent-previous.XXXXXX")
  mv -T -- "$install_root" "$previous/tree"
  install -d -m 0755 -o root -g root "$install_root"
  mv -T -- "$previous/tree" "$service_root"
  rmdir -- "$previous"
fi
install -d -m 0755 -o root -g root "$install_root" "$install_root/versions"
if [ ! -d "$service_root" ]; then
  install -d -m 0755 -o "$agent_user" -g "$agent_user" "$service_root"
fi
if [ "$switch_version" -eq 1 ]; then
  version_dir=$install_root/versions/$WARGUARDIAN_AGENT_VERSION
  install -d -m 0755 -o root -g root "$version_dir"
  install -m 0755 -o root -g root "$work/warguardian-agent" "$version_dir/warguardian-agent"
  ln -sfn "versions/$WARGUARDIAN_AGENT_VERSION" "$install_root/.current.new"
  mv -Tf "$install_root/.current.new" "$install_root/current"
  # The service tree gets its own copy, written by the service account.
  as_agent /bin/sh -c '
    set -e
    umask 022
    mkdir -p -- "$1/versions/$2"
    cat >"$1/versions/$2/.warguardian-agent.new"
    chmod 0755 -- "$1/versions/$2/.warguardian-agent.new"
    mv -f -- "$1/versions/$2/.warguardian-agent.new" "$1/versions/$2/warguardian-agent"
    ln -sfn -- "versions/$2" "$1/.current.new"
    mv -Tf -- "$1/.current.new" "$1/current"
  ' sh "$service_root" "$WARGUARDIAN_AGENT_VERSION" <"$version_dir/warguardian-agent"
fi
ln -sfn "$install_root/current/warguardian-agent" "$bin_link"
install -m 0640 -o root -g "$agent_user" "$work/agent.json" "$config_dir/.agent.json.new"
mv -f "$config_dir/.agent.json.new" "$config_file"
if [ "${#first_seen[@]}" -gt 0 ]; then
  for listed in "${!first_seen[@]}"; do
    printf '%s %s\n' "$listed" "${first_seen[$listed]}"
  done | sort >"$work/blocked-versions"
  install -m 0644 -o root -g root "$work/blocked-versions" "$blocked_file"
fi
rm -rf "$runner"
runner=''

# The service account may read exactly the BattlEye RCON file of the server
# set up now. The file must belong to the game process that discovery found:
# owned by that process's user, with no link on the way. Discovery took it
# from that process's -bepath, its -profiles folder or the folder of its
# executable. Folders, other files and other servers keep their permissions.
can_read() {
  as_agent test -r "$1" </dev/null
}
needs_access=()
while IFS=' ' read -r server pid file; do
  if [ -z "$chosen" ] || [ "$server" != "$chosen" ] || [ -z "$file" ]; then
    continue
  fi
  case "$(basename -- "$file" | tr '[:upper:]' '[:lower:]')" in
    beserver_x64*.cfg) ;;
    *)
      needs_access+=("$file (not a BattlEye RCON file, left unchanged)")
      continue
      ;;
  esac
  if [ -L "$file" ] || [ ! -f "$file" ] || [ "$(stat -c %h -- "$file")" -ne 1 ] ||
    [ "$(realpath -e -- "$file" 2>/dev/null || true)" != "$file" ]; then
    needs_access+=("$file (not a plain file, left unchanged)")
    continue
  fi
  game=''
  if [[ $pid =~ ^[1-9][0-9]{0,9}$ ]]; then
    game=$(readlink -e -- "/proc/$pid/exe" 2>/dev/null || true)
  fi
  if [ -z "$game" ]; then
    needs_access+=("$file (the game process has stopped, left unchanged)")
    continue
  fi
  if [ "$(stat -c %u -- "$file")" != "$(stat -c %u -- "/proc/$pid")" ]; then
    needs_access+=("$file (not owned by the account of the game process, left unchanged)")
    continue
  fi
  if ! can_read "$file" && command -v setfacl >/dev/null 2>&1; then
    printf 'Granting %s read access to %s.\n' "$agent_user" "$file"
    setfacl -m "u:$agent_user:r" -- "$file" 2>/dev/null || true
  fi
  if ! can_read "$file"; then
    needs_access+=("$file and search access to its folders")
  fi
  # BattlEye renames its file while the server runs, so the agent lists the folder.
  folder=$(dirname -- "$file")
  if ! as_agent test -r "$folder" -a -x "$folder" </dev/null; then
    needs_access+=("$folder (folder listing)")
  fi
done <"$rcon_files"

printf 'Set up %s (%s).\n' "$server_id" "$profile"
if [ -n "$missing" ]; then
  printf 'Add %s for %s in %s.\n' "$missing" "$server_id" "$config_file"
fi
for item in ${needs_access[@]+"${needs_access[@]}"}; do
  printf 'Give %s read access to %s.\n' "$agent_user" "$item"
done
if [ "$profile" = arma-reforger ]; then
  printf 'Arma Reforger servers run in reforger-host-connector@.service, not in %s. See the WarGuardian Agent README.\n' "$unit_name"
fi

cat >"$unit_file.new" <<'UNIT'
[Unit]
Description=WarGuardian Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=warguardian-agent
Group=warguardian-agent
# Arma Reforger servers run in reforger-host-connector@.service instead.
ExecStart=/opt/warguardian-agent/service/current/warguardian-agent run --config /etc/warguardian/agent.json --skip-profile arma-reforger
# The agent exits after installing an update. systemd starts the new version.
Restart=always
RestartSec=10
# 78: no server is configured for this service. It stays stopped.
RestartPreventExitStatus=78
TimeoutStopSec=30
# The agent updates itself in its own tree. The configuration stays
# read-only. Enrollment rewrites it outside the service.
ReadWritePaths=/opt/warguardian-agent/service
StateDirectory=warguardian-agent
StateDirectoryMode=0700
UMask=0077
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$unit_file.new"
mv -f "$unit_file.new" "$unit_file"

systemctl daemon-reload
if [ "$service_servers" -eq 0 ]; then
  printf 'WarGuardian Agent %s is installed. No server runs in %s yet.\n' "$active_version" "$unit_name"
  exit 0
fi
systemctl enable "$unit_name" >/dev/null
systemctl restart "$unit_name"
sleep 2
if ! systemctl is-active --quiet "$unit_name"; then
  fail "The service did not start. Check: journalctl -u $unit_name"
fi
printf 'WarGuardian Agent %s is running for %s server(s).\n' "$active_version" "$service_servers"
