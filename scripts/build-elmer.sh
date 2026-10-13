#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <elmer-source-dir> <install-prefix>" >&2
  exit 2
fi

source_dir=$(cd "$1" && pwd)
install_prefix=$(mkdir -p "$2" && cd "$2" && pwd)
build_dir="${install_prefix%/*}/build-elmer"

cmake -S "$source_dir" -B "$build_dir" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$install_prefix" \
  -DCMAKE_Fortran_COMPILER="${FC:-gfortran}" \
  -DBLA_VENDOR=OpenBLAS \
  -DWITH_MPI:BOOL=OFF \
  -DWITH_OpenMP:BOOL=OFF \
  -DWITH_ElmerIce:BOOL=OFF \
  -DWITH_LUA:BOOL=OFF \
  -DWITH_ELMERGUI:BOOL=OFF \
  -DWITH_ELMERPOST:BOOL=OFF \
  -DWITH_VTK:BOOL=OFF \
  -DWITH_Mumps:BOOL=OFF
cmake --build "$build_dir" --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-2}"
cmake --install "$build_dir"

for executable in ElmerGrid ElmerSolver; do
  if [[ ! -x "$install_prefix/bin/$executable" && ! -x "$install_prefix/bin/$executable.exe" ]]; then
    echo "Elmer build did not install $executable" >&2
    exit 1
  fi
done
