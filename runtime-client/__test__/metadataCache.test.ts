import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import Fs from 'node:fs/promises';
import Os from 'node:os';
import Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { readInstalledRuntimeSource, readRuntimeSource } from '../src/generation/readRuntimeSource.ts';

it('retains declarations through a metadata outage and enriches the cache after a transient 503', async () => {
  const packageRoot = Path.resolve(Path.dirname(fileURLToPath(import.meta.resolve('@argonprotocol/mainchain'))), '..');
  const {
    metadataSource,
    genesisSource: _genesisSource,
    ...declarations
  } = await readInstalledRuntimeSource(packageRoot);
  const cacheDirectory = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'argon-runtime-metadata-test-'));
  const source = '1.4.13';
  const cachePath = Path.join(cacheDirectory, `${createHash('sha256').update(source).digest('hex')}.json`);
  const previous = JSON.stringify({ source, ...declarations });
  await Fs.writeFile(cachePath, previous);
  vi.stubEnv('ARGON_RUNTIME_CLIENT_CACHE', cacheDirectory);
  let metadataUnavailable = true;
  let failNextMetadataFetch = false;
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === 'https://registry.npmjs.org/@argonprotocol/mainchain/1.4.13') {
      return Response.json({ gitHead: '7df747f7563d5c79e0df762f60a2bf9449a03051' });
    }
    if (url.endsWith('/client/nodejs/metadata.json')) {
      if (metadataUnavailable || failNextMetadataFetch) {
        failNextMetadataFetch = false;
        return new Response('unavailable', { status: 503 });
      }
      return new Response(metadataSource);
    }
    throw new Error(`The existing package declarations must not be downloaded again: ${url}`);
  });
  try {
    await expect(readRuntimeSource(source)).rejects.toThrow('Unable to download metadata');
    expect(await Fs.readFile(cachePath, 'utf8')).toBe(previous);
    metadataUnavailable = false;
    failNextMetadataFetch = true;
    const recovered = await readRuntimeSource(source);
    expect(recovered.metadataSource).toBe(metadataSource);

    vi.resetModules();
    vi.stubGlobal('fetch', () => {
      throw new Error('A warm metadata cache must work offline');
    });
    const restarted = await import('../src/generation/readRuntimeSource.ts');
    const contents = await restarted.readRuntimeSource(source);
    expect(contents.querySource).toBe(declarations.querySource);
    const registry = new TypeRegistry();
    const { result } = JSON.parse(contents.metadataSource!);
    registry.setMetadata(new Metadata(registry, result), undefined, undefined, true);
    const pallet = registry.metadata.pallets.find(pallet => pallet.name.eq('BitcoinLocks'))!;
    const event = registry.lookup
      .getSiType(pallet.events.unwrap().type)
      .def.asVariant.variants.find(event => event.name.eq('BitcoinUtxoCosignRequested'))!;
    expect(event.fields.map(field => field.name.toString())).toEqual(['lock_id', 'vault_id', 'release_number']);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await Fs.rm(cacheDirectory, { recursive: true, force: true });
  }
}, 15_000);
