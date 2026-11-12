// Contrato del agente infra-bootstrap neutral y su proyeccion publicada.

import { describe } from 'node:test'

import { lineOf, repoPath } from '../../../../scripts/tests/text-contract.mts'
import {
  absent,
  agent,
  check,
  contains,
  distributionIsCurrent,
  generatedMarker,
  isRegularFile,
  metadataMatches,
  sameBytes,
  sourceValidates,
} from './agent-contract-kit.mts'

const AGENT = agent('infra-bootstrap')
const { body, claude: claudeBody } = AGENT

describe('[fuente] contrato neutral y perfil', () => {
  check('la fuente valida', () => sourceValidates(repoPath(AGENT.sourcePath)), 'la fuente no valida')
  check(
    'metadata declara agent/infra-bootstrap/all/fast/shell sin mcp',
    () =>
      metadataMatches(AGENT.metadata, {
        equal: { kind: 'agent', id: 'infra-bootstrap', mode: 'all', profile: 'fast', capabilities: ['shell'] },
        keys: ['capabilities', 'description', 'effort', 'id', 'kind', 'mode', 'profile'],
      }),
    'metadata neutral invalida',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(body, '{{mefisto:run azure-account-info.mts 2>&1}}', 'directiva azure-account-info.mts')
  contains(
    body,
    '{{mefisto:run bootstrap-backend.mts --subscription <id> --env <env>}}',
    'directiva bootstrap-backend.mts',
  )
  contains(body, '{{mefisto:run setup-github-labels.mts 2>&1}}', 'directiva setup-github-labels.mts')
  contains(body, '{{mefisto:run setup-github-ci.mts <id>}}', 'directiva setup-github-ci.mts')
  contains(body, '{{mefisto:run launch-pipeline.mts --infra <issue>}}', 'directiva launch-pipeline.mts --infra')
  contains(body, '{{mefisto:command infra-base}}', 'paso 6 remite a infra-base')
  absent(body, 'work-status', 'no remite a work-status')
  contains(body, 'az account set --subscription <id>', 'indica cambiar de suscripcion fuera del chat')
  contains(body, 'az login', 'indica az login ante fallo')
  contains(body, 'Nunca le pidas que escriba el id de suscripción', 'no pide el id al usuario')
  contains(body, 'Application Administrator', 'conserva advertencia de privilegios Entra')
  contains(
    body,
    'Role Based Access Control Administrator',
    'conserva advertencia de privilegios de suscripcion',
  )
  contains(body, 'Solo detente si', 'conserva solo-detente-si-exit-distinto-de-0')
  contains(body, 'idempotente', 'conserva idempotencia por paso')
  contains(
    body,
    'la ruta del log con la línea del visor `stream-watch.mts`',
    'instrucciones de seguimiento sin pane',
  )
  for (const secret of ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID']) {
    contains(body, secret, `reporta secret ${secret}`)
  }
})

describe('[fuente] sin acoplamientos', () => {
  for (const forbidden of [
    'PLUGIN_ROOT',
    '.plugin-root',
    'plugins/cache',
    'PLUGIN_SCRIPTS',
    'az account show',
    'iac-pipeline.mts',
    'Claude',
    '.claude/pipeline',
    'model:',
    'tools:',
    'CLAUDE_',
  ]) {
    absent(body, forbidden, `fuente sin: ${forbidden}`)
  }
})

describe('[fuente] orden de pasos', () => {
  const markers = [
    '### 1. ',
    '### 2. ',
    'azure-account-info.mts',
    'bootstrap-backend.mts --subscription',
    'setup-github-labels.mts 2>&1}}',
    'setup-github-ci.mts <id>}}',
    '### 6. ',
    'launch-pipeline.mts --infra',
    '### 8. ',
  ]
  check(
    'orden backend -> labels -> CI -> base -> pipeline',
    () => {
      let previous = 0
      for (const marker of markers) {
        const line = lineOf(body, marker)
        if (line <= previous) return false
        previous = line
      }
      return true
    },
    'orden de pasos incorrecto',
  )
})

describe('[salidas] adaptador y mirror', () => {
  check(`existe ${AGENT.claudePath}`, () => isRegularFile(repoPath(AGENT.claudePath)), `falta ${AGENT.claudePath}`)
  for (const form of [
    'azure-account-info.mts" 2>&1',
    'bootstrap-backend.mts" --subscription <id> --env <env>',
    'setup-github-labels.mts" 2>&1',
    'setup-github-ci.mts" <id>',
    'launch-pipeline.mts" --infra <issue>',
  ]) {
    contains(
      claudeBody,
      `MEFISTO_RUNTIME=claude node "\${MEFISTO_PACKAGE_ROOT}/scripts/${form}`,
      `Claude invoca ${form} con su runtime`,
    )
  }
  absent(claudeBody, 'az account show', 'salida sin az directo')
  absent(claudeBody, 'iac-pipeline.mts', 'salida sin iac-pipeline.mts directo')
  absent(claudeBody, 'PLUGIN_SCRIPTS', 'salida sin PLUGIN_SCRIPTS')
  absent(claudeBody, 'plugins/cache', 'salida sin cache de plugins')
  absent(claudeBody, '{{mefisto:', 'salida sin directivas sin resolver')
  contains(claudeBody, 'name: "infra-bootstrap"', 'Claude expone el id del agente')
  contains(claudeBody, 'tools: "Bash"', 'Claude deriva solo la capacidad shell')
  contains(claudeBody, 'model: "haiku"', 'Claude materializa el perfil fast')
  check('Claude omite MCP', () => !/[Mm][Cc][Pp]/.test(claudeBody))

  check(
    'mirror Claude coincide byte a byte',
    () => sameBytes(repoPath(AGENT.mirrorPath), repoPath(AGENT.claudePath)),
    'mirror Claude diverge',
  )
  contains(AGENT.mirror, generatedMarker(AGENT.id), 'mirror conserva marcador generado')
  check(
    'generate-published-adapters --check esta al dia',
    distributionIsCurrent,
    'generate-published-adapters --check detecto divergencias',
  )
})
