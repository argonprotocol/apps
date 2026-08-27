import {
  runtimeTypeOverrides,
  type CurrentRuntimeQueries,
  type RuntimeQueries,
} from './RuntimeQueries.generated.js';
import type BigNumber from 'bignumber.js';
import { toPlain } from './toPlain.js';
import type { RuntimeTypeOverride } from './typeOverrides.js';

type UnionKeys<Value> = Value extends Value ? keyof Value : never;
type RequiredKeys<Value> = {
  [Key in UnionKeys<Value>]: [Value] extends [Record<Key, unknown>] ? Key : never;
}[UnionKeys<Value>];
type OptionalKeys<Value> = Exclude<UnionKeys<Value>, RequiredKeys<Value>>;
type MergeObject<Value> = {
  readonly [Key in RequiredKeys<Value>]: MergeHistorical<Value extends Record<Key, infer Field> ? Field : never>;
} & {
  readonly [Key in OptionalKeys<Value>]?: MergeHistorical<
    Value extends Partial<Record<Key, infer Field>> ? Field : never
  >;
};

export type MergeHistorical<Value> = null extends Value
  ? MergeHistorical<Exclude<Value, null>> | null
  : [Value] extends [readonly unknown[]]
    ? Value
    : [Value] extends [Uint8Array]
      ? Value
      : [Value] extends [BigNumber]
        ? Value
        : [Value] extends [{ readonly type: string }]
          ? Value
          : [Value] extends [object]
            ? string extends keyof Value
              ? Value
              : MergeObject<Value>
            : Value;

export type RuntimeStorageKey<Args extends readonly unknown[]> = { readonly args: Args };
type RuntimeQueryArgs<Args extends readonly unknown[]> = { readonly [Index in keyof Args]: unknown };

export type RuntimeQuery<Args extends readonly unknown[], Result> = {
  (...args: RuntimeQueryArgs<Args>): Promise<Result>;
  (...args: [...RuntimeQueryArgs<Args>, callback: (value: Result) => void]): Promise<() => void>;
  readonly multi: (keys: readonly unknown[]) => Promise<readonly Result[]>;
  readonly at: (...args: readonly unknown[]) => Promise<Result>;
  readonly entries: (...args: readonly unknown[]) => Promise<readonly (readonly [RuntimeStorageKey<Args>, Result])[]>;
  readonly entriesAt: (...args: readonly unknown[]) => Promise<readonly (readonly [RuntimeStorageKey<Args>, Result])[]>;
  readonly entriesPaged: (...args: readonly unknown[]) => Promise<readonly (readonly [RuntimeStorageKey<Args>, Result])[]>;
  readonly hash: (...args: readonly unknown[]) => Promise<string>;
  readonly key: (...args: readonly unknown[]) => string;
  readonly keyPrefix: (...args: readonly unknown[]) => string;
  readonly keys: (...args: readonly unknown[]) => Promise<readonly RuntimeStorageKey<Args>[]>;
  readonly keysAt: (...args: readonly unknown[]) => Promise<readonly RuntimeStorageKey<Args>[]>;
  readonly keysPaged: (...args: readonly unknown[]) => Promise<readonly RuntimeStorageKey<Args>[]>;
  readonly size: (...args: readonly unknown[]) => Promise<bigint>;
  readonly sizeAt: (...args: readonly unknown[]) => Promise<bigint>;
};

export type OptionalRuntimeQuery<Args extends readonly unknown[], Result> = {
  (...args: RuntimeQueryArgs<Args>): Promise<Result> | null;
  (...args: [...RuntimeQueryArgs<Args>, callback: (value: Result) => void]): Promise<() => void> | null;
  readonly multi: (keys: readonly unknown[]) => Promise<readonly Result[]> | null;
  readonly at: (...args: readonly unknown[]) => Promise<Result> | null;
  readonly entries: (...args: readonly unknown[]) => Promise<readonly (readonly [RuntimeStorageKey<Args>, Result])[]> | null;
  readonly entriesAt: (...args: readonly unknown[]) => Promise<readonly (readonly [RuntimeStorageKey<Args>, Result])[]> | null;
  readonly entriesPaged: (...args: readonly unknown[]) => Promise<readonly (readonly [RuntimeStorageKey<Args>, Result])[]> | null;
  readonly hash: (...args: readonly unknown[]) => Promise<string> | null;
  readonly key: (...args: readonly unknown[]) => string | null;
  readonly keyPrefix: (...args: readonly unknown[]) => string | null;
  readonly keys: (...args: readonly unknown[]) => Promise<readonly RuntimeStorageKey<Args>[]> | null;
  readonly keysAt: (...args: readonly unknown[]) => Promise<readonly RuntimeStorageKey<Args>[]> | null;
  readonly keysPaged: (...args: readonly unknown[]) => Promise<readonly RuntimeStorageKey<Args>[]> | null;
  readonly size: (...args: readonly unknown[]) => Promise<bigint> | null;
  readonly sizeAt: (...args: readonly unknown[]) => Promise<bigint> | null;
};

export type CurrentRuntimeQuery<Args extends readonly unknown[], Result> = RuntimeQuery<Args, Result>;

type RuntimeQueryResult<Query> = Query extends RuntimeQuery<infer _Args, infer Result>
  ? Result
  : Query extends OptionalRuntimeQuery<infer _Args, infer Result>
    ? Result
    : never;
type RuntimeQueryMultiResult<Call> = Call extends readonly [infer Query, ...readonly unknown[]]
  ? RuntimeQueryResult<Query>
  : RuntimeQueryResult<Call>;
type RuntimeQueryMulti = {
  <const Calls extends readonly unknown[]>(
    calls: Calls,
    callback: (values: { readonly [Index in keyof Calls]: RuntimeQueryMultiResult<Calls[Index]> }) => void,
  ): Promise<() => void>;
  <const Calls extends readonly unknown[]>(
    calls: Calls,
  ): Promise<{ readonly [Index in keyof Calls]: RuntimeQueryMultiResult<Calls[Index]> }>;
};
type RuntimeQueryMetadata = {
  readonly query: unknown;
  readonly section: PropertyKey;
  readonly method: PropertyKey;
};

export type RuntimeClient<
  Api extends { readonly query: object } = { readonly query: object },
  Queries extends object = CurrentRuntimeQueries,
> = Omit<Api, 'at' | 'query' | 'queryMulti'> & {
  readonly raw: Api;
  readonly query: Queries;
} & (Api extends { readonly queryMulti: unknown } ? { readonly queryMulti: RuntimeQueryMulti } : object) &
  (Api extends { at: (...args: infer Args) => Promise<infer HistoricalApi> }
    ? { at: (...args: Args) => Promise<RuntimeClient<HistoricalApi & { readonly query: object }, RuntimeQueries>> }
    : object);

const clientsByApi = new WeakMap<object, object>();
const apiByClient = new WeakMap<object, object>();

export function isRuntimeClient<Api extends { readonly query: object }, Queries extends object>(
  value: Api | RuntimeClient<Api, Queries>,
): value is RuntimeClient<Api, Queries> {
  return apiByClient.has(value);
}

export function runtimeClient<Api extends { readonly query: object }, Queries extends object = CurrentRuntimeQueries>(
  api: Api,
): RuntimeClient<Api, Queries> {
  if (apiByClient.has(api)) return api as unknown as RuntimeClient<Api, Queries>;

  const existing = clientsByApi.get(api);
  if (existing) return existing as RuntimeClient<Api, Queries>;

  const runtimeQueries = new WeakMap<object, RuntimeQueryMetadata>();
  const sections = new Proxy(
    {},
    {
      get(_target, section) {
        return new Proxy(
          {},
          {
            get(_sectionTarget, method) {
              return createRuntimeQuery(api.query, section, method, runtimeQueries);
            },
          },
        );
      },
    },
  );

  const boundMethods = new WeakMap<(...args: never[]) => unknown, (...args: never[]) => unknown>();
  const client = new Proxy(api, {
    get(target, property) {
      if (property === 'raw') return target;
      if (property === 'query') return sections;

      const value = Reflect.get(target, property, target) as unknown;
      if (property === 'rpc' || property === 'tx') return value;
      if (typeof value !== 'function') return value;

      const method = value as (...args: never[]) => unknown;
      const cached = boundMethods.get(method);
      if (cached) return cached;

      let bound: (...args: never[]) => unknown;
      if (property === 'at') {
        bound = (...args: never[]) => Promise.resolve(Reflect.apply(method, target, args)).then(wrapReturnedApi);
      } else if (property === 'queryMulti') {
        bound = (...args: never[]) =>
          invokeQueryMulti(method as (...args: unknown[]) => unknown, target, runtimeQueries, args);
      } else {
        bound = method.bind(target);
      }
      boundMethods.set(method, bound);
      return bound;
    },
  }) as unknown as RuntimeClient<Api, Queries>;
  clientsByApi.set(api, client);
  apiByClient.set(client, api);
  return client;
}

function wrapReturnedApi(value: unknown): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return value;
  if (!('query' in value)) return value;
  return runtimeClient(value as { readonly query: object });
}

function createRuntimeQuery(
  queryRoot: object,
  section: PropertyKey,
  method: PropertyKey,
  runtimeQueries: WeakMap<object, RuntimeQueryMetadata>,
): unknown {
  const call = (...args: unknown[]) => invokeQuery(queryRoot, section, method, undefined, args);
  const query = new Proxy(call, {
    get(_target, attachedMethod) {
      return (...args: unknown[]) => invokeQuery(queryRoot, section, method, attachedMethod, args);
    },
  });
  runtimeQueries.set(query, { query: readProperty(readProperty(queryRoot, section), method), section, method });
  return query;
}

function invokeQueryMulti(
  queryMulti: (...args: unknown[]) => unknown,
  client: object,
  runtimeQueries: WeakMap<object, RuntimeQueryMetadata>,
  args: unknown[],
): unknown {
  const calls = args[0];
  if (!Array.isArray(calls)) return Reflect.apply(queryMulti, client, args);

  const queryCalls = calls.map(call => {
    const query = Array.isArray(call) ? call[0] : call;
    if ((typeof query !== 'object' || query === null) && typeof query !== 'function') {
      return { call, override: undefined };
    }
    const metadata = runtimeQueries.get(query);
    if (!metadata) return { call, override: undefined };
    return {
      call: Array.isArray(call) ? [metadata.query, ...call.slice(1)] : metadata.query,
      override: queryOverride(metadata.section, metadata.method),
    };
  });
  const rawCalls = queryCalls.map(({ call }) => call);
  const overrides = queryCalls.map(({ override }) => override);
  const normalize = (values: readonly unknown[]) => values.map((value, index) => toPlain(value, overrides[index]));
  const callback = args[1];
  if (typeof callback === 'function') {
    const onValues = callback as (values: readonly unknown[]) => void;
    return Reflect.apply(queryMulti, client, [
      rawCalls,
      (values: readonly unknown[]) => onValues(normalize(values)),
    ]);
  }
  return Promise.resolve(Reflect.apply(queryMulti, client, [rawCalls])).then(values =>
    normalize(values as readonly unknown[]),
  );
}

function invokeQuery(
  queryRoot: object,
  section: PropertyKey,
  method: PropertyKey,
  attachedMethod: PropertyKey | undefined,
  args: unknown[],
): unknown {
  const sectionQueries = readProperty(queryRoot, section);
  const query = readProperty(sectionQueries, method);
  const callable = attachedMethod === undefined ? query : readProperty(query, attachedMethod);
  if (typeof callable !== 'function') return null;
  const override = queryOverride(section, method, attachedMethod);
  const argOverrides = queryArgOverrides(section, method);

  const invocationArgs = args.map((arg, index) => {
    if (index !== args.length - 1 || typeof arg !== 'function') return arg;
    const callback = arg as (value: unknown) => void;
    return (value: unknown) => callback(toPlain(value, override, argOverrides));
  });
  const response = Reflect.apply(callable as (...args: unknown[]) => unknown, query, invocationArgs);
  if (attachedMethod === 'key' || attachedMethod === 'keyPrefix') return toPlain(response, override, argOverrides);
  return Promise.resolve(response).then(value =>
    typeof value === 'function' ? value : toPlain(value, override, argOverrides),
  );
}

function queryOverride(
  section: PropertyKey,
  method: PropertyKey,
  attachedMethod?: PropertyKey,
): (typeof runtimeTypeOverrides.queries)[keyof typeof runtimeTypeOverrides.queries] | undefined {
  if (typeof section !== 'string' || typeof method !== 'string') return;
  if (attachedMethod !== undefined && attachedMethod !== 'at' && attachedMethod !== 'multi') return;
  return runtimeTypeOverrides.queries[`${section}.${method}` as keyof typeof runtimeTypeOverrides.queries];
}

function queryArgOverrides(section: PropertyKey, method: PropertyKey): readonly RuntimeTypeOverride[] | undefined {
  if (typeof section !== 'string' || typeof method !== 'string') return;
  return (runtimeTypeOverrides.queryArgs as Readonly<Record<string, readonly RuntimeTypeOverride[]>>)[
    `${section}.${method}`
  ];
}

function readProperty(value: unknown, property: PropertyKey): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined;
  return Reflect.get(value, property) as unknown;
}
