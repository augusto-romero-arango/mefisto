# Piloto Claude Code del experimento LSP en agentes C# (issue #979)

Ejecuta, para el brazo **Claude Code** unicamente, el protocolo fijado por
`docs/testing/lsp-experiment-protocol.md` (issue #976). No compara cifras
absolutas contra otro runtime; esa comparacion no existe en ningun punto de
este documento ni de la sintesis posterior (#981).

## Veredicto

**NO EVALUABLE.** El preflight de disponibilidad (CA-1) se ejecuto completo
hasta el punto en que puede ejecutarse y falla en el gate de disponibilidad
del mecanismo LSP: el plugin oficial `csharp-lsp` no esta instalado en el
entorno donde corre este piloto (aunque el marketplace que lo distribuye si
esta configurado), el binario `csharp-ls` que ese plugin invoca no existe en
el `PATH`, y **dos consultas de control dentro de `claude -p` headless
confirman empiricamente que la sesion no declara ninguna tool `LSP`**. Sin
esa tool no hay brazo LSP que correr, asi que ningun par texto-vs-LSP de los
tres casos del protocolo puede ejecutarse. Siguiendo la regla de parada del
protocolo (seccion "Preflight y reglas de parada" de #976) y CA-1 de este
issue, el piloto **termina aqui, sin fingir cifras** para ningun campo del
formato de evidencia.

| CA (#979) | Estado | Nota |
|---|---|---|
| CA-1 | pasa (preflight ejecutado; concluye `no evaluable`) | version de Claude Code, modelo, version declarada del plugin, ausencia del binario, SHA del consumidor y **la consulta de control ejecutada en `claude -p`**, todos documentados abajo con evidencia reproducible |
| CA-2 | no evaluable | cero pares corridos: no hay tool LSP que exponer en el brazo LSP de ningun caso |
| CA-3 | no evaluable | no hay filas de evidencia que reportar; la tabla de metricas del protocolo queda vacia por diseno, no rellenada con datos ficticios |
| CA-4 | no evaluable | no hay edicion dentro de un brazo LSP cuya frescura verificar |
| CA-5 | pasa (conclusion `no evaluable` para los tres roles, sin generalizar) | ver "Conclusion por rol" abajo |
| CA-6 | pasa | `changelog.d/979.added.md` creado; ningun frontmatter ni doctrina de agente cambia como consecuencia de este piloto |

## Preflight (CA-1)

El protocolo fija cuatro gates que deben estar en verde **antes** de contar
cualquier par como valido. Este piloto los evalua en orden y se detiene en el
primero que falla:

| # | Gate | Resultado |
|---|---|---|
| 1 | Binario `csharp-ls` presente | **falla** |
| 2 | Plugin `csharp-lsp` instalado y habilitado | **falla** |
| 3 | Tool `LSP` disponible en una consulta de control dentro de `claude -p` | **falla** (verificado, no inferido) |
| 4 | Frescura de las respuestas semanticas tras una edicion | no alcanzado (requiere el gate 3 en verde) |

### Entorno verificado

| Item | Valor | Como se verifico |
|---|---|---|
| Fecha | 2026-09-07 | -- |
| Claude Code | `2.1.263` | `claude --version` |
| Modelo de las consultas de control | `claude-opus-5` (default de `claude -p` sin `--model` en este entorno) | campo `modelUsage` del `--output-format json` de ambas consultas (ver abajo) |
| Modelo de la etapa que redacta este reporte | `sonnet` (alias del frontmatter de la etapa del pipeline interno) | -- |
| Marketplace `claude-plugins-official` | configurado | `claude plugin marketplace list` -> `claude-plugins-official` (fuente `anthropics/claude-plugins-official`) |
| Plugin `csharp-lsp` | **no instalado** | `claude plugin list` no muestra ninguna entrada `csharp-lsp@claude-plugins-official`; el unico plugin de ese marketplace instalado es `azure@claude-plugins-official` (`Status: disabled`) |
| Version declarada de `csharp-lsp` | `1.0.0` | `marketplace.json` del marketplace oficial: `{"name":"csharp-lsp","version":"1.0.0","source":"./plugins/csharp-lsp", ...}`, coincide con **[1]** |
| Como registra el plugin la capacidad | `lspServers: {"csharp-ls": {"command": "csharp-ls", "extensionToLanguage": {".cs": "csharp"}}}` | misma entrada de `marketplace.json` **[1]**. Es la cadena causal completa del fallo: el plugin no aporta un servidor propio, **ejecuta** el binario `csharp-ls` del `PATH` -- sin binario no hay servidor, y sin plugin instalado no hay ni siquiera intento de ejecutarlo |
| Binario `csharp-ls` | **no encontrado** | `which csharp-ls` -> `csharp-ls not found` (exit 1); el plugin espera el servidor instalado via `dotnet tool install --global csharp-ls` o Homebrew **[2]**, ninguno de los dos se ejecuto |
| .NET SDK | `10.0.201` (>= 6.0 requerido por el plugin) | `dotnet --version` -- el SDK no es el gate que falla |
| SHA del consumidor | `21757bd2d6c0b261443158c4aec25e83e7f6597c` | reverificado hoy con `gh api repos/augusto-romero-arango/Bitakora.ControlAsistencia/commits/21757bd2d6c0b261443158c4aec25e83e7f6597c --jq .sha`: sigue siendo alcanzable, mismo valor que fijo #976 |
| Baseline textual sin MCP de Rider (#978) | **mergeado y verificado** | `grep -rn "jetbrains\|Rider" agents/ commands/ skills/` no devuelve ninguna declaracion `mcp__jetbrains__*` ni prescripcion de ese servidor (el unico hit es un patron de `.gitignore` generado por `infra-base-scaffolder`); commit `5502ab7` en la historia de esta rama |

### Consulta de control en `claude -p` headless (gate 3)

El protocolo exige confirmar disponibilidad **con una consulta pequena**, no
solo verificar la instalacion, porque los reportes **[3]**/**[4]** del tracker
distinguen el modo interactivo del headless y `claude -p` es el modo real del
pipeline publicado. Ese paso **se ejecuto**; no se dio por inferido a partir
de los gates 1 y 2:

| Consulta | Prompt | Resultado | Sesion | `duration_api_ms` | Costo USD |
|---|---|---|---|---|---|
| C1 | enumerar los nombres exactos de las tools disponibles | la enumeracion de tools integradas devuelta (`Agent, Bash, Edit, ListAgents, Read, ReportFindings, ScheduleWakeup, ShareOnboardingGuide, Skill, ToolSearch, Workflow, Write, CronCreate, ... WebFetch, WebSearch`, seguida del bloque de tools `mcp__*`) **no contiene ninguna entrada `LSP`** | `77191d71-c0d7-4c24-9b5b-ad2f05427036` | 12903 | 0.282739 |
| C2 | responder `SI`/`NO` a si existe una tool llamada exactamente `LSP` | `NO` | `e76945ad-dd33-4f42-86ed-00a521ba2c4b` | 3520 | 0.230874 |

Reproducible con `claude -p '<prompt>' --output-format json`; los campos
`session_id`, `modelUsage`, `duration_api_ms` y `total_cost_usd` salen tal
cual de ese JSON.

Dos consultas y no una porque miden cosas distintas: C1 enumera y por tanto
distingue "la tool no esta" de "el modelo no quiso responder"; C2 pregunta de
forma cerrada por el nombre exacto y elimina la posibilidad de que la
enumeracion de C1 estuviera simplemente truncada. Ambas coinciden.

Dos limitaciones de este gate, registradas en vez de omitidas:

- Las consultas corrieron desde el worktree de Mefisto, no desde un worktree
  del consumidor. No cambia la conclusion: `csharp-lsp` no esta instalado a
  **ningun** scope (`claude plugin list` cubre user y project), asi que ningun
  directorio de trabajo puede exponer la tool. Un piloto futuro con el plugin
  instalado si debe correr el gate desde el worktree del consumidor, donde hay
  archivos `.cs` que el servidor pueda abrir.
- Las consultas corrieron en la sesion padre. El reporte **[3]** ubica la poda
  de la tool en los subagentes, asi que un preflight futuro debe repetir el
  gate **dentro** de los subagentes que cada etapa del pipeline invoca, no
  solo en el padre. Aqui esa distincion no cambia nada -- una tool ausente en
  el padre no puede aparecer en un subagente -- pero si importara en cuanto el
  gate 2 pase.

### Por que este piloto no instala el plugin por su cuenta

Instalar `csharp-lsp@claude-plugins-official` cambia configuracion de plugins
a nivel de usuario/maquina (`claude plugin install`), fuera del arbol del
repo y fuera del alcance de esta corrida (una etapa headless del pipeline
publicado de tooling, sin turno humano que confirme un cambio de entorno
compartido). Con el plugin no disponible en el entorno donde el pipeline
publicado corre hoy, la respuesta correcta del protocolo es exactamente esta:
`no evaluable`, no una instalacion improvisada a mitad de una corrida
documentada como medicion.

## Casos, brazos y formato de evidencia (CA-2, CA-3, CA-4)

Los tres casos de #976 (`planner` / analisis de impacto, `implementer` /
cambio sobre test rojo, `reviewer` / revision de diff transversal) quedan sin
ejecutar. La tabla de evidencia queda con la cabecera comun que #976 fija --
para que #981 la concatene sin normalizar nada a mano -- y **sin ninguna
fila**:

| caso | rol | brazo | pos | rep | tokens_in | tokens_out | costo | wall_clock_s | tool_calls | reintentos | build | tests | hallazgos_mayores | oraculo | cache |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

No existe ninguna repeticion del brazo LSP que reportar; el brazo texto
tampoco se corrio de forma aislada, porque un par requiere ambos brazos y el
protocolo no acepta pares incompletos. Ningun valor de esta tabla se rellena
por extrapolacion, promedio ni suposicion. Las cifras de las dos consultas de
control de arriba **no** son filas de este corpus: miden disponibilidad de la
tool, no un caso del experimento, y no entran en ninguna mediana.

La verificacion de frescura tras una edicion (CA-4 de este issue, gate 4 del
preflight) tampoco aplica: requiere una edicion real dentro de un brazo LSP
en curso, y ese brazo nunca arranco.

## Conclusion por rol (CA-5)

Para los tres roles del corpus (`planner`, `implementer`, `reviewer`) el
resultado es **`no evaluable`**, siguiendo literalmente la regla de #976:
*"Si el reemplazo no es posible (el mecanismo LSP no esta disponible de forma
estable), el rol concluye `no evaluable` y queda fuera de la sintesis de
#981"*. Aqui el mecanismo no esta disponible desde el gate 1, antes de
cualquier repeticion, asi que los tres roles heredan la misma conclusion sin
necesidad de evaluarlos por separado.

El criterio de decision de dos pasos de #976 se aplica asi, en su orden:

1. **No inferioridad de calidad**: no evaluable. Exige que el brazo LSP pase
   el mismo oraculo independiente que el brazo texto en las 3 repeticiones;
   con cero repeticiones del brazo LSP no hay nada que comparar. El rol **no**
   queda "rechazado por calidad": rechazar exigiria haber observado al brazo
   LSP fallar el oraculo, y no se lo observo en absoluto.
2. **Beneficio neto** (medianas de tokens de input y wall-clock, umbrales
   -10% / -15% con la otra metrica sin empeorar mas de 10%): **no se mira**,
   por dos motivos independientes -- el paso 1 no aprobo, y no hay tres
   repeticiones validas por brazo sobre las que calcular ninguna mediana.

Este resultado:

- **No se generaliza** a `test-writer`, `smoke-test-writer` ni las variantes
  de proyecciones (`projection-test-writer`, `projections-scaffolder`,
  `projection-implementer` en su rol read-side) -- #976 ya los excluye del
  corpus y este piloto no aporta evidencia a favor ni en contra para ellos.
- **No se compara** con el piloto de otro runtime: cada uno corre su propio
  preflight sobre su propio mecanismo y llega a su propia conclusion.
- **No decide adopcion de LSP** en ningun agente publicado: esa decision es
  de #981, y de todas formas requeriria evidencia favorable que este piloto
  no produjo.
- **Es especifico de este entorno en esta fecha**, no una afirmacion sobre el
  plugin `csharp-lsp` en abstracto: el plugin existe, esta versionado
  (`1.0.0`) y documentado por el marketplace oficial **[1]**; lo que falta es
  la instalacion local del plugin y del binario que lo respalda, no evidencia
  de que sea inviable en principio.
- **No es determinista al 100%.** Las dos consultas de control dependen de
  que el modelo describa correctamente su propio conjunto de tools. Se
  mitigo con dos formulaciones distintas que coinciden y con los gates 1 y 2,
  que son verificaciones de proceso (`which`, `claude plugin list`) sin
  intermediacion del modelo. El acuerdo de las tres evidencias es lo que
  sostiene la conclusion, no ninguna de ellas por si sola.

## Que sigue (backlog, no ejecutado en este piloto)

Para que un piloto Claude Code futuro deje de terminar en `no evaluable`:

1. Instalar el binario: `dotnet tool install --global csharp-ls` (o
   `brew install csharp-ls` en macOS) **[2]**, y verificar con
   `which csharp-ls` + `csharp-ls --version` (la version resuelta en tiempo de
   ejecucion es un dato del preflight, no se conoce hoy).
2. Instalar y habilitar el plugin:
   `claude plugin install csharp-lsp@claude-plugins-official`, y confirmar con
   `claude plugin list` que aparece con `Status: enabled`. Si tras instalarlo
   la tool `LSP` sigue sin aparecer en el gate 3, probar con una sesion nueva
   antes de concluir nada: **no esta verificado en este piloto** si los
   plugins se resuelven solo al arrancar la sesion o tambien en caliente, y
   esa duda es precisamente lo que el gate 3 resuelve por observacion.
3. Repetir los cuatro gates de este documento -- ahora si con el gate 3
   corriendo desde un worktree del consumidor y dentro de los subagentes que
   invoca cada etapa headless (donde **[3]** reporta la poda), y con el gate 4
   de frescura tras una edicion real.
4. Solo con los cuatro gates en verde, ejecutar los 3 casos x 3 pares que
   fija #976, con worktrees limpios del SHA congelado y contrabalanceo de
   orden, y llenar la tabla de evidencia con datos reales.

Cada corrida futura reverifica los cuatro gates desde cero: la verificacion
de hoy vale para hoy y para este entorno, y no sustituye la del piloto que
finalmente mida.

## Fuentes

- **[1]** `anthropics/claude-plugins-official`, `.claude-plugin/marketplace.json`
  -- entrada `csharp-lsp`, version `1.0.0`, fuente `./plugins/csharp-lsp`,
  bloque `lspServers` que declara `command: csharp-ls` y
  `extensionToLanguage: {".cs": "csharp"}`. Leido el 2026-09-07 con
  `gh api repos/anthropics/claude-plugins-official/contents/.claude-plugin/marketplace.json`.
  https://github.com/anthropics/claude-plugins-official
- **[2]** `anthropics/claude-plugins-official`, `plugins/csharp-lsp/README.md`
  -- instalacion del servidor via `dotnet tool install --global csharp-ls` o
  Homebrew, requisito de .NET SDK 6.0+. Verificado por fetch HTTP el
  2026-09-07.
  https://github.com/anthropics/claude-plugins-official/tree/main/plugins/csharp-lsp
- **[3]** `anthropics/claude-code#84125` (abierto) -- "LSP tool is pruned from
  all subagent tool sets in interactive sessions (present in the parent, and
  in subagents under -p)". Senal de riesgo de terceros, no fuente normativa;
  citada aqui porque fija por que el gate 3 debe correr dentro de las etapas
  headless reales del pipeline, subagentes incluidos, y no solo en la sesion
  padre.
  https://github.com/anthropics/claude-code/issues/84125
- **[4]** `anthropics/claude-code#79744` (abierto) -- "Interactive LSP client
  never sends didChange after Edit-tool writes -- server buffers stay frozen
  at first-query content (headless `-p` syncs correctly)". Misma naturaleza:
  senal de riesgo, no normativa; motiva el gate 4 de frescura en vez de
  asumirlo.
  https://github.com/anthropics/claude-code/issues/79744
- `docs/testing/lsp-experiment-protocol.md` (issue #976) -- protocolo, corpus,
  formato de evidencia y umbrales que este documento intenta ejecutar. Sus
  fuentes **[2]**/**[3]** son las que aqui aparecen como **[3]**/**[4]**: la
  numeracion es local a cada documento, la URL es la clave estable.
