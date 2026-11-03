import { fn } from 'storybook/test';
import type * as Startup from '../startup.ts';

export const getAppStartup = fn<typeof Startup.getAppStartup>();
export const getInstaller = fn<typeof Startup.getInstaller>();
export const getBot = fn<typeof Startup.getBot>();
export const useStartupStore = fn<typeof Startup.useStartupStore>();
export const recoverPreviousWalletHistory = fn<typeof Startup.recoverPreviousWalletHistory>();
export const checkInstallerIfCloseAllowed = fn<typeof Startup.checkInstallerIfCloseAllowed>();
