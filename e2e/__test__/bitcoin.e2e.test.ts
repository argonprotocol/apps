import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import Path from 'node:path';
import { createArgonClient } from '@argonprotocol/apps-core';
import { getClient, Keyring } from '@argonprotocol/mainchain';
import { afterAll, describe, it } from 'vitest';
import { resolveReadonlyAccount, writeReadonlyWallet } from '../../scripts/troubleshootAccount.ts';
import { sudoSubmitAndFinalize } from '../../core/__test__/helpers/mainchain.ts';
import { sudoFundWallet } from '../../core/__test__/helpers/sudoFundWallet.ts';
import { createFlowSession, type IFlowSession } from '../flows/session.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E).sequential('Bitcoin Operation Flows', () => {
  describe.sequential('Bitcoin Liquid lifecycle and read-only recovery', () => {
    let session: IFlowSession | undefined;
    let lifecycleCompleted = false;
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
        session = await createFlowSession({
          useTestNetwork: true,
          useDevUpstream: true,
          sessionName: `bitcoin-liquid-spec-${process.pid}-${Date.now()}`,
        });
        await session.run('App.flow.claimDevUpstream');
        await session.run('Bitcoin.flow.liquidCreate', { minimumLockSatoshis: 150_000 });
        lifecycleCompleted = true;
      },
      45 * 60_000,
    );

    it(
      'loads a copied account with its archived Liquid in read-only mode',
      async ({ skip }) => {
        if (!session || !lifecycleCompleted) return skip('The Bitcoin Liquid lifecycle did not complete.');

        await session.checkpointDatabase();
        const readOnlyInstanceName = `${Path.basename(session.appInstanceDirectory)}-copy`;
        readOnlyInstanceDirectory = Path.join(Path.dirname(session.appInstanceDirectory), readOnlyInstanceName);

        mkdirSync(readOnlyInstanceDirectory, { recursive: true });
        for (const filename of ['wallet.json', 'database.sqlite', 'app-version.txt']) {
          const source = Path.join(session.appInstanceDirectory, filename);
          if (existsSync(source)) copyFileSync(source, Path.join(readOnlyInstanceDirectory, filename));
        }

        const wallet = JSON.parse(readFileSync(Path.join(readOnlyInstanceDirectory, 'wallet.json'), 'utf8')) as {
          meta: { ethereumAddress: string };
        };
        await session.loadInstance(readOnlyInstanceName);
        await session.run('App.flow.readOnly', {
          expectedEthereumAddress: wallet.meta.ethereumAddress,
          expectsBitcoinLiquid: true,
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
          await session.run('App.flow.readOnly', {
            expectedDefaultArgonAddress: basicAccountId,
            expectsOperations: false,
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
        if (!session || !lifecycleCompleted) return skip('The Bitcoin Liquid lifecycle did not complete.');

        const sourceWallet = JSON.parse(
          readFileSync(Path.join(session.appInstanceDirectory, 'wallet.json'), 'utf8'),
        ) as {
          meta: {
            vaultingAddress: string;
            miningBotAddress: string;
            operationalAddress: string;
          };
        };
        const generatedInstanceName = `${Path.basename(session.appInstanceDirectory)}-generated`;
        generatedInstanceDirectory = Path.join(Path.dirname(session.appInstanceDirectory), generatedInstanceName);

        const client = createArgonClient(await getClient(session.archiveUrl));
        try {
          await registerOperationalProfile(client, sourceWallet.meta);
          const account = await resolveReadonlyAccount(client, {
            defaultAccountId: sourceWallet.meta.vaultingAddress,
          });
          if (!account.operatorName) throw new Error('The E2E operational account has no operator name.');
          const accountByName = await resolveReadonlyAccount(client, { operatorName: account.operatorName });
          writeReadonlyWallet(generatedInstanceDirectory, accountByName);
        } finally {
          await client.disconnect();
        }

        await session.loadInstance(generatedInstanceName);
        await session.run('App.flow.readOnly', {
          expectedDefaultArgonAddress: sourceWallet.meta.vaultingAddress,
          expectsConfiguredServer: false,
          expectsUpstream: false,
          expectsBitcoinLiquid: true,
        });
      },
      60 * 60_000,
    );
  });

  it(
    'bitcoin lock/unlock',
    async () => {
      const session = await createFlowSession({
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
