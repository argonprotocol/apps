import './polyfills.ts';
import './configureFetch.ts';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { MotionGlobalConfig } from 'motion-v';
import './lib/LogForwarding.ts';
import AppRoot from './AppRoot.vue';
import './main.css';
import { IS_TREASURY_APP } from './lib/Env.ts';
import { getVersion } from '@tauri-apps/api/app';

window.addEventListener('unhandledrejection', error => {
  console.error('Unhandled promise rejection:', error.reason);
});

window.addEventListener('error', error => {
  const file = error.filename ?? '<unknown>';
  const line = error.lineno ?? '?';
  const col = error.colno ?? '?';

  console.error(`[${file}:${line}:${col}] Unhandled error: ${error.message}`, error.error);
});

const isE2E = __ARGON_DRIVER_WS__.trim().length > 0;
const isE2EHeadless = isE2E && __ARGON_E2E_HEADLESS__;
const screenshotMode = __ARGON_E2E_SCREENSHOT_MODE__.trim().toLowerCase();
const isE2EScreenshotCaptureEnabled =
  isE2E && screenshotMode.length > 0 && !['0', 'false', 'off', 'none'].includes(screenshotMode);

if (isE2EHeadless || isE2EScreenshotCaptureEnabled) {
  // Global animation kill-switch for deterministic automated runs.
  MotionGlobalConfig.skipAnimations = true;
  MotionGlobalConfig.instantAnimations = true;
}

if (isE2EHeadless || isE2EScreenshotCaptureEnabled) {
  document.documentElement.dataset.e2eNoMotion = '1';
}

const appName = IS_TREASURY_APP ? 'Treasury' : 'Operations';

console.log(`[Bootstrap] Creating Argon ${appName} Vue app`);
const app = createApp(AppRoot);
app.config.errorHandler = (error, instance, info) => {
  console.error(`[Vue] ${info}`, {
    component: instance?.$options.name ?? '<anonymous>',
    error,
  });
};
app.use(createPinia());

console.log('[Bootstrap] Mounting Vue app to #app');
try {
  app.mount('#app');
  console.log('[Bootstrap] Vue app mounted to #app');
} catch (error) {
  console.error('[Bootstrap] Vue app mount failed', error);
  throw error;
}

void getVersion().then(version => {
  console.log(`Starting Argon ${appName} App v${version}`);
});

if (isE2E) {
  console.info('[E2E] Loading driver client module');
  void import('./e2e/init')
    .then(({ initE2EClient }) => {
      console.info('[E2E] Driver client module loaded');
      initE2EClient();
    })
    .catch(error => {
      console.error('[E2E] Failed to initialize driver client', error);
    });
}
