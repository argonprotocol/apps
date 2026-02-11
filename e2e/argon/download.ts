import Fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Path from 'node:path';
import { parseEnv } from 'node:util';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ARGON_ENV_PATH = Path.resolve(__dirname, '.env');
const ARGON_DOCKER_COMPOSE = Path.resolve(__dirname, 'docker-compose.yml');

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

  return [...new Set(refs)];
}

const argonEnvVersion = await getArgonEnvVersion();
const requestedRef = toMainchainGitRef(process.env.VERSION?.trim() || argonEnvVersion);
const candidateRefs = getCandidateMainchainRefs(requestedRef);
const shouldRefreshMainRef = ['main', 'refs/heads/main'].includes(candidateRefs[0]);
const shouldForceForPinnedRef = !shouldRefreshMainRef;
const composeExists = await Fs.stat(ARGON_DOCKER_COMPOSE)
  .then(() => true)
  .catch(() => false);

if (process.argv[2] === 'force' || shouldRefreshMainRef || shouldForceForPinnedRef || !composeExists) {
  let downloadedFromRef: string | null = null;
  const failures: string[] = [];

  for (const ref of candidateRefs) {
    console.log(`Downloading docker-compose.yml for argon dev-docker network (${ref})`);
    const response = await fetch(
      `https://raw.githubusercontent.com/argonprotocol/mainchain/${ref}/docker-compose.yml`,
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
}
if (
  !(await Fs.stat('/tmp/oracle/data/US_CPI_State.json')
    .then(() => true)
    .catch(() => false))
) {
  await Fs.mkdir(`/tmp/oracle/data`, { recursive: true });
  await Fs.copyFile(`${__dirname}/oracle/oracle_state.json`, '/tmp/oracle/data/US_CPI_State.json');
}
