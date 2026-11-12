// Textos que arma `tooling-pipeline.mts`: prompts del writer, del reviewer y del merge y cuerpo
// del PR, byte a byte contra los que producia tooling-pipeline.mts (`fixtures/tooling-pipeline/`),
// y el contrato de alcance y de frontera neutral que esos textos y el modulo sostienen.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { capture } from '../lib/cli.mts'
import { isPathInConsumerBlocklist } from '../lib/pipeline/consumer-scope.mts'
import { summaryDetails } from '../lib/pipeline/pipeline-pr.mts'
import { renderRunMetricsTable } from '../lib/pipeline/run-history.mts'
import { renderWarningRemnantsSection } from '../lib/pipeline/warning-remnants.mts'
import { mergePrompt, pullRequestBody, stage1Prompt, stage2Prompt, writerBlockers } from '../tooling-pipeline.mts'
import { FIXTURES } from './tooling-pipeline-sandbox.mts'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const work = mkdtempSync(join(tmpdir(), 'mefisto tooling prompts '))
after(() => rmSync(work, { recursive: true, force: true }))

const golden = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

// Los mismos valores con que se generaron los textos de referencia desde el bash.
const ISSUE_CONTEXT = '# Issue #42: Agregar workflow "ci" con $HOME y `backticks`\n\nCuerpo con $(subshell) y \\backslash.\nSegunda linea.'
const SNAPSHOT = '0123456789abcdef0123456789abcdef01234567'
const STAGE1 = { projectName: 'Control de Asistencias', issueContext: ISSUE_CONTEXT, snapshot: SNAPSHOT, draftsSlug: 'acme/mefisto-fork' }
const STAGE2 = {
  projectName: 'Control de Asistencias',
  issueContext: ISSUE_CONTEXT,
  snapshot: SNAPSHOT,
  writerHead: '89abcdef0123456789abcdef0123456789abcdef',
  diffStat: ' .github/workflows/ci.yml | 12 ++++++++++++\n 1 file changed, 12 insertions(+)',
  diffNameStatus: 'A\t.github/workflows/ci.yml',
}
const WRITER_METRICS =
  '{"model":"modelo-a","tokens":{"input":1200,"output":340,"cache_read":50000,"cache_write":2000,"reasoning":0},"estimated_cost_usd":0.4321}'
const METRICS_TABLE = renderRunMetricsTable([
  { label: 'Writer', duration: 125, metrics: WRITER_METRICS },
  { label: 'Reviewer', duration: null, metrics: 'null' },
])
const BODY = {
  issue: '42',
  writerSummary: '## Implementado\n\n- Workflow `ci.yml` con $VARIABLES sin expandir.',
  writerSeconds: 125,
  reviewerSummary: '_(El agente no genero resumen)_',
  reviewerSeconds: null,
  commits: '89abcde tooling(#42): revision y correcciones\n0123456 tooling(#42): implementacion',
  metricsTable: METRICS_TABLE,
}

describe('prompts identicos a los de tooling-pipeline.mts', () => {
  test('writer (Stage 1)', () => {
    assert.equal(stage1Prompt(STAGE1), golden('stage-1-writer.prompt.txt'))
  })
  test('reviewer (Stage 2)', () => {
    assert.equal(stage2Prompt(STAGE2), golden('stage-2-reviewer.prompt.txt'))
  })
  test('resolucion de conflictos de merge', () => {
    assert.equal(mergePrompt({ conflictFiles: 'scripts/a.sh\ndocs/b.md' }), golden('merge.prompt.txt'))
  })
  test('el contexto del issue entra literal: sin expandir $, comillas ni acentos graves', () => {
    assert.ok(stage1Prompt(STAGE1).includes('Agregar workflow "ci" con $HOME y `backticks`\n\nCuerpo con $(subshell) y \\backslash.'))
  })
})

describe('cuerpo del PR identico al de tooling-pipeline.mts', () => {
  test('la tabla de metricas de la corrida', () => {
    assert.equal(METRICS_TABLE.replace(/\n+$/, ''), golden('metrics-table.txt'))
  })
  test('sin warnings remanentes', () => {
    assert.equal(pullRequestBody({ ...BODY, remnants: '' }), golden('pr-body-sin-remanentes.txt'))
  })
  test('con warnings remanentes, entre las decisiones y los commits', () => {
    const worktree = join(work, 'worktree')
    mkdirSync(join(worktree, '.mefisto', 'pipeline'), { recursive: true })
    writeFileSync(join(worktree, '.mefisto', 'pipeline', 'warnings-remanentes.txt'), '#77\nacme/otro#5\n')
    const body = pullRequestBody({ ...BODY, remnants: renderWarningRemnantsSection(worktree) })
    assert.equal(body, golden('pr-body-con-remanentes.txt'))
    const decisions = body.indexOf('## Decisiones del pipeline')
    const remnants = body.indexOf('## Warnings remanentes')
    const commits = body.indexOf('## Commits')
    assert.ok(decisions !== -1 && decisions < remnants && remnants < commits)
  })
  test('un stage que no corrio muestra 0m 0s', () => {
    assert.ok(pullRequestBody({ ...BODY, writerSeconds: null, remnants: '' }).includes(summaryDetails('Writer', 0, BODY.writerSummary)))
  })
})

describe('politica de cero warnings nuevos (MEF-ADR-0056)', () => {
  test('el writer recibe el commit base y los dos prompts nombran warnings-diff.mts con --base', () => {
    assert.ok(stage1Prompt(STAGE1).includes(`Commit base: ${SNAPSHOT}\n`))
    for (const prompt of [stage1Prompt(STAGE1), stage2Prompt(STAGE2)]) {
      assert.ok(prompt.includes(`scripts/warnings-diff.mts del plugin (politica de cero warnings nuevos, MEF-ADR-0056); sigue la doctrina de tu agente con --base ${SNAPSHOT}.`))
    }
  })
})

/** Lineas que siguen al encabezado `heading`, incluido el. */
function block(prompt: string, heading: string, count: number): string[] {
  const lines = prompt.split('\n')
  const start = lines.indexOf(heading)
  assert.notEqual(start, -1, `falta el encabezado ${heading}`)
  return lines.slice(start, start + count + 1)
}

describe('alcance permitido que declaran los prompts', () => {
  const writer = block(stage1Prompt(STAGE1), 'ALCANCE PERMITIDO de escritura:', 14)
  const reviewer = block(stage2Prompt(STAGE2), 'ALCANCE PERMITIDO de escritura (igual al del writer):', 4)
  const mentions = (lines: string[], needle: string): string[] => lines.filter((line) => line.includes(needle))

  test('el writer lista el config canonico antes que el legacy, y este solo si ya existe', () => {
    const canonical = writer.findIndex((line) => line.includes('.mefisto/harness.config.json'))
    const legacy = writer.findIndex((line) => line.includes('.claude/harness.config.json'))
    assert.ok(canonical !== -1 && legacy !== -1 && canonical < legacy)
    assert.match(writer[legacy] ?? '', /solo si ya existe/)
  })

  test('el reviewer enumera lo mismo: canonico, legacy calificado y settings.json tal cual', () => {
    assert.equal(mentions(reviewer, '.mefisto/harness.config.json').length, 1)
    assert.match(mentions(reviewer, '.claude/harness.config.json')[0] ?? '', /solo si ya existe/)
    assert.equal(mentions(reviewer, '.claude/settings.json').length, 1)
  })

  test('ninguna linea nombra el config legacy sin calificarlo de legacy', () => {
    for (const prompt of [stage1Prompt(STAGE1), stage2Prompt(STAGE2)]) {
      for (const line of mentions(prompt.split('\n'), '.claude/harness.config.json')) assert.match(line, /legacy/)
    }
  })

  for (const [name, lines] of [['writer', writer], ['reviewer', reviewer]] as const) {
    test(`el ${name} declara .github/dependabot.yml sin abrir .github/ completo`, () => {
      assert.equal(mentions(lines, '.github/dependabot.yml').length, 1)
      assert.equal(lines.some((line) => /(^|[ ,-])\.github\/($|[ ,(])/.test(line)), false)
    })
    test(`el ${name} declara .mefisto/appinsights.env sin abrir .mefisto/ completo`, () => {
      assert.equal(mentions(lines, '.mefisto/appinsights.env').length, 1)
      assert.equal(lines.some((line) => /(^|[ ,-])\.mefisto\/($|[ ,(])/.test(line)), false)
    })
  }

  test('el writer describe appinsights.env como configuracion sin secretos', () => {
    assert.match(mentions(writer, '.mefisto/appinsights.env')[0] ?? '', /sin secretos/)
  })

  test('el gate es coherente con el prompt: no bloquea las rutas de config y si las del plugin', () => {
    for (const allowed of ['.mefisto/harness.config.json', '.claude/harness.config.json', '.github/dependabot.yml', '.mefisto/appinsights.env']) {
      assert.equal(isPathInConsumerBlocklist(allowed), false, allowed)
    }
    for (const blocked of ['commands/x.md', 'agents/x.md', 'hooks/x.sh', '.claude-plugin/plugin.json']) {
      assert.equal(isPathInConsumerBlocklist(blocked), true, blocked)
    }
  })

  test('un cambio que solo toca dependabot.yml es visible para git y pasa el gate', () => {
    const repo = join(work, 'solo-dependabot')
    mkdirSync(join(repo, '.github'), { recursive: true })
    capture('git', ['init', '-q', repo])
    writeFileSync(join(repo, '.github', 'dependabot.yml'), 'version: 2\n')
    const pending = capture('git', ['-C', repo, 'status', '--porcelain', '-uall']).stdout.trimEnd()
    assert.equal(pending, '?? .github/dependabot.yml')
    assert.equal(isPathInConsumerBlocklist(pending.slice(3)), false)
  })
})

describe('writerBlockers', () => {
  test('devuelve solo el contenido de la seccion Pendiente/bloqueos', () => {
    const summary = '## Implementado\n\nNada.\n\n## Pendiente/bloqueos\n\nBLOQUEO-CENTINELA-1315\n\nDetalle del bloqueo.\n\n## Verificacion\n\nNo aplica.\n'
    assert.equal(writerBlockers(summary), '\nBLOQUEO-CENTINELA-1315\n\nDetalle del bloqueo.')
  })
  test('sin la seccion o con la seccion vacia no hay bloqueos', () => {
    assert.equal(writerBlockers('## Implementado\n\nSin cambios.\n'), '')
    assert.equal(writerBlockers('## Pendiente/bloqueos\n\n## Verificacion\n\nNo aplica.\n'), '')
    assert.equal(writerBlockers(''), '')
  })
  test('la seccion al final del resumen llega hasta el fin; un subtitulo no la corta', () => {
    assert.equal(writerBlockers('## Pendiente/bloqueos  \r\n- falta acceso\n### detalle\nmas\n'), '- falta acceso\n### detalle\nmas')
  })
})

describe('frontera neutral: el pipeline no conoce ningun runtime concreto', () => {
  const sources = ['scripts/tooling-pipeline.mts', 'scripts/lib/pipeline/pipeline-agent-run.mts'].map((file) => readFileSync(join(REPO_ROOT, ...file.split('/')), 'utf8'))
  const code = sources.join('\n')

  for (const forbidden of ['claude -p', 'CLAUDE_CONFIG_DIR', 'bypassPermissions', 'output-format', '--raw-log', '--stderr-log', 'fork-session', 'process.kill']) {
    test(`no menciona ${forbidden}`, () => {
      assert.equal(code.includes(forbidden), false)
    })
  }

  test('no lanza un shell ni las herramientas de texto del bash', () => {
    assert.equal(/['"`](bash|sh|jq|awk|sed|python3)['"`]/.test(code), false)
  })

  for (const [path, id] of [
    ['agents/tooling-writer.md', 'tooling-writer'],
    ['agents/tooling-reviewer.md', 'tooling-reviewer'],
    ['.claude/agents/mefisto-writer.md', 'mefisto-writer'],
    ['.claude/agents/mefisto-reviewer.md', 'mefisto-reviewer'],
  ] as const) {
    test(`el agente ${id} existe y declara ese nombre`, () => {
      const file = join(REPO_ROOT, ...path.split('/'))
      assert.equal(existsSync(file), true)
      assert.equal(/^name: "([^"]*)"$/m.exec(readFileSync(file, 'utf8'))?.[1], id)
    })
  }
})
