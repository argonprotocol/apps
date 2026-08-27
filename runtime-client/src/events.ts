import type { GenericEvent } from '@argonprotocol/mainchain';
import {
  historicalEventChanges as generatedEventChanges,
  historicalEventSpecSources as generatedSpecSources,
} from './HistoricalEvents.generated.js';
import type { HistoricalEvent } from './HistoricalEvents.generated.js';
import { runtimeTypeOverrides } from './RuntimeQueries.generated.js';
import { toPlain } from './toPlain.js';
import type { RuntimeTypeOverride } from './typeOverrides.js';

export type { HistoricalEvent } from './HistoricalEvents.generated.js';

type HistoricalEventFields = Readonly<Record<string, string>>;
type HistoricalEventVersion = { spec: number; fields: HistoricalEventFields[] };

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
const historicalEventKeys = new Set(changesByEvent.keys());

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

export function toHistoricalEvent(event: Pick<GenericEvent, 'data' | 'method' | 'section'>): HistoricalEvent | null {
  if (!historicalEventKeys.has(`${event.section}.${event.method}`)) return null;
  const names = event.data.names;
  if (!names || names.length !== event.data.length || event.data.typeDef.length !== event.data.length) {
    throw new AccountActivityCoverageError(`${event.section}.${event.method} does not expose complete named metadata`);
  }

  const fieldOverrides = runtimeTypeOverrides.fields as Readonly<Record<string, RuntimeTypeOverride>>;
  const data = Object.fromEntries(names.map((name, index) => [name, toPlain(event.data[index], fieldOverrides[name])]));
  return { section: event.section, method: event.method, data } as HistoricalEvent;
}

export function toRuntimeEvent(event: GenericEvent | HistoricalEvent): HistoricalEvent | null {
  return 'registry' in event ? toHistoricalEvent(event) : event;
}

function getEventDeclarations(specVersion: number, section: string, method: string): readonly HistoricalEventFields[] {
  const earliestSupportedSpec = supportedHistoricalEventSpecs[0];
  if (earliestSupportedSpec === undefined || specVersion < earliestSupportedSpec) {
    throw new AccountActivityCoverageError(`No copied event declarations for runtime spec ${specVersion}`);
  }

  const changes = changesByEvent.get(`${section}.${method}`) ?? [];
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    if (changes[index].spec <= specVersion) return changes[index].fields;
  }
  return [];
}
