import type { StorybookConfig } from '@storybook/vue3-vite';

const config: StorybookConfig = {
  addons: ['@storybook/addon-vitest'],
  framework: '@storybook/vue3-vite',
  stories: ['./stories/**/*.stories.ts'],
  viteFinal: viteConfig => {
    viteConfig.build ??= {};
    // Lightning CSS does not understand the Tailwind directives retained in component-scoped styles.
    viteConfig.build.cssMinify = 'esbuild';
    viteConfig.build.target = 'esnext';

    viteConfig.plugins ??= [];
    viteConfig.plugins.push({
      name: 'storybook-dependency-readiness',
      enforce: 'pre',
      transform(code, id) {
        const moduleId = id.split('?')[0];

        if (moduleId.endsWith('/@argonprotocol/mainchain/browser/index.js')) {
          // Stories do not sign chain operations. Keeping this initialization non-blocking prevents
          // Rolldown from propagating top-level await through circular UI modules during static builds.
          return code.replace('await cryptoWaitReady();', 'void cryptoWaitReady();');
        }

        if (!moduleId.endsWith('/@argonprotocol/bitcoin/browser/index.js')) return;

        // The browser package embeds its WASM bytes, so Storybook can instantiate them synchronously
        // and avoid propagating top-level await through every Bitcoin UI module in the static build.
        return code.replace(
          'var { instance, module: module$1 } = await loadWasm(bitcoin_bindings_bg_default, imports);',
          'var module$1 = new WebAssembly.Module(bitcoin_bindings_bg_default);\n' +
            'var instance = new WebAssembly.Instance(module$1, imports);',
        );
      },
    });

    return viteConfig;
  },
};

export default config;
