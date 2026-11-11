# Contrato neutral de hooks interactivos

`interactive-hooks.json` expresa siete hechos publicados, sin fijar un runtime ni una forma ejecutable. Claude materializa `append-session-model` en `Stop`: lee únicamente el `transcript_path` que recibió en ese payload y observa el último `assistant.message.model` no vacío. `timeoutSeconds: null` significa que Mefisto no agrega un plazo: el límite efectivo es el que documente y aplique cada runtime.

La persistencia se rige por allowlist (MEF-ADR-0025). Ningún binding conserva prompts, input completo de herramientas, comandos shell completos, tokens, cookies, headers, variables de credenciales ni auth stores.

| Binding | Inputs mínimos permitidos | Salida/destino lógico permitido | Handler vigente |
|---|---|---|---|
| `record-active-release` | identidad de la distribución activa observable | `release_identity` en `canonical-state` y `release-identity`; exclusivamente como transición, también puede reflejar esa misma identidad en `legacy-release-marker` | `SessionStart`, primer comando |
| `append-session` | `record_type`, `session_id`, `transcript_path`, `cwd`, `source`, `timestamp`, `runtime`, `model`, `harness_version`, `harness_commit` | Una línea `session.started` con esas diez claves, exactamente, en `canonical-state` y `session-registry`. `model`, versión y commit pueden ser `null`; `runtime` identifica al adaptador. | Inicio de sesión del adaptador |
| `append-session-model` | `record_type`, `session_id`, `timestamp`, `runtime`, `model`, `harness_version`, `harness_commit` | Una línea `session.model-observed` con esas siete claves, exactamente. `model` es un identificador opaco no vacío observado por el runtime; no persiste `provider` separado. | Observación de modelo del adaptador |
| `remind-field-notes` | fin de turno con cambios de archivo (una vez por sesión) | Solo el recordatorio visible al usuario en `human-log`; no persiste datos | `Stop`, con marcador por `session_id` bajo `.mefisto/pipeline/` |
| `append-file-change` | path del archivo cambiado | `time` (`HH:MM:SS` UTC), familia fija `archivo` y `file_path` en `canonical-state` y `human-log` | `PostToolUse` con matcher `Write|Edit` |
| `append-dotnet-test-result` | resultado resumido de la prueba | `time` (`HH:MM:SS` UTC), familia fija `test` y `result` limitado a `PASS|FAIL` en `canonical-state` y `human-log` | primer comando de `PostToolUse` con matcher `Bash` |
| `append-terraform-result` | subcomando y resultado resumido de Terraform | `time` (`HH:MM:SS` UTC), familia fija `terraform`, `terraform_subcommand` limitado a `plan|apply|init|validate` y `result` limitado a `OK|ERROR` en `canonical-state` y `human-log` | segundo comando de `PostToolUse` con matcher `Bash` |

No se declara comportamiento para fin de sesión, inicio de herramienta, prompt, permiso, notificación ni compactación: no existen handlers vigentes para esas señales.

## Sesiones correlacionables

`sessions.jsonl` es append-only por `session_id`. Claude conserva `SessionStart.model` cuando llega; tras `/clear` puede faltar y registra `null`. Al cierre de cada turno, observa el último modelo efectivo desde el transcript explícito; transcript ausente, ilegible o sin un modelo observable no agrega un hecho. Una observación posterior se agrega solo si difiere del último modelo no nulo de la sesión: A→A no duplica y A→B conserva ambos hechos. No se actualizan, borran ni reescriben líneas existentes. Los lectores deben aceptar líneas históricas de seis campos sin `record_type` como inicios legacy con identidad faltante.

`runtime` admite `claude`. La versión y el commit se leen únicamente del manifiesto verificable de la distribución cargada; su ausencia o malformación produce `null`. Los adaptadores no consultan Git, red, caches arbitrarios, credenciales, auth stores ni configuración del proveedor. Esta limitación aplica MEF-ADR-0025, MEF-ADR-0031, MEF-ADR-0049, MEF-ADR-0050 y MEF-ADR-0053.

## Excepción transitoria del marker de release

El destino lógico `legacy-release-marker` está reservado en exclusiva a `record-active-release`. El adaptador Claude escribe primero la identidad/ruta de la distribución cargada observada desde `CLAUDE_PLUGIN_ROOT` en `.mefisto/pipeline/.plugin-root` y refleja exactamente ese valor en `.claude/pipeline/.plugin-root`; limpia `.claude/pipeline/.plugin-root.previous` sin copiarlo. El estado canónico sigue siendo obligatorio y primario: el adaptador no resuelve dos versiones ni usa el release más reciente del cache como fallback, porque ese cache puede haber avanzado y no describir la versión que la sesión ya cargó.

El fallo al mantener el mirror no invalida la sesión (`failure: continue`) ni autoriza dual-write para `.mefisto/pipeline/sessions.jsonl` o `.mefisto/pipeline/events.log`, que se escriben solo en el estado canónico. La excepción se retira únicamente con un issue posterior, después de un inventario verificable sin lectores de `.claude/pipeline/.plugin-root` ni `.claude/pipeline/.plugin-root.previous`; el cierre de #1054 no la retira implícitamente. Véanse MEF-ADR-0053, decisión 4, y la matriz de adaptación.

## Adaptador Claude Code

`hooks/hooks.json` lo genera `../scripts/generate-claude-hooks.sh`. Cada hook usa la forma exec de Claude Code: `command: "node"` más `args` con `${CLAUDE_PLUGIN_ROOT}/scripts/interactive-hooks.mts` y el id del binding. No interviene ningún shell, así que el hook corre igual en macOS, Linux y Windows (MEF-ADR-0057, decisión 3). `scripts/interactive-hooks.mts` implementa los siete bindings; su comportamiento lo cubre `scripts/tests/interactive-hooks.test.mts`.

Requiere Node 22.18 o posterior en el `PATH` y Claude Code con la forma exec de hooks, disponible desde la versión 2.1.139 ([changelog de Claude Code](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)).

## Matriz de adaptación

Ver [adaptation-matrix.md](adaptation-matrix.md). La matriz es deliberadamente separada del descriptor: puede nombrar capacidades de runtime y debe conservar la evidencia oficial, mientras el JSON permanece neutral.

## Validación

`../scripts/validate-interactive-hooks.sh` es un shim de `validate-interactive-hooks.mts`, que corre sobre Node 22.18 o posterior sin `jq`; valida el descriptor y un archivo alternativo pasado como único argumento. Sus fixtures y el test de inventario (`../scripts/tests/interactive-hooks-contract.test.mts` e `interactive-hooks-inventory.test.mts`) no necesitan red ni instalaciones de runtime.
