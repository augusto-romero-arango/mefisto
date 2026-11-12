import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { validateVariantLabel } from '../lib/pipeline/variant.mts'

const LABEL_40 = 'a'.repeat(40)
const LABEL_41 = 'a'.repeat(41)
const INVALID = ['Experimento', 'experimento_a', 'experimento a', 'experimento.a', 'a/b']

describe('validateVariantLabel', () => {
  test('[1] el label vacio se rechaza', () => {
    assert.equal(validateVariantLabel(''), 'el label de --variant no puede estar vacio')
  })

  test('[2][3][6] acepta minusculas, digitos y guiones', () => {
    for (const label of ['a', 'experimento-a', '123-456', '-', '0']) assert.equal(validateVariantLabel(label), null, label)
  })

  test('[4] 40 caracteres valen y 41 no', () => {
    assert.equal(validateVariantLabel(LABEL_40), null)
    assert.equal(validateVariantLabel(LABEL_41), `el label de --variant '${LABEL_41}' supera 40 caracteres`)
  })

  test('[5] los caracteres invalidos se rechazan nombrando el label', () => {
    for (const label of INVALID) {
      assert.equal(
        validateVariantLabel(label),
        `el label de --variant '${label}' es invalido: solo minusculas, digitos y guiones ([a-z0-9-])`,
      )
    }
  })

  test('la longitud se mide en caracteres y antes que el contenido', () => {
    assert.match(validateVariantLabel('ñ'.repeat(40)) ?? '', /es invalido/)
    assert.match(validateVariantLabel('ñ'.repeat(41)) ?? '', /supera 40 caracteres/)
    assert.match(validateVariantLabel('A'.repeat(41)) ?? '', /supera 40 caracteres/)
  })

  test('mas casos invalidos: espacios, comillas, tabulador y caracteres de shell', () => {
    for (const label of ['ñandu', 'a b', ' a', 'a\t', 'a$b', "a'b", 'A\nB', '\n']) {
      assert.match(validateVariantLabel(label) ?? '', /es invalido/, JSON.stringify(label))
    }
    assert.equal(validateVariantLabel('--'), null)
  })

  test('con saltos de linea basta que una linea sea valida, como el grep del que se porto', () => {
    for (const label of ['a\nb', 'A\nb', 'a\n']) assert.equal(validateVariantLabel(label), null, JSON.stringify(label))
  })
})
