# Workflow dependencies

Action commits and their transitive dependencies are pinned in
`.github/workflows/actions.lock`. Generate this file with GitHub's CLI extension;
do not edit it by hand.

```sh
gh extension install github/gh-actions-lock --pin v0.4.0
gh actions-lock
gh actions-lock --verify
```

Run these commands after adding a workflow or changing an action reference. The
verification workflow checks changes to workflows and action definitions on pull
requests and pushes to `main`. Dependabot updates the matching lockfile entries
when it updates actions in onboarded workflows.

Use `$/` for this repository's composite actions so their dependencies are included
in the lockfile. These references use the workflow's commit, independently of the
workspace checkout. Run `gh actions-lock --migrate-local-actions` to migrate a new
`./` reference.

Keep direct action references on semantic-version tags. Dependabot does not create
security alerts for SHA references; the immutable commits belong in the lockfile.
`open-pull-requests-limit: 0` keeps routine version-update PRs disabled while
allowing security-update PRs when repository security updates are enabled.

The migration preserves existing action commits except for Rust toolchain `v1`
and Rust cache `v2.9.1`, which replace previously untagged pins. The Rust cache tag
has identical executable files to the previous pin. Rust toolchain `v1` includes
upstream input-handling and installation fixes and retains our explicit stable
toolchain and target inputs.

Review changed commits and repository identities in lockfile diffs. To
intentionally advance a moving branch or tag, review its upstream changes before
running `gh actions-lock --relock`.
