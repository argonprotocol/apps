import Fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Path from 'node:path';
import { parseEnv } from 'node:util';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ARGON_ENV_PATH = Path.resolve(__dirname, '.env');
const ARGON_DOCKER_COMPOSE = Path.resolve(__dirname, 'docker-compose.yml');
const ARGON_DOCKER_COMPOSE_VERSION_PATH = Path.resolve(__dirname, '.docker-compose.version');

interface ComposeVersionState {
  requestedRef: string;
  downloadedFromRef: string;
  updatedAt: string;
}

async function getArgonEnvVersion(): Promise<string | undefined> {
  const envRaw = await Fs.readFile(ARGON_ENV_PATH, 'utf-8').catch(() => '');
  if (!envRaw) return undefined;
  const parsed = parseEnv(envRaw);
  const version = parsed.VERSION?.trim();
  return version || undefined;
}

function isUsableMainchainRef(value: string | undefined): value is string {
  if (!value) return false;
  const normalized = value.trim();
  if (!normalized) return false;
  if (normalized === 'dev') return false;
  if (normalized === 'latest') return false;
  return true;
}

function toMainchainGitRef(value: string | undefined): string | undefined {
  if (!value) return value;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (/^sha-[a-f0-9]{7,40}$/i.test(normalized)) {
    return normalized.slice(4);
  }
  return normalized;
}

function getCandidateMainchainRefs(value: string | undefined): string[] {
  if (!isUsableMainchainRef(value)) return ['main'];

  const normalized = value.trim();
  const refs = [normalized];
  const semver = /^\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i;
  const vSemver = /^v\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i;

  if (semver.test(normalized)) {
    refs.push(`v${normalized}`);
  } else if (vSemver.test(normalized)) {
    refs.push(normalized.slice(1));
  }

  const releaseTagVariant = toReleaseTagVariant(normalized);
  if (releaseTagVariant) {
    refs.push(releaseTagVariant);
    if (releaseTagVariant.startsWith('v')) {
      refs.push(releaseTagVariant.slice(1));
    } else {
      refs.push(`v${releaseTagVariant}`);
    }
  }

  return [...new Set(refs)];
}

function toReleaseTagVariant(value: string): string | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/i.exec(value.trim());
  if (!match) return undefined;

  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return undefined;
  }

  // Runtime package versions may encode repo release tags as:
  // npm 1.40.0 -> repo tag v1.4.0, npm 1.41.0 -> repo tag v1.4.1, etc.
  if (patch === 0 && minor >= 10) {
    const releaseMinor = Math.floor(minor / 10);
    const releasePatch = minor % 10;
    return `v${major}.${releaseMinor}.${releasePatch}`;
  }

  return undefined;
}

async function readComposeVersionState(): Promise<ComposeVersionState | undefined> {
  const raw = await Fs.readFile(ARGON_DOCKER_COMPOSE_VERSION_PATH, 'utf-8').catch(() => '');
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<ComposeVersionState>;
    if (!parsed.requestedRef?.trim() || !parsed.downloadedFromRef?.trim()) return undefined;
    return {
      requestedRef: parsed.requestedRef.trim(),
      downloadedFromRef: parsed.downloadedFromRef.trim(),
      updatedAt: parsed.updatedAt?.trim() || '',
    };
  } catch {
    return undefined;
  }
}

async function writeComposeVersionState(state: ComposeVersionState): Promise<void> {
  await Fs.writeFile(ARGON_DOCKER_COMPOSE_VERSION_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

const argonEnvVersion = await getArgonEnvVersion();
const requestedRef = toMainchainGitRef(process.env.VERSION?.trim() || argonEnvVersion);
const candidateRefs = getCandidateMainchainRefs(requestedRef);
const shouldRefreshMainRef = ['main', 'refs/heads/main'].includes(candidateRefs[0]);
const composeExists = await Fs.stat(ARGON_DOCKER_COMPOSE)
  .then(() => true)
  .catch(() => false);
const composeVersionState = await readComposeVersionState();
const shouldUsePinnedComposeCache =
  !shouldRefreshMainRef &&
  composeExists &&
  composeVersionState?.requestedRef === candidateRefs[0] &&
  Boolean(composeVersionState && candidateRefs.includes(composeVersionState.downloadedFromRef));

if (process.argv[2] === 'force' || shouldRefreshMainRef || !composeExists || !shouldUsePinnedComposeCache) {
  let downloadedFromRef: string | null = null;
  const failures: string[] = [];

  for (const ref of candidateRefs) {
    console.log(`Downloading docker-compose.yml for argon dev-docker network (${ref})`);
    const response = await fetch(
      `https://raw.githubusercontent.com/argonprotocol/mainchain/${ref}/dev.docker-compose.yml`,
    );
    if (!response.ok) {
      failures.push(`${ref}: ${response.status} ${response.statusText}`);
      continue;
    }
    await Fs.writeFile(ARGON_DOCKER_COMPOSE, await response.text(), 'utf-8');
    downloadedFromRef = ref;
    break;
  }

  if (!downloadedFromRef) {
    throw new Error(`Failed to fetch docker-compose.yml for refs: ${failures.join(', ')}`);
  }
  await writeComposeVersionState({
    requestedRef: candidateRefs[0],
    downloadedFromRef,
    updatedAt: new Date().toISOString(),
  });
} else {
  console.log(
    `Using cached docker-compose.yml for argon dev-docker network (${composeVersionState?.requestedRef ?? candidateRefs[0]})`,
  );
}
for (const oracleStatePath of getOracleStatePaths()) {
  if (
    !(await Fs.stat(oracleStatePath)
      .then(() => true)
      .catch(() => false))
  ) {
    await Fs.mkdir(Path.dirname(oracleStatePath), { recursive: true });
    await Fs.copyFile(`${__dirname}/oracle/oracle_state.json`, oracleStatePath);
  }
}

function getOracleStatePaths(): string[] {
  const paths = [Path.resolve('/tmp/oracle/data/US_CPI_State.json')];
  if (process.platform === 'win32') {
    const systemDrive = process.env.SystemDrive?.trim() || 'C:';
    paths.push(Path.join(systemDrive, 'tmp', 'oracle', 'data', 'US_CPI_State.json'));
  }

  return [...new Set(paths)];
}
