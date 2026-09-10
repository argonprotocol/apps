import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import Path from 'node:path';
import { createArgonClient } from '@argonprotocol/apps-core';
import { getClient, Keyring } from '@argonprotocol/mainchain';
import { describe, it } from 'vitest';
import { createFlowSession, type IFlowSession } from '../flows/session.ts';
import { resolveReadonlyAccount, writeReadonlyWallet } from '../../scripts/troubleshootAccount.ts';
import { sudoSubmitAndFinalize } from '../../core/__test__/helpers/mainchain.ts';
import { sudoFundWallet } from '../../core/__test__/helpers/sudoFundWallet.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E)('Read-only account', () => {
  it(
    'loads basic, copied, and wallet-only operational accounts in readonly mode',
    async () => {
      const session: IFlowSession = await createFlowSession({
        useTestNetwork: true,
        useDevUpstream: true,
        sessionName: `read-only-spec-${process.pid}-${Date.now()}`,
      });
      const readOnlyInstanceName = `${Path.basename(session.appInstanceDirectory)}-copy`;
      const readOnlyInstanceDirectory = Path.join(Path.dirname(session.appInstanceDirectory), readOnlyInstanceName);
      const generatedInstanceName = `${Path.basename(session.appInstanceDirectory)}-generated`;
      const generatedInstanceDirectory = Path.join(Path.dirname(session.appInstanceDirectory), generatedInstanceName);
      const basicInstanceName = `${Path.basename(session.appInstanceDirectory)}-basic`;
      const basicInstanceDirectory = Path.join(Path.dirname(session.appInstanceDirectory), basicInstanceName);

      try {
        await session.run('App.flow.claimDevUpstream');
        await session.run('Bitcoin.flow.liquidCreate');
        await session.checkpointDatabase();

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

        const sourceWallet = JSON.parse(
          readFileSync(Path.join(session.appInstanceDirectory, 'wallet.json'), 'utf8'),
        ) as {
          meta: {
            vaultingAddress: string;
            miningBotAddress: string;
            operationalAddress: string;
          };
        };
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
      } finally {
        await session.close();
        rmSync(readOnlyInstanceDirectory, { recursive: true, force: true });
        rmSync(generatedInstanceDirectory, { recursive: true, force: true });
        rmSync(basicInstanceDirectory, { recursive: true, force: true });
      }
    },
    60 * 60_000,
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
