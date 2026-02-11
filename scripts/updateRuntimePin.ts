import { execFileSync } from 'node:child_process';
import Fs from 'node:fs';
import Path from 'node:path';
import { parseEnv } from 'node:util';

const RUNTIME_PACKAGES = ['@argonprotocol/mainchain', '@argonprotocol/testing', '@argonprotocol/bitcoin'] as const;
const REPO_ROOT = Path.resolve(import.meta.dirname, '..');
const PACKAGE_JSON_PATH = Path.join(REPO_ROOT, 'package.json');
const ARGON_ENV_PATH = Path.join(REPO_ROOT, 'e2e/argon/.env');
const SERVER_DEV_DOCKER_ENV_PATH = Path.join(REPO_ROOT, 'server/.env.dev-docker');
const MAINCHAIN_GIT_REPO = 'https://github.com/argonprotocol/mainchain.git';

void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.info('Usage: yarn runtime:pin <tag-or-commit-hash|main>');
    return;
  }
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new Error('Usage: yarn runtime:pin <tag-or-commit-hash|main>');
  }

  const ref = normalizeRef(args[0]);
  const dockerVersion = toDockerVersion(ref);
  const mainRepoCommitHash = ref === 'main' ? resolveMainRepoCommitHash() : undefined;
  const envRaw = Fs.readFileSync(ARGON_ENV_PATH, 'utf8');
  const serverEnvRaw = Fs.readFileSync(SERVER_DEV_DOCKER_ENV_PATH, 'utf8');
  const packageJsonRaw = Fs.readFileSync(PACKAGE_JSON_PATH, 'utf8');

  const envResult = updateEnvContents(envRaw, {
    VERSION: dockerVersion,
  });
  const serverEnvResult = updateEnvContents(serverEnvRaw, {
    ARGON_VERSION: dockerVersion,
  });

  const packageJsonResult = updatePackageJson(packageJsonRaw, ref, mainRepoCommitHash);

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
  if (mainRepoCommitHash) {
    console.info(`- main repo commit: ${mainRepoCommitHash}`);
  }
}

function normalizeRef(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error('Usage: yarn runtime:pin <tag-or-commit-hash|main>');
  }
  return normalized;
}

function isCommitHash(value: string): boolean {
  return /^[a-f0-9]{7,40}$/i.test(value);
}

function isSemverLike(value: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i.test(value);
}

function toDockerVersion(ref: string): string {
  if (ref === 'main') {
    return 'dev';
  }
  if (isCommitHash(ref)) {
    return `sha-${ref.slice(0, 7).toLowerCase()}`;
  }
  if (isSemverLike(ref) && !ref.startsWith('v')) {
    return `v${ref}`;
  }
  return ref;
}

function toNpmVersion(ref: string): string {
  return ref.startsWith('v') ? ref.slice(1) : ref;
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

function toGitWorkspaceResolution(workspace: string, commitHash: string): string {
  return `${MAINCHAIN_GIT_REPO}#workspace=${workspace}&commit=${commitHash}`;
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

function updatePackageJson(
  packageJsonRaw: string,
  ref: string,
  mainRepoCommitHash?: string,
): {
  next: string;
  changedPackages: string[];
} {
  const packageJson = JSON.parse(packageJsonRaw) as {
    resolutions?: Record<string, string>;
  };

  packageJson.resolutions ??= {};
  const changedPackages: string[] = [];
  const pinnedNpmVersion = ref === 'main' || isCommitHash(ref) ? undefined : toNpmVersion(ref);

  for (const runtimePackage of RUNTIME_PACKAGES) {
    let nextValue: string;
    if (ref === 'main') {
      if (!mainRepoCommitHash) {
        throw new Error('Missing resolved main repo commit hash');
      }
      nextValue = toGitWorkspaceResolution(runtimePackage, mainRepoCommitHash);
    } else if (isCommitHash(ref)) {
      nextValue = toGitWorkspaceResolution(runtimePackage, ref);
    } else {
      nextValue = pinnedNpmVersion!;
    }
    if (packageJson.resolutions[runtimePackage] !== nextValue) {
      packageJson.resolutions[runtimePackage] = nextValue;
      changedPackages.push(runtimePackage);
    }
  }

  let next = JSON.stringify(packageJson, null, 2);
  if (!next.endsWith('\n')) next += '\n';
  return { next, changedPackages };
}
