import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { calculationCases, createCalculationInput } from './calculation-cases.mjs'

import {
  automationLimits,
  buildQuotationEnvelope,
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
