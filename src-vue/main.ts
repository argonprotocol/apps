import { createApp } from 'vue';
import { createPinia } from 'pinia';
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

const App = IS_CAPITAL_APP ? CapitalApp : OperationsApp;
const app = createApp(App);
app.use(createPinia());
app.mount('#app');
void getVersion().then(version => {
  console.log(`Starting Argon ${IS_CAPITAL_APP ? 'Capital' : 'Operations'} App v${version}`);
});
