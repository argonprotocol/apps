import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import svgLoader from 'vite-svg-loader';
import wasm from 'vite-plugin-wasm';
import vitePluginTopLevelAwait from 'vite-plugin-top-level-await';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { NodeTypes } from '@vue/compiler-core';

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const require = createRequire(__filename);
const ALLOWED_DRIVER_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const GENERIC_COMPONENT_NAMES = new Set([
  'App',
  'Dashboard',
  'Dialog',
  'Index',
  'Layout',
  'Modal',
  'Overlay',
  'Page',
  'Panel',
  'Screen',
  'View',
]);

const defaultOperationsPortString = '1420';
const defaultCapitalPortString = '1430';

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(part => (part ? part.charAt(0).toUpperCase() + part.slice(1) : ''))
    .join('');
}

function deriveComponentTestId(filename: string, selfName: string | null): string {
  const normalizedFilename = filename.replace(/\\/g, '/');
  const pathSegments = normalizedFilename.split('/');
  const rawFileName = pathSegments[pathSegments.length - 1] ?? '';
  const rawBaseName = rawFileName.replace(/\.[^/.]+$/, '');
  const baseName = toPascalCase(rawBaseName);
  const fallback = selfName ? toPascalCase(selfName) : baseName || 'Component';
  if (!baseName) return fallback;

  if (!GENERIC_COMPONENT_NAMES.has(baseName)) {
    return baseName;
  }

  const parentSegment = pathSegments[pathSegments.length - 2] ?? '';
  const parentName = toPascalCase(parentSegment);
  if (!parentName) {
    return fallback;
  }
  const parentPrefix = parentName.replace(/(Dialog|Layout|Overlay|Page|Panel|Screen|View)$/, '');
  return `${parentPrefix || parentName}${baseName}`;
}

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

function getValidatedDriverWs(rawDriverWs: string | undefined): string | null {
  const trimmed = rawDriverWs?.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error: any) {
    throw new Error(`⚠️ ARGON_DRIVER_WS is not a valid URL (${error.message})`);
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`⚠️ ARGON_DRIVER_WS must use ws:// or wss://`);
  }
  if (!ALLOWED_DRIVER_HOSTS.has(url.hostname)) {
    throw new Error(`⚠️ ARGON_DRIVER_WS host must be localhost, 127.0.0.1, or ::1`);
  }

  const session = url.searchParams.get('session')?.trim();
  if (!session) {
    throw new Error(`⚠️ ARGON_DRIVER_WS must include query param 'session'`);
  }

  return url.toString();
}

// https://vitejs.dev/config/
export default defineConfig(async ({ mode }) => {
  mode = process.env.NODE_ENV || 'development';

  const envFile = loadEnv(mode, process.cwd(), '');
  const host = envFile.TAURI_DEV_HOST;

  const instance = (process.env.ARGON_APP_INSTANCE || '').split(':');
  const app = process.env.ARGON_APP || 'operations';
  const defaultPort = app.startsWith('i') ? defaultCapitalPortString : defaultOperationsPortString;

  const instancePort = parseInt(instance[1] || defaultPort, 10);

  if (envFile.ARGON_APP_INSTANCE && envFile.ARGON_APP_INSTANCE !== process.env.ARGON_APP_INSTANCE) {
    throw new Error(`⚠️ ARGON_APP_INSTANCE must be set on the command line not from inside a .env file`);
  }

  // Check if the port is available
  const portAvailable = await isPortAvailable(instancePort);
  if (!portAvailable) {
    throw new Error(`⚠️ Port ${instancePort} is already in use. The server may fail to start.`);
  }

  const driverWs = getValidatedDriverWs(process.env.ARGON_DRIVER_WS);

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
                return (node, ctx) => {
                  if (node.type !== NodeTypes.ELEMENT) return;
                  if (!ctx.filename) return;

                  if (node.props.some(p => p.name === 'data-testid')) return;

                  const pushTestId = (value: string) => {
                    node.props.push({
                      type: NodeTypes.ATTRIBUTE,
                      name: 'data-testid',
                      nameLoc: node.loc,
                      value: {
                        type: NodeTypes.TEXT,
                        content: value,
                        loc: node.loc,
                      },
                      loc: node.loc,
                    });
                  };

                  const primaryRootElement = ctx.root.children.find(child => child.type === NodeTypes.ELEMENT);
                  const isPrimaryRootElement = ctx.parent?.type === NodeTypes.ROOT && primaryRootElement === node;
                  if (isPrimaryRootElement) {
                    pushTestId(deriveComponentTestId(ctx.filename, ctx.selfName));
                    return;
                  }

                  let testId = ctx.selfName;
                  // Look for click handlers
                  const clickDir = node.props.find(
                    p =>
                      p.type === NodeTypes.DIRECTIVE &&
                      p.name === 'on' &&
                      p.arg?.type === NodeTypes.SIMPLE_EXPRESSION &&
                      p.arg.content === 'click',
                  );
                  if (!clickDir || clickDir.type !== NodeTypes.DIRECTIVE || !clickDir.exp) return;

                  let fnName = clickDir.exp.type === NodeTypes.SIMPLE_EXPRESSION ? clickDir.exp.content : '';
                  if (!fnName.includes('(') && !fnName.includes('=')) fnName += '()';
                  testId = `${testId}.${fnName}`;
                  pushTestId(testId);
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
        },
      },
      sourcemap: true,
    },
    // Define environment variables for the frontend
    define: {
      'process.env': {},
      __ARGON_DRIVER_WS__: JSON.stringify(driverWs ?? ''),
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
