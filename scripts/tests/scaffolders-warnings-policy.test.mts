// Los scaffolders como su propia ultima instancia de la politica de cero warnings nuevos (#2411,
// MEF-ADR-0056): cada uno lleva la seccion completa y los comandos de install copian los remanentes
// al body del PR.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assertAbsent, lineOf, matchingLines, readRepoFile, sectionOf } from './text-contract.mts'

const SCAFFOLDERS = [
  'domain-scaffolder',
  'mcp-scaffolder',
  'projections-scaffolder',
  'apim-gateway-scaffolder',
  'workos-identity-scaffolder',
  'infra-base-scaffolder',
]

const NEEDLES = [
  'SCAFFOLD_BASE=$(git rev-parse HEAD',
  'node {{mefisto:package-root}}/scripts/warnings-diff.mts --toolchain dotnet',
  'node {{mefisto:package-root}}/scripts/warnings-diff.mts --toolchain terraform',
  '--path infra/environments/<env>',
  'node {{mefisto:package-root}}/scripts/warnings-diff.mts --toolchain shell',
  'Salida `1`',
  '#pragma warning disable',
  '<NoWarn>',
  '# shellcheck disable',
  'json-value.mts" get "{{mefisto:config-path}}" repoSlug --or-empty',
  'augusto-romero-arango/mefisto',
  'gh issue list -R',
  'gh issue create -R',
  'gh issue comment',
  '--label "estado:borrador,tipo:tooling,warning"',
  'Remediar <codigo> en la plantilla de <agente>',
  '{{mefisto:package-root}}/mefisto-manifest.json',
  'Si `gh` falla',
  '{{mefisto:state-path warnings-remanentes.txt}}',
  '## Warnings remanentes',
  '- Relacionado: owner/repo#N',
]

for (const agent of SCAFFOLDERS) {
  test(`${agent}: seccion 'Cero warnings nuevos (MEF-ADR-0056)' completa`, () => {
    const section = sectionOf(readRepoFile(`src/published/agents/${agent}.md`), '## Cero warnings nuevos (MEF-ADR-0056)')
    assert.notEqual(section, '', `${agent}: sin seccion 'Cero warnings nuevos (MEF-ADR-0056)'`)
    assert.deepEqual(
      NEEDLES.filter((needle) => !section.includes(needle)),
      [],
      `${agent}: faltan textos de la seccion`,
    )
  })
}

test("projections-scaffolder remite a la seccion en vez de afirmar 'sin advertencias'", () => {
  assertAbsent(readRepoFile('src/published/agents/projections-scaffolder.md'), 'sin advertencias')
})

for (const command of ['install-apim', 'install-workos', 'install-auth']) {
  test(`${command}: el paso de gh pr create copia '## Warnings remanentes' al body`, () => {
    const text = readRepoFile(`src/published/commands/${command}.md`)
    const pr = lineOf(text, 'gh pr create --title')
    const remnants = matchingLines(text, '## Warnings remanentes').at(-1)?.number ?? 0
    assert.ok(pr > 0 && remnants > 0, `${command}: falta gh pr create o '## Warnings remanentes'`)
    const distance = remnants - pr
    assert.ok(distance >= 0 && distance <= 5, `${command}: pr=${pr} w=${remnants}`)
  })
}
