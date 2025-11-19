import {
  type ArgonClient,
  createKeyringPair,
  getClient,
  mnemonicGenerate,
  TxSubmitter,
} from '@argonprotocol/mainchain';
import { sudo, teardown } from '@argonprotocol/testing';
import { Accountset, getRange } from '@argonprotocol/apps-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startArgonTestNetwork } from './startArgonTestNetwork.js';
import Path from 'path';

afterAll(teardown);
const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E)('Accountset tests', {}, () => {
  let client: ArgonClient;
  let mainchainUrl: string;
  const sessionMiniSecretOrMnemonic = mnemonicGenerate();
  beforeAll(async () => {
    const network = await startArgonTestNetwork(Path.basename(import.meta.filename), { profiles: ['bob'] });

    mainchainUrl = network.archiveUrl;
    client = await getClient(mainchainUrl);
  });

  it('can derive multiple accounts', async () => {
    const seedAccount = createKeyringPair({});
    const accountset = new Accountset({
      client,
      seedAccount,
      subaccountRange: getRange(0, 49),
      sessionMiniSecretOrMnemonic: sessionMiniSecretOrMnemonic,
    });

    expect(Object.keys(accountset.subAccountsByAddress).length).toBe(100);
    expect(new Set(Object.values(accountset.subAccountsByAddress)).size).toBe(100); // all unique
    // half should be deprecated addresses
    const deprecatedAccounts = Object.values(accountset.subAccountsByAddress).filter(x => x.isDeprecated);
    expect(deprecatedAccounts.length).toBe(50);

    // generating a second time should yield the same accounts
    const accountset2 = new Accountset({
      client,
      seedAccount,
      subaccountRange: getRange(0, 49),
      sessionMiniSecretOrMnemonic: sessionMiniSecretOrMnemonic,
    });
    expect(Object.keys(accountset2.subAccountsByAddress).length).toBe(100);
    expect(Object.keys(accountset.subAccountsByAddress).every(x => accountset2.subAccountsByAddress[x])).toBe(true);
  });

  it('can register keys from a mnemonic', async () => {
    const seedAccount = sudo();
    const accountset = new Accountset({
      client,
      seedAccount,
      subaccountRange: getRange(0, 49),
      sessionMiniSecretOrMnemonic: sessionMiniSecretOrMnemonic,
    });

    await expect(accountset.registerKeys(mainchainUrl)).resolves.toBeUndefined();
  });

  it('can submit bids', async () => {
    const seedAccount = sudo();
    const accountset = new Accountset({
      client,
      seedAccount,
      subaccountRange: getRange(0, 49),
      sessionMiniSecretOrMnemonic: sessionMiniSecretOrMnemonic,
      includeDerivedSubaccounts: true,
    });
    const txSubmitter = new TxSubmitter(
      client,
      client.tx.sudo.sudo(client.tx.ownership.forceSetBalance(seedAccount.address, 500_000)),
      seedAccount,
    );
    const res = await txSubmitter.submit();
    await res.waitForInFirstBlock;

    const nextSeats = await accountset.getAvailableMinerAccounts(5);
    expect(nextSeats).toHaveLength(5);

    const submitter = await accountset.createMiningBidTx({
      bidAmount: 10_000n,
      subaccounts: nextSeats,
    });
    const result = await submitter.submit({
      tip: 100n,
      useLatestNonce: true,
    });
    await result.waitForInFirstBlock;

    console.log('Mining bid result', { ...result, client: undefined });
    expect(result).toBeTruthy();
    expect(result.finalFee).toBeGreaterThan(6000);
    expect(result.batchInterruptedIndex).not.toBeDefined();
    expect(result.extrinsicError).toBeFalsy();
    // check for bids or registered seats
    const api = await client.at(result.blockHash!);
    const seats = await accountset.miningSeatsAndBids(api);
    expect(seats.filter(x => !!x.seat || x.hasWinningBid)).toHaveLength(5);
  });
});
