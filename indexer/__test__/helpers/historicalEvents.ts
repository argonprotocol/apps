import type { GenericEvent } from '@argonprotocol/mainchain';
import { getTypeDef } from '@polkadot/types-create';
import { getHistoricalEventFieldAlternatives } from '@argonprotocol/runtime-client/events';
import { getBundledMetadata } from '@argonprotocol/runtime-client';
import { Metadata, TypeRegistry } from '@polkadot/types';
import type { HexString } from '@polkadot/util/types';
import { readRuntimeSource } from '@argonprotocol/runtime-client/generation/readRuntimeSource';

// These deployed versions share a spec number with different published snapshots and are deliberately not bundled.
const [source116, source148] = await Promise.all([readRuntimeSource('1.0.18'), readRuntimeSource('1.4.2')]);
const historicalMetadata: Record<number, HexString> = {
  116: JSON.parse(source116.metadataSource!).result,
  148: JSON.parse(source148.metadataSource!).result,
};

export function createHistoricalEventData(
  specVersion: number,
  section: string,
  method: string,
  values: Readonly<Record<string, unknown>>,
): GenericEvent['data'] {
  const declarations = getHistoricalEventFieldAlternatives(specVersion, section, method).filter(fields => {
    const fieldNames = Object.keys(fields);
    return fieldNames.length === Object.keys(values).length && fieldNames.every(name => name in values);
  });
  if (declarations?.length !== 1) {
    throw new Error(`${section}.${method} does not uniquely match a declaration at spec ${specVersion}`);
  }

  const fields = Object.entries(declarations[0]);
  const registry = new TypeRegistry();
  const metadata =
    Object.entries(getBundledMetadata()).find(([key]) => key.endsWith(`-${specVersion}`))?.[1] ??
    historicalMetadata[specVersion];
  if (!metadata) throw new Error(`Missing test metadata for runtime ${specVersion}`);
  registry.setMetadata(new Metadata(registry, metadata), undefined, undefined, true);
  const data =
    fields.length === 1
      ? registry.createType<GenericEvent['data']>(`Vec<${fields[0][1]}>`, [values[fields[0][0]]])
      : registry.createType<GenericEvent['data']>(
          `(${fields.map(([, type]) => type).join(',')})`,
          fields.map(([name]) => values[name]),
        );
  Object.defineProperties(data, {
    names: { value: fields.map(([name]) => name) },
    typeDef: { value: fields.map(([, type]) => getTypeDef(type)) },
    ...Object.fromEntries(fields.map(([name], index) => [name, { value: data[index] }])),
  });
  return data;
}
