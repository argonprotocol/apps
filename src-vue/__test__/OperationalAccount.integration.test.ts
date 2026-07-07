import Path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teardown } from '@argonprotocol/testing';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import { getClient, type ArgonClient } from '@argonprotocol/mainchain';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import { submitAndFinalize } from '@argonprotocol/apps-core/__test__/helpers/mainchain.ts';
import { createTestWallet } from './helpers/wallet.ts';
import { buildOperatorAccountRegistrationTx, loadOperationalAccount } from '../lib/OperationalAccount.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E).sequential('OperationalAccount integration tests', { timeout: 180_000 }, () => {
  let client: ArgonClient | undefined;

  beforeAll(async () => {
    const network = await startArgonTestNetwork(Path.basename(import.meta.filename), {
      profiles: ['miners'],
      chainStartTimeoutMs: 120_000,
      chainStartPollMs: 250,
    });

    client = await getClient(network.archiveUrl);
  });

  afterAll(async () => {
    await client?.disconnect();
    await teardown();
  });

  it('registers an operational account on the current runtime', async () => {
    const runtimeClient = client!;
    const wallet = createTestWallet('//op-register');
    const operationalAccount = await wallet.walletKeys.getOperationalKeypair();

    await sudoFundWallet({
      address: operationalAccount.address,
      microgons: 1_000_000_000n,
      micronots: 0n,
      client: runtimeClient,
    });

    const tx = await buildOperatorAccountRegistrationTx({
      walletKeys: wallet.walletKeys,
      config: { upstreamOperator: null } as any,
      client: runtimeClient,
    });

    expect(tx).toBeTruthy();
    if (!tx) {
      throw new Error('expected operational registration transaction');
    }

    const result = await submitAndFinalize(runtimeClient, tx, operationalAccount);
    expect(result.extrinsicError).toBeUndefined();

    const registered = await loadOperationalAccount(wallet.walletKeys, runtimeClient);
    expect(registered.isSome).toBe(true);
  });
});
