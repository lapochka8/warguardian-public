import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * An inert Windows program: a single executable copy of this Node.js that
 * writes its process ID to `<its path>.pid` and idles. Unlike `node.exe`, it
 * accepts the arguments of a game server or SteamCMD. Hard links to it run
 * as separate programs with their own `.pid` file.
 */
export async function idleExecutable(directory: string, name: string) {
  const main = join(directory, 'idle.cjs'),
    blob = join(directory, 'idle.blob'),
    config = join(directory, 'idle-sea.json'),
    executable = join(directory, name);
  await fs.writeFile(
    main,
    [
      "require('node:fs').writeFileSync(`${process.execPath}.pid`, String(process.pid));",
      "console.log('started');",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  await fs.writeFile(
    config,
    JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true }),
  );
  execFileSync(process.execPath, ['--experimental-sea-config', config], {
    stdio: 'ignore',
  });
  await fs.copyFile(process.execPath, executable);
  // The package ships no types.
  const postject: string = 'postject';
  const { inject } = (await import(postject)) as {
    inject: (
      file: string,
      name: string,
      data: Buffer,
      options: { sentinelFuse: string },
    ) => Promise<void>;
  };
  const log = console.log,
    warn = console.warn;
  console.log = console.warn = () => {};
  try {
    await inject(executable, 'NODE_SEA_BLOB', await fs.readFile(blob), {
      sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    });
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return executable;
}
