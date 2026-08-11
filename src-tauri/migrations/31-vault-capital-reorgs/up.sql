DELETE FROM VaultCapitalHistory
WHERE id NOT IN (
  SELECT MAX(id)
  FROM VaultCapitalHistory
  GROUP BY
    walletAddress,
    vaultId,
    blockNumber,
    COALESCE(extrinsicIndex, -1),
    eventType,
    COALESCE(amount, ''),
    COALESCE(securitization, ''),
    COALESCE(securitizationTarget, ''),
    COALESCE(releaseHeight, ''),
    COALESCE(securitizationRemaining, ''),
    COALESCE(securitizationReleased, '')
);

-- Collect releases the vault's full held balance once. Frame-start processing
-- can emit multiple distinct burns in one block, so only collect is block-unique.
DELETE FROM VaultRevenueEvents
WHERE source = 'vaultCollect'
  AND id NOT IN (
    SELECT MAX(id)
    FROM VaultRevenueEvents
    WHERE source = 'vaultCollect'
    GROUP BY blockNumber
  );

DROP INDEX idxVaultRevenueEventsBlockIdentity;

CREATE UNIQUE INDEX idxVaultRevenueEventsBlockIdentity
ON VaultRevenueEvents (blockNumber, source)
WHERE source = 'vaultCollect';
