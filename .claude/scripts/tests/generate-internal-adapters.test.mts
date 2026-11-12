import assert from 'node:assert/strict'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { capture } from '../../../scripts/lib/cli.mts'
import {
  PUBLISHED_PROJECTED_SKILLS,
  runGenerator,
  skillRelParts,
} from '../../../src/internal/scripts/generate-internal-adapters.mts'
import {
  claudeDefaultEffort,
  claudeDefaultModel,
  claudeTranslateBody,
} from '../../../src/internal/scripts/lib/adapter-claude.mts'
import { jqJson } from '../../../src/internal/scripts/lib/jq-json.mts'
import { Output } from '../../../src/internal/scripts/lib/mefisto-script-io.mts'
import { runValidator } from '../../../src/internal/scripts/validate-internal-artifacts.mts'
import { defaultEffort as runtimeDefaultEffort, defaultModel as runtimeDefaultModel } from '../../../src/runtime/lib/runtime-claude.mts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPTS = join(REPO_ROOT, 'src', 'internal', 'scripts')
const CONTRACT = join(REPO_ROOT, 'src', 'internal', 'contract')
const MARKER = '<!-- GENERADO por src/internal/scripts/generate-internal-adapters.sh desde '

const posix = (path: string): string => path.split(sep).join('/')

interface Run {
  status: number
  stdout: string
  stderr: string
  /** stdout y stderr juntos, como `2>&1`. */
  all: string
}

function generate(args: string[], repoRoot?: string): Run {
  const output = new Output()
  const status = runGenerator(args, output, repoRoot)
  return { status, stdout: output.stdout, stderr: output.stderr, all: output.stderr + output.stdout }
}

function write(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files[posix(path.slice(root.length + 1))] = readFileSync(path, 'utf8')
  }
  return files
}

let work = ''
let src = ''

const AGENT_BASIC = `---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-fx-agent-basic",
  "description": "Agente de prueba minimo para el generador de adaptadores (issue #854).",
  "mode": "subagent",
  "capabilities": ["read", "edit"],
  "skills": ["agent-skill-authoring", "comment-cleanup"]
}
---

Cuerpo de prueba.
`

const COMMAND_BASIC = `---
{
  "kind": "command",
  "id": "mefisto-fx-command-basic",
  "description": "Comando de prueba minimo para el generador (issue #854).",
  "capabilities": ["shell"],
  "arguments": "<issue> -- numero del issue"
}
---

Procesa el issue $ARGUMENTS.
`

const COMMAND_DIRECTIVES = `---
{
  "kind": "command",
  "id": "mefisto-fx-command-directives",
  "description": "Comando de prueba, cubre las tres directivas de body (issue #854)."
}
---

Invoca al agente:

{{mefisto:launch-agent mefisto-fx-agent-basic}}

Corre el script auxiliar:

\`\`\`bash
{{mefisto:run some-script.sh --flag value}}
\`\`\`

Lee el comando hermano:

\`\`\`bash
cat "{{mefisto:command-path mefisto-fx-command-basic}}"
\`\`\`
`

const agentBasic = (): string => join(src, 'mefisto-fx-agent-basic.md')
const commandBasic = (): string => join(src, 'mefisto-fx-command-basic.md')
const commandDirectives = (): string => join(src, 'mefisto-fx-command-directives.md')

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto-gen-internos-'))
  src = join(work, 'src')
  write(agentBasic(), AGENT_BASIC)
  write(commandBasic(), COMMAND_BASIC)
  write(commandDirectives(), COMMAND_DIRECTIVES)
})

after(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('shims y punto de entrada', () => {
  for (const name of ['generate-internal-adapters', 'validate-internal-artifacts', 'mefisto-neutrality-gate']) {
    test(`${name}.sh es el shim de tres lineas hacia su .mts`, () => {
      const shim = join(SCRIPTS, `${name}.sh`)
      assert.equal(
        readFileSync(shim, 'utf8'),
        [
          '#!/usr/bin/env bash',
          `# Shim: la implementacion vive en ${name}.mts (MEF-ADR-0057). No editar.`,
          `exec node "$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd -P)/${name}.mts" "$@"`,
          '',
        ].join('\n'),
      )
      assert.ok(existsSync(join(SCRIPTS, `${name}.mts`)))
      if (process.platform !== 'win32') assert.notEqual(statSync(shim).mode & 0o111, 0)
    })
  }

  test('el .mts corre como comando y propaga salida y codigo', () => {
    const script = join(SCRIPTS, 'generate-internal-adapters.mts')
    const missing = capture(process.execPath, [script, '--check', '--out', join(work, 'cli-nunca'), agentBasic()])
    assert.equal(missing.status, 1)
    assert.equal(missing.stdout, '.claude/agents/mefisto-fx-agent-basic.md: faltante\n')
    const noDir = capture(process.execPath, [script, '--out'])
    assert.equal(noDir.status, 1)
    assert.equal(noDir.stderr, 'ERROR: --out requiere un directorio\n')
  })
})

describe('fixtures validos del contrato', () => {
  test('generan el agente y el comando con exit 0', () => {
    const out = join(work, 'out-valid')
    const run = generate([
      '--out',
      out,
      join(CONTRACT, 'fixtures', 'valid', 'mefisto-example-agent.md'),
      join(CONTRACT, 'fixtures', 'valid', 'mefisto-example-command.md'),
    ])
    assert.equal(run.status, 0, run.all)
    assert.equal(run.all, '')
    const agent = readFileSync(join(out, '.claude', 'agents', 'mefisto-example-agent.md'), 'utf8')
    assert.ok(existsSync(join(out, '.claude', 'commands', 'mefisto-example-command.md')))
    assert.match(agent, /^tools: "Read, Glob, Grep, Edit, Write, Bash"$/m)
    assert.match(agent, /^effort: "high"$/m)
  })

  test('la capacidad ask se traduce a AskUserQuestion', () => {
    const source = write(
      join(work, 'ask-src', 'mefisto-fx-ask.md'),
      `---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-fx-ask",
  "description": "Agente read+ask (issue #2142).",
  "mode": "primary",
  "capabilities": ["read", "ask"]
}
---

Cuerpo.
`,
    )
    const out = join(work, 'out-ask')
    assert.equal(generate(['--out', out, source]).status, 0)
    assert.match(
      readFileSync(join(out, '.claude', 'agents', 'mefisto-fx-ask.md'), 'utf8'),
      /^tools: "Read, Glob, Grep, AskUserQuestion"$/m,
    )
  })
})

describe('contenido exacto', () => {
  test('agente y comando minimos', () => {
    const out = join(work, 'out-basic')
    const run = generate(['--out', out, agentBasic(), commandBasic()])
    assert.equal(run.status, 0, run.all)
    assert.equal(
      readFileSync(join(out, '.claude', 'agents', 'mefisto-fx-agent-basic.md'), 'utf8'),
      `---
name: "mefisto-fx-agent-basic"
description: "Agente de prueba minimo para el generador de adaptadores (issue #854)."
effort: "high"
tools: "Read, Glob, Grep, Edit, Write"
skills: ["agent-skill-authoring","comment-cleanup"]
---
${MARKER}${posix(agentBasic())}. No editar a mano. -->

Cuerpo de prueba.
`,
    )
    assert.equal(
      readFileSync(join(out, '.claude', 'commands', 'mefisto-fx-command-basic.md'), 'utf8'),
      `---
description: "Comando de prueba minimo para el generador (issue #854)."
argument-hint: "<issue> -- numero del issue"
allowed-tools: "Bash"
---
${MARKER}${posix(commandBasic())}. No editar a mano. -->

Procesa el issue $ARGUMENTS.
`,
    )
  })

  test('las tres directivas de body traducidas', () => {
    const out = join(work, 'out-directives')
    const run = generate(['--out', out, agentBasic(), commandDirectives()])
    assert.equal(run.status, 0, run.all)
    assert.equal(
      readFileSync(join(out, '.claude', 'commands', 'mefisto-fx-command-directives.md'), 'utf8'),
      `---
description: "Comando de prueba, cubre las tres directivas de body (issue #854)."
---
${MARKER}${posix(commandDirectives())}. No editar a mano. -->

Invoca al agente:

\`\`\`bash
claude --agent mefisto-fx-agent-basic "$ARGUMENTS"
\`\`\`

Corre el script auxiliar:

\`\`\`bash
MEFISTO_RUNTIME=claude ./.claude/scripts/some-script.sh --flag value
\`\`\`

Lee el comando hermano:

\`\`\`bash
cat ".claude/commands/mefisto-fx-command-basic.md"
\`\`\`
`,
    )
  })

  test('id con muchos guiones y description con dos puntos y comillas', () => {
    const source = write(
      join(src, 'mefisto-fx-id-with-many-hyphens-here.md'),
      `---
{
  "kind": "command",
  "id": "mefisto-fx-id-with-many-hyphens-here",
  "description": "Hace X: paso \\"importante\\" para el usuario."
}
---

Cuerpo.
`,
    )
    const out = join(work, 'out-escaping')
    const run = generate(['--out', out, source])
    assert.equal(run.status, 0, run.all)
    const generated = readFileSync(
      join(out, '.claude', 'commands', 'mefisto-fx-id-with-many-hyphens-here.md'),
      'utf8',
    )
    assert.ok(generated.includes('description: "Hace X: paso \\"importante\\" para el usuario."'))
  })

  test('un body vacio deja el marcador como ultima linea', () => {
    const source = write(
      join(src, 'mefisto-fx-empty-body.md'),
      '---\n{"kind":"command","id":"mefisto-fx-empty-body","description":"d"}\n---\n',
    )
    const out = join(work, 'out-empty-body')
    assert.equal(generate(['--out', out, source]).status, 0)
    assert.equal(
      readFileSync(join(out, '.claude', 'commands', 'mefisto-fx-empty-body.md'), 'utf8'),
      `---\ndescription: "d"\n---\n${MARKER}${posix(source)}. No editar a mano. -->\n`,
    )
  })
})

describe('traduccion de directivas', () => {
  const translate = (body: string): string => claudeTranslateBody('fx.md', body)

  test('{{mefisto:run}} conserva un argumento con espacios y comillas', () => {
    assert.equal(
      translate("{{mefisto:run mefisto-launch-pipeline.sh --tooling $ARGUMENTS --models 'writer=a b'}}"),
      "MEFISTO_RUNTIME=claude ./.claude/scripts/mefisto-launch-pipeline.sh --tooling $ARGUMENTS --models 'writer=a b'\n",
    )
  })

  test('las directivas en linea conservan el texto que las rodea', () => {
    assert.equal(
      translate('pre {{mefisto:run a.sh}} post'),
      'pre MEFISTO_RUNTIME=claude ./.claude/scripts/a.sh post\n',
    )
    assert.equal(
      translate('{{mefisto:run   a.sh    --x  y   }}'),
      'MEFISTO_RUNTIME=claude ./.claude/scripts/a.sh --x  y\n',
    )
    assert.equal(
      translate('`{{mefisto:command-path mefisto-y}}`!'),
      '`.claude/commands/mefisto-y.md`!\n',
    )
  })

  test('launch-agent solo se traduce si ocupa toda la linea', () => {
    assert.equal(
      translate('  {{mefisto:launch-agent mefisto-x}}  '),
      '```bash\nclaude --agent mefisto-x "$ARGUMENTS"\n```\n',
    )
    assert.throws(() => translate('x {{mefisto:launch-agent mefisto-x}}'), /directiva de body desconocida/)
  })

  test('con dos directivas en una linea solo se traduce la ultima', () => {
    assert.equal(
      translate('{{mefisto:run a.sh}} y {{mefisto:run b.sh c}} z'),
      '{{mefisto:run a.sh}} y MEFISTO_RUNTIME=claude ./.claude/scripts/b.sh c z\n',
    )
  })
})

describe('abortos sin escribir nada', () => {
  test('una directiva desconocida', () => {
    const source = write(
      join(src, 'mefisto-fx-unknown-directive.md'),
      `---
{
  "kind": "command",
  "id": "mefisto-fx-unknown-directive",
  "description": "Comando con una directiva de body desconocida."
}
---

{{mefisto:frobnicate foo}}
`,
    )
    const out = join(work, 'out-unknown')
    const run = generate(['--out', out, source])
    assert.equal(run.status, 1)
    assert.equal(
      run.stderr,
      `${posix(source)}: directiva de body desconocida: '{{mefisto:frobnicate foo}}'\nERROR: la generacion aborto; no se escribio nada\n`,
    )
    assert.equal(existsSync(join(out, '.claude')), false)
  })

  test('una fuente que no pasa la validacion previa', () => {
    const out = join(work, 'out-invalid')
    const run = generate(['--out', out, join(CONTRACT, 'fixtures', 'invalid', 'mismatched-id.md')])
    assert.equal(run.status, 1)
    assert.ok(run.stderr.includes('distinto del nombre de archivo'), run.stderr)
    assert.ok(
      run.stderr.endsWith(
        'ERROR: validacion previa (validate-internal-artifacts.sh) fallo; no se genero nada\n',
      ),
    )
    assert.equal(existsSync(out), false)
  })

  test('la capacidad mcp, que no tiene mapeo', () => {
    const source = write(
      join(src, 'mefisto-fx-mcp-capability.md'),
      `---
{
  "kind": "agent",
  "effort": "standard",
  "id": "mefisto-fx-mcp-capability",
  "description": "Agente que declara la capacidad mcp, sin mapeo Claude (issue #854).",
  "mode": "subagent",
  "capabilities": ["read", "mcp"]
}
---

Cuerpo.
`,
    )
    const out = join(work, 'out-mcp')
    const run = generate(['--out', out, source])
    assert.equal(run.status, 1)
    assert.ok(run.stderr.includes('capacidad mcp sin mapeo Claude definido'), run.stderr)
    assert.equal(existsSync(join(out, '.claude')), false)
  })
})

describe('determinismo', () => {
  test('dos corridas y una tercera tras tocar el mtime producen el mismo arbol', () => {
    const [first, second, third] = ['det-a', 'det-b', 'det-c'].map((name) => join(work, name))
    assert.ok(first !== undefined && second !== undefined && third !== undefined)
    const sources = [agentBasic(), commandDirectives()]
    assert.equal(generate(['--out', first, ...sources]).status, 0)
    assert.equal(generate(['--out', second, ...sources]).status, 0)
    const later = new Date(Date.now() + 60_000)
    for (const source of sources) utimesSync(source, later, later)
    assert.equal(generate(['--out', third, ...sources]).status, 0)
    assert.equal(Object.keys(snapshot(first)).length, 2)
    assert.deepEqual(snapshot(second), snapshot(first))
    assert.deepEqual(snapshot(third), snapshot(second))
  })
})

describe('--check', () => {
  test('al dia, distinta, huerfana y sin marcador', () => {
    const out = join(work, 'check-dir')
    const sources = [agentBasic(), commandBasic()]
    assert.equal(generate(['--out', out, ...sources]).status, 0)

    const upToDate = generate(['--check', '--out', out, ...sources])
    assert.equal(upToDate.status, 0)
    assert.equal(upToDate.all, '')

    appendFileSync(join(out, '.claude', 'agents', 'mefisto-fx-agent-basic.md'), 'corrupcion manual\n')
    const different = generate(['--check', '--out', out, ...sources])
    assert.equal(different.status, 1)
    assert.equal(different.stdout, '.claude/agents/mefisto-fx-agent-basic.md: distinta\n')
    assert.equal(generate(['--out', out, ...sources]).status, 0)

    write(
      join(out, '.claude', 'commands', 'mefisto-fx-orphan.md'),
      `---\ndescription: "huerfano de prueba"\n---\n${MARKER}fake/source.md. No editar a mano. -->\ncontenido huerfano\n`,
    )
    write(join(out, '.claude', 'commands', 'mefisto-manual.md'), 'archivo de autoria manual, sin marcador\n')
    const strays = generate(['--check', '--out', out, ...sources])
    assert.equal(strays.status, 1)
    assert.equal(
      strays.stdout,
      '.claude/commands/mefisto-fx-orphan.md: huerfana\n.claude/commands/mefisto-manual.md: sin marcador\n',
    )
  })

  test('no crea ni el directorio de salida', () => {
    const never = join(work, 'never-created')
    const run = generate(['--check', '--out', never, agentBasic()])
    assert.equal(run.status, 1)
    assert.equal(run.stdout, '.claude/agents/mefisto-fx-agent-basic.md: faltante\n')
    assert.equal(existsSync(never), false)
  })

  test('el scan por defecto sobre la fuente real genera y queda al dia', () => {
    const out = join(work, 'out-nosources')
    const generated = generate(['--out', out])
    assert.equal(generated.status, 0, generated.all)
    const check = generate(['--check', '--out', out])
    assert.equal(check.status, 0, check.all)
    assert.equal(check.all, '')
  })

  test('lo versionado en .claude/ coincide byte a byte con lo que produce la fuente', () => {
    const check = generate(['--check'])
    assert.equal(check.all, '')
    assert.equal(check.status, 0)
  })
})

describe('Agent Skills internos', () => {
  let skillSource = ''
  let resource = ''
  let out = ''

  before(() => {
    const root = join(work, 'skills-tree', 'src', 'internal', 'skills', 'mefisto-fx-skill')
    skillSource = write(
      join(root, 'SKILL.md'),
      '---\nname: mefisto-fx-skill\ndescription: Skill de fixture\n---\n\n# Titulo\n',
    )
    resource = write(join(root, 'nivel3.txt'), 'recurso\n')
    out = join(work, 'skills-out')
  })

  test('genera .claude/skills/<id>/ con el marcador tras el frontmatter', () => {
    const run = generate(['--out', out, skillSource, resource])
    assert.equal(run.status, 0, run.all)
    assert.equal(
      readFileSync(join(out, '.claude', 'skills', 'mefisto-fx-skill', 'SKILL.md'), 'utf8'),
      `---\nname: mefisto-fx-skill\ndescription: Skill de fixture\n---\n${MARKER}${posix(skillSource)}. No editar a mano. -->\n\n# Titulo\n`,
    )
    assert.equal(
      readFileSync(join(out, '.claude', 'skills', 'mefisto-fx-skill', 'nivel3.txt'), 'utf8'),
      'recurso\n',
    )
    assert.equal(generate(['--check', '--out', out, skillSource, resource]).status, 0)
  })

  test('--check reporta faltante, distinta, sin marcador y huerfana', () => {
    const sources = [skillSource, resource]
    const copy = join(out, '.claude', 'skills', 'mefisto-fx-skill', 'nivel3.txt')
    rmSync(copy)
    assert.equal(
      generate(['--check', '--out', out, ...sources]).stdout,
      '.claude/skills/mefisto-fx-skill/nivel3.txt: faltante\n',
    )
    assert.equal(generate(['--out', out, ...sources]).status, 0)
    appendFileSync(copy, 'x\n')
    assert.equal(
      generate(['--check', '--out', out, ...sources]).stdout,
      '.claude/skills/mefisto-fx-skill/nivel3.txt: distinta\n',
    )
    assert.equal(generate(['--out', out, ...sources]).status, 0)

    const other = join(out, '.claude', 'skills', 'otro', 'SKILL.md')
    write(other, '---\nname: otro\ndescription: x\n---\ncuerpo\n')
    assert.equal(
      generate(['--check', '--out', out, ...sources]).stdout,
      '.claude/skills/otro/SKILL.md: sin marcador\n',
    )
    write(other, `---\nname: otro\ndescription: x\n---\n${MARKER}x. No editar a mano. -->\ncuerpo\n`)
    const orphan = generate(['--check', '--out', out, ...sources])
    assert.equal(orphan.status, 1)
    assert.equal(orphan.stdout, '.claude/skills/otro/SKILL.md: huerfana\n')
  })

  test('el validador rechaza name distinto del directorio, allowed-tools y description ausente', () => {
    const bad = join(work, 'skills-tree', 'src', 'internal', 'skills', 'mefisto-bad-skill', 'SKILL.md')
    write(bad, '---\nname: otro-nombre\ndescription: x\nallowed-tools: Read\n---\ncuerpo\n')
    const first = new Output()
    assert.equal(runValidator([bad], first), 1)
    assert.equal(
      first.stdout,
      `${posix(bad)}: name: 'otro-nombre' distinto del directorio 'mefisto-bad-skill'\n${posix(bad)}: allowed-tools: prohibido en un SKILL.md portable (MEF-ADR-0033)\n`,
    )
    write(bad, '---\nname: mefisto-bad-skill\n---\ncuerpo\n')
    const second = new Output()
    assert.equal(runValidator([bad], second), 1)
    assert.equal(second.stdout, `${posix(bad)}: description: ausente o vacia\n`)
  })
})

describe('Skills publicados proyectados', () => {
  let tree = ''
  let skill = ''
  let examples = ''
  let projections = ''

  before(() => {
    tree = join(work, 'pub-tree')
    skill = write(
      join(tree, 'skills', 'code-comments', 'SKILL.md'),
      '---\nname: code-comments\ndescription: Skill publicado de fixture\n---\n\n# Titulo\n',
    )
    examples = write(join(tree, 'skills', 'code-comments', 'ejemplos.md'), 'ejemplos\n')
    projections = write(
      join(tree, 'skills', 'projections', 'SKILL.md'),
      '---\nname: projections\ndescription: No se proyecta\n---\n\n# P\n',
    )
  })

  test('la lista de proyectados es la esperada', () => {
    assert.deepEqual(PUBLISHED_PROJECTED_SKILLS, ['code-comments'])
  })

  test('skillRelParts solo reconoce las raices de Skills', () => {
    assert.equal(skillRelParts('src/internal/skills/x/SKILL.md'), 'x/SKILL.md')
    assert.equal(skillRelParts('/r/src/internal/skills/x/sub/a.md'), 'x/sub/a.md')
    assert.equal(skillRelParts('/r/skills/code-comments/a.md'), 'code-comments/a.md')
    assert.equal(skillRelParts('skills/projections/SKILL.md'), '')
    assert.equal(skillRelParts('/skills/anc/src/internal/agents/a.md'), '')
  })

  test('proyecta solo los de la lista, con marcador y recursos identicos', () => {
    const out = join(work, 'pub-out')
    const run = generate(['--out', out, skill, examples, projections])
    assert.equal(run.status, 0, run.all)
    const projected = readFileSync(join(out, '.claude', 'skills', 'code-comments', 'SKILL.md'), 'utf8')
    assert.ok(projected.split('\n').slice(0, 5).includes(`${MARKER}${posix(skill)}. No editar a mano. -->`))
    assert.equal(
      readFileSync(join(out, '.claude', 'skills', 'code-comments', 'ejemplos.md'), 'utf8'),
      'ejemplos\n',
    )
    assert.equal(existsSync(join(out, '.claude', 'skills', 'projections')), false)

    assert.equal(generate(['--check', '--out', out, skill, examples]).status, 0)
    appendFileSync(join(out, '.claude', 'skills', 'code-comments', 'SKILL.md'), 'edicion manual\n')
    const edited = generate(['--check', '--out', out, skill, examples])
    assert.equal(edited.status, 1)
    assert.equal(edited.stdout, '.claude/skills/code-comments/SKILL.md: distinta\n')
    assert.equal(generate(['--out', out, skill, examples]).status, 0)
    assert.equal(generate(['--check', '--out', out, skill, examples]).status, 0)
  })

  test('un id presente como Skill interno y como proyectado aborta sin escribir', () => {
    const duplicate = write(
      join(tree, 'src', 'internal', 'skills', 'code-comments', 'SKILL.md'),
      '---\nname: code-comments\ndescription: Duplicado interno\n---\n\n# Dup\n',
    )
    const out = join(work, 'pub-out2')
    const run = generate(['--out', out, skill, duplicate])
    assert.equal(run.status, 1)
    assert.ok(run.stderr.includes("el id de Skill 'code-comments' existe en src/internal/skills/"), run.stderr)
    assert.equal(existsSync(join(out, '.claude', 'skills')), false)
  })

  describe('scan por defecto sobre un clon bajo un ancestro skills/', () => {
    let root = ''

    before(() => {
      root = join(work, 'skills', 'anc')
      cpSync(CONTRACT, join(root, 'src', 'internal', 'contract'), { recursive: true })
      write(join(root, 'src', 'internal', 'agents', 'mefisto-fx-agent-basic.md'), AGENT_BASIC)
      cpSync(join(tree, 'skills'), join(root, 'skills'), { recursive: true })
    })

    test('proyecta con marcador relativo y no salta los agentes', () => {
      const out = join(work, 'rt-out')
      const run = generate(['--out', out], root)
      assert.equal(run.status, 0, run.all)
      assert.ok(existsSync(join(out, '.claude', 'agents', 'mefisto-fx-agent-basic.md')))
      const projected = readFileSync(join(out, '.claude', 'skills', 'code-comments', 'SKILL.md'), 'utf8')
      assert.ok(
        projected.split('\n').slice(0, 5).includes(`${MARKER}skills/code-comments/SKILL.md. No editar a mano. -->`),
      )
      assert.equal(existsSync(join(out, '.claude', 'skills', 'projections')), false)
      assert.equal(generate(['--check', '--out', out], root).status, 0)
    })

    test('el Skill publicado pasa por la validacion previa', () => {
      const published = join(root, 'skills', 'code-comments', 'SKILL.md')
      const original = readFileSync(published, 'utf8')
      writeFileSync(published, '---\nname: otro-nombre\ndescription: x\n---\n\n# T\n')
      const run = generate(['--out', join(work, 'rt-out-bad')], root)
      writeFileSync(published, original)
      assert.equal(run.status, 1)
      assert.ok(run.stderr.includes('skills/code-comments/SKILL.md: name:'), run.stderr)
    })

    test('aborta con un id duplicado', () => {
      write(
        join(root, 'src', 'internal', 'skills', 'code-comments', 'SKILL.md'),
        '---\nname: code-comments\ndescription: Duplicado interno\n---\n\n# Dup\n',
      )
      const run = generate(['--out', join(work, 'rt-out-dup')], root)
      assert.equal(run.status, 1)
      assert.ok(run.stderr.includes("'code-comments'"), run.stderr)
    })

    test('aborta si falta el directorio de un Skill proyectado', () => {
      const empty = join(work, 'sin-skills')
      cpSync(CONTRACT, join(empty, 'src', 'internal', 'contract'), { recursive: true })
      const run = generate(['--out', join(work, 'rt-out-missing')], empty)
      assert.equal(run.status, 1)
      assert.equal(
        run.stderr,
        'ERROR: skills/code-comments/ no existe pero esta en PUBLISHED_PROJECTED_SKILLS\n',
      )
    })
  })
})

describe('escapado JSON como jq', () => {
  test('escapa DEL y los controles, y deja pasar el resto', () => {
    assert.equal(jqJson('\u007f\u001f a<>&é😀"\\\n'), '"\\u007f\\u001f a<>&é😀\\"\\\\\\n"')
    assert.equal(jqJson(['a', 'b"c']), '["a","b\\"c"]')
    assert.equal(jqJson({ b: 1, a: [null, true] }), '{"b":1,"a":[null,true]}')
  })
})

describe('tablas fijas del adaptador', () => {
  test('perfiles y efforts conocidos', () => {
    assert.equal(claudeDefaultModel('fast'), 'haiku')
    assert.equal(claudeDefaultModel('balanced'), 'sonnet')
    assert.equal(claudeDefaultModel('deep'), 'opus')
    assert.equal(claudeDefaultModel('otro'), '')
    assert.equal(claudeDefaultEffort('standard'), 'high')
    assert.equal(claudeDefaultEffort('otro'), null)
  })

  test('coinciden con las del adaptador de runtime', () => {
    for (const profile of ['fast', 'balanced', 'deep', 'otro', '']) {
      assert.equal(claudeDefaultModel(profile), runtimeDefaultModel(profile) ?? '', profile)
    }
    for (const effort of ['quick', 'light', 'standard', 'thorough', 'exhaustive', 'otro', '']) {
      assert.equal(claudeDefaultEffort(effort), runtimeDefaultEffort(effort), effort)
    }
  })
})
