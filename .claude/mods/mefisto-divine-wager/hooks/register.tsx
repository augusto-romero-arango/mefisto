import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BatchRun, LogLine, PipelineRun, ReadyList, Release, ReleaseStep } from '../types'
import {
  BATCH_STATUS,
  EVENTS_LOG,
  BATCH_STOP,
  HISTORY,
  LOG_DIR,
  NEXT_ORDER,
  PLANNER_AGENT,
  READY_ROWS,
  agentFlagOf,
  agentOfEventsFile,
  batchCounts,
  batchFromStatus,
  batchIssuesOf,
  batchPr,
  batchSummary,
  clip,
  elapsed,
  cropGrid,
  finishedFromHistory,
  fmtCost,
  issueStatsFromHistory,
  fitTitle,
  summaryTitleWidth,
  statsPending,
  currentRowParts,
  totalRowText,
  issueMark,
  mascotPose,
  isReleasePrompt,
  isReleaseRun,
  holdOf,
  holdText,
  bitacoraPrompt,
  changelogOf,
  fieldNotesIn,
  releaseArgsOf,
  releaseOptions,
  releaseInvocationOf,
  releasePlan,
  releaseIssuesOf,
  releaseBranchOf,
  releaseTagOf,
  releaseChecklist,
  releaseHeader,
  isConsolidated,
  withObservedSteps,
  finishRelease,
  mergeArgsOf,
  mergeOptions,
  newlyMerged,
  padEnd,
  pageOf,
  parseNextOrder,
  parseOpenPrs,
  readyRows,
  sequentialOf,
  titlesOf,
  toolingOf,
  waitingFace,
  parseEvent,
  pickEventsFile,
  prNumber,
  runFromStatus,
  statusPath,
  steps,
  toolingIssueOf,
  usedColumns,
  historianFrom,
  isAgentActive,
  bitacoraPrOf,
  fieldNoteNamesOf,
  pendingNotes,
  processedDirsOf,
  withProcessedNotes,
  finishMerge,
  ghMergeNumbersOf,
  isGhMergeRun,
  mergeCounts,
  mergeHeader,
  mergeOutcomesOf,
  mergePromptArgs,
  mergePrsOf,
  withMergeOutcomes,
  liveTape,
} from './logic'
import { DEFAULT_COLOR, HEIGHT, PALETTE, RASTER_ROWS, face, sprite } from './sprites'

const PANE = 'mefisto-divine-wager'
const MAX_LINES = 200
const STATUS_GRACE_MS = 30_000
// Un seguimiento que tras este tiempo sigue en setup sin status ni historial no corresponde a ninguna corrida.
const ORPHAN_MS = 120_000
const PANE_ROWS = 16
const FIXED_ROWS = 7
const PR_CHECK_MS = 15_000
const READY_POLL_MS = 60_000
const BAND_LOG_ROWS = 3
const STATS_EVERY_MS = 5_000
const HOLD_EVERY_MS = 5_000
const HISTORIAN = 'mefisto-historiador'
// Tras terminar, el historiador queda en pose de listo este tiempo antes de volver a la espera.
const HISTORIAN_DONE_MS = 8_000
const FIELD_NOTES_DIR = 'docs/bitacora/field-notes'
const SUMMARIES_DIR = '.mefisto/pipeline/summaries'
const NOTES_POLL_MS = 3_000
const CHANGELOG_DIR = 'changelog.d'

// Las rutas del mod son relativas a la raiz del repo, no al cwd de la sesion: este cambia con cada `cd` del
// asistente, y desde otro directorio un script relativo no arranca y $.fs no encuentra el estado del pipeline.
let repoRootCache: string | null = null
async function repoRoot($: EngineInterface): Promise<string | null> {
  if (!repoRootCache) repoRootCache = (await $.session.repo().catch(() => null))?.root ?? null
  return repoRootCache
}
async function inRepo($: EngineInterface, path: string): Promise<string> {
  const root = await repoRoot($)
  return root && !path.startsWith('/') ? `${root}/${path}` : path
}
async function runInRepo($: EngineInterface, argv: string[], init: { timeoutMs?: number } = {}) {
  const root = await repoRoot($)
  return $.process.run(argv, root ? { ...init, cwd: root } : init)
}
const SCRIPT_TIMEOUT_MS = 180_000
// Respaldo del avance de la cinta de merge: el bucle de /mefisto-merge es un solo Bash y su salida llega al final.
const MERGE_POLL_MS = 5_000
// Sin ningun `gh pr merge` a la vista, una cinta que pasa este tiempo se cierra al terminar el turno.
const MERGE_STALE_MS = 10 * 60_000
/** Cada cuanto se sondea la fase del release en GitHub mientras corre su script. */
const RELEASE_POLL_MS = 5_000
/** Cuanto queda en la banda el release terminado, con su boton para abrirlo. */
const RELEASE_DONE_MS = 15_000
const PLUGIN_JSON = '.claude-plugin/plugin.json'

// Recorte comun a todos los cuadros que usa la consola, calculado una vez: sin margen y sin saltos al alternar.
const MASCOT_POSES = [
  ['desarrollador', 'trabajando'],
  ['desarrollador', 'pensando'],
  ['desarrollador', 'error'],
  ['revisor', 'trabajando'],
  ['revisor', 'pensando'],
  ['revisor', 'corrigiendo'],
  ['revisor', 'aprobado'],
  ['historiador', 'escribiendo'],
  ['historiador', 'listo'],
  ['release', 'reposo'],
  ['release', 'despegando'],
  ['release', 'listo'],
  ['merge', 'cosiendo'],
  ['merge', 'listo'],
] as const
const MASCOT_COLS = usedColumns([
  ...MASCOT_POSES.flatMap(([role, state]) => [sprite(role, state, 0), sprite(role, state, 1)]),
  face('normal'),
])
const MASCOT_WIDTH = MASCOT_COLS.to - MASCOT_COLS.from + 1

/** Celdas del Raster (dos pixeles por celda con ▀/▄), como toRasterCells de sprites.ts pero con el ancho recortado. */
function mascotCells(grid: readonly string[]): string {
  const color = (ch: string | undefined) => (!ch || ch === '.' || ch === ' ' ? null : (PALETTE[ch] ?? null))
  const words: number[] = []
  for (let y = 0; y < HEIGHT; y += 2) {
    for (let x = 0; x < MASCOT_WIDTH; x++) {
      const top = color(grid[y]?.[x])
      const bottom = color(grid[y + 1]?.[x])
      if (top !== null) words.push(0x2580, top, bottom ?? DEFAULT_COLOR)
      else if (bottom !== null) words.push(0x2584, bottom, DEFAULT_COLOR)
      else words.push(0x20, DEFAULT_COLOR, DEFAULT_COLOR)
    }
  }
  let bin = ''
  for (const b of new Uint8Array(Uint32Array.from(words).buffer)) bin += String.fromCharCode(b)
  return btoa(bin)
}

const runAtom = atom({ plugin: 'mefisto-divine-wager', key: 'run' } as const, null)
const linesAtom = atom({ plugin: 'mefisto-divine-wager', key: 'lines' } as const, [])
const nowAtom = atom({ plugin: 'mefisto-divine-wager', key: 'now' } as const, 0)
const executionAtom = atom({ plugin: 'mefisto-divine-wager', key: 'isExecutionSession' } as const, false)
const readyAtom = atom({ plugin: 'mefisto-divine-wager', key: 'ready' } as const, null)
const readyPageAtom = atom({ plugin: 'mefisto-divine-wager', key: 'readyPage' } as const, 0)
const batchAtom = atom({ plugin: 'mefisto-divine-wager', key: 'batch' } as const, null)
const openPrsAtom = atom({ plugin: 'mefisto-divine-wager', key: 'openPrs' } as const, null)
const fieldNotesAtom = atom({ plugin: 'mefisto-divine-wager', key: 'fieldNotes' } as const, null)
const changelogAtom = atom({ plugin: 'mefisto-divine-wager', key: 'changelog' } as const, null)
const holdAtom = atom({ plugin: 'mefisto-divine-wager', key: 'hold' } as const, null)
const historianAtom = atom({ plugin: 'mefisto-divine-wager', key: 'historian' } as const, null)
const releaseAtom = atom({ plugin: 'mefisto-divine-wager', key: 'release' } as const, null)
const mergeAtom = atom({ plugin: 'mefisto-divine-wager', key: 'merge' } as const, null)

type Tail = { path: string; stream: AsyncGenerator<unknown, unknown> }

let tail: Tail | null = null
let watchSinceMs = 0
let batchSinceMs = 0
let lastStatsReadMs = 0
let lastHoldReadMs = 0
let isPolling = false
// Una sesion no interactiva (los agentes de los pipelines) no tiene a nadie mirando: el mod no sigue nada.
let isInteractive = false
let lastPrCheckMs = 0
let isLogOpen = false
let isRefreshingReady = false
let readyTimer: { cancel: () => void } | null = null
// La banda en reposo vive en el modulo, no en atoms: /clear, /resume y /branch los reinician y el modulo sigue.
let isExecutionOn = false
let lastMergePollMs = 0
let isMergeSeen = false
let lastReleasePollMs = 0
let isReleaseScriptSeen = false
let lastNotesPollMs = 0
let lastBitacoraPrCheckMs = 0

async function stopTail() {
  const current = tail
  tail = null
  if (current) await current.stream.return(undefined).catch(() => undefined)
}

async function pushLines($: EngineInterface, added: LogLine[]) {
  if (added.length === 0) return
  await update($, linesAtom, list => [...(list ?? []), ...added].slice(-MAX_LINES))
}

async function followTail($: EngineInterface, stream: AsyncGenerator<unknown, unknown>, path: string) {
  let pending = ''
  try {
    for await (const chunk of stream) {
      if (tail?.stream !== stream) break
      const { stream: kind, text } = chunk as { stream: string; text: string }
      if (kind !== 'stdout') continue
      pending += text
      const rows = pending.split('\n')
      pending = rows.pop() ?? ''
      await pushLines($, rows.map(parseEvent).filter((l): l is LogLine => l !== null))
    }
  } catch (err) {
    $.ui.log(`tail ${path}: ${String(err)}`, { to: 'debug' })
  }
}

async function startTail($: EngineInterface, name: string) {
  await stopTail()
  const path = `${LOG_DIR}/${name}`
  const root = await repoRoot($)
  const stream = $.process.spawn({ argv: ['tail', '-n', '40', '-F', path], ...(root ? { cwd: root } : {}) })
  tail = { path, stream }
  await pushLines($, [{ ts: '', kind: 'start', text: `── ${agentOfEventsFile(name)} ──` }])
  void followTail($, stream, path)
}

// En un batch cada eslabon se sigue igual que un /mefisto-tooling suelto, pero el log acumula todos los issues.
async function watch($: EngineInterface, issue: string, sinceMs: number, keepLines = false) {
  await stopTail()
  watchSinceMs = sinceMs
  const run: PipelineRun = {
    issue,
    title: '',
    stage: 'setup',
    state: 'running',
    startedMs: Date.now(),
    finishedMs: null,
    agents: {},
    pr: null,
    lastError: null,
    eventsFile: null,
  }
  await update($, runAtom, () => run)
  if (keepLines) await pushLines($, [{ ts: '', kind: 'start', text: `══ #${issue} ══` }])
  else await update($, linesAtom, () => [])
  await poll($)
}

async function watchBatch($: EngineInterface, issues: string[], sinceMs: number) {
  await stopTail()
  batchSinceMs = sinceMs
  const batch: BatchRun = {
    issues: issues.map(issue => ({ issue, status: 'pendiente', pr: null })),
    state: 'running',
    current: null,
    stopRequested: false,
    holdSeconds: 0,
    startedMs: Date.now(),
    finishedMs: null,
    stats: {},
  }
  await update($, runAtom, () => null)
  await update($, linesAtom, () => [])
  await update($, batchAtom, () => batch)
}

// Duracion, costo y titulo de cada terminado: se leen del historial cuando falta alguno o su titulo, a lo
// sumo cada STATS_EVERY_MS (un fallido antes de escribir su historial no los tendra nunca).
async function withStats($: EngineInterface, batch: BatchRun): Promise<BatchRun> {
  const stats = batch.stats ?? {}
  const finished = batch.issues.filter(i => ['done', 'failed'].includes(issueMark(i.status))).map(i => i.issue)
  const missing = statsPending(finished, stats)
  if (missing.length === 0 || Date.now() - lastStatsReadMs < STATS_EVERY_MS) return batch
  lastStatsReadMs = Date.now()
  const { stdout } = await runInRepo($, ['tail', '-n', '200', HISTORY]).catch(() => ({ stdout: '' }))
  return { ...batch, stats: { ...stats, ...issueStatsFromHistory(stdout, missing, batch.startedMs) } }
}

async function pollBatch($: EngineInterface) {
  const batch = await read($, batchAtom)
  if (!batch) return
  if (batch.state !== 'running') {
    const filled = await withStats($, batch)
    if (filled !== batch) await update($, batchAtom, () => filled)
    return
  }
  let next = batch
  if (await $.fs.exists(await inRepo($, BATCH_STATUS))) next = batchFromStatus(await $.fs.read(await inRepo($, BATCH_STATUS)).catch(() => ''), batch, batchSinceMs)
  next = { ...next, stopRequested: next.stopRequested || (await $.fs.exists(await inRepo($, BATCH_STOP))) }
  for (const i of newlyMerged(batch.issues, next.issues)) $.ui.toast(`#${i.issue} mergeado${i.pr ? ` · PR #${i.pr}` : ''}`)
  next = await withStats($, next)
  const settled = next
  await update($, batchAtom, () => settled)
  const run = await read($, runAtom)
  if (settled.current && settled.current !== run?.issue) await watch($, settled.current, settled.startedMs, true)
  const c = batchCounts(settled.issues)
  if (settled.state === 'running') {
    $.ui.status(`mefisto · sequential ${c.done + c.failed}/${c.total}${settled.current ? ` · #${settled.current}` : ''}`)
    return
  }
  await stopTail()
  $.ui.toast(`sequential terminado: ${batchSummary(settled)}`)
  $.ui.status(settled.state === 'failed' ? `mefisto · sequential con fallos` : undefined)
}

// Parada suave: la misma senal que /mefisto-batch-stop. Termina el eslabon en curso (con su merge) y no sigue.
async function requestStop($: EngineInterface) {
  await $.fs.write(await inRepo($, BATCH_STOP), '')
  await update($, batchAtom, b => (b ? { ...b, stopRequested: true } : b))
  $.ui.toast('parada pedida: termina el issue en curso y no arranca los siguientes')
}

async function finish($: EngineInterface, run: PipelineRun) {
  await stopTail()
  if (run.state === 'completed') {
    const pr = prNumber(run.pr)
    $.ui.toast(pr ? `#${run.issue} terminó · PR #${pr} listo` : `#${run.issue} terminó`)
    $.ui.status(undefined)
  } else {
    $.ui.toast(`#${run.issue} falló en ${stageName(run.stage)}`)
    $.ui.status(`mefisto · #${run.issue} falló`)
  }
}

async function fromHistory($: EngineInterface, prev: PipelineRun): Promise<PipelineRun> {
  const { stdout } = await runInRepo($, ['tail', '-n', '50', HISTORY]).catch(() => ({ stdout: '' }))
  const done = finishedFromHistory(stdout, prev.issue, Math.min(prev.startedMs, watchSinceMs))
  if (!done) return prev
  const isFailed = done.state === 'failed'
  return {
    ...prev,
    title: done.title ?? prev.title,
    state: isFailed ? 'failed' : 'completed',
    stage: isFailed ? (done.stage ?? prev.stage) : 'done',
    pr: done.pr ?? null,
    lastError: done.error ?? null,
    finishedMs: Date.now(),
  }
}

// Mientras /mefisto-bitacora corre al historiador, la banda de espera lo muestra escribiendo y lleva la cinta de
// sus field notes: pendientes hasta que aparecen en algun procesadas/.
async function pollHistorian($: EngineInterface) {
  if (!isInteractive) return
  const agents = await $.agent.list().catch(() => [])
  const active = agents.some(a => a.type === HISTORIAN && isAgentActive(a.status))
  const prev = await read($, historianAtom)
  const next = historianFrom(prev, active, Date.now())
  if (next !== prev) {
    await update($, historianAtom, () => next)
    if (next && !next.finishedMs) {
      void captureNotes($)
      return
    }
    if (next?.finishedMs) {
      lastNotesPollMs = 0
      await pollNotes($)
      await findBitacoraPr($)
      void refreshReady($)
    }
    return
  }
  if (next && !next.finishedMs) await pollNotes($)
  if (next?.pr) await checkBitacoraPr($, next.pr.number)
}

async function captureNotes($: EngineInterface) {
  const local = await $.fs.list(await inRepo($, FIELD_NOTES_DIR)).catch(() => [])
  const notePrs = ((await read($, openPrsAtom)) ?? []).filter(p => p.isFieldNote).map(p => String(p.number))
  const files = await Promise.all(
    notePrs.map(n =>
      runInRepo($, ['gh', 'pr', 'view', n, '--json', 'files', '-q', '.files[].path']).catch(() => ({ exitCode: 1, stdout: '' })),
    ),
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
  const summaries = await $.fs.list(await inRepo($, SUMMARIES_DIR)).catch(() => [])
  const dirs = processedDirsOf(summaries.filter(n => n.kind === 'dir').map(n => n.name))
  const listed = await Promise.all(dirs.map(async d => $.fs.list(await inRepo($, d)).catch(() => [])))
  const processed = listed.flat().filter(n => n.kind === 'file').map(n => n.name)
  await update($, historianAtom, cur => (cur ? withProcessedNotes(cur, processed) : cur))
}

// Al terminar, el PR de bitacora que quedo abierto se ofrece para mergear, ver o cerrar. Si no hay (el skill ya lo
// mergeo), la cinta se limpia sola como antes.
async function findBitacoraPr($: EngineInterface) {
  const { exitCode, stdout } = await runInRepo($, ['gh', 'pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,headRefName,files'])
    .catch(() => ({ exitCode: 1, stdout: '' }))
  const pr = exitCode === 0 ? bitacoraPrOf(stdout) : null
  if (pr) {
    lastBitacoraPrCheckMs = Date.now()
    await update($, historianAtom, h => (h ? { ...h, pr } : h))
    return
  }
  $.clock.after(HISTORIAN_DONE_MS, () => void update($, historianAtom, h => (h?.finishedMs && !h.pr ? null : h)))
}

// El PR ofrecido sigue abierto: si se mergeo o cerro por fuera (el skill, GitHub), la cinta se va.
async function checkBitacoraPr($: EngineInterface, pr: number) {
  if (Date.now() - lastBitacoraPrCheckMs < PR_CHECK_MS) return
  lastBitacoraPrCheckMs = Date.now()
  const { exitCode, stdout } = await runInRepo($, ['gh', 'pr', 'view', String(pr), '--json', 'state', '-q', '.state'])
    .catch(() => ({ exitCode: 1, stdout: '' }))
  if (exitCode === 0 && stdout.trim() !== 'OPEN') await dismissHistorian($)
}

async function dismissHistorian($: EngineInterface) {
  await update($, historianAtom, () => null)
  void refreshReady($)
}

async function mergeBitacoraPr($: EngineInterface) {
  const pr = (await read($, historianAtom))?.pr
  if (!pr) return
  await dismissHistorian($)
  await startMerge($, String(pr.number))
  await $.command.run({ command: 'mefisto-merge', args: String(pr.number) })
}

async function openBitacoraPr($: EngineInterface) {
  const pr = (await read($, historianAtom))?.pr
  if (pr) await runInRepo($, ['gh', 'pr', 'view', String(pr.number), '--web']).catch(() => undefined)
}

async function closeBitacoraPr($: EngineInterface) {
  const pr = (await read($, historianAtom))?.pr
  if (!pr) return
  const answer = await $.ui
    .ask(`¿Cerrar el PR #${pr.number} de la bitácora sin mergear y borrar su rama?`, {
      header: 'Cerrar PR',
      options: ['Cerrar PR', 'Cancelar'],
    })
    .catch(() => null)
  if (answer !== 'Cerrar PR') return
  const { exitCode, stderr } = await runInRepo($, ['gh', 'pr', 'close', String(pr.number), '--delete-branch'])
    .catch(err => ({ exitCode: 1, stderr: String(err) }))
  if (exitCode !== 0) {
    $.ui.toast(`no se pudo cerrar el PR #${pr.number}: ${clip(stderr ?? '', 80)}`)
    return
  }
  $.ui.toast(`PR #${pr.number} cerrado`)
  await dismissHistorian($)
}

async function poll($: EngineInterface) {
  if (isPolling) return
  isPolling = true
  try {
    if (isExecutionOn && !(await read($, executionAtom))) await restoreExecution($)
    await update($, nowAtom, () => Date.now())
    await pollBatch($)
    await pollHistorian($)
    await pollMerge($)
    await pollRelease($)
    const inBatch = (await read($, batchAtom)) !== null
    const prev = await read($, runAtom)
    if (prev?.state === 'completed' && !inBatch) await closeIfMerged($, prev)
    if (!prev || prev.state !== 'running') return

    let next: PipelineRun = prev
    const status = statusPath(prev.issue)
    if (await $.fs.exists(await inRepo($, status))) {
      const raw = await $.fs.read(await inRepo($, status)).catch(() => '')
      const parsed = runFromStatus(raw, prev)
      if (parsed && !(parsed.state !== 'running' && parsed.startedMs + 1000 < watchSinceMs)) next = parsed
    } else if (watchSinceMs === 0 || Date.now() - watchSinceMs > STATUS_GRACE_MS || prev.stage !== 'setup') {
      next = await fromHistory($, prev)
      if (!inBatch && next === prev && prev.stage === 'setup' && Date.now() - prev.startedMs > ORPHAN_MS) {
        $.ui.log(`mefisto-divine-wager: #${prev.issue} sin status ni historial tras ${ORPHAN_MS / 60_000} min; se deja de seguir`, { to: 'debug' })
        await closeRun($)
        return
      }
    }

    if (next.state === 'running' && Date.now() - lastHoldReadMs >= HOLD_EVERY_MS) {
      lastHoldReadMs = Date.now()
      const { stdout } = await runInRepo($, ['tail', '-n', '3', EVENTS_LOG]).catch(() => ({ stdout: '' }))
      const hold = holdOf(stdout)
      await update($, holdAtom, () => hold)
    } else if (next.state !== 'running') {
      await update($, holdAtom, () => null)
    }

    if (next.state === 'running') {
      const entries = await $.fs.list(await inRepo($, LOG_DIR)).catch(() => [])
      const name = pickEventsFile(entries, next.issue, Math.min(next.startedMs, watchSinceMs))
      if (name && name !== next.eventsFile) {
        next = { ...next, eventsFile: name }
        await startTail($, name)
      }
      if (!inBatch) $.ui.status(`mefisto · #${next.issue} ${stageName(next.stage)} ${elapsed(Date.now() - next.startedMs)}`)
    }

    const settled = next
    await update($, runAtom, () => settled)
    if (settled.state !== 'running') {
      if (inBatch) await stopTail()
      else await finish($, settled)
    }
  } finally {
    isPolling = false
  }
}

// El PR mergeado da la corrida por terminada: venga del boton, de /mefisto-merge tecleado o de GitHub.
async function closeIfMerged($: EngineInterface, run: PipelineRun) {
  const pr = prNumber(run.pr)
  if (!pr || Date.now() - lastPrCheckMs < PR_CHECK_MS) return
  lastPrCheckMs = Date.now()
  const { exitCode, stdout } = await runInRepo($, ['gh', 'pr', 'view', pr, '--json', 'state', '-q', '.state'])
    .catch(() => ({ exitCode: 1, stdout: '' }))
  if (exitCode !== 0 || stdout.trim() !== 'MERGED') return
  await closeRun($)
  $.ui.toast(`PR #${pr} mergeado · corrida de #${run.issue} cerrada`)
}

async function openPane($: EngineInterface, isFocused = false) {
  isLogOpen = true
  return $.ui.open({ id: PANE, title: 'mefisto', rows: PANE_ROWS, ...(isFocused ? { focus: true as const } : {}) })
}

async function closeLog($: EngineInterface) {
  isLogOpen = false
  await $.ui.close({ id: PANE })
}

// La tecla 3 de la banda abre el log o, si ya estaba abierto, lo cierra.
async function toggleLog($: EngineInterface) {
  if (isLogOpen) await closeLog($)
  else await openPane($, true)
}

async function closeRun($: EngineInterface) {
  await stopTail()
  await update($, batchAtom, () => null)
  await update($, runAtom, () => null)
  await update($, linesAtom, () => [])
  $.ui.status(undefined)
  await $.ui.close({ id: PANE })
  void refreshReady($)
}

async function openPr($: EngineInterface) {
  const run = await read($, runAtom)
  const batch = await read($, batchAtom)
  const pr = batch ? batchPr(batch) : prNumber(run?.pr ?? null)
  if (pr) await runInRepo($, ['gh', 'pr', 'view', pr, '--web']).catch(() => undefined)
}

async function merge($: EngineInterface) {
  const run = await read($, runAtom)
  const pr = prNumber(run?.pr ?? null)
  if (!pr) return
  const answer = await $.ui
    .ask(`¿Mergear el PR #${pr} con /mefisto-merge?`, ['Mergear', 'Cancelar'])
    .catch(() => 'Cancelar')
  if (answer !== 'Mergear') return
  $.ui.toast(`/mefisto-merge ${pr} en cola: la corrida se cierra cuando el PR quede mergeado`)
  lastPrCheckMs = 0
  await startMerge($, pr)
  await $.command.run({ command: 'mefisto-merge', args: pr })
}

// La sesion de ejecucion es cualquier sesion interactiva que no sea la del planner: el planner no lanza
// trabajo (su tablero deja los listos en solo lectura). Se lee el --agent de la linea de comando del
// proceso de Claude Code, padre del `sh` que corre aqui; si no se puede leer, la sesion cuenta como de ejecucion.
async function detectExecution($: EngineInterface) {
  const ps = await runInRepo($, ['sh', '-c', 'ps -o args= -p "$PPID"']).catch(() => ({ exitCode: 1, stdout: '' }))
  const cmdline = ps.exitCode === 0 ? ps.stdout.trim() : ''
  if (agentFlagOf(cmdline) === PLANNER_AGENT) return
  isExecutionOn = true
  await update($, executionAtom, () => true)
  readyTimer?.cancel()
  readyTimer = $.clock.every(READY_POLL_MS, () => void refreshReady($))
  void refreshReady($)
}

// El engine no entrega eventos classic.* a un plugin de tier user y session.start no se repite tras /clear: el
// poll de cada segundo nota los atoms en blanco y rearma la banda con listos, PRs, field notes y fragmentos.
async function restoreExecution($: EngineInterface) {
  await update($, executionAtom, () => true)
  void refreshReady($)
}

async function refreshReady($: EngineInterface) {
  if (isRefreshingReady || !(await read($, executionAtom))) return
  isRefreshingReady = true
  try {
    const [order, listos, prs] = await Promise.all([
      runInRepo($, [NEXT_ORDER, '--json'], { timeoutMs: SCRIPT_TIMEOUT_MS })
        .catch(err => ({ exitCode: 2, stdout: '', stderr: String(err) })),
      runInRepo($, ['gh', 'issue', 'list', '--state', 'open', '--label', 'estado:listo', '--limit', '200', '--json', 'number,title'])
        .catch(() => ({ exitCode: 1, stdout: '' })),
      runInRepo($, ['gh', 'pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,isDraft,headRefName'])
        .catch(() => ({ exitCode: 1, stdout: '' })),
    ])
    const openPrs = prs.exitCode === 0 ? parseOpenPrs(prs.stdout) : null
    await update($, openPrsAtom, () => openPrs)
    const notes = await $.fs.list(await inRepo($, FIELD_NOTES_DIR)).catch(() => null)
    await update($, fieldNotesAtom, () => (notes ? fieldNotesIn(notes.filter(n => n.kind === 'file').map(n => n.name)) : null))
    const fragments = await $.fs.list(await inRepo($, CHANGELOG_DIR)).catch(() => null)
    await update($, changelogAtom, () => (fragments ? changelogOf(fragments.filter(n => n.kind === 'file').map(n => n.name)) : null))
    const ready: ReadyList = parseNextOrder(order.exitCode, order.stdout, order.stderr, titlesOf(listos.stdout))
    await update($, readyAtom, () => ready)
  } finally {
    isRefreshingReady = false
  }
}

// La banda escribe el comando sin Enter: se lanza a mano, con la opcion de ajustarlo antes.
async function fill($: EngineInterface, text: string) {
  await $.prompt.fill({ text, mode: 'replace' })
}

// Las confirmaciones van en el dialogo nativo, abajo junto al prompt; la banda queda para informar. Esc cancela.
const WITH_MERGE = 'Con merge (sequential)'
const ONLY_PR = 'Solo PR (tooling)'

async function choose($: EngineInterface, issue: number) {
  const answer = await $.ui
    .ask(`¿Cómo desarrollar #${issue}?`, { header: 'Lanzar', options: [WITH_MERGE, ONLY_PR] })
    .catch(() => null)
  if (answer === WITH_MERGE) await fill($, sequentialOf(issue))
  else if (answer === ONLY_PR) await fill($, toolingOf(issue))
}

// Mergear desde la espera: todos o los PRs elegidos; en la opcion de texto se escriben otros numeros. Elegir en el
// dialogo ya es la aprobacion, asi que /mefisto-merge se ejecuta de una vez.
async function chooseMerge($: EngineInterface) {
  const prs = (await read($, openPrsAtom)) ?? []
  if (prs.length === 0) return
  const options = mergeOptions(prs)
  const answer = await $.ui
    .ask(`¿Qué mergear? ${prs.length} PRs abiertos${prs.length > 3 ? ' (otros números: escríbelos en la opción de texto)' : ''}`, {
      header: 'Merge',
      options,
      ...(prs.length > 1 ? { multiSelect: true as const } : {}),
    })
    .catch(() => null)
  const args = answer === null ? null : mergeArgsOf(answer, options)
  if (!args) return
  $.ui.toast(`/mefisto-merge ${args} en cola`)
  await startMerge($, args)
  await $.command.run({ command: 'mefisto-merge', args })
}

// La cinta de /mefisto-merge: la lista sale de los argumentos; con --all, de los PRs abiertos al momento.
async function startMerge($: EngineInterface, args: string) {
  const current = await read($, mergeAtom)
  if (current && !current.finishedMs) return
  let open = (await read($, openPrsAtom)) ?? []
  if (/(^|\s)--all(\s|$)/.test(args)) {
    const prs = await runInRepo($, ['gh', 'pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,isDraft,headRefName'])
      .catch(() => ({ exitCode: 1, stdout: '' }))
    open = (prs.exitCode === 0 ? parseOpenPrs(prs.stdout) : null) ?? open
  }
  const prs = mergePrsOf(args, open)
  if (prs.length === 0) return
  isMergeSeen = false
  lastMergePollMs = Date.now()
  await update($, mergeAtom, () => ({ prs, startedMs: Date.now(), finishedMs: null }))
}

async function settleMerge($: EngineInterface, merged: readonly string[], failed: readonly string[]) {
  const prev = await read($, mergeAtom)
  if (!prev || prev.finishedMs) return
  const next = withMergeOutcomes(prev, merged, failed, Date.now())
  if (next === prev) return
  await update($, mergeAtom, () => next)
  if (next.finishedMs) await endMerge($)
}

async function endMerge($: EngineInterface) {
  const run = await read($, mergeAtom)
  if (!run) return
  const done = finishMerge(run, Date.now())
  if (done !== run) await update($, mergeAtom, () => done)
  $.ui.toast(`merge: ${mergeHeader(done, '')}`)
  $.clock.after(HISTORIAN_DONE_MS, () => void update($, mergeAtom, m => (m?.finishedMs ? null : m)))
  void refreshReady($)
}

// Respaldo: el estado de cada pendiente en GitHub, cada MERGE_POLL_MS.
async function pollMerge($: EngineInterface) {
  const run = await read($, mergeAtom)
  if (!run || run.finishedMs || Date.now() - lastMergePollMs < MERGE_POLL_MS) return
  lastMergePollMs = Date.now()
  const pending = run.prs.filter(p => p.estado === 'pendiente').map(p => p.num)
  const states = await Promise.all(
    pending.map(n =>
      runInRepo($, ['gh', 'pr', 'view', n, '--json', 'state', '-q', '.state']).catch(() => ({ exitCode: 1, stdout: '' })),
    ),
  )
  const merged = pending.filter((_, i) => states[i]?.exitCode === 0 && states[i]?.stdout.trim() === 'MERGED')
  if (merged.length > 0) await settleMerge($, merged, [])
}

// Integrar la bitacora: las field notes de main y las que esperan en sus PRs. Elegir en el dialogo es la aprobacion.
async function chooseBitacora($: EngineInterface) {
  const local = (await read($, fieldNotesAtom)) ?? 0
  const prs = ((await read($, openPrsAtom)) ?? []).filter(p => p.isFieldNote).map(p => p.number)
  if (local + prs.length === 0) return
  const integrate = prs.length > 0 ? `Mergear sus ${prs.length} PRs e integrar` : 'Integrar'
  const answer = await $.ui
    .ask(`¿Integrar la bitácora? ${local} field notes en main${prs.length > 0 ? ` y ${prs.length} en PRs sin mergear` : ''}`, {
      header: 'Bitácora',
      options: [integrate, 'Cancelar'],
    })
    .catch(() => null)
  if (answer !== integrate) return
  await $.prompt.submit({ text: bitacoraPrompt(prs), asUser: true })
}

// Publicar un release con los fragmentos de changelog.d/: SemVer sugiere el bump; tambien se puede solo preparar.
async function chooseRelease($: EngineInterface) {
  const summary = await read($, changelogAtom)
  if (!summary || summary.issues === 0) return
  const counts = [
    summary.added > 0 ? `${summary.added} added` : '',
    summary.changed > 0 ? `${summary.changed} changed` : '',
    summary.fixed > 0 ? `${summary.fixed} fixed` : '',
    summary.removed > 0 ? `${summary.removed} removed` : '',
  ].filter(Boolean).join(', ')
  const answer = await $.ui
    .ask(`¿Publicar un release? ${summary.issues} issues con cambios (${counts})`, { header: 'Release', options: releaseOptions(summary) })
    .catch(() => null)
  const args = answer === null ? null : releaseArgsOf(answer)
  if (!args) return
  $.ui.toast(`/mefisto-release ${args} en cola`)
  await startRelease($, `/mefisto-release ${args}`)
  await $.command.run({ command: 'mefisto-release', args })
}

// La cinta del release: la foto de changelog.d/ al arrancar, agrupada por issue, y las fases que recorre el script.
async function startRelease($: EngineInterface, invocationText: string) {
  const current = await read($, releaseAtom)
  if (current && !current.finishedMs && Array.isArray(current.steps)) return
  let version: string | null = null
  try {
    const parsed = JSON.parse(await $.fs.read(await inRepo($, PLUGIN_JSON)).catch(() => ''))
    version = typeof parsed?.version === 'string' ? parsed.version : null
  } catch {
    version = null
  }
  const plan = releasePlan(version, releaseInvocationOf(invocationText))
  const listed = await $.fs.list(await inRepo($, CHANGELOG_DIR)).catch(() => [])
  const fragments = listed.filter(n => n.kind === 'file' && n.name !== 'README.md' && n.name.endsWith('.md')).map(n => n.name)
  const issues = releaseIssuesOf(fragments)
  const release: Release = {
    phase: 'reposo',
    startedMs: Date.now(),
    finishedMs: null,
    version: plan.version,
    steps: plan.steps,
    done: [],
    failed: null,
    issues,
    fragments,
    pr: null,
    url: null,
  }
  isReleaseScriptSeen = false
  lastReleasePollMs = 0
  await update($, releaseAtom, () => release)
  void fillReleaseTitles($, issues.map(i => i.issue))
}

// El titulo de cada issue de la foto, en paralelo; los que gh no devuelve se quedan con el numero solo.
async function fillReleaseTitles($: EngineInterface, issues: string[]) {
  const titles = await Promise.all(
    issues.map(n =>
      runInRepo($, ['gh', 'issue', 'view', n, '--json', 'title', '-q', '.title']).catch(() => ({ exitCode: 1, stdout: '' })),
    ),
  )
  const byIssue = new Map(issues.map((n, i) => [n, titles[i]?.exitCode === 0 ? titles[i].stdout.trim() : '']))
  await update($, releaseAtom, r =>
    r && Array.isArray(r.issues) ? { ...r, issues: r.issues.map(i => (byIssue.get(i.issue) ? { ...i, title: byIssue.get(i.issue) ?? '' } : i)) } : r,
  )
}

// Las fases por sondeo de GitHub, no por la salida del Bash (que llega entera al terminar el script).
async function pollRelease($: EngineInterface, isForced = false) {
  const release = await read($, releaseAtom)
  if (!release || release.finishedMs || !release.version || !Array.isArray(release.steps)) return
  if (!isForced && Date.now() - lastReleasePollMs < RELEASE_POLL_MS) return
  lastReleasePollMs = Date.now()
  const branch = releaseBranchOf(release.version)
  const tag = releaseTagOf(release.version)
  const pending = (step: ReleaseStep) => release.steps.includes(step) && !release.done.includes(step)
  const none = Promise.resolve(null)
  const probe = (argv: string[]) => runInRepo($, argv).catch(() => null)
  const [heads, contents, prs, tags, published] = await Promise.all([
    pending('rama') ? probe(['git', 'ls-remote', '--heads', 'origin', branch]) : none,
    pending('consolidar') ? probe(['gh', 'api', `repos/{owner}/{repo}/contents/changelog.d?ref=${branch}`, '--jq', '.[].name']) : none,
    pending('pr') || pending('merge') ? probe(['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state']) : none,
    pending('tag') ? probe(['git', 'ls-remote', '--tags', 'origin', `refs/tags/${tag}`]) : none,
    pending('release') ? probe(['gh', 'release', 'view', tag, '--json', 'url,isDraft']) : none,
  ])
  const observed: ReleaseStep[] = []
  let pr = release.pr
  let url = release.url
  if (heads?.exitCode === 0 && heads.stdout.trim() !== '') observed.push('rama')
  if (contents?.exitCode === 0 && isConsolidated(release.fragments, contents.stdout.split('\n').map(l => l.trim()).filter(Boolean))) {
    observed.push('consolidar')
  }
  if (prs?.exitCode === 0) {
    try {
      const first = (JSON.parse(prs.stdout) as { number: number; state: string }[])[0]
      if (first) {
        pr = String(first.number)
        observed.push(first.state === 'MERGED' ? 'merge' : 'pr')
      }
    } catch {
      // salida inesperada: se reintenta en el siguiente sondeo
    }
  }
  if (tags?.exitCode === 0 && tags.stdout.trim() !== '') observed.push('tag')
  if (published?.exitCode === 0) {
    try {
      const info = JSON.parse(published.stdout) as { url?: string; isDraft?: boolean }
      if (!info.isDraft) {
        url = info.url ?? null
        observed.push('release')
      }
    } catch {
      // idem
    }
  }
  await update($, releaseAtom, r => {
    if (!r || r.finishedMs || !Array.isArray(r.steps)) return r
    const next = withObservedSteps(r, observed)
    return next === r && pr === r.pr && url === r.url ? r : { ...next, pr, url }
  })
}

// Las cintas terminadas vencen al dibujar, sin depender de que su clock.after sobreviva un hot-reload; el siguiente
// hook que puede escribir estado limpia el atom vencido. La bitacora con un PR abierto espera al usuario.
async function liveTapes($: EngineInterface, nowMs: number) {
  const historian = await read($, historianAtom)
  return {
    historian: liveTape(historian, HISTORIAN_DONE_MS, nowMs, Boolean(historian?.pr)),
    release: liveTape(await read($, releaseAtom), RELEASE_DONE_MS, nowMs),
    merge: liveTape(await read($, mergeAtom), HISTORIAN_DONE_MS, nowMs),
  }
}

async function sweepTapes($: EngineInterface) {
  const now = Date.now()
  const live = await liveTapes($, now)
  if (!live.historian && (await read($, historianAtom))) await update($, historianAtom, h => liveTape(h, HISTORIAN_DONE_MS, now, Boolean(h?.pr)))
  if (!live.release && (await read($, releaseAtom))) await update($, releaseAtom, r => liveTape(r, RELEASE_DONE_MS, now))
  if (!live.merge && (await read($, mergeAtom))) await update($, mergeAtom, m => liveTape(m, HISTORIAN_DONE_MS, now))
}

async function openRelease($: EngineInterface) {
  const release = await read($, releaseAtom)
  if (!release?.version) return
  if (release.url) await runInRepo($, ['gh', 'release', 'view', releaseTagOf(release.version), '--web']).catch(() => undefined)
  else if (release.pr) await runInRepo($, ['gh', 'pr', 'view', release.pr, '--web']).catch(() => undefined)
}

async function confirmStop($: EngineInterface) {
  const current = (await read($, batchAtom))?.current
  const answer = await $.ui
    .ask(`¿Detener el sequential tras ${current ? `#${current}` : 'el issue en curso'}?`, {
      header: 'Detener',
      options: ['Detener tras el actual', 'Seguir'],
    })
    .catch(() => null)
  if (answer === 'Detener tras el actual') await requestStop($)
}

async function nextReadyPage($: EngineInterface) {
  const ready = await read($, readyAtom)
  const total = ready ? readyRows(ready).length : 0
  await update($, readyPageAtom, p => pageOf((p ?? 0) + 1, total, READY_ROWS).page)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    await $.command.register({
      name: 'mefisto-divine-wager',
      description: 'Consola de Mefisto: sin argumentos abre el log; <issue> sigue esa corrida; batch <issues> sigue un sequential; merge | close | refresh',
      argumentHint: '[issue|batch <issues>|merge|close|refresh]',
      immediate: true,
    })
    // Tras un hot-reload el tail del modulo anterior murio: se fuerza a reabrirlo.
    await update($, runAtom, run => (run && run.state === 'running' ? { ...run, eventsFile: null } : run))
    await sweepTapes($)
    $.clock.every(1000, () => void poll($))
    if (isInteractive) void detectExecution($)
    return next(e)
  })

  // El cohete del release: en reposo desde que se pide /mefisto-release, despegando mientras corre su script y
  // listo cuando termina el turno que lo ejecuto.
  on('prompt.submit', async ($, e, next) => {
    await sweepTapes($)
    if (isInteractive && isReleasePrompt(e.text)) await startRelease($, e.text)
    const mergeArgs = isInteractive ? mergePromptArgs(e.text) : null
    if (mergeArgs) await startMerge($, mergeArgs)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Solo cierra el turno que corrio el script: un /mefisto-release encolado arranca en un turno posterior.
    const release = await read($, releaseAtom)
    if (release && !release.finishedMs && (isReleaseScriptSeen || Date.now() - release.startedMs > MERGE_STALE_MS)) {
      await pollRelease($, true)
      await update($, releaseAtom, r => (r ? (Array.isArray(r.steps) ? finishRelease(r, Date.now()) : { ...r, phase: 'reposo', finishedMs: Date.now() }) : r))
      const done = await read($, releaseAtom)
      if (done?.version) $.ui.toast(releaseHeader(done, ''))
      $.clock.after(RELEASE_DONE_MS, () => void update($, releaseAtom, r => (r?.finishedMs ? null : r)))
      void refreshReady($)
    }
    // El turno de /mefisto-merge termino: lo que siga pendiente lo descarto el skill o no se llego a mergear.
    const merge = await read($, mergeAtom)
    if (merge && !merge.finishedMs && (isMergeSeen || Date.now() - merge.startedMs > MERGE_STALE_MS)) {
      lastMergePollMs = 0
      await pollMerge($)
      await endMerge($)
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await sweepTapes($)
    if (isInteractive && isReleaseRun(e.command)) {
      await startRelease($, e.command)
      isReleaseScriptSeen = true
      await update($, releaseAtom, r => (r ? { ...r, phase: 'despegando' } : r))
      try {
        return await next(e)
      } finally {
        await update($, releaseAtom, r => (r ? { ...r, phase: 'reposo' } : r))
      }
    }
    if (isInteractive && isGhMergeRun(e.command)) {
      const literal = ghMergeNumbersOf(e.command)
      if (literal.length > 0) await startMerge($, literal.join(' '))
      isMergeSeen = true
      const ran = await next(e)
      if (ran.deny === undefined) {
        const { merged, failed } = mergeOutcomesOf(e.command, ran.text ?? '', ran.isError === true)
        await settleMerge($, merged, failed)
      }
      return ran
    }
    // El instante se toma antes de correr: sin pane, la llamada vuelve cuando el batch ya avanzo (o por
    // timeout), y un estado publicado antes de esa vuelta se descartaria como de un batch anterior.
    const launchedMs = Date.now() - 5_000
    const batchIssues = isInteractive ? batchIssuesOf(e.command) : null
    if (batchIssues && batchIssues.length > 0) {
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) await watchBatch($, batchIssues, launchedMs)
      return ran
    }
    const issue = isInteractive ? toolingIssueOf(e.command) : null
    if (!issue) return next(e)
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await watch($, issue, launchedMs)
    }
    return ran
  })

  on('command.run', { command: 'mefisto-divine-wager' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      await closeRun($)
      return { text: 'Corrida cerrada.' }
    }
    if (arg === 'refresh') {
      await refreshReady($)
      return { text: 'Listos actualizados.' }
    }
    if (arg === 'merge') {
      await merge($)
      return { text: 'Merge solicitado.' }
    }
    // Reengancha un sequential ya lanzado (tras reiniciar la sesion): `/mefisto-divine-wager batch 12 13`.
    const batchArgs = /^batch((?:\s+#?\d+)+)$/.exec(arg)
    if (batchArgs?.[1]) {
      const issues = batchArgs[1].match(/\d+/g) ?? []
      await watchBatch($, issues, 0)
      return { text: `Siguiendo el sequential ${issues.map(n => `#${n}`).join(' ')} en la banda.` }
    }
    // La banda sigue la corrida; el pane es solo el log completo y se abre a pedido.
    if (/^#?\d+$/.test(arg)) {
      await watch($, arg.replace('#', ''), 0)
      return { text: `Siguiendo #${arg.replace('#', '')} en la banda.` }
    }
    await openPane($, true)
    return { text: 'Log abierto.' }
  })

  // Cerrar el log solo cierra el pane: la banda conserva la corrida (y su PR) hasta que se cierre con 4.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    isLogOpen = false
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const run = await read($, runAtom)
    const batch = await read($, batchAtom)
    if (e.props.hasSurvey) return next(e)
    if (!run && !batch && !(await read($, executionAtom))) return next(e)
    const now = await read($, nowAtom)
    const { Box, Text, Button } = $.ui.resolve(e)
    if (batch) {
      // El sequential: avance y cola arriba, el eslabon en curso abajo con su mascota, pasos y ultimas lineas.
      const lines = await read($, linesAtom)
      const inner = Math.max(40, (e.props.bodyColumns ?? 80) - 4)
      const body = Math.max(30, inner - MASCOT_WIDTH - 2)
      const c = batchCounts(batch.issues)
      const end = batch.finishedMs ?? (now || Date.now())
      const isRunning = batch.state === 'running'
      const pr = batchPr(batch)
      const pose =
        isRunning && run ? mascotPose(run, lines[lines.length - 1])
        : batch.state === 'failed' ? { role: 'desarrollador' as const, state: 'error' }
        : isRunning ? { role: 'desarrollador' as const, state: 'pensando' }
        : { role: 'revisor' as const, state: 'aprobado' }
      const frame = isRunning ? (Math.floor((now || Date.now()) / 1000) % 2 === 0 ? 0 : 1) : 0
      const grid = cropGrid(sprite(pose.role, pose.state, frame), MASCOT_COLS)
      const elements = $.ui.resolve(e)
      const mascot =
        'Raster' in elements ? (
          <elements.Raster key="mefisto-mascota" columns={MASCOT_WIDTH} rows={RASTER_ROWS} cells={mascotCells(grid)} />
        ) : (
          <Box width={MASCOT_WIDTH} />
        )
      const hold = await read($, holdAtom)
      const recent = lines.filter(l => l.ts !== '').slice(-3)
      const markText = (m: ReturnType<typeof issueMark>) =>
        m === 'done' ? '✓' : m === 'failed' ? '✗' : m === 'deferred' ? '⏸' : m === 'current' ? '●' : '○'
      const markColor = (m: ReturnType<typeof issueMark>) =>
        m === 'done' ? ('success' as const) : m === 'failed' ? ('error' as const) : m === 'current' ? ('warning' as const) : undefined
      const failedIssue = batch.issues.find(i => issueMark(i.status) === 'failed')
      const doneRows = batch.issues.filter(i => ['done', 'failed'].includes(issueMark(i.status)))
      const stats = batch.stats ?? {}
      const titleW = summaryTitleWidth(inner)
      const doneStats = doneRows.map(i => stats[i.issue]).filter(st => st !== undefined)
      // Sin exigir `!run.finishedMs`: el historial se escribe antes del merge del batch, y la fila no debe desaparecer
      // mientras el issue espera su merge; ahi su tiempo queda congelado en el fin de la corrida.
      const currentRun =
        isRunning && run && run.issue === batch.current && !doneRows.some(i => i.issue === run.issue) ? run : null
      const currentMs = currentRun ? Math.max(0, (currentRun.finishedMs ?? (now || Date.now())) - currentRun.startedMs) : null
      const currentParts = currentRun ? currentRowParts(currentRun.issue, currentRun.title, prNumber(currentRun.pr), currentMs ?? 0, titleW) : null
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="claude" borderDimColor paddingX={1}>
          <Box justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color="claude">mefisto</Text>
              <Text> · sequential {c.done + c.failed}/{c.total}</Text>
              {isRunning && batch.stopRequested && <Text color="warning"> · se detiene tras #{batch.current ?? '…'}</Text>}
              {batch.state === 'completed' && <Text color="success"> · terminado</Text>}
              {batch.state === 'stopped' && <Text color="warning"> · detenido</Text>}
              {batch.state === 'failed' && <Text color="error"> · con fallos</Text>}
              <Text dimColor> {elapsed(end - batch.startedMs)}</Text>
            </Text>
            <Box gap={2}>
              {isRunning && !batch.stopRequested && (
                <Button key="batch-stop" hotkey="1" plain label="detener" onPress={() => void confirmStop($)} />
              )}
              {pr && <Button key="batch-pr" hotkey="2" plain label={`ver PR #${pr}`} onPress={() => void openPr($)} />}
              <Button key="batch-log" hotkey="3" plain dimColor={isRunning} label="log" onPress={() => void toggleLog($)} />
              {!isRunning && <Button key="batch-close" hotkey="4" plain label="cerrar" onPress={() => void closeRun($)} />}
            </Box>
          </Box>
          <Box gap={2} height={RASTER_ROWS + 1} alignItems="flex-start">
            {mascot}
            <Box flexDirection="column" width={body} marginTop={1}>
              <Text wrap="truncate-end">
                {batch.issues.map((i, k) => {
                  const m = issueMark(i.status)
                  return (
                    <Text color={markColor(m)} dimColor={m === 'pending' || m === 'deferred'}>
                      {k > 0 ? ' ─ ' : ''}
                      {markText(m)} #{i.issue}
                      {m === 'current' && run && run.issue === i.issue ? ` ${stageName(run.stage)}` : ''}
                    </Text>
                  )
                })}
              </Text>
              {isRunning && run && run.title !== '' && <Text dimColor wrap="truncate-end">#{run.issue} {run.title}</Text>}
              {isRunning && hold && <Text color="warning" wrap="truncate-end">{holdText(hold)}</Text>}
              {isRunning && run && !hold && <Text> </Text>}
              {isRunning && !run && <Text dimColor>preparando el primer issue…</Text>}
              {isRunning &&
                recent.map(line => (
                  <Text wrap="truncate-end" color={lineColor(line)} dimColor={line.kind === 'text'}>
                    {`${line.ts} ${line.kind === 'text' ? '» ' : ''}${line.text}`}
                  </Text>
                ))}
              {!isRunning && <Text wrap="truncate-end">{batchSummary(batch)}</Text>}
              {!isRunning && failedIssue && (
                <Text color="error" wrap="truncate-end">#{failedIssue.issue} {failedIssue.status.replace(/^ERROR:\s*/, '')}</Text>
              )}
            </Box>
          </Box>
          {(doneRows.length > 0 || currentParts) && (
            <Box flexDirection="column">
              {doneRows.map(i => {
                const st = stats[i.issue]
                const m = issueMark(i.status)
                return (
                  <Text wrap="truncate-end" color={markColor(m)}>
                    {`${markText(m)} ${padEnd(`#${i.issue}`, 7)} ${titleW > 0 ? `${fitTitle(st?.title, titleW)} ` : ''}${padEnd(i.pr ? `PR #${i.pr}` : 'sin PR', 10)} `}
                    <Text dimColor>{st ? `${padEnd(elapsed(st.durationMs), 8)} ${fmtCost(st.costUsd)}` : '…'}</Text>
                  </Text>
                )
              })}
              {currentParts && (
                <Text wrap="truncate-end" color="warning">
                  {currentParts.head}
                  <Text dimColor>{currentParts.tail}</Text>
                </Text>
              )}
              {doneRows.length + (currentParts ? 1 : 0) > 1 && (
                <Text dimColor wrap="truncate-end">
                  {totalRowText(doneStats, currentMs, titleW)}
                </Text>
              )}
            </Box>
          )}
        </Box>
      )
    }
    if (!run) {
      const ready = await read($, readyAtom)
      const openPrs = (await read($, openPrsAtom)) ?? []
      const workPrs = openPrs.length
      const pendingNotes = ((await read($, fieldNotesAtom)) ?? 0) + openPrs.filter(p => p.isFieldNote).length
      const changelog = await read($, changelogAtom)
      const inner = Math.max(40, (e.props.bodyColumns ?? 80) - 4)
      const body = Math.max(30, inner - MASCOT_WIDTH - 2)
      const { page, pages } = pageOf(await read($, readyPageAtom), ready ? readyRows(ready).length : 0, READY_ROWS)
      const rows = ready ? readyRows(ready) : []
      const visible = rows.slice(page * READY_ROWS, (page + 1) * READY_ROWS)
      const numWidth = Math.max(4, ...visible.map(i => String(i.number).length + 1))
      const afterWidth = Math.min(24, Math.max(0, ...visible.map(i => i.reason.length)))
      // El prefijo '5: ' de la tecla, el numero, un espacio y, si alguno depende de otro, la columna 'tras #N'.
      const titleWidth = Math.max(12, body - 3 - numWidth - 1 - (afterWidth > 0 ? afterWidth + 2 : 0))
      const more = ready
        ? [
            ready.cycleCount > 0 ? `${ready.cycleCount} en ciclo` : '',
          ].filter(Boolean).join(' · ')
        : ''
      // En espera de que se lance algo; mientras Claude trabaja en la sesion, mira de lado a lado y corre la arena.
      // Si el historiador escribe la bitacora, es el quien aparece, con la pluma en movimiento.
      const tapes = await liveTapes($, now || Date.now())
      const historian = tapes.historian
      const tick = e.props.isWorking ? Math.floor((now || Date.now()) / 1000) : null
      const release = tapes.release
      // La cinta de merge cose al ritmo del reloj aunque el turno este en un Bash largo.
      const mergeRun = tapes.merge
      const mergeTick = mergeRun && !mergeRun.finishedMs ? Math.floor((now || Date.now()) / 1000) : tick
      const frame = (mergeTick ?? 0) % 2 === 0 ? 0 : 1
      const grid = mergeRun
        ? cropGrid(sprite('merge', mergeRun.finishedMs ? 'listo' : 'cosiendo', frame), MASCOT_COLS)
        : release
        ? cropGrid(sprite('release', release.finishedMs ? 'listo' : release.phase, frame), MASCOT_COLS)
        : historian
          ? cropGrid(sprite('historiador', historian.finishedMs ? 'listo' : 'escribiendo', frame), MASCOT_COLS)
          : cropGrid(waitingFace(face('normal'), tick), MASCOT_COLS)
      const elements = $.ui.resolve(e)
      const mascot =
        'Raster' in elements ? (
          <elements.Raster key="mefisto-mascota" columns={MASCOT_WIDTH} rows={RASTER_ROWS} cells={mascotCells(grid)} />
        ) : (
          <Box width={MASCOT_WIDTH} />
        )
      // Los pendientes de la cinta y despues los fallidos, en las mismas filas que la lista de listos.
      const mergeAll = mergeRun
        ? [...mergeRun.prs.filter(p => p.estado === 'pendiente'), ...mergeRun.prs.filter(p => p.estado === 'fallido')]
        : []
      const mergeRows = mergeAll.length > READY_ROWS ? READY_ROWS - 1 : READY_ROWS
      const mergeLines = mergeAll.slice(0, mergeRows)
      const mergeHidden = mergeAll.length - mergeLines.length
      // La cinta de la bitacora: pendientes primero y despues las procesadas, en las mismas filas.
      const notes = historian ? [...historian.notes.filter(n => n.estado === 'pendiente'), ...historian.notes.filter(n => n.estado === 'procesada')] : []
      const noteSlots = READY_ROWS - (historian?.pr ? 1 : 0)
      const noteRows = notes.length > noteSlots ? noteSlots - 1 : noteSlots
      const noteLines = notes.slice(0, noteRows)
      const notesHidden = notes.length - noteLines.length
      const notesDone = historian ? historian.notes.filter(n => n.estado === 'procesada').length : 0
      const bitacoraPr = !mergeRun ? (historian?.pr ?? null) : null
      // La cinta del release: la foto de changelog.d/ (✓ al consolidarse) y las fases en una linea debajo.
      const releaseRun = release && Array.isArray(release.steps) ? release : null
      const releaseIssues = releaseRun?.issues ?? []
      const releaseSlots = READY_ROWS - 1
      const releaseRows = releaseIssues.length > releaseSlots ? releaseSlots - 1 : releaseSlots
      const releaseLines = releaseIssues.slice(0, releaseRows)
      const releaseHidden = releaseIssues.length - releaseLines.length
      const isConsolidatedRun = releaseRun?.done.includes('consolidar') ?? false
      const releaseLink = releaseRun?.finishedMs && !mergeRun ? (releaseRun.url ? 'ver release' : releaseRun.pr ? 'ver PR' : null) : null
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="claude" borderDimColor paddingX={1}>
          <Box justifyContent="space-between">
            <Text>
              <Text color="claude">mefisto</Text>
              <Text dimColor> · listos {ready ? readyRows(ready).length : '…'}</Text>
              {historian && !historian.finishedMs && (
                <Text color="warning">
                  {' · historiador escribiendo la bitácora '}
                  {historian.notes.length > 0 ? `${notesDone}/${historian.notes.length} ` : ''}
                  {elapsed((now || Date.now()) - historian.startedMs)}
                </Text>
              )}
              {historian?.finishedMs && (
                <Text color="success"> · bitácora escrita{historian.pr ? ` · PR #${historian.pr.number}` : ''}</Text>
              )}
              {releaseRun && (
                <Text color={releaseRun.failed ? 'error' : releaseRun.finishedMs ? 'success' : 'warning'}>
                  {' · '}{releaseHeader(releaseRun, releaseRun.finishedMs ? '' : elapsed((now || Date.now()) - releaseRun.startedMs))}
                </Text>
              )}
              {mergeRun && (
                <Text color={!mergeRun.finishedMs ? 'warning' : mergeCounts(mergeRun).failed > 0 ? 'error' : 'success'}>
                  {' · '}{mergeHeader(mergeRun, elapsed((mergeRun.finishedMs ?? (now || Date.now())) - mergeRun.startedMs))}
                </Text>
              )}
            </Text>
            {releaseLink ? (
              <Box gap={2}>
                <Button key="release-web" hotkey="2" plain variant="primary" label={releaseLink} onPress={() => void openRelease($)} />
              </Box>
            ) : bitacoraPr ? (
              <Box gap={2}>
                <Button key="bitacora-merge" hotkey="1" plain variant="primary" label="mergear" onPress={() => void mergeBitacoraPr($)} />
                <Button key="bitacora-web" hotkey="2" plain label="ver PR" onPress={() => void openBitacoraPr($)} />
                <Button key="bitacora-close" hotkey="3" plain label="cerrar PR" onPress={() => void closeBitacoraPr($)} />
              </Box>
            ) : (
            <Box gap={2}>
              {workPrs > 0 && (
                <Button key="merge-prs" hotkey="2" plain label={`PRs ${workPrs}`} onPress={() => void chooseMerge($)} />
              )}
              {pendingNotes > 0 && !historian && (
                <Button key="bitacora" hotkey="3" plain label={`bitácora ${pendingNotes}`} onPress={() => void chooseBitacora($)} />
              )}
              {changelog && changelog.issues > 0 && (
                <Button key="release" hotkey="4" plain label={`release ${changelog.issues}`} onPress={() => void chooseRelease($)} />
              )}
            </Box>
            )}
          </Box>
          <Box gap={2} height={RASTER_ROWS + 1} alignItems="flex-start">
            {mascot}
            {mergeRun ? (
              <Box flexDirection="column" width={body} marginTop={1}>
                {mergeLines.map(p => (
                  <Text key={`merge-${p.num}`} wrap="truncate-end" color={p.estado === 'fallido' ? 'error' : undefined}>
                    <Text color={p.estado === 'fallido' ? 'error' : 'warning'}>{p.estado === 'fallido' ? '✗' : '●'}</Text>
                    {` #${p.num}${p.title ? ` ${p.title}` : ''}`}
                  </Text>
                ))}
                {mergeLines.length === 0 && <Text color="success">✓ todos mergeados</Text>}
                {mergeHidden > 0 && <Text dimColor>+{mergeHidden} más</Text>}
              </Box>
            ) : releaseRun ? (
              <Box flexDirection="column" width={body} marginTop={1}>
                {releaseLines.map(i => (
                  <Text key={`release-${i.issue}`} wrap="truncate-end" dimColor={isConsolidatedRun}>
                    <Text color={isConsolidatedRun ? 'success' : 'warning'}>{isConsolidatedRun ? '✓' : '●'}</Text>
                    {` #${i.issue}${i.title ? ` ${i.title}` : ''}${i.categories.length > 0 ? ` · ${i.categories.join('/')}` : ''}`}
                  </Text>
                ))}
                {releaseIssues.length === 0 && <Text dimColor>sin fragmentos pendientes en changelog.d/</Text>}
                {releaseHidden > 0 && <Text dimColor>+{releaseHidden} más</Text>}
                <Text wrap="truncate-end">
                  {releaseChecklist(releaseRun).map((s, i) => (
                    <Text key={`fase-${s.step}`} color={s.mark === '✓' ? 'success' : s.mark === '●' ? 'warning' : s.mark === '✗' ? 'error' : undefined} dimColor={s.mark === '·'}>
                      {i > 0 ? ' → ' : ''}{s.mark} {s.label}
                    </Text>
                  ))}
                </Text>
              </Box>
            ) : historian ? (
              <Box flexDirection="column" width={body} marginTop={1}>
                {historian.pr && <Text wrap="truncate-end">PR #{historian.pr.number} {historian.pr.title}</Text>}
                {noteLines.map(n => (
                  <Text key={`nota-${n.name}`} wrap="truncate-end" dimColor={n.estado === 'procesada'}>
                    <Text color={n.estado === 'procesada' ? 'success' : 'warning'}>{n.estado === 'procesada' ? '✓' : '●'}</Text>
                    {` ${n.name.replace(/\.md$/, '')}`}
                  </Text>
                ))}
                {historian.notes.length === 0 && <Text dimColor>leyendo las field notes…</Text>}
                {notesHidden > 0 && <Text dimColor>+{notesHidden} más</Text>}
              </Box>
            ) : (
            <Box flexDirection="column" width={body} marginTop={1}>
              {!ready && <Text dimColor>cargando…</Text>}
              {ready?.error && <Text color="error">next-order falló: {clip(ready.error, body - 20)}</Text>}
              {ready && !ready.error && visible.length === 0 && <Text dimColor>Sin issues en estado:listo.</Text>}
              {visible.map((item, i) => {
                const label = `${padEnd(`#${item.number}`, numWidth)} ${padEnd(clip(item.title, titleWidth), titleWidth)}`
                return (
                  <Box>
                    {item.isLaunchable ? (
                      <Button
                        key={`ready-${item.number}`}
                        hotkey={String(i + 5)}
                        plain
                        dimColor={page > 0 || i > 0}
                        label={label}
                        onPress={() => void choose($, item.number)}
                      />
                    ) : (
                      <Text dimColor>{`   ${label}`}</Text>
                    )}
                    <Text dimColor>{item.reason ? `  ${clip(item.reason, afterWidth)}` : ''}</Text>
                  </Box>
                )
              })}
              {Array.from({ length: Math.max(0, READY_ROWS - Math.max(visible.length, 1)) }, (_, i) => (
                <Text key={`ready-blank-${i}`}> </Text>
              ))}
              <Box justifyContent="space-between">
                <Text> </Text>
                <Box gap={2}>
                  {more !== '' && <Text dimColor>{more}</Text>}
                  {pages > 1 && (
                    <Button key="ready-page" hotkey="0" plain dimColor label={`página ${page + 1}/${pages} ▸`}
                      onPress={() => void nextReadyPage($)} />
                  )}
                </Box>
              </Box>
            </Box>
            )}
          </Box>
          {/* La linea de todos los listos crece con la cola: va abajo, a lo ancho, y no empuja los menus fijos. */}
          {!mergeRun && !bitacoraPr && ready?.launch && (
            <Button key="ready-all" hotkey="1" plain label={clip(ready.launch.replace(/^\/mefisto-/, ''), inner - 3)}
              onPress={() => void fill($, ready.launch ?? '')} />
          )}
        </Box>
      )
    }
    // La corrida ocupa la misma banda que la espera: la mascota del agente activo, los pasos y lo ultimo que hizo.
    const lines = await read($, linesAtom)
    const hold = await read($, holdAtom)
    const inner = Math.max(40, (e.props.bodyColumns ?? 80) - 4)
    const body = Math.max(30, inner - MASCOT_WIDTH - 2)
    const end = run.finishedMs ?? (now || Date.now())
    const pr = prNumber(run.pr)
    const pose = mascotPose(run, lines[lines.length - 1])
    const frame = run.state === 'running' ? (Math.floor((now || Date.now()) / 1000) % 2 === 0 ? 0 : 1) : 0
    const grid = cropGrid(sprite(pose.role, pose.state, frame), MASCOT_COLS)
    const elements = $.ui.resolve(e)
    const mascot =
      'Raster' in elements ? (
        <elements.Raster key="mefisto-mascota" columns={MASCOT_WIDTH} rows={RASTER_ROWS} cells={mascotCells(grid)} />
      ) : (
        <Box width={MASCOT_WIDTH} />
      )
    const recent = lines.filter(l => l.ts !== '').slice(-BAND_LOG_ROWS)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="claude" borderDimColor paddingX={1}>
        <Box justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text color="claude">mefisto</Text>
            {run.state === 'running' && <Text> · #{run.issue} {stageName(run.stage)}</Text>}
            {run.state === 'completed' && <Text color="success"> · #{run.issue} ✓ {pr ? `PR #${pr}` : 'terminado'}</Text>}
            {run.state === 'failed' && <Text color="error"> · #{run.issue} ✗ {stageName(run.stage)}</Text>}
            <Text dimColor> {elapsed(end - run.startedMs)}</Text>
          </Text>
          <Box gap={2}>
            {run.state === 'completed' && pr && (
              <Button key="band-merge" hotkey="1" plain variant="primary" label="mergear" onPress={() => void merge($)} />
            )}
            {run.state === 'completed' && pr && <Button key="band-web" hotkey="2" plain label="ver PR" onPress={() => void openPr($)} />}
            <Button key="band-open" hotkey="3" plain dimColor={run.state === 'running'} label="log" onPress={() => void toggleLog($)} />
            {run.state !== 'running' && <Button key="band-close" hotkey="4" plain label="cerrar" onPress={() => void closeRun($)} />}
          </Box>
        </Box>
        <Box gap={2} height={RASTER_ROWS + 1} alignItems="flex-start">
          {mascot}
          <Box flexDirection="column" width={body} marginTop={1}>
            <Text wrap="truncate-end">
              {steps(run).map((st, i) => (
                <Text
                  color={st.mark === 'done' ? 'success' : st.mark === 'failed' ? 'error' : st.mark === 'current' ? 'warning' : undefined}
                  dimColor={st.mark === 'pending'}
                >
                  {i > 0 ? ' ─ ' : ''}
                  {st.mark === 'done' ? '✓' : st.mark === 'failed' ? '✗' : st.mark === 'current' ? '●' : '○'} {st.name}
                </Text>
              ))}
            </Text>
            {run.title !== '' && <Text dimColor wrap="truncate-end">{run.title}</Text>}
            {run.state === 'running' && hold && <Text color="warning" wrap="truncate-end">{holdText(hold)}</Text>}
            {run.state === 'failed' && run.lastError && <Text color="error" wrap="truncate-end">{run.lastError}</Text>}
            {run.state === 'running' && recent.length === 0 && <Text dimColor>esperando eventos del agente…</Text>}
            {run.state === 'running' &&
              recent.map(line => (
                <Text wrap="truncate-end" color={lineColor(line)} dimColor={line.kind === 'text'}>
                  {`${line.ts} ${line.kind === 'text' ? '» ' : ''}${line.text}`}
                </Text>
              ))}
          </Box>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const run = await read($, runAtom)
    if (!run) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Sin corrida. Lanza /mefisto-tooling &lt;issue&gt; o /mefisto-divine-wager &lt;issue&gt;.</Text>
        </Box>
      )
    }
    const lines = await read($, linesAtom)
    const now = await read($, nowAtom)
    const width = Math.max(20, e.props.bodyColumns ?? 60)
    const rows = Math.max(3, (e.props.scroll?.bodyRows ?? PANE_ROWS) - FIXED_ROWS)
    const end = run.finishedMs ?? (now || Date.now())
    const pr = prNumber(run.pr)

    return (
      <Box flexDirection="column" width={width}>
        <Box justifyContent="space-between">
          <Text bold color="claude">mefisto-tooling #{run.issue}</Text>
          <Text dimColor>{elapsed(end - run.startedMs)}</Text>
        </Box>
        {run.title !== '' && <Text wrap="truncate-end">{run.title}</Text>}
        <Box>
          {steps(run).map((s, i) => (
            <Text
              color={s.mark === 'done' ? 'success' : s.mark === 'failed' ? 'error' : s.mark === 'current' ? 'warning' : undefined}
              dimColor={s.mark === 'pending'}
            >
              {i > 0 ? ' ─ ' : ''}
              {s.mark === 'done' ? '✓' : s.mark === 'failed' ? '✗' : s.mark === 'current' ? '●' : '○'} {s.name}
              {agentDuration(run, s.name)}
            </Text>
          ))}
        </Box>
        {run.state === 'completed' && (
          <Box flexDirection="column">
            <Box gap={3}>
              <Text color="success" bold>✓ {pr ? `PR #${pr} creado` : 'terminado'}</Text>
              {pr && <Button key="merge" hotkey="m" plain variant="primary" label={`Mergear #${pr}`} onPress={() => void merge($)} />}
              {pr && <Button key="web" hotkey="v" plain label="Ver en GitHub" onPress={() => void openPr($)} />}
              <Button key="close" hotkey="c" plain label="Cerrar log" role="dismiss" onPress={() => void closeLog($)} />
            </Box>
            <Text dimColor wrap="truncate-end">
              {pr ? `m: /mefisto-merge ${pr} (squash + borra rama) · ` : ''}c: cierra el log, la banda sigue · ctrl+x tab enfoca · esc vuelve al prompt
            </Text>
          </Box>
        )}
        {run.state === 'failed' && (
          <Box flexDirection="column">
            <Text color="error" wrap="wrap">✗ falló en {stageName(run.stage)}{run.lastError ? `: ${run.lastError}` : ''}</Text>
            <Box gap={2}>
              <Button key="close" hotkey="c" plain label="Cerrar log" role="dismiss" onPress={() => void closeLog($)} />
            </Box>
          </Box>
        )}
        {run.state === 'running' && (
          <Box gap={2}>
            <Button key="close" hotkey="c" plain label="Cerrar log" role="dismiss" onPress={() => void closeLog($)} />
            <Text dimColor>3 en la banda también lo cierra · ctrl+x tab enfoca · esc vuelve al prompt</Text>
          </Box>
        )}
        <Text dimColor>{'─'.repeat(Math.min(width, 80))}</Text>
        <Box flexDirection="column">
          {lines.length === 0 && <Text dimColor>esperando eventos del agente…</Text>}
          {lines.slice(-rows).map(line => (
            <Text wrap="truncate-end" color={lineColor(line)} dimColor={line.kind === 'text'}>
              {line.ts !== '' ? `${line.ts} ` : ''}
              {line.kind === 'text' ? '» ' : ''}
              {line.text}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}

function stageName(stage: string): string {
  return stage.replace(/^\d+-/, '')
}

function agentDuration(run: PipelineRun, step: string): string {
  const d = run.agents[step]?.duration
  return typeof d === 'number' && d > 0 ? ` ${Math.round(d / 60)}m` : ''
}

function lineColor(line: LogLine) {
  if (line.kind === 'fail') return 'error' as const
  if (line.kind === 'done') return 'success' as const
  if (line.kind === 'start') return 'claude' as const
  return undefined
}
