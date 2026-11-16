import { defineConfig } from 'tsup';
import { wasmLoader } from 'esbuild-plugin-wasm';

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  dts: true,
  format: 'esm',
  target: 'esnext',
  clean: true,
  outDir: './lib',
  platform: 'node',
  sourcemap: true,
  shims: false,
  splitting: false,
  treeshake: true,
  skipNodeModulesBundle: true,
  noExternal: [
    /@argonprotocol\/apps-core/,
    '@argonprotocol/runtime-client',
    // Uniswap's ESM exports and contract JSON imports require bundler resolution.
    /^@uniswap\//,
  ],
  esbuildPlugins: [
    wasmLoader({
      mode: 'deferred',
    }),
  ],
});
