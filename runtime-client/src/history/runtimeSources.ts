export type RuntimeSourceRegistry = Readonly<Record<number, readonly string[]>>;

export function upsertCurrentRuntimeSource(
  registry: RuntimeSourceRegistry,
  input: { specVersion: number; source: string },
): RuntimeSourceRegistry {
  const newestSpec = Math.max(...Object.keys(registry).map(Number));
  if (Number.isFinite(newestSpec) && input.specVersion < newestSpec) {
    throw new Error(`Cannot replace older frozen runtime spec ${input.specVersion}; newest spec is ${newestSpec}`);
  }

  return {
    ...registry,
    [input.specVersion]: [input.source],
  };
}

export function readArgonSpecVersion(source: string): number {
  const match = source.match(/\bspec_version\s*:\s*([0-9_]+)\s*,/);
  if (!match) throw new Error('Unable to find numeric spec_version in runtime/argon/src/lib.rs');

  return Number(match[1].replaceAll('_', ''));
}
