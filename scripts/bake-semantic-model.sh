#!/bin/sh
# Bake the reference L2 embedding model into a bundle directory the semantic
# classifier can load via SEMANTIC_MODEL_PATH (add-semantic-dashboard task 4.1).
#
# This runs at IMAGE-BUILD time only — never at container runtime (the SSRF
# posture forbids runtime fetches). It downloads the weights + tokenizer from a
# COMMIT-PINNED source, verifies each against a pinned SHA-256 (a hijacked mirror
# or a moved tag fails the build), writes the classifier manifest, and records
# the redistributable license + provenance beside the files.
#
# Reference model: sentence-transformers/all-MiniLM-L6-v2 (Apache-2.0), ONNX
# export mirrored by Xenova/all-MiniLM-L6-v2. 384-dim, WordPiece, mean-pooled +
# L2-normalized — the family the bundled anchors were tuned against.
#
# Usage: sh bake-semantic-model.sh <output-dir>
set -eu

OUT="${1:?usage: bake-semantic-model.sh <output-dir>}"

# --- Pinned provenance (immutable HF commit + content checksums) -------------
REV="751bff37182d3f1213fa05d7196b954e230abad9"
BASE="https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/${REV}"
MODEL_URL="${BASE}/onnx/model.onnx"
MODEL_SHA="759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e"
VOCAB_URL="${BASE}/vocab.txt"
VOCAB_SHA="07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3"
LICENSE_NAME="Apache-2.0"
MODEL_SLUG="sentence-transformers/all-MiniLM-L6-v2"

# --- Portable helpers --------------------------------------------------------
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    echo "ERROR: no sha256 tool (sha256sum/shasum) available" >&2
    exit 1
  fi
}

fetch() {
  # fetch <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error --max-time 600 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    echo "ERROR: no downloader (curl/wget) available" >&2
    exit 1
  fi
}

verify() {
  # verify <file> <expected-sha256>
  got="$(sha256_of "$1")"
  if [ "$got" != "$2" ]; then
    echo "ERROR: checksum mismatch for $1" >&2
    echo "  expected $2" >&2
    echo "  got      $got" >&2
    exit 1
  fi
  echo "  ok  $(basename "$1")  sha256=$got"
}

mkdir -p "$OUT"

echo "Baking reference embedding model into ${OUT}"
echo "  source ${MODEL_SLUG} @ ${REV} (${LICENSE_NAME})"

fetch "$MODEL_URL" "$OUT/model.onnx"
verify "$OUT/model.onnx" "$MODEL_SHA"

fetch "$VOCAB_URL" "$OUT/vocab.txt"
verify "$OUT/vocab.txt" "$VOCAB_SHA"

# --- Classifier manifest (validated by the loader's strict schema at boot) ---
# I/O tensor names verified against the pinned ONNX graph: inputs input_ids /
# attention_mask / token_type_ids, output last_hidden_state (token embeddings).
cat > "$OUT/manifest.json" <<'JSON'
{
  "schemaVersion": 1,
  "tokenizer": {
    "type": "wordpiece",
    "vocabFile": "vocab.txt",
    "lowercase": true,
    "unkToken": "[UNK]",
    "clsToken": "[CLS]",
    "sepToken": "[SEP]",
    "padToken": "[PAD]",
    "maxTokens": 256
  },
  "model": {
    "file": "model.onnx",
    "inputNames": {
      "inputIds": "input_ids",
      "attentionMask": "attention_mask",
      "tokenTypeIds": "token_type_ids"
    },
    "outputName": "last_hidden_state",
    "outputKind": "token_embeddings",
    "dims": 384,
    "pooling": "mean",
    "normalize": true
  }
}
JSON

# --- Provenance + license record (redistribution requires attribution) -------
cat > "$OUT/MODEL-PROVENANCE.txt" <<EOF
Reference embedding model baked into the polyrouter -semantic image variant.

Model:     ${MODEL_SLUG}
Mirror:    Xenova/all-MiniLM-L6-v2 (ONNX export)
Revision:  ${REV}
License:   ${LICENSE_NAME} (permits redistribution)

Checksums (SHA-256), verified at image-build time:
  model.onnx  ${MODEL_SHA}
  vocab.txt   ${VOCAB_SHA}

Fetched at build time only. No file here is downloaded at container runtime.
Override by mounting your own bundle and pointing SEMANTIC_MODEL_PATH at it.
EOF

echo "Baked model.onnx + vocab.txt + manifest.json + MODEL-PROVENANCE.txt into ${OUT}"
