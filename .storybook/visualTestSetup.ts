import { afterEach, beforeEach, vi } from 'vitest';
import { server } from 'vitest/browser';

beforeEach(({ task }) => {
  if (task.file.filepath.endsWith('/ConnectorChannel.stories.ts')) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-16T14:00:00.000Z'));
  }
});

afterEach(async ({ task }) => {
  const isConnectorChannelStory = task.file.filepath.endsWith('/ConnectorChannel.stories.ts');
  try {
    if (task.result?.state !== 'pass') return;

    const storyFile =
      task.file.filepath
        .split('/')
        .at(-1)
        ?.replace(/\.stories\.[^.]+$/, '') ?? 'story';
    const name = `${storyFile}--${task.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await server.commands.captureStory(name);
  } finally {
    if (isConnectorChannelStory) vi.useRealTimers();
  }
});

declare module 'vitest/browser' {
  interface BrowserCommands {
    captureStory: (name: string) => Promise<void>;
  }
}
