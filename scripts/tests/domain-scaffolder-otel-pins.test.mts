// Contrato de pines OpenTelemetry de los agentes publicados (#1230, #1246): cada guard del Paso 7
// usa el pin que prescribe su propia receta.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readRepoFile } from './text-contract.mts'

const AGENT = readRepoFile('agents/domain-scaffolder.md')
const PROJECTIONS_AGENT = readRepoFile('agents/projections-scaffolder.md')

const PACKAGES = [
  {
    name: 'OpenTelemetry.Extensions.Hosting',
    csproj: '$REPO_ROOT/src/<RootNamespace>.{PascalCase}/<RootNamespace>.{PascalCase}.csproj',
    side: 'produccion',
    version: '1.15.3',
  },
  {
    name: 'OpenTelemetry.Exporter.InMemory',
    csproj: '$REPO_ROOT/tests/<RootNamespace>.{PascalCase}.Tests/<RootNamespace>.{PascalCase}.Tests.csproj',
    side: 'tests',
    version: '1.15.3',
  },
]

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function recipePins(name: string): string[] {
  const pattern = new RegExp(`<PackageReference Include="${escaped(name)}" Version="([^"]+)" />`, 'g')
  return [...AGENT.matchAll(pattern)].map((match) => match[1] ?? '')
}

interface GuardCall {
  version: string
  csproj: string
}

function guardCalls(name: string): GuardCall[] {
  const pattern = new RegExp(
    `verificar_pin_otlp\\s*\\\\\\s*"${escaped(name)}"\\s*\\\\\\s*"([^"]+)"\\s*\\\\\\s*"([^"]+)"\\s*\\|\\|\\s*exit 1`,
    'g',
  )
  return [...AGENT.matchAll(pattern)].map((match) => ({ version: match[1] ?? '', csproj: match[2] ?? '' }))
}

for (const { name, csproj, side, version } of PACKAGES) {
  const recipe = recipePins(name)
  const calls = guardCalls(name)

  test(`la receta de ${side} prescribe un unico pin para ${name}`, () => {
    assert.equal(recipe.length, 1)
  })

  test(`la receta de ${side} fija ${name} exclusivamente en ${version}`, () => {
    assert.deepEqual(recipe, [version])
  })

  test(`Paso 7 contiene una unica llamada cerrada para ${name}`, () => {
    assert.equal(calls.length, 1)
  })

  test(`el guard de ${side} coincide con el pin de la receta`, () => {
    assert.equal(recipe.length, 1)
    assert.deepEqual(
      calls.map((call) => call.version),
      recipe,
    )
  })

  test(`el guard de ${side} fija ${name} exclusivamente en ${version}`, () => {
    assert.deepEqual(
      calls.map((call) => call.version),
      [version],
    )
  })

  test(`el guard de ${side} apunta al csproj afectado`, () => {
    assert.deepEqual(
      calls.map((call) => call.csproj),
      [csproj],
    )
  })
}

test('la receta conserva Azure.Monitor.OpenTelemetry.Exporter en 1.8.2', () => {
  assert.deepEqual(recipePins('Azure.Monitor.OpenTelemetry.Exporter'), ['1.8.2'])
})

test('projections-scaffolder contrasta su pin independiente contra el write-side 1.15.3/1.8.2', () => {
  assert.ok(PROJECTIONS_AGENT.includes('write-side en MEF-ADR-0003 (`1.15.3`/`1.8.2`'))
})

test('projections-scaffolder no presenta 1.13.1 como el pin write-side vigente', () => {
  assert.ok(!PROJECTIONS_AGENT.includes('write-side en MEF-ADR-0003 (`1.13.1`/`1.8.2`'))
})

test('la funcion de verificacion puede extraerse del Paso 7', () => {
  const start = AGENT.indexOf('verificar_pin_otlp() {')
  assert.notEqual(start, -1)
  assert.notEqual(AGENT.indexOf('\n}\n\nverificar_pin_otlp \\', start), -1)
})
