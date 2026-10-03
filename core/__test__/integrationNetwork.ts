import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import type { ProvidedContext } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import Path from 'node:path';
import docker from 'docker-compose';
import {
  COMPOSE_CONFIG,
  COMPOSE_DIR,
  startArgonTestNetwork,
  type StartedArgonTestNetwork,
} from './startArgonTestNetwork.ts';
import packageJson from '../../package.json' with { type: 'json' };
import { acquireIntegrationLock } from './helpers/locks.ts';
import { getClient } from '@argonprotocol/mainchain';

const repoRoot = Path.resolve(import.meta.dirname, '../..');
export const integrationNetworkManifestPath = Path.join(repoRoot, 'e2e/artifacts/integration-network.json');
export const integrationComposeProjectName = `argon-integration-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 12)}`;

export type IntegrationNetwork = Pick<StartedArgonTestNetwork, 'archiveUrl' | 'notaryUrl' | 'networkConfigOverride'> & {
  composeProjectName: string;
};
export type PersistentIntegrationNetwork = IntegrationNetwork & {
  mainchainVersion: string;
  genesisHash: string;
};

declare module 'vitest' {
  export interface ProvidedContext {
    argonIntegrationSession: {
      composeProjectName: string;
      manifestPath: string;
      lockDirectory: string;
      borrowed: boolean;
    };
    argonIntegrationRunId: string;
  }
}

export const integrationSession = new AsyncLocalStorage<ProvidedContext['argonIntegrationSession']>();

export async function startIntegrationNetwork(
  manifestPath = integrationNetworkManifestPath,
  composeProjectName = integrationComposeProjectName,
): Promise<PersistentIntegrationNetwork> {
  const release = await acquireIntegrationLock(
    'network-start',
    Path.join(Path.dirname(integrationNetworkManifestPath), 'integration-locks', composeProjectName),
  );
  try {
    if (existsSync(manifestPath)) {
      return await verifyPersistentIntegrationNetwork(
        JSON.parse(await readFile(manifestPath, 'utf8')) as PersistentIntegrationNetwork,
        composeProjectName,
      );
    }
    const started = await startArgonTestNetwork(composeProjectName, {
      composeProjectName,
      profiles: ['bob', 'price-oracle'],
      registerTeardown: false,
    });
    const pendingPath = `${manifestPath}.${randomUUID()}.pending`;
    try {
      const client = await getClient(started.archiveUrl);
      try {
        const network: PersistentIntegrationNetwork = {
          archiveUrl: started.archiveUrl,
          notaryUrl: started.notaryUrl,
          networkConfigOverride: started.networkConfigOverride,
          composeProjectName,
          mainchainVersion: packageJson.dependencies['@argonprotocol/mainchain'],
          genesisHash: client.genesisHash.toHex(),
        };
        await mkdir(Path.dirname(manifestPath), { recursive: true });
        await writeFile(pendingPath, `${JSON.stringify(network, null, 2)}\n`, { mode: 0o600 });
        await rename(pendingPath, manifestPath);
        return network;
      } finally {
        await client.disconnect();
      }
    } catch (error) {
      await started.stop();
      await rm(pendingPath, { force: true });
      throw error;
    }
  } finally {
    await release();
  }
}

export function integrationAccountUri(runId: string, testFile: string, role: string): string {
  const relativeFile = Path.relative(repoRoot, testFile).split(Path.sep).join('/');
  const fileId = createHash('sha256').update(relativeFile).digest('hex').slice(0, 16);
  return `//Alice//${runId}//${fileId}//${role}`;
}

export async function verifyPersistentIntegrationNetwork(
  saved: PersistentIntegrationNetwork,
  expectedProject = integrationComposeProjectName,
): Promise<PersistentIntegrationNetwork> {
  if (saved.composeProjectName !== expectedProject) {
    throw new Error(
      'Integration network metadata belongs to another checkout. Remove e2e/artifacts/integration-network.json and run yarn test:network:start in this checkout.',
    );
  }
  if (saved.mainchainVersion !== packageJson.dependencies['@argonprotocol/mainchain']) {
    throw new Error(
      'The persistent integration network belongs to a different checkout or runtime. Run yarn test:network:stop and yarn test:network:start.',
    );
  }
  try {
    const serviceEndpoints = [
      ['archive-node', '9944', saved.archiveUrl],
      ['archive-rpc', '9944', saved.networkConfigOverride.archiveUrl],
      ['notary', '9925', saved.notaryUrl],
      ['bitcoin-electrs', '3002', saved.networkConfigOverride.esploraHost],
    ];
    if (saved.networkConfigOverride.indexerHost)
      serviceEndpoints.push(['indexer', '3262', saved.networkConfigOverride.indexerHost]);
    const [archiveUrl, archiveRpcUrl, notaryUrl, esploraHost, indexerHost] = await Promise.all(
      serviceEndpoints.map(async ([service, internalPort, url]) => {
        const result = await docker.port(service, internalPort, {
          config: COMPOSE_CONFIG,
          cwd: COMPOSE_DIR,
          env: { ...process.env, COMPOSE_PROJECT_NAME: expectedProject },
        });
        const endpoint = new URL(url);
        endpoint.port = String(result.data.port);
        return endpoint.origin;
      }),
    );
    const network: PersistentIntegrationNetwork = {
      ...saved,
      archiveUrl,
      notaryUrl,
      networkConfigOverride: {
        ...saved.networkConfigOverride,
        archiveUrl: archiveRpcUrl,
        esploraHost,
        ...(indexerHost ? { indexerHost } : {}),
      },
    };
    const response = await fetch(network.archiveUrl.replace(/^ws/, 'http'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chain_getBlockHash', params: [0] }),
      signal: AbortSignal.timeout(10_000),
    });
    const { result } = (await response.json()) as { result?: string };
    if (!response.ok || result !== saved.genesisHash) throw new Error('Genesis does not match');
    return network;
  } catch (error) {
    throw new Error(
      'The persistent integration network is unavailable or has changed. Run yarn test:network:stop and yarn test:network:start.',
      { cause: error },
    );
  }
}
