#!/usr/bin/env bash
# Estructural: scaffolders como su propia ultima instancia de la politica de
# cero warnings nuevos (#2411, MEF-ADR-0056).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAILS=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAILS=$((FAILS+1)); }

for a in domain-scaffolder mcp-scaffolder projections-scaffolder apim-gateway-scaffolder workos-identity-scaffolder infra-base-scaffolder; do
    f="$ROOT/src/published/agents/$a.md"
    sec=$(awk '/^## Cero warnings nuevos \(MEF-ADR-0056\)$/{p=1; next} p && /^## /{exit} p' "$f")
    if [ -z "$sec" ]; then fail "$a: sin seccion 'Cero warnings nuevos (MEF-ADR-0056)'"; continue; fi
    missing=""
    while IFS= read -r needle; do
        grep -qF -- "$needle" <<<"$sec" || missing="$missing [$needle]"
    done <<'NEEDLES'
SCAFFOLD_BASE=$(git rev-parse HEAD
{{mefisto:package-root}}/scripts/warnings-diff.sh --toolchain dotnet
{{mefisto:package-root}}/scripts/warnings-diff.sh --toolchain terraform
--path infra/environments/<env>
{{mefisto:package-root}}/scripts/warnings-diff.sh --toolchain shell
Salida `1`
#pragma warning disable
<NoWarn>
# shellcheck disable
json-value.mts" get "{{mefisto:config-path}}" repoSlug --or-empty
augusto-romero-arango/mefisto
gh issue list -R
gh issue create -R
gh issue comment
--label "estado:borrador,tipo:tooling,warning"
Remediar <codigo> en la plantilla de <agente>
{{mefisto:package-root}}/mefisto-manifest.json
Si `gh` falla
{{mefisto:state-path warnings-remanentes.txt}}
## Warnings remanentes
- Relacionado: owner/repo#N
NEEDLES
    if [ -z "$missing" ]; then pass "$a: seccion completa"; else fail "$a: faltan$missing"; fi
done

if grep -qF 'sin advertencias' "$ROOT/src/published/agents/projections-scaffolder.md"; then
    fail "projections-scaffolder aun afirma 'sin advertencias' por su cuenta"
else
    pass "projections-scaffolder remite a la seccion en vez de afirmar 'sin advertencias'"
fi

for c in install-apim install-workos install-auth; do
    f="$ROOT/src/published/commands/$c.md"
    L_PR=$(grep -n 'gh pr create --title' "$f" | head -1 | cut -d: -f1)
    L_W=$(grep -n '## Warnings remanentes' "$f" | tail -1 | cut -d: -f1)
    if [ -n "$L_PR" ] && [ -n "$L_W" ] && [ $((L_W - L_PR)) -ge 0 ] && [ $((L_W - L_PR)) -le 5 ]; then
        pass "$c: el paso de gh pr create copia '## Warnings remanentes' al body"
    else
        fail "$c: el paso de gh pr create no copia '## Warnings remanentes' (pr=$L_PR w=$L_W)"
    fi
done

if [ "$FAILS" -eq 0 ]; then echo "OK"; else echo "$FAILS fallo(s)"; exit 1; fi
