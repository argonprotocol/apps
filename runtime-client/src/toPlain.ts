import { AbstractInt, Bool, Bytes, CodecMap, Compact, Enum, Null, Option, Raw, Struct, Text } from '@polkadot/types-codec';
import type { Codec, INumber } from '@polkadot/types-codec/types';
import BigNumber from 'bignumber.js';
import { runtimeTypeOverrides } from './RuntimeQueries.generated.js';
import type { RuntimeTypeOverride } from './typeOverrides.js';

export class RuntimeValueNormalizationError extends Error {}

export function toPlain(
  value: unknown,
  override?: RuntimeTypeOverride,
  storageKeyOverrides?: readonly RuntimeTypeOverride[],
): unknown {
  return normalizeValue(value, '$', override, storageKeyOverrides);
}

function normalizeValue(
  value: unknown,
  path: string,
  override?: RuntimeTypeOverride,
  storageKeyOverrides?: readonly RuntimeTypeOverride[],
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint' || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (BigNumber.isBigNumber(value)) return value;

  if (value instanceof Option) {
    return value.isNone ? null : normalizeValue(value.unwrap(), path, override, storageKeyOverrides);
  }
  if (isRuntimeEvent(value)) {
    const names = value.data.names;
    const fieldOverrides = runtimeTypeOverrides.fields as Readonly<Record<string, RuntimeTypeOverride>>;
    const data = Object.fromEntries(
      [...value.data].map((entry, index) => {
        const name = names?.[index] ?? String(index);
        return [
          name,
          normalizeValue(entry, propertyPath(`${path}.data`, name), fieldOverrides[name], storageKeyOverrides),
        ];
      }),
    );
    return { section: value.section, method: value.method, data };
  }
  if (value instanceof Enum) {
    if (value.isNone || value.value instanceof Null) return { type: value.type };
    return { type: value.type, value: normalizeValue(value.value, `${path}.value`, override, storageKeyOverrides) };
  }
  if (value instanceof Struct) {
    return Object.fromEntries(
      [...value.entries()].map(([key, field]) => {
        const name = String(key);
        const fieldOverride = (runtimeTypeOverrides.fields as Readonly<Record<string, RuntimeTypeOverride>>)[name];
        return [name, normalizeValue(field, propertyPath(path, name), fieldOverride, storageKeyOverrides)];
      }),
    );
  }
  if (value instanceof CodecMap || value instanceof Map) {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of value.entries()) {
      const normalizedKey = mapKey(key, `${path}.<key>`);
      result[normalizedKey] = normalizeValue(
        entry,
        `${path}[${JSON.stringify(normalizedKey)}]`,
        override,
        storageKeyOverrides,
      );
    }
    return result;
  }
  if (value instanceof Set) {
    return [...value].map((entry, index) => normalizeValue(entry, `${path}[${index}]`, override, storageKeyOverrides));
  }
  if (value instanceof Compact || value instanceof AbstractInt) return normalizeInteger(value, override);
  if (value instanceof Bool) return value.valueOf();
  if (value instanceof Text) return value.toString();
  if (value instanceof Null) return null;
  if (isCodec(value) && /^AccountId\d*$/.test(value.toRawType())) return value.toString();
  if (isStorageKey(value)) {
    return {
      args: value.args.map((entry, index) =>
        normalizeValue(entry, `${path}.args[${index}]`, storageKeyOverrides?.[index]),
      ),
    };
  }
  if (value instanceof Bytes) return value.toU8a(true);
  if (value instanceof Raw) return value.toHex().toLowerCase();
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeValue(entry, `${path}[${index}]`, override, storageKeyOverrides));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeValue(entry, propertyPath(path, key), undefined, storageKeyOverrides),
      ]),
    );
  }
  if (isCodec(value)) {
    throw new RuntimeValueNormalizationError(`Unsupported runtime codec ${value.toRawType()} at ${path}`);
  }

  throw new RuntimeValueNormalizationError(
    `Unsupported runtime query value ${Object.prototype.toString.call(value)} at ${path}`,
  );
}

function mapKey(value: unknown, path: string): string {
  const plain = normalizeValue(value, path);
  if (typeof plain === 'string' || typeof plain === 'number' || typeof plain === 'bigint') return String(plain);
  if (typeof plain === 'boolean') return plain ? 'true' : 'false';
  if (BigNumber.isBigNumber(plain)) return plain.toFixed();
  const serialized = JSON.stringify(plain, (_key: string, nested: unknown) =>
    typeof nested === 'bigint' ? nested.toString() : nested,
  );
  if (serialized === undefined) throw new RuntimeValueNormalizationError(`Unsupported runtime map key at ${path}`);
  return serialized;
}

function propertyPath(path: string, property: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(property) ? `${path}.${property}` : `${path}[${JSON.stringify(property)}]`;
}

function normalizeInteger(
  value: Compact<INumber> | AbstractInt,
  override?: RuntimeTypeOverride,
): number | bigint | BigNumber {
  const rawType = value instanceof Compact ? value.unwrap().toRawType() : value.toRawType();
  if (override === 'number' || override === 'number[]') return value.toNumber();

  const decimalPlaces = override === 'FixedU128' ? 18 : fixedPointDecimalPlaces[rawType];
  if (decimalPlaces !== undefined) return new BigNumber(value.toString()).shiftedBy(-decimalPlaces);
  return /^u(8|16|32)$/.test(rawType) ? value.toNumber() : value.toBigInt();
}

const fixedPointDecimalPlaces: Record<string, number> = {
  Percent: 2,
  Permill: 6,
  Perbill: 9,
  Perquintill: 18,
  FixedU128: 18,
  FixedI128: 18,
};

function isCodec(value: unknown): value is Codec {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  return 'toRawType' in value && typeof value.toRawType === 'function';
}

function isStorageKey(value: unknown): value is Codec & { readonly args: readonly unknown[] } {
  return isCodec(value) && 'args' in value && Array.isArray(value.args);
}

function isRuntimeEvent(value: unknown): value is Struct & {
  readonly section: string;
  readonly method: string;
  readonly data: readonly unknown[] & { readonly names?: readonly string[] };
} {
  return value instanceof Struct && 'section' in value && 'method' in value && 'data' in value;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
