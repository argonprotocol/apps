import { invoke } from '@tauri-apps/api/core';

export class InvokeTimeout extends Error {
  constructor(message: string) {
    super(message);
  }
}

export async function invokeWithTimeout<T>(cmd: string, args: Record<string, any>, timeoutMs: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new InvokeTimeout('Invoke timed out')), timeoutMs),
  );

  try {
    console.info(`[TAURI] ${cmd}`);
    const invocation = invoke<T>(cmd, args);
    const result = await Promise.race([invocation, timeout]);
    console.debug(`[TAURI] ${cmd} returned`, result);
    return result;
  } catch (e) {
    console.error(`[TAURI] Error invoking ${cmd}`, e);
    throw e;
  }
}
