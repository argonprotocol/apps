DROP TABLE StableSwapPurchases;
DROP TABLE StableSwapSyncState;

ALTER TABLE BitcoinFissions ADD COLUMN repayments JSON NOT NULL DEFAULT '[]';
ALTER TABLE BitcoinFissions ADD COLUMN initialSatoshis TEXT;
UPDATE BitcoinFissions SET initialSatoshis = satoshis;

DELETE FROM Config WHERE key = 'hasActivatedStableSwaps';
UPDATE Config SET value = '"Home"' WHERE key = 'selectedTab' AND value = '"StableSwaps"';

CREATE TABLE StabilizerBuys (
  ownerAccount TEXT NOT NULL,
  id TEXT NOT NULL,
  gatewayTransferId TEXT,
  status TEXT NOT NULL,
  admissionFrame INTEGER,
  principal TEXT,
  matchingBasis TEXT,
  repayLiquidId INTEGER,
  liquidRepaymentEvent JSON,
  purchaseAdmissionFailure JSON,

  ethereumQuote JSON,
  ethereumMaxFeeWei TEXT,

  usdcApprovalTxHash TEXT,
  usdcApprovalSubmittedAt DATETIME,
  usdcApprovalFeeWei TEXT,
  usdcApprovalPrices JSON,

  ethereumTxHash TEXT,
  ethereumSubmittedAt DATETIME,
  ethereumFeeWei TEXT,
  ethereumPrices JSON,
  ethereumGatewayActivity JSON,
  purchaseEthereumBlockNumber INTEGER,
  purchaseEthereumBlockHash TEXT,
  purchaseEthereumLogIndex INTEGER,
  ethereumConfirmedAt DATETIME,

  argonPurchaseEvent JSON,
  purchaseArgonRecognitionBlockNumber INTEGER,
  purchaseArgonRecognitionBlockHash TEXT,
  purchaseArgonRecognitionBlockTime DATETIME,
  purchaseArgonRecognitionEventIndex INTEGER,
  ineligibleReason TEXT,

  purchaseArgonReleaseBlockNumber INTEGER,
  purchaseArgonReleaseBlockHash TEXT,
  purchaseArgonReleaseBlockTime DATETIME,
  purchaseArgonReleaseEventIndex INTEGER,
  releasedPrincipal TEXT,

  purchasedAt DATETIME,
  spentMicrogons TEXT,
  ethereumFeeMicrogons TEXT,
  usdcApprovalFeeMicrogons TEXT,
  argonFees JSON NOT NULL DEFAULT '[]',

  statusError TEXT,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ownerAccount, id),
  UNIQUE (ownerAccount, gatewayTransferId)
);
CREATE INDEX idxStabilizerBuysStatus ON StabilizerBuys (ownerAccount, status, createdAt);
CREATE INDEX idxStabilizerBuysFrame ON StabilizerBuys (ownerAccount, admissionFrame);

CREATE TABLE StabilizerBuyFrameRewards (
  ownerAccount TEXT NOT NULL,
  admissionFrame INTEGER NOT NULL,
  bidCount INTEGER NOT NULL DEFAULT 0,
  latestBid INTEGER NOT NULL DEFAULT 0,
  bidEvent JSON,
  lastUpdatedArgonBlock INTEGER NOT NULL,
  requestedReward TEXT,
  rewardAward JSON,
  awardedReward TEXT,
  maturesAtFrame INTEGER,
  paidReward TEXT NOT NULL DEFAULT '0',
  repaymentRewards JSON NOT NULL DEFAULT '[]',
  payout JSON,
  bidFees JSON NOT NULL DEFAULT '[]',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ownerAccount, admissionFrame)
);
