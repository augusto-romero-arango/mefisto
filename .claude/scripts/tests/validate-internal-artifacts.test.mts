import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { capture } from '../../../scripts/lib/cli.mts'
import { extractBody, extractFrontmatter } from '../../../src/internal/scripts/lib/frontmatter.mts'
import type { Json, JsonObject } from '../../../src/internal/scripts/lib/jq-json.mts'
import { validateSchema } from '../../../src/internal/scripts/lib/jsonschema-lite.mts'
import { Output } from '../../../src/internal/scripts/lib/mefisto-script-io.mts'
import {
  bodyRuntimeReferences,
  runValidator,
} from '../../../src/internal/scripts/validate-internal-artifacts.mts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPTS = join(REPO_ROOT, 'src', 'internal', 'scripts')
const CONTRACT = join(REPO_ROOT, 'src', 'internal', 'contract')
const SCHEMA_FILE = join(CONTRACT, 'internal-artifact.schema.json')
const SCHEMA = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')) as JsonObject

const posix = (path: string): string => path.split(sep).join('/')

function validate(files: string[], repoRoot?: string): { status: number; stdout: string; stderr: string } {
  const output = new Output()
  const status = runValidator(files, output, repoRoot)
  return { status, stdout: output.stdout, stderr: output.stderr }
}

let work = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto-validador-'))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function fixture(name: string, content: string): string {
  const path = join(work, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

describe('fixtures del contrato', () => {
  test('los de fixtures/valid pasan', () => {
    const valid = readdirSync(join(CONTRACT, 'fixtures', 'valid')).filter((name) => name.endsWith('.md'))
    assert.ok(valid.length > 0)
    for (const name of valid) {
      const run = validate([join(CONTRACT, 'fixtures', 'valid', name)])
      assert.equal(run.status, 0, `${name}: ${run.stdout}`)
      assert.equal(run.stdout, '')
    }
  })

  // El motivo se comprueba para que un fixture invalido no pase por la razon equivocada.
  const invalid: [string, string][] = [
    ['mefisto-invalid-model-field.md', 'model: propiedad adicional'],
    ['mefisto-invalid-tools-field.md', 'tools: propiedad adicional'],
    ['mefisto-invalid-permission-field.md', 'permission: propiedad adicional'],
    ['mefisto-invalid-allowed-tools-field.md', 'allowed-tools: propiedad adicional'],
    ['mefisto-invalid-profile-value.md', 'profile: valor'],
    ['mefisto-invalid-capability-value.md', 'capabilities'],
    ['mefisto-invalid-extra-property.md', 'foo: propiedad adicional'],
    ['no-frontmatter.md', 'frontmatter: ausente'],
    ['frontmatter-not-json.md', 'no es JSON valido'],
    ['mismatched-id.md', 'distinto del nombre de archivo'],
    ['mefisto-missing-mode.md', 'mode: campo requerido ausente'],
    ['mefisto-missing-effort.md', 'effort: campo requerido ausente'],
    ['mefisto-invalid-effort-value.md', 'effort: valor'],
    ['mefisto-id-not-string.md', 'id: tipo esperado string'],
    ['mefisto-body-runtime-reference.md', 'nombra un runtime concreto'],
  ]
  for (const [name, reason] of invalid) {
    test(`${name} se rechaza con su motivo`, () => {
      const run = validate([join(CONTRACT, 'fixtures', 'invalid', name)])
      assert.equal(run.status, 1)
      assert.ok(run.stdout.includes(reason), run.stdout)
      assert.ok(run.stdout.startsWith(`src/internal/contract/fixtures/invalid/${name}: `), run.stdout)
    })
  }

  test('todo fixture de fixtures/invalid tiene su caso', () => {
    const names = readdirSync(join(CONTRACT, 'fixtures', 'invalid')).sort()
    assert.deepEqual(names, invalid.map(([name]) => name).sort())
  })
})

describe('sin argumentos', () => {
  test('la fuente real del repo valida completa', () => {
    const run = validate([])
    assert.equal(run.stdout, '')
    assert.equal(run.status, 0)
  })

  test('el .mts corre como comando', () => {
    const script = join(SCRIPTS, 'validate-internal-artifacts.mts')
    const run = capture(process.execPath, [script, join(CONTRACT, 'fixtures', 'invalid', 'mismatched-id.md')])
    assert.equal(run.status, 1)
    assert.equal(
      run.stdout,
      "src/internal/contract/fixtures/invalid/mismatched-id.md: id: 'mefisto-otro-nombre' distinto del nombre de archivo 'mismatched-id'\n",
    )
  })

  test('sin el schema aborta con un error', () => {
    const empty = join(work, 'sin-schema')
    mkdirSync(empty, { recursive: true })
    const run = validate([], empty)
    assert.equal(run.status, 1)
    assert.equal(
      run.stderr,
      `ERROR: no existe '${posix(empty)}/src/internal/contract/internal-artifact.schema.json'\n`,
    )
  })
})

describe('estructura del archivo', () => {
  const rejection = (name: string, content: string): string => {
    const path = fixture(name, content)
    const run = validate([path])
    assert.equal(run.status, 1, name)
    return run.stdout.replaceAll(`${posix(path)}: `, '')
  }

  test('archivo inexistente', () => {
    assert.equal(
      validate([join(work, 'no-existe.md')]).stdout,
      `${posix(join(work, 'no-existe.md'))}: archivo: no existe o no es un archivo regular\n`,
    )
  })

  test('frontmatter sin cierre, vacio o que no es un objeto', () => {
    assert.equal(
      rejection('mefisto-a.md', '---\n{"kind":"agent"\n'),
      "frontmatter: sin delimitador de cierre (falta una linea '---' tras el objeto JSON)\n",
    )
    assert.equal(rejection('mefisto-b.md', ''), rejection('mefisto-a.md', '---\n{"kind":"agent"\n'))
    assert.equal(
      rejection('mefisto-c.md', '---\n\n---\nbody\n'),
      'frontmatter: bloque vacio (se esperaba un objeto JSON)\n',
    )
    assert.equal(
      rejection('mefisto-d.md', '---\n[1,2]\n---\n'),
      '(raiz): se esperaba un objeto JSON, encontrado array\n',
    )
  })

  test('kind ausente o desconocido', () => {
    assert.equal(
      rejection('mefisto-e.md', '---\n{"id":"mefisto-e","description":"x"}\n---\n'),
      'kind: campo requerido ausente\n',
    )
    assert.equal(
      rejection('mefisto-f.md', '---\n{"kind":"otro","id":"mefisto-f","description":"x"}\n---\n'),
      'kind: valor "otro" no coincide con ningun \'kind\' declarado en oneOf\n',
    )
  })

  test('varios motivos salen en el orden del schema', () => {
    assert.equal(
      rejection(
        'mefisto-g.md',
        '---\n{"kind":"agent","id":"","description":"","mode":"x","effort":1,"capabilities":"read","skills":[1,""],"profile":null}\n---\n',
      ),
      [
        'id: longitud minima 1, encontrado 0',
        "id: '' no coincide con el patron ^mefisto-[a-z0-9]+(-[a-z0-9]+)*$",
        'description: longitud minima 1, encontrado 0',
        'mode: valor "x" no esta en el vocabulario permitido ["primary","subagent","all"]',
        'effort: tipo esperado string, encontrado number',
        'effort: valor 1 no esta en el vocabulario permitido ["quick","light","standard","thorough","exhaustive"]',
        'profile: tipo esperado string, encontrado null',
        'profile: valor null no esta en el vocabulario permitido ["fast","balanced","deep"]',
        'capabilities: tipo esperado array, encontrado string',
        'skills.0: tipo esperado string, encontrado number',
        'skills.1: longitud minima 1, encontrado 0',
        '',
      ].join('\n'),
    )
  })

  test('el body solo puede citar el manifiesto del plugin y la superficie de scripts', () => {
    const content =
      '---\n{"kind":"command","id":"mefisto-h","description":"d"}\n---\n\nlinea CLAUDE aqui\n.claude-plugin/x y .claude/scripts ok\nClaude Code\n'
    assert.deepEqual(bodyRuntimeReferences(content), [5, 7])
    assert.equal(
      rejection('mefisto-h.md', content),
      [
        'body: linea 5 nombra un runtime concreto; la fuente neutral es agnostica (CA-1)',
        'body: linea 7 nombra un runtime concreto; la fuente neutral es agnostica (CA-1)',
        '',
      ].join('\n'),
    )
  })
})

describe('corte del frontmatter', () => {
  test('frontmatter y body con sus codigos', () => {
    assert.deepEqual(extractFrontmatter('---\n{"a":1}\n---\n\ncuerpo\n'), { status: 0, text: '{"a":1}\n' })
    assert.deepEqual(extractBody('---\n{"a":1}\n---\n\ncuerpo\n---\n'), { status: 0, text: '\ncuerpo\n---\n' })
    assert.deepEqual(extractFrontmatter('x\n---\n'), { status: 1, text: '' })
    assert.deepEqual(extractFrontmatter('---\nsin cierre\n'), { status: 2, text: 'sin cierre\n' })
    assert.deepEqual(extractBody('---\nsin cierre\n'), { status: 2, text: '' })
    assert.deepEqual(extractFrontmatter(''), { status: 2, text: '' })
  })

  test('cada forma del archivo: codigo y texto del frontmatter y del body', () => {
    const cases: [string, number, string, number, string][] = [
      ['', 2, '', 2, ''],
      ['---\n', 2, '', 2, ''],
      ['sin frontmatter\n---\n', 1, '', 1, ''],
      ['---\n{"a":1}\n---\n', 0, '{"a":1}\n', 0, ''],
      ['---\n{"a":1}\n---', 0, '{"a":1}\n', 0, ''],
      ['---\n{"a":1}\n---\n\ncuerpo\n---\nmas\n\n\n', 0, '{"a":1}\n', 0, '\ncuerpo\n---\nmas\n\n\n'],
      ['---\nsin cierre\notra\n', 2, 'sin cierre\notra\n', 2, ''],
      ['---\r\n{"a":1}\r\n---\r\n', 1, '', 1, ''],
      ['---\n---\n---\ncuerpo sin salto final', 0, '', 0, '---\ncuerpo sin salto final\n'],
    ]
    for (const [sample, frontmatterStatus, frontmatter, bodyStatus, body] of cases) {
      assert.deepEqual(extractFrontmatter(sample), { status: frontmatterStatus, text: frontmatter }, JSON.stringify(sample))
      assert.deepEqual(extractBody(sample), { status: bodyStatus, text: body }, JSON.stringify(sample))
    }
  })
})

describe('subconjunto de JSON Schema', () => {
  test('una instancia valida no produce motivos', () => {
    assert.deepEqual(
      validateSchema(SCHEMA, { kind: 'agent', id: 'mefisto-x', description: 'd', mode: 'all', effort: 'quick' }),
      [],
    )
  })

  test('minLength cuenta caracteres, no unidades UTF-16', () => {
    assert.deepEqual(validateSchema({ type: 'string', minLength: 2 }, '😀'), [': longitud minima 2, encontrado 1'])
  })

  test('cada instancia con sus motivos, en orden', () => {
    const vocabulary = (values: string[]): string => JSON.stringify(values)
    const capabilities = vocabulary(['read', 'edit', 'shell', 'web', 'skill', 'task', 'mcp', 'ask'])
    const pattern = '^mefisto-[a-z0-9]+(-[a-z0-9]+)*$'
    const cases: [Json, string[]][] = [
      [{}, ['kind: campo requerido ausente']],
      [[1, 2], ['(raiz): se esperaba un objeto JSON, encontrado array']],
      ['cadena', ['(raiz): se esperaba un objeto JSON, encontrado string']],
      [null, ['(raiz): se esperaba un objeto JSON, encontrado null']],
      [{ id: 'mefisto-x', description: 'd' }, ['kind: campo requerido ausente']],
      [{ kind: 'otro', id: 'mefisto-x', description: 'd' }, ['kind: valor "otro" no coincide con ningun \'kind\' declarado en oneOf']],
      [
        { kind: ['agent'], id: 'mefisto-x', description: 'd' },
        ['mode: campo requerido ausente', 'effort: campo requerido ausente', 'kind: tipo esperado string, encontrado array'],
      ],
      [
        { kind: 'agent', id: 7, description: '', mode: 'x', effort: null, capabilities: ['read', 'bash', 3] },
        [
          'id: tipo esperado string, encontrado number',
          'description: longitud minima 1, encontrado 0',
          `mode: valor "x" no esta en el vocabulario permitido ${vocabulary(['primary', 'subagent', 'all'])}`,
          'effort: tipo esperado string, encontrado null',
          `effort: valor null no esta en el vocabulario permitido ${vocabulary(['quick', 'light', 'standard', 'thorough', 'exhaustive'])}`,
          `capabilities.1: valor "bash" no esta en el vocabulario permitido ${capabilities}`,
          'capabilities.2: tipo esperado string, encontrado number',
          `capabilities.2: valor 3 no esta en el vocabulario permitido ${capabilities}`,
        ],
      ],
      [
        { kind: 'command', id: 'Mefisto', description: 'd', agent: 'x', arguments: '', zz: 1, aa: { b: [true] } },
        [
          'zz: propiedad adicional no permitida',
          'aa: propiedad adicional no permitida',
          `id: 'Mefisto' no coincide con el patron ${pattern}`,
          `agent: 'x' no coincide con el patron ${pattern}`,
          'arguments: longitud minima 1, encontrado 0',
        ],
      ],
      [
        { kind: 'command', id: 'mefisto-x', description: 'dé😀', skills: [], capabilities: {} },
        ['capabilities: tipo esperado array, encontrado object'],
      ],
    ]
    for (const [instance, reasons] of cases) assert.deepEqual(validateSchema(SCHEMA, instance), reasons, JSON.stringify(instance))
  })
})
