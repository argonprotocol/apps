DELETE FROM config WHERE key = 'screenKey';
UPDATE config SET key = 'serverInstaller' WHERE key = 'installDetails';
INSERT INTO config (key, value)
SELECT 'serverAdd' AS key, value
FROM config
WHERE key = 'serverCreation'
ON CONFLICT(key) DO UPDATE
SET value = excluded.value;
DELETE FROM config WHERE key = 'serverCreation';

INSERT INTO config (key, value)
SELECT
    'miningSetupStatus' AS key,
    CASE
        WHEN EXISTS (
            SELECT 1 FROM config
            WHERE key = 'isMinerInstalled' AND value = 'true'
        ) THEN '"Finished"'
        WHEN EXISTS (
            SELECT 1 FROM config
            WHERE key = 'isMinerInstalling' AND value = 'true'
        ) THEN '"Installing"'
        WHEN EXISTS (
            SELECT 1 FROM config
            WHERE key = 'isPreparingMinerSetup' AND value = 'true'
        ) THEN '"Checklist"'
        ELSE '"None"'
END AS value
ON CONFLICT(key) DO UPDATE
SET value = excluded.value;

UPDATE config SET key = 'isServerInstalled' WHERE key = 'isMinerInstalled';
UPDATE config SET key = 'isServerInstalling' WHERE key = 'isMinerInstalling';
DELETE FROM config WHERE key = 'isMiningMachineCreated';
DELETE FROM config WHERE key = 'isMinerReadyToInstall';
DELETE FROM config WHERE key = 'isPreparingMinerSetup';

INSERT INTO config (key, value)
SELECT
    'vaultingSetupStatus' AS key,
    CASE
        WHEN EXISTS (
            SELECT 1 FROM config
            WHERE key = 'isVaultActivated' AND value = 'true'
        ) THEN '"Finished"'
        WHEN EXISTS (
            SELECT 1 FROM config
            WHERE key = 'isVaultReadyToCreate' AND value = 'true'
        ) THEN '"Installing"'
        WHEN EXISTS (
            SELECT 1 FROM config
            WHERE key = 'isPreparingVaultSetup' AND value = 'true'
        ) THEN '"Checklist"'
        ELSE '"None"'
END AS value
ON CONFLICT(key) DO UPDATE
SET value = excluded.value;

DELETE FROM config WHERE key = 'isVaultActivated';
DELETE FROM config WHERE key = 'isVaultReadyToCreate';
DELETE FROM config WHERE key = 'isPreparingVaultSetup';
