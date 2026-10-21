import type { ArgonClient } from '@argonprotocol/apps-core';
import { sudo } from '@argonprotocol/testing';
import { submitAndFinalize } from '../core/__test__/helpers/mainchain.ts';
import { loadOperationalAccount } from '../src-vue/lib/OperationalAccount.ts';
import type { MemoryWalletKeys } from '../src-vue/lib/MemoryWalletKeys.ts';

export async function certifyDevAccount({
  client,
  walletKeys,
}: {
  client: ArgonClient;
  walletKeys: MemoryWalletKeys;
}): Promise<void> {
  const account = await loadOperationalAccount(walletKeys, client);
  if (account?.isOperationallyCertified) return;

  if (account) {
    await submitAndFinalize(
      client,
      client.tx.sudo.sudoAs(walletKeys.operationalAddress, client.tx.operationalAccounts.activate()),
      sudo(),
      { useLatestNonce: true },
    );
    const activated = await loadOperationalAccount(walletKeys, client);
    if (!activated?.isOperationallyCertified) {
      throw new Error(
        'This registered account must finish certification in the app. Use a fresh --profile for the local access shortcut.',
      );
    }
    return;
  }

  const ownerQuery = client.query.operationalAccounts.operationalAccountBySubAccount;
  const subAccounts = [walletKeys.defaultArgonAddress, walletKeys.miningBotAddress];
  const owners = await Promise.all(subAccounts.map(address => ownerQuery(address)));
  if (owners.some(owner => owner && owner !== walletKeys.operationalAddress)) {
    throw new Error('A local user account is already linked to a different operational account.');
  }

  const accountQuery = client.query.operationalAccounts.operationalAccounts;
  // Grant local access without fabricating the assets required by ordinary registration.
  const accountValue = client
    .createType('PalletOperationalAccountsOperationalAccount', {
      vaultAccount: walletKeys.defaultArgonAddress,
      miningAccount: walletKeys.miningBotAddress,
      encryptionPubkey: await walletKeys.getOperationalEncryptionKeypair(),
      isOperationallyCertified: true,
      availableAccessCodes: 1,
    })
    .toHex();
  const storageEntries: [string, string][] = [[accountQuery.key(walletKeys.operationalAddress), accountValue]];
  const ownerValue = client.createType('AccountId', walletKeys.operationalAddress).toHex();
  for (const address of subAccounts) storageEntries.push([ownerQuery.key(address), ownerValue]);
  await submitAndFinalize(client, client.tx.sudo.sudo(client.tx.system.setStorage(storageEntries)), sudo(), {
    useLatestNonce: true,
  });

  const certified = await loadOperationalAccount(walletKeys, client);
  if (!certified?.isOperationallyCertified) throw new Error('The local user did not receive operational access.');
}
