// JSONL neutral para los tests de metricas, eventos y fallos de agentes del lado interno.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/** Escribe `contents` como `<dir>/<nombre><extension>` y devuelve la ruta de cada uno, por nombre. */
export function writeFixtures(dir: string, contents: Readonly<Record<string, string>>, extension: string): Record<string, string> {
  const paths: Record<string, string> = {}
  for (const [name, content] of Object.entries(contents)) {
    paths[name] = join(dir, `${name}${extension}`)
    writeFileSync(paths[name], content)
  }
  return paths
}

function line(type: unknown, fields: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ v: 1, type, ts: '2026-09-06T10:00:00Z', ...fields })}\n`
}

export const message = (text: unknown, extra: Record<string, unknown> = {}): string =>
  line('message', { role: 'assistant', text, ...extra })
export const toolStarted = (tool: unknown): string => line('tool.started', { tool, input_summary: null })
export const toolCompleted = (tool: unknown, durationMs: unknown): string =>
  line('tool.completed', { tool, ok: true, duration_ms: durationMs })

const TERMINAL_FIELDS = {
  runtime: 'claude',
  model: null,
  session_id: null,
  duration_ms: 100,
  tokens: { input: null, output: null },
  cost_usd: null,
  turns: null,
  denials: null,
  ttft_ms: null,
  api_duration_ms: null,
}

export const failed = (fields: Record<string, unknown> = {}): string =>
  line('run.failed', { status: 'failed', ...TERMINAL_FIELDS, ...fields })
export const completed = (fields: Record<string, unknown> = {}): string =>
  line('run.completed', { status: 'success', ...TERMINAL_FIELDS, error: null, ...fields })

/** Terminal con todas sus cifras, como lo deja el runner tras una corrida sana. */
const FULL_TERMINAL = line('run.completed', {
  status: 'success',
  runtime: 'claude',
  model: 'claude-sonnet-5',
  session_id: 'sess-abc',
  duration_ms: 9451,
  tokens: { input: 1200, output: 340, cache_read: 500, cache_write: 120, reasoning: 80 },
  estimated_cost_usd: 0.0234,
  turns: 4,
  denials: 2,
  ttft_ms: 3797,
  api_duration_ms: 5289,
  error: null,
})

export const INTERNAL_EVENTS: Readonly<Record<string, string>> = {
  'fallo-ordinario': message('todo bien') + failed({ error: { kind: 'nonzero_exit', detail: 'stop_reason=? subtype=? exit=1' } }),
  'corte-de-stream': message('trabajando...') + failed({ error: { kind: 'stream_cut', detail: 'el stream se corto a mitad de escritura' } }),
  proveedor: failed({ error: { kind: 'provider_unavailable', detail: 'API Error: 529 Overloaded' } }),
  'limite-con-reset': failed({ session_id: 'sess-abc', error: { kind: 'rate_limit', detail: 'ventana agotada' }, resets_at: '2026-05-07T22:40:00Z' }),
  'limite-sin-reset': failed({ error: { kind: 'rate_limit', detail: '429' }, resets_at: null }),
  cliente: failed({ error: { kind: 'api_error', detail: 'API Error: 400 Bad Request' } }),
  'error-del-proveedor-con-texto': message('Empiezo a trabajar.') + failed({ turns: 3, error: { kind: 'api_error', detail: 'API Error: 500 Overloaded' } }),
  'tiempo-agotado': failed({ status: 'timeout', duration_ms: 1800000, error: { kind: 'timeout', detail: 'el watchdog mato el proceso tras superar 1800s' } }),
  exito: message('trabajando') + completed({ model: 'claude-sonnet-5', duration_ms: 217358, turns: 34 }),
  'sin-terminal': message('trabajando'),
  'terminal-truncado': message('trabajando') + '{"v":1,"type":"run.completed","status":"suc',
  'tool-truncada-y-terminal': '{"v":1,"type":"tool.started","ts":"2026-07-27T22:09:34.000Z","tool":"Bash","input_summary":"ls\n' + completed({ turns: 1, api_duration_ms: 80 }),
  'texto-y-tool-truncada': message('primera linea completa') + '{"v":1,"type":"tool.started","tool":"Bash","input_summary":"ls',
  'mensajes-y-tools':
    message('Voy a leer el archivo relevante.') +
    toolStarted('Read') +
    toolCompleted('Read', 100) +
    toolStarted('Write') +
    toolCompleted('Write', 100) +
    message('Listo, hice el cambio.') +
    completed({ model: 'claude-sonnet-5', duration_ms: 4200 }),
  'metricas-completas':
    message('Voy a investigar.') +
    toolStarted('Read') +
    toolCompleted('Read', 200) +
    toolStarted('Read') +
    toolCompleted('Read', 900) +
    toolStarted('Write') +
    toolCompleted('Write', 1000) +
    FULL_TERMINAL,
  'costo-cero': completed({ runtime: 'fake', duration_ms: 500, tokens: { input: 10, output: 5, cache_read: null, cache_write: null, reasoning: null }, estimated_cost_usd: 0 }),
  'costo-legado': completed({ runtime: 'fake', duration_ms: 500, tokens: { input: 10, output: 5 }, cost_usd: 0 }),
  'tool-sin-duracion': toolStarted('Bash') + toolCompleted('Bash', null) + completed({ turns: 1, api_duration_ms: 80 }),
  'tool-sin-completar': toolStarted('Bash') + completed({ turns: 1, api_duration_ms: 80 }),
  'tool-completada-sin-empezar': toolCompleted('Bash', 70) + toolStarted('Read') + completed(),
  'campos-ausentes':
    toolStarted('Grep') +
    toolCompleted('Grep', 150) +
    '{"v":1,"type":"run.completed","status":"success","runtime":"claude","model":"claude-sonnet-5","duration_ms":500,"tokens":{"input":10,"output":5},"cost_usd":0.001,"turns":2,"api_duration_ms":300,"error":null}\n',
  'fallo-con-cifras': failed({ model: 'claude-sonnet-5', session_id: 'sess-1', duration_ms: 45000, tokens: { input: 100, output: 20 }, cost_usd: 0.05, turns: 3, denials: 0, ttft_ms: 500, api_duration_ms: 40000, error: { kind: 'api_error', detail: 'API Error: 529' } }),
  'fallo-sin-cifras': failed({ runtime: 'fake', duration_ms: 12000, error: { kind: 'api_error', detail: 'el proceso termino con exit 1' } }),
  'tres-duraciones': toolStarted('Bash') + toolStarted('Bash') + toolStarted('Bash') + toolCompleted('Bash', 30) + toolCompleted('Bash', 10) + toolCompleted('Bash', 20) + completed(),
  'cuatro-duraciones': [5, 40, 20, 11].map((ms) => toolStarted('Edit') + toolCompleted('Edit', ms)).join('') + completed(),
  'tools-de-tipos-mezclados': toolStarted('Write') + toolStarted(5) + toolStarted(null) + toolStarted('Bash') + toolStarted(5) + toolCompleted(5, 7) + toolCompleted(null, 3) + completed(),
  'tool-sin-nombre': line('tool.started') + line('tool.completed', { duration_ms: 4 }) + completed(),
  'duraciones-de-texto': toolStarted('A') + toolCompleted('A', 'lento') + toolStarted('B') + toolCompleted('B', 'x') + toolCompleted('B', 'y') + toolCompleted('B', 'z') + completed(),
  'duraciones-de-texto-en-par': toolStarted('A') + toolCompleted('A', 'x') + toolCompleted('A', 'y') + completed(),
  'duraciones-que-no-suman': toolStarted('A') + toolCompleted('A', 5) + toolCompleted('A', 'y') + completed(),
  'duracion-false': toolStarted('A') + toolCompleted('A', false) + completed(),
  'tokens-que-no-son-objeto': completed({ tokens: 'n/d' }),
  'error-false': failed({ error: false, resets_at: false, session_id: false }),
  'error-vacio': failed({ error: {} }),
  'duraciones-de-texto-en-el-terminal': completed({ duration_ms: 'mucho', api_duration_ms: 3 }),
  'solo-duracion-total': completed({ duration_ms: 700, api_duration_ms: null }),
  'kind-objeto': failed({ error: { kind: { codigo: 7, partes: ['a', 'b'] }, detail: ['x'] }, session_id: 42, resets_at: true }),
  'kind-con-salto': failed({ error: { kind: 'rate_limit\n', detail: 'dos\nlineas\n\n' } }),
  'kind-con-nulo': failed({ error: { kind: 'rate\u0000limit', detail: 'a\u0000' }, session_id: '\u0000s' }),
  'reset-solo-en-error': failed({ error: { kind: 'rate_limit', resets_at: '2031-01-01T00:00:00Z' } }),
  'reset-en-error-y-raiz': failed({ error: { kind: 'rate_limit', resets_at: '2031-01-01T00:00:00Z' }, resets_at: '2032-01-01T00:00:00Z' }),
  'dos-terminales': completed({ session_id: 'primera', resets_at: '2030-06-01T00:00:00Z', error: { kind: 'rate_limit' } }) + failed({ error: { kind: 'api_error' } }),
  'exito-y-despues-fallo': completed() + failed({ error: { kind: 'stream_cut' } }),
  'fallo-y-despues-exito': failed({ error: { kind: 'stream_cut' } }) + message('sigo') + completed(),
  'exito-con-status-fallido': completed({ status: 'failed' }),
  'fallido-con-status-exito': failed({ status: 'success' }),
  'mensaje-de-otro-kind': message('pensando', { kind: 'thinking' }) + message('visible', { kind: 'text' }) + message('sin kind', { kind: null }) + message(null) + message(7) + message({ a: [1, { b: null }] }),
  'tool-con-nombre-numerico': toolStarted('Read') + toolStarted(7) + toolStarted({ n: 1 }) + toolStarted('') + message('despues del fallo'),
  'error-con-kind-numerico': failed({ error: { kind: 5, detail: 'x' } }) + failed({ error: { kind: 'k', detail: 5 } }) + failed({ error: { detail: 'solo detalle' } }) + failed({ error: { kind: 'solo kind' } }),
  'lineas-que-no-son-objeto': '5\n[1,2]\nnull\n"texto"\nno soy json\n\n' + message('sobrevive') + completed(),
  'fin-de-linea-windows': (message('con retorno') + toolStarted('Read') + failed({ session_id: 'crlf', error: { kind: 'timeout', detail: 'd' } })).replaceAll('\n', '\r\n'),
  'sin-salto-final': message('ultimo') + completed({ session_id: 's' }).trimEnd(),
  'tipo-desconocido': line('run.started', { runtime: 'claude' }) + line(7) + line(undefined, { texto: 'sin type' }) + completed(),
  'ultima-linea-truncada': failed({ error: { kind: 'rate_limit' } }) + '{"v":1,"type":"run.fai',
  'linea-que-no-es-json': `no soy json\n${failed({ error: { kind: 'rate_limit' } })}`,
  'valor-que-no-es-objeto': `${failed({ error: { kind: 'rate_limit' }, denials: 1 })}5\n`,
  'varias-lineas-por-valor': `${JSON.stringify(JSON.parse(failed({ session_id: 'bonito', error: { kind: 'stream_cut' } })), null, 2)}\n`,
  'solo-saltos': '\n\n',
  vacio: '',
}

/** Un `error` que no es objeto. */
export const ERROR_AS_TEXT = message('antes') + failed({ error: 'boom' })
