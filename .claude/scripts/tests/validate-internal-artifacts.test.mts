import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { capture, commandExists } from '../../../scripts/lib/cli.mts'
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

const SAMPLES = [
  '',
  '---\n',
  'sin frontmatter\n---\n',
  '---\n{"a":1}\n---\n',
  '---\n{"a":1}\n---',
  '---\n{"a":1}\n---\n\ncuerpo\n---\nmas\n\n\n',
  '---\nsin cierre\notra\n',
  '---\r\n{"a":1}\r\n---\r\n',
  '---\n---\n---\ncuerpo sin salto final',
]

describe('corte del frontmatter', () => {
  test('frontmatter y body con sus codigos', () => {
    assert.deepEqual(extractFrontmatter('---\n{"a":1}\n---\n\ncuerpo\n'), { status: 0, text: '{"a":1}\n' })
    assert.deepEqual(extractBody('---\n{"a":1}\n---\n\ncuerpo\n---\n'), { status: 0, text: '\ncuerpo\n---\n' })
    assert.deepEqual(extractFrontmatter('x\n---\n'), { status: 1, text: '' })
    assert.deepEqual(extractFrontmatter('---\nsin cierre\n'), { status: 2, text: 'sin cierre\n' })
    assert.deepEqual(extractBody('---\nsin cierre\n'), { status: 2, text: '' })
    assert.deepEqual(extractFrontmatter(''), { status: 2, text: '' })
  })

  test(
    'coincide con frontmatter.sh',
    { skip: process.platform === 'win32' ? 'la libreria bash no corre en Windows' : false },
    () => {
      const lib = join(SCRIPTS, 'lib', 'frontmatter.sh')
      for (const [index, sample] of SAMPLES.entries()) {
        const path = fixture(`corte-${index}.md`, sample)
        for (const [fn, ours] of [
          ['extract_frontmatter', extractFrontmatter(sample)],
          ['extract_body', extractBody(sample)],
        ] as const) {
          const twin = capture('bash', ['-c', `source "$1"; ${fn} "$2"`, 'bash', lib, path])
          assert.equal(ours.status, twin.status, `${fn} ${JSON.stringify(sample)}`)
          assert.equal(ours.text, twin.stdout, `${fn} ${JSON.stringify(sample)}`)
        }
      }
    },
  )
})

describe('subconjunto de JSON Schema', () => {
  const instances: Json[] = [
    {},
    [1, 2],
    'cadena',
    null,
    { id: 'mefisto-x', description: 'd' },
    { kind: 'otro', id: 'mefisto-x', description: 'd' },
    { kind: ['agent'], id: 'mefisto-x', description: 'd' },
    { kind: 'agent', id: 'mefisto-x', description: 'd', mode: 'all', effort: 'quick' },
    { kind: 'agent', id: 7, description: '', mode: 'x', effort: null, capabilities: ['read', 'bash', 3] },
    { kind: 'command', id: 'Mefisto', description: 'd', agent: 'x', arguments: '', zz: 1, aa: { b: [true] } },
    { kind: 'command', id: 'mefisto-x', description: 'dé😀', skills: [], capabilities: {} },
  ]

  test('una instancia valida no produce motivos', () => {
    assert.deepEqual(
      validateSchema(SCHEMA, { kind: 'agent', id: 'mefisto-x', description: 'd', mode: 'all', effort: 'quick' }),
      [],
    )
  })

  test('minLength cuenta caracteres, no unidades UTF-16', () => {
    assert.deepEqual(validateSchema({ type: 'string', minLength: 2 }, '😀'), [': longitud minima 2, encontrado 1'])
  })

  test(
    'coincide con jsonschema-lite.jq',
    {
      skip:
        process.platform === 'win32' || !commandExists('jq') ? 'la gemela en jq necesita jq y no corre en Windows' : false,
    },
    () => {
      const program = join(SCRIPTS, 'lib', 'jsonschema-lite.jq')
      for (const instance of instances) {
        const twin = capture('jq', [
          '-n',
          '--argjson',
          'schema',
          JSON.stringify(SCHEMA),
          '--argjson',
          'instance',
          JSON.stringify(instance),
          '-f',
          program,
        ])
        assert.equal(twin.status, 0, twin.stderr)
        assert.deepEqual(validateSchema(SCHEMA, instance), JSON.parse(twin.stdout), JSON.stringify(instance))
      }
    },
  )
})
