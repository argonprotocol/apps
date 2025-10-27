import { type ArgonClient, getClient, Keyring, mnemonicGenerate, Vault } from '@argonprotocol/mainchain';
import { describeIntegration, teardown } from '@argonprotocol/testing';
import { MainchainClients, MiningFrames, StorageFinder, TransactionFees } from '@argonprotocol/apps-core';
import { afterAll, beforeAll, it, expect } from 'vitest';
import { startArgonTestNetwork } from './startArgonTestNetwork.js';
import { bip39, BitcoinNetwork, getChildXpriv, getXpubFromXpriv } from '@argonprotocol/bitcoin';

afterAll(teardown);

describeIntegration('Storage/Fees Finder tests', () => {
  let client: ArgonClient;
  let mainchainUrl: string;
  beforeAll(async () => {
    const network = await startArgonTestNetwork('exttest', { profiles: ['bob'] });

    mainchainUrl = network.archiveUrl;
    client = await getClient(mainchainUrl);
    MiningFrames.setNetwork('dev-docker');
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
    const { txResult, vault } = await Vault.create(client, alice, {
      securitization: 10_000_000n,
      securitizationRatio: 1,
      annualPercentRate: 0.05,
      baseFee: 500_000n,
      bitcoinXpub: vaultMasterXpub,
      treasuryProfitSharing: 0.5,
    });
    const actualBlock = await client.rpc.chain.getHeader(await txResult.inBlockPromise);
    console.log('txResult block', actualBlock.toJSON());
    const storageKey = client.query.vaults.vaultsById.key(vault.vaultId);
    const binarySearch = await StorageFinder.binarySearchForStorageAddition(
      new MainchainClients(mainchainUrl),
      storageKey,
    );
    console.log('Binary search checked', binarySearch.blocksChecked);
    expect(Buffer.from(binarySearch.blockHash).toString('hex')).toStrictEqual(
      Buffer.from(await txResult.inBlockPromise).toString('hex'),
    );
    expect(binarySearch.blocksChecked.length).toBeLessThan(MiningFrames.ticksPerFrame / 2);

    const iterateSearch = await StorageFinder.iterateFindStorageAddition({
      client,
      startingBlock: 10,
      maxBlocksToCheck: 20,
      storageKey,
    });
    expect(Buffer.from(iterateSearch.blockHash).toString('hex')).toStrictEqual(
      Buffer.from(await txResult.inBlockPromise).toString('hex'),
    );
    expect(iterateSearch.blocksChecked.length).toBe(actualBlock.number.toNumber() + 1 - 10);

    const fee = await TransactionFees.findFromEvents({
      client,
      accountAddress: alice.address,
      isMatchingEvent: ev => client.events.vaults.VaultCreated.is(ev),
      blockHash: binarySearch.blockHash,
    });
    expect(fee).toBeDefined();
    expect(fee).toBe(txResult.finalFee);
  });
});
