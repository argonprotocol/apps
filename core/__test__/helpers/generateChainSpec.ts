import Path from 'path';
import docker from 'docker-compose';
import * as Fs from 'fs';

export async function generateChainSpec({
  runtimeWasmPath,
  ticksBetweenSlots,
  computeDifficulty,
  outputPath,
  env = process.env,
}: {
  runtimeWasmPath?: string;
  ticksBetweenSlots?: number;
  computeDifficulty?: number;
  outputPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const runtimeBytes = runtimeWasmPath
    ? await Fs.promises.readFile(Path.resolve(runtimeWasmPath)).catch(err => {
        throw new Error(`Failed to read runtime wasm file at ${Path.resolve(runtimeWasmPath)}: ${err.message}`);
      })
    : undefined;

  const config = Path.resolve(import.meta.dirname, '../../../e2e/argon/docker-compose.yml');

  const rawPath = Path.resolve(
    outputPath ||
      env.ARGON_CHAIN_SPEC_PATH?.trim() ||
      Path.join(import.meta.dirname, '../../../e2e/argon/chainspec.raw.json'),
  );
  const outputDir = Path.dirname(rawPath);
  const humanPath = Path.resolve(outputDir, 'chainspec.json');
  await Fs.promises.mkdir(outputDir, { recursive: true });

  if (Fs.existsSync(rawPath) && Fs.statSync(rawPath).isDirectory()) {
    // Docker creates an empty directory for a missing mount source.
    await Fs.promises.rmdir(rawPath);
  }

  // 1) Generate human spec from the current node image/config.
  const humanResult = await docker.run('archive-node', ['build-spec', '--chain', 'dev-docker'], {
    config,
    cwd: Path.resolve(import.meta.dirname, '../../..'),
    env,
    log: false,
    commandOptions: ['--rm', '--no-deps'],
  } as any);

  let chainspecJson: IChainspecJson;
  try {
    const parsed = JSON.parse(readDockerOut(humanResult, 'human chainspec'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Parsed chainspec is not an object');
    }
    chainspecJson = parsed as IChainspecJson;
  } catch (error) {
    throw new Error(`Failed to parse human chainspec JSON from stdout: ${(error as Error).message}`);
  }

  if (!hasRuntimeGenesisCode(chainspecJson)) {
    // log all keys in structure
    console.log(
      'chainspec empty json: ',
      JSON.stringify(
        chainspecJson,
        (_key, value) => {
          if (typeof value === 'string' || Buffer.isBuffer(value)) {
            return '';
          }
          return value as unknown;
        },
        2,
      ),
    );
    throw new Error('Invalid chainspec format: missing genesis.runtimeGenesis.code');
  }
  if (runtimeBytes) {
    chainspecJson.genesis.runtimeGenesis.code = `0x${runtimeBytes.toString('hex')}`;
  }
  if (ticksBetweenSlots !== undefined) {
    const miningConfig = chainspecJson.genesis.runtimeGenesis.patch?.miningSlot?.miningConfig;
    if (!miningConfig) {
      throw new Error('Invalid chainspec format: missing genesis mining slot configuration');
    }
    miningConfig.ticksBetweenSlots = ticksBetweenSlots;
  }
  if (computeDifficulty !== undefined) {
    const blockSealSpec = chainspecJson.genesis.runtimeGenesis.patch?.blockSealSpec;
    if (!blockSealSpec) {
      throw new Error('Invalid chainspec format: missing genesis block seal configuration');
    }
    blockSealSpec.initialComputeDifficulty = computeDifficulty;
  }

  await Fs.promises.writeFile(humanPath, `${JSON.stringify(chainspecJson, null, 2)}\n`, 'utf8');

  const rawResult = await docker.run('archive-node', ['build-spec', '--chain', '/chainspec.json', '--raw'], {
    config,
    cwd: Path.resolve(import.meta.dirname, '../../..'),
    env,
    log: false,
    commandOptions: ['--rm', '--no-deps', '-v', `${humanPath}:/chainspec.json:ro`],
    composeOptions: [],
  });

  const rawSpecOutput = readDockerOut(rawResult, 'raw chainspec');
  if (!rawSpecOutput.trim()) {
    throw new Error('Failed to generate raw chainspec: docker-compose returned empty stdout.');
  }

  await Fs.promises.writeFile(rawPath, `${rawSpecOutput.trim()}\n`, 'utf8');
  console.info(`Generated raw chain spec at ${rawPath}`);
}

interface IDockerRunResult {
  out?: unknown;
}

interface IChainspecJson {
  genesis?: {
    runtimeGenesis?: {
      code?: string;
      patch?: {
        blockSealSpec?: {
          initialComputeDifficulty?: number;
        };
        miningSlot?: {
          miningConfig?: {
            ticksBetweenSlots?: number;
          };
        };
      };
    };
  };
  [key: string]: unknown;
}

function readDockerOut(result: unknown, label: string): string {
  const out = (result as IDockerRunResult | null | undefined)?.out;
  if (typeof out !== 'string') {
    throw new Error(`${label} did not return a stdout string.`);
  }
  return out;
}

function hasRuntimeGenesisCode(chainspec: IChainspecJson): chainspec is IChainspecJson & {
  genesis: {
    runtimeGenesis: {
      code: string;
    };
  };
} {
  return (
    typeof chainspec.genesis === 'object' &&
    chainspec.genesis != null &&
    typeof chainspec.genesis.runtimeGenesis === 'object' &&
    chainspec.genesis.runtimeGenesis != null &&
    typeof chainspec.genesis.runtimeGenesis.code === 'string'
  );
}
