import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  changedFilesText,
  detectSmokeOnly,
  listSmokesInvokingRoutes,
  listSmokesInvokingTools,
  smokeInvokersText,
  smokeToolName,
} from '../lib/pipeline/smokes.mts'
import { writeIn } from './consumer-sandbox.mts'
import { git, isolateGitConfig } from './field-note-sandbox.mts'

const SMOKE = 'tests/Acme.Dominio.SmokeTests/FooSmokeTests.cs'

let work = ''
let counter = 0
let restoreGit = (): void => {}

interface Repo {
  root: string
  snapshot: string
}

function newRepo(): Repo {
  const root = join(work, `repo-${counter++}`)
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  writeIn(root, 'README.md', 'base\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'base')
  return { root, snapshot: git(root, 'rev-parse', 'HEAD') }
}

function commit(root: string, ...files: string[]): void {
  for (const file of files) writeIn(root, file, 'x\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'c')
}

interface SmokeCase {
  name: string
  committed: string[]
  uncommitted?: string[]
  committedOnly?: boolean
  smokeOnly: boolean
}

const SMOKE_ONLY_CASES: SmokeCase[] = [
  { name: 'solo SmokeTests', committed: [SMOKE], smokeOnly: true },
  { name: 'SmokeTests y docs/adr', committed: [SMOKE, 'docs/adr/mef-adr-0099-x.md'], smokeOnly: true },
  { name: 'SmokeTests y src/', committed: [SMOKE, 'src/Acme.Dominio/Foo.cs'], smokeOnly: false },
  { name: 'solo docs/', committed: ['docs/adr/x.md'], smokeOnly: false },
  { name: 'tests unitarios y SmokeTests', committed: [SMOKE, 'tests/Acme.Dominio.Tests/FooTests.cs'], smokeOnly: false },
  { name: 'committedOnly ignora lo que esta sin commitear', committed: [SMOKE], uncommitted: ['src/Acme.Dominio/Sucio.cs'], committedOnly: true, smokeOnly: true },
  { name: 'sin committedOnly ve los archivos nuevos', committed: [SMOKE], uncommitted: ['src/Acme.Dominio/Sucio.cs'], smokeOnly: false },
  { name: 'smoke sin commitear y pipeline-state', committed: [], uncommitted: [SMOKE, 'pipeline-state/x.md'], smokeOnly: true },
  { name: 'sin cambios', committed: [], smokeOnly: false },
  { name: 'smoke de otro prefijo', committed: ['tests/Otra.Dominio.SmokeTests/X.cs'], smokeOnly: false },
  { name: 'orden por bytes y rutas parecidas', committed: [SMOKE, 'tests/Acme.B.SmokeTests/b.cs', 'tests/Acme.A.SmokeTests/Z.cs', 'tests/Acme.A.SmokeTests/a.cs', 'docs/a.md', 'documentos/x.md', 'tests/Acme.SmokeTests/x.cs'], smokeOnly: false },
]

function repoFor(item: SmokeCase): Repo {
  const repo = newRepo()
  if (item.committed.length > 0) commit(repo.root, ...item.committed)
  for (const file of item.uncommitted ?? []) writeIn(repo.root, file, 'x\n')
  return repo
}

const TOOL_SRC = 'src/Acme.Mcp.Asistente'
const TOOL_SMOKES = 'tests/Acme.Mcp.Asistente.SmokeTests'

function toolsFixture(): string {
  const root = join(work, `tools-${counter++}`)
  const files: Record<string, string> = {
    [`${TOOL_SRC}/CrearPlantillaSemanalTool.cs`]: 'internal const string NombreTool = "crear_plantilla_semanal";\n',
    [`${TOOL_SRC}/SinNombreTool.cs`]: '[McpToolTrigger("x", "desc")]\n',
    [`${TOOL_SRC}/SinNadaTool.cs`]: 'public class Nada {}\n',
    [`${TOOL_SRC}/NombreVacioTool.cs`]: 'const string NombreTool = "";\n[McpToolTrigger( "por_trigger", "desc")]\n',
    [`${TOOL_SRC}/DosNombresTool.cs`]: '// NombreTool = "viejo"; NombreTool\t=\t"otra_tool"; resto\r\nconst string NombreTool = "tercero";\n',
    [`${TOOL_SMOKES}/CrearPlantillaSemanal/CrearSmokeTests.cs`]: 'CallToolAsync("crear_plantilla_semanal", a);\n',
    [`${TOOL_SMOKES}/AsignarTurnoADia/AsignarSmokeTests.cs`]: 'CallToolAsync("crear_plantilla_semanal", a);\n',
    [`${TOOL_SMOKES}/BuscarPlantillas/BuscarSmokeTests.cs`]: 'CallToolAsync("crear_plantilla_semanal", a);\n',
    [`${TOOL_SMOKES}/Otra/OtraSmokeTests.cs`]: 'CallToolAsync("otra_tool", a);\n',
    [`${TOOL_SMOKES}/Otra/XSmokeTests.cs`]: 'CallToolAsync("x", a);\n',
    [`${TOOL_SMOKES}/Otra/notas.txt`]: 'CallToolAsync("x", a);\n',
    [`${TOOL_SMOKES}/.oculta/Oculto.cs`]: 'CallToolAsync("x", a);\n',
    [`${TOOL_SMOKES}/Raiz.cs`]: 'CallToolAsync("x", a); CallToolAsync("por_trigger", a);\n',
  }
  for (const [file, content] of Object.entries(files)) writeIn(root, file, content)
  return root
}

const ROUTE_ENDPOINTS = [
  'src/N.Programacion/F/AgregarFranja/FunctionEndpoint.cs',
  'src/N.Colab/F/Listar/FunctionEndpoint.cs',
  'src/N.Colab/F/Bus/FunctionEndpoint.cs',
]
const FRANJA = 'programacion/turnos/{id}:agregar-franja'

function routesFixture(): string {
  const root = join(work, `routes-${counter++}`)
  const files: Record<string, string> = {
    [ROUTE_ENDPOINTS[0] ?? '']: `[Function("A")] public Task R([HttpTrigger(AuthorizationLevel.Function, "post", Route = "${FRANJA}")] HttpRequest r) => null;\n`,
    [ROUTE_ENDPOINTS[1] ?? '']: '[Function("L")] public Task R([HttpTrigger(AuthorizationLevel.Function, "get", Route = "colaboradores")] HttpRequest r) => null;\n',
    [ROUTE_ENDPOINTS[2] ?? '']: '[Function("B")] public Task R([ServiceBusTrigger("t", "s")] string m) => null;\n',
    'src/N.Otro/Varias/FunctionEndpoint.cs':
      '[ HttpTrigger(\r\n    AuthorizationLevel.Function, "get",\r\n    Route = "/reportes/{anio}/{mes}/" ) ] HttpRequest a,\r\n[HttpTrigger(AuthorizationLevel.Function, "get", Route="colaboradores")] HttpRequest b,\n[HttpTrigger(AuthorizationLevel.Function, "get", Route = "a.b/(c)/{x")] HttpRequest c\n',
    'tests/N.Otro.SmokeTests/Literal.cs': `await c.PostAsJsonAsync($"/api/programacion/turnos/{id}:agregar-franja", b);\nawait c.GetAsync("/api/Colaboradores");\n`,
    'tests/N.Mcp.X.SmokeTests/Mcp.cs': 'await c.PostAsJsonAsync("/api/programacion/turnos/abc:agregar-franja", b);\n',
    'tests/N.Programacion.SmokeTests/Compuesta.cs':
      'private const string RutaTurnos = "/api/programacion/turnos";\nawait c.PostAsJsonAsync($"{RutaTurnos}/{turnoId}:agregar-franja", b);\n',
    'tests/N.Programacion.SmokeTests/Otra.cs': 'await c.GetAsync($"/api/programacion/turnos/{id}");\n',
    'tests/N.Programacion.SmokeTests/Sub/Dir/Anidada.cs':
      'const string Base = "/api";\r\nconst string Reportes = $"{Base}/reportes";\r\nconst string Año = "2026";\r\nvar a = $"{Reportes}/{Año}/08?x=1";\r\nvar b = "/API/COLABORADORES?activo=true";\r\nvar c = "/api/colaboradores/extra";\r\nvar d = "/api/a.b/(c)/{x";\r\nvar e = "/api/aXb/(c)/1";\n',
    'tests/N.Programacion.SmokeTests/.oculta/Oculta.cs': 'await c.GetAsync("/api/colaboradores");\n',
    'tests/N.Programacion.SmokeTests/.Oculto.cs': 'await c.GetAsync("/api/colaboradores");\n',
    'tests/N.Programacion.SmokeTests/notas.txt': 'await c.GetAsync("/api/colaboradores");\n',
    'tests/N.Programacion.Tests/Unit.cs': 'await c.GetAsync("/api/colaboradores");\n',
    'tests/.Oculto.SmokeTests/X.cs': 'await c.GetAsync("/api/colaboradores");\n',
  }
  for (const [file, content] of Object.entries(files)) writeIn(root, file, content)
  return root
}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto smokes '))
  restoreGit = isolateGitConfig(work)
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true })
})

describe('detectSmokeOnly', () => {
  for (const item of SMOKE_ONLY_CASES) {
    test(`${item.name}: ${item.smokeOnly ? 'si' : 'no'}`, () => {
      const repo = repoFor(item)
      assert.equal(detectSmokeOnly(repo.root, repo.snapshot, 'Acme', item.committedOnly ?? false).smokeOnly, item.smokeOnly)
    })
  }

  test('lista cada archivo con su clase', () => {
    const repo = repoFor({ name: '', committed: [SMOKE, 'src/Acme.Dominio/Foo.cs', 'docs/x.md'], smokeOnly: false })
    const detection = detectSmokeOnly(repo.root, repo.snapshot, 'Acme')
    assert.deepEqual(detection.files, [
      { kind: 'docs', path: 'docs/x.md' },
      { kind: 'otro', path: 'src/Acme.Dominio/Foo.cs' },
      { kind: 'smoke', path: SMOKE },
    ])
    assert.equal(changedFilesText(detection.files), `docs: docs/x.md\notro: src/Acme.Dominio/Foo.cs\nsmoke: ${SMOKE}\n`)
  })

  test('ordena por bytes y solo el prefijo exacto con .SmokeTests cuenta como smoke', () => {
    const repo = repoFor(SMOKE_ONLY_CASES.find((item) => item.name === 'orden por bytes y rutas parecidas') ?? assert.fail('sin caso'))
    assert.equal(
      changedFilesText(detectSmokeOnly(repo.root, repo.snapshot, 'Acme').files),
      [
        'docs: docs/a.md',
        'otro: documentos/x.md',
        'smoke: tests/Acme.A.SmokeTests/Z.cs',
        'smoke: tests/Acme.A.SmokeTests/a.cs',
        'smoke: tests/Acme.B.SmokeTests/b.cs',
        `smoke: ${SMOKE}`,
        'otro: tests/Acme.SmokeTests/x.cs',
        '',
      ].join('\n'),
    )
  })

  test('pipeline-state cuenta como docs, y con committedOnly lo sin commitear no cuenta', () => {
    const repo = repoFor(SMOKE_ONLY_CASES.find((item) => item.name === 'smoke sin commitear y pipeline-state') ?? assert.fail('sin caso'))
    assert.equal(changedFilesText(detectSmokeOnly(repo.root, repo.snapshot, 'Acme').files), `docs: pipeline-state/x.md\nsmoke: ${SMOKE}\n`)
    assert.deepEqual(detectSmokeOnly(repo.root, repo.snapshot, 'Acme', true), { smokeOnly: false, files: [] })
  })

  test('un snapshot invalido no falla: solo cuenta lo que esta sin commitear', () => {
    const repo = repoFor({ name: '', committed: ['src/x.cs'], uncommitted: [SMOKE], smokeOnly: true })
    assert.deepEqual(detectSmokeOnly(repo.root, 'deadbeef', 'Acme'), { smokeOnly: true, files: [{ kind: 'smoke', path: SMOKE }] })
  })
})

describe('listSmokesInvokingTools', () => {
  let root = ''

  before(() => {
    root = toolsFixture()
  })

  test('smokeToolName: NombreTool y, si no esta, McpToolTrigger', () => {
    assert.equal(smokeToolName(join(root, TOOL_SRC, 'CrearPlantillaSemanalTool.cs')), 'crear_plantilla_semanal')
    assert.equal(smokeToolName(join(root, TOOL_SRC, 'SinNombreTool.cs')), 'x')
    assert.equal(smokeToolName(join(root, TOOL_SRC, 'NombreVacioTool.cs')), 'por_trigger')
    assert.equal(smokeToolName(join(root, TOOL_SRC, 'DosNombresTool.cs')), 'otra_tool')
    assert.equal(smokeToolName(join(root, TOOL_SRC, 'SinNadaTool.cs')), null)
    assert.equal(smokeToolName(join(root, TOOL_SRC, 'NoExisteTool.cs')), null)
  })

  test('lista los smokes que invocan la tool, con ruta relativa al worktree', () => {
    assert.deepEqual(listSmokesInvokingTools(root, TOOL_SMOKES, [`${TOOL_SRC}/CrearPlantillaSemanalTool.cs`]), [
      { target: 'crear_plantilla_semanal', file: `${TOOL_SMOKES}/AsignarTurnoADia/AsignarSmokeTests.cs` },
      { target: 'crear_plantilla_semanal', file: `${TOOL_SMOKES}/BuscarPlantillas/BuscarSmokeTests.cs` },
      { target: 'crear_plantilla_semanal', file: `${TOOL_SMOKES}/CrearPlantillaSemanal/CrearSmokeTests.cs` },
    ])
  })

  test('sin NombreTool resuelve por McpToolTrigger; solo cuentan los .cs', () => {
    const invokers = listSmokesInvokingTools(root, TOOL_SMOKES, [`${TOOL_SRC}/SinNombreTool.cs`])
    assert.equal(smokeInvokersText(invokers), `x\t${TOOL_SMOKES}/.oculta/Oculto.cs\nx\t${TOOL_SMOKES}/Otra/XSmokeTests.cs\nx\t${TOOL_SMOKES}/Raiz.cs\n`)
  })

  test('sin nombre extraible avisa con la ruta y el motivo, y no lista nada', () => {
    const warnings: string[] = []
    const tools = [`${TOOL_SRC}/SinNadaTool.cs`, `${TOOL_SRC}/NoExisteTool.cs`]
    assert.deepEqual(listSmokesInvokingTools(root, TOOL_SMOKES, tools, (message) => warnings.push(message)), [])
    assert.deepEqual(warnings, [
      `No se pudo extraer el nombre de la tool MCP de '${TOOL_SRC}/SinNadaTool.cs' (sin NombreTool ni McpToolTrigger)`,
      `No se pudo extraer el nombre de la tool MCP de '${TOOL_SRC}/NoExisteTool.cs' (el archivo no existe en el worktree (tool borrada o renombrada))`,
    ])
  })

  test('sin proyecto de smokes no lista nada, pero avisa igual de lo que no puede leer', () => {
    assert.deepEqual(listSmokesInvokingTools(root, 'tests/NoExiste.SmokeTests', [`${TOOL_SRC}/SinNombreTool.cs`]), [])
    const warnings: string[] = []
    assert.deepEqual(listSmokesInvokingTools(root, 'tests/NoExiste.SmokeTests', [`${TOOL_SRC}/SinNadaTool.cs`], (message) => warnings.push(message)), [])
    assert.equal(warnings.length, 1)
  })

  test('varias tools se listan en el orden recibido, sin quitar repetidas ni fallar por una vacia', () => {
    const warnings: string[] = []
    const tools = [`${TOOL_SRC}/SinNombreTool.cs`, '', `${TOOL_SRC}/SinNadaTool.cs`, `${TOOL_SRC}/CrearPlantillaSemanalTool.cs`, `${TOOL_SRC}/SinNombreTool.cs`]
    const x = [`${TOOL_SMOKES}/.oculta/Oculto.cs`, `${TOOL_SMOKES}/Otra/XSmokeTests.cs`, `${TOOL_SMOKES}/Raiz.cs`].map((file) => ({ target: 'x', file }))
    assert.deepEqual(listSmokesInvokingTools(root, TOOL_SMOKES, tools, (message) => warnings.push(message)), [
      ...x,
      { target: 'crear_plantilla_semanal', file: `${TOOL_SMOKES}/AsignarTurnoADia/AsignarSmokeTests.cs` },
      { target: 'crear_plantilla_semanal', file: `${TOOL_SMOKES}/BuscarPlantillas/BuscarSmokeTests.cs` },
      { target: 'crear_plantilla_semanal', file: `${TOOL_SMOKES}/CrearPlantillaSemanal/CrearSmokeTests.cs` },
      ...x,
    ])
    assert.deepEqual(warnings, [`No se pudo extraer el nombre de la tool MCP de '${TOOL_SRC}/SinNadaTool.cs' (sin NombreTool ni McpToolTrigger)`])
    assert.deepEqual(listSmokesInvokingTools(root, TOOL_SMOKES, []), [])
  })

  test('NombreTool vacio cae a McpToolTrigger y el primer NombreTool de la linea gana', () => {
    assert.equal(smokeInvokersText(listSmokesInvokingTools(root, TOOL_SMOKES, [`${TOOL_SRC}/NombreVacioTool.cs`])), `por_trigger\t${TOOL_SMOKES}/Raiz.cs\n`)
    assert.equal(smokeInvokersText(listSmokesInvokingTools(root, TOOL_SMOKES, [`${TOOL_SRC}/DosNombresTool.cs`])), `otra_tool\t${TOOL_SMOKES}/Otra/OtraSmokeTests.cs\n`)
  })


})

describe('listSmokesInvokingRoutes', () => {
  let root = ''

  before(() => {
    root = routesFixture()
  })

  test('lista los smokes que invocan la ruta de un HttpTrigger modificado', () => {
    const invokers = listSmokesInvokingRoutes(root, ROUTE_ENDPOINTS)
    assert.deepEqual(invokers, [
      { target: FRANJA, file: 'tests/N.Mcp.X.SmokeTests/Mcp.cs' },
      { target: 'colaboradores', file: 'tests/N.Otro.SmokeTests/Literal.cs' },
      { target: FRANJA, file: 'tests/N.Otro.SmokeTests/Literal.cs' },
      { target: FRANJA, file: 'tests/N.Programacion.SmokeTests/Compuesta.cs' },
      { target: 'colaboradores', file: 'tests/N.Programacion.SmokeTests/Sub/Dir/Anidada.cs' },
    ])
  })

  test('un trigger sin Route no aporta rutas', () => {
    assert.deepEqual(listSmokesInvokingRoutes(root, [ROUTE_ENDPOINTS[2] ?? '']), [])
    assert.deepEqual(listSmokesInvokingRoutes(root, []), [])
  })

  test('resuelve constantes compuestas y admite una cadena de consulta', () => {
    const invokers = listSmokesInvokingRoutes(root, ['src/N.Otro/Varias/FunctionEndpoint.cs'])
    assert.deepEqual(invokers, [
      { target: 'colaboradores', file: 'tests/N.Otro.SmokeTests/Literal.cs' },
      { target: '/reportes/{anio}/{mes}/', file: 'tests/N.Programacion.SmokeTests/Sub/Dir/Anidada.cs' },
      { target: 'a.b/(c)/{x', file: 'tests/N.Programacion.SmokeTests/Sub/Dir/Anidada.cs' },
      { target: 'colaboradores', file: 'tests/N.Programacion.SmokeTests/Sub/Dir/Anidada.cs' },
    ])
  })

  test('sin carpeta tests no lista nada', () => {
    assert.deepEqual(listSmokesInvokingRoutes(join(work, 'no-existe'), ROUTE_ENDPOINTS), [])
  })

  test('sigue un enlace a una carpeta de smokes sin entrar en un ciclo', { skip: process.platform === 'win32' }, () => {
    const linked = routesFixture()
    symlinkSync(join(linked, 'tests', 'N.Mcp.X.SmokeTests'), join(linked, 'tests', 'N.Programacion.SmokeTests', 'Enlace'))
    symlinkSync(join(linked, 'tests', 'N.Otro.SmokeTests'), join(linked, 'tests', 'N.Otro.SmokeTests', 'Ciclo'))
    const files = listSmokesInvokingRoutes(linked, ROUTE_ENDPOINTS).map((invoker) => invoker.file)
    assert.ok(files.includes('tests/N.Programacion.SmokeTests/Enlace/Mcp.cs'))
    assert.equal(files.filter((file) => file.includes('Ciclo')).length, 0)
  })

  test('varios endpoints se recorren en el orden de los smokes; uno inexistente no aporta rutas', () => {
    const endpoints = ['src/N.Otro/Varias/FunctionEndpoint.cs', ...ROUTE_ENDPOINTS, 'src/no-existe.cs']
    assert.deepEqual(listSmokesInvokingRoutes(root, endpoints), [
      { target: FRANJA, file: 'tests/N.Mcp.X.SmokeTests/Mcp.cs' },
      { target: 'colaboradores', file: 'tests/N.Otro.SmokeTests/Literal.cs' },
      { target: FRANJA, file: 'tests/N.Otro.SmokeTests/Literal.cs' },
      { target: FRANJA, file: 'tests/N.Programacion.SmokeTests/Compuesta.cs' },
      { target: '/reportes/{anio}/{mes}/', file: 'tests/N.Programacion.SmokeTests/Sub/Dir/Anidada.cs' },
      { target: 'a.b/(c)/{x', file: 'tests/N.Programacion.SmokeTests/Sub/Dir/Anidada.cs' },
      { target: 'colaboradores', file: 'tests/N.Programacion.SmokeTests/Sub/Dir/Anidada.cs' },
    ])
  })
})
