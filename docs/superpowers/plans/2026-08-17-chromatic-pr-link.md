# Chromatic PR Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one visible pull-request comment updated with the current Chromatic review and published Storybook links.

**Architecture:** Extend the existing `Changed UI states` job after Chromatic publication. Use the runner's authenticated GitHub CLI to find the open pull request whose head matches the pushed in-repository branch, then create or update a marker-tagged comment without adding another action dependency.

**Tech Stack:** GitHub Actions YAML, Bash, GitHub CLI REST API, Chromatic action outputs

## Global Constraints

- Keep the existing push-only trigger and path filters.
- Keep workflow-level `contents: read` and grant `pull-requests: write` only to the `Changed UI states` job.
- Keep Chromatic publication authoritative; publish available review links without replacing its success or failure result.
- Update one marker-tagged comment instead of adding comments on every push.
- Skip comment creation when the pushed branch has no matching open pull request.
- Do not add another third-party GitHub Action dependency.

---

### Task 1: Publish Chromatic links in the pull request

**Files:**
- Modify: `.github/workflows/storybook.yml:17-97`

**Interfaces:**
- Consumes: `${{ steps.chromatic.outputs.buildUrl }}`, `${{ steps.chromatic.outputs.storybookUrl }}`, `${{ github.token }}`, `GITHUB_REPOSITORY`, `GITHUB_REPOSITORY_OWNER`, `GITHUB_REF_NAME`, and `GITHUB_SHA`
- Produces: one open pull-request comment containing the marker `<!-- chromatic-pr-links -->` and the two current Chromatic URLs

- [x] **Step 1: Extend workflow permissions**

Keep workflow-level `contents: read` and add the narrow pull-request permission only to the publishing job:

```yaml
  changed-ui-states:
    name: Changed UI states
    permissions:
      contents: read
      pull-requests: write
```

- [x] **Step 2: Add the non-blocking comment upsert step**

Add this step after `Link Storybook review`:

```yaml
      - name: Link Storybook in pull request
        if: always() && steps.chromatic.outputs.buildUrl != '' && steps.chromatic.outputs.storybookUrl != ''
        continue-on-error: true
        env:
          GH_TOKEN: ${{ github.token }}
          CHROMATIC_BUILD_URL: ${{ steps.chromatic.outputs.buildUrl }}
          CHROMATIC_STORYBOOK_URL: ${{ steps.chromatic.outputs.storybookUrl }}
        run: |
          pr_number=$(gh api --method GET "/repos/${GITHUB_REPOSITORY}/pulls" \
            -f state=open \
            -f head="${GITHUB_REPOSITORY_OWNER}:${GITHUB_REF_NAME}" \
            --jq 'first | .number // empty')

          if [[ -z "$pr_number" ]]; then
            echo "::notice::No open pull request was found for ${GITHUB_REF_NAME}."
            exit 0
          fi

          marker='<!-- chromatic-pr-links -->'
          body="${marker}
          ## Storybook review

          - [Review changed UI states](${CHROMATIC_BUILD_URL})
          - [Browse the complete PR Storybook](${CHROMATIC_STORYBOOK_URL})

          Updated for commit \`${GITHUB_SHA:0:7}\`."
          comment_id=$(gh api "/repos/${GITHUB_REPOSITORY}/issues/${pr_number}/comments" --paginate \
            --jq ".[] | select(.body | contains(\"${marker}\")) | .id" | head -n 1)

          if [[ -n "$comment_id" ]]; then
            gh api --method PATCH "/repos/${GITHUB_REPOSITORY}/issues/comments/${comment_id}" -f body="$body"
          else
            gh api --method POST "/repos/${GITHUB_REPOSITORY}/issues/${pr_number}/comments" -f body="$body"
          fi
```

- [x] **Step 3: Validate formatting and workflow structure**

Run:

```bash
yarn prettier --check .github/workflows/storybook.yml
git diff --check
```

Expected: both commands exit successfully.

- [x] **Step 4: Review the permission and failure boundary**

Confirm the final diff contains only the new `pull-requests: write` permission and the non-blocking upsert step, with no `pull_request_target` trigger and no new action dependency.

- [x] **Step 5: Commit**

```bash
git add .github/workflows/storybook.yml docs/superpowers/plans/2026-08-17-chromatic-pr-link.md
git commit -m "ci: expose Chromatic links in pull requests" -m "Keep one current Storybook review comment visible on each in-repository pull request after Chromatic publishes successfully."
```
