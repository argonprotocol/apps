import Fs from 'node:fs/promises';
import Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { generateRuntimeQueryTypes, type RuntimeQuerySource } from './generation/generateRuntimeQueryTypes.js';
import { readInstalledRuntimeSource, readRuntimeSource } from './generation/readRuntimeSource.js';
import { upsertCurrentRuntimeSource, type RuntimeSourceRegistry } from './history/runtimeSources.js';
import type { RuntimeTypeOverrides } from './typeOverrides.js';

const packageDirectory = Path.resolve(
  Path.dirname(fileURLToPath(import.meta.resolve('@argonprotocol/mainchain'))),
  '..',
);
const outputPath = Path.join(import.meta.dirname, 'RuntimeQueries.generated.ts');
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

  const effectiveRegistry = source
    ? upsertCurrentRuntimeSource(persistedRegistry, { specVersion: specVersion!, source })
    : persistedRegistry;
  await verifyInstalledPinRegistered(effectiveRegistry);

  const typeOverrides = JSON.parse(await Fs.readFile(typeOverridesPath, 'utf8')) as RuntimeTypeOverrides;

  const installedPackage = JSON.parse(await Fs.readFile(Path.join(packageDirectory, 'package.json'), 'utf8')) as {
    version?: string;
  };
  const installedVersion = installedPackage.version;
  const localSource = process.argv.includes('--local') ? source : undefined;
  const runtimeSources = await Promise.all(
    Object.entries(effectiveRegistry).flatMap(([rawVersion, sourceVersions]) => {
      return sourceVersions.map(async sourceVersion => {
        const contents =
          sourceVersion === installedVersion || sourceVersion === localSource
            ? await readInstalledRuntimeSource(packageDirectory)
            : await readRuntimeSource(sourceVersion);
        return {
          specVersion: Number(rawVersion),
          source: sourceLabel(sourceVersion),
          ...contents,
        } satisfies RuntimeQuerySource & { eventSource: string };
      });
    }),
  );

  const output = generateRuntimeQueryTypes(runtimeSources, typeOverrides);
  const prettierConfig = await resolveConfig(outputPath);
  const formattedOutput = await format(output, { ...prettierConfig, parser: 'typescript' });
  if (check) {
    const currentOutput = await Fs.readFile(outputPath, 'utf8');
    if (currentOutput !== formattedOutput) {
      throw new Error('RuntimeQueries.generated.ts is out of date; run the runtime client generator');
    }
  } else {
    await Fs.writeFile(outputPath, formattedOutput);
  }

  process.env.ARGON_RUNTIME_SOURCES = JSON.stringify(effectiveRegistry);
  await import('./generateHistoricalEvents.js');

  if (source && !process.argv.includes('--local') && !check) {
    await Fs.writeFile(registryPath, `${JSON.stringify(effectiveRegistry, null, 2)}\n`);
  }
}

async function verifyInstalledPinRegistered(registry: RuntimeSourceRegistry): Promise<void> {
  const rootPackage = JSON.parse(await Fs.readFile(rootPackagePath, 'utf8')) as {
    resolutions?: Record<string, string>;
  };
  const pinnedSource = rootPackage.resolutions?.['@argonprotocol/mainchain'];
  if (!pinnedSource || pinnedSource.startsWith('portal:')) return;
  if (!Object.values(registry).some(sources => sources.includes(pinnedSource))) {
    throw new Error(`@argonprotocol/mainchain@${pinnedSource} is not registered in RuntimeSources.json`);
  }
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
