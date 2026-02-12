import { execFileSync } from 'node:child_process';
import Fs from 'node:fs';
import Path from 'node:path';
import { parseEnv } from 'node:util';
import Semver from 'semver';

const RUNTIME_PACKAGES = ['@argonprotocol/mainchain', '@argonprotocol/testing', '@argonprotocol/bitcoin'] as const;
const AUTHORITATIVE_RUNTIME_PACKAGE = '@argonprotocol/mainchain' as const;
const REPO_ROOT = Path.resolve(import.meta.dirname, '..');
const PACKAGE_JSON_PATH = Path.join(REPO_ROOT, 'package.json');
const ARGON_ENV_PATH = Path.join(REPO_ROOT, 'e2e/argon/.env');
const SERVER_DEV_DOCKER_ENV_PATH = Path.join(REPO_ROOT, 'server/.env.dev-docker');
const MAINCHAIN_GIT_REPO = 'https://github.com/argonprotocol/mainchain.git';
type RuntimePackage = (typeof RUNTIME_PACKAGES)[number];

void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.info('Usage: yarn mainchain:pin <tag-or-commit-hash|sha-commit-hash|main>');
    return;
  }
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new Error('Usage: yarn mainchain:pin <tag-or-commit-hash|sha-commit-hash|main>');
  }

  const ref = normalizeRef(args[0]);
  const resolvedPin = resolveRuntimePin(ref);
  const envRaw = Fs.readFileSync(ARGON_ENV_PATH, 'utf8');
  const serverEnvRaw = Fs.readFileSync(SERVER_DEV_DOCKER_ENV_PATH, 'utf8');
  const packageJsonRaw = Fs.readFileSync(PACKAGE_JSON_PATH, 'utf8');

  const envResult = updateEnvContents(envRaw, {
    VERSION: resolvedPin.dockerVersion,
  });
  const serverEnvResult = updateEnvContents(serverEnvRaw, {
    ARGON_VERSION: resolvedPin.dockerVersion,
  });

  const packageJsonResult = updatePackageJson(packageJsonRaw, resolvedPin.runtimePackageVersions);

  if (envResult.changedKeys.length) {
    Fs.writeFileSync(ARGON_ENV_PATH, envResult.next, 'utf8');
  }
  if (serverEnvResult.changedKeys.length) {
    Fs.writeFileSync(SERVER_DEV_DOCKER_ENV_PATH, serverEnvResult.next, 'utf8');
  }
  if (packageJsonResult.changedPackages.length) {
    Fs.writeFileSync(PACKAGE_JSON_PATH, packageJsonResult.next, 'utf8');
  }

  console.info('Updated runtime pin configuration.');
  console.info(`- e2e/argon/.env: ${envResult.changedKeys.join(', ') || 'no changes'}`);
  console.info(`- server/.env.dev-docker: ${serverEnvResult.changedKeys.join(', ') || 'no changes'}`);
  console.info(`- package.json resolutions: ${packageJsonResult.changedPackages.join(', ') || 'no changes'}`);
  console.info(`- docker/runtime ref: ${resolvedPin.dockerVersion}`);
  console.info(
    `- npm runtime versions: ${RUNTIME_PACKAGES.map(pkg => `${pkg}=${resolvedPin.runtimePackageVersions[pkg]}`).join(', ')}`,
  );
  if (resolvedPin.mainRepoCommitHash) {
    console.info(`- main repo commit: ${resolvedPin.mainRepoCommitHash}`);
  }
  console.info('- next step: run yarn install to sync yarn.lock and node_modules');
}

function normalizeRef(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error('Usage: yarn mainchain:pin <tag-or-commit-hash|sha-commit-hash|main>');
  }
  return normalized;
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
  mainRepoCommitHash?: string;
} {
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
    };
  }

  if (!isSemverLike(ref)) {
    throw new Error('Usage: yarn mainchain:pin <tag-or-commit-hash|sha-commit-hash|main>');
  }

  const npmVersion = toNpmVersion(ref);
  return {
    dockerVersion: toDockerVersionFromNpmVersion(npmVersion),
    runtimePackageVersions: createRuntimePackageVersions(npmVersion),
  };
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
): {
  next: string;
  changedPackages: string[];
} {
  const packageJson = JSON.parse(packageJsonRaw) as {
    resolutions?: Record<string, string>;
  };

  packageJson.resolutions ??= {};
  const changedPackages: string[] = [];
  for (const runtimePackage of RUNTIME_PACKAGES) {
    const nextValue = runtimePackageVersions[runtimePackage];
    if (packageJson.resolutions[runtimePackage] !== nextValue) {
      packageJson.resolutions[runtimePackage] = nextValue;
      changedPackages.push(runtimePackage);
    }
  }

  let next = JSON.stringify(packageJson, null, 2);
  if (!next.endsWith('\n')) next += '\n';
  return { next, changedPackages };
}
