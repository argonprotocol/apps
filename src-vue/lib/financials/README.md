# Financial positions

Financials separates **net worth** from **investment return**. Net worth sums each current asset and liability once. Domain returns compare eligible positions using:

`current value + returned principal + paid income - invested cost`

Wallet balances and liabilities affect net worth but are not themselves investment returns. If historical cost basis or a required price is missing, we keep the current value when possible and mark the return partial or unavailable instead of guessing.

Account RTD combines eligible mining, vaulting, bond, Bitcoin, and stable-swap positions using their domain-defined performance rather than their current market value. Cost basis is capital-time weighted, so newly deployed capital gains influence as it remains invested instead of diluting established returns immediately. Position histories provide later capital additions and removals where a position can change size. Undeployed wallet balances and ARGNOT market-price movement remain outside investment performance.

The app recomputes live RTD summaries in memory from positions observed at one coherent best block. Finalized or recovered history supplies cost basis and capital timing. While history catches up, affected returns are partial or unavailable; current balances remain visible independently.

Each financial projection source implements the same `IFinancialPositionSource` contract. Its primary method identifies the domain records, lifecycle, and native amounts; `createFinancialPosition` adds the shared position fields and takes calculated investment value separately. `FinancialPositionBook` rejects duplicate IDs and positions published into the wrong group.

## State authority and recovery

Current domain state comes from live chain queries, subscriptions, and recovered pending transactions owned by that domain. Financial history is backfill: it supplies older facts that are absent locally, but it does not become the source of current state.

On first `get...()` or `use...()` access, every domain store creates its singleton and starts its idempotent current-state load. The model sets `data.isLoaded` after publishing usable current chain and recovered pending-transaction state. It increments `data.financialRevision` with that initial publication and after every later atomic change that can affect a financial position, including published backfill.

Background domain hydration is not application-fatal. A transient chain, block, or service failure is logged with domain context and leaves the idempotent load retryable. Only an unusable application identity or durable local state belongs in the global fatal-error path.

Ordinary consumers never call or await a domain model's `load()` method. Financials publishes wallet state as soon as the wallet snapshot is ready, leaves an unavailable domain group loading (or preserves its last valid snapshot), and recomputes that group after the domain revision changes. Certification and screen controllers only observe domain state.

Recovery may start only at one of these boundaries:

- an account import needs historical reconstruction;
- a domain owner detects a concrete missing record or event gap;
- the user explicitly runs Find Missing Data.

Domains own normal finalized-event ingestion and concrete gap repair. The `financialHistory` store coordinates only account-import reconstruction and the explicit Find Missing Data command. It writes through each domain's recovery boundary, then the domain atomically publishes a new financial revision after merging backfill behind any newer live observations. Financial projections consume that published domain state and recompute when it changes; they do not require recovery to reach the moving chain head and do not use a global recovery flag to invalidate otherwise complete positions.

Completeness is evaluated at the affected record and field. If a return needs a missing fee, price, or capital event, that return remains unavailable until the domain supplies the fact. Unrelated positions and already-valid current values remain visible.

## ARGNOT handling

ARGNOT contributes to net worth at the current ARGNOT rate. Domain returns do not treat changes in the market value of ARGNOT principal as investment income.

When a domain return needs the ARGN value of ARGNOT principal or income, it uses the rate recorded by that domain, such as a mining bid or bond lock rate. If the required rate is missing, the current value can still be shown for net worth, but the affected return is partial or unavailable.

## Position categories

- **Wallets:** Argon and Ethereum wallets own their balances exactly once. ARGN is shown at face value unless an active Ethereum swap market supplies its current mark, and ARGNOT is shown at its current rate. Balances already owned by mining, vaulting, or bonds are excluded from generic wallet holdings to avoid double counting.
- **Mining bids and terms:** A pending bid reserves its ARGN bid and any newly supplied ARGNOT collateral. Each won cohort then becomes a mining-term position whose cost is the bid plus transaction fees. The seat is valued at the bid price amortized over the completed percentage of its term. Mining RTD uses realized income against cost and does not include the seat's current asset value.
- **Mining ARGNOT:** The mining account's ARGNOT balance is included in net worth at the current rate and excluded from generic wallet holdings so it is counted once. Mining collateral uses its bid-time rate for mining performance, while earned ARGNOT is counted as mining income. Collateral price movement is not added as separate mining income.
- **Vaulting:** One position tracks the operator's securitization, uncollected revenue, collected revenue, released principal, and capital loss. Increases add cost basis; released capital becomes returned principal. A return needs capital history beginning with vault creation and reconciling to the live vault.
- **Bonds:** Each treasury bond lot is a position, although the UI can combine them. ARGN principal remains at face value; ARGNOT principal uses its current or release mark for net worth. Bond income return is distributed earnings divided by the principal's ARGN value when locked, excluding later ARGNOT price movement. A bond into the user's own vault remains visible in Bonds but is excluded from account value and RTD to avoid overlap with the vault position.
- **Bitcoin locks:** One position follows a lock across ratchets. Live BTC and pending mint use the current mark, while received liquidity excludes pending and burned mint. A securitization term's full net insurance cost is initially assigned to the first Liquid using that Bitcoin. Later Liquid, close, ratchet, or term events redistribute that fixed cost across the recorded periods of use; ordinary chain ticks do not change it. A completed release settles from its removal-time BTC mark, recorded redemption, Argon and Bitcoin fees, compensation, and removal time. Until settlement recovery completes, the observable value remains visible but its return is unavailable. An expired unspent UTXO is not presented as a live lock or returned BTC.
- **Stable swaps:** The Ethereum wallet owns its ARGN asset. Once Stable Swaps is activated, the same position is marked at the current pool price and enriched with purchase basis; no second swap asset is added. Return is unavailable when purchase history does not reconcile to the wallet quantity.

Historical recovery is asynchronous. Affected historical fields may be partial or unavailable while a domain repairs missing records, but recovery progress is not current-state readiness. App financial history is supported from runtime spec 137, the oldest runtime used by an app release.

## Known deficiencies

- **Mining ARGNOT attribution is incomplete:** Active mining rewards are included in net worth and mining income, but their historical attribution remains incomplete until the cohort closes.
- **Transaction fees are incomplete:** Mining cohort fees and Bitcoin operation fees are included where their domain records carry them. Vault, bond, stable-swap, and general wallet transaction fees are not yet assigned consistently to investment positions.
- **Reopened vaults are not supported:** Financial history assumes an operator account has one vault lifecycle.
