// Trazabilidad entre los siete hooks de Claude y los hechos neutrales del contrato.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..')

interface Hook {
  command: string
  args: string[]
}

interface Group {
  matcher?: string
  hooks: Hook[]
}

interface Binding {
  id: string
  signal: string
  action: string
}

const hooks = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Group[]>
  }
).hooks
const { bindings } = JSON.parse(
  readFileSync(join(REPO_ROOT, 'src', 'published', 'hooks', 'interactive-hooks.json'), 'utf8'),
) as { bindings: Binding[] }

/** Hooks del evento, y del matcher si se pide, que invocan el binding `id`. */
function traced(id: string, event: string, matcher?: string): number {
  return (hooks[event] ?? [])
    .filter((group) => matcher === undefined || group.matcher === matcher)
    .flatMap((group) => group.hooks)
    .filter((hook) => hook.args[1] === id).length
}

describe('inventario de hooks', () => {
  test('hay siete hooks y el contrato tiene siete hechos', () => {
    const commands = Object.values(hooks).flatMap((groups) => groups.flatMap((group) => group.hooks))
    assert.deepEqual([commands.length, bindings.length], [7, 7])
  })

  const TRACES: [string, string, string?][] = [
    ['record-active-release', 'SessionStart'],
    ['append-session', 'SessionStart'],
    ['append-session-model', 'Stop'],
    ['remind-field-notes', 'Stop'],
    ['append-file-change', 'PostToolUse', 'Write|Edit'],
    ['append-dotnet-test-result', 'PostToolUse', 'Bash'],
    ['append-terraform-result', 'PostToolUse', 'Bash'],
  ]

  for (const [id, event, matcher] of TRACES) {
    test(`${id} traza un hook`, () => {
      assert.equal(traced(id, event, matcher), 1)
      assert.equal(bindings.filter((binding) => binding.id === id).length, 1)
    })
  }

  test('append-session-model declara el hecho posterior neutral', () => {
    const declared = bindings.filter(
      (binding) =>
        binding.id === 'append-session-model' &&
        binding.signal === 'session.model-observed' &&
        binding.action === 'append-session-model',
    )
    assert.equal(declared.length, 1)
  })

  test('no hay bindings huerfanos', () => {
    assert.deepEqual(bindings.map((binding) => binding.id).sort(), TRACES.map(([id]) => id).sort())
  })
})
