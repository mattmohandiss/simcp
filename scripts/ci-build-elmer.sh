#!/usr/bin/env bash
set -euo pipefail

revision=${ELMER_REVISION:?ELMER_REVISION must be set from flake.lock}
temp_dir="$RUNNER_TEMP"
workspace="$GITHUB_WORKSPACE"
if command -v cygpath >/dev/null 2>&1; then
  temp_dir=$(cygpath -u "$temp_dir")
  workspace=$(cygpath -u "$workspace")
fi

git clone --filter=blob:none https://github.com/ElmerCSC/elmerfem.git "$temp_dir/elmer-source"
git -C "$temp_dir/elmer-source" checkout "$revision"
git -C "$temp_dir/elmer-source" submodule update --init --recursive

if [[ -n "${MINGW_PREFIX:-}" ]]; then
  export CMAKE_PREFIX_PATH="$MINGW_PREFIX${CMAKE_PREFIX_PATH:+:$CMAKE_PREFIX_PATH}"
  export PKG_CONFIG_PATH="$MINGW_PREFIX/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
fi

bash scripts/build-elmer.sh "$temp_dir/elmer-source" "$workspace/.runtime-cache/elmer"
