#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${QWEN_TOOLS_DIR:-$ROOT_DIR/.tools}"
LLAMA_DIR="${LLAMA_CPP_DIR:-$TOOLS_DIR/llama.cpp}"
BUILD_DIR="$LLAMA_DIR/build"
MODELS_DIR="$ROOT_DIR/models"
ENV_FILE="$ROOT_DIR/.env.local"
BACKEND="cpu"
INSTALL_DEPS=1
UPDATE_LLAMA=1

usage() {
  cat <<'EOF'
Usage:
  bash scripts/setup-qwen-linux.sh [--cuda|--vulkan] [--no-deps] [--no-update]

Examples:
  bun run qwen:setup        # CPU build
  bun run qwen:setup:cuda   # CUDA build, then use QWEN_GPU_LAYERS=auto
  bun run qwen:setup:vulkan # Vulkan build

The GGUF model is not downloaded by this script. Put it in ./models/.
Any qwen3-reranker*.gguf file is auto-detected by server.js.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cuda) BACKEND="cuda" ;;
    --vulkan) BACKEND="vulkan" ;;
    --cpu) BACKEND="cpu" ;;
    --no-deps) INSTALL_DEPS=0 ;;
    --no-update) UPDATE_LLAMA=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
  shift
done

need_cmd() { command -v "$1" >/dev/null 2>&1; }

install_deps_if_needed() {
  local missing=()
  need_cmd git || missing+=(git)
  need_cmd cmake || missing+=(cmake)
  need_cmd c++ || missing+=(build-essential)
  need_cmd curl || missing+=(curl)

  if [[ ${#missing[@]} -eq 0 ]]; then
    return
  fi

  if [[ "$INSTALL_DEPS" != "1" ]]; then
    echo "Missing tools: ${missing[*]}" >&2
    echo "Run: sudo apt update && sudo apt install -y cmake build-essential git curl" >&2
    exit 1
  fi

  if ! need_cmd apt; then
    echo "Missing tools: ${missing[*]}" >&2
    echo "This setup script can auto-install dependencies only on apt-based Linux." >&2
    exit 1
  fi

  echo "Installing build dependencies: ${missing[*]}"
  sudo apt update
  sudo apt install -y cmake build-essential git curl

  if [[ "$BACKEND" == "vulkan" ]]; then
    sudo apt install -y vulkan-tools libvulkan-dev
  fi
}

install_deps_if_needed
mkdir -p "$TOOLS_DIR" "$MODELS_DIR"

if [[ ! -d "$LLAMA_DIR/.git" ]]; then
  echo "Cloning llama.cpp into $LLAMA_DIR"
  git clone https://github.com/ggml-org/llama.cpp.git "$LLAMA_DIR"
elif [[ "$UPDATE_LLAMA" == "1" ]]; then
  echo "Updating llama.cpp in $LLAMA_DIR"
  git -C "$LLAMA_DIR" pull --ff-only || true
fi

cmake_flags=(
  -DCMAKE_BUILD_TYPE=Release
  -DLLAMA_BUILD_SERVER=ON
)

case "$BACKEND" in
  cuda)
    cmake_flags+=( -DGGML_CUDA=ON )
    ;;
  vulkan)
    cmake_flags+=( -DGGML_VULKAN=ON )
    ;;
  cpu)
    ;;
esac

echo "Building llama-server ($BACKEND)"
cmake -S "$LLAMA_DIR" -B "$BUILD_DIR" "${cmake_flags[@]}"
cmake --build "$BUILD_DIR" --config Release --target llama-server -j "$(nproc)"

LLAMA_SERVER_BIN="$BUILD_DIR/bin/llama-server"
if [[ ! -x "$LLAMA_SERVER_BIN" ]]; then
  LLAMA_SERVER_BIN="$(find "$BUILD_DIR" -name llama-server -type f -perm -111 | head -n 1 || true)"
fi

if [[ -z "$LLAMA_SERVER_BIN" || ! -x "$LLAMA_SERVER_BIN" ]]; then
  echo "Build finished, but llama-server was not found in $BUILD_DIR" >&2
  exit 1
fi

# Keep user custom values if already present; otherwise append project-local config.
touch "$ENV_FILE"
if ! grep -q '^QWEN_LLAMA_SERVER_BIN=' "$ENV_FILE"; then
  printf '\nQWEN_LLAMA_SERVER_BIN=%s\n' "$LLAMA_SERVER_BIN" >> "$ENV_FILE"
fi
if [[ "$BACKEND" == "cuda" || "$BACKEND" == "vulkan" ]]; then
  if ! grep -q '^QWEN_GPU_LAYERS=' "$ENV_FILE"; then
    printf 'QWEN_GPU_LAYERS=auto\n' >> "$ENV_FILE"
  fi
fi
if ! grep -q '^QWEN_RERANK_TIMEOUT_MS=' "$ENV_FILE"; then
  printf 'QWEN_RERANK_TIMEOUT_MS=120000\n' >> "$ENV_FILE"
fi
if ! grep -q '^QWEN_LLAMA_BATCH=' "$ENV_FILE"; then
  printf 'QWEN_LLAMA_BATCH=1024\n' >> "$ENV_FILE"
fi
if ! grep -q '^QWEN_STARTUP_TIMEOUT_MS=' "$ENV_FILE"; then
  printf 'QWEN_STARTUP_TIMEOUT_MS=120000\n' >> "$ENV_FILE"
fi

echo
echo "✅ llama-server ready: $LLAMA_SERVER_BIN"
echo "✅ Project env written: $ENV_FILE"
echo
if compgen -G "$MODELS_DIR/*.gguf" >/dev/null; then
  echo "✅ GGUF model found in $MODELS_DIR"
else
  echo "⚠️  No GGUF model found yet. Put your Qwen3 reranker GGUF in:"
  echo "   $MODELS_DIR/"
  echo "   Example accepted names:"
  echo "   - Qwen3-Reranker-0.6B-Q4_K_M.gguf"
  echo "   - qwen3-reranker-0.6b-q4_k_m.gguf"
fi

echo
echo "Next:"
echo "  bun dev"
