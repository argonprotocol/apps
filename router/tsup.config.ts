import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'server.ts',
  },
  dts: false,
  format: 'esm',
  target: 'esnext',
  clean: true,
  outDir: '../server/router/src',
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
    o.banner.js =
      'import { createRequire as __createRequire } from "module"; const require = __createRequire(import.meta.url);';
  },
});
