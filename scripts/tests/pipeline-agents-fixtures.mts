// Fixtures de eventos neutrales compartidos por los tests de `scripts/lib/pipeline/agent-*.mts`.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const REPO_ROOT = join(import.meta.dirname, '..', '..')

function terminal(type: string, fields: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, type, ts: '2026-08-05T10:00:00Z', runtime: 'claude', ...fields })}\n`
}

const failed = (fields: Record<string, unknown>): string => terminal('run.failed', { status: 'failed', ...fields })
const completed = (fields: Record<string, unknown> = {}): string =>
  terminal('run.completed', { status: 'success', error: null, ...fields })
const MESSAGE = '{"v":1,"type":"message","ts":"2026-08-05T10:00:00Z","role":"assistant","text":"trabajando"}\n'

/** JSONL neutral de la politica de fallos, mas los bordes de la lectura del terminal. */
export const NEUTRAL_EVENTS: Readonly<Record<string, string>> = {
  'tooling-fallido': '{"type":"run.failed","status":"failed","session_id":"s 1","denials":2,"resets_at":"2030-01-01T00:00:00Z","error":{"kind":"rate_limit"}}\n',
  'tooling-exito': '{"type":"run.completed","status":"success","session_id":null,"denials":0,"error":null}\n',
  '5xx': failed({ session_id: null, denials: null, error: { kind: 'provider_unavailable', detail: 'API Error: 529 Overloaded' } }),
  'limite-con-reset': failed({ session_id: 'sess-abc', denials: null, error: { kind: 'rate_limit', detail: 'ventana agotada' }, resets_at: '2026-08-05T15:00:00Z' }),
  'limite-sin-reset': failed({ session_id: null, denials: null, error: { kind: 'rate_limit', detail: '429' }, resets_at: null }),
  '4xx': failed({ error: { kind: 'api_error', detail: 'API Error: 400 Bad Request' } }),
  corte: failed({ error: { kind: 'stream_cut', detail: 'Connection closed mid-response' } }),
  'salida-no-cero': failed({ error: { kind: 'nonzero_exit', detail: 'stop_reason=? subtype=?' } }),
  'sin-resultado': failed({ error: { kind: 'no_result' } }),
  'tiempo-agotado': failed({ error: { kind: 'timeout' } }),
  matado: failed({ error: { kind: 'killed' } }),
  'protocolo-invalido': failed({ error: { kind: 'protocol_invalid' } }),
  'kind-desconocido': failed({ error: { kind: 'RATE_LIMIT' } }),
  'kind-con-salto': failed({ error: { kind: 'rate_limit\n' } }),
  exito: completed({ session_id: null, denials: null }),
  'exito-con-status-fallido': terminal('run.completed', { status: 'failed' }),
  'fallido-con-status-exito': terminal('run.failed', { status: 'success' }),
  'sin-terminal': MESSAGE,
  'sin-error': failed({ denials: 3 }),
  'error-nulo': failed({ error: null, session_id: false, denials: false }),
  'reset-en-error': failed({ error: { kind: 'rate_limit', resets_at: '2031-01-01T00:00:00Z' }, resets_at: '2032-01-01T00:00:00Z' }),
  'denials-texto': failed({ denials: 'muchas' }),
  'dos-terminales': completed({ session_id: 'primera', denials: 4, resets_at: '2030-06-01T00:00:00Z', error: { kind: 'rate_limit' } }) + failed({ error: { kind: 'api_error' } }),
  'ultimo-terminal-vacio': failed({ session_id: 'primera', denials: 4, error: { kind: 'rate_limit' } }) + completed(),
  'exito-y-despues-fallo': completed() + failed({ error: { kind: 'killed' } }),
  'fallo-y-despues-exito': failed({ error: { kind: 'killed' } }) + MESSAGE + completed(),
  'ultima-linea-truncada': failed({ error: { kind: 'rate_limit' } }) + '{"v":1,"type":"run.fai',
  'linea-que-no-es-json': `no soy json\n${failed({ error: { kind: 'rate_limit' } })}`,
  'valor-que-no-es-objeto': `${failed({ error: { kind: 'rate_limit' }, denials: 1 })}5\n`,
  'arreglo-suelto': `[1,2]\n${completed()}`,
  'nulo-suelto': `null\n${completed({ session_id: 'tras-nulo' })}`,
  'varias-lineas-por-valor': `${JSON.stringify(JSON.parse(failed({ session_id: 'bonito', error: { kind: 'stream_cut' } })), null, 2)}\n`,
  'fin-de-linea-windows': failed({ session_id: 'crlf', error: { kind: 'timeout' } }).replaceAll('\n', '\r\n'),
  'solo-espacios': ' \n\n',
  vacio: '',
}

/** Fixtures de JSONL neutral del repo, relativos a su raiz. */
export const NEUTRAL_EVENT_FILES: readonly string[] = [
  'invalid-missing-cost-name',
  'invalid-missing-field',
  'invalid-status-mismatch',
  'invalid-two-terminals',
  'invalid-unknown-type',
  'legacy-cost-usd',
  'valid-failed',
  'valid-rate-limit-claude',
  'valid-rate-limit-sin-reset',
  'valid-success',
  'valid-timeout',
]
  .map((name) => join('src', 'runtime', 'contract', 'fixtures', 'run-events', `${name}.jsonl`))
  .concat(
    ['neutral-claude.events', 'neutral-failed.events', 'neutral-sensitive-unknown.events', 'legacy-claude.stream'].map(
      (name) => join('scripts', 'tests', 'fixtures', 'stream-watch', `${name}.jsonl`),
    ),
    ['hold.events', 'success.events', 'truncated-input.events'].map((name) =>
      join('scripts', 'tests', 'fixtures', 'tooling-observability', `${name}.jsonl`),
    ),
  )

/** Escribe `contents` como `<dir>/<nombre><extension>` y devuelve la ruta de cada uno, por nombre. */
export function writeFixtures(dir: string, contents: Readonly<Record<string, string>>, extension: string): Record<string, string> {
  const paths: Record<string, string> = {}
  for (const [name, content] of Object.entries(contents)) {
    paths[name] = join(dir, `${name}${extension}`)
    writeFileSync(join(dir, `${name}${extension}`), content)
  }
  return paths
}
