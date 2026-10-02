-- Earlier desktops treated closed live frames as immutable before finalization.
-- Keep their visible totals and refresh them once from the bot's canonical files.
UPDATE Frames SET isProcessed = 0 WHERE isProcessed = 1;
