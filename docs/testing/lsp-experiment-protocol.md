# Protocolo del experimento de LSP en agentes C# (issue #976)

Este documento fija el **protocolo y el corpus** de un experimento A/B: si la navegacion
semantica (LSP) reduce contexto/tokens o mejora calidad frente a busqueda textual en los
agentes publicados de Mefisto que trabajan sobre C#. **No ejecuta ningun piloto** -- lo
ejecuta un piloto por runtime con adaptador sobre este mismo protocolo (hoy solo Claude
Code, #979); #981 sintetiza la decision. La hipotesis se expresa como capacidad semantica
neutral (MEF-ADR-0050): el servidor, la configuracion, el tool schema y el wire format
quedan fijados por runtime, y por eso **solo son validos los deltas texto-vs-LSP dentro
del mismo runtime** -- ninguna cifra absoluta se compara entre runtimes, ni aqui ni en
#979/#981.

## Que este documento NO decide

- No corre ningun par texto/LSP: eso es #979.
- No decide adopcion de LSP en la doctrina de ningun agente: eso es #981.
- No prueba `test-writer`, `smoke-test-writer` ni las variantes de proyecciones
  (`projection-test-writer`, `projections-scaffolder`, `projection-implementer` en su
  rol read-side). Un resultado favorable en los tres roles de este protocolo **no**
  se extrapola por si solo a esos roles no probados.
- No reintroduce el MCP de Rider (#978 lo retira del baseline textual antes de este
  experimento) ni bundlea `csharp-lsp` o cambia permisos como efecto colateral de
  medir.

## Consumidor y SHA de referencia

El corpus corre sobre `Bitakora.ControlAsistencia` (consumidor de origen de la
investigacion), congelado en un unico SHA de referencia:

```
repo: augusto-romero-arango/Bitakora.ControlAsistencia
SHA:  21757bd2d6c0b261443158c4aec25e83e7f6597c   (main, commit del 2026-09-06)
```

Resuelto el 2026-09-07 con
`gh api repos/augusto-romero-arango/Bitakora.ControlAsistencia/commits/main --jq .sha`.
Que `main` avance despues no invalida nada: el SHA fijado sigue siendo un commit
alcanzable, y es el punto de comparacion del experimento, no "lo ultimo del consumidor".

Reglas de uso:

1. **Todo piloto usa este SHA**, no uno propio. Es la unica forma de que los deltas
   texto-vs-LSP de cada piloto describan el mismo codigo. Cada piloto lo copia a su
   preflight (`docs/testing/lsp-pilot-claude.md`) como dato reverificado con el comando
   de arriba, no como supuesto heredado.
2. Queda **congelado** para los tres casos, las tres repeticiones por caso y ambos brazos
   (texto/LSP) de cada piloto -- ninguna repeticion resuelve `HEAD` por su cuenta, ni
   siquiera si el consumidor avanza mientras el piloto esta en curso.
3. Si el SHA deja de ser alcanzable (rebase destructivo, borrado del repo), el piloto que
   lo detecte **enmienda este documento** con el SHA nuevo y su fecha antes de correr, y
   cualquier otro piloto se realinea a ese mismo valor. Ninguno elige un SHA distinto en
   silencio dentro de su propio reporte: eso reintroduce una variable no controlada entre
   runtimes, que es precisamente lo que este SHA existe para eliminar.

## Casos (tres roles, un oraculo independiente cada uno)

| # | Caso | Rol bajo prueba | Oraculo independiente |
|---|---|---|---|
| 1 | Analisis de impacto de un cambio propuesto sobre un simbolo con multiples consumidores conocidos | `planner` | Lista de archivos/simbolos afectados fijada **antes** de correr el experimento (construida por el operador con `dotnet build` tras el cambio real + referencias completas), nunca derivada de la propia respuesta del agente bajo prueba |
| 2 | Cambio de implementacion sobre un test ya rojo (fase verde TDD acotada) | `implementer` | `dotnet test` sobre la suite completa del proyecto tocado: verde en el test objetivo y sin regresion en el resto: autoridad unica, no la opinion del agente sobre si termino |
| 3 | Revision de un diff con impacto transversal conocido (p. ej. un cambio que toca un simbolo referenciado desde otro bounded context o desde una proyeccion) | `reviewer` | Lista predeclarada de hallazgos esperados (los que un review correcto debe levantar), fijada por el operador antes de exponer el diff al agente |

Los tres casos comparten una propiedad: el oraculo se fija **antes** de la corrida y es
independiente del artefacto que produce el propio agente bajo prueba (CA-1). Sin oraculo
independiente, un caso no entra al corpus.

### Simbolos candidatos para las consultas semanticas

Las consultas candidatas de los brazos LSP son `goToDefinition`, `goToImplementation`,
`hover` y busqueda de referencias, siempre sobre **simbolos especificos** del caso (una
clase, un metodo, un evento concreto). Quedan **fuera del corpus**, por riesgo de
respuestas no acotadas o ambiguas que contaminarian la medicion:

- `workspaceSymbol` vacio o ambiguo (sin un termino que resuelva a un unico candidato).
- Referencias sobre simbolos transversales de uso masivo (`Handle`, `Id`,
  `CancellationToken`): su conteo de referencias no es comparable entre repeticiones ni
  aporta senal sobre el caso concreto.

## Diseno experimental

- **Tres pares por runtime, por caso.** Un "par" es una repeticion completa: brazo
  texto + brazo LSP sobre el mismo caso, mismo runtime, mismo modelo, mismo prompt,
  mismo SHA (seccion anterior) y mismo estado inicial del worktree. Con 3 casos x 3
  pares, el corpus de cada runtime son 9 pares (18 ejecuciones individuales).
- **Worktrees limpios.** Cada ejecucion individual (cada brazo de cada par) arranca de
  un worktree nuevo creado desde el SHA congelado -- nunca se reutiliza el worktree de
  una ejecucion anterior, para que ningun estado residual (cache tibia, archivos ya
  tocados) contamine la comparacion.
- **Contrabalanceo del orden.** Dentro de las 3 repeticiones de un mismo par
  (caso x runtime), se alterna que brazo corre primero: repeticion 1 texto->LSP,
  repeticion 2 LSP->texto, repeticion 3 texto->LSP (o el orden inverso, siempre
  alternando). Esto controla deriva sistematica entre repeticiones (carga de maquina,
  actualizaciones de proveedor a mitad de piloto) que de otro modo favoreceria siempre
  al brazo que corre segundo o siempre al que corre primero.
- **Variables congeladas dentro de cada par**: runtime, modelo, prompt, SHA, estado
  inicial. La **unica** variable que cambia entre los dos brazos de un par es la
  disponibilidad de LSP (ver "Brazos" abajo).
- **Ninguna comparacion de cifras absolutas entre runtimes.** El delta relevante es
  texto-vs-LSP calculado dentro de cada runtime. Los pilotos no confrontan sus numeros
  entre si; #981 sintetiza veredictos independientes, no un promedio cruzado.

## Brazos del experimento

### Brazo texto (baseline)

- Sin MCP de Rider. El baseline asume #978 ya mergeado (retira de `implementer`,
  `projection-implementer` y `reviewer` la preferencia por el MCP de Rider user-level que
  Mefisto no instala). Si un piloto arranca antes de ese merge, desactiva el MCP en la
  corrida y lo registra en su preflight: un brazo texto que consulte Rider no es el
  baseline que este protocolo define.
- Sin ninguna tool ni schema de LSP expuesto al agente -- no solo "sin usarlo": la
  capacidad no esta declarada en la config de esa corrida. Mecanismo concreto por
  runtime: en **Claude Code**, el plugin `csharp-lsp` no esta cargado en esa corrida y se
  confirma en la traza que la tool no aparece.
- Navegacion con `Glob`/`Grep`/`Read`; diagnostico con `dotnet build`/`dotnet test`,
  igual que el agente publicado hoy tras #978.

### Brazo LSP

- **Claude Code**: unicamente el plugin oficial `csharp-lsp` 1.0.0 del marketplace
  `anthropics/claude-plugins-official`, respaldado por `csharp-ls` **[1]**. Su
  disponibilidad en modo headless (`claude -p`, el modo real del pipeline publicado) se
  verifica en preflight, no se asume -- ver "Preflight" abajo.
- **Doctrina dirigida**: el brazo LSP recibe una instruccion explicita
  de preferir la consulta semantica sobre la consulta textual para los simbolos
  candidatos del caso. Esta doctrina es temporal para el experimento -- no se adopta en
  ningun agente publicado hasta que #981 lo decida.
- **Prohibido el doble-check automatico con grep.** Una vez que una consulta semantica
  concluye con una respuesta no vacia y no ambigua, el brazo LSP no repite la misma
  consulta con `grep` "por si acaso" -- esa repeticion automatica contaminaria el conteo
  de tool calls/tokens y anularia el propio efecto que el experimento mide. El fallback a
  texto solo esta permitido cuando la consulta LSP en si falla, expira o se degrada (ver
  reglas de parada).

## Formato de evidencia

Cada repeticion (brazo individual) registra, como minimo:

| Campo | Nota |
|---|---|
| Runtime, modelo, caso, brazo (texto/LSP), posicion en el par (1ro/2do) | identifica la fila de forma unica |
| Tokens de input y de output | del contrato neutral de metricas existente; no se amplia el schema |
| Costo | si el proveedor lo expone; un costo `0` de suscripcion no se interpreta como ausencia de consumo |
| Wall-clock | duracion total de la ejecucion |
| Tool calls por nombre | conteo desglosado, no solo el total |
| Reintentos | de la propia ejecucion (timeouts, errores transitorios) |
| Resultado de `dotnet build`/`dotnet test` | autoridad unica sobre correctud, nunca la opinion del agente |
| Hallazgos mayores | lista, comparada contra el oraculo independiente del caso |
| Resultado del oraculo | pasa/no pasa, segun la tabla de casos |
| Indexacion/cache fria vs caliente | anotada aparte de las metricas anteriores, nunca mezclada en los promedios de tokens/tiempo |

Todo piloto emite esas filas con **la misma cabecera**, para que #981 lea los reportes
sin normalizar nada a mano (y siempre leyendo los tokens y el tiempo dentro de cada
runtime, nunca entre runtimes):

| caso | rol | brazo | pos | rep | tokens_in | tokens_out | costo | wall_clock_s | tool_calls | reintentos | build | tests | hallazgos_mayores | oraculo | cache |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

`tool_calls` va desglosado por nombre dentro de la celda (`Grep:7 Read:12 LSP:0`), nunca
como total; `cache` toma `fria` o `caliente` y no se promedia junto con las demas
columnas; `pos` es `1ro`/`2do` dentro del par (el dato que hace auditable el
contrabalanceo).

El **tamano bruto de cada respuesta** (payload de la consulta LSP o del grep) es
diagnostico opcional que se deriva de la traza solo cuando el runtime la expone -- no es
metrica portable ni motivo para ampliar el contrato neutral de metricas antes de que
#979 demuestre que hace falta.

## Criterio de decision (por rol, predeclarado)

Para cada uno de los tres roles del corpus, la conclusion sigue dos pasos en orden. Son
umbrales de **gobierno del experimento** elegidos por Mefisto -- no una best practice
externa citable.

1. **No inferioridad de calidad (obligatorio primero).** El brazo LSP debe pasar el
   mismo oraculo independiente que el brazo texto en las 3 repeticiones, y no debe
   introducir ningun hallazgo mayor adicional que el brazo texto no tuviera. Si este
   paso falla, el rol queda rechazado para LSP sin mirar tokens ni tiempo.
2. **Beneficio neto (solo si el paso 1 aprueba).** La mediana de tokens de input de las
   3 repeticiones del brazo LSP es al menos **10% menor** que la del brazo texto, **o**
   la mediana de wall-clock es al menos **15% menor** -- en cualquiera de los dos casos,
   sin que la otra metrica (la que no mejoro) empeore mas de **10%**. Si ninguna de las
   dos condiciones se cumple, el resultado para ese rol es "no concluyente / sin
   adopcion", no un rechazo por calidad.

### Que cuenta como "hallazgo mayor"

El paso 1 depende de esta clasificacion, asi que queda fijada aqui y no la improvisa cada
piloto. Es **mayor** el hallazgo que, sin corregirse, cambia el comportamiento o rompe un
contrato: correctitud (resultado incorrecto, test rojo, regresion), invariante de dominio
o de event sourcing violada, fuga de identidad/tenant o de secretos, contrato publico
roto (firma, evento, endpoint), y toda desviacion de un ADR del marco que el propio agente
no documente. **No** es mayor lo que no cambia comportamiento: naming, estilo,
comentarios, orden de miembros, sugerencias de refactor.

Un hallazgo mayor **adicional** del brazo LSP es el que aparece en su artefacto y no en el
del brazo texto del mismo par. Los que aparecen en ambos brazos no penalizan a ninguno:
son propiedad del caso, no del brazo.

### Repeticiones `no evaluable` y la mediana

La mediana del paso 2 se calcula sobre **tres** repeticiones validas por brazo. Si una
queda `no evaluable` (ver reglas de parada), se corre una repeticion de reemplazo desde un
worktree limpio, conservando el contrabalanceo del orden. Si el reemplazo no es posible
(el mecanismo LSP no esta disponible de forma estable), el rol concluye `no evaluable` y
queda fuera de la sintesis de #981: nunca se calcula la mediana sobre dos repeticiones ni
se rellena la faltante con el promedio de las otras.

## Preflight y reglas de parada

Antes de contar cualquier par como valido, cada piloto verifica y registra:

- Version del runtime, version del modelo y SHA del consumidor (fijados, ver seccion
  "Consumidor y SHA de referencia").
- **Disponibilidad del mecanismo LSP con una consulta pequena de control**, no solo su
  instalacion: Claude Code confirma que `csharp-lsp` responde dentro de `claude -p`
  headless. Los dos reportes abiertos del tracker ubican el fallo en el modo interactivo
  y describen `-p` como el camino que si funciona **[2][3]**, pero eso no exime de
  comprobarlo: son senales de riesgo de terceros, no fuentes normativas, y lo que el
  preflight mide es que la tool aparece en la traza del stage tal como lo lanza el
  pipeline -- incluidos los subagentes que ese stage invoque, que es justo donde **[2]**
  reporta la poda -- y que responde a una consulta de control.
- **Frescura tras una edicion**: dentro de una misma ejecucion, si el brazo LSP edita un
  archivo, la siguiente consulta semantica debe reflejar esa edicion antes de aceptarse
  como valida -- una respuesta que ignora una edicion reciente se registra como
  hallazgo, no se descarta en silencio.

**Regla de parada**: si el tool LSP, el servidor o la sincronizacion fallan en preflight o
a mitad de una repeticion, esa repeticion se marca `no evaluable` (nunca se fabrica una
cifra ni se sustituye por una corrida de otro runtime). `dotnet build`/`dotnet test`
siguen siendo la autoridad sobre correctud durante todo el experimento, incluso cuando el
oraculo del caso es distinto (ver tabla de casos).

## Fuera de alcance para #981 por adelantado

Si el resultado favorece LSP en alguno de los tres roles, #981 decide una capacidad
neutral separada de `read` para exponerlo en la doctrina.

## Fuentes

- **[1]** `anthropics/claude-plugins-official`, entrada `csharp-lsp` del marketplace y
  `plugins/csharp-lsp/README.md` -- plugin oficial 1.0.0 respaldado por `csharp-ls`.
  https://github.com/anthropics/claude-plugins-official/tree/main/plugins/csharp-lsp
- **[2]** `anthropics/claude-code#84125` (abierto) -- "LSP tool is pruned from all
  subagent tool sets in interactive sessions (present in the parent, and in subagents
  under -p)". Senal de riesgo de terceros, no fuente normativa: reporta el modo
  interactivo como el roto y `-p` como el que si expone la tool a los subagentes; de ahi
  que el preflight verifique la presencia de la tool en la forma exacta en que corre el
  pipeline, subagentes incluidos.
  https://github.com/anthropics/claude-code/issues/84125
- **[3]** `anthropics/claude-code#79744` (abierto) -- "Interactive LSP client never sends
  didChange after Edit-tool writes -- server buffers stay frozen at first-query content
  (headless `-p` syncs correctly)". Misma naturaleza: atribuye la desincronizacion tras
  editar al modo interactivo. Que el reporte afirme que `-p` sincroniza bien es
  exactamente lo que la verificacion de frescura de este protocolo debe confirmar de
  forma empirica en vez de dar por hecho.
  https://github.com/anthropics/claude-code/issues/79744
