import { expect, test } from 'claude-code/testing'

import { sprite } from '../sprites'
import {
  canStopParallel,
  parallelClosedHeader,
  parallelClosedTable,
  parallelCounts,
  parallelDismissKey,
  parallelMergeablePrs,
  parallelSummaryMarks,
  lotViewOf,
  paginateBands,
  parallelHeader,
  parallelQueueMarks,
  parallelRunOf,
  parallelStopQuestion,
  parallelTable,
  parseParallelStatus,
  batchSeparator,
  cleanLogLine,
  durationText,
  followTargetsOf,
  mergePaneLines,
  paneHeaderOf,
  parseEvent,
  poseOfBatch,
  bitacoraCount,
  bitacoraPrOf,
  bitacoraPrompt,
  fieldNoteNamesOf,
  fieldNotesIn,
  historianFrom,
  isHistorianType,
  liveHistorian,
  orderedNotes,
  pendingNotes,
  withProcessedNotes,
  finishMerge,
  isMergeRibbonExpired,
  mergeRunArgsOf,
  mergePrsOf,
  mergeRibbonHeader,
  mergeRibbonLine,
  mergeRibbonRows,
  mergeRibbonShown,
  mergeSummaryText,
  withMerged,
  batchSummaryMarks,
  batchEndLabel,
  batchEndFromStats,
  closeRowText,
  closeTotalText,
  nextCurrentRow,
  runningRowText,
  totalWithRunning,
  fmtCost,
  issueStatsFromHistory,
  stampToMs,
  statsPending,
  statsTotal,
  bandViewOf,
  resultsFooterText,
  mergeArgsOf,
  mergeOptions,
  mergeToast,
  openPrArgsOf,
  openPrOptions,
  parseOpenPrs,
  parsePrArgs,
  prOfResult,
  resultPrs,
  viewPrOf,
  activeRunOf,
  agentFlagOf,
  eventsFileOf,
  eventsLogBase,
  lastEventOf,
  poseOfResults,
  poseOfRun,
  roleOfAgent,
  agentOf,
  clockOf,
  minutesSince,
  agentSettingOf,
  dismissKey,
  parseHistory,
  parseStatus,
  pruneDismissed,
  reconcile,
  resultLine,
  runLine,
  stateDirOf,
  isMefistoManifest,
  nextOrderPath,
  pageOf,
  parseNextOrder,
  inPrRowParts,
  boardRowsOf,
  listosTextOf,
  rowParts,
  rowText,
  answerText,
  footerRestOf,
  launchCountOf,
  parseLaunchArg,
  planIssue,
  planLaunch,
  transcriptPathOf,
  batchCounts,
  batchDismissKey,
  batchHoldLine,
  batchPrOf,
  batchQueueText,
  batchQueueMarks,
  batchRunningHeader,
  recentLineColor,
  recentLines,
  batchRunOf,
  batchStopPath,
  canStopBatch,
  newlyMerged,
  parseBatchStatus,
  stepsOfAgents,
  stepsOf,
  stepsText,
  runHeader,
  logTailLines,
  eventLineOf,
  bandLinesOf,
  isPipelineLaunch,
} from './logic'

const json = JSON.stringify({
  items: [{ position: 1, number: 7, title: 'Hacer algo', tipo: 'tooling', after: [], hasDepsSection: true }],
  blocked: [{ number: 9 }, { number: 10 }],
  cycles: [[3, 4]],
  launch: '/mefisto:sequential 7',
})

test('parseNextOrder lee items, bloqueados y ciclos', () => {
  const list = parseNextOrder(0, json, '')
  expect(list.error).toBe(null)
  expect(list.items[0]?.number).toBe(7)
  expect(list.blockedCount).toBe(2)
  expect(list.cycleCount).toBe(1)
  expect(footerRestOf(list, false)).toBe('1 en ciclo')
})

test('parseNextOrder con exit 1 y sin items no es error', () => {
  const list = parseNextOrder(1, '{"items":[],"blocked":[],"cycles":[],"launch":null}', '')
  expect(list.error).toBe(null)
  expect(list.items.length).toBe(0)
})

test('parseNextOrder con exit 2 informa el error', () => {
  expect(parseNextOrder(2, '', '\nfallo gh\n').error).toBe('fallo gh')
  expect(parseNextOrder(2, '', '').error).toBe('exit 2')
  expect(parseNextOrder(0, 'no json', '').error).toBe('salida de next-order no es JSON')
})

test('rowText y rowParts: sin tecla, posicion ni [tipo]; letra de typeBadge y tras #M', () => {
  const item = { number: 7, title: 'Hacer algo', tipo: 'tooling', after: [3], hasDepsSection: true }
  expect(rowText(item, 4, 40)).toBe('#7   Hacer algo')
  expect(rowParts(item, 4, 40)).toEqual({ letter: 'T', color: 'magenta', label: '#7   Hacer algo', after: 'tras #3' })
  expect(rowParts({ ...item, tipo: null, after: [] }, 4, 40)).toEqual({ letter: '?', color: 'gray', label: '#7   Hacer algo', after: '' })
})

test('pageOf acota la pagina', () => {
  expect(pageOf(0, 0, 5)).toEqual({ page: 0, pages: 1 })
  expect(pageOf(9, 11, 5)).toEqual({ page: 2, pages: 3 })
})

test('deteccion del planner y del repo de Mefisto', () => {
  expect(agentFlagOf('claude --agent mefisto:planner')).toBe('mefisto:planner')
  expect(agentFlagOf('claude --agent=otro -p')).toBe('otro')
  expect(agentFlagOf('claude')).toBe(null)
  expect(agentSettingOf('{"type":"agent-setting","agentSetting":"mefisto:planner"}\n')).toBe('mefisto:planner')
  expect(agentSettingOf('{"type":"user"}\n')).toBe(null)
  expect(isMefistoManifest('{"name":"mefisto"}')).toBe(true)
  expect(isMefistoManifest('{"name":"otro"}')).toBe(false)
  expect(isMefistoManifest('x')).toBe(false)
})

test('rutas', () => {
  expect(nextOrderPath('/p/')).toBe('/p/scripts/next-order.sh')
  expect(transcriptPathOf('/h/.c', '/a/b', 's1')).toBe('/h/.c/projects/-a-b/s1.jsonl')
})

const status = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ issue: '7', pipeline: 'tdd', variant: null, started: '2026-10-09T10:00:00', stage: '3-implementer', state: 'running', ...over })
const NOW = Date.parse('2026-10-09T10:12:30')

test('parseStatus: running, hold, fallo y variante', () => {
  const run = parseStatus('pipeline-status-tdd-7.json', status())!
  expect(agentOf(run.stage)).toBe('implementer')
  expect(runLine(run, NOW)).toBe('#7 tdd implementer 12m')
  const hold = parseStatus('pipeline-status-tooling-8.json', status({ pipeline: 'tooling', issue: 8, state: 'hold', hold: { next_probe: '2026-10-09T10:45:00' } }))!
  expect(runLine(hold, NOW)).toBe('#8 tooling rate limit · sonda 10:45 12m')
  expect(runLine(parseStatus('pipeline-status-infra-9.json', status({ pipeline: 'infra', issue: 9, stage: 'setup' }))!, NOW)).toBe('#9 infra setup 12m')
  const variant = parseStatus('pipeline-status-tdd-7-b.json', status({ variant: 'b' }))!
  expect(variant.variant).toBe('b')
  expect(parseStatus('otro.json', status())).toBe(null)
  expect(parseStatus('pipeline-status-tdd-7.json', 'no json')).toBe(null)
})

test('parseHistory ignora lineas rotas y conserva el PR', () => {
  const h = parseHistory(`{"issue":"7","pipeline":"tdd","variant":null,"started":"2026-10-09T10:00:00","pr":"https://x/pull/55"}\nbasura\n`)
  expect(h.length).toBe(1)
  expect(h[0]!.pr).toBe('https://x/pull/55')
})

test('reconcile: de activa a ✓ PR, fallo con ✗ y descarte persistente', () => {
  const repo = '/r'
  const run = parseStatus('pipeline-status-tdd-7.json', status())!
  const history = parseHistory('{"issue":"7","pipeline":"tdd","variant":null,"started":"2026-10-09T10:00:00","pr":"https://x/pull/55"}')
  const first = reconcile(repo, [run], {}, history, new Set())
  expect(first.runs.length).toBe(1)
  const done = reconcile(repo, [], first.seen, history, new Set())
  expect(done.results.map(resultLine)).toEqual(['#7 tdd ✓ PR #55'])
  const failed = parseStatus('pipeline-status-tdd-7.json', status({ state: 'blocked', stage: '4-reviewer' }))!
  expect(reconcile(repo, [failed], {}, [], new Set()).results[0]!.text).toBe('✗ 4-reviewer')
  expect(reconcile(repo, [failed], {}, [], new Set([dismissKey(repo, failed)])).results.length).toBe(0)
})

test('dismissKey incluye repo, pipeline, issue, variante y started', () => {
  const run = parseStatus('pipeline-status-tdd-7-b.json', status({ variant: 'b' }))!
  expect(dismissKey('/r', run)).toBe('/r|tdd|7|b|2026-10-09T10:00:00')
})

test('pruneDismissed poda solo claves viejas del repo sin status vivo', () => {
  const old = '/r|tdd|1||2026-10-01T10:00:00'
  const fresh = '/r|tdd|2||2026-10-09T10:00:00'
  const other = '/o|tdd|1||2026-10-01T10:00:00'
  expect(pruneDismissed([old, fresh, other], '/r', new Set(), NOW)).toEqual([fresh, other])
  expect(pruneDismissed([old], '/r', new Set([old]), NOW)).toEqual([old])
})

test('stateDirOf resuelve el checkout principal aunque sea un worktree', () => {
  expect(stateDirOf('/repo/.git', '/repo/.mefisto/worktrees/x')).toBe('/repo/.mefisto/pipeline')
  expect(stateDirOf('.git', '/repo/')).toBe('/repo/.mefisto/pipeline')
})

test('started compacto de los pipelines y next_probe en UTC', () => {
  expect(minutesSince('20261009-100000', NOW)).toBe(12)
  const probe = '2026-10-09T15:45:00Z'
  const d = new Date(Date.parse(probe))
  expect(clockOf(probe)).toBe(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)
  expect(clockOf('nada')).toBe('nada')
})

const board = (over: Record<string, unknown> = {}) =>
  parseNextOrder(
    0,
    JSON.stringify({
      items: [
        { number: 7, title: 'A', tipo: 'tooling' },
        { number: 8, title: 'B', tipo: 'feature' },
        { number: 9, title: 'C', tipo: 'infra' },
        { number: 10, title: 'D', tipo: null },
      ],
      blocked: [{ number: 1 }],
      launch: '/mefisto:sequential 7 8',
      infra: [],
      parallel: { issues: [7, 8], launch: '/mefisto:parallel 7 8' },
      ...over,
    }),
    '',
  )

test('parseNextOrder lee infra y parallel', () => {
  const l = board({ infra: [9] })
  expect(l.infra).toEqual([9])
  expect(l.parallel?.launch).toBe('/mefisto:parallel 7 8')
})

test('1 y 2 escriben la linea de next-order sin infra', () => {
  expect(planLaunch(board(), 'sequential')).toEqual({ kind: 'fill', text: '/mefisto:sequential 7 8' })
  expect(planLaunch(board(), 'parallel')).toEqual({ kind: 'fill', text: '/mefisto:parallel 7 8' })
})

test('linea null: no actua ni se muestra', () => {
  const l = board({ launch: null, parallel: { issues: [], launch: null } })
  expect(planLaunch(l, 'sequential').kind).toBe('none')
  expect(planLaunch(l, 'parallel').kind).toBe('none')
})

test('con infra, 1 y 2 abren el dialogo previo con tres opciones', () => {
  const plan = planLaunch(board({ infra: [9, 11] }), 'parallel')
  if (plan.kind !== 'ask') throw new Error('se esperaba dialogo')
  expect(plan.options.map(o => o.label)).toEqual(['Infra primero', 'Seguir sin infra', 'Cancelar'])
  expect(answerText(plan.options, 'Infra primero')).toBe('/mefisto:infra 9')
  expect(answerText(plan.options, 'Seguir sin infra')).toBe('/mefisto:parallel 7 8')
  expect(answerText(plan.options, 'Cancelar')).toBe(null)
})

test('cerrar el dialogo o texto libre no escriben nada', () => {
  const plan = planLaunch(board({ infra: [9] }), 'sequential')
  if (plan.kind !== 'ask') throw new Error('se esperaba dialogo')
  expect(answerText(plan.options, null)).toBe(null)
  expect(answerText(plan.options, 'infra primero')).toBe(null)
  expect(answerText(plan.options, 'lo que sea')).toBe(null)
})

test('tipo -> opciones de un solo issue', () => {
  const item = (tipo: string | null) => ({ number: 5, title: 't', tipo, after: [], hasDepsSection: true })
  const texts = (tipo: string | null) => {
    const p = planIssue(item(tipo))
    return p.kind === 'ask' ? p.options.map(o => `${o.label}=${o.text}`) : p
  }
  for (const t of ['feature', 'refactor', 'projection']) {
    expect(texts(t)).toEqual(['Con merge=/mefisto:sequential 5', 'Solo PR=/mefisto:implement 5', 'Cancelar=null'])
  }
  expect(texts('tooling')).toEqual(['Con merge=/mefisto:sequential 5', 'Solo PR=/mefisto:tooling 5', 'Cancelar=null'])
  expect(texts('infra')).toEqual(['Solo PR=/mefisto:infra 5', 'Cancelar=null'])
  expect(planIssue(item(null)).kind).toBe('none')
  expect(planIssue(item('docs')).kind).toBe('none')
})

test('pie: teclas, infra y excluidos; fila sin prefijo', () => {
  const l = board({ infra: [9] })
  expect(footerRestOf(l, false)).toBe('infra: #9')
  expect(footerRestOf(l, true)).toBe(' · infra: #9')
  expect(rowText(l.items[0]!, 4, 20)).toBe('#7   A')
})

test('pie en reposo: sin `5-9 uno` ni bloqueados ni el menu de PRs', () => {
  const l = board({})
  expect(footerRestOf(l, true)).toBe('')
  expect(footerRestOf(board({ infra: [9] }), true)).not.toMatch(/5-9|bloqueados|PRs/)
})

test('launchCountOf cuenta los issues de la linea de lanzamiento', () => {
  expect(launchCountOf('/mefisto:sequential 7 8')).toBe(2)
  expect(launchCountOf(null)).toBe(0)
})

test('1 y 4 solo escriben o preguntan: planLaunch nunca envia', () => {
  for (const kind of ['sequential', 'parallel'] as const) {
    for (const infra of [[], [9]]) {
      const plan = planLaunch(board({ infra }), kind)
      expect(['fill', 'ask']).toContain(plan.kind)
      expect(plan.kind).not.toBe('submit')
    }
  }
})

test('lanzar: sin argumento es 1, un numero fuera de los lanzables lo dice', () => {
  const l = board()
  expect(parseLaunchArg('', l)).toEqual({ kind: 'launch', launch: 'sequential' })
  expect(parseLaunchArg(' parallel', l)).toEqual({ kind: 'launch', launch: 'parallel' })
  expect(parseLaunchArg('8', l)).toEqual({ kind: 'issue', issue: 8 })
  expect(parseLaunchArg('99', l).kind).toBe('invalid')
  expect(parseLaunchArg('x', l).kind).toBe('invalid')
})

test('roleOfAgent mapea el agente del stage al rol', () => {
  for (const a of ['test-writer', 'smoke-test-writer', 'coverage-gate']) expect(roleOfAgent(a)).toBe('tester')
  for (const a of ['implementer', 'writer', 'setup', 'scaffold', 'projection-implementer', '2-projection-implementer']) expect(roleOfAgent(a)).toBe('desarrollador')
  for (const a of ['reviewer', 'infra-reviewer']) expect(roleOfAgent(a)).toBe('revisor')
  expect(roleOfAgent('infra-writer')).toBe('infraestructura')
})

const runOf = (over: Record<string, unknown> = {}) =>
  parseStatus('pipeline-status-tdd-7.json', status({ updated: '2026-10-09T10:05:00', ...over }))!

test('activeRunOf elige la activa con updated mas reciente', () => {
  const a = runOf({ updated: '2026-10-09T10:05:00' })
  const b = parseStatus('pipeline-status-tooling-8.json', status({ pipeline: 'tooling', issue: 8, updated: '2026-10-09T10:09:00' }))!
  const done = parseStatus('pipeline-status-tdd-9.json', status({ issue: 9, state: 'failed', updated: '2026-10-09T10:11:00' }))!
  expect(activeRunOf([a, b, done])?.issue).toBe(8)
  expect(activeRunOf([done])).toBe(null)
})

test('ruta del events.jsonl por pipeline y el intento mas alto', () => {
  expect(eventsLogBase(runOf())).toBe('stage-3-implementer-2026-10-09T10:00:00-issue-7')
  const tooling = parseStatus('pipeline-status-tooling-8-b.json', status({ pipeline: 'tooling', issue: 8, variant: 'b', stage: '1-writer' }))!
  expect(eventsLogBase(tooling)).toBe('tooling-stage-1-writer-2026-10-09T10:00:00-issue-8-b')
  const infra = parseStatus('pipeline-status-infra-9.json', status({ pipeline: 'infra', issue: 9, stage: '1-infra-writer' }))!
  expect(eventsLogBase(infra)).toBe('iac-stage-1-infra-writer-2026-10-09T10:00:00-issue-9')
  const base = eventsLogBase(runOf())
  const names = [`${base}-attempt-1.events.jsonl`, `${base}-attempt-10.events.jsonl`, `${base}-attempt-2.events.jsonl`, `${base}-attempt-3.log`, 'otro.events.jsonl']
  expect(eventsFileOf(runOf(), names)).toBe(`${base}-attempt-10.events.jsonl`)
  expect(eventsFileOf(runOf(), ['otro'])).toBe(null)
})

test('lastEventOf toma el ultimo evento relevante', () => {
  const tool = '{"type":"tool.started","tool":"Edit"}'
  const text = '{"type":"message","role":"assistant","text":"hola"}'
  expect(lastEventOf(`${text}\n${tool}\n{"type":"tool.completed","ok":true}\nbasura\n`)).toEqual({ kind: 'tool', tool: 'Edit' })
  expect(lastEventOf(`${tool}\n${text}\n`)).toEqual({ kind: 'text', tool: '' })
  expect(lastEventOf('{"type":"message","role":"user","text":"x"}\n')).toBe(null)
  expect(lastEventOf('')).toBe(null)
})

test('poseOfRun sigue el ultimo evento, tambien en hold', () => {
  const tool = { kind: 'tool', tool: 'Bash' } as const
  const edit = { kind: 'tool', tool: 'Write' } as const
  const text = { kind: 'text', tool: '' } as const
  expect(poseOfRun(runOf(), tool)).toEqual({ role: 'desarrollador', state: 'trabajando' })
  expect(poseOfRun(runOf(), text)).toEqual({ role: 'desarrollador', state: 'pensando' })
  expect(poseOfRun(runOf(), null)).toEqual({ role: 'desarrollador', state: 'pensando' })
  expect(poseOfRun(runOf({ stage: '2-reviewer' }), edit)).toEqual({ role: 'revisor', state: 'corrigiendo' })
  expect(poseOfRun(runOf({ stage: '2-reviewer' }), tool)).toEqual({ role: 'revisor', state: 'trabajando' })
  expect(poseOfRun(runOf({ stage: '1-test-writer' }), edit)).toEqual({ role: 'tester', state: 'trabajando' })
  expect(poseOfRun(runOf({ stage: '1-infra-writer' }), text)).toEqual({ role: 'infraestructura', state: 'desplegando' })
  expect(poseOfRun(runOf({ state: 'hold' }), tool)).toEqual({ role: 'desarrollador', state: 'trabajando' })
})

test('poseOfResults: aprobado/error y variantes de infra', () => {
  const r = (pipeline: 'tdd' | 'infra', ok: boolean) => ({ key: 'k', issue: 1, pipeline, ok, text: '' })
  expect(poseOfResults([])).toBe(null)
  expect(poseOfResults([r('tdd', true)])).toEqual({ role: 'revisor', state: 'aprobado' })
  expect(poseOfResults([r('tdd', false)])).toEqual({ role: 'desarrollador', state: 'error' })
  expect(poseOfResults([r('infra', true)])).toEqual({ role: 'infraestructura', state: 'arriba' })
  expect(poseOfResults([r('infra', false)])).toEqual({ role: 'infraestructura', state: 'caido' })
})

const res = (issue: number, pr: number | null, pipeline: 'tdd' | 'infra' = 'tdd', ok = true) => ({
  key: `k${issue}`,
  issue,
  pipeline,
  ok,
  text: ok ? (pr ? `✓ PR #${pr}` : '✓ completado') : '✗ 1-writer',
})

test('resultPrs: solo ✓ con PR, sin repetir, del mas reciente al mas antiguo', () => {
  expect(prOfResult(res(1, 7))).toBe('7')
  expect(prOfResult(res(1, null))).toBe(null)
  expect(prOfResult(res(1, null, 'tdd', false))).toBe(null)
  const prs = resultPrs([res(1, 7), res(2, 9), res(3, null), res(4, 5, 'tdd', false), res(5, 7)])
  expect(prs.map(p => p.pr)).toEqual(['9', '7'])
})

test('mergeArgsOf: un PR, varios, "Todos" y texto libre; nunca --all', () => {
  const one = resultPrs([res(1, 7)])
  expect(mergeOptions(one)).toEqual(['Mergear #7', 'Cancelar'])
  expect(mergeArgsOf('Mergear #7', mergeOptions(one), one)).toBe('7')
  expect(mergeArgsOf('Cancelar', mergeOptions(one), one)).toBe(null)

  const many = resultPrs([res(1, 5), res(2, 6), res(3, 7), res(4, 8), res(5, 9)])
  const options = mergeOptions(many)
  expect(options).toHaveLength(4)
  expect(options[0]).toBe('Todos')
  expect(mergeArgsOf('Todos', options, many)).toBe('9 8 7 6 5')
  expect(mergeArgsOf(`${options[1]}, ${options[3]}`, options, many)).toBe('9 7')
  expect(mergeArgsOf('5, 99', options, many)).toBe('5')
  expect(mergeArgsOf(`${options[2]}, 5`, options, many)).toBe('8 5')
  expect(mergeArgsOf('99', options, many)).toBe(null)
  expect(mergeArgsOf('', options, many)).toBe(null)
  expect(mergeArgsOf(null, options, many)).toBe(null)
  expect(mergeArgsOf('Todos', options, many)).not.toContain('--all')
})

test('viewPrOf y parsePrArgs: solo numeros de ✓ conocidos', () => {
  const prs = resultPrs([res(1, 7), res(2, 9)])
  expect(viewPrOf('#9 · #2 tdd', prs)).toBe('9')
  expect(viewPrOf('7', prs)).toBe('7')
  expect(viewPrOf('55', prs)).toBe(null)
  expect(viewPrOf(null, prs)).toBe(null)
  expect(parsePrArgs('7 #9 55 7', prs)).toEqual({ prs: ['7', '9'], invalid: ['55'] })
})

test('mergeToast: en infra avisa que el issue lo cierra el apply de CI', () => {
  const prs = resultPrs([res(1, 7), res(2, 9, 'infra')])
  expect(mergeToast('7', prs)).toBe('/mefisto:merge 7 en cola')
  expect(mergeToast('7 9', prs)).toContain('apply de CI')
})

test('parseOpenPrs: conserva field notes y descarta borradores; el mas reciente primero', () => {
  const raw = JSON.stringify([
    { number: 5, title: 'A', isDraft: false, headRefName: 'worktree-issue-5-a' },
    { number: 9, title: 'B', isDraft: false, headRefName: 'docs/bitacora-hasta-2026-10-08' },
    { number: 8, title: 'Borrador', isDraft: true, headRefName: 'x' },
    { number: 7, title: 'Nota', isDraft: false, headRefName: 'docs/planner-field-notes-abc' },
  ])
  expect(parseOpenPrs(raw)).toEqual([
    { number: '9', title: 'B', isFieldNote: false },
    { number: '7', title: 'Nota', isFieldNote: true },
    { number: '5', title: 'A', isFieldNote: false },
  ])
  expect(parseOpenPrs('no json')).toEqual([])
  expect(parseOpenPrs('{}')).toEqual([])
})

test('openPrArgsOf: uno, varios, "Todos" (--all) y texto libre', () => {
  const one = [{ number: '7', title: 'X', isFieldNote: false }]
  expect(openPrOptions(one)).toEqual(['#7 X', 'Cancelar'])
  expect(openPrArgsOf('#7 X', openPrOptions(one), one)).toBe('7')
  expect(openPrArgsOf('Cancelar', openPrOptions(one), one)).toBe(null)

  const many = [9, 8, 7, 6, 5].map(n => ({ number: String(n), title: `T${n}`, isFieldNote: false }))
  const options = openPrOptions(many)
  expect(options).toEqual(['Todos', '#9 T9', '#8 T8', '#7 T7'])
  expect(openPrArgsOf('Todos', options, many)).toBe('--all')
  expect(openPrArgsOf('#9 T9, #7 T7', options, many)).toBe('9 7')
  expect(openPrArgsOf('#8 T8, 5, 99', options, many)).toBe('8 5')
  expect(openPrArgsOf('99', options, many)).toBe(null)
  expect(openPrArgsOf(null, options, many)).toBe(null)
})

// ---- Incremento 7: lote ----
const batchRaw = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    pipeline: 'sequential',
    started: '2026-10-09T10:00:00',
    state: 'running',
    current: 13,
    stop_requested: false,
    hold_seconds: 0,
    log: 'x.log',
    issues: [
      { issue: 12, status: 'mergeado', pr: '#101', detail: '' },
      { issue: 13, status: 'en-curso', pr: null, detail: '' },
      { issue: 14, status: 'pendiente', pr: null, detail: '' },
    ],
    ...over,
  })
const batchNow = Date.parse('2026-10-09T10:07:30')

test('parseBatchStatus lee un lote running y calcula cabecera, cola y avance', () => {
  const b = parseBatchStatus(batchRaw())!
  expect(b.state).toBe('running')
  expect(b.current).toBe(13)
  expect(b.issues[0]?.pr).toBe('101')
  expect(batchQueueText(b)).toBe('✓ #12 ─ ● #13 ─ ○ #14')
  expect(batchQueueText(b, 'reviewer')).toBe('✓ #12 ─ ● #13 reviewer ─ ○ #14')
  expect(batchQueueMarks(b, 'reviewer').map(m => m.color)).toEqual(['success', 'warning', undefined])
  expect(canStopBatch(b)).toBe(true)
})

test('parseBatchStatus con stop_requested dice se detiene tras #N y no ofrece 1', () => {
  const b = parseBatchStatus(batchRaw({ stop_requested: true }))!
  expect(batchRunningHeader(b, batchNow).stopNote).toBe('se detiene tras #13')
  expect(canStopBatch(b)).toBe(false)
})

test('parseBatchStatus completed con fallidos y saltados: conteos y resumen', () => {
  const b = parseBatchStatus(
    batchRaw({
      state: 'completed',
      current: null,
      hold_seconds: 600,
      issues: [
        { issue: 1, status: 'mergeado', pr: 5 },
        { issue: 2, status: 'fallido', pr: null, detail: 'review' },
        { issue: 3, status: 'saltado', pr: null, detail: 'infra' },
        { issue: 4, status: 'aplazado', pr: null },
      ],
    }),
  )!
  expect(batchCounts(b)).toEqual({ merged: 1, failed: 1, deferred: 1, skipped: 1, total: 4 })
  expect(canStopBatch(b)).toBe(false)
})

test('parseBatchStatus stopped y entradas invalidas', () => {
  expect(parseBatchStatus(batchRaw({ state: 'stopped' }))?.state).toBe('stopped')
  expect(parseBatchStatus('no json')).toBe(null)
  expect(parseBatchStatus(batchRaw({ state: 'raro' }))).toBe(null)
  expect(parseBatchStatus('[]')).toBe(null)
})

test('batchPrOf: PR del eslabon en curso o del ultimo mergeado; sin PR, null', () => {
  expect(batchPrOf(parseBatchStatus(batchRaw())!)).toBe('101')
  const own = parseBatchStatus(
    batchRaw({ issues: [{ issue: 12, status: 'mergeado', pr: 101 }, { issue: 13, status: 'en-curso', pr: 102 }] }),
  )!
  expect(batchPrOf(own)).toBe('102')
  expect(batchPrOf(parseBatchStatus(batchRaw({ issues: [{ issue: 13, status: 'en-curso' }] }))!)).toBe(null)
})

test('newlyMerged solo anuncia las transiciones a mergeado', () => {
  const a = parseBatchStatus(batchRaw())!
  const b = parseBatchStatus(
    batchRaw({ issues: [{ issue: 12, status: 'mergeado' }, { issue: 13, status: 'mergeado', pr: 7 }, { issue: 14, status: 'en-curso' }] }),
  )!
  expect(newlyMerged(a.issues, b.issues).map(i => i.issue)).toEqual([13])
  expect(newlyMerged(null, b.issues)).toEqual([])
})

test('batchRunOf: corrida suelta del eslabon en curso', () => {
  const b = parseBatchStatus(batchRaw())!
  const mk = (issue: number): ReturnType<typeof parseStatus> =>
    parseStatus(`pipeline-status-tdd-${issue}.json`, JSON.stringify({ issue, started: '20261009-100000', updated: '20261009-100100', stage: '2-implementer', state: 'running' }))
  const runs = [mk(13)!, mk(40)!]
  expect(batchRunOf(b, runs)?.issue).toBe(13)
})

test('senal de parada en la raiz del checkout principal y clave de descarte por repo + started', () => {
  expect(batchStopPath('/r/')).toBe('/r/pipeline-state/batch-stop')
  expect(batchDismissKey('/r', parseBatchStatus(batchRaw())!)).toBe('/r|batch|2026-10-09T10:00:00')
})

test('bandViewOf: las corridas toman la banda solo con una activa', () => {
  const active = parseStatus('pipeline-status-tdd-7.json', status())!
  const failed = parseStatus('pipeline-status-tdd-8.json', status({ state: 'failed', stage: '2-infra-reviewer' }))!
  const res = [{ key: 'k', issue: 8, pipeline: 'tdd', ok: false, text: '✗ setup' }]
  expect(bandViewOf([active], [])).toBe('runs')
  expect(bandViewOf([active], res)).toBe('runs')
  expect(bandViewOf([], res)).toBe('ready-with-results')
  expect(bandViewOf([failed], [])).toBe('ready')
  expect(bandViewOf([], [])).toBe('ready')
})

test('resultsFooterText: formato, recorte al ancho y +N', () => {
  const res = [
    { key: 'a', issue: 7, pipeline: 'tdd', ok: true, text: '✓ PR #55' },
    { key: 'b', issue: 413, pipeline: 'infra', ok: false, text: '✗ 2-infra-reviewer' },
    { key: 'c', issue: 99, pipeline: 'tooling', ok: false, text: '✗ setup' },
  ]
  expect(resultsFooterText(res, 200)).toBe('resultados: ✓#7 PR #55 · ✗#413 2-infra-reviewer · ✗#99 setup')
  expect(resultsFooterText(res, 45)).toBe('resultados: ✓#7 PR #55 +2')
  expect(resultsFooterText(res, 45).length).toBeLessThanOrEqual(45)
})

test('batchSummaryMarks lleva marcas y omite lo que esta en cero', () => {
  const b = parseBatchStatus(JSON.stringify({ state: 'stopped', started: '20260101-000000', hold_seconds: 600, issues: [
    { issue: 1, status: 'mergeado', pr: 5 }, { issue: 2, status: 'fallido' }, { issue: 3, status: 'aplazado' },
  ] })) as BatchStatus
  expect(batchSummaryMarks(b)).toBe('✓ 1 mergeados · ✗ 1 fallidos · ⏸ 1 aplazados · espera 10m')
  const ok = parseBatchStatus(JSON.stringify({ state: 'completed', issues: [{ issue: 1, status: 'mergeado' }] })) as BatchStatus
  expect(batchSummaryMarks(ok)).toBe('✓ 1 mergeados')
  expect(batchEndLabel('completed')).toBe('terminado')
  expect(batchEndLabel('stopped')).toBe('detenido')
  expect(batchEndLabel('failed')).toBe('con fallos')
})

const histLine = (o: Record<string, unknown>) => JSON.stringify({ pipeline: 'tdd', started: '20260101-100000', finished: '2026-01-01T10:10:00', ...o })

test('issueStatsFromHistory lee duracion y costo de los pipelines publicados desde el inicio del lote', () => {
  const raw = [
    histLine({ issue: '7', title: 'Uno', agents: { a: { metrics: { estimated_cost_usd: 1.5 } }, b: { metrics: { estimated_cost_usd: 0.25 } } } }),
    histLine({ issue: '8', pipeline: 'tooling', started: '20260101-102000', finished: '2026-01-01T10:21:00' }),
    histLine({ issue: '9', pipeline: 'mefisto-tooling' }),
    histLine({ issue: '10', started: '20251231-100000' }),
    'no es json',
  ].join('\n')
  const since = stampToMs('20260101-095900')
  const out = issueStatsFromHistory(raw, ['7', '8', '9', '10'], since)
  expect(out['7']).toMatchObject({ durationMs: 600_000, costUsd: 1.75, title: 'Uno' })
  expect(out['8']).toMatchObject({ durationMs: 60_000, costUsd: null, title: null })
  expect(out['9']).toBeUndefined()
  expect(out['10']).toBeUndefined()
  expect(statsPending(['7', '8', '11'], out)).toEqual(['8', '11'])
})

test('closeRowText, closeTotalText y statsTotal arman la tabla de cierre', () => {
  const i = { issue: 853, status: 'mergeado' as const, pr: '949', detail: '' }
  const st = { durationMs: 76_000, costUsd: 4.21, title: 'Listar los dias', finishedMs: 0 }
  const row = closeRowText(i, st, 20)
  expect(row.lead).toBe(`#853    ${'Listar los dias'.padEnd(20)} PR #949    `)
  expect(row.trail).toBe('01:16    $4.21')
  expect(closeRowText({ ...i, pr: null }, undefined, 0)).toEqual({ lead: '#853    sin PR     ', trail: '…' })
  const total = statsTotal([st, { ...st, durationMs: 4000, costUsd: null }])
  expect(total).toMatchObject({ durationMs: 80_000, costUsd: 4.21 })
  expect(closeTotalText(2, total, 20)).toBe(`  total ${'2'.padEnd(33)} 01:20    $4.21`)
  expect(fmtCost(null)).toBe('$?')
  expect(batchEndFromStats({ a: st, b: { ...st, finishedMs: 5 } })).toBe(5)
  expect(batchEndFromStats({})).toBeNull()
})

const ribbon = (finishedMs: number | null = null) => ({ prs: mergePrsOf('12 13', [{ number: '12', title: 'Uno' }]), startedMs: 0, finishedMs })

test('mergeRunArgsOf reconoce un merge de pr-sync.sh y devuelve sus PRs o --all', () => {
  const script = 'MEFISTO_RUNTIME=claude "/x/mefisto/0.46.3/scripts/pr-sync.sh"'
  expect(mergeRunArgsOf(`${script} 12 13 --merge`)).toBe('12 13')
  expect(mergeRunArgsOf(`${script} --all --merge`)).toBe('--all')
  expect(mergeRunArgsOf(`${script} 12`)).toBeNull()
  expect(mergeRunArgsOf('gh pr list --merge 12')).toBeNull()
  expect(mergeRunArgsOf(`${script} 12 --merge && echo ok`)).toBe('12')
})

test('mergePrsOf toma los numeros de los argumentos o los abiertos con --all', () => {
  const open = [{ number: '5', title: 'Cinco' }, { number: '6', title: 'Seis' }]
  expect(mergePrsOf('6 6 7', open).map(p => `${p.num}:${p.title}`)).toEqual(['6:Seis', '7:'])
  expect(mergePrsOf('--all', open).map(p => p.num)).toEqual(['5', '6'])
})

test('la cinta pasa un PR MERGED a mergeado y no vuelve atras', () => {
  const r = withMerged(ribbon(), ['12'])
  expect(r.prs.map(p => p.estado)).toEqual(['mergeado', 'pendiente'])
  expect(mergeRibbonRows(r).map(p => p.num)).toEqual(['13', '12'])
  expect(mergeRibbonHeader(r, 0).startsWith('merge 1/2')).toBe(true)
  expect(withMerged(r, ['12'])).toBe(r)
  expect(withMerged(r, ['99'])).toBe(r)
})

test('al terminar el turno los pendientes quedan fallidos y se resume', () => {
  const done = finishMerge(withMerged(ribbon(), ['12']), 1000)
  expect(done.prs.map(p => p.estado)).toEqual(['mergeado', 'fallido'])
  expect(done.finishedMs).toBe(1000)
  expect(mergeSummaryText(done)).toBe('1 mergeados · 1 fallidos')
  expect(finishMerge(done, 2000)).toBe(done)
  expect(mergeRibbonLine(done.prs[1]!, 40)).toBe('✗ #13 · no mergeado')
  expect(mergeRibbonLine(ribbon().prs[0]!, 40)).toBe('· #12 Uno')
})

test('la cinta terminada vence a los 15 s y una en curso nunca', () => {
  expect(isMergeRibbonExpired(ribbon(1000), 1000 + 15_001)).toBe(true)
  expect(isMergeRibbonExpired(ribbon(1000), 1000 + 15_000)).toBe(false)
  expect(isMergeRibbonExpired(ribbon(null), 10_000_000)).toBe(false)
  expect(isMergeRibbonExpired(null, 1)).toBe(false)
})

test('el lote de sequential ocupa la banda antes que la cinta de merge', () => {
  const batch = { pipeline: 'sequential', started: '', state: 'running', current: null, stopRequested: false, holdSeconds: 0, issues: [] } as never
  expect(mergeRibbonShown(batch, ribbon(), 0)).toBeNull()
  expect(mergeRibbonShown(null, ribbon(), 0)).not.toBeNull()
  expect(mergeRibbonShown(null, ribbon(1000), 1000 + 20_000)).toBeNull()
})

// ---- Incremento 9: la bitacora ----

test('bitacoraCount: field notes de main mas PRs de field notes; PRs N cuenta todos los abiertos', () => {
  const raw = JSON.stringify([
    ...[948, 947, 946, 945, 944, 943, 942, 941, 933].map(n => ({ number: n, title: 'nota', isDraft: false, headRefName: `docs/planner-field-notes-${n}` })),
    { number: 900, title: 'trabajo', isDraft: false, headRefName: 'worktree-issue-900-x' },
    { number: 950, title: 'borrador', isDraft: true, headRefName: 'docs/planner-field-notes-950' },
  ])
  const prs = parseOpenPrs(raw)
  expect(fieldNotesIn(['a.md', 'b.md', 'c.md', 'd.md', 'procesadas'])).toBe(4)
  expect(bitacoraCount(4, prs)).toBe(13)
  expect(prs.length).toBe(10)
  expect(openPrOptions(prs)).toEqual(['Todos', '#948 nota', '#947 nota', '#946 nota'])
  expect(bitacoraCount(0, [{ number: '900', title: 'trabajo', isFieldNote: false }])).toBe(0)
  expect(bitacoraCount(null, [])).toBe(0)
})

test('bitacoraPrompt: mergea los PRs de field notes, trae main y corre /mefisto:bitacora', () => {
  expect(bitacoraPrompt(['948', '933'])).toBe(
    'Integra la bitacora: mergea los PRs de field notes #948 #933 con /mefisto:merge, pon el checkout en main al dia (git switch main && git pull --ff-only) y luego corre /mefisto:bitacora.',
  )
  expect(bitacoraPrompt([])).toBe(
    'Integra la bitacora: pon el checkout en main al dia (git switch main && git pull --ff-only) y luego corre /mefisto:bitacora.',
  )
})

test('isHistorianType: con o sin el prefijo del plugin', () => {
  expect(isHistorianType('mefisto:historiador')).toBe(true)
  expect(isHistorianType('historiador')).toBe(true)
  expect(isHistorianType('mefisto:historiador-x')).toBe(false)
})

test('notas: pasan de pendiente a procesada al aparecer en procesadas/ y se ordenan pendientes primero', () => {
  const names = fieldNoteNamesOf(['b.md', 'a.md', 'procesadas'], ['docs/bitacora/field-notes/c.md', 'docs/bitacora/field-notes/a.md', 'src/x.md'])
  expect(names).toEqual(['a.md', 'b.md', 'c.md'])
  const h = { notes: pendingNotes(names) }
  const next = withProcessedNotes(h, ['a.md', 'zzz.md'])
  expect(next.notes.map(n => n.estado)).toEqual(['procesada', 'pendiente', 'pendiente'])
  expect(withProcessedNotes(next, ['zzz.md'])).toBe(next)
  expect(orderedNotes(next.notes).map(n => n.name)).toEqual(['b.md', 'c.md', 'a.md'])
})

test('historianFrom y liveHistorian: arranca, termina y se va a los 8 s salvo con PR', () => {
  const started = historianFrom(null, true, 1000)
  expect(started).toEqual({ startedMs: 1000, finishedMs: null, notes: [], pr: null })
  expect(historianFrom(started, true, 2000)).toBe(started)
  const done = historianFrom(started, false, 5000)!
  expect(done.finishedMs).toBe(5000)
  expect(liveHistorian(done, 12_000)).toBe(done)
  expect(liveHistorian(done, 13_001)).toBe(null)
  const withPr = { ...done, pr: { number: 7, title: 'bitacora' } }
  expect(liveHistorian(withPr, 999_999)).toBe(withPr)
})

test('bitacoraPrOf: excluye ramas de field notes y PRs que tocan algo fuera de docs/bitacora/', () => {
  const rows = [
    { number: 10, title: 'notas', headRefName: 'docs/planner-field-notes-abc', files: [{ path: 'docs/bitacora/field-notes/x.md' }] },
    { number: 11, title: 'mezcla', headRefName: 'docs/otra', files: [{ path: 'docs/bitacora/a.md' }, { path: 'src/x.cs' }] },
    { number: 12, title: 'bitacora vieja', headRefName: 'docs/bitacora-1', files: [{ path: 'docs/bitacora/a.md' }] },
    { number: 13, title: 'bitacora', headRefName: 'docs/bitacora-2', files: [{ path: 'docs/bitacora/b.md' }] },
    { number: 14, title: 'sin archivos', headRefName: 'docs/vacio', files: [] },
  ]
  expect(bitacoraPrOf(JSON.stringify(rows))).toEqual({ number: 13, title: 'bitacora' })
  expect(bitacoraPrOf(JSON.stringify(rows.slice(0, 2)))).toBe(null)
  expect(bitacoraPrOf('no json')).toBe(null)
})

test('roleOfAgent decide por sufijo e ignora el prefijo del stage', () => {
  expect(roleOfAgent('projection-test-writer')).toBe('tester')
  expect(roleOfAgent('1-projection-test-writer')).toBe('tester')
  expect(roleOfAgent('projection-implementer')).toBe('desarrollador')
  expect(roleOfAgent('2-reviewer')).toBe('revisor')
  expect(roleOfAgent('tooling-reviewer')).toBe('revisor')
  expect(roleOfAgent('infra-writer')).toBe('infraestructura')
})

const AGENTS = {
  'test-writer': { duration: 102, result: 'passed' },
  implementer: { duration: null, result: 'running' },
  'smoke-test-writer': { duration: null, result: '' },
  reviewer: { duration: null, result: 'failed' },
  'coverage-gate': { duration: null, result: 'otra-cosa' },
}

test('stepsOfAgents / stepsOf: la fila de pasos sale de status.agents en su orden', () => {
  const raw = JSON.stringify({ issue: '853', stage: '2-implementer', state: 'running', agents: AGENTS, log: '/x/log.txt', title: 'Proyeccion' })
  const run = parseStatus('pipeline-status-tdd-853.json', raw)!
  expect(run.title).toBe('Proyeccion')
  expect(run.log).toBe('/x/log.txt')
  expect(stepsOfAgents(AGENTS).map(s => s.result)).toEqual(['passed', 'running', 'pending', 'failed', 'pending'])
  expect(stepsOf(run).map(s => [s.mark, s.color, s.dim])).toEqual([
    ['✓', 'success', false],
    ['●', 'warning', false],
    ['○', undefined, true],
    ['✗', 'error', false],
    ['○', undefined, true],
  ])
  expect(stepsText(run)).toBe('✓ test-writer ─ ● implementer ─ ○ smoke-test-writer ─ ✗ reviewer ─ ○ coverage-gate')
  expect(stepsOfAgents(undefined)).toEqual([])
})

test('runHeader: corrida suelta y lote', () => {
  const run = parseStatus('pipeline-status-tdd-853.json', JSON.stringify({ stage: '2-projection-implementer', state: 'running', started: '20261011-100000' }))!
  const now = new Date(2026, 9, 11, 10, 3, 30).getTime()
  expect(runHeader(run, now)).toBe('#853 projection-implementer 3m')
})

test('batchRunningHeader: M/N, tiempo y parada pedida', () => {
  const b = parseBatchStatus(batchRaw())!
  const h = batchRunningHeader(b, batchNow)
  expect(h.progress).toBe('sequential 1/3')
  expect(h.time).toBe('07:30')
  expect(h.stopNote).toBe('')
  expect(batchRunningHeader({ ...b, started: '20261009-080000' }, batchNow).time).toBe('2:07:30')
  expect(batchRunningHeader({ ...b, started: '' }, batchNow).time).toBe('')
  expect(batchRunningHeader({ ...b, stopRequested: true }, batchNow).stopNote).toBe('se detiene tras #13')
  const mixed = parseBatchStatus(batchRaw({ issues: [{ issue: 12, status: 'mergeado' }, { issue: 13, status: 'fallido' }, { issue: 14, status: 'en-curso' }] }))!
  expect(batchRunningHeader(mixed, batchNow).progress).toBe('sequential 2/3')
})

test('batchQueueText: aplazado, fallido y el paso solo en el issue en curso', () => {
  const b = parseBatchStatus(batchRaw({ current: 14, issues: [{ issue: 12, status: 'fallido' }, { issue: 13, status: 'aplazado' }, { issue: 14, status: 'en-curso' }] }))!
  expect(batchQueueText(b, 'implementer')).toBe('✗ #12 ─ ⏸ #13 ─ ● #14 implementer')
  expect(batchQueueMarks(b).map(m => m.color)).toEqual(['error', undefined, 'warning'])
})

test('batchHoldLine: solo con el eslabon en hold', () => {
  const mk = (state: string) => parseStatus('pipeline-status-tdd-13.json', JSON.stringify({ stage: '2-implementer', state, started: '20261009-100000', hold: { next_probe: '2026-10-09T10:20:00' } }))!
  expect(batchHoldLine(mk('hold'))).toBe('en espera por rate limit · próxima sonda 10:20')
  expect(batchHoldLine(mk('running'))).toBe('')
  expect(batchHoldLine(null)).toBe('')
})

test('recentLines: solo lineas con hora, formato HH:MM:SS y color por tipo', () => {
  const lines = ['── Stage 3: Reviewer ──', 'sin hora', '[11:50:53] Invocando reviewer (modelo: opus)...', '11:51:11 Bash', '[11:52:00] ✓ listo', '[11:53:00] ERROR boom']
  expect(recentLines(lines)).toEqual([
    { ts: '11:51:11', text: 'Bash', color: undefined },
    { ts: '11:52:00', text: '✓ listo', color: 'success' },
    { ts: '11:53:00', text: 'ERROR boom', color: 'error' },
  ])
  expect(recentLines(lines, 4)[0]).toEqual({ ts: '11:50:53', text: 'Invocando reviewer (modelo: opus)...', color: 'claude' })
  expect(recentLines(['✓ sin hora', 'success · 12 turnos'])).toEqual([])
})

test('recentLineColor: fallo, exito (incluido `<agente> completado`), inicio y resto sin color', () => {
  expect(recentLineColor('reviewer completado en 312s')).toBe('success')
  expect(recentLineColor('Error al crear el PR')).toBe('error')
  expect(recentLineColor('Invocando implementer (modelo: sonnet)...')).toBe('claude')
  expect(recentLineColor('Haciendo push de la rama...')).toBe(undefined)
})

test('logTailLines: ultimas lineas utiles sin ANSI', () => {
  const raw = '\u001b[32mFase roja confirmada\u001b[0m\n\n-----\nInvocando projection-implementer…\n  \nlinea 3\nlinea 4\n'
  expect(logTailLines(raw)).toEqual(['Invocando projection-implementer…', 'linea 3', 'linea 4'])
  expect(logTailLines(raw, 5)[0]).toBe('Fase roja confirmada')
})

test('eventLineOf: ultimo evento como linea', () => {
  const tool = JSON.stringify({ type: 'tool.started', ts: '2026-10-11T15:04:05Z', tool: 'Edit', input_summary: null })
  expect(eventLineOf(`${tool}\n${JSON.stringify({ type: 'tool.completed', tool: 'Edit' })}\n`)).toMatch(/^\d\d:\d\d:\d\d Edit$/)
  const done = JSON.stringify({ type: 'run.completed', status: 'success', turns: 7, estimated_cost_usd: 0.1417 })
  expect(eventLineOf(`${tool}\n${done}\n`)).toBe('success · 7 turnos · $0.14')
  expect(eventLineOf('')).toBe(null)
  expect(bandLinesOf(['a', 'b', 'c'], 'x', 3)).toEqual(['b', 'c', 'x'])
  expect(bandLinesOf(['a'], null)).toEqual(['a'])
})

test('isPipelineLaunch: detecta el lanzamiento de pipelines en un comando Bash', () => {
  expect(isPipelineLaunch('bash "${CLAUDE_PLUGIN_ROOT}/scripts/batch-pipeline.sh" 853')).toBe(true)
  expect(isPipelineLaunch('scripts/tdd-pipeline.sh 853 --verbose')).toBe(true)
  expect(isPipelineLaunch('cd x && ./scripts/tooling-pipeline.sh 12')).toBe(true)
  expect(isPipelineLaunch('scripts/launch-pipeline.sh 1 2')).toBe(true)
  expect(isPipelineLaunch('MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/launch-pipeline.sh" --batch 1 2')).toBe(true)
  expect(isPipelineLaunch('scripts/iac-pipeline.sh 9')).toBe(true)
  expect(isPipelineLaunch('scripts/pr-sync.sh 12 --merge')).toBe(false)
  expect(isPipelineLaunch('cat scripts/tdd-pipeline.sh.bak')).toBe(false)
  expect(isPipelineLaunch(undefined)).toBe(false)
})

test('parseEvent: eventos redactados reales (sin message, input_summary null)', () => {
  expect(parseEvent(JSON.stringify({ type: 'run.started', agent: 'implementer', model: 'sonnet' }))).toEqual({ kind: 'start', text: '\u2500\u2500 implementer \u00b7 sonnet \u2500\u2500' })
  const tool = parseEvent(JSON.stringify({ type: 'tool.started', ts: '2026-10-11T15:04:05Z', tool: 'Edit', input_summary: null }))
  expect(tool?.kind).toBe('tool')
  expect(tool?.text).toMatch(/^\d\d:\d\d:\d\d Edit$/)
  expect(parseEvent(JSON.stringify({ type: 'tool.completed', tool: 'Edit', ok: true }))).toBe(null)
  const failed = parseEvent(JSON.stringify({ type: 'tool.completed', ts: '2026-10-11T15:04:06Z', tool: 'Bash', ok: false }))
  expect(failed?.kind).toBe('fail')
  expect(failed?.text).toMatch(/^\d\d:\d\d:\d\d Bash fall\u00f3$/)
  expect(parseEvent(JSON.stringify({ type: 'run.completed', status: 'success', turns: 7, estimated_cost_usd: 0.1417 }))).toEqual({ kind: 'done', text: 'success \u00b7 7 turnos \u00b7 $0.14' })
  expect(parseEvent(JSON.stringify({ type: 'run.failed', error: 'timeout' }))).toEqual({ kind: 'fail', text: 'timeout' })
  expect(parseEvent(JSON.stringify({ type: 'message', role: 'assistant' }))).toBe(null)
  expect(parseEvent('no json')).toBe(null)
})

test('cleanLogLine: sin ANSI ni lineas vacias', () => {
  expect(cleanLogLine('\u001b[32mFase roja confirmada\u001b[0m\r')).toBe('Fase roja confirmada')
  expect(cleanLogLine('-----')).toBe(null)
  expect(cleanLogLine('   ')).toBe(null)
})

test('followTargetsOf: events.jsonl del intento vigente y log de la corrida o del lote', () => {
  const run = parseStatus('pipeline-status-tdd-853.json', JSON.stringify({ issue: 853, pipeline: 'tdd', started: '20261011-150000', stage: '1-test-writer', state: 'running', log: '.mefisto/pipeline/logs/pipeline-1.log' }))!
  const base = eventsLogBase(run)
  const names = [`${base}-attempt-1.events.jsonl`, `${base}-attempt-2.events.jsonl`, `${base}-attempt-2.log`]
  const solo = followTargetsOf(run, null, names, '/repo/')
  expect(solo.events).toBe(`/repo/.mefisto/pipeline/logs/${base}-attempt-2.events.jsonl`)
  expect(solo.log).toBe('/repo/.mefisto/pipeline/logs/pipeline-1.log')
  const batch = parseBatchStatus(JSON.stringify({ state: 'running', current: 853, log: '/abs/batch-1.log', issues: [{ issue: 853, status: 'en-curso' }] }))!
  expect(followTargetsOf(run, batch, names, '/repo').log).toBe('/abs/batch-1.log')
  expect(followTargetsOf(null, batch, [], '/repo')).toEqual({ events: null, log: '/abs/batch-1.log' })
  expect(followTargetsOf(run, null, [], '/repo').events).toBe(null)
})

test('pane: cabecera, duraciones, separador y tope de lineas', () => {
  const run = parseStatus('pipeline-status-tdd-853.json', JSON.stringify({ issue: 853, pipeline: 'tdd', started: '20261011-150000', stage: '1-x', state: 'running', agents: { x: { result: 'passed', duration: 185 } } }))!
  expect(run.agents?.[0]?.duration).toBe(185)
  expect(paneHeaderOf(run, null)).toBe('mefisto \u00b7 #853 tdd')
  const batch = parseBatchStatus(JSON.stringify({ state: 'running', current: 853, issues: [{ issue: 852, status: 'mergeado' }, { issue: 853, status: 'en-curso' }] }))!
  expect(paneHeaderOf(run, batch)).toBe('mefisto \u00b7 sequential 1/2 \u00b7 #853 tdd')
  expect(durationText(185)).toBe('3m')
  expect(durationText(45)).toBe('45s')
  expect(durationText(undefined)).toBe('')
  expect(batchSeparator(853).text).toBe('\u2550\u2550 #853 \u2550\u2550')
  const many = Array.from({ length: 5 }, (_, i) => ({ kind: 'log' as const, text: `l${i}` }))
  expect(mergePaneLines(many, [{ kind: 'log', text: 'z' }], 3).map(l => l.text)).toEqual(['l3', 'l4', 'z'])
})

test('poseOfBatch: cada estado del lote tiene sprite, y el terminado es el revisor aprobado', () => {
  const batch = (state: 'running' | 'completed' | 'failed' | 'stopped') =>
    ({ pipeline: 'tdd', started: '', state, current: null, stopRequested: false, holdSeconds: 0, issues: [], log: null }) as never
  expect(poseOfBatch(batch('completed'))).toEqual({ role: 'revisor', state: 'aprobado' })
  expect(poseOfBatch(batch('failed'))).toEqual({ role: 'desarrollador', state: 'error' })
  expect(poseOfBatch(batch('running'))).toEqual({ role: 'desarrollador', state: 'pensando' })
  for (const state of ['running', 'completed', 'failed', 'stopped'] as const) {
    const pose = poseOfBatch(batch(state))
    expect(() => sprite(pose.role, pose.state, 0)).not.toThrow()
  }
})

test('runningRowText y totalWithRunning arman la fila en curso de la tabla', () => {
  const started = stampToMs('20260101-120000')
  const now = started + 83_000
  expect(runningRowText(900, null, 'Mostrar tabla', started, now, 20)).toEqual({
    lead: `#900    ${'Mostrar tabla'.padEnd(20)} ${'…'.padEnd(10)} `,
    trail: '01:23    …',
  })
  expect(runningRowText(900, '951', null, started, now, 0).lead).toBe('#900    PR #951    ')
  expect(runningRowText(900, null, null, 0, now, 0).trail).toBe('…        …')
  const total = statsTotal([{ durationMs: 76_000, costUsd: 4.21, title: null, finishedMs: 0 }])
  const withRun = totalWithRunning(total, started, now)
  expect(withRun).toMatchObject({ durationMs: 159_000, costUsd: 4.21 })
  expect(closeTotalText(2, withRun, 0)).toContain('02:39')
  expect(totalWithRunning(total, 0, now)).toBe(total)
})

test('nextCurrentRow: corrida activa del eslabon y, al esperar su merge, tiempo congelado', () => {
  const b = parseBatchStatus(batchRaw())!
  const live = parseStatus('pipeline-status-tdd-13.json', JSON.stringify({ issue: 13, started: '20261009-100000', updated: '2026-10-09T10:01:00', stage: '2-implementer', state: 'running' }))!
  const row = nextCurrentRow(b, live, null, 1_000)
  expect(row).toEqual({ run: live, endMs: null })
  const frozen = nextCurrentRow(b, null, row, 5_000)
  expect(frozen).toEqual({ run: live, endMs: 5_000 })
  expect(nextCurrentRow(b, null, frozen, 9_000)).toBe(frozen)
  const other = parseStatus('pipeline-status-tdd-40.json', JSON.stringify({ issue: 40, started: '20261009-100000', stage: '2-implementer', state: 'running' }))!
  expect(nextCurrentRow(b, null, { run: other, endMs: null }, 5_000)).toBeNull()
  expect(nextCurrentRow(parseBatchStatus(batchRaw({ state: 'completed' }))!, live, row, 5_000)).toBeNull()
})

// ---- Lote parallel (#2449) ----

const parallelRaw = (state: string, issues: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ pipeline: 'parallel', started: '20260101-120000', state, stop_requested: false, log: '/x/l.log', issues, ...extra })
const pIssue = (issue: number, status: string, extra: Record<string, unknown> = {}) => ({ issue, pipeline: 'tdd', status, pr: null, started: null, finished: null, detail: null, ...extra })
const parallelOf = (state: string, issues: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  parseParallelStatus(parallelRaw(state, issues, extra))!

test('parseParallelStatus lee la forma del lote y rechaza lo invalido', () => {
  const p = parseParallelStatus(parallelRaw('running', [pIssue(1, 'en-curso', { started: 1000, pr: 'https://x/pull/9' }), pIssue(2, 'pendiente')]))!
  expect(p.issues.length).toBe(2)
  expect(p.issues[0]!.startedMs).toBe(1_000_000)
  expect(p.issues[0]!.pr).toBe('9')
  expect(p.issues[1]!.startedMs).toBe(0)
  expect(parseParallelStatus('no json')).toBe(null)
  expect(parseParallelStatus(JSON.stringify({ state: 'raro', issues: [] }))).toBe(null)
})

test('lotViewOf: sequential en curso, parallel en curso, sequential cerrado, nada', () => {
  const seq = (state: string) => ({ pipeline: 'sequential', started: '', state, current: null, stopRequested: false, holdSeconds: 0, issues: [] }) as never
  const par = parallelOf('running', [pIssue(1, 'en-curso')])
  expect(lotViewOf(seq('running'), par)).toBe('sequential')
  expect(lotViewOf(null, par)).toBe('parallel')
  expect(lotViewOf(seq('completed'), par)).toBe('parallel')
  expect(lotViewOf(seq('completed'), null)).toBe('closed-sequential')
  expect(lotViewOf(null, parallelOf('completed', []))).toBe('closed-parallel')
  expect(lotViewOf(seq('completed'), parallelOf('completed', [], { started: '2999-01-01T00:00:00Z' }))).toBe('closed-parallel')
  expect(lotViewOf(null, null)).toBe(null)
})

test('parallelHeader cuenta terminados + fallidos sobre el total y marca la parada', () => {
  const p = parallelOf('running', [pIssue(1, 'terminado'), pIssue(2, 'fallido'), pIssue(3, 'en-curso'), pIssue(4, 'pendiente')])
  const h = parallelHeader(p, new Date(2026, 0, 1, 12, 5, 7).getTime())
  expect(h.progress).toBe('parallel 2/4')
  expect(h.time).toBe('05:07')
  expect(h.stopNote).toBe('')
  expect(parallelHeader({ ...p, stopRequested: true }, 0).stopNote).toBe('se detiene: no lanza mas')
})

test('canStopParallel exige corriendo, sin parada pedida y con pendientes', () => {
  const issues = [pIssue(1, 'en-curso'), pIssue(2, 'pendiente')]
  expect(canStopParallel(parallelOf('running', issues))).toBe(true)
  expect(canStopParallel(parallelOf('running', issues, { stop_requested: true }))).toBe(false)
  expect(canStopParallel(parallelOf('running', [pIssue(1, 'en-curso')]))).toBe(false)
  expect(canStopParallel(parallelOf('completed', issues))).toBe(false)
  expect(canStopParallel(null)).toBe(false)
  expect(parallelStopQuestion(parallelOf('running', issues))).toContain('1 en curso')
})

test('parallelQueueMarks usa las marcas y colores del sequential', () => {
  const p = parallelOf('running', [pIssue(1, 'terminado'), pIssue(2, 'en-curso'), pIssue(3, 'pendiente'), pIssue(4, 'fallido')])
  expect(parallelQueueMarks(p)).toEqual([
    { text: '✓ #1', color: 'success' },
    { text: '● #2', color: 'warning' },
    { text: '○ #3', color: undefined },
    { text: '✗ #4', color: 'error' },
  ])
})

test('paginateBands: 1, 3 y 4 corridas con 3 por pagina', () => {
  expect(paginateBands([1], 0).visible).toEqual([1])
  expect(paginateBands([1], 0).pages).toBe(1)
  expect(paginateBands([1, 2, 3], 0).pages).toBe(1)
  expect(paginateBands([1, 2, 3], 0).visible).toEqual([1, 2, 3])
  const second = paginateBands([1, 2, 3, 4], 1)
  expect(second.pages).toBe(2)
  expect(second.page).toBe(1)
  expect(second.visible).toEqual([4])
  expect(paginateBands([1, 2, 3, 4], 5).page).toBe(1)
})

test('parallelRunOf elige la corrida activa del issue, preferida la del mismo pipeline', () => {
  const run = (pipeline: string, updated: string, state = 'running') => ({ issue: 7, pipeline, state, updated, started: '', variant: null }) as never
  const p = parallelOf('running', [pIssue(7, 'en-curso', { pipeline: 'tooling' })])
  const found = parallelRunOf(p.issues[0]!, [run('tdd', '2026-01-01T00:00:02Z'), run('tooling', '2026-01-01T00:00:01Z'), run('tooling', '2026-01-01T00:00:09Z', 'completed')])
  expect(found?.pipeline).toBe('tooling')
  expect(parallelRunOf(p.issues[0]!, [])).toBe(null)
})

test('parallelTable: terminados, una fila ● por corrida en curso y total', () => {
  const p = parallelOf('running', [
    pIssue(1, 'terminado', { pr: 5 }),
    pIssue(2, 'fallido'),
    pIssue(3, 'en-curso', { started: 100 }),
    pIssue(4, 'en-curso', { started: 160 }),
    pIssue(5, 'pendiente'),
  ])
  const stats = {
    '1': { durationMs: 60_000, costUsd: 1.5, title: 'Uno', finishedMs: 1 },
    '2': { durationMs: 30_000, costUsd: 0.5, title: 'Dos', finishedMs: 2 },
  }
  const t = parallelTable(p, stats, n => `titulo ${n}`, 220_000, 12)
  expect(t.rows.map(r => r.key)).toEqual(['done-1', 'done-2', 'cur-3', 'cur-4'])
  expect(t.rows.map(r => r.mark)).toEqual(['✓', '✗', '●', '●'])
  expect(t.rows[0]!.trail).toContain('$1.50')
  expect(t.rows[2]!.trail).toContain('…')
  expect(t.rows[2]!.lead).toContain('titulo 3')
  expect(t.total).toContain('4')
  expect(t.total).toContain('$2.00')
  expect(t.total).toContain('04:30')
})

test('parallelTable: una sola fila no lleva total y sin filas queda vacia', () => {
  const one = parallelTable(parallelOf('running', [pIssue(1, 'en-curso', { started: 100 })]), {}, () => null, 160_000, 0)
  expect(one.rows.length).toBe(1)
  expect(one.total).toBe(null)
  expect(parallelTable(parallelOf('running', [pIssue(1, 'pendiente')]), {}, () => null, 0, 0).rows).toEqual([])
})

test('resumen del parallel terminado: conteos y estado de la cabecera', () => {
  const p = parallelOf('stopped', [
    pIssue(1, 'terminado', { pr: 5, started: 100, finished: 160 }),
    pIssue(2, 'fallido'),
    pIssue(3, 'aplazado'),
    pIssue(4, 'saltado'),
    pIssue(5, 'terminado'),
  ])
  expect(parallelCounts(p)).toEqual({ withPr: 2, failed: 1, deferred: 1, skipped: 1, total: 5 })
  expect(parallelSummaryMarks(p)).toBe('✓ 2 con PR · ✗ 1 fallidos · ⏸ 1 aplazados · ⤼ 1 saltados')
  expect(parallelSummaryMarks(parallelOf('completed', [pIssue(1, 'terminado')]))).toBe('✓ 1 con PR')
  const h = parallelClosedHeader(p)
  expect(h.progress).toBe('parallel 3/5')
  expect(h.label).toBe('detenido')
  expect(parallelClosedHeader(parallelOf('completed', [])).label).toBe('terminado')
  expect(parallelClosedHeader(parallelOf('failed', [])).label).toBe('con fallos')
  expect(parallelDismissKey('/r', p)).toContain('|parallel|')
})

test('tabla del parallel terminado: fallido con fila, saltado sin ella y total', () => {
  const p = parallelOf('completed', [pIssue(1, 'terminado', { pr: 5 }), pIssue(2, 'fallido'), pIssue(3, 'saltado')])
  const stats = {
    '1': { durationMs: 60_000, costUsd: 1.5, title: 'Uno', finishedMs: 1 },
    '2': { durationMs: 30_000, costUsd: 0.5, title: 'Dos', finishedMs: 2 },
  }
  const t = parallelClosedTable(p, stats, 12)
  expect(t.rows.map(r => r.key)).toEqual(['done-1', 'done-2'])
  expect(t.rows.map(r => r.mark)).toEqual(['✓', '✗'])
  expect(t.rows[0]!.lead).toContain('PR #5')
  expect(t.rows[1]!.lead).toContain('sin PR')
  expect(t.total).toContain('$2.00')
  expect(parallelClosedTable(parallelOf('completed', [pIssue(1, 'terminado')]), {}, 0).total).toBe(null)
})

test('parallelMergeablePrs excluye sin PR, no terminados y ya mergeados', () => {
  const p = parallelOf('completed', [
    pIssue(1, 'terminado', { pr: 5 }),
    pIssue(2, 'terminado', { pr: 9 }),
    pIssue(3, 'terminado'),
    pIssue(4, 'fallido', { pr: 11 }),
    pIssue(5, 'terminado', { pr: 7 }),
  ])
  expect(parallelMergeablePrs(p, new Set()).map(x => x.pr)).toEqual(['9', '7', '5'])
  expect(parallelMergeablePrs(p, new Set(['9'])).map(x => x.pr)).toEqual(['7', '5'])
  expect(parallelMergeablePrs(p, new Set(['9', '7', '5']))).toEqual([])
})

const withInPr = JSON.stringify({
  items: [{ position: 1, number: 7, title: 'Hacer algo', tipo: 'tooling', after: [], hasDepsSection: true }],
  blocked: [],
  inPr: [
    { number: 1091, title: 'Ya tiene PR', tipo: 'tooling', pr: 55 },
    { number: 1092, title: 'Otro', tipo: null, pr: 56 },
  ],
  cycles: [],
  launch: '/mefisto:sequential 7',
})

test('parseNextOrder lee inPr[] presente, vacio y ausente', () => {
  expect(parseNextOrder(0, withInPr, '').inPr).toEqual([
    { number: 1091, title: 'Ya tiene PR', tipo: 'tooling', pr: 55 },
    { number: 1092, title: 'Otro', tipo: null, pr: 56 },
  ])
  expect(parseNextOrder(0, '{"items":[],"inPr":[]}', '').inPr).toEqual([])
  expect(parseNextOrder(0, json, '').inPr).toEqual([])
})

test('listosTextOf cuenta solo lanzables y suma en PR si hay', () => {
  expect(listosTextOf(parseNextOrder(0, withInPr, ''))).toBe('listos 1 · en PR 2')
  expect(listosTextOf(parseNextOrder(0, json, ''))).toBe('listos 1')
  expect(listosTextOf({ ...board(), inPr: undefined })).toBe('listos 4')
  expect(listosTextOf(board({ inPr: [] }))).toBe('listos 4')
})

test('inPrRowParts: letra con color y PR en la etiqueta', () => {
  expect(inPrRowParts({ number: 1091, title: 'Ya tiene PR', tipo: 'tooling', pr: 55 }, 5, 40)).toEqual({
    letter: 'T', color: 'magenta', label: '#1091 Ya tiene PR · PR #55',
  })
})

test('boardRowsOf pone los lanzables antes que los de PR y pagina todo junto', () => {
  const list = board({ inPr: [{ number: 90, title: 'a', tipo: null, pr: 5 }, { number: 91, title: 'b', tipo: null, pr: 6 }] })
  const rows = boardRowsOf(list)
  expect(rows.map(r => `${r.kind}:${r.item.number}`)).toEqual(['launch:7', 'launch:8', 'launch:9', 'launch:10', 'inpr:90', 'inpr:91'])
  expect(pageOf(1, rows.length, 5)).toEqual({ page: 1, pages: 2 })
  expect(rows.slice(5, 10).map(r => r.kind)).toEqual(['inpr'])
  expect(boardRowsOf(board()).length).toBe(4)
  expect(boardRowsOf(null)).toEqual([])
})
