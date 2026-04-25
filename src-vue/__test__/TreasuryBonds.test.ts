import { describe, expect, it } from 'vitest';
import { MICROGONS_PER_ARGON, TreasuryBonds } from '@argonprotocol/apps-core';

const oneBond = BigInt(MICROGONS_PER_ARGON);

describe('getCurrentFrameBondLots', () => {
  it('maps legacy current-frame bond holders into synthetic bond lots', async () => {
    const operator = '5Operator';
    const external = '5External';

    const client = {
      query: {
        treasury: {
          vaultPoolsByFrame: async (frameId: number) => {
            expect(frameId).toBe(42);

            return {
              entries: () => [
                [
                  codecNumber(7),
                  {
                    bondHolders: {
                      entries: () => [
                        [accountId(operator), codecBigint(120n * oneBond)],
                        [accountId(external), codecBigint(30n * oneBond)],
                      ],
                    },
                    vaultSharingPercent: codecBigint(400_000n),
                    distributedEarnings: some(codecBigint(90n * oneBond)),
                  },
                ],
              ],
            };
          },
        },
      },
    } as unknown as Parameters<typeof TreasuryBonds.getCurrentFrameBondLots>[0];

    await expect(TreasuryBonds.getCurrentFrameBondLots(client, 7, operator, 42)).resolves.toEqual({
      bondLots: [
        {
          id: `account:${operator}`,
          accountId: operator,
          bonds: 120,
          prorata: 800_000_000_000_000_000n,
          isOperator: true,
        },
        {
          id: `account:${external}`,
          accountId: external,
          bonds: 30,
          prorata: 200_000_000_000_000_000n,
          isOperator: false,
        },
      ],
      vaultSharingPct: 40,
      totalActiveBonds: 150,
      distributedEarnings: 90n * oneBond,
    });
  });

  it('includes runtime bond lot details with current-frame bond lots', async () => {
    const operator = '5Operator';
    const external = '5External';

    const client = {
      query: {
        treasury: {
          currentFrameVaultCapital: async () =>
            some({
              vaults: {
                entries: () => [
                  [
                    codecNumber(7),
                    {
                      eligibleBonds: codecNumber(100),
                      vaultSharingPercent: codecBigint(400_000n),
                      bondLotAllocations: [
                        { bondLotId: codecNumber(2), prorata: codecBigint(250_000_000_000_000_000n) },
                      ],
                    },
                  ],
                ],
              },
            }),
          bondLotById: {
            multi: async (ids: number[]) => {
              expect(ids).toEqual([2]);
              return [
                some(
                  runtimeBondLot({
                    bonds: 40,
                    owner: external,
                    vaultId: 7,
                    createdFrame: 33,
                    cumulativeEarnings: 5n * oneBond,
                  }),
                ),
              ];
            },
          },
        },
      },
    } as unknown as Parameters<typeof TreasuryBonds.getCurrentFrameBondLots>[0];

    const result = await TreasuryBonds.getCurrentFrameBondLots(client, 7, operator, 42);

    expect(result.bondLots).toHaveLength(1);
    expect(result.bondLots[0]).toMatchObject({
      id: 'lot:2',
      accountId: external,
      bonds: 25,
      prorata: 250_000_000_000_000_000n,
      isOperator: false,
      details: {
        id: 2,
        accountId: external,
        vaultId: 7,
        bonds: 40,
        createdFrame: 33,
        lifetimeEarnings: 5n * oneBond,
      },
    });
  });
});

describe('getBondLots', () => {
  it('translates legacy funder state into active and returning bond lots', async () => {
    const client = {
      query: {
        treasury: {
          funderStateByVaultAndAccount: {
            entries: async (vaultId: number) => {
              expect(vaultId).toBe(7);

              return [
                [
                  { args: [codecNumber(7), accountId('5Owner')] },
                  some(
                    funderState({
                      heldPrincipal: 120n * oneBond,
                      pendingUnlockAmount: 30n * oneBond,
                      pendingUnlockAtFrame: 55,
                      lifetimeCompoundedEarnings: 5n * oneBond,
                      lifetimePrincipalDeployed: 1_000n * oneBond,
                      lifetimePrincipalLastBasisFrame: 42,
                    }),
                  ),
                ],
              ];
            },
          },
        },
      },
    } as unknown as Parameters<typeof TreasuryBonds.getBondLots>[0];

    const lots = await TreasuryBonds.getBondLots(client, 7, '5Owner');

    expect(lots).toHaveLength(2);
    expect(lots[0]).toMatchObject({
      accountId: '5Owner',
      vaultId: 7,
      bonds: 90,
      activeBonds: 90,
      returningBonds: 0,
      lifetimeEarnings: 5n * oneBond,
      lifetimeBondedFrameMicrogons: 1_000n * oneBond,
      canRelease: true,
    });
    expect(lots[1]).toMatchObject({
      bonds: 30,
      activeBonds: 0,
      returningBonds: 30,
      releaseFrame: 55,
      canRelease: false,
    });
  });

  it('loads runtime bond lots with one multi query across vault and account ids', async () => {
    const multiCalls: number[][] = [];
    const client = {
      query: {
        treasury: {
          bondLotsByVault: async (vaultId: number) => {
            expect(vaultId).toBe(7);

            return [{ bondLotId: codecNumber(1) }, { bondLotId: codecNumber(2) }];
          },
          bondLotIdsByAccount: {
            keys: async (account: string) => {
              expect(account).toBe('5Owner');

              return [{ args: [accountId('5Owner'), codecNumber(2)] }, { args: [accountId('5Owner'), codecNumber(3)] }];
            },
          },
          bondLotById: {
            multi: async (ids: number[]) => {
              multiCalls.push(ids);

              return ids.map(id => {
                if (id === 1) return some(runtimeBondLot({ bonds: 10, owner: '5External', vaultId: 7 }));
                if (id === 2) return some(runtimeBondLot({ bonds: 20, owner: '5Owner', vaultId: 7 }));
                return some(runtimeBondLot({ bonds: 30, owner: '5Owner', vaultId: 8 }));
              });
            },
          },
        },
      },
    } as unknown as Parameters<typeof TreasuryBonds.getBondLots>[0];

    const lots = await TreasuryBonds.getBondLots(client, 7, '5Owner');

    expect(multiCalls).toEqual([[1, 2, 3]]);
    expect(lots.map(lot => ({ id: lot.id, bonds: lot.bonds, isOwn: lot.isOwn }))).toEqual([
      { id: 1, bonds: 10, isOwn: false },
      { id: 2, bonds: 20, isOwn: true },
    ]);
  });
});

describe('buildBuyBondTx', () => {
  it('submits whole bond counts to the runtime', async () => {
    const tx = {};
    const calls: Array<[number, number]> = [];

    const client = {
      tx: {
        treasury: {
          buyBonds: (vaultId: number, bonds: number) => {
            calls.push([vaultId, bonds]);
            return tx;
          },
        },
      },
    } as unknown as Parameters<typeof TreasuryBonds.buildBuyBondTx>[0]['client'];

    await expect(
      TreasuryBonds.buildBuyBondTx({
        client,
        vaultId: 7,
        accountId: '5Owner',
        bondPurchaseMicrogons: 12n * oneBond,
      }),
    ).resolves.toBe(tx);
    expect(calls).toEqual([[7, 12]]);
  });

  it('uses the legacy set-allocation call until buy-bonds is live', async () => {
    const tx = {};
    const calls: Array<[number, bigint]> = [];

    const funderStateByVaultAndAccount = async (vaultId: number, account: string) => {
      expect(vaultId).toBe(7);
      expect(account).toBe('5Owner');

      return some(
        funderState({
          heldPrincipal: 40n * oneBond,
          pendingUnlockAmount: 10n * oneBond,
        }),
      );
    };
    const client = {
      query: {
        treasury: {
          funderStateByVaultAndAccount,
        },
      },
      tx: {
        treasury: {
          setAllocation: (vaultId: number, amount: bigint) => {
            calls.push([vaultId, amount]);
            return tx;
          },
        },
      },
    } as unknown as Parameters<typeof TreasuryBonds.buildBuyBondTx>[0]['client'];

    await expect(
      TreasuryBonds.buildBuyBondTx({
        client,
        vaultId: 7,
        accountId: '5Owner',
        bondPurchaseMicrogons: 12n * oneBond,
      }),
    ).resolves.toBe(tx);
    expect(calls).toEqual([[7, 42n * oneBond]]);
  });

  it('rejects fractional bond purchases before submission', async () => {
    const client = {
      tx: {
        treasury: {
          buyBonds: () => ({}),
        },
      },
    } as unknown as Parameters<typeof TreasuryBonds.buildBuyBondTx>[0]['client'];

    await expect(
      TreasuryBonds.buildBuyBondTx({
        client,
        vaultId: 7,
        accountId: '5Owner',
        bondPurchaseMicrogons: 12n * oneBond + 1n,
      }),
    ).rejects.toThrow('Treasury bonds must be purchased in whole-ARGN bond units.');
  });
});

describe('buildReleaseBondLotTx', () => {
  it('liquidates runtime bond lots by id', async () => {
    const tx = {};
    const calls: number[] = [];
    const client = {
      tx: {
        treasury: {
          liquidateBondLot: (bondLotId: number) => {
            calls.push(bondLotId);
            return tx;
          },
        },
      },
    } as unknown as Parameters<typeof TreasuryBonds.buildReleaseBondLotTx>[0]['client'];

    await expect(
      TreasuryBonds.buildReleaseBondLotTx({
        client,
        bondLot: {
          id: 22,
          vaultId: 7,
          accountId: '5Owner',
          activeBondMicrogons: 12n * oneBond,
        },
      }),
    ).resolves.toBe(tx);
    expect(calls).toEqual([22]);
  });

  it('uses the legacy set-allocation call until bond lots are live', async () => {
    const tx = {};
    const calls: Array<[number, bigint]> = [];

    const client = {
      query: {
        treasury: {
          funderStateByVaultAndAccount: async (vaultId: number, account: string) => {
            expect(vaultId).toBe(7);
            expect(account).toBe('5Owner');

            return some(
              funderState({
                heldPrincipal: 40n * oneBond,
                pendingUnlockAmount: 10n * oneBond,
              }),
            );
          },
        },
      },
      tx: {
        treasury: {
          setAllocation: (vaultId: number, amount: bigint) => {
            calls.push([vaultId, amount]);
            return tx;
          },
        },
      },
    } as unknown as Parameters<typeof TreasuryBonds.buildReleaseBondLotTx>[0]['client'];

    await expect(
      TreasuryBonds.buildReleaseBondLotTx({
        client,
        bondLot: {
          id: 0,
          vaultId: 7,
          accountId: '5Owner',
          activeBondMicrogons: 12n * oneBond,
        },
      }),
    ).resolves.toBe(tx);
    expect(calls).toEqual([[7, 18n * oneBond]]);
  });
});

function codecNumber(value: number) {
  return {
    toNumber: () => value,
  };
}

function codecBigint(value: bigint) {
  return {
    toBigInt: () => value,
  };
}

function accountId(value: string) {
  return {
    toString: () => value,
  };
}

function some<T>(value: T) {
  return {
    isNone: false,
    isSome: true,
    unwrap: () => value,
  };
}

function none() {
  return {
    isNone: true,
    isSome: false,
    unwrap: () => {
      throw new Error('Cannot unwrap none');
    },
  };
}

function optionNumber(value?: number) {
  return value === undefined ? none() : some(codecNumber(value));
}

function funderState(args: {
  heldPrincipal: bigint;
  pendingUnlockAmount?: bigint;
  pendingUnlockAtFrame?: number;
  lifetimeCompoundedEarnings?: bigint;
  lifetimePrincipalDeployed?: bigint;
  lifetimePrincipalLastBasisFrame?: number;
}) {
  return {
    heldPrincipal: codecBigint(args.heldPrincipal),
    pendingUnlockAmount: codecBigint(args.pendingUnlockAmount ?? 0n),
    pendingUnlockAtFrame: optionNumber(args.pendingUnlockAtFrame),
    lifetimeCompoundedEarnings: codecBigint(args.lifetimeCompoundedEarnings ?? 0n),
    lifetimePrincipalDeployed: codecBigint(args.lifetimePrincipalDeployed ?? 0n),
    lifetimePrincipalLastBasisFrame: codecNumber(args.lifetimePrincipalLastBasisFrame ?? 0),
  };
}

function runtimeBondLot(args: {
  bonds: number;
  owner: string;
  vaultId: number;
  createdFrame?: number;
  cumulativeEarnings?: bigint;
}) {
  return {
    owner: accountId(args.owner),
    vaultId: codecNumber(args.vaultId),
    bonds: codecNumber(args.bonds),
    cumulativeEarnings: codecBigint(args.cumulativeEarnings ?? 0n),
    lastFrameEarnings: none(),
    lastFrameEarningsFrameId: none(),
    participatedFrames: codecNumber(0),
    createdFrameId: codecNumber(args.createdFrame ?? 0),
    releaseReason: none(),
    releaseFrameId: none(),
  };
}
