import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './lib/LogForwarding.ts';
import App from './App.vue';
import './main.css';

window.addEventListener('unhandledrejection', error => {
  console.error('Unhandled promise rejection:', error.reason);
});

window.addEventListener('error', error => {
  const file = error.filename ?? '<unknown>';
  const line = error.lineno ?? '?';
  const col = error.colno ?? '?';

  console.error(`[${file}:${line}:${col}] Unhandled error: ${error.message}`, error.error);
});

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => {
  console.error(`Vue error: ${info}`, err);
};
app.use(createPinia());
app.mount('#app');
