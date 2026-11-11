import Fs from 'node:fs';
import Path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
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
        const enclave = execFileSync('kurtosis', ['enclave', 'ls', '--full-uuids'], {
          encoding: 'utf8',
          timeout: 15_000,
        })
          .split('\n')
          .map(line => line.trim().split(/\s+/))
          .find(([, name]) => name === ethereum.enclaveName);
        if (!enclave) continue;

        const removal = spawnSync('kurtosis', ['enclave', 'rm', '-f', ethereum.enclaveName], {
          encoding: 'utf8',
          timeout: 60_000,
        });
        if (removal.stdout) Fs.writeSync(output.fd, removal.stdout);
        if (removal.stderr) Fs.writeSync(output.fd, removal.stderr);
        if (removal.error) throw removal.error;
        if (removal.status === null) {
          throw new Error(`Removing Ethereum enclave ${ethereum.enclaveName} was interrupted. Logs: ${paths.logPath}`);
        }
        if (removal.status === 0) continue;
        if (!removal.stderr?.includes(`No enclave found with identifier '${ethereum.enclaveName}'`)) {
          throw new Error(`Could not remove Ethereum enclave ${ethereum.enclaveName}. Logs: ${paths.logPath}`);
        }

        const [enclaveId] = enclave;
        if (!/^[a-f0-9]{32}$/i.test(enclaveId)) {
          throw new Error('Kurtosis returned an invalid enclave UUID. Refusing to remove Docker resources.');
        }

        output.progress(`Removing leftover Docker resources for ${ethereum.enclaveName}`);
        removeOrphanedEthereumResources(enclaveId, output);
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
    }
    if (reset) {
      const instances = new Set([...owned.map(({ instance }) => instance.instance), owner]);
      for (const instance of instances) {
        const resetProfile = { ...profile, instance };
        clearMacDevKeychain(resetProfile);
        Fs.rmSync(getDevPaths(resetProfile).instanceDir, { recursive: true, force: true });
      }
    }
    output.progress(`${reset ? 'Reset' : 'Stopped'} ${owner}`);
  } finally {
    release?.();
    output.close();
  }
}

export function clearMacDevKeychain(
  { network, instance }: Pick<DevProfile, 'network' | 'instance'>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (process.platform !== 'darwin' || network !== 'dev-docker') return;

  const account = `${network}/${instance}`;
  const result = spawnSync(
    'security',
    ['delete-generic-password', '-s', 'com.argon.desktop.local.mnemonic', '-a', account],
    {
      env,
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  // security exits with 44 when the entry is already absent.
  if (result.status !== 0 && result.status !== 44) {
    throw new Error('Could not clear this development profile’s keychain entry.', { cause: result.error });
  }
}

function removeOrphanedEthereumResources(enclaveId: string, output: DevOutput): void {
  const filter = `label=com.kurtosistech.enclave-id=${enclaveId}`;
  const listOptions = { encoding: 'utf8', timeout: 15_000 } as const;
  const removalOptions = { timeout: 60_000, stdio: ['ignore' as const, output.fd, output.fd] };

  const containers = execFileSync('docker', ['ps', '-aq', '--filter', filter], listOptions)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (containers.length) execFileSync('docker', ['rm', '--force', '--volumes', ...containers], removalOptions);

  const volumes = execFileSync('docker', ['volume', 'ls', '-q', '--filter', filter], listOptions)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (volumes.length) execFileSync('docker', ['volume', 'rm', ...volumes], removalOptions);

  const networks = execFileSync('docker', ['network', 'ls', '-q', '--filter', filter], listOptions)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const networkId of networks) {
    const endpoints =
      JSON.parse(
        execFileSync('docker', ['network', 'inspect', '--format', '{{json .Containers}}', networkId], listOptions),
      ) ?? {};
    for (const containerId of Object.keys(endpoints)) {
      const labels = (JSON.parse(
        execFileSync('docker', ['inspect', '--format', '{{json .Config.Labels}}', containerId], listOptions),
      ) ?? {}) as Record<string, string>;
      if (
        labels['com.kurtosistech.app-id'] !== 'kurtosis' ||
        labels['com.kurtosistech.container-type'] !== 'kurtosis-reverse-proxy' ||
        labels['com.kurtosistech.enclave-id']
      ) {
        throw new Error(
          `Unrecognized container ${containerId} is attached to old Ethereum network ${networkId}. Refusing to disconnect it.`,
        );
      }

      // The shared proxy belongs to every enclave; only this deleted enclave's attachment is ours.
      execFileSync('docker', ['network', 'disconnect', networkId, containerId], removalOptions);
    }
    execFileSync('docker', ['network', 'rm', networkId], removalOptions);
  }
}
