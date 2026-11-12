import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CliError } from '../lib/cli.mts'
import { parseJq } from '../lib/jq-literals.mts'
import { JqError } from '../lib/jq-values.mts'
import type { StateDirs } from '../lib/state.mts'
import { PLAIN } from '../lib/stream-watch.mts'
import type { DiscoveryFilter } from '../lib/stream-watch.mts'
import {
  StreamViewer,
  USAGE,
  discoverStream,
  legacyRows,
  matchesIssues,
  neutralRows,
  parseArguments,
  runMetadata,
  streamFormat,
  streamHeader,
} from '../stream-watch.mts'
import { isolateGitConfig } from './field-note-sandbox.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SCRIPT = join(HERE, '..', 'stream-watch.mts')
const FIXTURES = join(HERE, 'fixtures', 'stream-watch')
const NO_FILTER: DiscoveryFilter = { issues: '', newerThan: '' }

let work = ''
let consumer = ''
let dirs: StateDirs = { canonical: '', legacy: '' }
let canonicalLogs = ''
let legacyLogs = ''
let restoreGit = (): void => {}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'stream-watch-'))
  restoreGit = isolateGitConfig(work)
  consumer = join(work, 'consumidor')
  execFileSync('git', ['init', '--quiet', consumer])
  const root = join(work, 'consumidor con espacios')
  dirs = { canonical: join(root, '.mefisto', 'pipeline'), legacy: join(root, '.claude', 'pipeline') }
  canonicalLogs = join(dirs.canonical, 'logs')
  legacyLogs = join(dirs.legacy, 'logs')
  mkdirSync(canonicalLogs, { recursive: true })
  mkdirSync(legacyLogs, { recursive: true })
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true })
})

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

function setMtime(file: string, isoTime: string): void {
  const time = new Date(isoTime)
  utimesSync(file, time, time)
}

interface Session {
  viewer: StreamViewer
  output: () => string
  /** Lo que el visor escribio desde la ultima vez que se pidio. */
  take: () => string
}

function session(filter: DiscoveryFilter = NO_FILTER): Session {
  let text = ''
  let taken = 0
  const viewer = new StreamViewer({ dirs, filter, colors: PLAIN, write: (chunk) => (text += chunk) })
  return {
    viewer,
    output: () => text,
    take: () => {
      const fresh = text.slice(taken)
      taken = text.length
      return fresh
    },
  }
}

function render(file: string): Session {
  const current = session()
  current.viewer.activate(file)
  current.viewer.processNewLines()
  return current
}

function rows(filter: (event: ReturnType<typeof parseJq>) => string[][], json: string): string[][] {
  return filter(parseJq(json))
}

describe('invocacion directa', () => {
  test('--help muestra el uso y termina en 0', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--help'], { cwd: consumer, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `${USAGE}\n`)
    assert.match(result.stdout, /^Uso: stream-watch\.mts /)
  })

  test('fuera de un repo git falla antes de mirar los argumentos', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--help'], { cwd: work, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'ERROR: no estas en un repositorio git\n')
    assert.equal(result.stdout, '')
  })

  test('dentro del repo del plugin se niega a correr', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      'ERROR: scripts/stream-watch.mts es del plugin publicado y solo aplica al consumidor.\n',
    )
  })

  test('una ruta manual que no existe o no es un stream conocido termina en 1', () => {
    const missing = join(work, 'no-existe.events.jsonl')
    const unknown = join(work, 'desconocido.jsonl')
    writeFileSync(unknown, '{}\n')
    for (const [file, message] of [
      [missing, `ERROR: no existe el stream indicado: ${missing}\n`],
      [unknown, `ERROR: la ruta manual no es *.events.jsonl ni *.stream.jsonl: ${unknown}\n`],
    ] as const) {
      const result = spawnSync(process.execPath, [SCRIPT, file], { cwd: consumer, encoding: 'utf8' })
      assert.equal(result.status, 1)
      assert.equal(result.stderr, message)
    }
  })

  test('sigue una ruta manual hasta Ctrl-C y termina en 130', async () => {
    const file = join(work, 'en-vivo-issue-7.events.jsonl')
    writeFileSync(file, fixture('neutral-claude.events.jsonl'))
    const child = spawn(process.execPath, [SCRIPT, file], { cwd: consumer, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
    await new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (stdout.includes('desenlace run.completed')) resolve()
      })
    })
    child.kill('SIGINT')
    const code = await closed
    assert.match(stdout, /^\u001b\[0;36m\u001b\[1mMefisto -- visor run-events\.v1\u001b\[0m\n/)
    assert.ok(stdout.includes(`estado: manual | ruta: ${file}`))
    // En Windows `kill` no entrega la senal: termina el proceso sin pasar por el manejador.
    if (process.platform !== 'win32') assert.equal(code, 130)
  })
})

describe('argumentos', () => {
  test('acepta una ruta y los dos filtros en cualquier orden', () => {
    assert.deepEqual(parseArguments(['--issues', '42,43', 'a.events.jsonl', '--newer-than', '1788861600']), {
      filter: { issues: '42,43', newerThan: '1788861600' },
      pinned: 'a.events.jsonl',
    })
    assert.deepEqual(parseArguments([]), { filter: NO_FILTER, pinned: '' })
  })

  test('--help y -h piden la ayuda', () => {
    assert.equal(parseArguments(['--help']), null)
    assert.equal(parseArguments(['a.events.jsonl', '-h']), null)
  })

  test('los errores de uso terminan en 2 con su mensaje', () => {
    const cases: [string[], string][] = [
      [['--issues'], 'ERROR: falta el valor de --issues'],
      [['--newer-than'], 'ERROR: falta el valor de --newer-than'],
      [['--newer-than', '12x'], 'ERROR: --newer-than debe ser un epoch en segundos'],
      [['--newer-than', ''], 'ERROR: --newer-than debe ser un epoch en segundos'],
      [['--bogus'], 'ERROR: opcion desconocida: --bogus'],
      [['a.events.jsonl', 'b.events.jsonl'], 'ERROR: solo se admite una ruta manual'],
    ]
    for (const [argv, message] of cases) {
      assert.throws(
        () => parseArguments(argv),
        (error: unknown) => error instanceof CliError && error.message === message && error.exitCode === 2,
        message,
      )
    }
  })
})

describe('[A] protocolo neutral y redaccion', () => {
  test('renderiza la corrida sin filtrar payloads a la terminal', () => {
    const file = join(canonicalLogs, 'tooling-stage-1-writer-20260908-100000-issue-1123.events.jsonl')
    writeFileSync(file, fixture('neutral-claude.events.jsonl') + fixture('neutral-sensitive-unknown.events.jsonl'))
    const { viewer, output } = render(file)
    const out = output()
    assert.ok(
      out.includes('neutral | issue #1123 | stage 1 | runtime claude | agente writer | modelo modelo-claude'),
      'encabezado neutral completo',
    )
    assert.ok(out.includes(`estado: canonico | ruta: ${file}`), 'estado canonico')
    assert.ok(out.includes('mensaje (text)'), 'tipo de mensaje sin su texto')
    assert.ok(out.includes('herramienta Bash iniciada'), 'tool.started sin input')
    assert.ok(out.includes('herramienta Bash: ok (1.0s)'), 'tool.completed')
    assert.ok(
      out.includes(
        'desenlace run.completed | resultado=success | runtime=claude | agente=writer | modelo=modelo-claude | duracion=4.0s',
      ),
      'el unico terminal',
    )
    // La ruta del stream va en el encabezado; la redaccion se juzga sobre las filas.
    const body = out.split('\n').slice(2).join('\n')
    for (const secret of [
      'SECRETO-no-mostrar',
      'input_summary',
      'prompt',
      'Authorization',
      'Bearer',
      'tokens',
      'headers',
      'cwd',
      '/tmp',
    ]) {
      assert.ok(!body.includes(secret), `no filtra al pane: ${secret}`)
    }
    assert.equal(viewer.terminals, 1)
  })

  test('las filas llevan hora, delta desde la anterior y los colores del visor', () => {
    const file = join(work, 'colores.events.jsonl')
    writeFileSync(
      file,
      [
        '{"v":1,"type":"tool.started","ts":"2026-09-08T10:00:02Z","tool":"Bash","input_summary":"x"}',
        '{"v":1,"type":"tool.completed","ts":"2026-09-08T10:00:03.250Z","tool":"Bash","ok":false,"duration_ms":null}',
        '',
      ].join('\n'),
    )
    let out = ''
    const viewer = new StreamViewer({ dirs, write: (chunk) => (out += chunk) })
    viewer.activate(file)
    viewer.processNewLines()
    const clock = (iso: string): string => {
      const date = new Date(iso)
      return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
    }
    const esc = '\u001b['
    assert.equal(
      out,
      `${esc}0;36m${esc}1m=== neutral ===${esc}0m\n` +
        `${esc}0;36mestado: manual | ruta: ${file}${esc}0m\n` +
        `${esc}0;34m[${clock('2026-09-08T10:00:02Z')}]${esc}0m       -  herramienta ${esc}1mBash${esc}0m iniciada\n` +
        `${esc}0;34m[${clock('2026-09-08T10:00:03Z')}]${esc}0m +  1.2s  herramienta ${esc}1mBash${esc}0m: fallo (?s)\n`,
    )
  })

  test('un terminal fallido de otro runtime no aparenta exito ni muestra el detalle', () => {
    const file = join(canonicalLogs, 'tooling-stage-2-reviewer-20260908-110000-issue-1124.events.jsonl')
    writeFileSync(file, fixture('neutral-failed.events.jsonl'))
    const out = render(file).output()
    assert.ok(out.includes('runtime fake | agente reviewer'), 'encabezado neutral de otro runtime')
    assert.ok(out.includes('resultado=failed'))
    assert.ok(out.includes('La corrida no termino con exito'))
    assert.ok(!out.includes('SECRETO-no-mostrar'), 'omite error.detail')
  })

  test('un exito con error posterior lo anuncia como incidente', () => {
    const file = join(work, 'incidente.events.jsonl')
    writeFileSync(
      file,
      '{"v":1,"type":"run.completed","ts":"2026-09-08T10:00:04Z","status":"success","runtime":"claude","model":"m","duration_ms":250,"error":{"kind":"killed","detail":"x"}}\n',
    )
    const out = render(file).output()
    assert.ok(out.includes('runtime=claude | agente=- | modelo=m | duracion=0.2s'))
    assert.ok(out.includes('Incidente posterior al exito: killed.'))
    assert.ok(!out.includes('no termino con exito'))
  })

  test('el terminal completa runtime y modelo con los del run.started', () => {
    const file = join(work, 'heredado.events.jsonl')
    writeFileSync(
      file,
      [
        '{"v":1,"type":"run.started","ts":"2026-09-08T10:00:00Z","runtime":"fake","agent":"writer","model":"m1","cwd":"/x"}',
        '{"v":1,"type":"run.failed","ts":"2026-09-08T10:00:04Z","status":"failed","runtime":null,"model":null,"duration_ms":null}',
        '',
      ].join('\n'),
    )
    assert.ok(
      render(file)
        .output()
        .includes('desenlace run.failed | resultado=failed | runtime=fake | agente=writer | modelo=m1 | duracion=?s'),
    )
  })
})

describe('filtros de eventos', () => {
  test('el neutral solo nombra campos seguros y descarta lo que no conoce', () => {
    assert.deepEqual(rows(neutralRows, '{"type":"message","ts":"2026-09-08T10:00:01.5Z","text":"x","kind":"thinking"}'), [
      ['message', '1788861601500', 'thinking'],
    ])
    assert.deepEqual(rows(neutralRows, '{"type":"message","text":"x"}'), [['message', '-', 'text']])
    assert.deepEqual(rows(neutralRows, '{"type":"tool.completed","ts":null,"tool":"T","ok":true,"duration_ms":1500.50}'), [
      ['tool-completed', '-', 'T', 'true', '1500.50'],
    ])
    assert.deepEqual(rows(neutralRows, '{"type":"future.event","prompt":"x"}'), [])
    assert.deepEqual(rows(neutralRows, '"suelto"'), [])
    assert.deepEqual(rows(neutralRows, '[1,2]'), [])
  })

  test('un ts que no es una fecha del contrato se trata como ausente', () => {
    for (const ts of ['"2026-09-08T10:00:00+00:00"', '"2026-13-08T10:00:00Z"', '17', 'null']) {
      assert.deepEqual(rows(neutralRows, `{"type":"tool.started","ts":${ts},"tool":"T"}`), [['tool-started', '-', 'T']])
    }
  })

  test('el neutral falla, como el filtro de jq, si `error` no es un objeto', () => {
    assert.throws(() => rows(neutralRows, '{"type":"run.completed","error":"cadena"}'), JqError)
  })

  test('el legado rinde una fila por bloque del mensaje y otra por el cierre', () => {
    const assistant =
      '{"type":"assistant","timestamp":"2026-09-08T10:00:00Z","message":{"content":[{"type":"text","text":"hola"},{"type":"thinking"},{"type":"tool_use","name":"Read"},{"type":"tool_use"},{"type":"otro"},null]}}'
    assert.deepEqual(rows(legacyRows, assistant), [
      ['legacy-message', '1788861600000', 'texto'],
      ['legacy-message', '1788861600000', 'pensamiento'],
      ['legacy-tool', '1788861600000', 'Read'],
      ['legacy-tool', '1788861600000', '-'],
    ])
    assert.deepEqual(rows(legacyRows, '{"type":"result","is_error":false,"duration_ms":1000,"num_turns":1}'), [
      ['legacy-terminal', '-', 'false', '1000', '1'],
    ])
    assert.deepEqual(rows(legacyRows, '{"type":"assistant","message":{"content":"cadena"}}'), [])
    assert.deepEqual(rows(legacyRows, '{"type":"assistant"}'), [])
    assert.deepEqual(rows(legacyRows, '{"type":"system"}'), [])
    assert.deepEqual(rows(legacyRows, '[1]'), [])
  })

  test('el legado falla si el mensaje o uno de sus bloques no es un objeto', () => {
    assert.throws(() => rows(legacyRows, '{"type":"assistant","message":"cadena"}'), JqError)
    assert.throws(() => rows(legacyRows, '{"type":"assistant","message":{"content":[{"type":"text"},"suelto"]}}'), JqError)
  })
})

describe('[B] parciales, corrupcion, truncado y cardinalidad', () => {
  test('una linea parcial no avanza el cursor y se consume cuando se completa', () => {
    const file = join(work, 'partial.events.jsonl')
    writeFileSync(file, '{"v":1,"type":"message"')
    const { viewer, take } = session()
    viewer.processNewLines(file)
    assert.equal(viewer.cursor.lines, 0, 'la parcial no avanza el cursor')
    assert.equal(take(), 'Aviso: linea parcial; se reintentara.\n')
    appendFileSync(file, ',"ts":"2026-09-08T10:00:00Z","role":"assistant","text":"oculto"}\n')
    viewer.processNewLines(file)
    assert.equal(viewer.cursor.lines, 1, 'la linea reparada se consume')
    assert.match(take(), /mensaje \(text\)\n$/)
  })

  test('una linea valida sin su salto se consume de una vez', () => {
    const file = join(work, 'sin-salto.events.jsonl')
    writeFileSync(file, '{"v":1,"type":"message","ts":"2026-09-08T10:00:00Z","text":"x"}')
    const { viewer, take } = session()
    viewer.processNewLines(file)
    assert.equal(viewer.cursor.lines, 1)
    assert.match(take(), /mensaje \(text\)\n$/)
    viewer.processNewLines(file)
    assert.equal(take(), '')
  })

  test('una linea corrupta ya cerrada se omite con aviso y no desactiva la redaccion', () => {
    const file = join(work, 'corrupt.events.jsonl')
    writeFileSync(
      file,
      '{corrupta}\n{"v":1,"type":"message","ts":"2026-09-08T10:00:00Z","role":"assistant","text":"SECRETO-no-mostrar"}\n',
    )
    const { viewer, output } = session()
    viewer.processNewLines(file)
    assert.equal(viewer.cursor.lines, 2, 'omite la corrupta y continua')
    assert.ok(output().includes('linea corrupta omitida'))
    assert.ok(!output().includes('SECRETO-no-mostrar'))
  })

  test('un evento que el filtro no puede leer se omite con su propio aviso', () => {
    const file = join(work, 'no-renderizable.events.jsonl')
    writeFileSync(file, '{"v":1,"type":"run.completed","status":"success","error":"cadena"}\n')
    const { viewer, output } = session()
    viewer.processNewLines(file)
    assert.equal(viewer.cursor.lines, 1)
    assert.equal(output(), 'Aviso: evento no renderizable omitido.\n')
    assert.equal(viewer.terminals, 0)
  })

  test('un stream sin terminal degrada visiblemente y no aparenta exito', () => {
    const file = join(work, 'truncated.events.jsonl')
    writeFileSync(
      file,
      '{"v":1,"type":"run.started","ts":"2026-09-08T10:00:00Z","runtime":"claude","agent":"writer","model":null,"cwd":"/tmp"}\n',
    )
    const { viewer, take } = render(file)
    take()
    viewer.finishCurrent()
    const out = take()
    assert.ok(out.includes('quedo truncado'))
    assert.ok(!out.includes('exito'))
  })

  test('solo renderiza un terminal y denuncia el duplicado', () => {
    const file = join(work, 'duplicate.events.jsonl')
    const neutral = fixture('neutral-claude.events.jsonl')
    const last = neutral.trimEnd().split('\n').at(-1) ?? ''
    writeFileSync(file, `${neutral}${last}\n`)
    const { viewer, output, take } = render(file)
    assert.equal(output().split('desenlace run.completed').length - 1, 1)
    assert.ok(output().includes('mas de un terminal'))
    take()
    viewer.finishCurrent()
    assert.equal(take(), 'Aviso: el stream anterior es invalido: declaro 2 terminales.\n')
  })
})

describe('[C] descubrimiento, roots, preferencia, filtros y rotacion', () => {
  const logDirs = (): string[] => [canonicalLogs, legacyLogs]
  let legacyNew = ''
  let pairStem = ''

  before(() => {
    for (const dir of [canonicalLogs, legacyLogs]) {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
    }
    legacyNew = join(legacyLogs, 'iac-stage-9-reviewer-20260908-120000-issue-1125.stream.jsonl')
    pairStem = join(legacyLogs, 'tooling-stage-3-writer-20260908-130000-issue-1126')
  })

  test('consulta el root canonico antes que el legacy, aunque este sea mas reciente', () => {
    const canonical = join(canonicalLogs, 'tooling-stage-1-writer-20260908-100000-issue-1123.events.jsonl')
    writeFileSync(canonical, fixture('neutral-claude.events.jsonl'))
    copyFileSync(join(FIXTURES, 'legacy-claude.stream.jsonl'), legacyNew)
    setMtime(legacyNew, '2026-09-08T12:00:00Z')
    setMtime(canonical, '2026-09-08T10:00:00Z')
    assert.equal(discoverStream(logDirs(), NO_FILTER), canonical)
    const { viewer, output } = session()
    viewer.step()
    assert.equal(viewer.current, canonical)
    assert.ok(output().includes(`estado: canonico | ruta: ${canonical}`))
    rmSync(canonical)
  })

  test('sin canonico, el neutral gana al stream de Claude del mismo stem', () => {
    copyFileSync(join(FIXTURES, 'legacy-claude.stream.jsonl'), `${pairStem}.stream.jsonl`)
    copyFileSync(join(FIXTURES, 'neutral-claude.events.jsonl'), `${pairStem}.events.jsonl`)
    assert.equal(discoverStream(logDirs(), NO_FILTER), `${pairStem}.events.jsonl`)
  })

  test('un stream de Claude con par neutral no se elige ni cuando el filtro deja fuera al par', () => {
    setMtime(`${pairStem}.events.jsonl`, '2026-09-08T09:00:00Z')
    setMtime(`${pairStem}.stream.jsonl`, '2026-09-08T13:00:00Z')
    const cutoff = String(Date.parse('2026-09-08T12:30:00Z') / 1000)
    assert.equal(discoverStream(logDirs(), { issues: '', newerThan: cutoff }), null)
  })

  test('sin su par neutral, el stream historico es el fallback y queda rotulado', () => {
    rmSync(`${pairStem}.events.jsonl`)
    setMtime(`${pairStem}.stream.jsonl`, '2026-09-08T13:00:00Z')
    const found = discoverStream(logDirs(), NO_FILTER)
    assert.equal(found, `${pairStem}.stream.jsonl`)
    const out = render(found ?? '').output()
    assert.ok(out.includes('=== legacy-claude | issue #1126 | stage 3 ==='))
    assert.ok(out.includes(`estado: legacy | ruta: ${pairStem}.stream.jsonl`))
    assert.ok(out.includes('[legacy Claude]'))
    assert.ok(out.includes('herramienta Read'))
    assert.ok(out.includes('[legacy Claude] cierre: OK duracion=1.0s turnos=1'))
    assert.ok(!out.includes('SECRETO-no-mostrar'))
  })

  test('--issues selecciona la coincidencia exacta', () => {
    assert.equal(discoverStream(logDirs(), { issues: '1125', newerThan: '' }), legacyNew)
    assert.equal(matchesIssues('stage-1-a-issue-1123.events.jsonl', '1123'), true)
    assert.equal(matchesIssues('stage-1-a-issue-11230.events.jsonl', '1123'), false)
  })

  test('matchesIssues cubre los dos formatos y las variantes, no las copias de reintento', () => {
    assert.equal(matchesIssues('s-issue-42.stream.jsonl', '42'), true)
    assert.equal(matchesIssues('s-issue-42-variante.events.jsonl', '42'), true)
    assert.equal(matchesIssues('s-issue-42-variante.stream.jsonl', '41,42'), true)
    assert.equal(matchesIssues('s-issue-42.attempt-2.events.jsonl', '42'), false)
    assert.equal(matchesIssues('s-issue-42.events.jsonl', '4'), false)
    assert.equal(matchesIssues('cualquier-cosa.events.jsonl', ''), true)
  })

  test('--newer-than excluye las corridas viejas', () => {
    assert.equal(discoverStream(logDirs(), { issues: '', newerThan: '9999999999' }), null)
    const { viewer, output } = session({ issues: '', newerThan: '9999999999' })
    viewer.step()
    assert.equal(viewer.current, '')
    assert.equal(output(), '')
  })

  test('un directorio de logs que aun no existe no impide descubrir en el otro', () => {
    const only = { canonical: join(work, 'sin-estado', '.mefisto', 'pipeline'), legacy: dirs.legacy }
    const viewer = new StreamViewer({ dirs: only, colors: PLAIN, write: () => {} })
    assert.deepEqual(viewer.logDirs(), [legacyLogs])
    viewer.step()
    assert.equal(viewer.current, `${pairStem}.stream.jsonl`)
  })

  test('la rotacion denuncia el stream anterior sin terminal y resetea cursor y formato', () => {
    const truncated = join(work, 'rotacion.events.jsonl')
    writeFileSync(
      truncated,
      '{"v":1,"type":"run.started","ts":"2026-09-08T10:00:00Z","runtime":"claude","agent":"writer","model":null,"cwd":"/tmp"}\n',
    )
    const { viewer, take } = render(truncated)
    assert.equal(viewer.cursor.lines, 1)
    assert.deepEqual(viewer.run, { runtime: 'claude', agent: 'writer', model: '-' })
    take()
    viewer.activate(`${pairStem}.stream.jsonl`)
    assert.ok(take().startsWith('Aviso: el stream anterior quedo truncado: no declaro terminal.\n=== legacy-claude'))
    assert.equal(viewer.cursor.lines, 0)
    assert.equal(viewer.format, 'legacy-claude')
    assert.deepEqual(viewer.run, { runtime: '', agent: '', model: '' })
    viewer.activate(`${pairStem}.stream.jsonl`)
    assert.equal(take(), '', 'reactivar el mismo stream no hace nada')
  })
})

describe('[D] ruta manual, paths con espacios y solo lectura', () => {
  test('una ruta manual con espacios se muestra en el encabezado y no se modifica', () => {
    const file = join(work, 'ruta manual con espacios.events.jsonl')
    copyFileSync(join(FIXTURES, 'neutral-failed.events.jsonl'), file)
    const before = readFileSync(file)
    const out = render(file).output()
    assert.ok(readFileSync(file).equals(before), 'la ruta manual no modifica el stream')
    assert.ok(out.includes(`estado: manual | ruta: ${file}`))
  })

  test('la ruta manual se restringe a los formatos conocidos', () => {
    assert.equal(streamFormat(join(work, 'a.events.jsonl')), 'neutral')
    assert.equal(streamFormat(join(work, 'a.stream.jsonl')), 'legacy-claude')
    assert.equal(streamFormat(join(work, 'desconocido.jsonl')), null)
    const { viewer } = session()
    assert.throws(
      () => viewer.activate(join(work, 'desconocido.jsonl')),
      (error: unknown) => error instanceof CliError && error.exitCode === 1,
    )
  })
})

describe('encabezado', () => {
  const run = { runtime: 'claude', agent: '-', model: 'null' }

  test('toma stage e issue de la ultima aparicion en el nombre y omite lo que falta', () => {
    const file = join(work, 'stage-1-x-stage-23-issue-4-issue-56.events.jsonl')
    assert.equal(
      streamHeader(file, 'neutral', run, dirs, PLAIN),
      `=== neutral | issue #56 | stage 23 | runtime claude ===\nestado: manual | ruta: ${file}\n`,
    )
  })

  test('runMetadata lee el primer run.started y degrada si el archivo no es JSONL completo', () => {
    const complete = join(work, 'metadata.events.jsonl')
    writeFileSync(
      complete,
      '"suelto"\n{"type":"run.started","runtime":"fake","agent":"","model":null}\n{"type":"run.started","runtime":"otro"}\n',
    )
    assert.deepEqual(runMetadata(complete), { runtime: 'fake', agent: '-', model: '-' })
    appendFileSync(complete, '{"type":"mess')
    assert.deepEqual(runMetadata(complete), { runtime: '-', agent: '-', model: '-' })
    assert.deepEqual(runMetadata(join(work, 'no-existe.events.jsonl')), { runtime: '-', agent: '-', model: '-' })
  })
})
