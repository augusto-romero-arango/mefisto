import { expect, test } from 'claude-code/testing'

import {
  arrivals,
  blockedBy,
  createdCardText,
  showsDraftList,
  dependenciesOf,
  depsText,
  labelsText,
  parseIssueCard,
  isIssueChange,
  createdIssueOf,
  isIssueCreate,
  cropGrid,
  mascotPose,
  usedColumns,
  isPlannerClosing,
  issueMarkedListo,
  issueClosed,
  settlePending,
  withoutItems,
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
} from './logic'

test('lee el JSON de next-order, vacio y con fallo', async () => {
  const ok = parseNextOrder(
    0,
    '{"mode":"refinement","items":[{"number":801,"title":"A","after":[],"hasDepsSection":false}],"blocked":[{"number":2,"by":3,"reason":"external"}],"cycles":[],"launch":null}',
    '',
  )
  expect(ok.items[0]?.number).toBe(801)
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
  const item = { number: 5, title: 't', after: [3, 4], hasDepsSection: true }
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
  expect(isPlannerClosing('MEFISTO_RUNTIME=claude ./.claude/scripts/mefisto-field-note.sh --agent mefisto-planner')).toBe(true)
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
  const planner = '{"type":"user"}\n{"type":"agent-setting","agentSetting":"mefisto-planner","sessionId":"s"}\n'
  expect(agentSettingOf(planner)).toBe('mefisto-planner')
  expect(agentSettingOf('{"type":"user"}\n')).toBe(null)
  expect(agentSettingOf('roto\n{"type":"agent-setting","agentSetting":"otro"}')).toBe('otro')
  expect(transcriptPathOf('/h/.claude', '/Users/a/Cosmos/eda-evsourcing-azure-harness', 'id1')).toBe(
    '/h/.claude/projects/-Users-a-Cosmos-eda-evsourcing-azure-harness/id1.jsonl',
  )
})

test('lee el --agent de la linea de comando del proceso', async () => {
  expect(agentFlagOf('claude --agent mefisto-planner --plugin-dir /x')).toBe('mefisto-planner')
  expect(agentFlagOf('/usr/local/bin/claude --agent=mefisto-planner')).toBe('mefisto-planner')
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

test('solo cuenta los comandos que se ejecutan, no los que se nombran', async () => {
  expect(isPlannerClosing('MEFISTO_RUNTIME=claude ./.claude/scripts/mefisto-field-note.sh --agent mefisto-planner')).toBe(true)
  expect(isPlannerClosing('cd /repo; git show origin/main:src/internal/scripts/mefisto-field-note.sh | grep -n worktree')).toBe(false)
  expect(isPlannerClosing("grep -rn 'mefisto-field-note.sh' docs")).toBe(false)
  expect(issueMarkedListo('gh issue edit 2105 --remove-label "estado:borrador" --add-label "estado:listo"')).toBe(2105)
  expect(issueMarkedListo('cd /r && S=x; gh issue edit 2105 --body-file $S/b.md && gh issue edit 2105 --add-label estado:listo')).toBe(2105)
  expect(issueMarkedListo("grep -n 'gh issue edit 7 --add-label estado:listo' a.md")).toBe(null)
  expect(isIssueCreate("cat > b.md <<'EOF'\ngh issue create --title x\nEOF\necho ok")).toBe(false)
  expect(isIssueChange('cd /r; gh issue close 12 --reason completed')).toBe(true)
  const both = 'gh issue edit 2108 --body-file b.md && gh issue edit 2108 --remove-label "estado:borrador" --add-label "estado:listo"\nN=$(gh issue create --title x --body "$(cat <<\'EOF\'\nhola\nEOF\n)")'
  expect(issueMarkedListo(both)).toBe(2108)
  expect(isIssueCreate(both)).toBe(true)
})

test('lee las dependencias forward de la seccion, con la regla de issue-dependencies.mts', async () => {
  const body = [
    '## Contexto',
    'Depende de #1 fuera de la seccion',
    '## Dependencias',
    '- Depende de #2139 (capacidad ask)',
    '* Bloqueado por #20 y #21',
    '- No depende de #30',
    'Prosa que menciona depende de #40',
    '## Componente',
    '- Depende de #50',
  ].join('\n')
  expect(dependenciesOf(body)).toEqual({ deps: [20, 2139], hasSection: true })
  expect(dependenciesOf('## Contexto\nnada')).toEqual({ deps: [], hasSection: false })
})

test('arma la ficha del issue en foco', async () => {
  const card = parseIssueCard(
    JSON.stringify({
      number: 2137,
      title: 'Hacer que el planner pregunte',
      labels: [{ name: 'estado:borrador' }, { name: 'dom:planner' }, { name: 'tipo:tooling' }],
      body: '## Dependencias\n- Depende de #2139\n- Depende de #2000',
    }),
  )
  expect(card?.deps).toEqual([2000, 2139])
  expect(labelsText(card?.labels ?? [])).toBe('tipo:tooling · dom:planner · estado:borrador')
  const open = [{ number: 2139, title: 'ask', labels: ['estado:listo'] }]
  expect(depsText(card!, open)).toBe('depende de #2000 ✓ · #2139 listo')
  expect(depsText({ ...card!, deps: [] }, open)).toBe('no depende de nada')
  expect(depsText({ ...card!, deps: [], hasDepsSection: false }, open)).toBe('sin sección ## Dependencias')
  expect(parseIssueCard('no json')).toBe(null)
})

test('bloquea a quien va tras el issue en cualquiera de las listas', async () => {
  const list = (items: { number: number; after: number[] }[]) => ({
    items: items.map(i => ({ ...i, title: 't', hasDepsSection: true })),
    blockedCount: 0,
    cycleCount: 0,
    launch: null,
    error: null,
  })
  expect(blockedBy(5, [list([{ number: 7, after: [5] }, { number: 6, after: [] }]), null, list([{ number: 3, after: [1, 5] }])])).toEqual([3, 7])
})

test('la ficha de un borrador creado lleva su tipo', async () => {
  const open = [{ number: 2140, title: 'Mostrar la ficha', labels: ['estado:borrador', 'tipo:tooling'] }]
  expect(createdCardText(2140, open, 60)).toBe('#2140 Mostrar la ficha · tipo:tooling')
  expect(createdCardText(9, open, 60)).toBe('#9')
})

test('issueClosed extrae el numero de gh issue close', async () => {
  expect(issueClosed('gh issue close 2214 --reason completed')).toBe(2214)
  expect(issueClosed('cd /r && gh issue close #801')).toBe(801)
  expect(issueClosed('git show HEAD:x # gh issue close 5')).toBe(null)
  expect(issueClosed('gh issue edit 5 --add-label x')).toBe(null)
})

const draft = (number: number) => ({ number, title: `t${number}`, after: [], hasDepsSection: true })
const listOf = (...ns: number[]) => ({ items: ns.map(draft), blockedCount: 0, cycleCount: 0, launch: null, error: null })

test('la quita optimista saca el issue sin reordenar y recalcula la pagina visible', async () => {
  const list = listOf(1, 2, 3, 4, 5, 6)
  const out = withoutItems(list, [1])
  expect(out?.items.map(i => i.number)).toEqual([2, 3, 4, 5, 6])
  expect(pageOf(1, out?.items.length ?? 0, 5)).toEqual({ page: 0, pages: 1 })
  expect(out?.items.slice(0, 5)[0]?.number).toBe(2)
  expect(withoutItems(null, [1])).toBe(null)
  expect(withoutItems(list, [])).toBe(list)
})

test('el conjunto pendiente se filtra, se confirma o expira a los 60 s', async () => {
  const pending = new Map([[7, 1_000 + PENDING_TTL_MS]])
  expect([...settlePending(pending, [7, 8], 2_000).keys()]).toEqual([7])
  expect(settlePending(pending, [8], 2_000).size).toBe(0)
  expect(settlePending(pending, [7], 1_000 + PENDING_TTL_MS).size).toBe(0)
  expect([...settlePending(pending, null, 2_000).keys()]).toEqual([7])
  expect(settlePending(pending, null, 1_000 + PENDING_TTL_MS).size).toBe(0)
})

test('showsDraftList: solo explorar con borradores creados', () => {
  expect(showsDraftList(null)).toBe(false)
  expect(showsDraftList({ kind: 'explorar', created: [] })).toBe(false)
  expect(showsDraftList({ kind: 'explorar', created: [7] })).toBe(true)
  expect(showsDraftList({ kind: 'refinar', created: [7] })).toBe(false)
})
