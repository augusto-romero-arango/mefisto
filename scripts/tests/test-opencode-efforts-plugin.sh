#!/usr/bin/env bash
# Entrada pública estable para la prueba que vive junto al adaptador.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec bash "$SCRIPT_DIR/../../src/published/scripts/tests/test-opencode-efforts-plugin.sh"
