// Textos y reglas de `scaffold-pipeline.mts`: prompt, cuerpo del PR y ayuda byte a byte contra los
// que producia scaffold-pipeline.mts (`fixtures/scaffold-pipeline/`), normalizacion del dominio,
// gate de pines OpenTelemetry y frontera neutral del modulo.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { OTEL_PIN_CANONICO, XmlError, checkOtelPin, parseXmlElements } from '../lib/pipeline/scaffold-otel-pins.mts'
import { renderWarningRemnantsSection } from '../lib/pipeline/warning-remnants.mts'
import {
  SCAFFOLD_HELP,
  domainFromIssueBody,
  isKebabDomain,
  normalizeDomain,
  pascalCase,
  scaffoldPrompt,
  scaffoldPullRequestBody,
} from '../scaffold-pipeline.mts'
import { FIXTURES } from './scaffold-pipeline-sandbox.mts'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const work = mkdtempSync(join(tmpdir(), 'mefisto scaffold prompts '))
after(() => rmSync(work, { recursive: true, force: true }))

const golden = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

// Los mismos valores con que se generaron los textos de referencia desde el bash.
const BODY = {
  domain: 'calculo-horas',
  pascal: 'CalculoHoras',
  namespacePrefix: 'Empresa.Proyecto',
}

describe('textos identicos a los de scaffold-pipeline.mts', () => {
  test('prompt del domain-scaffolder', () => {
    assert.equal(scaffoldPrompt('calculo-horas'), golden('domain-scaffolder.prompt.txt'))
  })

  test('ayuda, con los escapes de color literales que imprimia cat', () => {
    assert.equal(SCAFFOLD_HELP, golden('help.txt'))
  })

  test('cuerpo del PR con issue y warnings remanentes', () => {
    const worktree = join(work, 'con-remanentes')
    mkdirSync(join(worktree, '.mefisto', 'pipeline'), { recursive: true })
    writeFileSync(join(worktree, '.mefisto', 'pipeline', 'warnings-remanentes.txt'), '#77\nacme/otro#5\n')
    const body = scaffoldPullRequestBody({
      ...BODY,
      commits: '89abcde scaffold(calculo-horas): nuevo dominio CalculoHoras\n0123456 base $HOME `x`',
      remnants: renderWarningRemnantsSection(worktree),
      closesLine: 'Closes #42',
    })
    assert.equal(body, golden('pr-body-issue-remanentes.txt'))
    // Politica de cero warnings nuevos (MEF-ADR-0056): los remanentes van antes del cierre.
    assert.ok(body.indexOf('## Warnings remanentes') < body.indexOf('Closes #42'))
  })

  test('cuerpo del PR sin issue ni remanentes', () => {
    assert.equal(scaffoldPullRequestBody({ ...BODY, commits: '(sin commits)', remnants: '', closesLine: '' }), golden('pr-body-sin-issue.txt'))
  })
})

describe('dominio', () => {
  test('el body nombra el dominio con Dominio: o dominio:, en cualquier parte de la linea', () => {
    assert.equal(domainFromIssueBody('Contexto\n\nDominio: calculo-horas\n'), 'calculo-horas')
    assert.equal(domainFromIssueBody('- **dominio:**\tVentas_Online resto'), '')
    assert.equal(domainFromIssueBody('- dominio:\tVentas-Online resto'), 'Ventas-Online')
    assert.equal(domainFromIssueBody('Dominio: primero\nDominio: segundo'), 'primero')
    assert.equal(domainFromIssueBody('Dominio: a y Dominio: b'), 'b', 'en una linea gana la ultima aparicion')
    assert.equal(domainFromIssueBody('Dominio: crlf\r\n'), 'crlf')
    assert.equal(domainFromIssueBody('Dominio: 9abc'), '')
    assert.equal(domainFromIssueBody('Sin nada'), '')
  })

  test('normaliza PascalCase, camelCase y snake_case a kebab-case', () => {
    assert.equal(normalizeDomain('CalculoHoras'), 'calculo-horas')
    assert.equal(normalizeDomain('calculoHoras'), 'calculo-horas')
    assert.equal(normalizeDomain('calculo_horas'), 'calculo-horas')
    assert.equal(normalizeDomain('ABCdef'), 'abcdef')
    assert.equal(normalizeDomain('v2Api'), 'v2-api')
  })

  test('valida kebab-case como el grep del bash: basta una linea valida', () => {
    assert.equal(isKebabDomain('calculo-horas'), true)
    assert.equal(isKebabDomain('calculo--horas'), false)
    assert.equal(isKebabDomain('9-ventas'), false)
    assert.equal(isKebabDomain('ventas\nmal!'), true)
  })

  test('deriva PascalCase', () => {
    assert.equal(pascalCase('calculo-horas'), 'CalculoHoras')
    assert.equal(pascalCase('v2-api'), 'V2Api')
  })

  test('normaliza, valida y deriva PascalCase de los nombres que recibe', () => {
    const cases: [input: string, normalized: string, kebab: boolean, pascal: string][] = [
      ['CalculoHoras', 'calculo-horas', true, 'CalculoHoras'],
      ['calculo_horas', 'calculo-horas', true, 'CalculoHoras'],
      ['aBC', 'a-bc', true, 'ABc'],
      ['Ventas-Online', 'ventas-online', true, 'VentasOnline'],
      ['x', 'x', true, 'X'],
      ['mal!nombre', 'mal!nombre', false, 'Mal!nombre'],
    ]
    for (const [input, normalized, kebab, pascal] of cases) {
      assert.equal(normalizeDomain(input), normalized, input)
      assert.equal(isKebabDomain(normalized), kebab, input)
      assert.equal(pascalCase(normalized), pascal, input)
    }
  })

  test('lee el dominio del cuerpo del issue: el primero, cortado en el primer caracter invalido', () => {
    assert.equal(domainFromIssueBody('x\nDominio: Calculo-Horas y mas\n'), 'Calculo-Horas')
    assert.equal(domainFromIssueBody('dominio:\t ab_c'), 'ab')
    assert.equal(domainFromIssueBody('Dominio: a Dominio: b'), 'b')
  })
})

describe('gate de pines OpenTelemetry', () => {
  let counter = 0
  const csproj = (content: string): string => {
    const file = join(work, `p-${++counter}.csproj`)
    writeFileSync(file, content)
    return file
  }
  const HOSTING = 'OpenTelemetry.Extensions.Hosting'
  const ref = (version: string, paquete = HOSTING): string => `<PackageReference Include="${paquete}" Version="${version}" />`

  test('el pin canonico es 1.15.3', () => {
    assert.equal(OTEL_PIN_CANONICO, '1.15.3')
  })

  test('una sola referencia con el pin pasa, aunque el proyecto use un espacio de nombres', () => {
    assert.equal(checkOtelPin(HOSTING, '1.15.3', csproj(`<?xml version="1.0" encoding="utf-8"?>\n<Project Sdk="Microsoft.NET.Sdk">\n  <!-- otel -->\n  <ItemGroup>\n    ${ref('1.15.3')}\n  </ItemGroup>\n</Project>\n`)), null)
    assert.equal(checkOtelPin(HOSTING, '1.15.3', csproj(`<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><ItemGroup>${ref('1.15.3')}</ItemGroup></Project>`)), null)
    assert.equal(checkOtelPin(HOSTING, '1.15.3', csproj(`<Project><ItemGroup><PackageReference Version='1.15.3' Include='${HOSTING}'></PackageReference></ItemGroup></Project>`)), null)
  })

  test('cada desvio tiene su diagnostico con paquete, pin y archivo', () => {
    const missing = join(work, 'no-existe.csproj')
    assert.equal(checkOtelPin(HOSTING, '1.15.3', missing), `ERROR: paquete ${HOSTING}: se esperaba el pin 1.15.3 en ${missing}, pero el archivo no existe.`)
    const twice = csproj(`<Project><ItemGroup>${ref('1.15.3')}${ref('1.15.3')}</ItemGroup></Project>`)
    assert.equal(checkOtelPin(HOSTING, '1.15.3', twice), `ERROR: paquete ${HOSTING}: se esperaba exactamente una referencia con pin 1.15.3 en ${twice}; se encontraron 2.`)
    const none = csproj(`<Project><ItemGroup>${ref('1.15.3', 'Otro')}</ItemGroup></Project>`)
    assert.equal(checkOtelPin(HOSTING, '1.15.3', none), `ERROR: paquete ${HOSTING}: se esperaba exactamente una referencia con pin 1.15.3 en ${none}; se encontraron 0.`)
    const old = csproj(`<Project>${ref('1.13.1')}</Project>`)
    assert.equal(checkOtelPin(HOSTING, '1.15.3', old), `ERROR: paquete ${HOSTING}: se esperaba el pin 1.15.3 en ${old}; se encontro 1.13.1 como atributo Version.`)
    const noVersion = csproj(`<Project><PackageReference Include="${HOSTING}" /></Project>`)
    assert.equal(checkOtelPin(HOSTING, '1.15.3', noVersion), `ERROR: paquete ${HOSTING}: se esperaba el pin 1.15.3 en ${noVersion}; se encontro ningun valor como atributo Version.`)
    const broken = csproj(`<Project><ItemGroup>${ref('1.15.3')}</Project>`)
    assert.equal(checkOtelPin(HOSTING, '1.15.3', broken), `ERROR: paquete ${HOSTING}: se esperaba el pin 1.15.3 en ${broken}, pero el XML no es valido: mismatched tag: line 1, column 102.`)
  })

  test('rechaza los documentos mal formados', () => {
    for (const bad of ['', '<a>', '<a></b>', '<a/><b/>', '<a x="1" x="2"/>', '<a x=1/>', '<a>&nope;</a>', 'texto<a/>', '<a/>texto', '<a x="<"/>']) {
      assert.throws(() => parseXmlElements(bad), XmlError, JSON.stringify(bad))
    }
    // Causas y columnas de expat, el analizador que usaba ElementTree.
    for (const [bad, message] of [
      ['', 'no element found: line 1, column 0'],
      ['<a>', 'no element found: line 1, column 3'],
      ['<a/><b/>', 'junk after document element: line 1, column 4'],
      ['<a x="1" x="2"/>', 'duplicate attribute: line 1, column 9'],
      ['<a>&nope;</a>', 'undefined entity: line 1, column 3'],
      ['<a>\n</b>', 'mismatched tag: line 2, column 2'],
    ] as const) {
      assert.throws(() => parseXmlElements(bad), { message }, JSON.stringify(bad))
    }
    assert.deepEqual(
      parseXmlElements('<a:b xmlns:a="u" Include="x &amp; y&#33;"><![CDATA[<no/>]]></a:b>').map((element) => [element.localName, element.attributes.get('Include')]),
      [['b', 'x & y!']],
    )
  })

  test('casos limite: varias referencias, espacio de nombres, version vacia, XML roto, entidades y BOM', () => {
    const fail = (file: string, detail: string): string => `ERROR: paquete ${HOSTING}: se esperaba ${detail.replaceAll('<f>', file)}`
    const cases: [document: string, expected: (file: string) => string | null][] = [
      [`<Project><ItemGroup>${ref('1.15.3')}${ref('1.13.1')}</ItemGroup></Project>`, (f) => fail(f, 'exactamente una referencia con pin 1.15.3 en <f>; se encontraron 2.')],
      [`<Project xmlns="urn:x"><ItemGroup>${ref('1.13.1')}</ItemGroup></Project>`, (f) => fail(f, 'el pin 1.15.3 en <f>; se encontro 1.13.1 como atributo Version.')],
      [`<Project><PackageReference Include="${HOSTING}" Version="" /></Project>`, (f) => fail(f, 'el pin 1.15.3 en <f>; se encontro ningun valor como atributo Version.')],
      [`<Project><PackageReference Include="${HOSTING}" Version="1.15.3"></Project>`, (f) => fail(f, 'el pin 1.15.3 en <f>, pero el XML no es valido: mismatched tag: line 1, column 89.')],
      ['<Project/><Otro/>', (f) => fail(f, 'el pin 1.15.3 en <f>, pero el XML no es valido: junk after document element: line 1, column 10.')],
      [`<Project>&amp;${ref('1.15.3')}</Project>`, () => null],
      [`\ufeff<?xml version="1.0"?><!DOCTYPE Project><Project>${ref('1.15.3')}</Project>`, () => null],
    ]
    for (const [document, expected] of cases) {
      const file = csproj(document)
      assert.equal(checkOtelPin(HOSTING, '1.15.3', file), expected(file), document)
    }
  })

  test('el gate comparte el pin de las recetas del domain-scaffolder', () => {
    const agent = readFileSync(join(REPO_ROOT, 'agents', 'domain-scaffolder.md'), 'utf8')
    for (const paquete of ['OpenTelemetry.Extensions.Hosting', 'OpenTelemetry.Exporter.InMemory']) {
      const recipes = [...agent.matchAll(new RegExp(`<PackageReference Include="${paquete.replaceAll('.', '\\.')}" Version="([^"]+)" />`, 'g'))].map((found) => found[1])
      assert.deepEqual(recipes, [OTEL_PIN_CANONICO], paquete)
    }
  })
})

describe('frontera neutral: el pipeline no conoce ningun runtime concreto', () => {
  const code = ['scripts/scaffold-pipeline.mts', 'scripts/lib/pipeline/scaffold-otel-pins.mts']
    .map((file) => readFileSync(join(REPO_ROOT, ...file.split('/')), 'utf8'))
    .join('\n')

  for (const forbidden of ['claude -p', '--permission-mode', 'bypassPermissions', 'output-format', 'resolveDeclaredAgentModel', '.claude/settings.json', 'checkout -- .claude/', 'API Error', 'process.kill']) {
    test(`no menciona ${forbidden}`, () => {
      assert.equal(code.includes(forbidden), false)
    })
  }

  test('no lanza un shell ni las herramientas de texto del bash', () => {
    assert.equal(/['"`](bash|sh|jq|awk|sed|python3)['"`]/.test(code), false)
  })

  test('delega espera, reanudacion y clasificacion en la politica comun', () => {
    assert.ok(code.includes('runAgentWithPolicy('))
    assert.ok(code.includes('resolveRunnerCommand('))
  })
})
