// Contrato publicado: fixtures de artefactos, registro MCP y su proyeccion Claude.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { indexOf, jqRegExp, validateSchema } from '../lib/published-schema.mts'
import { validatePublishedArtifacts } from '../validate-published-artifacts.mts'
import { main as validateMcp } from '../validate-published-mcp.mts'

const HERE = import.meta.dirname
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const CONTRACT = join(REPO_ROOT, 'src', 'published', 'contract')
const INVALID = 'src/published/contract/fixtures/invalid'
const MCP_FIXTURES = join(CONTRACT, 'fixtures', 'mcp')

let work = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto contrato publicado '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function validate(...files: string[]): { status: number; output: string } {
  const result = validatePublishedArtifacts(files, REPO_ROOT)
  return { status: result.status, output: result.stdout + result.stderr }
}

describe('contrato publicado', () => {
  test('existen el schema, el registro MCP y los validadores', () => {
    for (const file of ['published-artifact.schema.json', 'mcp-servers.json', 'mcp-servers.schema.json']) {
      assert.ok(existsSync(join(CONTRACT, file)), file)
    }
    assert.doesNotThrow(() =>
      JSON.parse(readFileSync(join(CONTRACT, 'published-artifact.schema.json'), 'utf8')),
    )
  })

  test('los fixtures validos pasan', () => {
    const dir = join(CONTRACT, 'fixtures', 'valid')
    const fixtures = readdirSync(dir).filter((name) => name.endsWith('.md'))
    assert.ok(fixtures.length > 0)
    for (const name of fixtures) assert.deepEqual(validate(join(dir, name)), { status: 0, output: '' }, name)
  })

  // Fixture invalido y el fragmento de diagnostico que lo identifica.
  const REJECTED: [string, string][] = [
    ['frontmatter-not-json.md', 'frontmatter: no es JSON valido'],
    ['missing-description.md', 'description: campo requerido ausente'],
    ['extra-property.md', 'foo: propiedad adicional no permitida'],
    ['invalid-kind.md', 'kind: valor'],
    ['invalid-profile.md', 'profile: valor'],
    ['invalid-mode.md', 'mode: valor'],
    ['missing-mode.md', 'mode: campo requerido ausente'],
    ['missing-effort.md', 'effort: campo requerido ausente'],
    ['invalid-effort.md', 'effort: valor'],
    ['effort-on-command.md', 'effort: propiedad adicional'],
    ['invalid-capability.md', 'capabilities.0: valor'],
    ['mismatched-id.md', "id: 'other-id' distinto"],
    ['mefisto-prefixed-id.md', "id: 'mefisto-prefixed-id' no coincide"],
    ['id-with-colon.md', "id: 'mefisto:id-with-colon' no coincide"],
    ['model-field.md', 'model: propiedad adicional'],
    ['tools-field.md', 'tools: propiedad adicional'],
    ['allowed-tools-field.md', 'allowed-tools: propiedad adicional'],
    ['permission-field.md', 'permission: propiedad adicional'],
    ['mode-on-command.md', 'mode: propiedad adicional'],
    ['command-fields-on-agent.md', 'agent: propiedad adicional'],
    ['missing-guard.md', 'body: falta {{mefisto:assert-consumer-repo}}'],
    ['unknown-directive.md', 'directiva mefisto desconocida'],
    ['malformed-mcp.md', 'mcp.0'],
    ['unknown-mcp.md', 'mcp.0: valor'],
    ['missing-skill.md', "skills: 'skill-inexistente' no resuelve"],
    ['prefixed-skill.md', "skills.0: 'mefisto-projections' no coincide"],
    ['prefixed-agent-reference.md', "agent: 'mefisto-example-agent' no coincide"],
    ['guard-outside-body.md', 'body: falta {{mefisto:assert-consumer-repo}}'],
    [
      'launch-agent-no-message.md',
      'directiva mefisto mal formada: {{mefisto:launch-agent bug-investigator}}',
    ],
    ['launch-agent-unknown-agent.md', "launch-agent 'agente-inexistente' no existe en src/published/agents"],
    ['launch-agent-with-agent.md', 'un comando con agent no puede usar launch-agent'],
    ['extra-closing-brace.md', 'directiva mefisto mal formada'],
    ['prefixed-directive-id.md', 'directiva mefisto mal formada'],
    ['skill-root-invalid-id.md', 'directiva mefisto mal formada: {{mefisto:skill-root mefisto-projections}}'],
    ['skill-root-undeclared.md', 'directiva skill-root comment-cleanup no esta declarada en skills'],
    [
      'command-doc-missing.md',
      'directiva command-doc command-doc-inexistente no resuelve a src/published/commands/command-doc-inexistente.md',
    ],
    ['command-doc-invalid-id.md', 'directiva mefisto mal formada: {{mefisto:command-doc Mefisto-Draft}}'],
    ['command-doc-self.md', 'directiva command-doc command-doc-self referencia al propio comando'],
    [
      'skill-root-missing.md',
      'directiva skill-root skill-inexistente no resuelve a skills/skill-inexistente/SKILL.md',
    ],
  ]

  for (const [name, expected] of REJECTED) {
    test(`rechaza ${name}: ${expected}`, () => {
      const result = validate(join(CONTRACT, 'fixtures', 'invalid', name))
      assert.equal(result.status, 1)
      assert.ok(result.output.includes(expected), result.output)
    })
  }

  // Fixture invalido y su salida completa.
  const EXACT: [string, string[]][] = [
    [
      'body-runtime-reference.md',
      ['body: linea 5 referencia un runtime, CLI, cache, directorio o metadata propia de runtime'],
    ],
    [
      'malformed-directive.md',
      ['body: linea 5 directiva mefisto mal formada: {{mefisto:launch-agent invalid:id}}'],
    ],
    [
      'runtime-variable.md',
      [
        'body: linea 5 referencia un runtime, CLI, cache, directorio o metadata propia de runtime',
        'body: linea 5 placeholder no permitido: $CLAUDE_PLUGIN_ROOT (solo se admite $ARGUMENTS)',
      ],
    ],
    ['partially-malformed-directive.md', ['body: linea 4 directiva mefisto mal formada']],
  ]

  for (const [name, expected] of EXACT) {
    test(`${name} conserva su diagnostico exacto`, () => {
      assert.deepEqual(validate(join(CONTRACT, 'fixtures', 'invalid', name)), {
        status: 1,
        output: expected.map((line) => `${INVALID}/${name}: ${line}\n`).join(''),
      })
    })
  }

  test('ningun fixture invalido queda sin expectativa', () => {
    const covered = new Set([...REJECTED, ...EXACT].map(([name]) => name))
    const fixtures = readdirSync(join(CONTRACT, 'fixtures', 'invalid')).filter((name) => name.endsWith('.md'))
    assert.deepEqual(
      fixtures.filter((name) => !covered.has(name)),
      [],
    )
  })

  test('skill-root.md conserva exclusivamente el id logico', () => {
    const source = readFileSync(join(CONTRACT, 'fixtures', 'valid', 'skill-root.md'), 'utf8')
    assert.doesNotMatch(source, /Claude|mefisto-projections|MEFISTO_PACKAGE_ROOT|\.claude/)
  })

  test('sin argumentos, todas las fuentes publicadas validan', () => {
    assert.deepEqual(validate(), { status: 0, output: '' })
  })

  test('un archivo ausente, sin frontmatter o sin cierre se diagnostica por su ruta', () => {
    const put = (name: string, content: string): string => {
      const path = join(work, name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      return path
    }
    const missing = join(work, 'no-existe.md')
    const plain = put('sin-frontmatter.md', 'hola\n')
    const open = put('sin-cierre.md', '---\n{}\n')
    const blank = put('vacio.md', '---\n---\ncuerpo\n')
    const several = put('varios.md', '---\n{} {}\n---\ncuerpo\n')
    assert.deepEqual(validate(missing, plain, open, blank, several), {
      status: 1,
      output: [
        `${missing}: archivo: no existe o no es un archivo regular`,
        `${plain}: frontmatter: ausente (se esperaba un bloque '---' JSON al inicio del archivo)`,
        `${open}: frontmatter: sin delimitador de cierre`,
        `${blank}: frontmatter: bloque vacio (se esperaba un objeto JSON)`,
        `${several}: schema: el validador jq fallo: jq: invalid JSON text passed to --argjson`,
        '',
      ].join('\n'),
    })
  })

  test('sin el schema del contrato aborta antes de validar', () => {
    const empty = join(work, 'repo-sin-contrato')
    const schema = join(empty, 'src', 'published', 'contract', 'published-artifact.schema.json')
    assert.deepEqual(validatePublishedArtifacts([], empty), {
      status: 1,
      stdout: '',
      stderr: `ERROR: no existe '${schema}'\n`,
    })
  })
})

describe('subconjunto de JSON Schema', () => {
  test('$ acepta el fin del texto o su salto final, como en jq', () => {
    const id = jqRegExp('^[a-z]+$')
    assert.deepEqual(
      ['abc', 'abc\n', 'abc\n\n', 'abc\nx', 'x\nabc'].map((text) => id.test(text)),
      [true, true, false, false, false],
    )
    assert.equal(jqRegExp('^[$]$').test('$'), true)
  })

  test('index busca un elemento, o una subsecuencia si recibe un arreglo', () => {
    assert.equal(indexOf(['a', 'b'], 'b'), 1)
    assert.equal(indexOf(['a', 'b'], 'c'), null)
    assert.equal(indexOf([null, 'b'], null), 0)
    assert.equal(indexOf(['a', 'b'], ['b']), 1)
    assert.equal(indexOf(['a', 'b'], []), null)
  })

  test('los errores salen en el orden del validador original', () => {
    const schema = {
      type: 'object',
      required: ['a', 'b'],
      additionalProperties: false,
      properties: {
        a: { type: 'string', minLength: 2, pattern: '^x', enum: ['xx', 'xy'] },
        c: { type: 'array', minItems: 2, uniqueItems: true, items: { type: ['string', 'null'] } },
      },
    }
    assert.deepEqual(validateSchema(schema, { a: 'y', c: [1, 1], z: true }), [
      'b: campo requerido ausente',
      'z: propiedad adicional no permitida',
      'a: valor "y" no esta en el vocabulario permitido ["xx","xy"]',
      'a: longitud minima 2, encontrado 1',
      "a: 'y' no coincide con el patron ^x",
      'c.0: tipo esperado ["string","null"], encontrado number',
      'c.1: tipo esperado ["string","null"], encontrado number',
      'c: elementos duplicados no permitidos',
    ])
    assert.deepEqual(validateSchema(schema, []), [': tipo esperado "object", encontrado array'])
  })
})

describe('registro MCP y proyeccion Claude', () => {
  const mcp = (...args: string[]): { status: number; text: string } => {
    const result = validateMcp(args, REPO_ROOT)
    return { status: result.status, text: result.errors.join('\n') }
  }
  const fixture = (kind: string, name: string): string => join(MCP_FIXTURES, kind, name)

  test('el registro publicado y el fixture valido validan', () => {
    assert.deepEqual(mcp(), { status: 0, text: '' })
    assert.deepEqual(mcp('--registry', fixture('valid', 'mcp-servers.json')), { status: 0, text: '' })
  })

  const REGISTRIES: [string, string][] = [
    ['bundled-without-url.json', 'bundled exige'],
    ['bundled-without-authentication.json', 'bundled exige'],
    ['external-with-connection.json', 'external exige'],
    ['sensitive-key.json', 'headers: propiedad adicional'],
    ['duplicate-id.json', 'ids duplicados'],
    ['out-of-order-ids.json', 'ids fuera de orden'],
    ['empty-servers.json', 'cantidad minima de elementos'],
    ['non-kebab-id.json', "id: 'Microsoft_Learn' no coincide"],
  ]

  for (const [name, expected] of REGISTRIES) {
    test(`rechaza el registro ${name}: ${expected}`, () => {
      const result = mcp('--registry', fixture('invalid', name))
      assert.equal(result.status, 1)
      assert.ok(result.text.includes(expected), result.text)
    })
  }

  const SCHEMAS: [string, string][] = [
    ['artifact-schema-divergent.json', 'enum mcp para agent difiere en orden'],
    ['artifact-schema-duplicate-enum.json', 'enum mcp para agent contiene ids duplicados'],
    ['artifact-schema-unknown-id.json', 'enum mcp para agent contiene id desconocido: servidor-ajeno'],
    ['artifact-schema-missing-id.json', 'enum mcp para agent omite id del registro: terraform'],
  ]

  for (const [name, expected] of SCHEMAS) {
    test(`detecta ${name}: ${expected}`, () => {
      const result = mcp('--artifact-schema', fixture('invalid', name))
      assert.equal(result.status, 1)
      assert.ok(result.text.includes(expected), result.text)
    })
  }

  test('detecta un .mcp.json divergente y compara estructura, no orden de claves', () => {
    const divergent = mcp('--claude-config', fixture('invalid', 'claude-config-divergent.json'))
    assert.equal(divergent.status, 1)
    assert.ok(divergent.text.includes('difiere de la proyeccion Claude'), divergent.text)
    assert.deepEqual(mcp('--claude-config', fixture('valid', 'claude-config-reordered.json')), {
      status: 0,
      text: '',
    })
  })

  test('argumentos invalidos terminan en 2 y un archivo ausente en 1', () => {
    assert.deepEqual(mcp('--registry'), { status: 2, text: 'ERROR: falta el archivo para --registry' })
    assert.deepEqual(mcp('--otra'), {
      status: 2,
      text: 'Uso: validate-published-mcp.sh [--registry archivo] [--artifact-schema archivo] [--claude-config archivo]',
    })
    const missing = join(work, 'no-existe.json')
    assert.deepEqual(mcp('--registry', missing), { status: 1, text: `ERROR: no existe '${missing}'` })
  })
})
