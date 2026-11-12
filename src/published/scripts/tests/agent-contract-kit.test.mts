import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import {
  agent,
  bodyLines,
  closureAssets,
  generatedMarker,
  inventoriesDestination,
  isRegularFile,
  lowerAscii,
  metadataMatches,
  metadataOf,
  pipelineReferences,
  readInventory,
  readOrEmpty,
  regularFilesUnder,
  sameBytes,
  scanPipelineClosure,
  sha256Of,
} from './agent-contract-kit.mts'

let work = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto kit agentes '))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function write(relative: string, content: string): string {
  const path = join(work, ...relative.split('/'))
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

test('un archivo que falta se lee vacio y no es regular ni igual a otro', () => {
  const present = write('lectura/uno.txt', 'uno\n')
  const missing = join(work, 'lectura', 'no-existe.txt')
  assert.equal(readOrEmpty(present), 'uno\n')
  assert.equal(readOrEmpty(missing), '')
  assert.equal(isRegularFile(present), true)
  assert.equal(isRegularFile(missing), false)
  assert.equal(isRegularFile(join(work, 'lectura')), false)
  assert.equal(sameBytes(present, write('lectura/copia.txt', 'uno\n')), true)
  assert.equal(sameBytes(present, write('lectura/otro.txt', 'uno')), false)
  assert.equal(sameBytes(present, missing), false)
  assert.equal(sameBytes(missing, missing), false)
})

test('sha256Of da el hash del contenido, o vacio si el archivo falta', () => {
  assert.equal(
    sha256Of(write('hash/abc.txt', 'abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
  assert.equal(sha256Of(join(work, 'hash', 'no-existe')), '')
})

test('regularFilesUnder lista archivos con ruta relativa, sin carpetas', () => {
  write('arbol/b.txt', '')
  write('arbol/a/c.txt', '')
  write('arbol/a/d/e.txt', '')
  mkdirSync(join(work, 'arbol', 'vacia'))
  assert.deepEqual(regularFilesUnder(join(work, 'arbol')), ['a/c.txt', 'a/d/e.txt', 'b.txt'])
  assert.deepEqual(regularFilesUnder(join(work, 'no-existe')), [])
})

test('lowerAscii solo cambia las mayusculas ASCII', () => {
  assert.equal(lowerAscii('Claude ÁRBOL .Claude/X'), 'claude Árbol .claude/x')
})

test('bodyLines conserva las lineas vacias del final y no da cuerpo sin cierre', () => {
  assert.deepEqual(bodyLines('---\n{}\n---\n\nuno\n---\ndos\n\n'), ['', 'uno', '---', 'dos', ''])
  assert.deepEqual(bodyLines('---\n{}\n'), [])
  assert.deepEqual(bodyLines(''), [])
})

test('metadataOf lee el frontmatter JSON y da un objeto vacio si no lo es', () => {
  assert.deepEqual(metadataOf('---\n{"id": "x",\n "mode": "all"}\n---\ncuerpo\n'), { id: 'x', mode: 'all' })
  assert.deepEqual(metadataOf('---\nid: x\n---\n'), {})
  assert.deepEqual(metadataOf('---\n["x"]\n---\n'), {})
  assert.deepEqual(metadataOf(''), {})
})

test('metadataMatches compara valores exactos, claves ausentes, claves totales y capacidades', () => {
  const metadata = { id: 'x', capabilities: ['read', 'shell'], skills: ['a', 'b'], mcp: null }
  assert.equal(metadataMatches(metadata, {}), true)
  assert.equal(metadataMatches(metadata, { equal: { id: 'x', skills: ['a', 'b'] } }), true)
  assert.equal(metadataMatches(metadata, { equal: { skills: ['b', 'a'] } }), false)
  assert.equal(metadataMatches(metadata, { equal: { profile: 'deep' } }), false)
  assert.equal(metadataMatches(metadata, { without: ['profile'] }), true)
  // Una clave presente con valor null cuenta como presente.
  assert.equal(metadataMatches(metadata, { without: ['mcp'] }), false)
  assert.equal(metadataMatches(metadata, { keys: ['capabilities', 'id', 'mcp', 'skills'] }), true)
  assert.equal(metadataMatches(metadata, { keys: ['capabilities', 'id', 'skills'] }), false)
  assert.equal(metadataMatches(metadata, { capabilities: ['shell', 'read'] }), true)
  assert.equal(metadataMatches(metadata, { capabilities: ['web'] }), false)
  assert.equal(metadataMatches({ capabilities: 'read' }, { capabilities: ['read'] }), false)
  assert.equal(metadataMatches({}, { capabilities: ['read'] }), false)
})

test('agent resuelve fuente, proyeccion y espejo de un agente publicado', () => {
  const planner = agent('planner')
  assert.equal(planner.sourcePath, 'src/published/agents/planner.md')
  assert.equal(planner.claudePath, 'dist/claude/agents/planner.md')
  assert.equal(planner.mirrorPath, 'agents/planner.md')
  assert.equal(planner.metadata.id, 'planner')
  assert.ok(planner.source.startsWith('---\n'))
  assert.ok(planner.source.endsWith(`${planner.body}\n`))
  assert.ok(!planner.body.startsWith('---'))
  assert.ok(planner.mirror.includes(generatedMarker('planner')))

  const missing = agent('agente-que-no-existe')
  assert.deepEqual(
    [missing.source, missing.claude, missing.mirror, missing.body, missing.metadata],
    ['', '', '', '', {}],
  )
})

test('readInventory lee los assets y tolera un inventario ausente o ilegible', () => {
  const inventory = readInventory(
    write('inventario/ok.json', '{"schemaVersion":1,"assets":[{"destination":"agents/x.md"}]}'),
  )
  assert.equal(inventory.schemaVersion, 1)
  assert.equal(inventoriesDestination(inventory, 'agents/x.md'), true)
  assert.equal(inventoriesDestination(inventory, 'agents/y.md'), false)
  assert.deepEqual(readInventory(write('inventario/sin-assets.json', '{"schemaVersion":1}')).assets, [])
  assert.deepEqual(readInventory(write('inventario/roto.json', 'no es json')), { assets: [] })
  assert.deepEqual(readInventory(write('inventario/null.json', 'null')), { assets: [] })
  assert.deepEqual(readInventory(join(work, 'inventario', 'no-existe.json')), { assets: [] })
  assert.ok(readInventory().assets.length > 0)
})

test('closureAssets separa ruta y modo y descarta lo que no es `ruta|modo`', () => {
  assert.deepEqual(closureAssets(['scripts/a.sh|0755', 'scripts/lib/b.mts|0644', 'scripts/c.sh|0600', 'x']), [
    { source: 'scripts/a.sh', mode: '0755' },
    { source: 'scripts/lib/b.mts', mode: '0644' },
  ])
  const real = closureAssets()
  assert.ok(real.length > 0)
  assert.ok(real.every((asset) => asset.source.length > 0 && /^0(644|755)$/.test(asset.mode)))
})

const PIPELINE = [
  '#!/usr/bin/env bash',
  'source "$(dirname "${BASH_SOURCE[0]}")/_pipeline-common.sh"',
  "source '$(dirname \"$0\")'/lib/otro.sh",
  '# source "$(dirname "$0")/comentado.sh"',
  '    # "$SCRIPT_DIR/tambien-comentado.sh"',
  'source "$SCRIPT_DIR/sin-dirname.sh"',
  '  "${SCRIPT_DIR}/../scripts/run-tests.sh" && jq -f "$RUNTIME_LIB_DIR/runtime-claude.jq"',
  'bash "$RUNTIME_DIR/lib/../mefisto-process.sh" "$SCRIPT_DIR/datos.json"',
  'echo "$OTRO_DIR/ajeno.sh" "$(dirname "$0")/sin-source.sh"',
  '',
].join('\n')

test('pipelineReferences reconoce los source con dirname y las rutas bajo las tres bases', () => {
  assert.deepEqual(pipelineReferences(PIPELINE), [
    'scripts/_pipeline-common.sh',
    'scripts/lib/otro.sh',
    'scripts/run-tests.sh',
    'scripts/sin-dirname.sh',
    'src/runtime/lib/runtime-claude.jq',
    'src/runtime/mefisto-process.sh',
  ])
  assert.deepEqual(pipelineReferences(''), [])
})

test('scanPipelineClosure exige que cada referencia este declarada y un minimo de cuatro', () => {
  const herdr = scanPipelineClosure('scripts/herdr-pipeline.sh')
  assert.equal(herdr.problem, '')
  assert.ok(herdr.references >= 4)

  const undeclared = scanPipelineClosure('scripts/herdr-pipeline.sh', ['scripts/_pipeline-common.sh|0644'])
  assert.equal(undeclared.references, herdr.references)
  assert.notEqual(undeclared.problem, '')
  assert.ok(!undeclared.problem.split('\n').includes('scripts/_pipeline-common.sh'))

  assert.deepEqual(scanPipelineClosure('scripts/no-existe.sh'), {
    references: 0,
    problem: 'el barrido solo reconocio 0 dependencias; se esperaban al menos 4',
  })
})
