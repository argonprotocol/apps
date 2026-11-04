import { invoke } from '@tauri-apps/api/core';

export type SystemAuthenticationOption = 'touchId' | 'faceId' | 'windowsHello' | 'fingerprint';

export class InvokeTimeout extends Error {
  constructor(message: string) {
    super(message);
  }
}

const SENSITIVE_COMMANDS = new Set([
  'keychain_create',
  'keychain_write',
  'keychain_set_protection',
  'keychain_delete',
  'keychain_encrypt',
  'keychain_decrypt',
  'keychain_authenticate',
  'export_sr25519_seed',
  'cleanup_mnemonic_files',
  'write_wallet_file',
  'open_ssh_connection',
  'ssh_access_activate',
  'ssh_access_deactivate',
]);

export async function invokeWithTimeout<T>(cmd: string, args: Record<string, any>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new InvokeTimeout('Invoke timed out')), timeoutMs);
  });

  try {
    if (SENSITIVE_COMMANDS.has(cmd)) {
      console.info(`[TAURI] ${cmd} [args redacted]`);
    } else {
      console.info(`[TAURI] ${cmd}`, args);
    }
    const invocation = invoke<T>(cmd, args);
    return await Promise.race([invocation, timeout]);
  } catch (e) {
    console.error(`[TAURI] Error invoking ${cmd}`, e);
    throw e;
  } finally {
    clearTimeout(timer!);
  }
}
