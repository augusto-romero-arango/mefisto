// Guardrail (#1923): toda plantilla de workflow embebida en `agents/*.md` declara `permissions` a
// nivel de workflow o en todos sus jobs (CodeQL actions/missing-workflow-permissions).

import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'

import { readRepoFile, repoPath } from './text-contract.mts'

interface Template {
  label: string
  block: string
}

function workflowTemplates(): Template[] {
  const templates: Template[] = []
  const agents = readdirSync(repoPath('agents'))
    .filter((name) => name.endsWith('.md'))
    .sort()
  for (const agent of agents) {
    for (const match of readRepoFile(`agents/${agent}`).matchAll(/^```ya?ml\n([\s\S]*?)^```$/gm)) {
      const block = match[1] ?? ''
      if (!/^on:/m.test(block) || !/^jobs:/m.test(block)) continue
      const name = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? '(sin name)'
      templates.push({ label: `${agent}: ${name}`, block })
    }
  }
  return templates
}

interface Job {
  name: string
  body: string
}

function jobsOf(block: string): Job[] {
  const at = block.indexOf('\njobs:')
  assert.notEqual(at, -1, 'la plantilla no abre `jobs:` tras otra linea')
  const jobsPart = block.slice(at + '\njobs:'.length)
  const starts = [...jobsPart.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)]
  return starts.map((start, index) => ({
    name: start[1] ?? '',
    body: jobsPart.slice(start.index + start[0].length, starts[index + 1]?.index ?? jobsPart.length),
  }))
}

const TEMPLATES = workflowTemplates()

test('hay plantillas de workflow en agents/*.md', () => {
  assert.notEqual(TEMPLATES.length, 0, 'no se encontro ninguna plantilla de workflow en agents/*.md')
})

for (const { label, block } of TEMPLATES) {
  if (/^permissions:/m.test(block)) {
    test(`${label} declara permissions a nivel de workflow`, () => {
      assert.match(block, /^permissions:/m)
    })
    continue
  }
  for (const job of jobsOf(block)) {
    test(`${label} job ${job.name} declara permissions`, () => {
      assert.match(
        job.body,
        /^    permissions:/m,
        `${label} job ${job.name} sin permissions y workflow sin permissions`,
      )
    })
  }
}
