#!/usr/bin/env bash
# Shim: la implementacion vive en purge-store.mts (MEF-ADR-0057). No editar.
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/purge-store.mts" "$@"
