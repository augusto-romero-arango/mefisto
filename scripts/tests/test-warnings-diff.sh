#!/usr/bin/env bash
# test-warnings-diff.sh -- Tests de scripts/warnings-diff.sh (issue #2405).
#
# Corre el script real como subproceso dentro de repos fixture (git init en
# mktemp -d, SIN .claude-plugin/plugin.json).
#   [pre]  existe, ejecutable, sintaxis valida
#   [CA-1] warning nuevo, linea movida, .sh sin commitear, duplicado
#   [CA-2] supresiones (.sh y .shellcheckrc)
#   [CA-3] cache sin worktree y limpieza del worktree temporal
#   [CA-4] toolchain no soportada / ausente / guard en Mefisto
#   [path] --path acota el analisis
#   [fix]  WARNINGS_DIFF_FIXTURE_DIR
#   [dotnet] toolchain dotnet con fixtures del file logger (issue #2417)
#   [terraform] toolchain terraform con fixtures y stub (issue #2418)
#   consola del build (dotnet) y linea de tiempos por fase (issue #2507)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REAL_SCRIPT="$REPO_ROOT/scripts/warnings-diff.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

TMPS=()
trap 'for d in "${TMPS[@]:-}"; do [ -n "$d" ] && rm -rf "$d"; done' EXIT

new_repo() {
    local d
    d=$(mktemp -d)
    TMPS+=("$d")
    git -C "$d" init -q -b main
    git -C "$d" config user.email t@t
    git -C "$d" config user.name t
    printf '#!/usr/bin/env bash\nfoo=1\ncd /tmp\necho ok\n' > "$d/a.sh"
    git -C "$d" add -A
    git -C "$d" commit -q -m base
    echo "$d"
}

run_wd() { # dir args...
    local d="$1"; shift
    (cd "$d" && "$REAL_SCRIPT" "$@" 2>&1)
}

echo "[pre] warnings-diff.sh existe, es ejecutable y tiene sintaxis valida"
if [ -x "$REAL_SCRIPT" ] && bash -n "$REAL_SCRIPT"; then pass "existe, ejecutable, sintaxis ok"; else fail "script ausente o invalido"; fi

if ! command -v shellcheck >/dev/null 2>&1; then
    echo "  SKIP: shellcheck no instalado; casos CA-1..CA-3 omitidos"
else
echo "[CA-1] warning nuevo"
R=$(new_repo); BASE=$(git -C "$R" rev-parse HEAD)
printf 'bar=2\n' >> "$R/a.sh"
OUT=$(run_wd "$R" --toolchain shell --base "$BASE"); RC=$?
if [ "$RC" -eq 2 ] && echo "$OUT" | grep -q '^NEW shell a.sh SC2034 ' && echo "$OUT" | grep -q '^warnings nuevos: 1$'; then
    pass "warning nuevo -> NEW + exit 2"; else fail "warning nuevo (rc=$RC): $OUT"; fi

echo "[CA-1] linea movida"
R=$(new_repo); BASE=$(git -C "$R" rev-parse HEAD)
printf '#!/usr/bin/env bash\ncd /tmp\necho ok\n\nfoo=1\n' > "$R/a.sh"
OUT=$(run_wd "$R" --toolchain shell --base "$BASE"); RC=$?
if [ "$RC" -eq 0 ]; then pass "warning movido de linea -> exit 0"; else fail "movido (rc=$RC): $OUT"; fi

echo "[CA-1] .sh nuevo sin commitear"
R=$(new_repo); BASE=$(git -C "$R" rev-parse HEAD)
printf '#!/usr/bin/env bash\nzed=1\n' > "$R/b.sh"
OUT=$(run_wd "$R" --toolchain shell --base "$BASE"); RC=$?
if [ "$RC" -eq 2 ] && echo "$OUT" | grep -q '^NEW shell b.sh SC2034 '; then pass ".sh sin commitear reportado"; else fail "sin commitear (rc=$RC): $OUT"; fi

echo "[CA-1] duplicado de una clave existente"
R=$(new_repo); BASE=$(git -C "$R" rev-parse HEAD)
printf 'cd /tmp\n' >> "$R/a.sh"
OUT=$(run_wd "$R" --toolchain shell --base "$BASE"); RC=$?
if [ "$RC" -eq 2 ] && [ "$(echo "$OUT" | grep -c '^NEW ')" -eq 1 ]; then pass "duplicado -> exactamente 1 nuevo"; else fail "duplicado (rc=$RC): $OUT"; fi

echo "[CA-2] supresiones"
R=$(new_repo); BASE=$(git -C "$R" rev-parse HEAD)
printf '# shellcheck disable=SC2086\n' >> "$R/a.sh"
printf 'disable=SC2034\n' > "$R/.shellcheckrc"
git -C "$R" add .shellcheckrc
OUT=$(run_wd "$R" --toolchain shell --base "$BASE"); RC=$?
if [ "$RC" -eq 2 ] && echo "$OUT" | grep -q '^NEW shell a.sh SUPPRESSION ' && echo "$OUT" | grep -q '^NEW shell .shellcheckrc SUPPRESSION '; then
    pass "supresiones en .sh y .shellcheckrc"; else fail "supresiones (rc=$RC): $OUT"; fi

echo "[CA-3] cache y worktree temporal"
R=$(new_repo); BASE=$(git -C "$R" rev-parse HEAD)
OUT=$(run_wd "$R" --toolchain shell --base "$BASE")
CACHE="$R/.mefisto/pipeline/warnings-baseline/shell-$BASE-all.txt"
[ -f "$CACHE" ] && pass "cache creado" || fail "cache ausente: $CACHE"
echo "$OUT" | grep -Eq '^warnings-diff: base [0-9]+s \(build\), actual [0-9]+s$' \
    && pass "tiempos (#2507): base sin cache -> (build)" || fail "tiempos sin cache: $OUT"
# Shim de git en PATH que registra cada invocacion: la segunda corrida no debe
# llamar 'git worktree add' (un alias no sirve: git ignora aliases que ocultan
# subcomandos nativos).
SHIM=$(mktemp -d); TMPS+=("$SHIM")
GITLOG="$SHIM/git.log"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s"\nexec "%s" "$@"\n' "$GITLOG" "$(command -v git)" > "$SHIM/git"
chmod +x "$SHIM/git"
OUT=$(cd "$R" && PATH="$SHIM:$PATH" "$REAL_SCRIPT" --toolchain shell --base "$BASE" 2>&1); RC=$?
if [ "$RC" -eq 0 ] && [ -f "$GITLOG" ] && ! grep -q 'worktree add' "$GITLOG"; then
    pass "segunda invocacion reutiliza el cache sin crear worktree"; else fail "cache no reutilizado (rc=$RC): $OUT"; fi
echo "$OUT" | grep -Eq '^warnings-diff: base [0-9]+s \(cache\), actual [0-9]+s$' \
    && pass "tiempos (#2507): base desde cache -> (cache)" || fail "tiempos con cache: $OUT"
[ "$(git -C "$R" worktree list | wc -l | tr -d ' ')" -eq 1 ] && pass "sin worktrees temporales tras salir" || fail "worktree residual"
run_wd "$R" --toolchain shell --base deadbeef >/dev/null; RC=$?
[ "$RC" -eq 1 ] && [ "$(git -C "$R" worktree list | wc -l | tr -d ' ')" -eq 1 ] && pass "base invalida -> exit 1 sin worktree residual" || fail "base invalida (rc=$RC)"
# Error a mitad: sin cache, el worktree se crea y run_shell falla porque
# falta shellcheck en PATH; el trap debe eliminar el worktree igual.
rm -f "$CACHE" "$GITLOG"
NOSC=$(mktemp -d); TMPS+=("$NOSC")
cp "$SHIM/git" "$NOSC/git"
for c in bash env mktemp cat grep sort sed tr rm mkdir cp comm awk basename wc; do
    p=$(command -v "$c") && ln -s "$p" "$NOSC/$c"
done
OUT=$(cd "$R" && PATH="$NOSC" "$REAL_SCRIPT" --toolchain shell --base "$BASE" 2>&1); RC=$?
if [ "$RC" -eq 1 ] && grep -q 'worktree add' "$GITLOG" && [ "$(git -C "$R" worktree list | wc -l | tr -d ' ')" -eq 1 ]; then
    pass "error tras crear el worktree -> exit 1 y trap lo elimina"; else fail "error a mitad (rc=$RC): $OUT"; fi

echo "[path] --path acota el analisis"
R=$(new_repo); BASE=$(git -C "$R" rev-parse HEAD)
mkdir -p "$R/sub"
printf '#!/usr/bin/env bash\nqux=1\n' > "$R/sub/c.sh"
printf 'bar=2\n' >> "$R/a.sh"
OUT=$(run_wd "$R" --toolchain shell --base "$BASE" --path sub); RC=$?
if [ "$RC" -eq 2 ] && echo "$OUT" | grep -q '^NEW shell sub/c.sh SC2034 ' && ! echo "$OUT" | grep -q ' a.sh ' && echo "$OUT" | grep -q '^warnings nuevos: 1$'; then
    pass "--path ignora warnings fuera del subdirectorio"; else fail "--path (rc=$RC): $OUT"; fi
fi

echo "[CA-4] toolchain y guard"
R=$(new_repo)
OUT=$(run_wd "$R" --toolchain nope --base HEAD); RC=$?
if [ "$RC" -eq 1 ] && echo "$OUT" | grep -q 'toolchain no soportada: nope' && echo "$OUT" | grep -q 'Uso:'; then pass "toolchain no registrada -> exit 1 con uso"; else fail "nope (rc=$RC): $OUT"; fi
OUT=$(run_wd "$R"); RC=$?
if [ "$RC" -eq 1 ] && echo "$OUT" | grep -q 'Uso:'; then pass "sin --toolchain -> exit 1 con uso"; else fail "sin toolchain (rc=$RC): $OUT"; fi
OUT=$(cd "$REPO_ROOT" && "$REAL_SCRIPT" --toolchain shell 2>&1); RC=$?
if [ "$RC" -eq 1 ] && echo "$OUT" | grep -q "plugin publicado y solo aplica al consumidor"; then pass "guard en repo de Mefisto"; else fail "guard (rc=$RC): $OUT"; fi

echo "[fix] WARNINGS_DIFF_FIXTURE_DIR"
R=$(new_repo); BASE=$(git -C "$R" rev-parse HEAD)
FX=$(mktemp -d); TMPS+=("$FX")
echo 'a.sh:2:1: warning: foo appears unused. Verify use (or export if used externally). [SC2034]' > "$FX/base.out"
printf '%s\n' 'a.sh:2:1: warning: foo appears unused. Verify use (or export if used externally). [SC2034]' \
    'a.sh:3:1: warning: bar appears unused. Verify use (or export if used externally). [SC2034]' > "$FX/current.out"
OUT=$(cd "$R" && WARNINGS_DIFF_FIXTURE_DIR="$FX" "$REAL_SCRIPT" --toolchain shell --base "$BASE" 2>&1); RC=$?
if [ "$RC" -eq 2 ] && echo "$OUT" | grep -q '^NEW shell a.sh SC2034 bar appears unused' && echo "$OUT" | grep -q '^warnings nuevos: 1$'; then
    pass "fixture dir: parser + diff"; else fail "fixture (rc=$RC): $OUT"; fi
echo "$OUT" | grep -Eq '^warnings-diff: base [0-9]+s \(build\), actual [0-9]+s$' \
    && pass "tiempos (#2507): linea presente con --toolchain shell" || fail "tiempos shell: $OUT"

echo "[dotnet] fixtures del file logger"
FXD="$SCRIPT_DIR/fixtures/warnings-diff/dotnet"
dn() { # fixture-dir
    (cd "$R" && WARNINGS_DIFF_FIXTURE_DIR="$1" "$REAL_SCRIPT" --toolchain dotnet --base "$BASE" 2>&1)
}
R=$(new_repo); BASE=$(git -C "$R" rev-parse HEAD)
OUT=$(dn "$FXD/new"); RC=$?
if [ "$RC" -eq 2 ] && echo "$OUT" | grep -q '^NEW dotnet Poc/Class1.cs CS0168 The variable' && echo "$OUT" | grep -q '^warnings nuevos: 1$'; then
    pass "CA-1: CS0168 solo en el actual -> NEW + exit 2"; else fail "CA-1 (rc=$RC): $OUT"; fi
OUT=$(dn "$FXD/moved"); RC=$?
[ "$RC" -eq 0 ] && pass "CA-1: mismos warnings en otras lineas -> exit 0" || fail "CA-1 movidos (rc=$RC): $OUT"
OUT=$(dn "$FXD/abs"); RC=$?
[ "$RC" -eq 0 ] && pass "CA-2: prefijo de nodo y rutas absolutas distintas -> misma clave" || fail "CA-2 (rc=$RC): $OUT"
FXL=$(mktemp -d); TMPS+=("$FXL")
printf '%s\n' '1:7>/w/Poc/Class1.cs(4): warning CS0168: The variable '"'x'"' is declared but never used [/w/Poc/Poc.csproj]' \
    '1:7>/w/Poc/Poc.csproj : warning NU1603: Poc depends on X (>= 1.0.0) but X 1.0.0 was not found [/w/Poc/Poc.csproj]' > "$FXL/base.out"
printf '%s\n' '/w/Poc/Class1.cs(14,27,14,28) : warning CS0168: The variable '"'x'"' is declared but never used [/w/Poc/Poc.csproj]' \
    '/w/Poc/Poc.csproj : warning NU1603: Poc depends on X (>= 1.0.0) but X 1.0.0 was not found [/w/Poc/Poc.csproj]' > "$FXL/current.out"
printf '/w\n' > "$FXL/base.root"; printf '/w\n' > "$FXL/current.root"
OUT=$(dn "$FXL"); RC=$?
[ "$RC" -eq 0 ] && pass "parser: ubicaciones (l) y (l,c,l,c) y warning sin linea (NU) -> misma clave" || fail "parser ubicaciones (rc=$RC): $OUT"
OUT=$(dn "$FXD/fail-base"); RC=$?
[ "$RC" -eq 1 ] && echo "$OUT" | grep -q 'la base no compila' && pass "CA-4: base fallida -> exit 1" || fail "CA-4 base (rc=$RC): $OUT"
OUT=$(dn "$FXD/fail-current"); RC=$?
[ "$RC" -eq 1 ] && echo "$OUT" | grep -q 'el arbol actual no compila' && pass "CA-4: actual fallido -> exit 1" || fail "CA-4 actual (rc=$RC): $OUT"

echo "[dotnet] consola del build y tiempos (#2507)"
FXC=$(mktemp -d); TMPS+=("$FXC")
cp "$FXD/fail-base/"* "$FXC/" 2>/dev/null
: > "$FXC/current.out"
{ for i in $(seq 1 25); do echo "/w/Poc/Class1.cs($i,1): error CS1002: ; expected [/w/Poc/Poc.csproj]"; done
  echo "Build FAILED."; } > "$FXC/base.console"
echo 1 > "$FXC/base.exitcode"
R=$(new_repo); BASE=$(git -C "$R" rev-parse HEAD)
OUT=$(dn "$FXC"); RC=$?
if [ "$RC" -eq 1 ] && echo "$OUT" | grep -q 'la base no compila' && [ "$(echo "$OUT" | grep -c ': error CS1002')" -eq 20 ] \
    && echo "$OUT" | grep -q "log completo del build: $FXC/base.console" && ! echo "$OUT" | grep -q 'Build FAILED'; then
    pass "CA-2: base.console con ': error ' -> 20 lineas de error y ruta del log"; else fail "CA-2 extracto (rc=$RC): $OUT"; fi
[ ! -d "$R/.mefisto/pipeline/logs" ] && pass "CA-4: modo fixture no escribe en .mefisto/pipeline/logs" || fail "fixture escribio logs"
seq 1 30 | sed 's/^/linea /' > "$FXC/base.console"
OUT=$(dn "$FXC"); RC=$?
if [ "$RC" -eq 1 ] && echo "$OUT" | grep -q '^linea 30$' && echo "$OUT" | grep -q '^linea 11$' && ! echo "$OUT" | grep -q '^linea 10$'; then
    pass "CA-2: sin ': error ' -> ultimas 20 lineas"; else fail "CA-2 cola (rc=$RC): $OUT"; fi
OUT=$(dn "$FXD/new"); RC=$?
if [ "$RC" -eq 2 ] && echo "$OUT" | grep -Eq '^warnings-diff: base [0-9]+s \(build\), actual [0-9]+s$'; then
    pass "CA-3: linea de tiempos con (build) en fixture"; else fail "CA-3 tiempos (rc=$RC): $OUT"; fi
STDOUT_ONLY=$(cd "$R" && WARNINGS_DIFF_FIXTURE_DIR="$FXD/new" "$REAL_SCRIPT" --toolchain dotnet --base "$BASE" 2>/dev/null)
[ "$(echo "$STDOUT_ONLY" | grep -c '')" -eq 2 ] && echo "$STDOUT_ONLY" | head -n1 | grep -q '^NEW dotnet ' && [ "$(echo "$STDOUT_ONLY" | tail -n1)" = 'warnings nuevos: 1' ] \
    && ! echo "$STDOUT_ONLY" | grep -q 'warnings-diff:' && pass "CA-3: stdout sin la linea de tiempos" || fail "CA-3 stdout: $STDOUT_ONLY"
OUT=$(cd "$R" && WARNINGS_DIFF_FIXTURE_DIR="$FXD/moved" "$REAL_SCRIPT" --toolchain dotnet --base "$BASE" 2>&1 >/dev/null)
echo "$OUT" | grep -Eq '^warnings-diff: base [0-9]+s \(build\), actual [0-9]+s$' && pass "CA-3: tiempos presentes con exit 0" || fail "CA-3 exit 0: $OUT"

echo "[dotnet] supresiones"
R=$(new_repo); BASE=$(git -C "$R" rev-parse HEAD)
printf '#pragma warning disable CS0168\n' > "$R/A.cs"
printf '<Project><PropertyGroup><NoWarn>CS0168</NoWarn></PropertyGroup></Project>\n' > "$R/P.csproj"
printf 'dotnet_diagnostic.CS0168.severity = none\n' > "$R/.editorconfig"
OUT=$(dn "$FXD/abs"); RC=$?
if [ "$RC" -eq 2 ] && echo "$OUT" | grep -q '^NEW dotnet A.cs SUPPRESSION ' && echo "$OUT" | grep -q '^NEW dotnet P.csproj SUPPRESSION ' && echo "$OUT" | grep -q '^NEW dotnet .editorconfig SUPPRESSION '; then
    pass "CA-3: pragma, NoWarn y editorconfig reportados"; else fail "CA-3 (rc=$RC): $OUT"; fi

echo "[CA-5] cabecera documenta las opciones obligatorias"
grep -q -- '--no-incremental' "$REAL_SCRIPT" && grep -q 'warningsonly' "$REAL_SCRIPT" && pass "cabecera dotnet documentada" || fail "cabecera sin --no-incremental/warningsonly"

echo "[CA-5] cabecera documenta el log por lado y los tiempos"
grep -q 'warnings-diff-dotnet-<lado>.log' "$REAL_SCRIPT" && grep -q "warnings-diff: base <N>s" "$REAL_SCRIPT" && pass "cabecera documenta log y tiempos" || fail "cabecera sin log/tiempos"

echo "[terraform] fixtures"
if ! command -v jq >/dev/null 2>&1; then
    echo "  SKIP: jq no instalado; casos terraform omitidos"
else
FXT="$SCRIPT_DIR/fixtures/warnings-diff/terraform"
tf() { # fixture-dir
    (cd "$R" && WARNINGS_DIFF_FIXTURE_DIR="$1" "$REAL_SCRIPT" --toolchain terraform --base "$BASE" --path infra/environments/dev 2>&1)
}
R=$(new_repo); BASE=$(git -C "$R" rev-parse HEAD)
OUT=$(tf "$FXT/new"); RC=$?
if [ "$RC" -eq 2 ] && echo "$OUT" | grep -q '^NEW terraform main.tf Deprecated attribute ' && echo "$OUT" | grep -q '^warnings nuevos: 1$'; then
    pass "CA-1: warning solo en el actual -> NEW + exit 2"; else fail "CA-1 (rc=$RC): $OUT"; fi
OUT=$(tf "$FXT/moved"); RC=$?
[ "$RC" -eq 0 ] && pass "CA-1: mismo warning en otra linea -> exit 0" || fail "CA-1 movido (rc=$RC): $OUT"
echo "$OUT" | grep -Eq '^warnings-diff: base [0-9]+s \(build\), actual [0-9]+s$' \
    && pass "tiempos (#2507): linea presente con --toolchain terraform" || fail "tiempos terraform: $OUT"
OUT=$(tf "$FXT/errors-only"); RC=$?
[ "$RC" -eq 0 ] && pass "CA-2: diagnosticos error no cuentan como warnings" || fail "CA-2 error ignorado (rc=$RC): $OUT"
OUT=$(tf "$FXT/invalid"); RC=$?
if [ "$RC" -eq 1 ] && echo "$OUT" | grep -q 'valid=false' && echo "$OUT" | grep -q 'Reference to undeclared input variable'; then
    pass "CA-2: valid=false -> exit 1 con los errores"; else fail "CA-2 invalid (rc=$RC): $OUT"; fi
OUT=$(run_wd "$R" --toolchain terraform --base "$BASE"); RC=$?
if [ "$RC" -eq 1 ] && echo "$OUT" | grep -q -- '--path' && echo "$OUT" | grep -q 'Uso:'; then pass "CA-3: sin --path -> exit 1 con uso"; else fail "CA-3 (rc=$RC): $OUT"; fi

echo "[terraform] TF_PLUGIN_CACHE_DIR (stub)"
STUB=$(mktemp -d); TMPS+=("$STUB")
cat > "$STUB/terraform" <<'STUBEOF'
#!/usr/bin/env bash
echo "$1 cache=${TF_PLUGIN_CACHE_DIR:-UNSET} pwd=$(basename "$PWD")" >> "$STUB_LOG"
[ "$1" = validate ] && echo '{"valid":true,"warning_count":0,"error_count":0,"diagnostics":[]}'
exit 0
STUBEOF
chmod +x "$STUB/terraform"
R=$(new_repo); BASE=$(git -C "$R" rev-parse HEAD)
mkdir -p "$R/infra/environments/dev"; echo '# tf' > "$R/infra/environments/dev/main.tf"
git -C "$R" add -A; git -C "$R" commit -q -m infra; BASE=$(git -C "$R" rev-parse HEAD)
LOG="$STUB/log1"; : > "$LOG"
OUT=$(cd "$R" && env -u TF_PLUGIN_CACHE_DIR PATH="$STUB:$PATH" STUB_LOG="$LOG" "$REAL_SCRIPT" --toolchain terraform --base "$BASE" --path infra/environments/dev 2>&1); RC=$?
if [ "$RC" -eq 0 ] && [ -d "$R/.mefisto/pipeline/terraform-plugin-cache" ] \
    && grep -q 'init cache=.*/.mefisto/pipeline/terraform-plugin-cache pwd=dev' "$LOG" && grep -q '^validate ' "$LOG"; then
    pass "CA-4: sin TF_PLUGIN_CACHE_DIR -> lo exporta y crea el directorio"; else fail "CA-4 default (rc=$RC): $OUT $(cat "$LOG")"; fi
LOG="$STUB/log2"; : > "$LOG"; rm -rf "$R/.mefisto"
OUT=$(cd "$R" && PATH="$STUB:$PATH" STUB_LOG="$LOG" TF_PLUGIN_CACHE_DIR="$STUB/mi-cache" "$REAL_SCRIPT" --toolchain terraform --base "$BASE" --path infra/environments/dev 2>&1); RC=$?
if [ "$RC" -eq 0 ] && grep -q "init cache=$STUB/mi-cache " "$LOG" && [ ! -d "$R/.mefisto/pipeline/terraform-plugin-cache" ]; then
    pass "CA-4: TF_PLUGIN_CACHE_DIR definido se conserva"; else fail "CA-4 respeto (rc=$RC): $OUT $(cat "$LOG")"; fi
fi

echo "----------------------------------------"
echo "Resultado: $PASS pass, $FAIL fail"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
