import { execFileSync } from 'node:child_process';
import Fs from 'node:fs';
import Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { getClient } from '@argonprotocol/mainchain';
import { format, resolveConfig } from 'prettier';
import * as Semver from 'semver';
import {
  createRuntimeCompatibilityModule,
  readRuntimeCompatibilityProvenance,
  type RuntimeCompatibilityProvenance,
  type RuntimeInterfaceSources,
} from './runtimeCompatibilityTypes.ts';
import { readArgonSpecVersion } from '../runtime-client/src/history/runtimeSources.ts';

const RUNTIME_PACKAGES = ['@argonprotocol/mainchain', '@argonprotocol/testing', '@argonprotocol/bitcoin'] as const;
const AUTHORITATIVE_RUNTIME_PACKAGE = '@argonprotocol/mainchain' as const;
const USAGE = 'Usage: yarn mainchain:pin <dev|tag-or-commit-hash|sha-commit-hash|main>';
const REPO_ROOT = Path.resolve(import.meta.dirname, '..');
const ROOT_PACKAGE_JSON_PATH = Path.join(REPO_ROOT, 'package.json');
const ARGON_ENV_PATH = Path.join(REPO_ROOT, 'e2e/argon/.env');
const SERVER_DEV_DOCKER_ENV_PATH = Path.join(REPO_ROOT, 'server/.env.dev-docker');
const SERVER_MAINNET_ENV_PATH = Path.join(REPO_ROOT, 'server/.env.mainnet');
const SERVER_TESTNET_ENV_PATH = Path.join(REPO_ROOT, 'server/.env.testnet');
const RUNTIME_COMPATIBILITY_PATH = Path.join(REPO_ROOT, 'core/src/runtimeCompatibility.ts');
const MAINCHAIN_GIT_REPO = 'https://github.com/argonprotocol/mainchain.git';
const WORKSPACE_MAINCHAIN_PATH = Path.resolve(REPO_ROOT, '../mainchain');
const DEV_RUNTIME_PACKAGE_PATHS: Record<RuntimePackage, string> = {
  '@argonprotocol/mainchain': Path.join(WORKSPACE_MAINCHAIN_PATH, 'client/nodejs/package.json'),
  '@argonprotocol/testing': Path.join(WORKSPACE_MAINCHAIN_PATH, 'testing/nodejs/package.json'),
  '@argonprotocol/bitcoin': Path.join(WORKSPACE_MAINCHAIN_PATH, 'bitcoin/nodejs/package.json'),
};
const DEV_RUNTIME_PACKAGE_RESOLUTIONS: Record<RuntimePackage, string> = {
  '@argonprotocol/mainchain': 'portal:../mainchain/client/nodejs',
  '@argonprotocol/testing': 'portal:../mainchain/testing/nodejs',
  '@argonprotocol/bitcoin': 'portal:../mainchain/bitcoin/nodejs',
};
const RUNTIME_MANIFEST_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;
type RuntimePackage = (typeof RUNTIME_PACKAGES)[number];

void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.info(USAGE);
    return;
  }
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new Error(USAGE);
  }

  const ref = normalizeRef(args[0]);
  const isTagPin = isSemverLike(ref);
  const resolvedPin = resolveRuntimePin(ref);
  const runtimeSpecVersion = await resolvePinnedRuntimeSpecVersion(resolvedPin.mainRepoCommitHash);
  const envRaw = Fs.readFileSync(ARGON_ENV_PATH, 'utf8');
  const serverEnvRaw = Fs.readFileSync(SERVER_DEV_DOCKER_ENV_PATH, 'utf8');
  const rootPackageJsonRaw = Fs.readFileSync(ROOT_PACKAGE_JSON_PATH, 'utf8');
  const rootPackageJson = JSON.parse(rootPackageJsonRaw) as {
    workspaces?: string[];
  };
  const compatibilityResult = await updateRuntimeCompatibilityTypes(rootPackageJsonRaw);

  const envResult = updateEnvContents(envRaw, {
    VERSION: resolvedPin.dockerVersion,
  });
  const serverEnvResult = updateEnvContents(serverEnvRaw, {
    ARGON_VERSION: resolvedPin.dockerVersion,
  });
  const releaseServerEnvResults = isTagPin
    ? [
        {
          envPath: SERVER_MAINNET_ENV_PATH,
          ...updateEnvContents(Fs.readFileSync(SERVER_MAINNET_ENV_PATH, 'utf8'), {
            ARGON_VERSION: resolvedPin.dockerVersion,
          }),
        },
        {
          envPath: SERVER_TESTNET_ENV_PATH,
          ...updateEnvContents(Fs.readFileSync(SERVER_TESTNET_ENV_PATH, 'utf8'), {
            ARGON_VERSION: resolvedPin.dockerVersion,
          }),
        },
      ]
    : [];
  const packageManifestResults = [
    ROOT_PACKAGE_JSON_PATH,
    ...(rootPackageJson.workspaces ?? []).map(workspace => Path.join(REPO_ROOT, workspace, 'package.json')),
  ].map(manifestPath => {
    const packageJsonRaw =
      manifestPath === ROOT_PACKAGE_JSON_PATH ? rootPackageJsonRaw : Fs.readFileSync(manifestPath, 'utf8');
    return {
      manifestPath,
      ...updatePackageJson(packageJsonRaw, resolvedPin.runtimePackageVersions, {
        updateResolutions: manifestPath === ROOT_PACKAGE_JSON_PATH,
        runtimePackageResolutions: resolvedPin.runtimePackageResolutions,
      }),
    };
  });

  if (envResult.changedKeys.length) {
    Fs.writeFileSync(ARGON_ENV_PATH, envResult.next, 'utf8');
  }
  if (serverEnvResult.changedKeys.length) {
    Fs.writeFileSync(SERVER_DEV_DOCKER_ENV_PATH, serverEnvResult.next, 'utf8');
  }
  for (const releaseServerEnvResult of releaseServerEnvResults) {
    if (!releaseServerEnvResult.changedKeys.length) continue;
    Fs.writeFileSync(releaseServerEnvResult.envPath, releaseServerEnvResult.next, 'utf8');
  }
  for (const packageManifestResult of packageManifestResults) {
    if (!packageManifestResult.changedSections.length) continue;
    Fs.writeFileSync(packageManifestResult.manifestPath, packageManifestResult.next, 'utf8');
  }

  console.info('Updated runtime pin configuration.');
  console.info(
    `- runtime compatibility: ${compatibilityResult.changed ? Path.relative(REPO_ROOT, RUNTIME_COMPATIBILITY_PATH) : `unchanged (mainnet spec ${compatibilityResult.provenance.specVersion})`}`,
  );
  console.info(`- e2e/argon/.env: ${envResult.changedKeys.join(', ') || 'no changes'}`);
  console.info(`- server/.env.dev-docker: ${serverEnvResult.changedKeys.join(', ') || 'no changes'}`);
  if (isTagPin) {
    for (const releaseServerEnvResult of releaseServerEnvResults) {
      console.info(
        `- ${Path.relative(REPO_ROOT, releaseServerEnvResult.envPath)}: ${releaseServerEnvResult.changedKeys.join(', ') || 'no changes'}`,
      );
    }
  } else {
    console.info('- server/.env.mainnet: skipped (only updated for semver tag pins)');
    console.info('- server/.env.testnet: skipped (only updated for semver tag pins)');
  }
  for (const packageManifestResult of packageManifestResults) {
    console.info(
      `- ${Path.relative(REPO_ROOT, packageManifestResult.manifestPath)}: ${packageManifestResult.changedSections.join('; ') || 'no changes'}`,
    );
  }
  console.info(`- docker/runtime ref: ${resolvedPin.dockerVersion}`);
  console.info(
    `- npm runtime versions: ${RUNTIME_PACKAGES.map(pkg => `${pkg}=${resolvedPin.runtimePackageVersions[pkg]}`).join(', ')}`,
  );
  if (resolvedPin.runtimePackageResolutions) {
    console.info(
      `- npm runtime resolutions: ${RUNTIME_PACKAGES.map(pkg => `${pkg}=${resolvedPin.runtimePackageResolutions?.[pkg]}`).join(', ')}`,
    );
  }
  if (resolvedPin.mainRepoCommitHash) {
    console.info(`- main repo commit: ${resolvedPin.mainRepoCommitHash}`);
  }
  console.info(`- runtime spec: ${runtimeSpecVersion}`);
  if (Fs.existsSync(WORKSPACE_MAINCHAIN_PATH)) {
    console.info(
      '- note: workspace docker mode (`yarn docker:up:workspace`) uses ../mainchain directly and does not read these pinned npm versions.',
    );
  }

  console.info('Building yarn');
  execFileSync('yarn', ['install'], {
    cwd: REPO_ROOT,
    env: { ...process.env, YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' },
    shell: true,
    stdio: 'inherit',
  });
  console.info('Regenerating runtime query and historical event types');
  const generatorArgs = [
    'workspace',
    '@argonprotocol/runtime-client',
    'generate',
    '--source',
    resolvedPin.runtimePackageVersions[AUTHORITATIVE_RUNTIME_PACKAGE],
    '--spec',
    String(runtimeSpecVersion),
  ];
  if (resolvedPin.runtimePackageResolutions) generatorArgs.push('--local');
  execFileSync('yarn', generatorArgs, {
    cwd: REPO_ROOT,
    env: process.env,
    shell: true,
    stdio: 'inherit',
  });
  console.info('Building server');
  execFileSync('yarn', ['build:server'], {
    cwd: REPO_ROOT,
    env: process.env,
    shell: true,
    stdio: 'inherit',
  });
}

function normalizeRef(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(USAGE);
  }
  return normalized;
}

async function updateRuntimeCompatibilityTypes(
  rootPackageJsonRaw: string,
): Promise<{ changed: boolean; provenance: RuntimeCompatibilityProvenance }> {
  const deployedRuntime = await readDeployedRuntime();
  if (Fs.existsSync(RUNTIME_COMPATIBILITY_PATH)) {
    const existing = readRuntimeCompatibilityProvenance(Fs.readFileSync(RUNTIME_COMPATIBILITY_PATH, 'utf8'));
    if (existing?.specVersion === deployedRuntime.specVersion) {
      return { changed: false, provenance: existing };
    }
  }

  const rootPackageJson = JSON.parse(rootPackageJsonRaw) as {
    resolutions?: Record<string, string>;
  };
  const installedPackagePath = Path.resolve(
    Path.dirname(fileURLToPath(import.meta.resolve(AUTHORITATIVE_RUNTIME_PACKAGE))),
    '../package.json',
  );
  const installedPackage = JSON.parse(Fs.readFileSync(installedPackagePath, 'utf8')) as {
    name?: string;
    version?: string;
  };
  const clientVersion = installedPackage.version;
  if (installedPackage.name !== AUTHORITATIVE_RUNTIME_PACKAGE || !clientVersion || !Semver.valid(clientVersion)) {
    throw new Error(`Cannot snapshot runtime compatibility types from ${clientVersion ?? 'an unknown client version'}`);
  }

  if (!clientMatchesNodeVersion(clientVersion, deployedRuntime.nodeVersion)) {
    throw new Error(
      `Cannot snapshot mainnet runtime spec ${deployedRuntime.specVersion}: the deployed node is ${deployedRuntime.nodeVersion}, but the installed ${AUTHORITATIVE_RUNTIME_PACKAGE} client is ${clientVersion}`,
    );
  }

  const sources = await readCurrentRuntimeInterfaceSources({
    installedPackageDirectory: Path.dirname(installedPackagePath),
    resolution: rootPackageJson.resolutions?.[AUTHORITATIVE_RUNTIME_PACKAGE],
    version: clientVersion,
  });
  const provenance: RuntimeCompatibilityProvenance = {
    clientVersion,
    finalizedBlockHash: deployedRuntime.finalizedBlockHash,
    specVersion: deployedRuntime.specVersion,
  };
  const generated = createRuntimeCompatibilityModule(sources, provenance);
  const prettierConfig = await resolveConfig(RUNTIME_COMPATIBILITY_PATH);
  const formatted = await format(generated, { ...prettierConfig, filepath: RUNTIME_COMPATIBILITY_PATH });
  if (Fs.existsSync(RUNTIME_COMPATIBILITY_PATH) && Fs.readFileSync(RUNTIME_COMPATIBILITY_PATH, 'utf8') === formatted) {
    return { changed: false, provenance };
  }

  Fs.writeFileSync(RUNTIME_COMPATIBILITY_PATH, formatted, 'utf8');
  return { changed: true, provenance };
}

async function readDeployedRuntime(): Promise<{
  finalizedBlockHash: string;
  nodeVersion: string;
  specVersion: number;
}> {
  const archiveUrl = parseEnv(Fs.readFileSync(SERVER_MAINNET_ENV_PATH, 'utf8')).ARGON_ARCHIVE_NODE;
  if (!archiveUrl) {
    throw new Error(`${Path.relative(REPO_ROOT, SERVER_MAINNET_ENV_PATH)} does not define ARGON_ARCHIVE_NODE`);
  }

  const client = await getClient(archiveUrl);
  try {
    const finalizedBlockHash = (await client.rpc.chain.getFinalizedHead()).toHex();
    const runtimeVersion = await client.rpc.state.getRuntimeVersion(finalizedBlockHash);
    const specVersion = runtimeVersion.specVersion.toNumber();
    const nodeVersion = (await client.rpc.system.version()).toString();
    return { finalizedBlockHash, nodeVersion, specVersion };
  } finally {
    await client.disconnect();
  }
}

async function readCurrentRuntimeInterfaceSources(args: {
  installedPackageDirectory: string;
  resolution?: string;
  version: string;
}): Promise<RuntimeInterfaceSources> {
  const portalPath = args.resolution?.startsWith('portal:')
    ? Path.resolve(REPO_ROOT, args.resolution.slice('portal:'.length))
    : null;
  const localPaths = [
    args.installedPackageDirectory,
    portalPath,
    Path.dirname(DEV_RUNTIME_PACKAGE_PATHS[AUTHORITATIVE_RUNTIME_PACKAGE]),
  ].filter((path): path is string => Boolean(path));

  for (const localPath of localPaths) {
    const packageJsonPath = Path.join(localPath, 'package.json');
    if (!Fs.existsSync(packageJsonPath)) continue;

    const packageJson = JSON.parse(Fs.readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    if (packageJson.version !== args.version) continue;

    const interfacesDirectory = Path.join(localPath, 'src/interfaces');
    if (
      ![
        'types-lookup.ts',
        'augment-api-tx.ts',
        'augment-api-query.ts',
        'augment-api-events.ts',
        'augment-api-runtime.ts',
      ].every(filename => Fs.existsSync(Path.join(interfacesDirectory, filename)))
    ) {
      continue;
    }

    return readRuntimeInterfaceSourcesFromDirectory(interfacesDirectory);
  }

  const response = await fetch(
    `https://registry.npmjs.org/@argonprotocol/mainchain/-/mainchain-${encodeURIComponent(args.version)}.tgz`,
  );
  if (!response.ok) {
    throw new Error(`Unable to download ${AUTHORITATIVE_RUNTIME_PACKAGE}@${args.version}: ${response.status}`);
  }

  const archive = gunzipSync(Buffer.from(await response.arrayBuffer()));
  return readRuntimeInterfaceSourcesFromArchive(archive, args.version);
}

function readRuntimeInterfaceSourcesFromDirectory(directory: string): RuntimeInterfaceSources {
  return {
    lookup: Fs.readFileSync(Path.join(directory, 'types-lookup.ts'), 'utf8'),
    tx: Fs.readFileSync(Path.join(directory, 'augment-api-tx.ts'), 'utf8'),
    query: Fs.readFileSync(Path.join(directory, 'augment-api-query.ts'), 'utf8'),
    events: Fs.readFileSync(Path.join(directory, 'augment-api-events.ts'), 'utf8'),
    runtime: Fs.readFileSync(Path.join(directory, 'augment-api-runtime.ts'), 'utf8'),
  };
}

function readRuntimeInterfaceSourcesFromArchive(archive: Buffer, version: string): RuntimeInterfaceSources {
  const readSource = (filename: string) => {
    const contents = readTarFile(archive, `package/src/interfaces/${filename}`);
    if (!contents) {
      throw new Error(`${AUTHORITATIVE_RUNTIME_PACKAGE}@${version} does not include src/interfaces/${filename}`);
    }
    return contents;
  };

  return {
    lookup: readSource('types-lookup.ts'),
    tx: readSource('augment-api-tx.ts'),
    query: readSource('augment-api-query.ts'),
    events: readSource('augment-api-events.ts'),
    runtime: readSource('augment-api-runtime.ts'),
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

function clientMatchesNodeVersion(clientVersion: string, nodeVersion: string): boolean {
  if (Semver.coerce(clientVersion)?.version !== Semver.coerce(nodeVersion)?.version) return false;

  const clientCommit = Semver.parse(clientVersion)?.prerelease.find(
    (identifier): identifier is string => typeof identifier === 'string' && /^[a-f0-9]{7,40}$/i.test(identifier),
  );
  return !clientCommit || nodeVersion.toLowerCase().includes(clientCommit.toLowerCase());
}

function isCommitHash(value: string): boolean {
  return /^[a-f0-9]{7,40}$/i.test(value);
}

function toCommitHashFromShaTag(value: string): string | null {
  const match = /^sha-([a-f0-9]{7,40})$/i.exec(value.trim());
  if (!match) return null;
  return match[1].toLowerCase();
}

function isSemverLike(value: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i.test(value);
}

function toNpmVersion(ref: string): string {
  return ref.startsWith('v') ? ref.slice(1) : ref;
}

function toDockerVersionFromNpmVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

function toDockerVersionFromCommitHash(commitHash: string): string {
  return `sha-${commitHash.slice(0, 7).toLowerCase()}`;
}

function resolveRuntimePin(ref: string): {
  dockerVersion: string;
  runtimePackageVersions: Record<RuntimePackage, string>;
  runtimePackageResolutions?: Record<RuntimePackage, string>;
  mainRepoCommitHash?: string;
} {
  if (ref === 'dev') {
    return {
      dockerVersion: 'dev',
      runtimePackageVersions: readDevRuntimePackageVersions(),
      runtimePackageResolutions: DEV_RUNTIME_PACKAGE_RESOLUTIONS,
    };
  }

  if (ref === 'main') {
    const mainRepoCommitHash = resolveMainRepoCommitHash();
    const sharedRuntimeVersion = resolveSharedRuntimeVersionByCommit(mainRepoCommitHash);
    return {
      dockerVersion: toDockerVersionFromCommitHash(mainRepoCommitHash),
      runtimePackageVersions: createRuntimePackageVersions(sharedRuntimeVersion),
      mainRepoCommitHash,
    };
  }

  const shaTaggedCommitHash = toCommitHashFromShaTag(ref);
  if (shaTaggedCommitHash || isCommitHash(ref)) {
    const commitHash = (shaTaggedCommitHash ?? ref).toLowerCase();
    const sharedRuntimeVersion = resolveSharedRuntimeVersionByCommit(commitHash);
    return {
      dockerVersion: toDockerVersionFromCommitHash(commitHash),
      runtimePackageVersions: createRuntimePackageVersions(sharedRuntimeVersion),
      mainRepoCommitHash: commitHash,
    };
  }

  if (!isSemverLike(ref)) {
    throw new Error(USAGE);
  }

  const npmVersion = toNpmVersion(ref);
  const mainRepoCommitHash = resolveMainRepoTagCommitHash(npmVersion);
  return {
    dockerVersion: toDockerVersionFromNpmVersion(npmVersion),
    runtimePackageVersions: createRuntimePackageVersions(npmVersion),
    mainRepoCommitHash,
  };
}

async function resolvePinnedRuntimeSpecVersion(commitHash?: string): Promise<number> {
  if (!commitHash) {
    const runtimeSourcePath = Path.join(WORKSPACE_MAINCHAIN_PATH, 'runtime/argon/src/lib.rs');
    if (!Fs.existsSync(runtimeSourcePath)) {
      throw new Error(`Missing dev runtime source: ${runtimeSourcePath}`);
    }
    return readArgonSpecVersion(Fs.readFileSync(runtimeSourcePath, 'utf8'));
  }

  const response = await fetch(
    `https://raw.githubusercontent.com/argonprotocol/mainchain/${commitHash}/runtime/argon/src/lib.rs`,
  );
  if (!response.ok) throw new Error(`Unable to read Argon runtime spec at ${commitHash}: ${response.status}`);
  return readArgonSpecVersion(await response.text());
}

function readDevRuntimePackageVersions(): Record<RuntimePackage, string> {
  const runtimePackageVersions = {} as Record<RuntimePackage, string>;
  for (const runtimePackage of RUNTIME_PACKAGES) {
    const packageJsonPath = DEV_RUNTIME_PACKAGE_PATHS[runtimePackage];
    if (!Fs.existsSync(packageJsonPath)) {
      throw new Error(`Missing dev runtime package manifest: ${Path.relative(REPO_ROOT, packageJsonPath)}`);
    }
    const packageJson = JSON.parse(Fs.readFileSync(packageJsonPath, 'utf8')) as {
      name?: string;
      version?: string;
    };
    if (packageJson.name !== runtimePackage) {
      throw new Error(
        `Expected ${Path.relative(REPO_ROOT, packageJsonPath)} to be ${runtimePackage}, found ${packageJson.name ?? 'unknown'}.`,
      );
    }
    if (!packageJson.version) {
      throw new Error(`Missing version in dev runtime package manifest: ${Path.relative(REPO_ROOT, packageJsonPath)}`);
    }
    runtimePackageVersions[runtimePackage] = packageJson.version;
  }
  return runtimePackageVersions;
}

function updateEnvContents(
  input: string,
  updates: Record<string, string>,
): {
  next: string;
  changedKeys: string[];
} {
  let next = input;
  const changedKeys: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const parsed = parseEnv(next);
    if (parsed[key] === value) continue;
    next = setEnvValue(next, key, value);
    changedKeys.push(key);
  }

  if (!next.endsWith('\n')) next += '\n';
  return { next, changedKeys };
}

function setEnvValue(input: string, key: string, value: string): string {
  const lines = input.split('\n');
  let replaced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || /^\s*#/.test(line)) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;
    const lineKey = line.slice(0, separatorIndex).trim();
    if (lineKey !== key) continue;
    lines[i] = `${lineKey}=${value}`;
    replaced = true;
    break;
  }
  if (!replaced) {
    lines.push(`${key}=${value}`);
  }
  return lines.join('\n');
}

function resolveMainRepoCommitHash(): string {
  const output = execFileSync('git', ['ls-remote', MAINCHAIN_GIT_REPO, 'refs/heads/main'], {
    encoding: 'utf8',
  }).trim();
  const hash = output.split(/\s+/)[0]?.trim();
  if (!hash || !isCommitHash(hash)) {
    throw new Error(`Failed to resolve main commit hash from ${MAINCHAIN_GIT_REPO}`);
  }
  return hash.toLowerCase();
}

function resolveMainRepoTagCommitHash(version: string): string {
  const tags = [`v${version}`, version];
  const refs = tags.flatMap(tag => [`refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  const output = execFileSync('git', ['ls-remote', '--tags', MAINCHAIN_GIT_REPO, ...refs], {
    encoding: 'utf8',
  }).trim();
  const entries = output
    .split('\n')
    .filter(Boolean)
    .map(line => line.trim().split(/\s+/))
    .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]));

  for (const tag of tags) {
    const peeled = entries.find(([, ref]) => ref === `refs/tags/${tag}^{}`)?.[0];
    const direct = entries.find(([, ref]) => ref === `refs/tags/${tag}`)?.[0];
    const commit = peeled ?? direct;
    if (commit && isCommitHash(commit)) return commit.toLowerCase();
  }
  throw new Error(`Unable to resolve mainchain tag for runtime package ${version}`);
}

function getPublishedPackageVersions(packageName: RuntimePackage): string[] {
  const raw = execFileSync('npm', ['view', packageName, 'versions', '--json'], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
  }).trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as string[] | string;
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === 'string') return [parsed];
  return [];
}

function createRuntimePackageVersions(sharedVersion: string): Record<RuntimePackage, string> {
  const runtimePackageVersions = {} as Record<RuntimePackage, string>;
  for (const runtimePackage of RUNTIME_PACKAGES) {
    runtimePackageVersions[runtimePackage] = sharedVersion;
  }
  return runtimePackageVersions;
}

function resolveSharedRuntimeVersionByCommit(commitHash: string): string {
  const shortHash = commitHash.slice(0, 8).toLowerCase();
  const publishedVersions = getPublishedPackageVersions(AUTHORITATIVE_RUNTIME_PACKAGE);
  const candidateVersions = publishedVersions.filter(version => version.toLowerCase().includes(`-dev.${shortHash}`));
  if (!candidateVersions.length) {
    throw new Error(
      `No published ${AUTHORITATIVE_RUNTIME_PACKAGE} version matches commit ${commitHash} (-dev.${shortHash}).`,
    );
  }

  const sorted = Semver.rsort(candidateVersions);
  const selectedVersion = sorted[0];
  if (!selectedVersion) {
    throw new Error(
      `Unable to select published version for ${AUTHORITATIVE_RUNTIME_PACKAGE} with commit ${commitHash}.`,
    );
  }
  return selectedVersion;
}

function updatePackageJson(
  packageJsonRaw: string,
  runtimePackageVersions: Record<RuntimePackage, string>,
  options: {
    updateResolutions?: boolean;
    runtimePackageResolutions?: Record<RuntimePackage, string>;
  } = {},
): {
  next: string;
  changedSections: string[];
} {
  const packageJson = JSON.parse(packageJsonRaw) as {
    workspaces?: string[];
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    resolutions?: Record<string, string>;
  };

  const changedSections: string[] = [];
  for (const section of RUNTIME_MANIFEST_SECTIONS) {
    const changedPackages: string[] = [];
    const dependencies = packageJson[section];
    if (dependencies) {
      for (const runtimePackage of RUNTIME_PACKAGES) {
        if (!(runtimePackage in dependencies)) continue;
        const nextValue = runtimePackageVersions[runtimePackage];
        if (dependencies[runtimePackage] === nextValue) continue;
        dependencies[runtimePackage] = nextValue;
        changedPackages.push(runtimePackage);
      }
    }
    if (changedPackages.length) {
      changedSections.push(`${section}: ${changedPackages.join(', ')}`);
    }
  }
  if (options.updateResolutions) {
    packageJson.resolutions ??= {};
    const changedPackages: string[] = [];
    for (const runtimePackage of RUNTIME_PACKAGES) {
      const nextValue = options.runtimePackageResolutions?.[runtimePackage] ?? runtimePackageVersions[runtimePackage];
      if (packageJson.resolutions[runtimePackage] === nextValue) continue;
      packageJson.resolutions[runtimePackage] = nextValue;
      changedPackages.push(runtimePackage);
    }
    if (changedPackages.length) {
      changedSections.push(`resolutions: ${changedPackages.join(', ')}`);
    }
  }

  let next = JSON.stringify(packageJson, null, 2);
  if (!next.endsWith('\n')) next += '\n';
  return { next, changedSections };
}
