# Chromatic PR Link Design

## Goal

Make every successful Chromatic publication discoverable from the pull request conversation without requiring reviewers to open the GitHub Actions job summary.

## Design

After the existing `Changed UI states` job publishes Storybook, it will locate the open pull request associated with the pushed commit and create or update one marked comment. The comment will link to both the Chromatic review build and the complete published Storybook.

The workflow will update the same comment after later pushes so each pull request has one current review entry instead of accumulating comments. The existing job summary links will remain as a secondary location.

## Permissions and boundaries

The workflow will add only the minimum permission needed to write the pull-request comment. It will continue to run on matching branch pushes so repository secrets remain unavailable to untrusted fork workflows; fork pull requests will not publish or receive this comment. If a pushed commit has no associated open pull request, publication still succeeds and comment creation is skipped.

## Failure behavior

Publishing Storybook remains the authoritative job result. A failure to find or update a pull-request comment will be reported clearly without invalidating a successful Chromatic build.

## Verification

Validate the workflow syntax and comment script locally where possible. Confirm that the next pushed build updates one marked comment with non-empty Chromatic build and Storybook URLs, while subsequent pushes update that comment rather than creating another.
