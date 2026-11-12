import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { capture } from '../lib/cli.mts'

// metrics-report viaja en la clausura publicada (MEF-ADR-0053): dist/claude lo trae identico y
// corre sin depender de nada fuera de dist.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = join(REPO_ROOT, 'dist', 'claude')
const CLOSURE = ['scripts/metrics-report.mts', 'scripts/metrics-report.mts', 'scripts/lib/metrics-report.mts', 'scripts/lib/jq-values.mts']

// Dos runtimes; la fila del segundo trae tokens y costo en null.
const HISTORY = `{"issue":"1","pipeline":"tdd","started":"20260901-090000","state":"completed","runtime":"claude","agents":{"implementer":{"duration":60,"metrics":{"turns":5,"duration_ms":60000,"duration_api_ms":50000,"non_api_ms":10000,"cost_usd":0.5,"tokens":{"input":100,"output":50},"model":"opus","tool_calls":[{"name":"Read","count":2}]}}}}
{"issue":"2","pipeline":"tdd","started":"20260902-090000","state":"completed","runtime":"fake","agents":{"implementer":{"duration":70,"metrics":{"turns":6,"duration_ms":70000,"duration_api_ms":60000,"non_api_ms":10000,"cost_usd":null,"tokens":null,"model":"modelo-abierto","tool_calls":[{"name":"read","count":3}]}}}}
`

let work = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto metricas dist '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

test('dist/claude trae el reporte identico al fuente y registrado en el inventario', () => {
  const inventory = JSON.parse(readFileSync(join(DIST, '.mefisto-generated-assets.json'), 'utf8')) as {
    assets: { destination: string }[]
  }
  const registered = new Set(inventory.assets.map((asset) => asset.destination))
  for (const file of CLOSURE) {
    assert.deepEqual(readFileSync(join(DIST, file)), readFileSync(join(REPO_ROOT, file)), file)
    assert.ok(registered.has(file), `${file} falta en el inventario`)
  }
})

test('el reporte de dist corre sobre un repo temporal', () => {
  const consumer = join(work, 'consumer')
  mkdirSync(join(consumer, '.claude', 'pipeline'), { recursive: true })
  assert.equal(capture('git', ['-C', consumer, 'init', '-q']).status, 0)
  writeFileSync(join(consumer, '.claude', 'pipeline', 'pipeline-history.jsonl'), HISTORY)

  const { status, stdout, stderr } = capture(process.execPath, [join(DIST, 'scripts', 'metrics-report.mts')], { cwd: consumer })
  assert.equal(status, 0, stderr)
  assert.match(stdout, /Corridas totales en la ventana: 2$/m)
  assert.match(stdout, /tdd .*2 corridas \(instrumentadas: 2/)
  // El reporte no tiene eje "runtime": cada fila se distingue por su modelo declarado.
  assert.match(stdout, /^implementer +- +opus /m)
  assert.match(stdout, /^implementer +- +modelo-abierto /m)
})
