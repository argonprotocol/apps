INSERT INTO Config (key, value)
SELECT 'hasMiningSeats', 'true'
WHERE EXISTS (SELECT 1 FROM Cohorts WHERE seatCountWon > 0)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

INSERT INTO Config (key, value)
SELECT 'hasMiningBids', 'true'
WHERE EXISTS (SELECT 1 FROM FrameBids WHERE json_array_length(bidsJson) > 0)
   OR EXISTS (SELECT 1 FROM Cohorts WHERE seatCountWon > 0)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

INSERT INTO Config (key, value)
SELECT 'miningSetupStatus', '"Finished"'
WHERE EXISTS (SELECT 1 FROM Config WHERE key IN ('hasMiningBids', 'hasMiningSeats') AND value = 'true')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

INSERT INTO Config (key, value)
SELECT 'hasExtensionTreasury', 'true'
WHERE EXISTS (
  SELECT 1
  FROM Config
  WHERE key IN ('miningSetupStatus', 'vaultingSetupStatus') AND value = '"Finished"'
)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

INSERT INTO Config (key, value)
SELECT 'hasExtensionOperations', 'true'
WHERE EXISTS (
  SELECT 1
  FROM Config
  WHERE key IN ('miningSetupStatus', 'vaultingSetupStatus') AND value = '"Finished"'
)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

DROP TABLE IF EXISTS CohortFrames;
DROP TABLE IF EXISTS FrameBids;
DROP TABLE IF EXISTS Cohorts;
DROP TABLE IF EXISTS Frames;
