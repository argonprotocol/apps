import { afterAll, afterEach, beforeEach, expect, vi } from 'vitest';
import { server } from 'vitest/browser';

const storyDate = new Date('2026-08-16T14:00:00.000Z');
const freezeDate = /\/(ConnectorChannel|MarketStabilizers|StabilizerBuyDetailOverlay)\.stories\.ts$/.test(
  expect.getState().testPath ?? '',
);
// Freeze dates before these story modules create fixtures; scheduled browser timers stay real.
if (freezeDate) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(storyDate);
}

beforeEach(() => {
  if (freezeDate) vi.setSystemTime(storyDate);
});

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

afterAll(() => {
  if (freezeDate) vi.useRealTimers();
});

declare module 'vitest/browser' {
  interface BrowserCommands {
    captureStory: (name: string) => Promise<void>;
  }
}
