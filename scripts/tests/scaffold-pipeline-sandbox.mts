// Consumidor de usar y tirar para correr `scaffold-pipeline.mts` de extremo a extremo. Reutiliza
// el de tooling: remoto bare, `gh` inyectado, reloj falso y agente guionado.

import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loggedThrough } from '../lib/pipeline/pipeline-log.mts'
import { scaffoldPipeline } from '../scaffold-pipeline.mts'
import type { ScaffoldPipelineDeps } from '../scaffold-pipeline.mts'
import type { GuionStep } from './fixtures/tooling-pipeline/runtime-guion.mts'
import { fakeClock, fakeTools, pipelineEnv, runWith } from './tooling-pipeline-sandbox.mts'
import type { Consumer, FakeTools } from './tooling-pipeline-sandbox.mts'

export const FIXTURES = join(import.meta.dirname, 'fixtures', 'scaffold-pipeline')
export const PROJECT = 'Empresa.Proyecto.Prueba'
export const PIN = '1.15.3'

const reference = (paquete: string, version: string): string => `<PackageReference Include="${paquete}" Version="${version}" />`

export interface ScaffoldWork {
  hosting?: string
  exporter?: string
  /** Archivos extra o que reemplazan a los del scaffold sano. */
  files?: Record<string, string>
  /** Sin el `.csproj` del Function App o el de tests. */
  without?: ('function' | 'tests')[]
}

/** Archivos que deja el domain-scaffolder para el dominio `prueba` del consumidor de prueba. */
export function scaffoldFiles(work: ScaffoldWork = {}): Record<string, string> {
  const files: Record<string, string> = {
    [`src/${PROJECT}/Program.cs`]: 'namespace Empresa.Proyecto.Prueba;\n',
  }
  if (!(work.without ?? []).includes('function')) {
    files[`src/${PROJECT}/${PROJECT}.csproj`] = `<Project><ItemGroup>${reference('OpenTelemetry.Extensions.Hosting', work.hosting ?? PIN)}</ItemGroup></Project>\n`
  }
  if (!(work.without ?? []).includes('tests')) {
    files[`tests/${PROJECT}.Tests/${PROJECT}.Tests.csproj`] = `<Project><ItemGroup>${reference('OpenTelemetry.Exporter.InMemory', work.exporter ?? PIN)}</ItemGroup></Project>\n`
  }
  return { ...files, ...work.files }
}

export interface ScaffoldRun {
  code: number
  out: string
  err: string
  tools: FakeTools
}

export interface ScaffoldRunOptions {
  tools?: FakeTools
  env?: NodeJS.ProcessEnv
  guion?: GuionStep[]
  deps?: Partial<ScaffoldPipelineDeps>
}

/** Corre el pipeline en proceso, con el runner real como hijo y el agente guionado. */
export async function runScaffold(consumer: Consumer, argv: string[], options: ScaffoldRunOptions = {}): Promise<ScaffoldRun> {
  const tools = options.tools ?? fakeTools({ issue: { number: 42, title: 'Crear dominio de prueba', body: 'Dominio: prueba', state: 'OPEN' } })
  if (options.guion !== undefined) {
    writeFileSync(consumer.guionFile, JSON.stringify(options.guion))
    writeFileSync(`${consumer.guionFile}.n`, '0')
  }
  let out = ''
  let err = ''
  const run = runWith(tools)
  const clock = fakeClock()
  const code = await scaffoldPipeline({
    argv,
    cwd: consumer.root,
    env: pipelineEnv(consumer, options.env),
    out: (text) => {
      out += text
    },
    err: (text) => {
      err += text
    },
    run,
    runLogged: loggedThrough(run),
    hasCommand: () => true,
    now: clock.now,
    sleep: clock.sleep,
    pid: 4242,
    ...options.deps,
  })
  return { code, out, err, tools }
}

/** Log principal de la corrida (`scaffold-<ts>-<pid>.log`). */
export function mainLog(stateDir: string): string {
  const logs = join(stateDir, 'logs')
  const found = existsSync(logs) ? readdirSync(logs).filter((name) => /^scaffold-\d{8}-\d{6}-\d+\.log$/.test(name)) : []
  return found.length === 1 ? join(logs, found[0] ?? '') : ''
}
