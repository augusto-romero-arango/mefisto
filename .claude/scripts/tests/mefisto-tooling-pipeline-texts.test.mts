// Textos del pipeline interno de tooling: prompts de cada stage, del intento de correccion de
// neutralidad, de la reanudacion y de los conflictos, y cuerpo del PR, byte a byte contra los que
// producia mefisto-tooling-pipeline.mts (`fixtures/mefisto-tooling-pipeline/`).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import {
  NEUTRALITY_RUNTIME_BLOCK,
  holdNote,
  mergePrompt,
  neutralityFixPrompt,
  pullRequestBody,
  resumePrompt,
  stage1Prompt,
  stage2Prompt,
} from '../../../src/internal/scripts/lib/mefisto-tooling-texts.mts'
import { FIXTURES, REPO_ROOT } from './mefisto-tooling-pipeline-sandbox.mts'

const golden = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

// Los mismos valores con que se generaron los textos de referencia desde el bash.
const ISSUE_CONTEXT = '# Issue #42: Agregar workflow "ci" con $HOME y `backticks`\n\nCuerpo con $(subshell) y \\backslash.\nSegunda linea.'
const STAGE1 = { projectName: 'mefisto', issue: '42', issueContext: ISSUE_CONTEXT, timeout: '1800' }
const STAGE2 = {
  projectName: 'mefisto',
  issueContext: ISSUE_CONTEXT,
  snapshot: '0123456789abcdef0123456789abcdef01234567',
  writerHead: '89abcdef0123456789abcdef0123456789abcdef',
  diffStat: ' scripts/ci.sh | 12 ++++++++++++\n 1 file changed, 12 insertions(+)',
  diffNameStatus: 'A\tscripts/ci.sh',
  timeout: '1800',
}
const FIX = {
  projectName: 'mefisto',
  issue: '42',
  gateOutput: 'src/internal/agents/fx-leak.md:3: R1\nsrc/internal/x.md:1: R3',
  remedy: 'R1: reformula.\nR3: reformula citando MEF-ADR-0050.',
}
const COMMITS = '89abcde mefisto-tooling(#42): revision y correcciones\n0123456 mefisto-tooling(#42): implementacion'
const WRITER_SUMMARY = '## Implementado\n\n- Script `ci.sh` con $VARIABLES sin expandir.'
const NO_SUMMARY = '_(El agente no genero resumen)_'

describe('prompts identicos a los de mefisto-tooling-pipeline.mts', () => {
  test('bloque de neutralidad de runtime', () => {
    assert.equal(NEUTRALITY_RUNTIME_BLOCK, golden('neutrality-block.txt'))
  })
  test('writer (Stage 1)', () => {
    assert.equal(stage1Prompt(STAGE1), golden('stage-1-writer.prompt.txt'))
  })
  test('reviewer (Stage 2)', () => {
    assert.equal(stage2Prompt(STAGE2), golden('stage-2-reviewer.prompt.txt'))
  })
  test('intento de correccion de neutralidad', () => {
    assert.equal(neutralityFixPrompt(FIX), golden('stage-1-fix-writer.prompt.txt'))
  })
  test('reanudacion tras una espera', () => {
    assert.equal(resumePrompt('1', 'writer'), golden('resume-1-writer.prompt.txt'))
  })
  test('resolucion de conflictos de merge', () => {
    assert.equal(mergePrompt('scripts/a.sh\ndocs/b.md'), golden('merge.prompt.txt'))
  })
  test('el contexto del issue entra literal: sin expandir $, comillas ni acentos graves', () => {
    assert.ok(stage1Prompt(STAGE1).includes('\n\n# Issue #42: Agregar workflow "ci" con $HOME y `backticks`\n\nCuerpo con $(subshell) y \\backslash.\n'))
  })
  test('el reemplazo es literal: un $& o $1 del issue no se interpreta', () => {
    const prompt = stage1Prompt({ ...STAGE1, issueContext: 'costo $& y $1 y $$' })
    assert.ok(prompt.includes('\n\ncosto $& y $1 y $$\n\n'))
  })
})

describe('doctrina de los prompts', () => {
  test('el bloque de neutralidad viaja una vez, identico, en cada prompt', () => {
    for (const prompt of [stage1Prompt(STAGE1), stage2Prompt(STAGE2)]) {
      assert.equal(prompt.split(NEUTRALITY_RUNTIME_BLOCK).length, 2)
    }
  })
  test('el reviewer corrige la fuga en su revision, sin ampliar la allowlist', () => {
    const prompt = stage2Prompt(STAGE2)
    assert.ok(prompt.includes('reformulalos tu mismo en esta misma revision'))
    assert.ok(prompt.includes('propongas ampliar la allowlist'))
  })
  test('cada stage escribe su resumen bajo .mefisto/pipeline/summaries/', () => {
    assert.ok(stage1Prompt(STAGE1).endsWith('.mefisto/pipeline/summaries/stage-1-writer.md'))
    assert.ok(stage2Prompt(STAGE2).endsWith('.mefisto/pipeline/summaries/stage-2-reviewer.md'))
  })
  test('los dos prompts cierran con los guards y buscan tests tambien en src/published/scripts/tests/', () => {
    const lines = [stage1Prompt(STAGE1), stage2Prompt(STAGE2)].map((prompt) => prompt.split('\n').filter((line) => line.includes('corre UNA vez')))
    assert.deepEqual(
      lines.map((found) => found.length),
      [1, 1],
    )
    const [writer = '', reviewer = ''] = lines.map((found) => found[0] ?? '')
    assert.equal(writer, reviewer)
    assert.ok(writer.includes('src/published/scripts/tests/'))
    assert.ok(writer.includes('node --test scripts/tests/guards.test.mts'))
  })
  test('el presupuesto del stage es el timeout recibido', () => {
    assert.ok(stage1Prompt({ ...STAGE1, timeout: '60' }).includes('El presupuesto completo del stage es 60 s.'))
    assert.ok(stage2Prompt({ ...STAGE2, timeout: '60' }).includes('el presupuesto (60 s) no la cubre'))
  })
  test('ningun texto ni modulo del pipeline nombra un literal de R3', () => {
    const sources = [
      'src/internal/scripts/mefisto-tooling-pipeline.mts',
      'src/internal/scripts/lib/mefisto-tooling-texts.mts',
      'src/internal/scripts/lib/mefisto-tooling-agent.mts',
      'src/internal/scripts/lib/mefisto-tooling-records.mts',
    ]
    for (const source of sources) {
      const text = readFileSync(join(REPO_ROOT, source), 'utf8')
      assert.doesNotMatch(text, /CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|\.claude\/pipeline/, source)
    }
  })
})

describe('cuerpo del PR identico al de mefisto-tooling-pipeline.mts', () => {
  test('sin esperas y con Closes', () => {
    const body = pullRequestBody({
      writer: { seconds: '125', holdSeconds: 0, resumed: false, summary: WRITER_SUMMARY },
      reviewer: { seconds: '0', holdSeconds: 0, resumed: false, summary: NO_SUMMARY },
      commits: COMMITS,
      metricsTable: '| tabla |',
      reference: 'Closes',
      issue: '42',
    })
    assert.equal(body, golden('pr-body-plain.txt'))
  })
  test('con espera, reanudacion y Refs (cierre manual)', () => {
    const body = pullRequestBody({
      writer: { seconds: '725', holdSeconds: 600, resumed: true, summary: WRITER_SUMMARY },
      reviewer: { seconds: '61', holdSeconds: 0, resumed: true, summary: NO_SUMMARY },
      commits: COMMITS,
      metricsTable: '| tabla |',
      reference: 'Refs',
      issue: '42',
    })
    assert.equal(body, golden('pr-body-hold.txt'))
  })
  test('un stage que no corrio cuenta cero segundos', () => {
    const body = pullRequestBody({
      writer: { seconds: '', holdSeconds: 0, resumed: false, summary: NO_SUMMARY },
      reviewer: { seconds: '3', holdSeconds: 0, resumed: false, summary: NO_SUMMARY },
      commits: COMMITS,
      metricsTable: '| tabla |',
      reference: 'Closes',
      issue: '42',
    })
    assert.ok(body.includes('<summary>Writer -- 0m 0s</summary>'))
  })
  test('nota de espera', () => {
    assert.equal(holdNote(0, false), '')
    assert.equal(holdNote(90, false), ' (incluye 1m 30s en espera/hold)')
    assert.equal(holdNote(0, true), ' (reanudo la sesion truncada)')
    assert.equal(holdNote(61, true), ' (incluye 1m 1s en espera/hold; reanudo la sesion truncada)')
  })
})
