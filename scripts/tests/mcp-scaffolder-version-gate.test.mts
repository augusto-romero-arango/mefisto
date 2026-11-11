// Presupuesto y diagnostico del gate por SHA del scaffold MCP (#1274).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readRepoFile, sliceBetween } from './text-contract.mts'

const AGENT = readRepoFile('agents/mcp-scaffolder.md')
const READY_START = 'echo "Esperando que ${{ inputs.base_url }}/api/ready responda 200..."'
const WARMUP = sliceBetween(AGENT, '- name: Warmup Function App', '- name: Azure Authentication')
const VERSION = sliceBetween(WARMUP, 'if [ -n "$expected_sha" ]; then', READY_START)
const READY = WARMUP.slice(WARMUP.indexOf(READY_START))

function check(description: string, condition: () => boolean): void {
  test(description, () => {
    assert.ok(condition())
  })
}

check('el gate por SHA fija el presupuesto de 420 s', () => VERSION.includes('TIMEOUT_VERSION=420'))
check(
  'el presupuesto del gate por SHA se mide por reloj',
  () =>
    VERSION.includes('INICIO=$SECONDS') && VERSION.includes('while (( SECONDS - INICIO < TIMEOUT_VERSION )); do'),
)
check(
  'el gate por SHA usa un intervalo de 5 s acotado por el tiempo restante',
  () =>
    VERSION.includes('INTERVALO_VERSION=5') &&
    VERSION.includes('espera=$(( restante < INTERVALO_VERSION ? restante : INTERVALO_VERSION ))') &&
    VERSION.includes('sleep "$espera"'),
)
check(
  'cada peticion de version tiene timeout acotado dentro del presupuesto',
  () =>
    VERSION.includes('curl -s --max-time "$timeout_peticion" "${{ inputs.base_url }}/api/version"') &&
    VERSION.includes('timeout_peticion=$(( restante < 15 ? restante : 15 ))'),
)
check(
  'el exito exige el SHA y reporta intentos y segundos reales',
  () =>
    VERSION.includes('[[ "$body" == *"$expected_sha"* ]]') &&
    VERSION.includes('Version OK tras ${intentos} intento(s) (${transcurrido}s)'),
)
check(
  'el agotamiento informa presupuesto, SHA, ultimo cuerpo y URL manual de Kudu',
  () =>
    VERSION.includes('en 420s') &&
    VERSION.includes('Ultimo cuerpo observado:') &&
    VERSION.includes('StartupLogs de Kudu:') &&
    VERSION.includes('startup_logs_url="https://${app_name}.scm.azurewebsites.net/api/vfs/LogFiles/StartupLogs/"'),
)
check(
  'la URL de StartupLogs se deriva de inputs.base_url',
  () =>
    VERSION.includes('app_host="${{ inputs.base_url }}"') &&
    VERSION.includes('app_name="${app_host%.azurewebsites.net}"'),
)
check('Kudu es solo diagnostico y no se consulta', () => {
  const declared = VERSION.indexOf('startup_logs_url')
  return (
    !VERSION.includes('GetAsync(startup_logs_url') &&
    declared !== -1 &&
    !VERSION.slice(declared + 'startup_logs_url'.length).includes('curl')
  )
})
check(
  'el gate por SHA no vuelve al bucle 60 x 2',
  () => !VERSION.includes('seq 1 60') && !VERSION.includes('i*2'),
)
check(
  '/api/ready conserva su presupuesto y timeout independientes',
  () =>
    READY.includes('for i in $(seq 1 60); do') &&
    READY.includes('--max-time 15 "${{ inputs.base_url }}/api/ready"') &&
    READY.includes('Reintentando en 2s') &&
    READY.includes('sleep 2') &&
    READY.includes('Timeout: /api/ready no respondio 200 en 120s'),
)
