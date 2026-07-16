import { getOfflineRegistry, type GenericEvent } from '@argonprotocol/mainchain';
import { getTypeDef } from '@polkadot/types-create';
import { getHistoricalEventFieldAlternatives } from '../../src/HistoricalEventSpecs.ts';

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
  const data = getOfflineRegistry().createType<GenericEvent['data']>(
    `(${fields.map(([, type]) => type).join(',')})`,
    fields.map(([name]) => values[name]),
  );
  Object.defineProperties(data, {
    names: { value: fields.map(([name]) => name) },
    typeDef: { value: fields.map(([, type]) => getTypeDef(type)) },
  });
  return data;
}
