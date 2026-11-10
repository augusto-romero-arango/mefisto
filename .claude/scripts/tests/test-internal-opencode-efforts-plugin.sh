#!/usr/bin/env bash
# test-internal-opencode-efforts-plugin.sh -- Prueba (issue #2505) el plugin
# OpenCode generado .opencode/plugins/mefisto-efforts.js: snapshot y --check del
# generador, paridad de datos embebidos con la fuente neutral y el hook `config`
# ejecutado con node, sin iniciar OpenCode ni consultar red.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd -P)"
GENERATOR="$REPO_ROOT/src/internal/scripts/generate-internal-adapters.sh"
RUNTIME_LIB="$REPO_ROOT/src/runtime/lib/runtime-opencode.sh"
PLUGIN_REL=".opencode/plugins/mefisto-efforts.js"
GENERATED="$REPO_ROOT/$PLUGIN_REL"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

if ! command -v node >/dev/null 2>&1; then
    printf 'SKIP: node no esta instalado\n'
    exit 0
fi

printf '[generador]\n'
mkdir -p "$WORK/out"
"$GENERATOR" --out "$WORK/out" >/dev/null 2>&1 || { fail 'el generador fallo contra un --out limpio'; exit 1; }
cmp -s "$GENERATED" "$WORK/out/$PLUGIN_REL" && pass 'snapshot versionado coincide con la salida del generador' || fail 'snapshot de efforts divergente'
head -1 "$GENERATED" | grep -q '^// GENERADO por src/internal/scripts/generate-internal-adapters.sh ' && pass 'plugin declara marcador de generado' || fail 'plugin sin marcador de generado'

CHECK_OUT="$("$GENERATOR" --check --out "$WORK/out" 2>&1)"; [ -z "$CHECK_OUT" ] && pass '--check en verde con el plugin presente' || fail "--check inesperado: $CHECK_OUT"
rm "$WORK/out/$PLUGIN_REL"
CHECK_OUT="$("$GENERATOR" --check --out "$WORK/out" 2>&1)"; echo "$CHECK_OUT" | grep -qF "$PLUGIN_REL: faltante" && pass '--check detecta plugin faltante' || fail "--check no detecto faltante: $CHECK_OUT"
printf '// GENERADO por src/internal/scripts/generate-internal-adapters.sh desde src/internal/agents/*.md. No editar a mano.\n// alterado\n' > "$WORK/out/$PLUGIN_REL"
CHECK_OUT="$("$GENERATOR" --check --out "$WORK/out" 2>&1)"; echo "$CHECK_OUT" | grep -qF "$PLUGIN_REL: distinta" && pass '--check detecta plugin distinto' || fail "--check no detecto distinta: $CHECK_OUT"
cp "$GENERATED" "$WORK/out/$PLUGIN_REL"
printf '// huerfano\n' > "$WORK/out/.opencode/plugins/otro.js"
CHECK_OUT="$("$GENERATOR" --check --out "$WORK/out" 2>&1)"; echo "$CHECK_OUT" | grep -qF '.opencode/plugins/otro.js: sin marcador' && pass '--check detecta plugin sin marcador' || fail "--check no detecto sin marcador: $CHECK_OUT"
printf '// GENERADO por src/internal/scripts/generate-internal-adapters.sh desde src/internal/agents/*.md. No editar a mano.\n' > "$WORK/out/.opencode/plugins/otro.js"
CHECK_OUT="$("$GENERATOR" --check --out "$WORK/out" 2>&1)"; echo "$CHECK_OUT" | grep -qF '.opencode/plugins/otro.js: huerfana' && pass '--check detecta plugin huerfano' || fail "--check no detecto huerfana: $CHECK_OUT"

printf '[paridad]\n'
RUNTIME_TABLE="$(bash -c 'source "$1"; for l in quick light standard thorough exhaustive; do printf "%s=%s\n" "$l" "$(runtime_opencode_default_effort "$l")"; done' _ "$RUNTIME_LIB")"
EXPECTED_AGENTS="$(for f in "$REPO_ROOT"/src/internal/agents/*.md; do awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$f" | jq -c '{id, profile, effort}'; done | jq -s -c 'sort_by(.id)')"
EMBEDDED_AGENTS="$(sed -n 's/^const agents = \(.*\);$/\1/p' "$GENERATED")"
EMBEDDED_NATIVES="$(sed -n 's/^const natives = \(.*\);$/\1/p' "$GENERATED")"
[ "$(jq 'length' <<< "$EMBEDDED_AGENTS")" = 5 ] && [ "$EMBEDDED_AGENTS" = "$EXPECTED_AGENTS" ] && pass 'datos embebidos (5 agentes) coinciden con effort/profile de las fuentes' || fail 'datos embebidos divergen de src/internal/agents'
EXPECTED_NATIVES="$(jq -Rn -c '[inputs | split("=") | {(.[0]): .[1]}] | add' <<< "$RUNTIME_TABLE")"
[ "$EMBEDDED_NATIVES" = "$EXPECTED_NATIVES" ] && pass 'tabla de nativos embebida coincide con el runtime' || fail "tabla embebida divergente: $EMBEDDED_NATIVES"

printf '[hook config]\n'
cp "$GENERATED" "$WORK/mefisto-efforts.js"
mkdir -p "$WORK/none" "$WORK/deep/.mefisto" "$WORK/agent/.mefisto" "$WORK/levels/.mefisto" "$WORK/conflict/.mefisto" "$WORK/broken/.mefisto"
printf '%s\n' '{"opencode":{"profiles":{"deep":"p/deep-model"}}}' > "$WORK/deep/.mefisto/models.json"
printf '%s\n' '{"opencode":{"agents":{"mefisto-writer":"p/writer-model"},"efforts":{"agents":{"mefisto-writer":"light"}}}}' > "$WORK/agent/.mefisto/models.json"
printf '%s\n' '{"opencode":{"profiles":{"deep":"p/deep-model"},"efforts":{"levels":{"thorough":"custom-max"}}}}' > "$WORK/levels/.mefisto/models.json"
cp "$WORK/deep/.mefisto/models.json" "$WORK/conflict/.mefisto/models.json"
printf '%s\n' '{"opencode": ' > "$WORK/broken/.mefisto/models.json"
RESULT="$(WORK="$WORK" node --input-type=module <<EOF2
import plugin from "file://$WORK/mefisto-efforts.js";
const run = async (dir, config) => { const logs = []; const hooks = await plugin({ worktree: process.env.WORK + "/" + dir, client: { app: { log: async (entry) => logs.push(entry.body) } } }); await hooks.config(config); return { config, logs }; };
const none = await run("none", {});
const deep = await run("deep", {});
const agent = await run("agent", {});
const levels = await run("levels", {});
const prior = { prompt: "conservado", permission: { bash: "deny" } };
const merged = await run("deep", { agent: { "mefisto-planner": prior } });
const userModel = { model: "usuario/propio" };
const conflict = await run("conflict", { agent: { "mefisto-planner": userModel } });
let broken; let threw = false;
try { broken = await run("broken", {}); } catch { threw = true; }
console.log(JSON.stringify([
  none.config.agent === undefined && none.logs.length === 0,
  JSON.stringify(deep.config.agent["mefisto-planner"]) === JSON.stringify({ model: "p/deep-model", variant: "xhigh" }) && deep.config.agent["mefisto-investigator"].variant === "xhigh" && deep.config.agent["mefisto-writer"] === undefined && deep.logs.length === 0,
  JSON.stringify(agent.config.agent) === JSON.stringify({ "mefisto-writer": { model: "p/writer-model", variant: "medium" } }),
  levels.config.agent["mefisto-planner"].variant === "custom-max" && levels.config.agent["mefisto-planner"].model === "p/deep-model",
  merged.config.agent["mefisto-planner"].prompt === "conservado" && merged.config.agent["mefisto-planner"].permission.bash === "deny" && merged.config.agent["mefisto-planner"].variant === "xhigh",
  conflict.config.agent["mefisto-planner"] === userModel && JSON.stringify(userModel) === '{"model":"usuario/propio"}' && conflict.logs.some((l) => l.message === "efforts_config_conflict" && l.extra.agent === "mefisto-planner") && conflict.config.agent["mefisto-investigator"].model === "p/deep-model",
  !threw && broken.config.agent === undefined && broken.logs.length === 1 && broken.logs[0].message === "efforts_mapping_invalid"
]));
EOF2
)"
[ "$RESULT" = '[true,true,true,true,true,true,true]' ] && pass 'sin mapping, perfil, agente+nivel, levels, preservacion, conflicto y mapping ilegible' || fail "contrato del hook de efforts invalido: $RESULT"
printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
