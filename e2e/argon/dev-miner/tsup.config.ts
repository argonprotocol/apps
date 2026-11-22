import Path from 'node:path';
import { defineConfig } from 'tsup';
import { wasmLoader } from 'esbuild-plugin-wasm';

export default defineConfig({
  entry: { index: Path.join(import.meta.dirname, 'devMiner.ts') },
  outDir: Path.join(import.meta.dirname, 'dist'),
  outExtension: () => ({ js: '.mjs' }),
  format: 'esm',
  target: 'node24',
  platform: 'node',
  clean: true,
  splitting: false,
  treeshake: true,
  noExternal: [/.*/],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  esbuildPlugins: [wasmLoader({ mode: 'deferred' })],
});
