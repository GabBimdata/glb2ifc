#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LLAMA_DIR="${QWEN_LLAMA_CPP_DIR:-$ROOT/.tools/llama.cpp}"
BUILD_DIR="${QWEN_LLAMA_BUILD_DIR:-$LLAMA_DIR/build}"
MODEL_PATH="${QWEN_MODEL_PATH:-$ROOT/models/Qwen3-Reranker-0.6B-Q4_K_M.gguf}"
CMAKE_FLAGS=("-DLLAMA_BUILD_SERVER=ON" "-DCMAKE_BUILD_TYPE=Release")

for arg in "$@"; do
  case "$arg" in
    --cuda) CMAKE_FLAGS+=("-DGGML_CUDA=ON") ;;
    --vulkan) CMAKE_FLAGS+=("-DGGML_VULKAN=ON") ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v git >/dev/null || { echo "Missing git" >&2; exit 1; }
command -v cmake >/dev/null || { echo "Missing cmake" >&2; exit 1; }

if [[ ! -d "$LLAMA_DIR" ]]; then
  mkdir -p "$(dirname "$LLAMA_DIR")"
  git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "$LLAMA_DIR"
elif [[ -d "$LLAMA_DIR/.git" ]]; then
  git -C "$LLAMA_DIR" pull --ff-only
fi

cmake -S "$LLAMA_DIR" -B "$BUILD_DIR" "${CMAKE_FLAGS[@]}"
cmake --build "$BUILD_DIR" --config Release --target llama-server

LLAMA_SERVER_BIN=""
for candidate in \
  "$BUILD_DIR/bin/llama-server" \
  "$BUILD_DIR/bin/Release/llama-server" \
  "$BUILD_DIR/examples/server/llama-server"; do
  if [[ -x "$candidate" ]]; then
    LLAMA_SERVER_BIN="$candidate"
    break
  fi
done

if [[ -z "$LLAMA_SERVER_BIN" ]]; then
  LLAMA_SERVER_BIN="$(find "$BUILD_DIR" -type f -name 'llama-server' -perm -111 | head -n 1 || true)"
fi

if [[ -z "$LLAMA_SERVER_BIN" ]]; then
  echo "Could not find llama-server. Set QWEN_LLAMA_SERVER_BIN manually in .env.local." >&2
  exit 1
fi

mkdir -p "$(dirname "$MODEL_PATH")"
ENV_FILE="$ROOT/.env.local"
touch "$ENV_FILE"

upsert_env() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i.bak "s#^${key}=.*#${key}=${value}#" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

upsert_env QWEN_LLAMA_SERVER_BIN "$LLAMA_SERVER_BIN"
upsert_env QWEN_MODEL_PATH "$MODEL_PATH"
upsert_env QWEN_LLAMA_HOST "127.0.0.1"
upsert_env QWEN_LLAMA_PORT "8081"
upsert_env QWEN_LLAMA_CONTEXT "4096"
upsert_env QWEN_LLAMA_BATCH "1024"

cat <<MSG

Configured .env.local
QWEN_LLAMA_SERVER_BIN=$LLAMA_SERVER_BIN
QWEN_MODEL_PATH=$MODEL_PATH
MSG

if [[ ! -f "$MODEL_PATH" ]]; then
  cat <<MSG

Model file not found yet.
Place your Qwen3 reranker GGUF here:
  $MODEL_PATH
Any qwen3-reranker*.gguf file in ./models is also auto-detected by the app.
MSG
fi

cat <<MSG

Next:
  bun run dev
  bun run qwen:status
MSG
