import { getOfflineRegistry, type PalletTreasuryFrameVaultCapital } from '@argonprotocol/mainchain';
import type { Option } from '@polkadot/types-codec';
import { type MainchainClients } from '@argonprotocol/apps-core';
import { runtimeClient } from '@argonprotocol/runtime-client';
import { expect, it } from 'vitest';
import { Config } from '../lib/Config.ts';
import { VaultCalculator } from '../lib/VaultCalculator.ts';

it.each([
  { target: 0n, expected: 65_891_472n },
  { target: 10_000_000_000n, expected: 13_178_294n },
])(
  'includes new vault capital in the projected network denominator with target $target',
  async ({ target, expected }) => {
    const registry = getOfflineRegistry();
    const capital = registry.createType<Option<PalletTreasuryFrameVaultCapital>>(
      'Option<PalletTreasuryFrameVaultCapital>',
      {
        frameId: 10,
        totalActiveBonds: 0,
        targetSecuritization: target,
        totalSecuritization: 1_000_000_000n,
        vaultSecuritizationPositions: {},
      },
    );
    const client = runtimeClient({
      registry,
      consts: {
        treasury: {
          palletId: registry.createType('PalletId', '0x74657374706f6f6c'),
          percentForVaultPool: registry.createType('Percent', 51),
          percentForArgonBondPool: registry.createType('Percent', 16),
        },
      },
      query: {
        system: { account: async () => registry.createType('AccountInfo', { data: { free: 1_000_000_000n } }) },
        miningSlot: { minersByCohort: { entries: async () => [[{ args: [1] }, [{ bid: 1_000_000_000n }]]] } },
        vaults: { revenuePerFrameByVault: { entries: async () => [] } },
        treasury: { currentFrameVaultCapital: async () => capital },
        priceIndex: { historicArgonotAverageByFrame: async () => ({}) },
      },
    });
    const calculator = new VaultCalculator({
      prunedClientOrArchivePromise: Promise.resolve(client),
      archiveClientPromise: Promise.resolve(client),
    } as unknown as MainchainClients);
    const rules = {
      ...(Config.getDefault('vaultingRules') as Config['vaultingRules']),
      baseMicrogonCommitment: 1_000_000_000n,
      btcFlatFee: 0n,
      btcPctFee: 0,
      btcUtilizationPctMax: 100,
      poolUtilizationPctMax: 100,
    };
    await calculator.load(rules);
    expect(calculator.calculateInternalRevenue('High', 'High')).toBe(expected);
    expect(calculator.calculateInternalPoolCapital()).toBe(0n);
    expect(capital.unwrap().totalSecuritization.toBigInt()).toBe(1_000_000_000n);
  },
);
