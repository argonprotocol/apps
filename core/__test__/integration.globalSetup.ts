import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import docker from 'docker-compose';
import Path from 'node:path';
import type { TestProject } from 'vitest/node';
import { COMPOSE_CONFIG, COMPOSE_DIR, stopArgonTestNetwork } from './startArgonTestNetwork.ts';
import { integrationComposeProjectName, integrationNetworkManifestPath } from './integrationNetwork.ts';

export default function setup(project: TestProject): () => Promise<void> {
  const borrowed = !process.env.CI && existsSync(integrationNetworkManifestPath);
  const sessionId = randomUUID();
  const composeProjectName = borrowed ? integrationComposeProjectName : `argon-integration-${sessionId}`;
  const manifestPath = borrowed
    ? integrationNetworkManifestPath
    : Path.join(Path.dirname(integrationNetworkManifestPath), 'integration-sessions', sessionId, 'network.json');
  const lockDirectory = Path.join(
    Path.dirname(integrationNetworkManifestPath),
    'integration-locks',
    composeProjectName,
  );

  project.provide('argonIntegrationSession', { composeProjectName, manifestPath, lockDirectory, borrowed });
  project.provide('argonIntegrationRunId', randomUUID());
  project.onTestsRerun(() => project.provide('argonIntegrationRunId', randomUUID()));

  return async () => {
    if (borrowed) return;
    // Local and isolated scenarios never create this shared session's manifest.
    if (existsSync(manifestPath)) {
      if (process.env.CI && project.vitest.state.getFailedFilepaths().length) {
        try {
          const composeOptions = {
            cwd: COMPOSE_DIR,
            config: COMPOSE_CONFIG,
            composeOptions: ['--profile=bob', '--profile=price-oracle'],
            env: { ...process.env, COMPOSE_PROJECT_NAME: composeProjectName },
          };
          const containers = execFileSync(
            'docker',
            ['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${composeProjectName}`],
            { encoding: 'utf8' },
          ).trim();
          const state = containers
            ? execFileSync(
                'docker',
                [
                  'inspect',
                  '--format',
                  '{{.Name}} restarts={{.RestartCount}} state={{json .State}}',
                  ...containers.split(/\s+/),
                ],
                { encoding: 'utf8' },
              )
            : 'No test-network containers remain.\n';
          const logs = await docker.logs(['archive-node', 'miner-1', 'notary'], {
            ...composeOptions,
            timestamps: true,
          });
          const diagnosticsDirectory = Path.join(
            Path.dirname(integrationNetworkManifestPath),
            'integration-diagnostics',
          );
          await mkdir(diagnosticsDirectory, { recursive: true });
          await writeFile(Path.join(diagnosticsDirectory, `${composeProjectName}.log`), state + logs.out + logs.err, {
            mode: 0o600,
          });
        } catch (error) {
          console.error('Could not capture failed integration network diagnostics', error);
        }
      }
      await stopArgonTestNetwork(composeProjectName, { profiles: ['bob', 'price-oracle'] });
    }
    await rm(Path.dirname(manifestPath), { recursive: true, force: true });
    await rm(lockDirectory, { recursive: true, force: true });
  };
}
