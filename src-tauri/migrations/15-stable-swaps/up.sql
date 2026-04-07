CREATE TABLE StableSwapSyncState (
  walletAddress TEXT NOT NULL PRIMARY KEY,
  startBlockNumber INTEGER NOT NULL,
  lastScannedBlockNumber INTEGER NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE StableSwapMarketState (
  id INTEGER NOT NULL PRIMARY KEY CHECK(id = 1),
  poolAddress TEXT NOT NULL,
  poolFee INTEGER NOT NULL,
  poolLiquidity TEXT NOT NULL,
  currentPriceMicrogons TEXT NOT NULL,
  targetPriceMicrogons TEXT,
  discountedEthereumArgonAmount TEXT NOT NULL,
  costToTargetMicrogons TEXT NOT NULL,
  projectedProfitMicrogons TEXT NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE StableSwapPurchases (
  id INTEGER NOT NULL PRIMARY KEY,
  walletAddress TEXT NOT NULL,
  txHash TEXT NOT NULL,
  blockNumber INTEGER NOT NULL,
  blockHash TEXT NOT NULL,
  transactionIndex INTEGER NOT NULL,
  receiptRoot TEXT NOT NULL,
  ethereumTimestamp DATETIME NOT NULL,
  poolAddress TEXT NOT NULL,
  poolFee INTEGER NOT NULL,
  ethereumArgonAmount TEXT NOT NULL,
  costBasisUsdc TEXT NOT NULL,
  costBasisMicrogons TEXT NOT NULL,
  effectiveBuyPriceMicrogons TEXT NOT NULL,
  uniswapPriceMicrogons TEXT NOT NULL,
  argonBlockNumber INTEGER,
  argonBlockHash TEXT,
  argonOraclePriceMicrogons TEXT,
  argonOracleTargetPriceMicrogons TEXT,
  proofStatus TEXT NOT NULL CHECK(proofStatus IN (
    'Pending',
    'Ready',
    'Failed'
  )),
  proofPayload TEXT,
  proofError TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(walletAddress, txHash)
);

CREATE INDEX idxStableSwapPurchasesWalletTimestamp
ON StableSwapPurchases (walletAddress, ethereumTimestamp DESC, id DESC);

CREATE INDEX idxStableSwapPurchasesProofStatus
ON StableSwapPurchases (walletAddress, proofStatus, blockHash);
