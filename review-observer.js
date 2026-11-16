// A bounded, side-effect-free projection of the upstream review stream. Never log
// chunks or errors. The caller must redact a returned reason before persistence.
// Bound the assembled text; replacing a completed block may briefly retain
// both the old and new strings, so peak memory can be twice this limit.
const MAX_BYTES = 8 * 1024
const MAX_BLOCKS = 256

export function parseDecision(text) {
  const value = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  // Match the upstream topLevelMemberCount, including escaped member names.
  const syntax = text.replace(/"(?:\\.|[^"\\])*"/gs, '')
  let depth = 0
  let count = 0
  for (const char of syntax) {
    if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') depth--
    else if (char === ':' && depth === 1) count++
  }
  const keys = Object.keys(value)
  if (count !== keys.length) return
  const { risk, decision } = value
  if (keys.length === 2 && decision === 'allow' && (risk === 'low' || risk === 'medium')) return { risk, decision }
  if (decision === 'deny' && ['low', 'medium', 'high', 'unknown'].includes(risk)) {
    const legacyRisk = risk === 'medium' || risk === 'high'
    if (legacyRisk && keys.length === 2) return { risk, decision }
    if (keys.length === 3 && Object.hasOwn(value, 'reason') && typeof value.reason === 'string' &&
        (legacyRisk || value.reason.trim().length > 0)) {
      return { risk, decision, reason: value.reason }
    }
  }
}

/** Observe chunks without changing them. The caller reports normal EOF with
 * completed and a thrown stream error with failed; neither contains raw errors. */
export function createReviewObserver() {
  const blocks = new Map()
  let bytes = 0
  let invalid = false
  let terminal = false
  let terminalKind
  let finished = false
  const discard = () => { invalid = true; blocks.clear(); bytes = 0 }
  const ensure = (index, type) => {
    if (!Number.isSafeInteger(index) || index < 0) { discard(); return }
    let partial = blocks.get(index)
    if (!partial) {
      if (blocks.size >= MAX_BLOCKS) { discard(); return }
      partial = { type: type === 'text' || type === 'reasoning' ? type : 'other', text: '', closed: false }
      blocks.set(index, partial)
    }
    return partial
  }
  const replace = (partial, text, append = false) => {
    if (typeof text !== 'string') { discard(); return }
    const size = Buffer.byteLength(text, 'utf8')
    if (size > MAX_BYTES) { discard(); return }
    const old = Buffer.byteLength(partial.text, 'utf8')
    // A surrogate pair can span two deltas: measure the joined string rather
    // than summing their individual UTF-8 lengths.
    const next = append ? partial.text + text : text
    const nextBytes = bytes - old + Buffer.byteLength(next, 'utf8')
    if (nextBytes > MAX_BYTES) { discard(); return }
    partial.text = next
    bytes = nextBytes
  }
  function observe(chunk) {
    if (finished || invalid) return
    try {
      if (!chunk || typeof chunk !== 'object' || terminal) { discard(); return }
      switch (chunk.type) {
        case 'block-start': {
          if (typeof chunk.blockType !== 'string') { discard(); return }
          ensure(chunk.index, chunk.blockType)
          break
        }
        case 'text-delta':
        case 'reasoning-delta': {
          const partial = ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
          if (!partial || partial.closed) break
          if (typeof chunk.text !== 'string') { discard(); break }
          // The assembler appends either delta kind to a single partial.text.
          // Reasoning content need not be retained unless its original type is text.
          if (partial.type === 'text') replace(partial, chunk.text, true)
          break
        }
        case 'tool-call-delta': {
          const partial = ensure(chunk.index, 'tool-call')
          if (!partial || partial.closed) break
          if (typeof chunk.argumentsDelta !== 'string') discard()
          break
        }
        case 'block-end': {
          if (!chunk.block || typeof chunk.block !== 'object' || typeof chunk.block.type !== 'string') { discard(); break }
          const partial = ensure(chunk.index, chunk.block.type)
          if (!partial || partial.closed) break
          const type = chunk.block.type
          if (type === 'text') replace(partial, chunk.block.text)
          else { bytes -= Buffer.byteLength(partial.text, 'utf8'); partial.text = '' }
          if (invalid) break
          partial.type = type === 'text' || type === 'reasoning' ? type : 'other'
          partial.closed = true
          break
        }
        case 'usage': break
        case 'finish':
          if (!chunk.reason || typeof chunk.reason.kind !== 'string') { discard(); break }
          terminal = true
          terminalKind = chunk.reason.kind
          break
        default: discard()
      }
    } catch { discard() }
  }
  function finish(options = { completed: true }) {
    let modelStatus = 'unknown'
    try {
      if (terminalKind === 'aborted') modelStatus = 'cancelled'
      else if (options?.failed || terminalKind === 'error') modelStatus = 'error'
      let result = { modelDecision: 'unknown', risk: 'unknown', modelStatus }
      if (!finished && !invalid && !options?.failed && options?.completed === true && terminal && terminalKind === 'stop') {
        const values = [...blocks.values()]
        const final = values.at(-1)
        if (final?.type === 'text' && values.slice(0, -1).every(block => block.type === 'reasoning')) {
          const decision = parseDecision(final.text)
          if (decision) result = { modelDecision: decision.decision, risk: decision.risk, modelStatus: 'success', ...Object.hasOwn(decision, 'reason') ? { reason: decision.reason } : {} }
        }
      }
      return result
    } catch {
      return { modelDecision: 'unknown', risk: 'unknown', modelStatus }
    } finally {
      finished = true
      blocks.clear()
      bytes = 0
    }
  }
  return { observe, finish }
}
