import Fs from 'node:fs/promises';
import Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { deflateSync } from 'node:zlib';
import { Metadata, TypeRegistry } from '@polkadot/types';
import type { HexString } from '@polkadot/util/types';
import { generateRuntimeQueryTypes, type RuntimeQuerySource } from './generation/generateRuntimeQueryTypes.js';
import {
  hasSameRuntimeMetadata,
  readInstalledRuntimeSource,
  readRuntimeSource,
  type RuntimeSourceContents,
} from './generation/readRuntimeSource.js';
import { writeGeneratedFile } from './generation/writeGeneratedFile.js';
import { upsertCurrentRuntimeSource, type RuntimeSourceRegistry } from './history/runtimeSources.js';
import type { RuntimeTypeOverrides } from './typeOverrides.js';

const packageDirectory = Path.resolve(
  Path.dirname(fileURLToPath(import.meta.resolve('@argonprotocol/mainchain'))),
  '..',
);
const outputPath = Path.join(import.meta.dirname, 'RuntimeQueries.generated.ts');
const metadataOutputPath = Path.join(import.meta.dirname, 'RuntimeMetadata.generated.ts');
const registryPath = Path.join(import.meta.dirname, 'history/RuntimeSources.json');
const rootPackagePath = Path.resolve(import.meta.dirname, '../../package.json');
const typeOverridesPath = Path.resolve(import.meta.dirname, '../../runtime-type-overrides.json');

await generateRuntimeClient();

async function generateRuntimeClient(): Promise<void> {
  const check = process.argv.includes('--check');
  const source = readArgument('--source');
  const rawSpec = readArgument('--spec');
  if ((source && !rawSpec) || (!source && rawSpec)) {
    throw new Error('--source and --spec must be supplied together');
  }

  const persistedRegistry = JSON.parse(await Fs.readFile(registryPath, 'utf8')) as RuntimeSourceRegistry;
  const specVersion = rawSpec ? Number(rawSpec) : undefined;
  if (rawSpec && !Number.isSafeInteger(specVersion)) throw new Error(`Invalid runtime spec ${rawSpec}`);

  const installedPackage = JSON.parse(await Fs.readFile(Path.join(packageDirectory, 'package.json'), 'utf8')) as {
    version?: string;
  };
  const installedVersion = installedPackage.version;
  const localSource = process.argv.includes('--local') ? source : undefined;
  const installedContents = await readInstalledRuntimeSource(packageDirectory);

  let effectiveRegistry = persistedRegistry;
  if (source) {
    const updatedRegistry = upsertCurrentRuntimeSource(persistedRegistry, { specVersion: specVersion!, source });
    const registeredSources = await Promise.all(
      (persistedRegistry[specVersion!] ?? []).map(registeredSource => readRuntimeSource(registeredSource, true)),
    );
    let pinnedRuntimeSource = installedContents;
    if (source !== installedVersion && source !== localSource) {
      pinnedRuntimeSource = await readRuntimeSource(source, true);
    }
    if (!registeredSources.some(registered => hasSameRuntimeMetadata(registered, pinnedRuntimeSource))) {
      effectiveRegistry = updatedRegistry;
    }
  }

  const typeOverrides = JSON.parse(await Fs.readFile(typeOverridesPath, 'utf8')) as RuntimeTypeOverrides;
  const liveSpecs = Object.keys(effectiveRegistry)
    .map(Number)
    .sort((a, b) => b - a)
    .slice(0, 2);
  const runtimeSources = await Promise.all(
    Object.entries(effectiveRegistry).flatMap(([rawVersion, sourceVersions]) => {
      return sourceVersions.map(async sourceVersion => {
        const contents =
          sourceVersion === installedVersion || sourceVersion === localSource
            ? installedContents
            : await readRuntimeSource(sourceVersion, liveSpecs.includes(Number(rawVersion)));
        return {
          specVersion: Number(rawVersion),
          source: sourceLabel(sourceVersion),
          ...contents,
        } satisfies RuntimeQuerySource & { eventSource: string };
      });
    }),
  );
  await verifyInstalledRuntimeSource(effectiveRegistry, installedContents, runtimeSources);

  if (!installedContents.genesisSource) throw new Error('The installed Mainchain SDK has no bundled genesis hashes');
  const genesis = JSON.parse(installedContents.genesisSource) as Record<string, string>;
  // Published Argon snapshots contain mainnet constants; canary uses its own node's metadata.
  const genesisHashes = [genesis.mainnet];
  const metadataBySpecVersion: Record<number, HexString> = {};
  for (const [rawVersion] of Object.entries(effectiveRegistry)) {
    const specVersion = Number(rawVersion);
    const metadataVariants = new Set(
      runtimeSources
        .filter(source => source.specVersion === specVersion)
        .map(source => {
          if (!source.metadataSource) throw new Error(`Missing metadata for ${source.source}`);
          const { result } = JSON.parse(source.metadataSource) as { result: HexString };
          // Parse the actual SCALE payload before admitting it to the shipped bundle.
          return new Metadata(new TypeRegistry(), result).toHex();
        }),
    );
    if (metadataVariants.size === 1) {
      metadataBySpecVersion[specVersion] = [...metadataVariants][0];
    } else {
      // A spec with conflicting published snapshots must keep its authoritative RPC lookup.
      console.warn(`Runtime spec ${specVersion} has conflicting metadata snapshots; using RPC metadata for this spec`);
    }
  }
  const metadataBundle = deflateSync(Buffer.from(JSON.stringify({ genesisHashes, metadataBySpecVersion }))).toString(
    'base64',
  );
  const metadataOutput = `// Generated by \`yarn generate:runtime-client\`. Do not check this payload into Git.\nexport const compressedRuntimeMetadata = ${JSON.stringify(metadataBundle)};\n`;
  await writeGeneratedFile(metadataOutputPath, metadataOutput, check);

  const output = generateRuntimeQueryTypes(runtimeSources, typeOverrides);
  const prettierConfig = await resolveConfig(outputPath);
  const formattedOutput = await format(output, { ...prettierConfig, parser: 'typescript' });
  await writeGeneratedFile(outputPath, formattedOutput, check);

  process.env.ARGON_RUNTIME_SOURCES = JSON.stringify(effectiveRegistry);
  await import('./generateHistoricalEvents.js');

  if (source && !process.argv.includes('--local') && !check) {
    await Fs.writeFile(registryPath, `${JSON.stringify(effectiveRegistry, null, 2)}\n`);
  }
}

async function verifyInstalledRuntimeSource(
  registry: RuntimeSourceRegistry,
  installedContents: RuntimeSourceContents,
  registeredSources: readonly RuntimeSourceContents[],
): Promise<void> {
  const rootPackage = JSON.parse(await Fs.readFile(rootPackagePath, 'utf8')) as {
    resolutions?: Record<string, string>;
  };
  const pinnedSource = rootPackage.resolutions?.['@argonprotocol/mainchain'];
  if (!pinnedSource || pinnedSource.startsWith('portal:')) return;
  if (Object.values(registry).some(sources => sources.includes(pinnedSource))) return;
  if (registeredSources.some(registered => hasSameRuntimeMetadata(registered, installedContents))) return;

  throw new Error(`@argonprotocol/mainchain@${pinnedSource} has no matching runtime metadata in RuntimeSources.json`);
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1]?.trim();
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function sourceLabel(source: string): string {
  return source.startsWith('argonprotocol/') ? source : `@argonprotocol/mainchain@${source}`;
}
