#!/usr/bin/env bash
# frontmatter.sh -- Extraccion del frontmatter JSON y del body de un artefacto
# neutral src/internal/{agents,commands}/<id>.md (MEF-ADR-0049 CA-6, issues
# #853 y #854). Regla de corte del bloque '---' para los scripts en bash.
#
# Gemela de lib/frontmatter.mts, la que usan el validador y el generador
# (MEF-ADR-0057); validate-internal-artifacts.test.mts compara las dos.
#
# Uso: source "$(dirname "${BASH_SOURCE[0]}")/frontmatter.sh"

# extract_frontmatter <archivo> -- imprime por stdout el bloque JSON entre la
# primera linea ("---") y la siguiente linea que sea exactamente "---". Un
# objeto JSON nunca contiene una linea que sea solo "---", asi que el corte es
# robusto sin necesitar un parser JSON para encontrar el limite.
# Exit: 0 bloque delimitado, 1 la primera linea no es "---", 2 falta el cierre.
extract_frontmatter() {
    awk '
        NR==1 { if ($0 != "---") { bad=1; exit 1 } ; next }
        $0 == "---" { closed=1; exit 0 }
        { print }
        END { if (bad) exit 1; if (!closed) exit 2 }
    ' "$1"
}

# extract_body <archivo> -- imprime por stdout todo lo que sigue a la linea de
# cierre del frontmatter (incluida la linea en blanco separadora, si el
# archivo la tiene).
# Exit: 0 si se encontro el cierre, 1 si la primera linea no es "---", 2 si no
# hay cierre.
extract_body() {
    awk '
        NR==1 { if ($0 != "---") { bad=1; exit 1 } ; next }
        $0 == "---" && !closed { closed=1; next }
        closed { print }
        END { if (bad) exit 1; if (!closed) exit 2 }
    ' "$1"
}
