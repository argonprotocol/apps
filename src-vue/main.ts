import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './main.css';

const orig = console.log;
console.log = (...args) => {
  const ts = new Date();
  const strValue = `${ts.getHours().toString().padStart(2, '0')}:${ts.getMinutes().toString().padStart(2, '0')}:${ts
    .getSeconds()
    .toString()
    .padStart(2, '0')}.${ts.getMilliseconds().toString().padStart(3, '0')}`;
  orig(`[${strValue}]`, ...args);
};

const app = createApp(App);

app.use(createPinia());
app.mount('#app');
