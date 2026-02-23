import Path from 'path';
import docker from 'docker-compose';
import * as Fs from 'fs';

interface IDockerRunResult {
  out?: unknown;
}

interface IChainspecJson {
  genesis?: {
    runtimeGenesis?: {
      code?: string;
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

const runtimeWasmPath = process.argv[2];
if (!runtimeWasmPath) {
  throw new Error('Usage: tsx chainspec.ts <path-to-runtime-wasm>');
}
const runtimeBytes = await Fs.promises.readFile(Path.resolve(runtimeWasmPath)).catch(err => {
  throw new Error(`Failed to read runtime wasm file at ${Path.resolve(runtimeWasmPath)}: ${err.message}`);
});

const config = Path.resolve(import.meta.dirname, 'docker-compose.yml');

const outputDir = import.meta.dirname;
const humanPath = Path.resolve(outputDir, 'chainspec.json');
const rawPath = Path.resolve(outputDir, 'chainspec.raw.json');

if (Fs.existsSync(rawPath)) {
  // docker will put a directory here if there's no file, so remove it first
  await Fs.promises.rm(rawPath, { recursive: true });
}

// 1) Generate human spec from the current node image/config.
const humanResult = await docker.run('archive-node', ['build-spec', '--chain', 'dev-docker'], {
  config,
  log: true,
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
chainspecJson.genesis.runtimeGenesis.code = `0x${runtimeBytes.toString('hex')}`;

await Fs.promises.writeFile(humanPath, `${JSON.stringify(chainspecJson, null, 2)}\n`, 'utf8');

const rawResult = await docker.run('archive-node', ['build-spec', '--chain', '/chainspec.json', '--raw'], {
  config,
  log: true,
  commandOptions: ['--rm', '--no-deps', '-v', `${humanPath}:/chainspec.json:ro`],
  composeOptions: [],
});

const rawSpecOutput = readDockerOut(rawResult, 'raw chainspec');
if (!rawSpecOutput.trim()) {
  throw new Error('Failed to generate raw chainspec: docker-compose returned empty stdout.');
}

await Fs.promises.writeFile(rawPath, `${rawSpecOutput.trim()}\n`, 'utf8');
