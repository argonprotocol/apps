import { TypeRegistry } from '@polkadot/types/create';
import BigNumber from 'bignumber.js';
import { describe, expect, it } from 'vitest';
import { toPlain } from '../src/toPlain.ts';

describe('toPlain', () => {
  it('normalizes a real metadata-style struct without losing integer precision', () => {
    const registry = new TypeRegistry();
    registry.register({
      TestChoiceData: { amount: 'u128' },
      TestChoice: { _enum: { Empty: 'Null', Data: 'TestChoiceData' } },
      TestRecord: {
        amount: 'u128',
        enabled: 'bool',
        maybe: 'Option<u64>',
        account: 'AccountId32',
        bytes: 'Bytes',
        values: 'Vec<u32>',
        pair: '(u32,bool)',
        ids: 'BTreeSet<u32>',
        balances: 'BTreeMap<u32,u128>',
        compositeBalances: 'BTreeMap<(u32,bool),u128>',
        choice: 'TestChoice',
      },
    });
    const account = new Uint8Array(32).fill(7);
    const codec = registry.createType('TestRecord', {
      amount: '340282366920938463463374607431768211455',
      enabled: true,
      maybe: 42,
      account,
      bytes: '0x0102ff',
      values: [1, 2],
      pair: [3, false],
      ids: [2, 1],
      balances: new Map([
        [4, '9007199254740993'],
        [5, '6'],
      ]),
      compositeBalances: new Map([[[7, true], '8']]),
      choice: { Data: { amount: 9 } },
    });

    const plain = toPlain(codec) as Record<string, unknown>;

    expect(plain).toMatchObject({
      amount: 340282366920938463463374607431768211455n,
      enabled: true,
      maybe: 42n,
      account: registry.createType('AccountId32', account).toString(),
      bytes: new Uint8Array([1, 2, 255]),
      values: [1, 2],
      pair: [3, false],
      ids: [1, 2],
      choice: { type: 'Data', value: { amount: 9n } },
    });
    expect(plain.balances).toEqual({ 4: 9007199254740993n, 5: 6n });
    expect(Object.getPrototypeOf(plain.balances)).toBeNull();
    expect(Object.keys(plain.compositeBalances as object)).toEqual(['[7,true]']);
    expect(Object.values(plain.compositeBalances as object)).toEqual([8n]);
  });

  it('uses null for Option::None and omits enum value for unit variants', () => {
    const registry = new TypeRegistry();
    registry.register({ TestChoice: { _enum: { Empty: 'Null', Data: 'u64' } } });

    expect(toPlain(registry.createType('Option<u128>', null))).toBeNull();
    expect(toPlain(registry.createType('TestChoice', 'Empty'))).toEqual({ type: 'Empty' });
  });

  it('uses numbers for u8, u16, and u32 while wider unsigned integers stay bigint', () => {
    const registry = new TypeRegistry();

    expect(toPlain(registry.createType('u8', 1))).toBe(1);
    expect(toPlain(registry.createType('u16', 2))).toBe(2);
    expect(toPlain(registry.createType('Compact<u32>', 3))).toBe(3);
    expect(toPlain(registry.createType('u64', 4))).toBe(4n);
  });

  it('converts declared fixed-point codecs to exact scaled BigNumbers', () => {
    const registry = new TypeRegistry();

    expect(toPlain(registry.createType('Permill', 300_000))).toEqual(new BigNumber('0.3'));
    expect(toPlain(registry.createType('FixedU128', 1_500_000_000_000_000_000n))).toEqual(new BigNumber('1.5'));
  });

  it('reports the recursive path for an unsupported value', () => {
    expect(() => toPlain({ nested: [new Date()] })).toThrow('$.nested[0]');
  });
});
