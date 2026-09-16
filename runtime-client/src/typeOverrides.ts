export type RuntimeTypeOverride = 'number' | 'number[]' | 'FixedU128' | 'mapEntries';

export type RuntimeTypeOverrides = {
  fields: Record<string, RuntimeTypeOverride>;
  queries: Record<string, RuntimeTypeOverride>;
  queryArgs?: Record<string, RuntimeTypeOverride[]>;
};
