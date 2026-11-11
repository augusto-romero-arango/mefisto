// Lectura de la seccion '## Dependencias' del body de un issue.
//
// Gemela de `lib/mefisto-deps.sh`: mientras esta tenga llamadores en bash, un cambio va en
// los dos lados.
//
// Solo cuentan las dependencias forward ('Depende de #N' / 'Bloqueado por #N', sin distinguir
// mayusculas) con el marcador al inicio del item, tras espacios y una vineta '-' o '*'
// opcional. 'No depende de #N', el marcador a mitad de linea, 'Bloquea' y la prosa se ignoran.

// `[[:space:]]` de POSIX; `\s` de JavaScript incluye ademas los espacios Unicode.
const SPACE = '[ \\t\\n\\v\\f\\r]'
const SECTION_HEADING = new RegExp(`^##${SPACE}*[Dd]ependencias`)
const ANY_HEADING = new RegExp(`^##${SPACE}`)
const FORWARD = new RegExp(
  `^${SPACE}*(?:[-*]${SPACE}+)?(?:Depende de|Bloqueado por)${SPACE}+#([0-9]+)`,
  'i',
)

function linesOf(body: string): string[] {
  const lines = body.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Lineas de la seccion, sin su encabezado; vacio si no existe. */
export function dependenciesSection(body: string): string[] {
  const section: string[] = []
  let inside = false
  for (const line of linesOf(body)) {
    if (SECTION_HEADING.test(line)) {
      inside = true
      continue
    }
    if (ANY_HEADING.test(line)) inside = false
    if (inside) section.push(line)
  }
  return section
}

/** Numeros de las dependencias forward, sin repetir y en el orden de `sort -u` (de texto: 10 antes que 9). */
export function forwardDependencies(body: string): string[] {
  const numbers = new Set<string>()
  for (const line of dependenciesSection(body)) {
    const number = FORWARD.exec(line)?.[1]
    if (number !== undefined) numbers.add(number)
  }
  return [...numbers].sort()
}

/** `true` si el body declara la seccion '## Dependencias', aunque este vacia. */
export function hasDependenciesSection(body: string): boolean {
  return linesOf(body).some((line) => SECTION_HEADING.test(line))
}
