export interface DevDockerComposeContext {
  composeDir: string;
  composeEnv: NodeJS.ProcessEnv;
  composeProjectName?: string;
  profiles: readonly string[];
}

export const DEV_DOCKER_COMPOSE_FILES = [
  'docker-compose.yml',
  'miners.docker-compose.yml',
  'upstream-server.docker-compose.yml',
  'indexer.docker-compose.yml',
] as const;

const CHAIN_SPEC_COMPOSE_FILE = 'chainspec.docker-compose.yml';

export function getComposeArgs(context: DevDockerComposeContext): string[] {
  const useChainspec =
    context.composeEnv.E2E_USE_TEST_NETWORK?.trim() !== '1' ||
    context.composeEnv.ARGON_CHAIN?.trim() === '/chainspec.raw.json';
  const composeFiles = useChainspec ? [...DEV_DOCKER_COMPOSE_FILES, CHAIN_SPEC_COMPOSE_FILE] : DEV_DOCKER_COMPOSE_FILES;

  return [
    'compose',
    ...context.profiles.flatMap(profile => ['--profile', profile]),
    ...(context.composeProjectName ? ['--project-name', context.composeProjectName] : []),
    ...composeFiles.flatMap(file => ['-f', file]),
  ];
}
