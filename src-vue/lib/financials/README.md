# Financial positions

Financials separates **net worth** from **investment return**. Net worth sums each current asset and liability once. Return compares eligible positions using:

`current value + returned principal + paid income - invested cost`

Wallet balances and liabilities affect net worth but are not themselves investment returns. If historical cost basis or a required price is missing, we keep the current value when possible and mark the return partial or unavailable instead of guessing.

Each domain class implements the same `IFinancialPositionSource` contract. Its primary method identifies the domain records, lifecycle, and native amounts; `createFinancialPosition` adds the shared position fields and takes calculated investment value separately. `FinancialPositionBook` rejects duplicate IDs and positions published into the wrong group.

## ARGNOT handling

ARGNOT is valued in ARGN at the ARGNOT rate for the observation. Its cost basis is the rate when the ARGNOT entered the position: an external receipt, bond purchase, mining bid, or mining reward settlement. Moving ARGNOT between owned accounts preserves that basis. Moving it into a domain removes it from liquid wallet holdings so the same ARGNOT is not counted twice; the domain position then owns its value and return until it leaves.

Mining collateral is marked from its bid-time rate through the end of its custody period. ARGNOT earned during an active mining term is already part of the mining account balance, so it is included in net worth at the current rate. The mining term also counts that value as earned income, but the ARGNOT does not yet have a separate holding basis. When the term closes, its total earned ARGNOT replaces that unbased quantity with one holding lot at the term's closing rate. This changes its return attribution without changing its current value. Daily reward lots would require arbitrary interim marks and split one term's earnings across many holding positions, so rewards are consolidated at the term boundary instead.

Recommitting available ARGNOT closes the prior holding and opens the next mining position at the new bid rate. ARGNOT bond principal follows the same pattern using purchase, current, and release rates. When an entry rate is missing, current value can still be shown from a current rate, but return remains unavailable.

## Position categories

- **Wallets:** Argon and Ethereum wallets own their balances exactly once. ARGN is shown at face value unless an active Ethereum swap market supplies its current mark. ARGNOT received from outside the owned accounts opens a FIFO holding lot at that block's ARGNOT price. Transfers between owned accounts preserve the lot and basis; an external transfer closes it. Domain-owned holds are removed from wallet holdings and counted by mining, vaulting, or bonds instead.
- **Mining bids and terms:** A pending bid reserves its ARGN bid and any newly supplied ARGNOT collateral. Each won cohort then becomes a mining-term position whose cost is the bid plus transaction fees. The seat is valued at the bid price amortized over the completed percentage of its term. Mining RTD uses realized income against cost and does not include the seat's current asset value.
- **Mining ARGNOT:** ARGNOT entering the mining bot opens a custody lot at the transfer rate, including amounts not yet committed to a cohort. A bid closes the committed FIFO quantity and opens collateral at the bid-time rate. During a cohort, earned ARGNOT is live-valued as part of mining net worth but remains ineligible for a separate holding return. When the cohort ends, its total earned ARGNOT becomes one reward lot at the closing rate; rewards are not split per block. Custody, collateral, and rewards stay live-valued until recommitted or transferred out. The full mining balance is excluded from generic wallet holdings, so the term-close handoff must replace the unbased quantity rather than add another asset.
- **Vaulting:** One position tracks the operator's securitization, uncollected revenue, collected revenue, released principal, and capital loss. Increases add cost basis; released capital becomes returned principal. A return needs capital history beginning with vault creation and reconciling to the live vault.
- **Bonds:** Each treasury bond lot is a position, although the UI can combine them. ARGN principal remains at face value; ARGNOT principal uses its purchase, current, and release marks. Distributed earnings are income and released principal settles the position. A bond into the user's own vault remains visible in Bonds but is excluded from the blended account return to avoid overlap with the vault position.
- **Bitcoin locks:** One position follows a lock across ratchets. Live BTC and pending mint use the current mark, while received liquidity excludes pending and burned mint. A completed release settles from its removal-time BTC mark, recorded redemption, Argon and Bitcoin fees, compensation, and removal time. Until settlement recovery completes, the observable value remains visible but its return is unavailable. An expired unspent UTXO is not presented as a live lock or returned BTC.
- **Stable swaps:** The Ethereum wallet owns its ARGN asset. Once Stable Swaps is activated, the same position is marked at the current pool price and enriched with purchase basis; no second swap asset is added. Return is unavailable when purchase history does not reconcile to the wallet quantity.

Historical recovery is asynchronous. Until wallet, bond, vault, and Bitcoin history reaches the current finalized observation, affected groups may be stale, partial, or unavailable; current balances must still remain loadable. App financial history is supported from runtime spec 137, the oldest runtime used by an app release.

## Known deficiencies

- **Blended RTD is not time-weighted:** The account percentage combines eligible profit and invested cost across positions. It is not an IRR or time-weighted return, so it does not normalize deposits, withdrawals, or positions held for different lengths of time.
- **Mining ARGNOT attribution is incomplete:** Active mining rewards are included in net worth and mining income but have no separate holding return until the cohort closes. That handoff does not duplicate the asset, but the blended RTD can then count the successor holding basis in addition to the mining term basis. Custody-to-collateral transitions have the same denominator problem, and a direct historical transfer from the mining bot can lack its closing boundary.
- **Transaction fees are incomplete:** Mining cohort fees and Bitcoin operation fees are included where their domain records carry them. Vault, bond, stable-swap, and general wallet transaction fees are not yet assigned consistently to investment positions.
- **Reopened vaults are not supported:** Financial history assumes an operator account has one vault lifecycle.
