import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BoardFocus, BoardList, BoardTab } from '../types'
import {
  NEXT_ORDER,
  agentFlagOf,
  agentSettingOf,
  transcriptPathOf,
  arrivals,
  blockedBy,
  blocksText,
  briefsOf,
  clip,
  createdCardText,
  createdIssueOf,
  createdText,
  showsDraftList,
  cropGrid,
  depsText,
  labelsText,
  minutesSince,
  parseIssueCard,
  isIssueChange,
  isIssueCreate,
  usedColumns,
  mascotPose,
  isPlannerClosing,
  issueMarkedListo,
  issueClosed,
  PENDING_TTL_MS,
  settlePending,
  withoutItems,
  numberWidth,
  padEnd,
  pageOf,
  pageSizeOf,
  parseNextOrder,
  parseOpenIssues,
  reasonOf,
  refineTargetOf,
  signatureOf,
  topicOf,
} from './logic'
import { DEFAULT_COLOR, HEIGHT, PALETTE, RASTER_ROWS, sprite } from './sprites'

const PLANNER_AGENT = 'mefisto-planner'
const POLL_MS = 60_000
const SCRIPT_TIMEOUT_MS = 180_000
const FLASH_MS = 8_000
// GitHub tarda en reflejar un cambio en todas sus consultas: un refresco inmediato puede guardar la firma nueva
// con listas viejas de next-order y el poll ya no vuelve a refrescar. Se repite forzado tras este margen.
const SETTLE_MS = 15_000

const activeAtom = atom({ plugin: 'mefisto-planner-board', key: 'isActive' } as const, false)
const plannerAtom = atom({ plugin: 'mefisto-planner-board', key: 'isPlannerSession' } as const, false)
const expandedAtom = atom({ plugin: 'mefisto-planner-board', key: 'isExpanded' } as const, false)
const pageAtom = atom({ plugin: 'mefisto-planner-board', key: 'page' } as const, 0)
const tabAtom = atom({ plugin: 'mefisto-planner-board', key: 'tab' } as const, 'borrador')
const focusAtom = atom({ plugin: 'mefisto-planner-board', key: 'focus' } as const, null)
const flashAtom = atom({ plugin: 'mefisto-planner-board', key: 'flash' } as const, null)
const refineAtom = atom({ plugin: 'mefisto-planner-board', key: 'refine' } as const, null)
const developAtom = atom({ plugin: 'mefisto-planner-board', key: 'develop' } as const, null)
const updatedAtom = atom({ plugin: 'mefisto-planner-board', key: 'updatedMs' } as const, 0)
const signatureAtom = atom({ plugin: 'mefisto-planner-board', key: 'signature' } as const, '')
const frameAtom = atom({ plugin: 'mefisto-planner-board', key: 'frame' } as const, 0)
const stepsAtom = atom({ plugin: 'mefisto-planner-board', key: 'stepsInTurn' } as const, 0)
const workingAtom = atom({ plugin: 'mefisto-planner-board', key: 'isWorking' } as const, false)
const knownAtom = atom({ plugin: 'mefisto-planner-board', key: 'known' } as const, [])
const cardAtom = atom({ plugin: 'mefisto-planner-board', key: 'card' } as const, null)
const openAtom = atom({ plugin: 'mefisto-planner-board', key: 'open' } as const, [])

const pendingAtom = atom({ plugin: 'mefisto-planner-board', key: 'pendingCount' } as const, 0)

let pending = new Map<number, number>()
let isInteractive = false
// La intencion vive en el modulo, no en atoms: /clear abre una sesion nueva con los atoms en blanco, el modulo sigue.
let isBoardOn = false
let isTurnedOff = false
let isRefreshing = false
let settle: { cancel: () => void } | null = null
let timer: { cancel: () => void } | null = null
let animation: { cancel: () => void } | null = null
const ANIMATION_MS = 600

async function runNextOrder($: EngineInterface, args: string[]): Promise<BoardList> {
  const { exitCode, stdout, stderr } = await $.process
    .run(['node', NEXT_ORDER, ...args], { timeoutMs: SCRIPT_TIMEOUT_MS })
    .catch(err => ({ exitCode: 2, stdout: '', stderr: String(err) }))
  return parseNextOrder(exitCode, stdout, stderr)
}

async function refresh($: EngineInterface, isForced: boolean) {
  if (isRefreshing || !(await read($, activeAtom))) return
  isRefreshing = true
  try {
    const { exitCode, stdout } = await $.process
      .run(['gh', 'issue', 'list', '--state', 'open', '--limit', '300', '--json', 'number,title,labels,updatedAt'])
      .catch(() => ({ exitCode: 1, stdout: '' }))
    const issues = exitCode === 0 ? parseOpenIssues(stdout) : null
    if (!issues) return

    const signature = signatureOf(issues)
    if (!isForced && pending.size === 0 && signature === (await read($, signatureAtom))) return

    const focus = await read($, focusAtom)
    await update($, openAtom, () => briefsOf(issues))
    if (focus?.kind === 'refinar' && focus.issue !== null) await loadCard($, focus.issue)
    for (const a of arrivals(issues, await read($, knownAtom))) {
      if (!focus?.created.includes(a.number)) $.ui.toast(`Nuevo ${a.kind} #${a.number}: ${clip(a.title, 60)}`)
    }
    const [refine, develop] = await Promise.all([runNextOrder($, ['--refinement', '--json']), runNextOrder($, ['--json'])])
    pending = settlePending(pending, refine.error ? null : refine.items.map(i => i.number), Date.now())
    await update($, refineAtom, () => withoutItems(refine, pending.keys()))
    await update($, developAtom, () => develop)
    await update($, pendingAtom, () => pending.size)
    await update($, signatureAtom, () => signature)
    await update($, knownAtom, () => issues.map(i => i.number))
    await update($, updatedAtom, () => Date.now())
  } finally {
    isRefreshing = false
  }
}

async function loadCard($: EngineInterface, issue: number) {
  const { exitCode, stdout } = await $.process
    .run(['gh', 'issue', 'view', String(issue), '--json', 'number,title,labels,body'])
    .catch(() => ({ exitCode: 1, stdout: '' }))
  const card = exitCode === 0 ? parseIssueCard(stdout) : null
  if (card) await update($, cardAtom, () => card)
}

async function activate($: EngineInterface) {
  isBoardOn = true
  await update($, activeAtom, () => true)
  timer?.cancel()
  timer = $.clock.every(POLL_MS, () => void refresh($, false))
  void refresh($, true)
}

async function deactivate($: EngineInterface) {
  isBoardOn = false
  isTurnedOff = true
  pending.clear()
  timer?.cancel()
  timer = null
  await update($, activeAtom, () => false)
}

// El engine no entrega eventos classic.* a un plugin de tier user y session.start no se repite tras /clear,
// /resume ni /branch: cada segundo se compara la intencion del modulo con el atom y se rearma el tablero.
const HEAL_MS = 1_000

async function heal($: EngineInterface) {
  if (isBoardOn && !isTurnedOff && !(await read($, activeAtom))) await activate($)
}

const DETECT_TRIES = 20
const DETECT_EVERY_MS = 3_000

// El agente principal de la sesion. Los eventos clasicos no llegan a un plugin de tier user,
// asi que se lee primero la linea de comando del proceso de Claude Code (padre del `sh` que corre aqui) y,
// si no se puede, el inicio del transcript, que solo existe tras el primer mensaje: por eso se reintenta.
async function detectPlanner($: EngineInterface, triesLeft: number) {
  if (!isInteractive || isTurnedOff || (await read($, activeAtom))) return
  const ps = await $.process.run(['sh', '-c', 'ps -o args= -p "$PPID"']).catch(() => ({ exitCode: 1, stdout: '' }))
  const cmdline = ps.exitCode === 0 ? ps.stdout.trim() : ''
  if (/\bclaude\b/.test(cmdline)) {
    if (agentFlagOf(cmdline) === PLANNER_AGENT) await claimPlanner($)
    return
  }
  const home = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const path = transcriptPathOf(home, await $.session.cwd(), await $.session.id())
  const { stdout } = await $.process.run(['head', '-c', '200000', path]).catch(() => ({ stdout: '' }))
  const agent = agentSettingOf(stdout)
  if (agent === PLANNER_AGENT) {
    await claimPlanner($)
    return
  }
  if (agent === null && triesLeft > 0) $.clock.after(DETECT_EVERY_MS, () => void detectPlanner($, triesLeft - 1))
}

// Marca la sesion como del planner y la activa si ya se sabe que es interactiva. Devuelve si la activo ahora.
async function claimPlanner($: EngineInterface): Promise<boolean> {
  await update($, plannerAtom, () => true)
  if (!isInteractive || isTurnedOff || (await read($, activeAtom))) return false
  await activate($)
  return true
}

// Cada instruccion del agente (una herramienta, o tu mensaje que abre el turno) alterna el cuadro A/B.
async function step($: EngineInterface, isNewTurn: boolean) {
  await update($, frameAtom, f => (f === 1 ? 0 : 1))
  await update($, stepsAtom, n => (isNewTurn ? 0 : (n ?? 0) + 1))
}

// Recorte comun a todos los cuadros del planner, calculado una vez: sin margen y sin saltos al alternar.
const MASCOT_STATES = ['planeando', 'pensando', 'listo'] as const
const MASCOT_COLS = usedColumns(MASCOT_STATES.flatMap(state => [sprite('planner', state, 0), sprite('planner', state, 1)]))
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

// Mientras Claude trabaja (pensando o con herramientas) la mascota alterna sola; en reposo queda quieta.
async function setWorking($: EngineInterface, isWorking: boolean) {
  await update($, workingAtom, () => isWorking)
  animation?.cancel()
  animation = isWorking ? $.clock.every(ANIMATION_MS, () => void update($, frameAtom, f => (f === 1 ? 0 : 1))) : null
}

async function startFocus($: EngineInterface, focus: BoardFocus) {
  await update($, flashAtom, () => null)
  await update($, focusAtom, () => focus)
  await update($, cardAtom, () => null)
  if (focus.kind === 'refinar' && focus.issue !== null) void loadCard($, focus.issue)
}

async function closeFocus($: EngineInterface, summary: string) {
  await update($, focusAtom, () => null)
  await update($, cardAtom, () => null)
  await update($, flashAtom, () => ({ text: summary, untilMs: Date.now() + FLASH_MS }))
  $.clock.after(FLASH_MS, () => void update($, flashAtom, () => null))
  void refresh($, true)
}

function summaryOf(focus: BoardFocus, isListo: boolean): string {
  const created = createdText(focus.created)
  const head =
    focus.kind === 'refinar'
      ? `✓ #${focus.issue}${isListo ? ' → listo' : ' · refinamiento cerrado'}`
      : `✓ exploración «${clip(focus.topic, 40)}»`
  return [head, created].filter(Boolean).join(' · ')
}

async function onPrompt($: EngineInterface, text: string) {
  const focus = await read($, focusAtom)
  const target = refineTargetOf(text)
  if (target !== null && !(focus?.kind === 'refinar' && focus.issue === target)) {
    const known = (await read($, refineAtom))?.items.find(i => i.number === target)
    await startFocus($, { kind: 'refinar', issue: target, topic: known?.title ?? '', created: [], startedMs: Date.now() })
    return
  }
  if (!focus && target === null && text.trim() !== '' && !text.trim().startsWith('/')) {
    await startFocus($, { kind: 'explorar', issue: null, topic: topicOf(text), created: [], startedMs: Date.now() })
  }
}

function refreshAfterSettle($: EngineInterface) {
  settle?.cancel()
  settle = $.clock.after(SETTLE_MS, () => void refresh($, true))
}

// El issue que sale de borrador se quita de la lista al instante; los refrescos lo siguen filtrando hasta que
// GitHub confirme el cambio o venza el plazo. La lista de listos no se toca: la trae el siguiente refresco.
async function markPending($: EngineInterface, issue: number) {
  pending.set(issue, Date.now() + PENDING_TTL_MS)
  await update($, refineAtom, list => withoutItems(list, [issue]))
  await update($, pendingAtom, () => pending.size)
  $.clock.after(PENDING_TTL_MS + 1_000, () => void refresh($, true))
}

async function onBash($: EngineInterface, command: string, output: string) {
  const left = issueMarkedListo(command) ?? issueClosed(command)
  if (left !== null) await markPending($, left)
  if (isIssueChange(command)) refreshAfterSettle($)
  const focus = await read($, focusAtom)
  if (!focus) return
  // Un mismo comando puede crear un borrador y pasar el foco a listo: se revisan las dos cosas.
  if (isIssueCreate(command)) {
    const created = createdIssueOf(output)
    if (created !== null && !focus.created.includes(created)) {
      if (focus.kind === 'explorar' && focus.created.length === 0) await update($, pageAtom, () => 0)
      await update($, focusAtom, f => (f ? { ...f, created: [...f.created, created] } : f))
      void refresh($, true)
    }
  }
  const listo = issueMarkedListo(command)
  if (focus.kind === 'refinar' && listo !== null && listo === focus.issue) {
    const updated = (await read($, focusAtom)) ?? focus
    await closeFocus($, summaryOf(updated, true))
    return
  }
  if (isPlannerClosing(command)) await closeFocus($, summaryOf(focus, false))
}

// Cierre de la exploracion con una tecla: pulsarla ya es la autorizacion, asi que le pide al planner su rutina
// de cierre (resumen + field note) sin confirmar. El foco se cierra solo cuando el planner corre
// mefisto-field-note.mts.
async function closeSession($: EngineInterface) {
  await $.prompt.submit({ text: 'Cierra la sesión ahora, sin pedir confirmación: resumen, field note y entrega.', asUser: true })
}

// La misma tecla abre su lista o, si ya estaba abierta, la cierra.
async function toggleList($: EngineInterface, tab: BoardTab) {
  if (await read($, focusAtom)) return
  const isOpen = (await read($, expandedAtom)) && (await read($, tabAtom)) === tab
  await update($, tabAtom, () => tab)
  await update($, pageAtom, () => 0)
  await update($, expandedAtom, () => !isOpen)
}

// Avanza de pagina y da la vuelta al final.
async function nextPage($: EngineInterface) {
  const tab = showsDraftList(await read($, focusAtom)) ? 'borrador' : await read($, tabAtom)
  const list = tab === 'borrador' ? await read($, refineAtom) : await read($, developAtom)
  const { page, pages } = pageOf(await read($, pageAtom), list?.items.length ?? 0, pageSizeOf(tab))
  await update($, pageAtom, () => (page + 1) % pages)
}

// Rastro para diagnosticar teclas que llegan como texto (#2210): el log de debug dice si el boton estaba en el
// arbol de la banda y si la pulsacion llego al mod.
async function debugLog($: EngineInterface, text: () => string) {
  try {
    await $.ui.log(`[mefisto-planner-board] ${text()}`, { to: 'debug' })
  } catch {
    // El rastro nunca debe tumbar el render ni la pulsacion que observa.
  }
}

async function fill($: EngineInterface, text: string) {
  await $.prompt.fill({ text, mode: 'replace' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    await $.command.register({
      name: 'mefisto-planner-board',
      description: 'Tablero del planner: refresh | borradores | listos | cerrar | cerrar-sesion | on | off',
      argumentHint: '[refresh|borradores|listos|cerrar|cerrar-sesion|on|off]',
      immediate: true,
    })
    const isWanted = (await read($, activeAtom)) || (await read($, plannerAtom))
    if (isInteractive && isWanted) await activate($)
    if (isInteractive && (await read($, workingAtom))) await setWorking($, true)
    else if (isInteractive) void detectPlanner($, DETECT_TRIES)
    if (isInteractive) $.clock.every(HEAL_MS, () => void heal($))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && !(await read($, activeAtom))) await detectPlanner($, 0)
    if (await read($, activeAtom)) {
      await step($, true)
      await setWorking($, true)
    }
    if (e.origin.kind === 'composer' && (await read($, activeAtom))) await onPrompt($, e.text)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (await read($, activeAtom)) await step($, false)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (await read($, activeAtom)) {
      const output = ran.text ?? JSON.stringify(ran.result ?? '')
      await onBash($, e.command, output).catch(() => undefined)
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (await read($, activeAtom)) await setWorking($, false)
    return done
  })

  on('command.run', { command: 'mefisto-planner-board' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off') {
      await deactivate($)
      return { text: 'Tablero del planner apagado en esta sesión.' }
    }
    if (arg === 'on' || !(await read($, activeAtom))) {
      isTurnedOff = false
      await activate($)
      return { text: 'Tablero del planner activo en esta sesión.' }
    }
    if (arg === 'borradores' || arg === 'listos') {
      await toggleList($, arg === 'borradores' ? 'borrador' : 'listo')
      return { text: `Lista de ${arg} alternada.` }
    }
    if (arg === 'cerrar-sesion') {
      await closeSession($)
      return { text: 'Cierre de sesión solicitado al planner.' }
    }
    if (arg === 'cerrar') {
      const focus = await read($, focusAtom)
      if (focus) await closeFocus($, summaryOf(focus, false))
      return { text: focus ? 'Foco cerrado.' : 'No había foco abierto.' }
    }
    await refresh($, true)
    return { text: 'Tablero actualizado.' }
  })

  on('ui.press', async ($, e, next) => {
    await debugLog($, () => `ui.press ${JSON.stringify(e)}`)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(await read($, activeAtom))) return next(e)
    if (e.props.hasSurvey) {
      await debugLog($, () => `render omitido hasSurvey=true isWorking=${!!e.props.isWorking} maxRows=${String(e.props.maxRows)}`)
      return next(e)
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const focus = await read($, focusAtom)
    const flash = await read($, flashAtom)
    const isExpanded = await read($, expandedAtom)
    const refine = await read($, refineAtom)
    const develop = await read($, developAtom)
    const inner = Math.max(40, (e.props.bodyColumns ?? 80) - 4)
    const count = (l: BoardList | null) => (l ? String(l.items.length) : '…')
    const tab = showsDraftList(focus) ? 'borrador' : await read($, tabAtom)
    const pendingCount = await read($, pendingAtom)
    const suggested = refine?.items[0]?.number ?? null
    const listButtons = (
      <Box gap={2}>
        <Button key="list-borrador" hotkey="3" plain variant={isExpanded && tab === 'borrador' ? 'primary' : undefined}
          dimColor={!(isExpanded && tab === 'borrador')} label={`borradores ${count(refine)}`}
          onPress={() => void toggleList($, 'borrador')} />
        {pendingCount > 0 && <Text dimColor>actualizando…</Text>}
        <Button key="list-listo" hotkey="4" plain variant={isExpanded && tab === 'listo' ? 'primary' : undefined}
          dimColor={!(isExpanded && tab === 'listo')} label={`listos ${count(develop)}`}
          onPress={() => void toggleList($, 'listo')} />
      </Box>
    )

    let head
    if (focus) {
      // La cabecera dice que se hace y desde cuando; el titulo o el tema va una sola vez, en el cuerpo.
      const minutes = minutesSince(focus.startedMs ?? Date.now(), Date.now())
      const label = `${focus.kind === 'refinar' ? `refinar #${focus.issue}` : 'explorar'} · ${minutes} min`
      const created = createdText(focus.created)
      head = (
        <Box justifyContent="space-between">
          <Box gap={2}>
            <Text color="claude">●</Text>
            <Text bold>{label}</Text>
            {created !== '' && <Text color="success">{created}</Text>}
          </Box>
          {focus.kind === 'explorar' && (
            <Button key="close-session" hotkey="1" plain label="cerrar sesión" onPress={() => void closeSession($)} />
          )}
        </Box>
      )
    } else if (flash && flash.untilMs > Date.now()) {
      head = (
        <Box justifyContent="space-between">
          <Text color="success">{clip(flash.text, inner - 34)}</Text>
          {listButtons}
        </Box>
      )
    } else {
      head = (
        <Box justifyContent="space-between">
          <Box gap={3}>
            <Button key="mode-explorar" hotkey="1" plain label="explorar" onPress={() => void fill($, 'Quiero explorar: ')} />
            {suggested !== null && (
              <Button key="mode-refinar" hotkey="2" plain label={`refinar #${suggested}`}
                onPress={() => void fill($, `Refina el borrador #${suggested}`)} />
            )}
          </Box>
          {listButtons}
        </Box>
      )
    }

    const body = Math.max(30, inner - MASCOT_WIDTH - 2)
    const hotkeys = focus ? (focus.kind === 'explorar' ? ['1'] : []) : flash && flash.untilMs > Date.now() ? ['3', '4'] : suggested !== null ? ['1', '2', '3', '4'] : ['1', '3', '4']
    await debugLog($, () => `render kind=${focus?.kind ?? 'reposo'} hotkeys=[${hotkeys.join(',')}] isWorking=${!!e.props.isWorking} hasSurvey=${!!e.props.hasSurvey} maxRows=${String(e.props.maxRows)}`)
    const frame = await read($, frameAtom)
    const isWorking = e.props.isWorking || (await read($, workingAtom))
    const state = mascotPose(isWorking, await read($, stepsAtom), !!flash && flash.untilMs > Date.now())
    const grid = cropGrid(sprite('planner', state, frame), MASCOT_COLS)
    const elements = $.ui.resolve(e)
    const mascot =
      'Raster' in elements ? (
        <elements.Raster key="mefisto-mascota" columns={MASCOT_WIDTH} rows={RASTER_ROWS} cells={mascotCells(grid)} />
      ) : (
        <Box width={MASCOT_WIDTH} />
      )

    const updatedMs = await read($, updatedAtom)
    let content
    if (focus?.kind === 'refinar' && focus.issue !== null) {
      const card = await read($, cardAtom)
      const open = await read($, openAtom)
      const title = card?.title || focus.topic
      content = (
        <Box flexDirection="column" width={body}>
          <Text bold color="claude" wrap="wrap">{clip(title || ' ', body * 2 - 2)}</Text>
          {title.length <= body && <Text> </Text>}
          {!card && <Text dimColor>cargando ficha…</Text>}
          {card && <Text dimColor wrap="truncate-end">{labelsText(card.labels)}</Text>}
          {card && (
            <Text color={card.hasDepsSection ? undefined : 'warning'} wrap="truncate-end">{depsText(card, open)}</Text>
          )}
          {card && <Text dimColor wrap="truncate-end">{blocksText(blockedBy(focus.issue, [refine, develop]))}</Text>}
        </Box>
      )
    } else if (focus && !showsDraftList(focus)) {
      const open = await read($, openAtom)
      const shown = focus.created.slice(-3)
      content = (
        <Box flexDirection="column" width={body}>
          <Text bold color="claude" wrap="wrap">{clip(focus.topic || ' ', body * 2 - 2)}</Text>
          {focus.topic.length <= body && <Text> </Text>}
          {shown.length === 0 && <Text dimColor>sin borradores aún</Text>}
          {shown.map(n => (
            <Text key={`created-${n}`} color="success" wrap="truncate-end">{createdCardText(n, open, body)}</Text>
          ))}
        </Box>
      )
    } else if (!isExpanded && !showsDraftList(focus)) {
      const nextRefine = refine?.items.slice(0, 2) ?? []
      const nextDevelop = develop?.items[0]
      content = (
        <Box flexDirection="column" width={body}>
          <Text dimColor>siguiente a refinar</Text>
          {[0, 1].map(i => (
            <Text key={`r-${i}`} dimColor={i > 0} wrap="truncate-end">
              {nextRefine[i] ? `#${nextRefine[i].number}  ${clip(nextRefine[i].title, body - 8)}` : ' '}
            </Text>
          ))}
          <Text dimColor>siguiente a desarrollar</Text>
          <Text wrap="truncate-end">{nextDevelop ? `#${nextDevelop.number}  ${clip(nextDevelop.title, body - 8)}` : ' '}</Text>
          <Text dimColor>{updatedMs ? ' ' : 'cargando…'}</Text>
        </Box>
      )
    } else {
      const list = tab === 'borrador' ? refine : develop
      const size = pageSizeOf(tab)
      const { page, pages } = pageOf(await read($, pageAtom), list?.items.length ?? 0, size)
      const visible = list?.items.slice(page * size, (page + 1) * size) ?? []
      const blankRows = Math.max(0, size - Math.max(visible.length, 1))
      const numWidth = numberWidth(visible)
      // Solo 'tras #N' ocupa columna: sin dependencias no se marca.
      const afterWidth = Math.min(16, Math.max(0, ...visible.map(i => reasonOf(i).length)))
      // Ancho exacto de la fila: el prefijo '5: ' de la tecla (solo en borradores), el numero, un espacio
      // y, si alguno depende de otro, la columna 'tras #N'. El titulo ocupa el resto hasta el marco.
      const keyPrefix = tab === 'borrador' ? 3 : 0
      const titleWidth = Math.max(12, body - keyPrefix - numWidth - 1 - (afterWidth > 0 ? afterWidth + 2 : 0))
      const more = list
        ? [
            list.blockedCount > 0 ? `${list.blockedCount} bloqueados` : '',
            list.cycleCount > 0 ? `${list.cycleCount} en ciclo` : '',
          ].filter(Boolean).join(' · ')
        : ''
      const hint = tab === 'borrador' ? '5-9 al prompt' : ''
      content = (
        <Box flexDirection="column" width={body}>
          {list?.error && <Text color="error">next-order falló: {clip(list.error, body - 20)}</Text>}
          {list && !list.error && visible.length === 0 && (
            <Text dimColor>{tab === 'borrador' ? 'Sin borradores refinables.' : 'Sin issues lanzables.'}</Text>
          )}
          {visible.map((item, i) => {
            const reason = reasonOf(item)
            return (
              <Box>
                {tab === 'borrador' ? (
                  <Button
                    key={`item-${item.number}`}
                    hotkey={String(i + 5)}
                    plain
                    dimColor={page > 0 || i > 0}
                    label={`${padEnd(`#${item.number}`, numWidth)} ${padEnd(clip(item.title, titleWidth), titleWidth)}`}
                    onPress={() => void fill($, `Refina el borrador #${item.number}`)}
                  />
                ) : (
                  <Text dimColor={page > 0 || i > 0}>
                    {`${padEnd(`#${item.number}`, numWidth)} ${padEnd(clip(item.title, titleWidth), titleWidth)}`}
                  </Text>
                )}
                <Text dimColor>{reason ? `  ${clip(reason, afterWidth)}` : ''}</Text>
              </Box>
            )
          })}
          {Array.from({ length: blankRows }, (_, i) => (
            <Text key={`blank-${i}`}> </Text>
          ))}
          <Box justifyContent="space-between">
            <Text dimColor>{hint}</Text>
            <Box gap={2}>
              {more !== '' && <Text dimColor>{more}</Text>}
              {pages > 1 && (
                <Button key="next-page" hotkey="0" plain dimColor label={`página ${page + 1}/${pages} ▸`} onPress={() => void nextPage($)} />
              )}
            </Box>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="claude" borderDimColor paddingX={1}>
        {head}
        <Box gap={2} height={RASTER_ROWS + 1} alignItems="flex-start">
          {mascot}
          <Box marginTop={1}>{content}</Box>
        </Box>
      </Box>
    )
  })
}
