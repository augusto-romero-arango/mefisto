# Migración y versionado

Migración de consumidores existentes, compatibilidad y actualización a versiones nuevas. Movido desde el [README](../README.md).

## Migración para consumidores existentes

### Migrar el config al canónico `.mefisto/harness.config.json`

El legacy `.claude/harness.config.json` sigue siendo legible como fallback de lectura indefinido (MEF-ADR-0053, decisión 4), pero los escritores (`/onboard` paso 6, `/seed-secret`) rechazan un consumidor solo-legacy y piden migrar conscientemente el archivo completo. No existe una herramienta automática: migra a mano.

1. `mkdir -p .mefisto && git mv .claude/harness.config.json .mefisto/harness.config.json` — mueve el legacy al canónico; el directorio destino debe existir antes del `git mv`.
2. Commitea el movimiento.
3. Corre `/mefisto:onboard` para verificar; ahí también te avisa si falta `.mefisto/pipeline/` en tu `.gitignore`.

No conserves ambos archivos: los lectores avisan de la coexistencia y usan igualmente el canónico.

### Migrar directivas canónicas desde `CLAUDE.md`

Cuando `AGENTS.md` todavía no existe, un `CLAUDE.md` legacy con "Tokens del harness" y "Verificación de fuentes" sigue siendo legible como fallback indefinido. Para que las directivas vivan en la fuente canónica, neutral a runtime, sin duplicarse:

1. mueve las dos secciones, sin reescribir su contenido, a `AGENTS.md`;
2. elimina esas copias de `CLAUDE.md` y añade `@AGENTS.md` como línea independiente;
3. conserva en `CLAUDE.md` solo las directivas realmente específicas de Claude Code, si las hay.

Las demás convenciones del proyecto también pueden vivir en `AGENTS.md`, pero son opcionales y no tienen un formato impuesto por `/onboard`.

### Añadir `boundedContext`

El campo `boundedContext` es **obligatorio** (MEF-ADR-0023). Si actualizas desde una versión que no lo exigía, `load_harness_config` abortará con un mensaje que muestra el shape exacto a añadir. Para migrar:

1. **Abre `.mefisto/harness.config.json`** de tu proyecto y añade el campo `boundedContext` antes del cierre `}`:

   ```json
   "boundedContext": {
     "name": "Principal",
     "domains": ["dominio1", "dominio2"]
   }
   ```

   - `name`: elige un nombre para tu BC (ej: "Principal", "Admin", "Core"). Puede coincidir con `projectName`.
   - `domains`: lista tus `domainLabels` actuales. Si todos tus dominios pertenecen a un solo BC (caso más común), pon todos. Si tienes múltiples BCs futuros, pon solo los que pertenecen a este BC.

2. **Añade los tokens al `AGENTS.md`** de tu proyecto (sección "Tokens del harness"):

   ```markdown
   - **BoundedContext**: Principal
   - **BoundedContextDomains**: dominio1, dominio2
   ```

3. **Deja `CLAUDE.md` como puente** con la línea independiente `@AGENTS.md`. Si aún contiene los tokens o la verificación de fuentes, aplica primero la migración anterior para no duplicar la doctrina.

4. **Verifica con `/mefisto:onboard`**: el checklist mostrará `[OK] boundedContext declarado: name='Principal' domains='...'`.

> **Tip**: si tienes dudas sobre el nombre del BC, usa el mismo `projectName`. La convención del harness es `BC name ≈ projectName` cuando hay un solo BC por proyecto.

## Compatibilidad y versionado

Sigue [SemVer](https://semver.org/):

- **MAJOR**: cambios incompatibles del schema de `harness.config.json` o de paths/contratos esperados del consumidor.
- **MINOR**: nuevos skills/agentes/scripts.
- **PATCH**: fixes.

Cambios **incompatibles** al schema de `harness.config.json` (quitar o renombrar campos, cambiar su tipo, o volver obligatorio uno que no lo era) ⇒ MAJOR + nota de migración en `CHANGELOG.md`. Añadir un campo **opcional** (con default o flag que lo sobrescriba, como `azureLocation`) es retrocompatible ⇒ MINOR, no requiere nota de migración.

## Actualizar a una versión nueva

```
/mefisto:upgrade
```

Reemplaza el flujo manual por un comando + el reload final: detecta el marketplace sin asumir su nombre, actualiza catálogo y plugin, reescribe `.claude/pipeline/.plugin-root` e imprime el delta de `CHANGELOG.md`. Reporta además la activación de Mefisto: si el repo ya lo habilita en su `.claude/settings.json` commiteado y el nivel usuario todavía lo carga en todos tus repos, ofrece deshabilitarlo a ese nivel bajo confirmación. Bajo confirmación explícita, además poda las versiones viejas del cache —nunca la versión cargada en esta sesión ni la nueva—. Termina siempre pidiendo `/reload-plugins` (o reiniciar la sesión), porque la sesión viva sigue cargando la versión anterior hasta entonces.

Por qué la poda necesita cuidado: si borrara la versión que la sesión activa tiene cargada, el propio skill en ejecución desaparecería del disco y la sesión rompería a mitad de camino. Como el paso de actualización ya reescribió `.plugin-root` a la versión nueva, ese archivo deja de describir lo que la sesión cargó, así que el skill le pasa la versión cargada al script de forma explícita (`--prune --loaded <versión>`) y el script la respalda en `.claude/pipeline/.plugin-root.previous` —un marker por sesión que escribe una sola vez y que limpia el hook `SessionStart`, no el script—. Correr `/mefisto:upgrade` dos veces en la misma sesión (el camino natural si declinas podar y lo reconsideras después) es por eso seguro. Si ninguna de las dos fuentes resuelve la versión cargada, el script conserva la N-1 por precaución en vez de arriesgarse.

Revisa el `CHANGELOG.md` para notas de migración antes de actualizar entre majors.
