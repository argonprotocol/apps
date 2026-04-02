DELETE FROM Config WHERE key = 'hasReadVaultingInstructions';
DELETE FROM Config WHERE key = 'hasReadMiningInstructions';

INSERT OR REPLACE INTO Config (key, value)
SELECT
  'bootstrapDetails',
  '{"type":"Public","routerHost":"ARGON_NETWORK_NAME"}'
FROM Config
WHERE key = 'showWelcomeOverlay'
  AND value = 'true';

DELETE FROM Config WHERE key = 'showWelcomeOverlay';
