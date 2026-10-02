import { aroundAll, aroundEach, inject, TestRunner } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import Path from 'node:path';
import docker from 'docker-compose';
import { getTests } from '@vitest/runner/utils';
import { acquireIntegrationLock, acquireIntegrationNetworkAccess } from './helpers/locks.ts';
import { waitFor } from './helpers/waitFor.ts';
import { COMPOSE_CONFIG, COMPOSE_DIR } from './startArgonTestNetwork.ts';
import { Keyring } from '@argonprotocol/mainchain';
import { NetworkConfig } from '../src/NetworkConfig.ts';
import { getTestMainchainClient, sudoSubmitAndFinalize } from './helpers/mainchain.ts';
import {
  integrationAccountUri,
  integrationSession,
  startIntegrationNetwork,
  verifyPersistentIntegrationNetwork,
  type PersistentIntegrationNetwork,
  type IntegrationNetwork,
} from './integrationNetwork.ts';

export let integrationNetwork: IntegrationNetwork;
const file = TestRunner.getCurrentSuite().file;
let releaseNetworkAccess: (() => Promise<void>) | undefined;

aroundAll(async runSuite => {
  const tests = getTests(file).filter(test => test.mode === 'run' || test.mode === 'only');
  if (
    !tests.length ||
    tests.every(test => test.tags?.some(tag => tag === 'no-argon-network' || tag === 'isolated-argon-network'))
  ) {
    await runSuite();
    return;
  }
  if (tests.some(test => test.tags?.includes('exclusive-argon-network')) && tests.some(test => test.concurrent)) {
    throw new Error('Tests with exclusive network access must use a sequential suite.');
  }
  const session = inject('argonIntegrationSession');
  await integrationSession.run(session, async () => {
    let releaseAuction: (() => Promise<void>) | undefined;
    try {
      const controlsAuction = tests.some(test => test.tags?.includes('mining-auction'));
      if (controlsAuction) releaseAuction = await acquireIntegrationLock('mining-auction', session.lockDirectory);
      releaseNetworkAccess = await acquireIntegrationNetworkAccess('shared', session.lockDirectory);
      const network = session.borrowed
        ? await verifyPersistentIntegrationNetwork(
            JSON.parse(await readFile(session.manifestPath, 'utf8')) as PersistentIntegrationNetwork,
            session.composeProjectName,
          )
        : await startIntegrationNetwork(session.manifestPath, session.composeProjectName);
      NetworkConfig.setNetwork('dev-docker');
      const client = await getTestMainchainClient(network.archiveUrl);
      try {
        await NetworkConfig.updateConfig(client);
        NetworkConfig.setRuntimeOverride('dev-docker', network.networkConfigOverride);
        const account = new Keyring({ type: 'sr25519' }).addFromUri(
          integrationAccountUri(inject('argonIntegrationRunId'), file.filepath, 'funded'),
        );
        const fundingCalls = [client.tx.balances.forceSetBalance(account.address, 500_000_000n)];
        if (controlsAuction) {
          const stakePerSeat = await client.query.miningSlot.argonotsPerMiningSeat();
          const maximumSeats = BigInt(client.consts.mint.maxPossibleMiners.toNumber());
          fundingCalls.push(client.tx.ownership.forceSetBalance(account.address, stakePerSeat * maximumSeats));
        }
        const result = await sudoSubmitAndFinalize(client, client.tx.utility.batchAll(fundingCalls), {
          useLatestNonce: true,
        });
        if (result.extrinsicError) throw result.extrinsicError;
        integrationNetwork = network;
      } finally {
        await client.disconnect();
      }
      await runSuite();
    } finally {
      try {
        await releaseNetworkAccess?.();
      } finally {
        await releaseAuction?.();
      }
    }
  });
}, 16 * 60_000);

aroundEach(async (runTest, { task }) => {
  const session = integrationSession.getStore();
  if (!session) {
    await runTest();
    return;
  }
  if (!task.tags?.includes('exclusive-argon-network')) {
    releaseNetworkAccess ??= await acquireIntegrationNetworkAccess('shared', session.lockDirectory);
    await runTest();
    return;
  }

  await releaseNetworkAccess?.();
  releaseNetworkAccess = undefined;
  const releaseExclusive = await acquireIntegrationNetworkAccess('exclusive', session.lockDirectory);
  try {
    const composeOptions = {
      cwd: COMPOSE_DIR,
      config: COMPOSE_CONFIG,
      env: { ...process.env, COMPOSE_PROJECT_NAME: session.composeProjectName },
    };
    const client = await getTestMainchainClient(integrationNetwork.archiveUrl);
    try {
      const before = await client.at(await client.rpc.chain.getFinalizedHead());
      const [originalPrice, rateHistory] = await Promise.all([
        before.query.priceIndex.current(),
        before.query.bitcoinLocks.microgonPerBtcHistory(),
      ]);
      const originalRate = rateHistory?.at(-1)?.[1];
      if (!originalPrice || originalRate === undefined) {
        throw new Error('Exclusive integration tests require a published Bitcoin price.');
      }

      await docker.pauseOne('oracle-price', composeOptions);
      try {
        await runTest();
      } finally {
        try {
          await docker.unpauseOne('oracle-price', composeOptions);
          await waitFor(90_000, 'shared price oracle to resume after exclusive test', async () => {
            const after = await client.at(await client.rpc.chain.getFinalizedHead());
            const [price, history] = await Promise.all([
              after.query.priceIndex.current(),
              after.query.bitcoinLocks.microgonPerBtcHistory(),
            ]);
            if (
              !price ||
              !price.btcUsdPrice.isEqualTo(originalPrice.btcUsdPrice) ||
              !price.argonUsdPrice.isEqualTo(originalPrice.argonUsdPrice) ||
              !price.argonUsdTargetPrice.isEqualTo(originalPrice.argonUsdTargetPrice) ||
              (originalPrice.argonotUsdPrice && !price.argonotUsdPrice?.isEqualTo(originalPrice.argonotUsdPrice)) ||
              history?.at(-1)?.[1] !== originalRate
            )
              return;
            return true;
          });
        } catch (error) {
          await writeFile(
            Path.join(session.lockDirectory, 'network-unavailable'),
            'Price oracle did not resume after exclusive integration test.\n',
          );
          throw error;
        }
      }
    } finally {
      await client.disconnect();
    }
  } finally {
    await releaseExclusive();
    releaseNetworkAccess = await acquireIntegrationNetworkAccess('shared', session.lockDirectory);
  }
}, 16 * 60_000);
