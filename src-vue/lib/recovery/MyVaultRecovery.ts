import { ITuple, Option, U8aFixed, u8aToHex, Vault } from '@argonprotocol/mainchain';
import { IVaultingRules } from '../../interfaces/IVaultingRules.ts';
import BigNumber from 'bignumber.js';
import BitcoinLocks from '../BitcoinLocks.ts';
import { AccountActivityKind, MainchainClients, StorageFinder, TransactionEvents } from '@argonprotocol/apps-core';
import { TICK_MILLIS } from '../Env.ts';
import { Config } from '../Config.ts';
import bs58check from 'bs58check';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import { hexToU8a } from '@polkadot/util';
import type { IBitcoinLockRecord } from '../db/BitcoinLocksTable.ts';
import { DEFAULT_MASTER_XPUB_PATH } from '../MyVault.ts';
import { WalletKeys } from '../WalletKeys.ts';
import { findAddressActivity } from '../IndexerClient.ts';

export class MyVaultRecovery {
  public static rebuildRules(args: {
    feesInMicrogons: bigint;
    vault: Pick<Vault, 'securitization' | 'securitizationRatio' | 'terms'>;
    treasuryMicrogons?: bigint;
    bitcoin?: { liquidityPromised: bigint };
  }): IVaultingRules {
    const { vault, treasuryMicrogons = 0n, bitcoin = { liquidityPromised: 0n } } = args;

    const securitization = vault.securitization;
    const securitizationRatio = vault.securitizationRatio;
    const baseMicrogonCommitment = securitization + treasuryMicrogons;
    let capitalForSecuritizationPct = 100;
    if (baseMicrogonCommitment > 0n) {
      capitalForSecuritizationPct = BigNumber(securitization)
        .div(baseMicrogonCommitment)
        .times(100)
        .decimalPlaces(1, BigNumber.ROUND_HALF_EVEN)
        .toNumber();
    }

    const capitalForTreasuryPct = 100 - capitalForSecuritizationPct;
    const profitSharingPct = vault.terms.treasuryProfitSharing.times(100).toNumber();
    const btcFlatFee = vault.terms.bitcoinBaseFee;
    const btcPctFee = vault.terms.bitcoinAnnualPercentRate.times(100).toNumber();

    let personalBtcPct = 0;
    if (securitization > 0n) {
      personalBtcPct = BigNumber(bitcoin.liquidityPromised)
        .dividedBy(securitization)
        .times(100)
        .integerValue(BigNumber.ROUND_CEIL)
        .toNumber();
    }

    return {
      ...(Config.getDefault('vaultingRules') as IVaultingRules),
      capitalForSecuritizationPct,
      capitalForTreasuryPct,
      profitSharingPct,
      securitizationRatio,
      btcPctFee,
      btcFlatFee,
      baseMicrogonCommitment,
      personalBtcPct,
    };
  }

  public static async findOperatorVault(
    mainchainClients: MainchainClients,
    bitcoinNetwork: BitcoinNetwork,
    walletKeys: WalletKeys,
  ): Promise<{ vault: Vault; masterXpubPath: string; createBlockNumber: number; txFee: bigint } | undefined> {
    const client = await mainchainClients.archiveClientPromise;

    const vaultingAddress = walletKeys.vaultingAddress;
    const vaultIdMaybe = await client.query.vaults.vaultIdByOperator(vaultingAddress);
    if (vaultIdMaybe.isNone) return;
    const vaultId = vaultIdMaybe.unwrap().toNumber();
    const vaultRaw = await client.query.vaults.vaultsById(vaultId);

    if (vaultRaw.isNone) throw new Error(`Vault with id ${vaultId} not found`);
    const vault = new Vault(vaultId, vaultRaw.value, TICK_MILLIS);

    const storedXpubMaybe = await client.query.vaults.vaultXPubById(vaultId);
    const masterXpubPath = await this.recoverXpubPath({
      vaultId,
      storedXpubMaybe,
      walletKeys,
      bitcoinNetwork,
    });
    console.log('Recovered vault xpub path:', masterXpubPath);

    const findVaultCreation = (blockHash: Uint8Array) => {
      return TransactionEvents.findFromFeePaidEvent({
        client,
        accountAddress: vaultingAddress,
        blockHash,
        isMatchingEvent(event) {
          if (!client.events.vaults.VaultCreated.is(event)) return false;
          return event.data.vaultId.toNumber() === vaultId;
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

  public static async recoverPersonalBitcoin(args: {
    mainchainClients: MainchainClients;
    bitcoinLocks: BitcoinLocks;
    vaultSetupBlockNumber: number;
    vault: Vault;
  }): Promise<(IBitcoinLockRecord & { initializedAtBlockNumber: number })[]> {
    const { mainchainClients, bitcoinLocks, vault, vaultSetupBlockNumber } = args;
    const vaultingAddress = vault.operatorAccountId;
    const vaultId = vault.vaultId;
    const client = await mainchainClients.archiveClientPromise;
    const bitcoins = await client.query.bitcoinLocks.locksByUtxoId.entries();
    const myBitcoins = bitcoins.filter(([, lockMaybe]) => {
      if (!lockMaybe.isSome) return false;
      if (lockMaybe.value.vaultId.toNumber() !== vaultId) return false;
      return lockMaybe.value.ownerAccount.toHuman() === vaultingAddress;
    });

    const records: (IBitcoinLockRecord & { initializedAtBlockNumber: number })[] = [];
    const table = await bitcoinLocks.getTable();

    for (const [utxoId] of myBitcoins) {
      const existingInDb = await table.getByUtxoId(utxoId.args[0].toNumber());
      if (existingInDb) {
        records.push({ ...existingInDb, initializedAtBlockNumber: existingInDb.ratchets[0].blockHeight });
        continue;
      }

      const lock = await bitcoinLocks.getFromApi(utxoId.args[0].toNumber());
      let bitcoinTxAddition: { blockHash: Uint8Array; blockNumber: number } | undefined;
      if (lock.createdAtArgonBlock > 0) {
        bitcoinTxAddition = {
          blockNumber: lock.createdAtArgonBlock,
          blockHash: await client.rpc.chain.getBlockHash(lock.createdAtArgonBlock),
        };
      } else {
        const bitcoinTxKey = client.query.bitcoinLocks.locksByUtxoId.key(lock.utxoId);
        bitcoinTxAddition = await StorageFinder.binarySearchForStorageAddition(
          mainchainClients,
          bitcoinTxKey,
          vaultSetupBlockNumber,
        ).catch(err => {
          console.warn('Unable to find bitcoin lock creation block:', err);
          return undefined;
        });
      }
      const addedAtBlockNumber = bitcoinTxAddition?.blockNumber ?? 0;
      let bitcoinTxFee = 0n;
      if (bitcoinTxAddition) {
        const result = await TransactionEvents.findFromFeePaidEvent({
          client,
          blockHash: bitcoinTxAddition.blockHash,
          isMatchingEvent: ev => {
            if (client.events.bitcoinLocks.BitcoinLockCreated.is(ev)) {
              return ev.data.utxoId.toNumber() === lock.utxoId;
            }
            return false;
          },
          accountAddress: vaultingAddress,
        });
        bitcoinTxFee = result?.fee ?? 0n;
      }

      const record = await bitcoinLocks.recovery.recoverLock({
        lock,
        createdAtArgonBlockHeight: addedAtBlockNumber,
        finalFee: bitcoinTxFee,
      });
      records.push({ ...record, initializedAtBlockNumber: addedAtBlockNumber });
    }
    records.sort((a, b) => {
      return b.initializedAtBlockNumber - a.initializedAtBlockNumber;
    });
    return records;
  }

  private static async recoverXpubPath(param: {
    bitcoinNetwork: BitcoinNetwork;
    vaultId: number;
    storedXpubMaybe: Option<ITuple<[{ publicKey: U8aFixed }, any]>>;
    walletKeys: WalletKeys;
  }) {
    const { walletKeys, storedXpubMaybe, vaultId } = param;
    const masterXpubPath = DEFAULT_MASTER_XPUB_PATH;
    const vaultXpriv = await walletKeys.getBitcoinChildXpriv(masterXpubPath, param.bitcoinNetwork);
    const masterXpub = vaultXpriv.publicExtendedKey;
    if (storedXpubMaybe.isNone) throw new Error(`Vault with id ${vaultId} xpub not found`);
    const storedXpubPubkey = storedXpubMaybe.unwrap()[0].publicKey.toHex().replace('0x', '');
    const expectedXpubHex = u8aToHex(bs58check.decode(masterXpub), undefined, false);
    if (!expectedXpubHex.includes(storedXpubPubkey)) {
      throw new Error(
        `Vault xpub master ${expectedXpubHex} doesn't contain the expected public key ${storedXpubPubkey}.`,
      );
    }

    return masterXpubPath;
  }
}
