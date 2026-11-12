// Textos y reglas de `scaffold-pipeline.mts`: prompt, cuerpo del PR y ayuda byte a byte contra los
// que producia scaffold-pipeline.sh (`fixtures/scaffold-pipeline/`), normalizacion del dominio,
// gate de pines OpenTelemetry y frontera neutral del modulo.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { capture, commandExists } from '../lib/cli.mts'
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
const NO_BASH = process.platform === 'win32'
const work = mkdtempSync(join(tmpdir(), 'mefisto scaffold prompts '))
after(() => rmSync(work, { recursive: true, force: true }))

const golden = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

// Los mismos valores con que se generaron los textos de referencia desde el bash.
const BODY = {
  domain: 'calculo-horas',
  pascal: 'CalculoHoras',
  namespacePrefix: 'Empresa.Proyecto',
}

describe('textos identicos a los de scaffold-pipeline.sh', () => {
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

  test('paridad con el sed, tr, grep y awk de scaffold-pipeline.sh', { skip: NO_BASH }, () => {
    const inputs = ['CalculoHoras', 'calculo_horas', 'v2Api', 'aBC', 'Ventas-Online', 'x', 'mal!nombre']
    for (const input of inputs) {
      const script = [
        'D=$(echo "$1" | sed \'s/_/-/g\' | sed \'s/\\([a-z0-9]\\)\\([A-Z]\\)/\\1-\\2/g\' | tr \'[:upper:]\' \'[:lower:]\')',
        'printf "%s\\n" "$D"',
        'if echo "$D" | grep -qE \'^[a-z][a-z0-9]*(-[a-z0-9]+)*$\'; then echo ok; else echo no; fi',
        "echo \"$D\" | awk -F'-' '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1' OFS=''",
      ].join('\n')
      const result = capture('bash', ['-c', script, 'paridad', input])
      const normalized = normalizeDomain(input)
      assert.equal(result.stdout, `${normalized}\n${isKebabDomain(normalized) ? 'ok' : 'no'}\n${pascalCase(normalized)}\n`, input)
    }
    for (const body of ['x\nDominio: Calculo-Horas y mas\n', 'dominio:\t ab_c', 'Dominio: a Dominio: b']) {
      const result = capture('bash', [
        '-c',
        'echo "$1" | sed -n \'s/.*[Dd]ominio:[[:space:]]*\\([a-zA-Z][a-zA-Z0-9-]*\\).*/\\1/p\' | head -1',
        'paridad',
        body,
      ])
      assert.equal(result.stdout.replace(/\n$/, ''), domainFromIssueBody(body), body)
    }
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

  const PYTHON_GATE = `
import sys
import xml.etree.ElementTree as ET
paquete, version, archivo = sys.argv[1:]
try:
    raiz = ET.parse(archivo).getroot()
except ET.ParseError:
    print("XML")
    raise SystemExit(1)
refs = [e for e in raiz.iter() if e.tag.rsplit("}", 1)[-1] == "PackageReference" and e.get("Include") == paquete]
if len(refs) != 1:
    print(f"N {len(refs)}")
    raise SystemExit(1)
real = refs[0].get("Version")
if real != version:
    print(f"V {real or 'ningun valor'}")
    raise SystemExit(1)
`
  test('paridad con el ElementTree que usaba el bash', { skip: NO_BASH || !commandExists('python3') }, () => {
    const documents = [
      `<Project>${ref('1.15.3')}</Project>`,
      `<Project><ItemGroup>${ref('1.15.3')}${ref('1.13.1')}</ItemGroup></Project>`,
      `<Project xmlns="urn:x"><ItemGroup>${ref('1.13.1')}</ItemGroup></Project>`,
      `<Project><PackageReference Include="${HOSTING}" Version="" /></Project>`,
      `<Project><PackageReference Include="${HOSTING}" Version="1.15.3"></Project>`,
      '<Project/><Otro/>',
      `<Project>&amp;${ref('1.15.3')}</Project>`,
      `﻿<?xml version="1.0"?><!DOCTYPE Project><Project>${ref('1.15.3')}</Project>`,
    ]
    for (const document of documents) {
      const file = csproj(document)
      const python = capture('python3', ['-c', PYTHON_GATE, HOSTING, '1.15.3', file])
      const mine = checkOtelPin(HOSTING, '1.15.3', file)
      const expected =
        python.status === 0
          ? null
          : python.stdout.startsWith('XML')
            ? 'XML'
            : python.stdout.startsWith('N ')
              ? `exactamente una referencia con pin 1.15.3 en ${file}; se encontraron ${python.stdout.slice(2).trim()}.`
              : `se encontro ${python.stdout.slice(2).trim()} como atributo Version.`
      if (expected === null) assert.equal(mine, null, document)
      else if (expected === 'XML') assert.match(mine ?? '', /pero el XML no es valido: /, document)
      else assert.ok((mine ?? '').endsWith(expected), `${document}: ${mine}`)
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

  for (const forbidden of ['claude -p', '--permission-mode', 'bypassPermissions', 'output-format', 'resolveDeclaredAgentModel', '.claude/settings.json', 'checkout -- .claude/', '_pipeline-common.sh', 'API Error', 'process.kill']) {
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
