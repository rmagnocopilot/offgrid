#!/usr/bin/env bash
set -euo pipefail

TAG="${TAG:-models-v1}"
CHUNK_SIZE="${CHUNK_SIZE:-1900M}"
MODEL_DIR="${1:-models-local}"

command -v gh >/dev/null || { echo "Instale o GitHub CLI (gh)."; exit 1; }
command -v split >/dev/null || { echo "O comando split é obrigatório."; exit 1; }

gh release view "$TAG" >/dev/null 2>&1 || gh release create "$TAG" --title "Modelos GGUF para Offgrid"

for file in \
  qwen2.5-coder-3b-instruct-q4_k_m.gguf \
  qwen2.5-coder-7b-instruct-q4_k_m.gguf; do
  source_path="$MODEL_DIR/$file"
  [[ -f "$source_path" ]] || { echo "Ignorando: $source_path não encontrado"; continue; }
  temp_dir="$(mktemp -d)"
  split -b "$CHUNK_SIZE" -d -a 2 "$source_path" "$temp_dir/$file.part-"
  gh release upload "$TAG" "$temp_dir"/$file.part-* --clobber
  rm -rf "$temp_dir"
done
