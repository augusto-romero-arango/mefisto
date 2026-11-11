// Adaptador Claude de las fuentes publicadas: render, directivas, fallos y los preambulos de shell
// que emite, ejecutados tal como los ejecutaria Claude Code.

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
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { CliError, commandExists } from '../../../../scripts/lib/cli.mts'
import type { Json } from '../../../../scripts/lib/jq-values.mts'
import { createAdapter } from '../adapters/adapter-claude.mts'
import { generatePublishedAdapters } from '../generate-published-adapters.mts'
import { claudeEffort, renderClaude } from '../lib/adapter-claude.mts'
import { AdapterError } from '../lib/published-adapter.mts'
import { validatePublishedArtifacts } from '../validate-published-artifacts.mts'

const HERE = import.meta.dirname
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const FIXTURES = join(HERE, 'fixtures', 'claude')
const MARKER = '<!-- GENERADO por prueba desde fixture. No editar a mano. -->'
const GUARD = '{{mefisto:assert-consumer-repo}}'
const WINDOWS = process.platform === 'win32'
// Los preambulos son shell para el consumidor; el de la raiz del paquete usa ademas jq.
const NO_SHELL = WINDOWS || !commandExists('bash')
const NO_JQ = NO_SHELL || !commandExists('jq')
const IS_ROOT = process.getuid?.() === 0
const COMMIT = '0123456789abcdef0123456789abcdef01234567'

let work = ''

before(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mefisto adaptador claude ')))
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

function write(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function source(name: string, frontmatter: Record<string, Json>, ...body: string[]): string {
  return write(
    join(work, `${name}.md`),
    ['---', JSON.stringify(frontmatter), '---', GUARD, ...body, ''].join('\n'),
  )
}

function agent(
  name: string,
  capabilities: Json,
  extra: Record<string, Json> = {},
  ...body: string[]
): string {
  return source(
    name,
    {
      kind: 'agent',
      effort: 'light',
      id: name,
      description: 'Prueba.',
      mode: 'subagent',
      capabilities,
      ...extra,
    },
    ...body,
  )
}

const command = (name: string, extra: Record<string, Json>, ...body: string[]): string =>
  source(name, { kind: 'command', id: name, description: 'x', ...extra }, ...body)

const render = (path: string): string => renderClaude(path, MARKER, REPO_ROOT)
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1
const blocks = (text: string): number => text.split('\n').filter((line) => line === '```bash').length

/** Codigo del primer bloque de shell del artefacto renderizado. */
function preamble(rendered: string): string {
  const lines = rendered.split('\n')
  const start = lines.indexOf('```bash')
  return lines.slice(start + 1, lines.indexOf('```', start)).join('\n')
}

interface Shell {
  status: number | null
  stdout: string
  stderr: string
}

function shell(code: string, cwd: string, env: NodeJS.ProcessEnv = {}): Shell {
  const inherited = { ...process.env }
  delete inherited.CLAUDE_PLUGIN_ROOT
  const result = spawnSync('bash', ['-c', code], { cwd, env: { ...inherited, ...env }, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function validation(path: string): { status: number; output: string } {
  const result = validatePublishedArtifacts([path], REPO_ROOT)
  return { status: result.status, output: result.stdout + result.stderr }
}

describe('interfaz', () => {
  const adapter = createAdapter({ repoRoot: REPO_ROOT })

  test('declara la raiz Claude y rutas sin prefijo interno', () => {
    assert.equal(adapter.root(), 'dist/claude')
    assert.equal(adapter.path('src/published/commands/orden.md'), 'commands/orden.md')
    assert.equal(adapter.path('src/published/agents/rol.md'), 'agents/rol.md')
  })

  test('rechaza una fuente publicada desconocida', () => {
    assert.throws(
      () => adapter.path('src/published/otros/x.md'),
      new AdapterError('src/published/otros/x.md: path: fuente publicada desconocida'),
    )
  })

  test('loaded-root se renderiza como ${CLAUDE_PLUGIN_ROOT} exacto', () => {
    const rendered = render(
      command(
        'cmd-lr',
        {},
        "MEFISTO_LOADED_ROOT='{{mefisto:loaded-root}}' {{mefisto:run upgrade.sh --prune}}",
      ),
    )
    assert.ok(rendered.includes("MEFISTO_LOADED_ROOT='${CLAUDE_PLUGIN_ROOT}' MEFISTO_RUNTIME=claude"))
    assert.ok(!rendered.includes('{{mefisto:'))
  })
})

describe('render', () => {
  let rendered = ''

  before(() => {
    rendered = render(join(FIXTURES, 'agent-completo.md'))
  })

  test('snapshot byte a byte del comando y del agente', () => {
    assert.equal(
      render(join(FIXTURES, 'command-delegado.md')),
      readFileSync(join(FIXTURES, 'expected-command-delegado.md'), 'utf8'),
    )
    assert.equal(rendered, readFileSync(join(FIXTURES, 'expected-agent-completo.md'), 'utf8'))
  })

  test('frontmatter Claude del agente', () => {
    for (const expected of [
      'name: "agent-completo"',
      'description: "Lee: \\"edita\\"."',
      'tools: "Read, Glob, Grep, Edit, Write, Bash, WebFetch, WebSearch, Skill, Task, mcp__microsoft-learn__*, mcp__plugin_mefisto_microsoft-learn__*, mcp__terraform__*, mcp__plugin_terraform_terraform__*"',
      'skills: ["projections"]',
      'model: "sonnet"',
    ]) {
      assert.ok(rendered.includes(expected), expected)
    }
  })

  test('directivas traducidas', () => {
    for (const expected of [
      'Rutas: ${MEFISTO_CONFIG_PATH}, ${MEFISTO_INSTRUCTIONS_PATH} y ${MEFISTO_PACKAGE_ROOT}.',
      'MEFISTO_CONFIG_PATH=".mefisto/harness.config.json"',
      'MEFISTO_INSTRUCTIONS_PATH="AGENTS.md"',
      '.mefisto/pipeline/logs/con-espacio.log',
      '"${MEFISTO_PACKAGE_ROOT}/scripts/prueba.sh" "$ARGUMENTS con espacios"',
      'MEFISTO_PACKAGE_ROOT="$mefisto_claude_root"',
      '/mefisto:otra-orden',
      'Guard inline: Antes de continuar',
    ]) {
      assert.ok(rendered.includes(expected), expected)
    }
    for (const forbidden of ['{{mefisto:', '/Users/', 'mefisto-agent-completo']) {
      assert.ok(!rendered.includes(forbidden), forbidden)
    }
  })

  test('config-path e instructions-path comparten un unico preambulo adicional', () => {
    assert.equal(blocks(rendered), 2)
  })

  test('un body sin directivas de raiz no recibe preambulo', () => {
    assert.ok(!render(join(FIXTURES, 'command-delegado.md')).includes('MEFISTO_PACKAGE_ROOT'))
  })

  test('skill-root convive con package-root y run en un solo preambulo', () => {
    const path = agent(
      'raiz-skill',
      ['skill'],
      { skills: ['projections'] },
      'Recursos: {{mefisto:skill-root projections}}/read-apis.md y {{mefisto:skill-root projections}}/recipes.md; paquete {{mefisto:package-root}}; ejecuta {{mefisto:run prueba.sh "$ARGUMENTS con espacios"}}.',
    )
    const output = render(path)
    assert.ok(output.includes('"${MEFISTO_PACKAGE_ROOT}/skills/projections"/read-apis.md'))
    assert.ok(
      output.includes(
        'paquete ${MEFISTO_PACKAGE_ROOT}; ejecuta MEFISTO_RUNTIME=claude "${MEFISTO_PACKAGE_ROOT}/scripts/prueba.sh" "$ARGUMENTS con espacios"',
      ),
    )
    assert.equal(occurrences(output, 'MEFISTO_PACKAGE_ROOT="$mefisto_claude_root"'), 1)
  })

  test('command-doc resuelve la ruta del comando generado en un solo preambulo', () => {
    const output = render(
      command(
        'doc-prueba',
        {},
        'Lee {{mefisto:command-doc draft}} y luego {{mefisto:command-doc seed-secret}}.',
      ),
    )
    assert.ok(output.includes('Lee "${MEFISTO_PACKAGE_ROOT}/commands/draft.md" y'))
    assert.ok(output.includes('luego "${MEFISTO_PACKAGE_ROOT}/commands/seed-secret.md".'))
    assert.equal(occurrences(output, 'MEFISTO_PACKAGE_ROOT="$mefisto_claude_root"'), 1)
    assert.ok(existsSync(join(REPO_ROOT, 'dist', 'claude', 'commands', 'draft.md')))
  })

  test('el validador rechaza un command-doc inexistente nombrando su id', () => {
    const result = validation(command('doc-inexistente', {}, 'Lee {{mefisto:command-doc no-existe-jamas}}.'))
    assert.notEqual(result.status, 0)
    assert.ok(result.output.includes('no-existe-jamas'), result.output)
  })

  test('usos repetidos de config-path e instructions-path comparten un preambulo y conservan cada uso', () => {
    const output = render(
      agent(
        'contrato-repetido',
        ['read'],
        {},
        'Primero {{mefisto:config-path}} y de nuevo {{mefisto:config-path}}; tambien {{mefisto:instructions-path}} y otra vez {{mefisto:instructions-path}}.',
      ),
    )
    assert.equal(blocks(output), 1)
    assert.equal(occurrences(output, '${MEFISTO_CONFIG_PATH}'), 2)
    assert.equal(occurrences(output, '${MEFISTO_INSTRUCTIONS_PATH}'), 2)
  })

  test('la regla de uso acompana al preambulo, fuera del bloque', () => {
    const code = preamble(rendered)
    assert.ok(!code.includes('${CLAUDE_PLUGIN_ROOT:-'))
    assert.ok(code.includes("mefisto_claude_loaded='${CLAUDE_PLUGIN_ROOT}'"))
    assert.ok(
      rendered.includes(
        'Ejecuta este bloque en cada llamada Bash de este comando, sin guardarlo en un archivo ni reutilizar el de otro comando: la raiz que fija es la de la version cargada.',
      ),
    )
    assert.ok(!code.includes('Ejecuta este bloque'))
  })
})

describe('contrato efectivo', { skip: NO_SHELL }, () => {
  let consumer = ''
  let configCode = ''
  let instructionsCode = ''
  const config = (): Shell => shell(`${configCode}\nprintf '%s\\n' "$MEFISTO_CONFIG_PATH"`, consumer)
  const instructions = (): Shell =>
    shell(`${instructionsCode}\nprintf '%s\\n' "$MEFISTO_INSTRUCTIONS_PATH"`, consumer)
  const CANONICAL = '.mefisto/harness.config.json'
  const LEGACY = '.claude/harness.config.json'
  const put = (rel: string, content: string): string => write(join(consumer, ...rel.split('/')), content)
  const drop = (...rels: string[]): void => {
    for (const rel of rels) rmSync(join(consumer, ...rel.split('/')), { force: true })
  }

  before(() => {
    consumer = join(work, 'contrato consumidor')
    mkdirSync(consumer, { recursive: true })
    configCode = preamble(render(agent('contrato-config', ['read'], {}, '{{mefisto:config-path}}')))
    instructionsCode = preamble(
      render(agent('contrato-instrucciones', ['read'], {}, '{{mefisto:instructions-path}}')),
    )
  })

  test('config-path: solo el canonico resuelve sin aviso', () => {
    drop(LEGACY)
    put(CANONICAL, '{}')
    assert.deepEqual(config(), { status: 0, stdout: `${CANONICAL}\n`, stderr: '' })
  })

  test('config-path: solo el legacy resuelve como fallback', () => {
    drop(CANONICAL)
    put(LEGACY, '{}')
    assert.deepEqual(config(), { status: 0, stdout: `${LEGACY}\n`, stderr: '' })
  })

  test('config-path: la coexistencia elige el canonico y avisa sin mezclar', () => {
    put(CANONICAL, '{}')
    put(LEGACY, '{}')
    const result = config()
    assert.deepEqual([result.status, result.stdout], [0, `${CANONICAL}\n`])
    assert.ok(
      result.stderr.includes(`se usara el config canonico ${CANONICAL}; se ignora el legacy ${LEGACY}`),
      result.stderr,
    )
  })

  test('config-path: la ausencia total aborta nombrando canonico y legacy', () => {
    drop(CANONICAL, LEGACY)
    const result = config()
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    assert.ok(
      result.stderr.includes(`no se encontro el config canonico requerido ${CANONICAL}`),
      result.stderr,
    )
    assert.ok(result.stderr.includes(`fallback legacy ${LEGACY}`), result.stderr)
  })

  test('config-path: un canonico no legible se sigue seleccionando', { skip: IS_ROOT }, () => {
    drop(LEGACY)
    const path = put(CANONICAL, '{}')
    chmodSync(path, 0o000)
    try {
      assert.deepEqual([config().status, config().stdout], [0, `${CANONICAL}\n`])
    } finally {
      chmodSync(path, 0o644)
    }
  })

  test('instructions-path: solo el canonico resuelve sin aviso', () => {
    drop('CLAUDE.md')
    put('AGENTS.md', '@AGENTS.md\n')
    assert.deepEqual(instructions(), { status: 0, stdout: 'AGENTS.md\n', stderr: '' })
  })

  test('instructions-path: solo el legacy resuelve como fallback', () => {
    drop('AGENTS.md')
    put('CLAUDE.md', '@AGENTS.md\n')
    assert.deepEqual(instructions(), { status: 0, stdout: 'CLAUDE.md\n', stderr: '' })
  })

  test('instructions-path: la coexistencia elige el canonico y avisa sin mezclar', () => {
    put('AGENTS.md', '@AGENTS.md\n')
    put('CLAUDE.md', '@AGENTS.md\n')
    const result = instructions()
    assert.deepEqual([result.status, result.stdout], [0, 'AGENTS.md\n'])
    assert.ok(result.stderr.includes('se usara AGENTS.md; se ignora el legacy CLAUDE.md'), result.stderr)
  })

  test('instructions-path: la ausencia total aborta con diagnostico de onboarding', () => {
    drop('AGENTS.md', 'CLAUDE.md')
    const result = instructions()
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    for (const expected of ['no se encontro AGENTS.md', 'fallback legacy CLAUDE.md', '/mefisto:onboard']) {
      assert.ok(result.stderr.includes(expected), result.stderr)
    }
  })

  test('instructions-path: un canonico no legible se sigue seleccionando', { skip: IS_ROOT }, () => {
    drop('CLAUDE.md')
    const path = put('AGENTS.md', '@AGENTS.md\n')
    chmodSync(path, 0o000)
    try {
      assert.deepEqual([instructions().status, instructions().stdout], [0, 'AGENTS.md\n'])
    } finally {
      chmodSync(path, 0o644)
    }
  })
})

describe('resolucion de la raiz del paquete', { skip: NO_JQ }, () => {
  let code = ''
  let consumer = ''
  let subdir = ''
  const roots: Record<string, string> = {}
  const CANONICAL_MARKER = '.mefisto/pipeline/.plugin-root'
  const LEGACY_MARKER = '.claude/pipeline/.plugin-root'

  function pluginRoot(key: string, name = 'mefisto', version = '1.2.3', runtime = 'claude'): string {
    const root = join(work, `plugin ${key}`)
    write(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }))
    write(
      join(root, 'mefisto-manifest.json'),
      JSON.stringify({ schemaVersion: 1, runtime, version, commit: COMMIT }),
    )
    const probe = write(
      join(root, 'scripts', 'probe.sh'),
      '#!/bin/sh\nprintf invoked > "$MEFISTO_TEST_TRACE"\n',
    )
    chmodSync(probe, 0o755)
    roots[key] = root
    return root
  }

  const marker = (rel: string, content: string): string => write(join(consumer, ...rel.split('/')), content)
  const unmark = (rel: string): void => rmSync(join(consumer, ...rel.split('/')), { force: true })

  /** Lo que hace Claude Code al cargar el artefacto: sustituye el texto exacto; sin raiz no sustituye. */
  function resolve(cwd: string, loadedRoot: string, key: string): Shell & { traced: boolean } {
    const trace = join(work, `${key}.trace`)
    rmSync(trace, { force: true })
    const loaded = loadedRoot === '' ? code : code.replaceAll('${CLAUDE_PLUGIN_ROOT}', loadedRoot)
    const result = shell(
      `${loaded}\nprintf "ROOT=%s\\n" "$MEFISTO_PACKAGE_ROOT"; "$MEFISTO_PACKAGE_ROOT/scripts/probe.sh"`,
      cwd,
      { MEFISTO_TEST_TRACE: trace },
    )
    return { ...result, traced: existsSync(trace) }
  }

  before(() => {
    code = preamble(render(join(FIXTURES, 'agent-completo.md')))
    consumer = join(work, 'consumidor con espacios')
    subdir = join(consumer, 'sub', 'directorio')
    mkdirSync(subdir, { recursive: true })
    for (const key of ['runtime', 'canonico', 'legacy']) pluginRoot(key)
    pluginRoot('otro runtime', 'mefisto', '1.2.3', 'fake')
    marker(CANONICAL_MARKER, `${roots.canonico}/\n`)
    marker(LEGACY_MARKER, `${roots.legacy}\n`)
  })

  test('la sustitucion prevalece sobre un marker canonico valido y normaliza rutas con espacios', () => {
    const result = resolve(subdir, `${roots.runtime}/`, 'runtime')
    assert.deepEqual(
      [result.status, result.stdout, result.traced],
      [0, `ROOT=${realpathSync.native(roots.runtime ?? '')}\n`, true],
    )
  })

  test('sin sustitucion, el marker canonico se resuelve desde un subdirectorio', () => {
    const result = resolve(subdir, '', 'canonical')
    assert.deepEqual(
      [result.status, result.stdout],
      [0, `ROOT=${realpathSync.native(roots.canonico ?? '')}\n`],
    )
  })

  test('un marker canonico valido prevalece sin leer un marker legacy invalido', () => {
    marker(LEGACY_MARKER, `${join(work, 'no-existe')}\n`)
    const result = resolve(consumer, '', 'legacy-invalido')
    assert.deepEqual(
      [result.status, result.stdout],
      [0, `ROOT=${realpathSync.native(roots.canonico ?? '')}\n`],
    )
    marker(LEGACY_MARKER, `${roots.legacy}\n`)
  })

  test('un marker canonico invalido aborta sin aceptar el fallback ni ejecutar codigo', () => {
    const malformed = join(work, 'plugin canonico malformado')
    write(join(malformed, 'mefisto-manifest.json'), '{\n')
    for (const candidate of [malformed, roots['otro runtime'] ?? '', 'relativa/plugin']) {
      marker(CANONICAL_MARKER, `${candidate}\n`)
      const result = resolve(subdir, '', 'marker-invalido')
      assert.notEqual(result.status, 0, candidate)
      assert.equal(result.traced, false, candidate)
      assert.ok(result.stderr.includes('marker canonico invalida'), result.stderr)
    }
    marker(CANONICAL_MARKER, `${roots.canonico}/\n`)
  })

  test('el marker legacy queda como fallback y sin markers se diagnostica la instalacion faltante', () => {
    unmark(CANONICAL_MARKER)
    const legacy = resolve(subdir, '', 'legacy')
    assert.deepEqual([legacy.status, legacy.stdout], [0, `ROOT=${realpathSync.native(roots.legacy ?? '')}\n`])
    unmark(LEGACY_MARKER)
    const missing = resolve(subdir, '', 'missing')
    assert.notEqual(missing.status, 0)
    assert.equal(missing.traced, false)
    assert.ok(missing.stderr.includes('no se encontro una raiz Claude valida'), missing.stderr)
    marker(CANONICAL_MARKER, `${roots.canonico}/\n`)
    marker(LEGACY_MARKER, `${roots.legacy}\n`)
  })

  test('una sustitucion invalida aborta antes del script con una accion concreta', () => {
    const broken = join(work, 'plugin roto')
    symlinkSync(join(work, 'no-existe'), broken)
    const unreadable = pluginRoot('metadata ilegible')
    write(join(unreadable, '.claude-plugin', 'plugin.json'), '{\n')
    const candidates = [
      'relativa/plugin',
      join(work, 'no-existe'),
      broken,
      pluginRoot('nombre ajeno', 'otro'),
      pluginRoot('version invalida', 'mefisto', 'version-invalida'),
      unreadable,
    ]
    for (const candidate of candidates) {
      const result = resolve(work, candidate, 'failure')
      assert.notEqual(result.status, 0, candidate)
      assert.equal(result.traced, false, candidate)
      assert.ok(result.stderr.includes('ERROR Claude:'), result.stderr)
      assert.ok(result.stderr.includes('reinstale'), result.stderr)
    }
  })

  test('una sustitucion invalida no cae a los markers, aunque el canonico sea valido', () => {
    for (const bad of [join(work, 'no-existe'), roots['otro runtime'] ?? '']) {
      const result = resolve(subdir, bad, 'sust')
      assert.notEqual(result.status, 0, bad)
      assert.deepEqual([result.traced, result.stdout], [false, ''], bad)
      assert.ok(
        result.stderr.includes(
          `ERROR Claude: la raiz cargada (${bad}) es invalida; recargue o reinstale el plugin.`,
        ),
        result.stderr,
      )
    }
  })

  test('el marker funciona desde un worktree', () => {
    const worktree = join(work, 'worktree consumidor', 'directorio')
    mkdirSync(join(worktree, 'sub'), { recursive: true })
    write(join(worktree, ...CANONICAL_MARKER.split('/')), `${roots.canonico}\n`)
    const result = resolve(join(worktree, 'sub'), '', 'worktree')
    assert.deepEqual(
      [result.status, result.stdout],
      [0, `ROOT=${realpathSync.native(roots.canonico ?? '')}\n`],
    )
  })
})

describe('fallos sin salida parcial', () => {
  const failure = (path: string): string => {
    try {
      render(path)
    } catch (error) {
      if (error instanceof AdapterError) return error.message
      throw error
    }
    return ''
  }

  test('capacidad, MCP, Skill, perfil y directiva desconocidos', () => {
    const cases: [string, string][] = [
      [agent('capacidad', ['desconocida']), "capabilities: capacidad 'desconocida' sin mapping Claude"],
      [agent('mcp', [], { mcp: ['desconocido'] }), "mcp: servidor MCP 'desconocido' sin matcher Claude"],
      [agent('skill', [], { skills: ['no-existe'] }), "skills: Skill publicado 'no-existe' no resuelve"],
      [agent('perfil', [], { profile: 'desconocido' }), "profile: perfil 'desconocido' sin mapping Claude"],
      [agent('directiva', [], {}, '{{mefisto:desconocida}}'), 'body: directiva sin mapping Claude'],
    ]
    for (const [path, expected] of cases) {
      assert.ok(failure(path).startsWith(`${path}: ${expected}`), `${basename(path)}: ${failure(path)}`)
    }
  })

  test('el perfil deep declara model: "opus"', () => {
    assert.ok(render(agent('profundo', [], { profile: 'deep' })).includes('model: "opus"'))
  })

  test('la capacidad neutral ask se traduce a AskUserQuestion', () => {
    assert.ok(
      render(agent('ask-agent', ['read', 'ask'])).includes('tools: "Read, Glob, Grep, AskUserQuestion"'),
    )
  })

  test('el generador propaga un mapping fallido sin reemplazar dist', async () => {
    const fake = join(work, 'repo')
    const schema = JSON.parse(
      readFileSync(join(REPO_ROOT, 'src', 'published', 'contract', 'published-artifact.schema.json'), 'utf8'),
    ) as { oneOf: { properties: { mcp: { items: { enum: string[] } } } }[] }
    for (const variant of schema.oneOf) variant.properties.mcp.items.enum.push('nuevo')
    write(
      join(fake, 'src', 'published', 'contract', 'published-artifact.schema.json'),
      JSON.stringify(schema),
    )
    write(join(fake, '.claude-plugin', 'plugin.json'), '{"name":"mefisto","version":"1.2.3"}\n')
    write(
      join(fake, 'src', 'published', 'release-identity.json'),
      `{"schemaVersion":1,"version":"1.2.3","commit":"${COMMIT}"}\n`,
    )
    const previous = write(join(fake, 'dist', 'claude', 'anterior.md'), 'salida anterior\n')
    write(
      join(fake, 'src', 'published', 'agents', 'atomico.md'),
      `---\n{"kind":"agent","effort":"light","id":"atomico","description":"Prueba.","mode":"subagent","mcp":["nuevo"]}\n---\n${GUARD}\n`,
    )
    const root = realpathSync.native(fake)
    await assert.rejects(
      generatePublishedAdapters({
        check: false,
        outRoot: root,
        files: [],
        repoRoot: root,
        adapters: [createAdapter({ repoRoot: root })],
      }),
      (error: unknown) =>
        error instanceof CliError && error.message.includes("mcp: servidor MCP 'nuevo' sin matcher Claude"),
    )
    assert.equal(readFileSync(previous, 'utf8'), 'salida anterior\n')
    assert.ok(!existsSync(join(fake, 'dist', 'claude', 'agents', 'atomico.md')))
  })
})

describe('delegacion', () => {
  test('el frontmatter agent delega el comando completo', () => {
    const output = render(command('cmd-completo', { agent: 'agent-completo' }, 'Cuerpo.'))
    assert.ok(output.includes('agente `mefisto:agent-completo`'))
    assert.ok(output.includes('$ARGUMENTS como mensaje'))
    assert.ok(output.includes('no las ejecutes tu mismo'))
    assert.ok(!output.includes('Actua como el agente'))
  })

  test('launch-agent delega un paso puntual y el comando continua', () => {
    const output = render(
      command(
        'cmd-puntual',
        {},
        'Paso 1: pregunta al usuario.',
        '{{mefisto:launch-agent agent-completo Escribe el ambiente dev y el proposito Facturas}}',
        'Paso 3: crea el PR.',
      ),
    )
    assert.ok(
      output.includes(
        'invoca la tool `Task` con el agente `mefisto:agent-completo` y este mensaje: Escribe el ambiente dev y el proposito Facturas.',
      ),
    )
    assert.ok(output.includes('Espera su resultado final'))
    assert.ok(output.includes('Paso 3: crea el PR.'))
    assert.ok(!output.includes('Actua como el agente'))
    assert.ok(!output.includes('ARGUMENTS'))
  })

  test('dos launch-agent alternativos se traducen por separado', () => {
    const output = render(
      command(
        'cmd-alt',
        {},
        'Si aplica A: {{mefisto:launch-agent agent-completo Mensaje A}}',
        'Si aplica B: {{mefisto:launch-agent agent-completo Mensaje B}}',
      ),
    )
    assert.ok(output.includes('este mensaje: Mensaje A.'))
    assert.ok(output.includes('este mensaje: Mensaje B.'))
  })

  test('el validador rechaza launch-agent sin mensaje, con id inexistente o junto a agent', () => {
    const cases: [string, string][] = [
      [
        command('rechazo-sin-mensaje', {}, '{{mefisto:launch-agent bug-investigator}}'),
        'directiva mefisto mal formada',
      ],
      [
        command('rechazo-inexistente', {}, '{{mefisto:launch-agent agente-inexistente Haz algo}}'),
        "launch-agent 'agente-inexistente' no existe",
      ],
      [
        command(
          'rechazo-con-agent',
          { agent: 'bug-investigator' },
          '{{mefisto:launch-agent bug-investigator Haz algo}}',
        ),
        'un comando con agent no puede usar launch-agent',
      ],
    ]
    for (const [path, expected] of cases) {
      const result = validation(path)
      assert.notEqual(result.status, 0, expected)
      assert.ok(result.output.includes(expected), result.output)
    }
  })
})

describe('effort', () => {
  const LEVELS: [string, string][] = [
    ['quick', 'low'],
    ['light', 'medium'],
    ['standard', 'high'],
    ['thorough', 'xhigh'],
    ['exhaustive', 'max'],
  ]
  const leveled = (level: string, extra: Record<string, Json> = {}): string =>
    source(`ef-${level}`, {
      kind: 'agent',
      id: `ef-${level}`,
      description: 'Prueba.',
      mode: 'subagent',
      ...extra,
      effort: level,
    })

  test('cada nivel neutral se renderiza como effort nativo tras model', () => {
    for (const [level, native] of LEVELS) {
      const output = render(leveled(level, { profile: 'balanced' }))
      assert.ok(output.includes(`model: "sonnet"\neffort: "${native}"\n---`), level)
    }
  })

  test('un nivel desconocido falla sin salida parcial', () => {
    const path = leveled('raro')
    assert.throws(() => render(path), new AdapterError(`${path}: effort: nivel 'raro' sin mapping Claude`))
  })

  test('coincide con el effort por defecto del runner en los cinco niveles', { skip: NO_SHELL }, () => {
    const runtime = join(REPO_ROOT, 'src', 'runtime', 'lib', 'runtime-claude.sh')
    const levels = LEVELS.map(([level]) => level)
    const result = spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; shift; for level in "$@"; do runtime_claude_default_effort "$level"; echo; done',
        '_',
        runtime,
        ...levels,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.stdout.trimEnd().split('\n'), levels.map(claudeEffort))
  })
})
