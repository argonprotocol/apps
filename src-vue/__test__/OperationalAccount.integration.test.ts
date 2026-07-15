import Path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sudo, teardown } from '@argonprotocol/testing';
import {
  startArgonTestNetwork,
  type StartedArgonTestNetwork,
} from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import {
  createBitcoinAddress,
  generateBlocks,
  sendBitcoinToAddress,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import { submitAndFinalize } from '@argonprotocol/apps-core/__test__/helpers/mainchain.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import { loadCertificationProgress, MICROGONS_PER_ARGON, TreasuryBonds } from '@argonprotocol/apps-core';
import { BitcoinLock, getClient, TxSubmitter, type ArgonClient } from '@argonprotocol/mainchain';
import type { IConfig } from '../interfaces/IConfig.ts';
import {
  cleanupBitcoinLocksHarness,
  createBitcoinLocksHarness,
  defaultVaultRules,
} from './helpers/bitcoinLocksHarness.ts';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import { Config } from '../lib/Config.ts';
import {
  buildOperatorAccountRegistrationTx,
  getOperationalRewardConfig,
  loadOperationalAccount,
} from '../lib/OperationalAccount.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E).sequential('OperationalAccount integration tests', { timeout: 300_000 }, () => {
  let client: ArgonClient | undefined;
  let network: StartedArgonTestNetwork;
  let previousComposeProjectName: string | undefined;

  beforeAll(async () => {
    network = await startArgonTestNetwork(Path.basename(import.meta.filename), {
      profiles: ['miners', 'price-oracle'],
      chainStartTimeoutMs: 120_000,
      chainStartPollMs: 250,
    });

    client = await getClient(network.archiveUrl);
    previousComposeProjectName = process.env.COMPOSE_PROJECT_NAME;
    process.env.COMPOSE_PROJECT_NAME = network.composeEnv.COMPOSE_PROJECT_NAME;
  });

  afterAll(async () => {
    await client?.disconnect();
    if (previousComposeProjectName === undefined) {
      delete process.env.COMPOSE_PROJECT_NAME;
    } else {
      process.env.COMPOSE_PROJECT_NAME = previousComposeProjectName;
    }
    await teardown();
  });

  it('registers an operational account on the current runtime', async () => {
    const runtimeClient = client!;
    await waitFor(90_000, 'price oracle update', async () => {
      const current = await runtimeClient.query.priceIndex.current();
      if (current.isNone) return;

      const priceIndex = current.unwrap();
      if (priceIndex.btcUsdPrice.toBigInt() <= 0n) return;
      if (priceIndex.argonUsdPrice.toBigInt() <= 0n) return;
      return true;
    });

    const rewardConfig = await getOperationalRewardConfig(runtimeClient);
    const configuredVaultRules = Config.getDefault('vaultingRules') as IConfig['vaultingRules'];
    const vaultRules = {
      ...defaultVaultRules,
      baseMicrogonCommitment: configuredVaultRules.baseMicrogonCommitment,
    };
    const harness = await createBitcoinLocksHarness({
      archiveUrl: network.archiveUrl,
      esploraHost: network.networkConfigOverride.esploraHost,
      network: 'dev-docker',
      vaultRules,
      walletFundingMicrogons:
        vaultRules.baseMicrogonCommitment + rewardConfig.treasuryMinimumBonds + 20n * BigInt(MICROGONS_PER_ARGON),
    });

    try {
      const { bitcoinLocks, myVault, walletKeys } = harness;
      const vault = myVault.createdVault!;

      const satoshis = await bitcoinLocks.satoshisForArgonLiquidity(rewardConfig.treasuryMinimumBitcoin);
      const { txInfo } = await bitcoinLocks.initializeLock({ vault, satoshis });
      expect(txInfo).toBeTruthy();
      if (!txInfo) throw new Error('expected treasury bitcoin lock transaction');

      const blockHash = txInfo.tx.blockHash ?? (await txInfo.txResult.waitForInFirstBlock);
      const apiAt = await runtimeClient.at(blockHash);
      const { lock } = await BitcoinLock.getBitcoinLockFromTxResult(apiAt, txInfo.txResult);
      const fundingAddress = BitcoinLocks.formatP2wshAddress(lock.p2wshScriptHashHex, bitcoinLocks.bitcoinNetwork);
      const minerAddress = createBitcoinAddress();
      sendBitcoinToAddress(fundingAddress, lock.satoshis);

      const bondTx = await TreasuryBonds.buildBuyBondTx({
        client: runtimeClient,
        vaultId: vault.vaultId,
        bondPurchaseMicrogons: rewardConfig.treasuryMinimumBonds,
      });
      const treasurySigner = await walletKeys.getTreasuryKeypair();

      const transferTotalsKey = runtimeClient.query.crosschainTransfer.transferTotalsByAccount.key(
        walletKeys.treasuryAddress,
      );
      const transferTotalsValue = runtimeClient
        .createType('PalletCrosschainTransferAccountTransferTotals', {
          microgonsIn: rewardConfig.treasuryMinimumUniswapTransfer,
          microgonsOut: 0n,
          argonTransfersInCount: 1,
          argonTransfersOutCount: 0,
          micronotsIn: 0n,
          micronotsOut: 0n,
          argonotTransfersInCount: 0,
          argonotTransfersOutCount: 0,
        })
        .toHex();
      const transferResultPromise = new TxSubmitter(
        runtimeClient,
        runtimeClient.tx.sudo.sudo(runtimeClient.tx.system.setStorage([[transferTotalsKey, transferTotalsValue]])),
        sudo(),
      ).submit({ useLatestNonce: true });

      generateBlocks(8, minerAddress);

      await Promise.all([
        transferResultPromise.then(result => result.waitForInFirstBlock),
        waitFor(45_000, 'treasury bitcoin funded', async () => {
          const currentLock = await BitcoinLock.get(runtimeClient, lock.utxoId);
          if (!currentLock?.isFunded) return;
          return currentLock;
        }),
      ]);

      const bondResult = await new TxSubmitter(runtimeClient, bondTx, treasurySigner).submit({ useLatestNonce: true });
      await bondResult.waitForInFirstBlock;

      const certification = await loadCertificationProgress({
        client: runtimeClient,
        defaultAccountId: walletKeys.treasuryAddress,
      });
      expect(certification.isTreasuryCertified).toBe(true);

      const tx = await buildOperatorAccountRegistrationTx({
        walletKeys,
        accessProof: null,
        client: runtimeClient,
      });

      expect(tx).toBeTruthy();
      if (!tx) throw new Error('expected operational registration transaction');

      const result = await submitAndFinalize(runtimeClient, tx, treasurySigner);
      expect(result.extrinsicError).toBeUndefined();

      const registered = await loadOperationalAccount(walletKeys, runtimeClient);
      expect(registered.isSome).toBe(true);
    } finally {
      await cleanupBitcoinLocksHarness(harness);
    }
  });
});
