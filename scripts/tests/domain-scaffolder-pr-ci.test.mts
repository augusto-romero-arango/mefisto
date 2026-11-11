// Contrato CI de PRs de la plantilla `deploy-{kebab}.yml` de domain-scaffolder (#1248).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readRepoFile } from './text-contract.mts'

const AGENT = readRepoFile('agents/domain-scaffolder.md')
const TEMPLATE = /name: Deploy \{PascalCase\}\n[\s\S]*?^```$/m.exec(AGENT)?.[0]
const WORKFLOW = TEMPLATE ?? ''

const DEPENDENCIES = [
  'src/<RootNamespace>.{PascalCase}/**',
  'src/<RootNamespace>.{PascalCase}.DomainEvents/**',
  'src/<RootNamespace>.PublicEvents/**',
  'src/<RootNamespace>.PrivateEvents/**',
  'global.json',
  '.github/workflows/deploy-{kebab}.yml',
]

const SAFE_CONDITION =
  "if: github.event_name != 'pull_request' && needs.determinar-alcance.outputs.debe_desplegar == 'true'"

function find(pattern: RegExp): string | undefined {
  return pattern.exec(WORKFLOW)?.[0]
}

function pathsOf(trigger: string | undefined): string[] {
  return [...(trigger ?? '').matchAll(/^\s+- '([^']+)'$/gm)].map((match) => match[1] ?? '')
}

/** `fnmatch` de shell: `*`, `?` y `[...]`, sin trato especial para `/`. */
function fnmatch(name: string, pattern: string): boolean {
  const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const source = pattern.replace(/\[(!?)(\]?[^\]]*)\]|[\s\S]/g, (token: string, negated?: string, set?: string) => {
    if (token === '*') return '[\\s\\S]*'
    if (token === '?') return '[\\s\\S]'
    if (set === undefined || set === '') return literal(token)
    return `[${negated === '!' ? '^' : ''}${set.replace(/[\\\]^]/g, '\\$&')}]`
  })
  return new RegExp(`^${source}$`).test(name)
}

const PUSH = find(/  push:\n[\s\S]*?(?=^  pull_request:)/m)
const PULL_REQUEST = find(/  pull_request:\n[\s\S]*?(?=^  workflow_run:)/m)
const BUILD = find(/^  build-and-test:\n[\s\S]*?(?=^  deploy:)/m)
const DEPLOY = find(/^  deploy:\n[\s\S]*?(?=^  smoke-tests:)/m)
const SMOKE = find(/^  smoke-tests:\n[\s\S]*/m)
const TEST_GLOB = /for proj in (tests\/<RootNamespace>[^;]+); do/.exec(BUILD ?? '')?.[1]

function check(description: string, condition: () => boolean): void {
  test(description, () => {
    assert.ok(condition())
  })
}

check('se encontro la plantilla deploy-{kebab}.yml', () => TEMPLATE !== undefined)
check('la plantilla conserva el trigger push', () => PUSH !== undefined)
check('la plantilla declara el trigger pull_request', () => PULL_REQUEST !== undefined)

test('push conserva exactamente las seis dependencias de build', () => {
  assert.deepEqual(pathsOf(PUSH), DEPENDENCIES)
})

test('pull_request vigila exactamente las mismas dependencias que push', () => {
  assert.notEqual(PUSH, undefined)
  assert.deepEqual(pathsOf(PULL_REQUEST), pathsOf(PUSH))
})

check('la plantilla conserva el unico job build-and-test', () => BUILD !== undefined)
check(
  'build-and-test se ejecuta para el alcance del PR sin excluir pull_request',
  () => BUILD?.includes("if: needs.determinar-alcance.outputs.debe_desplegar == 'true'") === true,
)
check('el PR restaura la solucion', () => BUILD?.includes('dotnet restore <SolutionFile>') === true)
check(
  'el PR compila Release',
  () => BUILD?.includes('dotnet build <SolutionFile> --no-restore --configuration Release') === true,
)
check(
  'el PR ejecuta todos los proyectos unitarios y de contrato',
  () => BUILD?.includes('for proj in tests/<RootNamespace>.*.Tests/; do') === true,
)
check('se encontro el glob de proyectos de test', () => TEST_GLOB !== undefined)
check(
  'el glob selecciona proyectos unitarios y de contrato',
  () =>
    TEST_GLOB !== undefined &&
    fnmatch('tests/<RootNamespace>.Ventas.Tests/', TEST_GLOB) &&
    fnmatch('tests/<RootNamespace>.Ventas.Contract.Tests/', TEST_GLOB),
)
check(
  'el glob no selecciona proyectos .SmokeTests',
  () => TEST_GLOB !== undefined && !fnmatch('tests/<RootNamespace>.Ventas.SmokeTests/', TEST_GLOB),
)

check('deploy queda omitido en pull_request', () => DEPLOY?.includes(SAFE_CONDITION) === true)
check('smoke-tests queda omitido en pull_request', () => SMOKE?.includes(SAFE_CONDITION) === true)
check(
  'smoke-tests conserva deploy y la salida de alcance como dependencias',
  () => SMOKE?.includes('needs: [determinar-alcance, deploy]') === true,
)
check('OIDC permanece dentro del job excluido en PR', () => DEPLOY?.includes('uses: azure/login@v3') === true)
check('publish permanece dentro del job excluido en PR', () => DEPLOY?.includes('- name: Publish') === true)
check(
  'deploy a Azure permanece dentro del job excluido en PR',
  () => DEPLOY?.includes('uses: Azure/functions-action@v1') === true,
)

check(
  'se conserva workflow_run posterior a Infra CD',
  () => WORKFLOW.includes("workflow_run:\n    workflows: ['Infra CD']"),
)
check('se conserva workflow_dispatch', () => WORKFLOW.includes('workflow_dispatch:'))
check(
  'determinar-alcance habilita build-and-test para pull_request, push y workflow_dispatch',
  () => WORKFLOW.includes('if [ "$EVENTO" != "workflow_run" ]; then'),
)
check(
  'la nota de idempotencia explica como portar el cambio a workflows existentes',
  () => AGENT.includes('Repos ya scaffoldeados antes del fix del issue #1248'),
)
check(
  'la nota de idempotencia conserva dependencias condicionales de dominios existentes',
  () =>
    AGENT.includes('pull_request.paths` como copia exacta de `push.paths') &&
    AGENT.includes('TenantResolver/**` cuando el dominio ya la tenga'),
)
