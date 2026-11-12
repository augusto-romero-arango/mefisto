import { expect, test } from 'claude-code/testing'
import type { BoardList } from './types'

import {
  arrivals,
  showsDraftList,
  isMefistoManifest,
  versionLabel,
  shouldRearm,
  isIssueChange,
  createdIssueOf,
  isIssueCreate,
  cropGrid,
  mascotPose,
  usedColumns,
  isPlannerClosing,
  issueMarkedListo,
  issueClosed,
  addPending,
  applyPending,
  dropIssue,
  PENDING_TTL_MS,
  agentFlagOf,
  agentSettingOf,
  transcriptPathOf,
  pageOf,
  parseNextOrder,
  reasonOf,
  refineTargetOf,
  signatureOf,
  topicOf,
  typeBadge,
  nextOrderPath,
} from './logic'

test('lee el JSON de next-order, vacio y con fallo', async () => {
  const ok = parseNextOrder(
    0,
    '{"mode":"refinement","items":[{"number":801,"title":"A","tipo":"tooling","after":[],"hasDepsSection":false}],"blocked":[{"number":2,"by":3,"reason":"external"}],"cycles":[],"launch":null}',
    '',
  )
  expect(ok.items[0]?.number).toBe(801)
  expect(ok.items[0]?.tipo).toBe('tooling')
  expect(ok.items[0]?.hasDepsSection).toBe(false)
  expect(ok.blockedCount).toBe(1)
  expect(parseNextOrder(1, '{"items":[],"blocked":[],"cycles":[],"launch":null}', '').error).toBe(null)
  expect(parseNextOrder(2, '', "ERROR: fallo 'gh issue list'\n").error).toBe("ERROR: fallo 'gh issue list'")
})

test('la firma cambia con labels y updatedAt, no con el orden de la lista', async () => {
  const a = [{ number: 1, updatedAt: 't1', labels: [{ name: 'estado:borrador' }] }, { number: 2, updatedAt: 't2' }]
  expect(signatureOf(a)).toBe(signatureOf([...a].reverse()))
  expect(signatureOf(a)).not.toBe(signatureOf([{ ...a[0]!, labels: [{ name: 'estado:listo' }] }, a[1]!]))
})

test('avisa solo de borradores y listos nuevos, nunca en el primer refresco', async () => {
  const issues = [
    { number: 1, title: 'viejo', labels: [{ name: 'estado:listo' }] },
    { number: 2, title: 'nuevo borrador', labels: [{ name: 'estado:borrador' }] },
    { number: 3, title: 'sin estado', labels: [] },
  ]
  expect(arrivals(issues, [])).toEqual([])
  expect(arrivals(issues, [1])).toEqual([{ number: 2, title: 'nuevo borrador', kind: 'borrador' }])
})

test('la razon solo dice de que depende', async () => {
  const item = { number: 5, title: 't', tipo: null, after: [3, 4], hasDepsSection: true }
  expect(reasonOf(item)).toBe('tras #3 #4')
  expect(reasonOf({ ...item, after: [], hasDepsSection: false })).toBe('')
})

test('el mensaje marca el foco: refinar #N o explorar con tema', async () => {
  expect(refineTargetOf('Refina el borrador #801')).toBe(801)
  expect(refineTargetOf('refinemos #1800 por favor')).toBe(1800)
  expect(refineTargetOf('mira el #801 antes')).toBe(null)
  expect(topicOf('Quiero explorar: tablero del planner con foco\nmas detalle')).toBe('tablero del planner con foco')
})

test('reconoce las senales de cierre y de borradores creados', async () => {
  expect(issueMarkedListo('gh issue edit 801 --remove-label "estado:borrador" --add-label "estado:listo" --add-label "tipo:tooling"')).toBe(801)
  expect(issueMarkedListo('gh issue edit 801 --add-label bloqueado')).toBe(null)
  expect(isPlannerClosing('MEFISTO_RUNTIME=claude node src/internal/scripts/field-note.mts --agent mefisto:planner')).toBe(true)
  expect(isIssueCreate('gh issue create --title "X" --label "estado:borrador"')).toBe(true)
  expect(createdIssueOf('https://github.com/o/r/issues/2085\n')).toBe(2085)
})

test('pagina con su tamaño y vuelve a la primera si la lista se achica', async () => {
  expect(pageOf(0, 12, 5)).toEqual({ page: 0, pages: 3 })
  expect(pageOf(2, 12, 5)).toEqual({ page: 2, pages: 3 })
  expect(pageOf(2, 4, 4)).toEqual({ page: 0, pages: 1 })
  expect(pageOf(0, 0, 5)).toEqual({ page: 0, pages: 1 })
})

test('reconoce la sesion del planner por su transcript', async () => {
  const planner = '{"type":"user"}\n{"type":"agent-setting","agentSetting":"mefisto:planner","sessionId":"s"}\n'
  expect(agentSettingOf(planner)).toBe('mefisto:planner')
  expect(agentSettingOf('{"type":"user"}\n')).toBe(null)
  expect(agentSettingOf('roto\n{"type":"agent-setting","agentSetting":"otro"}')).toBe('otro')
  expect(transcriptPathOf('/h/.claude', '/Users/a/Cosmos/eda-evsourcing-azure-harness', 'id1')).toBe(
    '/h/.claude/projects/-Users-a-Cosmos-eda-evsourcing-azure-harness/id1.jsonl',
  )
})

test('lee el --agent de la linea de comando del proceso', async () => {
  expect(agentFlagOf('claude --agent mefisto:planner --plugin-dir /x')).toBe('mefisto:planner')
  expect(agentFlagOf('/usr/local/bin/claude --agent=mefisto:planner')).toBe('mefisto:planner')
  expect(agentFlagOf('claude --plugin-dir /x')).toBe(null)
})

test('la mascota es siempre la del planner', async () => {
  expect(mascotPose(true, 2, false)).toBe('planeando')
  expect(mascotPose(true, 0, false)).toBe('pensando')
  expect(mascotPose(false, 3, true)).toBe('listo')
  expect(mascotPose(false, 0, false)).toBe('planeando')
})

test('recorta las columnas vacias comunes a todos los cuadros', async () => {
  const a = ['..x...', '...x..']
  const b = ['....x.', '..x...']
  expect(usedColumns([a, b])).toEqual({ from: 2, to: 4 })
  expect(cropGrid(a, { from: 2, to: 4 })).toEqual(['x..', '.x.'])
})


test('reconoce los cambios de issues que obligan a refrescar las listas', async () => {
  expect(isIssueChange('gh issue edit 2080 --add-label estado:listo')).toBe(true)
  expect(isIssueChange('gh issue create --title x')).toBe(true)
  expect(isIssueChange('gh issue close 12')).toBe(true)
  expect(isIssueChange('gh issue view 12')).toBe(false)
})

test('traduce el tipo a su letra y color, y ? gris si falta', async () => {
  expect(typeBadge('feature')).toEqual({ letter: 'F', color: 'success' })
  expect(typeBadge('refactor').letter).toBe('R')
  expect(typeBadge('projection')).toEqual({ letter: 'P', color: 'cyan' })
  expect(typeBadge('tooling')).toEqual({ letter: 'T', color: 'magenta' })
  expect(typeBadge('infra')).toEqual({ letter: 'I', color: 'blue' })
  expect(typeBadge(null)).toEqual({ letter: '?', color: 'gray' })
  expect(typeBadge('otro').letter).toBe('?')
})

test('el cierre acepta la invocacion real del planner, con ruta expandida y comillas', async () => {
  expect(isPlannerClosing('MEFISTO_RUNTIME=claude node "${MEFISTO_PACKAGE_ROOT}/scripts/field-note.mts" --session-id abc')).toBe(true)
  expect(isPlannerClosing('MEFISTO_RUNTIME=claude node "/p/mefisto/scripts/field-note.mts" --session-id abc')).toBe(true)
  expect(isPlannerClosing('MEFISTO_RUNTIME=claude node "/Users/a b/mefisto plugin/scripts/field-note.mts" --session-id abc')).toBe(true)
  expect(isPlannerClosing('cd x && node /p/scripts/field-note.mts --session-id abc')).toBe(true)
  expect(isPlannerClosing('/p/scripts/mefisto-field-note.mts')).toBe(false)
})

test('nombrar field-note.mts o gh issue create sin ejecutarlos no cuenta', async () => {
  expect(isPlannerClosing('cat scripts/field-note.mts')).toBe(false)
  expect(isPlannerClosing('grep -n foo scripts/field-note.mts')).toBe(false)
  expect(isPlannerClosing('git show HEAD:scripts/field-note.mts')).toBe(false)
  expect(isPlannerClosing("cat <<'EOF'\n/p/scripts/field-note.mts --x\nEOF")).toBe(false)
  expect(isIssueCreate('git show abc:x | grep "gh issue create"')).toBe(false)
  expect(isIssueCreate('cat <<EOF\ngh issue create --title x\nEOF')).toBe(false)
  expect(isIssueChange('echo "gh issue edit 1"')).toBe(false)
  expect(issueMarkedListo('gh issue edit 801 --title x; echo --add-label estado:listo')).toBe(null)
})

test('el cierre es field-note.mts y la ruta de next-order cuelga de la raiz del plugin', async () => {
  expect(isPlannerClosing('"$root/scripts/field-note.mts" --agent mefisto:planner')).toBe(true)
  expect(isPlannerClosing('gh issue view 3')).toBe(false)
  expect(nextOrderPath('/p/mefisto/')).toBe('/p/mefisto/scripts/next-order.mts')
})

test('un mismo comando puede crear un borrador y pasar a listo el issue del foco', async () => {
  const cmd = 'gh issue create --title x --label "estado:borrador" && gh issue edit 2108 --add-label "estado:listo"'
  expect(isIssueCreate(cmd)).toBe(true)
  expect(issueMarkedListo(cmd)).toBe(2108)
})

test('reconoce el manifiesto del propio plugin Mefisto', async () => {
  expect(isMefistoManifest('{ "name": "mefisto", "version": "0.43.0" }')).toBe(true)
  expect(isMefistoManifest('{ "name": "otro-plugin" }')).toBe(false)
  expect(isMefistoManifest('no json')).toBe(false)
})

test('reconoce el cierre de un issue', async () => {
  expect(issueClosed('gh issue close 801 --comment "ok"')).toBe(801)
  expect(issueClosed('cd x && gh issue close #802')).toBe(802)
  expect(issueClosed('gh issue edit 801 --add-label bloqueado')).toBe(null)
  expect(issueClosed('echo "gh issue close 5"')).toBe(null)
})

const item = (number: number) => ({ number, title: `T${number}`, tipo: null, after: [], hasDepsSection: true })
const board = (...numbers: number[]): BoardList => ({
  items: numbers.map(item), blockedCount: 0, cycleCount: 0, launch: null, infra: [], parallel: null, error: null,
})

test('la quita optimista saca el item y recalcula los indices de la pagina visible', async () => {
  const list = dropIssue(board(1, 2, 3, 4, 5, 6, 7), 2)
  expect(list?.items.map(i => i.number)).toEqual([1, 3, 4, 5, 6, 7])
  expect(list?.items.slice(0, 5).map(i => i.number)).toEqual([1, 3, 4, 5, 6])
  expect(dropIssue(null, 2)).toBe(null)
  const same = board(1)
  expect(dropIssue(same, 9)).toBe(same)
})

test('el conjunto pendiente filtra el borrador y sale al confirmarse o a los 60 s', async () => {
  const pending = addPending(new Map(), 2, 1000)
  const still = applyPending(board(1, 2, 3), pending, 1000 + 5_000)
  expect(still.list.items.map(i => i.number)).toEqual([1, 3])
  expect(still.pending.has(2)).toBe(true)
  const confirmed = applyPending(board(1, 3), still.pending, 1000 + 10_000)
  expect(confirmed.pending.size).toBe(0)
  const expired = applyPending(board(1, 2, 3), pending, 1000 + PENDING_TTL_MS)
  expect(expired.list.items.map(i => i.number)).toEqual([1, 2, 3])
  expect(expired.pending.size).toBe(0)
  const failed = applyPending({ ...board(), error: 'next-order fallo' }, pending, 1000 + 5_000)
  expect(failed.pending.has(2)).toBe(true)
})

test('showsDraftList: solo una exploracion con borradores creados muestra la lista', () => {
  expect(showsDraftList(null)).toBe(false)
  expect(showsDraftList({ kind: 'explorar', created: [] })).toBe(false)
  expect(showsDraftList({ kind: 'explorar', created: [12] })).toBe(true)
  expect(showsDraftList({ kind: 'refinar', created: [12] })).toBe(false)
})

test('versionLabel: manifest valido, fallback a plugin.json y null si ninguno sirve', () => {
  const manifest = JSON.stringify({ version: '0.46.0' })
  const plugin = JSON.stringify({ version: '0.45.1' })
  expect(versionLabel(manifest, plugin)).toBe('v0.46.0')
  expect(versionLabel(JSON.stringify({ version: 'latest' }), plugin)).toBe('v0.45.1')
  expect(versionLabel('no es json', plugin)).toBe('v0.45.1')
  expect(versionLabel(null, null)).toBe(null)
  expect(versionLabel('{}', '{"version": 3}')).toBe(null)
})

test('shouldRearm: rearma solo con intencion activa y el atom en blanco', () => {
  expect(shouldRearm({ isEligible: true, isWanted: true, isActive: false })).toBe(true)
  expect(shouldRearm({ isEligible: true, isWanted: true, isActive: true })).toBe(false)
  expect(shouldRearm({ isEligible: true, isWanted: false, isActive: false })).toBe(false)
  expect(shouldRearm({ isEligible: false, isWanted: true, isActive: false })).toBe(false)
})
