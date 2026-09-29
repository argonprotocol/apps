#!/usr/bin/env bash
set -euo pipefail

phase=$1
shift
mkdir -p "$CI_TEMP_DIR"
started=$SECONDS
trap '
  status=$?
  elapsed=$((SECONDS - started))
  printf "%s\t%s\t%s\n" "$phase" "$elapsed" "$status" >> "$CI_TEMP_DIR/phase-timings.tsv"
  printf "%s: %ss (exit %s)\n\n" "$phase" "$elapsed" "$status" >> "$GITHUB_STEP_SUMMARY"
  df -h "$CI_TEMP_DIR" | sed "s/^/    /" >> "$GITHUB_STEP_SUMMARY" || true
  printf "\n" >> "$GITHUB_STEP_SUMMARY"
  exit "$status"
' EXIT
"$@"
