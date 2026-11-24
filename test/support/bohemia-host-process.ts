/**
 * One Agent process for the Windows host test: it runs one host command with
 * the real process functions and exits, like an Agent that restarts.
 *
 *   bohemia-host-process.ts <root> start|stop|download
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  bohemiaHostSettings,
  createBohemiaHostController,
} from '../../src/games/bohemia-host';

const [root, mode] = process.argv.slice(2) as [string, string];
const server = join(root, 'server');
const steamcmd = join(root, 'steamcmd.exe');
const controller = await createBohemiaHostController({
  serverId: 'demo-arma3',
  game: 'arma3',
  settings: bohemiaHostSettings.parse({
    executable: join(server, 'arma3server_x64.exe'),
    serverDirectory: server,
    config: join(server, 'server.cfg'),
    profiles: join(root, 'profiles'),
    port: 2302,
    steamcmd,
    steamUser: 'wg_host',
    workshopDirectory: join(root, 'workshop'),
  }),
  stateDirectory: join(root, 'state'),
  startCheckMs: 1000,
  startReadyMs: 0,
});
if (mode === 'download') {
  await controller.execute({ action: 'install-mods', ids: ['450814997'] });
  while (!existsSync(`${steamcmd}.pid`))
    await new Promise((resolve) => setTimeout(resolve, 50));
} else {
  await controller.execute(
    mode === 'stop' ? { action: 'stop', confirmation: 'x' } : { action: mode },
  );
  await controller.idle();
}
const status = await controller.read('status', new URLSearchParams());
process.stdout.write(JSON.stringify(status), () => process.exit(0));
