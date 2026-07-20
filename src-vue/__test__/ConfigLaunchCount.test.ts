import './helpers/mocks.ts';
import { describe, expect, it, vi } from 'vitest';
import { recordPostWelcomeLaunch, type Config } from '../stores/config.ts';

describe('recordPostWelcomeLaunch', () => {
  it('does not count launches while the welcome overlay is active', async () => {
    const save = vi.fn();
    const config = {
      showWelcomeOverlay: true,
      postWelcomeLaunchCount: 0,
      save,
    } as unknown as Config;

    await recordPostWelcomeLaunch(config);

    expect(config.postWelcomeLaunchCount).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('counts and saves launches after the welcome overlay is dismissed', async () => {
    const save = vi.fn();
    const config = {
      showWelcomeOverlay: false,
      postWelcomeLaunchCount: 2,
      save,
    } as unknown as Config;

    await recordPostWelcomeLaunch(config);

    expect(config.postWelcomeLaunchCount).toBe(3);
    expect(save).toHaveBeenCalledOnce();
  });
});
