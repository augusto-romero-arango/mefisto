// Contrato de ruta del token de proyecciones (#1500): `projections.enabled` sale del config
// efectivo, y ni el comando ni el agente leen el legacy por su cuenta.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'

import { resolveHarnessConfigPath } from '../lib/harness-config.mts'
import { matchingLines, readRepoFile } from './text-contract.mts'

const COMMAND = readRepoFile('commands/scaffold-projections.md')
const AGENT = readRepoFile('agents/projections-scaffolder.md')

let work = ''

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto scaffold-projections ')))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

const canonicalOf = (root: string): string => join(root, '.mefisto', 'harness.config.json')
const legacyOf = (root: string): string => join(root, '.claude', 'harness.config.json')

function writeConfig(path: string, enabled: boolean): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `{"projections":{"enabled":${enabled}}}\n`)
}

function resolve(root: string): { path: string; warnings: string[] } {
  const warnings: string[] = []
  const path = resolveHarnessConfigPath('read', root, { warn: (message) => warnings.push(message) })
  return { path, warnings }
}

function projectionsEnabled(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')).projections.enabled
}

function root(name: string, canonical: boolean | null, legacy: boolean | null): string {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  if (canonical !== null) writeConfig(canonicalOf(dir), canonical)
  if (legacy !== null) writeConfig(legacyOf(dir), legacy)
  return dir
}

test('canonico resuelve la ruta efectiva', () => {
  const dir = root('canonical', true, null)
  assert.equal(resolve(dir).path, canonicalOf(dir), `canonico no resolvio '${canonicalOf(dir)}'`)
})

test('canonico habilita projections.enabled', () => {
  const dir = root('canonical', true, null)
  assert.equal(projectionsEnabled(resolve(dir).path), true, 'canonico no entrega projections.enabled=true')
})

test('ambos resuelve la ruta efectiva', () => {
  const dir = root('both', true, false)
  assert.equal(resolve(dir).path, canonicalOf(dir), `ambos no resolvio '${canonicalOf(dir)}'`)
})

test('ambos usa solo el canonico y anuncia la divergencia', () => {
  const dir = root('both', true, false)
  const { path, warnings } = resolve(dir)
  assert.ok(
    projectionsEnabled(path) === true &&
      warnings
        .join('\n')
        .includes(
          `AVISO: se usara el config canonico ${canonicalOf(dir)}; se ignora el legacy ${legacyOf(dir)}. Migra o elimina conscientemente el archivo legacy para evitar divergencias.`,
        ),
    'ambos no preserva la precedencia o el AVISO',
  )
})

test('legacy resuelve la ruta efectiva', () => {
  const dir = root('legacy', null, true)
  assert.equal(resolve(dir).path, legacyOf(dir), `legacy no resolvio '${legacyOf(dir)}'`)
})

test('legacy habilita projections.enabled mediante fallback', () => {
  const dir = root('legacy', null, true)
  assert.equal(projectionsEnabled(resolve(dir).path), true, 'legacy no entrega projections.enabled=true')
})

test('ausencia aborta y explica contrato canonico y fallback', () => {
  const dir = root('missing', null, null)
  assert.throws(
    () => resolve(dir),
    (error: Error) =>
      error.message.includes(`config canonico requerido ${canonicalOf(dir)}`) &&
      error.message.includes(`fallback legacy ${legacyOf(dir)}`),
    'ausencia debe abortar y explicar el contrato y fallback',
  )
})

const DIRECT_LEGACY_READ =
  /(^|[;&|\s])(jq|cat)\s.*\.claude\/harness\.config\.json|<\s*\S*\.claude\/harness\.config\.json/

for (const [name, text, isCommand] of [
  ['scaffold-projections.md', COMMAND, true],
  ['projections-scaffolder.md', AGENT, false],
] as const) {
  test(`${name} resuelve canonico, fallback y AVISO mediante el preludio renderizado de config-path`, () => {
    assert.ok(
      text.includes('MEFISTO_CONFIG_PATH=".mefisto/harness.config.json"') &&
        text.includes('MEFISTO_CONFIG_PATH=".claude/harness.config.json"') &&
        text.includes(
          'AVISO: se usara el config canonico .mefisto/harness.config.json; se ignora el legacy .claude/harness.config.json.',
        ),
      `${name} no contiene el resolver requerido`,
    )
  })

  if (isCommand) {
    test(`${name} lee projections.enabled desde la ruta efectiva del preludio`, () => {
      assert.ok(
        text.includes(`jq -r '.projections.enabled' "\${MEFISTO_CONFIG_PATH}" 2>/dev/null`),
        `${name} no lee projections.enabled desde MEFISTO_CONFIG_PATH`,
      )
    })
  }

  test(`${name} no lee directamente el config legacy`, () => {
    assert.deepEqual(matchingLines(text, DIRECT_LEGACY_READ), [], `${name} reintroduce una lectura directa legacy`)
  })

  test(`${name} califica toda referencia legacy en mensajes de usuario`, () => {
    assert.deepEqual(
      matchingLines(text, /^\s*echo .*\.claude\/harness\.config\.json/).filter(
        (line) => !/fallback legacy|AVISO:.*legacy/.test(line.text),
      ),
      [],
      `${name} nombra el legacy en un mensaje sin calificarlo`,
    )
  })
}
