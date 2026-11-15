import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReviewObserver } from '../review-observer.js'

const stop = { type: 'finish', reason: { kind: 'stop' } }
const delta = (index, text) => ({ type: 'text-delta', index, text })
const end = (index, type, text) => ({ type: 'block-end', index, block: { type, text } })
const expected = (modelDecision = 'unknown', risk = 'unknown', modelStatus = modelDecision === 'unknown' ? 'unknown' : 'success') => ({ modelDecision, risk, modelStatus })
function run(chunks, options) {
  const observer = createReviewObserver()
  for (const chunk of chunks) observer.observe(chunk)
  return observer.finish(options)
}

test('accepts exact upstream shapes and rejects malformed decisions', () => {
  for (const [text, result] of [
    ['{"risk":"low","decision":"allow"}', expected('allow', 'low')],
    ['{"decision":"allow","risk":"medium"}', expected('allow', 'medium')],
    ['{"risk":"medium","decision":"deny"}', expected('deny', 'medium')],
    ['{"risk":"high","decision":"deny","reason":"private"}', { ...expected('deny', 'high'), reason: 'private' }],
    ['{"risk":"low","decision":"deny"}', expected()],
    ['{"risk":"high","decision":"allow"}', expected()],
    ['{"risk":"low","decision":"allow","reason":"x"}', expected()],
    ['{"risk":"low","risk":"low","decision":"allow"}', expected()],
    ['{"risk":"low","r\\u0069sk":"low","decision":"allow"}', expected()],
    ['{"risk":"low","decision":"allow"} trailing', expected()],
    ['[]', expected()],
  ]) assert.deepEqual(run([delta(0, text), stop]), result)
})

test('assembler first-index order, duplicate starts and end overwrite', () => {
  const valid = '{"risk":"medium","decision":"deny","reason":"ok"}'
  assert.deepEqual(run([
    { type: 'reasoning-delta', index: 10, text: 'secret' },
    delta(2, 'wrong'), { type: 'block-start', index: 2, blockType: 'reasoning' },
    end(2, 'text', valid), delta(2, 'ignored'), end(2, 'text', 'ignored'), stop,
  ]), { ...expected('deny', 'medium'), reason: 'ok' })
  assert.deepEqual(run([delta(1, valid), { type: 'reasoning-delta', index: 1, text: 'x' }, stop]), expected())
  assert.deepEqual(run([{ type: 'block-start', index: 0, blockType: 'reasoning' }, delta(0, valid), stop]), expected())
  assert.deepEqual(run([end(0, 'text', valid), { type: 'reasoning-delta', index: 1, text: 'x' }, stop]), expected())
  assert.deepEqual(run([delta(0, valid), delta(1, valid), stop]), expected())
})

test('terminal, EOF, caller errors and cancellation are independent of content', () => {
  const text = '{"risk":"low","decision":"allow"}'
  assert.deepEqual(run([delta(0, text)]), expected('unknown', 'unknown', 'unknown'))
  assert.deepEqual(run([delta(0, text), stop, stop]), expected())
  assert.deepEqual(run([delta(0, text), { type: 'finish', reason: { kind: 'error' } }]), expected('unknown', 'unknown', 'error'))
  assert.deepEqual(run([delta(0, text), { type: 'finish', reason: { kind: 'aborted' } }]), expected('unknown', 'unknown', 'cancelled'))
  assert.deepEqual(run([delta(0, text), { type: 'finish', reason: { kind: 'max-tokens' } }]), expected('unknown', 'unknown', 'unknown'))
  assert.deepEqual(run([delta(0, text), stop], { completed: false, failed: true }), expected('unknown', 'unknown', 'error'))
  assert.deepEqual(run([delta(0, text), stop], { completed: false, failed: false }), expected())
  assert.deepEqual(run([delta(0, text), stop], { completed: true, failed: false }), expected('allow', 'low'))
})

test('enforces byte and block limits, does not store reasoning or mutate input', () => {
  const chunk = Object.freeze({ type: 'reasoning-delta', index: 0, text: 's'.repeat(100000) })
  const text = '{"risk":"low","decision":"allow"}'
  assert.deepEqual(run([chunk, delta(1, text), stop]), expected('allow', 'low'))
  assert.deepEqual(run([delta(0, '中'.repeat(6000)), stop]), expected('unknown', 'unknown', 'unknown'))
  assert.deepEqual(run([delta(0, text), end(0, 'text', 'x'.repeat(16384)), stop]), expected('unknown', 'unknown', 'unknown'))
  const many = Array.from({ length: 257 }, (_, index) => ({ type: 'block-start', index, blockType: 'reasoning' }))
  assert.deepEqual(run([...many, stop]), expected('unknown', 'unknown', 'unknown'))
  assert.deepEqual(run([delta(-1, text), stop]), expected('unknown', 'unknown', 'unknown'))
})
