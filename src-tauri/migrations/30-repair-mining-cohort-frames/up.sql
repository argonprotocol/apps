-- Cohort-frame write suppression previously keyed its cache by frame alone,
-- so equal earnings for different cohorts could be skipped. These records are
-- replayed in place from bot history to restore complete mining RTD.
UPDATE Frames AS frame
SET isProcessed = 0
WHERE frame.isProcessed = 1
  AND (
    frame.blocksMinedTotal != COALESCE((
      SELECT SUM(cohortFrame.blocksMinedTotal)
      FROM CohortFrames AS cohortFrame
      WHERE cohortFrame.frameId = frame.id
    ), 0)
    OR frame.micronotsMinedTotal != COALESCE((
      SELECT SUM(cohortFrame.micronotsMinedTotal)
      FROM CohortFrames AS cohortFrame
      WHERE cohortFrame.frameId = frame.id
    ), 0)
    OR frame.microgonsMinedTotal != COALESCE((
      SELECT SUM(cohortFrame.microgonsMinedTotal)
      FROM CohortFrames AS cohortFrame
      WHERE cohortFrame.frameId = frame.id
    ), 0)
    OR frame.microgonsMintedTotal != COALESCE((
      SELECT SUM(cohortFrame.microgonsMintedTotal)
      FROM CohortFrames AS cohortFrame
      WHERE cohortFrame.frameId = frame.id
    ), 0)
    OR frame.microgonFeesCollectedTotal != COALESCE((
      SELECT SUM(cohortFrame.microgonFeesCollectedTotal)
      FROM CohortFrames AS cohortFrame
      WHERE cohortFrame.frameId = frame.id
    ), 0)
  );
