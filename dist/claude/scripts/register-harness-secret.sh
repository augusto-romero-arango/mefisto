#!/usr/bin/env bash
# Shim: la implementacion vive en register-harness-secret.mts (MEF-ADR-0057). No editar.
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/register-harness-secret.mts" "$@"
