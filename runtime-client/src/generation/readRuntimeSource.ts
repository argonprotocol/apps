import Fs from 'node:fs/promises';
import Path from 'node:path';
import { gunzipSync } from 'node:zlib';

export type RuntimeSourceContents = {
  querySource: string;
  eventSource: string;
  lookupSource: string;
  definitionSource?: string;
};

const sourceCache = new Map<string, Promise<RuntimeSourceContents>>();

export function readRuntimeSource(source: string): Promise<RuntimeSourceContents> {
  const cached = sourceCache.get(source);
  if (cached) return cached;

  const contents = source.startsWith('argonprotocol/') ? fetchGitSource(source) : fetchNpmSource(source);
  sourceCache.set(source, contents);
  return contents;
}

export async function readInstalledRuntimeSource(packageDirectory: string): Promise<RuntimeSourceContents> {
  const interfaces = Path.join(packageDirectory, 'src/interfaces');
  const declarations = Path.join(packageDirectory, 'lib/types/interfaces');
  const bundlePath = Path.join(packageDirectory, 'lib/index.d.ts');
  const bundle = await Fs.readFile(bundlePath, 'utf8').catch(() => undefined);

  return {
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
  };
}

async function fetchNpmSource(version: string): Promise<RuntimeSourceContents> {
  const response = await fetch(`https://registry.npmjs.org/@argonprotocol/mainchain/-/mainchain-${version}.tgz`);
  if (!response.ok) throw new Error(`Unable to download @argonprotocol/mainchain@${version}: ${response.status}`);

  const archive = gunzipSync(Buffer.from(await response.arrayBuffer()));
  const bundle = readTarFile(archive, 'package/lib/index.d.ts');
  return {
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
  };
}

async function fetchGitSource(source: string): Promise<RuntimeSourceContents> {
  const commit = source.slice(source.lastIndexOf('@') + 1);
  const baseUrl = `https://raw.githubusercontent.com/argonprotocol/mainchain/${commit}/client/nodejs/src/interfaces`;
  const [queryResponse, eventResponse, lookupResponse, definitionResponse] = await Promise.all([
    fetch(`${baseUrl}/augment-api-query.ts`),
    fetch(`${baseUrl}/augment-api-events.ts`),
    fetch(`${baseUrl}/types-lookup.ts`),
    fetch(`${baseUrl}/lookup.ts`),
  ]);
  if (!queryResponse.ok || !eventResponse.ok || !lookupResponse.ok) {
    throw new Error(
      `Unable to download ${source}: query=${queryResponse.status}, events=${eventResponse.status}, lookup=${lookupResponse.status}`,
    );
  }
  return {
    querySource: await queryResponse.text(),
    eventSource: await eventResponse.text(),
    lookupSource: await lookupResponse.text(),
    definitionSource: definitionResponse.ok ? await definitionResponse.text() : undefined,
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
