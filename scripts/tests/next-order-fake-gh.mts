// `gh` de mentira para los tests de next-order: responde desde fixtures en memoria.

import { chmodSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

import type { CommandResult } from '../lib/cli.mts'
import type { Gh } from '../lib/next-order.mts'

export interface GhFixtures {
  /** Respuesta de `gh issue list` cuando el label no tiene lista propia. */
  issues?: unknown[]
  /** Respuesta de `gh issue list --label estado:borrador`. */
  borrador?: unknown[]
  /** Respuesta de `gh issue list --label estado:listo`. */
  listo?: unknown[]
  /** Estado que responde `gh issue view <n>`; sin entrada, falla. */
  states?: Record<string, string>
  /** Estado que responde `gh pr view <n>`; sin entrada, falla. */
  prStates?: Record<string, string>
  /** Respuesta de `gh pr list`; sin ella, `[]`. */
  prs?: unknown[]
  prListFails?: boolean
  /** Todo `gh` falla. */
  down?: boolean
}

export interface FakeGh {
  gh: Gh
  /** Argumentos de cada invocacion, en orden. */
  calls: string[][]
}

export function issue(number: number, title: string, body: string, ...labels: string[]): unknown {
  return { number, title, body, labels: labels.map((name) => ({ name })) }
}

const FAILED: CommandResult = { status: 1, stdout: '', stderr: '' }

function ok(stdout: string): CommandResult {
  return { status: 0, stdout, stderr: '' }
}

function respond(fixtures: GhFixtures, args: string[]): CommandResult {
  if (fixtures.down === true) return FAILED
  const [scope, action, target] = args
  if (scope === 'issue' && action === 'list') {
    const label = args[args.indexOf('--label') + 1]
    const own = label === 'estado:listo' ? fixtures.listo : label === 'estado:borrador' ? fixtures.borrador : undefined
    return ok(JSON.stringify(own ?? fixtures.issues ?? []))
  }
  if (scope === 'pr' && action === 'list') {
    return fixtures.prListFails === true ? FAILED : ok(JSON.stringify(fixtures.prs ?? []))
  }
  if (action === 'view' && target !== undefined) {
    const state = (scope === 'issue' ? fixtures.states : fixtures.prStates)?.[target]
    return state === undefined ? FAILED : ok(`${state}\n`)
  }
  return FAILED
}

export function fakeGh(fixtures: GhFixtures): FakeGh {
  const calls: string[][] = []
  return {
    calls,
    gh: (args) => {
      calls.push(args)
      return respond(fixtures, args)
    },
  }
}

/**
 * Instala en `binDir` un `gh` que responde desde `fixtures` y devuelve el entorno que lo antepone
 * en el PATH. Arranca por shebang: no sirve en Windows.
 */
export function fakeGhOnPath(binDir: string, fixtures: GhFixtures): NodeJS.ProcessEnv {
  const stub = join(binDir, 'gh')
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env node',
      'import(process.env.FAKE_GH_MODULE).then(({ fakeGh }) => {',
      '  const result = fakeGh(JSON.parse(process.env.FAKE_GH_FIXTURES)).gh(process.argv.slice(2))',
      '  process.stdout.write(result.stdout)',
      '  process.exitCode = result.status',
      '})',
      '',
    ].join('\n'),
  )
  chmodSync(stub, 0o755)
  return {
    ...process.env,
    PATH: [binDir, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    FAKE_GH_MODULE: import.meta.url,
    FAKE_GH_FIXTURES: JSON.stringify(fixtures),
  }
}
