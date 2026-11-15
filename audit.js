import { mkdir, readdir, lstat, unlink, open, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const MAX_RECORD = 2 * 1024
const MAX_FILE = 5 * 1024 * 1024
const MAX_TOTAL = 20 * 1024 * 1024
const MAX_AGE = 7 * 24 * 60 * 60 * 1000
const NAME = /^audit-[0-9a-f-]{36}\.jsonl$/
const owners = new Set()
const outcomeValues = Object.freeze(['allow', 'ask', 'deny', 'cancel', 'error', 'allowed', 'denied', 'cancelled', 'success'])

// Public schema describes only caller-supplied fields; timestamp is generated here.
// A fingerprint must be produced by the caller (SHA-256, lowercase hex), not
// an unhashed reviewer or model name. Its format alone cannot prove its origin.
export const auditSchema = Object.freeze({
  event: Object.freeze(['review', 'review_started', 'review_finished', 'review_failed', 'tool_allowed', 'tool_denied']),
  outcome: outcomeValues,
  gateOutcome: outcomeValues,
  modelDecision: Object.freeze(['allow', 'deny', 'unknown']),
  risk: Object.freeze(['low', 'medium', 'high', 'unknown']),
  modelStatus: Object.freeze(['success', 'error', 'timeout', 'cancelled', 'unknown']),
  callMode: Object.freeze(['native', 'ptc-inner']),
  approvalPolicy: Object.freeze(['ask', 'never', 'unknown']),
  reviewerRoute: 'sha256-lowercase-hex',
  sessionRef: 'sha256-lowercase-hex',
  callRef: 'sha256-lowercase-hex',
  reviewId: 'uuid',
  durationMs: 'non-negative-safe-integer',
  attempt: 'non-negative-safe-integer',
  reason: 'redacted-utf8-at-most-512-bytes',
})
const enumFields = ['event', 'outcome', 'modelDecision', 'risk', 'modelStatus', 'callMode', 'approvalPolicy']
const enumValues = Object.fromEntries(enumFields.map(key => [key, new Set(auditSchema[key])]))
const fields = new Set([...Object.keys(auditSchema), 'gateOutcome'])
const fingerprint = /^[0-9a-f]{64}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Best-effort redaction cannot guarantee removal of every secret. Apply before
// truncation so a truncated credential cannot evade the full-pattern checks.
function redactReason(value) {
  if (typeof value !== 'string' || value.length > 65536) return null
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\b(?:rm|rmdir|unlink|shred|curl|wget|scp|rsync|ssh|bash|sh|zsh|python\d*|node|git)\b[^\n。；;]*/gi, '[redacted-command]')
    .replace(/\b[A-Za-z0-9_]*(?:PASS(?:WORD)?|TOKEN|SECRET|CREDENTIAL|API[_-]?KEY)[A-Za-z0-9_]*\b\s*[:=]?\s*[^\s,;，。]+/gi, '[redacted]')
    .replace(/(?:密码|口令|密钥|令牌|凭证)\s*[:：=]?\s*[^\s,;，。]+/g, '[redacted]')
    .replace(/\b(?:https?|ftp|file):\/\/[^\s]+/gi, '[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/|~\/)[^\s]*/g, '[redacted]')
    .replace(/\b(?:bearer|authorization|api[_-]?key|token|secret|password|passwd|credential)\b\s*[:=]?\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+\b/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9+/=_-]{32,}\b/g, '[redacted]')
  let result = ''
  let bytes = 0
  for (const char of text) {
    const size = Buffer.byteLength(char)
    if (bytes + size > 512) break
    result += char
    bytes += size
  }
  return result
}

/** Strictly typed fields; reason, if present, is redacted before persistence. */
function encode(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !fields.has(key) || !('value' in descriptors[key]))) return null
  const value = key => descriptors[key]?.value
  if (!enumValues.event.has(value('event'))) return null
  for (const key of enumFields.slice(1)) {
    if (descriptors[key] && !enumValues[key].has(value(key))) return null
  }
  if (descriptors.gateOutcome && !enumValues.outcome.has(value('gateOutcome'))) return null
  for (const key of ['reviewerRoute', 'sessionRef', 'callRef']) {
    if (descriptors[key] && (typeof value(key) !== 'string' || !fingerprint.test(value(key)))) return null
  }
  if (descriptors.reviewId && (typeof value('reviewId') !== 'string' || !uuid.test(value('reviewId')))) return null
  for (const key of ['durationMs', 'attempt']) {
    if (descriptors[key] && (!Number.isSafeInteger(value(key)) || value(key) < 0)) return null
  }
  let reason
  if (descriptors.reason) {
    reason = redactReason(value('reason'))
    if (reason === null) return null
  }
  const record = { timestamp: new Date().toISOString(), event: value('event') }
  for (const key of fields) if (key !== 'event' && key !== 'reason' && descriptors[key]) record[key] = value(key)
  if (descriptors.reason) record.reason = reason
  const line = Buffer.from(`${JSON.stringify(record)}\n`)
  return line.length <= MAX_RECORD ? line : null
}

/**
 * One live instance may own a directory across processes. A crash leaves the
 * exclusive lock in place; an operator must verify the owner is gone and remove it.
 * log() resolves after the write/close, not fsync; await close().
 * Warnings contain only fixed codes and counts, never input or filesystem errors.
 */
export function createAuditLogger({ directory, onWarning = () => {}, queueLimit = 1024 } = {}) {
  if (typeof directory !== 'string' || !directory || typeof onWarning !== 'function' || !Number.isSafeInteger(queueLimit) || queueLimit < 1 || queueLimit > 10000) throw new TypeError('invalid audit configuration')
  const dir = path.resolve(directory)
  if (owners.has(dir)) throw new Error('audit directory already in use')
  owners.add(dir)
  let closed = false
  let current = null
  let running = null
  let closePromise = null
  let locked = false
  const lockFile = path.join(dir, '.audit.lock')
  const queue = []
  const warn = (code, count = 1) => { try { onWarning({ code, count }) } catch { /* warning handlers must not interrupt logging */ } }

  async function inventory() {
    const files = []
    for (const name of await readdir(dir)) {
      if (!NAME.test(name)) continue
      const file = path.join(dir, name)
      try {
        const stat = await lstat(file)
        if (stat.isFile()) files.push({ file, size: stat.size, mtime: stat.mtimeMs })
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return files.sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file))
  }

  async function prune(required = 0, clean = false) {
    const files = await inventory()
    if (clean) {
      for (const file of files) {
        if (file.size > MAX_FILE) {
          await unlink(file.file)
          file.size = 0
          if (file.file === current?.file) current = null
          warn('oversized_file_removed')
          warn('record_lost')
          continue
        }
        const data = await readFile(file.file)
        if (data.length > MAX_FILE) throw new Error('audit file changed during cleanup')
        const lines = data.toString('utf8').split('\n')
        const complete = lines.pop()
        let lost = complete ? 1 : 0
        const kept = []
        for (const line of lines) {
          try {
            const entry = JSON.parse(line)
            const time = Date.parse(entry.timestamp)
            if (!Number.isFinite(time) || Buffer.byteLength(line) + 1 > MAX_RECORD) throw new Error('invalid line')
            if (time >= Date.now() - MAX_AGE) kept.push(line)
          } catch { lost++ }
        }
        if (lost) warn('record_lost', lost)
        const filtered = kept.length ? `${kept.join('\n')}\n` : ''
        if (Buffer.byteLength(filtered) !== data.length) {
          try {
            if (filtered) await writeFile(file.file, filtered, { mode: 0o600 })
            else await unlink(file.file)
          } catch (error) { warn('record_lost'); throw error }
          file.size = Buffer.byteLength(filtered)
          if (file.file === current?.file) {
            if (filtered) current.size = file.size
            else current = null
          }
        }
      }
    }
    let total = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of files) {
      if (file.size && total + required > MAX_TOTAL) {
        await unlink(file.file)
        total -= file.size
        if (file.file === current?.file) current = null
      }
    }
    if (total + required > MAX_TOTAL) throw new Error('audit capacity unavailable')
  }

  async function initialize() {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    let lock
    try { lock = await open(lockFile, 'wx', 0o600) } catch (error) {
      if (error.code === 'EEXIST') { warn('directory_locked', 0); warn('possible_record_loss', 0) }
      throw error
    }
    locked = true
    await lock.close()
    await prune(0, true)
  }
  // Attach the rejection handler immediately, even if no records are submitted.
  const ready = initialize().then(() => true, () => { warn('initialization_failed', 0); return false })

  async function write(line) {
    if (!current || current.size + line.length > MAX_FILE) {
      current = null
      await prune(line.length, true)
      const file = path.join(dir, `audit-${randomUUID()}.jsonl`)
      const handle = await open(file, 'wx', 0o600)
      await handle.close()
      current = { file, size: 0 }
    } else {
      await prune(line.length)
      if (!current) return write(line)
    }
    const handle = await open(current.file, 'r+')
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== current.size) throw new Error('audit file changed')
      let offset = 0
      while (offset < line.length) {
        const { bytesWritten } = await handle.write(line, offset, line.length - offset, current.size + offset)
        if (!bytesWritten) throw new Error('short write')
        offset += bytesWritten
      }
    } finally { await handle.close() }
    current.size += line.length
  }

  function start() {
    if (running) return running
    running = (async () => {
      const initialized = await ready
      while (queue.length) {
        const { line, resolve } = queue.shift()
        if (!initialized) { warn('record_lost'); resolve(false); continue }
        try { await write(line); resolve(true) } catch { current = null; warn('write_failed'); warn('record_lost'); resolve(false) }
      }
    })().finally(() => { running = null; if (queue.length) start() })
    return running
  }

  return {
    log(record) {
      if (closed) { warn('record_lost'); return Promise.resolve(false) }
      let line
      try { line = encode(record) } catch { line = null }
      if (!line) { warn('invalid_record'); warn('record_lost'); return Promise.resolve(false) }
      if (queue.length >= queueLimit) { warn('queue_overflow'); warn('record_lost'); return Promise.resolve(false) }
      return new Promise(resolve => {
        queue.push({ line, resolve })
        start()
      })
    },
    async flush() {
      const initialized = await ready
      while (running || queue.length) await (running || start())
      return initialized
    },
    close() {
      if (!closePromise) {
        closed = true
        closePromise = (async () => {
          try {
            const initialized = await this.flush()
            if (locked) {
              try { await unlink(lockFile); locked = false } catch { warn('lock_release_failed', 0); return false }
            }
            return initialized
          } finally { owners.delete(dir) }
        })()
      }
      return closePromise
    },
  }
}
