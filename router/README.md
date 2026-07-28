# Router

The router is the public HTTP policy layer for an operator server. It owns authentication, member and invite state, and
the external API that coordinates with the internal bot service.

## Member Restore

Member restore lets an existing downstream repair missing upstream state without introducing another identity or
putting restore metadata on-chain.

The downstream is the sole holder of its opaque restore package. The router retains only its
mnemonic-derived, domain-separated sealing key; it does not store a copy of each member's package. Member
authentication continues to use the existing `//upstream-operator-auth` derived account.

### Initial issuance

1. The downstream claims an invite with its default account and derived upstream-auth account.
2. For the current treasury invite flow, the router activates the invite's coupon.
3. The router seals the member metadata needed for later restoration, including the coupon when present.
4. The invite response includes the opaque restore package.
5. The downstream persists the package with its upstream configuration.

If the router cannot seal the package, invite claiming fails instead of returning a partially recoverable connection.

### Normal login

1. The downstream requests a member challenge with its auth account ID and whether it still has a restore package.
2. The router checks whether the member and claimed invite state are present.
3. The router returns the normal challenge plus `restorePackageRequired`.
4. The downstream signs the challenge and submits the login.

When both sides still have their state, the opaque package is not uploaded and the login response does not contain a
replacement. Restore metadata is not attached to ordinary coupon, invite, or operations requests.

### Upstream restore

If the router is missing member or invite state and the downstream reported that it has a package:

1. The challenge sets `restorePackageRequired` to `true`.
2. The downstream includes its cached package in the signed login request.
3. The router verifies the existing auth challenge signature before decrypting or applying the package.
4. The router binds package decryption to the verified auth account ID and restores missing member and invite rows.
5. If the package contains a coupon and canonical bot state is missing, the router restores that coupon.
6. The router reads the resulting canonical coupon state and returns it with a freshly sealed package.
7. The downstream replaces its cached package and applies the canonical coupon state.

Restoration is idempotent. If a partial router/bot write fails, the next login can offer the same package again. If a
newer canonical coupon already exists, it wins; an older packaged coupon is used only to repair missing coupon state.

### Downstream package loss

If the downstream reports that it has no package while the upstream state is intact, the router does not need restore
metadata from the client. After the signed login succeeds, it creates a replacement package from canonical router and
bot state and returns it through the same restore result.

### Package contents and boundaries

The sealed package contains the operator-assigned member metadata needed to restore the claimed downstream record,
including its internal member ID, downstream name, operator `fromName`, invite code, default account ID, and the
currently supported Bitcoin coupon when present.

The package:

- is encrypted and authenticated with AES-256-GCM
- is bound to the member's verified upstream-auth account
- is off-chain and transport-agnostic
- does not contain an endpoint host, endpoint secret, chain recovery key, or endpoint key
- does not replace router discovery or the normal authenticated session

Future endpoint discovery must resolve and verify the router host before this handshake begins.

### Limitations

- If both the upstream state and the downstream package are lost, restore cannot reconstruct the missing metadata.
- Restore packages do not currently expire or support explicit revocation.
- A surviving upstream can issue a replacement after downstream-only package loss.
- An empty coupon list does not imply data loss because members may legitimately have no coupon. Isolated bot coupon
  loss therefore cannot trigger package restoration unless the router gains a durable indication that a coupon should
  exist.
- Restoration is lazy and per member; the router does not poll downstreams or fan out restoration.
