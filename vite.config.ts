import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import svgLoader from 'vite-svg-loader';
import wasm from 'vite-plugin-wasm';
import vitePluginTopLevelAwait from 'vite-plugin-top-level-await';
import { createServer } from 'node:net';
import { resolve, basename } from 'node:path';

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const require = createRequire(__filename);

const defaultPortString = '1420';

// Function to check if a port is available
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
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
  mode = process.env.NODE_ENV || 'development';

  const envFile = loadEnv(mode, process.cwd(), '');
  const host = envFile.TAURI_DEV_HOST;

  const instance = (process.env.ARGON_APP_INSTANCE || '').split(':');
  const instancePort = parseInt(instance[1] || defaultPortString, 10);

  if (envFile.ARGON_APP_INSTANCE && envFile.ARGON_APP_INSTANCE !== process.env.ARGON_APP_INSTANCE) {
    throw new Error(`⚠️ ARGON_APP_INSTANCE must be set on the command line not from inside a .env file`);
  }

  // Check if the port is available
  const portAvailable = await isPortAvailable(instancePort);
  if (!portAvailable) {
    throw new Error(`⚠️ Port ${instancePort} is already in use. The server may fail to start.`);
  }

  return {
    resolve: {
      alias: {
        '@argonprotocol/bitcoin': require.resolve('@argonprotocol/bitcoin/browser'),
      },
    },
    plugins: [
      wasm(),
      vitePluginTopLevelAwait(),
      vue({
        template: {
          compilerOptions: {
            nodeTransforms: [
              (() => {
                const templateCounter: { [name: string]: number } = {};
                return (node, ctx) => {
                  if (node.type !== 1) return;
                  if (!ctx.filename) return;

                  if (node.props.some(p => p.name === 'data-testid')) return;

                  let testId = ctx.selfName;
                  // Look for click handlers
                  const clickDir = node.props.find(
                    p =>
                      p.type === 7 && // DIRECTIVE
                      p.name === 'on' &&
                      p.arg?.type === 4 &&
                      p.arg.content === 'click',
                  );
                  if (!clickDir?.exp) return;

                  let fnName = clickDir.exp.content;
                  if (!fnName.includes('(') && !fnName.includes('=')) fnName += '()';
                  testId = `${testId}.${fnName}`;

                  node.props.push({
                    type: 6, // ATTRIBUTE
                    name: 'data-testid',
                    value: {
                      type: 2,
                      content: testId,
                      loc: node.loc,
                    },
                    loc: node.loc,
                  });
                };
              })(),
            ],
          },
        },
      }),
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
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          popup: resolve(__dirname, 'popup-youtube.html'), // 👈 add this
        },
      },
    },
    // Define environment variables for the frontend
    define: {
      'process.env': {},
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
        ignored: ['**/src-tauri/**', '**/e2e/**'],
      },
    },
  };
});
