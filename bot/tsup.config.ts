import { defineConfig } from 'tsup';
import { wasmLoader } from 'esbuild-plugin-wasm';

const entry = process.env.BOT_BUILD_TARGET === 'relayer' ? ['src/relayer.ts'] : ['src/index.ts'];

export default defineConfig({
  entry,
  dts: false,
  format: 'esm',
  target: 'esnext',
  clean: true,
  outDir: '../server/bot/src',
  platform: 'node',
  removeNodeProtocol: false,
  external: ['node:sqlite'],
  sourcemap: true,
  shims: false,
  splitting: false,
  treeshake: true,
  noExternal: [/.*/],
  esbuildOptions(o) {
    o.banner ??= {};
    o.banner.js = 'import { createRequire } from "module"; const require = createRequire(import.meta.url);';
  },
  esbuildPlugins: [
    wasmLoader({
      mode: 'deferred',
    }),
  ],
});
