#!/usr/bin/env bash
# Shim: la implementacion vive en herdr-workspace.mts (MEF-ADR-0057). No editar.
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/herdr-workspace.mts" "$@"
