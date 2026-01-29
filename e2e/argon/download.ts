import { ARGON_DOCKER_COMPOSE } from './index';
import Fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

if (
  process.argv[2] === 'force' ||
  !(await Fs.stat(ARGON_DOCKER_COMPOSE)
    .then(() => true)
    .catch(() => false))
) {
  console.log('Downloading docker-compose.yml for argon dev-docker network');
  const configResponse = await fetch(
    `https://raw.githubusercontent.com/argonprotocol/mainchain/refs/heads/main/docker-compose.yml`,
  );
  if (!configResponse.ok) throw new Error(`Failed to fetch docker-compose.yml: ${configResponse.statusText}`);
  await Fs.writeFile(ARGON_DOCKER_COMPOSE, await configResponse.text(), 'utf-8');
}
if (
  !(await Fs.stat('/tmp/oracle/data/US_CPI_State.json')
    .then(() => true)
    .catch(() => false))
) {
  await Fs.mkdir(`/tmp/oracle/data`, { recursive: true });
  await Fs.copyFile(`${__dirname}/oracle/oracle_state.json`, '/tmp/oracle/data/US_CPI_State.json');
}
