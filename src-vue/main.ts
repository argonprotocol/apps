import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { MotionGlobalConfig } from 'motion-v';
import './lib/LogForwarding.ts';
import CapitalApp from './CapitalApp.vue';
import OperationsApp from './OperationsApp.vue';
import './main.css';
import { IS_CAPITAL_APP } from './lib/Env.ts';
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
if (isE2EHeadless) {
  // Global animation kill-switch for automated runs.
  // Keep headed E2E visually faithful while making headless deterministic.
  MotionGlobalConfig.skipAnimations = true;
  MotionGlobalConfig.instantAnimations = true;
  document.documentElement.dataset.e2eNoMotion = '1';
}

const App = IS_CAPITAL_APP ? CapitalApp : OperationsApp;
const app = createApp(App);
app.use(createPinia());
app.mount('#app');
void getVersion().then(version => {
  console.log(`Starting Argon ${IS_CAPITAL_APP ? 'Capital' : 'Operations'} App v${version}`);
});

if (isE2E) {
  void import('./e2e/init')
    .then(({ initE2EClient }) => initE2EClient())
    .catch(error => {
      console.error('[E2E] Failed to initialize driver client', error);
    });
}
