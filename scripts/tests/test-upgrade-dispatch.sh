#!/usr/bin/env bash
# Test de scripts/upgrade.sh (issue #1678): JSON de --status, delegacion en
# update-plugin.sh, argumentos rechazados, runtime no soportado y guard del repo
# de Mefisto. update-plugin.sh es un stub.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PASS=0; FAIL=0
ok() { echo "  PASS: $1"; PASS=$((PASS+1)); }
ko() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

command -v jq >/dev/null 2>&1 || { echo "jq requerido"; exit 1; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
CONSUMER="$TMP/consumer"; STUBS="$TMP/scripts"
mkdir -p "$CONSUMER/.claude/pipeline" "$STUBS"
git -C "$CONSUMER" init -q
cp "$REPO_ROOT/scripts/upgrade.sh" "$STUBS/"
printf '/x/cache/mkt/mefisto/1.0.0' > "$CONSUMER/.claude/pipeline/.plugin-root"

cat > "$STUBS/update-plugin.sh" <<'S'
#!/usr/bin/env bash
echo "update-plugin $*" >> "$STUB_LOG"
exit "${STUB_UPDATE_RC:-0}"
S
chmod +x "$STUBS"/*.sh
export STUB_LOG="$TMP/log"
run_in() { local dir="$1"; shift; : > "$STUB_LOG"; (cd "$dir" && "$STUBS/upgrade.sh" "$@" 2>&1); }
run() { run_in "$CONSUMER" "$@"; }
log() { cat "$STUB_LOG"; }

echo "[a] delegacion en update-plugin.sh"
MEFISTO_RUNTIME=claude run >/dev/null; [ "$(log)" = "update-plugin " ] && ok "sin flags" || ko "sin flags: $(log)"
MEFISTO_RUNTIME=claude run --prune --only 0.8.0 --loaded 0.9.0 >/dev/null; [ "$(log)" = "update-plugin --prune --only 0.8.0 --loaded 0.9.0" ] && ok "--prune --loaded" || ko "--prune --loaded: $(log)"
MEFISTO_RUNTIME=claude run --prune --only 0.43.0,0.44.0 >/dev/null; [ "$(log)" = "update-plugin --prune --only 0.43.0,0.44.0" ] && ok "--prune reenvia --only y sin --loaded no lo infiere de .plugin-root" || ko "--prune: $(log)"
MEFISTO_RUNTIME=claude run --disable-user >/dev/null; [ "$(log)" = "update-plugin --disable-user" ] && ok "--disable-user" || ko "--disable-user: $(log)"
STUB_UPDATE_RC=7 MEFISTO_RUNTIME=claude run >/dev/null; rc=$?
[ "$rc" -eq 7 ] && ok "propaga el exit code de update-plugin.sh" || ko "exit code: $rc"
STUB_UPDATE_RC=7 MEFISTO_RUNTIME=claude run --disable-user >/dev/null; rc=$?
[ "$rc" -eq 7 ] && ok "--disable-user propaga el exit code" || ko "exit code --disable-user: $rc"

LR="$TMP/cache/mefisto"
for v in 0.44.0 0.44.1; do mkdir -p "$LR/$v/.claude-plugin"; printf '{"name":"mefisto","version":"%s"}' "$v" > "$LR/$v/.claude-plugin/plugin.json"; done
mkdir -p "$TMP/cache/otro/9.9.9/.claude-plugin"; printf '{"name":"otro","version":"9.9.9"}' > "$TMP/cache/otro/9.9.9/.claude-plugin/plugin.json"
MEFISTO_LOADED_ROOT="$LR/0.44.1" MEFISTO_RUNTIME=claude run >/dev/null; [ "$(log)" = "update-plugin --loaded 0.44.1" ] && ok "MEFISTO_LOADED_ROOT valida reenvia --loaded (actualizar)" || ko "loaded actualizar: $(log)"
MEFISTO_LOADED_ROOT="$LR/0.44.1" MEFISTO_RUNTIME=claude run --prune --only 0.43.0 >/dev/null; [ "$(log)" = "update-plugin --prune --only 0.43.0 --loaded 0.44.1" ] && ok "--prune reenvia --loaded desde MEFISTO_LOADED_ROOT" || ko "prune loaded: $(log)"
MEFISTO_LOADED_ROOT="$LR/0.44.1" MEFISTO_RUNTIME=claude run --prune --only 0.8.0 --loaded 0.9.0 >/dev/null; [ "$(log)" = "update-plugin --prune --only 0.8.0 --loaded 0.9.0" ] && ok "--loaded explicito gana" || ko "explicito: $(log)"
for bad in "" '${CLAUDE_PLUGIN_ROOT}' "$LR/0.44.0/../0.44.1" "$LR/9.9.9" "$TMP/cache/otro/9.9.9" "relativa/0.44.1"; do
    MEFISTO_LOADED_ROOT="$bad" MEFISTO_RUNTIME=claude run >/dev/null; [ "$(log)" = "update-plugin " ] && ok "MEFISTO_LOADED_ROOT '$bad' se ignora" || ko "invalida '$bad': $(log)"
done

echo "[b] --status JSON"
out=$(MEFISTO_RUNTIME=claude run --status); rc=$?
[ "$rc" -eq 0 ] && echo "$out" | jq -e '. == {schemaVersion: 3, runtime: "claude", installedVersion: "1.0.0"}' >/dev/null && ok "schemaVersion 3 sin peer" || ko "status: rc=$rc $out"
[ -z "$(log)" ] && ok "--status no delega en update-plugin.sh" || ko "--status delego: $(log)"
SIN_ROOT="$TMP/consumer-sin-root"; mkdir -p "$SIN_ROOT"; git -C "$SIN_ROOT" init -q
out=$(MEFISTO_RUNTIME=claude run_in "$SIN_ROOT" --status)
echo "$out" | jq -e '.schemaVersion == 3 and .installedVersion == null' >/dev/null && ok "sin .plugin-root -> installedVersion null" || ko "sin .plugin-root: $out"

echo "[c] argumentos desconocidos"
for flag in --align-peer --keep; do
    out=$(MEFISTO_RUNTIME=claude run "$flag"); rc=$?
    [ "$rc" -ne 0 ] && has "$out" "argumento desconocido '$flag'" && ok "$flag se rechaza" || ko "$flag no se rechazo: rc=$rc $out"
    [ -z "$(log)" ] && ok "$flag no delega" || ko "$flag delego: $(log)"
done
out=$(MEFISTO_RUNTIME=claude run --prune --keep 3); rc=$?
[ "$rc" -ne 0 ] && [ -z "$(log)" ] && ok "--prune --keep no poda" || ko "--prune --keep: rc=$rc $(log)"

echo "[d] runtime distinto de claude"
for args in "--status" "" "--prune --only 0.8.0" "--disable-user"; do
    # shellcheck disable=SC2086
    out=$(MEFISTO_RUNTIME=fake run $args); rc=$?
    [ "$rc" -ne 0 ] && has "$out" "runtime 'fake' no soportado" && [ -z "$(log)" ] && ok "aborta sin delegar (${args:-actualizar})" || ko "no aborta (${args:-actualizar}): rc=$rc $out $(log)"
done

echo "[e] guard del repo de Mefisto"
MEFISTO_REPO="$TMP/mefisto"; mkdir -p "$MEFISTO_REPO/.claude-plugin"; git -C "$MEFISTO_REPO" init -q
printf '{"name":"mefisto"}' > "$MEFISTO_REPO/.claude-plugin/plugin.json"
for args in "--status" "" "--disable-user"; do
    # shellcheck disable=SC2086
    out=$(MEFISTO_RUNTIME=claude run_in "$MEFISTO_REPO" $args); rc=$?
    [ "$rc" -ne 0 ] && has "$out" "no aplica al repo de Mefisto" && [ -z "$(log)" ] && ok "se niega en el repo de Mefisto (${args:-actualizar})" || ko "guard (${args:-actualizar}): rc=$rc $out $(log)"
done
NO_GIT="$TMP/no-git"; mkdir -p "$NO_GIT"
out=$(MEFISTO_RUNTIME=claude GIT_CEILING_DIRECTORIES="$TMP" run_in "$NO_GIT"); rc=$?
[ "$rc" -ne 0 ] && has "$out" "no estas en un repositorio git" && [ -z "$(log)" ] && ok "fuera de un repo git aborta" || ko "fuera de git: rc=$rc $out"

echo ""; echo "Resultado: $PASS pass, $FAIL fail"
[ "$FAIL" -eq 0 ]
