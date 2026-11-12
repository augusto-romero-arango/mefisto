// Label de `--variant`, que sufija worktree, rama y logs de una corrida para comparar variantes
// de un mismo issue.

const MAX_LENGTH = 40

/**
 * Motivo por el que `label` no sirve, listo para abortar, o `null` si es valido: `[a-z0-9-]`, de
 * 1 a 40 caracteres. Se valida antes de crear el worktree.
 */
export function validateVariantLabel(label: string): string | null {
  if (label.length === 0) return 'el label de --variant no puede estar vacio'
  if ([...label].length > MAX_LENGTH) return `el label de --variant '${label}' supera ${MAX_LENGTH} caracteres`
  // Se valida por lineas: basta una linea valida.
  if (!label.split('\n').some((line) => /^[a-z0-9-]+$/.test(line))) {
    return `el label de --variant '${label}' es invalido: solo minusculas, digitos y guiones ([a-z0-9-])`
  }
  return null
}
