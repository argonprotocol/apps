import Fs from 'node:fs';
import Path from 'node:path';

export function acquireDevLock(lockPath: string, actionLabel: string): () => void {
  Fs.mkdirSync(Path.dirname(lockPath), { recursive: true });
  const processLabel = actionLabel.toLowerCase();
  try {
    Fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

    // Only one process may reclaim a stale lock. A competing restart must not
    // remove a lock that another restart has just acquired.
    const recoveryPath = `${lockPath}.recover`;
    try {
      Fs.writeFileSync(recoveryPath, String(process.pid), { flag: 'wx', mode: 0o600 });
    } catch (recoveryError) {
      if ((recoveryError as NodeJS.ErrnoException).code !== 'EEXIST') throw recoveryError;
      throw new Error(
        `${actionLabel} lock recovery is already running. If it crashed, remove ${recoveryPath} after confirming no ${processLabel} process is running.`,
      );
    }
    try {
      if (Fs.existsSync(lockPath)) {
        const pid = Number(Fs.readFileSync(lockPath, 'utf8'));
        if (!Number.isInteger(pid) || pid <= 0) {
          throw new Error(
            `The ${processLabel} lock at ${lockPath} is incomplete. Remove it only after confirming no ${processLabel} process is running, then retry.`,
          );
        }
        let active = true;
        try {
          process.kill(pid, 0);
        } catch (pidError) {
          if ((pidError as NodeJS.ErrnoException).code === 'ESRCH') active = false;
          else throw pidError;
        }
        if (active) throw new Error(`${actionLabel} is already running for this instance (PID ${pid}).`);
        Fs.rmSync(lockPath);
      }
      Fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
    } finally {
      Fs.rmSync(recoveryPath);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    Fs.rmSync(lockPath);
    released = true;
  };
}
