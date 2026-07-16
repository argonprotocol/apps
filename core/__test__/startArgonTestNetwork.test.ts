import Path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestSessionDataDir } from './startArgonTestNetwork.ts';

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
