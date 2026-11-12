---
name: agent-skill-authoring
description: Notas operativas para definir o modificar agentes y comandos -- fuente neutral `src/internal/{agents,commands}/*.md` regenerada con `generate-internal-adapters.mts` para el lado interno, `agents/*.md`/`commands/*.md` de Claude Code para el lado publicado -- y Agent Skills (`skills/<nombre>/SKILL.md`, `.claude/skills/<nombre>/SKILL.md`) del propio plugin Mefisto: el frontmatter portable obligatorio de todo `SKILL.md` (`allowed-tools` prohibido), la declaracion de tools MCP en allowlists Claude Code y su prefijo scoped cuando el servidor lo provee un plugin, y el checklist para agregar el adaptador de un runtime nuevo sin tocar la fuente neutral (MEF-ADR-0050). Usar al crear o editar un agente, un comando o un Skill de este repo.
---
<!-- GENERADO por src/internal/scripts/generate-internal-adapters.mts desde src/internal/skills/agent-skill-authoring/SKILL.md. No editar a mano. -->

# Notas para definir agentes y skills

## Regla de oro: la fuente neutral primero (MEF-ADR-0050)

Los agentes y comandos **internos** (prefijo `mefisto-`, MEF-ADR-0019) se escriben **solo** en
`src/internal/{agents,commands}/<id>.md`: frontmatter JSON del contrato (`kind`, `id`,
`description`, `capabilities` en vez de `tools`, `profile` en vez de `model`, `skills` con los
Agent Skills precargados, mas `mode`/`agent`/`arguments` segun aplique) y un body que nunca
nombra un runtime concreto -- el validador rechaza la linea entera citando su numero, y solo
inspecciona el body: el `description` del frontmatter si puede nombrar un runtime cuando ese
runtime *es* el tema. Solo dos excepciones literales en el body: `.claude-plugin/` (el manifiesto
fisico del plugin, identico e indispensable en cualquier runtime) y `.claude/scripts/` (el
hook de scope del adaptador y los tests internos; los pipelines se invocan desde
`src/internal/scripts/`); ninguna otra forma de `.claude/`
pasa. Se regeneran con `src/internal/scripts/generate-internal-adapters.mts`.
**Nunca se edita a mano** `.claude/{agents,commands}/*.md` -- son adaptadores generados; una
edicion manual se pierde en la siguiente regeneracion y `--check` la reporta como divergencia.
Contrato completo (campos, vocabularios cerrados, mapeo por runtime):
`src/internal/contract/README.md`.

Esta regla es **solo del lado interno**. El lado publicado (`agents/*.md`, `commands/*.md`)
todavia no tiene fuente neutral propia -- MEF-ADR-0049 lo difiere a #874 (rollout
interno-primero) -- asi que se sigue editando directamente en formato Claude Code (frontmatter
YAML, `tools:`, `skills:`); ver la subseccion especifica de Claude Code mas abajo. La regla de
no-regresion de MEF-ADR-0050 (seccion 1) aplica igual a lo nuevo que se agregue ahi: ningun
script publicado nuevo invoca el CLI de un runtime, y ningun `SKILL.md` publicado nuevo usa
frontmatter no portable.

## Agent Skills (ambos lados)

Frontmatter de todo `SKILL.md` portable -- publicado (`skills/<nombre>/SKILL.md`) o interno
(`src/internal/skills/<nombre>/SKILL.md`, generado a `.claude/skills/`) -- limitado a los cinco campos portables del estandar
abierto: `name`, `description`, `license`, `compatibility`, `metadata` [1]. El sexto campo que la
spec reconoce, **`allowed-tools`, queda prohibido**: la spec lo marca *Experimental* [1] y un
runtime que no lo implemente lo ignora en silencio -- un Skill que dependiera de ese campo para
restringir que tools puede invocar al dispararse degradaria ahi sin ninguna senal. La
regla F5 del bloque `[F]` de `scripts/tests/guards.test.mts` lo verifica (MEF-ADR-0050 seccion 3,
issue #937). La prohibicion es **del frontmatter de un `SKILL.md`**: en un *comando* de Claude
Code `allowed-tools` es legitimo, y del lado interno lo emite el generador desde `capabilities`
-- nunca se escribe a mano.

- `name` = nombre del directorio, patron `^[a-z0-9]+(-[a-z0-9]+)*$` (la spec no admite `:`; F1 ya
  verifica esta igualdad).
- Recursos de **Nivel 3** (scripts, plantillas que el body invoca bajo demanda): scripts `.mts`
  que Node ejecuta directo, sin dependencias npm, mas `gh` y lo que trae Git Bash -- el mismo
  toolchain que el resto del harness (MEF-ADR-0057, decisiones 1 y 9), nunca `jq`, Python ni un
  binario que no este ya disponible en cualquier maquina que corra los pipelines de Mefisto.
- Ubicacion: la fuente canonica de los Skills internos es `src/internal/skills/<id>/SKILL.md`
  (issue #1685); `generate-internal-adapters.mts` la copia a `.claude/skills/<id>/` con el marcador
  de generado tras el frontmatter, y nunca se edita a mano. `.claude/skills/` es la ruta fisica
  donde Claude Code descubre los Skills del repo [2]. Los Skills publicados siguen en `skills/`
  (a mano). `--check` detecta Skills faltantes, distintos, huerfanos o sin marcador bajo
  `.claude/skills/`, y `validate-internal-artifacts.mts` valida el frontmatter de la fuente
  (`name` = directorio, `description` presente, sin `allowed-tools`).
- Doctrina extensa que solo aplica a algunas tareas: envolverla en un Agent Skill en vez de crecer
  el body de un agente (progressive disclosure, MEF-ADR-0033) -- se carga por niveles y no se
  paga cuando la tarea no lo necesita. Si el propio Skill crece mas alla del presupuesto de Nivel
  2 (<5k tokens), mover el detalle a un recurso de Nivel 3 dentro del mismo directorio en vez de
  seguir inflando el body.

## Nuevo runtime = nuevo adaptador

El conjunto de runtimes soportados es abierto: "soportado" significa unicamente "tiene adaptador
en el repo" (MEF-ADR-0050 seccion 1). Agregar el runtime `<id>` nunca edita
`src/internal/{agents,commands}/*.md` -- solo maquinaria de adaptacion (checklist completo de
nueve pasos, con el archivo exacto de cada uno: MEF-ADR-0050 seccion 2):

1. `src/runtime/lib/runtime-<id>.mts` (`buildCmd`, `translate`, `isAvailable` y la tabla de
   modelos por defecto) y `src/internal/scripts/lib/adapter-<id>.mts` (traduce las directivas
   `{{mefisto:...}}` del contrato y toma la tabla de modelos de `runtime-<id>.mts`).
2. Cableado en `generate-internal-adapters.mts` (incluido su `--check`). `resolveRuntime`
   (`src/runtime/lib/mefisto-runtime.mts`) descubre `runtime-<id>.mts` por su nombre y ejecuta
   `isAvailable`; el descubrimiento sincrono que usan `/upgrade` y `/onboard` sale de la tabla
   `PROBES` del mismo modulo, a la que hay que sumar el runtime nuevo.
3. Entradas espejo en las dos allowlists de scope: `isPathInMefistoScope`
   (`src/internal/scripts/lib/mefisto-scope.mts`, interno) e `isPathInConsumerBlocklist`
   (`scripts/lib/pipeline/consumer-scope.mts`, publicado).
4. Excepcion en `neutrality-allowlist.json` si el adaptador necesita nombrar su propio runtime en
   texto.
5. Kind reconocido por Herdr, si algun pipeline orquesta ese runtime en un pane:
   `scripts/herdr-workspace.mts` ya reenvia el id de runtime tal cual como `--kind`, asi que del
   lado de Mefisto no hay nada que editar -- solo verificarlo del lado de Herdr.
6. Tests: `runtime-<id>.test.mts` (contrato del adaptador), discovery abierto y resolucion de
   modelos sin proveedor real.

## Especifico del adaptador Claude Code -- lado publicado

- Las herramientas MCP requieren declaracion explicita cuando un agente usa allowlist `tools:`.
  Usa wildcard: `mcp__<servidor>__*`.
- Cuando el servidor MCP lo provee un **plugin** (declarado en `.mcp.json` en la raiz del plugin,
  propio o de terceros), el nombre real de sus tools va scoped con el prefijo del plugin, asi que
  la allowlist se escribe `mcp__plugin_<plugin>_<servidor>__*`, no `mcp__<servidor>__*`. Fuente:
  [3] -- *"Tool matchers and `if` fields take the scoped tool name
  `mcp__plugin_<plugin-name>_<server-name>__<tool>` ... A matcher written against the bare server
  key never fires"*. Ejemplo: el servidor `microsoft-learn` bundleado por este plugin (`mefisto`)
  se declara en `.mcp.json` y se referencia en `tools:` como
  `mcp__plugin_mefisto_microsoft-learn__*`.
- Si el agente **no** define `tools:`, hereda todas incluyendo MCP.
- Un agente precarga un Agent Skill con el campo frontmatter `skills:` (no requiere la tool
  `Skill` en `tools:`). En el lado publicado se escribe a mano; en el interno se declara en el
  campo neutral `skills` de la fuente y el generador lo emite aqui. La regla F4 exige que cada
  valor resuelva al `name` de un `SKILL.md` real -- barre `agents/` y `.claude/agents/` por
  igual, porque una referencia mal escrita degrada en silencio.

## Fuentes

- **[1]** "Agent Skills Specification" -- agentskills.io. Fija los seis campos de frontmatter
  reconocidos, marca `allowed-tools` como *Experimental* y fija el patron
  `name: ^[a-z0-9]+(-[a-z0-9]+)*$`. Verificado (fetch HTTP, 2026-09-06).
  https://agentskills.io/specification
- **[2]** "Using skill frontmatter outside Claude Code" -- Claude Code Docs. Tabla de campos
  estandar vs extensiones propias de Claude Code, y las ubicaciones que Claude Code reconoce
  (`.claude/skills/`, `<plugin>/skills/` -- nunca `.agents/skills/`). Verificado (fetch HTTP,
  2026-09-06). https://code.claude.com/docs/en/skills#using-skill-frontmatter-outside-claude-code
- **[3]** "Plugins reference" -- Claude Code Docs. Fija el prefijo scoped
  `mcp__plugin_<plugin-name>_<server-name>__<tool>` para tools MCP provistas por un plugin.
  Verificado (fetch HTTP, 2026-09-06). https://code.claude.com/docs/en/plugins-reference
- MEF-ADR-0050 (principio de neutralidad de runtime): fuente de la regla de oro, el frontmatter
  portable de `SKILL.md` y el checklist de adaptador nuevo.
- MEF-ADR-0049 (arquitectura neutral runtime/proveedor): fuente del layout `src/internal/` +
  adaptadores generados, los perfiles `fast|balanced|deep` y el toolchain del generador
  (TypeScript sobre Node, MEF-ADR-0057).
- `src/internal/contract/README.md`: contrato completo del generador (campos, vocabularios
  cerrados, mapeo por runtime).
