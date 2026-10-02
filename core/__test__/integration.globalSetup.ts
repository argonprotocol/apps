import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import Path from 'node:path';
import type { TestProject } from 'vitest/node';
import { stopArgonTestNetwork } from './startArgonTestNetwork.ts';
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
      await stopArgonTestNetwork(composeProjectName, { profiles: ['bob', 'price-oracle'] });
    }
    await rm(Path.dirname(manifestPath), { recursive: true, force: true });
    await rm(lockDirectory, { recursive: true, force: true });
  };
}
