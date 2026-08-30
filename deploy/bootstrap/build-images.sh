#!/usr/bin/env bash
# Build the four application images.
set -euo pipefail
cd "$(dirname "$0")/../.."

TAG="${IMAGE_TAG:-dev}"

build() {
  local name="$1" path="$2" target="${3:-runtime}"
  echo "── building qosfc/lottery-${name}:${TAG} ──"
  docker build \
    --target "${target}" \
    --build-arg "TARGET=${name}" \
    --build-arg "TARGET_PATH=${path}" \
    -t "qosfc/lottery-${name}:${TAG}" .
}

# worker-recon runs OCR over untrusted PDFs, so it alone gets the OCR toolchain.
build worker            apps/worker/dist/index.js              worker-ocr
build api               apps/api/dist/index.js
build admin             apps/admin/dist/index.js
build codec-server      services/codec-server/dist/index.js
build sandbox-providers services/sandbox-providers/dist/index.js

echo ""
echo "Built. Scan before deploying:"
echo "  trivy image --severity HIGH,CRITICAL qosfc/lottery-worker:${TAG}"
