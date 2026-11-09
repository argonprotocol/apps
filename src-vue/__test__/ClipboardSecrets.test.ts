import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearCopiedSecretLater } from '../lib/clipboardSecrets.ts';

let clipboardText = '';
const clipboard = {
  readText: vi.fn(async () => clipboardText),
  writeText: vi.fn(async (value: string) => {
    clipboardText = value;
  }),
};

beforeEach(() => {
  vi.useFakeTimers();
  clipboardText = '';
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { clipboard });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('clears a matching secret only after the cleanup delay', async () => {
  await clipboard.writeText('synthetic recovery secret');
  clearCopiedSecretLater('synthetic recovery secret');

  await vi.advanceTimersByTimeAsync(179_999);
  expect(clipboardText).toBe('synthetic recovery secret');
  await vi.advanceTimersByTimeAsync(1);
  expect(clipboardText).toBe('');
});

it('preserves unrelated clipboard contents copied after the secret', async () => {
  await clipboard.writeText('synthetic recovery secret');
  clearCopiedSecretLater('synthetic recovery secret');
  await clipboard.writeText('unrelated text');

  await vi.advanceTimersByTimeAsync(180_000);
  expect(clipboardText).toBe('unrelated text');
});

it('handles clipboard read failures during delayed cleanup', async () => {
  clipboard.readText.mockRejectedValueOnce(new Error('Clipboard access denied'));
  clearCopiedSecretLater('synthetic recovery secret');

  await vi.advanceTimersByTimeAsync(180_000);
  expect(clipboard.writeText).not.toHaveBeenCalled();
});

it('handles clipboard write failures during delayed cleanup', async () => {
  clipboardText = 'synthetic recovery secret';
  clipboard.writeText.mockRejectedValueOnce(new Error('Clipboard access denied'));
  clearCopiedSecretLater('synthetic recovery secret');

  await vi.advanceTimersByTimeAsync(180_000);
  expect(clipboardText).toBe('synthetic recovery secret');
});
