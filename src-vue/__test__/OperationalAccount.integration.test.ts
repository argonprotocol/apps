import { integrationNetwork as sharedNetwork } from '@argonprotocol/apps-core/__test__/integration.setup.ts';
import { it, beforeAll, afterAll, describe, expect } from 'vitest';
import { sudo, teardown } from '@argonprotocol/testing';
import { type IntegrationNetwork } from '@argonprotocol/apps-core/__test__/integrationNetwork.ts';
import {
  createBitcoinAddress,
  generateBlocks,
  sendBitcoinToAddress,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import { getTestMainchainClient, submitAndFinalize } from '@argonprotocol/apps-core/__test__/helpers/mainchain.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import {
  loadCertificationProgress,
  type ArgonClient,
  MICROGONS_PER_ARGON,
  TreasuryBonds,
  BitcoinFission,
  BitcoinLock,
} from '@argonprotocol/apps-core';
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
  let network: IntegrationNetwork;

  beforeAll(async () => {
    network = sharedNetwork;

    client = await getTestMainchainClient(network.archiveUrl);
  });

  afterAll(async () => {
    await client?.disconnect();
    await teardown();
  });

  it('registers an operational account on the current runtime', async () => {
    const runtimeClient = client!;
    await waitFor(90_000, 'price oracle update', async () => {
      const current = await runtimeClient.query.priceIndex.current();
      if (!current) return;
      if (current.btcUsdPrice.isLessThanOrEqualTo(0)) return;
      if (current.argonUsdPrice.isLessThanOrEqualTo(0)) return;
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
      const { bitcoinLocks, bitcoinLockCreate, myVault, walletKeys } = harness;
      const vault = myVault.createdVault!;

      const satoshis = await bitcoinLocks.satoshisForArgonLiquidity(rewardConfig.treasuryMinimumBitcoin);
      const txInfo = await bitcoinLockCreate.submit({
        vault,
        satoshis,
        txSigner: await walletKeys.getLiquidLockingKeypair(),
      });

      const blockHash = txInfo.tx.blockHash ?? (await txInfo.txResult.waitForInFirstBlock);
      const apiAt = await runtimeClient.at(blockHash);
      const { lock } = await BitcoinLock.getBitcoinLockFromTxResult(apiAt, txInfo.txResult);
      const fundingAddress = BitcoinLocks.formatP2wshAddress(lock.p2wshScriptHashHex, bitcoinLocks.bitcoinNetwork);
      const minerAddress = createBitcoinAddress();
      sendBitcoinToAddress(fundingAddress, lock.securitizedSatoshis);

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
      const transferResultPromise = submitAndFinalize(
        runtimeClient,
        runtimeClient.tx.sudo.sudo(runtimeClient.tx.system.setStorage([[transferTotalsKey, transferTotalsValue]])),
        sudo(),
        { useLatestNonce: true },
      );

      generateBlocks(8, minerAddress);

      await Promise.all([
        transferResultPromise.then(result => result.waitForInFirstBlock),
        waitFor(45_000, 'treasury bitcoin funded', async () => {
          const currentLock = await BitcoinLock.get(runtimeClient, lock.lockId);
          if (!currentLock?.fundedSatoshis) return;
          return currentLock;
        }),
      ]);

      await submitAndFinalize(runtimeClient, bondTx, treasurySigner, { useLatestNonce: true });

      const fissionId = await BitcoinFission.nextId(runtimeClient, walletKeys.treasuryAddress);
      const fissionTx = BitcoinFission.createTx({
        client: runtimeClient,
        fissionId,
        liquidId: fissionId,
        lockId: lock.lockId,
        satoshis: lock.securitizedSatoshis,
        microgonsAtTargetPerBtc: lock.microgonsAtTargetPerBtc,
      });
      await submitAndFinalize(runtimeClient, fissionTx, treasurySigner, {
        useLatestNonce: true,
      });

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
      expect(registered).not.toBeNull();
    } finally {
      await cleanupBitcoinLocksHarness(harness);
    }
  });
});
