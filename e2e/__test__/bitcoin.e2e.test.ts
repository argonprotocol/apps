import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';
import Path from 'node:path';
import { createArgonClient, SATOSHIS_PER_BITCOIN } from '@argonprotocol/apps-core';
import { getClient, Keyring } from '@argonprotocol/mainchain';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveReadonlyAccount, writeReadonlyWallet } from '../../scripts/troubleshootAccount.ts';
import { sudoSubmitAndFinalize } from '../../core/__test__/helpers/mainchain.ts';
import { sudoFundWallet } from '../../core/__test__/helpers/sudoFundWallet.ts';
import { FlowSession } from '../FlowSession.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));
describe.skipIf(skipE2E).sequential('Bitcoin Operation Flows', () => {
  describe.sequential('Bitcoin Liquid lifecycle and read-only recovery', () => {
    let session: FlowSession | undefined;
    let lifecycleCompleted = false;
    let liquidInstanceDirectory: string | undefined;
    let readOnlyInstanceDirectory: string | undefined;
    let basicInstanceDirectory: string | undefined;
    let generatedInstanceDirectory: string | undefined;

    afterAll(async () => {
      try {
        await session?.close();
      } finally {
        if (readOnlyInstanceDirectory) rmSync(readOnlyInstanceDirectory, { recursive: true, force: true });
        if (basicInstanceDirectory) rmSync(basicInstanceDirectory, { recursive: true, force: true });
        if (generatedInstanceDirectory) rmSync(generatedInstanceDirectory, { recursive: true, force: true });
      }
    });

    it(
      'creates, ratchets, and closes a Liquid',
      async () => {
        session = await FlowSession.start({
          useTestNetwork: true,
          useDevUpstream: true,
          sessionName: `bitcoin-liquid-spec-${process.pid}-${Date.now()}`,
        });
        await session.run('App.flow.claimDevUpstream');
        await session.run('Bitcoin.flow.liquidCreate', { minimumLockSatoshis: 150_000 });
        liquidInstanceDirectory = session.appInstanceDirectory;
        lifecycleCompleted = true;
      },
      45 * 60_000,
    );

    it(
      'loads a copied account with its archived Liquid and cash-flow return in read-only mode',
      async ({ skip }) => {
        if (!session || !lifecycleCompleted) return skip('The Bitcoin Liquid lifecycle did not complete.');

        const readOnlyInstanceName = `${Path.basename(session.appInstanceDirectory)}-copy`;
        readOnlyInstanceDirectory = Path.join(Path.dirname(session.appInstanceDirectory), readOnlyInstanceName);

        mkdirSync(readOnlyInstanceDirectory, { recursive: true });
        for (const filename of ['wallet.json', 'app-version.txt']) {
          const source = Path.join(session.appInstanceDirectory, filename);
          if (existsSync(source)) copyFileSync(source, Path.join(readOnlyInstanceDirectory, filename));
        }
        const sourceDatabase = new DatabaseSync(Path.join(session.appInstanceDirectory, 'database.sqlite'), {
          open: true,
          readOnly: true,
          timeout: 30_000,
        });
        const copiedDatabasePath = Path.join(readOnlyInstanceDirectory, 'database.sqlite');
        try {
          await backup(sourceDatabase, copiedDatabasePath);
        } finally {
          sourceDatabase.close();
        }
        const expectedBitcoinReturnPercentByLiquidId = readLiquidReturnFromHistory(copiedDatabasePath);

        const wallet = JSON.parse(readFileSync(Path.join(readOnlyInstanceDirectory, 'wallet.json'), 'utf8')) as {
          meta: { ethereumAddress: string };
        };
        await session.loadInstance(readOnlyInstanceName);
        await session.run('App.flow.accountReview', {
          expectedEthereumAddress: wallet.meta.ethereumAddress,
          expectsBitcoinLiquid: true,
          expectedArchivedBitcoinLiquidIds: Object.keys(expectedBitcoinReturnPercentByLiquidId).map(Number),
          expectedBitcoinReturnPercentByLiquidId,
        });
      },
      15 * 60_000,
    );

    it(
      'loads a basic account in read-only mode',
      async ({ skip }) => {
        if (!session || !lifecycleCompleted) return skip('The Bitcoin Liquid lifecycle did not complete.');

        const basicInstanceName = `${Path.basename(session.appInstanceDirectory)}-basic`;
        basicInstanceDirectory = Path.join(Path.dirname(session.appInstanceDirectory), basicInstanceName);
        const client = createArgonClient(await getClient(session.archiveUrl));

        try {
          const basicAccountId = new Keyring({ type: 'sr25519' }).addFromUri(`//ReadonlyBasic//${process.pid}`).address;
          await sudoFundWallet({
            client,
            address: basicAccountId,
            microgons: 5_000_000n,
            micronots: 0n,
          });
          const basicAccount = await resolveReadonlyAccount(client, { defaultAccountId: basicAccountId });
          writeReadonlyWallet(basicInstanceDirectory, basicAccount);

          await session.loadInstance(basicInstanceName);
          await session.run('App.flow.accountReview', {
            expectedDefaultArgonAddress: basicAccountId,
            expectsOperations: false,
            expectsTreasury: false,
            expectsConfiguredServer: false,
            expectsUpstream: false,
            expectsVault: false,
          });
        } finally {
          await client.disconnect();
        }
      },
      15 * 60_000,
    );

    it(
      'recovers the archived Liquid for a wallet-only operational account',
      async ({ skip }) => {
        if (!session || !lifecycleCompleted || !liquidInstanceDirectory)
          return skip('The Bitcoin Liquid lifecycle did not complete.');

        const sourceWallet = JSON.parse(readFileSync(Path.join(liquidInstanceDirectory, 'wallet.json'), 'utf8')) as {
          meta: {
            vaultingAddress: string;
            miningBotAddress: string;
            operationalAddress: string;
          };
        };
        const generatedInstanceName = `${Path.basename(session.appInstanceDirectory)}-generated`;
        generatedInstanceDirectory = Path.join(Path.dirname(session.appInstanceDirectory), generatedInstanceName);
        let historyThroughBlock = 0;

        const client = createArgonClient(await getClient(session.archiveUrl));
        try {
          await registerOperationalProfile(client, sourceWallet.meta);
          const account = await resolveReadonlyAccount(client, {
            defaultAccountId: sourceWallet.meta.vaultingAddress,
          });
          if (!account.operatorName) throw new Error('The E2E operational account has no operator name.');
          const accountByName = await resolveReadonlyAccount(client, { operatorName: account.operatorName });
          writeReadonlyWallet(generatedInstanceDirectory, accountByName);
          const finalizedHead = await client.rpc.chain.getFinalizedHead();
          historyThroughBlock = (await client.rpc.chain.getHeader(finalizedHead)).number.toNumber();
        } finally {
          await client.disconnect();
        }

        await session.loadInstance(generatedInstanceName);
        const historyRecovery = await session.recoverAccountHistory(historyThroughBlock);
        await session.run('App.flow.accountReview', {
          expectedDefaultArgonAddress: sourceWallet.meta.vaultingAddress,
          expectsConfiguredServer: false,
          expectsUpstream: false,
          expectsBitcoinLiquid: true,
        });
        expect(historyRecovery.throughBlock).toBe(historyThroughBlock);
        expect(historyRecovery.walletHistory.asOfBlock).toBeGreaterThanOrEqual(historyThroughBlock);
        expect(historyRecovery.financialHistory.accountId).toBe(sourceWallet.meta.vaultingAddress);
        expect(historyRecovery.financialHistory.asOfBlock).toBeGreaterThanOrEqual(historyThroughBlock);
        const { domainCheckpoints } = historyRecovery.financialHistory;
        if (!domainCheckpoints) throw new Error('Financial recovery did not return domain checkpoints');
        expect(Object.keys(domainCheckpoints).sort()).toEqual(['bitcoin', 'bonds', 'vaulting']);
        for (const checkpoint of Object.values(domainCheckpoints)) {
          expect(checkpoint.asOfBlock).toBeGreaterThanOrEqual(historyThroughBlock);
        }
      },
      60 * 60_000,
    );
  });

  it(
    'bitcoin lock/unlock',
    async () => {
      const session = await FlowSession.start({
        useTestNetwork: true,
        useDevUpstream: true,
        sessionName: 'bitcoin-spec-Bitcoin.flow.lockUnlock',
      });

      try {
        await session.run('App.flow.claimDevUpstream');
        await session.run('Bitcoin.flow.lockUnlock');
      } finally {
        await session.close();
      }
    },
    45 * 60_000,
  );
});

function readLiquidReturnFromHistory(databasePath: string): Record<number, number> {
  // This isolated scenario has one Fission and one upward ratchet. Calculate
  // its return from durable cash-flow facts, without reading a financial position.
  const db = new DatabaseSync(databasePath, { open: true, readOnly: true });
  try {
    const fissions = db
      .prepare(
        `SELECT ownerAccount, fissionId, liquidId, lockId, satoshis, redemptionAmount, closeTxFee
         FROM BitcoinFissions WHERE origin = 'created' AND closedAtArgonBlock IS NOT NULL`,
      )
      .all() as {
      ownerAccount: string;
      fissionId: number;
      liquidId: number;
      lockId: number;
      satoshis: string;
      redemptionAmount: string | null;
      closeTxFee: string | null;
    }[];
    expect(fissions).toHaveLength(1);
    const [fission] = fissions;
    if (fission.redemptionAmount == null || fission.closeTxFee == null) {
      throw new Error('The archived Liquid has no recorded redemption or closing transaction fee');
    }

    const ratchets = db
      .prepare(
        `SELECT sourceRatchetIndex, microgonsAtTargetPerBtc, liquidityPromised,
                amountMinted, amountBurned, mintPending, txFee
         FROM BitcoinFissionRatchets WHERE ownerAccount = ? AND fissionId = ?
         ORDER BY sourceRatchetIndex`,
      )
      .all(fission.ownerAccount, fission.fissionId) as {
      sourceRatchetIndex: number;
      microgonsAtTargetPerBtc: string;
      liquidityPromised: string;
      amountMinted: string;
      amountBurned: string;
      mintPending: string;
      txFee: string | null;
    }[];
    expect(ratchets.map(ratchet => ratchet.sourceRatchetIndex)).toEqual([0, 1]);
    if (ratchets.some(ratchet => ratchet.txFee == null)) {
      throw new Error('The archived Liquid has incomplete transaction fees');
    }
    if (
      ratchets.some(
        ratchet => BigInt(ratchet.mintPending) < 0n || BigInt(ratchet.mintPending) > BigInt(ratchet.amountMinted),
      )
    ) {
      throw new Error('The archived Liquid has invalid pending mint state');
    }
    const lock = db
      .prepare('SELECT securityFees, couponFeesPaid FROM BitcoinLocks WHERE lockId = ?')
      .get(fission.lockId) as { securityFees: string | null; couponFeesPaid: string | null } | undefined;
    if (!lock || lock.securityFees == null || lock.couponFeesPaid == null) {
      throw new Error('The archived Liquid has no recorded lock fees or coupon');
    }

    const openingBasis =
      (BigInt(ratchets[0].microgonsAtTargetPerBtc) * BigInt(fission.satoshis)) / SATOSHIS_PER_BITCOIN;
    if (openingBasis <= 0n) throw new Error('The archived Liquid has no opening basis');
    const unlocked = BigInt(ratchets[1].liquidityPromised) - BigInt(ratchets[0].liquidityPromised);
    if (unlocked <= 0n) throw new Error('The expected upward ratchet did not unlock liquidity');
    const received = ratchets.reduce((amount, ratchet) => {
      return amount + BigInt(ratchet.amountMinted) - BigInt(ratchet.mintPending) - BigInt(ratchet.amountBurned);
    }, 0n);
    const pending = ratchets.reduce((amount, ratchet) => amount + BigInt(ratchet.mintPending), 0n);
    const actionFees = ratchets.reduce((amount, ratchet) => amount + BigInt(ratchet.txFee!), 0n);
    const netSecurityFee = BigInt(lock.securityFees) - BigInt(lock.couponFeesPaid);
    if (netSecurityFee < 0n) throw new Error('The archived Liquid has more coupon credit than security fees');
    const fees = actionFees + BigInt(fission.closeTxFee) + netSecurityFee;
    const profit = unlocked + received + pending - BigInt(fission.redemptionAmount) - fees;
    return { [fission.liquidId]: Number((profit * 100_000n) / openingBasis) / 1_000 };
  } finally {
    db.close();
  }
}

async function registerOperationalProfile(
  client: Awaited<ReturnType<typeof createArgonClient>>,
  addresses: {
    vaultingAddress: string;
    miningBotAddress: string;
    operationalAddress: string;
  },
): Promise<void> {
  const operationalAccount = client.createType('PalletOperationalAccountsOperationalAccount', {
    vaultAccount: addresses.vaultingAddress,
    miningAccount: addresses.miningBotAddress,
    encryptionPubkey: new Uint8Array(32),
    upstreamAccount: null,
    name: 'ReadonlyE2e',
    lastNameChangeTick: null,
    uniswapArgonTransfersInAmount: 0n,
    accountBitcoinAmount: 0n,
    accountVaultBondAmount: 0n,
    vaultCreated: true,
    vaultBitcoinAccrual: 0n,
    vaultBitcoinAppliedTotal: 0n,
    miningSeatAccrual: 0,
    miningSeatAppliedTotal: 0,
    operationalCertificationsCount: 0,
    availableAccessCodes: 0,
    rewardsEarnedCount: 0,
    rewardsEarnedAmount: 0n,
    rewardsCollectedAmount: 0n,
    isOperationallyCertified: false,
  });
  const operationalAccountId = client.createType('AccountId32', addresses.operationalAddress).toHex();
  const storage: [string, string][] = [
    [
      client.query.operationalAccounts.operationalAccounts.key(addresses.operationalAddress),
      operationalAccount.toHex(),
    ],
    [
      client.query.operationalAccounts.operationalAccountBySubAccount.key(addresses.vaultingAddress),
      operationalAccountId,
    ],
    [
      client.query.operationalAccounts.operationalAccountBySubAccount.key(addresses.miningBotAddress),
      operationalAccountId,
    ],
  ];

  await sudoSubmitAndFinalize(client, client.tx.system.setStorage(storage));
}
