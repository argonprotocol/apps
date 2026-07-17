CREATE TABLE ExternalWalletBalanceCache (
  chain TEXT NOT NULL CHECK(chain IN ('ethereum', 'base')),
  address TEXT NOT NULL,
  availableMicrogons TEXT NOT NULL DEFAULT '0',
  availableMicronots TEXT NOT NULL DEFAULT '0',
  otherTokensJson TEXT NOT NULL DEFAULT '[]',
  observedAt DATETIME NOT NULL,
  PRIMARY KEY (chain, address)
);
