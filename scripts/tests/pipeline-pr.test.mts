import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import type { CommandResult } from '../lib/cli.mts'
import { loggedThrough } from '../lib/pipeline/pipeline-log.mts'
import {
  collectSummary,
  commentIssue,
  commentPullRequest,
  createPullRequest,
  formatMinutes,
  localDateTimeWithZone,
  metricsComment,
  parseIssueView,
  pushBranch,
  repoSlugFromRemoteUrl,
  summaryDetails,
  viewIssue,
  zoneAbbreviation,
} from '../lib/pipeline/pipeline-pr.mts'
import type { GithubTools } from '../lib/pipeline/pipeline-pr.mts'

const work = mkdtempSync(join(tmpdir(), 'mefisto pipeline pr '))
after(() => rmSync(work, { recursive: true, force: true }))

function tools(result: CommandResult): { calls: unknown[][]; logFile: string; tools: GithubTools } {
  const calls: unknown[][] = []
  const logFile = join(work, `log-${Math.random().toString(16).slice(2)}.log`)
  const run = (command: string, args: string[], options?: unknown): CommandResult => {
    calls.push([command, args, options])
    return result
  }
  return { calls, logFile, tools: { run, runLogged: loggedThrough(run), logFile, cwd: work, env: { A: '1' } } }
}

describe('repoSlugFromRemoteUrl', () => {
  const CASES: [string, string][] = [
    ['git@github.com:acme/consumidor.git', 'acme/consumidor'],
    ['https://github.com/acme/consumidor.git', 'acme/consumidor'],
    ['ssh://git@github.com/acme/con.sumidor.git', 'acme/con.sumidor'],
    ['https://github.com/acme/consumidor', 'https://github.com/acme/consumidor'],
    ['/srv/remotos/origin.git', '/srv/remotos/origin.git'],
  ]
  test('saca owner/repo de un remoto de GitHub con .git y deja igual lo demas', () => {
    for (const [url, slug] of CASES) assert.equal(repoSlugFromRemoteUrl(url), slug, url)
  })
})

describe('formatMinutes y summaryDetails', () => {
  test('minutos y segundos; vacio o ausente cuenta como cero', () => {
    assert.equal(formatMinutes(125), '2m 5s')
    assert.equal(formatMinutes('59'), '0m 59s')
    assert.equal(formatMinutes(null), '0m 0s')
    assert.equal(formatMinutes(''), '0m 0s')
  })
  test('bloque plegable con el resumen', () => {
    assert.equal(summaryDetails('Writer', 125, 'hice esto'), '<details>\n<summary>Writer -- 2m 5s</summary>\n\nhice esto\n\n</details>')
  })
})

describe('parseIssueView', () => {
  const raw = (issue: Record<string, unknown>): string => JSON.stringify(issue)

  test('lee estado, titulo y cuerpo de la respuesta de gh', () => {
    const view = parseIssueView(raw({ body: 'Linea 1\nLinea 2\n\n', number: 42, state: 'OPEN', title: 'Agregar CI' }))
    assert.deepEqual(view, { state: 'OPEN', title: 'Agregar CI', body: 'Linea 1\nLinea 2' })
  })

  test('un cuerpo nulo sale como None, igual que con el print de Python del bash', () => {
    assert.equal(parseIssueView(raw({ body: null, number: 1, state: 'OPEN', title: 't' })).body, 'None')
  })

  test('el titulo se lee del JSON: conserva comillas y barras invertidas', () => {
    const view = parseIssueView(raw({ body: 'b', number: 1, state: 'OPEN', title: 'Agregar "ci" nuevo' }))
    assert.equal(view.title, 'Agregar "ci" nuevo')
    assert.equal(parseIssueView(raw({ body: 'b', number: 1, state: 'OPEN', title: 'ruta a\\b' })).title, 'ruta a\\b')
  })

  test('una respuesta que no es JSON deja el estado en UNKNOWN', () => {
    assert.equal(parseIssueView('no es json').state, 'UNKNOWN')
    assert.equal(parseIssueView('').state, 'UNKNOWN')
    assert.equal(parseIssueView('{"title":"sin estado"}').state, 'UNKNOWN')
  })

  test('el titulo se lee tambien de un JSON con espacios, y sin campo title no hay titulo', () => {
    assert.equal(parseIssueView('{"state": "OPEN", "title": "con espacios"}').title, 'con espacios')
    assert.equal(parseIssueView('{"state": "OPEN"}').title, null)
  })

  test('sin body legible recorta el JSON crudo', () => {
    assert.equal(parseIssueView('{"number":1,"state":"OPEN","title":"t"}').body, '{"number":1,"state":"OPEN')
  })
})

describe('gh y git', () => {
  test('viewIssue devuelve la respuesta sin saltos finales y deja el error de gh en el log', () => {
    const ok = tools({ status: 0, stdout: '{"state":"OPEN"}\n', stderr: 'aviso de gh\n' })
    assert.equal(viewIssue('42', 'number,title,body,state', ok.tools), '{"state":"OPEN"}')
    assert.deepEqual(ok.calls, [['gh', ['issue', 'view', '42', '--json', 'number,title,body,state'], { cwd: work, env: { A: '1' } }]])
    assert.equal(readFileSync(ok.logFile, 'utf8'), 'aviso de gh\n')
    const failed = tools({ status: 1, stdout: '', stderr: 'GraphQL: no existe\n' })
    assert.equal(viewIssue('42', 'state', failed.tools), null)
    assert.equal(readFileSync(failed.logFile, 'utf8'), 'GraphQL: no existe\n')
  })

  test('pushBranch empuja la rama desde el worktree y manda la salida al log', () => {
    const ok = tools({ status: 0, stdout: '', stderr: 'To origin\n' })
    assert.equal(pushBranch(join(work, 'wt'), 'rama', ok.tools), true)
    assert.deepEqual(ok.calls[0]?.slice(0, 2), ['git', ['-C', join(work, 'wt'), 'push', '-u', 'origin', 'rama']])
    assert.equal(readFileSync(ok.logFile, 'utf8'), 'To origin\n')
    assert.equal(pushBranch(join(work, 'wt'), 'rama', tools({ status: 1, stdout: '', stderr: '' }).tools), false)
  })

  test('createPullRequest arma el argv de gh y devuelve la URL', () => {
    const ok = tools({ status: 0, stdout: 'https://github.com/acme/c/pull/7\n', stderr: 'creando\n' })
    const url = createPullRequest({ title: 'Titulo', body: 'Cuerpo\ncon saltos', head: 'rama', repo: 'acme/c' }, ok.tools)
    assert.equal(url, 'https://github.com/acme/c/pull/7')
    assert.deepEqual(ok.calls[0]?.slice(0, 2), [
      'gh',
      ['pr', 'create', '--title', 'Titulo', '--body', 'Cuerpo\ncon saltos', '--base', 'main', '--head', 'rama', '--repo', 'acme/c'],
    ])
    assert.equal(readFileSync(ok.logFile, 'utf8'), 'creando\n')
    const failed = tools({ status: 1, stdout: '', stderr: 'ya existe\n' })
    assert.equal(createPullRequest({ title: 't', body: 'b', base: 'develop', head: 'r', repo: 'a/b' }, failed.tools), null)
    assert.deepEqual((failed.calls[0]?.[1] as string[]).slice(6, 8), ['--base', 'develop'])
  })

  test('los comentarios devuelven si gh pudo y mandan su salida al log', () => {
    const ok = tools({ status: 0, stdout: 'https://comentario\n', stderr: '' })
    assert.equal(commentPullRequest('https://pr/7', 'cuerpo', 'acme/c', ok.tools), true)
    assert.equal(commentIssue('42', 'listo', 'acme/c', ok.tools), true)
    assert.deepEqual(
      ok.calls.map((call) => call[1]),
      [
        ['pr', 'comment', 'https://pr/7', '--body', 'cuerpo', '--repo', 'acme/c'],
        ['issue', 'comment', '42', '--body', 'listo', '--repo', 'acme/c'],
      ],
    )
    assert.equal(readFileSync(ok.logFile, 'utf8'), 'https://comentario\nhttps://comentario\n')
    const failed = tools({ status: 1, stdout: '', stderr: '' })
    assert.equal(commentPullRequest('u', 'b', 'r', failed.tools), false)
    assert.equal(commentIssue('1', 'b', 'r', failed.tools), false)
  })
})

describe('collectSummary', () => {
  test('devuelve el resumen sin saltos finales', () => {
    const file = join(work, 'stage-1-writer.md')
    writeFileSync(file, '## Implementado\n\n- Algo\n\n\n')
    assert.equal(collectSummary(file), '## Implementado\n\n- Algo')
  })
  test('sin archivo usa el texto de reemplazo, que es un parametro', () => {
    assert.equal(collectSummary(join(work, 'ausente.md')), '_(El agente no genero resumen)_')
    assert.equal(collectSummary(null), '_(El agente no genero resumen)_')
    assert.equal(collectSummary(null, '_(sin resumen)_'), '_(sin resumen)_')
    assert.equal(collectSummary(work), '_(El agente no genero resumen)_')
  })
})

describe('comentario de metricas', () => {
  const date = new Date(2026, 10, 11, 9, 5, 7)
  test('la fecha va en hora local con la zona', () => {
    assert.match(localDateTimeWithZone(date), /^2026-11-11 09:05:07 \S+$/)
    assert.equal(localDateTimeWithZone(date), `2026-11-11 09:05:07 ${zoneAbbreviation(date)}`)
  })
  test('la zona es una abreviatura o un desfase, nunca GMT+N', () => {
    assert.match(zoneAbbreviation(date), /^([A-Z]{2,5}|[+-]\d{2}(\d{2})?)$/)
  })
  test('el comentario lleva encabezado, fecha y tabla', () => {
    assert.equal(metricsComment('| tabla |', date), `## Metricas de la corrida\n\nActualizado: ${localDateTimeWithZone(date)}\n\n| tabla |`)
  })
})
