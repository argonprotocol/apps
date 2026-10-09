import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import Path from 'node:path';

export async function acquireIntegrationNetworkAccess(
  mode: 'shared' | 'exclusive',
  directory: string,
): Promise<() => Promise<void>> {
  const readersDirectory = Path.join(directory, 'network-readers');
  const unavailablePath = Path.join(directory, 'network-unavailable');
  await mkdir(readersDirectory, { recursive: true });
  const deadline = Date.now() + 15 * 60_000;

  if (mode === 'exclusive') {
    const releaseExclusive = await acquireIntegrationLock('network-exclusive', directory);
    try {
      // Drain a reader that was joining when the exclusive request arrived.
      const releaseAdmission = await acquireIntegrationLock('network-access', directory);
      await releaseAdmission();
      if (existsSync(unavailablePath)) {
        throw new Error(
          'The integration network could not resume after an exclusive test. Stop and restart the test network.',
        );
      }
      while ((await readdir(readersDirectory)).length) {
        if (Date.now() >= deadline) {
          throw new Error(
            'Other integration files did not release the network within 15 minutes. If a worker crashed, stop and restart the test network.',
          );
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return releaseExclusive;
    } catch (error) {
      await releaseExclusive();
      throw error;
    }
  }

  const readerPath = Path.join(readersDirectory, randomUUID());
  for (;;) {
    const releaseAdmission = await acquireIntegrationLock('network-access', directory);
    try {
      if (existsSync(unavailablePath)) {
        throw new Error(
          'The integration network could not resume after an exclusive test. Stop and restart the test network.',
        );
      }
      if (!existsSync(Path.join(directory, 'network-exclusive'))) {
        await mkdir(readerPath);
        return async () => {
          await rm(readerPath, { recursive: true });
        };
      }
    } finally {
      await releaseAdmission();
    }
    if (Date.now() >= deadline) {
      throw new Error(
        'An exclusive integration test did not release the network within 15 minutes. If a worker crashed, stop and restart the test network.',
      );
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

export async function acquireIntegrationLock(
  resource:
    | 'sudo'
    | 'mining-auction'
    | 'network-start'
    | 'network-assets'
    | 'financial-history-capture'
    | 'network-access'
    | 'network-exclusive',
  directory?: string,
): Promise<() => Promise<void>> {
  if (!directory) return async () => {};
  await mkdir(directory, { recursive: true });
  const lockPath = Path.join(directory, resource);
  const timeoutMs = {
    sudo: 180_000,
    'network-access': 180_000,
    'network-exclusive': 15 * 60_000,
    'network-start': 6 * 60_000,
    'network-assets': 180_000,
    'mining-auction': 15 * 60_000,
    'financial-history-capture': 45 * 60_000,
  }[resource];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockPath);
      return async () => {
        await rm(lockPath, { recursive: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        const recovery =
          resource === 'network-assets'
            ? `If startup crashed, remove ${lockPath} once no test startup is running.`
            : 'If it crashed, stop and restart the dedicated test network.';
        throw new Error(`Integration ${resource} is locked by another run. ${recovery}`);
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}
