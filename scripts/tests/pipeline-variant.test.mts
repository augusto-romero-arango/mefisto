import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { validateVariantLabel } from '../lib/pipeline/variant.mts'
import { bashLibrary, NO_BASH } from './pipeline-scope-parity.mts'

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

  test('coincide con validate_variant_label de la libreria bash', { skip: NO_BASH }, () => {
    const labels = [
      '',
      'a',
      'experimento-a',
      '123-456',
      '-',
      '--',
      LABEL_40,
      LABEL_41,
      ...INVALID,
      'ñandu',
      'a b',
      ' a',
      'a\t',
      'a$b',
      "a'b",
      'a\nb',
      'A\nb',
      'A\nB',
      'a\n',
      '\n',
    ]
    const script =
      'for label in "$@"; do validate_variant_label "$label"; printf "%s|%s\\0" "$?" "$PIPELINE_VARIANT_LABEL_ERROR"; done'
    const fromBash = bashLibrary(script, labels)
    assert.equal(fromBash.status, 0, fromBash.stderr)
    const verdicts = fromBash.stdout.split('\0').slice(0, -1)
    assert.equal(verdicts.length, labels.length)
    labels.forEach((label, index) => {
      const error = validateVariantLabel(label)
      assert.equal(`${error === null ? 0 : 1}|${error ?? ''}`, verdicts[index], JSON.stringify(label))
    })
  })
})
