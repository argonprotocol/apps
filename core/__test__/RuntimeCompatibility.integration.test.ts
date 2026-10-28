import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import BigNumber from 'bignumber.js';
import { Keyring, toFixedNumber } from '@argonprotocol/mainchain';
import {
  BitcoinNetwork,
  getChildXpriv,
  getXpubBytes,
  getXpubFromXpriv,
  p2wshScriptHexToAddress,
} from '@argonprotocol/bitcoin';
import { runtimeClient } from '@argonprotocol/runtime-client';
import { integrationNetwork } from './integration.setup.ts';
import { integrationAccountUri } from './integrationNetwork.ts';
import { getTestMainchainClient, submitAndFinalize } from './helpers/mainchain.ts';
import { createBitcoinAddress, generateBlocks, sendBitcoinToAddress } from './helpers/bitcoinCli.ts';
import { waitFor } from './helpers/waitFor.ts';
import { BitcoinLock, SATS_PER_BTC } from '../src/BitcoinLock.ts';
import { BitcoinFission } from '../src/BitcoinFission.ts';
import { Currency } from '../src/Currency.ts';
import { Vault } from '../src/Vault.ts';
import { TreasuryBonds } from '../src/TreasuryBonds.ts';
import { TreasuryRewards } from '../src/TreasuryRewards.ts';
import type { ArgonClient } from '../src/MainchainClients.ts';

describe('deployed and next runtime core contracts', { tags: ['exclusive-argon-network'] }, () => {
  let client: ArgonClient;
  beforeAll(async () => {
    client = await getTestMainchainClient(integrationNetwork.archiveUrl);
  });
  afterAll(async () => await client?.disconnect());

  it('preserves vault funding and funded Lock/Fission outcomes with the next client', async () => {
    const spec = client.runtimeVersion.specVersion.toNumber();
    expect(spec).toBe(Number(process.env.ARGON_TEST_RUNTIME_SPEC ?? 161));
    const signer = new Keyring({ type: 'sr25519' }).addFromUri(
      integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'funded'),
    );
    const vaultKey = getChildXpriv(new Uint8Array(64).fill(7), "m/84'/0'/0'", BitcoinNetwork.Regtest);
    const ownerKey = getChildXpriv(new Uint8Array(64).fill(8), "m/84'/0'/0'/0/0", BitcoinNetwork.Regtest);
    const creation = await submitAndFinalize(
      client,
      Vault.buildCreateTx(
        client,
        {
          terms: Vault.encodeTerms(client.registry, {
            bitcoinAnnualPercentRate: new BigNumber(0.05),
            bitcoinBaseFee: 100n,
          }),
          delegateAccountId: null,
          securitization: 200_000_000n,
          bitcoinXpubkey: getXpubBytes(getXpubFromXpriv(vaultKey)),
        },
        new BigNumber(1),
      ),
      signer,
    );
    if (creation.extrinsicError) throw creation.extrinsicError;
    const created = creation.events.find(event => event.section === 'vaults' && event.method === 'VaultCreated');
    if (!created || created.section !== 'vaults' || created.method !== 'VaultCreated')
      throw new Error('Vault creation was not finalized');
    const vaultId = created.data.vaultId;
    let vault = await Vault.get(client, vaultId);
    expect(vault.operatorAccountId).toBe(signer.address);
    expect(vault.securitization).toBe(200_000_000n);
    expect(vault.availableBitcoinSpace(signer.address)).toBe(200_000_000n);

    const funding = await submitAndFinalize(client, vault.buildModifyFundingTx(client, 250_000_000n), signer);
    if (funding.extrinsicError) throw funding.extrinsicError;
    vault = await Vault.get(client, vaultId);
    expect(vault.securitizationTarget).toBe(250_000_000n);
    expect(vault.availableBitcoinSpace(signer.address)).toBe(250_000_000n);

    const initialRate = await publishBitcoinPrice(client, 132_000);
    const satoshis = 50_000n;
    const initialize = await BitcoinLock.createInitializeTx({
      client,
      vault,
      priceIndex: await Currency.fetchPriceIndex(client),
      txSigner: signer,
      ownerBitcoinPubkey: ownerKey.publicKey!,
      satoshis,
      microgonsAtTargetPerBtc: initialRate,
    });
    expect(initialize.canAfford).toBe(true);
    const lockCreation = await submitAndFinalize(client, initialize.tx, signer);
    if (lockCreation.extrinsicError) throw lockCreation.extrinsicError;
    const { lock } = await BitcoinLock.getBitcoinLockFromTxResult(client, lockCreation);
    expect(lock.ownerAccount).toBe(signer.address);
    expect(lock.securitizedSatoshis).toBe(satoshis);

    const address = p2wshScriptHexToAddress(lock.p2wshScriptHashHex, BitcoinNetwork.Regtest);
    sendBitcoinToAddress(address, satoshis);
    generateBlocks(8, createBitcoinAddress());
    const funded = await waitFor(120_000, 'finalized Bitcoin funding', async () => {
      const snapshot = runtimeClient(await client.raw.at(await client.rpc.chain.getFinalizedHead()));
      const current = await BitcoinLock.get(snapshot, lock.lockId);
      if (current?.fundedSatoshis === satoshis) return current;
    });
    expect(funded.fundingUtxos.reduce((sum, utxo) => sum + utxo.satoshis, 0n)).toBe(satoshis);
    if (spec === 161) expect(funded.securitizationHoldExpirationBitcoinHeight).toBeNull();

    const cap = await publishBitcoinPrice(client, 144_000);
    const guarantee = await submitAndFinalize(
      client,
      BitcoinLock.createResecuritizeTx({
        client,
        lockId: lock.lockId,
        securitizedSatoshis: satoshis,
        microgonsAtTargetPerBtc: cap,
      }),
      signer,
    );
    if (guarantee.extrinsicError) throw guarantee.extrinsicError;
    expect((await BitcoinLock.get(client, lock.lockId))?.microgonsAtTargetPerBtc).toBe(cap);

    const rate = await publishBitcoinPrice(client, 120_000);
    const fissionId = await BitcoinFission.nextId(client, signer.address);
    const fissionCreation = await submitAndFinalize(
      client,
      BitcoinFission.createTx({
        client,
        fissionId,
        liquidId: 1,
        lockId: lock.lockId,
        satoshis: satoshis / 2n,
        microgonsAtTargetPerBtc: rate,
      }),
      signer,
    );
    if (fissionCreation.extrinsicError) throw fissionCreation.extrinsicError;
    const before = await BitcoinFission.get(client, signer.address, fissionId);
    expect(before).toMatchObject({
      ownerAccount: signer.address,
      lockId: lock.lockId,
      satoshis: satoshis / 2n,
      ratchetNumber: 0,
    });

    const higherRate = await publishBitcoinPrice(client, 132_000);
    const ratchet = await submitAndFinalize(
      client,
      BitcoinFission.createRatchetTx({ client, fissionId, microgonsAtTargetPerBtc: higherRate }),
      signer,
    );
    if (ratchet.extrinsicError) throw ratchet.extrinsicError;
    const after = await BitcoinFission.get(client, signer.address, fissionId);
    expect(after?.ratchetNumber).toBe(1);
    expect(after?.microgonsAtTargetPerBtc).toBe(higherRate);
    expect(after!.liquidityPromised).toBeGreaterThan(before!.liquidityPromised);
    const native = await client.query.bitcoinFissions.fissionByOwnerAndId(signer.address, fissionId);
    expect(after?.liquidityPromised).toBe(native?.liquidityPromised);
    if (native && 'cosignerGuarantee' in native) expect(after?.cosignerGuarantee).toEqual(native.cosignerGuarantee);
    else expect(after?.cosignerGuarantee).toBeUndefined();

    const totals = await client.query.treasuryPositions.networkTotals();
    const quantities = 'accountQuantities' in totals ? totals.accountQuantities : totals;
    expect(await TreasuryBonds.getActiveArgonotBonds(client)).toBe(quantities.stakes);

    // Compare the app's frozen-frame projection with the runtime's actual payout.
    const startingFrame = (await client.query.treasury.currentFrameVaultCapital())?.frameId ?? 0;
    const rewards = await waitFor<TreasuryRewards>(90_000, 'fresh funded Vault reward frame', async () => {
      const snapshot = runtimeClient(await client.at(await client.rpc.chain.getFinalizedHead()));
      const current = await TreasuryRewards.read(snapshot);
      if (current && current.capital.frameId > startingFrame && current.capital.vaultSecuritizationPositions[vaultId]) {
        return current;
      }
    });
    const poolFunding = await submitAndFinalize(
      client,
      client.tx.balances.transferKeepAlive(TreasuryRewards.getBidPoolAccountId(client), 10_000_000n),
      signer,
    );
    if (poolFunding.extrinsicError) throw poolFunding.extrinsicError;

    const payoutBlock = await waitFor<number>(90_000, 'reward frame payout', async () => {
      const snapshot = await client.at(await client.rpc.chain.getFinalizedHead());
      const current = await snapshot.query.treasury.currentFrameVaultCapital();
      if (current && current.frameId > rewards.capital.frameId) {
        return (await snapshot.query.miningSlot.frameStartBlockNumbers())?.[0];
      }
    });
    const payoutHash = await client.rpc.chain.getBlockHash(payoutBlock);
    const payoutApi = await client.at(payoutHash);
    const payout = (await payoutApi.query.system.events()).find(
      ({ event }) =>
        event.section === 'treasury' &&
        event.method === 'FrameEarningsDistributed' &&
        event.data.frameId === rewards.capital.frameId,
    )?.event;
    if (!payout || payout.section !== 'treasury' || payout.method !== 'FrameEarningsDistributed') {
      throw new Error('Frame payout event is missing');
    }
    const fullBidPool = payout.data.bidPoolDistributed + payout.data.treasuryReserves + (payout.data.burned ?? 0n);
    const expectedEarnings = rewards.vaultRevenuePotential(vaultId, fullBidPool)!.actualEarnings;
    const revenues = await payoutApi.query.vaults.revenuePerFrameByVault(vaultId);
    expect(expectedEarnings).toBeGreaterThan(0n);
    expect(revenues?.find(revenue => revenue.frameId === rewards.capital.frameId)).toMatchObject({
      treasuryVaultEarnings: expectedEarnings,
    });
  }, 300_000);
});

async function publishBitcoinPrice(client: ArgonClient, btcUsdPrice: number): Promise<bigint> {
  const previous = await client.query.priceIndex.current();
  const tick = await waitFor(30_000, 'fresh oracle tick', async () => {
    const current = await client.query.ticks.currentTick();
    if (current > (previous?.tick ?? 0)) return current;
  });
  const oracle = new Keyring({ type: 'sr25519' }).addFromUri('//Eve//oracle');
  const result = await submitAndFinalize(
    client,
    client.tx.priceIndex.submit(
      {
        btcUsdPrice: toFixedNumber(btcUsdPrice, 18),
        argonUsdPrice: toFixedNumber(1.06, 18),
        argonUsdTargetPrice: toFixedNumber(1.06, 18),
        argonotUsdPrice: toFixedNumber(0.05, 18),
        argonTimeWeightedAverageLiquidity: toFixedNumber(100_000_000, 18),
        tick,
      },
      null,
    ),
    oracle,
    { useLatestNonce: true },
  );
  if (result.extrinsicError) throw result.extrinsicError;
  return await waitFor(30_000, 'finalized eligible Bitcoin rate', async () => {
    const snapshot = runtimeClient(await client.raw.at(await client.rpc.chain.getFinalizedHead()));
    const price = await Currency.fetchPriceIndex(snapshot);
    const history = await snapshot.query.bitcoinLocks.microgonPerBtcHistory();
    const latest = history?.at(-1);
    if (price.lastUpdatedTick === tick && latest?.[1] === price.getSatoshiPriceInTargetMicrogons(SATS_PER_BTC))
      return latest[1];
  });
}
