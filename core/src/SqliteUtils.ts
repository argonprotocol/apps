import type { SQLInputValue } from 'node:sqlite';
import { hexToU8a } from '@argonprotocol/mainchain';
import { JsonExt } from './JsonExt.js';

export type ISqliteFieldTypes = Partial<
  Record<'bigint' | 'json' | 'date' | 'boolean' | 'bigintJson' | 'uint8array', string[]>
>;

export function convertFromSqliteFields<T>(obj: unknown, fields: ISqliteFieldTypes): T {
  if (Array.isArray(obj)) {
    const items = obj as unknown[];
    return items.map(item => convertFromSqliteFields(item, fields)) as T;
  }

  if (!obj || typeof obj !== 'object') {
    return obj as T;
  }

  const record = obj as Record<string, unknown>;

  for (const [type, fieldNames] of Object.entries(fields)) {
    for (const fieldName of fieldNames ?? []) {
      if (!(fieldName in record)) continue;

      const value = record[fieldName];
      if (value === null || value === undefined || value === '') {
        record[fieldName] = null;
        continue;
      }

      if (type === 'bigint') {
        record[fieldName] = BigInt(String(value));
        continue;
      }

      if (type === 'boolean') {
        record[fieldName] = Number(value) === 1;
        continue;
      }

      if (type === 'bigintJson' || type === 'json') {
        record[fieldName] = JsonExt.parse(String(value));
        continue;
      }

      if (type === 'date') {
        if (typeof value === 'string') {
          const hasExplicitOffset = /[+-]\d{2}:?\d{2}$/.test(value);
          const isLegacyUtcFormat = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);

          if (value.endsWith('Z') || hasExplicitOffset) {
            record[fieldName] = new Date(value);
          } else if (isLegacyUtcFormat) {
            record[fieldName] = new Date(value.replace(' ', 'T') + 'Z');
          } else {
            record[fieldName] = new Date(value);
          }
        } else {
          record[fieldName] = new Date(String(value));
        }
        continue;
      }

      if (type === 'uint8array') {
        if (typeof value === 'string' && value.startsWith('0x')) {
          record[fieldName] = hexToU8a(value);
        } else if (Array.isArray(value)) {
          record[fieldName] = Uint8Array.from(value);
        }
        continue;
      }

      throw new Error(`${fieldName} has unknown sqlite type: ${type}`);
    }
  }

  return obj as T;
}

export function toSqliteParams(record: Record<string, unknown>): Record<string, SQLInputValue> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [`$${key}`, toSqliteValue(value)]));
}

export function toSqliteValue(value: unknown): SQLInputValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') return JsonExt.stringify(value);
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (ArrayBuffer.isView(value)) return value as NodeJS.ArrayBufferView;
  throw new TypeError(`Unsupported sqlite value type: ${typeof value}`);
}
