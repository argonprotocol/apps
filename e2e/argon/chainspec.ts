import Path from 'path';
import docker from 'docker-compose';
import * as Fs from 'fs';
import { ARGON_DOCKER_COMPOSE } from './index';

const runtimeWasmPath = process.argv[2];
if (!runtimeWasmPath) {
  throw new Error('Usage: tsx chainspec.ts <path-to-runtime-wasm>');
}
const runtimeBytes = await Fs.promises.readFile(Path.resolve(runtimeWasmPath)).catch(err => {
  throw new Error(`Failed to read runtime wasm file at ${Path.resolve(runtimeWasmPath)}: ${err.message}`);
});

const config = ARGON_DOCKER_COMPOSE;

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

let chainspecJson: any;
try {
  chainspecJson = JSON.parse((humanResult as any)?.out ?? '');
  if (!chainspecJson || typeof chainspecJson !== 'object') {
    throw new Error('Parsed chainspec is not an object');
  }
} catch (error) {
  throw new Error(`Failed to parse human chainspec JSON from stdout: ${(error as Error).message}`);
}

if (!chainspecJson.genesis || !chainspecJson.genesis.runtimeGenesis || !chainspecJson.genesis.runtimeGenesis.code) {
  // log all keys in structure
  console.log(
    'chainspec empty json: ',
    JSON.stringify(
      chainspecJson,
      (_key, value) => {
        if (typeof value === 'string' || Buffer.isBuffer(value)) {
          return '';
        }
        return value;
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

const rawSpecOutput = (rawResult as any)?.out ?? '';
if (!rawSpecOutput.trim()) {
  throw new Error('Failed to generate raw chainspec: docker-compose returned empty stdout.');
}

await Fs.promises.writeFile(rawPath, `${rawSpecOutput.trim()}\n`, 'utf8');
