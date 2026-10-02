import { integrationNetwork as sharedNetwork } from '@argonprotocol/apps-core/__test__/integration.setup.ts';
import { createKeyringPair, Keyring, mnemonicGenerate } from '@argonprotocol/mainchain';
import { teardown } from '@argonprotocol/testing';
import { Accountset, type ArgonClient, getRange, TxSubmitter } from '@argonprotocol/apps-core';
import { it, beforeAll, afterAll, describe, expect, inject } from 'vitest';
import { integrationAccountUri } from './integrationNetwork.ts';
import { waitFor } from './helpers/waitFor.ts';
import { getTestMainchainClient } from './helpers/mainchain.ts';

afterAll(teardown);
const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E)('Accountset tests', { tags: ['mining-auction'] }, () => {
  let client: ArgonClient;
  let mainchainUrl: string;
  const sessionMiniSecretOrMnemonic = mnemonicGenerate();
  const fundedAccount = new Keyring({ type: 'sr25519' }).addFromUri(
    integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'funded'),
  );
  beforeAll(async () => {
    const network = sharedNetwork;

    mainchainUrl = network.archiveUrl;
    client = await getTestMainchainClient(mainchainUrl);
  });

  it('can derive multiple accounts', async () => {
    const bidderKeypair = createKeyringPair({});
    const accountset = new Accountset({
      client,
      txSubmitter: bidderKeypair,
      subaccountRange: getRange(0, 50),
      sessionMiniSecretOrMnemonic: sessionMiniSecretOrMnemonic,
    });

    expect(Object.keys(accountset.subAccountsByAddress).length).toBe(50);
    expect(new Set(Object.values(accountset.subAccountsByAddress)).size).toBe(50);

    // generating a second time should yield the same accounts
    const accountset2 = new Accountset({
      client,
      txSubmitter: bidderKeypair,
      subaccountRange: getRange(0, 50),
      sessionMiniSecretOrMnemonic: sessionMiniSecretOrMnemonic,
    });
    expect(Object.keys(accountset2.subAccountsByAddress).length).toBe(50);
    expect(Object.keys(accountset.subAccountsByAddress).every(x => accountset2.subAccountsByAddress[x])).toBe(true);
  });

  it('can register keys from a mnemonic', async () => {
    const bidderKeypair = fundedAccount;
    const accountset = new Accountset({
      client,
      txSubmitter: bidderKeypair,
      subaccountRange: getRange(0, 49),
      sessionMiniSecretOrMnemonic: sessionMiniSecretOrMnemonic,
    });

    await expect(accountset.registerKeys(mainchainUrl)).resolves.toBeUndefined();
  });

  it('can submit bids', async () => {
    const bidderKeypair = fundedAccount;
    const accountset = new Accountset({
      client,
      txSubmitter: bidderKeypair,
      subaccountRange: getRange(0, 49),
      sessionMiniSecretOrMnemonic: sessionMiniSecretOrMnemonic,
    });
    const nextSeats = await accountset.getAvailableMinerAccounts(5);
    expect(nextSeats).toHaveLength(5);

    const startingFrame = await client.query.miningSlot.nextFrameId();
    await waitFor(
      30_000,
      'next bidding window',
      async () => (await client.query.miningSlot.nextFrameId()) > startingFrame,
    );

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
    const fundingAccount = fundedAccount;
    const proxyAccount = createKeyringPair({});
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

    const startingFrame = await client.query.miningSlot.nextFrameId();
    await waitFor(
      30_000,
      'next bidding window',
      async () => (await client.query.miningSlot.nextFrameId()) > startingFrame,
    );

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
