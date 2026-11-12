// Guards defensivos del plugin, publicados e internos. Los bloques conservan la letra con la que
// los citan los ADRs y los agentes ([F] integridad de Agent Skills, [H] guarda de deploys ajenos).
// El registro MCP publicado y hooks/hooks.json los validan published-artifact-contract.test.mts y
// generate-claude-hooks.test.mts; el blocklist publicado, pipeline-consumer-scope.test.mts.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'

import { isPathInMefistoScope } from '../../src/internal/scripts/lib/mefisto-scope.mts'
import {
  REPO_ROOT,
  assertAbsent,
  assertContains,
  frontmatterOf,
  lineRanges,
  linesOf,
  matchingLines,
  readRepoFile,
  repoPath,
} from './text-contract.mts'

/** Nombres de los archivos `.md` de una carpeta del repo, ordenados. */
function markdownIn(relative: string): string[] {
  return readdirSync(repoPath(relative))
    .filter((name) => name.endsWith('.md'))
    .sort()
}

describe('[A] commands/*.md llevan el guard "cwd != Mefisto"', () => {
  const commands = markdownIn('commands')

  test('hay comandos publicados', () => {
    assert.ok(commands.length > 0)
  })

  // Recorrer la carpeta, y no una lista a mano, evita que un comando nuevo quede sin verificar.
  for (const name of commands) {
    test(`${name}: menciona .claude-plugin/plugin.json o el guard neutral generado`, () => {
      const text = readRepoFile(`commands/${name}`)
      assert.ok(
        text.includes('.claude-plugin/plugin.json') ||
          text.includes('src/internal/scripts/generate-internal-adapters.mts'),
        `${name}: falta el guard`,
      )
    })
  }
})

describe('[B] .claude/commands/mefisto-*.md llevan el guard inverso', () => {
  const commands = markdownIn('.claude/commands').filter((name) => name.startsWith('mefisto-'))

  test('hay comandos internos', () => {
    assert.ok(commands.length > 0)
  })

  for (const name of commands) {
    test(`${name}: menciona .claude-plugin/plugin.json (guard inverso)`, () => {
      assertContains(readRepoFile(`.claude/commands/${name}`), '.claude-plugin/plugin.json')
    })
  }
})

describe('[C2] los scripts publicados abortan cuando se ejecutan en el repo de Mefisto', () => {
  const SCRIPTS = [
    'appinsights-query',
    'setup-github-ci',
    'setup-github-labels',
    'bootstrap-backend',
    'seed-secret',
    'onboard-diagnose',
    'onboard-migrate-directives',
    'onboard-activate-repo',
    'update-plugin',
    'upgrade',
    'purge-store',
    'next-order',
    'field-note',
    'warnings-diff',
    'tooling-pipeline',
    'tdd-pipeline',
    'scaffold-pipeline',
    'iac-pipeline',
    'launch-pipeline',
  ]

  // Entorno fijo: sin variables de git, Claude, herdr ni Mefisto que hereden del proceso que corre
  // la suite, y con stdin vacio. Asi el guard es lo unico que decide la salida.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(GIT_|CLAUDE|HERDR|MEFISTO)/i.test(key)),
  )

  for (const name of SCRIPTS) {
    test(`${name}.mts: aborta con exit 1 y el mensaje del guard`, () => {
      const result = spawnSync(process.execPath, [repoPath(`scripts/${name}.mts`)], {
        cwd: REPO_ROOT,
        env,
        input: '',
        encoding: 'utf8',
        timeout: 60_000,
      })
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      assert.deepEqual(
        [result.status, output.includes('plugin publicado y solo aplica al consumidor')],
        [1, true],
        `salida de ${name}.mts (status ${result.status}, signal ${result.signal}):\n${output}`,
      )
    })
  }
})

describe('[E2] is_path_in_mefisto_scope clasifica correctamente', () => {
  const VALID = [
    'commands/foo.md',
    'skills/projections/SKILL.md',
    'skills/projections/scripts/check.sh',
    'agents/bar.md',
    'scripts/baz.sh',
    'hooks/hooks.json',
    'docs/adr/mef-adr-0001-service-bus-topics-por-evento.md',
    '.claude-plugin/plugin.json',
    '.claude/commands/mefisto-foo.md',
    '.claude/skills/mefisto-doctrina/SKILL.md',
    '.claude/mods/mefisto-divine-wager/hooks/register.tsx',
    '.claude/settings.json',
    '.mcp.json',
    'mefisto-manifest.json',
    'changelog.d/380.added.md',
    'changelog.d/README.md',
    'README.md',
    'src/internal/foo.ts',
    'src/internal/skills/foo/SKILL.md',
    'src/published/foo.md',
    'src/runtime/foo.sh',
    'dist/x',
    'AGENTS.md',
    '.github/workflows/ci.yml',
    '.github/rulesets/main.json',
  ]
  // `.mcp.json` y `mefisto-manifest.json` son entradas exactas de la raiz (issues #763 y #1135).
  const INVALID = [
    'src/Foo.cs',
    'src/otro/x.sh',
    'src/publication/foo.md',
    'src/runtime-local/foo.sh',
    'distribution/x',
    'dist-local/x',
    'tests/Bar.cs',
    '.github/CODEOWNERS',
    '.github/workflows',
    '.github/rulesets',
    'infra/main.tf',
    '.claude/harness.config.json',
    '.claude/pipeline/events.log',
    'sub/.mcp.json',
    'foo.mcp.json',
    'sub/mefisto-manifest.json',
    'mefisto-manifest.json.bak',
    'foo-mefisto-manifest.json',
    'mefisto-manifest.json/foo',
    'mefisto-manifest.json\\foo',
    '.mefisto/pipeline/events.log',
    '.mefisto/models.json',
  ]

  test('las rutas del plugin estan en scope', () => {
    assert.deepEqual(
      VALID.filter((path) => !isPathInMefistoScope(path)),
      [],
    )
  })

  test('las rutas ajenas al plugin quedan fuera', () => {
    assert.deepEqual(
      INVALID.filter((path) => isPathInMefistoScope(path)),
      [],
    )
  })
})

// MEF-ADR-0033 seccion 4: un `skills:` mal escrito no aborta el agente ni deja error visible; en
// un pipeline headless el subagente correria sin su doctrina.
describe('[F] integridad de los Agent Skills', () => {
  // Campos que MEF-ADR-0050 seccion 3 admite en el frontmatter de un SKILL.md.
  const PORTABLE_FIELDS = ['name', 'description', 'license', 'compatibility', 'metadata']

  function frontmatterLines(text: string): string[] {
    return linesOf(text)[0] === '---' ? linesOf(frontmatterOf(text)) : []
  }

  function frontmatterField(text: string, field: string): string {
    const line = frontmatterLines(text).find((candidate) => candidate.startsWith(`${field}:`))
    return (line ?? '')
      .slice(field.length + 1)
      .replace(/^[ \t]*/, '')
      .replace(/^["']|["']$/g, '')
  }

  /** Claves de nivel superior fuera del estandar portable; una linea indentada es una sub-clave. */
  function nonPortableFields(text: string): string[] {
    return frontmatterLines(text)
      .map((line) => /^[A-Za-z][A-Za-z0-9-]*(?=:)/.exec(line)?.[0])
      .filter((key): key is string => key !== undefined && !PORTABLE_FIELDS.includes(key))
  }

  /** `skills:` del frontmatter, en forma de lista YAML o inline (`skills: [a, "b"]`). */
  function skillReferences(text: string): string[] {
    const refs: string[] = []
    let inList = false
    for (const line of frontmatterLines(text)) {
      if (/^skills:[ \t]*$/.test(line)) {
        inList = true
        continue
      }
      if (inList && /^[ \t]*-[ \t]*/.test(line)) {
        refs.push(line.replace(/^[ \t]*-[ \t]*/, ''))
        continue
      }
      inList = false
      if (line.startsWith('skills:')) refs.push(...line.slice('skills:'.length).replace(/[[\],]/g, ' ').split(/[ \t]+/))
    }
    return [...new Set(refs.map((ref) => ref.replace(/["']/g, '').trim()).filter((ref) => ref !== ''))].sort()
  }

  function filesNamed(root: string, name: string): string[] {
    const found: string[] = []
    const walk = (relative: string): void => {
      let entries
      try {
        entries = readdirSync(repoPath(relative), { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const child = `${relative}/${entry.name}`
        if (entry.isDirectory()) walk(child)
        else if (entry.isFile() && (name.startsWith('.') ? entry.name.endsWith(name) : entry.name === name)) {
          found.push(child)
        }
      }
    }
    walk(root)
    return found.sort()
  }

  const skillFiles = [...filesNamed('skills', 'SKILL.md'), ...filesNamed('.claude/skills', 'SKILL.md')]
  const skillNames = new Set(skillFiles.map((path) => frontmatterField(readRepoFile(path), 'name')))

  test('hay Agent Skills en el repo', () => {
    assert.ok(skillFiles.length > 0)
  })

  for (const path of skillFiles) {
    const text = readRepoFile(path)
    const directory = dirname(path)
    const directoryName = directory.split('/').at(-1)

    test(`F1 ${path}: name coincide con su directorio`, () => {
      assert.equal(frontmatterField(text, 'name'), directoryName)
    })

    test(`F2 ${path}: tiene description (sin ella el Skill nunca se dispara)`, () => {
      assert.notEqual(frontmatterField(text, 'description'), '')
    })

    test(`F3 ${path}: existen los recursos de Nivel 3 que referencia`, () => {
      const resources = [...new Set([...text.matchAll(/\]\(([^)]*\.md)\)/g)].map((match) => match[1] ?? ''))]
      const missing = resources
        .filter((resource) => !/^(http|#|\/)/.test(resource))
        .filter((resource) => !existsSync(repoPath(`${directory}/${resource}`)))
      assert.deepEqual(missing, [])
    })

    test(`F5 ${path}: el frontmatter se limita al estandar portable (MEF-ADR-0050)`, () => {
      assert.deepEqual(nonPortableFields(text), [], `solo ${PORTABLE_FIELDS.join('/')}`)
    })
  }

  test('F5 detecta allowed-tools escrito a mano y no marca sub-claves de metadata', () => {
    assert.deepEqual(
      nonPortableFields('---\nname: x\ndescription: Fixture.\nallowed-tools: Bash\n---\n\n# Fixture\n'),
      ['allowed-tools'],
    )
    assert.deepEqual(
      nonPortableFields('---\nname: x\ndescription: Fixture.\nmetadata:\n  author: x\n  version: "1.0"\n---\n'),
      [],
    )
  })

  test('F4 lee skills: en forma de lista y en forma inline', () => {
    assert.deepEqual(skillReferences('---\nname: a\nskills:\n  - uno\n  - "dos"\ndescription: x\n---\n'), ['dos', 'uno'])
    assert.deepEqual(skillReferences('---\nskills: ["uno","dos"]\n---\n'), ['dos', 'uno'])
    assert.deepEqual(skillReferences('---\nskills: [uno, dos]\n---\nskills: [tres]\n'), ['dos', 'uno'])
  })

  const agentFiles = [...filesNamed('agents', '.md'), ...filesNamed('.claude/agents', '.md')]
  for (const path of agentFiles) {
    const refs = skillReferences(readRepoFile(path))
    if (refs.length === 0) continue
    test(`F4 ${path}: cada skills: resuelve a un SKILL.md real`, () => {
      assert.deepEqual(
        refs.filter((ref) => !skillNames.has(ref)),
        [],
      )
    })
  }
})

// Claude Code expande `$1..$9`, `${N}`, `$*`, `$@` y `$#` en el texto de un slash command antes de
// entregarlo al modelo, aun dentro de comillas simples (issue #443).
describe('[G] sin sintaxis posicional de shell en los bloques bash de commands/*.md', () => {
  const POSITIONAL = [/\$[1-9]/, /\$\{[0-9]+\}/, /\$\*/, /\$@/, /\$#/]

  function positionalLeaks(markdown: string): string[] {
    const leaks: string[] = []
    let inBash = false
    for (const [index, line] of linesOf(markdown).entries()) {
      if (line.startsWith('```bash')) inBash = true
      else if (line.startsWith('```')) inBash = false
      else if (inBash && POSITIONAL.some((pattern) => pattern.test(line))) leaks.push(`${index + 1}: ${line}`)
    }
    return leaks
  }

  test('ningun comando publicado la contiene', () => {
    const leaks = markdownIn('commands').flatMap((name) =>
      positionalLeaks(readRepoFile(`commands/${name}`)).map((leak) => `${name}:${leak}`),
    )
    assert.deepEqual(leaks, [])
  })

  test('el guard detecta un $1 escrito a mano', () => {
    assert.deepEqual(positionalLeaks('Prosa.\n\n```bash\necho "$1"\n```\n'), ['4: echo "$1"'])
  })

  test('el guard no marca $ARGUMENTS ni ${#ARRAY[@]}', () => {
    assert.deepEqual(positionalLeaks('```bash\necho "$ARGUMENTS"\necho "${#SEC_NAMES[@]}"\n```\n'), [])
  })
})

// Issue #604, MEF-ADR-0031 seccion 4: la guarda de smoke-tests-dominio.yml encuentra los deploys
// ajenos por convenciones de nombre; si una plantilla se renombra sin mover el literal, la guarda
// deja de ver a ese invocador en silencio.
describe('[H] guarda de deploys ajenos: convenciones acopladas', () => {
  const DS = readRepoFile('agents/domain-scaffolder.md')
  const PS = readRepoFile('agents/projections-scaffolder.md')
  const guard = matchingLines(DS, 'startswith("Deploy ")')
    .filter((line) => line.text.includes('workflow_runs'))
    .map((line) => line.text)
    .join('\n')
  const hasDeployJob = (text: string): boolean => matchingLines(text, /^ {2}deploy:$/).length > 0

  test('la plantilla del reutilizable conserva el filtro de runs de la guarda', () => {
    assert.notEqual(guard, '')
  })

  test("la guarda se condiciona a inputs.expected_sha == '' (sin enumerar dominios)", () => {
    assertContains(DS, "if: inputs.expected_sha == ''")
  })

  test("la plantilla deploy-{kebab}.yml conserva un nombre de workflow con prefijo 'Deploy '", () => {
    assert.ok(matchingLines(DS, /^name: Deploy \{PascalCase\}/).length > 0)
  })

  test("el job 'deploy' de la plantilla y el literal que la guarda busca coinciden", () => {
    assert.ok(hasDeployJob(DS) && DS.includes('select(.name == "deploy")'))
  })

  // La guarda falla si un run 'Deploy *' no expone un job 'deploy': todo workflow del marco con ese
  // prefijo que no despliega una Function App debe estar excluido por path.
  for (const name of markdownIn('agents').filter((file) => file !== 'domain-scaffolder.md')) {
    const text = readRepoFile(`agents/${name}`)
    if (matchingLines(text, /^name: Deploy /).length === 0) continue
    test(`${name}: sus workflows 'Deploy *' estan excluidos por path o declaran un job 'deploy'`, () => {
      const generated = [...new Set(text.match(/\.github\/workflows\/deploy-[A-Za-z0-9{}.-]+\.yml/g) ?? [])].sort()
      assert.ok(generated.length > 0, 'emite un workflow Deploy * sin un path .github/workflows/deploy-*.yml')
      assert.deepEqual(
        generated.filter((workflow) => !guard.includes(`select(.path != "${workflow}")`) && !hasDeployJob(text)),
        [],
      )
    })
  }

  test("el job 'publish' del worker y el literal del paso de espera coinciden (issue #2469)", () => {
    assert.ok(matchingLines(PS, /^ {2}publish:$/).length > 0 && DS.includes('select(.name == "publish")'))
  })

  test('el paso de espera del worker busca el path que genera projections-scaffolder', () => {
    const waitStep = matchingLines(DS, 'deploy-projections.yml") | select(.id')
      .map((line) => line.text)
      .join('\n')
    assertContains(PS, '.github/workflows/deploy-projections.yml')
    assertContains(waitStep, '== ".github/workflows/deploy-projections.yml"')
  })

  test('la guarda publica el output expected_sha de la promocion (issue #2468)', () => {
    assertContains(DS, 'id: guarda_deploys_ajenos')
    assertContains(DS, 'echo "expected_sha=$SHA" >> "$GITHUB_OUTPUT"')
  })

  test('la guarda invoca promover_gate_por_sha tras la espera', () => {
    assert.ok(matchingLines(DS, /^\s+promover_gate_por_sha$/).length > 0)
  })

  test("'Smoke tests' consume el expected_sha del input o el promovido por la guarda", () => {
    assertContains(
      DS,
      "Api__ExpectedSha: ${{ inputs.expected_sha != '' && inputs.expected_sha || steps.guarda_deploys_ajenos.outputs.expected_sha }}",
    )
  })

  test('el app-name: de deploy-{kebab}.yml y el host del base_url derivan el mismo FA', () => {
    const appNames = [
      ...new Set(
        matchingLines(DS, /^\s+app-name: /)
          .map((line) => line.text)
          .filter((line) => line.includes('func-'))
          .map((line) => line.replace(/^\s+app-name: /, '')),
      ),
    ]
    const hosts = [
      ...new Set(
        matchingLines(DS, /^\s+base_url: https:\/\/func-/).map((line) =>
          line.text.replace(/^\s+base_url: https:\/\/([^/]+)\.azurewebsites\.net.*/, '$1'),
        ),
      ),
    ]
    assert.deepEqual([appNames, hosts], [['func-{kebab}-{prefix_func}'], ['func-{kebab}-{prefix_func}']])
  })

  // Sin la concesion el run muere en startup_failure sin annotation.
  test("las 3 plantillas conceden 'actions: read' (reutilizable + 2 invocadores)", () => {
    assert.equal(matchingLines(DS, /^\s+actions: read/).length, 3)
  })
})

describe('[I] agents/planner.md delega el cierre documental en field-note.mts', () => {
  const PLANNER = readRepoFile('agents/planner.md')

  for (const required of [
    '"${MEFISTO_PACKAGE_ROOT}/scripts/field-note.mts"',
    '--session-id "$SESSION_ID"',
    '--timestamp "$CLOSING_TIMESTAMP"',
    '--field-note "$FIELD_NOTE_LOCAL"',
    '[ -f "$GLOSSARY_LOCAL" ] || GLOSSARY_PATH=""',
    'nunca crees la rama documental ahí',
  ]) {
    test(`planner conserva '${required}'`, () => {
      assertContains(PLANNER, required)
    })
  }

  for (const forbidden of [
    'git worktree add -b "$DOC_BRANCH"',
    'git -C "$WORKTREE_DIR" commit',
    'gh pr create --base "$DEFAULT_BRANCH" --head "$DOC_BRANCH"',
  ]) {
    test(`planner no reimplementa '${forbidden}' (delega en field-note.mts)`, () => {
      assertAbsent(PLANNER, forbidden)
    })
  }
})

describe('[J] mefisto-planner delega el cierre documental en mefisto-field-note (issue #1298)', () => {
  const MEFISTO_PLANNER = readRepoFile('src/internal/agents/mefisto-planner.md')

  for (const required of [
    'SESSION_TIMESTAMP=$(date "+%Y-%m-%d-%H%M")',
    'SESSION_ID="${SESSION_TIMESTAMP}-$(date +%S)-$(git rev-parse --short=12 HEAD)-$$"',
    'Nunca escribas la field note, crees una rama documental',
    'FIELD_NOTE_DIR="$(git rev-parse --show-toplevel)/.mefisto/pipeline/summaries"',
    'FIELD_NOTE_LOCAL="$FIELD_NOTE_DIR/mefisto-planner-field-note-${SESSION_ID}.md"',
    '{{mefisto:run mefisto-field-note.mts --agent mefisto-planner --timestamp "$CLOSING_TIMESTAMP" --session-id "$SESSION_ID"}} < "$FIELD_NOTE_LOCAL"',
    'nunca crees la rama documental ahi',
  ]) {
    test(`mefisto-planner conserva '${required}'`, () => {
      assertContains(MEFISTO_PLANNER, required)
    })
  }

  // El ultimo no es mecanica de git sino neutralidad (MEF-ADR-0050): el borrador vive en .mefisto/.
  for (const forbidden of [
    'INITIAL_HEAD_REF=$(git symbolic-ref -q --short HEAD || true)',
    'INITIAL_DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef',
    'git worktree add -b "$DOC_BRANCH"',
    'git -C "$WORKTREE_DIR" commit',
    'gh pr create --base "$DEFAULT_BRANCH" --head "$DOC_BRANCH"',
    'CURRENT_HEAD_REF=$(git symbolic-ref -q --short HEAD || true)',
    'FIELD_NOTE_LOCAL="/tmp',
  ]) {
    test(`mefisto-planner no reimplementa '${forbidden}'`, () => {
      assertAbsent(MEFISTO_PLANNER, forbidden)
    })
  }
})

describe('[K] domain-scaffolder normaliza a LF los archivos heredados de func init', () => {
  const DS = readRepoFile('agents/domain-scaffolder.md')
  // Acotado al bloque de normalizacion: ambas rutas aparecen tambien en otras secciones.
  const start = /^\*\*Normalizar a LF los archivos heredados de `func init`/
  const block = lineRanges(DS, start, /^Despues de `func init`/)[0] ?? ''

  for (const required of [
    '"$REPO_ROOT/src/<RootNamespace>.{PascalCase}/.gitignore"',
    '"$REPO_ROOT/src/<RootNamespace>.{PascalCase}/<RootNamespace>.{PascalCase}.csproj"',
    "tr -d '\\r'",
    'El comando es idempotente',
    'no reemplaces ni borres el `.gitignore`',
  ]) {
    test(`conserva '${required}' en la normalizacion LF`, () => {
      assertContains(block, required)
    })
  }

  test('verifica el diff staged, incluidos los archivos nuevos de func init', () => {
    assertContains(DS, 'git diff --cached --check')
  })
})
