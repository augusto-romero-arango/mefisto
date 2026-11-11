// Tests del consumidor: conteo del resumen de `dotnet test` y corrida de los proyectos `*.Tests`.
//
// Gemela de `extract_test_count`, `tests_json_value` y `run_tests_projects` de
// `_pipeline-common.sh`: mientras tengan llamadores en bash, un cambio va en los dos lados.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { runProgram } from '../../warnings-diff.mts'

// `[[:space:]]` de POSIX; `\s` de JavaScript admite ademas espacios Unicode.
const SPACE = '[ \\t\\n\\v\\f\\r]'
const PASSED = new RegExp(`(?:correcto|correctas|passed|superado):${SPACE}*([0-9]+)`, 'g')
const SUCCEEDED = new RegExp(`succeeded:${SPACE}*([0-9]+)`)

/**
 * Tests que pasaron segun la salida de `dotnet test`, sumando el resumen de cada proyecto; `null`
 * (el `?` de bash) si ningun resumen se reconoce. Entiende Microsoft.Testing.Platform, su salida
 * localizada y VSTest.
 */
export function extractTestCount(output: string): number | null {
  let total = 0
  let found = false
  for (const raw of output.split('\n')) {
    const line = raw.replace(/[A-Z]/g, (char) => char.toLowerCase())
    for (const match of line.matchAll(PASSED)) {
      total += Number(match[1])
      found = true
    }
    const succeeded = line.includes('test summary:') ? SUCCEEDED.exec(line) : null
    if (succeeded !== null) {
      total += Number(succeeded[1])
      found = true
    }
  }
  return found ? total : null
}

/** Conteo listo para el historial: un entero no negativo, o `null` si el texto no lo es. */
export function testsJsonValue(tests: string | number | null): number | null {
  const text = tests === null ? '' : String(tests)
  return /^[0-9]+$/.test(text) ? Number(text) : null
}

export interface TestRun {
  /** Salida de todos los proyectos, cada una seguida de un salto de linea. */
  output: string
  /** 0 si todos pasan, el primer codigo de fallo, u 8 si ningun proyecto tenia tests. */
  status: number
}

export interface DotnetResult {
  status: number | null
  /** stdout y stderr juntos, en el orden en que se emitieron. */
  output: string
}

export type RunDotnet = (args: string[]) => DotnetResult

function runDotnet(args: string[]): DotnetResult {
  const dir = mkdtempSync(join(tmpdir(), 'mefisto-dotnet-'))
  try {
    const outputFile = join(dir, 'salida.log')
    const result = runProgram('dotnet', args, { outputFile })
    return { status: result.status, output: readFileSync(outputFile, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Carpetas `tests/<prefijo>.*.Tests` de `worktree`, en orden de bytes; las `*.SmokeTests` no entran. */
export function testProjects(worktree: string, namespacePrefix: string): string[] {
  const tests = join(worktree, 'tests')
  const head = `${namespacePrefix}.`
  let names: string[]
  try {
    names = readdirSync(tests)
  } catch {
    return []
  }
  return names
    .filter((name) => name.startsWith(head) && name.endsWith('.Tests') && name.length >= head.length + '.Tests'.length)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((name) => join(tests, name))
    .filter(isDirectory)
}

/**
 * Corre `dotnet test` en cada proyecto `*.Tests` de `worktree`. Los smoke tests quedan fuera:
 * van contra el entorno desplegado y fallan en un gate local sin credenciales (MEF-ADR-0013).
 */
export function runTestsProjects(
  worktree: string,
  namespacePrefix: string,
  extraArgs: string[] = [],
  run: RunDotnet = runDotnet,
): TestRun {
  let output = ''
  let status = 0
  let anyTestsRan = false
  for (const project of testProjects(worktree, namespacePrefix)) {
    const result = run(['test', '--project', project + sep, ...extraArgs])
    // Sin codigo el proceso no arranco: bash da 127 ante un comando que no existe.
    const code = result.status ?? 127
    output += `${result.output.replace(/\n+$/, '')}\n`
    if (code !== 8) anyTestsRan = true
    if (code !== 0 && code !== 8 && status === 0) status = code
  }
  if (status === 0 && !anyTestsRan) status = 8
  return { output, status }
}
