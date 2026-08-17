import { ref } from 'vue';
import { fn } from 'storybook/test';

type OsModule = typeof import('../os.ts');

export const appWindow = ref(null) as OsModule['appWindow'];
export const isWindowMaximized = ref(false);
export const isWindowFullscreen = ref(false);
export const platformType = 'macos' satisfies OsModule['platformType'];
export const platformName = 'MacOS' satisfies OsModule['platformName'];
export const platformVersion = 'storybook' satisfies OsModule['platformVersion'];

export const minimizeWindow: OsModule['minimizeWindow'] = fn(async () => undefined);
export const maximizeWindow: OsModule['maximizeWindow'] = fn(async () => undefined);
export const fullscreenWindow: OsModule['fullscreenWindow'] = fn(async () => undefined);
export const closeWindow: OsModule['closeWindow'] = fn(async () => undefined);
