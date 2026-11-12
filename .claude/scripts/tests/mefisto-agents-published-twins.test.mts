// Paridad de las funciones de metricas, modelos por stage y fallos de `_mefisto-common.sh` cuya
// gemela en TypeScript es la del lado publicado: el comportamiento es el mismo y no hay modulo
// interno aparte.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { agentFailureIsHoldable } from '../../../scripts/lib/pipeline/agent-failures.mts'
import { resetsAtEpoch } from '../../../scripts/lib/pipeline/agent-hold.mts'
import { renderRunMetricCount, renderRunMetricsTable } from '../../../scripts/lib/pipeline/run-history.mts'
import type { RunStage } from '../../../scripts/lib/pipeline/run-history.mts'
import { formatStageModelsForLog, parseStageModels, resolveStageModel } from '../../../scripts/lib/pipeline/stage-models.mts'
import { NO_BASH, NO_BASH_JQ, RECORD, mefistoBash } from './mefisto-agents-parity.mts'

const WRITER =
  '{"model":"openai/gpt-5.6-terra","tokens":{"input":117000,"output":5700,"cache_read":1300000,"cache_write":22000,"reasoning":3000},"estimated_cost_usd":0.59}'
const REVIEWER =
  '{"model":"openai/gpt-5.6-sol","tokens":{"input":76000,"output":4300,"cache_read":1050000,"cache_write":1500,"reasoning":8500},"estimated_cost_usd":0.84}'
const NO_COST =
  '{"model":"modelo-sin-costo","tokens":{"input":10,"output":20,"cache_read":30,"cache_write":40,"reasoning":50},"estimated_cost_usd":null}'
const ZERO_COST =
  '{"model":"modelo-cero","tokens":{"input":1,"output":2,"cache_read":3,"cache_write":4,"reasoning":5},"estimated_cost_usd":0,"cost_usd":99}'
const INCOMPLETE = '{"model":"modelo-incompleto","tokens":{"input":10,"output":20,"cache_read":30,"cache_write":40},"estimated_cost_usd":1.25}'

const stage = (label: string, duration: string | number | null, metrics: string): RunStage => ({ label, duration, metrics })
const tokens = (input: number): string =>
  `{"model":"m","tokens":{"input":${input},"output":0,"cache_read":0,"cache_write":0,"reasoning":0},"estimated_cost_usd":0.5}`

// Los casos del test bash de la tabla y cada forma de degradar; sin literales cuyo texto cambie entre versiones de jq.
const TABLES: Record<string, RunStage[]> = {
  '[A] metricas completas': [stage('Writer', 907, WRITER), stage('Reviewer', 292, REVIEWER)],
  '[B] metricas null y costo null': [stage('Writer', 60, 'null'), stage('Reviewer', 30, NO_COST)],
  '[C] costo cero': [stage('Cero', 1, ZERO_COST), stage('SinCosto', 2, NO_COST)],
  '[D] contador ausente': [stage('Incompleta', 5, INCOMPLETE)],
  'sin etapas': [],
  'una etapa sin metricas': [stage('Writer', 60, '')],
  'duraciones que no son enteros': [stage('A', '', WRITER), stage('B', '1.5', WRITER), stage('C', '-3', WRITER), stage('D', null, WRITER)],
  'etiqueta y modelo con barras y saltos': [stage('Uno | dos\ntres', 5, '{"model":"a|b","tokens":{},"estimated_cost_usd":1}')],
  'metricas invalidas': [stage('A', 5, '{'), stage('B', 5, '[1]'), stage('C', 5, '"texto"'), stage('D', 5, '{"tokens":"n/d"}')],
  'modelo ausente o vacio': [stage('A', 5, '{"model":"","tokens":{}}'), stage('B', 5, '{"model":7}'), stage('C', 5, '{}')],
  umbrales: [999, 1000, 1049, 1050, 999949, 999950, 1000000, 1005000, 123456789].map((count) => stage(`n${count}`, count, tokens(count))),
  'duracion larga': [stage('Larga', 3599, WRITER), stage('Mas larga', 86400, WRITER), stage('Cero', 0, WRITER)],
}

describe('render_run_metrics_table y _render_run_metric_count internas', { skip: NO_BASH_JQ }, () => {
  for (const [name, stages] of Object.entries(TABLES)) {
    test(`renderRunMetricsTable da la misma tabla: ${name}`, () => {
      const args = stages.flatMap((item) => [item.label, item.duration === null ? '' : String(item.duration), item.metrics])
      const fromBash = mefistoBash('render_run_metrics_table "$@"', args)
      assert.equal(fromBash.status, 0)
      assert.equal(renderRunMetricsTable(stages), fromBash.stdout)
    })
  }

  test('renderRunMetricCount da el mismo conteo', () => {
    const counts = ['0', '7', '999', '1000', '1049', '1050', '1950', '99950', '999949', '999950', '1000000', '1005000', '1125000', '', 'x', '1.5', '-1']
    const script = `for n in "$@"; do _render_run_metric_count "$n"; printf '\\036'; done`
    // Los conteos salen de un `printf` sin salto; el `-`, de un `echo`.
    const fromBash = mefistoBash(script, counts).stdout.split(RECORD).map((text) => text.replace(/\n$/, ''))
    assert.deepEqual([...counts.map(renderRunMetricCount), ''], fromBash)
  })
})

describe('parse_stage_models, resolve_stage_model y format_stage_models_for_log internas', { skip: NO_BASH }, () => {
  test('parseStageModels, resolveStageModel y formatStageModelsForLog dan lo mismo', () => {
    // Tras un spec invalido el llamador aborta: el mapa a medias de la gemela no se compara.
    const script = [
      'for spec in "$@"; do (',
      '  parse_stage_models "$spec" || { printf "1\\n%s\\n\\036" "$MEFISTO_STAGE_MODELS_ERROR"; exit 0; }',
      '  printf "0\\n%s\\n%s\\n" "$MEFISTO_STAGE_MODELS_ERROR" "$(format_stage_models_for_log)"',
      '  for agent in writer reviewer a " a " merge write ""; do resolve_stage_model "$agent" "por-defecto"; done',
      '  printf "\\036"',
      '); done',
    ].join('\n')
    const agents = ['writer', 'reviewer', 'a', ' a ', 'merge', 'write', '']
    const specs = [
      '',
      'reviewer=opus',
      'writer=sonnet,reviewer=opus',
      'writer=claude-opus-5[1m]',
      'reviewer-opus',
      '=opus',
      'reviewer=',
      '=',
      'writer=sonnet,writer=opus',
      'writer=sonnet,reviewer-opus',
      ',,a=b,,',
      ',',
      'a=b=c',
      'a=b,',
      ' a = b ',
      'a=*,writer=$HOME',
      'a=b\nc=d',
      'writer=opus,merge=haiku',
    ]
    const fromBash = mefistoBash(script, specs).stdout.split(RECORD)
    assert.equal(fromBash.length, specs.length + 1)
    specs.forEach((spec, index) => {
      const parsed = parseStageModels(spec)
      const expected =
        'error' in parsed
          ? ['1', parsed.error, '']
          : [
              '0',
              '',
              formatStageModelsForLog(parsed.models),
              ...agents.map((agent) => resolveStageModel(parsed.models, agent, 'por-defecto')),
              '',
            ]
      assert.equal(expected.join('\n'), fromBash[index], JSON.stringify(spec))
    })
  })

  test('sin --models el mapa queda vacio y todo resuelve al modelo por defecto', () => {
    const script = 'parse_stage_models ""; printf "%s|%s|" "$?" "$MEFISTO_STAGE_MODELS"; resolve_stage_model reviewer opus; format_stage_models_for_log'
    const parsed = parseStageModels('')
    assert.ok('models' in parsed)
    assert.equal(`0|${formatStageModelsForLog(parsed.models)}|${resolveStageModel(parsed.models, 'reviewer', 'opus')}\n`, mefistoBash(script).stdout)
  })
})

describe('agent_failure_is_holdable e iso8601_to_epoch internas', { skip: NO_BASH }, () => {
  test('agentFailureIsHoldable decide lo mismo', () => {
    const labels = [
      'RATE_LIMIT (exit 1)',
      'PROVIDER_UNAVAILABLE (exit 1)',
      'RATE_LIMIT',
      'PROVIDER_UNAVAILABLE',
      'TIMEOUT (1800s, exit 137)',
      'API_ERROR_CLIENT (exit 1)',
      'STREAM_CUT (exit 1)',
      'CLI_ERROR (exit 3)',
      'SIGNAL_MID_FLIGHT (exit 137, 12s)',
      'SIGNAL_POST_SUCCESS (exit 137, 12s)',
      ' RATE_LIMIT',
      'rate_limit',
      '',
    ]
    const script = 'for label in "$@"; do if agent_failure_is_holdable "$label"; then printf 1; else printf 0; fi; done'
    assert.equal(labels.map((label) => (agentFailureIsHoldable(label) ? '1' : '0')).join(''), mefistoBash(script, labels).stdout)
  })

  test('resetsAtEpoch da el mismo epoch que iso8601_to_epoch', () => {
    // Solo fechas completas y texto que ningun `date` acepta: lo demas depende de si es el de BSD o el de GNU.
    const dates = [
      '2026-05-07T22:40:00Z',
      '2026-08-05T15:00:00Z',
      '1970-01-01T00:00:00Z',
      '2024-02-29T23:59:59Z',
      '2030-12-31T00:00:01Z',
      '',
      'no-es-fecha',
    ]
    const script = 'for iso in "$@"; do iso8601_to_epoch "$iso" 2>/dev/null; echo "rc=$?"; done'
    const own = dates.map((iso) => {
      const epoch = resetsAtEpoch(iso)
      return epoch === null ? 'rc=1\n' : `${epoch}\nrc=0\n`
    })
    assert.equal(own.join(''), mefistoBash(script, dates).stdout)
    assert.equal(resetsAtEpoch('2026-05-07T22:40:00Z'), 1778193600)
  })
})
