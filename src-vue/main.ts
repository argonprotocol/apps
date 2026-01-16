import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './lib/LogForwarding.ts';
import InvestmentApp from './InvestmentApp.vue';
import OperationsApp from './OperationsApp.vue';
import './main.css';
import { IS_INVESTMENTS_APP } from './lib/Env.ts';
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

const App = IS_INVESTMENTS_APP ? InvestmentApp : OperationsApp;
const app = createApp(App);
app.use(createPinia());
app.mount('#app');
void getVersion().then(version => {
  console.log(`Starting Argon ${IS_INVESTMENTS_APP ? 'Investment' : 'Operations'} App v${version}`);
});
