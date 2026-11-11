// Tests en rojo que ya existian antes de la fase roja, y tests que el reviewer toco en la fase
// refactor (issues #1937, #2062 y #2438).
//
// Gemela de `_red_method_body`, `detect_preexisting_red_tests`, `preexisting_red_only`,
// `list_reviewer_touched_tests` y `render_reviewer_touched_tests_section` de
// `_pipeline-common.sh`: mientras tengan llamadores en bash, un cambio va en los dos lados.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { capture } from '../cli.mts'
import type { Run } from '../azure-cli.mts'

// `[[:space:]]` de POSIX; `\s` de JavaScript admite ademas espacios Unicode.
const SPACE = '[ \\t\\n\\v\\f\\r]'
const ANSI_COLOR = /\u001b\[[0-9;]*m/g
const FAILED_LINE = new RegExp(`^${SPACE}*(?:failed|✗|×)${SPACE}+([^ \\t\\n\\v\\f\\r]+)`)
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENDS_STATEMENT = new RegExp(`;${SPACE}*$`)

function lines(text: string): string[] {
  const all = text.split('\n')
  if (all.at(-1) === '') all.pop()
  return all
}

/**
 * Bloque del primer metodo de `source` cuya firma contiene `method(`: desde la firma hasta que las
 * llaves balancean, o hasta el `;` de un cuerpo con `=>`. Cada linea sale con su salto; vacio si
 * no esta. `method` es un identificador.
 */
export function redMethodBody(source: string, method: string): string {
  const signature = new RegExp(`${SPACE}${method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${SPACE}*\\(`)
  let body = ''
  let found = false
  let arrow = false
  let seen = false
  let depth = 0
  for (const line of lines(source)) {
    if (!found && signature.test(line)) {
      found = true
      arrow = line.includes('=>')
    }
    if (!found) continue
    body += `${line}\n`
    if (!seen && arrow && !line.includes('{')) {
      if (ENDS_STATEMENT.test(line)) break
      continue
    }
    const opened = line.split('{').length - 1
    depth += opened - (line.split('}').length - 1)
    if (opened > 0) seen = true
    if (seen && depth <= 0) break
  }
  return body
}

/** Nombres de los tests que fallaron segun la salida de Microsoft Testing Platform, en orden. */
function failedNames(output: string): string[] {
  const names: string[] = []
  for (const line of output.split('\n')) {
    const name = FAILED_LINE.exec(line.replace(ANSI_COLOR, ''))?.[1]
    if (name !== undefined) names.push(name)
  }
  return names
}

/** Ultimo segmento punteado del nombre, sin los parametros de una teoria. */
function methodOf(name: string): string {
  const open = name.indexOf('(')
  const bare = open === -1 ? name : name.slice(0, open)
  return bare.slice(bare.lastIndexOf('.') + 1)
}

export interface RedTest {
  test: string
  /** Ruta del archivo, relativa al worktree y con `/`. */
  file: string
}

export interface RedTestsResult {
  /** 0 analisis completo; 1 hay un rojo que no es preexistente; 2 salida no parseable o fallo del analisis. */
  status: 0 | 1 | 2
  tests: RedTest[]
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Tests en rojo que ya existian en `snapshot` y cuyo cuerpo no cambio desde entonces: candidatos
 * a pin desactualizado. Un test nuevo o modificado no se reporta. No recompila: compara el bloque
 * del metodo en el arbol de `snapshot` contra el archivo actual.
 */
export function detectPreexistingRedTests(
  worktree: string,
  snapshot: string,
  output: string,
  run: Run = capture,
): RedTestsResult {
  const names = failedNames(output)
  if (names.length === 0) return { status: 2, tests: [] }
  const git = (...args: string[]) => run('git', ['-C', worktree, ...args])
  if (git('rev-parse', '--verify', '-q', `${snapshot}^{commit}`).status !== 0) return { status: 2, tests: [] }

  const tests: RedTest[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const method = methodOf(name)
    if (!IDENTIFIER.test(method) || seen.has(method)) continue
    seen.add(method)
    const hits = git('grep', '-l', '-E', `[[:space:]]${method}[[:space:]]*\\(`, snapshot, '--', 'tests/*.cs')
    if (hits.status !== 0) continue
    for (const hit of hits.stdout.split('\n')) {
      if (hit.length === 0) continue
      const file = hit.startsWith(`${snapshot}:`) ? hit.slice(snapshot.length + 1) : hit
      const shown = git('show', `${snapshot}:${file}`)
      const before = shown.status === 0 ? redMethodBody(shown.stdout, method).replace(/\n+$/, '') : ''
      const current = join(worktree, file)
      if (before.length === 0 || !isFile(current)) continue
      if (before === redMethodBody(readFileSync(current, 'utf8'), method).replace(/\n+$/, '')) {
        tests.push({ test: method, file })
        break
      }
    }
  }
  return { status: 0, tests }
}

/**
 * La lista de `detectPreexistingRedTests`, solo si todos los tests en rojo de `output` estan en
 * ella (Gate 2). Con `status` 1 o 2 la lista sale vacia.
 */
export function preexistingRedOnly(
  worktree: string,
  snapshot: string,
  output: string,
  run: Run = capture,
): RedTestsResult {
  const detected = detectPreexistingRedTests(worktree, snapshot, output, run)
  if (detected.status !== 0) return { status: 2, tests: [] }
  if (detected.tests.length === 0) return { status: 1, tests: [] }
  const preexisting = new Set(detected.tests.map((red) => red.test))
  const allPreexisting = failedNames(output).every((name) => preexisting.has(methodOf(name)))
  return allPreexisting ? detected : { status: 1, tests: [] }
}

/** `<test>\t<archivo>` por linea, como lo imprime bash. */
export function redTestsText(tests: readonly RedTest[]): string {
  return tests.map((red) => `${red.test}\t${red.file}\n`).join('')
}

/** Archivos de `tests/` modificados, renombrados o eliminados entre `base` y `HEAD`. */
export function listReviewerTouchedTests(worktree: string, base: string, run: Run = capture): string[] {
  const diff = run('git', ['-C', worktree, 'diff', '--name-only', '--diff-filter=MDR', base, 'HEAD', '--', 'tests/'])
  return diff.stdout.split('\n').filter((file) => file.length > 0)
}

/**
 * Seccion "Tests ajustados por el reviewer" del cuerpo del PR, con una linea por archivo; vacia
 * sin archivos. `blockageResolved` agrega la linea del destrabe tras la fase verde.
 */
export function renderReviewerTouchedTestsSection(files: readonly string[], blockageResolved = false): string {
  const list = files.filter((file) => file.length > 0)
  if (list.length === 0) return ''
  return [
    '## Tests ajustados por el reviewer\n\n',
    'El reviewer modifico, renombro o elimino estos tests existentes en la fase refactor; se revisan en el diff del PR.\n\n',
    blockageResolved ? 'Lo hizo al destrabar tests en rojo despues de la fase verde.\n\n' : '',
    ...list.map((file) => `- \`${file}\`\n`),
    '\n',
  ].join('')
}
