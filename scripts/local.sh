#!/usr/bin/env bash
# Install WhisperLiveKit from this checkout and start the server on Linux.
#
# Usage: scripts/run_local.sh [options] [-- extra wlk arguments]
#
#   -m, --model NAME      Whisper model (default: medium with an NVIDIA GPU, base otherwise)
#   -l, --language CODE   Transcription language, e.g. en, it, auto (default: auto)
#   -e, --extra NAME      PyTorch profile: cu129 or cpu (default: detected with nvidia-smi)
#       --host HOST       Bind address (default: localhost)
#   -p, --port PORT       Port (default: 8000)
#       --skip-sync       Start without installing dependencies again
#   -h, --help            Show this help
#
# Example:
#   scripts/run_local.sh --model small --language it
#   scripts/run_local.sh --language en -- --pcm-input
set -euo pipefail

cd "$(dirname "$0")/.."

model=""
language="auto"
extra=""
host="localhost"
port="8000"
skip_sync=0
wlk_args=()

usage() {
  sed -n '2,16s/^# \{0,1\}//p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model) model="$2"; shift 2 ;;
    -l|--language) language="$2"; shift 2 ;;
    -e|--extra) extra="$2"; shift 2 ;;
    --host) host="$2"; shift 2 ;;
    -p|--port) port="$2"; shift 2 ;;
    --skip-sync) skip_sync=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; wlk_args+=("$@"); break ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

has_gpu=0
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  has_gpu=1
fi
if [[ -z "$extra" ]]; then
  extra=$([[ $has_gpu -eq 1 ]] && echo cu129 || echo cpu)
fi
if [[ -z "$model" ]]; then
  model=$([[ $has_gpu -eq 1 ]] && echo medium || echo base)
fi

# uv manages the virtualenv and downloads a supported Python if needed.
if ! command -v uv >/dev/null 2>&1; then
  echo "==> uv not found, installing it for this user (https://astral.sh/uv)"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

if [[ $skip_sync -eq 0 ]]; then
  echo "==> Installing dependencies (extra: $extra)"
  uv sync --frozen --extra "$extra"
fi

# Without ffmpeg the browser must send raw PCM instead of WebM.
if ! command -v ffmpeg >/dev/null 2>&1 && [[ ! " ${wlk_args[*]-} " =~ " --pcm-input " ]]; then
  echo "==> ffmpeg not found: starting with --pcm-input (install it with: sudo apt install ffmpeg)"
  wlk_args+=("--pcm-input")
fi

echo "==> Starting server: model=$model language=$language"
echo "    Transcript: http://$host:$port/"
echo "    Subtitles:  http://$host:$port/subtitles"
exec uv run --frozen --no-sync wlk \
  --model "$model" --language "$language" --host "$host" --port "$port" \
  ${wlk_args[@]+"${wlk_args[@]}"}
