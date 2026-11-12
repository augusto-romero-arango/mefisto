# MEF-ADR-0056: Politica de cero warnings nuevos

- **Fecha**: 2026-10-13
- **Estado**: aceptado
- **Aplica a**: doctrina del marco que fija como tratan los warnings los agentes y skills que operan sobre el consumidor: `test-writer`, `implementer`, `projection-test-writer`, `projection-implementer`, `smoke-test-writer`, `reviewer`, `tooling-writer`, `tooling-reviewer`, `infra-writer`, `infra-reviewer`, los scaffolders y `/fix-review`. Fuera de alcance: el pipeline interno de Mefisto (extension futura diferida, MEF-ADR-0019). Este ADR funda la doctrina; la propagacion a agentes, el helper determinista y el label `warning` quedan para los issues #2405-#2412, que este ADR bloquea.

## Contexto

Este ADR adopta la politica de **tratar los warnings como errores** en el sentido de *The Pragmatic Programmer* (Hunt & Thomas, 20th Anniversary Ed.), apoyada en dos ideas del libro: del tema "Debugging", subir los warnings al maximo porque no tiene sentido gastar tiempo buscando problemas que la maquina puede encontrar; y "Don't Live with Broken Windows".

Hoy la doctrina es difusa:

- `reviewer` pide leer **todos** los warnings y pone "sin warnings del compilador" como atributo de elegancia.
- `implementer` corre `dotnet build`.
- `infra-*` exigen que `terraform validate` pase en verde, pero ignoran sus warnings.
- Ningun agente sabe que hacer con un warning que no logra resolver.

Las bases sobre las que trabajan los agentes no estan limpias. Linea base medida el 2026-10-13 en el propio repo: shellcheck reporta 14 warnings y 45 hallazgos info/style sobre `src/published/scripts` y `src/internal/scripts`. Es la evidencia de que la unica regla aplicable sobre bases existentes es el diferencial, no el cero absoluto.

La politica **no bloquea el ciclo de desarrollo**: no se activa `TreatWarningsAsErrors` en el build del consumidor. Cada agente intenta remediar con su mejor criterio; la ultima instancia deja un issue explicando por que no pudo.

## Decision

### 1. Alcance

Pipelines y agentes que operan sobre el consumidor. El pipeline interno de Mefisto queda diferido como extension futura, no como decision pendiente.

### 2. Warning "nuevo": diferencial contra la base

Un warning es nuevo si aparece en el estado del worktree y no en el commit base del worktree. Las bases no estan limpias, asi que comparar contra cero bloquearia por deuda ajena.

- Se compara como **multiconjunto** de claves normalizadas: herramienta + archivo + codigo + mensaje, sin numero de linea.
- Se compara sobre todo el proyecto, no solo sobre los archivos tocados: un `[Obsolete]` nuevo puede disparar CS0618 en archivos que el cambio no toca.

### 3. Toolchains y severidad

- **.NET**: los warnings de `dotnet build` (compilador y analyzers).
- **Terraform**: los diagnosticos `severity=warning` de `terraform validate -json`.
- **bash**: `shellcheck -S warning` (niveles warning y error; info y style quedan fuera).

### 4. Deteccion determinista

Un helper publicado (`scripts/warnings-diff.mts`, #2405) es la unica fuente de verdad del diferencial. Los agentes lo invocan; no comparan a mano.

### 5. Suprimir no es remediar

Si el diff anade cualquiera de estas supresiones, cuenta como warning nuevo:

- `#pragma warning disable`
- `[SuppressMessage]`
- `<NoWarn>`
- bajar `<WarningLevel>`
- `dotnet_diagnostic.*.severity = none|silent|suggestion`
- `# shellcheck disable=` (y `disable=` en `.shellcheckrc`)

La salida es corregir el codigo o abrir el issue.

### 6. Cadena de responsabilidad

- Cada agente escritor verifica con el helper antes de terminar y corrige. Lo que no logra remediar lo deja en su resumen de stage; los escritores no crean issues.
- El reviewer del pipeline es la ultima instancia.
- Los scaffolders son su propia ultima instancia (no tienen reviewer).
- `/fix-review` es la ultima instancia de los cambios que el mismo introduce.

### 7. Remanente

Si la ultima instancia no logra remediar un warning, crea un issue con:

- labels `estado:borrador`, `warning` y los `tipo:*`/`dom:*` del issue origen (el label `warning` lo agrega #2406 al enmendar MEF-ADR-0007);
- en el body, el warning literal, el archivo y **la razon por la que no se pudo remediar**.

Antes de crearlo busca un issue abierto equivalente (mismo codigo y archivo) y, si existe, comenta en el en vez de duplicar. El PR enlaza el issue como `Relacionado: #N`. Para los scaffolders, el issue es un draft cross-repo en Mefisto con `tipo:tooling`, porque el defecto esta en la plantilla del harness. El issue nace `estado:borrador` y no salta el refinamiento (MEF-ADR-0011).

### 8. No bloquea

Un remanente con su issue no hace fallar el pipeline.

## Alternativas consideradas

### Alt 1: `TreatWarningsAsErrors` en el build

**Descartada**: bloquea el ciclo de desarrollo; un warning que el agente no logra remediar detendria todo el pipeline, y ademas obligaria a tocar la configuracion de build del consumidor.

### Alt 2: cero warnings absoluto

**Descartada**: bloquea por deuda preexistente. La linea base medida (14 warnings de shellcheck solo en este repo) muestra que las bases no estan limpias; exigir cero hace fallar cambios por warnings que el cambio no introdujo.

### Alt 3: supresion justificada como remediacion valida

Criterio de SEI CERT MSC00-C, que admite suprimir un diagnostico con justificacion.

**Descartada**: es mas laxo que el elegido. Aceptar supresiones justificadas permite que un agente silencie el warning en vez de corregirlo, y la justificacion no es verificable de forma determinista. Aqui la salida es corregir o abrir el issue (decision 5).

### Alt 4: comparacion a criterio de cada agente

**Descartada**: no es reproducible (cada agente compara distinto) y es cara en turnos. El helper determinista (decision 4) lo resuelve una vez.

### Alt 5: gate de pipeline que inyecta el diferencial

**Descartada**: toca todos los pipelines; el helper invocado por los agentes basta.

## Consecuencias

### Positivas

- Criterio decidible y reproducible: el diferencial multiconjunto da el mismo resultado sin importar que agente lo calcule.
- No se acumulan warnings nuevos ni se esconden tras supresiones, sin exigir limpiar deuda ajena.
- Todo remanente queda trazado en un issue con su razon, en vez de perderse.
- El ciclo de desarrollo no se bloquea.

### Negativas

- Doctrina sin propagacion inmediata: hasta que #2405-#2412 cierren, ningun agente aplica la politica; existe una ventana en la que el ADR esta aceptado pero no aplicado.
- Compilar dos veces (base y worktree) cuesta tiempo en proyectos grandes.
- Los warnings de la base no se reducen por esta politica; la deuda preexistente sigue.
- El pipeline interno de Mefisto no queda cubierto hasta que se retome la extension diferida.

## Referencias

- Hunt, A. y Thomas, D., *The Pragmatic Programmer*, 20th Anniversary Edition (2019): tema "Debugging" (subir los warnings al maximo) y "Don't Live with Broken Windows".
- SEI CERT C, MSC00-C "Compile cleanly at high warning levels": https://wiki.sei.cmu.edu/confluence/display/c/MSC00-C.+Compile+cleanly+at+high+warning+levels (criterio de supresion justificada, descartado en Alt 3).
- MEF-ADR-0007 (gestion de proyecto con GitHub Issues): #2406 lo enmienda para agregar el label `warning`.
- MEF-ADR-0011 (Definition of Ready): el issue remanente nace `estado:borrador`.
- MEF-ADR-0019 (publicado vs interno): el alcance es el lado publicado.
- MEF-ADR-0030 (esquema de identificacion): fija el numero `MEF-ADR-0056`.
- MEF-ADR-0044 (doctrina de comentarios minimos): precedente de doctrina que delega su propagacion a issues dependientes.
- Issue #2404: origen de este ADR. Issues dependientes: #2405-#2412.

## Control de cambios

- 2026-10-13: creacion como `aceptado` (issue #2404). Fija la politica de cero warnings nuevos: diferencial multiconjunto contra la base, toolchains (.NET, Terraform, bash), helper determinista, supresion no es remediacion, cadena de responsabilidad con ultima instancia, issue remanente y no bloqueo. No propaga la doctrina a agentes ni crea el helper ni el label (#2405-#2412).
- 2026-11-12: se retiran los shims `.sh` (MEF-ADR-0057): el cuerpo cita los scripts `.mts` que los reemplazaban y su invocacion con `node`. Sin cambio de doctrina.
