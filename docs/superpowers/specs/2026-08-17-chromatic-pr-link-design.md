# Chromatic PR Link Design

## Goal

Make every initialized Chromatic build with review URLs discoverable from the pull request conversation without requiring reviewers to open the GitHub Actions job summary.

## Design

After the existing `Changed UI states` job initializes a Chromatic build and receives its review URLs, it will locate the open pull request whose head matches the pushed in-repository branch and create or update one marked comment. The comment will link to both the Chromatic review build and the complete published Storybook, including when Chromatic reports a component error.

The workflow will update the same comment after later pushes so each pull request has one current review entry instead of accumulating comments. The existing job summary links will remain as a secondary location.

## Permissions and boundaries

The workflow will add only the minimum permission needed to write the pull-request comment. It will continue to run on matching branch pushes so repository secrets remain unavailable to untrusted fork workflows; fork pull requests will not publish or receive this comment. If a pushed branch has no matching open pull request, publication still succeeds and comment creation is skipped.

## Failure behavior

Publishing Storybook remains the authoritative job result. A failed Chromatic build remains failed, but its available review links are still published. A failure to find or update a pull-request comment is reported clearly without replacing the Chromatic result.

## Verification

Validate the workflow syntax and comment script locally where possible. Confirm that the next pushed build updates one marked comment with non-empty Chromatic build and Storybook URLs, while subsequent pushes update that comment rather than creating another.
