import { PriceIndex } from '@argonprotocol/mainchain';
import BigNumber from 'bignumber.js';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { decorateConstants } from '@polkadot/types/metadata/decorate';
import { getBundledMetadata, runtimeClient } from '@argonprotocol/runtime-client';
import { describe, expect, it } from 'vitest';
import { BitcoinLock } from '../src/BitcoinLock.ts';
import { BitcoinFission } from '../src/BitcoinFission.ts';
import { Vault } from '../src/Vault.ts';
import type { ArgonCurrentQueryClient } from '../src/MainchainClients.ts';

// Only storage transport is replaced; both codecs and native decoding use shipped runtime metadata.
describe.each([160, 161])('runtime %s protocol normalization', spec => {
  const registry = new TypeRegistry();
  const metadata = new Metadata(
    registry,
    Object.entries(getBundledMetadata()).find(([key]) => key.endsWith(`-${spec}`))![1],
  );
  registry.setMetadata(metadata);
  const ownerAccount = new Uint8Array(32).fill(17);
  const guarantee = {
    basis: { satoshis: 3n, microgonsAtTargetPerBtc: 1_000_000_000n, tick: 12 },
    guaranteedMicrogons: 31n,
    fundHoldExtensions: { 144: 1n },
  };

  it('preserves Lock coverage and quotes a Lock change only for selected Fissions on 160', async () => {
    const record = registry.createType('Option<PalletBitcoinLocksLockedBitcoin>', {
      vaultId: 7,
      ownerAccount,
      fundedSatoshis: 3n,
      fissionedSatoshis: 1n,
      fundingUtxos: new Map([[{ txid: `0x${'22'.repeat(32)}`, outputIndex: 0 }, 3n]]),
      cosignerGuarantee: guarantee,
      securitizationBasis: guarantee.basis,
      securitizationCoverageMicrogons: 31n,
      securitizationRatio: 1_500_000_000_000_000_000n,
      securitizationTick: 12,
      fundHoldExtensions: guarantee.fundHoldExtensions,
      securitizationHoldExpirationBitcoinHeight: spec === 160 ? 144 : null,
    });
    const client = runtimeClient({
      registry,
      query: { bitcoinLocks: { locksById: async () => record } },
    }) as unknown as ArgonCurrentQueryClient;
    const lock = await BitcoinLock.get(client, 4);

    expect(lock?.securitizedSatoshis).toBe(spec === 160 ? 3n : 2n);
    expect(lock?.securitizationCoverageMicrogons).toBe(spec === 160 ? 31n : 20n);
    expect(lock?.securitizationCollateralMicrogons).toBe(spec === 160 ? 46n : 31n);
    expect(lock?.securitizationTick).toBe(12);
    expect(lock?.securitizationHoldExpirationBitcoinHeight).toBe(spec === 160 ? 144 : null);
    if (spec === 161) expect(lock?.cosignerGuarantee).toEqual(guarantee);

    const priceIndex = new PriceIndex();
    priceIndex.argonUsdPrice = new BigNumber(1);
    priceIndex.argonUsdTargetPrice = new BigNumber(1);
    priceIndex.btcUsdPrice = new BigNumber(1_000);
    const fission = new BitcoinFission({
      ownerAccount: lock!.ownerAccount,
      fissionId: 3,
      liquidId: 2,
      lockId: 4,
      satoshis: 1n,
      microgonsAtTargetPerBtc: guarantee.basis.microgonsAtTargetPerBtc,
      liquidityPromised: 10n,
      ratchetNumber: 0,
    });
    expect(
      BitcoinLock.calculateResecuritizationForRatchet({
        lockId: 4,
        lock: (await client.query.bitcoinLocks.locksById(4))!,
        lockFissions: [fission],
        selectedFissionIds: new Set([99]),
        microgonsAtTargetPerBtc: 2_000_000_000n,
        priceIndex,
      }),
    ).toBeUndefined();

    const lockChange = BitcoinLock.calculateResecuritizationForRatchet({
      lockId: 4,
      lock: (await client.query.bitcoinLocks.locksById(4))!,
      lockFissions: [fission],
      selectedFissionIds: new Set([fission.fissionId]),
      microgonsAtTargetPerBtc: 2_000_000_000n,
      priceIndex,
    });
    if (spec === 160) {
      expect(lockChange).toEqual({ satoshis: 1n, microgonsAtTargetPerBtc: 2_000_000_000n, increasesGuarantee: true });
    } else {
      expect(lockChange).toBeUndefined();
    }
  });

  it('retains full collateral while pending Bitcoin becomes partially funded', async () => {
    const basis = { satoshis: 1_000_001n, microgonsAtTargetPerBtc: 2_000_000n, tick: 100 };
    const storage = {
      vaultId: 3,
      ownerAccount,
      securitizationBasis: basis,
      securitizationTick: 100,
      securitizationCoverageMicrogons: 1_000_001n,
      securitizationRatio: 1_000_000_000_000_000_000n,
      cosignerGuarantee: { basis, guaranteedMicrogons: 1_000_001n, fundHoldExtensions: {} },
    };
    let record = registry.createType('Option<PalletBitcoinLocksLockedBitcoin>', storage);
    const client = runtimeClient({
      registry,
      query: { bitcoinLocks: { locksById: async () => record } },
    }) as unknown as ArgonCurrentQueryClient;

    await expect(BitcoinLock.get(client, 7)).resolves.toMatchObject({
      securitizedSatoshis: 1_000_001n,
      securitizationCoverageMicrogons: 1_000_001n,
      securitizationCollateralMicrogons: 1_000_001n,
    });

    record = registry.createType('Option<PalletBitcoinLocksLockedBitcoin>', {
      ...storage,
      fundedSatoshis: 500_000n,
      fundingUtxos: new Map([[{ txid: `0x${'22'.repeat(32)}`, outputIndex: 1 }, 500_000n]]),
    });
    await expect(BitcoinLock.get(client, 7)).resolves.toMatchObject({
      securitizedSatoshis: 500_000n,
      securitizationCoverageMicrogons: 500_000n,
      securitizationCollateralMicrogons: 1_000_001n,
    });
  });

  it('reserves the stored Lock collateral when creating and ratcheting Fissions', async () => {
    const basis = { satoshis: 100n, microgonsAtTargetPerBtc: 100_000_000n, tick: 12 };
    const record = registry.createType('Option<PalletBitcoinLocksLockedBitcoin>', {
      vaultId: 7,
      ownerAccount,
      fundedSatoshis: 100n,
      isFlexible: true,
      securitizationBasis: basis,
      securitizationTick: 12,
      securitizationCoverageMicrogons: 100n,
      securitizationRatio: 1_500_000_000_000_000_000n,
      cosignerGuarantee: { basis, guaranteedMicrogons: 100n, fundHoldExtensions: {} },
    });
    const collateral = spec === 160 ? 150n : 100n;
    const client = runtimeClient({
      registry,
      consts: decorateConstants(registry, metadata.asLatest, metadata.version),
      query: {
        bitcoinLocks: { locksById: async () => record },
        vaults: {
          vaultsById: async () =>
            registry.createType('Option<ArgonPrimitivesVault>', {
              operatorAccountId: ownerAccount,
              securitization: 200n,
              securitizationTarget: 200n,
              securitizationLocked: collateral,
              flexibleSecuritizationLocked: collateral,
            }),
        },
      },
    }) as unknown as ArgonCurrentQueryClient;
    const lock = (await client.query.bitcoinLocks.locksById(4))!;
    const vault = await Vault.get(client, 7, 1_000);
    const priceIndex = new PriceIndex();
    priceIndex.argonUsdPrice = priceIndex.argonUsdTargetPrice = new BigNumber(1);
    priceIndex.btcUsdPrice = new BigNumber(200);
    const quoteArgs = {
      lockId: 4,
      lock,
      vault,
      satoshis: 100n,
      priceIndex,
      microgonsAtTargetPerBtc: 200_000_000n,
      eligibleRates: [[13n, 200_000_000n] as const],
      lockFissions: [],
      currentBitcoinHeight: 0,
    };
    const quote = BitcoinLock.quoteFissionCreation(quoteArgs);
    expect(quote).not.toHaveProperty('error');
    expect(quote.maximumSatoshis).toBe(spec === 160 ? 0n : 100n);

    const replacement = BitcoinLock.calculateResecuritizationCapacity({
      lockId: 4,
      lock,
      vault,
      securitizedSatoshis: 100n,
      replacementCoverageMicrogons: 200n,
    });
    expect(replacement.canAfford).toBe(spec === 161);
    expect(replacement.projectedVault.securitizationLocked).toBe(spec === 160 ? 300n : 200n);
    expect(replacement.projectedVault.flexibleSecuritizationLocked).toBe(spec === 160 ? 300n : 200n);

    if (spec === 161) {
      vault.securitization = 175n;
      expect(BitcoinLock.quoteFissionCreation(quoteArgs)).toMatchObject({
        fission: { satoshis: 75n },
        maximumSatoshis: 75n,
        projectedVault: { securitizationLocked: 175n, flexibleSecuritizationLocked: 175n },
      });

      vault.securitization = 100n;
      expect(BitcoinLock.quoteFissionCreation(quoteArgs)).toMatchObject({
        fission: { satoshis: 0n },
        maximumSatoshis: 0n,
      });
    }

    vault.securitization = 300n;
    vault.securitizationTarget = 300n;
    expect(BitcoinLock.quoteFissionCreation(quoteArgs)).toMatchObject({
      fission: { satoshis: 100n },
      projectedVault: {
        securitizationLocked: spec === 160 ? 300n : 200n,
        flexibleSecuritizationLocked: spec === 160 ? 300n : 200n,
      },
    });
    const affordable = BitcoinLock.calculateResecuritizationCapacity({
      lockId: 4,
      lock,
      vault,
      securitizedSatoshis: 100n,
      replacementCoverageMicrogons: 200n,
    });
    expect(affordable.canAfford).toBe(true);
  });

  it.skipIf(spec !== 161)('checks selected amounts independently of an affordable Max', async () => {
    const storage = {
      vaultId: 7,
      ownerAccount,
      fundedSatoshis: 2_000_000n,
      isFlexible: true,
      cosignerGuarantee: {
        basis: { satoshis: 1_000_000n, microgonsAtTargetPerBtc: 100_000_000_000n, tick: 12 },
        guaranteedMicrogons: 1_000_000_000n,
        fundHoldExtensions: {},
      },
    };
    let record = registry.createType('Option<PalletBitcoinLocksLockedBitcoin>', storage);
    const client = runtimeClient({
      registry,
      consts: decorateConstants(registry, metadata.asLatest, metadata.version),
      query: {
        bitcoinLocks: { locksById: async () => record },
        vaults: {
          vaultsById: async () =>
            registry.createType('Option<ArgonPrimitivesVault>', {
              operatorAccountId: ownerAccount,
              securitization: 1_000_000_000n,
              securitizationLocked: 1_000_000_000n,
              flexibleSecuritizationLocked: 1_000_000_000n,
            }),
        },
      },
    }) as unknown as ArgonCurrentQueryClient;
    const vault = await Vault.get(client, 7, 1_000);
    const priceIndex = new PriceIndex();
    priceIndex.argonUsdPrice = priceIndex.argonUsdTargetPrice = new BigNumber(1);
    const args = {
      lockId: 4,
      lock: (await client.query.bitcoinLocks.locksById(4))!,
      vault,
      satoshis: 1_000_000n,
      priceIndex,
      microgonsAtTargetPerBtc: 50_000_000_000n,
      eligibleRates: [],
      lockFissions: [],
      currentBitcoinHeight: 0,
    };

    // Remaining Bitcoin keeps all existing coverage, so this partial allocation needs a new purchase.
    const partial = BitcoinLock.quoteFissionCreation(args);
    expect(partial).toMatchObject({ error: expect.stringContaining('Choose Max'), maximumSatoshis: 2_000_000n });
    expect(BitcoinLock.quoteFissionCreation({ ...args, satoshis: partial.maximumSatoshis! })).toMatchObject({
      fission: { satoshis: 2_000_000n, liquidityPromised: 1_000_000_000n },
      projectedVault: { securitizationLocked: 1_000_000_000n },
    });

    // Integer rounding leaves some affordable amounts beyond the conservative searched limit.
    record = registry.createType('Option<PalletBitcoinLocksLockedBitcoin>', {
      ...storage,
      fundedSatoshis: 1_000_000n,
      cosignerGuarantee: {
        ...storage.cosignerGuarantee,
        basis: { ...storage.cosignerGuarantee.basis, microgonsAtTargetPerBtc: 100_040_000_000n },
        guaranteedMicrogons: 1_000_400_000n,
      },
    });
    vault.securitization = 1_000_409_999n;
    vault.securitizationLocked = vault.flexibleSecuritizationLocked = 1_000_400_000n;
    expect(
      BitcoinLock.quoteFissionCreation({
        ...args,
        lock: (await client.query.bitcoinLocks.locksById(4))!,
        satoshis: 999_995n,
        microgonsAtTargetPerBtc: 100_041_000_000n,
      }),
    ).toMatchObject({
      fission: { satoshis: 999_995n },
      maximumSatoshis: 999_995n,
      projectedVault: { securitizationLocked: 1_000_409_999n },
    });
  });

  it('retains a Fission-owned guarantee only when the runtime assigns one', async () => {
    const record = registry.createType('Option<PalletBitcoinFissionsFission>', {
      liquidId: 2,
      lockId: 4,
      satoshis: 30n,
      microgonsAtTargetPerBtc: 1_000_000_000n,
      liquidityPromised: 300n,
      cosignerGuarantee: { ...guarantee, basis: { ...guarantee.basis, satoshis: 30n }, guaranteedMicrogons: 300n },
    });
    const client = runtimeClient({
      registry,
      query: { bitcoinFissions: { fissionByOwnerAndId: async () => record } },
    }) as unknown as ArgonCurrentQueryClient;
    const fission = await BitcoinFission.get(client, registry.createType('AccountId32', ownerAccount).toString(), 3);

    expect(fission?.liquidityPromised).toBe(300n);
    if (spec === 160) expect(fission?.cosignerGuarantee).toBeUndefined();
    else expect(fission?.cosignerGuarantee?.guaranteedMicrogons).toBe(300n);
  });

  it('uses the deployed ratio only where it exists when calculating operator capacity', async () => {
    const record = registry.createType('Option<ArgonPrimitivesVault>', {
      operatorAccountId: ownerAccount,
      securitization: 1_000n,
      securitizationTarget: 1_000n,
      securitizationLocked: 400n,
      flexibleSecuritizationLocked: 100n,
      reservedSecuritizationSpace: 50n,
      securitizationRatio: 1_500_000_000_000_000_000n,
    });
    const client = runtimeClient({
      registry,
      consts: decorateConstants(registry, metadata.asLatest, metadata.version),
      query: { vaults: { vaultsById: async () => record } },
    }) as unknown as ArgonCurrentQueryClient;
    const vault = await Vault.get(client, 7, 1_000);

    expect(vault.bitcoinCapacityMicrogons()).toBe(spec === 160 ? 666n : 1_000n);
    expect(vault.bitcoinCapacityMicrogons(900n)).toBe(spec === 160 ? 600n : 900n);
    expect(vault.availableSecuritizationSpace(vault.operatorAccountId)).toBe(600n);
    expect(vault.availableBitcoinSpace(vault.operatorAccountId)).toBe(spec === 160 ? 400n : 600n);
    if (spec === 161) expect(vault.securitizationRatio).toBeUndefined();

    vault.reservedSecuritizationSpace = 200n;
    expect(vault.availableBitcoinSpace(vault.operatorAccountId)).toBe(spec === 160 ? 333n : 500n);
    expect(vault.availableBitcoinSpace(vault.operatorAccountId, true)).toBe(spec === 160 ? 400n : 600n);
  });
});
