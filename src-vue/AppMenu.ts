import * as Vue from 'vue';
import { Menu, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';
import { exit as tauriExit } from '@tauri-apps/plugin-process';
import { getCurrentWindow } from '@tauri-apps/api/window';
import basicEmitter from './emitters/basicEmitter';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import { useController } from './stores/controller';
import { getInstaller } from './stores/installer';
import { getBot } from './stores/bot';
import { ScreenKey } from './interfaces/IConfig';
import { getConfig } from './stores/config';
import { useTour } from './stores/tour';
import { WalletType } from './lib/Wallet.ts';

function openAboutOverlay() {
  basicEmitter.emit('openAboutOverlay');
}

export async function createMenu() {
  const controller = useController();
  const installer = getInstaller();
  const config = getConfig();
  const bot = getBot();
  const tour = useTour();

  const mainMenu = await Submenu.new({
    text: 'Management Console',
    items: [
      {
        id: 'about',
        text: 'About This App',
        action: openAboutOverlay,
      },
      {
        id: 'check-updates',
        text: 'Check for Updates',
        action: () => basicEmitter.emit('openCheckForAppUpdatesOverlay'),
      },
      await PredefinedMenuItem.new({ item: 'Separator' }),
      {
        id: 'security-settings',
        text: 'Security Settings',
        action: () => basicEmitter.emit('openSecuritySettingsOverlay'),
      },
      {
        id: 'jurisdictional-compliance',
        text: 'Default Jurisdiction',
        action: () => basicEmitter.emit('openJurisdictionOverlay'),
      },
      await PredefinedMenuItem.new({ item: 'Separator' }),
      {
        id: 'quit',
        text: 'Quit Management Console',
        accelerator: 'CmdOrCtrl+Q',
        action: () => void tauriExit(),
      },
    ],
  });

  const editMenu = await Submenu.new({
    text: 'Edit',
    items: [
      await PredefinedMenuItem.new({ item: 'Undo' }),
      await PredefinedMenuItem.new({ item: 'Redo' }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await PredefinedMenuItem.new({ item: 'Cut' }),
      await PredefinedMenuItem.new({ item: 'Copy' }),
      await PredefinedMenuItem.new({ item: 'Paste' }),
      await PredefinedMenuItem.new({ item: 'SelectAll' }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
    ],
  });

  const miningMenu = await Submenu.new({
    text: 'Mining',
    items: [
      {
        id: 'mining-dashboard',
        text: 'Open Mining',
        action: () => controller.setScreenKey(ScreenKey.Mining),
      },
      {
        id: 'token-transfer-to-mining',
        text: 'Open Mining Wallet',
        action: () => basicEmitter.emit('openWalletOverlay', { walletType: WalletType.mining, screen: 'receive' }),
      },
    ],
  });

  const vaultingMenu = await Submenu.new({
    text: 'Vaulting',
    items: [
      {
        id: 'vaulting-dashboard',
        text: 'Open Vaulting',
        action: () => controller.setScreenKey(ScreenKey.Vaulting),
      },
      {
        id: 'token-transfer-to-vaulting',
        text: 'Open Vaulting Wallet',
        action: () => basicEmitter.emit('openWalletOverlay', { walletType: WalletType.vaulting, screen: 'receive' }),
      },
    ],
  });

  const windowMenu = await Submenu.new({
    text: 'Window',
    items: [
      {
        id: 'minimize',
        text: 'Minimize',
        accelerator: 'CmdOrCtrl+M',
        action: () => void getCurrentWindow().minimize(),
      },
      {
        id: 'maximize',
        text: 'Maximize',
        accelerator: 'CmdOrCtrl+Shift+M',
        action: () => void getCurrentWindow().toggleMaximize(),
      },
      {
        id: 'fullscreen',
        text: 'Fullscreen',
        accelerator: 'CmdOrCtrl+Ctrl+F',
        action: void (async () => {
          const window = getCurrentWindow();
          const isFullscreen = await window.isFullscreen();
          await window.setFullscreen(!isFullscreen);
        }),
      },
      await PredefinedMenuItem.new({ item: 'Separator' }),
      {
        id: 'reload',
        text: 'Reload UI',
        accelerator: 'CmdOrCtrl+R',
        action: () => {
          config
            .save()
            .then(() => {
              window.location.reload();
            })
            .catch(e => {
              console.log('Failed to save config before reload', e);
            });
        },
      },
    ],
  });

  const troubleshootingMenu = await Submenu.new({
    text: 'Troubleshooting',
    items: [
      {
        id: 'data-and-log-files',
        text: 'Data and Logging',
        action: () => basicEmitter.emit('openTroubleshootingOverlay', { screen: 'data-and-log-files' }),
      },
      {
        id: 'server-diagnostics',
        text: 'Server Diagnostics',
        action: () => basicEmitter.emit('openTroubleshootingOverlay', { screen: 'server-diagnostics' }),
      },
      await PredefinedMenuItem.new({ item: 'Separator' }),
      {
        id: 'options-for-restart',
        text: 'Advanced Restart',
        accelerator: 'CmdOrCtrl+Shift+R',
        action: () => basicEmitter.emit('openTroubleshootingOverlay', { screen: 'options-for-restart' }),
      },
    ],
  });

  const helpMenu = await Submenu.new({
    text: 'Help',
    items: [
      troubleshootingMenu,
      await PredefinedMenuItem.new({ item: 'Separator' }),
      {
        id: 'documentation',
        text: 'Documentation',
        action: () => void tauriOpenUrl('https://argon.network/docs'),
      },
      {
        id: 'faq',
        text: 'Frequently Asked Questions',
        action: () => void tauriOpenUrl('https://argon.network/faq'),
      },
      {
        id: 'tour',
        text: 'Take the Tour',
        action: () => tour.start(),
      },
      await PredefinedMenuItem.new({ item: 'Separator' }),
      {
        id: 'discord-community',
        text: 'Discord User Community',
        action: () => void tauriOpenUrl('https://discord.gg/xDwwDgCYr9'),
      },
      {
        id: 'github-community',
        text: 'GitHub Developer Community',
        action: () => void tauriOpenUrl('https://github.com/argonprotocol/apps/issues'),
      },
      await PredefinedMenuItem.new({ item: 'Separator' }),
      {
        id: 'about',
        text: 'About',
        action: openAboutOverlay,
      },
    ],
  });

  const menu = await Menu.new({
    items: [mainMenu, editMenu, miningMenu, vaultingMenu, windowMenu, helpMenu],
  });

  function updateMiningMenu() {
    void miningMenu.setEnabled(!installer.isRunning && !bot.isSyncing);
  }

  await menu.setAsAppMenu().then(async res => {
    Vue.watch(
      () => installer.isRunning,
      () => updateMiningMenu(),
      { immediate: true },
    );
    Vue.watch(
      () => bot.isSyncing,
      () => updateMiningMenu(),
      { immediate: true },
    );
  });
}
