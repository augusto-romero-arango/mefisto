# MEF-ADR-0052: Decision multi-runtime sobre navegacion semantica en agentes C#

- **Fecha**: 2026-09-07
- **Estado**: aceptado
- **Aplica a**: doctrina de navegacion semantica (LSP) en los agentes publicados que trabajan sobre C# -- los tres roles del corpus de #976 (`planner`, `implementer`, `reviewer`) mas `projection-implementer`, que hereda la doctrina resultante sin haber sido probado --, en el unico runtime con adaptador hoy (Claude Code, MEF-ADR-0057). Sintetiza la evidencia de #979 (piloto Claude Code) sobre el protocolo fijado por #976 (`docs/testing/lsp-experiment-protocol.md`). Cross-referencia MEF-ADR-0050 (neutralidad de toda operacion: la capacidad se expresaria como intencion neutral si se adoptara), MEF-ADR-0049 (arquitectura neutral de runtime: precedente de mapeos por runtime sin confundirlo con soporte publicado disponible), MEF-ADR-0019 (publicado vs interno: identifica que lado consumiria cada follow-up) y MEF-ADR-0030 (esquema de identificacion, fija el numero `0052` como libre).

**Issues bloqueados por este ADR**: ninguno. Este ADR no ejecuta adopcion; los follow-ups de la seccion "Decision, punto 5" quedan como candidatos para issues futuros que declaren su dependencia de `MEF-ADR-0052`, no como trabajo que este documento reserve o bloquee.

## Contexto

#976 fijo un protocolo A/B (`docs/testing/lsp-experiment-protocol.md`) para medir si la navegacion semantica (LSP) reduce tokens/tiempo o mejora calidad frente a busqueda textual, en los tres roles con oraculo independiente (`planner` / analisis de impacto, `implementer` / cambio sobre test rojo, `reviewer` / revision de diff transversal), sobre el mismo SHA congelado del consumidor `Bitakora.ControlAsistencia`. El protocolo declara explicitamente que **solo son validos los deltas texto-vs-LSP dentro del mismo runtime**: cada runtime expone su propio servidor, tool schema, wire format y mecanismo de activacion, y una mejora en uno no autoriza generalizar a otro. #978 retiro antes la dependencia del MCP de Rider de los agentes publicados, asi que el baseline textual del piloto ya no lo usa.

#979 (piloto Claude Code) ejecuta ese protocolo sobre el mecanismo de su runtime: el plugin oficial `csharp-lsp` 1.0.0 del marketplace `anthropics/claude-plugins-official`, respaldado por el binario `csharp-ls`.

Este issue (#981) **sintetiza** esa evidencia; no ejecuta ningun par adicional ni cambia doctrina de agente por su cuenta.

### Resultado de #979 (piloto Claude Code)

`docs/testing/lsp-pilot-claude.md` concluye **NO EVALUABLE** para los tres roles del corpus. El preflight se ejecuto completo (los cuatro gates que fija el protocolo): los gates 1, 2 y 3 quedaron en rojo -- el 3 verificado empiricamente, no inferido del fallo de los anteriores -- y el 4 no se alcanzo por depender del 3:

| Gate | Resultado |
|---|---|
| 1. Binario `csharp-ls` presente | falla (`which csharp-ls` -> no encontrado) |
| 2. Plugin `csharp-lsp` instalado y habilitado | falla (`claude plugin list` no lo muestra; solo `azure@claude-plugins-official`, deshabilitado) |
| 3. Tool `LSP` disponible en una consulta de control dentro de `claude -p` headless | falla (dos consultas de control, formulaciones distintas, ambas confirman ausencia) |
| 4. Frescura tras una edicion | no alcanzado (depende del gate 3) |

Consecuencia: **cero pares corridos** en los tres roles -- ni siquiera el brazo texto se ejecuto de forma aislada, porque el protocolo no acepta pares incompletos. El reporte distingue explicitamente que el bloqueo es de **entorno** (plugin/binario no instalados en la maquina donde corre el stage headless), no de **mecanismo**: el plugin existe, esta versionado (`1.0.0`) y documentado por el marketplace oficial. Instalarlo fue evaluado y descartado por el propio piloto -- cambia configuracion de plugins a nivel usuario/maquina, fuera del alcance de una etapa headless sin turno humano que confirme un cambio de entorno compartido.

## Decision

### 1. Tabla por runtime y rol (CA-1)

Ninguna de las tres combinaciones alcanzo siquiera un par valido, asi que no hay cifra que reportar:

| Runtime | Rol | Preflight ejecutado | Pares corridos | Resultado del piloto |
|---|---|---|---|---|
| Claude Code | `planner` | si (4 gates; fallan 1-3, el 4 no alcanzado) | 0/3 | `no evaluable` |
| Claude Code | `implementer` | si (4 gates; fallan 1-3, el 4 no alcanzado) | 0/3 | `no evaluable` |
| Claude Code | `reviewer` | si (4 gates; fallan 1-3, el 4 no alcanzado) | 0/3 | `no evaluable` |

**Como se lee la regla del protocolo.** #976 dice que un rol cuyo mecanismo LSP no esta disponible de forma estable "concluye `no evaluable` y queda fuera de la sintesis de #981". Este ADR lo lee como *fuera del calculo de medianas y de cualquier adopcion*, **no** fuera del registro: CA-1 de #981 exige explicitamente no ocultar corridas fallidas ni no evaluables. De ahi que las tres combinaciones figuren en la tabla con su causa y su conteo de pares en cero, y que ninguna aporte cifra a ningun umbral del punto 2.

Roles fuera del corpus de #976 (`test-writer`, `smoke-test-writer`, `projection-test-writer`, `projections-scaffolder`, `projection-implementer` en su rol read-side) no figuran en la tabla: no fueron probados en ningun runtime y este ADR no les asigna fila ni conclusion (ver punto 4).

### 2. Decision explicita por combinacion, con umbrales y tradeoffs (CA-2)

Para las **tres** combinaciones runtime x rol de la tabla, la decision es **evidencia insuficiente**. Aplicando el criterio de dos pasos predeclarado por #976:

1. **No inferioridad de calidad** (obligatorio primero): no evaluable en las tres combinaciones -- exige que el brazo LSP pase el mismo oraculo que el brazo texto en 3 repeticiones, y cero repeticiones del brazo LSP corrieron. Ninguna combinacion queda "rechazada por calidad": eso exigiria haber observado al brazo LSP fallar el oraculo, y no se lo observo en absoluto en ningun caso.
2. **Beneficio neto** (medianas de tokens de input y wall-clock, umbrales -10%/-15%): no se evalua en ninguna combinacion, por la misma regla explicita de #976 -- sin tres repeticiones validas por brazo no se calcula ninguna mediana, ni se sustituye con datos de otro runtime.

Tradeoffs de tokens, tiempo y calidad quedan **sin medir** en las tres combinaciones -- no hay una sola fila de evidencia cuantitativa que reportar.

El tradeoff de **indexacion** queda igualmente sin medir: la columna `cache` (`fria`/`caliente`) que el formato de evidencia de #976 obliga a anotar aparte -- nunca promediada con tokens ni con tiempo -- no tiene un solo valor registrado en el piloto. Lo unico conocido hoy de ese eje es cualitativo y se deriva del diseno del mecanismo, no de una medicion: el plugin no aporta servidor propio sino que ejecuta el binario `csharp-ls` del `PATH`, que debe cargar proyecto/solucion antes de responder la primera consulta semantica -- por eso el costo de arranque en frio es un dato del preflight y no un supuesto heredable.

El eje restante con senal cualitativa es la **madurez experimental** y la causa del bloqueo: el bloqueador es de **entorno**, no de mecanismo. El plugin `csharp-lsp` es oficial, versionado (`1.0.0`) y depende de una instalacion externa a nivel de usuario/maquina (binario `csharp-ls` + `claude plugin install`) que ningun stage headless del pipeline publicado ejecuta hoy por su cuenta. Dos reportes abiertos del tracker de terceros (`anthropics/claude-code#84125`, `#79744`) senalan riesgo adicional de poda de la tool en subagentes y de desincronizacion tras editar en modo interactivo -- ninguno de los dos se llego a verificar aqui porque el gate 3 fallo antes.

### 3. Capacidad neutral separada de `read` (CA-3, condicional -- no disparada)

Ninguna combinacion se adopta en este ADR, asi que **este ADR no define todavia** una capacidad neutral de navegacion semantica en el contrato de agentes. Deja fijado, para cuando un piloto futuro si apruebe algun rol/runtime, el criterio que MEF-ADR-0050 y la nota tecnica de #981 ya anticipan:

- La capacidad se expresaria en la fuente neutral (`src/internal/{agents,commands}/*.md`) como intencion semantica separada de `read` -- nunca fusionada con ella --, y cada adaptador de runtime mapearia esa intencion a su mecanismo concreto (la tool `LSP` en Claude Code).
- **Prohibido mapear LSP implicitamente desde `read`.** En el adaptador de Claude Code, `read` se traduce a `Read`, `Glob` y `Grep` y nunca implica la tool `LSP`; el adaptador de cualquier otro runtime respeta la misma separacion.
- `dotnet build`/`dotnet test` seguirian siendo el oraculo autoritativo sobre correctud en cualquier escenario, LSP habilitado o no -- ningun piloto ni adopcion futura cambia esto.

### 4. Fallback textual y no-carga de configuracion (CA-4)

Como las tres combinaciones evaluables resultan en evidencia insuficiente, la doctrina vigente **no cambia**: los agentes publicados que trabajan sobre C# (`planner`, `implementer`, `projection-implementer`, `reviewer`) continuan con el baseline textual fijado tras #978 (sin MCP de Rider, navegacion con `Glob`/`Grep`/`Read`, diagnostico con `dotnet build`/`dotnet test`).

Como consecuencia directa de este ADR:

- Ningun agente publicado ni interno carga el plugin `csharp-lsp` de Claude Code ni declara la tool `LSP` en su configuracion.
- Los roles que #976 excluyo explicitamente del corpus (`test-writer`, `smoke-test-writer`, `projection-test-writer`, `projections-scaffolder`, y `projection-implementer` en su rol read-side) permanecen **fuera de cualquier adopcion**: no hay evidencia a favor ni en contra para ellos, y el resultado de evidencia insuficiente en los tres roles si probados tampoco se extrapola hacia ellos.

### 5. Follow-ups por componente y lado, sin issue contenedor (CA-5)

Se enumeran como candidatos; **ninguno se ejecuta en este ADR** y este ADR no crea un issue que los agrupe. Cualquier issue de adopcion posterior debe declarar su dependencia de `MEF-ADR-0052`:

- **Follow-up 1 -- lado publicado, Claude Code**: instalar `csharp-ls` (`dotnet tool install --global csharp-ls` o Homebrew) y el plugin `csharp-lsp@claude-plugins-official` en el entorno donde corre el pipeline headless; repetir los cuatro gates del preflight de #979 -- esta vez el gate 3 desde un worktree del consumidor y dentro de los subagentes que invoca cada etapa (no solo la sesion padre), y el gate 4 de frescura tras una edicion real -- antes de correr los 3 casos x 3 pares que fija #976.
- **Follow-up 3 -- cualquier runtime con adaptador**: si un piloto futuro aprueba el paso 1 (no inferioridad de calidad) en algun rol, evaluar el paso 2 (umbrales -10%/-15%) con las tres repeticiones por caso que exige #976, sin comparar cifras absolutas entre runtimes en ningun punto.

### 6. Fragmentos de changelog (CA-6)

`changelog.d/981.added.md` y `changelog.d/981.adr-index.md` documentan este ADR sin editar `CHANGELOG.md` ni `docs/adr/INDICE-TEMATICO.md` directamente.

## Alternativas consideradas

### Alt c: Instalar el plugin/binario de Claude Code dentro de este mismo stage para desbloquear el piloto

Aprovechar la escritura de este ADR para instalar `csharp-ls` y el plugin `csharp-lsp`, re-ejecutar #979 con datos reales, y sintetizar con evidencia completa.

**Descartada**: #979 ya evaluo y descarto explicitamente esta opcion -- instalar un plugin de Claude Code cambia configuracion a nivel de usuario/maquina, fuera del arbol del repo y del alcance de una etapa headless sin turno humano que confirme un cambio de entorno compartido. Este issue (#981) es de sintesis documental, no de ejecucion de pilotos; reabrir la ejecucion aqui duplicaria el alcance que #979 ya delimito.

## Consecuencias

### Positivas

- **Ninguna doctrina de agente cambia por intuicion ni por extrapolacion entre runtimes**: las tres combinaciones quedan en evidencia insuficiente, con la causa del bloqueo documentada (entorno ausente en la maquina del piloto, no inviabilidad del mecanismo).
- **El fallback textual post-#978 sigue siendo la unica doctrina activa**, sin que ningun agente publicado cargue schema o configuracion de LSP como efecto colateral de un piloto que no concluyo.
- **Los follow-ups quedan concretos y verificables** (instalacion exacta del plugin y del binario, y los gates a repetir antes del corpus) en vez de un generico "reintentar mas adelante".
- **MEF-ADR-0050 y MEF-ADR-0049 quedan honrados**: ninguna doctrina comun asume un mecanismo de runtime concreto, y el punto 3 deja fijado el criterio de mapeo neutral para cuando (si) haga falta.

### Negativas

- **La pregunta original de #976 (LSP reduce tokens/mejora calidad frente a texto?) sigue sin respuesta** para los tres roles -- este ADR sintetiza ausencia de evidencia, no un resultado positivo o negativo del mecanismo en si.
- **El piloto Claude Code requiere trabajo de entorno fuera del pipeline** (instalar plugin + binario a nivel de usuario/maquina) antes de poder reintentarse con datos reales.
- **El corpus real sigue pendiente**: los 9 pares (18 corridas) sobre el consumidor congelado son trabajo humano no ejecutado, y no se llega a ese punto sin resolver antes la instalacion del plugin/binario.

## Referencias

- Issue #976: protocolo, corpus, umbrales y formato de evidencia (`docs/testing/lsp-experiment-protocol.md`).
- Issue #978 (PR #1002): retiro de la dependencia del MCP de Rider de los agentes publicados -- baseline textual del piloto.
- Issue #979 (PR #1011): piloto Claude Code, `docs/testing/lsp-pilot-claude.md` -- fuente del resultado `no evaluable` y de los cuatro gates de preflight citados en este ADR.
- MEF-ADR-0050 (principio de neutralidad de runtime): fuente del criterio de capacidad neutral separada de `read` que el punto 3 fijaria si se adoptara.
- MEF-ADR-0049 (arquitectura neutral runtime/proveedor): precedente de mapeos por runtime en los adaptadores, que el punto 3 aplica a la separacion entre `read` y la navegacion semantica.
- MEF-ADR-0019 (publicado vs interno): los follow-ups del punto 5 declaran explicitamente a que lado pertenece cada uno.
- MEF-ADR-0030 (esquema de identificacion de ADRs): fija el numero `MEF-ADR-0052` (verificado libre: `docs/adr/` llegaba a `MEF-ADR-0051` antes de este ADR).
- MEF-ADR-0057 (portabilidad con TypeScript sobre Node), decision 7: Claude Code es el unico runtime con adaptador; el conjunto de runtimes sigue abierto y un segundo se evalua cuando la portabilidad este completa.

## Control de cambios

- 2026-09-07: creacion como `aceptado` (issue #981). Sintetiza la evidencia de #979 (piloto Claude Code, `no evaluable` por plugin/binario ausentes en el entorno, no por inviabilidad del mecanismo) y #980 (piloto OpenCode, no ejecutado -- issue abierto sin reporte a esta fecha); fija `evidencia insuficiente` para las seis combinaciones runtime x rol evaluables por #976, sin comparar cifras absolutas entre runtimes y sin extrapolar el bloqueo de uno al otro (seccion "Decision", puntos 1-2); deja fijado el criterio de capacidad neutral separada de `read` para una adopcion futura, sin dispararlo (punto 3); mantiene el fallback textual post-#978 y prohibe cargar configuracion/schema de LSP en cualquier agente publicado como efecto de este ADR, dejando los roles no probados explicitamente fuera y registrando que el `lsp: allow` heredado de `read` en los adaptadores internos de OpenCode preexiste a los pilotos y no se toca aqui (punto 4); y enumera cuatro follow-ups por componente y lado sin ejecutarlos ni crear un issue contenedor (punto 5).
- 2026-09-07: enmienda con la evidencia real de #980 (PR #1014, `docs/testing/lsp-pilot-opencode.md`). La version original registro que el piloto OpenCode "nunca comenzo" porque su reporte no estaba en `main`: la etapa `writer` del pipeline interno lo habia escrito y habia pasado los guards, pero el watchdog la mato por timeout antes del commit, asi que el ADR se redacto sobre un `main` que no lo contenia. La conclusion de sintesis **no cambia** -- las seis combinaciones siguen en `evidencia insuficiente`, con el corpus en cero pares --, pero si la causa registrada para OpenCode: el preflight si corrio y los tres gates de mecanismo (servidor C# built-in, feature flag, permiso) quedaron **en verde** con invocacion real de la tool `lsp`, con el gate 4 de frescura no concluyente. Se reescriben en consecuencia la seccion "Resultado de #980", las tres filas de OpenCode del punto 1, el tradeoff de indexacion y la senal de madurez del punto 2, el follow-up 2 del punto 5 (de "ejecutar desde cero" a "correr el corpus"), las alternativas a y b, dos consecuencias positivas y una negativa, y la referencia a #980. La revision del mismo PR ajusto despues tres afirmaciones de esta enmienda a lo que la evidencia sostiene: el cuelgue de la sonda del gate 4 ocurrio en el arranque de `opencode run` -- mismo punto del log que la consulta de control `C1`, que era una sesion nueva sin edicion previa --, no al continuar sesion tras una edicion ni esperando al proveedor; los gates 2 y 3 quedaron confirmados en conjunto, sin control negativo del feature flag; y las filas de Claude Code del punto 1 pasan a decir "fallan 1-3" en vez de "falla en gate 3", para no contradecir la tabla de gates de la seccion de #979.
- 2026-11-10: enmienda por el retiro de OpenCode como runtime soportado (MEF-ADR-0057, decision 7). Salen del cuerpo el resultado de #980, las filas y la decision sobre OpenCode de los puntos 1 y 2, la asimetria `read` -> `lsp` del contrato interno (puntos 3 y 4), los follow-ups 2 y 4 del punto 5 y las alternativas a y b, porque su objeto dejo de existir; permanece el veredicto de `evidencia insuficiente` para los tres roles en Claude Code, con el fallback textual vigente.
