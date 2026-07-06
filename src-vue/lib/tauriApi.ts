import { invoke } from '@tauri-apps/api/core';

export class InvokeTimeout extends Error {
  constructor(message: string) {
    super(message);
  }
}

const SENSITIVE_COMMANDS = new Set([
  'overwrite_mnemonic',
  'encrypt_wallet_secret',
  'derive_external_ethereum_addresses',
  'derive_external_ethereum_address_from_private_key',
  'sign_external_ethereum_personal_message',
  'sign_external_ethereum_permit',
  'sign_external_ethereum_transaction',
]);

export async function invokeWithTimeout<T>(cmd: string, args: Record<string, any>, timeoutMs: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new InvokeTimeout('Invoke timed out')), timeoutMs),
  );

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
  }
}
