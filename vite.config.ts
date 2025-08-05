import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import svgLoader from 'vite-svg-loader';
import wasm from 'vite-plugin-wasm';
import vitePluginTopLevelAwait from 'vite-plugin-top-level-await';
import { createServer } from 'node:net';

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const requre = createRequire(__filename);

const defaultPortString = '1420';

// Function to check if a port is available
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    
    server.listen(port, () => {
      server.once('close', () => {
        resolve(true);
      });
      server.close();
    });
    
    server.on('error', () => {
      resolve(false);
    });
  });
}

// https://vitejs.dev/config/
export default defineConfig(async ({ mode }) => {

  const envFile = loadEnv(mode, process.cwd(), ''); 
  const host = envFile.TAURI_DEV_HOST;

  const instance = (process.env.COMMANDER_INSTANCE || '').split(':');
  const instancePort = parseInt(instance[1] || defaultPortString, 10);
  const instanceName = instance[0] || 'default';

  if (envFile.COMMANDER_INSTANCE && envFile.COMMANDER_INSTANCE !== process.env.COMMANDER_INSTANCE) {
    throw new Error(`⚠️ COMMANDER_INSTANCE must be set on the command line not from inside a .env file`);
  }

  // Check if the port is available
  const portAvailable = await isPortAvailable(instancePort);
  if (!portAvailable) {
    throw new Error(`⚠️ Port ${instancePort} is already in use. The server may fail to start.`);
  }

  return {
    resolve: {
      alias: {
        '@argonprotocol/bitcoin': requre.resolve('@argonprotocol/bitcoin/browser'),
      },
    },
    plugins: [
      wasm(),
      vitePluginTopLevelAwait(),
      vue(),
      tailwindcss(),
      svgLoader({
        svgoConfig: {
          multipass: true,
          plugins: [
            {
              name: 'preset-default',
              params: {
                overrides: {
                  removeViewBox: false,
                },
              },
            },
          ],
        },
      }),
    ],
    // Define environment variables for the frontend
    define: {
      'process.env': {},
      __ARGON_NETWORK_NAME__: JSON.stringify(envFile.ARGON_NETWORK_NAME || ''),
      __ARGON_NETWORK_URL__: JSON.stringify(envFile.ARGON_NETWORK_URL || ''),
      __COMMANDER_INSTANCE__: JSON.stringify(`${instanceName}:${instancePort}`),
    },
    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: instancePort,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: 'ws',
            host,
            port: instancePort + 1,
          }
        : undefined,
      watch: {
        // 3. tell vite to ignore watching `src-tauri`
        ignored: ['**/src-tauri/**'],
      },
    },
  };
});
