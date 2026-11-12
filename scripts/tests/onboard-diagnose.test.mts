import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { CommandResult } from '../lib/cli.mts'
import type { Json, Run } from '../lib/plugin-scopes.mts'
import {
  Checklist,
  GIT_BASH_ACTION,
  checkAppinsightsEnv,
  checkGitBash,
  checkClaudeVersion,
  checkConsumerDirectives,
  checkNodeVersion,
  checkRepoActivation,
  consumerOriginSlug,
  contractSectionHasToken,
  hasContractHeading,
  mefistoPipelineIgnored,
  onboardDiagnose,
  resolveOnboardRuntime,
  secretPresent,
  versionMeets,
} from '../onboard-diagnose.mts'
import { GIT_BASH_DEFAULT } from '../lib/git-bash.mts'
import { isolateGitConfig } from './field-note-sandbox.mts'
import { commitSettings, failed, git, newRepo, ok, writeJson } from './plugin-sandbox.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SCRIPT = join(HERE, '..', 'onboard-diagnose.mts')
const UNREADABLE = { skip: process.platform === 'win32' || process.getuid?.() === 0 }
const SENTINEL = 'APP_ID_CENTINELA_NO_PUBLICAR'
const COMPLETE_AGENTS = [
  '## Tokens del harness',
  '**RootNamespace**: Ejemplo',
  '**SolutionFile**: Ejemplo.sln',
  '**ProjectDisplayName**: Ejemplo',
  '**BoundedContext**: Ejemplo',
  '**BoundedContextDomains**: ejemplo',
  '## Verificación de fuentes (obligatorio para agentes)',
  '',
].join('\n')

let work = ''
let serial = 0
let restoreGit = (): void => {}
const savedCeiling = process.env.GIT_CEILING_DIRECTORIES

function scratch(name: string): string {
  serial++
  const dir = join(work, `${name}-${serial}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto onboard '))
  process.env.GIT_CEILING_DIRECTORIES = work
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
  else process.env.GIT_CEILING_DIRECTORIES = savedCeiling
  rmSync(work, { recursive: true, force: true })
})

describe('Checklist.row', () => {
  function rows(...calls: [string, string][]): { list: Checklist; out: string[] } {
    const out: string[] = []
    const list = new Checklist((line) => out.push(line))
    for (const [state, item] of calls) list.row(state, item)
    return { list, out }
  }

  test('OK y FALTA incrementan solo su contador y respetan el formato fijo', () => {
    const { list, out } = rows(['OK', 'config presente'], ['FALTA', 'faltan labels: dom:x'])
    assert.deepEqual([list.ok, list.falta, list.nv], [1, 1, 0])
    assert.deepEqual(out, ['  [OK           ] config presente', '  [FALTA        ] faltan labels: dom:x'])
  })

  test('cualquier otro estado cuenta y se imprime como NO VERIFICADO', () => {
    for (const state of ['NV', 'algo-no-reconocido']) {
      const { list, out } = rows([state, 'seccion sin verificar'])
      assert.deepEqual([list.ok, list.falta, list.nv], [0, 0, 1], state)
      assert.deepEqual(out, ['  [NO VERIFICADO] seccion sin verificar'])
    }
  })

  test('INFO se imprime sin contar', () => {
    const { list, out } = rows(['INFO', 'dato'])
    assert.deepEqual([list.ok, list.falta, list.nv], [0, 0, 0])
    assert.deepEqual(out, ['  [INFO         ] dato'])
  })

  test('conserva un item de varias palabras', () => {
    assert.deepEqual(rows(['OK', 'el archivo existe y parsea con jq']).out, [
      '  [OK           ] el archivo existe y parsea con jq',
    ])
  })
})

describe('secretPresent', () => {
  // Formato de `gh secret list`: NAME<TAB>UPDATED_AT, a veces con mas columnas.
  const LIST = [
    'AZURE_CLIENT_ID\t2024-01-01T00:00:00Z',
    'AZURE_CLIENT_ID_OLD\t2023-01-01T00:00:00Z',
    'TF_VAR_POSTGRESQL_ADMIN_PASSWORD\tActions\t2024-06-01T00:00:00Z',
  ].join('\n')

  test('detecta un secreto por coincidencia exacta de la primera columna', () => {
    assert.equal(secretPresent(LIST, 'AZURE_CLIENT_ID'), true)
    assert.equal(secretPresent(LIST, 'AZURE_CLIENT_ID_OLD'), true)
  })

  test('no coincide por ser parte de otro nombre', () => {
    assert.equal(secretPresent('AZURE_CLIENT_ID_OLD\t2023-01-01T00:00:00Z', 'AZURE_CLIENT_ID'), false)
  })

  test('no mira las demas columnas', () => {
    assert.equal(secretPresent(LIST, 'Actions'), false)
  })

  test('un secreto ausente se reporta ausente', () => {
    assert.equal(secretPresent(LIST, 'NO_EXISTE'), false)
  })
})

describe('checkConsumerDirectives', () => {
  let dir = ''
  const agents = (): string => join(dir, 'AGENTS.md')
  const claude = (): string => join(dir, 'CLAUDE.md')

  beforeEach(() => {
    dir = scratch('directivas')
    writeFileSync(agents(), COMPLETE_AGENTS)
  })

  function check(agentsState: string, bridgeState: string, needle: string, signals?: [boolean, boolean]): void {
    const found = checkConsumerDirectives(agents(), claude())
    assert.deepEqual([found.agents.state, found.bridge.state], [agentsState, bridgeState])
    assert.ok(`${found.agents.detail}\n${found.bridge.detail}`.includes(needle), `falta el detalle '${needle}'`)
    if (signals !== undefined) assert.deepEqual([found.bridgeHasImport, found.bridgeHasLegacy], signals)
  }

  test('greenfield completo: las dos ubicaciones quedan listas y nada se escribe', () => {
    writeFileSync(claude(), '  @AGENTS.md  \n')
    check('OK', 'OK', 'puente exacto', [true, false])
    assert.equal(readFileSync(agents(), 'utf8'), COMPLETE_AGENTS)
    assert.equal(readFileSync(claude(), 'utf8'), '  @AGENTS.md  \n')
  })

  test('AGENTS.md incompleto mantiene visible el puente correcto', () => {
    writeFileSync(claude(), '@AGENTS.md\n')
    writeFileSync(agents(), '## Tokens del harness\n**RootNamespace**: Ejemplo\n')
    check('FALTA', 'OK', 'BoundedContextDomains')
    assert.equal(
      checkConsumerDirectives(agents(), claude()).agents.detail,
      'AGENTS.md esta incompleto; faltan: encabezado "Verificación de fuentes" SolutionFile ProjectDisplayName BoundedContext BoundedContextDomains',
    )
  })

  test('los tokens deben estar en su seccion contractual', () => {
    writeFileSync(claude(), '@AGENTS.md\n')
    writeFileSync(agents(), COMPLETE_AGENTS.replace('## Tokens del harness\n', '## Tokens del harness\n## Otra sección\n'))
    check('FALTA', 'OK', 'RootNamespace')
  })

  test('una mencion en prosa no es un import', () => {
    writeFileSync(claude(), 'Esta prosa menciona @AGENTS.md pero no lo importa.\n')
    check('OK', 'FALTA', 'linea independiente', [false, false])
  })

  test('un CLAUDE.md ausente tiene su propia accion', () => {
    check('OK', 'FALTA', 'no existe', [false, false])
  })

  test('el fallback legacy explica el estado sin ocultar las dos faltas', () => {
    rmSync(agents())
    writeFileSync(claude(), '## Tokens del harness\n**RootNamespace**: Ejemplo\n## Verificación de fuentes\n')
    check('FALTA', 'FALTA', 'legacy legible', [false, true])
  })

  test('el import exacto no habilita duplicar las secciones canonicas', () => {
    writeFileSync(claude(), '@AGENTS.md\n## Tokens del harness\n## Verificación de fuentes\n')
    check('OK', 'FALTA', 'duplicadas', [true, true])
  })

  test('otras directivas de Claude pueden convivir con el import', () => {
    writeFileSync(claude(), '# Directivas de Claude\nUsa una capacidad exclusiva.\n @AGENTS.md \n')
    check('OK', 'OK', 'sin secciones contractuales duplicadas', [true, false])
  })

  test('un archivo existente pero no legible reporta NO VERIFICADO', UNREADABLE, () => {
    writeFileSync(claude(), '@AGENTS.md\n')
    chmodSync(agents(), 0o000)
    assert.equal(checkConsumerDirectives(agents(), claude()).agents.state, 'NV')
    chmodSync(agents(), 0o644)
    chmodSync(claude(), 0o000)
    assert.equal(checkConsumerDirectives(agents(), claude()).bridge.state, 'NV')
    chmodSync(claude(), 0o644)
  })

  test('bajo otro runtime el puente es informativo', () => {
    const missing = checkConsumerDirectives(agents(), claude(), 'fake').bridge
    assert.deepEqual(missing, {
      state: 'INFO',
      detail:
        'puente CLAUDE.md ausente: solo lo requiere Claude Code; si tu equipo tambien usa Claude, crealo con una linea independiente @AGENTS.md',
    })
    writeFileSync(claude(), 'sin import\n')
    const present = checkConsumerDirectives(agents(), claude(), 'fake').bridge
    assert.equal(present.state, 'INFO')
    assert.match(present.detail, /^opcional \(solo lo requiere Claude Code\): CLAUDE\.md no contiene/)
    writeFileSync(claude(), '@AGENTS.md\n')
    assert.equal(checkConsumerDirectives(agents(), claude(), 'fake').bridge.state, 'OK')
  })

  test('los encabezados admiten sangria, nivel, sufijo entre parentesis y CRLF', () => {
    assert.equal(hasContractHeading('   ###   Tokens del harness (x)  \r\n', 'Tokens del harness'), true)
    assert.equal(hasContractHeading('#\tVerificación de fuentes\t\n', 'Verificación de fuentes'), true)
    assert.equal(hasContractHeading('####### Tokens del harness\n', 'Tokens del harness'), false)
    assert.equal(hasContractHeading('## Tokens del harness y mas\n', 'Tokens del harness'), false)
    assert.equal(hasContractHeading('Tokens del harness\n', 'Tokens del harness'), false)
    const content = '## Tokens del harness (obligatorio)\r\n**Uno**: x\r\n# Otra\n**Dos**: y\n'
    assert.equal(contractSectionHasToken(content, 'Uno'), true)
    assert.equal(contractSectionHasToken(content, 'Dos'), false)
  })
})

describe('mefistoPipelineIgnored', () => {
  test('exige el ignore especifico y rechaza ignorar .mefisto/ completo', () => {
    const repo = newRepo(scratch('ignore'))
    assert.equal(mefistoPipelineIgnored(repo), false, 'sin patron en .gitignore')
    writeFileSync(join(repo, '.gitignore'), '.mefisto/pipeline/\n')
    assert.equal(mefistoPipelineIgnored(repo), true)
    writeFileSync(join(repo, '.gitignore'), '.mefisto/\n')
    assert.equal(mefistoPipelineIgnored(repo), false, 'ocultaria harness.config.json')
    assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), '.mefisto/\n')
  })
})

describe('versiones minimas', () => {
  test('versionMeets compara el primer semver de la salida', () => {
    assert.equal(versionMeets('2.1.287 (Claude Code)', '2.1.287'), 'cumple')
    assert.equal(versionMeets('2.1.288 (Claude Code)', '2.1.287'), 'cumple')
    assert.equal(versionMeets('2.2.0', '2.1.287'), 'cumple')
    assert.equal(versionMeets('3.0.0', '2.1.287'), 'cumple')
    assert.equal(versionMeets('2.1.286', '2.1.287'), 'menor')
    assert.equal(versionMeets('2.0.999', '2.1.287'), 'menor')
    assert.equal(versionMeets('1.9.999', '2.1.287'), 'menor')
    assert.equal(versionMeets('sin version', '2.1.287'), 'sin-version')
    assert.equal(versionMeets('v08.09.010', '8.9.10'), 'cumple')
  })

  test('checkClaudeVersion', () => {
    assert.deepEqual(checkClaudeVersion('claude', '2.1.287 (Claude Code)'), {
      state: 'OK',
      detail: 'Claude Code 2.1.287 >= 2.1.287',
    })
    assert.deepEqual(checkClaudeVersion('claude', '2.1.0 (Claude Code)'), {
      state: 'FALTA',
      detail: 'Claude Code 2.1.0 < 2.1.287 (los mods de hooks/hooks.json requieren >= 2.1.287)',
    })
    assert.equal(checkClaudeVersion('claude', '').state, 'NV')
    for (const output of ['1.0.0', '']) {
      assert.deepEqual(checkClaudeVersion('fake', output), {
        state: 'INFO',
        detail: 'version minima de Claude Code 2.1.287: no aplica bajo el runtime fake',
      })
    }
  })

  test('checkNodeVersion', () => {
    assert.deepEqual(checkNodeVersion('v22.18.0'), { state: 'OK', detail: 'Node 22.18.0 >= 22.18.0' })
    assert.equal(checkNodeVersion('v24.11.1').state, 'OK')
    assert.deepEqual(checkNodeVersion('v22.17.1'), {
      state: 'FALTA',
      detail: 'Node 22.17.1 < 22.18.0: los hooks de Mefisto no corren',
    })
    assert.equal(checkNodeVersion('v20.19.0').state, 'FALTA')
    assert.deepEqual(checkNodeVersion(''), {
      state: 'FALTA',
      detail: 'node no esta en el PATH o su salida no trae version: los hooks de Mefisto no corren',
    })
  })

  test('checkGitBash', () => {
    const only = (...files: string[]) => (path: string) => files.includes(path)
    assert.deepEqual(checkGitBash({}, only(GIT_BASH_DEFAULT)), {
      state: 'OK',
      detail: `Git Bash disponible en ${GIT_BASH_DEFAULT}`,
    })
    assert.deepEqual(checkGitBash({}, only()), {
      state: 'FALTA',
      detail: 'Git for Windows (Git Bash) no esta instalado: Claude Code ejecutaria los comandos de Mefisto con PowerShell',
    })
    assert.deepEqual(checkGitBash({ CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Git\\bin\\bash.exe' }, only(GIT_BASH_DEFAULT)), {
      state: 'FALTA',
      detail: 'CLAUDE_CODE_GIT_BASH_PATH apunta a D:\\Git\\bin\\bash.exe, que no existe',
    })
  })
})

describe('resolveOnboardRuntime', () => {
  const scriptDir = join(REPO_ROOT, 'scripts')

  test('MEFISTO_RUNTIME gana', () => {
    assert.equal(resolveOnboardRuntime({ env: { MEFISTO_RUNTIME: 'fake' }, scriptDir, hasCommand: () => true }), 'fake')
  })

  test('sin MEFISTO_RUNTIME usa el unico adaptador disponible, o claude si no se puede resolver', () => {
    const resolve = (env: NodeJS.ProcessEnv, commands: string[], dir = scriptDir): string =>
      resolveOnboardRuntime({ env, scriptDir: dir, hasCommand: (command) => commands.includes(command) })
    assert.equal(resolve({}, ['claude']), 'claude')
    assert.equal(resolve({ MEFISTO_FAKE_AVAILABLE: '1' }, []), 'fake')
    assert.equal(resolve({ MEFISTO_FAKE_AVAILABLE: '1' }, ['claude']), 'claude', 'varios disponibles')
    assert.equal(resolve({}, []), 'claude', 'ninguno disponible')
    assert.equal(resolve({ MEFISTO_FAKE_AVAILABLE: '1' }, [], join(work, 'sin-libreria')), 'claude')
  })
})

describe('checkRepoActivation', () => {
  const MKT = 'mkt-act'
  const ID = `mefisto@${MKT}`

  test('OK, FALTA y la fila del nivel usuario', () => {
    const configDir = scratch('config')
    const config = { env: { CLAUDE_CONFIG_DIR: configDir }, home: join(work, 'home') }
    const pluginRoot = join(work, 'cache', MKT, 'mefisto', '0.50.0')
    const repo = newRepo(scratch('activacion'))

    writeJson(join(configDir, 'settings.json'), { enabledPlugins: { [ID]: false } })
    assert.deepEqual(checkRepoActivation('claude', repo, pluginRoot, config), {
      state: 'FALTA',
      detail: `.claude/settings.json commiteado no habilita ${ID}: sin el, Mefisto no se carga en este repo cuando esta deshabilitado a nivel usuario`,
      userLevelDetail: '',
    })

    commitSettings(repo, { enabledPlugins: { [ID]: true } })
    assert.deepEqual(checkRepoActivation('claude', repo, pluginRoot, config), {
      state: 'OK',
      detail: `.claude/settings.json commiteado habilita ${ID} (repo y worktrees)`,
      userLevelDetail: '',
    })

    writeJson(join(configDir, 'settings.json'), { enabledPlugins: { [ID]: true } })
    assert.match(checkRepoActivation('claude', repo, pluginRoot, config).userLevelDetail, /habilitado a nivel usuario/)
  })

  test('bajo otro runtime es informativa', () => {
    const config = { env: {}, home: join(work, 'home') }
    assert.deepEqual(checkRepoActivation('fake', '', join(work, 'x'), config), {
      state: 'INFO',
      detail: 'activacion por repositorio: sin verificacion para el runtime fake',
      userLevelDetail: '',
    })
  })
})

describe('checkAppinsightsEnv (issue #2384)', () => {
  const FULL = 'APPINSIGHTS_APP=ai\nAPPINSIGHTS_RG=rg\nSERVICEBUS_NAMESPACE=sb\nSERVICEBUS_RG=rg2\n'
  let repo = ''
  const envFile = (): string => join(repo, '.mefisto', 'appinsights.env')

  beforeEach(() => {
    repo = scratch('appinsights')
    mkdirSync(join(repo, '.mefisto'))
  })

  test('sin archivo: NV en greenfield y FALTA cuando ya hay infra/environments', () => {
    assert.equal(checkAppinsightsEnv(repo).state, 'NV')
    mkdirSync(join(repo, 'infra', 'environments'), { recursive: true })
    const found = checkAppinsightsEnv(repo)
    assert.equal(found.state, 'FALTA')
    assert.match(found.detail, /\/bug.*\/health-check.*\/purge-store/)
  })

  test('archivo completo: OK que nombra el archivo, sin INFO', () => {
    writeFileSync(envFile(), `${FULL}FUNCTIONAPP_NAMES=func-a,func-b\n`)
    const found = checkAppinsightsEnv(repo)
    assert.equal(found.state, 'OK')
    assert.equal(found.info, '')
    assert.match(found.detail, /appinsights\.env/)
  })

  test('FUNCTIONAPP_NAMES ausente o vacio: OK con INFO', () => {
    for (const content of [FULL, `${FULL}FUNCTIONAPP_NAMES=\n`]) {
      writeFileSync(envFile(), content)
      const found = checkAppinsightsEnv(repo)
      assert.equal(found.state, 'OK')
      assert.match(found.info, /FUNCTIONAPP_NAMES/)
    }
  })

  test('claves ausentes o vacias: FALTA con la lista exacta', () => {
    writeFileSync(envFile(), 'APPINSIGHTS_APP=ai\nAPPINSIGHTS_RG=\nSERVICEBUS_RG=rg2\nFUNCTIONAPP_NAMES=f\n')
    assert.deepEqual(checkAppinsightsEnv(repo), {
      state: 'FALTA',
      detail: '.mefisto/appinsights.env incompleto, faltan: APPINSIGHTS_RG, SERVICEBUS_NAMESPACE',
      info: '',
    })
  })

  test('gana la ultima linea de cada clave y se quitan comillas y CR', () => {
    writeFileSync(envFile(), `${FULL}APPINSIGHTS_RG=" "\r\nSERVICEBUS_RG='rg3'\r\n`)
    assert.equal(checkAppinsightsEnv(repo).detail, '.mefisto/appinsights.env incompleto, faltan: APPINSIGHTS_RG')
  })

  test('no ejecuta el archivo ni lo modifica', () => {
    const probe = join(repo, 'ejecutado')
    const content = `${FULL}touch ${probe}\n`
    writeFileSync(envFile(), content)
    checkAppinsightsEnv(repo)
    assert.equal(existsSync(probe), false)
    assert.equal(readFileSync(envFile(), 'utf8'), content)
  })
})

describe('consumerOriginSlug', () => {
  test('deriva owner/repo de remotos SSH y HTTPS, con o sin .git', () => {
    const repo = newRepo(scratch('origin'))
    assert.equal(consumerOriginSlug(repo), '')
    git(repo, 'remote', 'add', 'origin', 'git@github.com:Org/Consumidor.git')
    assert.equal(consumerOriginSlug(repo), 'Org/Consumidor')
    for (const url of ['https://github.com/Org/Consumidor.git', 'https://github.com/Org/Consumidor/', 'ssh://git@github.com/Org/Consumidor']) {
      git(repo, 'remote', 'set-url', 'origin', url)
      assert.equal(consumerOriginSlug(repo), 'Org/Consumidor', url)
    }
  })
})

interface Tools {
  labelsWithoutWarning?: boolean
  apiMode?: 'mefisto' | 'otro' | '404' | 'noauth'
  azAppMode?: 'success' | 'absent' | 'error'
  /** Comandos que resuelven en el PATH; por defecto, todos. */
  available?: string[]
  claudeVersion?: string
  env?: NodeJS.ProcessEnv
  /** Por defecto, `darwin`: el reporte no depende del sistema que corre el test. */
  platform?: NodeJS.Platform
  /** Archivos que existen para la deteccion de Git Bash. */
  gitBashFiles?: string[]
}

interface Diagnosis {
  status: number
  out: string[]
  /** La salida completa, linea por linea. */
  lines: string[]
  text: string
  apiCalls: string[]
  counts: { ok: number; falta: number; nv: number }
}

describe('diagnostico integrado', () => {
  let repo = ''
  let real = ''
  let configDir = ''
  const scriptDir = (): string => join(work, 'paquete', 'scripts')
  const canonical = (): string => join(repo, '.mefisto', 'harness.config.json')
  const legacy = (): string => join(repo, '.claude', 'harness.config.json')

  function baseConfig(extra: Record<string, Json> = {}): Record<string, Json> {
    return {
      projectName: 'Diagnostico',
      namespacePrefix: 'Diagnostico.Dominio',
      solutionFile: 'Diagnostico.slnx',
      githubServicePrincipalName: 'ci-diagnostico',
      domainLabels: ['dominio1'],
      boundedContext: { name: 'Principal', domains: ['dominio1'] },
      secrets: [],
      tenancy: { strategy: 'mono-tenant-transitorio' },
      projections: { enabled: false },
      ...extra,
    }
  }

  function writeConfig(path: string, extra: Record<string, Json> = {}): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(baseConfig(extra), null, 2)}\n`)
  }

  function fakeTools(tools: Tools, apiCalls: string[]): Run {
    return (command, args): CommandResult => {
      if (tools.available?.includes(command) === false) return { status: null, stdout: '', stderr: '' }
      const line = args.join(' ')
      if (command === 'gh' && args[0] === 'label') {
        assert.equal(line, 'label list --json name -q .[].name')
        const labels = [
          'tipo:feature',
          'tipo:infra',
          'tipo:refactor',
          'tipo:tooling',
          'tipo:projection',
          'estado:borrador',
          'estado:listo',
          'bug',
          'bloqueado',
          'dom:dominio1',
        ]
        if (tools.labelsWithoutWarning !== true) labels.push('warning')
        return ok(`${labels.join('\n')}\n`)
      }
      if (command === 'gh' && args[0] === 'api') {
        apiCalls.push(line)
        switch (tools.apiMode ?? 'mefisto') {
          case 'mefisto':
            return ok('{"name":"mefisto"}\n')
          case 'otro':
            return ok('{"name":"otra-cosa"}\n')
          case '404':
            return failed('gh: Not Found (HTTP 404)\n')
          default:
            return failed('gh: Bad credentials (HTTP 401)\n')
        }
      }
      if (command === 'gh' && args[0] === 'secret') {
        const names = ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID', 'TF_VAR_POSTGRESQL_ADMIN_PASSWORD']
        return ok(`${names.map((name) => `${name}\tahora`).join('\n')}\n`)
      }
      if (command === 'az' && args[0] === 'account') return ok()
      if (command === 'az') {
        assert.equal(line, 'ad app list --display-name ci-diagnostico --query [0].appId -o tsv')
        switch (tools.azAppMode ?? 'success') {
          case 'success':
            return ok(`${SENTINEL}\n`)
          case 'absent':
            return ok('None\n')
          default:
            return failed(`ERROR_AZURE_CON_${SENTINEL}\n`)
        }
      }
      if (command === 'claude') return ok(`${tools.claudeVersion ?? '2.1.300 (Claude Code)'}\n`)
      if (command === 'node') return ok('v22.18.0\n')
      return { status: null, stdout: '', stderr: '' }
    }
  }

  function diagnose(tools: Tools = {}, cwd = repo): Diagnosis {
    const out: string[] = []
    const apiCalls: string[] = []
    const status = onboardDiagnose({
      cwd,
      env: { MEFISTO_RUNTIME: 'claude', CLAUDE_CONFIG_DIR: configDir, ...tools.env },
      home: join(work, 'home'),
      scriptDir: scriptDir(),
      hasCommand: (command) => tools.available?.includes(command) ?? true,
      run: fakeTools(tools, apiCalls),
      out: (line) => out.push(line),
      platform: tools.platform ?? 'darwin',
      isFile: (path) => tools.gitBashFiles?.includes(path) ?? false,
    })
    const text = out.join('\n')
    const summary = /Resumen: (\d+) OK \| (\d+) FALTA \| (\d+) NO VERIFICADO/.exec(text)
    return {
      status,
      out,
      lines: text.split('\n'),
      text,
      apiCalls,
      counts: { ok: Number(summary?.[1]), falta: Number(summary?.[2]), nv: Number(summary?.[3]) },
    }
  }

  function setSlug(slug: string): void {
    writeConfig(canonical(), { repoSlug: slug })
  }

  beforeEach(() => {
    repo = newRepo(scratch('consumidor'))
    real = realpathSync.native(repo)
    configDir = scratch('config')
    writeFileSync(join(repo, '.gitignore'), '.mefisto/pipeline/\n')
    for (const dir of ['src', 'tests', join('infra', 'environments')]) mkdirSync(join(repo, dir), { recursive: true })
    writeFileSync(join(repo, 'AGENTS.md'), COMPLETE_AGENTS)
    writeFileSync(join(repo, 'CLAUDE.md'), '@AGENTS.md\n')
    writeConfig(canonical())
  })

  test('el reporte completo de un consumidor configurado', () => {
    writeFileSync(
      join(repo, '.mefisto', 'appinsights.env'),
      'APPINSIGHTS_APP=ai\nAPPINSIGHTS_RG=rg\nSERVICEBUS_NAMESPACE=sb\nSERVICEBUS_RG=rg2\nFUNCTIONAPP_NAMES=f\n',
    )
    commitSettings(repo, { enabledPlugins: { 'mefisto@augusto-romero-arango-harness': true } })
    writeJson(join(configDir, 'settings.json'), {
      enabledPlugins: { 'mefisto@augusto-romero-arango-harness': false },
    })
    const result = diagnose()
    assert.equal(result.status, 0)
    assert.deepEqual(result.lines, [
      '====================================================================',
      '  /onboard - diagnostico del harness (solo lectura)',
      '====================================================================',
      '',
      'Configuracion (harness.config.json efectivo):',
      `  [OK           ] config efectivo ${join(real, '.mefisto', 'harness.config.json')} existe y parsea con jq`,
      '  [OK           ] campos requeridos presentes (projectName, namespacePrefix, solutionFile)',
      "  [OK           ] boundedContext declarado: name='Principal' domains='dominio1'",
      '  [OK           ] terraformStateStorage vacio (consumidor sin IaC; valido)',
      "  [OK           ] repoSlug 'augusto-romero-arango/mefisto' apunta a un repo de Mefisto (default, el config no declara repoSlug)",
      '',
      'Version de Claude Code (minima 2.1.287):',
      '  [OK           ] Claude Code 2.1.300 >= 2.1.287',
      '',
      'Version de Node (minima 22.18.0):',
      '  [OK           ] Node 22.18.0 >= 22.18.0',
      '',
      'Activacion de Mefisto (por repositorio):',
      '  [OK           ] .claude/settings.json commiteado habilita mefisto@augusto-romero-arango-harness (repo y worktrees)',
      '',
      'Directivas del consumidor (AGENTS.md canónico y puente CLAUDE.md):',
      '  [OK           ] AGENTS.md contiene las dos secciones obligatorias y los 5 tokens',
      '  [OK           ] CLAUDE.md contiene el puente exacto @AGENTS.md sin secciones contractuales duplicadas',
      '',
      'Estructura de carpetas esperada (informativo, no bloqueante):',
      '  [OK           ] src/ existe',
      '  [OK           ] tests/ existe',
      '  [OK           ] infra/environments/ existe',
      '',
      'Estado operativo de Mefisto (MEF-ADR-0053):',
      '  [OK           ] .mefisto/pipeline/ esta excluido por .gitignore',
      '  [OK           ] .mefisto/appinsights.env declara APPINSIGHTS_APP, APPINSIGHTS_RG, SERVICEBUS_NAMESPACE y SERVICEBUS_RG',
      '',
      'Labels de GitHub (esquema del harness - MEF-ADR-0007):',
      '  [OK           ] esquema completo (tipo:*, estado:*, dom:*, bug, bloqueado, warning)',
      '',
      'CI hacia Azure (OIDC / Service Principal - MEF-ADR-0022):',
      '  [OK           ] aplicacion de Entra "ci-diagnostico" existe',
      '  [OK           ] secrets OIDC presentes (AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID)',
      '',
      'Secretos que alimentan la siembra en Key Vault (MEF-ADR-0025 -- la siembra la hace CI tras el apply):',
      '  [OK           ] TF_VAR_POSTGRESQL_ADMIN_PASSWORD presente (alimenta marten-connection, MEF-ADR-0025 decision #9)',
      '',
      'Registro harness.config.json > secrets[] (siembra data-driven -- MEF-ADR-0025, issue #256):',
      '  [OK           ] secrets[] registra 0 entrada(s)',
      '',
      'Bifurcacion de dos caminos de auth -- (A) crecer / (B) POC (tenancy.strategy, MEF-ADR-0028):',
      '  [OK           ] tenancy.strategy = mono-tenant-transitorio -- camino (B) POC: sin autenticacion (etapa a)',
      '',
      'Worker de proyecciones (projections.enabled, MEF-ADR-0034):',
      '  [OK           ] projections.enabled=false -- opt-out explicito de proyecciones (valido)',
      '',
      '====================================================================',
      '  Resumen: 22 OK | 0 FALTA | 0 NO VERIFICADO',
      '  Estado: LISTO - el harness esta configurado.',
      '====================================================================',
      '',
      'Proximos pasos (informativo -- no ejecuta nada; los comandos abajo son los que tu corres o confirmas):',
      '  1. El harness esta configurado: arranca (o continua) el dominio con /mefisto:scaffold <dominio>,',
      '     luego /mefisto:draft y /mefisto:implement para tu primer ciclo TDD.',
      '  2. Recordatorio recurrente: la siembra de secretos en Key Vault la hace CI (infra-cd.yml),',
      '     iterando harness.config.json > secrets[] -- MEF-ADR-0025, issue #256. Tu unica accion manual',
      '     es crear/verificar los GitHub secrets que alimentan cada entrada github-secret',
      '     (TF_VAR_POSTGRESQL_ADMIN_PASSWORD, un SB_EXTERNAL_<ALIAS>_CONNECTION_STRING por alias, o el',
      '     que declares con /seed-secret) en Settings > Secrets and variables > Actions.',
      '',
      'Guia narrativa completa del arranque greenfield (10 pasos, roles admin/infra vs dev ongoing):',
      '  https://github.com/augusto-romero-arango/mefisto/blob/main/docs/greenfield-quickstart.md',
      '====================================================================',
    ])
  })

  test('Git Bash: la fila solo aparece en Windows', () => {
    const base = diagnose()
    assert.doesNotMatch(base.text, /Git Bash/)

    const present = diagnose({ platform: 'win32', gitBashFiles: [GIT_BASH_DEFAULT] })
    const at = present.lines.indexOf('Git Bash (Windows):')
    assert.ok(at > present.lines.indexOf('Version de Node (minima 22.18.0):'), 'la seccion va tras la de Node')
    assert.equal(present.lines[at + 1], `  [OK           ] Git Bash disponible en ${GIT_BASH_DEFAULT}`)
    assert.deepEqual(present.counts, { ...base.counts, ok: base.counts.ok + 1 })
    assert.ok(!present.text.includes(GIT_BASH_ACTION.trimEnd()))

    const missing = diagnose({ platform: 'win32' })
    assert.ok(
      missing.lines.includes(
        '  [FALTA        ] Git for Windows (Git Bash) no esta instalado: Claude Code ejecutaria los comandos de Mefisto con PowerShell',
      ),
    )
    assert.deepEqual(missing.counts, { ...base.counts, falta: base.counts.falta + 1 })
    assert.ok(
      missing.lines.includes(
        '  - Instala Git for Windows (https://git-scm.com/downloads/win): Claude Code usa Git Bash para ejecutar los comandos de Mefisto.',
      ),
    )
  })

  test('el config canonico prevalece y no mezcla datos del legacy', () => {
    writeConfig(legacy(), {
      projections: { enabled: true },
      secrets: [{ name: 'legacy-ignorado', source: { type: 'github-secret', value: 'LEGACY_IGNORADO' } }],
      tenancy: { strategy: 'multi-tenant-header' },
    })
    const { text } = diagnose()
    assert.ok(text.includes(`[OK           ] config efectivo ${join(real, '.mefisto', 'harness.config.json')} existe`))
    assert.doesNotMatch(text, /legacy-ignorado/)
    assert.doesNotMatch(text, /multi-tenant-header/)
    assert.ok(text.includes('[OK           ] secrets[] registra 0 entrada(s)'))
    assert.ok(text.includes('[OK           ] tenancy.strategy = mono-tenant-transitorio -- camino (B) POC'))
    assert.ok(text.includes('[OK           ] projections.enabled=false -- opt-out explicito'))
  })

  test('la aplicacion de Entra reporta nombre y estado sin exponer el appId', () => {
    const { lines, text } = diagnose()
    assert.ok(lines.includes('  [OK           ] aplicacion de Entra "ci-diagnostico" existe'))
    assert.doesNotMatch(text, new RegExp(SENTINEL))
  })

  test('sin el label warning se reporta la falta', () => {
    assert.ok(
      diagnose().lines.includes('  [OK           ] esquema completo (tipo:*, estado:*, dom:*, bug, bloqueado, warning)'),
    )
    const missing = diagnose({ labelsWithoutWarning: true })
    assert.ok(missing.lines.includes('  [FALTA        ] faltan labels: warning'))
    assert.ok(missing.text.includes(`"${join(scriptDir(), 'setup-github-labels.mts')}"`))
  })

  test('una aplicacion ausente conserva la FALTA accionable y ajusta solo sus conteos', () => {
    const base = diagnose()
    const absent = diagnose({ azAppMode: 'absent' })
    assert.ok(absent.lines.includes('  [FALTA        ] aplicacion de Entra "ci-diagnostico" no encontrada'))
    assert.ok(absent.text.includes(`${join(scriptDir(), 'setup-github-ci.mts')} <subscription-id>`))
    assert.deepEqual(absent.counts, { ok: base.counts.ok - 1, falta: base.counts.falta + 1, nv: base.counts.nv })
  })

  test('un error de Azure sigue siendo accionable sin filtrar identificadores', () => {
    const { lines, text } = diagnose({ azAppMode: 'error' })
    assert.ok(lines.includes('  [FALTA        ] aplicacion de Entra "ci-diagnostico" no encontrada'))
    assert.ok(text.includes('setup-github-ci.mts <subscription-id>'))
    assert.doesNotMatch(text, new RegExp(SENTINEL))
  })

  describe('repoSlug', () => {
    test('igual al propio origin: FALTA con accion, sin llamar a gh api', () => {
      git(repo, 'remote', 'add', 'origin', 'git@github.com:Org/Consumidor.git')
      setSlug('org/consumidor')
      const ssh = diagnose()
      assert.ok(ssh.text.includes("[FALTA        ] repoSlug 'org/consumidor' apunta al propio consumidor"))
      assert.ok(ssh.text.includes(`Corrige repoSlug en ${join(real, '.mefisto', 'harness.config.json')}`))
      assert.deepEqual(ssh.apiCalls, [])

      git(repo, 'remote', 'set-url', 'origin', 'https://github.com/Org/Consumidor.git')
      assert.ok(diagnose().text.includes("[FALTA        ] repoSlug 'org/consumidor' apunta al propio consumidor"))
    })

    test('plugin.json con name mefisto: OK', () => {
      setSlug('otro/mefisto-fork')
      const result = diagnose()
      assert.ok(result.text.includes("[OK           ] repoSlug 'otro/mefisto-fork' apunta a un repo de Mefisto"))
      assert.deepEqual(result.apiCalls, [
        'api repos/otro/mefisto-fork/contents/.claude-plugin/plugin.json -H Accept: application/vnd.github.raw+json',
      ])
    })

    test('name distinto: FALTA con causa y accion', () => {
      setSlug('otro/mefisto-fork')
      const { text } = diagnose({ apiMode: 'otro' })
      assert.ok(text.includes("[FALTA        ] repoSlug 'otro/mefisto-fork'"))
      assert.ok(text.includes("name 'otra-cosa'"))
      assert.ok(text.includes('Corrige repoSlug en'))
    })

    test('404: FALTA con causa', () => {
      setSlug('otro/mefisto-fork')
      const { text } = diagnose({ apiMode: '404' })
      assert.ok(text.includes("[FALTA        ] repoSlug 'otro/mefisto-fork'"))
      assert.ok(text.includes('no existe o no tiene .claude-plugin/plugin.json'))
    })

    test('gh sin autenticacion: NO VERIFICADO con el motivo de gh', () => {
      setSlug('otro/mefisto-fork')
      const { text } = diagnose({ apiMode: 'noauth' })
      assert.ok(text.includes("[NO VERIFICADO] repoSlug 'otro/mefisto-fork'"))
      assert.ok(text.includes('(gh: Bad credentials (HTTP 401))'))
    })

    test('sin gh: NO VERIFICADO', () => {
      setSlug('otro/mefisto-fork')
      const result = diagnose({ available: ['az', 'claude', 'node'] })
      assert.ok(
        result.lines.includes(
          "  [NO VERIFICADO] repoSlug 'otro/mefisto-fork' (declarado en el config) no verificado: gh no esta instalado",
        ),
      )
      assert.deepEqual(result.apiCalls, [])
    })

    test('sin repoSlug se valida el default', () => {
      const { text } = diagnose()
      assert.ok(
        text.includes("[OK           ] repoSlug 'augusto-romero-arango/mefisto' apunta a un repo de Mefisto (default"),
      )
    })
  })

  test('el fallback legacy conserva el diagnostico sin escribir el config canonico', () => {
    rmSync(canonical())
    writeConfig(legacy(), {
      projections: { enabled: true },
      secrets: [{ name: 'legacy', source: { type: 'github-secret', value: 'LEGACY' } }],
      tenancy: { strategy: 'multi-tenant-header' },
    })
    const { text, lines } = diagnose()
    assert.ok(text.includes(`[OK           ] config efectivo ${join(real, '.claude', 'harness.config.json')} existe`))
    assert.ok(text.includes('[OK           ] secrets[] registra 1 entrada(s)'))
    assert.ok(lines.includes("  [NO VERIFICADO] secrets[].name='legacy': GitHub secret 'LEGACY' no encontrado (crealo antes del proximo apply que lo siembre)"))
    assert.ok(text.includes('[OK           ] tenancy.strategy = multi-tenant-header'))
    assert.ok(text.includes('[NO VERIFICADO] projections.enabled=true, pero el worker'))
    assert.ok(text.includes('/install-auth para instalar WorkOS+APIM (MEF-ADR-0032)'))
    assert.ok(text.includes('corre /scaffold-projections para generarlo (MEF-ADR-0034)'))
    assert.equal(existsSync(canonical()), false)
  })

  test('con el worker de proyecciones presente la fila sale OK', () => {
    writeConfig(canonical(), { projections: { enabled: true } })
    const project = join(repo, 'src', 'Diagnostico.Dominio.Projections')
    mkdirSync(project)
    writeFileSync(join(project, 'Diagnostico.Dominio.Projections.csproj'), '')
    assert.ok(
      diagnose().lines.includes('  [OK           ] projections.enabled=true -- worker Diagnostico.Dominio.Projections presente'),
    )
  })

  test('un canonico invalido falla cerrado sin mezclar el fallback', () => {
    writeConfig(legacy())
    writeFileSync(canonical(), '{ JSON inválido\n')
    const { text, lines } = diagnose()
    assert.ok(lines.includes('  [FALTA        ] configuracion invalida o incompleta'))
    assert.ok(
      lines.includes(
        `                  ERROR: el JSON de ${join(real, '.mefisto', 'harness.config.json')} no es parseable.`,
      ),
    )
    for (const token of ['secrets[]', 'tenancy.strategy', 'projections.enabled']) {
      assert.ok(text.includes(`${token} no verificado porque el config efectivo no pudo cargarse`), token)
    }
    assert.ok(!text.includes(`config efectivo ${join(real, '.claude', 'harness.config.json')} existe`))
    assert.doesNotMatch(text, /parse error/)
  })

  test('un config que parsea pero no valida aun alimenta labels y CI, con el detalle sangrado', () => {
    writeJson(canonical(), {
      projectName: 'P',
      namespacePrefix: 'N',
      solutionFile: 'S',
      githubServicePrincipalName: 'ci-diagnostico',
      domainLabels: ['dominio1', 'zeta'],
    })
    const { lines } = diagnose()
    assert.ok(lines.includes('                      "boundedContext": {'))
    assert.ok(lines.includes('  [FALTA        ] faltan labels: dom:zeta'))
    assert.ok(lines.includes('  [OK           ] aplicacion de Entra "ci-diagnostico" existe'))
  })

  test('la ausencia de ambos configs falla con la ruta canonica', () => {
    rmSync(canonical())
    const { text, lines } = diagnose()
    assert.ok(
      text.includes(`no se encontro el config canonico requerido ${join(real, '.mefisto', 'harness.config.json')}`),
    )
    assert.ok(lines.includes('  [FALTA        ] configuracion invalida o incompleta'))
    assert.ok(text.includes('projections.enabled no verificado porque el config efectivo no pudo cargarse'))
    assert.ok(lines.includes('                  (dom:* no verificado - domainLabels vacio o config no cargada)'))
  })

  // Issue #2384: con infra/environments/ y sin .mefisto/appinsights.env.
  test('appinsights.env ausente da FALTA y paso manual, sin escribir', () => {
    const result = diagnose()
    assert.equal(result.status, 0)
    assert.ok(result.text.includes('[FALTA        ] .mefisto/appinsights.env no existe'))
    const steps = result.text.slice(result.text.indexOf('Proximos pasos'))
    assert.ok(steps.includes('Crea .mefisto/appinsights.env con las cinco claves'))
    assert.ok(steps.includes('/bug, /health-check y /purge-store lo requieren'))
    assert.equal(existsSync(join(repo, '.mefisto', 'appinsights.env')), false)
  })

  test('la activacion ausente sugiere el script del paquete', () => {
    const { lines, text } = diagnose()
    assert.ok(
      lines.includes(
        '  [INFO         ] mefisto@augusto-romero-arango-harness esta habilitado a nivel usuario: se carga en todos tus repos; /mefisto:upgrade ofrece deshabilitarlo a ese nivel',
      ),
    )
    assert.ok(
      lines.includes(
        `  - Habilita Mefisto en este repo: node "${join(scriptDir(), 'onboard-activate-repo.mts')}" --apply (o confirma el paso opt-in) y commitea los archivos que escribe.`,
      ),
    )
    assert.match(text, /Estado: INCOMPLETO - resuelve los FALTA antes de usar los pipelines\./)
  })

  test('bajo otro runtime las filas de Claude son informativas', () => {
    rmSync(join(repo, 'CLAUDE.md'))
    const { lines } = diagnose({ env: { MEFISTO_RUNTIME: 'fake' } })
    assert.ok(lines.includes('  [INFO         ] version minima de Claude Code 2.1.287: no aplica bajo el runtime fake'))
    assert.ok(lines.includes('  [INFO         ] activacion por repositorio: sin verificacion para el runtime fake'))
    assert.ok(lines.some((line) => line.startsWith('  [INFO         ] puente CLAUDE.md ausente')))
    assert.ok(lines.some((line) => / {2}\d+\. Opcional: el puente CLAUDE\.md -> @AGENTS\.md/.test(line)))
  })

  test('sin gh ni az cada seccion queda NO VERIFICADO y el diagnostico termina', () => {
    const result = diagnose({ available: ['claude', 'node'] })
    assert.equal(result.status, 0)
    for (const row of [
      '  [NO VERIFICADO] no se pudieron listar los labels (gh no autenticado / sin repo / version antigua)',
      '  [NO VERIFICADO] Service Principal de CI (Azure CLI no instalado)',
    ]) {
      assert.ok(result.lines.includes(row), row)
    }
  })

  test('el quickstart sale del homepage del paquete', () => {
    const pluginRoot = join(work, 'paquete')
    mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
    writeJson(join(pluginRoot, '.claude-plugin', 'plugin.json'), { homepage: 'https://ejemplo.test/fork/' })
    try {
      assert.ok(diagnose().lines.includes('  https://ejemplo.test/fork/blob/main/docs/greenfield-quickstart.md'))
    } finally {
      rmSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
    }
  })

  test('en el repo de Mefisto o fuera de git aborta por stdout', () => {
    mkdirSync(join(repo, '.claude-plugin'))
    writeFileSync(join(repo, '.claude-plugin', 'plugin.json'), '{}')
    const mefisto = diagnose()
    assert.equal(mefisto.status, 1)
    assert.deepEqual(mefisto.out, [
      'ERROR: /onboard no aplica al repo de Mefisto.',
      '       scripts/onboard-diagnose.mts es del plugin publicado y solo aplica al consumidor.',
    ])

    const outside = diagnose({}, scratch('no-git'))
    assert.equal(outside.status, 1)
    assert.deepEqual(outside.out, ['ERROR: no estas en un repositorio git'])
  })
})

describe('linea de comando', () => {
  test('en el repo de Mefisto termina en 1 con el mensaje por stdout', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stderr, '')
    assert.equal(
      result.stdout,
      'ERROR: /onboard no aplica al repo de Mefisto.\n       scripts/onboard-diagnose.mts es del plugin publicado y solo aplica al consumidor.\n',
    )
  })
})
