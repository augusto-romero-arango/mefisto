export type RunAgent = { duration: number | null; result: string }

export type PipelineRun = {
  issue: string
  title: string
  stage: string
  state: 'running' | 'completed' | 'failed'
  startedMs: number
  finishedMs: number | null
  agents: Record<string, RunAgent>
  pr: string | null
  lastError: string | null
  eventsFile: string | null
}

export type ReadyItem = { number: number; title: string; after: number[] }

/** Listos en el orden de mefisto-next-order.mts, con la linea de /mefisto-sequential que los lanza a todos. */
export type BlockedItem = { number: number; title: string; by: number[] }

export type ReadyList = { items: ReadyItem[]; blocked: BlockedItem[]; cycleCount: number; launch: string | null; error: string | null }

export type BatchIssue = { issue: string; status: string; pr: string | null }

/** Duracion y costo estimado de la corrida de tooling de un issue, del pipeline-history.jsonl. */
export type IssueStats = { durationMs: number; costUsd: number | null; title: string | null }

/** Un /mefisto-sequential en curso o terminado, leido de pipeline-status-mefisto-batch.json. */
export type BatchRun = {
  issues: BatchIssue[]
  state: 'running' | 'completed' | 'failed' | 'stopped'
  current: string | null
  stopRequested: boolean
  holdSeconds: number
  startedMs: number
  finishedMs: number | null
  stats: Record<string, IssueStats>
}

/** PR abierto sin borradores; los de field notes de la bitacora se cuentan aparte. */
export type OpenPr = { number: number; title: string; isFieldNote: boolean }

/** Fragmentos de changelog.d/ por consolidar en el proximo release. */
export type ChangelogSummary = { issues: number; added: number; changed: number; fixed: number; removed: number }

/** Espera por rate limit en curso, de la ultima linea de events.log. */
export type Hold = { family: string; nextProbe: string; deadline: string }

/** Una field note de la cinta de la bitacora: pendiente hasta que aparece en `procesadas/`. */
export type BitacoraNote = { name: string; estado: 'pendiente' | 'procesada' }

/** El PR de bitacora que dejo el historiador, abierto a la espera de mergearlo o cerrarlo. */
export type BitacoraPr = { number: number; title: string }

/** El subagente mefisto-historiador escribiendo la bitacora en esta sesion (lo lanza /mefisto-bitacora). */
export type Historian = { startedMs: number; finishedMs: number | null; notes: BitacoraNote[]; pr: BitacoraPr | null }

/** Una fase de mefisto-release.mts, en el orden en que ocurren. */
export type ReleaseStep = 'rama' | 'consolidar' | 'pr' | 'merge' | 'tag' | 'release'

/** Un issue con fragmentos en changelog.d/ al arrancar el release, y sus categorias de Keep a Changelog. */
export type ReleaseIssue = { issue: string; title: string; categories: string[] }

/**
 * Un /mefisto-release en esta sesion: en reposo mientras se prepara, despegando mientras corre su script.
 * `steps` son las fases que esta corrida recorre (--prepare-only se detiene en el PR; sin bump solo publica);
 * `done` las ya observadas por sondeo y `failed` la que quedo en curso si el turno termino sin completarlas.
 */
export type Release = {
  phase: 'reposo' | 'despegando'
  startedMs: number
  finishedMs: number | null
  version: string | null
  steps: ReleaseStep[]
  done: ReleaseStep[]
  failed: ReleaseStep | null
  issues: ReleaseIssue[]
  fragments: string[]
  pr: string | null
  url: string | null
}

/** Un PR de la cinta de /mefisto-merge: sale de la lista al quedar mergeado; si su merge falla queda con ✗. */
export type MergePr = { num: string; title: string; estado: 'pendiente' | 'mergeado' | 'fallido' }

/** Un /mefisto-merge en esta sesion: los PRs que cose y cuando termino. */
export type MergeRun = { prs: MergePr[]; startedMs: number; finishedMs: number | null }

export type LogKind = 'start' | 'tool' | 'text' | 'fail' | 'done'

export type LogLine = { ts: string; kind: LogKind; text: string }

declare module 'claude-code' {
  interface PluginState {
    'mefisto-divine-wager': {
      run: PipelineRun | null
      lines: LogLine[]
      now: number
      isExecutionSession: boolean
      ready: ReadyList | null
      readyPage: number
      batch: BatchRun | null
      openPrs: OpenPr[] | null
      fieldNotes: number | null
      changelog: ChangelogSummary | null
      hold: Hold | null
      historian: Historian | null
      release: Release | null
      merge: MergeRun | null
    }
  }
}
