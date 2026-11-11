#!/usr/bin/env bash
# Shim: la implementacion vive en generate-claude-hooks.mts (MEF-ADR-0057). No editar.
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/generate-claude-hooks.mts" "$@"
