// Offline integration-test driver plugin.
//
// Mounted by a base-only DSH profile together with dsh-tokeneconomizer. It waits
// (bounded) for the tokeneconomizer load marker, writes a machine-readable
// result file, and exits the DSH process so the process-level test terminates.
// It is test-only: no model, no network, no host API beyond fs.
import fs from 'node:fs'
import path from 'node:path'

export const name = 'te-integration-driver'

/**
 * @param {object} _config Bundle patch config (unused).
 */
export function apply(_config) {
  const home = process.env.DSH_HOME ?? ''
  const resultPath = process.env.TE_DRIVER_RESULT ?? path.join(home, 'driver-result.json')
  const markerPath = path.join(home, 'tokeneconomizer', 'plugin-load.json')
  const timeoutMs = Number(process.env.TE_DRIVER_TIMEOUT_MS ?? '30000')
  const started = Date.now()

  /** @param {Record<string, any>} result */
  const finish = (result) => {
    try {
      fs.mkdirSync(path.dirname(resultPath), { recursive: true })
      fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    } catch {
      // The test reads the exit code and its log; a write failure is not thrown.
    }
    process.exit(result.markerFound === true ? 0 : 1)
  }

  /** @param {Record<string, any>} [extra] */
  const result = (extra = {}) => ({
    markerFound: fs.existsSync(markerPath),
    waitedMs: Date.now() - started,
    pid: process.pid,
    dshHome: home,
    ...extra,
  })

  const poll = () => {
    if (fs.existsSync(markerPath)) {
      let marker = null
      try {
        marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
      } catch {
        marker = { unreadable: true }
      }
      finish(result({ marker }))
      return
    }
    if (Date.now() - started > timeoutMs) {
      finish(result({ timedOut: true }))
      return
    }
    setTimeout(poll, 100)
  }
  setTimeout(poll, 0)
}
