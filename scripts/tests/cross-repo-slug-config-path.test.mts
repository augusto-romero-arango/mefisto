// Contrato de ruta efectiva para leer `repoSlug` en los caminos de draft cross-repo hacia Mefisto
// (#1534, MEF-ADR-0053 decision 4): planner, tooling-investigator y fix-review comparten el
// preambulo renderizado de `{{mefisto:config-path}}` y ninguno lee el config legacy por su cuenta.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fencedBlocks, fromLine, linesOf, matchingLines, readRepoFile } from './text-contract.mts'

const PLANNER = readRepoFile('agents/planner.md')
const INVESTIGATOR = readRepoFile('agents/tooling-investigator.md')
const FIX_REVIEW = readRepoFile('commands/fix-review.md')
const DRAFT = readRepoFile('commands/draft.md')

const SLUG_ANCHOR = 'Lee el slug del repo de Mefisto (configurable para forks):'
const EXPORT_LINE = 'export MEFISTO_CONFIG_PATH'

function trimmed(block: string | undefined): string {
  return (block ?? '').replace(/\n+$/, '')
}

function blockAfterAnchor(text: string, anchor: string): string {
  return trimmed(fencedBlocks(fromLine(text, anchor), 'bash')[0])
}

/** El preambulo se reconoce por la linea que exporta `MEFISTO_CONFIG_PATH`, no por su posicion. */
function configPreamble(text: string): string {
  return trimmed(fencedBlocks(text, 'bash').find((block) => block.includes(EXPORT_LINE)))
}

// El bloque del investigator resuelve tambien `{{mefisto:instructions-path}}`: se aisla el config.
function upToExport(preamble: string): string {
  const lines = linesOf(preamble)
  const at = lines.indexOf(EXPORT_LINE)
  return trimmed((at === -1 ? lines : lines.slice(0, at + 1)).join('\n'))
}

const PLANNER_OWN = blockAfterAnchor(PLANNER, '### Slug del repo de Mefisto')
const PLANNER_PREAMBLE = configPreamble(PLANNER)
const INVESTIGATOR_OWN = blockAfterAnchor(INVESTIGATOR, SLUG_ANCHOR)
const INVESTIGATOR_PREAMBLE = upToExport(configPreamble(INVESTIGATOR))
const FIX_REVIEW_OWN = blockAfterAnchor(FIX_REVIEW, SLUG_ANCHOR)
const FIX_REVIEW_PREAMBLE = configPreamble(FIX_REVIEW)

test('los tres bloques (y los preambulos compartidos de planner y fix-review) se extrajeron desde sus anclajes', () => {
  for (const block of [
    PLANNER_OWN,
    PLANNER_PREAMBLE,
    INVESTIGATOR_OWN,
    INVESTIGATOR_PREAMBLE,
    FIX_REVIEW_OWN,
    FIX_REVIEW_PREAMBLE,
  ]) {
    assert.notEqual(block, '', 'no se pudo extraer alguno de los bloques esperados')
  }
})

test('planner y fix-review (migrados) comparten el mismo preambulo de config-path', () => {
  assert.equal(FIX_REVIEW_PREAMBLE, PLANNER_PREAMBLE, 'planner y fix-review divergen en el preambulo de config-path')
})

test('planner y tooling-investigator (migrado, #1668) comparten el mismo preambulo de config-path', () => {
  assert.equal(
    INVESTIGATOR_PREAMBLE,
    PLANNER_PREAMBLE,
    'planner y tooling-investigator divergen en el preambulo de config-path',
  )
})

test('fix-review resuelve el slug via MEFISTO_CONFIG_PATH (preambulo compartido), no via CONFIG propio', () => {
  assert.ok(FIX_REVIEW_OWN.includes('MEFISTO_CONFIG_PATH'))
})

test('fix-review ya no reconstruye CONFIG=$REPO_ROOT/... a mano', () => {
  assert.ok(!FIX_REVIEW_OWN.includes('CONFIG="$REPO_ROOT'))
})

test('planner resuelve el slug via MEFISTO_CONFIG_PATH (preambulo compartido), no via CONFIG propio', () => {
  assert.ok(PLANNER_OWN.includes('MEFISTO_CONFIG_PATH'))
})

test('planner ya no reconstruye CONFIG=$REPO_ROOT/... a mano', () => {
  assert.ok(!PLANNER_OWN.includes('CONFIG="$REPO_ROOT'))
})

test('ningun artefacto reintroduce una lectura directa del config legacy fuera del fallback sancionado', () => {
  const sanctioned =
    'cat .mefisto/harness.config.json 2>/dev/null || cat .claude/harness.config.json 2>/dev/null || echo "No existe"'
  const jqRead = /(^|[;&|(`$\s])jq\s.*\.claude\/harness\.config\.json/
  const otherRead =
    /(^|[;&|(`$\s])(cat|sed|awk|grep|python|python3)\s.*\.claude\/harness\.config\.json|<\s*\S*\.claude\/harness\.config\.json/
  const leaks: string[] = []
  for (const [name, text] of [
    ['planner.md', PLANNER],
    ['tooling-investigator.md', INVESTIGATOR],
    ['fix-review.md', FIX_REVIEW],
    ['draft.md', DRAFT],
  ] as const) {
    const filtered = linesOf(text)
      .filter((line) => !line.includes(sanctioned))
      .join('\n')
    if (matchingLines(filtered, jqRead).length > 0) leaks.push(`${name} tiene una lectura jq directa del config legacy`)
    if (matchingLines(filtered, otherRead).length > 0) {
      leaks.push(
        `${name} tiene una lectura directa (cat/sed/awk/grep/python/<) del config legacy fuera del fallback sancionado`,
      )
    }
  }
  assert.deepEqual(leaks, [])
})
