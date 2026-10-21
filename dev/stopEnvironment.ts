import Fs from 'node:fs';
import Path from 'node:path';
import { configureDevEnvironment, readOwnedEthereumStates, recordEthereumContainers } from './environment.ts';
import { acquireDevLock } from './lock.ts';
import { DevOutput } from './output.ts';
import { getDevPaths, readDevSession, requestDevSession, type DevProfile } from './session.ts';

export async function stopDevEnvironment(profile: DevProfile, reset = false): Promise<void> {
  const { paths, context, composeArgs, environment } = await configureDevEnvironment(profile);
  const owner = profile.join ?? profile.instance;
  Fs.mkdirSync(paths.instanceDir, { recursive: true });
  const output = new DevOutput(paths.logPath);
  let release: VoidFunction | undefined;
  try {
    release = acquireDevLock(Path.join(paths.networkDir, `.${owner}.dev-environment.lock`), 'Environment shutdown');
    const { stopDevUpstreamWorker } = await import('../e2e/scripts/devUpstreamProcess.ts');
    output.progress(`Stopping environment ${owner}`);
    const owned = Fs.readdirSync(paths.networkDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const instance = { ...profile, instance: entry.name };
        return { instance, state: readDevSession(instance) };
      })
      .filter(entry => entry.state?.owner === owner);
    for (const { state } of owned) {
      if (state) await requestDevSession(state, 'stop').catch(() => undefined);
    }
    for (const { state } of owned) {
      if (!state) continue;
      const deadline = Date.now() + 15_000;
      while (await requestDevSession(state, 'status').catch(() => undefined)) {
        if (Date.now() > deadline)
          throw new Error('A desktop instance is still shutting down. Retry stop before resetting data.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await stopDevUpstreamWorker(paths.upstreamDir);
    await output.run(
      'docker',
      [
        ...composeArgs,
        '--profile',
        'upstream',
        reset ? 'down' : 'stop',
        ...(reset ? ['--volumes', '--remove-orphans'] : []),
      ],
      { env: context.composeEnv, cwd: context.composeDir },
    );
    if (reset) {
      for (const ethereum of readOwnedEthereumStates(profile)) {
        await output.run('kurtosis', ['enclave', 'rm', '-f', ethereum.enclaveName]);
      }
    } else if (environment) {
      recordEthereumContainers(profile, environment);
      if (environment.ethereumContainers?.length)
        await output.run('docker', ['stop', ...environment.ethereumContainers]);
    }
    for (const { instance } of owned) {
      const { instanceDir } = getDevPaths(instance);
      const vmDir = Path.join(instanceDir, 'virtual-machine');
      for (const directory of [Path.join(vmDir, 'app', 'server'), vmDir]) {
        if (['docker-compose.yml', 'docker-compose.yaml'].some(file => Fs.existsSync(Path.join(directory, file)))) {
          const env = { ...process.env };
          delete env.COMPOSE_PROJECT_NAME;
          await output.run(
            'docker',
            ['compose', '--profile', 'all', reset ? 'down' : 'stop', ...(reset ? ['--volumes'] : [])],
            {
              env,
              cwd: directory,
            },
          );
        }
      }
      if (reset) Fs.rmSync(instanceDir, { recursive: true, force: true });
    }
    if (reset) Fs.rmSync(paths.ownerDir, { recursive: true, force: true });
    output.progress(`${reset ? 'Reset' : 'Stopped'} ${owner}`);
  } finally {
    release?.();
    output.close();
  }
}
