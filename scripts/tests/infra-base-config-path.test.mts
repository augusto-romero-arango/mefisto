// Contratos de config, instrucciones, naming y PostgreSQL de /infra-base (#1212, #1219, #1222,
// #1251, #1517): MEF-ADR-0053 para el prompt de infra-base-scaffolder. Desde #1649 el agente lee
// la ruta efectiva que resuelve su adaptador y el workflow generado lee solo el canonico.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { CliError } from '../lib/cli.mts'
import { resolveHarnessConfigPath } from '../lib/harness-config.mts'
import { NO_BASH, runBashStreams, writeTree } from './markdown-bash.mts'
import { assertContains, lineRanges, linesOf, matchingLines, readRepoFile } from './text-contract.mts'

const AGENT = readRepoFile('agents/infra-base-scaffolder.md')
const COMMAND = readRepoFile('commands/infra-base.md')
const GUIDE = readRepoFile('docs/guia-del-consumidor.md')
const ADR = readRepoFile('docs/adr/mef-adr-0021-infraestructura-base.md')

let work = ''

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto infra-base ')))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

const canonicalOf = (root: string): string => join(root, '.mefisto', 'harness.config.json')
const legacyOf = (root: string): string => join(root, '.claude', 'harness.config.json')

function writeConfig(path: string, project: string, projections: boolean, secret: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({
      projectName: project,
      infraResourceGroupPrefix: `rg-${project}`,
      terraformStateStorage: `st${project}tfstate`,
      azureLocation: `${project}-location`,
      azureRegionShort: `${project}-region`,
      resourceSequence: `${project}-seq`,
      serviceBus: {
        internal: { secretName: secret },
        external: [{ alias: `${project}-bus`, alcance: 'compartido', secretName: `${secret}-external` }],
      },
      projections: { enabled: projections },
      secrets: [{ name: secret, source: { type: 'output', value: `${project}-output` } }],
    })}\n`,
  )
}

function readTokens(path: string): string {
  const config = JSON.parse(readFileSync(path, 'utf8'))
  return [
    config.projectName,
    config.infraResourceGroupPrefix,
    config.terraformStateStorage,
    config.azureLocation,
    config.azureRegionShort,
    config.resourceSequence,
    config.serviceBus.internal.secretName,
    config.serviceBus.external[0].alias,
    config.projections.enabled,
    config.secrets[0].name,
  ].join('|')
}

const CANONICAL_TOKENS =
  'canonical|rg-canonical|stcanonicaltfstate|canonical-location|canonical-region|canonical-seq|canonical-secret|canonical-bus|true|canonical-secret'
const LEGACY_TOKENS =
  'legacy|rg-legacy|stlegacytfstate|legacy-location|legacy-region|legacy-seq|legacy-secret|legacy-bus|false|legacy-secret'

function root(name: string, canonical: boolean, legacy: boolean): string {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  if (canonical) writeConfig(canonicalOf(dir), 'canonical', true, 'canonical-secret')
  if (legacy) writeConfig(legacyOf(dir), 'legacy', false, 'legacy-secret')
  return dir
}

function assertEffective(label: string, dir: string, expected: string): void {
  assert.equal(resolveHarnessConfigPath('read', dir), expected, `${label} esperaba '${expected}'`)
}

function allIn(text: string, needles: string[], message: string): void {
  for (const needle of needles) assertContains(text, needle, message)
}

function range(text: string, start: RegExp, end: RegExp): string {
  return lineRanges(text, start, end).join('\n')
}

test('canonico resuelve la ruta efectiva esperada', () => {
  const dir = root('canonical', true, false)
  assertEffective('canonico', dir, canonicalOf(dir))
})

test('canonico provee todos los tokens y secrets', () => {
  const dir = root('canonical', true, false)
  assert.equal(
    readTokens(resolveHarnessConfigPath('read', dir)),
    CANONICAL_TOKENS,
    'canonico no provee todos los tokens esperados',
  )
})

test('ambos resuelve la ruta efectiva esperada', () => {
  const dir = root('both', true, true)
  assertEffective('ambos', dir, canonicalOf(dir))
})

test('ambos usa exclusivamente tokens y secrets canonicos', () => {
  const dir = root('both', true, true)
  assert.equal(readTokens(resolveHarnessConfigPath('read', dir)), CANONICAL_TOKENS, 'ambos mezclo tokens legacy')
})

test('legacy resuelve la ruta efectiva esperada', () => {
  const dir = root('legacy', false, true)
  assertEffective('legacy', dir, legacyOf(dir))
})

test('legacy provee todos los tokens y secrets mediante el fallback', () => {
  const dir = root('legacy', false, true)
  assert.equal(
    readTokens(resolveHarnessConfigPath('read', dir)),
    LEGACY_TOKENS,
    'legacy no provee todos los tokens esperados',
  )
})

test('ausencia aborta', () => {
  const dir = root('missing', false, false)
  assert.throws(() => resolveHarnessConfigPath('read', dir), CliError, 'ausencia debe abortar')
})

test('los tres bloques del agente usan la ruta efectiva del adaptador y el workflow lee el canonico', () => {
  const counts = {
    repoEfectivo: matchingLines(AGENT, 'CONFIG="${MEFISTO_CONFIG_PATH}"').length,
    repoHardcodeado: matchingLines(AGENT, /CONFIG="\$REPO_ROOT\/\.(mefisto|claude)\/harness\.config\.json"/).length,
    workflowCanonico: matchingLines(AGENT, 'CONFIG="$GITHUB_WORKSPACE/.mefisto/harness.config.json"').length,
    workflowLegacy: matchingLines(AGENT, 'CONFIG="$GITHUB_WORKSPACE/.claude/harness.config.json"').length,
  }
  assert.deepEqual(
    counts,
    { repoEfectivo: 3, repoHardcodeado: 0, workflowCanonico: 1, workflowLegacy: 0 },
    'resolvers inesperados',
  )
})

test('no hay lecturas jq directas del config legacy', () => {
  assert.deepEqual(
    matchingLines(AGENT, /(^|[;&|\s])(jq|json-value\.mts"?)\s.*\.claude\/harness\.config\.json/),
    [],
    'reaparecio una lectura jq directa del config legacy',
  )
})

test('no hay otras lecturas directas del config legacy', () => {
  assert.deepEqual(
    matchingLines(
      AGENT,
      /(^|[;&|\s])(cat|sed|awk|grep|python|python3)\s.*\.claude\/harness\.config\.json|<\s*\S*\.claude\/harness\.config\.json/,
    ),
    [],
    'reaparecio una lectura directa legacy fuera del fallback',
  )
})

test('todas las lecturas jq pasan por la ruta efectiva CONFIG', () => {
  assert.deepEqual(
    matchingLines(AGENT, /(^|[;&|\s])(jq|json-value\.mts"?)\s.*\.(mefisto|claude)\/harness\.config\.json/),
    [],
    'alguna lectura jq evita la ruta efectiva CONFIG',
  )
})

test('tokens del agente y secrets del workflow usan CONFIG y la ausencia aborta', () => {
  allIn(
    AGENT,
    [
      `json-value.mts" pick "$CONFIG" projectName infraResourceGroupPrefix terraformStateStorage azureLocation azureRegionShort resourceSequence serviceBus projections`,
      `COUNT=$(jq -r '.secrets // [] | length' "$CONFIG")`,
      'No se encontro .mefisto/harness.config.json; no se pueden sembrar secretos.',
    ],
    'alguna lectura efectiva o diagnostico de ausencia no usa el contrato resuelto',
  )
})

test('comando documenta contrato canonico sin instruir migracion', () => {
  allIn(
    COMMAND,
    ['.mefisto/harness.config.json', 'fallback de **lectura**', 'sin copiarlo ni migrarlo'],
    'comando no documenta correctamente el contrato',
  )
})

const POSTGRESQL_MODULE_BLOCK = range(AGENT, /^module "postgresql"/, /^}/)
const POSTGRESQL_RECIPE_BLOCK = range(
  AGENT,
  /^### 1\.3 `infra\/modules\/postgresql\/main\.tf`/,
  /^### 1\.4 `infra\/modules\/service-bus\/main\.tf`/,
)
const POSTGRESQL_RECIPE_SERVER_BLOCK = range(
  POSTGRESQL_RECIPE_BLOCK,
  /^resource "azurerm_postgresql_flexible_server" "this"/,
  /^}/,
)

test('el agente declara el sufijo regional exclusivo y el nombre CAF de PostgreSQL', () => {
  const message = 'falta la variable, el local o el nombre regional de PostgreSQL'
  allIn(
    range(AGENT, /^variable "postgresql_region_short"/, /^}/),
    ['variable "postgresql_region_short"', 'default     = "<azure_region_short>"'],
    message,
  )
  assertContains(
    AGENT,
    'postgresql_region_seq_suffix = var.postgresql_region_short != "" ? "-${var.postgresql_region_short}-${var.resource_sequence}" : ""',
    message,
  )
  assertContains(
    POSTGRESQL_MODULE_BLOCK,
    'name                   = "pgsql-${var.project_short}-${var.environment}${local.postgresql_region_seq_suffix}"',
    message,
  )
})

test('PostgreSQL conserva location/zone y los demas recursos conservan los locals primarios', () => {
  const message = 'se altero el aislamiento regional de PostgreSQL o el naming primario'
  allIn(
    POSTGRESQL_MODULE_BLOCK,
    ['location               = var.postgresql_location', 'zone                   = var.postgresql_zone'],
    message,
  )
  assertContains(range(AGENT, /^variable "postgresql_zone"/, /^}/), 'default     = null', message)
  allIn(
    AGENT,
    [
      'prefix      = "${var.project}-${var.environment}${local.region_seq_suffix}"',
      'prefix_func = "${var.project_short}-${var.environment}${local.region_seq_suffix}"',
      'name     = "rg-${local.prefix}"',
      'name                     = local.prefix',
      'name                = "sbns-interno-${local.prefix}"',
      'name                = "kv-${var.project_short}-${var.environment}${local.region_seq_suffix}"',
    ],
    message,
  )
})

test('agente, comando, README y ADR versionan el par regional de CI como defaults HCL', () => {
  const message = 'falta la receta versionada del par postgresql_location/postgresql_region_short'
  allIn(
    AGENT,
    ['defaults versionados', 'infra/environments/<env>/variables.tf', 'runner limpio de CI no lo recibe'],
    message,
  )
  allIn(
    COMMAND,
    [
      'variable "postgresql_location" { default = "centralus" }',
      'variable "postgresql_region_short" { default = "cus" }',
      'variables.tf',
      'solo sirve para overrides locales no versionados',
      'nunca guardes alli postgresql_admin_password ni otro secreto',
    ],
    message,
  )
  allIn(
    GUIDE,
    [
      'variable "postgresql_location" {',
      'default = "centralus"',
      'variable "postgresql_region_short" {',
      'default = "cus"',
      'no altera `location` ni `azure_region_short`',
      'nunca guardes allí `postgresql_admin_password` ni otro secreto',
    ],
    message,
  )
  allIn(
    ADR,
    [
      'default no sensible y versionado de `infra/environments/<env>/variables.tf`',
      '`terraform.tfvars` ignorado queda reservado para overrides locales no versionados',
    ],
    message,
  )
})

test('terraform.tfvars ignorado no se presenta como fuente regional de CI', () => {
  for (const phrase of [
    'juntos en el terraform.tfvars ignorado',
    'ambos overrides no sensibles viven en el `terraform.tfvars` ignorado',
    'revisable en `infra/environments/<env>/terraform.tfvars`',
  ]) {
    for (const text of [AGENT, COMMAND, GUIDE, ADR]) {
      assert.ok(
        !text.includes(phrase),
        'la receta regional vuelve a presentar terraform.tfvars ignorado como fuente de CI',
      )
    }
  }
})

test('la receta conserva create con zone null y protege lifecycle contra el drift de Azure', () => {
  const message = 'la receta PostgreSQL debe conservar default/wiring de zone, prevent_destroy e ignore_changes'
  allIn(range(POSTGRESQL_RECIPE_BLOCK, /^variable "zone"/, /^}/), ['variable "zone"', 'default     = null'], message)
  assertContains(POSTGRESQL_RECIPE_SERVER_BLOCK, 'zone = var.zone', message)
  allIn(
    range(POSTGRESQL_RECIPE_SERVER_BLOCK, /^  lifecycle \{$/, /^  }$/),
    ['prevent_destroy = true', 'ignore_changes  = [zone]'],
    message,
  )
})

test('la receta documenta recomendacion del provider, HA futura y migracion de consumidores', () => {
  allIn(
    POSTGRESQL_RECIPE_BLOCK,
    [
      'high_availability[0].standby_availability_zone',
      'Migracion de modulos ya provisionados',
      'nunca sobrescribe un `.tf` existente',
      'https://github.com/hashicorp/terraform-provider-azurerm/blob/main/website/docs/r/postgresql_flexible_server.html.markdown',
    ],
    'la receta debe documentar provider, standby de HA y migracion de modulos existentes',
  )
})

test('el agente no presenta CLAUDE.md como fuente directa de tokens', () => {
  assert.ok(
    !AGENT.includes('CLAUDE.md raiz') && !AGENT.includes('Lee ademas `CLAUDE.md`'),
    'el agente vuelve a presentar CLAUDE.md como fuente directa de tokens',
  )
})

test('RootNamespace se deriva solo del archivo efectivo de instrucciones', () => {
  assert.deepEqual(
    matchingLines(
      AGENT,
      /derivacion desde `?CLAUDE\.md`?|CLAUDE\.md.*token `?RootNamespace`?|token `?RootNamespace`?.*CLAUDE\.md/,
    ),
    [],
    'RootNamespace vuelve a leerse desde CLAUDE.md fuera del fallback',
  )
})

test('el Paso 5 no pide declarar RootNamespace en CLAUDE.md', () => {
  assert.deepEqual(
    matchingLines(AGENT, /declare `?RootNamespace`?.*CLAUDE\.md|CLAUDE\.md.*declare `?RootNamespace`?/),
    [],
    'el Paso 5 vuelve a pedir declarar RootNamespace en CLAUDE.md',
  )
})

test('CLAUDE.md queda confinado al bloque literal de fallback', () => {
  let insideResolver = false
  const outside = linesOf(AGENT).filter((line) => {
    if (line === 'if [ -f "AGENTS.md" ]; then') {
      insideResolver = true
      return false
    }
    if (insideResolver && line === 'export MEFISTO_INSTRUCTIONS_PATH') {
      insideResolver = false
      return false
    }
    return !insideResolver
  })
  assert.deepEqual(
    outside.filter((line) => line.includes('CLAUDE.md')),
    [],
    'CLAUDE.md aparece fuera del bloque literal de fallback',
  )
})

test('la alerta usa el token efectivo y conserva la omision acotada y su diagnostico canonico', () => {
  allIn(
    AGENT,
    [
      'projections_service_name',
      '`${MEFISTO_INSTRUCTIONS_PATH}`',
      'omite **solo** el recurso de la alerta',
      'declarar `RootNamespace` en `AGENTS.md`, seccion "Tokens del harness"',
    ],
    'falta el contrato que conecta RootNamespace efectivo con la alerta de proyecciones',
  )
})

// El resolver de instrucciones del prompt, ejecutado con bash: el service.name de la alerta
// (`<RootNamespace>.Projections`) sale solo del archivo efectivo.
describe('[ejecucion] instrucciones efectivas para RootNamespace', { skip: NO_BASH }, () => {
  const resolver = lineRanges(AGENT, /^if \[ -f "AGENTS\.md" \]; then$/, /^export MEFISTO_INSTRUCTIONS_PATH$/)[0] ?? ''
  const script =
    `${resolver}\n` +
    `root_namespace=$(awk -F '[:][[:space:]]*' '$1 == "RootNamespace" { print $2; exit }' "$MEFISTO_INSTRUCTIONS_PATH")\n` +
    `printf "%s|%s.Projections\\n" "$MEFISTO_INSTRUCTIONS_PATH" "$root_namespace"`
  const tokens = (rootNamespace: string): string => `## Tokens del harness\nRootNamespace: ${rootNamespace}\n`
  const resolve = (name: string, files: Record<string, string>) =>
    runBashStreams(script, writeTree(join(work, `instrucciones-${name}`), files))
  const WARNING = 'AVISO: se usara AGENTS.md; se ignora el legacy CLAUDE.md.'

  test('se extrae el resolver de instrucciones del agente', () => {
    assertContains(resolver, 'export MEFISTO_INSTRUCTIONS_PATH')
  })

  test('canonico resuelve desde AGENTS.md el service.name de la alerta y conserva visible el aviso', () => {
    const result = resolve('canonico', { 'AGENTS.md': tokens('Canonical'), 'CLAUDE.md': '@AGENTS.md\n' })
    assert.deepEqual([result.status, result.stdout], [0, 'AGENTS.md|Canonical.Projections\n'])
    assertContains(result.stderr, WARNING)
  })

  test('solo legacy resuelve el service.name desde CLAUDE.md como fallback de lectura', () => {
    assert.deepEqual(resolve('legacy', { 'CLAUDE.md': tokens('Legacy') }), {
      status: 0,
      stdout: 'CLAUDE.md|Legacy.Projections\n',
      stderr: '',
    })
  })

  test('coexistencia usa el RootNamespace canonico para la alerta y avisa que ignora el legacy', () => {
    const result = resolve('ambos', { 'AGENTS.md': tokens('Canonical'), 'CLAUDE.md': tokens('Legacy') })
    assert.deepEqual([result.status, result.stdout], [0, 'AGENTS.md|Canonical.Projections\n'])
    assertContains(result.stderr, WARNING)
  })

  test('ausencia de instrucciones aborta y remite a onboard', () => {
    const result = resolve('ausente', {})
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    assertContains(result.stderr, '/mefisto:onboard')
  })
})
