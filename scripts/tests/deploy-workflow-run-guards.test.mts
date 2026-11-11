// Guardas de origen confiable de los workflows de deploy encadenados por `workflow_run` en
// domain-scaffolder y mcp-scaffolder (#1828, MEF-ADR-0022).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readRepoFile } from './text-contract.mts'

const ORIGIN =
  "github.event_name != 'workflow_run' || (github.event.workflow_run.event == 'push' " +
  "&& github.event.workflow_run.head_branch == 'main' " +
  '&& github.event.workflow_run.head_repository.full_name == github.repository)'

const TEMPLATES = [
  { label: 'domain', path: 'agents/domain-scaffolder.md', header: 'name: Deploy \\{PascalCase\\}\\n' },
  { label: 'mcp', path: 'agents/mcp-scaffolder.md', header: 'name: Deploy MCP[^\\n]*\\n' },
]

const JOBS = [
  { job: 'build-and-test', next: 'deploy' },
  { job: 'deploy', next: 'smoke-tests' },
]

for (const { label, path, header } of TEMPLATES) {
  const template = new RegExp(`${header}[\\s\\S]*?^\`\`\`$`, 'm').exec(readRepoFile(path))?.[0]
  const scope = /^  determinar-alcance:\n[\s\S]*?(?=^  build-and-test:)/m.exec(template ?? '')?.[0]
  const scopeText = scope ?? ''

  test(`[${label}] se encontro la plantilla de deploy`, () => {
    assert.notEqual(template, undefined)
  })

  test(`[${label}] se encontro determinar-alcance`, () => {
    assert.notEqual(scope, undefined)
  })

  test(`[${label}] CA-1 RUN_EVENTO por env`, () => {
    assert.ok(scopeText.includes('RUN_EVENTO: ${{ github.event.workflow_run.event }}'))
  })

  test(`[${label}] CA-1 RUN_REPO por env`, () => {
    assert.ok(scopeText.includes('RUN_REPO: ${{ github.event.workflow_run.head_repository.full_name }}'))
  })

  test(`[${label}] CA-1 la guarda exige push y mismo repo`, () => {
    assert.ok(scopeText.includes('"$RUN_EVENTO" != "push"'))
    assert.ok(scopeText.includes('"$RUN_REPO" != "$REPO"'))
  })

  test(`[${label}] CA-3 el run: no contiene expresiones \${{ }}`, () => {
    const at = scopeText.indexOf('run: |')
    assert.notEqual(at, -1)
    assert.ok(!scopeText.slice(at + 'run: |'.length).includes('${{'))
  })

  for (const { job, next } of JOBS) {
    const found = new RegExp(`^  ${job}:\\n[\\s\\S]*?(?=^  ${next}:)`, 'm').exec(template ?? '')?.[0]
    const text = found ?? ''

    test(`[${label}] se encontro ${job}`, () => {
      assert.notEqual(found, undefined)
    })

    test(`[${label}] CA-2 ${job} incluye la guarda de origen`, () => {
      assert.ok(text.includes(ORIGIN))
    })

    test(`[${label}] CA-2 ${job} explica por que repite la guarda`, () => {
      assert.ok(text.includes('# Guarda de origen repetida junto al checkout'))
    })

    test(`[${label}] CA-2 ${job} conserva debe_desplegar`, () => {
      assert.ok(text.includes("needs.determinar-alcance.outputs.debe_desplegar == 'true'"))
    })

    if (label === 'domain' && job === 'deploy') {
      test('[domain] CA-2 deploy conserva la exclusion de pull_request', () => {
        assert.ok(text.includes("github.event_name != 'pull_request'"))
      })
    }
  }
}
