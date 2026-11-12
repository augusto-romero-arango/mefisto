# MEF-ADR-0014: Coverage gate en el pipeline TDD

**Fecha**: 2026-04-11  
**Estado**: Aceptado

---

## Contexto

El pipeline TDD produce codigo a traves de tres agentes autonomos: test-writer (fase roja), implementer (fase verde) y reviewer (refactor). Los tests se derivan de los criterios de aceptacion del issue, pero no hay verificacion de que el codigo producido por el implementer este cubierto por esos tests.

El implementer puede agregar metodos helper, branches defensivos, logica de orquestacion o caminos de error que ningun test ejercita. Estos gaps son invisibles hasta que un humano revisa el PR manualmente.

Necesitamos un mecanismo automatizado que:
- Detecte codigo nuevo sin cobertura de tests
- Distinga entre codigo que requiere cobertura (logica de dominio) y codigo que no la necesita (boilerplate)
- Intente cerrar los gaps automaticamente antes de escalar al humano
- Reporte los resultados con transparencia

### Alternativas evaluadas

**A: El reviewer mide cobertura y escribe tests faltantes.** El reviewer ya puede agregar tests (seccion 4 de su agente). Agregar medicion de cobertura lo convertiria en un one-stop-shop.

Descartada porque mueve la responsabilidad al mismo nivel donde se produce el gap. Si el objetivo es detectar atajos de los agentes de desarrollo, el detector no debe ser otro agente de desarrollo. Ademas, el reviewer ya tiene un contexto denso (checklist ES de 30+ items, elegancia, formato, cobertura de CAs) — agregar instrumentacion y analisis de cobertura degrada todo lo demas.

**B: Stage separado con loop acotado de remediacion.** Un Stage 4 mecanico que mide, clasifica, remedia (1 vez) y reporta.

Elegida. Separa la responsabilidad de medicion de la de revision de calidad. El gate es mecanico — no depende del juicio del LLM para decidir si un gap importa, eso lo determina la clasificacion de archivos.

**C: Cobertura como contexto informativo para el reviewer.** Se mide cobertura y se pasa al reviewer como datos, sin gate ni remediacion.

Descartada porque depende del juicio inconsistente del LLM reviewer. En pruebas, los LLMs tienden a reportar "cobertura aceptable" sin actuar, especialmente cuando ya tienen mucho contexto.

---

## Decision

### Stage 4: Coverage Gate

Agregar un Stage 4 al pipeline TDD que se ejecuta despues del reviewer y del merge con main, antes de crear el PR:

```
Stage 1 (test-writer) → Stage 2 (implementer) → Stage 3 (reviewer) → Sync main → Stage 4 (coverage gate) → PR
```

### Medicion

- Instrumentacion estatica con `dotnet-coverage instrument` + `dotnet-coverage collect` (el profiler dinamico no funciona con .NET 10)
- Se mide cobertura de lineas (branch coverage no disponible con instrumentacion estatica en .NET 10 — ver Limitaciones)
- Se filtra a los archivos `.cs` de `src/` creados o modificados en el PR

### Clasificacion de archivos

Los archivos se clasifican en dos categorias con umbrales diferenciados:

| Categoria | Umbral | Archivos |
|---|---|---|
| **Logica** | 95%+ | `*CommandHandler.cs`, `*AggregateRoot.cs`, `*Validator.cs`, `Eventos/*.cs` con factory `Crear()`, value objects con factory `Crear()`, `FunctionEndpoint.cs`, `*EventHandler.cs`, `*Tool.cs` de un servidor MCP |
| **Excluido** | No se mide | `HealthCheck.cs`, `Program.cs`, `*Mensajes.cs`, `*.resx`, `*AssemblyMarker.cs`, `ConfiguracionSerializacion*.cs`, `Infraestructura/` wiring puro (incluye `*Api.cs` de un servidor MCP), records DTO puros sin metodos (uno o varios por archivo) |

Razon del 95%: la logica de dominio ya esta consistentemente al 100% cuando los agentes trabajan bien. Un 95% deja margen para lineas inalcanzables (constructores privados de serializacion, fallbacks defensivos) sin esconder gaps reales. Un umbral mas bajo (80-90%) no detectaria los atajos que queremos atrapar.

Razon de excluir boilerplate: estas clases no contienen decisiones de negocio. Testearlas unitariamente no aporta confianza real — su correctitud se verifica via smoke tests contra el entorno desplegado (MEF-ADR-0013). Incluirlas en la medicion genera ruido que oculta los gaps verdaderos.

Archivos que no matchean ningun patron se clasifican como "sin clasificar": no es una exclusion deliberada (nadie decidio que no necesitan cobertura), es lo que quedo fuera de toda regla vigente — el gate no los midio. Se reportan sin bloquear, pero con presentacion propia: un marcador de atencion en la columna Estado de la tabla del PR — no el guion neutro que lleva "excluido" — y, cuando hay al menos uno, una nota bajo la tabla que declara que nadie los midio y que requieren revision humana. Distinguirlos tipograficamente es lo que hace efectiva la mitigacion de "Limitaciones conocidas": con filas identicas a las de "excluido", un archivo con logica real pasa camuflado entre exclusiones legitimas.

### Loop de remediacion acotado

Si hay archivos de logica bajo el umbral:

1. Se genera `.claude/pipeline/coverage-patch-spec.md` con metodos y lineas no cubiertas
2. Se relanza el test-writer con prompt enfocado en cubrir esos metodos especificos
3. Se relanza el implementer solo si los tests nuevos no compilan o no pasan
4. Se re-mide cobertura **una sola vez**
5. Si sigue bajo el umbral, se reporta como gap pendiente en el PR — no se itera mas

Razon de 1 iteracion: si una pasada enfocada del test-writer no cierra el gap, una segunda tampoco lo hara — el problema probablemente requiere juicio humano (el codigo es realmente inalcanzable, o el diseño necesita cambio). Iterar mas consume tokens y tiempo sin convergencia.

### Reporte en el PR

El body del PR incluye una seccion `## Cobertura` con tabla de archivos, cobertura, umbral y estado. Si hubo remediacion, incluye que tests se agregaron. Si quedaron gaps, lo indica explicitamente para el review humano.

El gate **nunca bloquea la creacion del PR**. Los gaps se reportan, no se imponen. La decision de mergear con gaps pendientes es del humano.

### Robustez

Si la instrumentacion falla por cualquier razon, el pipeline emite warning y continua sin el coverage gate. Un fallo de tooling nunca debe bloquear el flujo de desarrollo.

---

## Consecuencias

### Positivas

- **Visibilidad**: cada PR muestra exactamente que codigo quedo sin cubrir y por que
- **Deteccion temprana**: los gaps se detectan antes del review humano, no despues
- **Remediacion automatica**: en la mayoria de los casos, el test-writer puede cubrir el gap sin intervencion humana
- **No intrusivo**: no bloquea PRs, no cambia el flujo de los agentes existentes, se puede desactivar con `--from-stage` si se necesita
- **Clasificacion explicita**: la tabla de archivos documenta que se mide y que no — elimina discusiones sobre "metricas de vanidad"

### Negativas

- **Costo en tokens y tiempo**: el Stage 4 agrega ~10 minutos de medicion + hasta 30 minutos si hay remediacion. En el caso sin gaps (esperado cuando los agentes trabajan bien), solo son ~10 minutos
- **Complejidad del pipeline**: tdd-pipeline.mts gana ~150 lineas para un stage nuevo con instrumentacion, clasificacion, loop y reporte
- **Line coverage como proxy**: sin branch coverage, un `if/else` donde solo se ejecuta una rama aparece como "cubierto" si ambas lineas del `if` se tocan. Esto es una limitacion aceptada hasta que la herramienta soporte branches

### Limitaciones conocidas

- **Branch coverage no disponible**: `dotnet-coverage` con instrumentacion estatica en .NET 10 no reporta datos de branches (`branch-rate="1"` siempre). Se usa line coverage como proxy. Cuando la herramienta lo soporte, se puede ajustar el gate para usar branch coverage con umbrales apropiados
- **Clasificacion por nombre de archivo**: la heuristica de clasificacion usa patrones de nombre, no analisis semantico del codigo. Un archivo mal nombrado podria clasificarse incorrectamente. Mitigation: los archivos "sin clasificar" se reportan con marcador de atencion propio y nota al pie, tipograficamente distintos de una exclusion deliberada, para revision humana

---

## Control de cambios

- 2026-08-31: enmendado (issue #788) para sumar los patrones de un servidor MCP (MEF-ADR-0047/MEF-ADR-0048) a la clasificacion: `*Tool.cs` pasa a logica (routing de parametros, filtros de relevancia, truncado con senal -- MEF-ADR-0047 decision 4 --, y MEF-ADR-0048 nivel 1 exige unit tests de esa logica); `*Api.cs` bajo `Infraestructura/` pasa a excluido (cliente HTTP tipado que devuelve el `HttpResponseMessage` crudo, MEF-ADR-0047 decision 3); y la exclusion de records DTO se relaja de "un solo tipo declarado por archivo" a "todos los tipos declarados son records puros", para no dejar "sin clasificar" un contrato upstream redeclarado con varios records (MEF-ADR-0047 decision 3).
- 2026-11-12: se retiran los shims `.sh` (MEF-ADR-0057): el cuerpo cita los scripts `.mts` que los reemplazaban y su invocacion con `node`. Sin cambio de doctrina.
- 2026-11-12: Consecuencias deja de describir como bash el codigo que el Stage 4 suma a `tdd-pipeline.mts` (port a TypeScript, MEF-ADR-0057). Sin cambio de doctrina.
