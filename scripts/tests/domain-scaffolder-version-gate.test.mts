// Presupuesto y diagnostico del gate por SHA del scaffold de dominios (#1273).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { countOccurrences, readRepoFile, sliceBetween } from './text-contract.mts'

const AGENT = readRepoFile('agents/domain-scaffolder.md')
const FIXTURE = sliceBetween(
  AGENT,
  'public class ApiFixture : IAsyncLifetime',
  '**4. Crear `Fixtures/ServiceBusFixture.cs`',
)
const READY = sliceBetween(AGENT, '- name: Esperar /api/ready', '- name: Smoke tests')

function captures(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? '')
}

function check(description: string, condition: () => boolean): void {
  test(description, () => {
    assert.ok(condition())
  })
}

test('el gate por SHA fija un unico presupuesto de 420 s', () => {
  assert.deepEqual(captures(FIXTURE, /TimeoutGatePorVersion\s*=\s*TimeSpan\.FromSeconds\((\d+)\)/g), ['420'])
})
check(
  'el presupuesto del gate por SHA se mide por reloj',
  () =>
    FIXTURE.includes('var deadline = DateTime.UtcNow + TimeoutGatePorVersion;') &&
    FIXTURE.includes('while (DateTime.UtcNow < deadline)'),
)
check('el gate por SHA conserva el intervalo de 5 s', () => FIXTURE.includes('TimeSpan.FromSeconds(5)'))
check(
  'el gate conserva la comparacion exacta case-insensitive del SHA',
  () => FIXTURE.includes('StringComparison.OrdinalIgnoreCase'),
)
check('el gate reintenta HttpRequestException', () => FIXTURE.includes('catch (HttpRequestException)'))
check(
  'el agotamiento deriva e informa la URL de StartupLogs de Kudu',
  () =>
    FIXTURE.includes('var appHost = apiBaseAddress.Host;') &&
    FIXTURE.includes('appHost[..^".azurewebsites.net".Length]') &&
    FIXTURE.includes('.scm.azurewebsites.net/api/vfs/LogFiles/StartupLogs/') &&
    FIXTURE.includes('StartupLogs de Kudu: {startupLogsUrl}'),
)
check(
  'el agotamiento informa presupuesto, SHA esperado y ultimo SHA observado',
  () =>
    FIXTURE.includes('TimeoutGatePorVersion.TotalSeconds') &&
    FIXTURE.includes('SHA esperado ({expectedSha})') &&
    FIXTURE.includes('Ultimo SHA visto:'),
)
check(
  'el fallback sin SHA hace una unica comprobacion de /api/health',
  () =>
    countOccurrences(FIXTURE, 'Client.GetAsync("/api/health")') === 1 &&
    FIXTURE.includes('if (string.IsNullOrWhiteSpace(expectedSha))'),
)
check('StartupLogs es solo diagnostico y no se consulta', () => !FIXTURE.includes('GetAsync(startupLogsUrl'))
test('/api/ready conserva un unico presupuesto independiente de 120 s', () => {
  assert.deepEqual(captures(READY, /^\s*TIMEOUT=(\d+)\s*$/gm), ['120'])
})
check(
  '/api/ready no afirma compartir el timeout de /api/version',
  () => !READY.includes('Mismo timeout de 120s') && READY.includes('no comparte el timeout del gate por SHA'),
)
check(
  'la nota de idempotencia prescribe el parche manual del fixture existente',
  () =>
    AGENT.includes('Repos ya scaffoldeados antes del fix del issue #1273') &&
    AGENT.includes('Actualiza manualmente `Fixtures/ApiFixture.cs`'),
)
