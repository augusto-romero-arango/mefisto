// Lectura de la seccion '## Dependencias' del body de un issue.
//
// Solo cuentan las dependencias forward ('Depende de #N' / 'Bloqueado por #N', sin distinguir
// mayusculas) con el marcador al inicio del item, tras espacios y una vineta '-' o '*' opcional;
// por linea se toma el primer numero. 'No depende de #N', el marcador a mitad de linea, 'Bloquea',
// 'Consumido por' y la prosa libre se ignoran.
//
// Gemela de `src/internal/scripts/lib/mefisto-deps.sh`; `extract_canonical_dependencies` de
// `scripts/_pipeline-common.sh` aplica la misma regla. Mientras tengan llamadores en bash, un
// cambio de la regla va en los tres.

// El `[[:space:]]` de awk y grep, sin el salto de linea que ya separa los items.
const SPACE = '[ \\t\\v\\f\\r]'
const SECTION_START = new RegExp(`^##${SPACE}*[Dd]ependencias`)
const HEADING = new RegExp(`^##${SPACE}`)
const FORWARD = new RegExp(`^${SPACE}*(?:[-*]${SPACE}+)?(?:Depende de|Bloqueado por)${SPACE}+#([0-9]+)`, 'i')

// Como awk: un salto final cierra la ultima linea, no abre una vacia.
function linesOf(body: string): string[] {
  const lines = body.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Lineas de la seccion, sin su encabezado; vacio si no existe. */
export function dependenciesSection(body: string): string[] {
  const lines: string[] = []
  let inside = false
  for (const line of linesOf(body)) {
    if (SECTION_START.test(line)) {
      inside = true
      continue
    }
    if (HEADING.test(line)) inside = false
    if (inside) lines.push(line)
  }
  return lines
}

/**
 * Numeros de las dependencias forward tal como estan escritos, sin repetir y en orden de texto
 * (`10` antes que `9`), que es el de `sort -u`.
 */
export function forwardDependencies(body: string): string[] {
  const found = new Set<string>()
  for (const line of dependenciesSection(body)) {
    const number = FORWARD.exec(line)?.[1]
    if (number !== undefined) found.add(number)
  }
  return [...found].sort()
}

/** `true` si el body declara la seccion '## Dependencias', aunque este vacia. */
export function hasDependenciesSection(body: string): boolean {
  return linesOf(body).some((line) => SECTION_START.test(line))
}
