ALTER TABLE BitcoinLocks RENAME COLUMN peggedPrice TO lockedMarketRate;
ALTER TABLE BitcoinLocks ADD COLUMN lockedUtxoSatoshis INTEGER;
UPDATE BitcoinLocks SET lockedUtxoSatoshis = satoshis WHERE lockedTxid IS NOT NULL;
ALTER TABLE Vaults DROP COLUMN personalUtxoId;
ALTER TABLE Vaults DROP COLUMN prebondedMicrogons;
ALTER TABLE Vaults DROP COLUMN prebondedMicrogonsAtTick;
