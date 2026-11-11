#!/usr/bin/env bash
# mefisto-deps.sh -- Lectura de la seccion '## Dependencias' de un issue.
#
# Tercer consumidor del mismo awk|grep (MEF-ADR-0018, regla de tres): lo usan
# mefisto-next-order.sh (orden de lanzamiento y de refinamiento) y
# mefisto-validate-batch-deps.sh. Se mantiene aparte de _mefisto-common.sh para
# que estos scripts de solo lectura no carguen la libreria de pipelines.
#
# Solo dependencias FORWARD ('Depende de #N' / 'Bloqueado por #N',
# case-insensitive) y solo cuando el marcador esta AL INICIO del item (tras
# espacios y una vineta '-' o '*' opcional); por linea se toma unicamente el
# primer numero. 'No depende de #N', 'Ya no depende de #N' y el marcador a mitad
# de linea no cuentan; 'Bloquea', 'Consumido por' y la prosa libre se ignoran.
# Todas leen el body por stdin. No invocar directamente (sourceable).
#
# Gemela de scripts/lib/issue-dependencies.mts (MEF-ADR-0057): un cambio de la
# regla va en los dos lados.

# El texto de la seccion, sin su encabezado; vacio si no existe.
mefisto_dependencies_section() {
    awk '/^##[[:space:]]*[Dd]ependencias/{f=1;next} /^##[[:space:]]/{f=0} f'
}

# Numeros de las dependencias forward, uno por linea, ascendentes y sin repetir.
mefisto_forward_dependencies() {
    mefisto_dependencies_section \
        | grep -ioE '^[[:space:]]*([-*][[:space:]]+)?(Depende de|Bloqueado por)[[:space:]]+#[0-9]+' \
        | grep -oE '[0-9]+' | sort -u
}

# 0 si el body declara la seccion '## Dependencias', aunque este vacia.
mefisto_has_dependencies_section() {
    grep -qE '^##[[:space:]]*[Dd]ependencias'
}
