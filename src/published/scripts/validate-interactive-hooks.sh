#!/usr/bin/env bash
# Valida el contrato neutral de hooks interactivos publicados (Bash 3.2 + jq).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
HOOKS_DIR="$REPO_ROOT/src/published/hooks"
SCHEMA="$HOOKS_DIR/interactive-hooks.schema.json"
DEFAULT_CONTRACT="$HOOKS_DIR/interactive-hooks.json"

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq no esta instalado" >&2; exit 1; }
[ -f "$SCHEMA" ] || { echo "ERROR: falta schema: $SCHEMA" >&2; exit 1; }
jq empty "$SCHEMA" >/dev/null 2>&1 || { echo "ERROR: schema JSON invalido" >&2; exit 1; }

if [ "$#" -gt 1 ]; then echo "Uso: $(basename "$0") [contrato.json]" >&2; exit 1; fi
CONTRACT="${1:-$DEFAULT_CONTRACT}"
[ -f "$CONTRACT" ] || { echo "$CONTRACT: archivo no existe" >&2; exit 1; }
if ! jq empty "$CONTRACT" >/dev/null 2>&1; then echo "$CONTRACT: JSON invalido" >&2; exit 1; fi

ERRORS=$(jq -r --slurpfile specification "$SCHEMA" '
  def keys_are($expected): (keys | sort) == ($expected | sort);
  def fail($message): $message;
  $specification[0] as $spec |
  $spec["$defs"].binding as $binding_schema |
  ($spec.properties.bindings.items.allOf[1].oneOf
    | map({key: .properties.id.const, value: {
        signal: .properties.signal.const,
        action: .properties.action.const,
        destinations: .properties.destinations.const,
        fields: .properties.persistedFields.const
      }}) | from_entries) as $contracts |
  {mode: $binding_schema.properties.delivery.properties.mode.const,
   failure: $binding_schema.properties.delivery.properties.failure.const,
   timeoutSeconds: null} as $delivery |
  . as $contract |
  (if type != "object" then fail("raiz: debe ser objeto")
  elif keys_are(["$schema", "contractVersion", "bindings"]) | not then fail("raiz: propiedad adicional o faltante")
  elif .["$schema"] != $spec.properties["$schema"].const then fail("$schema: valor desconocido")
  elif .contractVersion != $spec.properties.contractVersion.const then fail("contractVersion: valor desconocido")
  elif (.bindings | type) != "array" or (.bindings | length) != $spec.properties.bindings.minItems then fail("bindings: se esperaban exactamente siete bindings")
  else empty end),
  ($contract.bindings[]? |
    if type != "object" then fail("binding: debe ser objeto")
    elif keys_are(["id", "signal", "action", "destinations", "persistedFields", "delivery"]) | not then fail("binding: propiedad adicional o faltante")
    elif (.id | type) != "string" or (.id | test("^[a-z0-9]+(-[a-z0-9]+)*$") | not) then fail("binding: id invalido")
    elif (.signal as $signal | $binding_schema.properties.signal.enum | index($signal)) == null then fail("binding " + .id + ": signal desconocida")
    elif (.action as $action | $binding_schema.properties.action.enum | index($action)) == null then fail("binding " + .id + ": accion desconocida")
    elif (.destinations | type) != "array" or (.destinations | length) == 0 or any(.destinations[]; . as $destination | ($binding_schema.properties.destinations.items.enum | index($destination)) == null) then fail("binding " + .id + ": destino desconocido")
    elif (.destinations | unique | length) != (.destinations | length) then fail("binding " + .id + ": destinos duplicados")
    elif (.persistedFields | type) != "array" or any(.persistedFields[]; type != "string") then fail("binding " + .id + ": campo persistible desconocido")
    elif any(.persistedFields[]; test("(^|[-_])(prompt|command|token|cookie|header|credential|authorization|password|secret|api[-_]?key|auth[-_]?store)([-_]|$)"; "i")) then fail("binding " + .id + ": campo persistible sensible")
    elif (.delivery | type) != "object" or (.delivery | keys_are(["mode", "failure", "timeoutSeconds"]) | not) or (.delivery != $delivery) then fail("binding " + .id + ": delivery divergente")
    elif ($contracts[.id] == null) then fail("binding " + .id + ": accion sin contrato")
    else . as $binding | $contracts[$binding.id] as $expected |
      if $binding.signal != $expected.signal or $binding.action != $expected.action then fail("binding " + $binding.id + ": par signal/action desconocido")
      elif ($binding.id == "record-active-release" and ($binding.destinations | index("canonical-state")) == null) then fail("binding record-active-release: falta el destino canonico obligatorio")
      elif $binding.destinations != $expected.destinations then fail("binding " + $binding.id + ": destinos no coinciden con su contrato")
      elif $binding.persistedFields != $expected.fields then fail("binding " + $binding.id + ": allowlist de campos persistibles divergente")
      else empty end
    end),
  (if ([$contract.bindings[].id] | unique | length) != ($contract.bindings | length) then "bindings: id duplicado" else empty end),
  (if ([$contract.bindings[]?.id] | sort) != ($contracts | keys | sort) then "bindings: falta un binding requerido o existe uno sin contrato" else empty end),
  ($contract | [.. | strings | select(test("CLAUDE_[A-Z_]+|\\.claude(/|$)|SessionStart|PostToolUse|ExitPlanMode|Write\\|Edit|tool\\.execute\\.(before|after)|session\\.(created|idle)|(^|[^a-z])(claude|javascript|typescript|cache)([^a-z]|$)"; "i"))] | unique[]? | "contrato: referencia a runtime: " + .)
' "$CONTRACT") || { echo "$CONTRACT: no se pudo evaluar el contrato" >&2; exit 1; }

if [ -n "$ERRORS" ]; then printf '%s\n' "$ERRORS" >&2; exit 1; fi
exit 0
