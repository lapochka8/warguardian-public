import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  checksumsFor,
  publicKeyLine,
  releaseAssetNames,
  stampInstaller,
} from '../build/release.mjs';
import { agentFiles } from './support/agent-files';

// install.sh runs end to end in a sandbox. Its path constants point into the
// sandbox, curl serves a release folder, and the privileged tools (useradd,
// install with an owner, chown, runuser, setsid, setfacl, systemctl) are
// stand-ins that record each call and keep a map of file owners. Tools that
// change files refuse any path outside the sandbox. The release's agent is a
// script that records how it was started.

const source = readFileSync(agentFiles.installer, 'utf8');
const version = '1.2.3';
const base = `https://github.com/lapochka8/warguardian-public/releases/download/agent-v${version}`;
const code = 'WG-7KQ4M-2XDPA';
const agentUid = 999;
const linux = process.platform === 'linux';

function bash(): boolean {
  if (process.platform === 'win32' && !process.env.MSYSTEM) return false;
  const probe = spawnSync('bash', ['-c', 'printf %s "$BASH_VERSION"'], {
    encoding: 'utf8',
  });
  return probe.status === 0 && /^[4-9]/.test(probe.stdout);
}

function openssl3(): boolean {
  const probe = spawnSync('bash', ['-c', 'openssl version'], {
    encoding: 'utf8',
  });
  return probe.status === 0 && /^OpenSSL [3-9]\./.test(probe.stdout);
}

/** Cases that install need symbolic links, so they run on Linux only. */
function ready(context: TestContext, installs = false) {
  if (installs && !linux) {
    context.skip('needs Linux symbolic links and processes');
    return false;
  }
  if (!bash()) {
    context.skip('bash 4 is unavailable');
    return false;
  }
  if (!openssl3()) {
    context.skip('OpenSSL 3 is unavailable');
    return false;
  }
  return true;
}

/** The release's agent: records each start, and answers discover and enroll. */
const fakeAgent = String.raw`#!/usr/bin/env bash
printf '%s\t%s\t%s\n' "${'$'}{WG_AS:-root}" "$0" "$*" >>"$WG_STATE/agent.log"
case "$1" in
  discover)
    cp -- "$WG_STATE/discovery.json" "$3"
    cat -- "$WG_STATE/discovery.lines"
    ;;
  enroll)
    [ ! -f "$WG_STATE/enroll-fails" ] || exit 1
    shift
    config='' code=''
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --config) config=$2; shift 2 ;;
        --panel | --discovered | --instance) shift 2 ;;
        --code-stdin) IFS= read -r code; shift ;;
        --json) shift ;;
        *) code=$1; shift ;;
      esac
    done
    printf '%s\n' "$code" >>"$WG_STATE/codes.log"
    { cat -- "$config"; printf 'enrolled %s\n' "$code"; } >"$config.tmp"
    mv -f -- "$config.tmp" "$config"
    cat -- "$WG_STATE/enroll.json"
    ;;
esac
`;

/** Tools: wrappers for the real ones, recorders for the privileged ones. */
const sandboxSetup = String.raw`
set -eu
bin=$1
for tool in bash env tr mktemp sed grep cut cat sha256sum basename dirname readlink realpath sort tail head date openssl wc awk; do
  path=$(command -v "$tool")
  printf '#!%s\nexec %q "$@"\n' "$BASH" "$path" >"$bin/$tool"
  chmod +x "$bin/$tool"
done
real_stat=$(command -v stat)
common=$(cat <<'COMMON'
record() { printf '%s\t%s\t%s\n' "${'$'}{WG_AS:-root}" "$1" "$(IFS=$'\t'; printf '%s' "${'$'}{*:2}")" >>"$WG_STATE/cmds.log"; }
inside() {
  case "$1" in
    "$WG_SANDBOX" | "$WG_SANDBOX"/* | /dev/null) return 0 ;;
    /*) printf 'outside sandbox: %s\n' "$1" >&2; exit 98 ;;
  esac
}
own() { printf '%s\t%s\n' "$1" "$2" >>"$WG_STATE/owners"; }
uid_of() {
  case "$1" in
    root | 0 | '') echo 0 ;;
    warguardian-agent) echo ${agentUid} ;;
    *) echo "$1" ;;
  esac
}
actor() { if [ "${'$'}{WG_AS:-}" = agent ]; then echo ${agentUid}; else echo 0; fi; }
COMMON
)
stub() {
  { printf '#!%s\n' "$BASH"; printf '%s\n' "$common"; printf '%s\n' "$2"; } >"$bin/$1"
  chmod +x "$bin/$1"
}
for tool in ln mv rm rmdir mkdir chmod cp touch; do
  real=$(command -v "$tool")
  stub "$tool" "record $tool \"\$@\"
for argument in \"\$@\"; do case \"\$argument\" in /*) inside \"\$argument\" ;; esac; done
exec '$real' \"\$@\""
done
stub stat "
if [ \"\$#\" -ge 3 ] && [ \"\$1\" = -c ]; then
  format=\$2 path=\$3
  [ \"\$3\" = -- ] && path=\$4
  for map in owners:%u modes:%a; do
    if [ \"\$format\" = \"\${map#*:}\" ]; then
      found=\$(awk -F '\t' -v p=\"\$path\" '\$1 == p { v = \$2 } END { if (v != \"\") print v }' \"\$WG_STATE/\${map%%:*}\")
      if [ -n \"\$found\" ]; then echo \"\$found\"; exit 0; fi
    fi
  done
fi
exec '$real_stat' \"\$@\""
stub id '
if [ "$#" -eq 1 ] && [ "$1" = -u ]; then echo 0; exit 0; fi
if [ "$#" -eq 2 ] && [ "$1" = -u ] && [ -f "$WG_STATE/user-exists" ]; then echo ${agentUid}; exit 0; fi
exit 1'
stub uname 'echo x86_64'
# The account reads an RCON file once root has granted it access.
real_test=$(type -P test)
stub test "
if [ \"\$#\" -eq 2 ] && [ \"\$1\" = -r ] && [ -f \"\$2\" ] && [ \"\${WG_AS:-}\" = agent ]; then
  awk -F '\t' -v f=\"\$2\" '\$2 == \"setfacl\" && \$NF == f { found = 1 } END { exit !found }' \"\$WG_STATE/cmds.log\"
  exit
fi
exec '$real_test' \"\$@\""
stub sleep 'exit 0'
stub useradd 'record useradd "$@"; : >"$WG_STATE/user-exists"'
stub setfacl 'record setfacl "$@"'
stub systemctl 'record systemctl "$@"'
stub runuser '
record runuser "$@"
[ "$1" = -u ] || exit 64
shift 2
[ "$1" = -- ] && shift
WG_AS=agent exec "$@"'
stub setsid '
record setsid "$@"
[ "$1" = --wait ] && shift
exec "$@"'
stub chown '
record chown "$@"
while [ "$#" -gt 0 ]; do case "$1" in -*) shift ;; *) break ;; esac; done
owner=${'$'}{1%%:*}
shift
for path in "$@"; do inside "$path"; own "$path" "$(uid_of "$owner")"; done'
stub chgrp 'record chgrp "$@"'
stub install '
record install "$@"
directory=0 mode="" owner=""
paths=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d) directory=1; shift ;;
    -m) mode=$2; shift 2 ;;
    -o) owner=$2; shift 2 ;;
    -g) shift 2 ;;
    --) shift ;;
    *) paths+=("$1"); shift ;;
  esac
done
for path in "${'$'}{paths[@]}"; do inside "$path"; done
uid=$(actor)
[ -n "$owner" ] && uid=$(uid_of "$owner")
if [ "$directory" -eq 1 ]; then
  for path in "${'$'}{paths[@]}"; do
    mkdir -p -- "$path"
    [ -z "$mode" ] || chmod "$mode" -- "$path"
    own "$path" "$uid"
  done
else
  target=${'$'}{paths[1]}
  [ ! -d "$target" ] || target=$target/$(basename -- "${'$'}{paths[0]}")
  rm -f -- "$target"
  cp -- "${'$'}{paths[0]}" "$target"
  [ -z "$mode" ] || chmod "$mode" -- "$target"
  own "$target" "$uid"
fi'
stub curl '
output="" url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --proto | --proto-redir | --retry) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf "%s\n" "$url" >>"$WG_STATE/urls.log"
name=${'$'}{url#"$WG_BASE"/}
if [ "$name" = "$url" ] || [ ! -f "$WG_SANDBOX/release/$name" ]; then
  echo "curl: (22) The requested URL returned error: 404" >&2
  exit 22
fi
cat "$WG_SANDBOX/release/$name" >"$output"'
`;

/**
 * Arguments: the sandbox folder, the shared tools folder, the release
 * address and the installer arguments. A case's own tools come first on the
 * PATH. Paths are converted for Git Bash on Windows.
 */
const sandboxRunner = String.raw`
set -eu
posix() { if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf '%s' "$1"; fi; }
sb=$(posix "$1")
shared=$(posix "$2")
export WG_SANDBOX=$sb WG_STATE=$sb/state WG_BASE=$3 TMPDIR=$sb/tmp
shift 3
for body in "$sb"/tools/*; do
  [ -e "$body" ] || continue
  name=$(basename "$body")
  { printf '#!%s\n' "$BASH"; cat "$body"; } >"$sb/bin/$name"
  chmod +x "$sb/bin/$name"
done
cd "$sb/tmp"
PATH=$sb/bin:$shared exec "$BASH" "$sb/install.sh" "$@" </dev/null
`;

/** The stand-in tools, written once for all cases. */
let sharedTools: string | null = null;
function toolsFolder() {
  if (sharedTools) return sharedTools;
  const folder = mkdtempSync(join(tmpdir(), 'wg-agent-install-tools-'));
  writeFileSync(join(folder, 'setup.sh'), sandboxSetup);
  mkdirSync(join(folder, 'bin'));
  const result = spawnSync(
    'bash',
    [join(folder, 'setup.sh'), posixPath(join(folder, 'bin'))],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  process.once('exit', () => rmSync(folder, { recursive: true, force: true }));
  sharedTools = join(folder, 'bin');
  return sharedTools;
}

type Release = {
  checksums?: (text: string) => string;
  signer?: KeyObject | null;
  after?: (directory: string) => void;
};

function writeRelease(directory: string, signer: KeyObject, options: Release) {
  mkdirSync(directory, { recursive: true });
  const names = releaseAssetNames(version);
  const files: Record<string, string> = {
    'warguardian-agent-linux-x64': fakeAgent,
    'warguardian-agent-linux-arm64': fakeAgent,
    'warguardian-agent-win-x64.exe': 'MZ windows',
    [`WarGuardianAgentSetup-${version}.exe`]: 'MZ setup',
    'install.sh': '#!/usr/bin/env bash\n',
  };
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(directory, name), text);
  let checksums = checksumsFor(directory, Object.keys(files));
  if (options.checksums) checksums = options.checksums(checksums);
  writeFileSync(join(directory, names.checksums), checksums);
  const signing = options.signer === undefined ? signer : options.signer;
  if (signing)
    writeFileSync(
      join(directory, names.signature),
      sign(null, Buffer.from(checksums, 'utf8'), signing),
    );
  options.after?.(directory);
}

/** Sandbox paths of the installer constants. */
type Host = {
  sandbox: string;
  posix: (path: string) => string;
  installRoot: string;
  serviceRoot: string;
  stateDir: string;
  configDir: string;
  unitFile: string;
  binLink: string;
};

function posixPath(path: string) {
  if (process.platform !== 'win32') return path;
  return spawnSync('cygpath', ['-u', path], { encoding: 'utf8' }).stdout.trim();
}

function hostFor(sandbox: string): Host {
  const root = join(sandbox, 'host');
  return {
    sandbox,
    posix: posixPath,
    installRoot: join(root, 'opt/warguardian-agent'),
    serviceRoot: join(root, 'opt/warguardian-agent/service'),
    stateDir: join(root, 'var/lib/warguardian-agent'),
    configDir: join(root, 'etc/warguardian'),
    unitFile: join(root, 'etc/systemd/system/warguardian-agent.service'),
    binLink: join(root, 'usr/local/bin/warguardian-agent'),
  };
}

/** install.sh as a release publishes it, with its paths in the sandbox. */
function releasedScript(
  host: Host,
  key: string,
  values: Record<string, string> = {},
  stamp = true,
) {
  let script = (stamp ? stampInstaller(source, version) : source).replace(
    /\nrelease_public_key='[^'\n]*'\n/,
    `\nrelease_public_key='${key}'\n`,
  );
  const p = host.posix;
  const constants: Record<string, string> = {
    install_root: p(host.installRoot),
    state_dir: p(host.stateDir),
    config_dir: p(host.configDir),
    unit_file: `${p(join(host.sandbox, 'host/etc/systemd/system'))}/$unit_name`,
    bin_link: p(host.binLink),
    systemd_runtime: p(join(host.sandbox, 'host/run/systemd/system')),
  };
  for (const [name, value] of Object.entries(constants))
    script = script.replace(
      new RegExp(`\\n${name}=[^\\n]*\\n`),
      `\n${name}=${value}\n`,
    );
  for (const [name, value] of Object.entries(values))
    script = script.replace(`\n${name}=''\n`, `\n${name}='${value}'\n`);
  return script;
}

type Setup = {
  release?: Release;
  tools?: Record<string, string | null>;
  files?: Record<string, string>;
  owners?: Record<string, number>;
  modes?: Record<string, string>;
  links?: Record<string, string>;
  userExists?: boolean;
  discovery?: string;
  outcome?: Record<string, unknown>;
  enrollFails?: boolean;
  script?: string;
};

type Run = {
  status: number | null;
  stdout: string;
  stderr: string;
  urls: string[];
  commands: { as: string; tool: string; args: string[] }[];
  starts: { as: string; path: string; args: string }[];
  codes: string[];
  host: Host;
  owner: (path: string) => number | null;
  read: (path: string) => string;
  link: (path: string) => string | null;
};

const defaultOutcome = {
  serverId: 'arma-one',
  profile: 'battleye',
  instance: 'arma3-0123456789',
  serviceServers: 1,
  missing: [],
};

/**
 * Run install.sh in a fresh sandbox. The sandbox is removed at the next
 * turn of the event loop, after the test has read the result.
 */
function runInstaller(
  signer: KeyObject,
  key: string,
  args: string[],
  setupFor: Setup | ((host: Host) => Setup) = {},
): Run {
  const sandbox = mkdtempSync(join(tmpdir(), 'wg-agent-install-script-'));
  const host = hostFor(sandbox);
  const p = host.posix;
  const setup = typeof setupFor === 'function' ? setupFor(host) : setupFor;
  setImmediate(() => rmSync(sandbox, { recursive: true, force: true }));
  for (const folder of [
    'bin',
    'tmp',
    'state',
    'tools',
    'host/run/systemd/system',
    'host/etc/systemd/system',
    'host/usr/local/bin',
  ])
    mkdirSync(join(sandbox, folder), { recursive: true });
  writeRelease(join(sandbox, 'release'), signer, setup.release ?? {});
  writeFileSync(
    join(sandbox, 'install.sh'),
    setup.script ?? releasedScript(host, key),
  );
  for (const name of ['urls.log', 'cmds.log', 'agent.log', 'codes.log'])
    writeFileSync(join(sandbox, 'state', name), '');
  const map = (values: Record<string, unknown> = {}) =>
    Object.entries(values)
      .map(([path, value]) => `${p(path)}\t${String(value)}\n`)
      .join('');
  writeFileSync(join(sandbox, 'state/owners'), map(setup.owners));
  writeFileSync(join(sandbox, 'state/modes'), map(setup.modes));
  if (setup.userExists) writeFileSync(join(sandbox, 'state/user-exists'), '');
  if (setup.enrollFails) writeFileSync(join(sandbox, 'state/enroll-fails'), '');
  writeFileSync(
    join(sandbox, 'state/discovery.json'),
    '[{"id":"arma3-0123456789"}]\n',
  );
  writeFileSync(join(sandbox, 'state/discovery.lines'), setup.discovery ?? '');
  writeFileSync(
    join(sandbox, 'state/enroll.json'),
    `${JSON.stringify(setup.outcome ?? defaultOutcome)}\n`,
  );
  for (const [path, text] of Object.entries(setup.files ?? {})) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text, { mode: 0o755 });
  }
  for (const [path, target] of Object.entries(setup.links ?? {})) {
    mkdirSync(join(path, '..'), { recursive: true });
    symlinkSync(target, path);
  }
  // A tool set to null is missing: its stand-in fails as a missing command.
  for (const [name, body] of Object.entries(setup.tools ?? {}))
    writeFileSync(join(sandbox, 'tools', name), `${body ?? 'exit 127'}\n`);
  writeFileSync(join(sandbox, 'runner.sh'), sandboxRunner);
  const result = spawnSync(
    'bash',
    [join(sandbox, 'runner.sh'), sandbox, toolsFolder(), base, ...args],
    { encoding: 'utf8', timeout: 120_000 },
  );
  const lines = (name: string) =>
    readFileSync(join(sandbox, 'state', name), 'utf8')
      .split('\n')
      .filter(Boolean);
  const owners = new Map<string, number>();
  for (const line of lines('owners')) {
    const [path, uid] = line.split('\t');
    owners.set(path!, Number(uid));
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    urls: lines('urls.log'),
    commands: lines('cmds.log').map((line) => {
      const [as, tool, ...rest] = line.split('\t');
      return { as: as!, tool: tool!, args: rest };
    }),
    starts: lines('agent.log').map((line) => {
      const [as, path, ...rest] = line.split('\t');
      return { as: as!, path: path!, args: rest.join('\t') };
    }),
    codes: lines('codes.log'),
    host,
    owner: (path) => owners.get(p(path)) ?? null,
    read: (path) => readFileSync(path, 'utf8'),
    link: (path) => {
      try {
        return readlinkSync(path);
      } catch {
        return null;
      }
    },
  };
}

function releaseKeys() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { signer: privateKey, line: publicKeyLine(privateKey) };
}

function assertInstalled(run: Run) {
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(
    run.stdout,
    /WarGuardian Agent 1\.2\.3 is running for 1 server\(s\)\./,
  );
}

/** Recorded commands other than removing the work folders. */
function hostChanges(run: Run) {
  return run.commands.filter(
    (command) =>
      !(command.tool === 'rm' && command.args[0] === '-rf') &&
      !(command.tool === 'chmod' && command.args[0] === '0711'),
  );
}

/** The script passed the release checks. Off Linux it may stop afterwards. */
function assertChecked(run: Run) {
  assert.match(
    run.stdout,
    /Checked the signature and SHA-256 of WarGuardian Agent 1\.2\.3\./,
    run.stderr,
  );
  if (linux) assertInstalled(run);
}

// Release checks

void test('a signed release passes the signature and checksum checks', (context) => {
  if (!ready(context)) return;
  const { signer, line } = releaseKeys();
  const run = runInstaller(signer, line, [
    code,
    '--panel',
    'https://Panel.Example.test/',
  ]);
  assertChecked(run);
  assert.deepEqual(run.urls, [
    `${base}/SHA256SUMS`,
    `${base}/SHA256SUMS.sig`,
    `${base}/warguardian-agent-linux-x64`,
  ]);
});

void test('a signature from another key or over changed sums stops before the download', (context) => {
  if (!ready(context)) return;
  const { signer, line } = releaseKeys();
  const other = releaseKeys();
  for (const release of [
    { signer: other.signer },
    {
      after: (directory: string) =>
        writeFileSync(
          join(directory, 'SHA256SUMS'),
          readFileSync(join(directory, 'SHA256SUMS'), 'utf8').replace(
            /^[0-9a-f]{64}(?=  warguardian-agent-linux-x64$)/m,
            'a'.repeat(64),
          ),
        ),
    },
  ] satisfies Release[]) {
    const run = runInstaller(signer, line, [code], { release });
    assert.equal(run.status, 1, run.stderr);
    assert.match(
      run.stderr,
      /The signature of SHA256SUMS does not match the WarGuardian Agent release key\./,
    );
    assert.deepEqual(run.urls, [
      `${base}/SHA256SUMS`,
      `${base}/SHA256SUMS.sig`,
    ]);
    assert.deepEqual(hostChanges(run), []);
  }
});

void test('a release without SHA256SUMS.sig stops', (context) => {
  if (!ready(context)) return;
  const { signer, line } = releaseKeys();
  const run = runInstaller(signer, line, [code], {
    release: { signer: null },
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(
    run.stderr,
    /Could not download SHA256SUMS\.sig from WarGuardian Agent 1\.2\.3\./,
  );
});

void test('a download that does not match SHA256SUMS stops before the host changes', (context) => {
  if (!ready(context)) return;
  const { signer, line } = releaseKeys();
  const run = runInstaller(signer, line, [code], {
    release: {
      after: (directory) =>
        writeFileSync(
          join(directory, 'warguardian-agent-linux-x64'),
          'changed after signing',
        ),
    },
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(
    run.stderr,
    /The download does not match its SHA-256 digest in SHA256SUMS\./,
  );
  assert.deepEqual(hostChanges(run), []);
});

void test('signed sums of another version, or without this processor, stop', (context) => {
  if (!ready(context)) return;
  const { signer, line } = releaseKeys();
  let run = runInstaller(signer, line, [code], {
    release: {
      checksums: (text) =>
        text.replace(
          `WarGuardianAgentSetup-${version}.exe`,
          'WarGuardianAgentSetup-1.2.2.exe',
        ),
    },
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(
    run.stderr,
    /SHA256SUMS does not belong to WarGuardian Agent 1\.2\.3\./,
  );
  run = runInstaller(signer, line, [code], {
    release: {
      checksums: (text) =>
        text.replace(/^.*  warguardian-agent-linux-x64\n/m, ''),
    },
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(
    run.stderr,
    /SHA256SUMS does not list warguardian-agent-linux-x64\./,
  );
});

void test('the SHA-256 a panel expects must equal the signed checksum', (context) => {
  if (!ready(context)) return;
  const { signer, line } = releaseKeys();
  const run = runInstaller(signer, line, [code], (host) => ({
    script: releasedScript(host, line, {
      WARGUARDIAN_AGENT_LINUX_X64: `${'b'.repeat(64)} https://panel.example.test/downloads/agent`,
    }),
  }));
  assert.equal(run.status, 1, run.stderr);
  assert.match(
    run.stderr,
    /The release does not match the SHA-256 that WarGuardian expects\./,
  );
  assert.deepEqual(run.urls, [`${base}/SHA256SUMS`, `${base}/SHA256SUMS.sig`]);
});

void test('without OpenSSL 3 the installer stops before any download', (context) => {
  if (!ready(context)) return;
  const { signer, line } = releaseKeys();
  for (const openssl of [
    null,
    'echo "OpenSSL 1.1.1w  11 Sep 2023"',
    'echo "LibreSSL 3.8.2"',
  ]) {
    const run = runInstaller(signer, line, [code], { tools: { openssl } });
    assert.equal(run.status, 1, `${openssl}: ${run.stderr}`);
    assert.match(
      run.stderr,
      /Install OpenSSL 3 to check the release signature, then run the installer again\./,
    );
    assert.deepEqual(run.urls, []);
  }
});

void test('an installer without a release key or version stops before any download', (context) => {
  if (!ready(context)) return;
  const { signer, line } = releaseKeys();
  let run = runInstaller(signer, line, [code], (host) => ({
    script: releasedScript(host, ''),
  }));
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /This installer has no release key\./);
  assert.deepEqual(run.urls, []);
  run = runInstaller(signer, line, [code], (host) => ({
    script: releasedScript(host, line, {}, false),
  }));
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /No WarGuardian Agent release is available\./);
  assert.deepEqual(run.urls, []);
});

void test('the panel address is an HTTPS origin, or HTTP on this host', (context) => {
  if (!ready(context)) return;
  const { signer, line } = releaseKeys();
  for (const panel of [
    'http://panel.example.test',
    'https://panel.example.test/path',
    'https://panel.example.test"x',
    'ftp://panel.example.test',
    '',
  ]) {
    const run = runInstaller(signer, line, [code, '--panel', panel]);
    assert.equal(run.status, 2, `${panel}: ${run.stderr}`);
    assert.match(
      run.stderr,
      /The WarGuardian address must be an https:\/\/ origin/,
    );
  }
  for (const panel of ['http://127.0.0.1:8080', 'http://localhost:3000'])
    assertChecked(runInstaller(signer, line, [code, '--panel', panel]));
});

// The service account has no way to root through the install tree.

/** Root changed nothing inside a folder that the service account controls. */
function assertRootStaysOut(run: Run) {
  const controlled = [run.host.serviceRoot, run.host.stateDir].map(
    run.host.posix,
  );
  const writes = new Set([
    'install',
    'chown',
    'chmod',
    'ln',
    'mv',
    'rm',
    'mkdir',
    'rmdir',
    'cp',
    'touch',
  ]);
  for (const command of run.commands) {
    if (command.as !== 'root' || !writes.has(command.tool)) continue;
    for (const folder of controlled)
      assert.ok(
        !command.args.some((argument) => argument.startsWith(`${folder}/`)),
        `root ran ${command.tool} ${command.args.join(' ')}`,
      );
  }
}

/** Root started agent executables only from its own verified copy, to discover. */
function assertRootRunsOnlyItsCopy(run: Run) {
  for (const start of run.starts) {
    if (start.as !== 'root') continue;
    assert.match(
      start.path,
      /\/\.warguardian-agent-setup\.[^/]+\/warguardian-agent$/,
      `root ran ${start.path}`,
    );
    assert.match(start.args, /^discover --output /);
  }
}

/** The account set itself up through setsid, without a terminal of root's. */
function assertDetachedSetup(run: Run) {
  const enroll = run.starts.find((start) => start.args.startsWith('enroll'));
  assert.equal(enroll?.as, 'agent');
  assert.ok(
    run.commands.some(
      (command) =>
        command.as === 'root' &&
        command.tool === 'setsid' &&
        command.args.slice(0, 5).join(' ') ===
          '--wait runuser -u warguardian-agent --' &&
        command.args.includes('enroll'),
    ),
    'enroll runs as setsid --wait runuser -u warguardian-agent --',
  );
}

void test('a first install gives the program to root and only the service tree to the account', (context) => {
  if (!ready(context, true)) return;
  const { signer, line } = releaseKeys();
  const run = runInstaller(signer, line, [code]);
  assertInstalled(run);
  const { installRoot, serviceRoot, configDir, unitFile } = run.host;
  for (const path of [
    installRoot,
    join(installRoot, 'versions'),
    join(installRoot, 'versions/1.2.3'),
    join(installRoot, 'versions/1.2.3/warguardian-agent'),
  ])
    assert.equal(run.owner(path), 0, path);
  // The configuration belongs to root, and the account may read it.
  assert.ok(
    run.commands.some(
      (command) =>
        command.as === 'root' &&
        command.tool === 'install' &&
        command.args.slice(0, 6).join(' ') ===
          '-m 0640 -o root -g warguardian-agent' &&
        command.args.at(-1) === `${run.host.posix(configDir)}/.agent.json.new`,
    ),
  );
  assert.equal(run.owner(serviceRoot), agentUid);
  assert.equal(run.link(join(installRoot, 'current')), 'versions/1.2.3');
  assert.equal(run.link(join(serviceRoot, 'current')), 'versions/1.2.3');
  assert.ok(existsSync(join(serviceRoot, 'versions/1.2.3/warguardian-agent')));
  assert.equal(
    run.link(run.host.binLink),
    `${run.host.posix(installRoot)}/current/warguardian-agent`,
  );
  const unit = run.read(unitFile);
  assert.match(
    unit,
    /^ExecStart=\/opt\/warguardian-agent\/service\/current\/warguardian-agent run /m,
  );
  assert.match(unit, /^ReadWritePaths=\/opt\/warguardian-agent\/service$/m);
  assertRootStaysOut(run);
  assertRootRunsOnlyItsCopy(run);
  assertDetachedSetup(run);
});

/** An install by an earlier release: the account owns the program tree. */
function earlierLayout(host: Host, extra: Partial<Setup> = {}): Setup {
  const secret = join(host.sandbox, 'host/root-secret');
  return {
    userExists: true,
    files: {
      [join(host.installRoot, 'versions/1.0.0/warguardian-agent')]: fakeAgent,
      [join(host.configDir, 'agent.json')]: 'first server\n',
      [secret]: 'root secret\n',
      ...extra.files,
    },
    owners: {
      [host.installRoot]: agentUid,
      [join(host.installRoot, 'versions')]: agentUid,
      [join(host.installRoot, 'versions/1.0.0')]: agentUid,
      [host.stateDir]: agentUid,
      ...extra.owners,
    },
    links: {
      [join(host.installRoot, 'current')]: 'versions/1.0.0',
      // Files that root used to write or read in the state folder now point
      // at a file of root's.
      [join(host.stateDir, 'agent.json.new')]: secret,
      [join(host.stateDir, 'discovery.json')]: secret,
      [join(host.stateDir, 'update.json')]: secret,
      ...extra.links,
    },
  };
}

void test('over an earlier layout, the account tree moves aside and root never runs or follows it', (context) => {
  if (!ready(context, true)) return;
  const { signer, line } = releaseKeys();
  const run = runInstaller(signer, line, [code], (host) => earlierLayout(host));
  assertInstalled(run);
  const { installRoot, serviceRoot, configDir, sandbox } = run.host;
  assert.equal(run.owner(installRoot), 0);
  assert.equal(run.link(join(installRoot, 'current')), 'versions/1.2.3');
  // The earlier versions stay with the service tree, which now runs 1.2.3.
  assert.ok(existsSync(join(serviceRoot, 'versions/1.0.0/warguardian-agent')));
  assert.equal(run.link(join(serviceRoot, 'current')), 'versions/1.2.3');
  // The first server stays, and the file the account pointed at is untouched.
  const config = run.read(join(configDir, 'agent.json'));
  assert.equal(config, `first server\nenrolled ${code}\n`);
  assert.equal(run.read(join(sandbox, 'host/root-secret')), 'root secret\n');
  assertRootStaysOut(run);
  assertRootRunsOnlyItsCopy(run);
  assertDetachedSetup(run);
});

void test('a failed setup leaves the running version, the configuration and the earlier tree in place', (context) => {
  if (!ready(context, true)) return;
  const { signer, line } = releaseKeys();
  for (const [failure, message] of [
    [{ enrollFails: true }, /Setup did not finish\./],
    [
      { outcome: { serverId: 'Not Valid' } },
      /The agent sent an unreadable setup answer\./,
    ],
  ] as const) {
    const run = runInstaller(signer, line, [code], (host) => ({
      ...earlierLayout(host),
      ...failure,
    }));
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, message);
    const { installRoot, configDir } = run.host;
    assert.equal(run.owner(installRoot), agentUid);
    assert.equal(run.link(join(installRoot, 'current')), 'versions/1.0.0');
    assert.equal(run.read(join(configDir, 'agent.json')), 'first server\n');
    assert.ok(!existsSync(join(installRoot, 'versions/1.2.3')));
    assertRootStaysOut(run);
  }
});

// The setup code stays out of every command line.

void test('the setup code reaches the agent on stdin, never in a command line', (context) => {
  if (!ready(context, true)) return;
  const { signer, line } = releaseKeys();
  for (const variant of ['argument', 'file'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'wg-agent-code-'));
    const codeFile = join(directory, 'code');
    writeFileSync(codeFile, `${code.toLowerCase()}\n`, { mode: 0o600 });
    const run = runInstaller(
      signer,
      line,
      variant === 'argument' ? [code] : ['--code-file', codeFile],
      { modes: { [codeFile]: '600' } },
    );
    rmSync(directory, { recursive: true, force: true });
    assertInstalled(run);
    assert.deepEqual(run.codes, [code], variant);
    for (const command of run.commands)
      assert.ok(
        !command.args.join(' ').toUpperCase().includes(code),
        `${command.tool} ${command.args.join(' ')}`,
      );
    for (const start of run.starts)
      assert.ok(!start.args.toUpperCase().includes(code), start.args);
    assert.ok(
      run.starts.some((start) => start.args.startsWith('enroll --code-stdin ')),
      variant,
    );
  }
});

void test('without a code and a terminal, or with a code file others can read, the installer stops', (context) => {
  if (!ready(context)) return;
  const { signer, line } = releaseKeys();
  let run = runInstaller(signer, line, ['--panel', 'https://warguardian.app']);
  assert.equal(run.status, 2, run.stderr);
  assert.match(
    run.stderr,
    /Enter the setup code in a terminal, or pass --code-file FILE\./,
  );
  assert.deepEqual(run.urls, []);
  const directory = mkdtempSync(join(tmpdir(), 'wg-agent-code-'));
  const codeFile = join(directory, 'code');
  writeFileSync(codeFile, `${code}\n`);
  run = runInstaller(signer, line, ['--code-file', codeFile], {
    modes: { [codeFile]: '644' },
  });
  rmSync(directory, { recursive: true, force: true });
  assert.equal(run.status, 2, run.stderr);
  assert.match(
    run.stderr,
    /The code file must be a plain file that only its owner can read\./,
  );
  assert.deepEqual(run.urls, []);
});

// Read access only for the BattlEye file of the discovered game process.

void test('only a BEServer_x64 file of the account of the discovered game process gets an ACL', async (context) => {
  if (!ready(context, true)) return;
  const { signer, line } = releaseKeys();
  const sandbox = mkdtempSync(join(tmpdir(), 'wg-agent-game-'));
  const game = join(sandbox, 'game');
  mkdirSync(join(game, 'battleye'), { recursive: true });
  const sleep = spawnSync('bash', ['-c', 'command -v sleep'], {
    encoding: 'utf8',
  }).stdout.trim();
  writeFileSync(join(game, 'arma3server_x64'), readFileSync(sleep), {
    mode: 0o755,
  });
  const server = spawn(join(game, 'arma3server_x64'), ['60'], {
    stdio: 'ignore',
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    const good = join(game, 'battleye/BEServer_x64_active_1a2b.cfg');
    writeFileSync(good, 'RConPassword x\n');
    writeFileSync(join(game, 'battleye/BEServer_x64.cfg'), 'x\n');
    writeFileSync(join(game, 'battleye/notes.cfg'), 'x\n');
    // A -profiles folder outside the install folder, as many hosts use.
    mkdirSync(join(sandbox, 'profiles/battleye'), { recursive: true });
    const profiles = join(sandbox, 'profiles/battleye/BEServer_x64.cfg');
    writeFileSync(profiles, 'x\n');
    symlinkSync(join(game, 'battleye'), join(game, 'linked'));
    const id = 'arma3-0123456789';
    const cases: [string, number, RegExp | null, Record<string, number>?][] = [
      [good, server.pid!, null],
      [
        join(game, 'battleye/notes.cfg'),
        server.pid!,
        /not a BattlEye RCON file/,
      ],
      [profiles, server.pid!, null],
      [
        profiles,
        server.pid!,
        /not owned by the account of the game process/,
        { [profiles]: 4242 },
      ],
      [join(game, 'linked/BEServer_x64.cfg'), server.pid!, /not a plain file/],
      [good, 2_147_483_000, /the game process has stopped/],
      [
        good,
        server.pid!,
        /not owned by the account of the game process/,
        { [good]: 4242 },
      ],
    ];
    for (const [file, pid, refused, owners] of cases) {
      const run = runInstaller(signer, line, [code], {
        discovery: `${id} ${pid} ${file}\n`,
        owners: owners ?? {},
      });
      assertInstalled(run);
      const granted = run.commands.filter(
        (command) => command.tool === 'setfacl',
      );
      if (refused) {
        assert.deepEqual(granted, [], file);
        assert.match(run.stdout, refused, file);
      } else {
        assert.equal(granted.length, 1, run.stdout + run.stderr);
        assert.equal(granted[0]!.args.at(-1), file);
        assert.ok(
          run.stdout.includes(
            `Granting warguardian-agent read access to ${file}.`,
          ),
          run.stdout,
        );
      }
    }
  } finally {
    server.kill();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// The blocked list belongs to root and its entries expire.

void test('a version the account reports as failed is held back for a day unless --allow-blocked', (context) => {
  if (!ready(context, true)) return;
  const { signer, line } = releaseKeys();
  const now = Math.floor(Date.now() / 1000);
  const installed =
    (
      list?: { text: string; uid: number },
      report = '{"v":1,"blocked":["1.2.3"]}\n',
    ) =>
    (host: Host): Setup => {
      const files: Record<string, string> = {
        [join(host.serviceRoot, 'versions/1.0.0/warguardian-agent')]: fakeAgent,
        [join(host.configDir, 'agent.json')]: 'first server\n',
      };
      if (report) files[join(host.stateDir, 'update.json')] = report;
      const owners: Record<string, number> = {
        [host.installRoot]: 0,
        [host.serviceRoot]: agentUid,
        [host.stateDir]: agentUid,
      };
      if (list) {
        files[join(host.installRoot, 'blocked-versions')] = list.text;
        owners[join(host.installRoot, 'blocked-versions')] = list.uid;
      }
      return {
        files,
        owners,
        links: { [join(host.serviceRoot, 'current')]: 'versions/1.0.0' },
        userExists: true,
      };
    };
  let run = runInstaller(signer, line, [code], installed());
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stdout,
    /Version 1\.2\.3 failed its health check on this host\. 1\.0\.0 stays in place\. Run again with --allow-blocked to install it\./,
  );
  assert.equal(
    run.link(join(run.host.serviceRoot, 'current')),
    'versions/1.0.0',
  );
  assert.match(
    run.read(join(run.host.installRoot, 'blocked-versions')),
    /^1\.2\.3 \d+$/m,
  );
  assert.equal(run.owner(join(run.host.installRoot, 'blocked-versions')), 0);
  assertRootStaysOut(run);
  run = runInstaller(signer, line, [code, '--allow-blocked'], installed());
  assertInstalled(run);
  assert.equal(
    run.link(join(run.host.serviceRoot, 'current')),
    'versions/1.2.3',
  );
  // A block first seen a little less than a day ago still holds.
  run = runInstaller(
    signer,
    line,
    [code],
    installed({ text: `1.2.3 ${now - 23 * 3600}\n`, uid: 0 }),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    run.link(join(run.host.serviceRoot, 'current')),
    'versions/1.0.0',
  );
  // A block first seen more than a day ago has expired, as the agent's own.
  run = runInstaller(
    signer,
    line,
    [code],
    installed({ text: `1.2.3 ${now - 25 * 3600}\n`, uid: 0 }),
  );
  assertInstalled(run);
  assert.equal(
    run.link(join(run.host.serviceRoot, 'current')),
    'versions/1.2.3',
  );
  // A list that the account could change is not used.
  run = runInstaller(
    signer,
    line,
    [code],
    installed({ text: `1.2.3 ${now}\n`, uid: agentUid }, ''),
  );
  assertInstalled(run);
  assert.equal(
    run.link(join(run.host.serviceRoot, 'current')),
    'versions/1.2.3',
  );
});

void test('the installer embeds the systemd unit unchanged', () => {
  const embedded = /<<'UNIT'\n([\s\S]*?)\nUNIT\n/.exec(source)?.[1];
  assert.equal(`${embedded}\n`, readFileSync(agentFiles.unit, 'utf8'));
});
