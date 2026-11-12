// Pipeline falso que sigue vivo despues de que el lanzador termina: anota su PID en
// LAUNCH_TEST_OUT y espera hasta que exista LAUNCH_TEST_STOP, o un minuto como mucho.

import { existsSync, renameSync, writeFileSync } from 'node:fs'

const out = process.env.LAUNCH_TEST_OUT ?? ''
const stop = process.env.LAUNCH_TEST_STOP ?? ''
process.stdout.write(`arrancado:${process.argv
  .slice(2)
  .map((arg) => ` [${arg}]`)
  .join('')}\n`)
writeFileSync(`${out}.tmp`, `${process.pid}\n`)
renameSync(`${out}.tmp`, out)
const deadline = Date.now() + 60_000
const timer = setInterval(() => {
  if ((stop !== '' && existsSync(stop)) || Date.now() > deadline) clearInterval(timer)
}, 200)
