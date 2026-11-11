#!/usr/bin/env bash
# test-mefisto-field-note.sh -- El gate de neutralidad sale 0 sobre el repo real.
#
# Los casos de mefisto-field-note viven en mefisto-field-note.test.mts.
#
# Uso: .claude/scripts/tests/test-mefisto-field-note.sh
# Exit code: 0 si el chequeo pasa, 1 si falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
GATE="$REPO_ROOT/src/internal/scripts/mefisto-neutrality-gate.sh"

echo "[pre] mefisto-neutrality-gate.sh sale 0 sobre el repo real"
if GATE_OUT=$(bash "$GATE" 2>&1); then
    echo "  PASS: mefisto-neutrality-gate.sh: exit 0"
    exit 0
fi
echo "  FAIL: mefisto-neutrality-gate.sh: exit != 0 -- $GATE_OUT"
exit 1
