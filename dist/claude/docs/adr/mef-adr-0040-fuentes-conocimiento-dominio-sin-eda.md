# MEF-ADR-0040: Fuentes de conocimiento del dominio sin capa de modelado EDA

- **Fecha**: 2026-08-05
- **Estado**: aceptado
- **Aplica a**: el harness completo -- retira la capa de modelado/documentacion EDA (agentes `eda-modeler`/`event-stormer`, skill `/show-flow`, script `scripts/eda-lint.sh`, artefactos `docs/eda/` en su ruta actual) y fija las fuentes de conocimiento del dominio que quedan vigentes. Supersede MEF-ADR-0010 (pipeline de conocimiento del dominio); enmienda MEF-ADR-0008 (knowledge crunching del planner), MEF-ADR-0012 (heuristicas de modelado) y MEF-ADR-0027 (donde se documenta en claro la clave de enrutamiento); actualiza una mencion residual en MEF-ADR-0039 (composicion de ensamblados por rol del evento).

## Contexto

MEF-ADR-0010 establecio un "knowledge hub" en `docs/eda/`: un pipeline de tres fases (descubrimiento con `event-stormer`, modelado con `eda-modeler`, planificacion con `planner`) que producia YAMLs estructurados -- `catalog.yaml`, `context-map.yaml`, `aggregates/*.yaml`, `flows/*.yaml`, `messaging/topics.yaml`, `projections/`, `ubiquitous-language.yaml`. Ese mismo ADR ya reconocia el riesgo en su seccion "Consecuencias / Negativas": *"los artefactos pueden quedar desactualizados si el agente `event-stormer` no los actualiza diligentemente"* y *"el catalogo puede divergir del codigo real si no se valida con el linter periodicamente"*. La mitigacion propuesta -- `scripts/eda-lint.sh` -- ataca el sintoma (detectar la divergencia una vez ocurrida), no la causa (que el artefacto es una copia derivada sin mecanismo que fuerce su sincronia con el codigo).

Decision de planning (2026-08-05): con MEF-ADR-0039 (composicion canonica de ensamblados por rol del evento) ya aceptado, cada artefacto YAML del knowledge hub tiene ahora, o siempre tuvo, una **fuente de verdad ejecutable** que no puede mentir -- el codigo mismo, la infraestructura Terraform, o un ADR ya vigente. Mantener el YAML derivado junto a esa fuente es puro riesgo de divergencia sin beneficio neto: cualquier consumidor (humano o agente) que necesite la informacion puede leerla directamente de la fuente ejecutable, con la garantia de que esta describe el sistema real, no una foto que alguien olvido actualizar.

La unica excepcion genuina es el **glosario de lenguaje ubicuo** (`ubiquitous-language.yaml`): terminos, actores, sistemas externos y preguntas abiertas no tienen ninguna representacion en el codigo -- no hay tipo CLR, Terraform ni ADR que documente que "supervisor" es como el dominio llama a quien aprueba un turno. Ese artefacto sobrevive, pero su ruta (`docs/eda/`) tambien era un accidente historico: es un termino de Domain-Driven Design (Eric Evans, *Domain-Driven Design*, 2003, cap. 3, "lenguaje ubicuo"), no de Event-Driven Architecture -- la carpeta `docs/eda/` fue simplemente donde escribio primero quien creo el pipeline (MEF-ADR-0010).

## Decision

### 1. Eliminacion de la capa de modelado EDA

Se elimina del harness:

- El agente `eda-modeler` (`agents/eda-modeler.md`)
- El agente `event-stormer` (`agents/event-stormer.md`)
- El skill `/show-flow` (`commands/show-flow.md`)
- El script `scripts/eda-lint.sh`
- Los artefactos que esos agentes mantenian bajo `docs/eda/` en su ruta actual: `catalog.yaml`, `flows/`, `messaging/topics.yaml`, `projections/`, `context-map.yaml`, `aggregates/`, `ubiquitous-language.yaml`

Tabla artefacto retirado -> fuente de verdad ejecutable que lo reemplaza:

| Artefacto EDA retirado | Fuente de verdad ejecutable |
|---|---|
| `docs/eda/catalog.yaml` (eventos, comandos, payloads) | El **codigo por rol** (MEF-ADR-0039): `src/<RootNamespace>.PublicEvents/{Dominio}/`, `*.PrivateEvents/{Dominio}/`, `*.{Dominio}.DomainEvents/` listan los eventos reales de cada rol -- no puede divergir de si mismo |
| `docs/eda/messaging/topics.yaml` (topologia Service Bus) | **Terraform** (`dominio-{kebab}.tf`) + atributos `[ServiceBusTrigger]` en el codigo + MEF-ADR-0001 (topics por evento), MEF-ADR-0024 (modelo de bus), MEF-ADR-0026 (colas con sesion), MEF-ADR-0027 (enrutamiento multi-destinatario) |
| `docs/eda/flows/*.yaml` (flujos end-to-end) | La coreografia es **semi-legible directamente del codigo**: la convencion de naming `{Accion}Cuando{Evento}` (MEF-ADR-0006) mas los topics por evento permiten reconstruir la cadena de handlers sin un YAML aparte |
| `docs/eda/projections/` (read models) | El **worker de proyecciones** (`<RootNamespace>.Projections`) + `<RootNamespace>.ReadModels` (MEF-ADR-0034) |
| `docs/eda/aggregates/*.yaml` (estado, invariantes) | El propio **`AggregateRoot`**: su factory `Crear`, sus invariantes y los eventos que consume via `Apply` viven en el unico lugar donde se hacen cumplir (MEF-ADR-0012) |
| `docs/eda/context-map.yaml` (mapa de contextos) | Ninguna -- **perdida aceptada** (ver "Consecuencias"); queda documentado en ADRs del consumidor y en la bitacora cuando el humano lo considere relevante |
| `docs/eda/ubiquitous-language.yaml` (glosario) | **Excepcion**: no tiene fuente ejecutable -- sobrevive bajo custodia del planner (decision 3), en ruta nueva (decision 4) |

Con la eliminacion del agente `eda-modeler`, la realineacion de ese agente a la composicion de MEF-ADR-0039 (listada en la seccion "Aplica a" de ese ADR como issue de capa 3 todavia sin crear) queda **moot**: no hay agente que realinear.

### 2. Fuentes de conocimiento del dominio vigentes

Tras el retiro, el conocimiento del dominio se sostiene en cuatro fuentes, ninguna de ellas nueva:

1. **Codigo por rol** (MEF-ADR-0039): que eventos/comandos existen, su forma exacta, su rol (publico, privado, persistido).
2. **Glosario de lenguaje ubicuo**, custodiado por el planner (decision 3): terminos, actores, sistemas externos, preguntas abiertas -- lo unico que el codigo no expone.
3. **Field notes y bitacora** (`docs/bitacora/field-notes/`, `docs/bitacora/`): la narrativa de como y por que se tomo una decision, producida por `historiador`, `bug-investigator`, `tooling-investigator` y el propio `planner`.
4. **ADRs del consumidor**: decisiones arquitectonicas especificas del dominio o configuracion del proyecto concreto.

Ningun agente nuevo reemplaza a `event-stormer`/`eda-modeler`: el `planner` ya cubre el knowledge crunching per-issue (MEF-ADR-0008), y las fuentes 1, 3 y 4 no requieren un agente dedicado a mantenerlas -- se producen como efecto colateral del trabajo normal (escribir codigo, investigar un bug, documentar un ADR), no como un artefacto que alguien tiene que recordar sincronizar.

### 3. Custodia del glosario por el planner

El agente `planner` hereda la custodia del glosario de lenguaje ubicuo, que antes era responsabilidad del `event-stormer` (MEF-ADR-0010, Fase 1). No es una tarea agregada artificialmente: el planner ya es el **chokepoint** natural por el que pasa todo evento o comando nuevo antes de convertirse en issue (MEF-ADR-0008) -- mantener el glosario es una consecuencia directa de ese rol, no una responsabilidad nueva encima de el.

Deberes concretos:

- **Lectura al arrancar**: el planner lee el glosario (ruta canonica, decision 4) al inicio de cada sesion, igual que ya lee `docs/eda/ubiquitous-language.yaml` hoy (`agents/planner.md`, seccion "Tu stack de conocimiento").
- **Deber de actualizacion al cierre de sesion, acotado al vocabulario tocado**: cuando la sesion introduce o refina un termino, un actor o una pregunta abierta, el planner lo escribe en el glosario antes de cerrar. No es una relectura exhaustiva de toda la sesion -- solo el vocabulario que la conversacion realmente produjo o cambio.
- **Guardrail anti-sinonimos, dos patas**: antes de nombrar un concepto nuevo, el planner verifica primero contra el **glosario** (evita bautizar dos veces el mismo concepto con nombres distintos) y despues contra el **codigo por rol** (evita reinventar un nombre que el codigo ya usa bajo otro termino). El orden importa: el glosario es la consulta mas barata (un solo archivo, cubre actores y conceptos sin tipo CLR asociado); el codigo por rol es la verificacion de respaldo para terminos que ya cristalizaron en tipos concretos.

**Enmienda (MEF-ADR-0041, issue #581): los terminos de vista entran a esta misma custodia y guardrail.** El nombre de un read model (`{TerminoVista}`, sin sufijo `View` desde MEF-ADR-0041) es vocabulario del dominio como cualquier comando o evento -- el planner lo escribe en el glosario al acunarlo, y lo verifica primero contra el glosario y despues contra el codigo por rol antes de nombrarlo. Para el read-side, "codigo por rol" se extiende a `<RootNamespace>.ReadModels` -- la cuarta isla que fija MEF-ADR-0039 (enmendado por MEF-ADR-0041) --, ademas de los tres ensamblados de eventos que esta seccion ya cubria.

La materializacion de estos deberes en el body de `agents/planner.md` es alcance de un issue hermano de demolicion/re-anclaje (ver "Referencias"); este ADR fija la doctrina, no edita ese agente.

### 4. Ruta canonica del glosario: `docs/ddd/ubiquitous-language.yaml`

La ruta canonica pasa a ser `docs/ddd/ubiquitous-language.yaml`: el glosario es un artefacto de **Domain-Driven Design**, no de Event-Driven Architecture -- `docs/eda/` era un accidente de quien lo escribio primero (MEF-ADR-0010), no una decision deliberada de ubicacion.

Todo agente que lea el glosario intenta primero la ruta nueva; si no existe, hace **fallback de lectura** a `docs/eda/ubiquitous-language.yaml` (consumidores existentes que todavia no migraron). La regla es de solo-lectura para el fallback: si el fallback encuentra el archivo en la ruta vieja, el agente **sugiere al humano** un `git mv docs/eda/ubiquitous-language.yaml docs/ddd/ubiquitous-language.yaml` -- **nunca escribe una copia nueva en la ruta canonica** mientras la vieja siga existiendo. Escribir dos copias del mismo glosario reintroduce exactamente el riesgo de divergencia que este ADR busca eliminar.

### 5. `docs/eda/` existente en consumidores: documentacion muerta, no se borra

Alcance **greenfield-only**, mismo patron que MEF-ADR-0039 decision 9 (migracion de consumidores legados como no-objetivo explicito): este ADR no prescribe ninguna migracion para un consumidor que ya tiene `docs/eda/` poblado. Los archivos `catalog.yaml`, `flows/`, `topics.yaml`, `projections/`, `context-map.yaml`, `aggregates/` quedan en su lugar como **documentacion muerta inofensiva** -- nadie los borra, nadie los actualiza, ningun agente los vuelve a leer. El unico archivo que sobrevive activamente es el glosario, y solo a traves del fallback de lectura + sugerencia de `git mv` de la decision 4.

## Alternativas consideradas

### Alt 1: mantener `eda-modeler`/`event-stormer`, pero reducidos a mantener solo el glosario

**Descartada**: dividir la responsabilidad de un solo artefacto (el glosario) entre dos agentes especializados es complejidad sin beneficio -- el `planner` ya es el chokepoint natural de todo vocabulario nuevo (MEF-ADR-0008) y no necesita un agente satelite dedicado a un archivo YAML.

### Alt 2: borrar `docs/eda/` existente en los consumidores durante la migracion

**Descartada**: es una operacion destructiva sobre repos de terceros que el marco no controla, fuera del alcance de un ADR que se declara greenfield-only. El consumidor decide si y cuando limpiar su propio historial documental.

### Alt 3: conservar `context-map.yaml` como segunda excepcion (junto al glosario)

**Descartada**: a diferencia del glosario, el mapa de contextos no tiene un chokepoint natural equivalente al planner -- ningun agente que sobreviva a esta poda pasa por *todas* las relaciones cross-BC del sistema. Sin un custodio claro, el artefacto se degradaria exactamente igual que las otras piezas del knowledge hub que este ADR retira. La perdida se documenta como aceptada (ver "Consecuencias") en vez de mantener un artefacto sin custodio real.

### Alt 4: mover el glosario a `docs/adr/` en vez de una carpeta `docs/ddd/` nueva

**Descartada**: el glosario no es una decision arquitectonica (no documenta un "por que", documenta vocabulario vivo que cambia con cada sesion) -- forzarlo al formato y cadencia de un ADR (`docs/adr/`, con Contexto/Decision/Consecuencias) le impondria una rigidez que no tiene sentido para un artefacto que se actualiza incrementalmente. `docs/ddd/` nombra correctamente la disciplina a la que pertenece sin mezclarlo con el registro de decisiones.

## Consecuencias

### Positivas

- **Ningun artefacto derivado puede volver a mentir**: cada YAML retirado tenia (o adquirio con MEF-ADR-0039) una fuente ejecutable que describe el sistema real sin necesitar sincronizacion manual.
- **El glosario sobrevive con un custodio claro**: el planner ya pasaba por todo vocabulario nuevo; formalizar su custodia no agrega un proceso nuevo, documenta uno que ya existia implicitamente.
- **Menos superficie de mantenimiento del harness**: dos agentes, un skill y un script menos que mantener alineados con cada cambio de convencion (p. ej. MEF-ADR-0039 ya habia dejado a `eda-modeler` en una lista de agentes por realinear -- esa deuda desaparece con el agente).
- **La perdida se documenta explicitamente en vez de quedar implicita**: un lector futuro que se pregunte donde quedo el mapa de contextos encuentra la respuesta aqui, no un silencio.

### Negativas

- **Se pierde el facilitador dedicado de sesiones de descubrimiento greenfield**: sin `event-stormer`, no queda un agente cuyo proposito sea explorar un dominio nuevo con WebSearch/WebFetch y field notes obligatorias antes de que exista codigo. El `planner` cubre el knowledge crunching per-issue (MEF-ADR-0008), pero eso presupone que ya hay una idea concreta que convertir en issue -- no una sesion exploratoria abierta.
- **La relacion cross-BC que capturaba `context-map.yaml` queda dispersa**: sin un artefacto centralizado, esa informacion vive en ADRs del consumidor y en bitacora, sin un punto unico de consulta. Un consumidor con varios Bounded Contexts que necesite ese mapa debe reconstruirlo de fuentes dispersas.
- **El fallback de lectura del glosario (decision 4) es deuda de transicion**: mientras un consumidor no ejecute el `git mv` sugerido, cada agente que lee el glosario paga el costo de intentar dos rutas.

## Referencias

- MEF-ADR-0010 (pipeline de conocimiento del dominio): supersedido por este ADR -- su cuerpo historico se conserva integro bajo el estado nuevo (ver ese documento, "Control de cambios").
- MEF-ADR-0008 (knowledge crunching como proposito del planner): enmendado por este ADR -- retira la complementariedad con `eda-modeler` y anota la custodia del glosario.
- MEF-ADR-0012 (heuristicas de modelado de objetos de dominio): enmendado por este ADR -- "event-stormer o planner" pasa a "planner" en la fase de descubrimiento.
- MEF-ADR-0027 (enrutamiento multi-destinatario por correlation filter): enmendado por este ADR -- su decision 6 prescribia documentar en claro la clave de enrutamiento en el YAML de `docs/eda/flows/`; retirado ese artefacto, la documentacion queda en los comentarios de Terraform de la subscription y en el issue o ADR del consumidor.
- MEF-ADR-0039 (composicion canonica de ensamblados por rol del evento): actualizado por este ADR -- retira `agents/eda-modeler.md` de su seccion "Aplica a" y de la lista de issues consumidores de capa 3; es ademas la fuente de verdad ejecutable que reemplaza `docs/eda/catalog.yaml` (decision 1).
- MEF-ADR-0041 (forma propia de la vista read-side): **enmienda la decision 3 de este ADR** -- los terminos de vista (read models sin sufijo `View`) entran a la custodia del glosario y al guardrail anti-sinonimos del planner en igualdad de condiciones con cualquier otro termino; "codigo por rol" se extiende a `ReadModels` (la cuarta isla de MEF-ADR-0039/0041).
- MEF-ADR-0001, MEF-ADR-0024, MEF-ADR-0026, MEF-ADR-0027: fuente de verdad de la topologia de Service Bus que reemplaza `docs/eda/messaging/topics.yaml`.
- MEF-ADR-0006 (convenciones de nombramiento de funciones Azure): fija `{Accion}Cuando{Evento}`, la convencion que hace semi-legible la coreografia que antes documentaba `docs/eda/flows/`.
- MEF-ADR-0034 (worker de proyecciones y read models): fuente de verdad ejecutable que reemplaza `docs/eda/projections/`.
- MEF-ADR-0030 (esquema de identificacion de ADRs): fija el numero `MEF-ADR-0040` (numero verificado libre, `docs/adr/` llegaba a 0039 antes de este ADR).
- Eric Evans, *Domain-Driven Design: Tackling Complexity in the Heart of Software* (Addison-Wesley, 2003), cap. 3 -- lenguaje ubicuo: fundamenta que el glosario es un artefacto de DDD, no de EDA, y por tanto su ruta canonica (`docs/ddd/`) en vez de `docs/eda/`.
- Issue #561 (este ADR) y sus issues hermanos de demolicion (retiro fisico de agentes/skill/script/artefactos, re-anclaje del `planner` a la custodia del glosario en su body), todavia sin crear: dependen de este ADR como su fuente de doctrina. Al borrar los archivos quedan por limpiar, en el mismo issue de demolicion, las menciones descriptivas que hoy son ciertas y dejan de serlo cuando el archivo desaparezca: la fila de `/show-flow` en el catalogo de skills de `CLAUDE.md`, los listados de skills y agentes de `README.md`, la linea `` `/show-flow`, `/eraser-diagram` `` de MEF-ADR-0019 ("Skills sin equivalente interno") y los inventarios del test de guards (hoy `scripts/tests/guards.test.mts`) que enumeraban `show-flow.md` y `eda-lint.sh`. Este ADR fija la doctrina; no ejecuta el retiro ni edita esos inventarios.

## Control de cambios

- 2026-08-05: creacion como `aceptado` (issue #561). Fija la eliminacion de la capa de modelado EDA (agentes `eda-modeler`/`event-stormer`, skill `/show-flow`, script `eda-lint.sh`, artefactos `docs/eda/` en su ruta actual) con la tabla artefacto -> fuente de verdad ejecutable; las cuatro fuentes de conocimiento del dominio vigentes; la custodia del glosario de lenguaje ubicuo por el `planner` (lectura al arrancar, actualizacion acotada al cierre de sesion, guardrail anti-sinonimos de dos patas); la ruta canonica `docs/ddd/ubiquitous-language.yaml` con fallback de lectura a `docs/eda/ubiquitous-language.yaml`; y el alcance greenfield-only para consumidores con `docs/eda/` ya poblado. Supersede MEF-ADR-0010; enmienda MEF-ADR-0008, MEF-ADR-0012 y MEF-ADR-0027; actualiza MEF-ADR-0039.
- 2026-08-07: enmendada la decision 3 (issue #581, creacion de MEF-ADR-0041). Los terminos de vista (read models sin sufijo `View` desde MEF-ADR-0041) entran a la custodia del glosario y al guardrail anti-sinonimos del planner en igualdad de condiciones con cualquier otro termino del vocabulario del dominio; "codigo por rol" se extiende a `<RootNamespace>.ReadModels` (la cuarta isla que fija MEF-ADR-0039, enmendado por el mismo issue). Sin cambio en el resto de la doctrina de este ADR.
- 2026-11-12: la referencia al issue #561 cita el test de guards por su ruta actual, `scripts/tests/guards.test.mts`, en lugar de `scripts/tests/test-guards.sh` (port a TypeScript, MEF-ADR-0057). Sin cambio de doctrina.
