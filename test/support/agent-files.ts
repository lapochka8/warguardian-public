import { join } from 'node:path';

const root = join(import.meta.dirname, '../..');

/** Files of the source tree that the tests read. */
export const agentFiles = {
  root,
  installer: join(root, 'install.sh'),
  unit: join(root, 'deploy/linux/warguardian-agent.service'),
};
