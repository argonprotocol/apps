import type { Codec, GenericEvent } from '@argonprotocol/mainchain';
import {
  historicalEventChanges as generatedEventChanges,
  historicalEventSpecSources as generatedSpecSources,
} from './HistoricalEventSpecs.generated.js';
import type { HistoricalEventDeclaration } from './HistoricalEventSpecs.generated.js';

type HistoricalEventFields = Readonly<Record<string, string>>;
type HistoricalEventVersion = { spec: number; fields: HistoricalEventFields[] };
type HistoricalEventSection = HistoricalEventDeclaration['section'];
type HistoricalEventMethod<Section extends HistoricalEventSection> = Extract<
  HistoricalEventDeclaration,
  { section: Section }
>['method'];
type HistoricalEventDeclarations<Section extends HistoricalEventSection, Method extends string> = Extract<
  HistoricalEventDeclaration,
  { section: Section; method: Method }
>;
type HistoricalEventFieldKeys<Fields> = Fields extends Fields ? keyof Fields : never;
type HistoricalEventRequiredFieldKeys<Fields> = {
  [Field in HistoricalEventFieldKeys<Fields>]: [Fields] extends [Readonly<Record<Field, Codec>>] ? Field : never;
}[HistoricalEventFieldKeys<Fields>];
type HistoricalEventFieldCodec<Fields, Field extends PropertyKey> =
  Fields extends Readonly<Record<Field, infer FieldCodec extends Codec>> ? FieldCodec : never;
type HistoricalEventData<Fields> = GenericEvent['data'] & {
  readonly [Field in HistoricalEventFieldKeys<HistoricalEventDeclaration['fields']>]?: HistoricalEventFieldCodec<
    HistoricalEventDeclaration['fields'],
    Field
  >;
} & {
  readonly [Field in HistoricalEventRequiredFieldKeys<Fields>]: HistoricalEventFieldCodec<Fields, Field>;
} & {
  readonly [Field in Exclude<
    HistoricalEventFieldKeys<Fields>,
    HistoricalEventRequiredFieldKeys<Fields>
  >]?: HistoricalEventFieldCodec<Fields, Field>;
};
type HistoricalEventFor<Section extends HistoricalEventSection, Method extends string> = {
  readonly section: Section;
  readonly method: Method;
  readonly data: HistoricalEventData<HistoricalEventDeclarations<Section, Method>['fields']>;
};

export type HistoricalEvent = {
  [Section in HistoricalEventSection]: {
    [Method in HistoricalEventMethod<Section>]: HistoricalEventFor<Section, Method>;
  }[HistoricalEventMethod<Section>];
}[HistoricalEventSection];

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

export function hasNamedEventData<
  Section extends HistoricalEventSection,
  Method extends HistoricalEventMethod<Section>,
>(
  event: Pick<GenericEvent, 'data' | 'method' | 'section'>,
  selector: { section: Section; method: Method },
): event is Pick<GenericEvent, 'data' | 'method' | 'section'> &
  Extract<HistoricalEvent, { section: Section; method: Method }>;
export function hasNamedEventData(
  event: Pick<GenericEvent, 'data' | 'method' | 'section'>,
): event is Pick<GenericEvent, 'data' | 'method' | 'section'> & HistoricalEvent;
export function hasNamedEventData(
  event: Pick<GenericEvent, 'data' | 'method' | 'section'>,
  selector?: { section: string; method: string },
): boolean {
  const section = selector?.section ?? event.section;
  const method = selector?.method ?? event.method;
  if (event.section !== section || event.method !== method) return false;

  const names = event.data.names;
  return names?.length === event.data.length && event.data.typeDef.length === event.data.length;
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
