# Storage subscription patch

The Polkadot.js patch keeps unchanged account values available while a storage subscription is active. This prevents an unchanged certified operational account from appearing absent when another subscribed value changes.

## Why values disappeared

Storage subscriptions receive an initial snapshot, then updates containing only changed keys. Polkadot.js combines those updates with previously decoded values to publish a complete result.

In `@polkadot/rpc-core` 17.0.1, those previous values come from a shared cache. Entries can expire after 30 seconds, be evicted by other queries, or be replaced by historical reads. A later update that omits the account key can therefore publish an empty account even though the account still exists on chain.

For the certification subscription, the sequence is:

1. The initial snapshot contains a certified operational account and treasury positions.
2. The shared cache loses the account entry.
3. Treasury positions change, and the next notification contains only those positions.
4. The decoder fills the omitted account with `None`, causing certification progress to appear incomplete.

The regression reproduces this mechanism with synthetic accounts and real storage codecs. It matches the reported symptoms; the affected session's notification was not captured.

## What changed

Each underlying subscription now owns a map of its decoded storage values. The map is created when that subscription starts and cleared during teardown.

| Event | Result after the patch |
| --- | --- |
| A notification omits an unchanged key | Retain that subscription's previous value |
| A notification explicitly deletes a key | Publish the deletion |
| An unrelated query expires or evicts shared cache entries | Active subscription values stay available |
| A historical query or overlapping subscription reads the same key | Keep each subscription's values separate |
| A full snapshot arrives after reconnect | Apply the supplied current values |
| A subscription ends | Clear its map and ignore late callbacks |

The essential code change is the cache's owner:

```js
// Before: every subscription reconstructs omitted keys from a shared cache.
const cached = this.#storageCache.get(hexKey);

// After: create this map inside the subscription's Observable activation.
const storageCache = new Map();

// Pass that map through decoding, and use it for omitted keys and updates.
const cached = storageCache.get(hexKey);
storageCache.set(hexKey, codec);

// Clear it when the underlying subscription is torn down.
storageCache.clear();
```

This excerpt shows the changed operations; they live in separate parts of the decoder. Ordinary queries continue using the existing bounded shared cache. The subscription map holds at most one value per requested key, so storage follows active subscriptions rather than query history.

## Where the patch lives

The `.patch` file in this directory modifies both the ESM and CommonJS builds of `@polkadot/rpc-core`. The root `package.json` resolution selects it, and `yarn.lock` records its checksum. Yarn applies it during installation; no manual edits to `node_modules` are needed.

The behavioral regression is `runtime-client/__test__/storageSubscriptions.test.ts`. It exercises real RPC decoding through cache expiry, capacity eviction, historical reads, overlapping subscriptions, deletion, replacement snapshots, and teardown. Only provider transport and time are mocked. Both module builds fail on the original dependency and pass with the patch.

When upgrading Polkadot.js, check whether upstream has fixed subscription value retention. Remove or regenerate this version-specific patch as appropriate, then run the regression against the installed dependency.
