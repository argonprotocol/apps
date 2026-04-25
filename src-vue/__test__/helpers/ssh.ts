import { vi } from 'vitest';

export const sshMockFn = () => {
  return {
    SSH: {
      getOrCreateConnection: () =>
        Promise.resolve({
          runCommandWithTimeout: vi.fn((command: string, timeout: number) => {
            console.log('SSH.runCommandWithTimeout', command, timeout);
            if (command.includes('docker compose port nginx 443')) {
              return Promise.resolve(['0.0.0.0:3443', 0]);
            }
            return Promise.resolve(['', 0]);
          }),
          uploadFileWithTimeout: vi.fn(),
        }),
      tryConnection: vi.fn(),
      closeConnection: vi.fn(),
      ensureConnection: vi.fn(),
      runCommand: vi.fn((command: string) => {
        console.log('SSH.runCommand', command);
        return ['', 0];
      }),
      runHttpGet: vi.fn(),
      uploadFile: vi.fn(),
      uploadDirectory: vi.fn(),
    },
  };
};
