#!/usr/bin/env node

// Optional maintenance check. Normal JSON generation does not load the repo or Vite.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { calculationCases, createCalculationInput } from './calculation-cases.mjs'
import {
  buildQuotationEnvelope,
  createQuotationRevisionInEnvelope,
  deleteQuotationRevisionFromEnvelope,
  restoreQuotationRevisionInEnvelope,
  summarizeQuotationEnvelope,
  validateQuotationEnvelope,
} from './quotation-json.mjs'

const repoPath = process.argv[2]
if (!repoPath) {
  console.error('Usage: node verify-repo-parity.mjs <quotation-software-repo>')
  process.exit(2)
}

const root = resolve(repoPath)
const requireFromRepo = createRequire(resolve(root, 'package.json'))
const { createServer } = await import(pathToFileURL(requireFromRepo.resolve('vite')).href)
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { parseQuotationDocumentContent } = await server.ssrLoadModule('/src/features/quotations/utils/quotationFile.ts')
  const { proposeQuotationRevision } = await server.ssrLoadModule('/src/features/quotations/utils/quotationRevisions.ts')
  const { calculateQuotationTotals } = await server.ssrLoadModule('/src/features/quotations/utils/quotationCalculations.ts')
  const { createGoodsReceiptLineDrafts } = await server.ssrLoadModule('/src/features/goods-receipts/utils/goodsReceipt.ts')
  const now = new Date('2026-09-08T08:00:00.000Z')
  let checked = 0
  function check(name, envelope, expectedTotal) {
    assert.deepEqual(validateQuotationEnvelope(envelope).errors, [], `${name}: offline validation`)
    const { quotation } = parseQuotationDocumentContent(JSON.stringify(envelope))
    const actual = summarizeQuotationEnvelope(envelope)
    const expected = calculateQuotationTotals(quotation.majorItems, quotation.totalsConfig, quotation.exchangeRates)
    for (const key of Object.keys(expected)) {
      assert.deepEqual(actual[key], expected[key], `${name}: ${key}`)
    }
    assert.equal(actual.currency, quotation.header.currency, `${name}: currency`)
    if (expectedTotal !== undefined) assert.equal(actual.grandTotal, expectedTotal, `${name}: expected total`)
    checked += 1
    return quotation
  }

  for (const entry of calculationCases) {
    check(entry.name, buildQuotationEnvelope(createCalculationInput(entry.input), now).envelope, entry.grandTotal)
  }

  // Exercise complete files that did not pass through the builder first.
  const rawCurrency = buildQuotationEnvelope(createCalculationInput(), now).envelope
  rawCurrency.quotation.header.currency = ' usd '
  rawCurrency.quotation.majorItems[0].costCurrency = ' eur '
  rawCurrency.quotation.exchangeRates = { usd: 1, EUR: 0.9 }
  check('raw lowercase currencies', rawCurrency, 90)

  const rawCharges = buildQuotationEnvelope(createCalculationInput(), now).envelope
  rawCharges.quotation.totalsConfig.extraCharges = [
    { id: 'a', label: 'A', amount: 0.005 }, { id: 'b', label: 'B', amount: 0.005 },
  ]
  check('raw sub-cent charges', rawCharges, 100.02)

  const ambiguous = structuredClone(rawCurrency)
  ambiguous.quotation.exchangeRates = { USD: 1, EUR: 1.08, eur: 0.9 }
  assert.ok(validateQuotationEnvelope(ambiguous).errors.some((error) => /Duplicate.*currency/i.test(error)))
  assert.throws(() => parseQuotationDocumentContent(JSON.stringify(ambiguous)), /duplicate_currency/)

  const fixture = JSON.parse(await readFile(new URL('../evals/fixtures/quotation-with-receipt.json', import.meta.url), 'utf8'))
  const fixtureQuotation = check('portable evaluation fixture', fixture)
  assert.deepEqual(fixture.quotation.pendingGoodsReceiptDraft.lines, createGoodsReceiptLineDrafts(fixtureQuotation.majorItems))

  // History is outside the editable quotation. Archived content must survive import
  // and rebuild unchanged, even when active-draft normalization would add defaults.
  const revisionInput = buildQuotationEnvelope(fixture, now).envelope
  assert.equal(revisionInput.schemaVersion, 3, 'builder defaults to schema 3')
  assert.deepEqual(revisionInput.revisions, [], 'new document has no saved revisions')
  revisionInput.quotation = JSON.parse(JSON.stringify(
    parseQuotationDocumentContent(JSON.stringify(revisionInput)).quotation,
  ))
  const archived = structuredClone(revisionInput.quotation)
  archived.header.revisionNumber = 1
  archived.header.projectName = 'Original scope'
  archived.majorItems[0].name = ''
  archived.majorItems[0].children[0].name = '  '
  archived.majorItems.unshift({ id: 'archived-section', kind: 'section_header', title: '' })
  archived.pendingGoodsReceiptDraft.grNumber = 'GR-ARCHIVED'
  archived.goodsReceiptHistory = []
  revisionInput.revisions = [{
    id: 'archived-original', revisionNumber: 1, createdAt: now.toISOString(),
    note: '  Preserve archived note verbatim  ', quotation: archived,
  }]
  revisionInput.quotation.header.revisionNumber = 4
  revisionInput.quotation.header.projectName = 'Changed scope'
  revisionInput.quotation.majorItems[0].children[0].unitCost += 25
  revisionInput.quotation.goodsReceiptHistory = [{
    id: 'current-receipt', exportedAt: now.toISOString(), filePath: 'current-receipt.pdf',
    draft: { ...structuredClone(revisionInput.quotation.pendingGoodsReceiptDraft), grNumber: 'GR-COMPLETED' },
  }]
  revisionInput.quotation.pendingGoodsReceiptDraft.grNumber = 'GR-PENDING-CURRENT'

  let revisionCases = 0
  function readDocument(name, envelope) {
    assert.deepEqual(validateQuotationEnvelope(envelope).errors, [], `${name}: offline validation`)
    const document = parseQuotationDocumentContent(JSON.stringify(envelope))
    assert.deepEqual(document.revisions, envelope.revisions, `${name}: exact archived content on import`)
    return document
  }
  const beforeRebuild = structuredClone(revisionInput)
  readDocument('schema 3 archived blanks', revisionInput)
  const rebuilt = buildQuotationEnvelope(revisionInput, now).envelope
  assert.deepEqual(rebuilt.revisions, revisionInput.revisions, 'builder preserves archived blanks and receipt snapshots')
  assert.deepEqual(revisionInput, beforeRebuild, 'builder does not mutate input history')
  readDocument('rebuilt schema 3 history', rebuilt)
  revisionCases += 1

  function checkRevisionProposal(name, input, result, options, timestamp) {
    const expected = proposeQuotationRevision({
      quotation: structuredClone(input.quotation), revisions: structuredClone(input.revisions),
    }, options, timestamp.toISOString())
    const latest = result.envelope.revisions.at(-1)
    assert.equal(typeof latest.id, 'string', `${name}: new archive ID`)
    assert.ok(latest.id.trim() && !input.revisions.some(({ id }) => id === latest.id), `${name}: unique archive ID`)
    // The independent helpers generate different UUIDs; compare every other value.
    expected.revisions.at(-1).id = latest.id
    assert.deepEqual({ quotation: result.envelope.quotation, revisions: result.envelope.revisions }, expected, `${name}: app proposal`)
    assert.equal(result.envelope.exportedAt, timestamp.toISOString(), `${name}: export timestamp`)
    readDocument(name, result.envelope)
    revisionCases += 1
    return result.envelope
  }

  const createAt = new Date('2026-10-12T08:00:00.000Z')
  const createOptions = { note: '  Customer update  ' }
  const created = checkRevisionProposal('create revision', revisionInput,
    createQuotationRevisionInEnvelope(revisionInput, createOptions, createAt), createOptions, createAt)
  assert.deepEqual(revisionInput, beforeRebuild, 'create does not mutate its source')
  assert.equal(created.quotation.header.revisionNumber, 5, 'create advances the working revision')
  assert.deepEqual(created.quotation.pendingGoodsReceiptDraft, revisionInput.quotation.pendingGoodsReceiptDraft, 'create keeps pending receipt')

  const restoreAt = new Date('2026-10-12T09:00:00.000Z')
  const beforeRestore = structuredClone(created)
  const restored = checkRevisionProposal('restore revision', created,
    restoreQuotationRevisionInEnvelope(created, 'archived-original', restoreAt), { restoreRevisionId: 'archived-original' }, restoreAt)
  assert.deepEqual(created, beforeRestore, 'restore does not mutate its source')
  assert.equal(restored.quotation.header.revisionNumber, 6, 'restore advances instead of reusing the archived number')
  assert.equal(restored.quotation.header.projectName, 'Original scope', 'restore uses archived quotation content')
  assert.deepEqual(restored.quotation.goodsReceiptHistory, created.quotation.goodsReceiptHistory, 'restore retains current completed receipts')
  assert.ok(!Object.hasOwn(restored.quotation, 'pendingGoodsReceiptDraft'), 'restore clears pending receipt')
  assert.deepEqual(restored.revisions.map(({ revisionNumber }) => revisionNumber), [1, 4, 5], 'restore archives the replaced working copy')

  const deleteAt = new Date('2026-10-12T10:00:00.000Z')
  const beforeDelete = structuredClone(restored)
  const deletedId = restored.revisions.at(-1).id
  const deleted = deleteQuotationRevisionFromEnvelope(restored, deletedId, deleteAt).envelope
  const expectedAfterDelete = structuredClone(restored)
  expectedAfterDelete.revisions = expectedAfterDelete.revisions.filter(({ id }) => id !== deletedId)
  expectedAfterDelete.exportedAt = deleteAt.toISOString()
  expectedAfterDelete.quotation.metadata.updatedAt = deleteAt.toISOString()
  assert.deepEqual(deleted, expectedAfterDelete, 'delete only removes the archive and updates save timestamps')
  assert.deepEqual(restored, beforeDelete, 'delete does not mutate its source')
  assert.equal(deleted.quotation.header.revisionNumber, 6, 'delete does not renumber the working copy')
  assert.deepEqual(deleted.revisions.map(({ revisionNumber }) => revisionNumber), [1, 4], 'delete keeps gaps in saved revision numbers')
  readDocument('delete latest archive', deleted)
  revisionCases += 1

  const nextAt = new Date('2026-10-12T11:00:00.000Z')
  const next = checkRevisionProposal('create after deletion', deleted,
    createQuotationRevisionInEnvelope(deleted, {}, nextAt), {}, nextAt)
  assert.equal(next.quotation.header.revisionNumber, 7, 'create after deletion remains monotonic')
  assert.deepEqual(next.revisions.map(({ revisionNumber }) => revisionNumber), [1, 4, 6], 'deleted revision numbers are not reused')

  for (const [name, change] of [
    ['missing history', (value) => { delete value.revisions }],
    ['duplicate archive number', (value) => { value.revisions.push({ ...structuredClone(value.revisions[0]), id: 'duplicate-number' }) }],
    ['wrong quotation family', (value) => { value.revisions[0].quotation.id = 'different-quotation' }],
  ]) {
    const invalid = structuredClone(revisionInput)
    change(invalid)
    assert.ok(validateQuotationEnvelope(invalid).errors.length > 0, `${name}: offline rejects invalid history`)
    assert.throws(() => parseQuotationDocumentContent(JSON.stringify(invalid)), /invalid_revisions/, `${name}: app rejects invalid history`)
  }

  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  console.log(JSON.stringify({ ok: true, quotationCases: checked, revisionCases, receiptLineParity: true, revisionHistoryParity: true, duplicateCurrencyRejected: true, repositoryCommit: commit }))
} finally {
  await server.close()
}
