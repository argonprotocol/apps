#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <archive-prefix> [macos-bundle-name]" >&2
  exit 1
fi

archive_prefix="$1"
bundle_name="${2:-}"
target_dir="${GITHUB_WORKSPACE:?}/src-tauri/target"
release_dir="$target_dir/release"
archive="$RUNNER_TEMP/${archive_prefix}_${VERSION}_${RUNNER_OS}-symbols.tar.gz"
symbol_dir="$RUNNER_TEMP/${archive_prefix//[^A-Za-z0-9._-]/_}-${RUNNER_OS}-symbols"

rm -rf "$symbol_dir"
mkdir -p "$symbol_dir"

found_symbols=0

case "$RUNNER_OS" in
  Windows)
    while IFS= read -r -d '' source_path; do
      found_symbols=1
      relative_path="${source_path#$release_dir/}"
      mkdir -p "$symbol_dir/$(dirname "$relative_path")"
      cp "$source_path" "$symbol_dir/$relative_path"
    done < <(find "$release_dir" -type f -name '*.pdb' -print0)

    if [ "$found_symbols" -eq 0 ]; then
      find "$release_dir" -type f -print
      echo "Missing PDB files under $release_dir" >&2
      exit 1
    fi
    ;;
  macOS)
    if [ -z "$bundle_name" ]; then
      echo "Missing macOS bundle name for dSYM collection" >&2
      exit 1
    fi

    while IFS= read -r -d '' source_path; do
      found_symbols=1
      relative_path="${source_path#$target_dir/}"
      mkdir -p "$symbol_dir/$(dirname "$relative_path")"
      cp -R "$source_path" "$symbol_dir/$relative_path"
    done < <(find "$target_dir" -type d -name "$bundle_name.app.dSYM" -print0)

    if [ "$found_symbols" -eq 0 ]; then
      find "$target_dir" -type d -name '*.dSYM' -print
      echo "Missing $bundle_name.app.dSYM under $target_dir" >&2
      exit 1
    fi
    ;;
  Linux)
    while IFS= read -r -d '' binary_path; do
      found_symbols=1
      relative_path="${binary_path#$release_dir/}"
      debug_path="$symbol_dir/${relative_path}.debug"
      mkdir -p "$(dirname "$debug_path")"
      objcopy --only-keep-debug "$binary_path" "$debug_path"
    done < <(find "$release_dir" -maxdepth 1 -type f -name 'Argon' -print0)

    if [ "$found_symbols" -eq 0 ]; then
      find "$release_dir" -maxdepth 1 -type f -print
      echo "Missing Argon binary under $release_dir" >&2
      exit 1
    fi
    ;;
  *)
    echo "Unsupported runner OS: $RUNNER_OS" >&2
    exit 1
    ;;
esac

tar -czf "$archive" -C "$symbol_dir" .
gh release upload "$VERSION" "$archive" --clobber
