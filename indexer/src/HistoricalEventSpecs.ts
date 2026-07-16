import type { GenericEvent } from '@argonprotocol/mainchain';
import {
  historicalEventChanges as generatedEventChanges,
  historicalEventSpecSources as generatedSpecSources,
} from './HistoricalEventSpecs.generated.js';

type HistoricalEventFields = Readonly<Record<string, string>>;
type HistoricalEventVersion = { spec: number; fields: HistoricalEventFields[] };

export type HistoricalEventData = readonly [name: string, type: string, value: unknown][];

export class AccountActivityCoverageError extends Error {}

const changesByEvent = new Map<string, HistoricalEventVersion[]>();
for (const change of generatedEventChanges) {
  const eventChanges = changesByEvent.get(`${change.section}.${change.method}`) ?? [];
  let specChange = eventChanges.at(-1);
  if (specChange?.spec !== change.spec) {
    specChange = { spec: change.spec, fields: [] };
    eventChanges.push(specChange);
    changesByEvent.set(`${change.section}.${change.method}`, eventChanges);
  }
  if (change.fields) specChange.fields.push(change.fields);
}

export const historicalEventSpecSources: Readonly<Record<number, string>> = generatedSpecSources;

export const supportedHistoricalEventSpecs = Object.keys(historicalEventSpecSources).map(Number);

export function getHistoricalEventFields(
  specVersion: number,
  section: string,
  method: string,
): readonly string[] | undefined {
  const fields = getEventDeclarations(specVersion, section, method)[0];
  return fields ? Object.keys(fields) : undefined;
}

export function getHistoricalEventFieldAlternatives(
  specVersion: number,
  section: string,
  method: string,
): readonly HistoricalEventFields[] {
  return getEventDeclarations(specVersion, section, method);
}

export function readHistoricalEventData(
  specVersion: number,
  event: Pick<GenericEvent, 'data' | 'method' | 'section'>,
): HistoricalEventData | undefined {
  if (!historicalEventSpecSources[specVersion]) {
    const names = event.data.names;
    const typeDefs = event.data.typeDef;
    if (names?.length === event.data.length && typeDefs.length === event.data.length) {
      return names.map((name, index) => [name, typeDefs[index].type, event.data[index].toHuman()]);
    }

    throw new AccountActivityCoverageError(
      `${event.section}.${event.method} at runtime spec ${specVersion} does not expose complete live field metadata and has no copied declaration fallback`,
    );
  }

  const declarations = getEventDeclarations(specVersion, event.section, event.method);
  if (!declarations.length) return;

  const eventFieldNames = event.data.names;
  const matchingDeclarations = declarations.filter(fields => {
    const fieldNames = Object.keys(fields);
    if (eventFieldNames?.length) {
      return (
        fieldNames.length === eventFieldNames.length &&
        fieldNames.every((name, index) => eventFieldNames[index] === name)
      );
    }
    return fieldNames.length === event.data.length;
  });
  if (matchingDeclarations.length !== 1) {
    const source = historicalEventSpecSources[specVersion];
    throw new AccountActivityCoverageError(
      `${event.section}.${event.method} at runtime spec ${specVersion} does not uniquely match the declarations copied from ${source}`,
    );
  }

  const entries = Object.entries(matchingDeclarations[0]);
  if (entries.length !== event.data.length) {
    const source = historicalEventSpecSources[specVersion];
    throw new AccountActivityCoverageError(
      `${event.section}.${event.method} at runtime spec ${specVersion} has ${event.data.length} fields; ${source} declares ${entries.length}`,
    );
  }

  return entries.map(([name, type], index) => [name, type, event.data[index].toHuman()]);
}

function getEventDeclarations(specVersion: number, section: string, method: string): readonly HistoricalEventFields[] {
  if (!historicalEventSpecSources[specVersion]) {
    throw new AccountActivityCoverageError(`No copied event declarations for runtime spec ${specVersion}`);
  }

  const changes = changesByEvent.get(`${section}.${method}`) ?? [];
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    if (changes[index].spec <= specVersion) return changes[index].fields;
  }
  return [];
}
