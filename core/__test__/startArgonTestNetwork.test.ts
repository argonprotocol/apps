import Path from 'node:path';
import { describe, expect, it } from 'vitest';
// prettier-ignore
import { resolveTestSessionCommandEnv, resolveTestSessionDataDir, resolveTestSessionIdentity } from './startArgonTestNetwork.ts';

describe('resolveTestSessionDataDir', () => {
  it('isolates each driver session beneath the temporary root', () => {
    const rootDir = Path.resolve('/ci-temp');

    const firstSessionDir = resolveTestSessionDataDir({
      rootDir,
      sessionId: 'driver-session-one',
    });
    const secondSessionDir = resolveTestSessionDataDir({
      rootDir,
      sessionId: 'driver-session-two',
    });

    expect(firstSessionDir).toBe(Path.join(rootDir, 'argon-e2e', 'driver-session-one'));
    expect(secondSessionDir).toBe(Path.join(rootDir, 'argon-e2e', 'driver-session-two'));
    expect(firstSessionDir).not.toBe(secondSessionDir);
  });
});

describe('resolveTestSessionIdentity', () => {
  it('gives independent driver sessions separate app profiles and network projects', () => {
    const options = { sessionName: 'dev-docker-onboarding-spec:1421', networkName: 'dev-docker' };
    const first = resolveTestSessionIdentity({ ...options, sessionId: 'driver-one' });
    const second = resolveTestSessionIdentity({ ...options, sessionId: 'driver-two' });

    expect(first).toEqual({
      composeNetwork: 'dev-docker',
      sessionName: 'onboarding-spec-driver-one',
      composeProjectName: 'dev-docker-onboarding-spec-driver-one',
      appInstanceName: 'onboarding-spec-driver-one',
      appInstancePort: '1421',
    });
    expect(second.sessionName).toBe('onboarding-spec-driver-two');
    expect(second.appInstanceName).toBe('onboarding-spec-driver-two');
    expect(second.composeProjectName).toBe('dev-docker-onboarding-spec-driver-two');
  });

  it('keeps the same profile across restarts even when the app port changes', () => {
    const options = {
      sessionName: 'onboarding-spec',
      sessionId: 'driver-one',
      baseEnv: { ARGON_NETWORK_NAME: 'dev-docker', ARGON_APP_INSTANCE: 'ambient:9999' },
    };
    const first = resolveTestSessionCommandEnv({ ...options, appPort: 1421 });
    const restarted = resolveTestSessionCommandEnv({ ...options, appPort: 1422 });

    expect(first.appEnv).toMatchObject({
      ARGON_APP_INSTANCE: 'onboarding-spec-driver-one:1421',
      COMPOSE_PROJECT_NAME: 'dev-docker-onboarding-spec-driver-one',
    });
    expect(restarted.appEnv).toMatchObject({
      ARGON_APP_INSTANCE: 'onboarding-spec-driver-one:1422',
      COMPOSE_PROJECT_NAME: 'dev-docker-onboarding-spec-driver-one',
    });
  });

  it('keeps a named test session isolated from the ambient app instance', () => {
    const identity = resolveTestSessionIdentity({
      sessionName: 'onboarding-spec',
      processEnv: {
        ARGON_APP_INSTANCE: 'app2:1421',
        ARGON_NETWORK_NAME: 'dev-docker',
      },
    });

    expect(identity).toEqual({
      composeNetwork: 'dev-docker',
      sessionName: 'onboarding-spec',
      composeProjectName: 'dev-docker-onboarding-spec',
      appInstanceName: 'onboarding-spec',
      appInstancePort: '',
    });
  });
});
