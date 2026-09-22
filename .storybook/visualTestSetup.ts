import { afterEach } from 'vitest';
import { server } from 'vitest/browser';

afterEach(async ({ task }) => {
  if (task.result?.state !== 'pass') return;

  const storyFile =
    task.file.filepath
      .split('/')
      .at(-1)
      ?.replace(/\.stories\.[^.]+$/, '') ?? 'story';
  const name = `${storyFile}--${task.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await server.commands.captureStory(name);
});

declare module 'vitest/browser' {
  interface BrowserCommands {
    captureStory: (name: string) => Promise<void>;
  }
}
