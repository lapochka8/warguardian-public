import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { win32 } from 'node:path';
import { AgentError } from './errors';

/** The pipe name for one Arma Reforger profile folder on Windows. */
export function reforgerProfilePipe(profile: string): string {
  const id = createHash('sha256')
    .update(win32.resolve(profile).toLowerCase())
    .digest('hex')
    .slice(0, 32);
  return `\\\\.\\pipe\\warguardian-reforger-${id}`;
}

const held: Server[] = [];

/**
 * Windows: hold the Arma Reforger profile for the life of this process. The
 * first instance of a named pipe is exclusive, and Windows closes it when
 * the Agent ends, also after a crash. The game keeps running.
 */
export function holdReforgerProfile(profile: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'EADDRINUSE' || error.code === 'EACCES'
          ? new AgentError(
              409,
              'locked',
              'The Arma Reforger profile lock could not be acquired.',
            )
          : error,
      ),
    );
    server.listen(
      { path: reforgerProfilePipe(profile), exclusive: true },
      () => {
        server.unref();
        held.push(server);
        resolve(server);
      },
    );
  });
}
