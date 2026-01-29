-- Prefer the row that has a utxoId when multiple rows share the same hdPath.
-- 1) If any row for an hdPath has a non-NULL utxoId, delete the NULL-utxoId duplicates.
DELETE FROM BitcoinLocks
WHERE utxoId IS NULL
  AND hdPath IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM BitcoinLocks AS b2
    WHERE b2.hdPath = BitcoinLocks.hdPath
      AND b2.utxoId IS NOT NULL
  );

-- 2) If duplicates still remain (e.g., multiple non-NULL utxoId rows), keep one deterministically.
DELETE FROM BitcoinLocks
WHERE hdPath IS NOT NULL
  AND rowid NOT IN (
    SELECT MIN(rowid)
    FROM BitcoinLocks
    WHERE hdPath IS NOT NULL
    GROUP BY hdPath
  );

CREATE UNIQUE INDEX IF NOT EXISTS idxBitcoinLocksHdPath ON BitcoinLocks (hdPath);

CREATE TABLE BitcoinLockStatusHistory (
  uuid TEXT NOT NULL,
  newStatus TEXT NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER BitcoinLocksStatusChangeHistoryRecorder
AFTER UPDATE OF status ON BitcoinLocks
WHEN OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO BitcoinLockStatusHistory (uuid, newStatus)
  VALUES (NEW.uuid, NEW.status);
END;
