import { readFile, rm } from 'node:fs/promises';
import Path from 'node:path';
import { stopArgonTestNetwork } from '../core/__test__/startArgonTestNetwork.ts';
import {
  integrationComposeProjectName,
  integrationNetworkManifestPath,
  startIntegrationNetwork,
  type PersistentIntegrationNetwork,
} from '../core/__test__/integrationNetwork.ts';

const command = process.argv[2];
if (command === 'start') {
  const network = await startIntegrationNetwork();
  console.log(
    `Integration network ready at ${network.archiveUrl}. Run yarn test:integration; yarn test:network:stop removes it.`,
  );
} else if (command === 'stop') {
  const saved = await readFile(integrationNetworkManifestPath, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (
    saved &&
    (JSON.parse(saved) as PersistentIntegrationNetwork).composeProjectName !== integrationComposeProjectName
  ) {
    throw new Error('Integration network metadata belongs to a different checkout.');
  }
  await stopArgonTestNetwork(integrationComposeProjectName, { profiles: ['bob', 'price-oracle'] });
  await rm(integrationNetworkManifestPath, { force: true });
  await rm(
    Path.join(Path.dirname(integrationNetworkManifestPath), 'integration-locks', integrationComposeProjectName),
    { recursive: true, force: true },
  );
  console.log('Integration network removed.');
} else {
  throw new Error('Use yarn test:network:start or yarn test:network:stop.');
}
