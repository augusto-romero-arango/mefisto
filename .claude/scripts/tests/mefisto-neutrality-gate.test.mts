import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CliError, capture } from '../../../scripts/lib/cli.mts'
import { git, isolateGitConfig, writeFiles } from '../../../scripts/tests/field-note-sandbox.mts'
import { globToRegExp, runGate } from '../../../src/internal/scripts/mefisto-neutrality-gate.mts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GATE = join(REPO_ROOT, 'src', 'internal', 'scripts', 'mefisto-neutrality-gate.mts')
const ALLOWLIST = 'src/internal/contract/neutrality-allowlist.json'
const EMPTY_ALLOWLIST = '{"scope_excluded": [], "exceptions": [], "not_migrated": []}'

const GENERIC_SHIM = `#!/usr/bin/env bash
# Shim de compatibilidad (MEF-ADR-0049): la implementacion canonica vive en src/internal/scripts/. No editar.
exec "$(cd "$(dirname "$0")/../.." && pwd)/src/internal/scripts/$(basename "$0")" "$@"
`
const COMMON_SHIM = `#!/usr/bin/env bash
# Shim de compatibilidad (MEF-ADR-0049): la implementacion canonica vive en src/internal/scripts/lib/_mefisto-common.sh. No editar.
# \`source\` (no \`exec\`): esta lib se sourcea desde otros scripts, nunca se ejecuta sola.
source "$(cd "$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)/src/internal/scripts/lib/_mefisto-common.sh"
`

// Generadores simulados: el gate lanza el `.mts` del arbol que escanea.
const INTERNAL_GENERATOR = 'src/internal/scripts/generate-internal-adapters.mts'
const PUBLISHED_GENERATOR = 'src/published/scripts/generate-published-adapters.mts'
const CLEAN_GENERATOR = 'process.exit(0)\n'
const dirtyGenerator = (line: string): string =>
  `if (process.argv[2] === '--check') {\n  console.log(${JSON.stringify(line)})\n  process.exit(1)\n}\n`

let work = ''
let restoreGit = (): void => {}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto-gate-'))
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true })
})

/** Repo git con `files` en el indice: `git ls-files` no exige un commit. */
function newTree(name: string, allowlist: string, files: Record<string, string>): string {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  writeFiles(dir, { [ALLOWLIST]: allowlist, ...files })
  git(dir, 'add', '-A')
  return dir
}

// Con la allowlist del propio arbol: el gate no la toma de --root.
function gate(dir: string): string[] {
  return runGate(['--root', dir, '--allowlist', join(dir, ALLOWLIST)]).violations
}

describe('arbol sin fugas', () => {
  test('shims conformes, excepcion de la allowlist y prosa que no es invocacion: sin violaciones', () => {
    const dir = newTree(
      'clean',
      JSON.stringify({
        scope_excluded: [],
        exceptions: [
          {
            path: 'src/internal/scripts/lib/fx-allowed-model.sh',
            rules: ['R1'],
            motivo: 'Fixture: archivo permitido a nombrar el alias sonnet a proposito.',
          },
          {
            path: ALLOWLIST,
            rules: ['ALL'],
            motivo: "Fixture: este mismo archivo cita 'sonnet' en el motivo de arriba.",
          },
        ],
        not_migrated: [
          { path: '.claude/scripts/fx-not-migrated.sh', motivo: 'Fixture: script no migrado.', issue: null },
        ],
      }),
      {
        'src/internal/scripts/lib/fx-allowed-model.sh':
          '#!/usr/bin/env bash\n# menciona el modelo sonnet a proposito (cubierto por la excepcion)\necho ok\n',
        'src/internal/scripts/lib/fx-clean.sh':
          '#!/usr/bin/env bash\n# el claude runtime lo resuelve el runner neutral: esto es prosa, no una invocacion\necho ok\n',
        'src/internal/scripts/lib/fx-plugin-manifest.sh':
          '#!/usr/bin/env bash\n# lee .claude-plugin/plugin.json (manifiesto fisico del plugin, no un id de modelo)\necho ok\n',
        'AGENTS.md': 'doctrina neutral de ejemplo, sin fugas.\n',
        '.claude/scripts/fx-shim.sh': GENERIC_SHIM,
        '.claude/scripts/_mefisto-common.sh': COMMON_SHIM,
        '.claude/scripts/fx-not-migrated.sh': '#!/usr/bin/env bash\necho "no soy un shim, pero estoy en not_migrated"\n',
        [INTERNAL_GENERATOR]: CLEAN_GENERATOR,
      },
    )
    assert.deepEqual(gate(dir), [])

    const cli = capture(process.execPath, [GATE, '--root', dir, '--allowlist', join(dir, ALLOWLIST)])
    assert.equal(cli.status, 0)
    assert.equal(cli.stdout + cli.stderr, '')
  })
})

describe('reglas de texto', () => {
  test('R1: alias de modelo e id de una familia no enumerada', () => {
    const dir = newTree('r1-neg', EMPTY_ALLOWLIST, {
      [INTERNAL_GENERATOR]: CLEAN_GENERATOR,
      'src/internal/scripts/lib/fx-model-leak.sh': '#!/usr/bin/env bash\n# usa el modelo sonnet para esta tarea\necho ok\n',
      'src/internal/scripts/lib/fx-model-id-leak.sh':
        '#!/usr/bin/env bash\n# id de una familia que R1 no enumera: claude-nova-9\necho ok\n',
    })
    assert.deepEqual(gate(dir), [
      'src/internal/scripts/lib/fx-model-id-leak.sh:2: R1',
      'src/internal/scripts/lib/fx-model-leak.sh:2: R1',
    ])

    const cli = capture(process.execPath, [GATE, '--root', dir, '--allowlist', join(dir, ALLOWLIST)])
    assert.equal(cli.status, 1)
    assert.equal(
      cli.stdout,
      'src/internal/scripts/lib/fx-model-id-leak.sh:2: R1\nsrc/internal/scripts/lib/fx-model-leak.sh:2: R1\n',
    )
  })

  test('R1: cada forma vetada, con sus bordes', () => {
    const lines = [
      'x="opus"',
      'no-opus-no',
      'gpt-4o',
      'openai/x anthropic/y',
      '{"model": "x"}',
      '"model"\t :',
      '["Readx","Skill"]',
      '"permission"',
      'fable\r',
      '.claude-plugin no cuenta',
      'modelo',
    ]
    const dir = newTree('r1-formas', EMPTY_ALLOWLIST, {
      // Fuera de src/internal/** R1 no aplica.
      '.claude/fx-fuera.md': 'sonnet\n',
      'src/internal/fx-formas.txt': `${lines.join('\n')}\nultima sin salto haiku`,
    })
    assert.deepEqual(
      gate(dir),
      [1, 3, 4, 5, 6, 7, 8, 9, 12].map((line) => `src/internal/fx-formas.txt:${line}: R1`),
    )
  })

  test('R2: invocacion directa del CLI, en todo el universo', () => {
    const dir = newTree('r2-neg', EMPTY_ALLOWLIST, {
      [INTERNAL_GENERATOR]: CLEAN_GENERATOR,
      'src/internal/scripts/fx-r2-leak.sh':
        '#!/usr/bin/env bash\n# invoca claude -p directo, sin pasar por el runner neutral\n# claude -px no cuenta\necho ok\n',
      '.claude/fx-top.md': 'claude --agent x\n',
    })
    assert.deepEqual(gate(dir), ['.claude/fx-top.md:1: R2', 'src/internal/scripts/fx-r2-leak.sh:2: R2'])
  })

  test('R3: variable o ruta de un runtime concreto', () => {
    const dir = newTree('r3-neg', EMPTY_ALLOWLIST, {
      [INTERNAL_GENERATOR]: CLEAN_GENERATOR,
      'src/internal/scripts/fx-r3-leak.sh':
        '#!/usr/bin/env bash\n# resuelve la ruta via CLAUDE_PROJECT_DIR (prohibido)\necho ok\n',
      '.claude/scripts/tests/fx.txt': '.claude/pipeline\n',
      // Fuera de src/internal/** y de .claude/scripts/ R3 no aplica.
      '.claude/fx-fuera.md': 'CLAUDE_PLUGIN_ROOT\n',
    })
    assert.deepEqual(gate(dir), ['.claude/scripts/tests/fx.txt:1: R3', 'src/internal/scripts/fx-r3-leak.sh:2: R3'])
  })

  test('un archivo binario o borrado del working tree no se escanea', () => {
    const dir = newTree('binario', EMPTY_ALLOWLIST, {
      'src/internal/fx-binario.dat': 'bin\u0000 sonnet\n',
      'src/internal/fx-borrado.sh': 'opus\n',
    })
    rmSync(join(dir, 'src', 'internal', 'fx-borrado.sh'))
    assert.deepEqual(gate(dir), [])
  })
})

describe('R4: conformidad de los shims de .claude/scripts', () => {
  test('un script que no es shim y un shim con un salto de mas', () => {
    const dir = newTree('r4-neg', EMPTY_ALLOWLIST, {
      [INTERNAL_GENERATOR]: CLEAN_GENERATOR,
      '.claude/scripts/fx-bad-shim.sh': '#!/usr/bin/env bash\necho "no soy un shim conforme"\n',
      '.claude/scripts/fx-trailing-shim.sh': `${GENERIC_SHIM}\n`,
      '.claude/scripts/fx-ok.sh': GENERIC_SHIM,
      // Solo el nivel superior: los tests no son shims.
      '.claude/scripts/tests/fx-test.sh': '#!/usr/bin/env bash\necho test\n',
    })
    assert.deepEqual(gate(dir), ['.claude/scripts/fx-bad-shim.sh:1: R4', '.claude/scripts/fx-trailing-shim.sh:1: R4'])
  })

  test('los shims reales del repo cumplen la plantilla', () => {
    const scripts = join(REPO_ROOT, '.claude', 'scripts')
    const shims = readdirSync(scripts).filter((name) => name.endsWith('.sh'))
    assert.ok(shims.includes('_mefisto-common.sh') && shims.length > 1)
    for (const name of shims) {
      const expected = name === '_mefisto-common.sh' ? COMMON_SHIM : GENERIC_SHIM
      assert.equal(readFileSync(join(scripts, name), 'utf8'), expected, name)
    }
  })
})

describe('verificaciones estructurales', () => {
  test('adapters-check reemite cada divergencia del generador interno', () => {
    const dir = newTree('adapters-check-neg', EMPTY_ALLOWLIST, {
      [INTERNAL_GENERATOR]: dirtyGenerator('.claude/agents/fx-agent.md: distinta'),
    })
    assert.deepEqual(gate(dir), ['.claude/agents/fx-agent.md: distinta: adapters-check'])
  })

  test('published-adapters-check reemite cada divergencia del generador publicado', () => {
    const dir = newTree('published-adapters-check-neg', EMPTY_ALLOWLIST, {
      [INTERNAL_GENERATOR]: CLEAN_GENERATOR,
      [PUBLISHED_GENERATOR]: dirtyGenerator('dist/claude/agents/fx-agent.md: distinta'),
    })
    assert.deepEqual(gate(dir), ['dist/claude/agents/fx-agent.md: distinta: published-adapters-check'])
  })

  test('un exit distinto de 0 sin lineas produce la violacion generica y deja pasar el stderr', () => {
    const dir = newTree('published-adapters-check-no-lines', EMPTY_ALLOWLIST, {
      [INTERNAL_GENERATOR]: CLEAN_GENERATOR,
      [PUBLISHED_GENERATOR]:
        "if (process.argv[2] === '--check') {\n  console.error('ERROR: fallo previo')\n  process.exit(3)\n}\n",
    })
    const result = runGate(['--root', dir, '--allowlist', join(dir, ALLOWLIST)])
    assert.deepEqual(result.violations, [
      'src/published/scripts/generate-published-adapters.sh: exit 3 sin lineas de divergencia: published-adapters-check',
    ])
    assert.equal(result.stderr, 'ERROR: fallo previo\n')
  })

  test(
    'un generador que solo existe como .sh se lanza con bash',
    { skip: process.platform === 'win32' ? 'necesita bash' : false },
    () => {
      const dir = newTree('adapters-check-bash', EMPTY_ALLOWLIST, {
        'src/internal/scripts/generate-internal-adapters.sh':
          '#!/usr/bin/env bash\nif [ "${1:-}" = "--check" ]; then\n    echo ".claude/agents/fx-agent.md: distinta"\n    exit 1\nfi\nexit 0\n',
      })
      assert.deepEqual(gate(dir), ['.claude/agents/fx-agent.md: distinta: adapters-check'])
    },
  )
})

describe('allowlist', () => {
  test('una entrada sin motivo aborta antes de escanear', () => {
    const dir = newTree(
      'bad-allowlist',
      JSON.stringify({
        scope_excluded: [],
        exceptions: [{ path: 'src/internal/scripts/lib/whatever.sh', rules: ['R1'] }],
        not_migrated: [],
      }),
      { [INTERNAL_GENERATOR]: CLEAN_GENERATOR },
    )
    const file = join(dir, ALLOWLIST)
    assert.throws(
      () => runGate(['--root', dir, '--allowlist', file]),
      new CliError(`ERROR: '${file}' tiene al menos una entrada sin 'motivo' no vacio (CA-1)`),
    )
  })

  test('una allowlist que no es JSON o no existe aborta', () => {
    const dir = newTree('allowlist-rota', '{ no es json', {})
    const file = join(dir, ALLOWLIST)
    assert.throws(
      () => runGate(['--root', dir, '--allowlist', file]),
      new CliError(`ERROR: '${file}' no es JSON valido`),
    )
    const missing = join(dir, 'no-existe.json')
    assert.throws(
      () => runGate(['--root', dir, '--allowlist', missing]),
      new CliError(`ERROR: no existe la allowlist '${missing}'`),
    )
  })

  // MEF-ADR-0019 seccion E: un PR no puede exonerarse desde su propio worktree.
  test('se carga desde el gate y nunca desde --root', () => {
    const dir = newTree(
      'allowlist-origin',
      JSON.stringify({
        scope_excluded: [],
        exceptions: [
          {
            path: 'src/internal/scripts/lib/fx-self-exempt.sh',
            rules: ['ALL'],
            motivo: 'Fixture: un PR que intenta exonerarse a si mismo desde su propio worktree.',
          },
        ],
        not_migrated: [],
      }),
      {
        [INTERNAL_GENERATOR]: CLEAN_GENERATOR,
        'src/internal/scripts/lib/fx-self-exempt.sh':
          '#!/usr/bin/env bash\n# usa el modelo sonnet para esta tarea\necho ok\n',
      },
    )
    assert.deepEqual(gate(dir), [])
    assert.deepEqual(runGate(['--root', dir]).violations, ['src/internal/scripts/lib/fx-self-exempt.sh:2: R1'])
  })

  test('los patrones siguen la sintaxis de `case`: `*` cruza directorios', () => {
    assert.ok(globToRegExp('.claude/agents/**').test('.claude/agents/sub/x.md'))
    assert.ok(globToRegExp('hooks/*.ts').test('hooks/sub/x.ts'))
    assert.ok(globToRegExp('a/?.[ch]').test('a/x.c'))
    assert.equal(globToRegExp('a/?.[!ch]').test('a/x.c'), false)
    assert.equal(globToRegExp('AGENTS.md').test('AGENTSxmd'), false)
    assert.equal(globToRegExp('src/internal/x.sh').test('src/internal/x.sh.bak'), false)
  })
})

describe('argumentos', () => {
  test('errores de invocacion', () => {
    assert.throws(() => runGate(['--root']), new CliError('ERROR: --root requiere un directorio'))
    assert.throws(() => runGate(['--allowlist']), new CliError('ERROR: --allowlist requiere un archivo'))
    assert.throws(
      () => runGate(['--otro']),
      new CliError(
        'ERROR: argumento desconocido: --otro (uso: mefisto-neutrality-gate.sh [--root <dir>] [--allowlist <file>])',
      ),
    )
    const missing = join(work, 'no-existe')
    assert.throws(
      () => runGate(['--root', missing]),
      new CliError(`ERROR: --root '${missing}' no existe o no es un directorio`),
    )
  })

  test('un --root que no es un repositorio git aborta', () => {
    // Fuera de `work`: su ancestro no puede ser un repo.
    const plain = mkdtempSync(join(tmpdir(), 'mefisto-gate-sin-git-'))
    try {
      assert.throws(
        () => runGate(['--root', plain]),
        new CliError(
          `ERROR: --root '${plain}' no es un repositorio git (el universo de archivos sale de git ls-files)`,
        ),
      )
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  test('el .mts traduce el error a stderr y exit 1', () => {
    const cli = capture(process.execPath, [GATE, '--root'])
    assert.equal(cli.status, 1)
    assert.equal(cli.stderr, 'ERROR: --root requiere un directorio\n')
  })
})

describe('repo real', () => {
  // Detecta regresiones grandes, no rendimiento fino: las dos verificaciones estructurales
  // lanzan un generador completo cada una y dominan el reloj.
  const limit = Number(process.env.MEFISTO_NEUTRALITY_PERF_LIMIT ?? '60')

  test(
    `una corrida completa termina en menos de ${limit}s`,
    { skip: process.platform === 'win32' ? 'el generador publicado aun es bash' : false },
    () => {
      const start = Date.now()
      runGate([])
      const elapsed = (Date.now() - start) / 1000
      assert.ok(elapsed < limit, `tardo ${elapsed}s`)
    },
  )
})

describe('universo de archivos', () => {
  test('un archivo sin versionar no se escanea; de uno versionado se lee el working tree', () => {
    const dir = newTree('indice', EMPTY_ALLOWLIST, { 'src/internal/fx.txt': 'limpio\n' })
    writeFileSync(join(dir, 'src', 'internal', 'fx-sin-anadir.txt'), 'sonnet\n')
    assert.deepEqual(gate(dir), [])
    writeFileSync(join(dir, 'src', 'internal', 'fx.txt'), 'sonnet\n')
    assert.deepEqual(gate(dir), ['src/internal/fx.txt:1: R1'])
  })
})
