ALTER TABLE BondLotHistory ADD COLUMN flexibilityHistory TEXT NOT NULL DEFAULT '[]';
ALTER TABLE BondLotHistory ADD COLUMN flexibilityHistoryComplete BOOLEAN NOT NULL DEFAULT 0;
