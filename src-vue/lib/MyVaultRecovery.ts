import { ArgonClient, ITuple, Option, u8aEq, U8aFixed, u8aToHex, Vault } from '@argonprotocol/mainchain';
import { IVaultingRules } from '../interfaces/IVaultingRules.ts';
import BigNumber from 'bignumber.js';
import BitcoinLocksStore from './BitcoinLocksStore.ts';
import { MainchainClients, StorageFinder, TransactionEvents } from '@argonprotocol/apps-core';
import { TICK_MILLIS } from './Env.ts';
import { Config } from './Config.ts';
import bs58check from 'bs58check';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import { BitcoinLocksTable, IBitcoinLockRecord } from './db/BitcoinLocksTable.ts';
import { DEFAULT_MASTER_XPUB_PATH } from './MyVault.ts';
import { WalletKeys } from './WalletKeys.ts';

export class MyVaultRecovery {
  public static rebuildRules(args: {
    feesInMicrogons: bigint;
    vault: Vault;
    treasuryMicrogons?: bigint;
    bitcoin?: { liquidityPromised: bigint };
  }): IVaultingRules {
    const { vault, treasuryMicrogons = 0n, bitcoin = { liquidityPromised: 0n }, feesInMicrogons } = args;

    const securitization = vault.securitization;
    const securitizationRatio = vault.securitizationRatio;
    // assume the amount in argons was a round number
    const baseMicrogonCommitment = BigInt(
      Math.round(Number(securitization + treasuryMicrogons + feesInMicrogons) / 10e6) * 10e6,
    );
    const capitalForSecuritizationPct = BigNumber(securitization)
      .div(securitization + treasuryMicrogons)
      .times(100)
      .decimalPlaces(1, BigNumber.ROUND_HALF_EVEN)
      .toNumber();
    const capitalForTreasuryPct = 100 - capitalForSecuritizationPct;
    const profitSharingPct = vault.terms.treasuryProfitSharing.times(100).toNumber();
    const btcFlatFee = vault.terms.bitcoinBaseFee;
    const btcPctFee = vault.terms.bitcoinAnnualPercentRate.times(100).toNumber();

    const personalBtcPct = BigNumber(bitcoin.liquidityPromised)
      .dividedBy(vault.securitization)
      .times(100)
      .integerValue(BigNumber.ROUND_CEIL)
      .toNumber();
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

  public static async findPrebonded(args: {
    client: ArgonClient;
    vaultId: number;
    vaultCreatedBlockNumber: number;
    walletKeys: WalletKeys;
  }): Promise<{
    prebondedMicrogons: bigint;
    txFee?: bigint;
    blockNumber?: number;
    blockHash?: Uint8Array;
    tick?: number;
  }> {
    const { walletKeys, vaultId, client, vaultCreatedBlockNumber } = args;
    const prebondInitKey = client.query.treasury.prebondedByVaultId.key(vaultId);
    const vaultPrebondBlock = await StorageFinder.iterateFindStorageAddition({
      client,
      startingBlock: vaultCreatedBlockNumber,
      maxBlocksToCheck: 100,
      storageKey: prebondInitKey,
    }).catch(() => undefined);

    let vaultPrebondFee: bigint | undefined;
    let prebondedMicrogons = 0n;
    if (!vaultPrebondBlock) {
      console.warn('No prebond/vault setup transaction found');
    } else {
      const result = await TransactionEvents.findFromFeePaidEvent({
        client,
        accountAddress: walletKeys.vaultingAddress,
        blockHash: vaultPrebondBlock.blockHash,
        isMatchingEvent: ev => {
          if (client.events.treasury.VaultOperatorPrebond.is(ev)) {
            const { vaultId: vaultIdRaw, amountPerFrame } = ev.data;
            if (vaultIdRaw.toNumber() === vaultId) {
              prebondedMicrogons = amountPerFrame.toBigInt() * 10n;
              return true;
            }
          }
          return false;
        },
      });
      vaultPrebondFee = result?.fee;
    }
    return {
      prebondedMicrogons,
      txFee: vaultPrebondFee,
      ...vaultPrebondBlock,
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

    // verify this has the right xpub path
    const storedXpubMaybe = await client.query.vaults.vaultXPubById(vaultId);
    const masterXpubPath = await this.recoverXpubPath({
      vaultId,
      storedXpubMaybe,
      walletKeys,
      bitcoinNetwork,
    });
    console.log('Recovered vault xpub path:', masterXpubPath);

    const vaultCreateKey = client.query.vaults.vaultsById.key(vaultId);
    const vaultStartBlock = await StorageFinder.binarySearchForStorageAddition(mainchainClients, vaultCreateKey).catch(
      err => {
        console.warn('Unable to find vault creation block:', err);
        return undefined;
      },
    );
    console.log('Look for vault create at block:', vaultStartBlock?.blockNumber ?? 'not found');
    const vaultCreateBlockNumber = vaultStartBlock?.blockNumber ?? 0;
    let vaultCreateFee = 0n;
    if (vaultStartBlock) {
      const result = await TransactionEvents.findFromFeePaidEvent({
        client,
        accountAddress: vaultingAddress,
        blockHash: vaultStartBlock.blockHash,
        isMatchingEvent: ev => {
          if (client.events.vaults.VaultCreated.is(ev)) {
            const { vaultId: vaultIdRaw } = ev.data;
            return vaultIdRaw.toNumber() === vaultId;
          }
          return false;
        },
      });
      vaultCreateFee = result?.fee ?? 0n;
    }
    return {
      masterXpubPath,
      createBlockNumber: vaultCreateBlockNumber,
      txFee: vaultCreateFee,
      vault,
    };
  }

  public static async recoverPersonalBitcoin(args: {
    mainchainClients: MainchainClients;
    bitcoinLocksStore: BitcoinLocksStore;
    vaultSetupBlockNumber: number;
    vault: Vault;
  }): Promise<(IBitcoinLockRecord & { initializedAtBlockNumber: number })[]> {
    const { mainchainClients, bitcoinLocksStore, vault, vaultSetupBlockNumber } = args;
    const vaultingAddress = vault.operatorAccountId;
    const vaultId = vault.vaultId;
    const client = await mainchainClients.archiveClientPromise;
    const bitcoins = await client.query.bitcoinLocks.locksByUtxoId.entries();
    const myBitcoins = bitcoins.filter(([_id, lockMaybe]) => {
      if (!lockMaybe.isSome) return false;
      if (lockMaybe.value.vaultId.toNumber() !== vaultId) return false;
      return lockMaybe.value.ownerAccount.toHuman() === vaultingAddress;
    });

    async function findPubkey(ownerPubkey: Uint8Array, maxTries = 100) {
      for (let i = 0; i < maxTries; i++) {
        const next = await bitcoinLocksStore.getDerivedPubkey(vaultId, i);
        if (u8aEq(ownerPubkey, next.ownerBitcoinPubkey)) {
          const table = await bitcoinLocksStore.getTable();
          await table.setVaultHdKeyIndex(vaultId, i);
          return next;
        }
      }
      return undefined;
    }

    const records: (IBitcoinLockRecord & { initializedAtBlockNumber: number })[] = [];
    const table = await bitcoinLocksStore.getTable();
    let totalAmountMinted = 0n;
    for (const [utxoId, utxoMaybe] of myBitcoins) {
      const utxo = utxoMaybe.unwrap();
      if (utxo.ownerAccount.toHuman() === vaultingAddress) {
        const ownerPubkey = utxo.ownerPubkey;
        const thisHdPath = await findPubkey(ownerPubkey);
        if (!thisHdPath) {
          console.warn('Unable to recover the hd path of this personal bitcoin');
          continue;
        }

        const lock = await bitcoinLocksStore.getFromApi(utxoId.args[0].toNumber());
        const bitcoinTxKey = client.query.bitcoinLocks.locksByUtxoId.key(lock.utxoId);
        const bitcoinTxAddition = await StorageFinder.binarySearchForStorageAddition(
          mainchainClients,
          bitcoinTxKey,
          vaultSetupBlockNumber,
        ).catch(err => {
          console.warn('Unable to find bitcoin lock creation block:', err);
          return undefined;
        });
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

        const uuid = BitcoinLocksTable.createUuid();
        await bitcoinLocksStore.insertPending({
          uuid,
          vaultId,
          satoshis: lock.satoshis,
          hdPath: thisHdPath.hdPath,
        });
        const record = await table.finalizePending({
          uuid,
          lock,
          createdAtArgonBlockHeight: addedAtBlockNumber,
          finalFee: bitcoinTxFee,
        });
        totalAmountMinted += record.ratchets.reduce((sum, r) => sum + r.mintAmount - r.mintPending, 0n);

        records.push({ ...record, initializedAtBlockNumber: addedAtBlockNumber });
      }
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
