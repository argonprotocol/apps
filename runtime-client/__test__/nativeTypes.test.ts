import Fs from 'node:fs';
import Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readRuntimeQueries } from '../src/generation/queryDeclarations.ts';

const packageRoot = Path.resolve(Path.dirname(fileURLToPath(import.meta.resolve('@argonprotocol/mainchain'))), '..');
const querySource = Fs.readFileSync(Path.join(packageRoot, 'src/interfaces/augment-api-query.ts'), 'utf8');
const lookupSource = Fs.readFileSync(Path.join(packageRoot, 'src/interfaces/types-lookup.ts'), 'utf8');
const definitionSource = Fs.readFileSync(Path.join(packageRoot, 'src/interfaces/lookup.ts'), 'utf8');

describe('native runtime query types', () => {
  it('erases real Bond and Bitcoin storage codecs into exact native values', () => {
    const queries = readRuntimeQueries(querySource, lookupSource, definitionSource);
    const bondLot = queries.treasury?.bondLotById?.result;
    const bitcoinLock = queries.bitcoinLocks?.locksByUtxoId?.result;

    expect(bondLot).toContain('readonly bonds: number');
    expect(bondLot).toContain('readonly sharingPercent: BigNumber');
    expect(bondLot).toContain("{ readonly type: 'Vault'; readonly value:");
    expect(bondLot).toContain("{ readonly type: 'Argonot' }");
    expect(bitcoinLock).toContain('readonly fundHoldExtensions: Record<string, bigint>');
    expect(`${bondLot}${bitcoinLock}`).not.toMatch(/\bCompact<|\bOption<|\bStruct\b|\bEnum\b/);
  });

  it('preserves native option, vector, tuple, bytes, and account policies', () => {
    const queries = readRuntimeQueries(querySource, lookupSource, definitionSource);

    expect(queries.authorship?.author?.result).toBe('string | null');
    expect(queries.bitcoinLocks?.microgonPerBtcHistory?.result).toBe('readonly (readonly [bigint, bigint])[]');
    expect(queries.system?.extrinsicData?.result).toBe('Uint8Array');
    expect(queries.system?.blockHash?.result).toBe('string');
  });
});
