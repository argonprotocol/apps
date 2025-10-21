ALTER TABLE Frames ADD COLUMN accruedMicronotProfits INTEGER NOT NULL DEFAULT 0;

CREATE TABLE FrameBids2 (
  frameId INTEGER PRIMARY KEY,
  confirmedAtBlockNumber INTEGER NOT NULL,
  bidsJson JSON DEFAULT '[]',
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO FrameBids2 (frameId, confirmedAtBlockNumber, bidsJson, createdAt, updatedAt)
SELECT
  fb.frameId,
  MIN(fb.confirmedAtBlockNumber) AS confirmedAtBlockNumber,
  (
    SELECT json_group_array(json_object(
      'address', address,
      'subAccountIndex', subAccountIndex,
      'microgonsPerSeat', microgonsPerSeat,
      'bidPosition', bidPosition,
      'lastBidAtTick', lastBidAtTick
    ))
    FROM (
      SELECT address, subAccountIndex, microgonsPerSeat, bidPosition, lastBidAtTick
      FROM FrameBids i
      WHERE i.frameId = fb.frameId
      ORDER BY bidPosition ASC
    )
  ) AS bidsJson,
  MIN(fb.createdAt) AS createdAt,
  MAX(fb.updatedAt) AS updatedAt
FROM FrameBids fb
GROUP BY fb.frameId
ORDER BY fb.frameId;

DROP TRIGGER FrameBidsUpdateTimestamp;
DROP TABLE FrameBids;
ALTER TABLE FrameBids2 RENAME TO FrameBids;

CREATE TRIGGER FrameBidsUpdateTimestamp
AFTER UPDATE ON FrameBids
BEGIN
  UPDATE FrameBids SET updatedAt = CURRENT_TIMESTAMP WHERE frameId = NEW.frameId;
END;

