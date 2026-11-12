# MEF-ADR-0050: Principio de neutralidad de runtime para toda operacion de Mefisto

- **Fecha**: 2026-09-06
- **Estado**: aceptado
- **Aplica a**: todo artefacto de Mefisto -- skill/comando, agente, pipeline bash, hook y Agent Skill -- en ambos lados de MEF-ADR-0019 (publicado e interno). Generaliza MEF-ADR-0049 (que fija la arquitectura concreta del rollout interno: fuente `src/internal/` + adaptadores generados, perfiles de modelo, toolchain bash+jq) a un principio transversal, sin reemplazarlo. Cross-referencia MEF-ADR-0049 (arquitectura que este ADR generaliza), MEF-ADR-0033 (Agent Skills: fija aqui el frontmatter portable de `SKILL.md`), MEF-ADR-0019 (publicado vs interno: el principio aplica a ambos lados) y MEF-ADR-0030 (esquema de identificacion, fija el numero `0050` como libre).

**Issues bloqueados por este ADR**: #937 (regla F5, frontmatter portable de `SKILL.md`, en el bloque `[F]` de `scripts/tests/guards.test.mts`), #938 (reescritura neutral del skill interno `agent-skill-authoring`).

## Contexto

MEF-ADR-0049 fijo la *arquitectura* neutral del lado interno -- fuente `src/internal/` + adaptadores generados -- y difirio el lado publicado a un ADR posterior (#874). Ese ADR deja tres cabos sueltos que hoy generan deuda:

1. **No existe un principio transversal.** Nada obliga a que una operacion nueva nazca neutral. Una recomendacion externa reciente (Claude Insights) propuso crear `.claude/skills/next-order/SKILL.md` con frontmatter especifico de Claude Code: ninguna regla lo impedia, y el artefacto habria nacido atado a ese runtime.
2. **El frontmatter de `SKILL.md` no tiene regla de portabilidad.** Un campo propio de un runtime degrada sin senal en cualquier otro que no lo implemente, y MEF-ADR-0049 (decision 2, tercer punto) remite a este ADR para fijar el frontmatter portable.
3. **El conjunto de runtimes se trato como una enumeracion cerrada.** El mantenedor quiere abrirlo: manana puede aparecer otro runtime del mercado, y agregarlo debe ser *solo* escribir un adaptador, nunca tocar la fuente neutral.

Ademas, `mefisto-writer` y `mefisto-reviewer` (los dos agentes del pipeline interno de tooling que producen y revisan cambios sobre el propio repo) tienen **cero** menciones de neutralidad en su fuente: hoy el gate de neutralidad (issue #923, `mefisto-neutrality-gate.sh`) los frena post-hoc si violan alguna regla, pero ninguno de los dos conoce la regla de antemano. `AGENTS.md` -- el archivo de directivas canonicas del repo (MEF-ADR-0049 decision 3) -- es el vehiculo natural para que la conozcan sin tocar sus fuentes.

Estas decisiones se tomaron en la sesion de planeacion del 2026-09-06 y este ADR las fija formalmente.

### Alcance

Este ADR fija un **principio** valido para toda operacion de Mefisto, en ambos lados de MEF-ADR-0019: que nace neutral a runtime, que el conjunto de runtimes soportados es abierto, cual es el punto de extension verificable para un runtime nuevo, cual es el frontmatter portable obligatorio de todo `SKILL.md`, como se nombra un artefacto publicado en cualquier runtime, y como se verifica "agnostico" contra los gates que ya existen.

### Que queda fuera de este ADR

- **La distribucion del lado publicado** (MEF-ADR-0053): este ADR fija la regla de no-regresion que rige ese lado, no su implementacion.
- **La mecanica concreta de generacion, validacion y adaptadores** (`src/internal/scripts/generate-internal-adapters.sh`, `validate-internal-artifacts.sh`, `mefisto-neutrality-gate.sh`): ya vive en MEF-ADR-0049 y en el contrato (`src/internal/contract/README.md`). Este ADR los referencia, no los reabre.

## Decision

### 1. Toda operacion nace neutral; el conjunto de runtimes es abierto (CA-1)

Toda operacion de Mefisto -- skill (`commands/`, `.claude/commands/`), agente (`agents/`, `.claude/agents/`), pipeline bash (`scripts/`, `.claude/scripts/`), hook (`hooks/`, `.claude/settings.json`) y Agent Skill (`skills/`, `.claude/skills/`) -- en ambos lados de MEF-ADR-0019, es neutral a runtime. Ninguna pieza nueva de doctrina, comportamiento o automatizacion asume que Claude Code (ni ningun otro runtime concreto) es el unico interprete posible.

El conjunto de runtimes soportados es **abierto**, no una enumeracion cerrada: "runtime soportado" significa unicamente **"tiene adaptador en el repo"** -- hoy solo Claude Code (`.claude/`, MEF-ADR-0057). Agregar otro runtime del mercado manana es, por definicion de este principio, escribir el adaptador que describe la decision 2 -- nunca tocar la fuente neutral de un artefacto ya existente.

**Regla de no-regresion en el lado publicado**, que hoy se distribuye como un unico Claude Code Plugin: ningun artefacto publicado nuevo agrega acoplamiento adicional a un runtime concreto. Dos ejemplos concretos:

- Un `scripts/*.sh` publicado nuevo no invoca el CLI de un runtime (p. ej. `claude`) si puede evitarlo -- el mismo criterio que la regla R2 de `mefisto-neutrality-gate.sh` ya aplica a todo su universo de archivos (`src/internal/`, `.claude/`, `AGENTS.md`), aunque ese universo no incluya `scripts/` -- el arbol publicado entero esta declarado fuera de alcance en `scope_excluded` de `neutrality-allowlist.json`.
- Un `skills/*/SKILL.md` publicado nuevo usa unicamente el frontmatter portable que fija la decision 3 (`name`, `description`, `license`, `compatibility`, `metadata`) -- nunca `allowed-tools` ni otra extension propia de Claude Code -- aunque hoy solo Claude Code cargue Skills publicados via marketplace.

### 2. Punto de extension de un runtime nuevo: checklist verificable, sin tocar la fuente neutral (CA-2)

Agregar el runtime `<id>` (hoy `claude`; manana cualquier otro) es, exhaustivamente, esta lista -- ningun paso edita `src/internal/{agents,commands}/*.md`, la fuente neutral de doctrina: todo lo que se toca es maquinaria de adaptacion.

| Paso | Archivo/mecanismo a crear | Ya implementado hoy para |
|---|---|---|
| 1 | `src/runtime/lib/runtime-<id>.mts` (`buildCmd`, `translate` y, opcionalmente, `isAvailable`, `defaultModel` y `supportsResume`; contrato en `src/runtime/contract/README.md`) | `runtime-claude.mts` |
| 2 | `src/internal/scripts/lib/adapter-<id>.mts`: traduce las directivas `{{mefisto:...}}` del contrato neutral y toma la tabla de modelos por defecto de `runtime-<id>.mts` | `adapter-claude.mts` |
| 3 | Cableado del adaptador nuevo en `src/internal/scripts/generate-internal-adapters.mts`: importarlo, emitir `.<id>/{agents,commands}/*.md` junto al destino ya existente, e incluir ese arbol en el barrido de divergencia de `--check` | la rama `.claude/` del generador |
| 4 | El runner no necesita cableado: `resolveRuntime` descubre `src/runtime/lib/runtime-<id>.mts`, valida el id y ejecuta `isAvailable`. El descubrimiento sincrono de `/upgrade` y `/onboard` usa la tabla `PROBES` del mismo modulo, a la que se suma el runtime | discovery abierto de `mefisto-runtime.mts` |
| 5 | Entrada en `is_path_in_mefisto_scope` (`src/internal/scripts/lib/mefisto-scope.mts`) | entradas `.claude/*` |
| 6 | Entrada en el blocklist publicado `is_path_in_consumer_blocklist` (`scripts/lib/pipeline/consumer-scope.mts`), si el adaptador introduce una ruta publicada que sus patrones no cubren | `src/published/*`, `src/runtime/*`, `dist/*` |
| 7 | Entrada(s) en `src/internal/contract/neutrality-allowlist.json` si el adaptador nuevo necesita nombrar su propio runtime en texto (mismo patron que la excepcion ya declarada para `adapter-claude.mts`) | seccion `exceptions` del archivo |
| 8 | Soporte del kind `<id>` en el propio Herdr, si un pipeline orquesta ese runtime en un pane: en el repo de Mefisto, `runtimes_for_repo` (`scripts/herdr-workspace.sh`) monta una fila por cada id de `MEFISTO_RUNTIMES` y lo pasa tal cual como `--kind`, asi que ahi no hay nada que editar -- solo verificar que Herdr reconozca ese kind; en un consumidor esa funcion monta solo la fila `claude`, y ofrecer ahi el runtime nuevo es editarla | `--kind claude` |
| 9 | Tests: contrato del adaptador, discovery abierto y resolucion de modelos sin proveedor real | `src/runtime/tests/*.test.mts` |

### 3. Frontmatter portable de todo `SKILL.md` (CA-3)

Todo `SKILL.md` del repo -- publicado (`skills/<nombre>/SKILL.md`) o interno (`.claude/skills/<nombre>/SKILL.md`) -- declara **unicamente** los cinco campos estables del estandar abierto: `name`, `description`, `license`, `compatibility`, `metadata` [1]. Los cuatro `SKILL.md` existentes en el repo (`skills/projections`, `skills/code-comments`, `.claude/skills/harness-config-contract`, `.claude/skills/agent-skill-authoring`) ya cumplen esto -- ninguno declara un campo fuera de esa lista.

**`allowed-tools` queda prohibido.** La especificacion abierta lo marca *Experimental* y advierte que su soporte varia entre implementaciones -- *"Support for this field may vary between agent implementations"* [1]. Un runtime que no lo implemente carga el Skill igual, pero la restriccion nunca se aplica: un Skill que dependa de `allowed-tools` para su seguridad (p. ej. para restringir que herramientas puede invocar al dispararse) degrada sin ninguna señal en ese runtime. Es el principio de la decision 1 aplicado al frontmatter: un Skill no depende de un campo que solo algunos runtimes honran.

Los **recursos de Nivel 3** (scripts, plantillas, referencias que el body de un `SKILL.md` invoca bajo demanda) se restringen al mismo toolchain que el resto del harness: bash + jq + gh (coherente con el toolchain que fija MEF-ADR-0049 seccion 6), nunca Node, Python ni un binario que no este ya disponible en cualquier maquina que corra los pipelines de Mefisto.

**`.claude/skills/` es la ubicacion fisica de los Skills internos**: Claude Code descubre Skills de proyecto en `.claude/skills/<skill-name>/SKILL.md` y de plugin en `<plugin>/skills/<skill-name>/SKILL.md`, nunca en `.agents/skills/` [3]. Su fuente canonica es `src/internal/skills/<id>/` y el generador interno la emite ahi (MEF-ADR-0049 decision 2); el frontmatter portable rige igual para la fuente y para lo generado.

Con esta decision, **MEF-ADR-0049 decision 2 deja de decir "un ADR de seguimiento decidira"**: el frontmatter portable ya queda fijado aqui. El cuerpo de MEF-ADR-0049 se actualiza en consecuencia (sin texto marcado como obsoleto: la mencion al ADR de seguimiento se reemplaza por la remision a MEF-ADR-0050, y el control de cambios de MEF-ADR-0049 registra la enmienda).

### 4. Namespace `mefisto`: intencion neutral, separador por adaptador (CA-4)

Todo artefacto publicado invocable lleva la intencion neutral de namespace `mefisto`, sea cual sea el runtime que lo interprete. Como se materializa ese namespace es una decision de **cada adaptador**, no de la fuente neutral:

- **Claude Code**: namespace nativo del plugin (`/mefisto:sequential`).
- **Runtimes sin concepto de plugin**: separador **`:`** literal en el nombre del comando, produciendo el mismo `/mefisto:sequential` visible para el consumidor.

Esto preserva la distincion ya vigente entre `mefisto:` (publicado, namespace de plugin/separador) y `mefisto-` (interno, prefijo llano de MEF-ADR-0019). Los **Agent Skills** publicados, en esos mismos runtimes sin plugin, llevan en cambio el prefijo llano **`mefisto-`** -- nunca `:` -- porque la especificacion abierta fija el `name` de un Skill con el patron `^[a-z0-9]+(-[a-z0-9]+)*$` [1], que no admite `:`. El adaptador que scaffoldee ese Skill para un runtime sin plugin renombra a la vez el directorio y el campo `name` (p. ej. `skills/projections/` -> `mefisto-projections` en ese adaptador), nunca uno sin el otro.

**Limite conocido**: `:` es un caracter ilegal en nombres de archivo NTFS. Irrelevante mientras el harness siga siendo bash sobre macOS/Linux/WSL (MEF-ADR-0049 seccion 6) -- se deja anotado para que un futuro soporte Windows nativo lo revise antes de asumir que el separador literal es portable a ese filesystem.

### 5. Definicion operativa de "agnostico": checklist contra los gates existentes (CA-5)

Un artefacto de Mefisto es "agnostico a runtime" cuando pasa, sin excepcion declarada, los gates que **ya existen** (MEF-ADR-0018: extender un mecanismo nuevo cuando uno existente basta es la extraccion prematura que esa heuristica desaconseja):

- **R1-R4, `adapters-check` y `published-adapters-check` de `src/internal/scripts/mefisto-neutrality-gate.sh`** (issue #911, `published-adapters-check` anadida por el issue #1496): ausencia de alias de modelo/tools/permisos crudos en la fuente neutral (R1), de invocaciones directas de CLI de runtime (R2), de rutas/variables propias de un runtime (R3), de shims de `.claude/scripts/*.sh` divergentes de su plantilla (R4), paridad entre la fuente interna y los adaptadores generados (`adapters-check`) y paridad entre la fuente publicada (`src/published/`, `src/runtime/`) y su distribucion generada (`dist/`, `published-adapters-check`).
- **Bloque `[F]` de `scripts/tests/guards.test.mts`**: integridad de todo `SKILL.md` -- `name` coincide con el directorio (F1), `description` no vacia (F2), recursos de Nivel 3 referenciados existen (F3), y toda referencia `skills:` de un agente resuelve a un Skill real (F4).
- **`src/internal/scripts/validate-internal-artifacts.sh`**: conformidad de todo `src/internal/{agents,commands}/*.md` contra `internal-artifact.schema.json` -- incluida la neutralidad del body (ninguna linea nombra un runtime concreto, hoy `claude`, fuera de las dos excepciones literales documentadas en `src/internal/contract/README.md`).

**Regla nueva que este ADR manda crear, todavia pendiente**: una **F5** en el bloque `[F]` de `guards.test.mts` que verifique el frontmatter portable de todo `SKILL.md` (decision 3) -- que ningun campo fuera de `name`/`description`/`license`/`compatibility`/`metadata` este presente, `allowed-tools` en particular. Hoy ningun `SKILL.md` del repo la viola (verificado, ver decision 3), pero el gate que lo garantice de forma continua no existe todavia: lo entrega el issue #937, que este ADR bloquea.

### 6. `AGENTS.md` porta el principio sin tocar las fuentes de `mefisto-writer`/`mefisto-reviewer` (CA-6)

`AGENTS.md` -- el archivo de directivas canonicas del repo (MEF-ADR-0049 decision 3) -- gana una linea de principio que referencia este ADR. Al ser una directiva de proyecto y no un campo de frontmatter de agente, `mefisto-writer` y `mefisto-reviewer` (los dos agentes del pipeline interno de tooling, hoy sin ninguna mencion de neutralidad en su fuente) la reciben en cada corrida, bajo cualquier runtime, sin que su `.md` en `src/internal/agents/` cambie una sola linea.

## Alternativas consideradas

### Alt a: Enmendar MEF-ADR-0049 en vez de crear un ADR nuevo

Anadir estas seis decisiones como una seccion mas de MEF-ADR-0049.

**Descartada**: MEF-ADR-0049 es arquitectura concreta del *rollout interno* -- fuente `src/internal/`, perfiles de modelo, toolchain bash+jq -- y esta explicitamente acotado a diferir el lado publicado a #874. Ese ADR va a seguir evolucionando junto con el lado interno; un principio transversal que aplica a ambos lados por igual sobrevive mejor separado de esa arquitectura especifica, igual que MEF-ADR-0012 y MEF-ADR-0018 conviven como heuristicas independientes sin fusionarse.

### Alt b: Separador `-` para runtimes sin concepto de plugin

Usar `mefisto-sequential` (guion) en vez de `mefisto:sequential` (dos puntos) para runtimes sin plugin, por ser universal (sin restriccion de caracteres) y ya documentado como convencion de Skills/comandos internos.

**Descartada**: colisiona nominalmente con la convencion ya vigente de `mefisto-` = interno (MEF-ADR-0019). Un consumidor viendo `/mefisto-sequential` no puede distinguir, por el nombre solo, si es un comando publicado corriendo bajo un runtime sin plugin o un comando interno del propio harness -- exactamente la ambiguedad que el prefijo doble (`mefisto:` vs `mefisto-`) existe para evitar. Ademas introduce dos grafias distintas del mismo comando publicado segun el runtime (`/mefisto:sequential` en Claude Code, `/mefisto-sequential` en el otro), forzando al consumidor a recordar cual aplica donde.

### Alt c: Separador `/` via subcarpeta

Organizar los comandos publicados bajo una subcarpeta `mefisto/` (p. ej. `commands/mefisto/sequential.md`), para los runtimes que derivan el namespace de la subcarpeta.

**Descartada**: semantica divergente entre runtimes. Un runtime que derive el namespace de la subcarpeta produciria `/mefisto/sequential`, pero Claude Code Plugins ignora la jerarquia de carpetas para el nombre del comando (el nombre lo da el archivo, no la ruta): el mismo artefacto fisico produciria ahi `/sequential` a secas, perdiendo el namespace exactamente donde mas hace falta (Claude Code, el unico runtime con adaptador hoy).

### Alt d: Permitir `allowed-tools` en `SKILL.md`

No prohibirlo, dejandolo como extension opcional de Claude Code que un autor de Skill puede usar si lo desea.

**Descartada**: es precisamente el modo de falla silencioso que origina la decision 3 -- la especificacion advierte que el soporte del campo varia entre implementaciones [1], asi que un Skill que dependa de el para su seguridad parece funcionar en todo runtime cuando en realidad solo restringe en los que lo implementan. Prohibirlo de raiz es mas barato que confiar en que cada autor recuerde no depender de el.

## Consecuencias

### Positivas

- **Ninguna operacion nueva puede "olvidar" ser neutral**: el principio aplica por default a todo artefacto nuevo, en vez de descubrirse post-hoc cuando el gate de neutralidad (#923) lo frena.
- **Agregar un runtime es un ejercicio mecanico**: la tabla de la decision 2 convierte "soportar un runtime nuevo" en una checklist verificable contra archivos reales, sin que nadie tenga que re-descubrir el punto de extension desde cero.
- **`.claude/skills/` deja de tener un riesgo sin dueño**: el frontmatter portable (decision 3) cierra el cabo suelto que MEF-ADR-0049 dejo explicitamente para "un ADR de seguimiento".
- **`mefisto-writer`/`mefisto-reviewer` conocen la regla de antemano**: la linea en `AGENTS.md` mueve la neutralidad de "gate que frena post-hoc" a "directiva que el agente ya trae al arrancar", sin tocar sus fuentes.
- **El namespace `mefisto` queda resuelto para cualquier runtime futuro sin plugin.**

### Negativas

- **F5 queda fijada pero no implementada**: este ADR manda crear la regla (decision 5) sin entregarla -- issue #937 la implementa. Hasta entonces, un `SKILL.md` con `allowed-tools` seguiria pasando el bloque `[F]` de `guards.test.mts` sin que ningun gate automatizado lo detecte (aunque hoy ninguno lo tiene).
- **La regla de no-regresion del lado publicado (decision 1) no tiene gate automatizado propio**: a diferencia del lado interno (`mefisto-neutrality-gate.sh`), nada escanea hoy `scripts/`, `commands/`, `skills/` publicados en busca de acoplamiento nuevo a un runtime -- la regla se aplica por revision humana/de agente hasta que un gate equivalente exista del lado publicado (fuera del alcance de este ADR).
- **Separador distinto segun el tipo de artefacto en runtimes sin plugin** (`:` para comandos, `-` para Skills, decision 4) es una asimetria que un contribuyente nuevo debe aprender -- aceptada porque la spec de Skills la fuerza (`name` no admite `:`), no por preferencia estetica.

## Referencias

- **[1]** "Agent Skills Specification" -- agentskills.io. Fija los seis campos de frontmatter reconocidos (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`), marca `allowed-tools` como *Experimental* con soporte variable (*"Support for this field may vary between agent implementations"*), y fija el patron `name: ^[a-z0-9]+(-[a-z0-9]+)*$`. Fuente de las decisiones 3 y 4. Verificado (fetch HTTP, 2026-11-10). https://agentskills.io/specification
- **[3]** "Using skill frontmatter outside Claude Code" -- Claude Code Docs. Tabla de campos estandar vs extensiones propias de Claude Code, y las ubicaciones que Claude Code reconoce (`.claude/skills/`, `<plugin>/skills/` -- nunca `.agents/skills/`). Fuente de la decision 3. Verificado (fetch HTTP, 2026-09-06). https://code.claude.com/docs/en/skills#using-skill-frontmatter-outside-claude-code
- MEF-ADR-0049 (arquitectura neutral runtime/proveedor): este ADR generaliza su principio subyacente sin reemplazar su arquitectura concreta del rollout interno; su decision 2 queda enmendada para remitir aqui en vez de a "un ADR de seguimiento".
- MEF-ADR-0057 (portabilidad con TypeScript sobre Node): su decision 7 deja a Claude Code como unico runtime con adaptador; el conjunto abierto de la decision 1 y el checklist de la decision 2 son el punto de extension para sumar otro.
- MEF-ADR-0033 (Agent Skills): fuente del modelo de Skills que la decision 3 restringe con el frontmatter portable.
- MEF-ADR-0019 (publicado vs interno): el principio de este ADR aplica a ambos lados que ese ADR separa; el registro de rutas nuevas (seccion E) sigue rigiendo para cualquier artefacto que un runtime nuevo introduzca.
- MEF-ADR-0030 (esquema de identificacion de ADRs): fija el numero `MEF-ADR-0050` (verificado libre: `docs/adr/` llegaba a `MEF-ADR-0049` antes de este ADR, sin issue ni PR que reservara `0050`).
- MEF-ADR-0018 (heuristicas de evolucion y reuso): justifica, en la decision 5, por que el checklist de "agnostico" referencia gates existentes en vez de crear un mecanismo nuevo.
- Issue #935: origen de este ADR.

## Control de cambios

- 2026-09-06: creacion como `aceptado` (issue #935). Fija el principio de neutralidad de runtime para toda operacion de Mefisto en ambos lados de MEF-ADR-0019 -- conjunto de runtimes abierto ("soportado" = tiene adaptador) y regla de no-regresion en el lado publicado hasta #874 (seccion 1); el checklist verificable de extension para un runtime nuevo, citando en cada paso el archivo real que hoy lo implementa para claude/opencode -- incluido el cableado del adaptador en `generate-internal-adapters.sh` (seccion 2); el frontmatter portable obligatorio de todo `SKILL.md` (`name`, `description`, `license`, `compatibility`, `metadata`; `allowed-tools` prohibido; recursos de Nivel 3 en bash+jq+gh; `.claude/skills/` como unica ubicacion fisica) (seccion 3); el namespace `mefisto` con separador nativo de plugin en Claude Code y `:` en runtimes sin esa primitiva, prefijo llano `mefisto-` para Skills en esos mismos runtimes, evidencia empirica de OpenCode 1.18.29 y el limite NTFS conocido (seccion 4); la definicion operativa de "agnostico" contra los gates ya existentes (R1-R4 + adapters-check de `mefisto-neutrality-gate.sh`, bloque `[F]` de `test-guards.sh`, `validate-internal-artifacts.sh`) y la regla F5 pendiente que este ADR manda crear (issue #937) (seccion 5); y la linea de principio en `AGENTS.md` que `mefisto-writer`/`mefisto-reviewer` reciben sin cambiar su fuente (seccion 6). Bloquea #937 y #938.
- 2026-09-19 (issue #1496): la seccion 5 suma `published-adapters-check` a la lista de gates que definen "agnostico" -- misma verificacion estructural que `adapters-check`, pero sobre el generador publicado (`src/published/scripts/generate-published-adapters.sh --check`), cerrando el hueco que dejaba pasar a `main` una distribucion `dist/` desactualizada respecto a su fuente (evidencia: PR #1478, incidente de release v0.38.0 recuperado en tres PRs).
- 2026-11-10: enmienda por MEF-ADR-0057 (decision 7, runtime unico): OpenCode deja de ser runtime soportado, asi que `claude` queda como unico ejemplo implementado del checklist de la seccion 2 (ajustado ademas al codigo: sin `.opencode/` en el generador ni en los gates, blocklist publicado por patrones y `runtimes_for_repo` en el paso 9), la prohibicion de `allowed-tools` (seccion 3) se apoya en la especificacion abierta y no en el comportamiento de un runtime, y salen la evidencia empirica de namespace de la seccion 4, las referencias que solo documentaban OpenCode y el punto de "Que queda fuera" sobre no generar `.claude/skills/`, que el generador interno ya emite. El principio, el conjunto abierto de runtimes y los diez pasos del checklist no cambian.
- 2026-11-11: enmienda por MEF-ADR-0057 (decisiones 1 y 3): el generador interno y su adaptador pasan a TypeScript, asi que los pasos 3, 4 y 8 del checklist de la seccion 2 nombran `adapter-<id>.mts` y `generate-internal-adapters.mts`. El adaptador lleva su tabla de modelos por defecto como gemela de la del runtime hasta que `src/runtime/` se porte.
- 2026-11-11: enmienda por MEF-ADR-0057 al portar el runner: los pasos 1, 2, 3 y 5 del checklist de la seccion 2 nombran el adaptador `runtime-<id>.mts` y `mefisto-runtime.mts`. El paso 2 pasa a ser la gemela bash del adaptador, que dura mientras queden pipelines en bash. El paso 5 reconoce la tabla `PROBES`, que el descubrimiento sincrono de `/upgrade` y `/onboard` necesita ampliar.
- 2026-11-12: los guards de `scripts/tests/test-guards.sh` pasan a `scripts/tests/guards.test.mts` (port a TypeScript, MEF-ADR-0057); el cuerpo cita el archivo nuevo. Sin cambio de doctrina.
- 2026-11-12: se borran las librerias bash del runtime y de los pipelines (MEF-ADR-0057): sale del checklist de la seccion 2 el paso de la gemela bash del adaptador (`runtime-<id>.sh` con su `.jq`), asi que los pasos 3 a 10 pasan a ser 2 a 9; las entradas de las allowlists de scope citan `mefisto-scope.mts` y `consumer-scope.mts`, y el paso de tests cita `src/runtime/tests/*.test.mts`, sin los shims de `.claude/scripts/tests/` que ya no existen.
