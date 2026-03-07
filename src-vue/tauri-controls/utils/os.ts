import { ref } from 'vue';
import type { window } from '@tauri-apps/api';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { platform as getPlatform, version as getVersion } from '@tauri-apps/plugin-os';
import { checkInstallerIfCloseAllowed, getInstaller } from '../../stores/installer.ts';

// Throttle utility function
function throttle<T extends (...args: any[]) => any>(func: T, limit: number): (...args: Parameters<T>) => void {
  let inThrottle: boolean = false;

  return function (this: any, ...args: Parameters<T>): void {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
}

export const appWindow = ref<window.Window | null>(null);
export const isWindowMaximized = ref(false);
export const isWindowFullscreen = ref(false);
export const platformType = getPlatformType();
export const platformName = getPlatformName();
export const platformVersion = getVersion();

appWindow.value = getCurrentWindow();
void appWindow.value.onResized(
  throttle(async () => {
    const isFullscreen = await getCurrentWindow().isFullscreen();
    isWindowFullscreen.value = isFullscreen;

    if (platformType !== 'macos') {
      const isMaximized = await appWindow.value?.isMaximized();
      if (isMaximized !== undefined) {
        isWindowMaximized.value = isMaximized;
      }
    }
  }, 100),
);

export async function minimizeWindow() {
  await appWindow.value?.minimize();
}

export async function maximizeWindow() {
  await appWindow.value?.toggleMaximize();
}

export async function fullscreenWindow() {
  if (appWindow) {
    const fullscreen = await appWindow.value?.isFullscreen();
    await appWindow.value?.setFullscreen(!fullscreen);
  }
}

export async function closeWindow() {
  const isCloseAllowed = await checkInstallerIfCloseAllowed();
  if (isCloseAllowed) {
    await appWindow.value?.close();
  }
}

function getPlatformType() {
  switch (getPlatform()) {
    case 'macos':
      return 'macos';
    case 'linux':
      return 'gnome';
    default:
      return 'windows';
  }
}

function getPlatformName() {
  switch (getPlatform()) {
    case 'macos':
      return 'MacOS';
    case 'linux':
      return 'Linux';
    default:
      return 'Windows';
  }
}
