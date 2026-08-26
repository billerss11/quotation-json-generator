import assert from 'node:assert/strict'
import test from 'node:test'

import {
  automationLimits,
  buildQuotationEnvelope,
  setPendingGoodsReceiptDraftInEnvelope,
  validateQuotationEnvelope,
  validateQuotationJsonContent,
} from './quotation-json.mjs'

const now = new Date('2026-08-26T08:00:00.000Z')

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
