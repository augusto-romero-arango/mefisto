import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CliError } from '../../../scripts/lib/cli.mts'
import { parseJq } from '../../../scripts/lib/jq-literals.mts'
import { JqError } from '../../../scripts/lib/jq-values.mts'
import type { StateDirs } from '../../../scripts/lib/state.mts'
import { ANSI, PLAIN, clock, delta, isMissing, isNewerThan } from '../../../scripts/lib/stream-watch.mts'
import type { DiscoveryFilter } from '../../../scripts/lib/stream-watch.mts'
import { isolateGitConfig } from '../../../scripts/tests/field-note-sandbox.mts'
import {
  EventViewer,
  banner,
  discoverStream,
  discoverStreamInDirs,
  eventRows,
  logDirs,
  matchesIssues,
  msOrNd,
  orNd,
  parseArguments,
  relativizePath,
  secondsOrNd,
  streamHeader,
  terminalSummary,
} from '../../../src/internal/scripts/mefisto-stream-watch.mts'
import { translate } from '../../../src/runtime/lib/runtime-claude.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'src', 'internal', 'scripts', 'mefisto-stream-watch.mts')
const NO_FILTER: DiscoveryFilter = { issues: '', newerThan: '' }

let work = ''
let dirs: StateDirs = { canonical: '', legacy: '' }
let restoreGit = (): void => {}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto-stream-watch-'))
  restoreGit = isolateGitConfig(work)
  dirs = {
    canonical: join(work, 'state-canonico', 'pipeline'),
    legacy: join(work, 'state-legacy', 'pipeline'),
  }
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true })
})

interface Session {
  viewer: EventViewer
  /** Lo que el visor escribio desde la ultima vez que se pidio. */
  take: () => string
}

function session(filter: DiscoveryFilter = NO_FILTER, pinned = ''): Session {
  let text = ''
  let taken = 0
  const viewer = new EventViewer({ dirs, filter, pinned, colors: PLAIN, write: (chunk) => (text += chunk) })
  return {
    viewer,
    take: () => {
      const fresh = text.slice(taken)
      taken = text.length
      return fresh
    },
  }
}

function stream(name: string, ...events: string[]): string {
  const file = join(work, name)
  writeFileSync(file, events.map((event) => `${event}\n`).join(''))
  return file
}

interface Shown {
  viewer: EventViewer
  out: string
  lines: string[]
}

/** Procesa el archivo en un visor recien cambiado de archivo y devuelve lo que mostro. */
function show(file: string): Shown {
  const { viewer, take } = session()
  viewer.processNewLines(file)
  const out = take()
  return { viewer, out, lines: out.split('\n').slice(0, -1) }
}

function touch(dir: string, name: string, isoTime: string): string {
  const file = join(dir, name)
  writeFileSync(file, '{}\n')
  const time = new Date(isoTime)
  utimesSync(file, time, time)
  return file
}

const rows = (json: string): string[][] => eventRows(parseJq(json))

describe('[A] message: texto completo, indentacion multilinea y el degrade con texto vacio', () => {
  let lines: string[] = []
  let viewer = session().viewer

  before(() => {
    const file = stream(
      'a-stream.jsonl',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","role":"assistant","text":"","kind":"thinking"}',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:05Z","role":"assistant","text":"","kind":"text"}',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:10Z","role":"assistant","text":"linea uno\\nlinea dos"}',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:15Z","role":"assistant","text":"razono paso 1\\nrazono paso 2","kind":"thinking"}',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:20Z","role":"assistant","text":"ruta C:\\\\temp con\\ttab y \\\\n literal"}',
    )
    const shown = show(file)
    viewer = shown.viewer
    lines = shown.lines
  })

  test('A-1: kind=thinking con texto vacio se senala solo con (pensando)', () => {
    assert.match(lines[0] ?? '', /^\[[0-9:]{8}\]       -  \(pensando\)$/)
  })

  test('A-2: kind=text con texto vacio se senala solo con (texto)', () => {
    assert.match(lines[1] ?? '', /^\[[0-9:]{8}\] \+  5\.0s  \(texto\)$/)
  })

  test('A-3: con texto presente, kind=text no lleva la etiqueta (texto)', () => {
    assert.match(lines[2] ?? '', /^\[[0-9:]{8}\] \+  5\.0s  linea uno$/)
  })

  test('A-4: la segunda linea del texto va sola, indentada, sin marca de tiempo ni truncar', () => {
    assert.equal(lines[3], `${' '.repeat(20)}linea dos`)
  })

  test('A-5: kind=thinking con texto presente conserva (pensando) delante del texto', () => {
    assert.match(lines[4] ?? '', /^\[[0-9:]{8}\] \+  5\.0s  \(pensando\) razono paso 1$/)
  })

  test('A-6: la segunda linea de un thinking multilinea va indentada, sin repetir la etiqueta', () => {
    assert.equal(lines[5], `${' '.repeat(20)}razono paso 2`)
  })

  test('A-7: backslash, tab y la secuencia \\n literales se reproducen fieles', () => {
    assert.ok((lines[6] ?? '').endsWith('  ruta C:\\temp con\ttab y \\n literal'), lines[6])
  })

  test('A-8: el cursor avanzo sobre las 5 lineas', () => {
    assert.equal(viewer.cursor.lines, 5)
    assert.equal(lines.length, 7)
  })

  test('el texto pierde sus saltos finales, y `-`, `null` o solo saltos cuentan como vacio', () => {
    const file = stream(
      'a-bordes.jsonl',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","text":"con saltos al final\\n\\n\\n","kind":"otro"}',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","text":"-"}',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","text":"null","kind":"thinking"}',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","text":"\\n\\n"}',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","text":"uno\\n\\ndos"}',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","text":{"a":[1,2.50]}}',
    )
    const stamp = (text: string): RegExp => new RegExp(`^\\[[0-9:]{8}\\] .{7}  ${text}$`)
    const shown = show(file).lines
    assert.match(shown[0] ?? '', stamp('con saltos al final'))
    assert.match(shown[1] ?? '', stamp('\\(texto\\)'))
    assert.match(shown[2] ?? '', stamp('\\(pensando\\)'))
    assert.match(shown[3] ?? '', stamp('\\(texto\\)'))
    assert.match(shown[4] ?? '', stamp('uno'))
    assert.deepEqual(shown.slice(5, 7), [' '.repeat(20), `${' '.repeat(20)}dos`])
    assert.match(shown[7] ?? '', stamp('\\{"a":\\[1,2\\.50\\]\\}'))
  })
})

describe('[B] tool.started visible con input_summary relativizado; tool.completed silencioso salvo fallo', () => {
  let out = ''
  let lines: string[] = []
  let viewer = session().viewer

  before(() => {
    const file = stream(
      'b-stream.jsonl',
      '{"v":1,"type":"run.started","ts":"2026-09-05T10:00:00Z","runtime":"fake","agent":"mefisto-writer","model":"m","cwd":"/tmp/worktree"}',
      '{"v":1,"type":"tool.started","ts":"2026-09-05T10:00:01Z","tool":"Read","input_summary":"/tmp/worktree/src/Foo.cs"}',
      '{"v":1,"type":"tool.completed","ts":"2026-09-05T10:00:01.500Z","tool":"Read","ok":true,"duration_ms":42}',
      '{"v":1,"type":"tool.started","ts":"2026-09-05T10:00:02Z","tool":"Bash","input_summary":null}',
      '{"v":1,"type":"tool.completed","ts":"2026-09-05T10:00:05Z","tool":"Bash","ok":false,"duration_ms":null}',
      '{"v":1,"type":"tool.started","ts":"2026-09-05T10:00:06Z","tool":"WebFetch","input_summary":"/otra/ruta/afuera.txt"}',
      '{"v":1,"type":"tool.completed","ts":"2026-09-05T10:00:06.200Z","tool":"WebFetch","ok":false,"duration_ms":200}',
      '{"v":1,"type":"tool.started","ts":"2026-09-05T10:00:07Z","tool":"Bash","input_summary":"sed -e s/\\\\t/x/ f && grep -F \\\\c f"}',
    )
    const shown = show(file)
    viewer = shown.viewer
    out = shown.out
    lines = shown.lines
  })

  test('B-1: run.started y el Read exitoso no producen fila; los 4 tool.started y los 2 fallos si', () => {
    assert.equal(lines.length, 6, out)
  })

  test('B-2: tool.started relativiza input_summary contra el cwd del run.started vigente', () => {
    assert.match(lines[0] ?? '', /^\[[0-9:]{8}\]       -  Read: src\/Foo\.cs$/)
    assert.equal(viewer.cwd, '/tmp/worktree')
  })

  test('B-3: tool.started con input_summary null renderiza solo el nombre de la tool', () => {
    assert.match(lines[1] ?? '', /^\[[0-9:]{8}\] \+  1\.0s  Bash$/)
  })

  test('B-4: el tool.completed exitoso no produce linea ni mueve el delta de la siguiente', () => {
    assert.ok(!out.includes('Read (ok'))
    assert.ok(!out.includes('Read fallo'))
  })

  test('B-5: un fallo imprime linea, con duration_ms null como n/d', () => {
    assert.match(lines[2] ?? '', /^\[[0-9:]{8}\] \+  3\.0s  Bash fallo \(n\/d\)$/)
  })

  test('B-6: un input_summary que no empieza por el cwd se muestra tal cual', () => {
    assert.match(lines[3] ?? '', /  WebFetch: \/otra\/ruta\/afuera\.txt$/)
  })

  test('B-7: un fallo imprime linea con su duracion', () => {
    assert.match(lines[4] ?? '', /^\[[0-9:]{8}\] \+  0\.2s  WebFetch fallo \(200ms\)$/)
  })

  test('B-8: run.started no cuenta como evento ignorado', () => {
    assert.equal(viewer.ignored, 0)
  })

  test('B-9: un input_summary con \\t y \\c se muestra literal y completo', () => {
    assert.ok((lines[5] ?? '').endsWith('  Bash: sed -e s/\\t/x/ f && grep -F \\c f'), lines[5])
  })

  test('B-10: la fila del Bash no contiene ningun tab real', () => {
    assert.ok(!(lines[5] ?? '').includes('\t'))
  })

  test('el nombre de la herramienta se muestra escapado y el resumen conserva sus saltos', () => {
    const file = stream(
      'b-bordes.jsonl',
      '{"v":1,"type":"tool.started","ts":"2026-09-05T10:00:00Z","tool":"con\\ttab\\\\y barra","input_summary":"uno\\ndos\\n"}',
      '{"v":1,"type":"tool.started","ts":"2026-09-05T10:00:00Z","tool":null,"input_summary":null}',
      '{"v":1,"type":"tool.completed","ts":"2026-09-05T10:00:00Z","tool":"X\\\\Y","ok":false,"duration_ms":1500.50}',
      '{"v":1,"type":"tool.completed","ts":"2026-09-05T10:00:00Z","tool":"Z","duration_ms":1}',
    )
    assert.deepEqual(
      show(file).lines.map((line) => line.replace(/^\[[0-9:]{8}\] .{7}  /, '')),
      ['con\\ttab\\\\y barra: uno', 'dos', '-', 'X\\\\Y fallo (1500.50ms)'],
    )
  })

  test('las filas llevan los colores del visor', () => {
    const file = stream(
      'b-colores.jsonl',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","text":"pienso","kind":"thinking"}',
      '{"v":1,"type":"tool.started","ts":"2026-09-05T10:00:00.250Z","tool":"Read","input_summary":"x"}',
      '{"v":1,"type":"tool.completed","ts":"2026-09-05T10:00:01Z","tool":"Read","ok":false,"duration_ms":7}',
    )
    let out = ''
    const colored = new EventViewer({ dirs, write: (chunk) => (out += chunk) })
    colored.processNewLines(file)
    const now = clock(String(Date.parse('2026-09-05T10:00:00Z')))
    const later = clock(String(Date.parse('2026-09-05T10:00:01Z')))
    const esc = '\u001b['
    assert.equal(
      out,
      `${esc}0;34m[${now}]${esc}0m       -  ${esc}1;33m(pensando)${esc}0m pienso\n` +
        `${esc}0;34m[${now}]${esc}0m +  0.2s  ${esc}1mRead${esc}0m: x\n` +
        `${esc}0;34m[${later}]${esc}0m +  0.8s  ${esc}1mRead${esc}0m fallo (7ms)\n`,
    )
  })
})

describe('[C] cierre de stage con todos los campos presentes', () => {
  let out = ''
  let viewer = session().viewer

  before(() => {
    const file = stream(
      'c-stream.jsonl',
      '{"v":1,"type":"message","ts":"2026-09-05T10:04:55Z","role":"assistant","text":"listo"}',
      '{"v":1,"type":"run.completed","ts":"2026-09-05T10:05:00Z","status":"success","runtime":"claude","model":"claude-sonnet-5","session_id":"sess-1","duration_ms":45000,"tokens":{"input":1200,"output":340},"cost_usd":0.55,"turns":7,"denials":0,"ttft_ms":300,"api_duration_ms":40000,"error":null}',
    )
    const shown = show(file)
    viewer = shown.viewer
    out = shown.out
  })

  test('C-1: sin ningun n/d cuando todos los campos estan presentes', () => {
    assert.ok(!out.includes('n/d'), out)
  })

  test('C-2: status=success se muestra como (OK)', () => {
    assert.ok(out.includes('(OK)'))
  })

  test('C-3: turnos y costo del evento terminal, sin desplazamiento de campos', () => {
    assert.ok(out.includes('turnos=7  costo_usd=0.55'))
  })

  test('C-4: duracion total y desglose api/no-api', () => {
    assert.ok(out.includes('duracion=45.0s (api=40.0s, no-api=5.0s)'))
  })

  test('C-5: runtime, modelo y session_id del cierre', () => {
    assert.ok(out.includes('runtime=claude  modelo=claude-sonnet-5  session_id=sess-1'))
  })

  test('C-6: el cierre reinicia el contador de ignorados y el instante de referencia', () => {
    assert.equal(viewer.ignored, 0)
    assert.equal(viewer.previousMs, '')
  })

  test('el cierre completo, con sus lineas en blanco y sus colores', () => {
    const now = clock(String(Date.parse('2026-09-05T10:05:00Z')))
    const cells = ['success', 'claude', 'claude-sonnet-5', 'sess-1', '45000', '40000', '0.55', '7', '1200', '340', '300', '0', '-']
    const esc = '\u001b['
    assert.equal(
      terminalSummary(now, cells, 3, ANSI),
      '\n' +
        `${esc}0;32m${esc}1m--- cierre de stage [${now}] (OK) ---${esc}0m\n` +
        'runtime=claude  modelo=claude-sonnet-5  session_id=sess-1\n' +
        'turnos=7  costo_usd=0.55  duracion=45.0s (api=40.0s, no-api=5.0s)\n' +
        'tokens: in=1200 out=340  ttft=300ms  denials=0\n' +
        'eventos ignorados: 3\n' +
        `${esc}0;32m${esc}1mEsperando el siguiente archivo...${esc}0m\n` +
        '\n',
    )
    assert.ok(out.endsWith(terminalSummary(now, cells, 0, PLAIN)))
  })
})

describe('[D] cierre de stage con campos ausentes', () => {
  let out = ''

  before(() => {
    const file = stream(
      'd-stream.jsonl',
      '{"v":1,"type":"run.failed","ts":"2026-09-05T10:05:05Z","status":"failed","runtime":"fake","model":null,"session_id":null,"duration_ms":5000,"tokens":{"input":800,"output":null},"cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":{"kind":"nonzero_exit","detail":"exit 1"}}',
    )
    out = show(file).out
  })

  test('D-1: un status no exitoso se senala como ERROR: <error.kind>', () => {
    assert.match(out, /--- cierre de stage \[[0-9:]{8}\] \(ERROR: nonzero_exit\) ---/)
  })

  test('D-2: modelo y session_id ausentes se muestran como n/d', () => {
    assert.ok(out.includes('runtime=fake  modelo=n/d  session_id=n/d'))
  })

  test('D-3: turnos y costo ausentes se muestran como n/d, nunca 0', () => {
    assert.ok(out.includes('turnos=n/d  costo_usd=n/d'))
  })

  test('D-4: duration_ms en segundos; api y no-api ausentes son n/d', () => {
    assert.ok(out.includes('duracion=5.0s (api=n/d, no-api=n/d)'))
  })

  test('D-5: tokens.input presente se muestra tal cual, el resto ausente como n/d', () => {
    assert.ok(out.includes('tokens: in=800 out=n/d  ttft=n/d  denials=n/d'))
  })

  test('D-6: un terminal success con error conserva el OK y muestra el error.kind', () => {
    const file = stream(
      'd2-stream.jsonl',
      '{"v":1,"type":"run.completed","ts":"2026-09-05T10:06:00Z","status":"success","runtime":"claude","model":"m","session_id":"s","duration_ms":9000,"tokens":{"input":10,"output":20},"cost_usd":0.1,"turns":3,"denials":0,"ttft_ms":100,"api_duration_ms":8000,"error":{"kind":"killed","detail":"SIGKILL tras el result"}}',
    )
    assert.ok(show(file).out.includes('(OK, con killed posterior)'))
  })

  test('un terminal sin ts usa la hora de la ultima fila visible y los campos crudos van escapados', () => {
    const file = stream(
      'd3-stream.jsonl',
      '{"v":1,"type":"message","ts":"2026-09-05T10:05:01Z","text":"antes"}',
      '{"v":1,"type":"run.failed","status":"failed","runtime":null,"model":"","session_id":"sess\\t1","duration_ms":"abc","tokens":null,"estimated_cost_usd":false,"cost_usd":1e3,"turns":0,"error":{"kind":"rate\\\\limit"}}',
    )
    const { out: shown } = show(file)
    const now = clock(String(Date.parse('2026-09-05T10:05:01Z')))
    assert.ok(shown.includes(`--- cierre de stage [${now}] (ERROR: rate\\limit) ---`), shown)
    assert.ok(shown.includes('runtime=n/d  modelo=n/d  session_id=sess\\t1'))
    assert.ok(shown.includes('turnos=0  costo_usd=1E+3  duracion=0.0s (api=n/d, no-api=n/d)'))
  })
})

describe('[E] linea JSON no-objeto y type desconocido', () => {
  test('cuentan como ignoradas, se consumen y no aportan fila', () => {
    const file = stream(
      'e-stream.jsonl',
      '"una linea suelta"',
      '{"v":1,"type":"algo.no.reconocido","ts":"2026-09-05T10:00:00Z"}',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:01Z","role":"assistant","text":"hola"}',
    )
    const { viewer, lines } = show(file)
    assert.equal(viewer.ignored, 2, 'E-1')
    assert.equal(lines.length, 1, 'E-2')
    assert.equal(viewer.cursor.lines, 3, 'E-3')
  })

  test('el filtro marca como ignorado lo que no es un objeto o no trae un type conocido', () => {
    for (const json of ['"suelto"', '42', '[1,2]', 'null', '{"v":1}', '{"type":false}', '{"type":7}', '{"type":""}']) {
      assert.deepEqual(rows(json), [['ignored']], json)
    }
  })

  test('las filas de cada evento conocido, con `-` en lo que falta', () => {
    assert.deepEqual(rows('{"type":"run.started","ts":"2026-09-05T10:00:00Z","cwd":"/w"}'), [
      ['run_started', '1788602400000', '/w'],
    ])
    assert.deepEqual(rows('{"type":"tool.started","ts":null}'), [['tool_started', '-', '-', '-']])
    assert.deepEqual(rows('{"type":"message","kind":"otro","text":"t"}'), [['message', '-', 'text', 't']])
    assert.deepEqual(rows('{"type":"tool.completed","tool":"T","ok":false,"duration_ms":0}'), [
      ['tool', '-', 'T', 'false', '0'],
    ])
    assert.deepEqual(
      rows(
        '{"type":"run.completed","ts":"2026-09-05T10:00:00.5Z","status":"success","runtime":"r","duration_ms":1,"estimated_cost_usd":0.10,"cost_usd":9,"turns":0,"tokens":{"input":5},"error":{"kind":"k"}}',
      ),
      [['terminal', '1788602400500', 'success', 'r', '-', '-', '1', '-', '0.10', '0', '5', '-', '-', '-', 'k']],
    )
  })

  test('un ts de texto con otra forma deja el evento sin fila; uno que no es texto hace fallar el filtro', () => {
    assert.deepEqual(rows('{"type":"message","ts":"2026-09-05T10:00:19+00:00","text":"x"}'), [])
    assert.throws(() => rows('{"type":"message","ts":17,"text":"x"}'), JqError)
    assert.throws(() => rows('{"type":"message","ts":"2026-13-05T10:00:19Z","text":"x"}'), JqError)
    assert.throws(() => rows('{"type":"run.completed","ts":null,"tokens":"cadena"}'), JqError)
    assert.throws(() => rows('{"type":"run.completed","ts":null,"error":"cadena"}'), JqError)
  })
})

describe('[F] linea no-JSON que no es la ultima del lote', () => {
  test('se cuenta como ignorada y el visor avanza mas alla de ella', () => {
    const file = stream(
      'f-stream.jsonl',
      'esto no es JSON en absoluto',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","role":"assistant","text":"hola"}',
    )
    const { viewer, out } = show(file)
    assert.equal(viewer.ignored, 1, 'F-1')
    assert.equal(viewer.cursor.lines, 2, 'F-2')
    assert.ok(out.includes('hola'), 'F-3')
  })

  test('un evento que hace fallar el filtro se trata igual que una linea que no es JSON', () => {
    const file = stream(
      'f-filtro.jsonl',
      '{"v":1,"type":"message","ts":17,"text":"ts numerico"}',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:00+00:00","text":"sin fila"}',
      '',
      '   ',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:16Z","text":"dos"} {"v":1,"type":"message","ts":"2026-09-05T10:00:17Z","text":"valores"}',
    )
    const { viewer, lines } = show(file)
    assert.equal(viewer.ignored, 1)
    assert.equal(viewer.cursor.lines, 5)
    assert.deepEqual(
      lines.map((line) => line.replace(/^\[[0-9:]{8}\] /, '')),
      ['      -  dos', '+  1.0s  valores'],
    )
  })
})

describe('[G] linea no-JSON como ultima del lote', () => {
  test('no se cuenta ni se consume, y se renderiza cuando se completa', () => {
    const file = stream(
      'g-stream.jsonl',
      '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","role":"assistant","text":"primera accion completa"}',
    )
    appendFileSync(file, '{"v":1,"type":"tool.completed","ts":"2026-09-05T10:00:0')
    const { viewer, take } = session()
    assert.doesNotThrow(() => viewer.processNewLines(file), 'G-1')
    assert.equal(viewer.cursor.lines, 1, 'G-2')
    assert.equal(viewer.ignored, 0, 'G-3')
    take()
    appendFileSync(file, '2Z","tool":"Bash","ok":false,"duration_ms":10}\n')
    appendFileSync(file, '{"v":1,"type":"message","ts":"2026-09-05T10:00:12Z","role":"assistant","text":"otra"}\n')
    viewer.processNewLines(file)
    assert.equal(viewer.cursor.lines, 3, 'G-4')
    assert.ok(take().includes('Bash fallo (10ms)'), 'G-5')
  })

  test('una ultima linea corrupta se reintenta aunque ya tenga su salto, hasta que llega otra', () => {
    const file = stream('g-cerrada.jsonl', '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","text":"a"}', '{corrupta}')
    const { viewer } = session()
    viewer.processNewLines(file)
    viewer.processNewLines(file)
    assert.equal(viewer.cursor.lines, 1)
    assert.equal(viewer.ignored, 0)
    appendFileSync(file, '{"v":1,"type":"message","ts":"2026-09-05T10:00:01Z","text":"b"}\n')
    viewer.processNewLines(file)
    assert.equal(viewer.cursor.lines, 3)
    assert.equal(viewer.ignored, 1)
  })

  test('las lineas vacias al final del lote esperan al siguiente contenido', () => {
    const file = stream('g-vacias.jsonl', '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","text":"a"}', '', '')
    const { viewer } = session()
    viewer.processNewLines(file)
    assert.equal(viewer.cursor.lines, 1)
    appendFileSync(file, '{"v":1,"type":"message","ts":"2026-09-05T10:00:01Z","text":"b"}\n')
    viewer.processNewLines(file)
    assert.equal(viewer.cursor.lines, 4)
  })
})

describe('[H] discoverStream elige el *.events.jsonl mas reciente', () => {
  test('H-1: elige el archivo con fecha de modificacion mas reciente', () => {
    const dir = join(work, 'logs-h')
    mkdirSync(dir)
    touch(dir, 'mefisto-tooling-stage-1-writer-20260729-090000-issue-100.events.jsonl', '2026-07-29T09:00:00Z')
    const newest = touch(
      dir,
      'mefisto-tooling-stage-2-reviewer-20260729-093000-issue-100.events.jsonl',
      '2026-07-29T09:30:00Z',
    )
    assert.equal(discoverStream(dir), newest)
  })

  test('H-2: un directorio inexistente no aborta', () => {
    assert.equal(discoverStream(join(work, 'no-existe-jamas')), null)
  })
})

describe('[I] discoverStreamInDirs: canonico primero', () => {
  let canon = ''
  let legacy = ''
  let empty = ''
  let fromLegacy = ''
  let fromCanon = ''

  before(() => {
    canon = join(work, 'canon')
    legacy = join(work, 'legacy')
    empty = join(work, 'vacio')
    for (const dir of [canon, legacy, empty]) mkdirSync(dir)
    fromLegacy = touch(legacy, 'mefisto-tooling-stage-1-writer-20260826-100000-issue-10.events.jsonl', '2026-08-26T10:00:00Z')
    fromCanon = touch(canon, 'mefisto-tooling-stage-1-writer-20260826-080000-issue-20.events.jsonl', '2026-08-26T08:00:00Z')
  })

  test('I-1: el canonico gana aunque el legacy tenga un archivo mas reciente', () => {
    assert.equal(discoverStreamInDirs([canon, legacy]), fromCanon)
  })

  test('I-2: sin candidatos en el canonico, cae al legacy', () => {
    assert.equal(discoverStreamInDirs([empty, legacy]), fromLegacy)
  })

  test('I-3: sin ningun directorio no aborta', () => {
    assert.equal(discoverStreamInDirs([]), null)
  })
})

describe('[I2] los directorios de logs se resuelven en cada sondeo', () => {
  test('un visor lanzado antes que el pipeline encuentra la corrida que nace despues', () => {
    const { viewer, take } = session()
    assert.deepEqual(logDirs(dirs), [], 'I2-1')
    viewer.step()
    assert.equal(viewer.current, '')
    assert.equal(take(), '')

    const logs = join(dirs.canonical, 'logs')
    mkdirSync(logs, { recursive: true })
    const file = join(logs, 'mefisto-tooling-stage-1-writer-20260905-100000-issue-878.events.jsonl')
    writeFileSync(file, '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","text":"nacio"}\n')
    viewer.step()
    assert.equal(viewer.current, file, 'I2-2')
    const shown = take()
    assert.ok(shown.startsWith(`\n=== issue #878 -- stage 1 (writer) -- 20260905-100000 ===\n${file}\n\n`), shown)
    assert.ok(shown.endsWith('  nacio\n'))
  })

  test('al aparecer un archivo mas nuevo cambia a el y reinicia cursor, cwd e ignorados', () => {
    const logs = join(dirs.canonical, 'logs')
    const first = join(logs, 'mefisto-tooling-stage-1-writer-20260905-100000-issue-878.events.jsonl')
    const { viewer, take } = session()
    writeFileSync(first, '{"v":1,"type":"run.started","ts":"2026-09-05T10:00:00Z","cwd":"/w"}\n"suelto"\n{"v":1}\n')
    const old = new Date('2026-09-05T10:00:00Z')
    utimesSync(first, old, old)
    viewer.step()
    assert.deepEqual([viewer.current, viewer.cursor.lines, viewer.cwd, viewer.ignored], [first, 3, '/w', 2])
    take()
    const second = join(logs, 'mefisto-tooling-stage-2-reviewer-20260905-103000-issue-878.events.jsonl')
    writeFileSync(second, '')
    const recent = new Date('2026-09-05T10:30:00Z')
    utimesSync(second, recent, recent)
    viewer.step()
    assert.deepEqual([viewer.current, viewer.cursor.lines, viewer.cwd, viewer.ignored], [second, 0, '', 0])
    assert.equal(take(), `\n=== issue #878 -- stage 2 (reviewer) -- 20260905-103000 ===\n${second}\n\n`)
    viewer.step()
    assert.equal(take(), '', 'sin lineas nuevas no escribe nada')
  })

  test('una ruta fija se sigue sin descubrir otras', () => {
    const pinned = stream('fija.jsonl', '{"v":1,"type":"message","ts":"2026-09-05T10:00:00Z","text":"fija"}')
    const { viewer, take } = session(NO_FILTER, pinned)
    viewer.step()
    assert.equal(viewer.current, pinned)
    assert.ok(take().startsWith(`\n=== fija.jsonl ===\n${pinned}\n\n`))
  })
})

describe('[J] streamHeader deriva issue, stage y agente del nombre', () => {
  test('J-1: extrae issue, stage y agente del nombre convencional', () => {
    const file = join('x', 'mefisto-tooling-stage-1-writer-20260729-100000-issue-434.events.jsonl')
    assert.equal(
      streamHeader(file, PLAIN),
      `=== issue #434 -- stage 1 (writer) -- 20260729-100000 ===\n${file}\n`,
    )
  })

  test('J-2: un stage no numerico tambien se extrae', () => {
    const file = join('x', 'mefisto-tooling-stage-merge-writer-20260729-100000-issue-441.events.jsonl')
    assert.ok(streamHeader(file, PLAIN).includes('stage merge'))
  })

  test('J-3: un nombre que no sigue el patron se muestra tal cual', () => {
    const file = join('x', 'un-nombre-cualquiera.jsonl')
    assert.equal(streamHeader(file, PLAIN), `=== un-nombre-cualquiera.jsonl ===\n${file}\n`)
    const retry = 'mefisto-tooling-stage-1-writer-20260729-100000-issue-434.attempt-2.events.jsonl'
    assert.ok(streamHeader(join('x', retry), PLAIN).startsWith(`=== ${retry} ===\n`))
  })

  test('el encabezado va en cian, con el titulo en negrita', () => {
    const esc = '\u001b['
    assert.equal(
      streamHeader('a.jsonl', ANSI),
      `${esc}0;36m${esc}1m=== a.jsonl ===${esc}0m\n${esc}0;36ma.jsonl${esc}0m\n`,
    )
  })
})

describe('[K] delta', () => {
  test('K-1: sin accion previa, el delta se muestra como `-`', () => {
    assert.equal(delta('', '1785190194169'), '      -')
  })

  test('K-2: con accion previa, el delta es la diferencia en segundos', () => {
    assert.equal(delta('1785190174000', '1785190194169'), '+ 20.2s')
  })
})

describe('[L] el contrato de n/d para un campo ausente', () => {
  test('L-1: vacio, `-` y `null` cuentan como ausente', () => {
    for (const value of ['', '-', 'null']) assert.equal(isMissing(value), true, value)
  })

  test('L-2: un valor real no se confunde con ausente', () => {
    for (const value of ['0', 'false', '42']) assert.equal(isMissing(value), false, value)
  })

  test('L-3: orNd traduce el placeholder a n/d y deja pasar un valor presente', () => {
    assert.equal(orNd('-'), 'n/d')
    assert.equal(orNd('3'), '3')
  })

  test('L-4: msOrNd agrega la unidad ms sin convertir a segundos', () => {
    assert.equal(msOrNd('-'), 'n/d')
    assert.equal(msOrNd('42'), '42ms')
  })

  test('L-5: secondsOrNd convierte a segundos con un decimal', () => {
    assert.equal(secondsOrNd('-'), 'n/d')
    assert.equal(secondsOrNd('3000'), '3.0s')
    assert.equal(secondsOrNd('45000', '40000'), '5.0s')
    assert.equal(secondsOrNd('45000', '-'), 'n/d')
  })

  test('L-6: clock traduce el placeholder a su marca de hora ausente', () => {
    assert.equal(clock('-'), '--:--:--')
  })

  test('relativizePath quita el prefijo `<cwd>/` literal y nada mas', () => {
    assert.equal(relativizePath('/tmp/w/src/a.cs', '/tmp/w'), 'src/a.cs')
    assert.equal(relativizePath('/tmp/w', '/tmp/w'), '/tmp/w')
    assert.equal(relativizePath('/tmp/work/a', '/tmp/w'), '/tmp/work/a')
    assert.equal(relativizePath('/tmp/w/a', '-'), '/tmp/w/a')
    assert.equal(relativizePath('/tmp/w/a', ''), '/tmp/w/a')
    assert.equal(relativizePath('/a b/[x]/c', '/a b/[x]'), 'c')
  })
})

describe('[M] matchesIssues', () => {
  const stage = 'mefisto-tooling-stage-1-writer-20260826-100000'

  test('M-1: el archivo del issue 42 pasa el filtro 42', () => {
    assert.equal(matchesIssues(`${stage}-issue-42.events.jsonl`, '42'), true)
  })

  test('M-2: el filtro 4 no deja pasar el issue 42', () => {
    assert.equal(matchesIssues(`${stage}-issue-42.events.jsonl`, '4'), false)
  })

  test('M-3: la copia de reintento sigue pasando por su issue', () => {
    assert.equal(matchesIssues(`${stage}-issue-42.attempt-2.events.jsonl`, '42'), true)
  })

  test('M-4: una lista de issues deja pasar a sus miembros y rechaza a los ajenos', () => {
    assert.equal(matchesIssues(`${stage}-issue-43.events.jsonl`, '42,43,44'), true)
    assert.equal(matchesIssues(`${stage}-issue-99.events.jsonl`, '42,43,44'), false)
  })

  test('M-5: el archivo de una corrida de variante pasa por su issue, sin relajar la coincidencia exacta', () => {
    assert.equal(matchesIssues(`${stage}-issue-42-experimento-a.events.jsonl`, '42'), true)
    assert.equal(matchesIssues(`${stage}-issue-42-experimento-a.events.jsonl`, '4'), false)
  })

  test('M-6: sin filtro pasa todo archivo', () => {
    assert.equal(matchesIssues('cualquier-cosa.events.jsonl', ''), true)
  })
})

describe('[N] corte por fecha y descubrimiento con filtros', () => {
  let dir = ''
  let issue10 = ''
  let issue20 = ''

  before(() => {
    dir = join(work, 'logs-n')
    mkdirSync(dir)
    issue10 = touch(dir, 'mefisto-tooling-stage-1-writer-20260826-090000-issue-10.events.jsonl', '2026-08-26T09:00:00Z')
    issue20 = touch(dir, 'mefisto-tooling-stage-1-writer-20260826-100000-issue-20.events.jsonl', '2026-08-26T10:00:00Z')
  })

  test('N-1: el corte rechaza lo anterior, deja pasar lo posterior y sin corte pasa todo', () => {
    assert.equal(isNewerThan(issue10, '9999999999'), false)
    assert.equal(isNewerThan(issue20, '1'), true)
    assert.equal(isNewerThan(issue10, ''), true)
  })

  test('N-2: con el filtro de issues, ignora el archivo mas reciente de otro issue', () => {
    assert.equal(discoverStream(dir, { issues: '10', newerThan: '' }), issue10)
  })

  test('N-3: con un corte posterior a la modificacion, espera', () => {
    assert.equal(discoverStream(dir, { issues: '10', newerThan: '9999999999' }), null)
  })
})

describe('[O] la corrida traducida por el adaptador real', () => {
  test('O-1 a O-3: rinde el conteo de tools, el estado terminal y todas las metricas', () => {
    const translated = translate({
      rawFile: join(HERE, 'fixtures', 'runtime-claude', 'success.jsonl'),
      runtime: 'claude',
      model: 'claude-sonnet-5',
      exitCode: 0,
      stderrFile: '',
    })
    // El runner fija en el terminal el reloj de pared, que el adaptador deja en null.
    const events = translated.map((event) =>
      typeof event === 'object' && event !== null && !Array.isArray(event) && String(event.type).startsWith('run.')
        ? { ...event, duration_ms: 5000 }
        : event,
    )
    const started = {
      v: 1,
      type: 'run.started',
      ts: '2026-09-05T10:00:00Z',
      runtime: 'claude',
      agent: 'mefisto-writer',
      model: 'claude-sonnet-5',
      cwd: '/tmp/w',
    }
    const file = stream('claude.events.jsonl', ...[started, ...events].map((event) => JSON.stringify(event)))
    const { out } = show(file)
    assert.equal(out.split('Read: x').length - 1, 1, 'O-1')
    assert.ok(out.includes('(OK)'), 'O-2')
    assert.ok(out.includes('costo_usd=0.01'), 'O-3')
    assert.ok(!out.includes('n/d'), out)
  })

  test('O-3b: un terminal que solo trae cost_usd conserva su costo', () => {
    const file = stream(
      'legacy-cost.events.jsonl',
      '{"v":1,"type":"run.completed","ts":"2026-09-05T10:00:00Z","status":"success","runtime":"claude","model":"claude-sonnet-5","session_id":null,"duration_ms":100,"tokens":{"input":10,"output":5},"cost_usd":0.02,"turns":1,"denials":null,"ttft_ms":null,"api_duration_ms":80,"error":null}',
    )
    assert.ok(show(file).out.includes('costo_usd=0.02'))
  })

  test('O-4: un costo no resoluble es n/d sin degradar un session_id presente', () => {
    const file = stream(
      'no-cost.events.jsonl',
      '{"v":1,"type":"run.completed","ts":"2026-09-05T10:00:00Z","status":"success","runtime":"fake","model":null,"session_id":"ses_presente","duration_ms":100,"tokens":{"input":10,"output":5,"cache_read":null,"cache_write":null,"reasoning":null},"estimated_cost_usd":null,"turns":null,"denials":null,"ttft_ms":null,"api_duration_ms":null,"error":null}',
    )
    const { out } = show(file)
    assert.ok(out.includes('costo_usd=n/d'))
    assert.ok(out.includes('session_id=ses_presente'))
  })
})

describe('[P] neutralidad del visor', () => {
  const source = readFileSync(SCRIPT, 'utf8')

  test('P-1: no nombra campos de la traza cruda de un runtime ni la ruta legada del estado', () => {
    for (const pattern of [/['"]assistant['"]/, /['"]result['"]/, /tool_use/, /num_turns/, /total_cost_usd/, /\.claude\/pipeline/]) {
      assert.doesNotMatch(source, pattern)
    }
  })

  test('P-2: localiza los archivos con la libreria de estado', () => {
    assert.match(source, /import \{ stateDirs \} from '[./]+\/scripts\/lib\/state\.mts'/)
  })

  test('P-3: sigue el JSONL neutral', () => {
    assert.match(source, /'\.events\.jsonl'/)
  })
})

describe('arranque', () => {
  const none = { filter: NO_FILTER, pinned: '' }

  test('los argumentos: filtros con valor y cualquier otra cosa como ruta, la ultima gana', () => {
    assert.deepEqual(parseArguments(['--issues', '42,43', '--newer-than', '5']), {
      filter: { issues: '42,43', newerThan: '5' },
      pinned: '',
    })
    assert.deepEqual(parseArguments(['a.jsonl', '--help']), { filter: NO_FILTER, pinned: '--help' })
    assert.deepEqual(parseArguments([]), none)
  })

  test('los errores de uso terminan en 2 con su mensaje', () => {
    const cases: [string[], string][] = [
      [['--issues'], 'ERROR: falta el valor de --issues'],
      [['--newer-than'], 'ERROR: falta el valor de --newer-than'],
      [['--newer-than', '12x'], "ERROR: --newer-than debe ser un epoch en segundos (recibido: '12x')"],
    ]
    for (const [argv, message] of cases) {
      assert.throws(
        () => parseArguments(argv),
        (error: unknown) => error instanceof CliError && error.message === message && error.exitCode === 2,
        message,
      )
    }
  })

  test('anuncia la ruta fija', () => {
    assert.equal(
      banner({ filter: NO_FILTER, pinned: 'x.events.jsonl' }, dirs, PLAIN),
      'Mefisto -- visor en vivo del flujo de eventos (issue #434/#878)\nInspeccionando: x.events.jsonl\n\n',
    )
  })

  test('anuncia el descubrimiento, sus filtros y la falta de directorio de logs', () => {
    const sinLogs = { canonical: join(work, 'nada', 'a'), legacy: join(work, 'nada', 'b') }
    mkdirSync(join(dirs.canonical, 'logs'), { recursive: true })
    assert.equal(
      banner(none, dirs, PLAIN),
      'Mefisto -- visor en vivo del flujo de eventos (issue #434/#878)\n' +
        'Descubriendo el archivo de eventos mas reciente...\n\n',
    )
    assert.equal(
      banner({ filter: { issues: '42,43', newerThan: '5' }, pinned: '' }, sinLogs, PLAIN),
      [
        'Mefisto -- visor en vivo del flujo de eventos (issue #434/#878)',
        'Descubriendo el archivo de eventos mas reciente...',
        'Filtro de issues: 42,43',
        'Esperando la traza de esta corrida (el archivo del stage 1 nace cuando arranca',
        'el primer agente, tras crear el worktree y validar el DoR)...',
        'Aviso: todavia no hay ningun directorio de logs del harness resuelto por',
        'mefisto_state_read_paths. Se creara cuando arranque un pipeline (el visor lo',
        'reintenta cada ciclo); si esperabas una corrida en curso, lanza el visor',
        'desde la raiz del repo principal.',
        '',
        '',
      ].join('\n'),
    )
    const esc = '\u001b['
    assert.ok(
      banner(none, sinLogs, ANSI).startsWith(
        `${esc}0;36m${esc}1mMefisto -- visor en vivo del flujo de eventos (issue #434/#878)${esc}0m\n` +
          'Descubriendo el archivo de eventos mas reciente...\n' +
          `${esc}1;33mAviso: todavia no hay ningun directorio de logs del harness resuelto por${esc}0m\n`,
      ),
    )
  })

  test('fuera del repo de Mefisto se niega a correr', () => {
    const outside = join(work, 'consumidor')
    execFileSync('git', ['init', '--quiet', outside])
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: outside, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^ERROR: este pipeline solo se ejecuta dentro del repo de Mefisto\n/)
    assert.equal(result.stdout, '')
  })

  test('una ruta que no existe termina en 1', () => {
    const missing = join(work, 'no-existe.events.jsonl')
    const result = spawnSync(process.execPath, [SCRIPT, missing], { cwd: REPO_ROOT, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stderr, `ERROR: no existe el archivo de eventos indicado: ${missing}\n`)
  })

  test('sigue una ruta fija hasta Ctrl-C y termina en 130', async () => {
    const file = stream(
      'en-vivo.events.jsonl',
      '{"v":1,"type":"run.failed","ts":"2026-09-05T10:05:05Z","status":"failed","runtime":"fake","duration_ms":5000}',
    )
    const child = spawn(process.execPath, [SCRIPT, file], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
    await new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (stdout.includes('Esperando el siguiente archivo...')) resolve()
      })
    })
    child.kill('SIGINT')
    const code = await closed
    assert.ok(stdout.includes(`Inspeccionando: ${file}\n\n\n`), stdout)
    assert.ok(stdout.includes(`=== ${basename(file)} ===`))
    // En Windows `kill` no entrega la senal: termina el proceso sin pasar por el manejador.
    if (process.platform !== 'win32') assert.equal(code, 130)
  })
})
