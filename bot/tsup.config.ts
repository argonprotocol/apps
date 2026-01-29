import { defineConfig } from 'tsup';
import { wasmLoader } from 'esbuild-plugin-wasm';

export default defineConfig({
  entry: ['src/index.ts'],
  dts: false,
  format: 'esm',
  target: 'esnext',
  clean: true,
  outDir: '../server/bot/src',
  platform: 'node',
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
