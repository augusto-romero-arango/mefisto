// Generacion del adaptador Claude de los hooks. El comportamiento de cada binding lo cubre
// scripts/tests/interactive-hooks.test.mts.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { CliError } from '../../../../scripts/lib/cli.mts'
import type { Json } from '../../../../scripts/lib/jq-values.mts'
import { generateClaudeHooks, hasHooksTopology, main, renderClaudeHooks } from '../generate-claude-hooks.mts'

const HERE = import.meta.dirname
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const HOOKS = join(REPO_ROOT, 'hooks', 'hooks.json')
const SCRIPT_ARG = '${CLAUDE_PLUGIN_ROOT}/scripts/interactive-hooks.mts'

interface Hook {
  type: string
  command: string
  args: string[]
}

interface Group {
  matcher?: string
  hooks: Hook[]
}

interface HooksFile {
  hooks: Record<string, Group[]>
  modules: string[]
}

let work = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto hooks claude '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function run(outRoot: string, check: boolean, render?: () => Json): { status: number; out: string[] } {
  const out: string[] = []
  const status = generateClaudeHooks({
    check,
    outRoot,
    out: (line) => out.push(line),
    ...(render ? { render } : {}),
  })
  return { status, out }
}

const published = (): HooksFile => JSON.parse(readFileSync(HOOKS, 'utf8')) as HooksFile
const allHooks = (file: HooksFile): Hook[] =>
  ['SessionStart', 'Stop', 'PostToolUse'].flatMap((event) =>
    (file.hooks[event] ?? []).flatMap((group) => group.hooks),
  )

describe('generacion', () => {
  test('--check acepta la salida vigente', () => {
    assert.deepEqual(run(REPO_ROOT, true), { status: 0, out: [] })
  })

  test('--check informa la salida faltante sin escribir', () => {
    const empty = join(work, 'vacio')
    assert.deepEqual(run(empty, true), { status: 1, out: ['hooks/hooks.json: faltante'] })
    assert.ok(!existsSync(empty))
  })

  test('un render alternativo coincide byte a byte y no deja temporales', () => {
    const out = join(work, 'render')
    assert.deepEqual(run(out, false), { status: 0, out: [] })
    assert.ok(readFileSync(join(out, 'hooks', 'hooks.json')).equals(readFileSync(HOOKS)))
    assert.deepEqual(run(out, true), { status: 0, out: [] })
    assert.ok(!existsSync(join(work, 'render', 'hooks', '.hooks.json')))
  })

  test('--check informa una diferencia sin escribir', () => {
    const out = join(work, 'distinta')
    mkdirSync(join(out, 'hooks'), { recursive: true })
    writeFileSync(join(out, 'hooks', 'hooks.json'), '{"distinta":true}\n')
    assert.deepEqual(run(out, true), { status: 1, out: ['hooks/hooks.json: distinta'] })
    assert.equal(readFileSync(join(out, 'hooks', 'hooks.json'), 'utf8'), '{"distinta":true}\n')
  })

  test('--check falla si el archivo no trae modules', () => {
    const out = join(work, 'sinmod')
    mkdirSync(join(out, 'hooks'), { recursive: true })
    const { modules: _modules, ...rest } = published()
    writeFileSync(join(out, 'hooks', 'hooks.json'), `${JSON.stringify(rest, null, 2)}\n`)
    assert.deepEqual(run(out, true), { status: 1, out: ['hooks/hooks.json: distinta'] })
  })

  test('la topologia rechaza una clave de primer nivel desconocida sin escribir', () => {
    const out = join(work, 'mutado')
    const mutated = (): Json => ({ ...(renderClaudeHooks() as Record<string, Json>), extra: 1 })
    assert.throws(
      () => run(out, false, mutated),
      new CliError('ERROR: el adaptador Claude renderizado no cumple la estructura de hooks'),
    )
    assert.ok(!existsSync(join(out, 'hooks', 'hooks.json')))
  })

  test('la topologia rechaza hooks movidos, repetidos o con otra forma', () => {
    const render = (): HooksFile => renderClaudeHooks() as unknown as HooksFile
    const mutations: ((file: HooksFile) => void)[] = [
      (file) => file.hooks.Stop?.[0]?.hooks.reverse(),
      (file) => file.hooks.SessionStart?.[0]?.hooks.pop(),
      (file) => file.hooks.PostToolUse?.reverse(),
      (file) => Object.assign(file.hooks.Stop?.[0]?.hooks[0] ?? {}, { timeout: 5 }),
      (file) => Object.assign(file.hooks.Stop?.[0]?.hooks[0] ?? {}, { command: 'bash' }),
      (file) => Object.assign(file.hooks.SessionStart?.[0] ?? {}, { matcher: 'x' }),
      (file) => file.modules.push('./otro.tsx'),
    ]
    assert.ok(hasHooksTopology(render() as unknown as Json))
    for (const [index, mutate] of mutations.entries()) {
      const file = render()
      mutate(file)
      assert.equal(hasHooksTopology(file as unknown as Json), false, `mutacion ${index}`)
    }
    assert.equal(hasHooksTopology([]), false)
  })

  test('argumentos invalidos fallan con exit 1', () => {
    assert.throws(() => main(['--zzz']), new CliError('ERROR: opcion desconocida: --zzz'))
    assert.throws(() => main(['suelto']), new CliError('ERROR: argumento inesperado: suelto'))
    assert.throws(() => main(['--out']), new CliError('ERROR: --out requiere una raiz'))
  })
})

describe('salida publicada', () => {
  test('estructura completa en forma exec, sync implicito y timeout omitido', () => {
    const file = published()
    assert.deepEqual(Object.keys(file).sort(), ['hooks', 'modules'])
    assert.deepEqual(file.modules, ['./index.tsx'])
    assert.deepEqual(Object.keys(file.hooks).sort(), ['PostToolUse', 'SessionStart', 'Stop'])
    for (const event of ['SessionStart', 'Stop']) {
      assert.equal(file.hooks[event]?.length, 1)
      assert.deepEqual(Object.keys(file.hooks[event]?.[0] ?? {}), ['hooks'])
      assert.equal(file.hooks[event]?.[0]?.hooks.length, 2)
    }
    assert.deepEqual(
      file.hooks.PostToolUse?.map((group) => group.matcher),
      ['Write|Edit', 'Bash'],
    )
    assert.equal(file.hooks.PostToolUse?.flatMap((group) => group.hooks).length, 3)
    for (const hook of allHooks(file)) {
      assert.deepEqual(Object.keys(hook).sort(), ['args', 'command', 'type'])
      assert.deepEqual([hook.type, hook.command, hook.args.length], ['command', 'node', 2])
    }
  })

  test('todos los hooks invocan el mismo script bajo la raiz de la distribucion', () => {
    assert.deepEqual([...new Set(allHooks(published()).map((hook) => hook.args[0]))], [SCRIPT_ARG])
    assert.ok(existsSync(join(REPO_ROOT, 'scripts', 'interactive-hooks.mts')))
  })

  test('cada binding del contrato tiene su hook', () => {
    const contract = JSON.parse(
      readFileSync(join(REPO_ROOT, 'src', 'published', 'hooks', 'interactive-hooks.json'), 'utf8'),
    ) as { bindings: { id: string }[] }
    assert.deepEqual(
      allHooks(published())
        .map((hook) => hook.args[1])
        .sort(),
      contract.bindings.map((binding) => binding.id).sort(),
    )
  })
})
