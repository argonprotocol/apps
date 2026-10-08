import { createHash, randomUUID } from 'node:crypto';
import Fs from 'node:fs/promises';
import Os from 'node:os';
import Path from 'node:path';
import { gunzipSync } from 'node:zlib';

export type RuntimeSourceContents = {
  querySource: string;
  constantSource?: string;
  eventSource: string;
  lookupSource: string;
  definitionSource?: string;
  metadataSource?: string;
  genesisSource?: string;
};

type CachedRuntimeSource = RuntimeSourceContents & { source: string };

const sourceCache = new Map<string, Promise<RuntimeSourceContents>>();

export function readRuntimeSource(source: string, includeConstants = false): Promise<RuntimeSourceContents> {
  const cacheKey = includeConstants ? `${source}:constants` : source;
  const cached = sourceCache.get(cacheKey);
  if (cached) return cached;

  const contents = readCachedRuntimeSource(source, includeConstants).catch(error => {
    if (sourceCache.get(cacheKey) === contents) sourceCache.delete(cacheKey);
    throw error;
  });
  sourceCache.set(cacheKey, contents);
  return contents;
}

export async function readInstalledRuntimeSource(packageDirectory: string): Promise<RuntimeSourceContents> {
  const interfaces = Path.join(packageDirectory, 'src/interfaces');
  const declarations = Path.join(packageDirectory, 'lib/types/interfaces');
  const bundlePath = Path.join(packageDirectory, 'lib/index.d.ts');
  const bundle = await Fs.readFile(bundlePath, 'utf8').catch(() => undefined);
  const sourceMap = await Fs.readFile(Path.join(packageDirectory, 'lib/index.js.map'), 'utf8').catch(() => undefined);
  const metadata = readBundledMetadata(sourceMap);

  return {
    constantSource: await readFirstFile(
      [Path.join(interfaces, 'augment-api-consts.ts'), Path.join(declarations, 'augment-api-consts.d.ts')],
      bundle,
      'AugmentedConsts',
    ),
    querySource: await readFirstFile(
      [Path.join(interfaces, 'augment-api-query.ts'), Path.join(declarations, 'augment-api-query.d.ts')],
      bundle,
      'AugmentedQueries',
    ),
    eventSource: await readFirstFile(
      [Path.join(interfaces, 'augment-api-events.ts'), Path.join(declarations, 'augment-api-events.d.ts')],
      bundle,
      'AugmentedEvents',
    ),
    lookupSource: await readFirstFile(
      [Path.join(interfaces, 'types-lookup.ts'), Path.join(declarations, 'types-lookup.d.ts')],
      bundle,
      'runtime lookup types',
    ),
    definitionSource: await Fs.readFile(Path.join(interfaces, 'lookup.ts'), 'utf8').catch(() => undefined),
    metadataSource: await Fs.readFile(Path.join(packageDirectory, 'metadata.json'), 'utf8').catch(
      () => metadata.metadataSource,
    ),
    genesisSource: await Fs.readFile(Path.join(packageDirectory, 'genesis.json'), 'utf8').catch(
      () => metadata.genesisSource,
    ),
  };
}

async function readCachedRuntimeSource(source: string, includeConstants: boolean): Promise<RuntimeSourceContents> {
  const cachePath = runtimeSourceCachePath(source);
  const cached = await Fs.readFile(cachePath, 'utf8').catch(() => undefined);
  if (cached !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cached);
    } catch {
      // Invalid derived state is handled below.
    }
    if (isCachedRuntimeSource(parsed, source)) {
      const { source: _cachedSource, ...contents } = parsed;
      if (includeConstants && !contents.constantSource) {
        const refreshed = await (source.startsWith('argonprotocol/') ? fetchGitSource(source) : fetchNpmSource(source));
        await writeCachedRuntimeSource(cachePath, { source, ...refreshed }).catch(() => undefined);
        return refreshed;
      }
      if (contents.metadataSource) return contents;
      // Enrich the existing declarations without downloading their package again.
      contents.metadataSource = await fetchMetadataSource(source);
      await writeCachedRuntimeSource(cachePath, { source, ...contents }).catch(() => undefined);
      return contents;
    }
    await Fs.rm(cachePath, { force: true }).catch(() => undefined);
  }

  const contents = await (source.startsWith('argonprotocol/') ? fetchGitSource(source) : fetchNpmSource(source));
  await writeCachedRuntimeSource(cachePath, { source, ...contents }).catch(() => undefined);
  return contents;
}

async function writeCachedRuntimeSource(cachePath: string, contents: CachedRuntimeSource): Promise<void> {
  await Fs.mkdir(Path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await Fs.writeFile(temporaryPath, JSON.stringify(contents));
    await Fs.rename(temporaryPath, cachePath);
  } finally {
    await Fs.rm(temporaryPath, { force: true });
  }
}

function runtimeSourceCachePath(source: string): string {
  const override = process.env.ARGON_RUNTIME_CLIENT_CACHE?.trim();
  let cacheDirectory: string;
  if (override) {
    cacheDirectory = Path.resolve(override);
  } else if (process.platform === 'darwin') {
    cacheDirectory = Path.join(Os.homedir(), 'Library/Caches/argon/runtime-client');
  } else {
    const xdgCacheHome = process.env.XDG_CACHE_HOME;
    const cacheHome = xdgCacheHome && Path.isAbsolute(xdgCacheHome) ? xdgCacheHome : Path.join(Os.homedir(), '.cache');
    cacheDirectory = Path.join(cacheHome, 'argon/runtime-client');
  }
  const sourceHash = createHash('sha256').update(source).digest('hex');
  return Path.join(cacheDirectory, `${sourceHash}.json`);
}

function isCachedRuntimeSource(value: unknown, source: string): value is CachedRuntimeSource {
  if (!value || typeof value !== 'object') return false;
  const cached = value as Partial<CachedRuntimeSource>;
  return (
    cached.source === source &&
    typeof cached.querySource === 'string' &&
    (cached.constantSource === undefined || typeof cached.constantSource === 'string') &&
    typeof cached.eventSource === 'string' &&
    typeof cached.lookupSource === 'string' &&
    (cached.definitionSource === undefined || typeof cached.definitionSource === 'string') &&
    (cached.metadataSource === undefined || typeof cached.metadataSource === 'string') &&
    (cached.genesisSource === undefined || typeof cached.genesisSource === 'string')
  );
}

async function fetchNpmSource(version: string): Promise<RuntimeSourceContents> {
  const response = await fetch(`https://registry.npmjs.org/@argonprotocol/mainchain/-/mainchain-${version}.tgz`);
  if (!response.ok) throw new Error(`Unable to download @argonprotocol/mainchain@${version}: ${response.status}`);

  const archive = gunzipSync(Buffer.from(await response.arrayBuffer()));
  const bundle = readTarFile(archive, 'package/lib/index.d.ts');
  const metadata = readBundledMetadata(
    readTarFile(archive, 'package/lib/index.js.map') ?? readTarFile(archive, 'package/browser/index.js.map'),
  );
  return {
    constantSource:
      readTarFile(archive, 'package/src/interfaces/augment-api-consts.ts') ??
      readTarFile(archive, 'package/lib/types/interfaces/augment-api-consts.d.ts') ??
      bundle ??
      missingSource(version, 'AugmentedConsts'),
    querySource:
      readTarFile(archive, 'package/src/interfaces/augment-api-query.ts') ??
      readTarFile(archive, 'package/lib/types/interfaces/augment-api-query.d.ts') ??
      bundle ??
      missingSource(version, 'AugmentedQueries'),
    eventSource:
      readTarFile(archive, 'package/src/interfaces/augment-api-events.ts') ??
      readTarFile(archive, 'package/lib/types/interfaces/augment-api-events.d.ts') ??
      bundle ??
      missingSource(version, 'AugmentedEvents'),
    lookupSource:
      readTarFile(archive, 'package/src/interfaces/types-lookup.ts') ??
      readTarFile(archive, 'package/lib/types/interfaces/types-lookup.d.ts') ??
      bundle ??
      missingSource(version, 'runtime lookup types'),
    definitionSource: readTarFile(archive, 'package/src/interfaces/lookup.ts'),
    ...metadata,
    metadataSource: metadata.metadataSource ?? (await fetchMetadataSource(version)),
  };
}

async function fetchGitSource(source: string): Promise<RuntimeSourceContents> {
  const commit = source.slice(source.lastIndexOf('@') + 1);
  const baseUrl = `https://raw.githubusercontent.com/argonprotocol/mainchain/${commit}/client/nodejs/src/interfaces`;
  const [queryResponse, eventResponse, lookupResponse, definitionResponse, metadataSource, constantResponse] =
    await Promise.all([
      fetch(`${baseUrl}/augment-api-query.ts`),
      fetch(`${baseUrl}/augment-api-events.ts`),
      fetch(`${baseUrl}/types-lookup.ts`),
      fetch(`${baseUrl}/lookup.ts`),
      fetchMetadataSource(source),
      fetch(`${baseUrl}/augment-api-consts.ts`),
    ]);
  if (!queryResponse.ok || !eventResponse.ok || !lookupResponse.ok) {
    throw new Error(
      `Unable to download ${source}: query=${queryResponse.status}, events=${eventResponse.status}, lookup=${lookupResponse.status}`,
    );
  }
  return {
    constantSource: constantResponse.ok ? await constantResponse.text() : undefined,
    querySource: await queryResponse.text(),
    eventSource: await eventResponse.text(),
    lookupSource: await lookupResponse.text(),
    definitionSource: definitionResponse.ok ? await definitionResponse.text() : undefined,
    metadataSource,
  };
}

async function fetchMetadataSource(source: string): Promise<string> {
  let commit = source.startsWith('argonprotocol/') ? source.slice(source.lastIndexOf('@') + 1) : undefined;
  if (!commit) {
    const response = await fetch(`https://registry.npmjs.org/@argonprotocol/mainchain/${encodeURIComponent(source)}`);
    if (!response.ok) throw new Error(`Unable to resolve metadata source ${source}: ${response.status}`);
    const manifest = (await response.json()) as { gitHead?: string };
    commit = manifest.gitHead;
  }
  if (!commit || !/^[a-f0-9]{7,40}$/.test(commit)) {
    throw new Error(`Runtime source ${source} does not identify an immutable metadata commit`);
  }

  const response = await fetch(
    `https://raw.githubusercontent.com/argonprotocol/mainchain/${commit}/client/nodejs/metadata.json`,
  );
  if (!response.ok) throw new Error(`Unable to download metadata for ${source}: ${response.status}`);
  return await response.text();
}

function readBundledMetadata(sourceMap?: string): Pick<RuntimeSourceContents, 'metadataSource' | 'genesisSource'> {
  if (!sourceMap) return {};
  const map = JSON.parse(sourceMap) as { sources: string[]; sourcesContent?: (string | null)[] };
  const metadataSource = map.sourcesContent?.[map.sources.findIndex(source => source.endsWith('/metadata.json'))];
  const genesisSource = map.sourcesContent?.[map.sources.findIndex(source => source.endsWith('/genesis.json'))];
  return {
    ...(metadataSource ? { metadataSource } : {}),
    ...(genesisSource ? { genesisSource } : {}),
  };
}

function readTarFile(archive: Buffer, requestedPath: string): string | undefined {
  for (let offset = 0; offset < archive.length; ) {
    const name = archive
      .subarray(offset, offset + 100)
      .toString()
      .replace(/\0.*$/, '');
    if (!name) return;

    const size = Number.parseInt(
      archive
        .subarray(offset + 124, offset + 136)
        .toString()
        .replace(/\0.*$/, '')
        .trim(),
      8,
    );
    const contentsOffset = offset + 512;
    if (name === requestedPath) return archive.subarray(contentsOffset, contentsOffset + size).toString();
    offset = contentsOffset + Math.ceil(size / 512) * 512;
  }
}

async function readFirstFile(paths: readonly string[], fallback: string | undefined, label: string): Promise<string> {
  for (const path of paths) {
    const contents = await Fs.readFile(path, 'utf8').catch(() => undefined);
    if (contents) return contents;
  }
  if (fallback) return fallback;
  throw new Error(`Installed @argonprotocol/mainchain package does not include ${label}`);
}

function missingSource(version: string, label: string): never {
  throw new Error(`@argonprotocol/mainchain@${version} does not include ${label}`);
}
