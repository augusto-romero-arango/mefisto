#!/usr/bin/env bash
# Entrada estable de la suite interna: el contrato canonico vive en src/runtime/.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
exec bash "$ROOT/src/runtime/tests/test-efforts.sh"
