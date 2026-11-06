import { parseArgs } from 'node:util';
import { agentTargets, buildAgent, buildWindowsInstaller } from './build.mjs';

const usage = `Usage: build-agent [--target TARGET]... [--out-dir DIR] [--pinned-node]
                   [--fetch-node] [--no-installer] [--require-all]
       build-agent --installer-from EXE --out-dir DIR

Targets: ${agentTargets.join(', ')}.`;

/** The build command line, for a source tree laid out as `sources` describes. */
export async function runBuild({
  root,
  sources,
  args = process.argv.slice(2),
}) {
  const { values } = parseArgs({
    args,
    options: {
      'out-dir': { type: 'string' },
      target: { type: 'string', multiple: true },
      'fetch-node': { type: 'boolean' },
      'pinned-node': { type: 'boolean' },
      'no-installer': { type: 'boolean' },
      'require-all': { type: 'boolean' },
      'installer-from': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (values['installer-from']) {
    if (!values['out-dir']) throw new Error(usage);
    const installer = buildWindowsInstaller({
      root,
      sources,
      executable: values['installer-from'],
      outDir: values['out-dir'],
    });
    console.log(`Windows installer written to ${installer}.`);
    return;
  }
  const targets = values.target ?? agentTargets;
  for (const target of targets)
    if (!agentTargets.includes(target))
      throw new Error(`Choose targets from ${agentTargets.join(', ')}.`);
  const { outDir, summary } = await buildAgent({
    root,
    sources,
    outDir: values['out-dir'],
    targets,
    fetchNode: values['fetch-node'],
    pinnedNode: values['pinned-node'],
    installer: !values['no-installer'],
    requireAll: values['require-all'],
  });
  for (const [name, artifact] of Object.entries(summary.artifacts))
    console.log(
      `${name}: ${artifact.file} ${artifact.size} bytes sha256 ${artifact.sha256}`,
    );
  console.log(`Agent ${summary.version} written to ${outDir}.`);
}
