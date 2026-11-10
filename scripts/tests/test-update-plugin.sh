#!/usr/bin/env bash
# test-update-plugin.sh -- Tests de scripts/update-plugin.sh (issue #531).
#
# Cubre la parte del script que no se puede probar a mano sin arriesgar el cache real de
# plugins ni invocar el CLI 'claude': la seleccion de que versiones se borran. El
# invariante que protege (CA-4) es que la poda NUNCA borra la version que la sesion
# activa tiene cargada -- si el skill en ejecucion se borra a si mismo, la sesion rompe a
# mitad de camino.
#
#   S-1: _protegidas() conserva {nueva, cargada} y, cuando la version cargada es
#        desconocida, infiere y protege la N-1 en vez de dejarla podable.
#   S-2: _podables() es la diferencia de conjuntos (todas - protegidas): poda las viejas
#        acumuladas y nunca la cargada, ni cuando la cargada NO es la N-1 (el caso de dos
#        corridas de /mefisto:upgrade en la misma sesion, que es el que rompia cuando la
#        version cargada se re-leia de .plugin-root ya reescrito).
#   S-3: _marketplace_dir() detecta el marketplace sin hardcodear su nombre (CA-2):
#        derivandolo del .plugin-root cargado, o por glob sobre el cache, y falla cuando
#        no hay ningun 'mefisto'.
#   S-4: el modo ACTUALIZAR califica el nombre del plugin con su marketplace al invocar
#        el CLI (issue #601): 'claude plugin update mefisto@<marketplace> --scope user',
#        no 'mefisto' a secas -- el CLI rechaza el nombre sin calificar. Es el unico
#        bloque que corre main() end-to-end.
#   S-7: el marcador canonico .mefisto/pipeline/.plugin-root (issue #2248): la poda
#        conserva su version en el modo actualizar y en --prune, y el modo actualizar no
#        lo reescribe; con el marcador ausente el comportamiento no cambia.
#   S-8: caso ControlAsistencia end-to-end por upgrade.sh (issue #2249): con .previous
#        viejo (0.44.0), MEFISTO_LOADED_ROOT valida (0.44.1) gana y 0.44.1 no es podable.
#
# El script se sourcea (no se ejecuta): scripts/update-plugin.sh solo corre su main()
# cuando BASH_SOURCE[0] == $0, asi que sourcearlo aqui carga las funciones sin disparar el
# guard cwd != Mefisto ni el update real. S-4 llama a main() a proposito, pero en un
# subshell con las tres fronteras peligrosas neutralizadas: cwd de mentira (git repo
# temporal sin .claude-plugin/plugin.json), cache de mentira (MEFISTO_CACHE_ROOT) y un
# stub de 'claude' antepuesto al PATH -- nunca se toca el cache real ni se invoca el CLI.
#
# Uso: scripts/tests/test-update-plugin.sh
# Exit code: 0 si todos los chequeos pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# assert_igual <esperado> <obtenido> <descripcion>
assert_igual() {
    if [ "$1" = "$2" ]; then
        pass "$3"
    else
        fail "$3 (esperado: '$1' / obtenido: '$2')"
    fi
}

# assert_contiene <texto> <fragmento> <descripcion>
assert_contiene() {
    case "$1" in
        *"$2"*) pass "$3" ;;
        *) fail "$3 (no se encontro: '$2')" ;;
    esac
}

source "$REPO_ROOT/scripts/update-plugin.sh"

# Cache real observado en el issue #531 (0.10.0 ... 0.19.0), mas la version recien traida.
TODAS=$'0.10.0\n0.15.0\n0.16.0\n0.17.0\n0.18.0\n0.19.0'
TODAS_TRAS_UPDATE="$TODAS"$'\n0.20.0'

echo "[S-1] _protegidas(): conserva {nueva, cargada} e infiere la N-1 si no la conoce"

salida=$(printf '%s\n' "$TODAS_TRAS_UPDATE" | _protegidas "0.20.0" "0.19.0" "0.20.0" | tr '\n' ' ')
assert_igual "0.19.0 0.20.0 " "$salida" "protege exactamente {cargada 0.19.0, nueva 0.20.0}"

# Version cargada desconocida: se infiere la N-1 (la mas nueva distinta de la nueva).
salida=$(printf '%s\n' "$TODAS" | _protegidas "0.19.0" "" "" | tr '\n' ' ')
assert_igual "0.18.0 0.19.0 " "$salida" "sin version cargada conocida protege la N-1 (0.18.0)"

# .plugin-root apuntando a una tercera version (marker desactualizado): se suma, no se
# reemplaza -- conservar una version de mas es preferible a borrar la cargada.
salida=$(printf '%s\n' "$TODAS" | _protegidas "0.19.0" "0.17.0" "0.18.0" | tr '\n' ' ')
assert_igual "0.17.0 0.18.0 0.19.0 " "$salida" "protege la union {nueva, cargada, .plugin-root}"

# Caso ControlAsistencia (#2248): canonico apunta a 0.44.0, nueva y cargada 0.44.1.
CA_TODAS=$'0.43.0\n0.44.0\n0.44.1'
salida=$(printf '%s\n' "$CA_TODAS" | _protegidas "0.44.1" "0.44.1" "0.44.1" "0.44.0" | tr '\n' ' ')
assert_igual "0.44.0 0.44.1 " "$salida" "protege la version del marcador canonico (0.44.0)"
salida=$(printf '%s\n' "$CA_TODAS" | _podables $(printf '%s\n' "$CA_TODAS" | _protegidas "0.44.1" "0.44.1" "0.44.1" "0.44.0") | tr '\n' ' ')
assert_igual "0.43.0 " "$salida" "con canonico 0.44.0 solo 0.43.0 es podable"
salida=$(printf '%s\n' "$CA_TODAS" | _podables $(printf '%s\n' "$CA_TODAS" | _protegidas "0.44.1" "0.44.1" "0.44.1" "") | tr '\n' ' ')
assert_igual "0.43.0 0.44.0 " "$salida" "canonico ausente: comportamiento sin cambio"

echo ""
echo "[S-2] _podables(): diferencia de conjuntos, y nunca la version cargada"

salida=$(printf '%s\n' "$TODAS" | _podables 0.19.0 0.20.0 | tr '\n' ' ')
assert_igual "0.10.0 0.15.0 0.16.0 0.17.0 0.18.0 " "$salida" "poda las 5 viejas acumuladas"

# Dos corridas de /mefisto:upgrade en la misma sesion: la sesion sigue con 0.18.0 cargada
# aunque .plugin-root ya apunte a 0.19.0. 0.18.0 NO puede quedar podable.
salida=$(printf '%s\n' "$TODAS" | _podables $(printf '%s\n' "$TODAS" | _protegidas "0.19.0" "0.18.0" "0.19.0") | tr '\n' ' ')
assert_igual "0.10.0 0.15.0 0.16.0 0.17.0 " "$salida" "la cargada (0.18.0) queda fuera de la poda aunque no sea la nueva"

salida=$(printf '%s\n' $'0.19.0\n0.20.0' | _podables 0.19.0 0.20.0)
assert_igual "" "$salida" "cache ya limpio: no hay nada podable"

echo ""
echo "[S-3] _marketplace_dir(): deteccion sin hardcodear el nombre del marketplace"

FAKE_CACHE="$(mktemp -d)"
trap 'rm -rf "$FAKE_CACHE"' EXIT
mkdir -p "$FAKE_CACHE/un-fork-cualquiera/mefisto/0.19.0"

salida=$(_marketplace_dir "$FAKE_CACHE/un-fork-cualquiera/mefisto/0.19.0" "$FAKE_CACHE")
assert_igual "$FAKE_CACHE/un-fork-cualquiera/mefisto" "$salida" "lo deriva del .plugin-root cargado (fork con otro marketplace)"

salida=$(_marketplace_dir "" "$FAKE_CACHE" 2>/dev/null)
assert_igual "$FAKE_CACHE/un-fork-cualquiera/mefisto" "$salida" "cae al glob del cache cuando no hay .plugin-root"

VACIO="$(mktemp -d)"
if _marketplace_dir "" "$VACIO" >/dev/null 2>&1; then
    fail "sin ningun 'mefisto' en el cache deberia retornar 1"
else
    pass "sin ningun 'mefisto' en el cache retorna 1"
fi
rmdir "$VACIO"

echo ""
echo "[S-4] modo ACTUALIZAR: 'claude plugin update' recibe el nombre calificado (issue #601)"

STUB_DIR="$(mktemp -d)"
CONSUMER_DIR="$(mktemp -d)"
FAKE_CACHE_S4="$(mktemp -d)"
CLAUDE_LOG="$(mktemp)"
trap 'rm -rf "$FAKE_CACHE" "$STUB_DIR" "$CONSUMER_DIR" "$FAKE_CACHE_S4" "$CLAUDE_LOG"' EXIT

# Marketplace de mentira (los asserts de abajo lo derivan de esta variable, no lo
# hardcodean): clava que el fix tambien funciona en un fork publicado bajo otro nombre de
# marketplace, la misma regla que protege S-3.
MARKETPLACE_FIXTURE="un-fork-de-mentira"
mkdir -p "$FAKE_CACHE_S4/$MARKETPLACE_FIXTURE/mefisto/0.20.0" \
         "$FAKE_CACHE_S4/$MARKETPLACE_FIXTURE/mefisto/0.21.0"
printf '## [0.21.0]\n- nada relevante\n\n## [0.20.0]\n- nada relevante\n' \
    > "$FAKE_CACHE_S4/$MARKETPLACE_FIXTURE/mefisto/0.21.0/CHANGELOG.md"

# Stub de 'claude' en PATH: registra los argumentos recibidos y simula exito, sin tocar
# ningun cache real ni invocar el CLI de verdad.
cat > "$STUB_DIR/claude" <<'EOF'
#!/usr/bin/env bash
[ "$1 $2" = "plugin list" ] || echo "$@" >> "$CLAUDE_LOG"
exit 0
EOF
chmod +x "$STUB_DIR/claude"

# Cwd de mentira (git repo sin .claude-plugin/plugin.json) con la version 0.20.0 cargada,
# para que main() corra el modo ACTUALIZAR completo (pasos 3-5) contra el cache fixture.
mkdir -p "$CONSUMER_DIR/.claude/pipeline"
printf '%s' "$FAKE_CACHE_S4/$MARKETPLACE_FIXTURE/mefisto/0.20.0" \
    > "$CONSUMER_DIR/.claude/pipeline/.plugin-root"

(
    cd "$CONSUMER_DIR" || exit 1
    git init -q .
    export PATH="$STUB_DIR:$PATH"
    export MEFISTO_CACHE_ROOT="$FAKE_CACHE_S4"
    export CLAUDE_LOG
    main
) >/dev/null 2>&1
resultado_main=$?

assert_igual "0" "$resultado_main" "el modo actualizar corre completo (exit 0) con el stub de claude"
assert_igual "plugin marketplace update $MARKETPLACE_FIXTURE" "$(sed -n '1p' "$CLAUDE_LOG")" \
    "actualiza el catalogo del marketplace derivado del fixture"
assert_igual "plugin update mefisto@$MARKETPLACE_FIXTURE --scope user" "$(sed -n '2p' "$CLAUDE_LOG")" \
    "el update del plugin recibe el nombre calificado mefisto@<marketplace-del-fixture>"
assert_igual "$FAKE_CACHE_S4/$MARKETPLACE_FIXTURE/mefisto/0.21.0" \
    "$(cat "$CONSUMER_DIR/.claude/pipeline/.plugin-root" 2>/dev/null)" \
    "de paso, reescribe .plugin-root a la version mas nueva del cache"

echo ""
echo "[S-6] scopes aplicables y version efectiva (issue #2130)"

S6_STUB="$(mktemp -d)"; S6_CONSUMER="$(mktemp -d)"; S6_CACHE="$(mktemp -d)"; S6_LOG="$(mktemp)"
S6_MKT="mkt-s6"
mkdir -p "$S6_CACHE/$S6_MKT/mefisto/0.20.0" "$S6_CACHE/$S6_MKT/mefisto/0.21.0" "$S6_CONSUMER/.claude/pipeline"
printf '## [0.21.0]\n- x\n\n## [0.20.0]\n- x\n' > "$S6_CACHE/$S6_MKT/mefisto/0.21.0/CHANGELOG.md"
printf '%s' "$S6_CACHE/$S6_MKT/mefisto/0.20.0" > "$S6_CONSUMER/.claude/pipeline/.plugin-root"
( cd "$S6_CONSUMER" && git init -q . )
S6_TOP="$(cd "$S6_CONSUMER" && pwd -P | xargs -I{} git -C {} rev-parse --show-toplevel)"
cat > "$S6_STUB/claude" <<'EOF2'
#!/usr/bin/env bash
echo "$@" >> "$S6_LOG"
if [ "$1 $2 $3" = "plugin list --json" ]; then
    jq -n --arg top "$S6_TOP" --arg c "$S6_CACHE" --arg mkt "$S6_MKT" --arg pv "${S6_PROJECT_VERSION:-0.21.0}" '[
      {id:("mefisto@"+$mkt),version:"0.21.0",scope:"user",installPath:($c+"/"+$mkt+"/mefisto/0.21.0")},
      {id:("mefisto@"+$mkt),version:$pv,scope:"project",projectPath:$top,installPath:($c+"/"+$mkt+"/mefisto/"+$pv)},
      {id:("mefisto@"+$mkt),version:"0.21.0",scope:"local",projectPath:"/otro/proyecto",installPath:($c+"/"+$mkt+"/mefisto/0.21.0")}]'
fi
exit 0
EOF2
chmod +x "$S6_STUB/claude"
s6_run() {
    : > "$S6_LOG"
    ( cd "$S6_CONSUMER" && export PATH="$S6_STUB:$PATH" MEFISTO_CACHE_ROOT="$S6_CACHE" S6_LOG S6_TOP S6_CACHE S6_MKT S6_PROJECT_VERSION && main ) 2>&1
}

S6_OUT=$(S6_PROJECT_VERSION=0.21.0 s6_run); S6_RC=$?
assert_igual "0" "$S6_RC" "S-6: user + project al dia: exit 0"
assert_contiene "$(cat "$S6_LOG")" "plugin update mefisto@$S6_MKT --scope user" "S-6: actualiza scope user"
assert_contiene "$(cat "$S6_LOG")" "plugin update mefisto@$S6_MKT --scope project" "S-6: actualiza scope project del proyecto"
case "$(cat "$S6_LOG")" in
    *"--scope local"*) FAIL=$((FAIL+1)); echo "  FAIL: S-6: actualizo un local de otro projectPath" ;;
    *) PASS=$((PASS+1)); echo "  PASS: S-6: ignora instalaciones de otros projectPath" ;;
esac

printf '%s' "$S6_CACHE/$S6_MKT/mefisto/0.20.0" > "$S6_CONSUMER/.claude/pipeline/.plugin-root"
S6_OUT=$(S6_PROJECT_VERSION=0.20.0 s6_run); S6_RC=$?
[ "$S6_RC" -ne 0 ] && { PASS=$((PASS+1)); echo "  PASS: S-6: project desfasado -> exit != 0"; } || { FAIL=$((FAIL+1)); echo "  FAIL: S-6: project desfasado debia fallar"; }
assert_contiene "$S6_OUT" "ERROR:" "S-6: imprime ERROR"
assert_contiene "$S6_OUT" "scope project" "S-6: el error nombra el scope"
assert_contiene "$S6_OUT" "0.20.0" "S-6: el error nombra la version efectiva"
assert_igual "$S6_CACHE/$S6_MKT/mefisto/0.20.0" "$(cat "$S6_CONSUMER/.claude/pipeline/.plugin-root")" \
    "S-6: .plugin-root apunta a la efectiva, no a la mas nueva del cache"
rm -rf "$S6_STUB" "$S6_CONSUMER" "$S6_CACHE" "$S6_LOG"

echo ""
echo "[S-7] marcador canonico .mefisto/pipeline/.plugin-root: se protege y no se reescribe (issue #2248)"

# Caso ControlAsistencia: cache 0.43.0 0.44.0 0.44.1, nueva y cargada 0.44.1, canonico en
# 0.44.0 (sesion viva sin reiniciar). main() end-to-end, mismas fronteras que S-4.
S7_STUB="$(mktemp -d)"; S7_CONSUMER="$(mktemp -d)"; S7_CACHE="$(mktemp -d)"; S7_LOG="$(mktemp)"
S7_MEF="$S7_CACHE/mkt-s7/mefisto"
mkdir -p "$S7_MEF/0.43.0" "$S7_MEF/0.44.0" "$S7_MEF/0.44.1" \
         "$S7_CONSUMER/.claude/pipeline" "$S7_CONSUMER/.mefisto/pipeline"
cat > "$S7_STUB/claude" <<'EOF2'
#!/usr/bin/env bash
[ "$1 $2" = "plugin list" ] || echo "$@" >> "$CLAUDE_LOG"
exit 0
EOF2
chmod +x "$S7_STUB/claude"
printf '%s' "$S7_MEF/0.44.1" > "$S7_CONSUMER/.claude/pipeline/.plugin-root"
printf '%s' "$S7_MEF/0.44.0" > "$S7_CONSUMER/.mefisto/pipeline/.plugin-root"
s7_run() {
    (
        cd "$S7_CONSUMER" || exit 1
        git init -q . 2>/dev/null
        export PATH="$S7_STUB:$PATH" MEFISTO_CACHE_ROOT="$S7_CACHE" CLAUDE_LOG="$S7_LOG"
        main "$@"
    ) 2>&1
}

S7_OUT=$(s7_run); S7_RC=$?
assert_igual "0" "$S7_RC" "S-7: modo actualizar con canonico 0.44.0: exit 0"
assert_igual "  - 0.43.0" "$(printf '%s\n' "$S7_OUT" | grep '^  - ')" \
    "S-7: modo actualizar lista como podable solo 0.43.0"
assert_igual "$S7_MEF/0.44.0" "$(cat "$S7_CONSUMER/.mefisto/pipeline/.plugin-root")" \
    "S-7: modo actualizar no reescribe el marcador canonico"

S7_OUT=$(s7_run --prune --only 0.43.0 --loaded 0.44.1); S7_RC=$?
assert_igual "0" "$S7_RC" "S-7: --prune con canonico 0.44.0: exit 0"
assert_igual "0.44.0 0.44.1" "$(ls "$S7_MEF" | tr '\n' ' ' | sed 's/ $//')" \
    "S-7: --prune borra solo 0.43.0 y conserva la version del canonico"

# Canonico ausente: el comportamiento previo no cambia (0.44.0 vuelve a ser podable).
mkdir -p "$S7_MEF/0.43.0"
rm -f "$S7_CONSUMER/.mefisto/pipeline/.plugin-root" "$S7_CONSUMER/.claude/pipeline/.plugin-root.previous"
S7_OUT=$(s7_run --prune --only 0.43.0,0.44.0 --loaded 0.44.1); S7_RC=$?
assert_igual "0" "$S7_RC" "S-7: --prune sin canonico: exit 0"
assert_igual "0.44.1" "$(ls "$S7_MEF" | tr '\n' ' ' | sed 's/ $//')" \
    "S-7: sin canonico se podan 0.43.0 y 0.44.0 como antes"
rm -rf "$S7_STUB" "$S7_CONSUMER" "$S7_CACHE" "$S7_LOG"

echo ""
echo "[S-8] upgrade.sh -> update-plugin.sh: la raiz viva gana sobre un .previous viejo (issue #2249)"

# Caso ControlAsistencia: /reload-plugins no dispara SessionStart, asi que .previous sigue en
# 0.44.0 mientras la sesion carga 0.44.1; la nueva es 0.45.0. End-to-end por upgrade.sh.
S8_STUB="$(mktemp -d)"; S8_CONSUMER="$(mktemp -d)"; S8_CACHE="$(mktemp -d)"
S8_MEF="$S8_CACHE/mkt-s8/mefisto"
for v in 0.43.0 0.44.0 0.44.1 0.45.0; do
    mkdir -p "$S8_MEF/$v/.claude-plugin"
    printf '{"name":"mefisto","version":"%s"}' "$v" > "$S8_MEF/$v/.claude-plugin/plugin.json"
done
mkdir -p "$S8_CONSUMER/.claude/pipeline"
printf '#!/usr/bin/env bash\nexit 0\n' > "$S8_STUB/claude"; chmod +x "$S8_STUB/claude"
printf '%s' "$S8_MEF/0.44.0" > "$S8_CONSUMER/.claude/pipeline/.plugin-root.previous"
printf '%s' "$S8_MEF/0.45.0" > "$S8_CONSUMER/.claude/pipeline/.plugin-root"
s8_run() {
    (
        cd "$S8_CONSUMER" || exit 1
        git init -q . 2>/dev/null
        export PATH="$S8_STUB:$PATH" MEFISTO_CACHE_ROOT="$S8_CACHE" MEFISTO_RUNTIME=claude
        "$REPO_ROOT/scripts/upgrade.sh" "$@"
    ) 2>&1
}

S8_OUT=$(MEFISTO_LOADED_ROOT="$S8_MEF/0.44.1" s8_run); S8_RC=$?
assert_igual "0" "$S8_RC" "S-8: actualizar con MEFISTO_LOADED_ROOT valida: exit 0"
assert_contiene "$S8_OUT" "Version cargada en esta sesion: 0.44.1 (fuente: --loaded)" \
    "S-8: la version cargada sale de la raiz viva, no del .previous"
assert_igual "  - 0.43.0
  - 0.44.0" "$(printf '%s\n' "$S8_OUT" | grep '^  - ')" "S-8: 0.44.1 no es podable"

S8_OUT=$(MEFISTO_LOADED_ROOT='${CLAUDE_PLUGIN_ROOT}' s8_run); S8_RC=$?
assert_contiene "$S8_OUT" "Version cargada en esta sesion: 0.44.0 (fuente: .claude/pipeline/.plugin-root.previous)" \
    "S-8: raiz sin sustituir se ignora y sigue la cadena previa"

S8_OUT=$(MEFISTO_LOADED_ROOT="$S8_MEF/0.44.1" s8_run --prune --only 0.43.0,0.44.0); S8_RC=$?
assert_igual "0" "$S8_RC" "S-8: --prune con MEFISTO_LOADED_ROOT valida: exit 0"
assert_igual "0.44.1 0.45.0" "$(ls "$S8_MEF" | tr '\n' ' ' | sed 's/ $//')" \
    "S-8: --prune conserva la version viva 0.44.1"
rm -rf "$S8_STUB" "$S8_CONSUMER" "$S8_CACHE"

echo ""
echo "[S-9] --prune exige --only y borra solo lo confirmado (issue #2250)"

S9_STUB="$(mktemp -d)"; S9_CONSUMER="$(mktemp -d)"; S9_CACHE="$(mktemp -d)"
S9_MEF="$S9_CACHE/mkt-s9/mefisto"
s9_reset() {
    rm -rf "$S9_MEF"
    for v in 0.43.0 0.44.0 0.44.1; do mkdir -p "$S9_MEF/$v"; done
}
mkdir -p "$S9_CONSUMER/.claude/pipeline"
printf '#!/usr/bin/env bash\nexit 0\n' > "$S9_STUB/claude"; chmod +x "$S9_STUB/claude"
printf '%s' "$S9_MEF/0.44.1" > "$S9_CONSUMER/.claude/pipeline/.plugin-root"
s9_run() {
    (
        cd "$S9_CONSUMER" || exit 1
        git init -q . 2>/dev/null
        export PATH="$S9_STUB:$PATH" MEFISTO_CACHE_ROOT="$S9_CACHE"
        main "$@"
    ) 2>&1
}

s9_reset
for bad in "--prune --loaded 0.44.1" "--prune --only  --loaded 0.44.1" "--prune --only , --loaded 0.44.1" "--prune --only 0.43.0,abc --loaded 0.44.1" "--prune --only ../0.43.0 --loaded 0.44.1"; do
    # shellcheck disable=SC2086
    S9_OUT=$(s9_run $bad); S9_RC=$?
    assert_igual "1" "$S9_RC" "S-9: '$bad' aborta"
    assert_igual "0.43.0 0.44.0 0.44.1" "$(ls "$S9_MEF" | tr '\n' ' ' | sed 's/ $//')" "S-9: '$bad' no borra nada"
done

# Caso ControlAsistencia: confirmada 0.43.0; 0.44.0 queda podable pero no confirmada.
S9_OUT=$(s9_run --prune --only 0.43.0 --loaded 0.44.1); S9_RC=$?
assert_igual "0" "$S9_RC" "S-9: --only 0.43.0: exit 0"
assert_igual "0.44.0 0.44.1" "$(ls "$S9_MEF" | tr '\n' ' ' | sed 's/ $//')" "S-9: borra solo 0.43.0"
assert_contiene "$S9_OUT" "Podables NO confirmadas (no se borraron): 0.44.0" "S-9: informa 0.44.0 como no confirmada"

# Confirmada que ahora esta protegida (la cargada): no se borra y se informa.
s9_reset
S9_OUT=$(s9_run --prune --only 0.43.0,0.44.1 --loaded 0.44.1); S9_RC=$?
assert_igual "0.44.0 0.44.1" "$(ls "$S9_MEF" | tr '\n' ' ' | sed 's/ $//')" "S-9: no borra la protegida confirmada"
assert_contiene "$S9_OUT" "Confirmadas que ahora estan protegidas (no se borraron): 0.44.1" "S-9: informa la confirmada protegida"

# Sin podables al borrar: la confirmada protegida igual se informa.
rm -rf "$S9_MEF"; mkdir -p "$S9_MEF/0.44.1"
S9_OUT=$(s9_run --prune --only 0.44.1 --loaded 0.44.1); S9_RC=$?
assert_igual "0.44.1" "$(ls "$S9_MEF" | tr '\n' ' ' | sed 's/ $//')" "S-9: cache limpio no borra la cargada"
assert_contiene "$S9_OUT" "Confirmadas que ahora estan protegidas (no se borraron): 0.44.1" "S-9: cache limpio informa la confirmada protegida"

# La pista del modo actualizar trae la lista exacta.
s9_reset
S9_OUT=$(s9_run --loaded 0.44.1)
assert_contiene "$S9_OUT" "--prune --only 0.43.0,0.44.0 --loaded 0.44.1" "S-9: la pista incluye --only con la lista exacta"
rm -rf "$S9_STUB" "$S9_CONSUMER" "$S9_CACHE"

echo ""
echo "===================================================================="
echo "  test-update-plugin.sh: $PASS pasaron, $FAIL fallaron"
echo "===================================================================="

[ "$FAIL" -eq 0 ]
