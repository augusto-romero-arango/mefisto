#!/usr/bin/env bash
# Prueba el hook config del plugin de efforts sin iniciar OpenCode ni consultar red,
# y la paridad de sus datos embebidos con el contrato neutral.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd -P)"
ADAPTER="$REPO_ROOT/src/published/scripts/adapters/adapter-opencode.sh"
RUNTIME_LIB="$REPO_ROOT/src/runtime/lib/runtime-opencode.sh"
GENERATED="$REPO_ROOT/dist/opencode/plugins/mefisto-efforts.js"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

"$ADAPTER" render-asset efforts-config "$REPO_ROOT/src/published/contract/published-artifact.schema.json" > "$WORK/mefisto-efforts.js" || exit 1
cmp -s "$GENERATED" "$WORK/mefisto-efforts.js" && pass 'snapshot generado coincide con dist/opencode' || fail 'snapshot de efforts divergente'
head -1 "$WORK/mefisto-efforts.js" | grep -q '^// GENERADO por ' && pass 'plugin declara marcador de generado' || fail 'plugin sin marcador de generado'

printf '[paridad]\n'
ADAPTER_TABLE="$(bash -c 'source "$1"; for l in quick light standard thorough exhaustive; do printf "%s=%s\n" "$l" "$(published_opencode_effort "$l")"; done' _ "$ADAPTER")"
RUNTIME_TABLE="$(bash -c 'source "$1"; for l in quick light standard thorough exhaustive; do printf "%s=%s\n" "$l" "$(runtime_opencode_default_effort "$l")"; done' _ "$RUNTIME_LIB")"
[ -n "$ADAPTER_TABLE" ] && [ "$ADAPTER_TABLE" = "$RUNTIME_TABLE" ] && pass 'published_opencode_effort coincide con runtime_opencode_default_effort en los 5 niveles' || fail "tabla de nativos divergente: [$ADAPTER_TABLE] vs [$RUNTIME_TABLE]"
EXPECTED_AGENTS="$(for f in "$REPO_ROOT"/src/published/agents/*.md; do awk 'NR == 1 { next } $0 == "---" { exit } { print }' "$f" | jq -c '{id, profile, effort}'; done | jq -s -c 'sort_by(.id)')"
EMBEDDED_AGENTS="$(sed -n 's/^const agents = \(.*\);$/\1/p' "$WORK/mefisto-efforts.js")"
EMBEDDED_NATIVES="$(sed -n 's/^const natives = \(.*\);$/\1/p' "$WORK/mefisto-efforts.js")"
[ "$(jq 'length' <<< "$EMBEDDED_AGENTS")" = 22 ] && [ "$EMBEDDED_AGENTS" = "$EXPECTED_AGENTS" ] && pass 'datos embebidos (22 agentes) coinciden con effort/profile de las fuentes' || fail 'datos embebidos divergen de src/published/agents'
EXPECTED_NATIVES="$(jq -Rn -c '[inputs | split("=") | {(.[0]): .[1]}] | add' <<< "$RUNTIME_TABLE")"
[ "$EMBEDDED_NATIVES" = "$EXPECTED_NATIVES" ] && pass 'tabla de nativos embebida coincide con el runtime' || fail "tabla embebida divergente: $EMBEDDED_NATIVES"

printf '[hook config]\n'
mkdir -p "$WORK/none" "$WORK/deep/.mefisto" "$WORK/agent/.mefisto" "$WORK/levels/.mefisto" "$WORK/conflict/.mefisto" "$WORK/broken/.mefisto"
printf '%s\n' '{"opencode":{"profiles":{"deep":"p/deep-model"}}}' > "$WORK/deep/.mefisto/models.json"
printf '%s\n' '{"opencode":{"agents":{"test-writer":"p/writer-model"},"efforts":{"agents":{"test-writer":"standard"}}}}' > "$WORK/agent/.mefisto/models.json"
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
const merged = await run("deep", { agent: { planner: prior } });
const userModel = { model: "usuario/propio" };
const conflict = await run("conflict", { agent: { planner: userModel } });
let broken; let threw = false;
try { broken = await run("broken", {}); } catch { threw = true; }
console.log(JSON.stringify([
  none.config.agent === undefined && none.logs.length === 0,
  JSON.stringify(deep.config.agent.planner) === JSON.stringify({ model: "p/deep-model", variant: "xhigh" }) && deep.config.agent["bug-investigator"].variant === "xhigh" && deep.config.agent.implementer === undefined && deep.logs.length === 0,
  JSON.stringify(agent.config.agent) === JSON.stringify({ "test-writer": { model: "p/writer-model", variant: "high" } }),
  levels.config.agent.planner.variant === "custom-max" && levels.config.agent.planner.model === "p/deep-model",
  merged.config.agent.planner.prompt === "conservado" && merged.config.agent.planner.permission.bash === "deny" && merged.config.agent.planner.variant === "xhigh",
  conflict.config.agent.planner === userModel && JSON.stringify(userModel) === '{"model":"usuario/propio"}' && conflict.logs.some((l) => l.message === "efforts_config_conflict" && l.extra.agent === "planner") && conflict.config.agent["bug-investigator"].model === "p/deep-model",
  !threw && broken.config.agent === undefined && broken.logs.length === 1 && broken.logs[0].message === "efforts_mapping_invalid"
]));
EOF2
)"
[ "$RESULT" = '[true,true,true,true,true,true,true]' ] && pass 'sin mapping, perfil, agente+nivel, levels, preservacion, conflicto y mapping ilegible' || fail "contrato del hook de efforts invalido: $RESULT"
printf 'RESULTADO: %s pasaron, %s fallaron\n' "$PASS" "$FAIL"
exit "$FAIL"
