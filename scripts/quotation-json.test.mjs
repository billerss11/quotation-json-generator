import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { calculationCases, createCalculationInput } from './calculation-cases.mjs'

import {
  automationLimits,
  addGoodsReceiptToEnvelope,
  buildQuotationEnvelope,
  clearPendingGoodsReceiptDraftInEnvelope,
  createQuotationRevisionInEnvelope,
  deleteQuotationRevisionFromEnvelope,
  listQuotationRevisions,
  restoreQuotationRevisionInEnvelope,
  setPendingGoodsReceiptDraftInEnvelope,
  summarizeQuotationEnvelope,
  validateQuotationEnvelope,
  validateQuotationJsonContent,
} from './quotation-json.mjs'

const now = new Date('2026-08-26T08:00:00.000Z')

for (const { name, input, grandTotal } of calculationCases) {
  test(name, () => {
    const { envelope } = buildQuotationEnvelope(createCalculationInput(input), now)
    assert.deepEqual(validateQuotationEnvelope(envelope).errors, [])
    assert.equal(summarizeQuotationEnvelope(envelope).grandTotal, grandTotal)
  })
}

test('preserves explicit pricing method and inactive manual price when rebuilding', () => {
  const input = createCalculationInput({ majorItems: [{ pricingMethod: 'cost_plus', unitCost: 100, manualUnitPrice: 200 }] })
  const { envelope } = buildQuotationEnvelope(input, now)
  assert.equal(envelope.quotation.majorItems[0].pricingMethod, 'cost_plus')
  assert.equal(envelope.quotation.majorItems[0].manualUnitPrice, 200)
  assert.deepEqual(buildQuotationEnvelope(envelope, now).envelope, envelope)
})

test('rejects duplicate canonical currencies in partial input and complete files', () => {
  assert.throws(() => createEnvelope({ exchangeRates: { USD: 1, EUR: 1.08, eur: 0.9 } }), /Duplicate.*currency/i)
  const envelope = createEnvelope()
  envelope.quotation.exchangeRates = { USD: 1, EUR: 1.08, eur: 0.9 }
  assert.ok(validateQuotationEnvelope(envelope).errors.some((error) => /Duplicate.*currency/i.test(error)))
  assert.throws(() => summarizeQuotationEnvelope(envelope), /Duplicate.*currency/i)
})

test('summarizes accepted lowercase currencies without modifying the input', () => {
  const envelope = createEnvelope()
  envelope.quotation.header.currency = ' usd '
  envelope.quotation.majorItems[0].costCurrency = ' eur '
  envelope.quotation.exchangeRates = { usd: 1, EUR: 0.9 }
  const before = structuredClone(envelope)
  assert.deepEqual(validateQuotationEnvelope(envelope).errors, [])
  assert.equal(summarizeQuotationEnvelope(envelope).grandTotal, 90)
  assert.equal(summarizeQuotationEnvelope(envelope).currency, 'USD')
  assert.deepEqual(envelope, before)
})

test('summarizes unnormalized extra charges exactly as import would', () => {
  const envelope = createEnvelope()
  envelope.quotation.totalsConfig.extraCharges = [
    { id: 'a', label: 'A', amount: 0.005 }, { id: 'b', label: 'B', amount: 0.005 },
  ]
  const before = structuredClone(envelope)
  assert.equal(summarizeQuotationEnvelope(envelope).extraChargesTotal, 0.02)
  assert.equal(summarizeQuotationEnvelope(envelope).grandTotal, 100.02)
  assert.deepEqual(envelope, before)
})

test('does not replace an invalid supplied legacy tax rate with zero', () => {
  for (const taxRate of [-1, 101, '13%']) {
    assert.throws(() => createEnvelope({ totalsConfig: { globalMarkupRate: 0, taxRate } }), /taxRate/)
  }
})

test('bundles valid evaluation fixtures at portable skill-relative paths', async () => {
  const evaluations = JSON.parse(await readFile(new URL('../evals/evals.json', import.meta.url), 'utf8'))
  for (const evaluation of evaluations.evals) {
    for (const file of evaluation.files) {
      assert.ok(file.startsWith('evals/fixtures/'), 'Evaluation inputs must be bundled fixtures')
      const envelope = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'))
      assert.deepEqual(validateQuotationEnvelope(envelope).errors, [])
      assert.ok(envelope.quotation.pendingGoodsReceiptDraft.lines.some((line) => line.selected && line.quantity > 0))
    }
  }
})

function createEnvelope(input = {}) {
  return buildQuotationEnvelope({
    header: {
      quotationNumber: 'Q-TEST-001',
      quotationDate: '2026-08-26',
      currency: 'USD',
      documentLocale: 'en-US',
    },
    majorItems: [{ name: 'Pump', quantity: 1, quantityUnit: 'EA', unitCost: 100, costCurrency: 'USD' }],
    ...input,
  }, now).envelope
}

function createPngDataUrl(width, height, mimeType = 'image/png') {
  const bytes = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  Buffer.from('IHDR').copy(bytes, 12)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return `data:${mimeType};base64,${bytes.toString('base64')}`
}

test('preserves the spreadsheet quotation template', () => {
  const envelope = createEnvelope({ templateId: 'spreadsheet' })
  assert.equal(envelope.quotation.templateId, 'spreadsheet')
  assert.deepEqual(validateQuotationEnvelope(envelope).errors, [])
})

test('rejects unknown final-schema fields', () => {
  const envelope = createEnvelope()
  envelope.quotation.header.legacyCustomerName = 'Old field'
  assert.ok(validateQuotationEnvelope(envelope).errors.some(error => error.includes('legacyCustomerName')))
})

test('validates logo bytes, MIME type, and dimensions', () => {
  const valid = createEnvelope({ branding: { logoDataUrl: createPngDataUrl(64, 32), accentColor: '#047857' } })
  assert.deepEqual(validateQuotationEnvelope(valid).errors, [])

  const wrongMime = structuredClone(valid)
  wrongMime.quotation.branding.logoDataUrl = createPngDataUrl(64, 32, 'image/jpeg')
  assert.ok(validateQuotationEnvelope(wrongMime).errors.some(error => error.includes('MIME type')))

  const tooWide = structuredClone(valid)
  tooWide.quotation.branding.logoDataUrl = createPngDataUrl(automationLimits.logoDimensionPixels + 1, 32)
  assert.ok(validateQuotationEnvelope(tooWide).errors.some(error => error.includes('dimensions')))
})

test('enforces quotation and pending goods-receipt byte limits', () => {
  const oversizedJson = createEnvelope()
  oversizedJson.quotation.header.notes = 'x'.repeat(automationLimits.quotationJsonBytes)
  assert.ok(validateQuotationJsonContent(JSON.stringify(oversizedJson)).errors.some(error => error.includes('Quotation JSON exceeds')))

  const quotation = createEnvelope()
  const withReceipt = setPendingGoodsReceiptDraftInEnvelope(quotation, {
    documentDate: '2026-08-26',
    selectionPreset: 'detailed',
  }, now).envelope
  withReceipt.quotation.pendingGoodsReceiptDraft.remarks = 'x'.repeat(automationLimits.goodsReceiptDraftBytes)
  assert.ok(validateQuotationEnvelope(withReceipt).errors.some(error => error.includes('pendingGoodsReceiptDraft exceeds')))
})

test('summarizes hierarchy, manual pricing, mixed tax, and extra charges', () => {
  const envelope = createEnvelope({
    totalsConfig: {
      globalMarkupRate: 10,
      extraCharges: [{ id: 'freight', label: 'Freight', amount: 5 }],
      taxMode: 'mixed',
      taxClasses: [
        { id: 'tax-10', label: 'Tax 10%', rate: 10 },
        { id: 'tax-0', label: 'Zero rated', rate: 0 },
      ],
      defaultTaxClassId: 'tax-10',
    },
    majorItems: [{
      name: 'Package', quantity: 1, quantityUnit: 'SET', children: [
        { name: 'Pump', quantity: 2, quantityUnit: 'EA', unitCost: 100, costCurrency: 'USD', taxClassId: 'tax-10' },
        {
          name: 'Commissioning', quantity: 1, quantityUnit: 'JOB', pricingMethod: 'manual_price',
          manualUnitPrice: 50, unitCost: 0, costCurrency: 'USD', taxClassId: 'tax-0',
        },
      ],
    }],
  })

  assert.deepEqual(summarizeQuotationEnvelope(envelope), {
    quotationNumber: 'Q-TEST-001',
    currency: 'USD',
    baseSubtotal: 200,
    markupAmount: 20,
    subtotalAfterMarkup: 270,
    taxableSubtotal: 270,
    taxAmount: 22,
    extraChargesTotal: 5,
    grandTotal: 297,
    taxBuckets: [
      { taxClassId: 'tax-10', label: 'Tax 10%', rate: 10, taxableSubtotal: 220, taxAmount: 22 },
      { taxClassId: 'tax-0', label: 'Zero rated', rate: 0, taxableSubtotal: 50, taxAmount: 0 },
    ],
  })
})

test('clears a pending goods-receipt draft without changing history', () => {
  const envelope = setPendingGoodsReceiptDraftInEnvelope(createEnvelope(), {
    documentDate: '2026-08-26',
    selectionPreset: 'detailed',
  }, now).envelope
  envelope.quotation.goodsReceiptHistory = []

  const cleared = clearPendingGoodsReceiptDraftInEnvelope(envelope, new Date('2026-08-26T09:00:00.000Z')).envelope
  assert.equal(cleared.quotation.pendingGoodsReceiptDraft, undefined)
  assert.deepEqual(cleared.quotation.goodsReceiptHistory, [])
  assert.equal(cleared.quotation.metadata.updatedAt, '2026-08-26T09:00:00.000Z')
})

test('receipt selection defaults are disclosed only for lines without explicit selection', () => {
  const quotation = createEnvelope({ majorItems: [
    { name: 'Pump', quantity: 1, unitCost: 100 },
    { name: 'Seal', quantity: 2, unitCost: 10 },
  ] })
  const initial = setPendingGoodsReceiptDraftInEnvelope(quotation, {}, now)
  assert.ok(initial.warnings.some((warning) => warning.includes('line selection was missing')))
  const draft = initial.envelope.quotation.pendingGoodsReceiptDraft
  draft.lines[1].selected = false
  const completed = addGoodsReceiptToEnvelope(quotation, { draft, filePath: 'C:\\receipt.pdf' }, now)
  assert.deepEqual(completed.envelope.quotation.goodsReceiptHistory[0].draft, draft)
  assert.ok(!completed.warnings.some((warning) => warning.includes('line selection was missing')))
  const firstSelection = { sourceItemNumber: '1', selected: true }
  const partial = setPendingGoodsReceiptDraftInEnvelope(quotation, { lines: [
    firstSelection, firstSelection, { sourceItemNumber: 'missing', selected: false },
  ] }, now)
  assert.ok(partial.warnings.some((warning) => warning.includes('selection for unspecified lines')))
  assert.equal(partial.envelope.quotation.pendingGoodsReceiptDraft.lines[1].selected, true)
})

test('build defaults to schema 3 and upgrades legacy files without inventing archives', () => {
  const original = createEnvelope()
  assert.equal(original.schemaVersion, 3)
  assert.deepEqual(original.revisions, [])
  for (const schemaVersion of [1, 2]) {
    const legacy = { ...structuredClone(original), schemaVersion }
    delete legacy.revisions
    if (schemaVersion === 2) assert.deepEqual(validateQuotationEnvelope(legacy).errors, [])
    const before = structuredClone(legacy)
    const built = buildQuotationEnvelope(legacy, now).envelope
    assert.deepEqual(built, original)
    assert.deepEqual(legacy, before)
  }
})

test('create freezes the working quotation, advances once, and returns detached data', () => {
  const original = createEnvelope()
  original.quotation.id = '  stable-family  '
  const before = structuredClone(original)
  const later = new Date('2026-08-26T09:00:00.000Z')
  const { envelope } = createQuotationRevisionInEnvelope(original, { note: '  Sent to customer  ' }, later)
  assert.equal(envelope.schemaVersion, 3)
  assert.equal(envelope.quotation.id, before.quotation.id)
  assert.equal(envelope.quotation.header.revisionNumber, 2)
  assert.equal(envelope.quotation.metadata.createdAt, before.quotation.metadata.createdAt)
  assert.equal(envelope.quotation.metadata.updatedAt, later.toISOString())
  assert.equal(envelope.exportedAt, later.toISOString())
  assert.equal(envelope.revisions[0].createdAt, later.toISOString())
  assert.equal(envelope.revisions[0].revisionNumber, 1)
  assert.equal(envelope.revisions[0].note, 'Sent to customer')
  assert.ok(envelope.revisions[0].id)
  assert.deepEqual(envelope.revisions[0].quotation, before.quotation)
  assert.deepEqual(original, before)
  envelope.quotation.majorItems[0].name = 'Edited working copy'
  assert.equal(envelope.revisions[0].quotation.majorItems[0].name, 'Pump')
  envelope.revisions[0].quotation.header.notes = 'Changed detached result'
  assert.deepEqual(original, before)
})

test('build preserves archived values exactly while normalizing only the working copy', () => {
  const original = createQuotationRevisionInEnvelope(createEnvelope(), {}, now).envelope
  const snapshot = original.revisions[0].quotation
  snapshot.majorItems[0].name = ''
  snapshot.majorItems[0].quantityUnit = ''
  snapshot.majorItems[0].manualUnitPrice = 123.4567
  snapshot.majorItems.push({ id: 'blank-section', kind: 'section_header', title: '' })
  snapshot.header.currency = ' usd '
  snapshot.majorItems[0].costCurrency = ' usd '
  snapshot.exchangeRates = { usd: 1 }
  original.quotation.id = snapshot.id = ' family-with-spaces '
  original.quotation.majorItems[0].name = ''
  original.quotation.header.notes = 'Working edit'
  const before = structuredClone(original)
  const archivedJson = JSON.stringify(original.revisions)
  const { envelope } = buildQuotationEnvelope(original, now)
  assert.equal(JSON.stringify(envelope.revisions), archivedJson)
  assert.equal(envelope.quotation.majorItems[0].name, 'Unnamed item')
  assert.equal(envelope.quotation.header.notes, 'Working edit')
  assert.equal(envelope.quotation.header.revisionNumber, 2)
  assert.equal(envelope.quotation.id, before.quotation.id)
  assert.deepEqual(original, before)
  assert.deepEqual(validateQuotationJsonContent(JSON.stringify(envelope)).errors, [])
  envelope.revisions[0].quotation.header.notes = 'Detached archive edit'
  assert.deepEqual(original, before)
})

test('receipt edits preserve archives and restore keeps completed family receipts but clears pending', () => {
  const pending = setPendingGoodsReceiptDraftInEnvelope(createEnvelope(), { selectionPreset: 'detailed' }, now).envelope
  const revision = createQuotationRevisionInEnvelope(pending, {}, now).envelope
  const archivedJson = JSON.stringify(revision.revisions)
  assert.deepEqual(revision.quotation.pendingGoodsReceiptDraft, pending.quotation.pendingGoodsReceiptDraft)
  const completed = addGoodsReceiptToEnvelope(revision, {
    filePath: 'C:\\Receipts\\completed.pdf', selectionPreset: 'detailed',
  }, now).envelope
  assert.equal(JSON.stringify(completed.revisions), archivedJson)
  assert.equal(completed.quotation.pendingGoodsReceiptDraft, undefined)
  const current = setPendingGoodsReceiptDraftInEnvelope(completed, { remarks: 'Next delivery' }, now).envelope
  current.quotation.majorItems[0].name = 'Updated pump'
  const before = structuredClone(current)
  const restored = restoreQuotationRevisionInEnvelope(current, current.revisions[0].id, now).envelope
  assert.equal(restored.quotation.header.revisionNumber, 3)
  assert.equal(restored.quotation.id, pending.quotation.id)
  assert.equal(restored.quotation.majorItems[0].name, 'Pump')
  assert.equal(restored.quotation.pendingGoodsReceiptDraft, undefined)
  assert.deepEqual(restored.quotation.goodsReceiptHistory, completed.quotation.goodsReceiptHistory)
  assert.equal(JSON.stringify(restored.revisions[0]), JSON.stringify(current.revisions[0]))
  assert.deepEqual(restored.revisions[1].quotation, before.quotation)
  assert.deepEqual(current, before)
  const cleared = clearPendingGoodsReceiptDraftInEnvelope(current, now).envelope
  assert.equal(JSON.stringify(cleared.revisions), archivedJson)
  assert.deepEqual(cleared.quotation.goodsReceiptHistory, completed.quotation.goodsReceiptHistory)
  restored.quotation.goodsReceiptHistory[0].draft.remarks = 'Detached receipt edit'
  assert.deepEqual(current, before)
})

test('build fills a new working row in schema 3 without changing saved history or family identity', () => {
  const input = createQuotationRevisionInEnvelope(createEnvelope(), {}, now).envelope
  input.quotation.majorItems.push({ name: 'New seal', quantity: 2, unitCost: 50 })
  const before = structuredClone(input)
  const archivedJson = JSON.stringify(input.revisions)
  const { envelope, warnings } = buildQuotationEnvelope(input, now)
  const row = envelope.quotation.majorItems[1]
  assert.equal(row.name, 'New seal')
  assert.equal(row.quantity, 2)
  assert.equal(row.unitCost, 50)
  assert.ok(row.id)
  assert.notEqual(row.id, envelope.quotation.majorItems[0].id)
  assert.equal(row.quantityUnit, 'EA')
  assert.equal(row.costCurrency, 'USD')
  assert.equal(row.pricingMethod, 'cost_plus')
  assert.ok(warnings.some((warning) => warning.includes('cost currency was missing')))
  assert.equal(summarizeQuotationEnvelope(envelope).grandTotal, 200)
  assert.deepEqual(validateQuotationEnvelope(envelope).errors, [])
  assert.equal(envelope.quotation.id, before.quotation.id)
  assert.equal(envelope.quotation.header.revisionNumber, before.quotation.header.revisionNumber)
  assert.equal(JSON.stringify(envelope.revisions), archivedJson)
  assert.deepEqual(input, before)
  for (const mutate of [
    (value) => { delete value.quotation.id },
    (value) => { delete value.quotation.header.revisionNumber },
    (value) => { value.quotation.header.revisionNumber = 0 },
    (value) => { value.revisions[0].quotation.majorItems[0].id = '' },
    (value) => { value.revisions[0].quotation.id = 'other-family' },
  ]) {
    const invalid = structuredClone(input)
    mutate(invalid)
    assert.throws(() => buildQuotationEnvelope(invalid, now), /Cannot build quotation/)
  }
})

test('all receipt mutations and revision creation upgrade valid legacy schema 2 to schema 3', () => {
  const legacy = createEnvelope()
  legacy.schemaVersion = 2
  delete legacy.revisions
  const before = structuredClone(legacy)
  for (const envelope of [
    setPendingGoodsReceiptDraftInEnvelope(legacy, {}, now).envelope,
    clearPendingGoodsReceiptDraftInEnvelope(legacy, now).envelope,
    addGoodsReceiptToEnvelope(legacy, { filePath: 'C:\\receipt.pdf' }, now).envelope,
    createQuotationRevisionInEnvelope(legacy, {}, now).envelope,
  ]) {
    assert.equal(envelope.schemaVersion, 3)
    assert.ok(Array.isArray(envelope.revisions))
    assert.equal(envelope.quotation.id, legacy.quotation.id)
    assert.deepEqual(validateQuotationEnvelope(envelope).errors, [])
  }
  assert.deepEqual(listQuotationRevisions(legacy), [])
  assert.deepEqual(legacy, before)
})

test('delete preserves gaps and active edits; deleting the last archive never resets numbering', () => {
  const first = createQuotationRevisionInEnvelope(createEnvelope(), {}, now).envelope
  const second = createQuotationRevisionInEnvelope(first, {}, now).envelope
  second.quotation.header.notes = 'Unsaved current edits'
  const before = structuredClone(second)
  const later = new Date('2026-08-26T09:00:00.000Z')
  const deleted = deleteQuotationRevisionFromEnvelope(second, second.revisions[0].id, later).envelope
  assert.deepEqual(deleted.revisions, [second.revisions[1]])
  assert.deepEqual(deleted.quotation, {
    ...before.quotation, metadata: { ...before.quotation.metadata, updatedAt: later.toISOString() },
  })
  assert.equal(deleted.exportedAt, later.toISOString())
  const empty = deleteQuotationRevisionFromEnvelope(deleted, deleted.revisions[0].id, later).envelope
  assert.deepEqual(empty.revisions, [])
  assert.equal(empty.quotation.header.revisionNumber, 3)
  const next = createQuotationRevisionInEnvelope(empty, {}, later).envelope
  assert.equal(next.quotation.header.revisionNumber, 4)
  assert.deepEqual(next.revisions.map((entry) => entry.revisionNumber), [3])
  assert.deepEqual(second, before)
})

test('rejects malformed revision metadata and archived content without normalization or data loss', () => {
  const first = createQuotationRevisionInEnvelope(createEnvelope(), {}, now).envelope
  const valid = createQuotationRevisionInEnvelope(first, {}, now).envelope
  const mutations = [
    (value) => { delete value.revisions },
    (value) => { value.revisions = null },
    (value) => { value.revisions[0] = null },
    (value) => { value.revisions[0].id = '' },
    (value) => { value.revisions[0].id = value.revisions[1].id },
    (value) => { value.revisions[0].revisionNumber = value.revisions[1].revisionNumber },
    (value) => { value.revisions[0].revisionNumber = 0 },
    (value) => { value.revisions[0].revisionNumber = Number.MAX_SAFE_INTEGER + 1 },
    (value) => { value.revisions[0].createdAt = '2026-02-30T00:00:00.000Z' },
    (value) => { value.revisions[0].note = 42 },
    (value) => { value.revisions[0].quotation.id = 'different-family' },
    (value) => { value.revisions[0].quotation.header.revisionNumber = 2 },
    (value) => { value.revisions[0].quotation.revisions = [] },
    (value) => { value.revisions[0].revisions = [] },
    (value) => { value.quotation.revisions = [] },
    (value) => { value.quotation.header.revisionNumber = 2 },
    (value) => { value.quotation.header.revisionNumber = 2.5 },
    (value) => { value.quotation.header.revisionNumber = Number.MAX_SAFE_INTEGER + 1 },
    (value) => { value.revisions[0].quotation.majorItems[0].unitCost = -1 },
    (value) => { value.revisions[0].quotation.majorItems[0].costCurrency = 'EUR' },
    (value) => { value.revisions[0].quotation.majorItems.push(structuredClone(value.revisions[0].quotation.majorItems[0])) },
    (value) => { value.revisions[0].quotation.goodsReceiptHistory = [{ id: 'broken-record' }] },
  ]
  for (const mutate of mutations) {
    const invalid = structuredClone(valid)
    mutate(invalid)
    const before = structuredClone(invalid)
    assert.ok(validateQuotationEnvelope(invalid).errors.length, mutate.toString())
    assert.throws(() => buildQuotationEnvelope(invalid, now), /Cannot build quotation/)
    assert.throws(() => listQuotationRevisions(invalid), /invalid quotation/)
    assert.throws(() => createQuotationRevisionInEnvelope(invalid, {}, now), /invalid quotation/)
    assert.throws(() => restoreQuotationRevisionInEnvelope(invalid, valid.revisions[0].id, now), /invalid quotation/)
    assert.throws(() => deleteQuotationRevisionFromEnvelope(invalid, valid.revisions[0].id, now), /invalid quotation/)
    assert.throws(() => clearPendingGoodsReceiptDraftInEnvelope(invalid, now), /invalid quotation/)
    assert.deepEqual(invalid, before)
  }
  const nestedLegacy = { ...valid, schemaVersion: 2 }
  assert.ok(validateQuotationEnvelope(nestedLegacy).errors.length)
  assert.throws(() => buildQuotationEnvelope(nestedLegacy, now), /history requires/)
})

test('revision IDs, options, overflow, and timestamps fail without changing the input', () => {
  const valid = createQuotationRevisionInEnvelope(createEnvelope(), {}, now).envelope
  const before = structuredClone(valid)
  for (const id of ['', null, 'missing-id', valid.quotation.id]) {
    assert.throws(() => restoreQuotationRevisionInEnvelope(valid, id, now), /revision ID|Revision not found/)
    assert.throws(() => deleteQuotationRevisionFromEnvelope(valid, id, now), /revision ID|Revision not found/)
  }
  for (const options of [null, { note: 4 }, { revisionNumber: 10 }]) {
    assert.throws(() => createQuotationRevisionInEnvelope(valid, options, now), /options/)
  }
  assert.throws(() => createQuotationRevisionInEnvelope(valid, {}, new Date('bad')), /Invalid time value/)
  assert.deepEqual(valid, before)
  valid.quotation.header.revisionNumber = Number.MAX_SAFE_INTEGER
  assert.deepEqual(validateQuotationEnvelope(valid).errors, [])
  assert.throws(() => createQuotationRevisionInEnvelope(valid, {}, now), /overflow/)
  assert.throws(() => restoreQuotationRevisionInEnvelope(valid, valid.revisions[0].id, now), /overflow/)
  assert.equal(deleteQuotationRevisionFromEnvelope(valid, valid.revisions[0].id, now).envelope.quotation.header.revisionNumber, Number.MAX_SAFE_INTEGER)
})

test('the 10 MiB document limit includes archives and is checked after creating a snapshot', () => {
  const valid = createQuotationRevisionInEnvelope(createEnvelope(), {}, now).envelope
  valid.quotation.header.notes = 'a'.repeat(6 * 1024 * 1024)
  assert.deepEqual(validateQuotationEnvelope(valid).errors, [])
  const before = structuredClone(valid)
  assert.throws(() => createQuotationRevisionInEnvelope(valid, {}, now), /Quotation JSON exceeds/)
  assert.deepEqual(valid, before)
  valid.revisions[0].quotation.header.notes = 'b'.repeat(5 * 1024 * 1024)
  assert.ok(validateQuotationEnvelope(valid).errors.some((error) => error.includes('Quotation JSON exceeds')))
  assert.throws(() => buildQuotationEnvelope(valid, now), /Quotation JSON exceeds/)
  assert.throws(() => deleteQuotationRevisionFromEnvelope(valid, valid.revisions[0].id, now), /Quotation JSON exceeds/)
})

test('revision CLI round-trips history, returns summaries, and does not write on invalid requests', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'quotation-revisions-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const inputPath = join(directory, 'input.json')
  const createdPath = join(directory, 'created.json')
  const restoredPath = join(directory, 'restored.json')
  const deletedPath = join(directory, 'deleted.json')
  const protectedPath = join(directory, 'existing-output.json')
  const script = fileURLToPath(new URL('./quotation-json.mjs', import.meta.url))
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [script, ...args, '--json'], { encoding: 'utf8' }))
  await writeFile(inputPath, JSON.stringify(createEnvelope()), 'utf8')
  assert.equal(run('create-revision', inputPath, createdPath, '--note', 'Issued for review').ok, true)
  const created = JSON.parse(await readFile(createdPath, 'utf8'))
  const listing = run('list-revisions', createdPath)
  assert.equal(listing.ok, true)
  assert.deepEqual(listing.revisions, [{
    id: created.revisions[0].id, revisionNumber: 1, createdAt: created.revisions[0].createdAt, note: 'Issued for review',
  }])
  assert.equal(run('restore-revision', createdPath, listing.revisions[0].id, restoredPath).ok, true)
  const restored = JSON.parse(await readFile(restoredPath, 'utf8'))
  assert.equal(restored.quotation.header.revisionNumber, 3)
  assert.deepEqual(restored.revisions[0], created.revisions[0])
  assert.equal(run('delete-revision', restoredPath, restored.revisions[0].id, deletedPath).ok, true)
  const deleted = JSON.parse(await readFile(deletedPath, 'utf8'))
  assert.deepEqual(deleted.revisions, [restored.revisions[1]])
  assert.equal(deleted.quotation.header.revisionNumber, 3)
  assert.equal(run('validate', deletedPath).ok, true)
  await writeFile(protectedPath, 'existing output remains untouched', 'utf8')
  for (const args of [
    ['restore-revision', createdPath, 'missing-id', protectedPath],
    ['delete-revision', createdPath, 'missing-id', protectedPath],
    ['create-revision', createdPath, protectedPath, '--note'],
    ['create-revision', createdPath, protectedPath, '--unknown'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args, '--json'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stderr).ok, false)
    assert.equal(await readFile(protectedPath, 'utf8'), 'existing output remains untouched')
  }
})
