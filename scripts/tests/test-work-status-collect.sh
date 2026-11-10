#!/usr/bin/env bash
# test-work-status-collect.sh -- Tests de scripts/work-status-collect.sh
# (issue #1597): consolidacion deterministica del estado de los pipelines del
# consumidor, con fallback legacy de solo lectura (MEF-ADR-0053 seccion 4).
#
# Cada caso arma su propio par de roots (canonico/legacy) en un temporal,
# sobreescribiendo MEFISTO_STATE_DIR/MEFISTO_LEGACY_STATE_DIR (el mismo
# mecanismo de override que _pipeline-common.sh ya documenta para fixtures) y
# corre el script como subproceso real, nunca sourceado.
#
# Casos cubiertos (CA-5):
#   [1]  CA-1: --json obligatorio; cualquier otro argumento sale con 2.
#   [2]  CA-1: sin ningun estado -- JSON valido, exit 0, empty.status/history
#        en true, rows/history vacios.
#   [3]  CA-2: misma clave en los dos roots -- gana el canonico.
#   [4]  CA-2: status disjuntos -- se conservan ambos, con su origen.
#   [5]  CA-2: formato antiguo sin pipeline/variant/runtime -- se infiere
#        pipeline "tdd", variant/runtime quedan null.
#   [6]  CA-3: hold estructurado -- activity toma cause/next_probe/ceiling
#        del propio status, con prioridad sobre stale.
#   [7]  CA-3: hold textual con UNA fila legacy running elegible -- se
#        traduce la causa y se extraen sonda/techo del events.log legacy.
#   [8]  CA-3: hold textual con DOS filas legacy running -- no se atribuye a
#        ninguna (ambiguedad).
#   [9]  CA-3: stale -- "updated" con mas de 35 minutos.
#   [10] CA-2/CA-1: historial sin "started" -- sigue visible, despues de las
#        entradas fechadas.
#   [11] CA-4: reconstruccion de log legacy cuando el status no declara uno.
#   [12] CA-2: es de solo lectura -- ningun archivo de los roots cambia
#        (checksum antes/despues).
#   [13] CA-2: issue string vs numerico es la misma clave de dedup; pr
#        numerico en el historial produce detail "PR #N".
#
# Uso: scripts/tests/test-work-status-collect.sh
# Exit code: 0 si todos los checks pasan, 1 si alguno falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET="$REPO_ROOT/scripts/work-status-collect.sh"
FIXTURES="$SCRIPT_DIR/fixtures/work-status"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# run_collect <canonical_dir> <legacy_dir>
# Corre el script como subproceso con los roots dados, imprime stdout.
run_collect() {
    local canonical="$1" legacy="$2"
    MEFISTO_STATE_DIR="$canonical" MEFISTO_LEGACY_STATE_DIR="$legacy" "$TARGET" --json
}

# hms_at <delta_segundos> -- HH:MM:SS de "ahora + delta" (mismo patron que
# test-hold-visibility.sh).
hms_at() {
    local delta="$1"
    local epoch=$(( $(date +%s) + delta ))
    date -r "$epoch" +%H:%M:%S 2>/dev/null || date -d "@$epoch" +%H:%M:%S 2>/dev/null
}

# iso_at <delta_segundos> -- "YYYY-MM-DDTHH:MM:SS" de "ahora + delta".
iso_at() {
    local delta="$1"
    local epoch=$(( $(date +%s) + delta ))
    date -r "$epoch" +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -d "@$epoch" +%Y-%m-%dT%H:%M:%S 2>/dev/null
}

# dir_checksum <dir> -- huella de todos los archivos regulares bajo <dir>.
dir_checksum() {
    local dir="$1"
    if [ -d "$dir" ]; then
        find "$dir" -type f -print0 2>/dev/null | sort -z | xargs -0 shasum 2>/dev/null | shasum | awk '{print $1}'
    else
        echo "no-dir"
    fi
}

echo "[1] CA-1: --json obligatorio; cualquier otro argumento sale con 2"
EMPTY_CANON="$TMP/empty-canon"; EMPTY_LEGACY="$TMP/empty-legacy"
if MEFISTO_STATE_DIR="$EMPTY_CANON" MEFISTO_LEGACY_STATE_DIR="$EMPTY_LEGACY" "$TARGET" >/dev/null 2>&1; then
    fail "sin argumentos deberia salir con codigo != 0"
else
    rc=$?
    [ "$rc" -eq 2 ] && pass "sin argumentos sale con 2" || fail "sin argumentos salio con $rc (esperaba 2)"
fi
if MEFISTO_STATE_DIR="$EMPTY_CANON" MEFISTO_LEGACY_STATE_DIR="$EMPTY_LEGACY" "$TARGET" --otro >/dev/null 2>&1; then
    fail "--otro deberia salir con codigo != 0"
else
    rc=$?
    [ "$rc" -eq 2 ] && pass "--otro sale con 2" || fail "--otro salio con $rc (esperaba 2)"
fi

echo ""
echo "[2] CA-1: sin ningun estado -- JSON valido, exit 0, empty en true/true"
OUT=$(run_collect "$EMPTY_CANON" "$EMPTY_LEGACY")
rc=$?
[ "$rc" -eq 0 ] && pass "exit 0 sin estado" || fail "exit $rc sin estado (esperaba 0)"
if jq -e '.schemaVersion == 1' <<< "$OUT" >/dev/null 2>&1; then
    pass "schemaVersion == 1"
else
    fail "schemaVersion incorrecto: $OUT"
fi
if [ "$(jq -r '.empty.status' <<< "$OUT")" = "true" ] && [ "$(jq -r '.empty.history' <<< "$OUT")" = "true" ]; then
    pass "empty.status y empty.history en true"
else
    fail "empty inesperado: $(jq -c '.empty' <<< "$OUT")"
fi
if [ "$(jq '.rows | length' <<< "$OUT")" -eq 0 ] && [ "$(jq '.history | length' <<< "$OUT")" -eq 0 ]; then
    pass "rows y history vacios"
else
    fail "rows/history no vacios sin estado"
fi
if jq -e '.now | test("^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$")' <<< "$OUT" >/dev/null 2>&1; then
    pass "now con formato YYYY-MM-DD HH:MM:SS"
else
    fail "now con formato inesperado: $(jq -r '.now' <<< "$OUT")"
fi

echo ""
echo "[3] CA-2: misma clave en los dos roots -- gana el canonico"
OUT=$(run_collect "$FIXTURES/dedup-canonical-wins/canonical" "$FIXTURES/dedup-canonical-wins/legacy")
ROW=$(jq -c '.rows[] | select(.issue == "100")' <<< "$OUT")
if [ -n "$ROW" ]; then
    if [ "$(jq -r '.title' <<< "$ROW")" = "canonical wins" ] && [ "$(jq -r '.origin' <<< "$ROW")" = "canonical" ]; then
        pass "gana el status canonico ante la misma clave"
    else
        fail "no gano el canonico: $ROW"
    fi
    if [ "$(jq '.rows | map(select(.issue == "100")) | length' <<< "$OUT")" -eq 1 ]; then
        pass "solo una fila para la clave duplicada (deduplicado)"
    else
        fail "quedaron ambas filas duplicadas"
    fi
else
    fail "no se encontro la fila issue 100"
fi

echo ""
echo "[4] CA-2: status disjuntos -- se conservan ambos con su origen"
OUT=$(run_collect "$FIXTURES/dedup-disjoint/canonical" "$FIXTURES/dedup-disjoint/legacy")
R101=$(jq -c '.rows[] | select(.issue == "101")' <<< "$OUT")
R103=$(jq -c '.rows[] | select(.issue == "103")' <<< "$OUT")
if [ "$(jq -r '.origin' <<< "$R101")" = "canonical" ] && [ "$(jq -r '.origin' <<< "$R103")" = "legacy" ]; then
    pass "ambos status disjuntos se conservan con su origen"
else
    fail "no se conservaron los disjuntos: 101=$R101 / 103=$R103"
fi

echo ""
echo "[5] CA-2: formato antiguo sin pipeline/variant/runtime"
OUT=$(run_collect "$TMP/no-existe-old" "$FIXTURES/old-format/legacy")
ROW=$(jq -c '.rows[] | select(.issue == "55")' <<< "$OUT")
if [ -n "$ROW" ]; then
    if [ "$(jq -r '.pipeline' <<< "$ROW")" = "tdd" ] \
        && [ "$(jq -r '.variant' <<< "$ROW")" = "null" ] \
        && [ "$(jq -r '.runtime' <<< "$ROW")" = "null" ]; then
        pass "pipeline inferido tdd, variant/runtime null"
    else
        fail "campos inferidos incorrectos: $ROW"
    fi
else
    fail "no se encontro la fila del formato antiguo (issue 55)"
fi

echo ""
echo "[6] CA-3: hold estructurado -- prioridad sobre stale"
OUT=$(run_collect "$FIXTURES/hold-structured/canonical" "$TMP/no-existe-hs-legacy")
ROW=$(jq -c '.rows[] | select(.issue == "200")' <<< "$OUT")
ACTIVITY=$(jq -c '.activity' <<< "$ROW")
if [ "$(jq -r '.kind' <<< "$ACTIVITY")" = "hold" ] \
    && [ "$(jq -r '.cause' <<< "$ACTIVITY")" = "RATE_LIMIT" ] \
    && [ "$(jq -r '.next_probe' <<< "$ACTIVITY")" = "2026-01-01T00:10:00" ] \
    && [ "$(jq -r '.ceiling' <<< "$ACTIVITY")" = "21600" ]; then
    pass "activity refleja el hold estructurado del propio status"
else
    fail "activity incorrecta para hold estructurado: $ACTIVITY"
fi

echo ""
echo "[7] CA-3: hold textual con UNA fila legacy running elegible"
CANON7="$TMP/hold-text-one/canonical"; LEGACY7="$TMP/hold-text-one/legacy"
mkdir -p "$CANON7" "$LEGACY7"
PROBE_HMS=$(hms_at 120)
cat > "$LEGACY7/pipeline-status-tooling-300.json" <<EOF
{
  "issue": "300",
  "title": "hold textual",
  "pipeline": "tooling",
  "variant": null,
  "runtime": null,
  "stage": "1-writer",
  "state": "running",
  "started": "$(date +%Y%m%d-%H%M%S)",
  "updated": "$(date +%Y-%m-%dT%H:%M:%S)",
  "log": "/no/existe/300.log",
  "pr": null,
  "last_error": null,
  "agents": {"writer": {"duration": null, "result": "running"}, "reviewer": {"duration": null, "result": "pending"}}
}
EOF
cat > "$LEGACY7/events.log" <<EOF
=== SESSION TOOLING $(date +%Y%m%d-%H%M%S) issue:300 from-stage:1 ===
[$(hms_at -60)][hold] RATE_LIMIT: esperando, proxima sonda $PROBE_HMS (techo 23:59)
EOF
OUT=$(run_collect "$CANON7" "$LEGACY7")
ROW=$(jq -c '.rows[] | select(.issue == "300")' <<< "$OUT")
ACTIVITY=$(jq -c '.activity' <<< "$ROW")
if [ "$(jq -r '.kind' <<< "$ACTIVITY")" = "hold" ] && [ "$(jq -r '.cause' <<< "$ACTIVITY")" = "limite de uso" ]; then
    pass "hold textual traducido a 'limite de uso' con una unica fila legacy running"
else
    fail "hold textual no aplicado: $ACTIVITY"
fi
if [ "$(jq -r '.next_probe' <<< "$ACTIVITY")" = "$PROBE_HMS" ]; then
    pass "next_probe extraido del events.log legacy"
else
    fail "next_probe incorrecto: $(jq -r '.next_probe' <<< "$ACTIVITY") (esperaba $PROBE_HMS)"
fi

echo ""
echo "[8] CA-3: hold textual con DOS filas legacy running -- ambiguo, no se atribuye"
CANON8="$TMP/hold-text-two/canonical"; LEGACY8="$TMP/hold-text-two/legacy"
mkdir -p "$CANON8" "$LEGACY8"
for issue in 301 302; do
cat > "$LEGACY8/pipeline-status-tooling-${issue}.json" <<EOF
{
  "issue": "$issue",
  "title": "hold textual ambiguo",
  "pipeline": "tooling",
  "variant": null,
  "runtime": null,
  "stage": "1-writer",
  "state": "running",
  "started": "$(date +%Y%m%d-%H%M%S)",
  "updated": "$(date +%Y-%m-%dT%H:%M:%S)",
  "log": "/no/existe/${issue}.log",
  "pr": null,
  "last_error": null,
  "agents": {"writer": {"duration": null, "result": "running"}, "reviewer": {"duration": null, "result": "pending"}}
}
EOF
done
cat > "$LEGACY8/events.log" <<EOF
[$(hms_at -60)][hold] RATE_LIMIT: esperando, proxima sonda $(hms_at 120) (techo 23:59)
EOF
OUT=$(run_collect "$CANON8" "$LEGACY8")
R301=$(jq -c '.rows[] | select(.issue == "301") | .activity' <<< "$OUT")
R302=$(jq -c '.rows[] | select(.issue == "302") | .activity' <<< "$OUT")
if [ "$(jq -r '.kind' <<< "$R301")" != "hold" ] && [ "$(jq -r '.kind' <<< "$R302")" != "hold" ]; then
    pass "con dos filas legacy running ninguna recibe el hold textual"
else
    fail "el hold textual se atribuyo con ambiguedad: 301=$R301 / 302=$R302"
fi

echo ""
echo "[9] CA-3: stale -- 'updated' con mas de 35 minutos"
CANON9="$TMP/stale/canonical"
mkdir -p "$CANON9"
cat > "$CANON9/pipeline-status-tooling-400.json" <<EOF
{
  "issue": "400",
  "title": "stale",
  "pipeline": "tooling",
  "variant": null,
  "runtime": "claude",
  "stage": "1-writer",
  "state": "running",
  "started": "$(date +%Y%m%d-%H%M%S)",
  "updated": "$(iso_at -2400)",
  "log": "/no/existe/400.log",
  "pr": null,
  "last_error": null,
  "agents": {"writer": {"duration": null, "result": "running"}, "reviewer": {"duration": null, "result": "pending"}}
}
EOF
OUT=$(run_collect "$CANON9" "$TMP/no-existe-stale-legacy")
ACTIVITY=$(jq -c '.rows[] | select(.issue == "400") | .activity' <<< "$OUT")
if [ "$(jq -r '.kind' <<< "$ACTIVITY")" = "stale" ]; then
    pass "activity stale cuando 'updated' supera 35 minutos"
else
    fail "activity incorrecta para stale: $ACTIVITY"
fi

echo ""
echo "[10] CA-2/CA-1: historial sin 'started' sigue visible, despues de las fechadas"
OUT=$(run_collect "$FIXTURES/history-mixed/canonical" "$TMP/no-existe-hist-legacy")
if [ "$(jq '.history | length' <<< "$OUT")" -eq 2 ]; then
    pass "las dos entradas de historial aparecen"
else
    fail "no aparecieron las dos entradas de historial: $(jq -c '.history' <<< "$OUT")"
fi
FIRST_ISSUE=$(jq -r '.history[0].issue' <<< "$OUT")
SECOND_ISSUE=$(jq -r '.history[1].issue' <<< "$OUT")
if [ "$FIRST_ISSUE" = "10" ] && [ "$SECOND_ISSUE" = "11" ]; then
    pass "la entrada fechada precede a la que carece de 'started'"
else
    fail "orden incorrecto: primero=$FIRST_ISSUE segundo=$SECOND_ISSUE"
fi
if [ "$(jq -r '.history[1].started' <<< "$OUT")" = "null" ]; then
    pass "la entrada sin 'started' conserva started=null"
else
    fail "started deberia ser null: $(jq -r '.history[1].started' <<< "$OUT")"
fi
if [ "$(jq -r '.history[0].duration' <<< "$OUT")" = "300" ] && [ "$(jq -r '.history[0].detail' <<< "$OUT")" = "PR #999" ]; then
    pass "duration/detail calculados para la entrada fechada (300s, PR #999)"
else
    fail "duration/detail incorrectos: $(jq -c '.history[0]' <<< "$OUT")"
fi

echo ""
echo "[11] CA-4: reconstruccion de log legacy cuando el status no declara uno"
# El .log del fixture se materializa en runtime: '*.log' esta en .gitignore y
# nunca llega versionado (issue #1626).
CANON11="$TMP/log-reconstruct/canonical"
mkdir -p "$CANON11/logs"
cp "$FIXTURES/log-reconstruct/canonical/"*.json "$CANON11/"
touch "$CANON11/logs/tooling-stage-2-reviewer-20260101-120000.log"
OUT=$(run_collect "$CANON11" "$TMP/no-existe-logrec-legacy")
LOG=$(jq -r '.rows[] | select(.issue == "500") | .log' <<< "$OUT")
EXPECTED="$CANON11/logs/tooling-stage-2-reviewer-20260101-120000.log"
if [ "$LOG" = "$EXPECTED" ]; then
    pass "log reconstruido con el patron legacy de Tooling"
else
    fail "log reconstruido incorrecto: '$LOG' (esperaba '$EXPECTED')"
fi

echo ""
echo "[12] CA-2: de solo lectura -- ningun archivo de los roots cambia (checksum)"
CANON12="$TMP/readonly/canonical"; LEGACY12="$TMP/readonly/legacy"
mkdir -p "$CANON12" "$LEGACY12"
cp "$FIXTURES/dedup-canonical-wins/canonical/pipeline-status-tooling-100.json" "$CANON12/"
cp "$FIXTURES/dedup-canonical-wins/legacy/pipeline-status-tooling-100.json" "$LEGACY12/"
cp "$FIXTURES/history-mixed/canonical/pipeline-history.jsonl" "$CANON12/"
BEFORE_CANON=$(dir_checksum "$CANON12")
BEFORE_LEGACY=$(dir_checksum "$LEGACY12")
run_collect "$CANON12" "$LEGACY12" >/dev/null
AFTER_CANON=$(dir_checksum "$CANON12")
AFTER_LEGACY=$(dir_checksum "$LEGACY12")
if [ "$BEFORE_CANON" = "$AFTER_CANON" ] && [ "$BEFORE_LEGACY" = "$AFTER_LEGACY" ]; then
    pass "ningun archivo de los roots cambio (checksum identico antes/despues)"
else
    fail "algun archivo cambio: canon $BEFORE_CANON -> $AFTER_CANON / legacy $BEFORE_LEGACY -> $AFTER_LEGACY"
fi
if [ ! -d "$TMP/no-existe-old" ] && [ ! -d "$TMP/no-existe-stale-legacy" ]; then
    pass "no se crearon roots ausentes durante ninguna corrida"
else
    fail "el script creo un root que no existia"
fi

echo ""
echo "[13] CA-2: issue string (canonico) vs numerico (legacy) es la misma clave; pr numerico en detail"
CANON13="$TMP/issue-type/canonical"; LEGACY13="$TMP/issue-type/legacy"
mkdir -p "$CANON13" "$LEGACY13"
echo '{"issue":"7","pipeline":"tooling","state":"running","stage":"1-writer"}' > "$CANON13/pipeline-status-tooling-7.json"
echo '{"issue":7,"pipeline":"tooling","state":"running","stage":"1-writer"}' > "$LEGACY13/pipeline-status-tooling-7.json"
echo '{"issue":7,"pipeline":"tooling","state":"completed","started":"20260101-100000","finished":"2026-01-01T10:05:00","pr":42}' > "$CANON13/pipeline-history.jsonl"
OUT=$(run_collect "$CANON13" "$LEGACY13")
if [ "$(jq '.rows | length' <<< "$OUT")" = "1" ] && [ "$(jq -r '.rows[0].origin' <<< "$OUT")" = "canonical" ]; then
    pass "issue \"7\" y 7 deduplican a una sola fila canonica"
else
    fail "dedup por tipo de issue incorrecto: $(jq -c '.rows' <<< "$OUT")"
fi
if [ "$(jq -r '.history[0].detail' <<< "$OUT")" = "PR #42" ]; then
    pass "pr numerico produce detail 'PR #42'"
else
    fail "detail con pr numerico incorrecto: $(jq -c '.history' <<< "$OUT")"
fi

echo ""
echo "[14] #1626 CA-4: /infra en curso desde el root canonico (stage, pct, log con sufijo -issue-N, hold)"
CANON14="$TMP/infra/canonical"; LEGACY14="$TMP/infra/legacy"
mkdir -p "$CANON14/logs" "$LEGACY14/logs"
echo '{"issue":"77","pipeline":"infra","state":"hold","stage":"1-infra-writer","started":"20260101-120000","runtime":"claude","hold":{"cause":"rate_limit","next_probe":null,"ceiling_seconds":21600,"accumulated_seconds":0}}' > "$CANON14/pipeline-status-infra-77.json"
touch "$CANON14/logs/iac-stage-1-infra-writer-20260101-120000-issue-77.log"
echo '{"issue":"78","pipeline":"infra","state":"running","stage":"2-infra-reviewer","started":"20260101-110000"}' > "$LEGACY14/pipeline-status-infra-78.json"
touch "$LEGACY14/logs/iac-stage-2-infra-reviewer-20260101-110000.log"
OUT=$(run_collect "$CANON14" "$LEGACY14")
ROW77=$(jq -c '.rows[] | select(.issue == "77")' <<< "$OUT")
if [ "$(jq -r '.origin' <<< "$ROW77")" = "canonical" ] && [ "$(jq -r '.log' <<< "$ROW77")" = "$CANON14/logs/iac-stage-1-infra-writer-20260101-120000-issue-77.log" ]; then
    pass "infra canonico: origin canonical y log por stage con sufijo -issue-N"
else
    fail "fila infra canonica incorrecta: $ROW77"
fi
if [ "$(jq -r '.progress_pct' <<< "$ROW77")" = "30" ] && [ "$(jq -r '.state' <<< "$ROW77")" = "hold" ] \
   && [ "$(jq -r '.stage' <<< "$ROW77")" = "1-infra-writer" ]; then
    pass "infra canonico: progreso 30 (infra-writer) y estado hold visibles"
else
    fail "progreso/hold ausentes en la fila infra: $ROW77"
fi
ROW78=$(jq -c '.rows[] | select(.issue == "78")' <<< "$OUT")
if [ "$(jq -r '.origin' <<< "$ROW78")" = "legacy" ] && [ "$(jq -r '.log' <<< "$ROW78")" = "$LEGACY14/logs/iac-stage-2-infra-reviewer-20260101-110000.log" ]; then
    pass "infra legacy sigue visible sin migrar, con su log sin sufijo"
else
    fail "fila infra legacy incorrecta: $ROW78"
fi

echo ""
echo "[15] #1730: PR y log de corrida terminada en history[]"
CANON15="$TMP/h1730/canonical"; LEGACY15="$TMP/h1730/legacy"
mkdir -p "$CANON15/logs" "$LEGACY15/logs"
touch "$CANON15/logs/iac-pipeline-20260101-100000.log"
touch "$CANON15/logs/tooling-pipeline-20260101-110000-v2.log"
touch "$CANON15/logs/run-12-20260101-120000.log" "$CANON15/logs/pipeline-20260101-120000.log"
touch "$LEGACY15/logs/pipeline-20260101-130000-v3.log"
{
    echo '{"issue":66,"pipeline":"infra","state":"completed","started":"20260101-100000","finished":"2026-01-01T10:05:00","environment":"dev","pr":"https://github.com/o/r/pull/66"}'
    echo '{"issue":67,"pipeline":"tooling","variant":"v2","state":"completed","started":"20260101-110000","finished":"2026-01-01T11:05:00"}'
    echo "{\"issue\":68,\"pipeline\":\"tdd\",\"state\":\"completed\",\"started\":\"20260101-120000\",\"finished\":\"2026-01-01T12:05:00\",\"log\":\"$CANON15/logs/run-12-20260101-120000.log\"}"
    echo '{"issue":69,"pipeline":"tdd","variant":"v3","state":"completed","started":"20260101-130000","finished":"2026-01-01T13:05:00"}'
} > "$CANON15/pipeline-history.jsonl"
OUT=$(run_collect "$CANON15" "$LEGACY15")
H66=$(jq -c '.history[] | select(.issue == "66" or .issue == 66)' <<< "$OUT")
if [ "$(jq -r '.pr' <<< "$H66")" = "https://github.com/o/r/pull/66" ] \
   && [ "$(jq -r '.detail' <<< "$H66")" = "env:dev, PR #66" ] \
   && [ "$(jq -r '.log' <<< "$H66")" = "$CANON15/logs/iac-pipeline-20260101-100000.log" ]; then
    pass "infra: pr expuesto, detail env+PR y log de corrida sin log ni stage"
else
    fail "entrada infra incorrecta: $H66"
fi
H67=$(jq -c '.history[] | select(.issue == "67" or .issue == 67)' <<< "$OUT")
if [ "$(jq -r '.log' <<< "$H67")" = "$CANON15/logs/tooling-pipeline-20260101-110000-v2.log" ] \
   && [ "$(jq -r '.pr' <<< "$H67")" = "null" ]; then
    pass "tooling con variant: log de corrida con sufijo y pr null"
else
    fail "entrada tooling con variante incorrecta: $H67"
fi
H68=$(jq -c '.history[] | select(.issue == "68" or .issue == 68)' <<< "$OUT")
if [ "$(jq -r '.log' <<< "$H68")" = "$CANON15/logs/run-12-20260101-120000.log" ]; then
    pass "log declarado existente conserva prioridad sobre el log de corrida"
else
    fail "log declarado no conservado: $H68"
fi
H69=$(jq -c '.history[] | select(.issue == "69" or .issue == 69)' <<< "$OUT")
if [ "$(jq -r '.log' <<< "$H69")" = "$LEGACY15/logs/pipeline-20260101-130000-v3.log" ]; then
    pass "tdd con variant: log de corrida resuelto desde el root legacy"
else
    fail "fallback legacy de log de corrida incorrecto: $H69"
fi

echo ""
echo "----------------------------------------"
echo "  Resumen: $PASS pass, $FAIL fail"
echo "----------------------------------------"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
