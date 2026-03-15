import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { Operation } from './index.ts';

interface IAppFlowContext {
  flow: IE2EFlowRuntime;
}

type ICaptureScreenshotUiState = {
  screenshotName: string;
  screenshotOutputPath: string | null;
};

interface ICaptureScreenshotState extends IE2EOperationInspectState<Record<string, never>, ICaptureScreenshotUiState> {
  screenshotName: string;
  screenshotOutputPath: string | null;
}

export default new Operation<IAppFlowContext, ICaptureScreenshotState>(import.meta, {
  async inspect({ flow }) {
    const screenshotName = normalizeScreenshotName(flow.input.screenshotName) ?? 'manual-capture';
    const screenshotOutputPath = normalizeOptionalString(flow.input.screenshotOutputPath);
    const lastScreenshotName = flow.getData<string>('manualScreenshotName');
    const lastScreenshotOutputPath = flow.getData<string | null>('manualScreenshotOutputPath') ?? null;
    const screenshotAlreadyCaptured =
      lastScreenshotName === screenshotName && lastScreenshotOutputPath === screenshotOutputPath;
    return {
      chainState: {},
      uiState: {
        screenshotName,
        screenshotOutputPath,
      },
      state: screenshotAlreadyCaptured ? 'complete' : 'runnable',
      screenshotName,
      screenshotOutputPath,
      blockers: [],
    };
  },

  async run({ flow }, state) {
    const screenshotPath = await flow.captureScreenshot({
      name: state.screenshotName,
      outputPath: state.screenshotOutputPath ?? undefined,
    });
    flow.setData('manualScreenshotName', state.screenshotName);
    flow.setData('manualScreenshotOutputPath', state.screenshotOutputPath);
    flow.setData('manualScreenshotPath', screenshotPath);
    console.info(`[E2E] Captured manual screenshot: ${screenshotPath}`);
  },

  inputs: [
    {
      key: 'screenshotName',
      description: 'Optional filename label for manual screenshot capture.',
    },
    {
      key: 'screenshotOutputPath',
      description: 'Optional absolute output path for manual screenshot capture.',
    },
  ],
});

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeScreenshotName(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  return normalized.replace(/[^A-Za-z0-9._-]+/g, '-');
}
