import { ITuple, Option, U8aFixed, u8aToHex } from '@argonprotocol/mainchain';
import { IVaultingRules } from '../../interfaces/IVaultingRules.ts';
import BigNumber from 'bignumber.js';
import {
  AccountActivityKind,
  getVaultByOperator,
  MainchainClients,
  StorageFinder,
  TransactionEvents,
  Vault,
} from '@argonprotocol/apps-core';
import { TICK_MILLIS } from '../Env.ts';
import { Config } from '../Config.ts';
import bs58check from 'bs58check';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import { hexToU8a } from '@polkadot/util';
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
    const vault = await getVaultByOperator({
      client,
      operatorAddress: vaultingAddress,
      tickDurationMillis: TICK_MILLIS,
    });
    if (!vault) return;
    const vaultId = vault.vaultId;

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
