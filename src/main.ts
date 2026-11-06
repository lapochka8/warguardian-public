import { spawn } from 'node:child_process';
import { resolve, win32 } from 'node:path';
import { isSea } from 'node:sea';
import { parseArgs } from 'node:util';
import {
  abortableSleep,
  consoleLogger,
  createServerClient,
  createServerLoop,
} from './agent';
import { agentTarget, buildInfo } from './build-info';
import { rconAccessList } from './access';
import {
  agentLocations,
  loadServers,
  parseAgentConfig,
  readAgentConfig,
  serverPanel,
  type ServerConfig,
} from './config';
import {
  discoverServers,
  printablePath,
  readDiscoveryFile,
  writeDiscoveryFile,
  type DiscoveredInstance,
} from './discovery';
import { enroll, type EnrollOutcome } from './enroll';
import { AgentError, errorMessage, redact } from './errors';
import {
  harmlessCommand,
  privilegeProblem,
  privilegedExitCode,
  processPrivileged,
  trustedCopy,
} from './privilege';
import { agentProfileId } from './protocol';
import { createBattlEyeProfile } from './profiles/battleye';
import { createSquadFamilyProfile } from './profiles/squad-family';
import type { ProfileHandler } from './profiles/types';
import { createWardogsProfile } from './profiles/wardogs';
import {
  abandonFailedUpdate,
  createUpdater,
  detectLayout,
  restartExitCode,
  selectVersion,
  updateKeysFor,
  type UpdateLayout,
} from './update';

/** The command that exchanges a one-time code. install.sh and the installer call it. */
const setupCommand = 'enroll';

const usage = `Usage: warguardian-agent <command>

Commands:
  run [--config FILE] [--env-file FILE]... [--server ID] [--skip-profile PROFILE]...
  ${setupCommand} CODE|--code-stdin [--panel URL] [--config FILE] [--instance ID] [--discovered FILE] [--json]
  discover [--json] [--output FILE]
  access [--config FILE]
  version [--json]
`;

/**
 * `run` found no server to start. The shared systemd unit does not restart
 * on this code (`RestartPreventExitStatus=78`).
 */
export const notConfiguredExitCode = 78;

async function createHandler(server: ServerConfig): Promise<ProfileHandler> {
  switch (server.profile) {
    case 'wardogs':
      return createWardogsProfile(server);
    case 'battleye':
      return createBattlEyeProfile(server);
    case 'squad-family':
      return createSquadFamilyProfile(server);
    case 'arma-reforger': {
      const { createReforgerProfile } =
        await import('./profiles/arma-reforger');
      return createReforgerProfile(server);
    }
  }
}

/** Arguments after the executable, for both `node bundle.cjs` and the single executable. */
function userArguments(): string[] {
  return process.argv.slice(2);
}

/**
 * Hold a kernel lock on the Reforger profile for the life of the process by
 * replacing it with `flock`. The game keeps running if the agent stops.
 */
function lockReforgerProfile(
  server: Extract<ServerConfig, { profile: 'arma-reforger' }>,
  args: string[],
): void {
  if (args.includes('--host-lock-held')) return;
  if (!server.host) return;
  if (typeof process.execve !== 'function')
    throw new AgentError(
      400,
      'unsupported',
      'Arma Reforger host management needs Node.js with execve.',
    );
  const script = isSea() ? [] : [process.argv[1]!];
  process.execve(
    '/usr/bin/flock',
    [
      '/usr/bin/flock',
      '--nonblock',
      '--no-fork',
      `${resolve(server.host.profile)}.warguardian.lock`,
      process.execPath,
      ...script,
      ...args,
      '--host-lock-held',
    ],
    process.env,
  );
  throw new AgentError(
    409,
    'locked',
    'The Arma Reforger profile lock could not be acquired.',
  );
}

/** Secret values from the environment, removed from logged errors. */
function environmentSecrets(): string[] {
  return Object.entries(process.env)
    .filter(
      ([name, value]) => /(?:PASSWORD|TOKEN|SECRET|KEY)$/.test(name) && value,
    )
    .map(([, value]) => value!);
}

/**
 * A pending update that cannot start its servers returns to the previous
 * version at once. Failures before the updater starts, such as arguments or
 * a configuration this version cannot read, or no server to run, would
 * otherwise repeat on every restart, or stop the service, without a rollback.
 */
async function abandonUpdate(
  reason: string,
  layout: UpdateLayout | null,
): Promise<boolean> {
  if (!layout || !updateKeysFor(buildInfo)) return false;
  try {
    return await abandonFailedUpdate({
      layout,
      stateDirectory: agentLocations().stateDirectory,
      running: buildInfo.version,
      log: (message) => {
        consoleLogger.error(reason);
        consoleLogger.error(message);
      },
    });
  } catch {
    return false;
  }
}

async function run(
  args: string[],
  layout = detectLayout(process.execPath, process.platform),
): Promise<number> {
  let code: number;
  try {
    code = await runServers(args, layout);
  } catch (error) {
    const reason = redact(
      errorMessage(error, 'The agent could not start.'),
      environmentSecrets(),
    );
    if (await abandonUpdate(reason, layout)) return restartExitCode;
    throw error;
  }
  if (
    code === notConfiguredExitCode &&
    (await abandonUpdate('No server runs in this version.', layout))
  )
    return restartExitCode;
  return code;
}

/**
 * Windows: WinSW starts the installed executable in the program folder with
 * `service`. It runs the version self-update selected, from `versions`, or
 * itself. Only the installer writes the program folder and the WinSW
 * configuration.
 */
async function serviceCommand(args: string[]): Promise<number> {
  if (process.platform !== 'win32')
    throw new AgentError(
      400,
      'unsupported',
      'The service command runs on Windows.',
    );
  const { stateDirectory } = agentLocations();
  if (detectLayout(process.execPath, 'win32', stateDirectory)) return run(args);
  const root = win32.dirname(process.execPath);
  const installed: UpdateLayout = {
    kind: 'windows',
    root,
    version: buildInfo.version,
    stateDirectory,
  };
  const selected = await selectVersion({
    root,
    stateDirectory,
    installed: buildInfo.version,
  });
  if (!selected) return run(args, installed);
  // WinSW sends Ctrl+C to the whole console on stop. The selected version
  // handles it, and this process reports its exit code.
  const ignore = () => undefined;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const)
    process.on(signal, ignore);
  try {
    return await new Promise<number>((resolve) => {
      const child = spawn(selected.binary, ['run', ...args], {
        stdio: 'inherit',
        windowsHide: true,
      });
      child.once('exit', (code) => resolve(code ?? 1));
      child.once('error', (error) => {
        consoleLogger.error(
          `Version ${selected.version} could not start: ${errorMessage(error, 'unknown error')}`,
        );
        void abandonUpdate(`Version ${selected.version} could not start.`, {
          ...installed,
          version: selected.version,
        }).then((returned) => resolve(returned ? restartExitCode : 1));
      });
    });
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const)
      process.removeListener(signal, ignore);
  }
}

async function runServers(
  args: string[],
  layout: UpdateLayout | null,
): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      'env-file': { type: 'string', multiple: true },
      server: { type: 'string' },
      'skip-profile': { type: 'string', multiple: true },
      'host-lock-held': { type: 'boolean' },
    },
    allowPositionals: false,
  });
  const skipped = new Set<string>();
  for (const profile of values['skip-profile'] ?? []) {
    if (!agentProfileId.safeParse(profile).success)
      throw new AgentError(
        400,
        'not-configured',
        `Unknown profile: ${profile}.`,
      );
    skipped.add(profile);
  }
  const locations = agentLocations();
  const { config } = await loadServers({
    configFile: values.config ?? locations.configFile,
    configExplicit: !!values.config,
    envFiles: values['env-file'] ?? [],
    env: process.env,
  });
  const configured = values.server
    ? config.servers.filter((server) => server.serverId === values.server)
    : config.servers;
  const selected = configured.filter((server) => !skipped.has(server.profile));
  if (!selected.length) {
    consoleLogger.error(
      values.server && !configured.length
        ? `Server ${values.server} is not configured.`
        : configured.length
          ? 'No server runs in this service. Arma Reforger servers run in their own service.'
          : `No server is set up. Run: warguardian-agent ${setupCommand} WG-XXXXX-XXXXX`,
    );
    return notConfiguredExitCode;
  }
  const reforger = selected.filter(
    (server) => server.profile === 'arma-reforger',
  );
  if (reforger.length && selected.length > 1)
    throw new AgentError(
      400,
      'not-configured',
      'Run each Arma Reforger server in its own service with --server ID.',
    );
  if (reforger[0]?.profile === 'arma-reforger')
    lockReforgerProfile(reforger[0], ['run', ...args]);

  const controller = new AbortController();
  let exitCode = 0;
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const target = agentTarget();
  // Self-update runs only with both pinned keys: the panel's manifest key
  // and the offline release key that signs each build.
  const keys = updateKeysFor(buildInfo);
  let updater: ReturnType<typeof createUpdater> | null = null;
  if (layout && target && keys && config.update.enabled) {
    updater = createUpdater({
      layout,
      stateDirectory: locations.stateDirectory,
      running: buildInfo.version,
      target,
      panel: serverPanel(config, selected[0]!),
      keys,
      log: (message) => consoleLogger.info(message),
      restart: () => {
        exitCode = restartExitCode;
        controller.abort();
      },
    });
    if (!(await updater.start())) return restartExitCode;
  }

  const handlers: ProfileHandler[] = [];
  const loops: Promise<void>[] = [];
  for (const server of selected) {
    let handler: ProfileHandler;
    try {
      handler = await createHandler(server);
    } catch (error) {
      consoleLogger.error(
        `${server.serverId}: ${errorMessage(error, 'the profile could not start')}`,
      );
      continue;
    }
    handlers.push(handler);
    handler.start();
    const loop = createServerLoop({
      serverId: server.serverId,
      client: createServerClient(
        serverPanel(config, server),
        server.serverId,
        server.secret,
        { version: buildInfo.version },
      ),
      handler,
      secrets: () => [server.secret],
      onHealthy: () => void updater?.healthy().catch(() => undefined),
    });
    loops.push(loop.run(controller.signal));
  }
  if (!loops.length)
    throw new AgentError(
      400,
      'not-configured',
      'No server profile could start.',
    );
  consoleLogger.info(
    `WarGuardian Agent ${buildInfo.version} started for ${handlers.length} server(s). No inbound listener is open.`,
  );

  if (updater) {
    const scheduled = updater;
    void (async () => {
      let wait = 5 * 60_000 + Math.floor(Math.random() * 60_000);
      while (!controller.signal.aborted) {
        await abortableSleep(wait, controller.signal);
        if (controller.signal.aborted) break;
        try {
          await scheduled.check();
        } catch (error) {
          consoleLogger.error(
            `Update check failed: ${errorMessage(error, 'unknown error')}`,
          );
        }
        wait = 6 * 3_600_000 + Math.floor(Math.random() * 600_000);
      }
    })();
  }

  await Promise.all(loops);
  updater?.close();
  await Promise.allSettled(handlers.map((handler) => handler.close()));
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  consoleLogger.info('WarGuardian Agent stopped.');
  return exitCode;
}

/**
 * The first line of stdin, so the code never appears in a process list.
 * At most 256 characters are read.
 */
export async function readSetupCode(
  stream: NodeJS.ReadableStream,
): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    if (text.includes('\n') || text.length > 256) break;
  }
  return (text.split(/\r?\n/, 1)[0] ?? '').trim().slice(0, 256);
}

/** The local paths of the RCON files set up for the server, for the operator. */
function setupPaths(outcome: EnrollOutcome): string[] {
  return outcome.paths.map(({ label, path }) => `${label}: ${path}`);
}

async function enrollCommand(args: string[], io: MainOptions): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      panel: { type: 'string' },
      config: { type: 'string' },
      instance: { type: 'string' },
      discovered: { type: 'string' },
      json: { type: 'boolean' },
      'code-stdin': { type: 'boolean' },
    },
    allowPositionals: true,
  });
  if (positionals.length !== (values['code-stdin'] ? 0 : 1))
    throw new AgentError(400, 'invalid-code', 'Pass one setup code.');
  const code = values['code-stdin']
    ? await readSetupCode(io.stdin ?? process.stdin)
    : positionals[0]!;
  const locations = agentLocations();
  const panel = values.panel ?? (buildInfo.panel || undefined);
  const outcome = await enroll({
    code,
    configFile: values.config ?? locations.configFile,
    stateDirectory: locations.stateDirectory,
    ...(panel ? { panel } : {}),
    ...(values.instance ? { instance: values.instance } : {}),
    ...(values.discovered
      ? { discovered: await readDiscoveryFile(values.discovered) }
      : {}),
    version: buildInfo.version,
  });
  if (values.json) {
    // One line for install.sh. It holds no secret and no local path.
    console.log(
      JSON.stringify({
        serverId: outcome.serverId,
        profile: outcome.profile,
        missing: outcome.missing,
        serviceServers: outcome.serviceServers,
        ...(outcome.instance ? { instance: outcome.instance } : {}),
      }),
    );
    for (const line of setupPaths(outcome)) console.error(line);
    if (outcome.problem) console.error(outcome.problem);
    return 0;
  }
  console.log(`Set up ${outcome.serverId} (${outcome.profile}).`);
  for (const line of setupPaths(outcome)) console.log(line);
  if (outcome.missing.length)
    console.log(
      `Set ${outcome.missing.join(', ')} for ${outcome.serverId} in the agent configuration.`,
    );
  if (outcome.problem) console.log(outcome.problem);
  return 0;
}

async function discoverCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { json: { type: 'boolean' }, output: { type: 'string' } },
  });
  const found = await discoverServers();
  if (values.output) {
    // install.sh runs this as root, then passes the file to `enroll` and
    // grants the service account read access to the files printed here for
    // the server that `enroll` set up, once it has checked each file against
    // the game process: one `<id> <process ID> <file>` line per file.
    await writeDiscoveryFile(values.output, found);
    for (const item of found) console.error(describe(item));
    for (const item of found)
      for (const file of item.rconFiles ?? [])
        if (printablePath(file))
          console.log(`${item.id} ${item.pid ?? 0} ${file}`);
    return 0;
  }
  if (values.json) {
    console.log(
      JSON.stringify(
        found.map((item) => ({
          id: item.id,
          rconConfigured: item.rconConfigured,
          ...item.summary,
        })),
      ),
    );
    return 0;
  }
  if (!found.length) console.log('No supported game server is running.');
  for (const item of found) console.log(describe(item));
  return 0;
}

/** One line about a discovered server, for the operator. */
function describe(item: DiscoveredInstance): string {
  return [
    item.id,
    item.summary.gameId,
    `rcon port ${item.summary.rconPort ?? 'not found'}`,
    item.rconConfigured ? 'password found' : 'password not found',
    ...(item.problem ? [item.problem] : []),
  ].join('  ');
}

/**
 * The game files the configured servers read, one `file <path>` or
 * `folder <path>` line each. The Windows installer grants the service
 * account read access to exactly these.
 */
async function accessCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { config: { type: 'string' } },
  });
  const config =
    (await readAgentConfig(values.config ?? agentLocations().configFile)) ??
    parseAgentConfig({});
  for (const entry of await rconAccessList(config))
    console.log(`${entry.kind} ${entry.path}`);
  return 0;
}

function versionCommand(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { json: { type: 'boolean' } },
  });
  if (values.json)
    console.log(
      JSON.stringify({ version: buildInfo.version, target: agentTarget() }),
    );
  else console.log(`WarGuardian Agent ${buildInfo.version}`);
  return 0;
}

/** The executable, and the bundle when Node.js runs one, may run privileged. */
async function runningCopyTrusted(): Promise<boolean> {
  if (!(await trustedCopy(process.execPath))) return false;
  if (isSea()) return true;
  return !!process.argv[1] && trustedCopy(process.argv[1]);
}

export type MainOptions = {
  stdin?: NodeJS.ReadableStream;
  /** True when this process runs as root or an elevated administrator. */
  privileged?: () => Promise<boolean>;
  /** True when this copy of the agent may run privileged commands. */
  trusted?: () => Promise<boolean>;
};

export async function main(
  argv: string[] = userArguments(),
  io: MainOptions = {},
): Promise<number> {
  const [command, ...rest] = argv;
  // A privileged run would follow files the service account controls.
  if (
    !harmlessCommand(command) &&
    (await (io.privileged ?? (() => processPrivileged()))())
  ) {
    const problem = privilegeProblem({
      platform: process.platform,
      command,
      trusted: await (io.trusted ?? runningCopyTrusted)(),
    });
    if (problem) {
      console.error(problem);
      return privilegedExitCode;
    }
  }
  switch (command) {
    case undefined:
    case 'run':
      return run(command === undefined ? [] : rest);
    case 'service':
      return serviceCommand(rest);
    case setupCommand:
      return enrollCommand(rest, io);
    case 'discover':
      return discoverCommand(rest);
    case 'access':
      return accessCommand(rest);
    case 'version':
    case '--version':
      return versionCommand(rest);
    case 'help':
    case '--help':
      console.log(usage);
      return 0;
    default:
      if (command.startsWith('--')) return run(argv);
      console.error(usage);
      return 2;
  }
}

/** Entry point of the bundle and the single executable. */
export function start(): void {
  main().then(
    (code) => {
      process.exitCode = code;
      if (code === restartExitCode) process.exit(code);
    },
    (error) => {
      console.error(
        `WarGuardian Agent: ${redact(errorMessage(error, 'could not start'), environmentSecrets())}`,
      );
      process.exitCode = 1;
    },
  );
}
