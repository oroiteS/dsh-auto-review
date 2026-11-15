import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { createReviewObserver } from './review-observer.js'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { createAuditLogger } from './audit.js'

export const name = 'configurable-auto-review'
export const inject = ['approval', 'llm', 'permissionPresets', 'sessions', 'tools', 'workingDirectory']

const packageDir = path.dirname(fileURLToPath(import.meta.url))

/** Load on every review: bad configuration fails the pending tool closed. */
export async function loadReviewSettings(directory = packageDir) {
  const config = JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8'))
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('auto-review: config must be an object')
  const { provider, model, promptFile } = config
  if (typeof provider !== 'string' || typeof model !== 'string' || Boolean(provider.trim()) !== Boolean(model.trim())) {
    throw new Error('auto-review: provider and model must both be set or both be empty')
  }
  if (typeof promptFile !== 'string' || !promptFile.trim()) throw new Error('auto-review: promptFile must be a non-empty path')
  const system = (await readFile(path.resolve(directory, promptFile), 'utf8')).trimEnd()
  if (!system.trim()) throw new Error('auto-review: prompt file is empty')
  return { provider: provider.trim(), model: model.trim(), system }
}

/** Substitute only the original plugin's LLM service; do not intercept other plugins. */
export function readGuiReview(review) {
  if (!review || typeof review !== 'object' || typeof review.provider !== 'string'
    || typeof review.model !== 'string' || typeof review.prompt !== 'string'
    || Boolean(review.provider.trim()) !== Boolean(review.model.trim()) || !review.prompt.trim()) {
    throw new Error('auto-review: provider and model must both be set or both be empty, and prompt must not be empty')
  }
  return { provider: review.provider.trim(), model: review.model.trim(), system: review.prompt.trimEnd() }
}

export function reviewContext(ctx, loadSettings = loadReviewSettings, audit) {
  const observations = new AsyncLocalStorage()
  const llm = new Proxy(ctx.llm, {
    get(target, property) {
      if (property === 'stream') return options => {
        const scope = options.purpose === 'auto-review' ? observations.getStore() : undefined
        if (scope?.active) {
          scope.streamCount++
          if (scope.streamCount > 1) scope.ambiguous = true
        }
        return (async function* () {
          let observer
          let completed = false
          let failed = false
          try {
            const settings = await loadSettings()
            options.signal?.throwIfAborted()
            const request = {
              ...options,
              ...(settings.provider ? { provider: settings.provider, model: settings.model } : {}),
              system: settings.system,
            }
            if (scope?.active && !scope.ambiguous) {
              scope.reviewerRoute = createHash('sha256').update(JSON.stringify([request.provider, request.model])).digest('hex')
              try { observer = createReviewObserver() } catch { /* observation must not alter review */ }
            }
            for await (const chunk of target.stream(request)) {
              if (observer && scope?.active && !scope.ambiguous) {
                try { observer.observe(chunk) } catch { observer = undefined }
              }
              yield chunk
            }
            completed = true
          } catch (error) {
            failed = true
            throw error
          } finally {
            if (scope?.active && !scope.ambiguous && observer) {
              try { scope.observed = observer.finish({ completed, failed }) } catch { /* unknown is safer than guessing */ }
            }
          }
        })()
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'llm') return llm
      if (property === 'on' && audit) return (event, listener, ...rest) => {
        if (event !== 'tools/pre-execute') return target.on(event, listener, ...rest)
        return target.on(event, async function (exec, next) {
          const eligible = exec.agent && !(exec.parent === undefined && exec.name === 'run_code')
            && target.permissionPresets.current(exec.agent.session) === 'auto'
          if (!eligible) return listener.call(this, exec, next)
          const started = Date.now()
          const scope = { active: true, streamCount: 0, ambiguous: false, reviewId: randomUUID() }
          const returned = await observations.run(scope, async () => {
            try { return { result: await listener.call(this, exec, next) } }
            catch (error) { return { error, failed: true } }
          })
          scope.active = false
          let approvalPolicy = 'unknown'
          try {
            const policy = target.approval?.overrideOf(exec.agent.session)
            if (policy === 'ask' || policy === 'never') approvalPolicy = policy
          } catch { /* No policy metadata is safer than a guessed value. */ }
          const result = returned.result
          const outcome = returned.failed || (result?.kind === 'deny' && result.info?.code === 'AUTO_REVIEW_FAILED')
            ? 'error' : result?.kind
          const observed = !scope.ambiguous && scope.observed ? scope.observed : {}
          const record = {
            event: 'review', outcome, gateOutcome: result?.kind ?? 'error',
            durationMs: Math.max(0, Date.now() - started), reviewId: scope.reviewId,
            callMode: exec.parent === undefined ? 'native' : 'ptc-inner', approvalPolicy,
            ...(typeof exec.agent.session.id === 'string' ? { sessionRef: createHash('sha256').update(exec.agent.session.id).digest('hex') } : {}),
            ...(typeof exec.callId === 'string' ? { callRef: createHash('sha256').update(exec.callId).digest('hex') } : {}),
            modelDecision: observed.modelDecision ?? 'unknown', risk: observed.risk ?? 'unknown',
            modelStatus: observed.modelStatus ?? 'unknown',
            ...(scope.reviewerRoute && !scope.ambiguous ? { reviewerRoute: scope.reviewerRoute } : {}),
            ...(typeof observed.reason === 'string' ? { reason: observed.reason } : {}),
          }
          let written = false
          try { written = await audit.log(record) } catch { /* Audit failure must not permit execution. */ }
          // Do not retain model-provided reason beyond this record.
          delete record.reason
          if (scope.observed) delete scope.observed.reason
          if (!written) return {
            kind: 'deny',
            reason: 'Auto review audit log failed or overflowed; this tool call was not executed. Check the plugin audit log.',
            info: { name: 'AutoReviewAuditError', code: 'AUTO_REVIEW_AUDIT_FAILED' },
          }
          if (returned.failed) throw returned.error
          return result
        }, ...rest)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** The original gate and routing override share one plugin lifecycle. */
export async function apply(ctx, loadSettings = loadReviewSettings) {
  const installDir = process.env.DSH_INSTALL_DIR ?? (process.resourcesPath
    ? path.join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
    : undefined)
  if (!installDir) throw new Error('auto-review: cannot locate the DSH installation; set DSH_INSTALL_DIR')
  const manifest = JSON.parse(await readFile(path.join(installDir, 'package.json'), 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== '0.2.2-rc.3') {
    throw new Error('auto-review: this plugin requires DSH 0.2.2-rc.3; revalidate compatibility before use')
  }
  const requireFromDsh = createRequire(path.join(installDir, 'package.json'))
  const entry = requireFromDsh.resolve('@deepseek-ai/dsh-experimental-auto-review')
  const original = await import(pathToFileURL(entry).href)
  if (typeof original.apply !== 'function') throw new Error('auto-review: original integration has no apply export')
  let fault = false
  const logger = createAuditLogger({
    directory: path.join(packageDir, 'audit-log'),
    onWarning: ({ code }) => {
      fault = true
      console.warn(`[configurable-auto-review] audit warning: ${code}`)
    },
  })
  const ready = await logger.flush()
  if (!ready || fault) {
    await logger.close()
    throw new Error('auto-review: audit log initialization failed; inspect the plugin audit directory and host log')
  }
  const audit = {
    async log(record) {
      if (fault) return false
      const written = await logger.log(record)
      return written && !fault
    },
  }
  // Register cleanup first, so the upstream gate drains before the logger closes.
  ctx.effect(() => () => logger.close())
  return original.apply(reviewContext(ctx, loadSettings, audit))
}
