// Contrato del comando seed-secret neutral y su proyeccion publicada.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { capture } from '../../../../scripts/lib/cli.mts'
import { runScript } from '../../../../scripts/tests/azure-cli-sandbox.mts'
import { isolateGitConfig } from '../../../../scripts/tests/field-note-sandbox.mts'
import { lineOf, repoPath } from '../../../../scripts/tests/text-contract.mts'
import {
  absent,
  absentAll,
  ascending,
  check,
  claudeOutputExists,
  commandContract,
  CONSUMER_GUARD,
  contains,
  generatorIsUpToDate,
  hasExactMetadata,
  inventoryHasDestination,
  isExecutable,
  linesWith,
  mirrorMatches,
  sameBytes,
  soleLine,
  sourceValidates,
} from './command-contract-kit.mts'

const command = commandContract('seed-secret')
const { body, claude, mirror } = command

describe('[fuente] contrato neutral', () => {
  sourceValidates(command)
  hasExactMetadata(
    command,
    {
      profile: 'balanced',
      arguments:
        '<nombre> --domain <Dominio> (--from-output <output> | --from-github-secret <NOMBRE>) [--env <env>]',
    },
    'metadata sin agent ni capabilities',
  )
  contains(body, '{{mefisto:assert-consumer-repo}}', 'guard consumidor presente')
  contains(
    body,
    '{{mefisto:run seed-secret.sh <nombre> --domain <Dominio> --env <env> <flag-de-fuente> <valor>}}',
    'invocacion neutral del script',
  )
  contains(body, 'Registro: <ruta>', 'extrae la linea Registro')
  contains(body, '{{mefisto:command scaffold}}', 'remite a scaffold via directiva command')
  contains(body, '{{mefisto:package-root}}/agents/domain-scaffolder.md', 'molde del HCL via package-root')
  contains(body, '¿Continuar? (s/n)', 'pide confirmacion explicita')
  contains(body, 'git switch -c seed-secret/', 'crea rama si se esta en main')
  contains(body, 'detente sin editar ningun otro archivo', 'se detiene si el script falla')
  contains(body, 'init -backend=false', 'solo init -backend=false')
  contains(body, 'Key Vault Secrets User', 'verifica Secrets User')
  contains(body, 'Nunca toques', 'regla: nunca Secrets Officer')
  contains(body, 'Nunca ejecutes', 'regla: nunca plan/apply')
  contains(body, 'azurerm_key_vault_secret', 'regla: nunca azurerm_key_vault_secret')
  contains(body, 'Nunca crees el dominio', 'regla: nunca crear dominio')
  absentAll(
    body,
    ['.claude/', 'CLAUDE_', '.plugin-root', 'plugins/cache', 'PLUGIN_SCRIPTS', 'PLUGIN_ROOT'],
    (token) => `fuente no publica token prohibido: ${token}`,
  )
  const confirmLine = soleLine(command.source, '¿Continuar? (s/n)')
  check(
    'guard precede la confirmacion',
    () => ascending(soleLine(command.source, CONSUMER_GUARD), confirmLine),
    'guard no precede la confirmacion',
  )
  check(
    'confirmacion precede a cualquier escritura',
    () =>
      ascending(
        confirmLine,
        soleLine(command.source, '{{mefisto:run seed-secret.sh'),
        soleLine(command.source, 'git add'),
      ),
    'confirmacion no precede las escrituras',
  )
})

describe('[salidas] adaptador y mirror', () => {
  claudeOutputExists(command)
  contains(
    claude,
    'MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/seed-secret.sh"',
    'Claude invoca seed-secret.sh con su runtime',
  )
  contains(claude, 'model: "sonnet"', 'Claude materializa el perfil balanced')
  absent(claude, 'plugins/cache', 'Claude sin plugins/cache')
  const invocation = linesWith(claude, 'scripts/seed-secret.sh"')
  absent(invocation, '.plugin-root', 'invocacion Claude sin lookup legacy .plugin-root')
  absent(invocation, 'PLUGIN_SCRIPTS', 'invocacion Claude sin PLUGIN_SCRIPTS')
  contains(claude, '/mefisto:scaffold', 'Claude resuelve command scaffold')
  mirrorMatches(command)
  contains(
    mirror,
    '<!-- GENERADO por src/published/scripts/generate-published-adapters.sh desde src/published/commands/seed-secret.md. No editar a mano. -->',
    'mirror conserva marcador generado',
  )
  const claudeConfirmLine = lineOf(claude, '¿Continuar? (s/n)')
  check(
    `guard antes de la confirmacion en ${command.claudePath}`,
    () =>
      ascending(
        lineOf(claude, 'aborta si existe `src/internal/scripts/generate-internal-adapters.sh`'),
        claudeConfirmLine,
      ),
    `guard no precede la confirmacion en ${command.claudePath}`,
  )
  check(
    `confirmacion antes del script en ${command.claudePath}`,
    () => ascending(claudeConfirmLine, lineOf(claude, 'scripts/seed-secret.sh')),
    `confirmacion no precede al script en ${command.claudePath}`,
  )
})

describe('[assets] seed-secret.sh empaquetado', () => {
  check(
    'seed-secret.sh ejecutable en dist/claude',
    () => isExecutable('dist/claude/scripts/seed-secret.sh'),
    'falta seed-secret.sh ejecutable en dist/claude',
  )
  check(
    'dist/claude identico a la fuente',
    () => sameBytes('scripts/seed-secret.sh', 'dist/claude/scripts/seed-secret.sh'),
    'dist/claude diverge de la fuente',
  )
  check(
    'inventario de dist/claude lo incluye',
    () => inventoryHasDestination('scripts/seed-secret.sh'),
    'inventario de dist/claude no lo incluye',
  )
  test('seed-secret distribuido resuelve sus modulos y responde el uso fuera del checkout', () => {
    const work = mkdtempSync(join(tmpdir(), 'mefisto seed-secret '))
    const restoreGitConfig = isolateGitConfig(work)
    try {
      const repo = join(work, 'consumidor')
      mkdirSync(repo)
      assert.equal(capture('git', ['init', '-q', repo]).status, 0)
      const result = runScript(repoPath('dist/claude/scripts/seed-secret.mts'), [], repo, work)
      const output = result.stdout + result.stderr
      assert.doesNotMatch(
        output,
        /No such file|command not found|unbound variable/,
        'seed-secret distribuido no resuelve sus modulos',
      )
      assert.match(output, /Uso: /, 'seed-secret.sh distribuido no imprimio el uso esperado')
      assert.equal(result.status, 1, `seed-secret.sh distribuido: rc inesperado ${result.status}`)
    } finally {
      restoreGitConfig()
      rmSync(work, { recursive: true, force: true })
    }
  })
  generatorIsUpToDate()
})
