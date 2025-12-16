import { defineConfig } from 'tsup';
import { wasmLoader } from 'esbuild-plugin-wasm';

export default defineConfig({
  entry: ['src/index.ts'],
  dts: false,
  format: 'esm',
  target: 'node24',
  clean: true,
  outDir: 'lib',
  platform: 'node',
  sourcemap: true,
  treeshake: true,
  shims: false,
  splitting: false,
  removeNodeProtocol: false,
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
