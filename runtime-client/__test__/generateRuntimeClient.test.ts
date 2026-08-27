import Fs from 'node:fs';
import Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateRuntimeQueryTypes } from '../src/generation/generateRuntimeQueryTypes.ts';

const packageRoot = Path.resolve(Path.dirname(fileURLToPath(import.meta.resolve('@argonprotocol/mainchain'))), '..');

describe('runtime query generator', () => {
  it('emits the full native query surface with typed historical results', () => {
    const output = generateRuntimeQueryTypes([
      {
        specVersion: 158,
        source: '@argonprotocol/mainchain@1.4.12',
        querySource: Fs.readFileSync(Path.join(packageRoot, 'src/interfaces/augment-api-query.ts'), 'utf8'),
        lookupSource: Fs.readFileSync(Path.join(packageRoot, 'src/interfaces/types-lookup.ts'), 'utf8'),
        definitionSource: Fs.readFileSync(Path.join(packageRoot, 'src/interfaces/lookup.ts'), 'utf8'),
      },
    ]);

    expect(output).toContain('readonly authorship:');
    expect(output).toContain('readonly system:');
    expect(output).toContain('readonly treasury:');
    expect(output).toContain('readonly bitcoinLocks:');
    expect(output).toContain('export type HistoricalQueryResultVariants<');
    expect(output).toContain('export type HistoricalQueryRecord<');
    expect(output).toContain('readonly bondLotById: RuntimeQuery<');
    expect(output).not.toMatch(/historicalStorageTypes|@polkadot\/types\/lookup|\bStruct\b|\bEnum\b|\bOption</);
  });
});
