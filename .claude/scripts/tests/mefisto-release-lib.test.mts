import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { writeFiles } from '../../../scripts/tests/field-note-sandbox.mts'
import {
  consolidateAdrIndexFragments,
  consolidateChangelogFragments,
  neutralityRemedy,
} from '../../../src/internal/scripts/lib/mefisto-release-lib.mts'

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.1.0] - 2026-01-01

### Added

- inicial
`
const ADR_INDEX = `### Indice tematico

| Tema | ADR |
|---|---|
| Topics de Service Bus por evento | MEF-ADR-0001 |
| Estrategia de testing con event sourcing (Given/When/Then) | MEF-ADR-0002 |

## Convenciones del marco
`

let work = ''
let count = 0

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto release lib '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = join(work, `caso-${++count}`)
  writeFiles(root, files)
  return root
}

function read(root: string, file: string): string {
  return readFileSync(join(root, ...file.split('/')), 'utf8')
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files[path.slice(root.length + 1).replaceAll('\\', '/')] = readFileSync(path, 'utf8')
  }
  return files
}

describe('consolidateChangelogFragments', () => {
  test('agrupa por categoria, borra los fragmentos consumidos y deja el resto', () => {
    const root = tree({
      'CHANGELOG.md': CHANGELOG,
      'changelog.d/380.added.md': '- Se anade el mecanismo de fragmentos de CHANGELOG.\n',
      'changelog.d/381.fixed.md': '- Se corrige un bug menor.\n',
      'changelog.d/380.adr-index.md': '| Doctrina X | MEF-ADR-0036 |\n',
      'changelog.d/README.md': '# doc del mecanismo\n',
    })
    assert.equal(consolidateChangelogFragments(root), null)
    assert.equal(
      read(root, 'CHANGELOG.md'),
      `# Changelog

## [Unreleased]

### Added

- Se anade el mecanismo de fragmentos de CHANGELOG.

### Fixed

- Se corrige un bug menor.

## [0.1.0] - 2026-01-01

### Added

- inicial
`,
    )
    assert.deepEqual(readdirSync(join(root, 'changelog.d')).sort(), ['380.adr-index.md', 'README.md'])
  })

  test('un fragmento con nombre invalido aborta sin modificar nada', () => {
    const root = tree({ 'CHANGELOG.md': CHANGELOG, 'changelog.d/sin-numero.added.md': '- oops\n' })
    assert.equal(
      consolidateChangelogFragments(root),
      'ERROR: fragmento de changelog con nombre invalido: sin-numero.added.md',
    )
    assert.equal(read(root, 'CHANGELOG.md'), CHANGELOG)
    assert.ok(existsSync(join(root, 'changelog.d', 'sin-numero.added.md')))
  })

  test('una categoria desconocida tambien es un nombre invalido', () => {
    const root = tree({
      'CHANGELOG.md': CHANGELOG,
      'changelog.d/1.added.md': '- valido\n',
      'changelog.d/2.security.md': '- oops\n',
    })
    assert.equal(
      consolidateChangelogFragments(root),
      'ERROR: fragmento de changelog con nombre invalido: 2.security.md',
    )
    assert.equal(read(root, 'CHANGELOG.md'), CHANGELOG)
    assert.ok(existsSync(join(root, 'changelog.d', '1.added.md')))
  })

  test('sin changelog.d/ o sin fragmentos no hace nada', () => {
    const without = tree({ 'CHANGELOG.md': CHANGELOG })
    assert.equal(consolidateChangelogFragments(without), null)
    assert.equal(read(without, 'CHANGELOG.md'), CHANGELOG)

    const onlyReadme = tree({ 'CHANGELOG.md': CHANGELOG, 'changelog.d/README.md': '# doc\n' })
    assert.equal(consolidateChangelogFragments(onlyReadme), null)
    assert.equal(read(onlyReadme, 'CHANGELOG.md'), CHANGELOG)
  })

  test('conserva el preambulo suelto y las entradas previas de [Unreleased]', () => {
    const root = tree({
      'CHANGELOG.md': `# Changelog

## [Unreleased]

Nota manual suelta, sin subseccion.

### Added

- entrada previa

## [0.1.0] - 2026-01-01
`,
      'changelog.d/380.added.md': '- entrada del fragmento\n',
      'changelog.d/381.removed.md': '- se quita algo\n',
      'changelog.d/382.changed.md': '\n',
    })
    assert.equal(consolidateChangelogFragments(root), null)
    assert.equal(
      read(root, 'CHANGELOG.md'),
      `# Changelog

## [Unreleased]

Nota manual suelta, sin subseccion.

### Added

- entrada previa
- entrada del fragmento

### Removed

- se quita algo

## [0.1.0] - 2026-01-01
`,
    )
    assert.deepEqual(readdirSync(join(root, 'changelog.d')), [])
  })

  test('sin seccion [Unreleased] aborta sin borrar los fragmentos', () => {
    const root = tree({ 'CHANGELOG.md': '# Changelog\n', 'changelog.d/1.added.md': '- x\n' })
    assert.equal(consolidateChangelogFragments(root), 'ERROR: no se encontro la seccion [Unreleased]')
    assert.ok(existsSync(join(root, 'changelog.d', '1.added.md')))
  })
})

describe('consolidateAdrIndexFragments', () => {
  test('anexa las filas al final de la tabla, en orden de nombre de archivo', () => {
    const root = tree({
      'docs/adr/INDICE-TEMATICO.md': ADR_INDEX,
      'changelog.d/377.adr-index.md': '| Doctrina B | MEF-ADR-0037 |\n',
      'changelog.d/376.adr-index.md': '| Doctrina A | MEF-ADR-0036 |\n\n| Doctrina A2 | MEF-ADR-0036 |\n',
      'changelog.d/376.added.md': '- no es del indice\n',
    })
    assert.equal(consolidateAdrIndexFragments(root), null)
    assert.equal(
      read(root, 'docs/adr/INDICE-TEMATICO.md'),
      ADR_INDEX.replace(
        '\n\n## Convenciones',
        '\n| Doctrina A | MEF-ADR-0036 |\n| Doctrina A2 | MEF-ADR-0036 |\n| Doctrina B | MEF-ADR-0037 |\n\n## Convenciones',
      ),
    )
    assert.deepEqual(readdirSync(join(root, 'changelog.d')), ['376.added.md'])
  })

  test('sin fragmentos del indice deja el archivo intacto', () => {
    const root = tree({ 'docs/adr/INDICE-TEMATICO.md': ADR_INDEX, 'changelog.d/1.added.md': '- x\n' })
    assert.equal(consolidateAdrIndexFragments(root), null)
    assert.equal(read(root, 'docs/adr/INDICE-TEMATICO.md'), ADR_INDEX)
    assert.equal(consolidateAdrIndexFragments(tree({ 'docs/adr/INDICE-TEMATICO.md': ADR_INDEX })), null)
  })

  test('sin la tabla del indice aborta sin borrar los fragmentos', () => {
    const root = tree({
      'docs/adr/INDICE-TEMATICO.md': '# Indice\n',
      'changelog.d/1.adr-index.md': '| Doctrina A | MEF-ADR-0036 |\n',
    })
    assert.equal(
      consolidateAdrIndexFragments(root),
      'ERROR: no se encontro la tabla de indice de ADRs en docs/adr/INDICE-TEMATICO.md',
    )
    assert.ok(existsSync(join(root, 'changelog.d', '1.adr-index.md')))
  })
})

describe('neutralityRemedy', () => {
  const lines = (output: string): string[] => (output.length === 0 ? [] : output.split('\n'))

  test('una sola violacion produce exactamente una linea con el prefijo de su regla', () => {
    const remedy = lines(neutralityRemedy('src/internal/agents/fx-leak.md:3: R1'))
    assert.equal(remedy.length, 1)
    assert.ok(remedy[0]?.startsWith('R1: '))
  })

  test('reglas mezcladas y desordenadas salen deduplicadas y en orden fijo', () => {
    const remedy = lines(
      neutralityRemedy(
        [
          'src/internal/scripts/generate-internal-adapters.sh: exit 1 sin lineas de divergencia: adapters-check',
          'src/internal/agents/b.md:9: R3',
          'dist/claude/agents/fx-agent.md: distinta: published-adapters-check',
          'src/internal/agents/a.md:5: R1',
          '.claude/scripts/mefisto-x.sh:1: R4',
          'src/internal/agents/a2.md:6: R1',
          'src/internal/scripts/foo.sh:2: R2',
          'src/internal/agents/b2.md:10: R3',
        ].join('\n'),
      ),
    )
    assert.deepEqual(
      remedy.map((line) => line.split(' ')[0]),
      ['R1:', 'R2:', 'R3:', 'R4:', 'adapters-check:', 'published-adapters-check:'],
    )
  })

  test('R4 tiene su propio remedio, distinto del de las reglas de texto', () => {
    const remedy = neutralityRemedy('.claude/scripts/mefisto-x.sh:1: R4')
    assert.ok(remedy.includes('not_migrated'))
    assert.equal(remedy.includes('reformula la mencion'), false)
  })

  test('las dos formas de cada verificacion estructural dan la misma linea', () => {
    const adapters = neutralityRemedy('.claude/agents/fx-agent.md: distinta: adapters-check')
    assert.equal(
      neutralityRemedy(
        'src/internal/scripts/generate-internal-adapters.sh: exit 2 sin lineas de divergencia: adapters-check',
      ),
      adapters,
    )
    assert.ok(adapters.includes('--check'))

    const published = neutralityRemedy('dist/claude/agents/fx-agent.md: distinta: published-adapters-check')
    assert.equal(
      neutralityRemedy(
        'src/published/scripts/generate-published-adapters.sh: exit 2 sin lineas de divergencia: published-adapters-check',
      ),
      published,
    )
    assert.ok(published.includes('--check'))
    assert.notEqual(published, adapters)
  })

  test('una regla no reconocida produce una linea generica propia', () => {
    const unknown = lines(neutralityRemedy('src/internal/foo.md:1: R99'))
    assert.equal(unknown.length, 1)
    assert.ok(unknown[0]?.startsWith('R99: '))
    assert.ok(unknown[0]?.includes('mefisto-neutrality-gate.mts'))
    assert.equal(lines(neutralityRemedy('a.md:1: R1\nb.md:2: R99\nc.md:3: R99')).length, 2)
  })

  test('una linea sin regla reconocible tambien recibe la linea generica, una vez por texto', () => {
    const output = 'a.md:1: R99\nb.md:2: R1\nc.md:3: R99\nsin separador\n\nd.md:4: otra regla'
    assert.deepEqual(
      lines(neutralityRemedy(output)).map((line) => line.slice(0, line.indexOf(':'))),
      ['R1', 'R99', 'sin separador', 'otra regla'],
    )
  })

  test('una entrada vacia no emite nada', () => {
    assert.equal(neutralityRemedy(''), '')
  })
})

test('consolidacion con fragmentos de todas las categorias, bloques de codigo y fragmentos vacios', () => {
  const root = tree({
    'CHANGELOG.md': CHANGELOG,
    'docs/adr/INDICE-TEMATICO.md': ADR_INDEX,
    'changelog.d/README.md': '# doc\n',
    'changelog.d/12.removed.md': '- se quita\n',
    'changelog.d/3.added.md': '- **Titulo**: detalle\n  - sublinea\n\n  ```bash\n- no es entrada\n  ```\n',
    'changelog.d/4.added.md': '\n\n- con blancos alrededor\n\n',
    'changelog.d/5.fixed.md': '- arreglo\n',
    'changelog.d/6.changed.md': '',
    'changelog.d/3.adr-index.md': '| Tema A | MEF-ADR-0040 |\n\n| Tema B | MEF-ADR-0041 |\n',
    'changelog.d/7.adr-index.md': '\n',
  })
  assert.equal(consolidateChangelogFragments(root), null)
  assert.equal(consolidateAdrIndexFragments(root), null)
  assert.deepEqual(snapshot(root), {
    'CHANGELOG.md': `# Changelog

## [Unreleased]

### Added

- **Titulo**: detalle
  - sublinea

  \`\`\`bash
- no es entrada
  \`\`\`
- con blancos alrededor

### Fixed

- arreglo

### Removed

- se quita

## [0.1.0] - 2026-01-01

### Added

- inicial
`,
    'docs/adr/INDICE-TEMATICO.md': ADR_INDEX.replace(
      '| MEF-ADR-0002 |\n',
      '| MEF-ADR-0002 |\n| Tema A | MEF-ADR-0040 |\n| Tema B | MEF-ADR-0041 |\n',
    ),
    'changelog.d/README.md': '# doc\n',
  })
})
