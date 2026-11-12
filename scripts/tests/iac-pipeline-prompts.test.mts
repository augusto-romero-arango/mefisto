// Textos y reglas de `iac-pipeline.mts`: prompts y cuerpo del PR byte a byte contra los que
// producia iac-pipeline.sh (`fixtures/iac-pipeline/`), lectura del gate de dependencias, la cola
// del log del agente y la frontera neutral del modulo.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { renderWarningRemnantsSection } from '../lib/pipeline/warning-remnants.mts'
import {
  applyPendingLine,
  dependencyReferences,
  dependencyStatus,
  iacPullRequestBody,
  iacStage1Prompt,
  iacStage2Prompt,
  issueHasBlockedLabel,
  tailText,
} from '../iac-pipeline.mts'
import { FIXTURES } from './iac-pipeline-sandbox.mts'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const work = mkdtempSync(join(tmpdir(), 'mefisto iac prompts '))
after(() => rmSync(work, { recursive: true, force: true }))

const golden = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

// Los mismos valores con que se generaron los textos de referencia desde el bash.
const PROMPT = {
  projectName: 'Control de Asistencias',
  issueContext: '# Issue #42: Crear "storage" con $HOME y `backticks`\n\nCuerpo con $(subshell) y \\backslash.\nSegunda linea.',
  environment: 'dev',
  envDirAbs: '/repo/.mefisto/pipeline/worktrees/infra-issue-42-x/infra/environments/dev',
  envDir: 'infra/environments/dev',
  snapshot: '0123456789abcdef0123456789abcdef01234567',
}
const BODY = {
  issue: '42',
  environment: 'dev',
  diffStat: ' infra/environments/dev/main.tf | 3 +++\n 1 file changed, 3 insertions(+)',
  commits: '89abcde infra(dev): correcciones de revision issue #42\n0123456 infra(dev): escritura HCL issue #42',
}

describe('textos identicos a los de iac-pipeline.sh', () => {
  test('prompt del infra-writer (Stage 1)', () => {
    assert.equal(iacStage1Prompt(PROMPT), golden('stage-1-infra-writer.prompt.txt'))
  })

  test('prompt del infra-reviewer (Stage 2)', () => {
    const diffContext = 'diff --git a/infra/environments/dev/main.tf b/infra/environments/dev/main.tf\n+resource "x" "y" {}'
    assert.equal(iacStage2Prompt({ ...PROMPT, diffContext }), golden('stage-2-infra-reviewer.prompt.txt'))
  })

  test('cuerpo del PR con warnings remanentes, entre las decisiones y los cambios Terraform', () => {
    const worktree = join(work, 'con-remanentes')
    mkdirSync(join(worktree, '.mefisto', 'pipeline'), { recursive: true })
    writeFileSync(join(worktree, '.mefisto', 'pipeline', 'warnings-remanentes.txt'), '#77\nacme/otro#5\n')
    const body = iacPullRequestBody({
      ...BODY,
      writerSummary: '## Implementado\n\n- Storage con $VARIABLES `sin` expandir.',
      writerSeconds: 125,
      reviewerSummary: '_(El agente no genero resumen)_',
      reviewerSeconds: null,
      remnants: renderWarningRemnantsSection(worktree),
    })
    assert.equal(body, golden('pr-body-remanentes.txt'))
    const decisions = body.indexOf('## Decisiones del pipeline')
    const remnants = body.indexOf('## Warnings remanentes')
    const terraform = body.indexOf('## Cambios Terraform')
    assert.ok(decisions !== -1 && decisions < remnants && remnants < terraform)
  })

  test('cuerpo del PR sin remanentes', () => {
    const body = iacPullRequestBody({
      ...BODY,
      writerSummary: '_(El agente no genero resumen)_',
      writerSeconds: null,
      reviewerSummary: 'Revisado.',
      reviewerSeconds: 60,
      remnants: '',
    })
    assert.equal(body, golden('pr-body-sin-remanentes.txt'))
  })

  test('el PR nunca cierra el issue: lo cierra el apply en CI (MEF-ADR-0022)', () => {
    assert.equal(applyPendingLine('42').includes('Closes'), false)
    assert.match(applyPendingLine('42'), /^> \*\*Apply pendiente en CI\*\*: este PR no cierra el issue #42\./)
  })

  test('los dos prompts prohiben publicar y el del reviewer, plan y apply', () => {
    const reviewer = iacStage2Prompt({ ...PROMPT, diffContext: '' })
    for (const prompt of [iacStage1Prompt(PROMPT), reviewer]) assert.ok(prompt.endsWith("PROHIBIDO hacer 'git push' o 'gh pr create' (ni ninguna operacion de publicacion de rama/PR): eso es responsabilidad exclusiva del pipeline, nunca tuya."))
    assert.ok(reviewer.includes("NUNCA ejecutes 'terraform plan' ni 'terraform apply'"))
  })
})

describe('gate de dependencias', () => {
  test('el label bloqueado se reconoce como objeto o como nombre', () => {
    assert.equal(issueHasBlockedLabel('{"labels":[{"name":"infra"},{"name":"bloqueado"}]}'), true)
    assert.equal(issueHasBlockedLabel('{"labels":["bloqueado"]}'), true)
    assert.equal(issueHasBlockedLabel('{"labels":[{"name":"infra"}]}'), false)
    assert.equal(issueHasBlockedLabel('{"labels":null}'), false)
    assert.equal(issueHasBlockedLabel('{}'), false)
    assert.equal(issueHasBlockedLabel('no es json'), false)
    assert.equal(issueHasBlockedLabel('{"labels":5}'), false)
  })

  test('cuenta cada #N de la seccion Dependencias, sin repetir, hasta el siguiente ##', () => {
    assert.deepEqual(dependencyReferences('Intro #1\n## Dependencias\n- Depende de #7 y PR #8\n- otra vez #7\n## Ambiente\n#9'), ['7', '8'])
    assert.deepEqual(dependencyReferences('## Dependencias (bloqueantes)\n#3\n### sub #4\n'), ['3', '4'])
    assert.deepEqual(dependencyReferences('## Dependencias\nNinguna.'), [])
    assert.deepEqual(dependencyReferences('sin seccion #5'), [])
    assert.deepEqual(dependencyReferences('## Dependencias'), [], 'un encabezado sin contenido no aporta referencias')
  })

  test('solo la primera seccion, y el ## de cierre puede ir sin espacio', () => {
    assert.deepEqual(dependencyReferences('## Dependencias\n#1\n## Dependencias\n#2'), ['1'])
    assert.deepEqual(dependencyReferences('x\n##Dependencias\n#5\n'), [])
    assert.deepEqual(dependencyReferences('## Dependencias\n#10 #2 #10\n##sin espacio #3\n## fin'), ['10', '2', '3'])
  })

  test('estado y titulo de una dependencia, con los valores por defecto del bash', () => {
    assert.deepEqual(dependencyStatus('{"state":"CLOSED","title":"Hecho"}'), { state: 'CLOSED', title: 'Hecho' })
    assert.deepEqual(dependencyStatus('{"state":"OPEN"}'), { state: 'OPEN', title: 'titulo no disponible' })
    assert.deepEqual(dependencyStatus('{"state":null,"title":"t"}'), { state: 'None', title: 't' })
    assert.deepEqual(dependencyStatus('roto'), { state: 'UNKNOWN', title: 'titulo no disponible' })
  })
})

describe('cola del log del agente', () => {
  test('tailText reproduce tail -n, con o sin salto final', () => {
    assert.equal(tailText('', 20), '')
    assert.equal(tailText('a\nb\nc\n', 2), 'b\nc\n')
    assert.equal(tailText('a\nb\nc', 2), 'b\nc')
    assert.equal(tailText('a\n', 20), 'a\n')
    assert.equal(tailText('\n\n\n', 20), '\n\n\n')
    const thirty = Array.from({ length: 30 }, (_, index) => `l${index}`)
    assert.equal(tailText(thirty.join('\n'), 20), thirty.slice(10).join('\n'))
  })

})

describe('frontera neutral: el pipeline no conoce ningun runtime concreto', () => {
  const code = readFileSync(join(REPO_ROOT, 'scripts', 'iac-pipeline.mts'), 'utf8')

  for (const forbidden of ['claude -p', '--permission-mode', 'bypassPermissions', 'output-format', 'resolveDeclaredAgentModel', '.claude/settings.json', 'checkout -- .claude/', 'API Error', 'agentSessionTranscriptCount', 'process.kill']) {
    test(`no menciona ${forbidden}`, () => {
      assert.equal(code.includes(forbidden), false)
    })
  }

  test('no lanza un shell, las herramientas de texto del bash ni az', () => {
    assert.equal(/['"`](bash|sh|jq|awk|sed|python3|az)['"`]/.test(code), false)
  })

  test('terraform solo corre init sin backend y validate', () => {
    const calls = [...code.matchAll(/terraform\((\[[^\]]*\])\)/g)].map((found) => found[1])
    assert.deepEqual(calls, ["['init', '-backend=false', '-input=false']", "['validate']"])
  })

  test('delega espera, reanudacion y clasificacion en la politica comun', () => {
    assert.ok(code.includes('runAgentWithPolicy('))
    assert.ok(code.includes('resolveRunnerCommand('))
  })
})
