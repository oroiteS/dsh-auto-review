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
const MAX_REVIEW_STREAM_BYTES = 1024 * 1024
const MAX_REVIEW_STREAM_CHUNKS = 8192

// The pinned upstream gate accepts only medium/high denials. Preserve every
// chunk's structure while mapping the two additional, already validated deny
// risks to medium for its parser. The audit observer retains the original risk.
function normalizeExtendedDenial(chunks, observed) {
  if (observed?.modelStatus !== 'success' || observed.modelDecision !== 'deny'
    || (observed.risk !== 'unknown' && observed.risk !== 'low')) return chunks
  const indexes = new Set()
  for (const chunk of chunks) {
    if (['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end'].includes(chunk.type)) {
      indexes.add(chunk.index)
    }
  }
  const finalIndex = [...indexes].at(-1)
  const text = JSON.stringify({ risk: 'medium', decision: 'deny', reason: observed.reason })
  let replaced = false
  return chunks.map(chunk => {
    if (chunk.index !== finalIndex) return chunk
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const replacement = replaced ? '' : text
      replaced = true
      return { ...chunk, text: replacement }
    }
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
      return { ...chunk, block: { ...chunk.block, text } }
    }
    return chunk
  })
}

/** Load on every review: bad configuration fails the pending tool closed. */
export async function loadReviewSettings(directory = packageDir) {
  const config = JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8'))
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('auto-review: config must be an object')
  const { provider, model, promptFile, reasoningEffort } = config
  if (typeof provider !== 'string' || typeof model !== 'string' || Boolean(provider.trim()) !== Boolean(model.trim())) {
    throw new Error('auto-review: provider and model must both be set or both be empty')
  }
  if (typeof promptFile !== 'string' || !promptFile.trim()) throw new Error('auto-review: promptFile must be a non-empty path')
  const system = (await readFile(path.resolve(directory, promptFile), 'utf8')).trimEnd()
  if (!system.trim()) throw new Error('auto-review: prompt file is empty')
  return { provider: provider.trim(), model: model.trim(), system, ...readReasoningEffort(reasoningEffort) }
}

/** Empty or absent selects the destination model's default; effort IDs are provider-defined. */
function readReasoningEffort(value) {
  if (value === undefined || value === '') return {}
  if (typeof value !== 'string') {
    throw new Error('auto-review: reasoningEffort must be an exact model effort ID or empty')
  }
  return { reasoningEffort: value }
}

/** Substitute only the original plugin's LLM service; do not intercept other plugins. */
export function readGuiReview(review) {
  if (!review || typeof review !== 'object' || typeof review.provider !== 'string'
    || typeof review.model !== 'string' || typeof review.prompt !== 'string'
    || Boolean(review.provider.trim()) !== Boolean(review.model.trim()) || !review.prompt.trim()) {
    throw new Error('auto-review: provider and model must both be set or both be empty, and prompt must not be empty')
  }
  return {
    provider: review.provider.trim(), model: review.model.trim(), system: review.prompt.trimEnd(),
    ...readReasoningEffort(review.reasoningEffort),
  }
}

// A downstream approval can win the upstream waterfall. Retain its original
// explanation while making the reviewer's separate denial visible as well.
function reviewApproval(result, observed, downstreamDecision) {
  if (result?.kind !== 'ask' || observed?.modelStatus !== 'success' || observed.modelDecision !== 'deny') return result
  const reason = typeof observed.reason === 'string' && observed.reason.trim() ? observed.reason : undefined
  const downstream = result === downstreamDecision
  if (!downstream && reason !== undefined) return result
  const existing = result.displayReason ?? { en: result.reason ?? 'Approval required.' }
  const locales = new Set(['en', 'zh', ...Object.keys(existing)])
  const displayReason = Object.fromEntries([...locales].map(locale => {
    const original = existing[locale] ?? existing.en ?? result.reason ?? 'Approval required.'
    const chinese = locale === 'zh' || locale.startsWith('zh-')
    const explanation = chinese
      ? (reason === undefined ? '审查模型拒绝了此调用，但未提供具体原因。' : `审查模型拒绝原因：${reason}`)
      : (reason === undefined ? 'The review model denied this call without providing a reason.' : `Review model denial reason: ${reason}`)
    return [locale, `${original} ${explanation}`]
  }))
  return { ...result, displayReason }
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
          let finalized = false
          let completed = false
          let failed = false
          try {
            const settings = await loadSettings()
            options.signal?.throwIfAborted()
            // Never carry the session's effort to another reviewer route. Omission
            // lets DSH resolve the destination model's own default during stream.
            const { reasoningEffort: _upstreamEffort, ...baseOptions } = options
            const request = {
              ...baseOptions,
              ...(settings.provider ? { provider: settings.provider, model: settings.model } : {}),
              ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
              system: settings.system,
            }
            if (scope?.active && !scope.ambiguous) {
              scope.reviewerRoute = createHash('sha256').update(JSON.stringify([request.provider, request.model])).digest('hex')
              try { observer = createReviewObserver() } catch { /* observation must not alter review */ }
            }
            // Outside an active review gate there is no authority to adapt a
            // response; retain the original streaming behaviour.
            if (!observer) {
              for await (const chunk of target.stream(request)) yield chunk
              completed = true
              return
            }
            const chunks = []
            let bytes = 0
            for await (const chunk of target.stream(request)) {
              options.signal?.throwIfAborted()
              const encoded = JSON.stringify(chunk)
              if (typeof encoded !== 'string') throw new Error('auto-review: invalid review stream chunk')
              bytes += Buffer.byteLength(encoded, 'utf8')
              if (bytes > MAX_REVIEW_STREAM_BYTES || chunks.length >= MAX_REVIEW_STREAM_CHUNKS) {
                throw new Error('auto-review: review stream exceeded safe buffer limits')
              }
              chunks.push(chunk)
              if (scope?.active && !scope.ambiguous) observer.observe(chunk)
            }
            completed = true
            if (scope?.active && !scope.ambiguous) {
              scope.observed = observer.finish({ completed: true, failed: false })
              finalized = true
            }
            for (const chunk of normalizeExtendedDenial(chunks, scope?.ambiguous ? undefined : scope?.observed)) {
              options.signal?.throwIfAborted()
              yield chunk
            }
          } catch (error) {
            failed = true
            throw error
          } finally {
            if (!finalized && scope?.active && !scope.ambiguous && observer) {
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
          let downstreamDecision
          const returned = await observations.run(scope, async () => {
            try {
              return { result: await listener.call(this, exec, async () => {
                downstreamDecision = await next()
                return downstreamDecision
              }) }
            } catch (error) { return { error, failed: true } }
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
          const approvalResult = reviewApproval(result, observed, downstreamDecision)
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
          return approvalResult
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
