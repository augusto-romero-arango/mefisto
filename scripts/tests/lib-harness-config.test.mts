import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { capture, CliError } from '../lib/cli.mts'
import {
  harnessConfigEnv,
  loadHarnessConfig,
  resolveHarnessConfigPath,
  upsertHarnessSecret,
} from '../lib/harness-config.mts'

const BASE = {
  projectName: 'MiControlPlane',
  namespacePrefix: 'MiControlPlane.Dominio',
  solutionFile: 'MiControlPlane.slnx',
  domainLabels: ['dominio1', 'dominio2'],
  boundedContext: { name: 'Principal', domains: ['dominio1'] },
}
const BASE_WITHOUT_BC = {
  projectName: BASE.projectName,
  namespacePrefix: BASE.namespacePrefix,
  solutionFile: BASE.solutionFile,
  domainLabels: BASE.domainLabels,
}
const SB_INTERNAL = { internal: { secretName: 'sb-connection-interno' } }

let tmp = ''
let sequence = 0

before(() => {
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto config ')))
})

after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function writeRaw(content: string, path = join(tmp, `config-${++sequence}.json`)): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function writeConfig(extra: Record<string, unknown> = {}, base: Record<string, unknown> = BASE): string {
  return writeRaw(`${JSON.stringify({ ...base, ...extra }, null, 2)}\n`)
}

function loadError(config?: string, cwd?: string): string {
  try {
    loadHarnessConfig(config, cwd === undefined ? {} : { cwd })
  } catch (error) {
    assert.ok(error instanceof CliError, String(error))
    assert.equal(error.exitCode, 1)
    return error.message
  }
  assert.fail(`la carga de ${config ?? cwd} deberia abortar`)
}

function cliError(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof CliError, String(error))
    assert.equal(error.exitCode, 1)
    return error.message
  }
  assert.fail('deberia abortar')
}

function readSecrets(config: string): unknown {
  return (JSON.parse(readFileSync(config, 'utf8')) as { secrets?: unknown }).secrets
}

function newRepo(): { root: string; canonical: string; legacy: string } {
  const root = join(tmp, `repo-${++sequence}`)
  mkdirSync(join(root, '.mefisto'), { recursive: true })
  mkdirSync(join(root, '.claude'), { recursive: true })
  assert.equal(capture('git', ['init', '-q', root]).status, 0)
  return {
    root,
    canonical: join(root, '.mefisto', 'harness.config.json'),
    legacy: join(root, '.claude', 'harness.config.json'),
  }
}

function configText(projectName = 'MiControlPlane'): string {
  return `${JSON.stringify({ ...BASE, projectName, namespacePrefix: `${projectName}.Dominio` }, null, 2)}\n`
}

test('[CA-1] terraformStateStorage invalido aborta', () => {
  for (const invalid of ['stmicontrolplanetfstatedev', 'stMcpTfstateDev', 'st-mcp-tfstate-dev', 'ab']) {
    assert.match(loadError(writeConfig({ terraformStateStorage: invalid })), /^ERROR: terraformStateStorage='/)
  }
})

test('[CA-2] terraformStateStorage vacio o ausente no dispara el error', () => {
  assert.equal(loadHarnessConfig(writeConfig({ terraformStateStorage: '' })).tfstateStorage, '')
  assert.equal(loadHarnessConfig(writeConfig()).tfstateStorage, '')
})

test('[CA-3] terraformStateStorage valido pasa, tambien en los limites de 3 y 24', () => {
  for (const valid of ['stmcptfstatedev', 'abc', 'abcdefghij0123456789abcd']) {
    assert.equal(loadHarnessConfig(writeConfig({ terraformStateStorage: valid })).tfstateStorage, valid)
  }
})

test('[CA-4] el mensaje indica el limite y sugiere abreviar', () => {
  assert.equal(
    loadError(writeConfig({ terraformStateStorage: 'stmicontrolplanetfstatedev' })),
    [
      "ERROR: terraformStateStorage='stmicontrolplanetfstatedev' no cumple las reglas de Azure Storage Account.",
      '  Debe tener 3-24 caracteres, solo minusculas y digitos ([a-z0-9]).',
      '  Sugerencia: abrevia el prefijo del proyecto (ej. micontrolplane -> mcp -> stmcptfstatedev).',
    ].join('\n'),
  )
})

test('[BC-1] boundedContext ausente aborta con el bloque a anadir', () => {
  const config = writeConfig({}, BASE_WITHOUT_BC)
  assert.equal(
    loadError(config),
    [
      `ERROR: falta 'boundedContext' en ${config} (campo obligatorio, MEF-ADR-0023).`,
      "  El campo 'boundedContext' es requerido por MEF-ADR-0023 (Bounded Context).",
      '  Anade el siguiente bloque a tu harness.config.json:',
      '    "boundedContext": {',
      '      "name": "<NombreDetuBC>",   // ej: Principal, Admin, Core',
      '      "domains": ["dominio1", "dominio2"]',
      '    }',
      '  Los dominios deben ser un subconjunto de tus domainLabels existentes.',
      "  Ver /onboard para diagnostico o docs/migracion-y-versionado.md seccion 'Migracion para consumidores existentes'.",
    ].join('\n'),
  )
})

test('[BC-2] boundedContext valido pasa y entrega nombre y dominios', () => {
  const one = loadHarnessConfig(writeConfig())
  assert.equal(one.bcName, 'Principal')
  assert.deepEqual(one.bcDomains, ['dominio1'])

  const all = loadHarnessConfig(writeConfig({ boundedContext: { name: 'Principal', domains: ['dominio1', 'dominio2'] } }))
  assert.equal(all.bcName, 'Principal')
  assert.deepEqual(all.bcDomains, ['dominio1', 'dominio2'])
  assert.equal(harnessConfigEnv(all).HARNESS_BC_DOMAINS, 'dominio1 dominio2')
})

test('[BC-3] boundedContext.name invalido aborta', () => {
  const empty = writeConfig({ boundedContext: { name: '', domains: ['dominio1'] } })
  assert.equal(
    loadError(empty),
    [
      `ERROR: boundedContext.name esta vacio en ${empty}.`,
      '  Debe ser un string de 1-63 caracteres alfanumericos y guiones (ej: Principal).',
    ].join('\n'),
  )
  for (const name of ['mi bc', 'Mi.BC', 'a'.repeat(64)]) {
    const config = writeConfig({ boundedContext: { name, domains: ['dominio1'] } })
    assert.equal(
      loadError(config),
      [
        `ERROR: boundedContext.name='${name}' no es valido en ${config}.`,
        '  Debe tener 1-63 caracteres alfanumericos y guiones ([a-zA-Z0-9-]).',
      ].join('\n'),
    )
  }
  assert.equal(loadHarnessConfig(writeConfig({ boundedContext: { name: 'a'.repeat(63), domains: ['dominio1'] } })).bcName.length, 63)
})

test('[BC-4] boundedContext.domains vacio o fuera de domainLabels aborta', () => {
  const empty = writeConfig({ boundedContext: { name: 'Principal', domains: [] } })
  assert.equal(
    loadError(empty),
    [
      `ERROR: boundedContext.domains esta vacio en ${empty}.`,
      '  Debe contener al menos un dominio presente en domainLabels.',
    ].join('\n'),
  )
  assert.equal(
    loadError(writeConfig({ boundedContext: { name: 'Principal', domains: ['ventas', 'dominio1', 'compras'] } })),
    [
      'ERROR: boundedContext.domains contiene dominios no declarados en domainLabels:',
      "  'ventas' no esta en domainLabels",
      "  'compras' no esta en domainLabels",
      '  Los dominios del BC deben ser un subconjunto de domainLabels.',
    ].join('\n'),
  )
})

test('[SB-1] serviceBus ausente no aborta y deja el registro vacio', () => {
  const config = loadHarnessConfig(writeConfig())
  assert.equal(config.sbInternalSecret, '')
  assert.deepEqual(config.sbExternal, [])
})

test('[SB-2] serviceBus.internal.secretName vacio o ausente aborta', () => {
  const empty = writeConfig({ serviceBus: { internal: { secretName: '' } } })
  assert.equal(
    loadError(empty),
    [
      `ERROR: serviceBus.internal.secretName esta vacio o ausente en ${empty} (MEF-ADR-0024).`,
      "  Si declaras 'serviceBus', el secreto de Key Vault de la cadena del ASB",
      '  propio del BC (alias reservado INTERNO) es obligatorio. Nunca la cadena',
      '  en claro (MEF-ADR-0024 decision #6). Anade:',
      '    "serviceBus": { "internal": { "secretName": "<nombre-secreto-kv>" } }',
    ].join('\n'),
  )
  assert.match(loadError(writeConfig({ serviceBus: {} })), /^ERROR: serviceBus\.internal\.secretName esta vacio o ausente/)
})

test('[SB-3] serviceBus con internal y external pasa y conserva el orden', () => {
  const config = loadHarnessConfig(
    writeConfig({
      serviceBus: {
        ...SB_INTERNAL,
        external: [
          { alias: 'COSMOS', alcance: 'compartido', secretName: 'sb-connection-cosmos' },
          { alias: 'FACTURACION', alcance: 'externo', secretName: 'sb-connection-facturacion' },
        ],
      },
    }),
  )
  assert.equal(config.sbInternalSecret, 'sb-connection-interno')
  assert.deepEqual(config.sbExternal, [
    { alias: 'COSMOS', alcance: 'compartido', secretName: 'sb-connection-cosmos' },
    { alias: 'FACTURACION', alcance: 'externo', secretName: 'sb-connection-facturacion' },
  ])
  const env = harnessConfigEnv(config)
  assert.equal(env.HARNESS_SB_INTERNAL_SECRET, 'sb-connection-interno')
  assert.equal(env.HARNESS_SB_EXTERNAL_ALIASES, 'COSMOS FACTURACION')
  assert.equal(env.HARNESS_SB_EXTERNAL_ALCANCES, 'compartido externo')
  assert.equal(env.HARNESS_SB_EXTERNAL_SECRETS, 'sb-connection-cosmos sb-connection-facturacion')
})

test('[SB-4] serviceBus con solo internal pasa sin externos', () => {
  const config = loadHarnessConfig(writeConfig({ serviceBus: SB_INTERNAL }))
  assert.equal(config.sbInternalSecret, 'sb-connection-interno')
  assert.deepEqual(config.sbExternal, [])
})

function externalError(entries: unknown[]): { config: string; message: string } {
  const config = writeConfig({ serviceBus: { ...SB_INTERNAL, external: entries } })
  return { config, message: loadError(config) }
}

function externalMessage(config: string, entries: string[]): string {
  return [
    `ERROR: serviceBus.external mal formado en ${config} (MEF-ADR-0024):`,
    ...entries.map((entry) => `  - ${entry}`),
    "  Cada entrada requiere: 'alias' no vacio y distinto de INTERNO (reservado),",
    "  'alcance' en {compartido, externo}, y 'secretName' no vacio (nombre del",
    '  secreto de Key Vault; nunca la cadena en claro).',
  ].join('\n')
}

test('[SB-5] entrada external con alias vacio aborta', () => {
  const { config, message } = externalError([{ alias: '', alcance: 'compartido', secretName: 'sb-x' }])
  assert.equal(message, externalMessage(config, ["entrada #0: 'alias' vacio o ausente"]))
})

test('[SB-6] entrada external con alcance invalido aborta', () => {
  const { config, message } = externalError([{ alias: 'COSMOS', alcance: 'publico', secretName: 'sb-x' }])
  assert.equal(
    message,
    externalMessage(config, ["entrada #0 (alias 'COSMOS'): alcance 'publico' invalido, debe ser 'compartido' o 'externo'"]),
  )
})

test('[SB-7] entrada external con secretName vacio aborta', () => {
  const { config, message } = externalError([{ alias: 'COSMOS', alcance: 'compartido', secretName: '' }])
  assert.equal(message, externalMessage(config, ["entrada #0 (alias 'COSMOS'): 'secretName' vacio o ausente"]))
})

test('[SB-8] el alias reservado INTERNO en external aborta sin distinguir mayusculas', () => {
  const { config, message } = externalError([{ alias: 'Interno', alcance: 'compartido', secretName: 'sb-x' }])
  assert.equal(
    message,
    externalMessage(config, ["entrada #0: alias 'Interno' es el alias reservado INTERNO (ASB propio del BC)"]),
  )
})

test('[SB-9] alias duplicados en external abortan sin distinguir mayusculas', () => {
  const { config, message } = externalError([
    { alias: 'COSMOS', alcance: 'compartido', secretName: 'sb-a' },
    { alias: 'cosmos', alcance: 'externo', secretName: 'sb-b' },
  ])
  assert.equal(message, externalMessage(config, ["entrada #1: alias 'cosmos' duplicado"]))
})

test('serviceBus.external junta todas las entradas invalidas en un solo error', () => {
  const { config, message } = externalError([
    { alcance: 'compartido', secretName: 'sb-x' },
    { alias: 'OK', alcance: 'externo', secretName: 'sb-ok' },
    { alias: 'OTRO', alcance: 'externo' },
  ])
  assert.equal(
    message,
    externalMessage(config, ["entrada #0: 'alias' vacio o ausente", "entrada #2 (alias 'OTRO'): 'secretName' vacio o ausente"]),
  )
})

test('[SEC-1] secrets ausente no aborta y deja el registro vacio', () => {
  assert.deepEqual(loadHarnessConfig(writeConfig()).secrets, [])
})

test('[SEC-2] secrets valido pasa con los tres tipos y conserva el orden', () => {
  const config = loadHarnessConfig(
    writeConfig({
      secrets: [
        { name: 'sb-connection-interno', source: { type: 'output', value: 'service_bus_interno_connection_string' } },
        { name: 'sb-connection-cosmos', source: { type: 'github-secret', value: 'SB_EXTERNAL_COSMOS_CONNECTION_STRING' } },
        { name: 'marten-connection', source: { type: 'composite', value: 'marten-connection' } },
      ],
    }),
  )
  assert.deepEqual(config.secrets, [
    { name: 'sb-connection-interno', type: 'output', value: 'service_bus_interno_connection_string' },
    { name: 'sb-connection-cosmos', type: 'github-secret', value: 'SB_EXTERNAL_COSMOS_CONNECTION_STRING' },
    { name: 'marten-connection', type: 'composite', value: 'marten-connection' },
  ])
  const env = harnessConfigEnv(config)
  assert.equal(env.HARNESS_SECRETS_NAMES, 'sb-connection-interno sb-connection-cosmos marten-connection')
  assert.equal(env.HARNESS_SECRETS_TYPES, 'output github-secret composite')
  assert.equal(
    env.HARNESS_SECRETS_VALUES,
    'service_bus_interno_connection_string SB_EXTERNAL_COSMOS_CONNECTION_STRING marten-connection',
  )
})

function secretsError(secrets: unknown): { config: string; message: string } {
  const config = writeConfig({ secrets })
  return { config, message: loadError(config) }
}

function secretsMessage(config: string, entries: string[]): string {
  return [
    `ERROR: 'secrets' mal formado en ${config} (issue #256):`,
    ...entries.map((entry) => `  - ${entry}`),
    "  Cada entrada requiere: 'name' no vacio y unico, y 'source.type' en",
    "  {output, github-secret, composite} con 'source.value' no vacio.",
  ].join('\n')
}

test("[SEC-3] entrada con 'name' vacio aborta", () => {
  const { config, message } = secretsError([{ name: '', source: { type: 'output', value: 'x' } }])
  assert.equal(message, secretsMessage(config, ["entrada #0: 'name' vacio o ausente"]))
})

test("[SEC-4] entrada con 'source.type' invalido aborta", () => {
  const { config, message } = secretsError([{ name: 'x', source: { type: 'literal', value: 'y' } }])
  assert.equal(
    message,
    secretsMessage(config, [
      "entrada #0 (name 'x'): source.type 'literal' invalido, debe ser 'output', 'github-secret' o 'composite'",
    ]),
  )
})

test("[SEC-5] entrada con 'source.value' vacio aborta", () => {
  const { config, message } = secretsError([{ name: 'x', source: { type: 'output', value: '' } }])
  assert.equal(message, secretsMessage(config, ["entrada #0 (name 'x'): 'source.value' vacio o ausente"]))
})

test("[SEC-6] 'name' duplicado aborta", () => {
  const { config, message } = secretsError([
    { name: 'x', source: { type: 'output', value: 'a' } },
    { name: 'x', source: { type: 'github-secret', value: 'B' } },
  ])
  assert.equal(message, secretsMessage(config, ["entrada #1: name 'x' duplicado"]))
})

test("[SEC-7] 'secrets' que no es un array aborta", () => {
  const { config, message } = secretsError({ name: 'x' })
  assert.equal(message, `ERROR: 'secrets' en ${config} debe ser un array (issue #256).`)
})

test("[UPSERT-1] upsertHarnessSecret crea el array 'secrets' si el config no lo declara", () => {
  const config = writeConfig()
  upsertHarnessSecret('app-insights-connection', 'output', 'app_insights_connection_string', config)
  assert.deepEqual(readSecrets(config), [
    { name: 'app-insights-connection', source: { type: 'output', value: 'app_insights_connection_string' } },
  ])
  assert.equal(
    readFileSync(config, 'utf8'),
    `${JSON.stringify({ ...BASE, secrets: [{ name: 'app-insights-connection', source: { type: 'output', value: 'app_insights_connection_string' } }] }, null, 2)}\n`,
  )
})

test('[UPSERT-2] upsertHarnessSecret agrega una entrada sin tocar las existentes', () => {
  const previous = { name: 'marten-connection', source: { type: 'composite', value: 'marten-connection' } }
  const config = writeConfig({ secrets: [previous] })
  upsertHarnessSecret('sb-connection-cosmos', 'github-secret', 'SB_EXTERNAL_COSMOS_CONNECTION_STRING', config)
  assert.deepEqual(readSecrets(config), [
    previous,
    { name: 'sb-connection-cosmos', source: { type: 'github-secret', value: 'SB_EXTERNAL_COSMOS_CONNECTION_STRING' } },
  ])
})

test("[UPSERT-3] upsertHarnessSecret actualiza por 'name' sin duplicar", () => {
  const config = writeConfig({ secrets: [{ name: 'sb-connection-cosmos', source: { type: 'github-secret', value: 'OLD_NAME' } }] })
  upsertHarnessSecret('sb-connection-cosmos', 'github-secret', 'SB_EXTERNAL_COSMOS_CONNECTION_STRING', config)
  upsertHarnessSecret('sb-connection-cosmos', 'github-secret', 'SB_EXTERNAL_COSMOS_CONNECTION_STRING', config)
  assert.deepEqual(readSecrets(config), [
    { name: 'sb-connection-cosmos', source: { type: 'github-secret', value: 'SB_EXTERNAL_COSMOS_CONNECTION_STRING' } },
  ])
})

test('upsertHarnessSecret aborta sin escribir si el config no existe o secrets no admite entradas', () => {
  const missing = join(tmp, 'no-existe.json')
  assert.equal(cliError(() => upsertHarnessSecret('x', 'output', 'y', missing)), `ERROR: no se encontro ${missing}`)
  assert.equal(existsSync(missing), false)

  const text = writeConfig({ secrets: 'no-es-array' })
  const before = readFileSync(text, 'utf8')
  assert.equal(cliError(() => upsertHarnessSecret('x', 'output', 'y', text)), `ERROR: jq fallo al actualizar 'secrets' en ${text}`)
  assert.equal(readFileSync(text, 'utf8'), before)
})

test('[PROJ-1..4] projections solo queda habilitado con enabled en true', () => {
  assert.equal(loadHarnessConfig(writeConfig()).projectionsEnabled, false)
  assert.equal(loadHarnessConfig(writeConfig({ projections: { enabled: true } })).projectionsEnabled, true)
  assert.equal(loadHarnessConfig(writeConfig({ projections: { enabled: false } })).projectionsEnabled, false)
  assert.equal(loadHarnessConfig(writeConfig({ projections: { enabled: 'yes' } })).projectionsEnabled, false)
  assert.equal(harnessConfigEnv(loadHarnessConfig(writeConfig())).HARNESS_PROJECTIONS_ENABLED, 'false')
  assert.equal(
    harnessConfigEnv(loadHarnessConfig(writeConfig({ projections: { enabled: true } }))).HARNESS_PROJECTIONS_ENABLED,
    'true',
  )
})

test("[PROJ-5] 'projections' que no es objeto no aborta la carga y queda deshabilitado", () => {
  assert.equal(loadHarnessConfig(writeConfig({ projections: true })).projectionsEnabled, false)
  assert.equal(loadHarnessConfig(writeConfig({ projections: 'si' })).projectionsEnabled, false)
  assert.equal(loadHarnessConfig(writeConfig({ projections: [true] })).projectionsEnabled, false)
})

test('[NAM-1] azureRegionShort y resourceSequence ausentes caen a los defaults', () => {
  const config = loadHarnessConfig(writeConfig())
  assert.equal(config.azureRegionShort, '')
  assert.equal(config.resourceSequence, '001')
})

test('[NAM-2] los dos tokens declarados salen tal cual', () => {
  const config = loadHarnessConfig(writeConfig({ azureRegionShort: 'eus2', resourceSequence: '002' }))
  assert.equal(config.azureRegionShort, 'eus2')
  assert.equal(config.resourceSequence, '002')
})

test('[NAM-3] resourceSequence ausente cae a 001 con azureRegionShort declarado', () => {
  const config = loadHarnessConfig(writeConfig({ azureRegionShort: 'eus2' }))
  assert.equal(config.azureRegionShort, 'eus2')
  assert.equal(config.resourceSequence, '001')
})

test('[NAM-4] resourceSequence vacio recibe el trato de ausente', () => {
  const config = loadHarnessConfig(writeConfig({ resourceSequence: '' }))
  assert.equal(config.azureRegionShort, '')
  assert.equal(config.resourceSequence, '001')
})

test('[NAM-5] los tokens de nombramiento nunca abortan la carga ni quedan sin valor', () => {
  const env = harnessConfigEnv(loadHarnessConfig(writeConfig()))
  assert.equal(env.HARNESS_AZURE_REGION_SHORT, '')
  assert.equal(env.HARNESS_RESOURCE_SEQUENCE, '001')
  const declared = harnessConfigEnv(loadHarnessConfig(writeConfig({ azureRegionShort: 'eus2', resourceSequence: '003' })))
  assert.equal(declared.HARNESS_AZURE_REGION_SHORT, 'eus2')
  assert.equal(declared.HARNESS_RESOURCE_SEQUENCE, '003')
})

test('[CFG-1] solo canonica: se resuelve con raiz explicita y desde la raiz Git', () => {
  const { root, canonical } = newRepo()
  writeRaw(configText(), canonical)
  const warnings: string[] = []
  const warn = (message: string): void => void warnings.push(message)

  assert.equal(resolveHarnessConfigPath('read', root, { warn }), canonical)
  mkdirSync(join(root, 'src', 'dominio'), { recursive: true })
  assert.equal(resolveHarnessConfigPath('read', undefined, { cwd: join(root, 'src', 'dominio'), warn }), canonical)
  assert.deepEqual(warnings, [])

  const config = loadHarnessConfig(undefined, { cwd: root })
  assert.equal(config.configPath, canonical)
  assert.equal(config.projectName, 'MiControlPlane')
  assert.equal(config.namespacePrefix, 'MiControlPlane.Dominio')
})

test('[CFG-1] solo legacy: se conserva como fallback de lectura', () => {
  const { root, legacy } = newRepo()
  writeRaw(configText(), legacy)
  assert.equal(resolveHarnessConfigPath('read', root), legacy)
  const config = loadHarnessConfig(undefined, { cwd: root })
  assert.equal(config.configPath, legacy)
  assert.equal(config.projectName, 'MiControlPlane')
})

test('[CFG-1] ambas rutas: gana la canonica y se avisa del legacy ignorado', () => {
  const { root, canonical, legacy } = newRepo()
  writeRaw(configText('Canonico'), canonical)
  writeRaw(configText('LegacyIgnorado'), legacy)
  const warnings: string[] = []
  const config = loadHarnessConfig(undefined, { cwd: root, warn: (message) => void warnings.push(message) })
  assert.equal(config.configPath, canonical)
  assert.equal(config.projectName, 'Canonico')
  assert.equal(config.namespacePrefix, 'Canonico.Dominio')
  assert.deepEqual(warnings, [
    `AVISO: se usara el config canonico ${canonical}; se ignora el legacy ${legacy}. Migra o elimina conscientemente el archivo legacy para evitar divergencias.`,
  ])
  assert.equal(loadHarnessConfig(undefined, { cwd: root }).configPath, canonical)
})

test('[CFG-1] ninguna ruta: aborta nombrando la canonica y el fallback legacy', () => {
  const { root, canonical, legacy } = newRepo()
  const expected = [
    `ERROR: no se encontro el config canonico requerido ${canonical}.`,
    `  Se acepta solo para lectura el fallback legacy ${legacy}.`,
  ].join('\n')
  assert.equal(cliError(() => resolveHarnessConfigPath('read', root)), expected)
  assert.equal(loadError(undefined, root), expected)
})

test('[CFG-2] la ruta explicita gana y se conserva exacta', () => {
  const { canonical, legacy } = newRepo()
  writeRaw(configText(), canonical)
  writeRaw(configText('Override'), legacy)
  const config = loadHarnessConfig(legacy)
  assert.equal(config.configPath, legacy)
  assert.equal(config.projectName, 'Override')
})

test('[CFG-3] un JSON invalido aborta con un unico diagnostico', () => {
  const config = writeRaw('{ invalido\n')
  assert.equal(loadError(config), `ERROR: el JSON de ${config} no es parseable.`)
})

test('[CFG-3] un config ausente aborta mostrando la forma del archivo', () => {
  const config = join(tmp, 'ausente.json')
  assert.equal(
    loadError(config),
    [
      `ERROR: no se encontro ${config}`,
      '  El harness requiere .mefisto/harness.config.json en la raiz',
      '  del proyecto consumidor; .claude/harness.config.json solo se acepta',
      '  como fallback de lectura para consumidores legacy.',
      '  El archivo tiene la forma:',
      '    {',
      '      "projectName": "...",',
      '      "namespacePrefix": "...",',
      '      "solutionFile": "...",',
      '      "infraResourceGroupPrefix": "...",',
      '      "githubServicePrincipalName": "...",',
      '      "appInsightsApp": "...",',
      '      "domainLabels": ["...", "..."],',
      '      "boundedContext": { "name": "<NombreBC>", "domains": ["..."] }',
      '    }',
    ].join('\n'),
  )
})

test('[CFG-4] el modo write resuelve solo la canonica, exista o no', () => {
  const { root, canonical, legacy } = newRepo()
  const warnings: string[] = []
  const warn = (message: string): void => void warnings.push(message)
  assert.equal(resolveHarnessConfigPath('write', root, { warn }), canonical)
  writeRaw(configText(), canonical)
  writeRaw(configText(), legacy)
  assert.equal(resolveHarnessConfigPath('write', root, { warn }), canonical)
  assert.deepEqual(warnings, [])
})

test('[CFG-4] la escritura por defecto modifica solo la canonica aunque exista la legacy', () => {
  const { root, canonical, legacy } = newRepo()
  writeRaw(configText(), canonical)
  writeRaw(configText('Override'), legacy)
  upsertHarnessSecret('canonico', 'output', 'valor', undefined, { cwd: root })
  assert.deepEqual(readSecrets(canonical), [{ name: 'canonico', source: { type: 'output', value: 'valor' } }])
  assert.equal(readFileSync(legacy, 'utf8'), configText('Override'))
})

test('[CFG-4] la escritura con solo legacy aborta sin migrar ni mutar', () => {
  const { root, canonical, legacy } = newRepo()
  writeRaw(configText(), legacy)
  assert.equal(
    cliError(() => upsertHarnessSecret('nuevo', 'output', 'valor', undefined, { cwd: root })),
    [
      `ERROR: solo existe el config legacy ${legacy}; no se modificara.`,
      `  Migra conscientemente el archivo completo a ${canonical} antes de registrar secretos.`,
    ].join('\n'),
  )
  assert.equal(existsSync(canonical), false)
  assert.equal(readFileSync(legacy, 'utf8'), configText())
})

test('[CFG-5] upsertHarnessSecret no reemplaza un JSON invalido', () => {
  const config = writeRaw('{ invalido\n')
  assert.equal(
    cliError(() => upsertHarnessSecret('nuevo', 'output', 'valor', config)),
    `ERROR: el JSON de ${config} no es parseable; no se modifico el archivo.`,
  )
  assert.equal(readFileSync(config, 'utf8'), '{ invalido\n')
})

test('resolveHarnessConfigPath rechaza un modo desconocido, una raiz inexistente y un directorio sin repo', () => {
  assert.equal(
    cliError(() => resolveHarnessConfigPath('borrar' as never, tmp)),
    "ERROR: modo invalido 'borrar'; use read o write.",
  )
  const missing = join(tmp, 'sin-raiz')
  assert.equal(
    cliError(() => resolveHarnessConfigPath('read', missing)),
    `ERROR: la raiz de repositorio no existe: ${missing}`,
  )
  const outside = mkdtempSync(join(tmp, 'sin-repo-'))
  if (capture('git', ['rev-parse', '--show-toplevel'], { cwd: outside }).status !== 0) {
    assert.equal(
      cliError(() => resolveHarnessConfigPath('write', undefined, { cwd: outside })),
      'ERROR: no se pudo resolver la raiz del repositorio Git para harness.config.json.',
    )
  }
})

test('los campos obligatorios ausentes se nombran juntos', () => {
  const config = writeRaw('{ "projectName": "Solo" }\n')
  assert.equal(loadError(config), `ERROR: campos obligatorios ausentes en ${config}: namespacePrefix solutionFile`)
  const empty = writeRaw('')
  assert.equal(loadError(empty), `ERROR: campos obligatorios ausentes en ${empty}: projectName namespacePrefix solutionFile`)
})

test('un config con BOM se lee igual', () => {
  assert.equal(loadHarnessConfig(writeRaw(`\ufeff${configText()}`)).projectName, 'MiControlPlane')
})

test('la carga entrega todos los tokens del proyecto y su equivalente HARNESS_*', () => {
  const path = writeConfig({
    infraResourceGroupPrefix: 'rg-micontrolplane',
    terraformStateStorage: 'stmcptfstatedev',
    githubServicePrincipalName: 'github-micontrolplane-ci',
    appInsightsApp: 'appi-mcp-dev-eus2-001',
  })
  const config = loadHarnessConfig(path)
  assert.deepEqual(config, {
    configPath: path,
    projectName: 'MiControlPlane',
    namespacePrefix: 'MiControlPlane.Dominio',
    solutionFile: 'MiControlPlane.slnx',
    rgPrefix: 'rg-micontrolplane',
    tfstateStorage: 'stmcptfstatedev',
    spName: 'github-micontrolplane-ci',
    appInsightsApp: 'appi-mcp-dev-eus2-001',
    domainLabels: ['dominio1', 'dominio2'],
    bcName: 'Principal',
    bcDomains: ['dominio1'],
    sbInternalSecret: '',
    sbExternal: [],
    secrets: [],
    projectionsEnabled: false,
    azureRegionShort: '',
    resourceSequence: '001',
  })
  assert.deepEqual(harnessConfigEnv(config), {
    HARNESS_CONFIG_PATH: path,
    HARNESS_PROJECT_NAME: 'MiControlPlane',
    HARNESS_NAMESPACE_PREFIX: 'MiControlPlane.Dominio',
    HARNESS_SOLUTION_FILE: 'MiControlPlane.slnx',
    HARNESS_RG_PREFIX: 'rg-micontrolplane',
    HARNESS_TFSTATE_STORAGE: 'stmcptfstatedev',
    HARNESS_SP_NAME: 'github-micontrolplane-ci',
    HARNESS_APP_INSIGHTS_APP: 'appi-mcp-dev-eus2-001',
    HARNESS_DOMAIN_LABELS: 'dominio1 dominio2',
    HARNESS_BC_NAME: 'Principal',
    HARNESS_BC_DOMAINS: 'dominio1',
    HARNESS_SB_INTERNAL_SECRET: '',
    HARNESS_SB_EXTERNAL_ALIASES: '',
    HARNESS_SB_EXTERNAL_ALCANCES: '',
    HARNESS_SB_EXTERNAL_SECRETS: '',
    HARNESS_SECRETS_NAMES: '',
    HARNESS_SECRETS_TYPES: '',
    HARNESS_SECRETS_VALUES: '',
    HARNESS_PROJECTIONS_ENABLED: 'false',
    HARNESS_AZURE_REGION_SHORT: '',
    HARNESS_RESOURCE_SEQUENCE: '001',
  })
})

const HARNESS_VARIABLES = [
  'HARNESS_CONFIG_PATH',
  'HARNESS_PROJECT_NAME',
  'HARNESS_NAMESPACE_PREFIX',
  'HARNESS_SOLUTION_FILE',
  'HARNESS_RG_PREFIX',
  'HARNESS_TFSTATE_STORAGE',
  'HARNESS_SP_NAME',
  'HARNESS_APP_INSIGHTS_APP',
  'HARNESS_DOMAIN_LABELS',
  'HARNESS_BC_NAME',
  'HARNESS_BC_DOMAINS',
  'HARNESS_SB_INTERNAL_SECRET',
  'HARNESS_SB_EXTERNAL_ALIASES',
  'HARNESS_SB_EXTERNAL_ALCANCES',
  'HARNESS_SB_EXTERNAL_SECRETS',
  'HARNESS_SECRETS_NAMES',
  'HARNESS_SECRETS_TYPES',
  'HARNESS_SECRETS_VALUES',
  'HARNESS_PROJECTIONS_ENABLED',
  'HARNESS_AZURE_REGION_SHORT',
  'HARNESS_RESOURCE_SEQUENCE',
]

interface Outcome {
  status: number | null
  stdout: string
  stderr: string
}

/** Corre la funcion y la presenta como un proceso: codigo, stdout y stderr. */
function asProcess(run: (warn: (message: string) => void) => string): Outcome {
  const messages: string[] = []
  let stdout = ''
  let status = 0
  try {
    stdout = run((message) => void messages.push(message))
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    status = error.exitCode
    messages.push(error.message)
  }
  return { status, stdout, stderr: messages.map((message) => `${message}\n`).join('') }
}

interface LoadResult {
  status: number
  env: Record<string, string> | null
  stderr: string
}

/** Codigo, variables HARNESS_* y mensajes de la carga, con la ruta temporal del config cambiada por `<config>`. */
function loadResult(config: string): LoadResult {
  const portablePath = (text: string): string => text.replaceAll(config, '<config>')
  const messages: string[] = []
  const stderr = (): string => portablePath(messages.map((message) => `${message}\n`).join(''))
  try {
    const env = harnessConfigEnv(loadHarnessConfig(config, { cwd: tmp, warn: (message) => void messages.push(message) }))
    return { status: 0, env: Object.fromEntries(HARNESS_VARIABLES.map((name) => [name, portablePath(String(env[name]))])), stderr: stderr() }
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    messages.push(error.message)
    return { status: error.exitCode, env: null, stderr: stderr() }
  }
}

// Configs de ejemplo con cada forma de degradar; su resultado esperado esta en fixtures/harness-config/expected.json.
const EXAMPLE_CONFIGS: Record<string, string> = {
  'valido minimo': JSON.stringify(BASE),
  'valido completo': JSON.stringify({
    ...BASE,
    infraResourceGroupPrefix: 'rg-mcp',
    terraformStateStorage: 'stmcptfstatedev',
    githubServicePrincipalName: 'github-mcp-ci',
    appInsightsApp: 'appi-mcp',
    azureRegionShort: 'eus2',
    resourceSequence: '002',
    projections: { enabled: true },
    serviceBus: {
      ...SB_INTERNAL,
      external: [
        { alias: 'COSMOS', alcance: 'compartido', secretName: 'sb-cosmos' },
        { alias: 'Facturacion', alcance: 'externo', secretName: 'sb-facturacion' },
      ],
    },
    secrets: [
      { name: 'a', source: { type: 'output', value: 'out_a' } },
      { name: 'b', source: { type: 'github-secret', value: 'SECRET_B' } },
      { name: 'c', source: { type: 'composite', value: 'c' } },
    ],
  }),
  'con BOM': `\ufeff${JSON.stringify(BASE)}`,
  'json invalido': '{ invalido\n',
  'archivo vacio': '',
  'solo espacios': ' \n\t\n',
  'raiz null': 'null',
  'raiz arreglo': '[]',
  'raiz texto': '"hola"',
  'sin obligatorios': '{}',
  'falta solutionFile': JSON.stringify({ projectName: 'P', namespacePrefix: 'N' }),
  'projectName null': JSON.stringify({ ...BASE, projectName: null }),
  'projectName false': JSON.stringify({ ...BASE, projectName: false }),
  'projectName numero': JSON.stringify({ ...BASE, projectName: 5 }),
  'projectName booleano': JSON.stringify({ ...BASE, projectName: true }),
  'projectName objeto': JSON.stringify({ ...BASE, projectName: { a: [1, { b: 'x' }], c: {} } }),
  'sin boundedContext': JSON.stringify(BASE_WITHOUT_BC),
  'sin boundedContext ni domainLabels': JSON.stringify({ projectName: 'P', namespacePrefix: 'N', solutionFile: 'S' }),
  'sin boundedContext, domainLabels con null': JSON.stringify({ ...BASE_WITHOUT_BC, domainLabels: ['a', null, 'b'] }),
  'sin boundedContext, domainLabels con numero': JSON.stringify({ ...BASE_WITHOUT_BC, domainLabels: ['a', 5] }),
  'sin boundedContext, domainLabels texto': JSON.stringify({ ...BASE_WITHOUT_BC, domainLabels: 'dominio1' }),
  'boundedContext null': JSON.stringify({ ...BASE, boundedContext: null }),
  'boundedContext texto': JSON.stringify({ ...BASE, boundedContext: 'Principal' }),
  'boundedContext arreglo': JSON.stringify({ ...BASE, boundedContext: [] }),
  'bc name vacio': JSON.stringify({ ...BASE, boundedContext: { name: '', domains: ['dominio1'] } }),
  'bc name con espacio': JSON.stringify({ ...BASE, boundedContext: { name: 'mi bc', domains: ['dominio1'] } }),
  'bc name de 64': JSON.stringify({ ...BASE, boundedContext: { name: 'a'.repeat(64), domains: ['dominio1'] } }),
  'bc name numero': JSON.stringify({ ...BASE, boundedContext: { name: 7, domains: ['dominio1'] } }),
  'bc name de dos lineas': JSON.stringify({ ...BASE, boundedContext: { name: 'Principal\nmi bc', domains: ['dominio1'] } }),
  'bc name arreglo': JSON.stringify({ ...BASE, boundedContext: { name: ['Principal'], domains: ['dominio1'] } }),
  'bc domains vacio': JSON.stringify({ ...BASE, boundedContext: { name: 'P', domains: [] } }),
  'bc domains ausente': JSON.stringify({ ...BASE, boundedContext: { name: 'P' } }),
  'bc domains fuera': JSON.stringify({ ...BASE, boundedContext: { name: 'P', domains: ['ventas', 'dominio2', 'compras'] } }),
  'bc domains texto': JSON.stringify({ ...BASE, boundedContext: { name: 'P', domains: 'dominio1' } }),
  'bc domains cero': JSON.stringify({ ...BASE, boundedContext: { name: 'P', domains: 0 } }),
  'bc domains numero': JSON.stringify({ ...BASE, boundedContext: { name: 'P', domains: 3 } }),
  'bc domains true': JSON.stringify({ ...BASE, boundedContext: { name: 'P', domains: true } }),
  'bc domains objeto': JSON.stringify({ ...BASE, boundedContext: { name: 'P', domains: { a: 'dominio1', b: 'dominio2' } } }),
  'bc domains con null': JSON.stringify({ ...BASE, boundedContext: { name: 'P', domains: [null, 'dominio1'] } }),
  'bc domains con numero': JSON.stringify({ ...BASE, boundedContext: { name: 'P', domains: ['dominio1', 5] } }),
  'bc domains anidado': JSON.stringify({ ...BASE, boundedContext: { name: 'P', domains: [['dominio1']] } }),
  'domainLabels con espacio': JSON.stringify({ ...BASE, domainLabels: ['dominio1 dominio2'], boundedContext: { name: 'P', domains: ['dominio2'] } }),
  'domainLabels objeto': JSON.stringify({ ...BASE, domainLabels: { a: 'dominio1' } }),
  'domainLabels mixto': JSON.stringify({ ...BASE, domainLabels: ['dominio1', null, true, 5] }),
  'domainLabels anidado': JSON.stringify({ ...BASE, domainLabels: [['dominio1']] }),
  'domainLabels con arreglo entre textos': JSON.stringify({ ...BASE, domainLabels: ['dominio1', ['x']] }),
  'valores con salto final': JSON.stringify({ ...BASE, projectName: 'P\n\n', azureRegionShort: 'eus2\n' }),
  'tfstate largo': JSON.stringify({ ...BASE, terraformStateStorage: 'stmicontrolplanetfstatedev' }),
  'tfstate mayusculas': JSON.stringify({ ...BASE, terraformStateStorage: 'stMcp' }),
  'tfstate vacio': JSON.stringify({ ...BASE, terraformStateStorage: '' }),
  'tfstate numero': JSON.stringify({ ...BASE, terraformStateStorage: 12345 }),
  'tfstate de dos lineas': JSON.stringify({ ...BASE, terraformStateStorage: 'abc\nNO VALIDO' }),
  'serviceBus null': JSON.stringify({ ...BASE, serviceBus: null }),
  'serviceBus vacio': JSON.stringify({ ...BASE, serviceBus: {} }),
  'serviceBus arreglo': JSON.stringify({ ...BASE, serviceBus: [] }),
  'serviceBus texto': JSON.stringify({ ...BASE, serviceBus: 'x' }),
  'serviceBus internal texto': JSON.stringify({ ...BASE, serviceBus: { internal: 'x' } }),
  'serviceBus solo internal': JSON.stringify({ ...BASE, serviceBus: SB_INTERNAL }),
  'serviceBus external null': JSON.stringify({ ...BASE, serviceBus: { ...SB_INTERNAL, external: null } }),
  'serviceBus external true': JSON.stringify({ ...BASE, serviceBus: { ...SB_INTERNAL, external: true } }),
  'serviceBus external texto': JSON.stringify({ ...BASE, serviceBus: { ...SB_INTERNAL, external: 'ab' } }),
  'serviceBus external numero': JSON.stringify({ ...BASE, serviceBus: { ...SB_INTERNAL, external: 2 } }),
  'serviceBus external objeto': JSON.stringify({ ...BASE, serviceBus: { ...SB_INTERNAL, external: { a: 1 } } }),
  'serviceBus external con null y texto': JSON.stringify({ ...BASE, serviceBus: { ...SB_INTERNAL, external: [null, 'x'] } }),
  'serviceBus external invalidos': JSON.stringify({
    ...BASE,
    serviceBus: {
      ...SB_INTERNAL,
      external: [
        { alias: '', alcance: 'compartido', secretName: 's' },
        { alias: 'Interno', alcance: 'compartido', secretName: 's' },
        { alias: 'A', alcance: 'publico', secretName: 's' },
        { alias: 'B', alcance: 'externo', secretName: '' },
        { alias: 'C', alcance: 'externo', secretName: 's' },
        { alias: 'c', alcance: 'compartido', secretName: 's' },
        { alias: 9, alcance: 'externo', secretName: 8 },
      ],
    },
  }),
  'secrets null': JSON.stringify({ ...BASE, secrets: null }),
  'secrets objeto': JSON.stringify({ ...BASE, secrets: { name: 'x' } }),
  'secrets texto': JSON.stringify({ ...BASE, secrets: 'x' }),
  'secrets vacio': JSON.stringify({ ...BASE, secrets: [] }),
  'secrets invalidos': JSON.stringify({
    ...BASE,
    secrets: [
      { name: '', source: { type: 'output', value: 'x' } },
      { name: 'a', source: { type: 'literal', value: 'x' } },
      { name: 'b', source: { type: 'output', value: '' } },
      { name: 'c', source: { type: 'output', value: 'x' } },
      { name: 'c', source: { type: 'github-secret', value: 'y' } },
      { name: 'd' },
      { name: 'e', source: 'texto' },
      null,
      'texto',
    ],
  }),
  'projections true': JSON.stringify({ ...BASE, projections: true }),
  'projections enabled texto true': JSON.stringify({ ...BASE, projections: { enabled: 'true' } }),
  'projections enabled yes': JSON.stringify({ ...BASE, projections: { enabled: 'yes' } }),
  'projections enabled 1': JSON.stringify({ ...BASE, projections: { enabled: 1 } }),
  'naming numerico': JSON.stringify({ ...BASE, azureRegionShort: 5, resourceSequence: 7 }),
  'naming false': JSON.stringify({ ...BASE, azureRegionShort: false, resourceSequence: false }),
  'naming objeto': JSON.stringify({ ...BASE, azureRegionShort: {}, resourceSequence: [] }),
}

const UPSERT_CONFIGS: Record<string, string> = {
  'sin secrets': `${JSON.stringify(BASE, null, 2)}\n`,
  'compacto y con secrets en medio': JSON.stringify({ projectName: 'P', secrets: [{ name: 'otro', source: { type: 'output', value: 'o' } }], solutionFile: 'S' }),
  'entrada existente': JSON.stringify({ ...BASE, secrets: [{ name: 'a', source: { type: 'output', value: 'viejo' }, extra: 1 }, { name: 'nuevo', source: { type: 'composite', value: 'viejo' } }, { name: 'nuevo', sobra: true }] }),
  'secrets null': JSON.stringify({ ...BASE, secrets: null }),
  'secrets texto': JSON.stringify({ ...BASE, secrets: 'x' }),
  'secrets objeto con la entrada': JSON.stringify({ ...BASE, secrets: { a: { name: 'nuevo' }, b: { name: 'b' } } }),
  'secrets objeto sin la entrada': JSON.stringify({ ...BASE, secrets: { a: { name: 'a' } } }),
  'secrets con elemento texto': JSON.stringify({ ...BASE, secrets: ['x'] }),
  'secrets con null': JSON.stringify({ ...BASE, secrets: [null] }),
  'valores vacios y anidados': JSON.stringify({ a: {}, b: [], c: [[], {}], d: 'ñ "comillas" \\ \t', e: null, f: true, g: -12 }),
  'raiz null': 'null',
  'raiz arreglo': '[1, 2]',
  'archivo vacio': '',
  'json invalido': '{ invalido',
  'con BOM': `\ufeff${JSON.stringify(BASE)}`,
}

/** El resultado con la ruta temporal del config cambiada por `<config>`. */
function portable(outcome: Outcome, config: string): Outcome {
  const replace = (text: string): string => text.replaceAll(config, '<config>')
  return { status: outcome.status, stdout: replace(outcome.stdout), stderr: replace(outcome.stderr) }
}

function upsertObservation(content: string): { outcome: Outcome; content: string; leftovers: string[]; mode: number } {
  const config = join(tmp, `upsert-${++sequence}.json`)
  writeFileSync(config, content, { mode: 0o644 })
  const outcome = asProcess(() => {
    upsertHarnessSecret('nuevo', 'github-secret', 'VALOR "raro" ñ', config)
    return ''
  })
  const leftovers = readdirSync(dirname(config)).filter((entry) => entry.includes('.tmp'))
  return { outcome: portable(outcome, config), content: readFileSync(config, 'utf8'), leftovers, mode: statSync(config).mode & 0o777 }
}

describe('configs de ejemplo', () => {
  const EXPECTED = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'harness-config', 'expected.json'), 'utf8')) as {
    load: Record<string, LoadResult>
    upsert: Record<string, ReturnType<typeof upsertObservation>>
  }

  test('cada config de ejemplo tiene su resultado esperado', () => {
    assert.deepEqual(Object.keys(EXPECTED.load), Object.keys(EXAMPLE_CONFIGS))
    assert.deepEqual(Object.keys(EXPECTED.upsert), Object.keys(UPSERT_CONFIGS))
  })

  for (const [name, content] of Object.entries(EXAMPLE_CONFIGS)) {
    test(`loadHarnessConfig: ${name}`, () => {
      assert.deepEqual(loadResult(writeRaw(content)), EXPECTED.load[name])
    })
  }

  for (const [name, content] of Object.entries(UPSERT_CONFIGS)) {
    test(`upsertHarnessSecret: ${name}`, () => {
      const expected = EXPECTED.upsert[name] ?? assert.fail(`sin esperado para ${name}`)
      const observed = upsertObservation(content)
      // Windows no tiene los permisos POSIX: alli el modo no se compara.
      if (process.platform === 'win32') observed.mode = expected.mode
      assert.deepEqual(observed, expected)
    })
  }
})

