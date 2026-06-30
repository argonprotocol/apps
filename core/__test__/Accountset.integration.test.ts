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
import { startArgonTestNetwork } from './startArgonTestNetwork.ts';
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
      subaccountRange: getRange(0, 50),
      sessionMiniSecretOrMnemonic: sessionMiniSecretOrMnemonic,
    });

    expect(Object.keys(accountset.subAccountsByAddress).length).toBe(50);
    expect(new Set(Object.values(accountset.subAccountsByAddress)).size).toBe(50);

    // generating a second time should yield the same accounts
    const accountset2 = new Accountset({
      client,
      seedAccount,
      subaccountRange: getRange(0, 50),
      sessionMiniSecretOrMnemonic: sessionMiniSecretOrMnemonic,
    });
    expect(Object.keys(accountset2.subAccountsByAddress).length).toBe(50);
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
    const blockHash = await result.waitForInFirstBlock;

    console.log('Mining bid result', { ...result, client: undefined });
    expect(result).toBeTruthy();
    expect(result.finalFee).toBeGreaterThan(6000);
    expect(result.batchInterruptedIndex).not.toBeDefined();
    expect(result.extrinsicError).toBeFalsy();
    // check for bids or registered seats
    const api = await client.at(blockHash);
    const seats = await accountset.miningSeatsAndBids(api);
    expect(seats.filter(x => !!x.seat || x.hasWinningBid)).toHaveLength(5);
  });

  it('can submit bids through a real-pays proxy', async () => {
    const fundingAccount = sudo();
    const proxyAccount = createKeyringPair({});
    const fundingSetup = new TxSubmitter(
      client,
      client.tx.sudo.sudo(client.tx.ownership.forceSetBalance(fundingAccount.address, 500_000)),
      fundingAccount,
    );
    const setupResult = await fundingSetup.submit();
    await setupResult.waitForInFirstBlock;

    const accountset = new Accountset({
      client,
      fundingAccountId: fundingAccount.address,
      isProxy: true,
      txSubmitter: proxyAccount,
      subaccountRange: getRange(0, 49),
      sessionMiniSecretOrMnemonic: sessionMiniSecretOrMnemonic,
    });
    const proxySetupPlan = await accountset.planMiningBidProxySetup();

    expect(proxySetupPlan.kind).toBe('tx');
    if (proxySetupPlan.kind !== 'tx') {
      throw new Error(`Expected proxy setup transaction, got ${proxySetupPlan.kind}`);
    }
    expect(proxySetupPlan.metadata).toEqual({
      fundingAccountId: fundingAccount.address,
      proxyAccountId: proxyAccount.address,
    });

    const proxySetup = await new TxSubmitter(client, proxySetupPlan.tx, fundingAccount).submit();
    await proxySetup.waitForInFirstBlock;

    const readyPlan = await accountset.planMiningBidProxySetup();
    expect(readyPlan).toEqual({ kind: 'ready' });

    const nextSeats = await accountset.getAvailableMinerAccounts(5);
    expect(nextSeats).toHaveLength(5);

    const submitter = await accountset.createMiningBidTx({
      bidAmount: 10_000n,
      subaccounts: nextSeats,
    });
    const result = await submitter.submit({
      useLatestNonce: true,
    });
    const blockHash = await result.waitForInFirstBlock;

    expect(result).toBeTruthy();
    expect(result.extrinsicError).toBeFalsy();

    const api = await client.at(blockHash);
    const seats = await accountset.miningSeatsAndBids(api);
    expect(seats.filter(x => !!x.seat || x.hasWinningBid).length).toBeGreaterThanOrEqual(5);
  });
});
