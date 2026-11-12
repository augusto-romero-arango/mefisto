import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { repoRoot } from '../../../scripts/lib/cli.mts'
import {
  FakeGh,
  checkoutState,
  deliverByHand,
  git,
  gitOk,
  isolateGitConfig,
  mutationsOf,
  newRepo,
  sandboxTools,
} from '../../../scripts/tests/field-note-sandbox.mts'
import type { CheckoutState, RecordingTools, Sandbox } from '../../../scripts/tests/field-note-sandbox.mts'
import { deliver, latestPr } from '../../../src/internal/scripts/mefisto-field-note.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'src', 'internal', 'scripts', 'mefisto-field-note.mts')
const SLUG = 'acme/mefisto-fake'
const AGENT = 'mefisto-planner'

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

// `.mefisto/` va ignorado como en el repo real: el worktree que un fallo conserva vive ahi y no
// debe contar como cambio del checkout principal.
function mefistoRepo(name: string): Sandbox {
  return newRepo(join(work, name), {
    '.claude-plugin/plugin.json': '{\n  "name": "mefisto",\n  "version": "0.0.0"\n}\n',
    '.gitignore': '.mefisto/\n',
  })
}

interface Session {
  timestamp: string
  id: string
  branch: string
  rel: string
}

function session(timestamp: string, suffix: string): Session {
  const id = `${timestamp}-01-${suffix}`
  return {
    timestamp,
    id,
    branch: `docs/${AGENT}-field-note-${id}`,
    rel: `docs/bitacora/field-notes/${timestamp}-${AGENT}.md`,
  }
}

interface Run {
  code: number
  tools: RecordingTools
}

function run(sandbox: Sandbox, gh: FakeGh, target: Session, content: string): Run {
  const tools = sandboxTools(gh)
  const code = deliver(['--agent', AGENT, '--timestamp', target.timestamp, '--session-id', target.id], {
    cwd: sandbox.main,
    tools,
    readStdin: () => Buffer.from(`${content}\n`),
    resolveRepo: (cwd) => ({ root: repoRoot(cwd) ?? cwd, projectName: 'mefisto', repoSlug: gh.slug }),
  })
  return { code, tools }
}

function prLine(tools: RecordingTools): string {
  return tools.stdout.split('\n').find((line) => line.startsWith('PR: ')) ?? ''
}

function seed(gh: FakeGh, number: number, state: string, mergedAt: string | null, head: string): string {
  const url = `https://github.com/${gh.slug}/pull/${number}`
  gh.prs.push({ number, url, state, mergedAt, head, base: 'main', createdAt: '2000-01-01T00:00:00Z' })
  return url
}

function hasRemoteBranch(sandbox: Sandbox, branch: string): boolean {
  return gitOk(sandbox.bare, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`)
}

describe('validacion de argumentos, sin tocar git', () => {
  let outside = ''

  // Una carpeta sin repo: si la validacion tocara git antes de rechazar el valor, el mensaje seria otro.
  function cli(...args: string[]): { status: number | null; stderr: string } {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: outside,
      input: 'contenido\n',
      encoding: 'utf8',
      env: { ...process.env, GIT_CEILING_DIRECTORIES: work },
    })
  }

  before(() => {
    outside = join(work, 'argtest')
    mkdirSync(outside)
  })

  test('sin argumentos pide los tres obligatorios y muestra el uso', () => {
    const result = cli()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^ERROR: --agent, --timestamp y --session-id son obligatorios\nUso: mefisto-field-note\.mts /)
  })

  test('rechaza un --agent o un --session-id que no sean un slug', () => {
    const invalid = cli('--agent', '../evil', '--timestamp', '2026-09-13-1530', '--session-id', 'abc123')
    assert.equal(invalid.status, 1)
    assert.equal(invalid.stderr, "ERROR: --agent '../evil' es invalido: solo se permiten letras, digitos, '-' y '_'\n")

    assert.equal(cli('--agent', 'a/b', '--timestamp', '2026-09-13-1530', '--session-id', 'abc123').status, 1)
    assert.equal(cli('--agent', AGENT, '--timestamp', '2026-09-13-1530', '--session-id', 'sesion con espacios').status, 1)

    const dash = cli('--agent', '-mefisto-planner', '--timestamp', '2026-09-13-1530', '--session-id', 'abc123')
    assert.equal(dash.status, 1)
    assert.equal(dash.stderr, "ERROR: --agent '-mefisto-planner' no puede empezar con '-'\n")
  })

  test('rechaza un --timestamp mal formado indicando el formato', () => {
    const result = cli('--agent', AGENT, '--timestamp', '13-09-2026', '--session-id', 'abc123')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /YYYY-MM-DD-HHMM/)
  })

  test('--help muestra el uso por stderr y sale con 0', () => {
    const result = cli('--help')
    assert.equal(result.status, 0)
    assert.match(result.stderr, /^Uso: mefisto-field-note\.mts /)
  })

  test('con argumentos validos y fuera de un repo, el guard aborta', () => {
    const previous = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = work
    try {
      const tools = sandboxTools(new FakeGh(SLUG))
      const args = ['--agent', AGENT, '--timestamp', '2026-09-13-1530', '--session-id', 'abc123']
      assert.equal(deliver(args, { cwd: outside, tools, readStdin: () => assert.fail('no debe leer stdin') }), 1)
      assert.equal(tools.stderr, 'ERROR: no estas en un repositorio git\n')
    } finally {
      if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = previous
    }
  })

  test('ningun caso escribio en la carpeta de prueba', () => {
    assert.deepEqual(readdirSync(outside), [])
  })
})

describe('precondiciones dentro del repo', () => {
  test('sin el slug del repo remoto aborta antes de leer la nota', () => {
    const sandbox = mefistoRepo('sin-slug')
    const tools = sandboxTools(new FakeGh(SLUG))
    const code = deliver(['--agent', AGENT, '--timestamp', '2026-09-13-1530', '--session-id', 'abc'], {
      cwd: sandbox.main,
      tools,
      readStdin: () => assert.fail('no debe leer stdin'),
      resolveRepo: (cwd) => ({ root: repoRoot(cwd) ?? cwd, projectName: 'mefisto', repoSlug: '' }),
    })
    assert.equal(code, 1)
    assert.match(tools.stderr, /ERROR: no se pudo resolver el repo remoto \(gh repo view --json nameWithOwner\); revisa 'gh auth status'\n$/)
  })

  test('una nota vacia por stdin aborta sin crear la rama', () => {
    const sandbox = mefistoRepo('vacia')
    const target = session('2026-09-13-1500', 'vacia-00000')
    const { code, tools } = run(sandbox, new FakeGh(SLUG), target, '\n')
    assert.equal(code, 1)
    assert.match(tools.stderr, /ERROR: no se recibio contenido por stdin para la field note\n$/)
    assert.equal(gitOk(sandbox.main, 'show-ref', '--verify', '--quiet', `refs/heads/${target.branch}`), false)
  })

  test('activa los hooks versionados y lo avisa una sola vez', () => {
    const sandbox = mefistoRepo('hooks')
    const gh = new FakeGh(SLUG)
    const first = run(sandbox, gh, session('2026-09-13-1501', 'hooks-00001'), 'nota')
    assert.match(first.tools.stderr, /^AVISO: core\.hooksPath configurado a src\/internal\/githooks /)
    assert.equal(git(sandbox.main, 'config', '--get', 'core.hooksPath'), 'src/internal/githooks')
    const second = run(sandbox, gh, session('2026-09-13-1502', 'hooks-00002'), 'nota')
    assert.doesNotMatch(second.tools.stderr, /core\.hooksPath/)
  })
})

describe('entrega', () => {
  test('primera entrega con el checkout principal sucio: crea el PR y no toca el checkout', () => {
    const sandbox = mefistoRepo('c')
    const gh = new FakeGh(SLUG)
    const target = session('2026-09-13-1530', 'abc123def456-99999')
    writeFileSync(join(sandbox.main, 'README-local.md'), 'trabajo en progreso\n')
    const before = checkoutState(sandbox.main)
    const content = '---\nfecha: 2026-09-13\ntema: prueba\n---\n\n## Contexto\nPrueba de entrega aislada.'

    const { code, tools } = run(sandbox, gh, target, content)

    assert.equal(code, 0, tools.stderr)
    // El aviso que gh escribe en stderr al tener exito no se pega ni a la URL ni al nombre de la rama base.
    assert.equal(prLine(tools), `PR: https://github.com/${SLUG}/pull/1`)
    assert.match(tools.stderr, /aviso de gh: hay una version mas nueva disponible\n/)
    assert.match(tools.stderr, /Creating pull request for /)

    const [create] = gh.callsTo('pr create')
    assert.deepEqual(create, [
      'pr',
      'create',
      '--repo',
      SLUG,
      '--base',
      'main',
      '--head',
      target.branch,
      '--title',
      `docs(bitacora): field note de ${AGENT} ${target.timestamp}`,
      '--body',
      `Entrega aislada de la field note de la sesion ${AGENT} ${target.id}.`,
    ])
    // El slug va posicional: `gh repo view` no acepta --repo.
    assert.deepEqual(gh.callsTo('repo view'), [
      ['repo', 'view', SLUG, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
    ])

    assert.equal(hasRemoteBranch(sandbox, target.branch), true)
    assert.equal(git(sandbox.bare, 'diff', '--name-only', 'main', target.branch), target.rel)
    assert.equal(git(sandbox.bare, 'show', `${target.branch}:${target.rel}`), content)
    assert.equal(
      git(sandbox.bare, 'log', '-1', '--format=%s', target.branch),
      `docs(bitacora): agregar field note de ${AGENT}`,
    )

    assert.deepEqual(checkoutState(sandbox.main), before)
    assert.equal(readFileSync(join(sandbox.main, 'README-local.md'), 'utf8'), 'trabajo en progreso\n')
    assert.doesNotMatch(git(sandbox.main, 'worktree', 'list'), /field-note-/)
    assert.deepEqual(mutationsOf(tools, git(sandbox.main, 'rev-parse', '--show-toplevel')), [])

    const commit = git(sandbox.bare, 'rev-parse', target.branch)
    assert.match(
      tools.stdout,
      new RegExp(`Field note: ${target.rel}\nRama: ${target.branch}\nCommit: ${commit}\nPR: https://github.com/${SLUG}/pull/1\n$`),
    )
  })

  test('reintento tras un push exitoso sin PR: reusa rama y commit y crea el PR una sola vez', () => {
    const sandbox = mefistoRepo('d')
    const gh = new FakeGh(SLUG)
    gh.failing.set('pr create', 'once')
    const target = session('2026-09-13-1600', 'retry-11111')
    const content = '---\nfecha: 2026-09-13\ntema: retry\n---\n## Contexto\nPrueba de reintento tras push.'

    const first = run(sandbox, gh, target, content)
    assert.equal(first.code, 1)
    assert.match(first.tools.stderr, /fallo en el paso 'creacion-pr'/)
    assert.match(first.tools.stderr, /Ultimo checkpoint confirmado: push/)
    assert.equal(hasRemoteBranch(sandbox, target.branch), true)

    const second = run(sandbox, gh, target, content)
    assert.equal(second.code, 0, second.tools.stderr)
    assert.match(second.tools.stdout, /Commit ya existente de esta sesion reutilizado/)
    assert.equal(git(sandbox.bare, 'rev-list', '--count', `main..${target.branch}`), '1')
    assert.equal(gh.callsTo('pr create').length, 2)
    assert.equal(gh.prs.length, 1)
  })

  test('contenido distinto en el reintento actualiza el commit con amend', () => {
    const sandbox = mefistoRepo('amend')
    const gh = new FakeGh(SLUG)
    const target = session('2026-09-13-1630', 'amend-12121')
    assert.equal(run(sandbox, gh, target, 'primera version').code, 0)

    const second = run(sandbox, gh, target, 'segunda version')

    assert.equal(second.code, 0, second.tools.stderr)
    assert.match(
      second.tools.stdout,
      /actualizado via --amend \(el contenido de la field note cambio respecto al intento anterior\)/,
    )
    assert.equal(git(sandbox.bare, 'rev-list', '--count', `main..${target.branch}`), '1')
    assert.equal(git(sandbox.bare, 'show', `${target.branch}:${target.rel}`), 'segunda version')
    assert.equal(gh.prs.length, 1)
  })

  test('un PR abierto de la sesion se reutiliza sin llamar a gh pr create', () => {
    const sandbox = mefistoRepo('e')
    const gh = new FakeGh(SLUG)
    const target = session('2026-09-13-1700', 'open-22222')
    const content = '## Contexto\nPR abierto preexistente.'
    deliverByHand(sandbox, join(work, 'e', 'prep-wt'), target.branch, target.rel, `${content}\n`)
    const url = seed(gh, 7, 'OPEN', null, target.branch)

    const { code, tools } = run(sandbox, gh, target, content)

    assert.equal(code, 0, tools.stderr)
    assert.match(tools.stdout, /PR ya existente reutilizado/)
    assert.equal(prLine(tools), `PR: ${url}`)
    assert.equal(gh.callsTo('pr create').length, 0)
  })

  test('un PR cerrado sin merge se reabre', () => {
    const sandbox = mefistoRepo('f')
    const gh = new FakeGh(SLUG)
    const target = session('2026-09-13-1800', 'closed-33333')
    const content = '## Contexto\nPR cerrado sin merge.'
    deliverByHand(sandbox, join(work, 'f', 'prep-wt'), target.branch, target.rel, `${content}\n`)
    const url = seed(gh, 8, 'CLOSED', null, target.branch)

    const { code, tools } = run(sandbox, gh, target, content)

    assert.equal(code, 0, tools.stderr)
    assert.deepEqual(gh.callsTo('pr reopen'), [['pr', 'reopen', '--repo', SLUG, url]])
    assert.match(tools.stdout, new RegExp(`PR cerrado sin merge fue reabierto: ${url}\n`))
    assert.equal(gh.prs[0]?.state, 'OPEN')
  })

  test('PR mergeado y rama borrada: no republica lo identico, reentrega lo nuevo y reutiliza la reentrega', () => {
    const sandbox = mefistoRepo('g')
    const gh = new FakeGh(SLUG)
    const target = session('2026-09-13-1900', 'merged-44444')
    const content = '## Contexto\nPR ya mergeado.'
    deliverByHand(sandbox, join(work, 'g', 'prep-wt'), target.branch, target.rel, `${content}\n`)
    // El merge y el borrado remoto del PR original; la tracking ref local queda rancia a proposito.
    git(sandbox.main, 'merge', '-q', '--ff-only', target.branch)
    git(sandbox.main, 'push', '-q', 'origin', 'main')
    git(sandbox.main, 'push', '-q', 'origin', '--delete', target.branch)
    git(sandbox.main, 'update-ref', `refs/remotes/origin/${target.branch}`, git(sandbox.main, 'rev-parse', target.branch))
    const merged = seed(gh, 9, 'MERGED', '2026-09-13T19:30:00Z', target.branch)

    const identical = run(sandbox, gh, target, content)
    assert.equal(identical.code, 0, identical.tools.stderr)
    assert.equal(prLine(identical.tools), `PR: ${merged}`)
    assert.match(identical.tools.stdout, new RegExp(`'${target.rel}' ya esta en 'main' con este mismo contenido`))
    assert.match(identical.tools.stdout, /PR ya mergeado: la field note de esta sesion ya fue entregada/)
    assert.equal(gh.callsTo('pr create').length, 0)
    assert.equal(hasRemoteBranch(sandbox, target.branch), false)
    assert.equal(
      gitOk(sandbox.main, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${target.branch}`),
      false,
    )

    const extended = '## Contexto\nPR mergeado; contenido ampliado para la reentrega.'
    const redelivery = run(sandbox, gh, target, extended)
    const redelivered = `https://github.com/${SLUG}/pull/2`
    assert.equal(redelivery.code, 0, redelivery.tools.stderr)
    assert.equal(prLine(redelivery.tools), `PR: ${redelivered}`)
    assert.match(redelivery.tools.stdout, /PR de reentrega creado tras el merge del PR anterior/)
    const [create] = gh.callsTo('pr create')
    assert.equal(
      create?.[create.indexOf('--title') + 1],
      `docs(bitacora): reentrega de field note de ${AGENT} ${target.timestamp}`,
    )
    assert.equal(git(sandbox.bare, 'show', `${target.branch}:${target.rel}`), extended)

    const third = run(sandbox, gh, target, extended)
    assert.equal(third.code, 0, third.tools.stderr)
    assert.equal(gh.callsTo('pr create').length, 1)
    assert.equal(prLine(third.tools), `PR: ${redelivered}`)
  })

  test('la rama documental checkouteada en el checkout principal aborta sin escribir ahi', () => {
    const sandbox = mefistoRepo('i')
    const gh = new FakeGh(SLUG)
    const target = session('2026-09-13-2100', 'inmain-66666')
    git(sandbox.main, 'switch', '-q', '-c', target.branch)
    const before = checkoutState(sandbox.main)

    const { code, tools } = run(sandbox, gh, target, 'contenido i')

    assert.equal(code, 1)
    assert.match(tools.stderr, /esta checkouteada en el CHECKOUT PRINCIPAL \('.*'\); reanudar ahi violaria el aislamiento del checkout principal\./)
    assert.match(tools.stderr, /Accion de recuperacion: /)
    assert.match(tools.stderr, /reintenta con los mismos --agent\/--timestamp\/--session-id\.\n/)
    assert.equal(existsSync(join(sandbox.main, ...target.rel.split('/'))), false)
    assert.deepEqual(checkoutState(sandbox.main), before)
  })

  test('nota ya mergeada en la base y contenido nuevo: no reescribe el commit de la base', () => {
    const sandbox = mefistoRepo('j')
    const gh = new FakeGh(SLUG)
    const target = session('2026-09-13-2200', 'merged-77777')
    // La rama documental ya no existe en origin: el worktree nace de origin/main, que ya trae la
    // nota. Amendar ahi reescribiria un commit de main y lo publicaria como field note.
    mkdirSync(dirname(join(sandbox.main, ...target.rel.split('/'))), { recursive: true })
    writeFileSync(join(sandbox.main, ...target.rel.split('/')), 'contenido j (version ya mergeada)\n')
    git(sandbox.main, 'add', '--', target.rel)
    git(sandbox.main, 'commit', '-q', '-m', 'docs(bitacora): merge previo de la field note')
    git(sandbox.main, 'push', '-q', 'origin', 'main')
    const mainTip = git(sandbox.bare, 'rev-parse', 'main')

    const { code, tools } = run(sandbox, gh, target, 'contenido j (version corregida)')

    assert.equal(code, 0, tools.stderr)
    assert.equal(gitOk(sandbox.bare, 'merge-base', '--is-ancestor', mainTip, target.branch), true)
    assert.equal(git(sandbox.bare, 'rev-parse', 'main'), mainTip)
    assert.equal(git(sandbox.bare, 'log', '-1', '--format=%s', 'main'), 'docs(bitacora): merge previo de la field note')
    assert.equal(git(sandbox.bare, 'rev-list', '--count', `main..${target.branch}`), '1')
    assert.equal(git(sandbox.bare, 'show', `${target.branch}:${target.rel}`), 'contenido j (version corregida)')
  })
})

describe('un fallo recuperable por checkpoint', () => {
  function assertAborted(result: Run, step: string, checkpoint: string): void {
    assert.equal(result.code, 1)
    assert.match(result.tools.stderr, new RegExp(`ERROR: fallo en el paso '${step}' de la entrega de la field note`))
    assert.match(result.tools.stderr, new RegExp(`Ultimo checkpoint confirmado: ${checkpoint}\n`))
    assert.match(result.tools.stderr, /Accion de recuperacion: \S/)
  }

  function assertUntouched(sandbox: Sandbox, before: CheckoutState): void {
    assert.deepEqual(checkoutState(sandbox.main), before)
  }

  test('worktree: el fetch de la rama base falla', () => {
    const sandbox = mefistoRepo('h1')
    const before = checkoutState(sandbox.main)
    git(sandbox.main, 'remote', 'set-url', 'origin', join(work, 'h1', 'no-existe.git'))

    const result = run(sandbox, new FakeGh(SLUG), session('2026-09-13-2000', 'h1-55501'), 'contenido h1')

    assertAborted(result, 'worktree', 'inicio')
    assertUntouched(sandbox, before)
  })

  test('commit: git commit falla y el worktree se conserva con la nota staged', () => {
    const sandbox = mefistoRepo('h2')
    const before = checkoutState(sandbox.main)
    const target = session('2026-09-13-2000', 'h2-55502')
    git(sandbox.main, 'config', 'commit.gpgsign', 'true')
    git(sandbox.main, 'config', 'gpg.program', join(work, 'h2', 'no-existe-gpg'))

    const result = run(sandbox, new FakeGh(SLUG), target, 'contenido h2')

    assertAborted(result, 'commit', 'worktree')
    assert.match(result.tools.stderr, /\(la field note sigue staged\)/)
    assert.match(
      result.tools.stderr,
      new RegExp(`AVISO: el worktree '.*field-note-${target.id}\\..*' conserva cambios sin commitear; no se elimina\\. Status:\nA  ${target.rel}\n`),
    )
    assert.match(git(sandbox.main, 'worktree', 'list'), /field-note-/)
    assertUntouched(sandbox, before)
  })

  test('push: el remoto rechaza la rama documental', () => {
    const sandbox = mefistoRepo('h3')
    const before = checkoutState(sandbox.main)
    const target = session('2026-09-13-2000', 'h3-55503')
    const hook = join(sandbox.bare, 'hooks', 'pre-receive')
    writeFileSync(
      hook,
      [
        '#!/bin/sh',
        'while read -r old new ref; do',
        '    case "$ref" in',
        '        refs/heads/docs/*) echo "rechazado: rama documental deshabilitada" >&2; exit 1 ;;',
        '    esac',
        'done',
        'exit 0',
        '',
      ].join('\n'),
    )
    chmodSync(hook, 0o755)

    const result = run(sandbox, new FakeGh(SLUG), target, 'contenido h3')

    assertAborted(result, 'push', 'commit')
    assert.equal(hasRemoteBranch(sandbox, target.branch), false)
    assertUntouched(sandbox, before)
  })

  test('consulta-pr: gh pr list falla antes del push y la rama no se publica', () => {
    const sandbox = mefistoRepo('h4')
    const before = checkoutState(sandbox.main)
    const target = session('2026-09-13-2000', 'h4-55504')
    const gh = new FakeGh(SLUG)
    gh.failing.set('pr list', 'always')

    const result = run(sandbox, gh, target, 'contenido h4')

    assertAborted(result, 'consulta-pr', 'commit')
    assert.equal(hasRemoteBranch(sandbox, target.branch), false)
    assertUntouched(sandbox, before)
  })

  test('reapertura-pr: gh pr reopen falla con el PR cerrado sin merge', () => {
    const sandbox = mefistoRepo('h5')
    const before = checkoutState(sandbox.main)
    const target = session('2026-09-13-2000', 'h5-55505')
    deliverByHand(sandbox, join(work, 'h5', 'prep-wt'), target.branch, target.rel, 'contenido h5\n')
    const gh = new FakeGh(SLUG)
    // Sin createdAt: un PR que gh devuelve sin ese campo igual se elige.
    gh.prs.push({ number: 10, url: `https://github.com/${SLUG}/pull/10`, state: 'CLOSED', mergedAt: null, head: target.branch, base: 'main' })
    gh.failing.set('pr reopen', 'always')

    const result = run(sandbox, gh, target, 'contenido h5')

    assertAborted(result, 'reapertura-pr', 'push')
    assertUntouched(sandbox, before)
  })

  test('creacion-pr: gh pr create falla sin PR previo', () => {
    const sandbox = mefistoRepo('h6')
    const before = checkoutState(sandbox.main)
    const gh = new FakeGh(SLUG)
    gh.failing.set('pr create', 'always')

    const result = run(sandbox, gh, session('2026-09-13-2000', 'h6-55506'), 'contenido h6')

    assertAborted(result, 'creacion-pr', 'push')
    assertUntouched(sandbox, before)
  })
})

describe('latestPr', () => {
  test('elige el PR creado mas recientemente, no el primero de la lista', () => {
    const merged = { number: 9, createdAt: '2026-09-13T19:00:00Z' }
    const redelivery = { number: 12, createdAt: '2026-09-14T08:00:00Z' }
    assert.equal(latestPr([redelivery, merged]), redelivery)
    assert.equal(latestPr([merged, redelivery]), redelivery)
  })

  test('a igual fecha gana el numero mayor, y sin fecha un PR va antes que cualquiera fechado', () => {
    const low = { number: 3, createdAt: '2026-09-13T19:00:00Z' }
    const high = { number: 4, createdAt: '2026-09-13T19:00:00Z' }
    assert.equal(latestPr([high, low]), high)
    assert.equal(latestPr([{ number: 99 }, low]), low)
    assert.equal(latestPr([]), undefined)
  })
})
