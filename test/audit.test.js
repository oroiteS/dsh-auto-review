import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile, rm, utimes, stat, truncate } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { auditSchema, createAuditLogger } from '../audit.js'

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'audit-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
const filename = number => `audit-${String(number).padStart(8, '0')}-0000-4000-8000-000000000000.jsonl`

test('strict whitelist excludes sensitive text, and writes only safe typed fields', async t => {
  const dir = await fixture(t)
  const warnings = []
  const audit = createAuditLogger({ directory: dir, onWarning: warning => warnings.push(warning) })
  assert.equal(await audit.log({ event: 'review', outcome: 'deny', durationMs: 23 }), true)
  for (const item of [
    { event: 'review', prompt: 'secret prompt' },
    { event: 'review', parameters: 'secret parameters' },
    { event: 'review', key: 'secret key' },
    { event: 'review', outcome: 'secret model output' },
    { event: 'review', durationMs: 'secret' },
    { event: 'secret model output' },
    { event: 'review', get outcome() { throw new Error('secret') } },
  ]) assert.equal(await audit.log(item), false)
  assert.equal(await audit.close(), true)
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  const text = await readFile(path.join(dir, files[0]), 'utf8')
  assert.ok(Buffer.byteLength(text) <= 2048)
  assert.doesNotMatch(text + JSON.stringify(warnings), /secret|prompt|parameters/)
  const entry = JSON.parse(text)
  assert.deepEqual(Object.keys(entry), ['timestamp', 'event', 'outcome', 'durationMs'])
  assert.equal(entry.outcome, 'deny')
  assert.equal(warnings.filter(w => w.code === 'record_lost').length, 7)
})

test('bounded queue, concurrent callers, close drains accepted work and rejects late writes', async t => {
  const dir = await fixture(t)
  const warnings = []
  const audit = createAuditLogger({ directory: dir, queueLimit: 2, onWarning: w => warnings.push(w) })
  const results = Array.from({ length: 20 }, () => audit.log({ event: 'review', outcome: 'allow' }))
  const closing = audit.close()
  assert.equal(await audit.log({ event: 'review' }), false)
  const values = await Promise.all(results)
  assert.equal(await closing, true)
  assert.equal(values.filter(Boolean).length, 2)
  assert.ok(warnings.some(w => w.code === 'queue_overflow'))
  const files = await readdir(dir)
  const lines = (await readFile(path.join(dir, files[0]), 'utf8')).trim().split('\n')
  assert.equal(lines.length, 2)
  assert.ok(lines.every(line => Buffer.byteLength(line + '\n') <= 2048))
  assert.equal(await audit.close(), true)
})

test('startup removes expired files and enforces total and file limits', async t => {
  const dir = await fixture(t)
  const old = path.join(dir, filename(1))
  const ancient = new Date(Date.now() - 8 * 86400000)
  await writeFile(old, `${JSON.stringify({ timestamp: ancient.toISOString(), event: 'review' })}\n`)
  await utimes(old, ancient, ancient)
  const fresh = `${JSON.stringify({ timestamp: new Date().toISOString(), event: 'review' })}\n`
  for (let i = 2; i <= 6; i++) await writeFile(path.join(dir, filename(i)), fresh.repeat(Math.floor(5 * 1024 * 1024 / Buffer.byteLength(fresh))))
  await writeFile(path.join(dir, 'unrelated.txt'), 'keep')
  const warnings = []
  const audit = createAuditLogger({ directory: dir, onWarning: w => warnings.push(w) })
  assert.equal(await audit.log({ event: 'review', outcome: 'ask' }), true)
  await audit.close()
  const names = await readdir(dir)
  assert.ok(!names.includes(filename(1)))
  assert.ok(names.includes('unrelated.txt'))
  const sizes = await Promise.all(names.filter(n => n.startsWith('audit-')).map(async n => (await stat(path.join(dir, n))).size))
  assert.ok(sizes.every(size => size <= 5 * 1024 * 1024))
  assert.ok(sizes.reduce((a, b) => a + b, 0) <= 20 * 1024 * 1024)
  assert.deepEqual(warnings, [])
})

test('initialization failure and write failure are visible without leaking errors', async t => {
  const dir = await fixture(t)
  const bad = path.join(dir, 'file')
  await writeFile(bad, 'not a directory')
  const warnings = []
  const failed = createAuditLogger({ directory: bad, onWarning: w => warnings.push(w) })
  assert.equal(await failed.flush(), false)
  assert.equal(await failed.log({ event: 'review' }), false)
  assert.equal(await failed.close(), false)
  assert.ok(warnings.some(w => w.code === 'initialization_failed'))
  assert.ok(warnings.some(w => w.code === 'record_lost'))
  const target = path.join(dir, 'logs')
  const audit = createAuditLogger({ directory: target, onWarning: w => warnings.push(w) })
  assert.equal(await audit.flush(), true)
  await rm(target, { recursive: true })
  assert.equal(await audit.log({ event: 'review' }), false)
  assert.ok(warnings.some(w => w.code === 'write_failed'))
  assert.doesNotMatch(JSON.stringify(warnings), /file|logs|directory/)
  await audit.close()
})

test('retention filters individual timestamps despite recent file mtime and reports corrupt lines', async t => {
  const dir = await fixture(t)
  const file = path.join(dir, filename(9))
  const old = JSON.stringify({ timestamp: new Date(Date.now() - 8 * 86400000).toISOString(), event: 'review' })
  const fresh = JSON.stringify({ timestamp: new Date().toISOString(), event: 'review' })
  await writeFile(file, `${old}\n${fresh}\ninvalid\npartial`)
  const warnings = []
  const audit = createAuditLogger({ directory: dir, onWarning: w => warnings.push(w) })
  assert.equal(await audit.flush(), true)
  assert.equal(await readFile(file, 'utf8'), `${fresh}\n`)
  assert.ok(warnings.some(w => w.code === 'record_lost' && w.count === 2))
  await audit.close()
})

test('external truncation or removal is not silently recreated', async t => {
  const dir = await fixture(t)
  const warnings = []
  const audit = createAuditLogger({ directory: dir, onWarning: w => warnings.push(w) })
  assert.equal(await audit.log({ event: 'review' }), true)
  let file = path.join(dir, (await readdir(dir)).find(name => name.startsWith('audit-')))
  await truncate(file, 0)
  assert.equal(await audit.log({ event: 'review' }), false)
  assert.equal(await audit.log({ event: 'review' }), true)
  const files = await readdir(dir)
  file = path.join(dir, files.find(name => name.startsWith('audit-') && name !== path.basename(file)))
  await rm(file)
  assert.equal(await audit.log({ event: 'review' }), false)
  assert.equal(warnings.filter(w => w.code === 'write_failed').length, 2)
  await audit.close()
})

test('existing cross-process or crash lock fails closed and warns', async t => {
  const dir = await fixture(t)
  await writeFile(path.join(dir, '.audit.lock'), '')
  const warnings = []
  const audit = createAuditLogger({ directory: dir, onWarning: w => warnings.push(w) })
  assert.equal(await audit.log({ event: 'review' }), false)
  assert.equal(await audit.close(), false)
  assert.ok(warnings.some(w => w.code === 'directory_locked'))
  assert.ok(warnings.some(w => w.code === 'possible_record_loss'))
  assert.ok((await readdir(dir)).includes('.audit.lock'))
})

test('expanded schema accepts only specified structured values', async t => {
  const dir = await fixture(t)
  const warnings = []
  const audit = createAuditLogger({ directory: dir, onWarning: warning => warnings.push(warning) })
  const record = {
    event: 'review_finished', outcome: 'ask', gateOutcome: 'deny',
    modelDecision: 'allow', risk: 'high', modelStatus: 'success', callMode: 'ptc-inner',
    reviewerRoute: 'a'.repeat(64), reviewId: '123e4567-e89b-42d3-a456-426614174000',
    approvalPolicy: 'never', durationMs: 12, attempt: 1,
  }
  assert.equal(await audit.log(record), true)
  for (const key of ['event', 'outcome', 'gateOutcome', 'modelDecision', 'risk', 'modelStatus', 'callMode', 'approvalPolicy']) {
    for (const value of auditSchema[key]) assert.equal(await audit.log({ event: 'review', [key]: value }), true)
    assert.equal(await audit.log({ ...record, [key]: 'secret free text' }), false)
  }
  const invalid = [
    { reviewerRoute: 'secret' }, { reviewerRoute: 'A'.repeat(64) }, { reviewerRoute: 'g'.repeat(64) },
    { reviewerRoute: 'a'.repeat(63) }, { reviewerRoute: { toString: () => 'a'.repeat(64) } },
    { reviewId: 'secret' }, { reviewId: '123e4567-e89b-02d3-a456-426614174000' },
    { reviewId: '123e4567-e89b-42d3-7456-426614174000' },
    { reason: { text: 'secret' } }, { prompt: 'secret' }, { path: 'secret' }, { args: 'secret' },
    { toolName: 'secret' }, { modelName: 'secret' }, { apiKey: 'secret' },
    { modelStatus: ['success'] }, { durationMs: Infinity }, { attempt: -1 },
    { [Symbol('secret')]: 'secret' },
  ]
  for (const item of invalid) assert.equal(await audit.log({ ...record, ...item }), false)
  const accessor = { ...record }
  Object.defineProperty(accessor, 'risk', { get() { throw new Error('secret') } })
  assert.equal(await audit.log(accessor), false)
  assert.equal(await audit.close(), true)
  const text = await readFile(path.join(dir, (await readdir(dir))[0]), 'utf8')
  const entries = text.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual({ ...entries[0], timestamp: undefined }, { timestamp: undefined, ...record })
  assert.ok(text.split('\n').every(line => Buffer.byteLength(line) + 1 <= 2048))
  assert.doesNotMatch(text + JSON.stringify(warnings), /secret/)
  assert.equal(warnings.filter(warning => warning.code === 'record_lost').length, invalid.length + 9)
  assert.ok(Object.isFrozen(auditSchema) && Object.isFrozen(auditSchema.modelDecision))
  assert.equal(auditSchema.gateOutcome, auditSchema.outcome)
})

test('reason is redacted before UTF-8 truncation and other text remains forbidden', async t => {
  const dir = await fixture(t)
  const audit = createAuditLogger({ directory: dir })
  const reason = '需要确认 https://example.com/private user@example.com /home/alice/file C:\\Users\\alice\\file token=abc123 sk-abcdef123456\n' + '中'.repeat(300)
  assert.equal(await audit.log({ event: 'review', reason }), true)
  assert.equal(await audit.log({ event: 'review', reason: '执行 rm -rf project；设置 DB_PASS hunter2，口令：secret123' }), true)
  assert.equal(await audit.log({ event: 'review', reason: 'x'.repeat(65537) }), false)
  assert.equal(await audit.log({ event: 'review', reasoning: 'secret' }), false)
  assert.equal(await audit.close(), true)
  const text = await readFile(path.join(dir, (await readdir(dir))[0]), 'utf8')
  const [entry, second] = text.trim().split('\n').map(JSON.parse)
  assert.doesNotMatch(second.reason, /rm|project|hunter2|secret123/i)
  assert.ok(entry.reason.startsWith('需要确认 [redacted]'))
  assert.ok(Buffer.byteLength(entry.reason) <= 512)
  assert.doesNotMatch(entry.reason, /example|alice|abc123|abcdef|[\u0000-\u001f\u007f-\u009f]/)
  assert.notEqual(entry.reason, reason)
})

test('directory ownership prevents competing instances and releases on close', async t => {
  const dir = await fixture(t)
  const first = createAuditLogger({ directory: dir })
  assert.throws(() => createAuditLogger({ directory: dir }), /already in use/)
  await first.close()
  const second = createAuditLogger({ directory: dir })
  await second.close()
})
