# changelog.d/ — fragmentos de CHANGELOG e indice de ADRs

Mecanismo de anotacion por fragmentos (issue #380), reemplaza la edicion directa
de `CHANGELOG.md` y de la tabla "Indice tematico" de `CLAUDE.md` por-PR: varios
PRs editando las mismas pocas lineas de esos dos archivos-indice era el punto de
contencion que colisionaba cuando corrian en paralelo (`/parallel`) o cuando el
sync con `main` se hacia una sola vez antes de crear el PR. Con un archivo propio
por issue, dos PRs nunca tocan la misma linea.

## Dos tipos de fragmento

- **Fragmento de CHANGELOG**: `<issue>.<categoria>.md`, donde `<categoria>` es
  una de `added`, `changed`, `fixed`, `removed` (las categorias de
  [Keep a Changelog](https://keepachangelog.com/) que usa este repo). Contenido:
  una o mas lineas `- texto de la entrada`, listas para insertarse bajo la
  subseccion `### <Categoria>` del bloque `## [Unreleased]` de `CHANGELOG.md`.

  Ejemplo, `changelog.d/380.added.md`:

  ```markdown
  - Se anade el mecanismo de fragmentos de CHANGELOG (`changelog.d/`), que
    reemplaza la edicion directa de `CHANGELOG.md` por-PR.
  ```

- **Fragmento de indice de ADRs**: `<issue>.adr-index.md`. Solo lo crean los
  issues que anaden o enmiendan un ADR del marco (`docs/adr/`). Contenido: una o
  mas filas de la tabla `| Tema | ADR |` del indice tematico de `CLAUDE.md`,
  listas para insertarse tal cual al final de esa tabla.

  Ejemplo, `changelog.d/380.adr-index.md`:

  ```markdown
  | Tema del ADR | MEF-ADR-0036 |
  ```

Un mismo issue puede dejar los dos fragmentos a la vez (p. ej. un issue que
redacta un ADR nuevo anota su entrada de CHANGELOG **y** su fila de indice).

## Quien los consume

`/mefisto-release` (fase *prepare*, `src/internal/scripts/mefisto-release.mts`,
issue #864)
consolida todos los fragmentos presentes: vuelca los de CHANGELOG en el bloque
`[Unreleased]` de `CHANGELOG.md` agrupados por categoria, vuelca los de indice
de ADRs al final de la tabla de `CLAUDE.md`, y borra los fragmentos consumidos.
Ningun PR de issue individual debe editar `CHANGELOG.md` ni la tabla de indice
de `CLAUDE.md` directamente — solo `/mefisto-release` lo hace, y solo en su
propia rama de release.

`changelog.d/README.md` (este archivo) es el unico `.md` de este directorio que
**no** es un fragmento: la consolidacion lo ignora explicitamente.
