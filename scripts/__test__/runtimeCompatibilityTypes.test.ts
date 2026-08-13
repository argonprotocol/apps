import { describe, expect, it } from 'vitest';
import {
  createRuntimeCompatibilityModule,
  readRuntimeCompatibilityProvenance,
  type RuntimeInterfaceSources,
} from '../runtimeCompatibilityTypes.ts';

const provenance = {
  clientVersion: '1.4.11',
  finalizedBlockHash: `0x${'1'.repeat(64)}`,
  specVersion: 157,
};

describe('runtime compatibility type extraction', () => {
  it('turns generated global augmentations into one namespaced module', () => {
    const generated = createRuntimeCompatibilityModule(createSources(), provenance);

    expect(generated).toContain('export namespace RuntimeSpec157 {');
    expect(generated).toContain('export interface PreviousValue extends Struct');
    expect(generated).toContain('export type PreviousMarker = Null');
    expect(generated).toContain('export interface Transactions');
    expect(generated).toContain('export interface Queries');
    expect(generated).toContain('export interface Events');
    expect(generated).toContain('export interface RuntimeCalls');
    expect(generated).not.toContain('declare module');
    expect(generated).not.toContain("import '@polkadot/types/lookup'");
    expect(generated).not.toContain("from '@polkadot/types/lookup'");
  });

  it('merges imports deterministically and keeps rollover changes inline', () => {
    const generated = createRuntimeCompatibilityModule(createSources(), provenance);
    const regenerated = createRuntimeCompatibilityModule(createSources({ reverseLookupImports: true }), provenance);
    const nextSpec = createRuntimeCompatibilityModule(createSources(), { ...provenance, specVersion: 158 });

    expect(regenerated).toBe(generated);
    expect(generated.match(/import type .*'@polkadot\/types-codec';/g)).toHaveLength(1);
    expect(withoutVersionLines(nextSpec)).toBe(withoutVersionLines(generated));
  });

  it('records the finalized mainnet origin used for repeated pin checks', () => {
    const generated = createRuntimeCompatibilityModule(createSources(), provenance);

    expect(readRuntimeCompatibilityProvenance(generated)).toEqual(provenance);
  });
});

function createSources(options: { reverseLookupImports?: boolean } = {}): RuntimeInterfaceSources {
  const lookupTypes = options.reverseLookupImports ? 'Struct, Null' : 'Null, Struct';

  return {
    lookup: `
import '@polkadot/types/lookup';
import type { ${lookupTypes} } from '@polkadot/types-codec';

declare module '@polkadot/types/lookup' {
  interface PreviousValue extends Struct {
    readonly value: Null;
  }

  type PreviousMarker = Null;
} // declare module
`,
    tx: createApiSource(
      '@polkadot/api-base/types/submittable',
      'AugmentedSubmittables',
      'previous: { submit: PreviousValue };',
    ),
    query: createApiSource(
      '@polkadot/api-base/types/storage',
      'AugmentedQueries',
      'previous: { read: PreviousValue };',
    ),
    events: createApiSource(
      '@polkadot/api-base/types/events',
      'AugmentedEvents',
      'previous: { Changed: PreviousValue };',
    ),
    runtime: createApiSource(
      '@polkadot/api-base/types/calls',
      'AugmentedCalls',
      'previous: { call: () => PreviousValue };',
      false,
    ),
  };
}

function createApiSource(moduleName: string, interfaceName: string, member: string, importsLookup = true): string {
  return `
import type {} from '${moduleName}';
import type { ApiTypes } from '@polkadot/api-base/types';
import type { Null } from '@polkadot/types-codec';
${importsLookup ? "import type { PreviousValue } from '@polkadot/types/lookup';" : ''}

declare module '${moduleName}' {
  interface ${interfaceName}<ApiType extends ApiTypes> {
    ${member}
  }
} // declare module
`;
}

function withoutVersionLines(value: string): string {
  return value
    .split('\n')
    .filter(line => !line.includes('Runtime compatibility source:') && !line.startsWith('export namespace RuntimeSpec'))
    .join('\n');
}
