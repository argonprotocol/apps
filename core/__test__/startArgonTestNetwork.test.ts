import Path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestSessionDataDir, resolveTestSessionIdentity } from './startArgonTestNetwork.ts';

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
