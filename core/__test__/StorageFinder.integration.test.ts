import {
  type ArgonClient,
  FIXED_U128_DECIMALS,
  getClient,
  Keyring,
  mnemonicGenerate,
  PERMILL_DECIMALS,
  toFixedNumber,
} from '@argonprotocol/mainchain';
import { teardown } from '@argonprotocol/testing';
import {
  MainchainClients,
  NetworkConfig,
  StorageFinder,
  TransactionEvents,
  TxSubmitter,
} from '@argonprotocol/apps-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startArgonTestNetwork } from './startArgonTestNetwork.ts';
import { bip39, BitcoinNetwork, getChildXpriv, getXpubFromXpriv } from '@argonprotocol/bitcoin';
import bs58check from 'bs58check';
import Path from 'path';

afterAll(teardown);
const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E)('Storage/Fees Finder tests', () => {
  let client: ArgonClient;
  let mainchainUrl: string;
  beforeAll(async () => {
    const network = await startArgonTestNetwork(Path.basename(import.meta.filename), { profiles: ['bob'] });

    mainchainUrl = network.archiveUrl;
    client = await getClient(mainchainUrl);
    NetworkConfig.setNetwork('dev-docker');
  });

  it('can find a transaction and its fees', async () => {
    const alice = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Alice');
    let blockNumber = 0;
    while (blockNumber <= 10) {
      blockNumber = await client.rpc.chain.getHeader().then(x => x.number.toNumber());
    }

    const vaultXpriv = getChildXpriv(
      bip39.mnemonicToSeedSync(mnemonicGenerate()),
      "m/84'/0'/0'",
      BitcoinNetwork.Regtest,
    );
    // get the xpub from the xpriv
    const vaultMasterXpub = getXpubFromXpriv(vaultXpriv);
    const createVaultTx = client.tx.vaults.create({
      terms: {
        bitcoinAnnualPercentRate: toFixedNumber(0.05, FIXED_U128_DECIMALS),
        bitcoinBaseFee: 500_000n,
        treasuryProfitSharing: toFixedNumber(0.5, PERMILL_DECIMALS),
        treasuryBonusProfitSharing: toFixedNumber(0, PERMILL_DECIMALS),
      },
      securitizationRatio: toFixedNumber(1, FIXED_U128_DECIMALS),
      securitization: 10_000_000n,
      bitcoinXpubkey: bs58check.decode(vaultMasterXpub),
      delegateAccountId: null,
    });
    const txResult = await new TxSubmitter(client, createVaultTx, alice).submit({ useLatestNonce: true });
    await txResult.waitForFinalizedBlock;
    const vaultCreated = txResult.events.find(event => client.events.vaults.VaultCreated.is(event));
    if (!vaultCreated) throw new Error('VaultCreated event not found');

    const actualBlock = await client.rpc.chain.getHeader(await txResult.waitForFinalizedBlock);
    console.log('txResult block', actualBlock.toHuman());
    const storageKey = client.query.vaults.vaultsById.key(vaultCreated.data.vaultId);
    const binarySearch = await StorageFinder.binarySearchForStorageAddition(
      new MainchainClients(mainchainUrl),
      storageKey,
    );
    console.log('Binary search checked', binarySearch.blocksChecked);
    expect(Buffer.from(binarySearch.blockHash).toString('hex')).toStrictEqual(
      Buffer.from(await txResult.waitForFinalizedBlock).toString('hex'),
    );
    expect(binarySearch.blocksChecked.length).toBeLessThan(NetworkConfig.rewardTicksPerFrame / 2);

    const iterateSearch = await StorageFinder.iterateFindStorageAddition({
      client,
      startingBlock: 10,
      maxBlocksToCheck: 20,
      storageKey,
    });
    expect(Buffer.from(iterateSearch.blockHash).toString('hex')).toStrictEqual(
      Buffer.from(await txResult.waitForFinalizedBlock).toString('hex'),
    );
    expect(iterateSearch.blocksChecked.length).toBe(actualBlock.number.toNumber() + 1 - 10);

    const result = await TransactionEvents.findFromFeePaidEvent({
      client,
      accountAddress: alice.address,
      isMatchingEvent: ev => client.events.vaults.VaultCreated.is(ev),
      blockHash: binarySearch.blockHash,
    });
    expect(result).toBeDefined();
    expect(result!.fee).toBe(txResult.finalFee);
  });
});
