DROP INDEX IF EXISTS idxBitcoinLocksHdPath;

CREATE UNIQUE INDEX idxBitcoinLocksHdPath ON BitcoinLocks (hdPath) WHERE utxoId IS NULL;
