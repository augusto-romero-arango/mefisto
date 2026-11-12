import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { RASTER_ROWS, ROLES, face, sprite, toRasterCells, waitingFace } from '../sprites'
import type { Role } from '../sprites'
import { cropGrid, numberWidth, padEnd, reasonOf, usedColumns } from '../logic'
import type { BoardList, Historian, PaneLine, PactMerge, PipelineResult, PipelineRun } from '../types'
import type { IssueStats } from './logic'
import type { BatchStatus, CurrentRow, LastEvent, LaunchKind, LaunchPlan, MascotPose, OpenPr, ParallelStatus } from './logic'
import {
  BAND_FETCH_ROWS,
  BAND_LOG_ROWS,
  PANE_MAX_LINES,
  agentOf,
  batchSeparator,
  cleanLogLine,
  durationText,
  followTargetsOf,
  isFailure,
  mergePaneLines,
  minutesSince,
  paneHeaderOf,
  parseEvent,
  LAUNCH_POLL_WINDOW_MS,
  LOG_TAIL_BYTES,
  LOGS_DIR,
  bandLinesOf,
  eventLineOf,
  isPipelineLaunch,
  logTailLines,
  runHeader,
  stepsOf,
  activeRunOf,
  bandViewOf,
  resultsFooterText,
  eventsFileOf,
  lastEventOf,
  poseOfBatch,
  poseOfResults,
  poseOfRun,
  DISMISSED_STORE_KEY,
  HISTORY_FILE,
  PAGE_ROWS,
  PLANNER_AGENT,
  agentFlagOf,
  agentSettingOf,
  NEXT_ORDER_ARGS,
  ROW_KEYS,
  answerText,
  parseLaunchArg,
  planIssue,
  planLaunch,
  clip,
  footerRestOf,
  launchCountOf,
  isMefistoManifest,
  nextOrderPath,
  RUNS_POLL_MS,
  dismissKey,
  parseHistory,
  parseStatus,
  pruneDismissed,
  reconcile,
  repoRootOf,
  resultLine,
  runLine,
  stateDirOf,
  pageOf,
  parseNextOrder,
  rowParts,
  transcriptPathOf,
  PR_CHECK_MS,
  mergeArgsOf,
  mergeOptions,
  mergeToast,
  OPEN_PRS_ARGS,
  openPrArgsOf,
  openPrOptions,
  parseOpenPrs,
  parsePrArgs,
  resultPrs,
  viewOptions,
  viewPrOf,
  BATCH_KEEP_ANSWER,
  BATCH_STOP_ANSWER,
  batchCounts,
  batchDismissKey,
  batchCurrentOf,
  batchHoldLine,
  batchMark,
  batchQueueMarks,
  batchRunningHeader,
  recentLines,
  batchSummaryMarks,
  batchEndLabel,
  batchEndFromStats,
  closeRowText,
  closeTotalText,
  nextCurrentRow,
  runningRowText,
  totalWithRunning,
  elapsedText,
  issueStatsFromHistory,
  statsPending,
  statsTotal,
  stampToMs,
  summaryTitleWidth,
  batchPrOf,
  batchRunOf,
  batchStatusPath,
  batchStopPath,
  canStopBatch,
  isBatchRunning,
  newlyMerged,
  parseBatchStatus,
  stopQuestion,
  PARALLEL_BAND_ROWS,
  parallelClosedHeader,
  parallelClosedTable,
  parallelDismissKey,
  parallelFailedIssue,
  parallelMergeablePrs,
  parallelSummaryMarks,
  canStopParallel,
  isParallelRunning,
  issueFromAnswer,
  lotViewOf,
  paginateBands,
  parallelHeader,
  parallelPrLabel,
  parallelPrs,
  parallelQueueMarks,
  parallelRunOf,
  parallelRunning,
  parallelStatusPath,
  parallelStopQuestion,
  parallelTable,
  parseParallelStatus,
  MERGE_POLL_MS,
  finishMerge,
  mergeRunArgsOf,
  mergePrsOf,
  mergeRibbonHeader,
  mergeRibbonLine,
  mergeRibbonRows,
  mergeRibbonShown,
  mergeSummaryText,
  withMerged,
  BITACORA_PR_ARGS,
  FIELD_NOTES_DIR,
  NOTES_POLL_MS,
  PROCESSED_NOTES_DIR,
  bitacoraCount,
  bitacoraIntegrateLabel,
  bitacoraPrOf,
  bitacoraPrompt,
  bitacoraQuestion,
  fieldNoteNamesOf,
  fieldNotesIn,
  historianFrom,
  historianHeader,
  isAgentActive,
  isHistorianType,
  liveHistorian,
  noteLine,
  orderedNotes,
  pendingNotes,
  withProcessedNotes,
  boardRowsOf,
  inPrRowParts,
  listosTextOf,
} from './logic'
import { shouldRearm, versionLabel } from '../logic'
import type { ResultPr } from './logic'

const POLL_MS = 60_000
const STATE_DIR = '.mefisto/pipeline'
const SCRIPT_TIMEOUT_MS = 180_000

const activeAtom = atom({ plugin: 'mefisto', key: 'pactIsActive' } as const, false)
const listAtom = atom({ plugin: 'mefisto', key: 'pactList' } as const, null)
const pageAtom = atom({ plugin: 'mefisto', key: 'pactPage' } as const, 0)
const runsAtom = atom({ plugin: 'mefisto', key: 'pactRuns' } as const, [] as PipelineRun[])
const resultsAtom = atom({ plugin: 'mefisto', key: 'pactResults' } as const, [] as PipelineResult[])
const lastEventAtom = atom({ plugin: 'mefisto', key: 'pactLastEvent' } as const, null as LastEvent | null)
const openPrsAtom = atom({ plugin: 'mefisto', key: 'pactOpenPrs' } as const, [] as OpenPr[])
const batchAtom = atom({ plugin: 'mefisto', key: 'pactBatch' } as const, null as BatchStatus | null)
type BatchStats = { stats: Record<string, IssueStats>; endedMs: number | null }
const batchStatsAtom = atom({ plugin: 'mefisto', key: 'pactBatchStats' } as const, { stats: {}, endedMs: null } as BatchStats)
const batchCurrentAtom = atom({ plugin: 'mefisto', key: 'pactBatchCurrent' } as const, null as CurrentRow | null)
type ParallelBand = { run: PipelineRun | null; lines: string[]; last: LastEvent | null }
const parallelAtom = atom({ plugin: 'mefisto', key: 'pactParallel' } as const, null as ParallelStatus | null)
const parallelStatsAtom = atom({ plugin: 'mefisto', key: 'pactParallelStats' } as const, {} as Record<string, IssueStats>)
const parallelBandsAtom = atom({ plugin: 'mefisto', key: 'pactParallelBands' } as const, {} as Record<string, ParallelBand>)
const parallelMergedAtom = atom({ plugin: 'mefisto', key: 'pactParallelMerged' } as const, [] as string[])
const parallelPageAtom = atom({ plugin: 'mefisto', key: 'pactParallelPage' } as const, 0)
const mergeAtom = atom({ plugin: 'mefisto', key: 'pactMerge' } as const, null as PactMerge | null)
const fieldNotesAtom = atom({ plugin: 'mefisto', key: 'pactFieldNotes' } as const, null as number | null)
const historianAtom = atom({ plugin: 'mefisto', key: 'pactHistorian' } as const, null as Historian | null)
const bandLinesAtom = atom({ plugin: 'mefisto', key: 'pactBandLines' } as const, [] as string[])
const logLinesAtom = atom({ plugin: 'mefisto', key: 'pactLogLines' } as const, [] as PaneLine[])
const paneRunAtom = atom({ plugin: 'mefisto', key: 'pactPaneRun' } as const, null as PipelineRun | null)
const tickAtom = atom({ plugin: 'mefisto', key: 'pactTick' } as const, 0)

// Columnas comunes a todos los cuadros de la mascota: el recorte no cambia al alternar poses.
const MASCOT_GRIDS = [
  ...(Object.keys(ROLES) as Role[])
    .filter(role => role !== 'planner')
    .flatMap(role => Object.keys(ROLES[role]).flatMap(state => [sprite(role, state, 0), sprite(role, state, 1)])),
  ...[null, 0, 1].map(tick => waitingFace(face('normal'), tick)),
]
const MASCOT_COLS = usedColumns(MASCOT_GRIDS)
const MASCOT_WIDTH = MASCOT_COLS.to - MASCOT_COLS.from + 1

const mascotGrid = (pose: MascotPose, frame: 0 | 1) => cropGrid(sprite(pose.role, pose.state, frame), MASCOT_COLS)
let isAnimating = false
// Tras ver el lanzamiento de un pipeline, el sondeo de corridas corre a 5 s hasta este instante aunque aun no haya status (#2320).
let launchPollUntilMs = 0
let lastNotesPollMs = 0
let lastHistorianPollMs = 0
let lastBitacoraPrCheckMs = 0
let isPollingHistorian = false
const HISTORIAN_POLL_MS = 2_000

// La intencion on/off y la elegibilidad viven aqui: /clear no dispara session.start y reinicia los atoms.
let isEligible = false
let isWanted = true
let isHealing = false
let healTimer: { cancel: () => void } | null = null
const HEAL_MS = 1_000
let isRefreshing = false
let timer: { cancel: () => void } | null = null
let runsTimer: { cancel: () => void } | null = null
let tickTimer: { cancel: () => void } | null = null
let prTimer: { cancel: () => void } | null = null
let isCheckingPrs = false
let isRefreshingOpenPrs = false
let isRefreshingRuns = false
let mergeTimer: { cancel: () => void } | null = null
let isPollingMerge = false
// La llamada Bash a pr-sync.mts ya empezo; sin verla, el reloj cierra la cinta arrancada por teclas a los MERGE_STALE_MS.
let isMergeScriptSeen = false
let mergeStartedMs = 0
const MERGE_STALE_MS = 60_000
// Corridas que esta sesion vio activas y resultados `✓` ya derivados; viven aqui porque /clear reinicia los atoms.
let seenRuns: Record<string, PipelineRun> = {}
let carriedResults: PipelineResult[] = []
let runsRepo = ''
// Ultimo estado del lote leido: base para anunciar con un toast cada issue que pasa a `mergeado`.
let lastBatchIssues: BatchStatus['issues'] | null = null
// Estadisticas del lote (del historial: titulo, duracion y costo); se reinician al cambiar el `started` del lote.
let batchStatsFor = ''
// Primer instante en que se vio el lote ya terminado: cierra el reloj de la cabecera si el historial no lo da.
let batchSeenEndedMs: number | null = null
// Lote parallel (#2449): el `started` de las estadisticas en cache y, con el lote vivo, el sondeo rapido de corridas.
let parallelStatsFor = ''
let isParallelLive = false
let lastParallelStatsReadMs = 0
let parallelMergedFor = ''
let isCheckingParallelPrs = false
// Issue cuyo log sigue el pane cuando el lote es parallel (varias corridas a la vez).
let paneIssue: number | null = null
// El historial se relee para estadisticas faltantes a lo sumo cada BATCH_STATS_EVERY_MS (como `withStats` en la cinta interna).
const BATCH_STATS_EVERY_MS = 5_000
let lastBatchStatsReadMs = 0
// Si al arrancar no se pudo saber el agente (sin linea de comando y sin transcript aun), se reintenta en cada refresh.
let agentChecksLeft = 0
const AGENT_CHECKS = 20

async function pluginRoot($: EngineInterface): Promise<string | null> {
  const own = $.plugin.root
  if (own) return own
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel']).catch(() => ({ exitCode: 1, stdout: '' }))
  const base = top.exitCode === 0 ? top.stdout.trim() : await $.session.cwd()
  const root = await $.fs.read(`${base}/.mefisto/pipeline/.plugin-root`).catch(() => '')
  return typeof root === 'string' && root.trim() !== '' ? root.trim() : null
}

const versionAtom = atom({ plugin: 'mefisto', key: 'pactVersion' } as const, null as string | null)

async function loadVersion($: EngineInterface) {
  const root = await pluginRoot($)
  const base = root ? root.replace(/\/+$/, '') : null
  const read1 = async (file: string) => (base ? await $.fs.read(`${base}/${file}`).catch(() => null) : null)
  const label = versionLabel(await read1('mefisto-manifest.json'), await read1('.claude-plugin/plugin.json'))
  await update($, versionAtom, () => label)
}

async function runNextOrder($: EngineInterface): Promise<BoardList> {
  const root = await pluginRoot($)
  if (!root) return parseNextOrder(2, '', 'raiz del plugin desconocida')
  const { exitCode, stdout, stderr } = await $.process
    .run(['node', nextOrderPath(root), ...NEXT_ORDER_ARGS], { timeoutMs: SCRIPT_TIMEOUT_MS })
    .catch(err => ({ exitCode: 2, stdout: '', stderr: String(err) }))
  return parseNextOrder(exitCode, stdout, stderr)
}

async function readDismissed($: EngineInterface): Promise<string[]> {
  const raw = await $.store.get(DISMISSED_STORE_KEY).catch(() => null)
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []
}

async function saveDismissed($: EngineInterface, keys: string[]) {
  await $.store.set(DISMISSED_STORE_KEY, keys).catch(() => undefined)
}

// Lector puro: solo lee `.mefisto/pipeline/` del checkout principal; la ruta legada se ignora (MEF-ADR-0053).
async function readRuns($: EngineInterface): Promise<PipelineRun[]> {
  const cwd = await $.session.cwd()
  const common = await $.process.run(['git', 'rev-parse', '--git-common-dir']).catch(() => ({ exitCode: 1, stdout: '' }))
  const dir = stateDirOf(common.exitCode === 0 ? common.stdout.trim() : '.git', cwd)
  runsRepo = repoRootOf(dir)
  const ls = await $.process.run(['ls', dir]).catch(() => ({ exitCode: 1, stdout: '' }))
  if (ls.exitCode !== 0) return []
  const runs: PipelineRun[] = []
  for (const name of ls.stdout.split('\n')) {
    const file = name.trim()
    if (!file.startsWith('pipeline-status-')) continue
    const raw = await $.fs.read(`${dir}/${file}`).catch(() => '')
    const run = typeof raw === 'string' ? parseStatus(file, raw) : null
    if (run) runs.push(run)
  }
  return runs
}

// Cola del `events.jsonl` del ultimo intento del agente activo; lector puro de `<estado>/logs/*.events.jsonl`.
async function readEventsTail($: EngineInterface, run: PipelineRun | null): Promise<string | null> {
  if (!run) return null
  const dir = `${runsRepo}/${STATE_DIR}/${LOGS_DIR}`
  const ls = await $.process.run(['ls', dir]).catch(() => ({ exitCode: 1, stdout: '' }))
  if (ls.exitCode !== 0) return null
  const file = eventsFileOf(run, ls.stdout.split('\n'))
  if (!file) return null
  const tail = await $.process.run(['tail', '-c', '65536', `${dir}/${file}`]).catch(() => ({ exitCode: 1, stdout: '' }))
  return tail.exitCode === 0 ? tail.stdout : null
}

// Ultimas lineas utiles: cola del log del pipeline (sin ANSI) y ultimo evento del agente; se calculan aqui, nunca al dibujar.
async function readBandLines($: EngineInterface, run: PipelineRun | null, eventsTail: string | null): Promise<string[]> {
  if (!run) return []
  let logLines: string[] = []
  if (run.log) {
    const path = run.log.startsWith('/') ? run.log : `${runsRepo}/${run.log}`
    const tail = await $.process.run(['tail', '-c', String(LOG_TAIL_BYTES), path]).catch(() => ({ exitCode: 1, stdout: '' }))
    if (tail.exitCode === 0) logLines = logTailLines(tail.stdout, BAND_FETCH_ROWS)
  }
  return bandLinesOf(logLines, eventsTail ? eventLineOf(eventsTail) : null, BAND_FETCH_ROWS)
}

// Solo `.mefisto/pipeline/` (MEF-ADR-0053): la ruta legada ya no la escribe ningun pipeline.
async function readHistory($: EngineInterface): Promise<string> {
  const raw = await $.fs.read(`${runsRepo}/${STATE_DIR}/${HISTORY_FILE}`).catch(() => '')
  return typeof raw === 'string' ? raw : ''
}

// Lector puro del status del lote (#2202); un lote terminado y cerrado (clave repo + `started` en el store) no se muestra.
async function readBatch($: EngineInterface): Promise<BatchStatus | null> {
  const raw = await $.fs.read(batchStatusPath(`${runsRepo}/${STATE_DIR}`)).catch(() => '')
  return typeof raw === 'string' && raw !== '' ? parseBatchStatus(raw) : null
}

async function refreshBatch($: EngineInterface) {
  const batch = await readBatch($)
  if (!batch) {
    lastBatchIssues = null
    await update($, batchCurrentAtom, () => null)
    await update($, batchAtom, () => null)
    return
  }
  for (const i of newlyMerged(lastBatchIssues, batch.issues)) $.ui.toast(`#${i.issue} mergeado${i.pr ? ` · PR #${i.pr}` : ''}`)
  lastBatchIssues = batch.issues
  if (batchStatsFor !== batch.started) {
    batchStatsFor = batch.started
    batchSeenEndedMs = null
    lastBatchStatsReadMs = 0
    await update($, batchStatsAtom, () => ({ stats: {}, endedMs: null }))
  }
  const finished = (i: BatchStatus['issues'][number]) => i.status !== 'pendiente' && i.status !== 'en-curso'
  const known = await read($, batchStatsAtom)
  const missing = statsPending(batch.issues.filter(finished).map(i => String(i.issue)), known.stats)
  let stats = known.stats
  if (missing.length > 0 && Date.now() - lastBatchStatsReadMs >= BATCH_STATS_EVERY_MS) {
    lastBatchStatsReadMs = Date.now()
    stats = { ...stats, ...issueStatsFromHistory(await readHistory($), missing, stampToMs(batch.started)) }
  }
  if (isBatchRunning(batch)) batchSeenEndedMs = null
  else batchSeenEndedMs ??= Date.now()
  const endedMs = isBatchRunning(batch) ? null : (batchEndFromStats(stats) ?? batchSeenEndedMs)
  if (stats !== known.stats || endedMs !== known.endedMs) await update($, batchStatsAtom, () => ({ stats, endedMs }))
  const prevRow = await read($, batchCurrentAtom)
  const nextRow = nextCurrentRow(batch, batchRunOf(batch, await read($, runsAtom)), prevRow, Date.now())
  if (nextRow !== prevRow) await update($, batchCurrentAtom, () => nextRow)
  const closed = !isBatchRunning(batch) && (await readDismissed($)).includes(batchDismissKey(runsRepo, batch))
  await update($, batchAtom, () => (closed ? null : batch))
}

// Parada suave (MEF-ADR-0017): la misma senal vacia que /mefisto:batch-stop, en la raiz del checkout principal.
async function requestStop($: EngineInterface): Promise<string> {
  const batch = await read($, batchAtom)
  if (!batch || !canStopBatch(batch)) return 'No hay un sequential en curso que detener.'
  await $.fs.write(batchStopPath(runsRepo), '')
  await update($, batchAtom, b => (b ? { ...b, stopRequested: true } : b))
  $.ui.toast('parada pedida: termina el issue en curso y no arranca los siguientes')
  return 'Parada pedida: termina el issue en curso y no arranca los siguientes.'
}

async function confirmStop($: EngineInterface): Promise<string> {
  const batch = await read($, batchAtom)
  if (batch && isBatchRunning(batch) && batch.stopRequested) return 'La parada ya esta pedida: termina el issue en curso.'
  if (!batch || !canStopBatch(batch)) return 'No hay un sequential en curso que detener.'
  const answer = await $.ui
    .ask(stopQuestion(batch), { header: 'Detener', options: [BATCH_STOP_ANSWER, BATCH_KEEP_ANSWER] })
    .catch(() => null)
  return answer === BATCH_STOP_ANSWER ? requestStop($) : 'Sin cambios.'
}

async function viewBatchPr($: EngineInterface): Promise<string> {
  const batch = await read($, batchAtom)
  const pr = batch ? batchPrOf(batch) : null
  if (!pr) return 'El lote no tiene PR que abrir.'
  await $.process.run(['gh', 'pr', 'view', pr, '--web']).catch(() => undefined)
  return `PR #${pr} abierto en GitHub.`
}

async function closeBatch($: EngineInterface) {
  const batch = await read($, batchAtom)
  if (!batch || isBatchRunning(batch)) return
  const keys = new Set(await readDismissed($))
  keys.add(batchDismissKey(runsRepo, batch))
  await saveDismissed($, [...keys])
  await update($, batchAtom, () => null)
  await closeLogIfGone($)
}

// Lector puro del status del lote parallel (#2447): en curso o cerrado (#2450); un cerrado ya ocultado con `4: cerrar` no ocupa la banda.
async function refreshParallel($: EngineInterface, runs: readonly PipelineRun[]) {
  const raw = await $.fs.read(parallelStatusPath(`${runsRepo}/${STATE_DIR}`)).catch(() => '')
  const parsed = typeof raw === 'string' && raw !== '' ? parseParallelStatus(raw) : null
  const closed = parsed !== null && !isParallelRunning(parsed) && (await readDismissed($)).includes(parallelDismissKey(runsRepo, parsed))
  const p = closed ? null : parsed
  isParallelLive = isParallelRunning(p)
  if (!p) {
    await update($, parallelBandsAtom, () => ({}))
    await update($, parallelAtom, () => null)
    return
  }
  if (parallelStatsFor !== p.started) {
    parallelStatsFor = p.started
    lastParallelStatsReadMs = 0
    await update($, parallelStatsAtom, () => ({}))
  }
  if (parallelMergedFor !== p.started) {
    parallelMergedFor = p.started
    await update($, parallelMergedAtom, () => [])
  }
  const known = await read($, parallelStatsAtom)
  const finished = p.issues.filter(i => i.status === 'terminado' || i.status === 'fallido').map(i => String(i.issue))
  const missing = statsPending(finished, known)
  if (missing.length > 0 && Date.now() - lastParallelStatsReadMs >= BATCH_STATS_EVERY_MS) {
    lastParallelStatsReadMs = Date.now()
    const stats = { ...known, ...issueStatsFromHistory(await readHistory($), missing, stampToMs(p.started)) }
    await update($, parallelStatsAtom, () => stats)
  }
  const bands: Record<string, ParallelBand> = {}
  for (const i of parallelRunning(p)) {
    const run = parallelRunOf(i, runs)
    const eventsTail = await readEventsTail($, run)
    bands[String(i.issue)] = { run, lines: await readBandLines($, run, eventsTail), last: eventsTail ? lastEventOf(eventsTail) : null }
  }
  await update($, parallelBandsAtom, () => bands)
  await update($, parallelAtom, () => p)
}

// Parada suave (MEF-ADR-0017): la misma senal que /mefisto:batch-stop y el sequential; ningun proceso se mata.
async function confirmStopParallel($: EngineInterface): Promise<string> {
  const p = await read($, parallelAtom)
  if (p && isParallelRunning(p) && p.stopRequested) return 'La parada ya esta pedida: no se lanzan mas issues.'
  if (!p || !canStopParallel(p)) return 'No hay un parallel en curso con issues pendientes que detener.'
  const answer = await $.ui
    .ask(parallelStopQuestion(p), { header: 'Detener', options: [BATCH_STOP_ANSWER, BATCH_KEEP_ANSWER] })
    .catch(() => null)
  if (answer !== BATCH_STOP_ANSWER) return 'Sin cambios.'
  await $.fs.write(batchStopPath(runsRepo), '')
  await update($, parallelAtom, cur => (cur ? { ...cur, stopRequested: true } : cur))
  $.ui.toast('parada pedida: los issues en curso terminan y no se lanzan mas')
  return 'Parada pedida: los issues en curso terminan y no se lanzan mas.'
}

// Ocultado persistente del lote parallel terminado: clave repo + `started` en `$.store`; el archivo no se toca.
async function closeParallel($: EngineInterface) {
  const p = await read($, parallelAtom)
  if (!p || p.state === 'running') return
  const keys = new Set(await readDismissed($))
  keys.add(parallelDismissKey(runsRepo, p))
  await saveDismissed($, [...keys])
  await update($, parallelAtom, () => null)
  await closeLogIfGone($)
}

// Sondeo de 15 s (como el de corridas terminadas): un PR del lote ya `MERGED` deja de ofrecerse.
async function probeParallelMerged($: EngineInterface) {
  if (isCheckingParallelPrs || !isEligible || !isWanted) return
  const p = await read($, parallelAtom)
  if (!p || p.state === 'running') return
  isCheckingParallelPrs = true
  try {
    const merged = await read($, parallelMergedAtom)
    const found: string[] = []
    for (const x of parallelMergeablePrs(p, new Set(merged))) {
      const { exitCode, stdout } = await $.process
        .run(['gh', 'pr', 'view', x.pr, '--json', 'state', '-q', '.state'])
        .catch(() => ({ exitCode: 1, stdout: '' }))
      if (exitCode === 0 && stdout.trim() === 'MERGED') found.push(x.pr)
    }
    if (found.length === 0) return
    await update($, parallelMergedAtom, cur => [...new Set([...cur, ...found])])
    void refreshOpenPrs($)
    for (const pr of found) $.ui.toast(`PR #${pr} mergeado`)
  } finally {
    isCheckingParallelPrs = false
  }
}

// `1: mergear` del lote terminado: solo los PRs del lote aun abiertos, con el mismo dialogo que las corridas terminadas.
async function mergeParallel($: EngineInterface): Promise<string> {
  const p = await read($, parallelAtom)
  if (!p || p.state === 'running') return 'No hay un parallel terminado.'
  const prs = parallelMergeablePrs(p, new Set(await read($, parallelMergedAtom)))
  if (prs.length === 0) return 'El lote no tiene PRs abiertos que mergear.'
  await refreshOpenPrs($)
  return mergeListed($, prs, null)
}

async function viewParallelPr($: EngineInterface): Promise<string> {
  const p = await read($, parallelAtom)
  const prs = p ? parallelPrs(p) : []
  if (prs.length === 0) return 'El lote no tiene PR que abrir.'
  let pr = prs[0]!.pr
  if (prs.length > 1) {
    const answer = await $.ui.ask('¿Cuál PR ver?', { header: 'PR', options: prs.map(parallelPrLabel) }).catch(() => null)
    const issue = issueFromAnswer(answer, prs.map(x => x.issue))
    const chosen = prs.find(x => x.issue === issue)
    if (!chosen) return 'Sin PR elegido.'
    pr = chosen.pr
  }
  await $.process.run(['gh', 'pr', 'view', pr, '--web']).catch(() => undefined)
  return `PR #${pr} abierto en GitHub.`
}

// ---- Pane de log (#2321): dos `tail -F` (eventos del agente y log del pipeline) mezclados en un mismo atom ----

const PANE = 'fausto-blood-pact'
const PANE_ROWS = 18
const PANE_FIXED_ROWS = 7
type Follow = { path: string; stream: AsyncGenerator<unknown, unknown> }
type FollowKind = 'events' | 'log'

let isLogOpen = false
let isSyncingLog = false
let eventsFollow: Follow | null = null
let logFollow: Follow | null = null
let separatedIssue: number | null = null

const followOf = (kind: FollowKind) => (kind === 'events' ? eventsFollow : logFollow)

async function stopFollow(kind: FollowKind) {
  const current = followOf(kind)
  if (kind === 'events') eventsFollow = null
  else logFollow = null
  if (current) await current.stream.return(undefined).catch(() => undefined)
}

async function stopFollows() {
  await stopFollow('events')
  await stopFollow('log')
}

async function consumeFollow($: EngineInterface, kind: FollowKind, follow: Follow) {
  let pending = ''
  try {
    for await (const chunk of follow.stream) {
      if (followOf(kind) !== follow) break
      const { stream: channel, text } = chunk as { stream: string; text: string }
      if (channel !== 'stdout') continue
      pending += text
      const rows = pending.split('\n')
      pending = rows.pop() ?? ''
      const added = rows
        .map((row): PaneLine | null => {
          if (kind === 'events') return parseEvent(row)
          const clean = cleanLogLine(row)
          return clean ? { kind: 'log', text: clean } : null
        })
        .filter((l): l is PaneLine => l !== null)
      if (added.length > 0) await update($, logLinesAtom, list => mergePaneLines(list, added, PANE_MAX_LINES))
    }
  } catch (err) {
    $.ui.log(`tail ${follow.path}: ${String(err)}`, { to: 'debug' })
  }
}

async function startFollow($: EngineInterface, kind: FollowKind, path: string) {
  await stopFollow(kind)
  const stream = $.process.spawn({ argv: ['tail', '-n', '40', '-F', path], ...(runsRepo ? { cwd: runsRepo } : {}) })
  const follow: Follow = { path, stream }
  if (kind === 'events') eventsFollow = follow
  else logFollow = follow
  void consumeFollow($, kind, follow)
}

const isSameRun = (a: PipelineRun, b: PipelineRun) => a.issue === b.issue && a.pipeline === b.pipeline && a.variant === b.variant

async function paneTarget($: EngineInterface): Promise<PipelineRun | null> {
  const batch = await read($, batchAtom)
  const runs = await read($, runsAtom)
  const parallel = await read($, parallelAtom)
  if (parallel && lotViewOf(batch, parallel) === 'parallel') {
    const live = parallelRunning(parallel)
    const chosen = live.find(i => i.issue === paneIssue) ?? live[0]
    return chosen ? parallelRunOf(chosen, runs) : null
  }
  return batch ? batchRunOf(batch, runs) : activeRunOf(runs)
}

// Cada sondeo: elige los archivos a seguir (intento vigente del stage activo, log de la corrida o del lote) y pasa al nuevo si cambian.
async function syncLog($: EngineInterface) {
  if (!isLogOpen || isSyncingLog) return
  isSyncingLog = true
  try {
    const batch = await read($, batchAtom)
    const active = await paneTarget($)
    let run = active ?? (await read($, paneRunAtom))
    if (!active && run) {
      const known = run
      run = (await readRuns($)).find(r => isSameRun(r, known)) ?? run
    }
    if (run) await update($, paneRunAtom, () => run)
    const ls = run ? await $.process.run(['ls', `${runsRepo}/${STATE_DIR}/${LOGS_DIR}`]).catch(() => ({ exitCode: 1, stdout: '' })) : null
    const names = ls && ls.exitCode === 0 ? ls.stdout.split('\n') : []
    const targets = followTargetsOf(run, batch, names, runsRepo)
    if (batch && active && active.issue !== separatedIssue) {
      separatedIssue = active.issue
      await update($, logLinesAtom, list => mergePaneLines(list, [batchSeparator(active.issue)], PANE_MAX_LINES))
    }
    if (!isLogOpen) return
    if (targets.events && targets.events !== eventsFollow?.path) await startFollow($, 'events', targets.events)
    if (targets.log && targets.log !== logFollow?.path) await startFollow($, 'log', targets.log)
  } finally {
    isSyncingLog = false
  }
}

async function closeLog($: EngineInterface) {
  isLogOpen = false
  await stopFollows()
  separatedIssue = null
  paneIssue = null
  await update($, logLinesAtom, () => [])
  await update($, paneRunAtom, () => null)
  await $.ui.close({ id: PANE })
}

async function openLog($: EngineInterface, issue: number | null = null): Promise<boolean> {
  if (issue !== null) paneIssue = issue
  const run = await paneTarget($)
  if (!run) return false
  isLogOpen = true
  separatedIssue = null
  await update($, logLinesAtom, () => [])
  await update($, paneRunAtom, () => run)
  await $.ui.open({ id: PANE, title: 'mefisto', rows: PANE_ROWS, focus: true as const })
  await syncLog($)
  return true
}

// La tecla 3 abre el log o, si ya estaba abierto, lo cierra.
async function toggleLog($: EngineInterface) {
  if (isLogOpen) {
    await closeLog($)
    return
  }
  const parallel = await read($, parallelAtom)
  const live = parallel && lotViewOf(await read($, batchAtom), parallel) === 'parallel' ? parallelRunning(parallel) : []
  let issue: number | null = null
  if (live.length > 1) {
    const answer = await $.ui
      .ask('¿Log de cuál corrida?', { header: 'Log', options: live.map(i => `#${i.issue}`) })
      .catch(() => null)
    issue = issueFromAnswer(answer, live.map(i => i.issue))
    if (issue === null) return
  }
  if (!(await openLog($, issue))) $.ui.toast('No hay corrida que seguir')
}

// Cuando la vista se va (cerrar, ocultar o una corrida que cierra sola) el pane y sus `tail` se van con ella.
async function closeLogIfGone($: EngineInterface) {
  if (!isLogOpen) return
  const batch = await read($, batchAtom)
  const runs = await read($, runsAtom)
  const results = await read($, resultsAtom)
  if (!batch && !(await read($, parallelAtom)) && runs.length === 0 && results.length === 0) await closeLog($)
}

async function refreshRuns($: EngineInterface) {
  if (isRefreshingRuns || !isEligible || !isWanted) return
  isRefreshingRuns = true
  try {
    const statuses = await readRuns($)
    const dismissed = await readDismissed($)
    const wasSeen = seenRuns
    const historyRaw = await readHistory($)
    const view = reconcile(
      runsRepo,
      statuses,
      wasSeen,
      parseHistory(typeof historyRaw === 'string' ? historyRaw : ''),
      new Set(dismissed),
      carriedResults,
    )
    seenRuns = view.seen
    carriedResults = view.results.filter(r => r.ok)
    const live = new Set(statuses.map(s => dismissKey(runsRepo, s)))
    const pruned = pruneDismissed(dismissed, runsRepo, live, Date.now())
    if (pruned.length !== dismissed.length) await saveDismissed($, pruned)
    const target = activeRunOf(view.runs)
    const eventsTail = await readEventsTail($, target)
    const last = eventsTail ? lastEventOf(eventsTail) : null
    const lines = await readBandLines($, target, eventsTail)
    await update($, lastEventAtom, () => last)
    await update($, bandLinesAtom, () => lines)
    await update($, runsAtom, () => view.runs)
    await refreshBatch($)
    await refreshParallel($, view.runs)
    await update($, resultsAtom, () => view.results)
    await syncLog($)
    await closeLogIfGone($)
  } finally {
    isRefreshingRuns = false
  }
}

async function dismissResults($: EngineInterface): Promise<number> {
  const results = await read($, resultsAtom)
  if (results.length === 0) return 0
  const keys = new Set(await readDismissed($))
  for (const r of results) keys.add(r.key)
  await saveDismissed($, [...keys])
  carriedResults = []
  await update($, resultsAtom, () => [])
  await update($, pageAtom, () => 0)
  await closeLogIfGone($)
  return results.length
}

// Un PR `MERGED` quita su linea sola: se guarda en `$.store` (nunca en archivos de estado) para que no reaparezca.
async function closeMergedPrs($: EngineInterface) {
  if (isCheckingPrs || !isEligible || !isWanted) return
  isCheckingPrs = true
  try {
    const results = await read($, resultsAtom)
    const merged: ResultPr[] = []
    for (const p of resultPrs(results)) {
      const { exitCode, stdout } = await $.process
        .run(['gh', 'pr', 'view', p.pr, '--json', 'state', '-q', '.state'])
        .catch(() => ({ exitCode: 1, stdout: '' }))
      if (exitCode === 0 && stdout.trim() === 'MERGED') merged.push(p)
    }
    if (merged.length === 0) return
    const keys = new Set(await readDismissed($))
    for (const p of merged) keys.add(p.key)
    await saveDismissed($, [...keys])
    const gone = new Set(merged.map(p => p.key))
    carriedResults = carriedResults.filter(r => !gone.has(r.key))
    await update($, resultsAtom, rs => rs.filter(r => !gone.has(r.key)))
    await update($, pageAtom, () => 0)
    void refreshOpenPrs($)
    for (const p of merged) {
      $.ui.toast(`PR #${p.pr} mergeado${p.pipeline === 'infra' ? ' · el issue se cierra cuando termine el apply de CI' : ''}`)
    }
  } finally {
    isCheckingPrs = false
  }
}

// La cinta de merge: arranca con las teclas o al ver la llamada Bash a pr-sync.mts --merge; con --all la lista sale de los PRs abiertos de ese momento.
async function startMerge($: EngineInterface, args: string) {
  const current = await read($, mergeAtom)
  if (current && current.finishedMs === null) return
  let open = await read($, openPrsAtom)
  if (/(^|\s)--all(\s|$)/.test(args)) {
    const listed = await $.process.run(['gh', ...OPEN_PRS_ARGS]).catch(() => ({ exitCode: 1, stdout: '' }))
    if (listed.exitCode === 0) open = parseOpenPrs(listed.stdout)
  }
  const prs = mergePrsOf(args, open)
  if (prs.length === 0) return
  isMergeScriptSeen = false
  mergeStartedMs = Date.now()
  await update($, mergeAtom, () => ({ prs, startedMs: mergeStartedMs, finishedMs: null }))
}

async function pollMerge($: EngineInterface) {
  if (isPollingMerge) return
  isPollingMerge = true
  try {
    const run = await read($, mergeAtom)
    if (!run || run.finishedMs !== null) return
    const pending = run.prs.filter(p => p.estado === 'pendiente').map(p => p.num)
    const states = await Promise.all(
      pending.map(n => $.process.run(['gh', 'pr', 'view', n, '--json', 'state', '-q', '.state']).catch(() => ({ exitCode: 1, stdout: '' }))),
    )
    const merged = pending.filter((_, i) => states[i]?.exitCode === 0 && states[i]?.stdout.trim() === 'MERGED')
    if (merged.length > 0) await update($, mergeAtom, r => (r ? withMerged(r, merged) : r))
  } finally {
    isPollingMerge = false
  }
}

async function endMerge($: EngineInterface) {
  await pollMerge($)
  const run = await read($, mergeAtom)
  if (!run || run.finishedMs !== null) return
  const done = finishMerge(run, Date.now())
  await update($, mergeAtom, () => done)
  $.ui.toast(mergeSummaryText(done))
  void refreshOpenPrs($)
}

async function closeMerge($: EngineInterface) {
  const run = await read($, mergeAtom)
  if (run && run.finishedMs !== null) await update($, mergeAtom, () => null)
}

// Mergear: la confirmacion del dialogo es la unica; /mefisto:merge no pide otra. Nunca `--all`.
async function mergePrs($: EngineInterface, preset: string[] | null = null): Promise<string> {
  const prs = resultPrs(await read($, resultsAtom))
  if (prs.length === 0) return 'No hay PRs de corridas terminadas.'
  return mergeListed($, prs, preset)
}

async function mergeListed($: EngineInterface, prs: ResultPr[], preset: string[] | null): Promise<string> {
  const scope = preset ? prs.filter(p => preset.includes(p.pr)) : prs
  const options = mergeOptions(scope)
  const answer = await $.ui
    .ask(
      scope.length === 1 ? `¿Mergear el PR #${scope[0]!.pr}?` : `¿Qué mergear? ${scope.length} PRs${scope.length > 3 ? ' (otros números: escríbelos en la opción de texto)' : ''}`,
      scope.length === 1 ? options : { header: 'Merge', options, multiSelect: true as const },
    )
    .catch(() => null)
  const args = mergeArgsOf(answer, options, scope)
  if (!args) return 'Merge cancelado.'
  $.ui.toast(mergeToast(args, prs))
  await startMerge($, args)
  await $.command.run({ command: 'mefisto:merge', args })
  void refreshOpenPrs($)
  return `/mefisto:merge ${args} en cola.`
}

async function refreshOpenPrs($: EngineInterface) {
  if (isRefreshingOpenPrs || !isEligible || !isWanted) return
  isRefreshingOpenPrs = true
  try {
    const { exitCode, stdout } = await $.process.run(['gh', ...OPEN_PRS_ARGS]).catch(() => ({ exitCode: 1, stdout: '' }))
    if (exitCode === 0) await update($, openPrsAtom, () => parseOpenPrs(stdout))
  } finally {
    isRefreshingOpenPrs = false
  }
}

// Reposo: la lista es de los PRs abiertos que no son borradores (field notes incluidos); "Todos" pasa `--all`.
async function mergeOpenPrs($: EngineInterface): Promise<string> {
  await refreshOpenPrs($)
  const prs = await read($, openPrsAtom)
  if (prs.length === 0) return 'No hay PRs abiertos.'
  const options = openPrOptions(prs)
  const answer = await $.ui
    .ask(
      prs.length === 1 ? `¿Mergear el PR #${prs[0]!.number}?` : `¿Qué mergear? ${prs.length} PRs${prs.length > 3 ? ' (otros números: escríbelos en la opción de texto)' : ''}`,
      prs.length === 1 ? options : { header: 'Merge', options, multiSelect: true as const },
    )
    .catch(() => null)
  const args = openPrArgsOf(typeof answer === 'string' ? answer : null, options, prs)
  if (!args) return 'Merge cancelado.'
  $.ui.toast(`/mefisto:merge ${args} en cola`)
  await startMerge($, args)
  await $.command.run({ command: 'mefisto:merge', args })
  void refreshOpenPrs($)
  return `/mefisto:merge ${args} en cola.`
}

async function viewPr($: EngineInterface, preset: string | null = null): Promise<string> {
  const prs = resultPrs(await read($, resultsAtom))
  if (prs.length === 0) return 'No hay PRs de corridas terminadas.'
  let pr = preset
  if (!pr) {
    if (prs.length === 1) pr = prs[0]!.pr
    else {
      const options = viewOptions(prs)
      const answer = await $.ui.ask('¿Cuál PR ver?', { header: 'PR', options }).catch(() => null)
      pr = viewPrOf(answer, prs)
    }
  }
  if (!pr) return 'Sin PR elegido.'
  await $.process.run(['gh', 'pr', 'view', pr, '--web']).catch(() => undefined)
  return `PR #${pr} abierto en GitHub.`
}

// La carpeta de las field notes es la del checkout principal, donde trabaja el historiador del consumidor.
async function repoDir($: EngineInterface): Promise<string> {
  return runsRepo || (await $.session.cwd())
}

async function refreshFieldNotes($: EngineInterface) {
  const entries = await $.fs.list(`${await repoDir($)}/${FIELD_NOTES_DIR}`).catch(() => null)
  await update($, fieldNotesAtom, () => (entries ? fieldNotesIn(entries.filter(n => n.kind === 'file').map(n => n.name)) : 0))
}

// Mientras el historiador corre (se sondea `$.agent.list()`: el tipo lleva el prefijo del plugin), la banda lo muestra
// escribiendo con sus field notes: pendientes hasta que aparecen en `procesadas/`.
async function pollHistorian($: EngineInterface) {
  if (isPollingHistorian || !isEligible || !isWanted || Date.now() - lastHistorianPollMs < HISTORIAN_POLL_MS) return
  isPollingHistorian = true
  lastHistorianPollMs = Date.now()
  try {
    const agents = await $.agent.list().catch(() => [])
    const active = agents.some(a => isHistorianType(a.type) && isAgentActive(a.status))
    const prev = await read($, historianAtom)
    const next = historianFrom(prev, active, Date.now())
    if (next !== prev) {
      await update($, historianAtom, () => next)
      if (next && !next.finishedMs) {
        await captureNotes($)
        return
      }
      if (next?.finishedMs) {
        lastNotesPollMs = 0
        await pollNotes($)
        await findBitacoraPr($)
        void refreshOpenPrs($)
        void refreshFieldNotes($)
      }
      return
    }
    if (next && !next.finishedMs) await pollNotes($)
    if (next?.pr) await checkBitacoraPr($, next.pr.number)
    if (next && next.finishedMs && !next.pr && !liveHistorian(next, Date.now())) await update($, historianAtom, () => null)
  } finally {
    isPollingHistorian = false
  }
}

async function captureNotes($: EngineInterface) {
  const local = await $.fs.list(`${await repoDir($)}/${FIELD_NOTES_DIR}`).catch(() => [])
  const notePrs = (await read($, openPrsAtom)).filter(p => p.isFieldNote).map(p => p.number)
  const files = await Promise.all(
    notePrs.map(n => $.process.run(['gh', 'pr', 'view', n, '--json', 'files', '-q', '.files[].path']).catch(() => ({ exitCode: 1, stdout: '' }))),
  )
  const paths = files.flatMap(f => (f.exitCode === 0 ? f.stdout.split('\n').filter(Boolean) : []))
  const names = fieldNoteNamesOf(local.filter(n => n.kind === 'file').map(n => n.name), paths)
  await update($, historianAtom, h => (h && h.notes.length === 0 ? { ...h, notes: pendingNotes(names) } : h))
  lastNotesPollMs = 0
  await pollNotes($)
}

async function pollNotes($: EngineInterface) {
  const h = await read($, historianAtom)
  if (!h || !h.notes.some(n => n.estado === 'pendiente') || Date.now() - lastNotesPollMs < NOTES_POLL_MS) return
  lastNotesPollMs = Date.now()
  const listed = await $.fs.list(`${await repoDir($)}/${PROCESSED_NOTES_DIR}`).catch(() => [])
  const processed = listed.filter(n => n.kind === 'file').map(n => n.name)
  await update($, historianAtom, cur => (cur ? withProcessedNotes(cur, processed) : cur))
}

// Al terminar, un PR de bitacora abierto se ofrece para mergear, ver o cerrar; si no queda ninguno (el skill ya lo
// mergeo), la cinta se va sola a los 8 s (el vencimiento tambien se calcula al dibujar).
async function findBitacoraPr($: EngineInterface) {
  const { exitCode, stdout } = await $.process.run(['gh', ...BITACORA_PR_ARGS]).catch(() => ({ exitCode: 1, stdout: '' }))
  const pr = exitCode === 0 ? bitacoraPrOf(stdout) : null
  if (!pr) return
  lastBitacoraPrCheckMs = Date.now()
  await update($, historianAtom, h => (h ? { ...h, pr } : h))
}

// Si el PR ofrecido se mergeo o cerro por fuera, la cinta se va en el siguiente chequeo.
async function checkBitacoraPr($: EngineInterface, pr: number) {
  if (Date.now() - lastBitacoraPrCheckMs < PR_CHECK_MS) return
  lastBitacoraPrCheckMs = Date.now()
  const { exitCode, stdout } = await $.process.run(['gh', 'pr', 'view', String(pr), '--json', 'state', '-q', '.state']).catch(() => ({ exitCode: 1, stdout: '' }))
  if (exitCode === 0 && stdout.trim() !== 'OPEN') await dismissHistorian($)
}

async function dismissHistorian($: EngineInterface) {
  await update($, historianAtom, () => null)
  void refreshOpenPrs($)
}

async function mergeBitacoraPr($: EngineInterface) {
  const pr = (await read($, historianAtom))?.pr
  if (!pr) return
  await dismissHistorian($)
  const args = String(pr.number)
  await startMerge($, args)
  await $.command.run({ command: 'mefisto:merge', args })
}

async function openBitacoraPr($: EngineInterface) {
  const pr = (await read($, historianAtom))?.pr
  if (pr) await $.process.run(['gh', 'pr', 'view', String(pr.number), '--web']).catch(() => undefined)
}

async function closeBitacoraPr($: EngineInterface) {
  const pr = (await read($, historianAtom))?.pr
  if (!pr) return
  const answer = await $.ui
    .ask(`¿Cerrar el PR #${pr.number} de la bitácora sin mergear y borrar su rama?`, { header: 'Cerrar PR', options: ['Cerrar PR', 'Cancelar'] })
    .catch(() => null)
  if (answer !== 'Cerrar PR') return
  const { exitCode, stderr } = await $.process
    .run(['gh', 'pr', 'close', String(pr.number), '--delete-branch'])
    .catch(err => ({ exitCode: 1, stderr: String(err) }))
  if (exitCode !== 0) {
    $.ui.toast(`no se pudo cerrar el PR #${pr.number}: ${clip(stderr ?? '', 80)}`)
    return
  }
  $.ui.toast(`PR #${pr.number} cerrado`)
  await dismissHistorian($)
}

// Integrar la bitacora: elegir en el dialogo es la aprobacion; el prompt se envia como mensaje del usuario.
async function chooseBitacora($: EngineInterface) {
  const local = (await read($, fieldNotesAtom)) ?? 0
  const prs = (await read($, openPrsAtom)).filter(p => p.isFieldNote).map(p => p.number)
  if (local + prs.length === 0) return
  const integrate = bitacoraIntegrateLabel(prs.length)
  const answer = await $.ui.ask(bitacoraQuestion(local, prs.length), { header: 'Bitácora', options: [integrate, 'Cancelar'] }).catch(() => null)
  if (answer !== integrate) return
  await $.prompt.submit({ text: bitacoraPrompt(prs), asUser: true })
}

async function refresh($: EngineInterface) {
  if (isRefreshing || !isEligible || !isWanted) return
  isRefreshing = true
  try {
    if (agentChecksLeft > 0) {
      agentChecksLeft -= 1
      const agent = await plannerSession($)
      if (agent !== null) agentChecksLeft = 0
      if (agent === true) {
        isEligible = false
        await deactivate($)
        isWanted = true
        return
      }
    }
    await refreshRuns($)
    await refreshOpenPrs($)
    await refreshFieldNotes($)
    const list = await runNextOrder($)
    await update($, listAtom, () => list)
  } finally {
    isRefreshing = false
  }
}

// El comando queda escrito sin Enter: la persona lo revisa y lo envia (MEF-ADR-0055 decision 2).
async function applyPlan($: EngineInterface, plan: LaunchPlan): Promise<boolean> {
  if (plan.kind === 'none') {
    $.ui.toast(plan.message)
    return false
  }
  const text = plan.kind === 'fill'
    ? plan.text
    : answerText(plan.options, await $.ui.ask(plan.question, plan.options.map(o => o.label)).catch(() => null))
  if (text === null) return false
  await $.prompt.fill({ text, mode: 'replace' })
  return true
}

async function launchKey($: EngineInterface, kind: LaunchKind) {
  const list = await read($, listAtom)
  if (list && !list.error) await applyPlan($, planLaunch(list, kind))
}

async function launchRow($: EngineInterface, issue: number) {
  const item = (await read($, listAtom))?.items.find(i => i.number === issue)
  if (item) await applyPlan($, planIssue(item))
}

async function activate($: EngineInterface) {
  isWanted = true
  await update($, activeAtom, () => true)
  timer?.cancel()
  timer = $.clock.every(POLL_MS, () => void refresh($))
  void loadVersion($)
  runsTimer?.cancel()
  // Ritmo rapido solo con corridas activas; sin ellas, `refresh` las relee al ritmo de los listos (CA-5).
  runsTimer = $.clock.every(RUNS_POLL_MS, () => {
    if (Object.keys(seenRuns).length > 0 || lastBatchIssues !== null || isParallelLive || Date.now() < launchPollUntilMs) void refreshRuns($)
  })
  prTimer?.cancel()
  prTimer = $.clock.every(PR_CHECK_MS, () => {
    void closeMergedPrs($)
    void probeParallelMerged($)
  })
  mergeTimer?.cancel()
  mergeTimer = $.clock.every(MERGE_POLL_MS, () => void pollMerge($))
  tickTimer?.cancel()
  // La mascota anima solo con corrida activa o con Claude trabajando; en reposo no hay re-render por segundo.
  tickTimer = $.clock.every(1000, () => {
    if (isAnimating) void update($, tickAtom, () => Math.floor(Date.now() / 1000))
    void closeStaleMerge($)
    void pollHistorian($)
  })
  void refresh($)
}

async function deactivate($: EngineInterface) {
  isWanted = false
  if (isLogOpen) await closeLog($)
  timer?.cancel()
  timer = null
  runsTimer?.cancel()
  runsTimer = null
  tickTimer?.cancel()
  tickTimer = null
  mergeTimer?.cancel()
  mergeTimer = null
  prTimer?.cancel()
  prTimer = null
  await update($, activeAtom, () => false)
}

async function isMefistoRepo($: EngineInterface): Promise<boolean> {
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel']).catch(() => ({ exitCode: 1, stdout: '' }))
  if (top.exitCode !== 0) return false
  const raw = await $.fs.read(`${top.stdout.trim()}/.claude-plugin/plugin.json`).catch(() => '')
  return typeof raw === 'string' && isMefistoManifest(raw)
}

// Agente principal de la sesion: primero la linea de comando de Claude Code, luego el transcript si ya existe.
async function plannerSession($: EngineInterface): Promise<boolean | null> {
  const ps = await $.process.run(['sh', '-c', 'ps -o args= -p "$PPID"']).catch(() => ({ exitCode: 1, stdout: '' }))
  const cmdline = ps.exitCode === 0 ? ps.stdout.trim() : ''
  if (/\bclaude\b/.test(cmdline)) return agentFlagOf(cmdline) === PLANNER_AGENT
  const home = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const path = transcriptPathOf(home, await $.session.cwd(), await $.session.id())
  const { stdout } = await $.process.run(['head', '-c', '200000', path]).catch(() => ({ stdout: '' }))
  const agent = agentSettingOf(stdout)
  return agent === null ? null : agent === PLANNER_AGENT
}

// El engine no entrega classic.* a un plugin de tier user y session.start no se repite tras /clear, /resume ni /branch:
// cada segundo se compara la intencion del modulo con el atom y se rearma la banda. Corre desde el reloj, donde escribir esta permitido.
async function heal($: EngineInterface) {
  if (isHealing) return
  isHealing = true
  try {
    if (!shouldRearm({ isEligible, isWanted, isActive: await read($, activeAtom) })) return
    await activate($)
    await $.ui.invalidate('ui.render')
  } finally {
    isHealing = false
  }
}

// Cinta vencida: una arrancada por teclas cuyo skill nunca invoco pr-sync.mts (p. ej. descarto todos los PRs).
async function closeStaleMerge($: EngineInterface) {
  if (!isEligible || !isWanted || isMergeScriptSeen) return
  const run = await read($, mergeAtom)
  if (run && run.finishedMs === null && Date.now() - run.startedMs > MERGE_STALE_MS) await endMerge($)
}

export const register: Register = on => {
  // La senal del merge es la llamada Bash a pr-sync.mts: el plugin carga en tier user y el engine no le entrega classic.*.
  // Convive con el tool.call Bash del tablero (mismo matcher, #2302).
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (isEligible && isWanted && isPipelineLaunch(e.command)) {
      launchPollUntilMs = Date.now() + LAUNCH_POLL_WINDOW_MS
      try {
        return await next(e)
      } finally {
        void refreshRuns($)
      }
    }
    const mergeArgs = isEligible && isWanted ? mergeRunArgsOf(e.command) : null
    if (mergeArgs === null) return next(e)
    await startMerge($, mergeArgs)
    isMergeScriptSeen = true
    try {
      return await next(e)
    } finally {
      await endMerge($)
    }
  }).catch(($, e, next) => next(e))

  // Con matcher: el engine admite un solo session.start sin matcher por plugin (el del tablero), y asi `-p` ni lo dispara.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    isEligible = false
    const agent = (await isMefistoRepo($)) ? true : await plannerSession($)
    if (agent === true) {
      await deactivate($)
      isWanted = true
      return next(e)
    }
    isEligible = true
    agentChecksLeft = agent === null ? AGENT_CHECKS : 0
    await $.command.register({
      name: 'fausto-blood-pact',
      description: 'Consola de Fausto: refresh | on | off | ocultar | detener | lanzar | merge | prs | pr | log',
      argumentHint: '[refresh|on|off|ocultar|detener|lanzar [sequential|parallel|<n>]|merge [<pr>...]|prs|pr [<pr>]|log]',
      immediate: true,
    })
    if (isWanted) await activate($)
    healTimer ??= $.clock.every(HEAL_MS, () => void heal($))
    await $.ui.invalidate('ui.render')
    return next(e)
  })

  on('command.run', { command: 'fausto-blood-pact' }, async ($, e) => {
    const arg = e.args.trim()
    if (!isEligible) return { text: 'La consola no aplica en esta sesión.' }
    if (arg === 'off') {
      await deactivate($)
      return { text: 'Consola de Fausto apagada.' }
    }
    if (arg === 'ocultar' || arg === 'descartar') {
      const n = await dismissResults($)
      return { text: n > 0 ? `Resultados ocultados: ${n}.` : 'No hay resultados que ocultar.' }
    }
    if (arg === 'detener') {
      const batch = await read($, batchAtom)
      if (!batch || !isBatchRunning(batch)) {
        if (isParallelRunning(await read($, parallelAtom))) return { text: await confirmStopParallel($) }
        return { text: 'No hay un sequential ni un parallel en curso.' }
      }
      return { text: await confirmStop($) }
    }
    if (arg === 'merge' || arg.startsWith('merge ')) {
      const given = arg.slice('merge'.length).trim()
      if (given === '') return { text: await mergePrs($) }
      const { prs, invalid } = parsePrArgs(given, resultPrs(await read($, resultsAtom)))
      if (prs.length === 0) return { text: `Sin ✓ con PR para: ${invalid.join(' ')}.` }
      return { text: await mergePrs($, prs) }
    }
    if (arg === 'log') {
      if (isLogOpen) return { text: 'El log ya está abierto.' }
      return { text: (await openLog($)) ? 'Log abierto.' : 'No hay corrida que seguir.' }
    }
    if (arg === 'prs') return { text: await mergeOpenPrs($) }
    if (arg === 'pr' || arg.startsWith('pr ')) {
      const given = arg.slice('pr'.length).trim()
      if (given === '') return { text: await viewPr($) }
      const { prs, invalid } = parsePrArgs(given, resultPrs(await read($, resultsAtom)))
      return { text: prs[0] ? await viewPr($, prs[0]) : `Sin ✓ con PR para: ${invalid.join(' ')}.` }
    }
    if (arg === 'lanzar' || arg.startsWith('lanzar ')) {
      const list = await read($, listAtom)
      if (!list || list.error) return { text: 'No hay lista de lanzables.' }
      const target = parseLaunchArg(arg.slice('lanzar'.length), list)
      if (target.kind === 'invalid') return { text: target.message }
      const plan = target.kind === 'launch' ? planLaunch(list, target.launch) : planIssue(list.items.find(i => i.number === target.issue)!)
      if (plan.kind === 'none') return { text: plan.message }
      return { text: (await applyPlan($, plan)) ? 'Comando escrito en el prompt.' : 'Sin cambios en el prompt.' }
    }
    if (arg === 'on' || !isWanted) {
      await activate($)
      return { text: 'Consola de Fausto activa.' }
    }
    await loadVersion($)
    await refresh($)
    return { text: 'Consola actualizada.' }
  })

  // Cerrar el pane por su cuenta (esc o ui.close) tambien suelta los `tail`.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    isLogOpen = false
    await stopFollows()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const run = await read($, paneRunAtom)
    if (!run) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Sin corrida que seguir.</Text>
        </Box>
      )
    }
    const batch = await read($, batchAtom)
    const results = await read($, resultsAtom)
    const lines = await read($, logLinesAtom)
    await read($, tickAtom)
    const width = Math.max(20, e.props.bodyColumns ?? 60)
    const rows = Math.max(3, (e.props.scroll?.bodyRows ?? PANE_ROWS) - PANE_FIXED_ROWS)
    const ended = run.state !== 'running' && run.state !== 'hold'
    const endMs = ended ? Date.parse(run.updated) || Date.now() : Date.now()
    const mins = minutesSince(run.started, endMs)
    const pr = resultPrs(results).find(p => p.issue === run.issue)?.pr ?? (batch ? batchPrOf(batch) : null)
    const colorOf = (l: PaneLine) => (l.kind === 'fail' ? 'error' : l.kind === 'done' ? 'success' : l.kind === 'start' ? 'claude' : undefined)
    return (
      <Box flexDirection="column" width={width}>
        <Box justifyContent="space-between">
          <Text bold color="claude" wrap="truncate-end">{paneHeaderOf(run, batch)}</Text>
          <Text dimColor>{mins === null ? '' : `${mins}m`}</Text>
        </Box>
        {run.title ? <Text wrap="truncate-end">{run.title}</Text> : null}
        <Text wrap="truncate-end">
          {stepsOf(run).map((st, i) => (
            <Text key={`pane-step-${i}`} color={st.color} dimColor={st.dim}>
              {`${i > 0 ? ' ─ ' : ''}${st.mark} ${st.name}`}
              {(() => {
                const d = durationText(run.agents?.[i]?.duration)
                return d ? ` ${d}` : ''
              })()}
            </Text>
          ))}
        </Text>
        {run.state === 'completed' && (
          <Box flexDirection="column">
            <Box gap={3}>
              <Text color="success" bold>✓ {pr ? `PR #${pr} creado` : 'terminado'}</Text>
              {pr && <Button key="merge" hotkey="m" plain variant="primary" label={`Mergear #${pr}`} onPress={() => void mergePrs($, [pr])} />}
              {pr && <Button key="web" hotkey="v" plain label="Ver en GitHub" onPress={() => void viewPr($, pr)} />}
              <Button key="close" hotkey="c" plain label="Cerrar log" role="dismiss" onPress={() => void closeLog($)} />
            </Box>
            <Text dimColor wrap="truncate-end">ctrl+x tab enfoca · esc vuelve al prompt</Text>
          </Box>
        )}
        {isFailure(run) && (
          <Box flexDirection="column">
            <Text color="error" wrap="wrap">✗ falló en {agentOf(run.stage)}{run.lastError ? `: ${run.lastError}` : ''}</Text>
            <Box gap={2}>
              <Button key="close" hotkey="c" plain label="Cerrar log" role="dismiss" onPress={() => void closeLog($)} />
            </Box>
          </Box>
        )}
        {!ended && (
          <Box gap={2}>
            <Button key="close" hotkey="c" plain label="Cerrar log" role="dismiss" onPress={() => void closeLog($)} />
            <Text dimColor>3 en la banda también lo cierra · ctrl+x tab enfoca · esc vuelve al prompt</Text>
          </Box>
        )}
        <Text dimColor>{'─'.repeat(Math.min(width, 80))}</Text>
        <Box flexDirection="column">
          {lines.length === 0 && <Text dimColor>esperando eventos del agente…</Text>}
          {lines.slice(-rows).map((line, i) => (
            <Text key={`pane-line-${i}`} wrap="truncate-end" color={colorOf(line)} dimColor={line.kind === 'log'}>
              {line.text}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const isActive = await read($, activeAtom)
    if (!isEligible || !isWanted || !isActive || e.props.hasSurvey) return next(e)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const inner = Math.max(40, (e.props.bodyColumns ?? 80) - 4)
    const body = Math.max(30, inner - MASCOT_WIDTH - 2)
    const runs = await read($, runsAtom)
    const results = await read($, resultsAtom)
    const batch = await read($, batchAtom)
    const parallel = await read($, parallelAtom)
    const lot = lotViewOf(batch, parallel)
    const bandLines = await read($, bandLinesAtom)
    const openPrs = await read($, openPrsAtom)
    const mergeRun = await read($, mergeAtom)
    await read($, tickAtom)
    const isWorking = Boolean(e.props.isWorking)
    const sec = Math.floor(Date.now() / 1000)
    const batchRun = batch ? batchRunOf(batch, runs) : null
    const active = batch ? batchRun : activeRunOf(runs)
    // El vencimiento se calcula al dibujar: el render nunca escribe estado. La cinta terminada sigue pidiendo
    // re-render por segundo hasta vencer, asi se oculta a los 15 s sin depender de $.clock.after.
    const ribbon = lot === 'parallel' ? null : mergeRibbonShown(batch, mergeRun, Date.now())
    const historian = liveHistorian(await read($, historianAtom), Date.now())
    isAnimating = isWorking || active !== null || (batch !== null && isBatchRunning(batch)) || lot === 'parallel' || ribbon !== null || historian !== null
    const pose: MascotPose | null = active
      ? poseOfRun(active, await read($, lastEventAtom))
      : lot === 'closed-parallel' && parallel
        ? poseOfBatch(parallel)
        : batch
          ? poseOfBatch(batch)
          : poseOfResults(results)
    const grid = ribbon
      ? cropGrid(sprite('merge', ribbon.finishedMs === null ? 'cosiendo' : 'listo', ribbon.finishedMs === null ? (sec % 2 === 0 ? 0 : 1) : 0), MASCOT_COLS)
      : historian && !batch
      ? cropGrid(sprite('historiador', historian.finishedMs ? 'listo' : 'escribiendo', historian.finishedMs ? 0 : sec % 2 === 0 ? 0 : 1), MASCOT_COLS)
      : pose
      ? mascotGrid(pose, active ? (sec % 2 === 0 ? 0 : 1) : 0)
      : cropGrid(waitingFace(face('normal'), isWorking ? sec : null), MASCOT_COLS)
    const version = await read($, versionAtom)
    const list = await read($, listAtom)
    const listosText = list && !list.error ? listosTextOf(list) : ''
    const headRoom = Math.max(8, inner - 20)
    const head = (state: string | null, key: string, stateColor?: string, withListos = true) => (
      <Text key={key} wrap="truncate-end">
        <Text color="claude">mefisto</Text>
        {withListos && listosText && <Text dimColor>{` · ${clip(listosText, headRoom)}`}</Text>}
        {state && (
          <Text color={stateColor} dimColor={!stateColor}>
            {` · ${clip(state, withListos ? Math.max(8, headRoom - listosText.length) : inner - 12)}`}
          </Text>
        )}
      </Text>
    )
    // Vista de corrida (#2320): fila de pasos, titulo del issue y las ultimas lineas; 5 filas fijas.
    const runBody = (run: PipelineRun) => {
      const shown = bandLines.slice(-BAND_LOG_ROWS)
      return [
        <Text key="run-steps" wrap="truncate-end">
          {stepsOf(run).map((st, i) => (
            <Text key={`step-${i}`} color={st.color} dimColor={st.dim}>{`${i > 0 ? ' ─ ' : ''}${st.mark} ${st.name}`}</Text>
          ))}
        </Text>,
        <Text key="run-title" wrap="truncate-end">{run.title ? clip(run.title, body) : ' '}</Text>,
        ...shown.map((l, i) => (
          <Text key={`run-line-${i}`} dimColor wrap="truncate-end">{clip(l, body)}</Text>
        )),
        ...Array.from({ length: Math.max(0, BAND_LOG_ROWS - shown.length) }, (_, i) => <Text key={`run-pad-${i}`}> </Text>),
      ]
    }
    const raster =
      'Raster' in elements ? (
        <elements.Raster key="mefisto-mascota" columns={MASCOT_WIDTH} rows={RASTER_ROWS} cells={toRasterCells(grid, MASCOT_WIDTH)} />
      ) : (
        <Box width={MASCOT_WIDTH} />
      )
    const mascot = version ? (
      <Box key="mefisto-mascota-version" flexDirection="column" width={MASCOT_WIDTH}>
        {raster}
        <Box width={MASCOT_WIDTH} justifyContent="center">
          <Text dimColor wrap="truncate-end">{version}</Text>
        </Box>
      </Box>
    ) : (
      raster
    )
    if (parallel && lot === 'parallel') {
      const head3 = parallelHeader(parallel, Date.now())
      const prs = parallelPrs(parallel)
      const bands = await read($, parallelBandsAtom)
      const stats = await read($, parallelStatsAtom)
      const titleW = summaryTitleWidth(inner)
      const live = parallelRunning(parallel)
      const { page, pages, visible } = paginateBands(live, await read($, parallelPageAtom), PARALLEL_BAND_ROWS)
      const table = parallelTable(parallel, stats, n => bands[String(n)]?.run?.title ?? null, Date.now(), titleW)
      const bandOf = (i: (typeof live)[number]) => {
        const b = bands[String(i.issue)]
        const run = b?.run ?? null
        const pose: MascotPose = run ? poseOfRun(run, b?.last ?? null) : { role: 'desarrollador', state: 'pensando' }
        const grid3 = mascotGrid(pose, sec % 2 === 0 ? 0 : 1)
        const hold = batchHoldLine(run)
        const recent = recentLines(b?.lines ?? [], hold ? BAND_LOG_ROWS - 1 : BAND_LOG_ROWS)
        return (
          <Box key={`pband-${i.issue}`} gap={2} alignItems="flex-start">
            {'Raster' in elements ? (
              <elements.Raster key={`pband-raster-${i.issue}`} columns={MASCOT_WIDTH} rows={RASTER_ROWS} cells={toRasterCells(grid3, MASCOT_WIDTH)} />
            ) : (
              <Box width={MASCOT_WIDTH} />
            )}
            <Box flexDirection="column" width={body}>
              <Text wrap="truncate-end">
                {run
                  ? stepsOf(run).map((st, n) => (
                      <Text key={`pstep-${i.issue}-${n}`} color={st.color} dimColor={st.dim}>{`${n > 0 ? ' ─ ' : ''}${st.mark} ${st.name}`}</Text>
                    ))
                  : ' '}
              </Text>
              <Text dimColor wrap="truncate-end">{clip(`#${i.issue} ${run?.title ?? ''}`.trim(), body)}</Text>
              {hold ? <Text color="warning" wrap="truncate-end">{clip(hold, body)}</Text> : null}
              {recent.map((l, n) => (
                <Text key={`pline-${i.issue}-${n}`} color={l.color} wrap="truncate-end">{clip(`${l.ts} ${l.text}`, body)}</Text>
              ))}
              {Array.from({ length: Math.max(0, BAND_LOG_ROWS - recent.length - (hold ? 1 : 0)) }, (_, n) => (
                <Text key={`ppad-${i.issue}-${n}`}> </Text>
              ))}
            </Box>
          </Box>
        )
      }
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="claude" borderDimColor paddingX={1}>
          <Box justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color="claude">mefisto</Text>
              <Text> · {head3.progress}</Text>
              {head3.time !== '' && <Text dimColor> {head3.time}</Text>}
              {head3.stopNote !== '' && <Text color="warning"> · {head3.stopNote}</Text>}
            </Text>
            <Box gap={2}>
              {canStopParallel(parallel) && <Button key="par-stop" hotkey="1" plain label="detener" onPress={() => void confirmStopParallel($)} />}
              {prs.length > 0 && <Button key="par-pr" hotkey="2" plain label="ver PR" onPress={() => void viewParallelPr($)} />}
              <Button key="par-log" hotkey="3" plain dimColor label="log" onPress={() => void toggleLog($)} />
              {pages > 1 && (
                <Button key="par-page" hotkey="0" plain dimColor label={`página ${page + 1}/${pages} ▸`}
                  onPress={() => void update($, parallelPageAtom, () => (page + 1) % pages)} />
              )}
            </Box>
          </Box>
          <Text wrap="truncate-end">
            {parallelQueueMarks(parallel).map((m, n) => (
              <Text key={`pq-${n}`} color={m.color} dimColor={m.color === undefined}>{`${n > 0 ? ' ─ ' : ''}${m.text}`}</Text>
            ))}
          </Text>
          {visible.length === 0 && <Text dimColor>preparando los primeros issues…</Text>}
          {visible.map(bandOf)}
          {table.rows.length > 0 && (
            <Box flexDirection="column">
              {table.rows.map(r => (
                <Text key={r.key} wrap="truncate-end" color={r.color}>
                  {`${r.mark} ${r.lead}`}
                  <Text dimColor>{r.trail}</Text>
                </Text>
              ))}
              {table.total && <Text dimColor wrap="truncate-end">{table.total}</Text>}
            </Box>
          )}
        </Box>
      )
    }
    // Mientras corre un merge lanzado desde aqui, la cinta de merge toma la banda (como en las corridas terminadas).
    if (parallel && lot === 'closed-parallel' && !ribbon) {
      const hdr = parallelClosedHeader(parallel)
      const prs = parallelPrs(parallel)
      const mergeable = parallelMergeablePrs(parallel, new Set(await read($, parallelMergedAtom)))
      const stats = await read($, parallelStatsAtom)
      const table = parallelClosedTable(parallel, stats, summaryTitleWidth(inner))
      const failed = parallelFailedIssue(parallel)
      const endColor = parallel.state === 'completed' ? 'success' : parallel.state === 'stopped' ? 'warning' : 'error'
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="claude" borderDimColor paddingX={1}>
          <Box justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color="claude">mefisto</Text>
              <Text> · {hdr.progress}</Text>
              <Text color={endColor}> · {hdr.label}</Text>
              {hdr.time !== '' && <Text dimColor> {hdr.time}</Text>}
            </Text>
            <Box gap={2}>
              {mergeable.length > 0 && <Button key="par-merge" hotkey="1" plain label="mergear" onPress={() => void mergeParallel($)} />}
              {prs.length > 0 && <Button key="par-pr" hotkey="2" plain label="ver PR" onPress={() => void viewParallelPr($)} />}
              <Button key="par-log" hotkey="3" plain label="log" onPress={() => void toggleLog($)} />
              <Button key="par-close" hotkey="4" plain label="cerrar" onPress={() => void closeParallel($)} />
            </Box>
          </Box>
          <Box gap={2} alignItems="flex-start">
            {mascot}
            <Box flexDirection="column" width={body}>
              <Text wrap="truncate-end">
                {parallelQueueMarks(parallel).map((m, n) => (
                  <Text key={`pcq-${n}`} color={m.color} dimColor={m.color === undefined}>{`${n > 0 ? ' ─ ' : ''}${m.text}`}</Text>
                ))}
              </Text>
              <Text wrap="truncate-end">{parallelSummaryMarks(parallel)}</Text>
              {failed && <Text color="error" wrap="truncate-end">#{failed.issue} {failed.detail.replace(/^ERROR:\s*/, '')}</Text>}
            </Box>
          </Box>
          {table.rows.length > 0 && (
            <Box flexDirection="column">
              {table.rows.map(r => (
                <Text key={r.key} wrap="truncate-end" color={r.color}>
                  {`${r.mark} ${r.lead}`}
                  <Text dimColor>{r.trail}</Text>
                </Text>
              ))}
              {table.total && <Text dimColor wrap="truncate-end">{table.total}</Text>}
            </Box>
          )}
        </Box>
      )
    }
    if (batch) {
      const running = isBatchRunning(batch)
      const c = batchCounts(batch)
      const pr = batchPrOf(batch)
      const { stats, endedMs } = await read($, batchStatsAtom)
      const markColor = (s: string) => (s === 'mergeado' ? 'success' : s === 'fallido' ? 'error' : undefined)
      const doneRows = batch.issues.filter(i => i.status === 'mergeado' || i.status === 'fallido')
      const titleW = summaryTitleWidth(inner)
      const startedMs = stampToMs(batch.started)
      const currentRow = await read($, batchCurrentAtom)
      // Tabla a todo el ancho: terminados y, con el lote en curso, la fila `●` del issue en curso.
      const batchTable = (() => {
        const cur = running ? batchCurrentOf(batch) : null
        const curRow = cur && currentRow && currentRow.run.issue === cur.issue && !doneRows.some(i => i.issue === cur.issue) ? currentRow : null
        const curRun = curRow ? curRow.run : null
        const nowMs = curRow?.endMs ?? Date.now()
        const curStartedMs = curRun ? stampToMs(curRun.started) : 0
        const curText = cur && curRun ? runningRowText(cur.issue, cur.pr, curRun.title ?? null, curStartedMs, nowMs, titleW) : null
        const rowCount = doneRows.length + (curText ? 1 : 0)
        if (rowCount === 0) return null
        const doneTotal = statsTotal(doneRows.map(i => stats[String(i.issue)]).filter((st): st is IssueStats => st !== undefined))
        const total = curText ? totalWithRunning(doneTotal, curStartedMs, nowMs) : doneTotal
        return (
          <Box flexDirection="column">
            {doneRows.map(i => {
              const row = closeRowText(i, stats[String(i.issue)], titleW)
              return (
                <Text key={`done-${i.issue}`} wrap="truncate-end" color={markColor(i.status)}>
                  {`${batchMark(i.status)} ${row.lead}`}
                  <Text dimColor>{row.trail}</Text>
                </Text>
              )
            })}
            {cur && curText && (
              <Text key={`cur-${cur.issue}`} wrap="truncate-end" color="warning">
                {`● ${curText.lead}`}
                <Text dimColor>{curText.trail}</Text>
              </Text>
            )}
            {rowCount > 1 && <Text dimColor wrap="truncate-end">{closeTotalText(rowCount, total, titleW)}</Text>}
          </Box>
        )
      })()
      if (!running) {
        // Cierre del lote: misma vista que la cinta interna (cabecera con acciones, cola y resumen junto a la mascota, tabla a todo el ancho).
        const failedIssue = batch.issues.find(i => i.status === 'fallido')
        const endColor = batch.state === 'completed' ? 'success' : batch.state === 'stopped' ? 'warning' : 'error'
        return (
          <Box flexDirection="column" borderStyle="round" borderColor="claude" borderDimColor paddingX={1}>
            <Box justifyContent="space-between">
              <Text wrap="truncate-end">
                <Text color="claude">mefisto</Text>
                <Text> · sequential {c.merged + c.failed}/{c.total}</Text>
                <Text color={endColor}> · {batchEndLabel(batch.state)}</Text>
                {startedMs > 0 && endedMs !== null && <Text dimColor> {elapsedText(endedMs - startedMs)}</Text>}
              </Text>
              <Box gap={2}>
                {pr && <Button key="batch-pr" hotkey="2" plain label={`ver PR #${pr}`} onPress={() => void viewBatchPr($)} />}
                <Button key="batch-log" hotkey="3" plain label="log" onPress={() => void toggleLog($)} />
                <Button key="batch-close" hotkey="4" plain label="cerrar" onPress={() => void closeBatch($)} />
              </Box>
            </Box>
            <Box gap={2} alignItems="flex-start">
              {mascot}
              <Box flexDirection="column" width={body}>
                <Text wrap="truncate-end">
                  {batch.issues.map((i, n) => (
                    <Text key={`q-${i.issue}`} color={markColor(i.status)} dimColor={markColor(i.status) === undefined}>
                      {`${n > 0 ? ' ─ ' : ''}${batchMark(i.status)} #${i.issue}`}
                    </Text>
                  ))}
                </Text>
                <Text wrap="truncate-end">{batchSummaryMarks(batch)}</Text>
                {failedIssue && (
                  <Text color="error" wrap="truncate-end">#{failedIssue.issue} {failedIssue.detail.replace(/^ERROR:\s*/, '')}</Text>
                )}
              </Box>
            </Box>
            {batchTable}
          </Box>
        )
      }
      // Lote en curso: misma vista que la cinta interna (cabecera con acciones, cola con paso, titulo y ultimas lineas junto a la mascota).
      const head2 = batchRunningHeader(batch, Date.now())
      const recent = recentLines(bandLines, BAND_LOG_ROWS)
      const holdLine = batchHoldLine(batchRun)
      const current = batchCurrentOf(batch)
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="claude" borderDimColor paddingX={1}>
          <Box justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color="claude">mefisto</Text>
              <Text> · {head2.progress}</Text>
              {head2.time !== '' && <Text dimColor> {head2.time}</Text>}
              {head2.stopNote !== '' && <Text color="warning"> · {head2.stopNote}</Text>}
            </Text>
            <Box gap={2}>
              {canStopBatch(batch) && !batch.stopRequested && (
                <Button key="batch-stop" hotkey="1" plain label="detener" onPress={() => void confirmStop($)} />
              )}
              {pr && <Button key="batch-pr" hotkey="2" plain label={`ver PR #${pr}`} onPress={() => void viewBatchPr($)} />}
              <Button key="batch-log" hotkey="3" plain dimColor label="log" onPress={() => void toggleLog($)} />
            </Box>
          </Box>
          <Box gap={2} alignItems="flex-start">
            {mascot}
            <Box flexDirection="column" width={body} marginTop={1}>
              <Text wrap="truncate-end">
                {batchQueueMarks(batch, batchRun ? agentOf(batchRun.stage) : null).map((m, n) => (
                  <Text key={`q-${n}`} color={m.color} dimColor={m.color === undefined}>
                    {`${n > 0 ? ' ─ ' : ''}${m.text}`}
                  </Text>
                ))}
              </Text>
              <Text dimColor wrap="truncate-end">
                {batchRun
                  ? clip(`#${batchRun.issue} ${batchRun.title}`.trim(), body)
                  : current
                    ? `#${current.issue}`
                    : 'preparando el primer issue…'}
              </Text>
              {holdLine ? <Text color="warning" wrap="truncate-end">{clip(holdLine, body)}</Text> : <Text> </Text>}
              {recent.map((l, i) => (
                <Text key={`recent-${i}`} color={l.color} wrap="truncate-end">{clip(`${l.ts} ${l.text}`, body)}</Text>
              ))}
              {Array.from({ length: Math.max(0, BAND_LOG_ROWS - recent.length) }, (_, i) => (
                <Text key={`recent-pad-${i}`}> </Text>
              ))}
            </Box>
          </Box>
          {batchTable}
        </Box>
      )
    }
    if (ribbon) {
      const rows = mergeRibbonRows(ribbon)
      const shown = rows.length > PAGE_ROWS ? PAGE_ROWS - 1 : PAGE_ROWS
      const visible = rows.slice(0, shown)
      const hidden = rows.length - visible.length
      const finished = ribbon.finishedMs !== null
      const header = mergeRibbonHeader(ribbon, Date.now())
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="claude" borderDimColor paddingX={1}>
          {head(header, 'pact-head')}
          <Box gap={2} alignItems="flex-start">
            {mascot}
            <Box flexDirection="column" width={body}>
              {visible.map(p => (
                <Text key={`m-${p.num}`} color={p.estado === 'mergeado' ? 'success' : p.estado === 'fallido' ? 'error' : undefined} dimColor={p.estado === 'pendiente'} wrap="truncate-end">
                  {mergeRibbonLine(p, body)}
                </Text>
              ))}
              {hidden > 0 && <Text dimColor>{`+${hidden} más`}</Text>}
              {Array.from({ length: Math.max(0, PAGE_ROWS - visible.length - (hidden > 0 ? 1 : 0)) }, (_, i) => (
                <Text key={`blank-${i}`}> </Text>
              ))}
              <Box>
                {finished ? (
                  <Button key="merge-close" hotkey="4" plain dimColor label="cerrar" onPress={() => void closeMerge($)} />
                ) : (
                  <Text dimColor> </Text>
                )}
              </Box>
            </Box>
          </Box>
        </Box>
      )
    }
    if (historian) {
      const bitacoraPr = historian.pr
      const notes = orderedNotes(historian.notes)
      const slots = PAGE_ROWS - (bitacoraPr ? 1 : 0)
      const shown = notes.length > slots ? slots - 1 : slots
      const visible = notes.slice(0, shown)
      const hidden = notes.length - visible.length
      const used = (bitacoraPr ? 1 : 0) + visible.length + (hidden > 0 ? 1 : 0) + (historian.notes.length === 0 ? 1 : 0)
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="claude" borderDimColor paddingX={1}>
          <Box justifyContent="space-between">
            {historian.finishedMs
              ? head(`bitácora escrita${bitacoraPr ? ` · PR #${bitacoraPr.number}` : ''}`, 'pact-head', 'success')
              : head(historianHeader(historian, Date.now()), 'pact-head', 'warning')}
            {bitacoraPr && (
              <Box>
                {withSeparators([
                  <Button key="bitacora-merge" hotkey="1" plain dimColor label="mergear" onPress={() => void mergeBitacoraPr($)} />,
                  <Button key="bitacora-web" hotkey="2" plain dimColor label="ver PR" onPress={() => void openBitacoraPr($)} />,
                  <Button key="bitacora-close" hotkey="3" plain dimColor label="cerrar PR" onPress={() => void closeBitacoraPr($)} />,
                ], Text)}
              </Box>
            )}
          </Box>
          <Box gap={2} alignItems="flex-start">
            {mascot}
            <Box flexDirection="column" width={body}>
              {bitacoraPr && <Text wrap="truncate-end">{clip(`PR #${bitacoraPr.number} ${bitacoraPr.title}`, body)}</Text>}
              {historian.notes.length === 0 && <Text dimColor>leyendo las field notes…</Text>}
              {visible.map(n => (
                <Text key={`note-${n.name}`} color={n.estado === 'procesada' ? 'success' : undefined} wrap="truncate-end">{clip(noteLine(n), body)}</Text>
              ))}
              {hidden > 0 && <Text dimColor>{`+${hidden} más`}</Text>}
              {Array.from({ length: Math.max(0, PAGE_ROWS - used) }, (_, i) => (
                <Text key={`blank-${i}`}> </Text>
              ))}
            </Box>
          </Box>
        </Box>
      )
    }
    const hasPrs = resultPrs(results).length > 0
    const lines = [
      ...runs.map(r => ({ key: `run-${r.pipeline}-${r.issue}-${r.variant ?? ''}`, text: runLine(r, Date.now()), color: undefined as string | undefined })),
      ...results.map(r => ({ key: `res-${r.key}`, text: resultLine(r), color: r.ok ? 'success' : 'error' })),
    ]
    const soleRun = runs.length === 1 && results.length === 0 ? (runs[0] as PipelineRun) : null
    if (soleRun && bandViewOf(runs, results) === 'runs') {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="claude" borderDimColor paddingX={1}>
          {head(runHeader(soleRun, Date.now()), 'pact-head', soleRun.state === 'hold' ? 'warning' : undefined, false)}
          <Box gap={2} alignItems="flex-start">
            {mascot}
            <Box flexDirection="column" width={body}>
              {runBody(soleRun)}
              <Box>
                <Button key="run-log" hotkey="3" plain dimColor={soleRun.state === 'running'} label="log" onPress={() => void toggleLog($)} />
              </Box>
            </Box>
          </Box>
        </Box>
      )
    }
    if (bandViewOf(runs, results) === 'runs') {
      const { page, pages } = pageOf(await read($, pageAtom), lines.length, PAGE_ROWS)
      const visible = lines.slice(page * PAGE_ROWS, (page + 1) * PAGE_ROWS)
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="claude" borderDimColor paddingX={1}>
          {head(`corridas ${runs.length} activas`, 'pact-head')}
          <Box gap={2} alignItems="flex-start">
            {mascot}
            <Box flexDirection="column" width={body}>
              {visible.map(l => (
                <Text key={l.key} color={l.color} wrap="truncate-end">{clip(l.text, body)}</Text>
              ))}
              {Array.from({ length: Math.max(0, PAGE_ROWS - visible.length) }, (_, i) => (
                <Text key={`blank-${i}`}> </Text>
              ))}
              <Box justifyContent="space-between">
                {results.length > 0 ? (
                  <Box>
                    {withSeparators([
                      hasPrs && (
                        <Button key="pact-merge" hotkey="1" plain dimColor label="mergear"
                          onPress={() => void mergePrs($)} />
                      ),
                      hasPrs && (
                        <Button key="pact-view-pr" hotkey="2" plain dimColor label="ver PR"
                          onPress={() => void viewPr($)} />
                      ),
                      <Button key="pact-dismiss" hotkey="4" plain dimColor label="ocultar"
                        onPress={() => void dismissResults($)} />,
                    ], Text)}
                  </Box>
                ) : (
                  <Text dimColor> </Text>
                )}
                {pages > 1 && (
                  <Button key="pact-next-page" hotkey="0" plain dimColor label={`página ${page + 1}/${pages} ▸`}
                    onPress={() => void update($, pageAtom, () => (page + 1) % pages)} />
                )}
              </Box>
            </Box>
          </Box>
        </Box>
      )
    }
    if (!list) void refresh($)
    const allRows = boardRowsOf(list)
    const { page, pages } = pageOf(await read($, pageAtom), allRows.length, PAGE_ROWS)
    const visibleRows = allRows.slice(page * PAGE_ROWS, (page + 1) * PAGE_ROWS)
    const visible = visibleRows.map(r => r.item)
    const numWidth = numberWidth(visible)
    const afterWidth = Math.min(16, Math.max(0, ...visibleRows.map(r => (r.kind === 'launch' ? reasonOf(r.item).length : 0))))
    const titleWidth = Math.max(12, body - 3 - 2 - numWidth - 1 - (afterWidth > 0 ? afterWidth + 2 : 0))
    const notesCount = bitacoraCount(await read($, fieldNotesAtom), openPrs)
    const footerRest = list ? footerRestOf(list, Boolean(list.launch || list.parallel?.launch)) : ''
    const hasFooter = Boolean(list?.launch || list?.parallel?.launch || footerRest !== '' || pages > 1)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="claude" borderDimColor paddingX={1}>
        <Box justifyContent="space-between">
          {head(null, 'pact-head')}
          {(openPrs.length > 0 || notesCount > 0) && (
            <Box gap={2}>
              {openPrs.length > 0 && (
                <Button key="pact-open-prs" hotkey="2" plain dimColor label={`PRs ${openPrs.length}`}
                  onPress={() => void mergeOpenPrs($)} />
              )}
              {notesCount > 0 && (
                <Button key="pact-bitacora" hotkey="3" plain dimColor label={`bitácora ${notesCount}`}
                  onPress={() => void chooseBitacora($)} />
              )}
            </Box>
          )}
        </Box>
        <Box gap={2} alignItems="flex-start">
          {mascot}
          <Box flexDirection="column" width={body} marginTop={1} marginBottom={hasFooter ? 1 : 0}>
            {!list && <Text dimColor>cargando…</Text>}
            {list?.error && <Text color="error">next-order falló: {clip(list.error, body - 20)}</Text>}
            {list && !list.error && visibleRows.length === 0 && <Text dimColor>Sin issues en estado:listo.</Text>}
            {visibleRows.map((r, i) => {
              if (r.kind === 'inpr') {
                const pr = inPrRowParts(r.item, numWidth, titleWidth + (afterWidth > 0 ? afterWidth + 2 : 0))
                return (
                  <Box key={`row-pr-${r.item.number}`}>
                    <Text color={pr.color}>{`${pr.letter} `}</Text>
                    <Text dimColor wrap="truncate-end">{pr.label}</Text>
                  </Box>
                )
              }
              const item = r.item
              const row = rowParts(item, numWidth, titleWidth)
              return (
                <Box key={`row-${item.number}`}>
                  <Text color={row.color}>{`${row.letter} `}</Text>
                  <Button hotkey={ROW_KEYS[i] as string} plain dimColor={page > 0 || i > 0}
                    label={afterWidth > 0 ? padEnd(row.label, numWidth + 1 + titleWidth) : row.label}
                    onPress={() => void launchRow($, item.number)} />
                  <Text dimColor>{row.after ? `  ${clip(row.after, afterWidth)}` : ''}</Text>
                </Box>
              )
            })}
            {Array.from({ length: Math.max(0, PAGE_ROWS - Math.max(visibleRows.length, 1)) }, (_, i) => (
              <Text key={`blank-${i}`}> </Text>
            ))}
            {results.length > 0 && (
              <Box>
                <Text dimColor wrap="truncate-end">{resultsFooterText(results, Math.max(12, body - 12))}</Text>
                <Text dimColor> · </Text>
                <Button key="pact-dismiss-rest" plain dimColor label="ocultar" onPress={() => void dismissResults($)} />
              </Box>
            )}
          </Box>
        </Box>
        {hasFooter && (
          <Box justifyContent="space-between">
            <Box>
              {withSeparators([
                list?.launch && (
                  <Button key="pact-sequential" hotkey="1" plain dimColor label={`sequential ${launchCountOf(list.launch)}`}
                    onPress={() => void launchKey($, 'sequential')} />
                ),
                list?.parallel?.launch && (
                  <Button key="pact-parallel" hotkey="4" plain dimColor label={`parallel ${list.parallel.issues.length}`}
                    onPress={() => void launchKey($, 'parallel')} />
                ),
              ], Text)}
              <Text dimColor>{footerRest}</Text>
            </Box>
            {pages > 1 && (
              <Button key="pact-next-page" hotkey="0" plain dimColor label={`página ${page + 1}/${pages} ▸`}
                onPress={() => void update($, pageAtom, () => (page + 1) % pages)} />
            )}
          </Box>
        )}
      </Box>
    )
  })
}

/** Intercala ` · ` (fuera de los botones) solo entre elementos visibles; descarta los falsos. */
function withSeparators(items: unknown[], Text: any): unknown[] {
  const shown = items.filter(Boolean)
  return shown.flatMap((el, i) => (i === 0 ? [el] : [<Text key={`sep-${i}`} dimColor> · </Text>, el]))
}
