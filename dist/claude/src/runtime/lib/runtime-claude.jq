# runtime-claude.jq -- Traduccion de la traza stream-json cruda de Claude Code
# al JSONL neutral (MEF-ADR-0049 CA-1, issue #859). Programa jq invocado desde
# runtime_claude_translate (runtime-claude.sh) con `-R -s` (el stream crudo
# entero como un unico string), `--arg runtime`/`--arg model_param`,
# `--arg exit_code` (exit code del proceso, "" si el caller no lo conoce) y
# `--rawfile stderr_text` (stderr crudo del proceso, "" si no hubo).
#
# Gemela de `translateStream` (lib/runtime-claude.mts), la que usa el runner
# (MEF-ADR-0057): un cambio va en los dos lados; runtime-claude.test.mts las
# compara.
#
# Mapeo (CA-2): `assistant` con bloques `text` -> `message{role:"assistant"}`;
# bloques `tool_use` -> `tool.started{tool, input_summary}` (issue #863: para
# los tools de archivo -- Edit, Write, Read -- `input_summary` es
# `.input.file_path`; para `Bash`, los primeros 80 caracteres de
# `.input.command`; para cualquier otro tool, `null` -- nunca se inventa un
# valor que el tool_use no trae); `user` con `tool_result` ->
# `tool.completed{tool, ok, duration_ms}` (tool resuelto por
# emparejamiento tool_use.id <-> tool_result.tool_use_id, mismo patron que
# compute_stage_metrics en _mefisto-common.sh); `result` -> terminal
# (run.completed/run.failed). El evento `system`/`init` NUNCA se re-emite como
# linea propia -- este adaptador jamas produce `run.started` (eso es
# responsabilidad exclusiva del runner, ver src/runtime/contract/README.md,
# "Interfaz de adaptador"): solo se usa para extraer `session_id` y `model`,
# que van a parar al evento terminal (CA-4).
#
# `duration_ms` del terminal SIEMPRE null aqui: mefisto-run-agent.sh lo
# sobreescribe con el reloj de pared que mide el runner (unico dueno de ese
# dato), nunca un valor fabricado por el adaptador (mismo contrato que
# runtime-fake.sh).
#
# Clasificacion (CA-3), en el mismo orden que classify_agent_failure
# (_mefisto-common.sh). El TIMEOUT del watchdog no aparece aqui a proposito:
# lo sintetiza el runner, que es quien tiene la senal y el reloj de pared
# (ver mefisto-run-agent.sh, "Normalizacion a EXACTAMENTE un evento terminal").
#
#   0. Exito declarado: `result.is_error==false` + `subtype=="success"` +
#      `stop_reason=="end_turn"` -> success. Gana sobre CUALQUIER exit code,
#      igual que agent_failure_is_unrecoverable desde el PR #446: si el CLI
#      alcanzo a declarar cumplido su contrato, una senal o un exit distinto
#      de cero POSTERIOR es una muerte de despues, no trabajo a medias. Esa
#      muerte no se pierde: queda documentada en `error{kind,detail}` sobre un
#      `run.completed{status:"success"}` -- el caso que run-events.schema.json
#      reconoce explicitamente en el `$comment` de `error`.
#   1. exit 137/143 -> killed (senal; SIGKILL/SIGTERM).
#   2. Un evento `rate_limit_event` con `rate_limit_info.status != "allowed"`
#      -> rate_limit, con `resets_at` poblado desde `rate_limit_info.resetsAt`
#      (epoch segundos -> ISO 8601) -- issue #965. Gana sobre cualquier
#      clasificacion posterior de `result`/stderr: la MISMA ventana agotada
#      puede terminar como un `result.is_error` con `api_error_status:429`, o
#      como un corte de stream a mitad de la respuesta sintetica ("You're out
#      of extra usage..."), y en ambos casos es la misma causa, no un
#      `api_error`/`stream_cut` generico. Forma real verificada en dos issues
#      publicos de Anthropic (ningun transcript local disponible la capturo,
#      ver notas tecnicas del issue #965):
#      anthropics/claude-agent-sdk-python#599 (CLI v2.1.49, evento suelto en
#      el stream: `{"type":"rate_limit_event","rate_limit_info":
#      {"rateLimitType":"five_hour","resetsAt":<epoch>,"status":"allowed"}}`)
#      y anthropics/claude-code#57096 (CLI v2.1.132, secuencia completa de un
#      429 real: el `rate_limit_event` con `status:"rejected"` precede a un
#      `assistant` sintetico y al `result{is_error:true,api_error_status:429}`
#      que el punto 3 clasificaria como api_error si este punto no existiera).
#   3. `result.is_error==true` -> provider_unavailable si `api_error_status`
#      es 5xx (522/529 incluidos), api_error en cualquier otro caso (un 4xx
#      que no es limite de uso, sin cambio de comportamiento -- issue #965
#      CA-2), con "API Error: <status>" en el detalle cuando el CLI trae
#      `api_error_status`. Forma real capturada del CLI v2.1.220 (ver bloque
#      [G] de test-stream-json-trace.sh): en un fallo de API el status viaja
#      DENTRO del evento `result`, con `subtype` todavia en "success".
#   4. stderr con `API Error: 5xx` (y solo despues `4xx`) -> mismo split
#      5xx->provider_unavailable / 4xx->api_error del punto anterior. Mismo
#      orden y mismos greps que antes del issue #965: el 5xx precede al 4xx,
#      y ambos preceden al corte de stream generico, que es mas amplio y se
#      los tragaria. La traza de stdout y el stderr siguen separados (#425),
#      por eso hacen falta las dos fuentes.
#   5. Sin evento `result`:
#        - ultima linea no vacia del stream sin parsear (corte a mitad de
#          escritura) -> stream_cut;
#        - stderr con "Connection closed mid-response" (el otro patron de
#          agent_log_has_stream_cut) -> stream_cut;
#        - en cualquier otro caso -> no_result (el proceso termino sin
#          declarar nada).
#   6. `result` presente que no declara exito ni `is_error` (p. ej.
#      `subtype=="error_max_turns"`) o exit distinto de cero sin patron
#      reconocido -> nonzero_exit.

def parse_ts:
    if . == null or (type != "string") then null
    else
        ((capture("^(?<base>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\\.(?<frac>[0-9]+))?Z$")) // null) as $c
        | if $c == null then null
          else
              (($c.base + "Z") | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime) as $sec
              | $sec * 1000 + (if $c.frac then (($c.frac + "000") | .[0:3] | tonumber) else 0 end)
          end
    end;

# Los detalles de error viajan a un JSONL que se lee en terminal: una linea de
# stderr de varios KB (un stack trace del CLI) no aporta nada por encima de su
# encabezado y si arruina la legibilidad de todo el log neutral.
def clip: if . == null then null else (tostring | .[0:300]) end;

# input_summary de un tool_use (issue #863): ruta relativa al cwd para los
# tools de archivo (Edit/Write/Read comparten el parametro `file_path`),
# primeros 80 caracteres del comando para Bash, `null` para cualquier otro
# tool -- nunca se inventa un resumen que el tool_use no trae.
def claude_input_summary($name; $input):
    if ($name == "Edit" or $name == "Write" or $name == "Read") then ($input.file_path // null)
    elif ($name == "Bash") then (($input.command // null) | if . == null then null else (tostring | .[0:80]) end)
    else null end;

(now | todate) as $fallback_ts
| ($model_param | if . == "" then null else . end) as $model_param_or_null
| ($exit_code | if . == "" then null else (tonumber? // null) end) as $exit

| (split("\n")) as $raw_lines
| ($raw_lines | map(select(length > 0))) as $nonblank
| ($nonblank | map(try fromjson catch null)) as $parsed
| ($parsed | map(select(. != null and type == "object"))) as $events
| (
    ($nonblank | length) as $n
    | if $n == 0 then false else ($parsed[$n - 1] == null) end
  ) as $truncated

| ($stderr_text | split("\n")) as $stderr_lines
| ($stderr_lines | map(select(test("API Error: 5"))) | first) as $stderr_api_5xx
| ($stderr_lines | map(select(test("API Error: 4"))) | first) as $stderr_api_4xx
| ($stderr_lines | map(select(test("Connection closed mid-response"))) | first) as $stderr_cut

# Ventana de uso agotada (issue #965): ver comentario de cabecera, punto 2.
# `last` y no `first` porque el CLI puede emitir varios `rate_limit_event`
# informativos con status "allowed" antes del que de verdad rechaza la
# peticion -- el ultimo rechazado es el que describe el desenlace real.
| ($events | map(select(.type == "rate_limit_event"))) as $rate_limit_events
| ($rate_limit_events | map(select((.rate_limit_info.status // "allowed") != "allowed")) | last) as $rate_limit_rejected_event
| ($rate_limit_rejected_event != null) as $rate_limit_rejected
| ($rate_limit_rejected_event.rate_limit_info.resetsAt // null) as $resets_at_epoch
| (if $resets_at_epoch == null then null else ($resets_at_epoch | try todate catch null) end) as $resets_at_iso
| ($rate_limit_rejected_event.rate_limit_info.rateLimitType // null) as $rate_limit_type

| ($events | map(select(.type == "system" and .subtype == "init")) | (.[0].session_id // null)) as $session_id
| ($events | map(select(.type == "system" and .subtype == "init")) | (.[0].model // null)) as $model_from_init
| ($events | map(select(.type == "assistant")) | (.[0].message.model // null)) as $model_from_assistant
| ($model_from_init // $model_from_assistant // $model_param_or_null) as $resolved_model

| (
    [ $events[] | select(.type == "assistant") | . as $ev
      | ($ev.message.content // [])[]?
      | select(.type == "tool_use")
      | {id: (.id // ""), name: (.name // "?"), ts: ($ev.timestamp | parse_ts)}
    ]
  ) as $tool_uses
| ($tool_uses | map({(.id): {name: .name, ts: .ts}}) | add // {}) as $tool_by_id

| [
    $events[] | . as $ev
    | if ($ev.type == "assistant") then
          ($ev.message.content // [])[]?
          | if .type == "text" then
                {v: 1, type: "message", ts: ($ev.timestamp // $fallback_ts), role: "assistant", text: (.text // "")}
            elif .type == "tool_use" then
                {v: 1, type: "tool.started", ts: ($ev.timestamp // $fallback_ts), tool: (.name // "?"),
                 input_summary: (claude_input_summary(.name // "?"; .input // {}))}
            else empty end
      elif ($ev.type == "user") then
          ($ev.message.content // [])[]?
          | select(.type == "tool_result")
          | (.tool_use_id // "") as $tid
          | ($tool_by_id[$tid].name // "?") as $tname
          | ($tool_by_id[$tid].ts) as $start_ms
          | ($ev.timestamp | parse_ts) as $end_ms
          | {
              v: 1, type: "tool.completed", ts: ($ev.timestamp // $fallback_ts),
              tool: $tname,
              ok: (if .is_error == true then false else true end),
              duration_ms: (if ($start_ms != null and $end_ms != null) then ($end_ms - $start_ms) else null end)
            }
      else empty end
  ] as $translated_events

| ($events | map(select(.type == "result")) | last) as $result
| ($result != null and $result.is_error == false
   and $result.subtype == "success" and $result.stop_reason == "end_turn") as $declared_success
| (($exit == 137) or ($exit == 143)) as $signaled
| ($exit != null and $exit != 0) as $nonzero
| (
    if $result != null and ($result.api_error_status // null) != null
      then "API Error: " + ($result.api_error_status | tostring) + " "
      else "" end
  ) as $result_api_prefix
| (
    if $declared_success then
        {
          status: "success",
          error_kind: (if $signaled then "killed" elif $nonzero then "nonzero_exit" else null end),
          error_detail: (
              if $signaled then "el CLI declaro exito y murio despues por senal (exit " + ($exit | tostring) + ")"
              elif $nonzero then "el CLI declaro exito y termino despues con exit " + ($exit | tostring)
              else null end
          )
        }
    elif $signaled then
        {
          status: "failed",
          error_kind: "killed",
          error_detail: ("el proceso murio por senal (exit " + ($exit | tostring) + ") sin declarar exito")
        }
    elif $rate_limit_rejected then
        {
          status: "failed",
          error_kind: "rate_limit",
          error_detail: ("ventana de uso agotada (rateLimitType=" + ($rate_limit_type // "?")
              + ", resetsAt=" + ($resets_at_iso // "?") + ")")
        }
    elif ($result != null and $result.is_error == true) then
        (
          (
            ($result_api_prefix
              + ((($result.result) // $result.error // $result.terminal_reason // $result.subtype // "error") | tostring)
            ) | clip
          ) as $is_error_detail
          | if (($result.api_error_status // null) != null and (($result.api_error_status | tostring) | test("^5")))
            then { status: "failed", error_kind: "provider_unavailable", error_detail: $is_error_detail }
            else { status: "failed", error_kind: "api_error", error_detail: $is_error_detail }
            end
        )
    elif ($stderr_api_5xx != null) then
        { status: "failed", error_kind: "provider_unavailable", error_detail: ($stderr_api_5xx | clip) }
    elif ($stderr_api_4xx != null) then
        { status: "failed", error_kind: "api_error", error_detail: ($stderr_api_4xx | clip) }
    elif ($result == null and $truncated) then
        {
          status: "failed",
          error_kind: "stream_cut",
          error_detail: "el stream de Claude se corto a mitad de escritura"
        }
    elif ($result == null and $stderr_cut != null) then
        { status: "failed", error_kind: "stream_cut", error_detail: ($stderr_cut | clip) }
    elif ($result == null) then
        {
          status: "failed",
          error_kind: "no_result",
          error_detail: ("el stream de Claude termino sin un evento result"
              + (if $exit != null then " (exit " + ($exit | tostring) + ")" else "" end))
        }
    else
        {
          status: "failed",
          error_kind: "nonzero_exit",
          error_detail: ("stop_reason=" + (($result.stop_reason // "?") | tostring)
              + " subtype=" + (($result.subtype // "?") | tostring)
              + (if $exit != null then " exit=" + ($exit | tostring) else "" end))
        }
    end
  ) as $verdict

| {
    v: 1,
    type: (if $verdict.status == "success" then "run.completed" else "run.failed" end),
    ts: ($result.timestamp // $fallback_ts),
    status: $verdict.status,
    runtime: $runtime,
    model: $resolved_model,
    session_id: $session_id,
    duration_ms: null,
    tokens: {
      input: ($result.usage.input_tokens // null),
      output: ($result.usage.output_tokens // null),
      cache_read: ($result.usage.cache_read_input_tokens // null),
      cache_write: ($result.usage.cache_creation_input_tokens // null),
      reasoning: null
    },
    estimated_cost_usd: ($result.total_cost_usd // null),
    turns: ($result.num_turns // null),
    denials: (if (($result.permission_denials // null) | type) == "array" then ($result.permission_denials | length) else null end),
    ttft_ms: ($result.ttft_ms // null),
    api_duration_ms: ($result.duration_api_ms // null),
    error: (if $verdict.error_kind == null then null else {kind: $verdict.error_kind, detail: $verdict.error_detail} end),
    resets_at: (if $verdict.error_kind == "rate_limit" then $resets_at_iso else null end)
  } as $terminal

| $translated_events[], $terminal
