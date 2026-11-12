#!/usr/bin/env bash
# Shim: la implementacion vive en mefisto-launch-pipeline.mts (MEF-ADR-0057). No editar.
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/mefisto-launch-pipeline.mts" "$@"
