// Procesa issues internos de Mefisto secuencialmente: el motor de /mefisto-sequential.
//
// Uso:
//   mefisto-batch-pipeline.mts 42 43 44
//   mefisto-batch-pipeline.mts 42 43 --stop-on-error
//
// Por issue: raiz ejecutable aislada en el SHA verificado de origin/main -> mefisto-tooling-pipeline
// desde ahi -> URL del PR -> `gh pr merge --squash --delete-branch` -> reconciliacion best-effort
// de los `bloqueado` liberados -> sync verificado: el merge debe estar en origin/main, de donde nace
// el siguiente worktree; si solo falla dejar main LOCAL al dia, se avisa y se sigue.
//
// El runtime (MEFISTO_RUNTIME), MEFISTO_AGENT_TIMEOUT_SECONDS y el resto del entorno se heredan
// tal cual en cada eslabon; el runtime viaja ya resuelto.
//
// Parada suave: `/mefisto-batch-stop` escribe `.mefisto/pipeline/batch-stop`; se consulta antes
// del primer eslabon y tras el sync verificado de cada uno, el unico punto seguro de la cadena.

import type { ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { resolveRuntime } from '../../runtime/lib/mefisto-runtime.mts'
import type { Run } from '../../../scripts/lib/azure-cli.mts'
import { CliError, COLOR, capture, commandExists, isEntryPoint } from '../../../scripts/lib/cli.mts'
import { fmtHoldDuration, holdNoteSuffix } from '../../../scripts/lib/pipeline/agent-hold.mts'
import { firstPullRequestUrl, isFile, lineCount, padBytes, runTeed, touch, writeAtomic } from '../../../scripts/lib/pipeline/orchestrator.mts'
import { PipelineAbort, runPipeline } from '../../../scripts/lib/pipeline/pipeline-exit.mts'
import type { SignalSource } from '../../../scripts/lib/pipeline/pipeline-exit.mts'
import { appendText, createPipelineLog, runLogged, stripAnsi } from '../../../scripts/lib/pipeline/pipeline-log.mts'
import type { LoggedRun } from '../../../scripts/lib/pipeline/pipeline-log.mts'
import { runStamp } from '../../../scripts/lib/pipeline/pipeline-status.mts'
import { ensureRepoOnBaseBranch } from './lib/mefisto-base-branch.mts'
import {
  executionRootPath,
  materializeExecutionRoot,
  removeExecutionRoot,
  syncMainAfterMerge,
  unmetDependency,
} from './lib/mefisto-batch-git.mts'
import type { BatchGit, ExecutionRoot } from './lib/mefisto-batch-git.mts'
import {
  deferFromIndex,
  getPr,
  getStatus,
  holdSecondsInRange,
  newBatchTracker,
  renderBatchStatus,
  setPr,
  setStatus,
} from './lib/mefisto-batch-records.mts'
import { assertInMefisto, ensureGithooksInstalled } from './lib/mefisto-repo.mts'
import type { MefistoRepo } from './lib/mefisto-repo.mts'

export interface MefistoBatchDeps {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Ruta con que se muestra el script en el mensaje de uso. */
  scriptPath: string
  out: (text: string) => void
  err: (text: string) => void
  /** `git` y `gh` cuando su salida se lee. */
  run: Run
  /** `git` cuando su salida va al log. */
  runLogged: LoggedRun
  hasCommand: (command: string) => boolean
  now: () => Date
  /** Esperas entre reintentos del sync; por defecto duerme de verdad. */
  sleep?: (seconds: number) => Promise<void>
  /** Sufijo de la raiz ejecutable; por defecto el PID de este proceso. */
  pid?: number
  signals?: SignalSource
  exit?: (code: number) => void
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

/** Corre el batch y devuelve su codigo de salida. */
export async function mefistoBatchPipeline(deps: MefistoBatchDeps): Promise<number> {
  const { env, out, err, now } = deps
  const { red, green, yellow, bold, reset } = COLOR

  let repo: MefistoRepo
  try {
    repo = assertInMefisto(deps.cwd, { run: deps.run, hasCommand: deps.hasCommand })
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    err(`${error.message}\n`)
    return 1
  }
  const root = resolve(repo.root)
  const githooks = ensureGithooksInstalled(repo.root)
  if (githooks !== null) err(`${githooks}\n`)

  const stateDir = nonEmpty(env.MEFISTO_STATE_DIR) ?? join(root, '.mefisto', 'pipeline')
  // Lo que el bash exportaba y heredan cada eslabon y el reconciliador.
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    MEFISTO_STATE_DIR: stateDir,
    MEFISTO_LEGACY_STATE_DIR: nonEmpty(env.MEFISTO_LEGACY_STATE_DIR) ?? join(root, '.claude', 'pipeline'),
    MEFISTO_LEGACY_STATE_REL: join('.claude', 'pipeline'),
    MEFISTO_REPO_ROOT: repo.root,
    MEFISTO_PROJECT_NAME: repo.projectName,
    ...(deps.hasCommand('gh') ? { MEFISTO_REPO_SLUG: repo.repoSlug } : {}),
  }
  const timestamp = runStamp(now())
  const logDir = join(stateDir, 'logs')
  const logFile = join(logDir, `mefisto-batch-${timestamp}.log`)
  const eventsLog = join(stateDir, 'events.log')
  const statusFile = join(stateDir, 'pipeline-status-mefisto-batch.json')
  const signalFile = join(stateDir, 'batch-stop')
  const stopRequested = (): boolean => isFile(signalFile)

  let logFileAbs = ''
  const log = createPipelineLog({ logFile: () => logFileAbs, out, now })

  let batchState = 'running'
  let batchCurrent = ''
  let totalHoldSeconds = 0
  const tracker = newBatchTracker(() => writeBatchStatus())
  function writeBatchStatus(state?: string): void {
    if (state !== undefined && state.length > 0) batchState = state
    writeAtomic(
      statusFile,
      renderBatchStatus({
        started: timestamp,
        state: batchState,
        current: batchCurrent,
        stopRequested: stopRequested(),
        holdSeconds: totalHoldSeconds,
        log: logFileAbs.length > 0 ? logFileAbs : logFile,
        entries: tracker.entries,
      }),
    )
  }

  const abort = (message: string): never => {
    writeBatchStatus('failed')
    const line = `\n${red}${bold}x ERROR FATAL: ${message}${reset}\n`
    out(line)
    appendText(logFileAbs, line)
    out(`${yellow}Revisa el log: ${logFileAbs}${reset}\n`)
    throw new PipelineAbort(message)
  }

  let haveErrors = false
  // Solo "el merge llego a origin/main pero main LOCAL quedo atrasado": no es un fallo del batch.
  let haveWarnings = false
  const failIssue = (issue: string, message: string): void => {
    const line = `\n${red}${bold}x Issue #${issue}: ${message}${reset}\n`
    out(line)
    appendText(logFileAbs, line)
    setStatus(tracker, issue, `ERROR: ${message}`)
    haveErrors = true
  }

  let executionRoot: ExecutionRoot | null = null
  let running: ChildProcess | null = null
  const git = (): BatchGit => ({
    root,
    env: childEnv,
    run: deps.run,
    runLogged: deps.runLogged,
    logFile: logFileAbs,
    warn: (message) => log.warn(message),
    sleep: deps.sleep ?? ((seconds) => new Promise<void>((done) => setTimeout(done, seconds * 1000))),
  })
  const cleanupExecutionRoot = (): void => {
    if (executionRoot === null) return
    removeExecutionRoot(executionRoot.path, { root, env: childEnv, run: deps.run })
    executionRoot = null
  }

  const main = async (): Promise<number> => {
    // --- Argumentos ---
    const argv = [...deps.argv]
    if (argv.length === 0) {
      out(`Uso: ${deps.scriptPath} <issue1> <issue2> ... [--stop-on-error]\n`)
      out('  issue1 ...         Numeros de issues a procesar (en orden)\n')
      out('  --stop-on-error    Abortar en el primer fallo (por defecto: continuar)\n')
      return 1
    }
    const issues: string[] = []
    let stopOnError = false
    for (const arg of argv) {
      if (arg === '--stop-on-error') stopOnError = true
      else if (/^[0-9]/.test(arg)) issues.push(arg)
      else {
        out(`Argumento desconocido: ${arg}\n`)
        return 1
      }
    }
    if (issues.length === 0) {
      out(`${red}${bold}x No se especificaron issues.${reset}\n`)
      return 1
    }

    // --- Log ---
    mkdirSync(logDir, { recursive: true })
    touch(logFile)
    logFileAbs = realpathSync.native(logFile)

    for (const issue of issues) setStatus(tracker, issue, 'pendiente')

    // --- Dependencias y runtime ---
    const missing = ['git', 'gh'].filter((command) => !deps.hasCommand(command))
    if (missing.length > 0) {
      out(`${red}${bold}x Dependencias faltantes:${missing.map((command) => ` ${command}`).join('')}${reset}\n`)
      return 1
    }
    const resolved = await resolveRuntime('', env, deps.hasCommand)
    if ('error' in resolved) {
      out(`${red}${bold}x No se pudo resolver el runtime activo: ${resolved.error}${reset}\n`)
      out(`${yellow}Fija MEFISTO_RUNTIME para desambiguar.${reset}\n`)
      return 1
    }
    const runtime = resolved.runtime
    // El adaptador no exige el CLI cuando el runtime llega explicito o por entorno: se exige aqui.
    if (!deps.hasCommand(runtime)) {
      out(`${red}${bold}x Falta el CLI del runtime resuelto ('${runtime}').${reset}\n`)
      out(`${yellow}Fija MEFISTO_RUNTIME con un runtime instalado.${reset}\n`)
      return 1
    }
    // Cada eslabon hereda el runtime ya resuelto en vez de volver a autodetectarlo.
    childEnv.MEFISTO_RUNTIME = runtime

    const base = ensureRepoOnBaseBranch({ repoRoot: repo.root, run: deps.run })
    if (base.gitStderr.length > 0) err(base.gitStderr)
    if (!base.ok) abort(base.abort)
    const mainBranch = base.ok ? base.mainBranch : ''
    for (const warning of base.ok ? base.warnings : []) log.warn(warning)

    // --- Cabecera ---
    log.header('mefisto-batch-pipeline --- Procesamiento secuencial de issues internos')
    log.log('Pipeline: mefisto-tooling (unico pipeline interno de Mefisto)')
    log.log(`Runtime activo: ${runtime}`)
    log.log(`Issues a procesar: ${issues.join(' ')}`)
    log.log(
      `Rama base: ${mainBranch} (el batch la mantiene sincronizada con origin/main entre eslabones; cada worktree nace de origin/main, issue #66)`,
    )
    log.log(`Modo en error: ${stopOnError ? 'detener' : 'continuar'}`)
    log.log(`Log: ${logFileAbs}`)
    log.log('Parada suave: /mefisto-batch-stop detiene el batch tras el eslabon en curso (issue #966)')
    log.log(
      "Espera automatica: ante RATE_LIMIT/PROVIDER_UNAVAILABLE el eslabon en curso espera (hold) en vez de fallar (issue #967) -- mientras espera, la consola de observacion lo reporta 'en espera' (issue #969)",
    )
    log.log('Ejecucion aislada: cada eslabon fija sus ejecutables en el SHA verificado de origin/main (issue #1107)')

    // --- Loop principal ---
    let completed = 0
    let failed = 0
    const total = issues.length
    let queue = [...issues]

    if (stopRequested()) {
      log.warn(`Parada solicitada (${signalFile}) antes de arrancar el primer eslabon: ningun issue se procesa en esta corrida.`)
      deferFromIndex(tracker, issues, 0, signalFile)
      queue = []
    }

    const appendIssueLog = (issueLog: string): void => {
      appendFileSync(logFileAbs, stripAnsi(readFileSync(issueLog, 'utf8')))
    }
    const stopIfAsked = (issue: string): void => {
      if (stopOnError) abort(`Detenido por --stop-on-error en issue #${issue}`)
    }

    for (const issue of queue) {
      const current = completed + failed + 1
      log.header(`Issue #${issue} (${current}/${total})`)
      batchCurrent = issue

      // Antes de "en curso" y del snapshot. El salto cuenta en los fallidos sin tocar los errores.
      const unmet = unmetDependency(issue, (dependency) => getStatus(tracker, dependency), git())
      if (unmet !== null) {
        setStatus(tracker, issue, `saltado: depende de #${unmet.dependency} (${unmet.reason})`)
        failed++
        log.warn(`Issue #${issue} saltado: depende de #${unmet.dependency} (${unmet.reason}); no se lanza el pipeline.`)
        continue
      }
      setStatus(tracker, issue, 'en curso')

      // Vive hasta que termine el eslabon entero; la siguiente vuelta lo reemplaza tras el sync.
      cleanupExecutionRoot()
      executionRoot = materializeExecutionRoot(issue, executionRootPath(root, timestamp, deps.pid ?? process.pid), git())
      if (executionRoot === null) {
        abort(`No se pudo preparar la raiz ejecutable aislada para issue #${issue}; no se lanzo ningun stage. Revisa el log: ${logFileAbs}`)
      }
      const snapshot: ExecutionRoot = executionRoot ?? { path: '', sha: '' }
      const pipelineScript = join(snapshot.path, 'src', 'internal', 'scripts', 'mefisto-tooling-pipeline.mts')
      if (!isFile(pipelineScript)) {
        abort(`El snapshot ${snapshot.sha} no contiene el pipeline interno ejecutable: ${pipelineScript}`)
      }
      log.log(`Snapshot ejecutable para #${issue}: ${snapshot.sha.slice(0, 12)} (${snapshot.path})`)

      // --- Stage 1: pipeline interno; el propio pipeline valida que el issue exista y este OPEN ---
      log.log(`Ejecutando mefisto-tooling-pipeline.mts para issue #${issue}...`)
      const issueLog = join(logDir, `mefisto-batch-issue-${issue}-${timestamp}.log`)
      touch(issueLog)

      // El events.log lo comparten todas las corridas del checkout: la espera de este eslabon se
      // acota desde esta linea y por la cabecera de sesion de su issue.
      const holdLineStart = isFile(eventsLog) ? lineCount(eventsLog) : 0

      // El cwd y los ejecutables son los del snapshot; el estado y el mapping, los del lanzador.
      const pipelineExit = await runTeed(pipelineScript, [issue], issueLog, {
        cwd: snapshot.path,
        env: {
          ...childEnv,
          MEFISTO_LAUNCH_ROOT: root,
          MEFISTO_MODELS_FILE: nonEmpty(env.MEFISTO_MODELS_FILE) ?? join(root, '.mefisto', 'models.json'),
        },
        onOutput: out,
        onChild: (child) => {
          running = child
        },
      })
      running = null
      appendIssueLog(issueLog)

      // Informativo: una espera nunca convierte un desenlace en fallo ni lo enmascara.
      const issueHoldSeconds = holdSecondsInRange(eventsLog, holdLineStart, issue, now())
      const heldNote = holdNoteSuffix(issueHoldSeconds)
      if (issueHoldSeconds > 0) {
        totalHoldSeconds += issueHoldSeconds
        log.log(`Issue #${issue}: ${fmtHoldDuration(issueHoldSeconds)} en espera (hold) durante este eslabon`)
      }

      if (pipelineExit !== 0) {
        failIssue(issue, `pipeline fallo (exit ${pipelineExit}). Log: ${issueLog}${heldNote}`)
        failed++
        stopIfAsked(issue)
        continue
      }

      // --- Stage 2: URL del PR que imprime el pipeline ---
      const prUrl = firstPullRequestUrl(stripAnsi(readFileSync(issueLog, 'utf8')))
      if (prUrl.length === 0) {
        failIssue(issue, `no se pudo extraer la URL del PR del output. Log: ${issueLog}${heldNote}`)
        failed++
        stopIfAsked(issue)
        continue
      }
      const prNumber = /[0-9]+$/.exec(prUrl)?.[0] ?? ''
      setPr(tracker, issue, prNumber)
      log.success(`Pipeline completado -> PR #${prNumber} (${prUrl})`)

      // --- Stage 3: merge directo (pr-sync es del lado publicado) ---
      log.log(`Mergeando PR #${prNumber} a main (squash + delete-branch)...`)
      const merged = deps.run('gh', ['pr', 'merge', prNumber, '--squash', '--delete-branch'], { cwd: root, env: childEnv })
      out(merged.stdout + merged.stderr)
      appendFileSync(issueLog, merged.stdout + merged.stderr)
      appendIssueLog(issueLog)
      const mergeExit = merged.status ?? 1
      if (mergeExit !== 0) {
        failIssue(issue, `merge del PR #${prNumber} fallo (exit ${mergeExit}). Log: ${issueLog}${heldNote}`)
        failed++
        stopIfAsked(issue)
        continue
      }

      // --- Stage 4: reconciliar bloqueos (best-effort: el PR ya se mergeo) ---
      log.log(`Reconciliando bloqueos liberados por el PR #${prNumber}...`)
      const reconcileExit = await runTeed(
        join(snapshot.path, 'src', 'internal', 'scripts', 'mefisto-validate-batch-deps.mts'),
        ['--reconcile-pr', prNumber],
        issueLog,
        {
          cwd: root,
          env: childEnv,
          onOutput: out,
          onChild: (child) => {
            running = child
          },
        },
      )
      running = null
      appendIssueLog(issueLog)
      if (reconcileExit !== 0) {
        log.warn(
          `El PR #${prNumber} ya se mergeo, pero la reconciliacion post-merge de bloqueados fallo (exit ${reconcileExit}). Se continua sin reintentar; revisa el log del issue: ${issueLog}`,
        )
      }

      // --- Stage 5: sync verificado; solo un merge ausente de origin/main rompe la cadena ---
      const isLastIssue = current === total
      log.log(`Sincronizando ${mainBranch} con origin (verificado)...`)
      const sync = await syncMainAfterMerge(prNumber, mainBranch, git())
      const shortSha = sync.mergeSha.slice(0, 12)
      if (sync.code === 0) {
        log.success(`${mainBranch} local incluye el merge del PR #${prNumber} (commit ${shortSha})`)
        setStatus(tracker, issue, `completado (PR #${prNumber} mergeado)${heldNote}`)
        completed++
        log.success(`Issue #${issue} completado y mergeado`)
      } else if (sync.code === 1) {
        setStatus(tracker, issue, `completado (PR #${prNumber} mergeado; sync de ${mainBranch} LOCAL fallido, no fatal)${heldNote}`)
        completed++
        haveWarnings = true
        log.success(`Issue #${issue} completado y mergeado`)
        log.warn(
          `El commit de merge ${shortSha} del PR #${prNumber} ya esta confirmado en origin/main; solo fallo dejar ${mainBranch} LOCAL sincronizado. No bloquea la cadena: el siguiente worktree nace de origin/main. Para ponerte al dia: 'git switch ${mainBranch} && git pull --ff-only'.`,
        )
      } else {
        setStatus(tracker, issue, `completado (PR #${prNumber} mergeado; sync de origin/main FALLIDO)${heldNote}`)
        completed++
        haveErrors = true
        if (isLastIssue) {
          log.warn(`El sync verificado de origin/main fallo, pero #${issue} era el ultimo eslabon: ningun issue posterior depende de este merge.`)
        } else {
          abort(
            `Sync verificado de origin/main tras el PR #${prNumber} fallo: el commit de merge no quedo confirmado en origin/main. El siguiente eslabon naceria de una base desactualizada, asi que la cadena se aborta. Revisa el log: ${logFileAbs}`,
          )
        }
      }

      // Parada suave, momento 2: un eslabon fallido nunca llega aqui.
      if (stopRequested()) {
        if (current < total) {
          log.warn(
            `Parada solicitada (${signalFile}) tras el sync verificado de #${issue}: los eslabones restantes quedan aplazados, sin arrancar ningun worktree.`,
          )
        } else {
          log.warn(
            `Parada solicitada (${signalFile}) tras el sync verificado de #${issue}, que era el ultimo eslabon del batch: no quedaba ninguno por arrancar. La senal se consumio igual, para no afectar la corrida siguiente.`,
          )
        }
        deferFromIndex(tracker, issues, current, signalFile)
        break
      }
    }

    // --- Resumen ---
    log.header('Resumen')
    out('\n')
    out(`${bold}${padBytes('Issue', 10)} ${padBytes('PR', 8)} ${padBytes('Estado', 45)}${reset}\n`)
    out(`${'-'.repeat(65)}\n`)
    for (const issue of issues) {
      const pr = getPr(tracker, issue)
      const status = getStatus(tracker, issue)
      // `saltado` y `aplazado` van en amarillo.
      const color = status.startsWith('completado') ? green : status.startsWith('ERROR') ? red : yellow
      out(`${color}${padBytes(`#${issue}`, 10)} ${padBytes(pr.length > 0 ? pr : '(n/a)', 8)} ${padBytes(status, 45)}${reset}\n`)
    }

    const deferred = issues.filter((issue) => getStatus(tracker, issue).startsWith('aplazado'))
    const skipped = issues.filter((issue) => getStatus(tracker, issue).startsWith('saltado'))

    batchCurrent = ''
    writeBatchStatus(haveErrors ? 'failed' : deferred.length > 0 ? 'stopped' : 'completed')

    out('\n')
    out(`  Total: ${total}  |  ${green}Completados: ${completed}${reset}  |  ${red}Fallidos: ${failed}${reset}  |  ${yellow}Aplazados: ${deferred.length}${reset}\n`)
    out(`  Log: ${logFileAbs}\n`)
    out('\n')

    // Informativo: nunca cambia fallidos ni el codigo de salida.
    if (totalHoldSeconds > 0) {
      out(`  Tiempo total en espera (hold): ${fmtHoldDuration(totalHoldSeconds)}\n`)
      out('\n')
    }

    if (skipped.length > 0) {
      log.warn(`${skipped.length} issue(s) saltados por dependencia no satisfecha. No se lanzaron.`)
      out(`  Relanza tras resolver sus dependencias: ${bold}/mefisto-sequential ${skipped.join(' ')}${reset}\n`)
      out('\n')
    }

    if (deferred.length > 0) {
      log.warn(
        `Parada solicitada: ${deferred.length} issue(s) quedaron aplazados en esta corrida. No es un fallo del batch: el exit code es 0 y nada quedo a medio pipeline.`,
      )
      out(`  Relanza los aplazados, en el mismo orden: ${bold}/mefisto-sequential ${deferred.join(' ')}${reset}\n`)
      out('\n')
    }

    if (haveErrors) {
      log.warn(`Algunos issues tuvieron errores. Revisa el log: ${logFileAbs}`)
      return 1
    }
    if (haveWarnings) {
      log.warn(
        `Todos los issues se completaron, pero ${mainBranch} LOCAL quedo sin sincronizar en algun eslabon (ver el detalle arriba). Ponte al dia con 'git switch ${mainBranch} && git pull --ff-only'. Log: ${logFileAbs}`,
      )
    }
    log.success(`mefisto-batch-pipeline completado. Log: ${logFileAbs}`)
    return 0
  }

  return runPipeline(main, {
    finalize: () => cleanupExecutionRoot(),
    // Solo el hijo que este batch lanzo, por su PID: el eslabon corta a su agente y limpia.
    onSignal: () => void (running as ChildProcess | null)?.kill('SIGTERM'),
    err,
    ...(deps.signals === undefined ? {} : { signals: deps.signals }),
    ...(deps.exit === undefined ? {} : { exit: deps.exit }),
  })
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await mefistoBatchPipeline({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    scriptPath: process.argv[1] ?? 'mefisto-batch-pipeline.mts',
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    run: capture,
    runLogged,
    hasCommand: (command) => commandExists(command),
    now: () => new Date(),
  })
}
