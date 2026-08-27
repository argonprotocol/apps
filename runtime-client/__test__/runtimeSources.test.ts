import { describe, expect, it } from 'vitest';
import { readArgonSpecVersion, upsertCurrentRuntimeSource } from '../src/history/runtimeSources.ts';

describe('runtime source registry', () => {
  it('replaces the canonical source when another pin has the newest spec', () => {
    expect(
      upsertCurrentRuntimeSource({ 157: ['1.4.11'], 158: ['1.4.12'] }, { specVersion: 158, source: '1.4.13' }),
    ).toEqual({ 157: ['1.4.11'], 158: ['1.4.13'] });
  });

  it('appends a newer spec without changing frozen multi-source history', () => {
    expect(
      upsertCurrentRuntimeSource(
        { 116: ['1.0.18', '1.1.0-rc.1'], 158: ['1.4.12'] },
        { specVersion: 159, source: '1.4.13' },
      ),
    ).toEqual({
      116: ['1.0.18', '1.1.0-rc.1'],
      158: ['1.4.12'],
      159: ['1.4.13'],
    });
  });

  it('refuses to overwrite an older frozen spec during an ordinary pin', () => {
    expect(() =>
      upsertCurrentRuntimeSource({ 157: ['1.4.11'], 158: ['1.4.12'] }, { specVersion: 157, source: 'replacement' }),
    ).toThrow('older frozen runtime spec 157');
  });

  it('reads the exact runtime spec from Rust source with numeric separators', () => {
    expect(
      readArgonSpecVersion(`RuntimeVersion {\n  spec_name: create_runtime_str!("argon"),\n  spec_version: 1_234,\n}`),
    ).toBe(1234);
  });
});
