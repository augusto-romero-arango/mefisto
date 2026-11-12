// Los comandos internos sobre la fuente neutral (MEF-ADR-0049): los de analisis y seguimiento
// (plan, bug, bitacora, fix-review) y los de ejecucion (tooling, sequential, merge, release).

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runGenerator } from '../../../src/internal/scripts/generate-internal-adapters.mts'
import { Output } from '../../../src/internal/scripts/lib/mefisto-script-io.mts'
import { runValidator } from '../../../src/internal/scripts/validate-internal-artifacts.mts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const COMMAND_IDS = ['mefisto-plan', 'mefisto-bug', 'mefisto-bitacora', 'mefisto-fix-review']
const EXEC_COMMAND_IDS = ['mefisto-tooling', 'mefisto-sequential', 'mefisto-merge', 'mefisto-release']
const ALL_IDS = [...COMMAND_IDS, ...EXEC_COMMAND_IDS]

const sourcePath = (id: string): string => join(REPO_ROOT, 'src', 'internal', 'commands', `${id}.md`)
const source = (id: string): string => readFileSync(sourcePath(id), 'utf8')
const generated = (id: string): string => readFileSync(join(REPO_ROOT, '.claude', 'commands', `${id}.md`), 'utf8')
const hasLine = (text: string, line: string): boolean => text.split('\n').includes(line)

describe('fuentes neutrales de los comandos', () => {
  for (const id of ALL_IDS) {
    test(`${id}: existe y pasa el contrato`, () => {
      assert.ok(existsSync(sourcePath(id)))
      const output = new Output()
      assert.equal(runValidator([sourcePath(id)], output), 0, output.stdout)
    })
  }

  for (const pattern of [/claude --agent/i, /\.claude\/pipeline/i, /\.claude\/agents/i, /\.claude\/commands/i]) {
    test(`ninguna fuente contiene ${pattern.source}`, () => {
      for (const id of ALL_IDS) {
        const hits = source(id)
          .split('\n')
          .filter((line) => pattern.test(line))
        assert.deepEqual(hits, [], id)
      }
    })
  }

  test('CLAUDE.md solo se cita como shim de compatibilidad, nunca como fuente de gobierno', () => {
    for (const id of ALL_IDS) {
      const hits = source(id)
        .split('\n')
        .filter((line) => line.includes('CLAUDE.md') && !line.includes('shim'))
      assert.deepEqual(hits, [], id)
    }
  })

  test('mefisto-tooling no prescribe un alias de modelo en sus ejemplos de --models', () => {
    const tooling = source('mefisto-tooling')
    const hits = tooling.split('\n').filter((line) => /--models[^`]*=(opus|sonnet|haiku)/i.test(line))
    assert.deepEqual(hits, [])
    assert.ok(tooling.includes('models.example.json'))
  })
})

describe('adaptadores generados de los comandos', () => {
  test('--check esta en verde', () => {
    const output = new Output()
    assert.equal(runGenerator(['--check'], output), 0, output.stdout + output.stderr)
  })

  for (const [command, agent] of [
    ['mefisto-plan', 'mefisto-planner'],
    ['mefisto-bug', 'mefisto-investigator'],
    ['mefisto-bitacora', 'mefisto-historiador'],
  ] as const) {
    test(`${command}: lanza a su agente`, () => {
      assert.ok(generated(command).includes(`claude --agent ${agent} "$ARGUMENTS"`))
    })
  }

  test('ninguna salida cita una ruta que la fuente neutral reemplazo', () => {
    for (const id of ALL_IDS) {
      for (const stale of ['.claude/pipeline', '.claude/agents']) {
        assert.equal(generated(id).includes(stale), false, `${id}: ${stale}`)
      }
    }
  })

  test('el guard inverso esta en la salida de cada comando', () => {
    for (const id of ALL_IDS) {
      const guard = generated(id)
        .split('\n')
        .some((line) => line.startsWith('[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ]'))
      assert.ok(guard, id)
    }
  })

  const models: [string, string][] = [
    ['mefisto-plan', 'haiku'],
    ['mefisto-bug', 'haiku'],
    ['mefisto-bitacora', 'haiku'],
    ['mefisto-fix-review', 'opus'],
    ['mefisto-tooling', 'haiku'],
    ['mefisto-sequential', 'haiku'],
    ['mefisto-merge', 'haiku'],
    ['mefisto-release', 'sonnet'],
  ]
  for (const [id, model] of models) {
    test(`${id}: lleva model: "${model}"`, () => {
      assert.ok(hasLine(generated(id), `model: "${model}"`))
    })
  }

  test('mefisto-bitacora no lee mefisto-merge', () => {
    assert.equal(generated('mefisto-bitacora').includes('commands/mefisto-merge.md'), false)
  })

  for (const [id, invocation] of [
    ['mefisto-tooling', 'mefisto-launch-pipeline.mts --tooling $ARGUMENTS'],
    ['mefisto-sequential', 'mefisto-validate-batch-deps.mts <issue1> <issue2> ...'],
    ['mefisto-sequential', 'mefisto-launch-pipeline.mts --batch <issue1> <issue2> ...'],
    ['mefisto-release', 'mefisto-release.mts $ARGUMENTS'],
    ['mefisto-merge', 'mefisto-validate-batch-deps.mts --reconcile-pr "$pr"'],
  ] as const) {
    test(`${id}: invoca ${invocation.split(' ')[0]} desde su fuente`, () => {
      assert.ok(generated(id).includes(`MEFISTO_RUNTIME=claude node src/internal/scripts/${invocation}`))
    })
  }
})

describe('mefisto-merge reconcilia cada merge exitoso', () => {
  const DIRECTIVE = '{{mefisto:run mefisto-validate-batch-deps.mts --reconcile-pr "$pr"}}'

  test('la fuente contiene una unica directiva --reconcile-pr y no usa --delete-branch', () => {
    const lines = source('mefisto-merge').split('\n')
    assert.equal(lines.filter((line) => line.includes(DIRECTIVE)).length, 1)
    assert.equal(lines.filter((line) => line.includes('--delete-branch')).length, 0)
  })

  // Fija la estructura del loop y no solo sus tokens: el `continue` del merge fallido precede
  // al reconciliador y no hay otro en la rama post-merge, asi que una lista mixta reconcilia
  // los exitosos sin reconciliar ni reintentar el fallido.
  test('el loop omite el fallido, reconcilia cada exitoso y degrada solo el post-merge', () => {
    const lines = source('mefisto-merge').split('\n')
    const start = lines.indexOf('for pr in <prs>; do')
    assert.notEqual(start, -1)
    const end = lines.indexOf('done', start)
    assert.notEqual(end, -1)
    const loop = lines.slice(start, end + 1)
    const only = (needle: string): number => {
      const hits = loop.flatMap((line, index) => (line.includes(needle) ? [index] : []))
      assert.equal(hits.length, 1, needle)
      return hits[0] ?? -1
    }
    const merge = only('gh pr merge "$pr" --squash || {')
    const remoteDelete = only('git push origin --delete "$head"')
    const skip = only('continue')
    const reconcile = only(DIRECTIVE)
    const merged = only('resultado="MERGED"')
    const degraded = only('resultado="MERGED (POST-MERGE DEGRADADO)"')
    assert.ok(merge < skip)
    assert.ok(skip < merged)
    assert.ok(skip < remoteDelete)
    assert.ok(remoteDelete < reconcile)
    assert.ok(merged < reconcile)
    assert.ok(reconcile < degraded)
  })
})

describe('{{mefisto:run}} conserva un argumento con espacios y comillas', () => {
  test('de la fuente al adaptador generado', () => {
    const work = mkdtempSync(join(tmpdir(), 'mefisto-run-quoting-'))
    try {
      const fixture = join(work, 'src', 'mefisto-test-run-quoting.md')
      mkdirSync(dirname(fixture), { recursive: true })
      writeFileSync(
        fixture,
        `---
{
  "kind": "command",
  "id": "mefisto-test-run-quoting",
  "description": "Fixture de test: verifica que {{mefisto:run}} preserva argumentos con espacios y comillas (issue #867 CA-6). No se invoca en produccion."
}
---

Invocacion de prueba:

{{mefisto:run mefisto-launch-pipeline.mts --tooling $ARGUMENTS --models 'writer=a b'}}
`,
      )
      const validation = new Output()
      assert.equal(runValidator([fixture], validation), 0, validation.stdout)
      const output = new Output()
      assert.equal(runGenerator(['--out', join(work, 'out'), fixture], output), 0, output.stderr)
      assert.ok(
        hasLine(
          readFileSync(join(work, 'out', '.claude', 'commands', 'mefisto-test-run-quoting.md'), 'utf8'),
          "MEFISTO_RUNTIME=claude node src/internal/scripts/mefisto-launch-pipeline.mts --tooling $ARGUMENTS --models 'writer=a b'",
        ),
      )
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
