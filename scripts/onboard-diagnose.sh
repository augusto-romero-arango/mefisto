#!/usr/bin/env bash
# Shim: la implementacion vive en onboard-diagnose.mts (MEF-ADR-0057). No editar.
# Sin Node >= 22.18 el .mts no arranca y su fila de Node nunca se imprimiria.
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' 2>/dev/null; then
    echo "FALTA: Node >= 22.18 no esta en el PATH: /onboard y los hooks de Mefisto no corren." >&2
    echo "  Instala Node 22.18 o superior (https://nodejs.org/en/download) y repite /onboard." >&2
    exit 1
fi
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/onboard-diagnose.mts" "$@"
