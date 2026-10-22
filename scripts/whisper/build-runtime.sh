#!/usr/bin/env bash
# Builds the CPU-only whisper.cpp runtime shipped under resources/whisper/<platform>-x64.
# Same configuration as the official whisper.cpp Windows x64 release (runtime CPU dispatch, no GPU):
#   BUILD_SHARED_LIBS=ON GGML_NATIVE=OFF GGML_BACKEND_DL=ON GGML_CPU_ALL_VARIANTS=ON, plus GGML_OPENMP=OFF
#   so the Windows build has no libgomp/libwinpthread DLL dependencies (ggml's own thread pool is used).
#
# Usage: scripts/whisper/build-runtime.sh <path-to-whisper.cpp-source-v1.9.1> [linux|win|all]
# Requirements: cmake ≥ 3.5, gcc/g++ (Linux target), x86_64-w64-mingw32-g++-posix (Windows target).
# The MinGW toolchain file is scripts/whisper/mingw-x64.cmake. MinGW-w64 headers ≤ 11 lack the
# THREAD_POWER_THROTTLING_STATE declarations used by ggml-cpu.c; scripts/whisper/mingw-header.patch adds them.
set -euo pipefail
SRC="${1:?whisper.cpp source dir}"
TARGET="${2:-all}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../resources/whisper"
COMMON=(-DBUILD_SHARED_LIBS=ON -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON -DGGML_OPENMP=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_SDL2=OFF -DCMAKE_BUILD_TYPE=Release)
TARGETS=(whisper-server whisper-cli whisper-bench)
if [[ "$TARGET" == "linux" || "$TARGET" == "all" ]]; then
  cmake -S "$SRC" -B "$SRC/build-linux" "${COMMON[@]}"
  cmake --build "$SRC/build-linux" --config Release -j"$(nproc)" --target "${TARGETS[@]}"
  mkdir -p "$OUT/linux-x64" && cp "$SRC"/build-linux/bin/*.so* "$SRC"/build-linux/bin/whisper-{server,cli,bench} "$OUT/linux-x64/"
fi
if [[ "$TARGET" == "win" || "$TARGET" == "all" ]]; then
  (cd "$SRC" && git apply --check "$HERE/mingw-header.patch" 2>/dev/null && git apply "$HERE/mingw-header.patch" || true)
  cmake -S "$SRC" -B "$SRC/build-win" -DCMAKE_TOOLCHAIN_FILE="$HERE/mingw-x64.cmake" "${COMMON[@]}"
  cmake --build "$SRC/build-win" --config Release -j"$(nproc)" --target "${TARGETS[@]}"
  mkdir -p "$OUT/win-x64" && cp "$SRC"/build-win/bin/*.dll "$SRC"/build-win/bin/whisper-{server,cli,bench}.exe "$OUT/win-x64/"
fi
echo "done → $OUT"
