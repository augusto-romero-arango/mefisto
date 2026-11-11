#!/usr/bin/env bash
# Shim de compatibilidad (MEF-ADR-0049): la implementacion canonica vive en src/internal/scripts/lib/_mefisto-common.sh. No editar.
# `source` (no `exec`): esta lib se sourcea desde otros scripts, nunca se ejecuta sola.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/src/internal/scripts/lib/_mefisto-common.sh"
