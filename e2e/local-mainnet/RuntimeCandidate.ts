import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import Path from 'node:path';
import { createInterface } from 'node:readline';

export interface CandidateRuntimeArtifact {
  sourceDirectory: string;
  gitHead: string;
  wasmPath: string;
  wasmSha256: string;
  expectedSpecVersion: number;
}

export class RuntimeCandidate {
  public static async build(args: {
    mainchainDirectory: string;
    runDirectory: string;
    expectedSpecVersion: number;
  }): Promise<CandidateRuntimeArtifact> {
    const { mainchainDirectory, runDirectory: requestedRunDirectory, expectedSpecVersion } = args;
    if (!Path.isAbsolute(requestedRunDirectory)) {
      throw new Error('Runtime migration runDirectory must be an absolute path');
    }
    if (!Number.isSafeInteger(expectedSpecVersion) || expectedSpecVersion < 1) {
      throw new Error('Candidate expectedSpecVersion must be a positive safe integer');
    }

    const sourceDirectory = realpathSync(mainchainDirectory);
    const runDirectory = RuntimeCandidate.canonicalNewPath(requestedRunDirectory);
    const relativeRunDirectory = Path.relative(sourceDirectory, runDirectory);
    const isOutsideSource = relativeRunDirectory.startsWith(`..${Path.sep}`) || Path.isAbsolute(relativeRunDirectory);
    if (!relativeRunDirectory || !isOutsideSource) {
      throw new Error('Runtime migration runDirectory must be outside the Mainchain source directory');
    }
    mkdirSync(runDirectory, { recursive: true });

    const candidateDirectory = Path.join(runDirectory, 'candidate');
    const wasmPath = Path.join(candidateDirectory, 'argon_runtime.compact.compressed.wasm');
    const attestationPath = Path.join(candidateDirectory, 'attestation.json');
    mkdirSync(candidateDirectory, { recursive: true });
    for (const outputPath of [wasmPath, attestationPath]) {
      if (existsSync(outputPath)) throw new Error(`Candidate output already exists at ${outputPath}`);
    }

    const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: sourceDirectory,
      encoding: 'utf8',
    }).trim();
    const runtimePackageId = RuntimeCandidate.getCargoPackageId(sourceDirectory);
    const buildProfileDirectory = await RuntimeCandidate.runCargoBuild(sourceDirectory, runtimePackageId);
    const builtWasmPath = Path.join(
      buildProfileDirectory,
      'wbuild',
      'argon-runtime',
      'argon_runtime.compact.compressed.wasm',
    );

    let wasmSize: number;
    try {
      const stats = statSync(builtWasmPath);
      if (!stats.isFile()) throw new Error('not a file');
      wasmSize = stats.size;
    } catch {
      throw new Error(`Candidate runtime WASM was not produced at ${builtWasmPath}`);
    }
    if (wasmSize === 0) throw new Error(`Candidate runtime WASM is empty at ${builtWasmPath}`);

    copyFileSync(builtWasmPath, wasmPath, constants.COPYFILE_EXCL);
    const artifact: CandidateRuntimeArtifact = {
      sourceDirectory,
      gitHead,
      wasmPath,
      wasmSha256: createHash('sha256').update(readFileSync(wasmPath)).digest('hex'),
      expectedSpecVersion,
    };
    writeFileSync(attestationPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
    return artifact;
  }

  private static async runCargoBuild(sourceDirectory: string, runtimePackageId: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(
        'cargo',
        [
          'build',
          '-p',
          'argon-runtime',
          '--release',
          '--features=on-chain-release-build',
          '--message-format=json-render-diagnostics',
        ],
        {
          cwd: sourceDirectory,
          env: { ...process.env, WASM_BUILD_WORKSPACE_HINT: sourceDirectory },
          stdio: ['ignore', 'pipe', 'inherit'],
        },
      );
      let buildProfileDirectory: string | undefined;
      let outputError: Error | undefined;
      const output = createInterface({ input: child.stdout });
      output.on('line', line => {
        if (!line) return;
        try {
          const message = JSON.parse(line) as { reason?: unknown; package_id?: unknown; out_dir?: unknown };
          if (
            message.reason === 'build-script-executed' &&
            message.package_id === runtimePackageId &&
            typeof message.out_dir === 'string'
          ) {
            const cargoBuildDirectory = Path.dirname(Path.dirname(message.out_dir));
            if (Path.basename(cargoBuildDirectory) !== 'build') {
              outputError = new Error(`Unexpected Cargo build-script output directory: ${message.out_dir}`);
              return;
            }
            buildProfileDirectory = Path.dirname(cargoBuildDirectory);
          }
        } catch (error) {
          outputError = new Error(`Invalid Cargo build output: ${(error as Error).message}`);
        }
      });
      child.once('error', error => reject(new Error(`Failed to start candidate runtime build: ${error.message}`)));
      child.once('close', (code, signal) => {
        if (code !== 0) {
          reject(new Error(`Candidate runtime build failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
        } else if (outputError) {
          reject(outputError);
        } else if (!buildProfileDirectory) {
          reject(new Error('Cargo did not report the argon-runtime build output directory'));
        } else {
          resolve(buildProfileDirectory);
        }
      });
    });
  }

  private static getCargoPackageId(sourceDirectory: string): string {
    let metadata: unknown;
    try {
      metadata = JSON.parse(
        execFileSync('cargo', ['metadata', '--format-version=1', '--no-deps'], {
          cwd: sourceDirectory,
          encoding: 'utf8',
        }),
      );
    } catch (error) {
      throw new Error(`Unable to read Mainchain Cargo metadata: ${(error as Error).message}`);
    }

    const runtimePackage = (metadata as { packages?: Array<{ id?: unknown; name?: unknown }> }).packages?.find(
      candidate => candidate.name === 'argon-runtime',
    );
    if (typeof runtimePackage?.id !== 'string') {
      throw new Error('Unable to resolve the argon-runtime package from Cargo metadata');
    }
    return runtimePackage.id;
  }

  private static canonicalNewPath(path: string): string {
    let existingAncestor = path;
    const missingNames: string[] = [];
    while (!existsSync(existingAncestor)) {
      missingNames.unshift(Path.basename(existingAncestor));
      existingAncestor = Path.dirname(existingAncestor);
    }
    return Path.join(realpathSync(existingAncestor), ...missingNames);
  }
}
