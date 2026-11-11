import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { CommandResult } from '../lib/cli.mts'
import { deliver, validateYamlFile } from '../field-note.mts'
import {
  FakeGh,
  checkoutState,
  git,
  gitOk,
  isolateGitConfig,
  mutationsOf,
  newRepo,
  sandboxTools,
} from './field-note-sandbox.mts'
import type { RecordingTools, Sandbox, SandboxToolsOptions } from './field-note-sandbox.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SHIM = join(REPO_ROOT, 'scripts', 'field-note.sh')
const SLUG = 'acme/consumer-fake'
const TIMESTAMP = '2026-01-01-0000'
const NOTE_REL = `docs/bitacora/field-notes/${TIMESTAMP}-planner.md`
const GLOSSARY_REL = 'docs/ddd/ubiquitous-language.yaml'
const NOT_WINDOWS = process.platform === 'win32' ? 'el shim es bash' : false

let work = ''
let restoreGitConfig = (): void => {}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto field note '))
  restoreGitConfig = isolateGitConfig(work)
})

after(() => {
  restoreGitConfig()
  rmSync(work, { recursive: true, force: true })
})

// Un repo sin `.claude-plugin/plugin.json`: el guard lo trata como consumidor.
function consumerRepo(name: string): Sandbox {
  return newRepo(join(work, name), { 'README.md': 'consumidor de prueba\n' })
}

function writeLocal(name: string, file: string, content: string): string {
  const path = join(work, name, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function docBranch(session: string): string {
  return `docs/planner-field-notes-${session}`
}

// Validador de YAML simulado en el lugar de python3: da por invalido lo que contiene "[sin cerrar".
function fakePython(command: string, args: string[]): CommandResult | undefined {
  if (command !== 'python3') return undefined
  const file = args[2]
  const invalid = file !== undefined && readFileSync(file, 'utf8').includes('[sin cerrar')
  return { status: invalid ? 1 : 0, stdout: '', stderr: '' }
}

interface Run {
  code: number
  tools: RecordingTools
}

function run(sandbox: Sandbox, gh: FakeGh, args: string[], options: SandboxToolsOptions = {}): Run {
  const tools = sandboxTools(gh, { intercept: fakePython, ...options })
  return { code: deliver(args, { cwd: sandbox.main, tools }), tools }
}

function noteArgs(session: string, note: string): string[] {
  return ['--session-id', session, '--timestamp', TIMESTAMP, '--field-note', note]
}

describe('guard y argumentos', () => {
  test('dentro del repo de Mefisto aborta antes de mirar los argumentos', () => {
    const sandbox = newRepo(join(work, 'guard'), { '.claude-plugin/plugin.json': '{"name":"mefisto"}\n' })
    const { code, tools } = run(sandbox, new FakeGh(SLUG), ['--help'])
    assert.equal(code, 1)
    assert.equal(
      tools.stderr,
      'ERROR: scripts/field-note.sh es del plugin publicado y solo aplica al consumidor.\n' +
        'Mefisto entrega sus propias field notes con src/internal/scripts/mefisto-field-note.sh.\n',
    )
    assert.deepEqual(tools.commands, [])
  })

  test('fuera de un repo git aborta', () => {
    const outside = join(work, 'sin repo')
    mkdirSync(outside)
    const previous = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = work
    try {
      const tools = sandboxTools(new FakeGh(SLUG))
      assert.equal(deliver([], { cwd: outside, tools }), 1)
      assert.equal(tools.stderr, 'ERROR: no estas en un repositorio git\n')
    } finally {
      if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = previous
    }
  })

  test('sin los obligatorios, con un flag desconocido o con --help muestra el uso por stderr', () => {
    const sandbox = consumerRepo('uso')
    const gh = new FakeGh(SLUG)
    const missing = run(sandbox, gh, ['--session-id', 's'])
    assert.equal(missing.code, 1)
    assert.match(missing.tools.stderr, /^ERROR: --session-id, --timestamp y --field-note son obligatorios\nUso: field-note\.sh /)

    const unknown = run(sandbox, gh, ['--agent', 'x'])
    assert.equal(unknown.code, 1)
    assert.match(unknown.tools.stderr, /^ERROR: argumento desconocido '--agent'\nUso: field-note\.sh /)

    const help = run(sandbox, gh, ['--help'])
    assert.equal(help.code, 0)
    assert.match(help.tools.stderr, /^Uso: field-note\.sh .*rama por defecto del repo\.\n$/s)
    assert.equal(help.tools.stdout, '')
    assert.deepEqual(gh.calls, [])
  })

  test('rechaza un --session-id o un --timestamp mal formados, y una nota ausente o vacia, sin tocar git', () => {
    const sandbox = consumerRepo('forma')
    const gh = new FakeGh(SLUG)
    const note = writeLocal('forma', 'nota.md', 'contenido\n')
    const empty = writeLocal('forma', 'vacia.md', '\n\n')
    const cases: Array<[string[], RegExp]> = [
      [['--session-id', '../x', '--timestamp', TIMESTAMP, '--field-note', note], /--session-id '\.\.\/x' es invalido/],
      [['--session-id', 's', '--timestamp', '01-01-2026', '--field-note', note], /se espera el formato YYYY-MM-DD-HHMM/],
      [noteArgs('s', join(work, 'forma', 'no-existe.md')), /no existe o no es un archivo/],
      [noteArgs('s', empty), /vacia\.md' esta vacio/],
      [[...noteArgs('s', note), '--glossary', note], /--glossary y --glossary-path deben pasarse juntos/],
    ]
    for (const [args, message] of cases) {
      const { code, tools } = run(sandbox, gh, args)
      assert.equal(code, 1)
      assert.match(tools.stderr, message)
    }
    assert.deepEqual(gh.calls, [])
    assert.equal(git(sandbox.main, 'branch', '--list', 'docs/*'), '')
  })

  test('sin gh en el PATH aborta nombrandolo', () => {
    const sandbox = consumerRepo('sin-gh')
    const note = writeLocal('sin-gh', 'nota.md', 'contenido\n')
    const { code, tools } = run(sandbox, new FakeGh(SLUG), noteArgs('s', note), { missing: ['gh'] })
    assert.equal(code, 1)
    assert.equal(tools.stderr, "ERROR: 'gh' no esta disponible en PATH\n")
  })
})

describe('shim', () => {
  test('scripts/field-note.sh es el shim hacia field-note.mts', () => {
    assert.equal(
      readFileSync(SHIM, 'utf8').replaceAll('\r\n', '\n'),
      [
        '#!/usr/bin/env bash',
        '# Shim: la implementacion vive en field-note.mts (MEF-ADR-0057). No editar.',
        'exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/field-note.mts" "$@"',
        '',
      ].join('\n'),
    )
  })

  test('el shim reenvia argumentos y codigo de salida', { skip: NOT_WINDOWS }, () => {
    const result = spawnSync(SHIM, ['--help'], { cwd: REPO_ROOT, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /plugin publicado y solo aplica al consumidor/)
  })
})

describe('entrega', () => {
  test('primera entrega: un PR, la nota en la rama documental y el checkout principal intacto', () => {
    const sandbox = consumerRepo('a')
    const gh = new FakeGh(SLUG)
    const note = writeLocal('a', 'field-note.md', 'contenido de la field note A\n')
    const before = checkoutState(sandbox.main)

    const { code, tools } = run(sandbox, gh, noteArgs('sess-a', note))

    assert.equal(code, 0, tools.stderr)
    assert.equal(gh.prs.length, 1)
    assert.equal(git(sandbox.bare, 'show', `${docBranch('sess-a')}:${NOTE_REL}`), 'contenido de la field note A')
    assert.equal(gitOk(sandbox.bare, 'cat-file', '-e', `main:${NOTE_REL}`), false)
    assert.deepEqual(checkoutState(sandbox.main), before)
    assert.equal(git(sandbox.main, 'worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1)
    assert.deepEqual(mutationsOf(tools, git(sandbox.main, 'rev-parse', '--show-toplevel')), [])

    const commit = git(sandbox.bare, 'rev-parse', docBranch('sess-a'))
    assert.match(
      tools.stdout,
      new RegExp(
        `PR creado \\(no existia ninguno para '${docBranch('sess-a')}'\\)\n` +
          `Field note: ${NOTE_REL}\nRama: ${docBranch('sess-a')}\nCommit: ${commit}\n` +
          `PR: https://github.com/${SLUG}/pull/1\n$`,
      ),
    )
    assert.equal(git(sandbox.bare, 'log', '-1', '--format=%s', commit), 'docs(bitacora): agregar field note del planner')
    const [create] = gh.callsTo('pr create')
    assert.deepEqual(create?.slice(-2), ['--repo', SLUG])
    assert.equal(create?.[create.indexOf('--title') + 1], 'docs(bitacora): field notes del planner')
  })

  test('una ruta relativa de --field-note se resuelve contra la carpeta de invocacion', () => {
    const sandbox = consumerRepo('relativa')
    mkdirSync(join(sandbox.main, '.mefisto', 'pipeline'), { recursive: true })
    writeFileSync(join(sandbox.main, '.gitignore'), '.mefisto/\n')
    git(sandbox.main, 'add', '.gitignore')
    git(sandbox.main, 'commit', '-q', '-m', 'ignorar el estado')
    git(sandbox.main, 'push', '-q', 'origin', 'main')
    writeFileSync(join(sandbox.main, '.mefisto', 'pipeline', 'nota.md'), 'nota relativa\n\n\n')

    const { code, tools } = run(sandbox, new FakeGh(SLUG), noteArgs('sess-rel', '.mefisto/pipeline/nota.md'))

    assert.equal(code, 0, tools.stderr)
    const blob = git(sandbox.bare, 'cat-file', '-p', `${docBranch('sess-rel')}:${NOTE_REL}`)
    assert.equal(blob, 'nota relativa')
    assert.equal(git(sandbox.bare, 'cat-file', '-s', `${docBranch('sess-rel')}:${NOTE_REL}`), '14')
  })

  test('reintento tras fallar gh pr create: no duplica el PR ni el commit', () => {
    const sandbox = consumerRepo('b')
    const gh = new FakeGh(SLUG)
    gh.failing.set('pr create', 'once')
    const note = writeLocal('b', 'field-note.md', 'contenido de la field note B\n')

    const first = run(sandbox, gh, noteArgs('sess-b', note))
    assert.equal(first.code, 1)
    assert.match(first.tools.stderr, /ERROR: fallo en el paso 'creacion-pr' de la entrega de la field note \(sesion 'sess-b'\)/)
    assert.match(first.tools.stderr, /Ultimo checkpoint confirmado: push/)
    const commits = git(sandbox.bare, 'rev-list', '--count', docBranch('sess-b'))

    const second = run(sandbox, gh, noteArgs('sess-b', note))
    assert.equal(second.code, 0, second.tools.stderr)
    assert.match(second.tools.stdout, /Commit ya existente de esta sesion reutilizado/)
    assert.equal(gh.prs.length, 1)
    assert.equal(git(sandbox.bare, 'rev-list', '--count', docBranch('sess-b')), commits)
  })

  test('contenido distinto en el reintento actualiza el commit con amend', () => {
    const sandbox = consumerRepo('amend')
    const gh = new FakeGh(SLUG)
    const note = writeLocal('amend', 'field-note.md', 'primera version\n')
    assert.equal(run(sandbox, gh, noteArgs('sess-am', note)).code, 0)
    writeFileSync(note, 'segunda version\n')

    const second = run(sandbox, gh, noteArgs('sess-am', note))

    assert.equal(second.code, 0, second.tools.stderr)
    assert.match(second.tools.stdout, /actualizado via --amend \(el contenido cambio respecto al intento anterior\)/)
    assert.match(second.tools.stdout, /PR ya existente reutilizado \(no se llamo a 'gh pr create'\)/)
    assert.equal(git(sandbox.bare, 'rev-list', '--count', `main..${docBranch('sess-am')}`), '1')
    assert.equal(git(sandbox.bare, 'show', `${docBranch('sess-am')}:${NOTE_REL}`), 'segunda version')
  })

  test('un PR cerrado sin merge se reabre por su numero', () => {
    const sandbox = consumerRepo('reopen')
    const gh = new FakeGh(SLUG)
    const note = writeLocal('reopen', 'field-note.md', 'contenido\n')
    assert.equal(run(sandbox, gh, noteArgs('sess-ro', note)).code, 0)
    const [pr] = gh.prs
    assert.ok(pr !== undefined)
    pr.state = 'CLOSED'

    const second = run(sandbox, gh, noteArgs('sess-ro', note))

    assert.equal(second.code, 0, second.tools.stderr)
    assert.deepEqual(gh.callsTo('pr reopen'), [['pr', 'reopen', '1', '--repo', SLUG]])
    assert.equal(pr.state, 'OPEN')
    assert.match(second.tools.stdout, new RegExp(`PR cerrado sin merge fue reabierto: ${pr.url}\n`))
  })

  test('un path ajeno en el worktree reanudado aborta sin tocarlo', () => {
    const sandbox = consumerRepo('c')
    const gh = new FakeGh(SLUG)
    const branch = docBranch('sess-c')
    const leftover = join(work, 'c', 'leftover-worktree')
    git(sandbox.main, 'branch', '-q', branch, 'main')
    git(sandbox.main, 'worktree', 'add', '-q', leftover, branch)
    writeFileSync(join(leftover, 'archivo-ajeno.txt'), 'contenido que no deberia estar aqui\n')
    const note = writeLocal('c', 'field-note.md', 'contenido de la field note C\n')
    const before = checkoutState(sandbox.main)

    const { code, tools } = run(sandbox, gh, noteArgs('sess-c', note))

    assert.equal(code, 1)
    assert.match(
      tools.stderr,
      new RegExp(
        `ERROR: el worktree documental contiene cambios fuera de los paths esperados \\('${NOTE_REL}'\\):\n\\?\\? archivo-ajeno\\.txt\n`,
      ),
    )
    assert.match(tools.stderr, /AVISO: el worktree '.*' conserva cambios sin commitear; no se elimina\. Status:\n/)
    assert.match(tools.stdout, /Worktree existente de una entrega previa de esta sesion reutilizado: /)
    assert.equal(existsSync(join(leftover, 'archivo-ajeno.txt')), true)
    assert.equal(gh.prs.length, 0)
    assert.deepEqual(checkoutState(sandbox.main), before)
  })
})

describe('glosario', () => {
  test('un glosario que no es YAML valido aborta antes de tocar git', () => {
    const sandbox = consumerRepo('d')
    const gh = new FakeGh(SLUG)
    const note = writeLocal('d', 'field-note.md', 'contenido de la field note D\n')
    const glossary = writeLocal('d', 'glosario-invalido.yaml', 'termino: [sin cerrar\n')

    const { code, tools } = run(sandbox, gh, [
      ...noteArgs('sess-d', note),
      '--glossary-path',
      GLOSSARY_REL,
      '--glossary',
      glossary,
    ])

    assert.equal(code, 1)
    assert.match(tools.stderr, /glosario-invalido\.yaml' dejo de ser YAML valido tras aplicar el delta\.\n/)
    assert.match(tools.stderr, /Accion de recuperacion: reformula unicamente el delta .*; no se toco git\.\n$/)
    assert.equal(gh.prs.length, 0)
    assert.deepEqual(gh.calls, [])
    assert.equal(gitOk(sandbox.bare, 'show-ref', '--verify', '--quiet', `refs/heads/${docBranch('sess-d')}`), false)
  })

  test('sin ningun validador en el PATH aborta sin dar el YAML por bueno', () => {
    const sandbox = consumerRepo('sin-validador')
    const gh = new FakeGh(SLUG)
    const note = writeLocal('sin-validador', 'field-note.md', 'contenido\n')
    const glossary = writeLocal('sin-validador', 'glosario.yaml', 'terminos: {}\n')

    const { code, tools } = run(
      sandbox,
      gh,
      [...noteArgs('sess-nv', note), '--glossary-path', GLOSSARY_REL, '--glossary', glossary],
      { missing: ['python3', 'ruby', 'yq'] },
    )

    assert.equal(code, 1)
    assert.match(tools.stderr, /^ERROR: ningun validador YAML esta ya presente en PATH \(se probo python3\+PyYAML, ruby y yq\)/)
    assert.deepEqual(gh.calls, [])
  })

  test('un --glossary-path fuera de los dos destinos admitidos aborta sin tocar git', () => {
    const sandbox = consumerRepo('e')
    const gh = new FakeGh(SLUG)
    const note = writeLocal('e', 'field-note.md', 'contenido\n')

    const { code, tools } = run(sandbox, gh, [
      ...noteArgs('sess-e', note),
      '--glossary-path',
      'docs/otro/glosario.yaml',
      '--glossary',
      note,
    ])

    assert.equal(code, 1)
    assert.match(tools.stderr, /^ERROR: --glossary-path 'docs\/otro\/glosario\.yaml' no es un destino admitido\.\n/)
    assert.equal(gitOk(sandbox.main, 'show-ref', '--verify', '--quiet', `refs/heads/${docBranch('sess-e')}`), false)
  })

  test('un glosario valido se entrega junto a la field note, y nada mas', () => {
    const sandbox = consumerRepo('f')
    const gh = new FakeGh(SLUG)
    const note = writeLocal('f', 'field-note.md', 'contenido de la field note F\n')
    const content = 'terminos:\n  turno: definicion de prueba\n'
    const glossary = writeLocal('f', 'glosario-valido.yaml', content)
    const branch = docBranch('sess-f')

    const { code, tools } = run(sandbox, gh, [
      ...noteArgs('sess-f', note),
      '--glossary-path',
      GLOSSARY_REL,
      '--glossary',
      glossary,
    ])

    assert.equal(code, 0, tools.stderr)
    assert.equal(git(sandbox.bare, 'show', `${branch}:${GLOSSARY_REL}`), content.trimEnd())
    assert.deepEqual(git(sandbox.bare, 'diff', '--name-only', 'main', branch).split('\n').sort(), [
      NOTE_REL,
      GLOSSARY_REL,
    ].sort())
    assert.match(tools.stdout, new RegExp(`Field note: ${NOTE_REL}\nGlosario: ${GLOSSARY_REL}\nRama: ${branch}\n`))
  })

  test('un --glossary que no existe aborta sin tocar git', () => {
    const sandbox = consumerRepo('g')
    const gh = new FakeGh(SLUG)
    const note = writeLocal('g', 'field-note.md', 'contenido\n')

    const { code, tools } = run(sandbox, gh, [
      ...noteArgs('sess-g', note),
      '--glossary-path',
      GLOSSARY_REL,
      '--glossary',
      join(work, 'g', 'delta-que-nunca-se-escribio.yaml'),
    ])

    assert.equal(code, 1)
    assert.match(tools.stderr, /^ERROR: --glossary '.*' no existe o no es un archivo\n$/)
    assert.equal(gitOk(sandbox.main, 'show-ref', '--verify', '--quiet', `refs/heads/${docBranch('sess-g')}`), false)
  })

  test('si la copia del worktree deja de validar, no se agrega y el worktree se conserva', () => {
    const sandbox = consumerRepo('h')
    const gh = new FakeGh(SLUG)
    const note = writeLocal('h', 'field-note.md', 'contenido\n')
    const glossary = writeLocal('h', 'glosario.yaml', 'terminos: {}\n')
    let checks = 0
    const before = checkoutState(sandbox.main)

    const { code, tools } = run(
      sandbox,
      gh,
      [...noteArgs('sess-h', note), '--glossary-path', GLOSSARY_REL, '--glossary', glossary],
      {
        // Valida el archivo de origen y rechaza la copia ya escrita en el worktree.
        intercept: (command, args) =>
          command !== 'python3'
            ? undefined
            : { status: args.length === 3 && ++checks === 2 ? 1 : 0, stdout: '', stderr: '' },
      },
    )

    assert.equal(code, 1)
    assert.match(tools.stderr, /ERROR: fallo en el paso 'worktree' de la entrega/)
    assert.match(tools.stderr, /Ultimo checkpoint confirmado: worktree\n/)
    assert.match(tools.stderr, new RegExp(`'${GLOSSARY_REL}' dejo de ser YAML valido tras escribir el delta en '.*'\\. No se stageo nada\\.`))
    assert.match(tools.stderr, new RegExp(`AVISO: el worktree '.*' conserva cambios sin commitear; no se elimina\\. Status:\nA  ${NOTE_REL}\n\\?\\? ${GLOSSARY_REL}\n`))
    assert.equal(gh.callsTo('pr list').length, 0)
    assert.equal(gitOk(sandbox.bare, 'show-ref', '--verify', '--quiet', `refs/heads/${docBranch('sess-h')}`), false)
    assert.deepEqual(checkoutState(sandbox.main), before)
  })
})

describe('validateYamlFile', () => {
  function validator(present: string[], verdicts: Record<string, number>): { tools: RecordingTools; code: number } {
    const tools = sandboxTools(new FakeGh(SLUG), {
      missing: ['python3', 'ruby', 'yq'].filter((command) => !present.includes(command)),
      intercept: (command, args) => {
        // La primera llamada a python3 y a ruby solo prueba que el modulo de YAML carga.
        const probe = (command === 'python3' && args.length === 2) || (command === 'ruby' && args.length === 3)
        const status = probe ? (verdicts[`${command}:probe`] ?? 0) : (verdicts[command] ?? 0)
        return { status, stdout: '', stderr: '' }
      },
    })
    return { tools, code: validateYamlFile(tools, work, 'glosario.yaml') }
  }

  test('usa python3 si trae PyYAML y devuelve su veredicto', () => {
    const valid = validator(['python3', 'ruby', 'yq'], {})
    assert.equal(valid.code, 0)
    assert.deepEqual(valid.tools.commands.map((command) => command[0]), ['python3', 'python3'])
    assert.equal(validator(['python3'], { python3: 1 }).code, 1)
  })

  test('sin PyYAML cae a ruby, y sin ruby a yq', () => {
    const ruby = validator(['python3', 'ruby', 'yq'], { 'python3:probe': 1, ruby: 1 })
    assert.equal(ruby.code, 1)
    assert.deepEqual(ruby.tools.commands.map((command) => command[0]), ['python3', 'ruby', 'ruby'])

    const yq = validator(['yq'], {})
    assert.equal(yq.code, 0)
    assert.deepEqual(yq.tools.commands, [['yq', 'eval', '.', 'glosario.yaml']])
  })

  test('sin ningun validador devuelve 2', () => {
    assert.equal(validator([], {}).code, 2)
    assert.equal(validator(['python3'], { 'python3:probe': 1 }).code, 2)
  })
})
