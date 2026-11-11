import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  detectPreexistingRedTests,
  listReviewerTouchedTests,
  preexistingRedOnly,
  redMethodBody,
  redTestsText,
  renderReviewerTouchedTestsSection,
} from '../lib/pipeline/red-tests.mts'
import { writeIn } from './consumer-sandbox.mts'
import { git, isolateGitConfig } from './field-note-sandbox.mts'
import { NO_BASH_TWIN, bashTwin } from './pipeline-metrics-parity.mts'

const PIN_TESTS = `public class PinTests
{
    [Fact]
    public void Pin_NoTocado()
    {
        Assert.Equal(28, Catalogo.Count);
    }
    [Fact]
    public void Pin_Modificado()
    {
        Assert.Equal(28, Catalogo.Count);
    }
    [Theory]
    public void Pin_Teoria(int valor)
    {
        if (valor > 0) { Assert.True(true); }
    }
    [Fact]
    public void Pin_Flecha() =>
        Assert.Equal(28, Catalogo.Count);
    [Fact]
    public void Pin_Borrado()
    {
        Assert.True(true);
    }
}
`
const NEW_TESTS = `public class NuevosTests
{
    [Fact]
    public void Nuevo_Rojo()
    {
        Assert.True(false);
    }
}
`
const PIN_FILE = 'tests/X.Dom.Tests/PinTests.cs'

const failed = (...names: string[]): string => `${names.map((name) => `  failed ${name} (12ms)\n    Assert.Equal() Failure\n`).join('')}Test run summary: Failed!\n`

// Salidas de la fase roja de la paridad.
const OUTPUTS: Record<string, string> = {
  'preexistente, modificado y nuevo': failed('X.Dom.Tests.PinTests.Pin_NoTocado', 'X.Dom.Tests.PinTests.Pin_Modificado', 'X.Dom.Tests.NuevosTests.Nuevo_Rojo'),
  'solo preexistentes': failed('X.Dom.Tests.PinTests.Pin_NoTocado', 'X.Dom.Tests.PinTests.Pin_Flecha'),
  'teoria con parametros y repetida': failed('X.Dom.Tests.PinTests.Pin_Teoria(valor: 1)', 'X.Dom.Tests.PinTests.Pin_Teoria(valor: 2)'),
  'archivo borrado y test borrado': failed('X.Dom.Tests.PinTests.Pin_Borrado', 'X.Dom.Tests.OtroTests.Otro_Borrado'),
  'con colores y otros marcadores': '\u001b[31m  failed\u001b[0m X.Dom.Tests.PinTests.Pin_NoTocado (3ms)\n\t✗ X.Dom.Tests.PinTests.Pin_Flecha\n× Pin_Teoria\r\n',
  'nombre que no es identificador': failed('X.Dom.Tests.PinTests.Pin_NoTocado', 'X.Dom.Tests.Generico<T>.Metodo<T>'),
  'sin formato': 'basura sin formato',
  vacia: '',
  'failed sin nombre': 'failed\n  failed   \n',
}

let work = ''
let worktree = ''
let snapshot = ''
let restoreGit = (): void => {}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mefisto red tests '))
  restoreGit = isolateGitConfig(work)
  worktree = join(work, 'wt')
  mkdirSync(worktree)
  git(worktree, 'init', '-q', '-b', 'main')
  git(worktree, 'config', 'user.email', 't@t')
  git(worktree, 'config', 'user.name', 't')
  writeIn(worktree, PIN_FILE, PIN_TESTS)
  writeIn(worktree, 'tests/X.Dom.Tests/OtroTests.cs', 'public class OtroTests\n{\n    public void Otro_Borrado()\n    {\n    }\n}\n')
  writeIn(worktree, 'src/X.Dom/Catalogo.cs', 'public class Catalogo { public void Pin_NoTocado() { } }\n')
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-qm', 'base')
  snapshot = git(worktree, 'rev-parse', 'HEAD')
  // El test-writer modifica un pin, borra otro, borra un archivo y agrega un test nuevo.
  const modified = PIN_TESTS.replace(/(Pin_Modificado\(\)\n    \{\n        Assert\.Equal\()28/, '$129').replace(
    /    \[Fact\]\n    public void Pin_Borrado\(\)\n    \{\n        Assert\.True\(true\);\n    \}\n/,
    '',
  )
  assert.notEqual(modified, PIN_TESTS)
  writeFileSync(join(worktree, ...PIN_FILE.split('/')), modified + NEW_TESTS)
  rmSync(join(worktree, 'tests', 'X.Dom.Tests', 'OtroTests.cs'))
})

after(() => {
  restoreGit()
  rmSync(work, { recursive: true, force: true })
})

describe('redMethodBody', () => {
  test('toma el metodo desde su firma hasta que las llaves balancean', () => {
    assert.equal(
      redMethodBody(PIN_TESTS, 'Pin_Teoria'),
      '    public void Pin_Teoria(int valor)\n    {\n        if (valor > 0) { Assert.True(true); }\n    }\n',
    )
  })

  test('un cuerpo con => termina en su punto y coma', () => {
    assert.equal(redMethodBody(PIN_TESTS, 'Pin_Flecha'), '    public void Pin_Flecha() =>\n        Assert.Equal(28, Catalogo.Count);\n')
    assert.equal(redMethodBody('  int Uno() => 1;\n  int Dos() => 2;\n', 'Uno'), '  int Uno() => 1;\n')
  })

  test('sin coincidencia no devuelve nada; el nombre debe ir tras un espacio', () => {
    assert.equal(redMethodBody(PIN_TESTS, 'NoExiste'), '')
    assert.equal(redMethodBody('void Pin_NoTocado()\n{\n}\n', 'Pin_NoTocado'), 'void Pin_NoTocado()\n{\n}\n')
    assert.equal(redMethodBody('Pin_NoTocado()\n{\n}\n', 'Pin_NoTocado'), '')
  })

  test('un metodo sin cerrar llega al final del archivo', () => {
    assert.equal(redMethodBody('  void Abierto()\n  {\n    x();', 'Abierto'), '  void Abierto()\n  {\n    x();\n')
  })
})

describe('detectPreexistingRedTests', () => {
  test('reporta el preexistente sin modificar; no el nuevo ni el modificado', () => {
    const result = detectPreexistingRedTests(worktree, snapshot, OUTPUTS['preexistente, modificado y nuevo'] ?? '')
    assert.deepEqual(result, { status: 0, tests: [{ test: 'Pin_NoTocado', file: PIN_FILE }] })
    assert.equal(redTestsText(result.tests), `Pin_NoTocado\t${PIN_FILE}\n`)
  })

  test('una teoria se reporta una vez, sin sus parametros', () => {
    const result = detectPreexistingRedTests(worktree, snapshot, OUTPUTS['teoria con parametros y repetida'] ?? '')
    assert.deepEqual(result, { status: 0, tests: [{ test: 'Pin_Teoria', file: PIN_FILE }] })
  })

  test('una salida sin fallos reconocibles o un snapshot invalido degradan a 2', () => {
    assert.deepEqual(detectPreexistingRedTests(worktree, snapshot, 'basura sin formato'), { status: 2, tests: [] })
    assert.deepEqual(detectPreexistingRedTests(worktree, 'deadbeef', OUTPUTS['solo preexistentes'] ?? ''), { status: 2, tests: [] })
  })
})

describe('preexistingRedOnly', () => {
  test('con solo preexistentes sin modificar devuelve la lista', () => {
    assert.deepEqual(preexistingRedOnly(worktree, snapshot, OUTPUTS['solo preexistentes'] ?? ''), {
      status: 0,
      tests: [
        { test: 'Pin_NoTocado', file: PIN_FILE },
        { test: 'Pin_Flecha', file: PIN_FILE },
      ],
    })
  })

  test('un rojo nuevo da 1 y un analisis fallido da 2', () => {
    assert.deepEqual(preexistingRedOnly(worktree, snapshot, OUTPUTS['preexistente, modificado y nuevo'] ?? ''), { status: 1, tests: [] })
    assert.deepEqual(preexistingRedOnly(worktree, snapshot, failed('X.Dom.Tests.NuevosTests.Nuevo_Rojo')), { status: 1, tests: [] })
    assert.deepEqual(preexistingRedOnly(worktree, snapshot, 'basura'), { status: 2, tests: [] })
  })
})

describe('tests que toca el reviewer', () => {
  let repo = ''
  let base = ''

  before(() => {
    repo = join(work, 'reviewer')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 't')
    writeIn(repo, 'tests/X.Tests/GuardTests.cs', 'Assert.Equal(28, Catalogo.Count);\n')
    writeIn(repo, 'tests/X.Tests/ViejoTests.cs', 'viejo\n')
    writeIn(repo, 'src/X/Codigo.cs', 'codigo\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')
    base = git(repo, 'rev-parse', 'HEAD')
  })

  test('sin cambios la lista esta vacia', () => {
    assert.deepEqual(listReviewerTouchedTests(repo, base), [])
  })

  test('lista los tests modificados y eliminados, no los nuevos ni lo que esta fuera de tests/', () => {
    writeIn(repo, 'tests/X.Tests/GuardTests.cs', 'Assert.Equal(29, Catalogo.Count);\n')
    writeIn(repo, 'tests/X.Tests/NuevoTests.cs', 'nuevo\n')
    writeIn(repo, 'src/X/Codigo.cs', 'otro codigo\n')
    rmSync(join(repo, 'tests', 'X.Tests', 'ViejoTests.cs'))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'reviewer ajusta guarda')
    assert.deepEqual(listReviewerTouchedTests(repo, base), ['tests/X.Tests/GuardTests.cs', 'tests/X.Tests/ViejoTests.cs'])
    assert.deepEqual(listReviewerTouchedTests(repo, 'no-existe'), [])
  })

  test('seccion del PR: una linea por archivo, y la del destrabe solo si lo hubo', () => {
    const files = ['tests/A.Tests/ATests.cs', 'tests/B.Tests/BTests.cs']
    assert.equal(renderReviewerTouchedTestsSection([]), '')
    assert.equal(renderReviewerTouchedTestsSection(['']), '')
    assert.equal(
      renderReviewerTouchedTestsSection(files),
      '## Tests ajustados por el reviewer\n\n' +
        'El reviewer modifico, renombro o elimino estos tests existentes en la fase refactor; se revisan en el diff del PR.\n\n' +
        '- `tests/A.Tests/ATests.cs`\n- `tests/B.Tests/BTests.cs`\n\n',
    )
    assert.match(renderReviewerTouchedTestsSection(files, true), /\n\nLo hizo al destrabar tests en rojo despues de la fase verde\.\n\n- `tests/)
  })

  test('paridad: list_reviewer_touched_tests y render_reviewer_touched_tests_section', { skip: NO_BASH_TWIN }, () => {
    for (const ref of [base, 'HEAD', 'no-existe']) {
      const bash = bashTwin('list_reviewer_touched_tests "$@"', [repo, ref])
      assert.equal(listReviewerTouchedTests(repo, ref).map((file) => `${file}\n`).join(''), bash.stdout, ref)
    }
    for (const files of [[], ['tests/A.Tests/ATests.cs'], ['tests/A.Tests/ATests.cs', '', 'tests/B con espacio/B`Tests.cs']]) {
      for (const resolved of [false, true]) {
        const bash = bashTwin('render_reviewer_touched_tests_section "$@"', [files.join('\n'), String(resolved)])
        assert.equal(renderReviewerTouchedTestsSection(files, resolved), bash.stdout)
      }
    }
  })
})

describe('paridad con la gemela bash', { skip: NO_BASH_TWIN }, () => {
  test('_red_method_body', () => {
    const current = readFileSync(join(worktree, ...PIN_FILE.split('/')), 'utf8')
    const sources = [PIN_TESTS, current, '  int Uno() => 1;\n  int Dos() => 2;\n', '  void Abierto()\n  {\n    x();', 'void F()\r\n{\r\n}\r\nvoid G() =>\r\n  1;\r\n', '  int Tres() => new[] { 1 }.Length;\n  int Cuatro() { return 4; } // }\n']
    for (const source of sources) {
      for (const method of ['Pin_NoTocado', 'Pin_Modificado', 'Pin_Teoria', 'Pin_Flecha', 'Pin_Borrado', 'Nuevo_Rojo', 'Uno', 'Dos', 'Abierto', 'F', 'G', 'Tres', 'Cuatro', 'NoExiste']) {
        const bash = capture(source, method)
        assert.equal(redMethodBody(source, method), bash, `${method} en ${JSON.stringify(source.slice(0, 30))}`)
      }
    }
  })

  for (const [name, output] of Object.entries(OUTPUTS)) {
    test(`detect_preexisting_red_tests y preexisting_red_only: ${name}`, () => {
      for (const ref of [snapshot, 'deadbeef']) {
        const detected = detectPreexistingRedTests(worktree, ref, output)
        const bashDetected = bashTwin('detect_preexisting_red_tests "$@"', [worktree, ref, output])
        assert.equal(detected.status, bashDetected.status)
        assert.equal(redTestsText(detected.tests), bashDetected.stdout)
        const only = preexistingRedOnly(worktree, ref, output)
        const bashOnly = bashTwin('preexisting_red_only "$@"', [worktree, ref, output])
        assert.equal(only.status, bashOnly.status)
        assert.equal(redTestsText(only.tests), bashOnly.stdout)
      }
    })
  }
})

/** Salida de `_red_method_body` con `source` por la entrada estandar. */
function capture(source: string, method: string): string {
  const file = join(work, 'fuente.cs')
  writeFileSync(file, source)
  return bashTwin('_red_method_body "$2" < "$1"', [file, method]).stdout
}
