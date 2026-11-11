#!/usr/bin/env bash
# Shim: la implementacion vive en azure-account-info.mts (MEF-ADR-0057). No editar.
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/azure-account-info.mts" "$@"
