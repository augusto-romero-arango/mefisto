import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { XmlError, packagePinError, xmlElements } from '../lib/package-reference-pin.mts'

const PACKAGE = 'OpenTelemetry.Extensions.Hosting'
const VERSION = '1.15.3'

const pin = (content: string): string | null => packagePinError(PACKAGE, VERSION, 'x.csproj', content)

describe('xmlElements', () => {
  test('lista los elementos con sus atributos, sin importar el formato', () => {
    const elements = xmlElements(
      '<?xml version="1.0" encoding="utf-8"?>\n<!-- cabecera -->\n<Project Sdk="Microsoft.NET.Sdk">\n' +
        "  <ItemGroup>\n    <PackageReference\n      Version = '1.0'\n      Include=\"A.B\" />\n" +
        '    <PackageReference Include="C"></PackageReference >\n  </ItemGroup>\n</Project>\n',
    )
    assert.deepEqual(
      elements.map((element) => [element.name, Object.fromEntries(element.attributes)]),
      [
        ['Project', { Sdk: 'Microsoft.NET.Sdk' }],
        ['ItemGroup', {}],
        ['PackageReference', { Version: '1.0', Include: 'A.B' }],
        ['PackageReference', { Include: 'C' }],
      ],
    )
  })

  test('ignora comentarios, CDATA e instrucciones de proceso', () => {
    const elements = xmlElements(
      '<Project><!-- <PackageReference Include="X" /> --><Nota><![CDATA[<PackageReference Include="Y" />]]></Nota><?pi x?></Project>',
    )
    assert.deepEqual(
      elements.map((element) => element.name),
      ['Project', 'Nota'],
    )
  })

  test('decodifica entidades y quita el prefijo de espacio de nombres', () => {
    const [root, child] = xmlElements('<m:Project xmlns:m="urn:x"><m:Item Include="a&amp;b&#65;&#x42;&quot;" /></m:Project>')
    assert.equal(root?.name, 'Project')
    assert.equal(child?.name, 'Item')
    assert.equal(child?.attributes.get('Include'), 'a&bAB"')
  })

  test('acepta un BOM inicial y un DOCTYPE', () => {
    assert.equal(xmlElements('﻿<!DOCTYPE Project>\n<Project/>').length, 1)
  })

  test('rechaza un documento mal formado', () => {
    const invalid = [
      '',
      'texto',
      '<Project>',
      '<Project></Otro>',
      '</Project>',
      '<Project/><Project/>',
      '<Project><Item Include="a" Include="b"/></Project>',
      '<Project><Item Include=a/></Project>',
      '<Project><Item Include="a/></Project>',
      '<Project><Item Include/></Project>',
      '<Project><Item Include="a"Version="1"/></Project>',
      '<Project><Item Include="a<b"/></Project>',
      '<Project><!-- sin cerrar</Project>',
      '<Project>a & b</Project>',
      '<Project><Item Include="&nada;"/></Project>',
      '<Project/>cola',
      '<Project></Project',
    ]
    for (const text of invalid) assert.throws(() => xmlElements(text), XmlError, text)
  })
})

describe('packagePinError', () => {
  test('acepta el unico pin exacto aunque cambie el formato XML', () => {
    assert.equal(
      pin(`<Project><ItemGroup><PackageReference Version="1.15.3"\n Include="${PACKAGE}"></PackageReference></ItemGroup></Project>`),
      null,
    )
    assert.equal(pin(`<Project><ItemGroup><PackageReference Include="${PACKAGE}" Version="1.15.3" /></ItemGroup></Project>`), null)
  })

  test('no cuenta una referencia comentada ni la de otro paquete', () => {
    assert.equal(
      pin(
        `<Project><ItemGroup><!-- <PackageReference Include="${PACKAGE}" Version="1.0.0" /> -->` +
          `<PackageReference Include="${PACKAGE}" Version="1.15.3" /><PackageReference Include="Otro" Version="9" /></ItemGroup></Project>`,
      ),
      null,
    )
  })

  test('rechaza referencias duplicadas aunque una sea multilinea', () => {
    assert.equal(
      pin(
        `<Project><ItemGroup><PackageReference Include="${PACKAGE}" Version="1.15.3" /><PackageReference\nInclude="${PACKAGE}" ` +
          'Version="1.15.3"></PackageReference></ItemGroup></Project>',
      ),
      `ERROR: paquete ${PACKAGE}: se esperaba exactamente una referencia con pin 1.15.3 en x.csproj; se encontraron 2.`,
    )
  })

  test('rechaza la ausencia de la referencia', () => {
    assert.equal(
      pin('<Project><ItemGroup /></Project>'),
      `ERROR: paquete ${PACKAGE}: se esperaba exactamente una referencia con pin 1.15.3 en x.csproj; se encontraron 0.`,
    )
  })

  test('rechaza un pin distinto, vacio o ausente', () => {
    assert.equal(
      pin(`<Project><ItemGroup><PackageReference Include="${PACKAGE}" Version="1.13.1" /></ItemGroup></Project>`),
      `ERROR: paquete ${PACKAGE}: se esperaba el pin 1.15.3 en x.csproj; se encontro 1.13.1 como atributo Version.`,
    )
    for (const attribute of ['', ' Version=""']) {
      assert.equal(
        pin(`<Project><ItemGroup><PackageReference Include="${PACKAGE}"${attribute} /></ItemGroup></Project>`),
        `ERROR: paquete ${PACKAGE}: se esperaba el pin 1.15.3 en x.csproj; se encontro ningun valor como atributo Version.`,
      )
    }
  })

  test('un XML invalido se reporta con el paquete, el pin y el archivo', () => {
    const error = pin('<Project><ItemGroup></Project>')
    assert.match(
      error ?? '',
      /^ERROR: paquete OpenTelemetry\.Extensions\.Hosting: se esperaba el pin 1\.15\.3 en x\.csproj, pero el XML no es valido: .+\.$/,
    )
  })
})
