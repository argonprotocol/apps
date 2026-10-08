import { u8aToHex } from '@argonprotocol/mainchain';
import {
  AccountActivityKind,
  getVaultByOperator,
  type Vault,
  MainchainClients,
  StorageFinder,
  TransactionEvents,
} from '@argonprotocol/apps-core';
import { TICK_MILLIS } from '../Env.ts';
import bs58check from 'bs58check';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import { hexToU8a } from '@polkadot/util';
import { DEFAULT_MASTER_XPUB_PATH } from '../MyVault.ts';
import { WalletKeys } from '../WalletKeys.ts';
import { findAddressActivity } from '../IndexerClient.ts';
import type { HistoricalQueryRecord } from '@argonprotocol/runtime-client';

export class MyVaultRecovery {
  public static async findOperatorVault(
    mainchainClients: MainchainClients,
    bitcoinNetwork: BitcoinNetwork,
    walletKeys: WalletKeys,
  ): Promise<{ vault: Vault; masterXpubPath: string; createBlockNumber: number; txFee: bigint } | undefined> {
    const client = await mainchainClients.archiveClientPromise;

    const vaultingAddress = walletKeys.vaultingAddress;
    const vault = await getVaultByOperator({
      client,
      operatorAddress: vaultingAddress,
      tickDurationMillis: TICK_MILLIS,
    });
    if (!vault) return;
    const vaultId = vault.vaultId;

    const storedXpubMaybe = await client.query.vaults.vaultXPubById(vaultId);
    const masterXpubPath = walletKeys.canSign
      ? await this.recoverXpubPath({
          vaultId,
          storedXpubMaybe,
          walletKeys,
          bitcoinNetwork,
        })
      : DEFAULT_MASTER_XPUB_PATH;
    console.log('Recovered vault xpub path:', masterXpubPath);

    const findVaultCreation = (blockHash: Uint8Array) => {
      return TransactionEvents.findFromFeePaidEvent({
        client,
        accountAddress: vaultingAddress,
        blockHash,
        isMatchingEvent(event) {
          return event.section === 'vaults' && event.method === 'VaultCreated' && event.data.vaultId === vaultId;
        },
      });
    };

    let vaultStartBlock: { blockNumber: number; blockHash: Uint8Array } | undefined;
    let vaultCreateFee = 0n;
    try {
      const indexedActivity = await findAddressActivity(vaultingAddress, {
        activityMask: AccountActivityKind.VaultPosition,
      });
      if (indexedActivity.coverage.gaps.length) {
        throw new Error(indexedActivity.coverage.gaps[0].reason);
      }

      const indexedCreation = indexedActivity.blocks.at(0);
      if (indexedCreation) {
        const candidate = {
          blockNumber: indexedCreation.blockNumber,
          blockHash: hexToU8a(indexedCreation.blockHash),
        };
        const result = await findVaultCreation(candidate.blockHash);
        if (result) {
          vaultStartBlock = candidate;
          vaultCreateFee = result.fee;
        }
      }
    } catch (error) {
      console.warn('Unable to find indexed vault creation block:', error);
    }

    if (!vaultStartBlock) {
      const vaultCreateKey = client.query.vaults.vaultsById.key(vaultId);
      vaultStartBlock = await StorageFinder.binarySearchForStorageAddition(mainchainClients, vaultCreateKey).catch(
        error => {
          console.warn('Unable to find vault creation block:', error);
          return undefined;
        },
      );
      if (vaultStartBlock) {
        vaultCreateFee = (await findVaultCreation(vaultStartBlock.blockHash))?.fee ?? 0n;
      }
    }

    console.log('Look for vault create at block:', vaultStartBlock?.blockNumber ?? 'not found');
    const vaultCreateBlockNumber = vaultStartBlock?.blockNumber ?? 0;
    return {
      masterXpubPath,
      createBlockNumber: vaultCreateBlockNumber,
      txFee: vaultCreateFee,
      vault,
    };
  }

  private static async recoverXpubPath(param: {
    bitcoinNetwork: BitcoinNetwork;
    vaultId: number;
    storedXpubMaybe: HistoricalQueryRecord<'vaults', 'vaultXPubById'>;
    walletKeys: WalletKeys;
  }) {
    const { walletKeys, storedXpubMaybe, vaultId } = param;
    const masterXpubPath = DEFAULT_MASTER_XPUB_PATH;
    const vaultXpriv = await walletKeys.getBitcoinChildXpriv(masterXpubPath, param.bitcoinNetwork);
    const masterXpub = vaultXpriv.publicExtendedKey;
    if (!storedXpubMaybe) throw new Error(`Vault with id ${vaultId} xpub not found`);
    const storedXpubPubkey = storedXpubMaybe[0].publicKey.replace('0x', '');
    const expectedXpubHex = u8aToHex(bs58check.decode(masterXpub), undefined, false);
    if (!expectedXpubHex.includes(storedXpubPubkey)) {
      throw new Error(
        `Vault xpub master ${expectedXpubHex} doesn't contain the expected public key ${storedXpubPubkey}.`,
      );
    }

    return masterXpubPath;
  }
}
