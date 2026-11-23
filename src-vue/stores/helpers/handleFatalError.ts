import { message as tauriMessage } from '@tauri-apps/plugin-dialog';
import { useAppUpdater } from '../appUpdater.ts';

let hasAlreadyShownFatalError = false;

export default async function handleFatalError(this: any, error?: Error) {
  const type = this || 'Unknown';
  console.error(`Fatal error (${type}): `, error);

  if (hasAlreadyShownFatalError) return;
  hasAlreadyShownFatalError = true;

  if (await useAppUpdater().showUpdateAfterError()) return;
  await tauriMessage(`A fatal error (${type}) has occurred. Please restart the application.`, {
    title: 'Fatal Error',
    kind: 'error',
  });
}
