import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from './cli.mjs';

await runBuild({
  root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  sources: {
    entry: 'src/cli.ts',
    license: 'LICENSE',
    serviceXml: 'deploy/windows/warguardian-agent-service.xml',
    installerScript: 'deploy/windows/warguardian-agent.iss',
    installScript: 'install.sh',
  },
});
