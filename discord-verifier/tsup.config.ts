import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  dts: false,
  format: 'esm',
  target: 'node24',
  clean: true,
  outDir: 'dist',
  platform: 'node',
  removeNodeProtocol: false,
  external: ['node:sqlite', '@polkadot/types-codec'],
  sourcemap: true,
  splitting: false,
  treeshake: true,
  noExternal: ['@argonprotocol/runtime-client'],
});
