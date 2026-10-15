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
  decodeQuotationEnvelope,
  encodeQuotationEnvelope,
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

test('builds optional summary settings with fresh row IDs without changing the default output or summary shape', () => {
  const original = createEnvelope()
  assert.deepEqual(original.quotation.outputSettings, { itemDetailLevel: 3 })
  assert.equal(Object.hasOwn(summarizeQuotationEnvelope(original), 'summaryDisplay'), false)
  const settings = {
    subtotalLabel: ' Materials subtotal ', showInformationalTotals: false,
    informationalTotals: [{ label: ' Equipment ', source: 'items', sectionIds: ['inactive', 'inactive'], itemIds: ['missing', 'missing'], visible: false }],
  }
  const before = structuredClone(settings)
  const envelope = createEnvelope({ outputSettings: settings })
  const row = envelope.quotation.outputSettings.informationalTotals[0]
  assert.ok(row.id)
  assert.deepEqual(row, { id: row.id, label: ' Equipment ', source: 'items', sectionIds: ['inactive'], itemIds: ['missing'], visible: false })
  assert.equal(envelope.quotation.outputSettings.subtotalLabel, ' Materials subtotal ')
  assert.deepEqual(settings, before)
  assert.deepEqual(validateQuotationEnvelope(envelope).errors, [])
  const display = summarizeQuotationEnvelope(envelope).summaryDisplay
  assert.equal(display.subtotalLabel, 'Materials subtotal')
  assert.equal(Object.hasOwn(display, 'informationalTotalsNote'), false)
  assert.equal(display.showInformationalTotals, false)
  assert.equal(display.informationalTotals[0].isVisible, false)
  assert.equal(display.informationalTotals[0].amount, null)
  assert.deepEqual(display.informationalTotals[0].missingSectionIds, [])
  assert.deepEqual(display.informationalTotals[0].missingItemIds, ['missing'])
  const partialRow = createEnvelope({ outputSettings: { informationalTotals: [{}] } }).quotation.outputSettings.informationalTotals[0]
  assert.deepEqual(partialRow, { id: partialRow.id, label: '', sectionIds: [], visible: true })
})

test('preserves custom multiline and explicitly blank informational notes without changing pricing or absent-note defaults', () => {
  const original = createEnvelope()
  const baseline = summarizeQuotationEnvelope(original)
  assert.equal(Object.hasOwn(original.quotation.outputSettings, 'informationalTotalsNote'), false)
  for (const note of ['  Included in the subtotal.\n仅供参考。  ', '', '  \n\t  ']) {
    const envelope = createEnvelope({ outputSettings: { informationalTotalsNote: note } })
    const before = structuredClone(envelope)
    assert.equal(envelope.quotation.outputSettings.informationalTotalsNote, note)
    assert.deepEqual(validateQuotationEnvelope(envelope).errors, [])
    const { summaryDisplay, ...financialSummary } = summarizeQuotationEnvelope(envelope)
    assert.equal(summaryDisplay.informationalTotalsNote, note)
    assert.deepEqual(financialSummary, baseline)
    assert.deepEqual(envelope, before)
    assert.equal(buildQuotationEnvelope(envelope, now).envelope.quotation.outputSettings.informationalTotalsNote, note)
  }
})

test('rejects non-string informational notes in the builder and in working or saved quotation validation', () => {
  for (const note of [null, 42, false, [], {}]) {
    assert.throws(() => createEnvelope({ outputSettings: { informationalTotalsNote: note } }), /informationalTotalsNote must be a string/)
    const envelope = createEnvelope()
    envelope.quotation.outputSettings.informationalTotalsNote = note
    assert.ok(validateQuotationEnvelope(envelope).errors.some(error => error.includes('informationalTotalsNote must be a string')))
    const history = createQuotationRevisionInEnvelope(createEnvelope(), {}, now).envelope
    history.revisions[0].quotation.outputSettings.informationalTotalsNote = note
    assert.ok(validateQuotationEnvelope(history).errors.some(error => error.includes('informationalTotalsNote must be a string')))
    assert.throws(() => buildQuotationEnvelope(history, now), /informationalTotalsNote must be a string/)
  }
})

test('summarizes sections and item unions with canonical nested pricing without adding informational totals to tax or grand total', () => {
  const envelope = createEnvelope({
    majorItems: [
      { id: 'orphan', name: 'Outside sections', unitCost: 100 },
      { id: 'equipment', kind: 'section_header', title: 'Equipment' },
      { id: 'package', name: 'Package', quantity: 2, markupRate: 25, children: [
        { id: 'assembly', name: 'Assembly', quantity: 3, children: [
          { id: 'fx', name: 'Imported part', quantity: 2, unitCost: 10, costCurrency: 'EUR' },
          { id: 'manual', name: 'Manual part', quantity: 1, pricingMethod: 'manual_price', manualUnitPrice: 7 },
        ] },
      ] },
      { id: 'piping', kind: 'section_header', title: 'Piping' },
      { id: 'pipe', name: 'Pipe', quantity: 2, pricingMethod: 'manual_price', manualUnitPrice: 50 },
    ],
    exchangeRates: { USD: 1, EUR: 1.2 },
    totalsConfig: { globalMarkupRate: 10, extraCharges: [{ id: 'install', label: 'Installation', amount: 200 }] },
    outputSettings: {
      itemDetailLevel: 1, subtotalLabel: 'Materials subtotal', showInformationalTotals: true,
      informationalTotals: [
        { id: 'sections', label: '', sectionIds: ['equipment', 'piping', 'equipment'], visible: true },
        { id: 'leaves', label: '', sectionIds: ['inactive-deleted-section'], source: 'items', itemIds: ['fx', 'manual', 'fx'], visible: true },
        { id: 'parent', label: '', sectionIds: [], source: 'items', itemIds: ['fx', 'package', 'assembly', 'manual'], visible: true },
        { id: 'part', label: ' Imported price ', sectionIds: [], source: 'items', itemIds: ['fx'], visible: true },
      ],
    },
  })
  const before = structuredClone(envelope)
  const summary = summarizeQuotationEnvelope(envelope)
  assert.equal(summary.subtotalAfterMarkup, 432)
  assert.equal(summary.taxAmount, 0)
  assert.equal(summary.grandTotal, 632)
  assert.deepEqual(summary.summaryDisplay.informationalTotals.map((row) => [row.label, row.amount]), [
    ['Equipment + Piping', 322], ['Imported part + Manual part', 222], ['Package', 222], ['Imported price', 180],
  ])
  assert.equal(validateQuotationEnvelope(envelope).warnings.some((warning) => warning.startsWith('outputSettings')), false)
  assert.deepEqual(envelope, before)
})

test('reports only active visible missing sources as warnings and never presents partial informational amounts', () => {
  const envelope = createEnvelope({
    majorItems: [{ id: 'pump', name: 'Pump', quantity: 1, unitCost: 100 }],
    outputSettings: {
      showInformationalTotals: true, informationalTotals: [
        { id: 'items', label: '', sectionIds: ['inactive-section'], source: 'items', itemIds: ['pump', 'deleted', 'deleted'], visible: true },
        { id: 'hidden', label: '', sectionIds: ['hidden-section'], source: 'items', itemIds: ['hidden-item'], visible: false },
        { id: 'empty', label: '', sectionIds: [], source: 'items', itemIds: [], visible: true },
      ],
    },
  })
  const result = validateQuotationEnvelope(envelope)
  assert.deepEqual(result.errors, [])
  const displayWarnings = result.warnings.filter((warning) => warning.startsWith('outputSettings'))
  assert.equal(displayWarnings.length, 2)
  assert.match(displayWarnings[0], /itemIds.*deleted/)
  assert.match(displayWarnings[1], /itemIds.*no items/)
  assert.ok(displayWarnings.every((warning) => !/inactive-section|hidden-item|hidden-section/.test(warning)))
  const rows = summarizeQuotationEnvelope(envelope).summaryDisplay.informationalTotals
  assert.equal(rows[0].amount, null)
  assert.deepEqual(rows[0].missingItemIds, ['deleted'])
  assert.deepEqual(rows[0].missingSectionIds, [])
  assert.equal(rows[2].amount, null)
  envelope.quotation.outputSettings.showInformationalTotals = false
  assert.equal(validateQuotationEnvelope(envelope).warnings.some((warning) => warning.startsWith('outputSettings')), false)
  envelope.quotation.outputSettings.showInformationalTotals = true
  envelope.quotation.outputSettings.informationalTotals = [{ id: 'sections', label: '', sectionIds: ['deleted-section'], itemIds: ['inactive-item'], visible: true }]
  const sectionResult = validateQuotationEnvelope(envelope)
  assert.deepEqual(sectionResult.errors, [])
  assert.ok(sectionResult.warnings.some((warning) => /sectionIds.*deleted-section/.test(warning)))
  assert.ok(sectionResult.warnings.every((warning) => !warning.includes('inactive-item')))
})

test('retains deterministic nested fractional cent allocations independently of selected items', () => {
  for (const { majorItems, leafIds, amount, firstAmount } of [
    {
      majorItems: [{ id: 'root', name: 'Root', quantity: 1.25, children: [{ id: 'group', name: 'Group', quantity: 1.25, children: [
        { id: 'a', name: 'A', pricingMethod: 'manual_price', manualUnitPrice: 0.01 },
        { id: 'b', name: 'B', pricingMethod: 'manual_price', manualUnitPrice: 0.03 },
      ] }] }], leafIds: ['a', 'b'], amount: 0.06, firstAmount: 0.01,
    },
    {
      majorItems: [{ id: 'root', name: 'Root', quantity: 0.25, children: [
        { id: 'first', name: 'First', pricingMethod: 'manual_price', manualUnitPrice: 0.01 },
        { id: 'group', name: 'Group', quantity: 0.25, children: [
          { id: 'a', name: 'A', pricingMethod: 'manual_price', manualUnitPrice: 0.01 },
          { id: 'b', name: 'B', pricingMethod: 'manual_price', manualUnitPrice: 0.01 },
        ] },
      ] }], leafIds: ['first', 'a', 'b'], amount: 0.01, firstAmount: 0,
    },
  ]) {
    const envelope = createEnvelope({ majorItems, outputSettings: { showInformationalTotals: true, informationalTotals: [
      { id: 'all', label: '', source: 'items', sectionIds: [], itemIds: leafIds, visible: true },
      { id: 'one', label: '', source: 'items', sectionIds: [], itemIds: [leafIds[0]], visible: true },
    ] } })
    const summary = summarizeQuotationEnvelope(envelope)
    assert.equal(summary.subtotalAfterMarkup, amount)
    assert.deepEqual(summary.summaryDisplay.informationalTotals.map((row) => row.amount), [amount, firstAmount])
    envelope.quotation.outputSettings.informationalTotals[0].itemIds = ['root', ...leafIds]
    assert.equal(summarizeQuotationEnvelope(envelope).summaryDisplay.informationalTotals[0].amount, amount)
  }
})

test('strictly rejects malformed, duplicate, or unknown summary settings rather than silently repairing supplied data', () => {
  const mutations = [
    (value) => { value.subtotalLabel = 42 },
    (value) => { value.showInformationalTotals = 'true' },
    (value) => { value.informationalTotals = {} },
    (value) => { value.unknown = true },
    (value) => { value.informationalTotals[0].source = 'unknown' },
    (value) => { value.informationalTotals[0].itemIds = [null] },
    (value) => { value.informationalTotals[0].sectionIds = 'section' },
    (value) => { value.informationalTotals[0].visible = 'true' },
    (value) => { value.informationalTotals[0].label = 42 },
    (value) => { value.informationalTotals[0].amount = 100 },
    (value) => { value.informationalTotals.push(structuredClone(value.informationalTotals[0])) },
  ]
  for (const mutate of mutations) {
    const settings = { itemDetailLevel: 1, informationalTotals: [{ id: 'row', label: '', sectionIds: [], visible: false }] }
    mutate(settings)
    assert.throws(() => createEnvelope({ outputSettings: settings }), /outputSettings|informational total ID/)
    const envelope = createEnvelope()
    envelope.quotation.outputSettings = settings
    assert.ok(validateQuotationEnvelope(envelope).errors.length, mutate.toString())
  }
})

test('rebuilds working summary settings while preserving archived settings and missing references byte for byte', () => {
  const original = createEnvelope({ outputSettings: {
    itemDetailLevel: 1, subtotalLabel: ' Saved label ', showInformationalTotals: false,
    informationalTotalsNote: '  Saved reminder.\n保存的说明。  ',
    informationalTotals: [{ id: 'saved', label: ' Saved row ', source: 'items', sectionIds: ['inactive'], itemIds: ['deleted'], visible: true }],
  } })
  const current = createQuotationRevisionInEnvelope(original, {}, now).envelope
  current.quotation.outputSettings.subtotalLabel = 'Working label'
  current.quotation.outputSettings.informationalTotalsNote = ''
  current.quotation.outputSettings.informationalTotals.push({ id: 'new', label: '', sectionIds: [], visible: false })
  const before = structuredClone(current)
  const archived = JSON.stringify(current.revisions)
  const rebuilt = buildQuotationEnvelope(current, now).envelope
  assert.equal(JSON.stringify(rebuilt.revisions), archived)
  assert.equal(rebuilt.quotation.outputSettings.subtotalLabel, 'Working label')
  assert.equal(rebuilt.revisions[0].quotation.outputSettings.subtotalLabel, ' Saved label ')
  assert.equal(rebuilt.quotation.outputSettings.informationalTotalsNote, '')
  assert.equal(rebuilt.revisions[0].quotation.outputSettings.informationalTotalsNote, original.quotation.outputSettings.informationalTotalsNote)
  const restored = restoreQuotationRevisionInEnvelope(rebuilt, rebuilt.revisions[0].id, now).envelope
  assert.equal(restored.quotation.outputSettings.informationalTotalsNote, original.quotation.outputSettings.informationalTotalsNote)
  assert.equal(restored.revisions.at(-1).quotation.outputSettings.informationalTotalsNote, '')
  assert.deepEqual(current, before)
  const invalid = structuredClone(current)
  invalid.revisions[0].quotation.outputSettings.informationalTotals[0].source = 'invalid'
  assert.throws(() => buildQuotationEnvelope(invalid, now), /Cannot build quotation/)
  assert.deepEqual(JSON.stringify(current.revisions), archived)
})

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
  wrongMime.images[wrongMime.quotation.branding.logoImageId] = createPngDataUrl(64, 32, 'image/jpeg')
  assert.ok(validateQuotationEnvelope(wrongMime).errors.some(error => error.includes('MIME type')))

  const tooWide = structuredClone(valid)
  tooWide.images[tooWide.quotation.branding.logoImageId] = createPngDataUrl(automationLimits.logoDimensionPixels + 1, 32)
  assert.ok(validateQuotationEnvelope(tooWide).errors.some(error => error.includes('dimensions')))
})

test('shares exact logo strings across v3 history without changing snapshot values or input', () => {
  const firstLogo = createPngDataUrl(64, 32)
  const secondLogo = createPngDataUrl(32, 32)
  const source = decodeQuotationEnvelope(createEnvelope({ branding: { logoDataUrl: firstLogo, accentColor: '#047857' } }))
  source.quotation.header.revisionNumber = 4
  source.revisions = [1, 2, 3].map((number) => {
    const quotation = structuredClone(source.quotation)
    quotation.header.revisionNumber = number
    quotation.branding.logoDataUrl = number === 2 ? secondLogo : number === 3 ? '' : firstLogo
    return { id: `saved-${number}`, revisionNumber: number, createdAt: now.toISOString(), note: `  Snapshot ${number}\n原始版本  `, quotation }
  })
  const before = structuredClone(source)
  const built = buildQuotationEnvelope(source, now).envelope
  assert.equal(built.schemaVersion, 4)
  assert.deepEqual(built.images, { 'image-1': firstLogo, 'image-2': secondLogo })
  assert.deepEqual(built.revisions.map(({ quotation }) => quotation.branding.logoImageId), ['image-1', 'image-2', null])
  assert.ok(!JSON.stringify(built).includes('logoDataUrl'))
  assert.deepEqual(decodeQuotationEnvelope(built).revisions, before.revisions)
  assert.deepEqual(source, before)
  assert.deepEqual(encodeQuotationEnvelope(built), built)
  assert.deepEqual(summarizeQuotationEnvelope(built), summarizeQuotationEnvelope(source))
  const created = createQuotationRevisionInEnvelope(built, {}, now).envelope
  assert.deepEqual(decodeQuotationEnvelope(created).revisions.slice(0, 3), before.revisions)
  assert.deepEqual(decodeQuotationEnvelope(created).revisions[3].quotation, before.quotation)
  const restored = restoreQuotationRevisionInEnvelope(created, 'saved-2', now).envelope
  assert.equal(decodeQuotationEnvelope(restored).quotation.branding.logoDataUrl, secondLogo)
  assert.deepEqual(decodeQuotationEnvelope(restored).revisions.slice(0, 3), before.revisions)
  const deleted = deleteQuotationRevisionFromEnvelope(built, 'saved-2', now).envelope
  assert.deepEqual(deleted.images, { 'image-1': firstLogo })
  assert.deepEqual(decodeQuotationEnvelope(deleted).revisions, before.revisions.filter(({ id }) => id !== 'saved-2'))
  for (const changed of [
    setPendingGoodsReceiptDraftInEnvelope(built, {}, now).envelope,
    clearPendingGoodsReceiptDraftInEnvelope(built, now).envelope,
    addGoodsReceiptToEnvelope(built, { filePath: 'receipt.pdf' }, now).envelope,
  ]) {
    assert.equal(changed.schemaVersion, 4)
    assert.deepEqual(decodeQuotationEnvelope(changed).revisions, before.revisions)
    assert.deepEqual(validateQuotationEnvelope(changed).errors, [])
  }
})

test('rejects malformed shared images, missing references and inline/reference mixtures', () => {
  const valid = createEnvelope({ branding: { logoDataUrl: createPngDataUrl(64, 32), accentColor: '#047857' } })
  for (const mutate of [
    value => { delete value.images },
    value => { value.images = [] },
    value => { value.images['image-0'] = value.images['image-1'] },
    value => { value.images['image-2'] = '' },
    value => { value.images['image-2'] = 42 },
    value => { value.images['image-2'] = 'data:image/png;base64,invalid' },
    value => { value.quotation.branding.logoImageId = 'image-2' },
    value => { value.quotation.branding.logoImageId = '__proto__' },
    value => { value.quotation.branding.logoImageId = 1 },
    value => { delete value.quotation.branding.logoImageId },
    value => { value.quotation.branding.logoDataUrl = value.images['image-1'] },
  ]) {
    const invalid = structuredClone(valid)
    mutate(invalid)
    const before = JSON.stringify(invalid)
    assert.ok(validateQuotationEnvelope(invalid).errors.length > 0)
    assert.throws(() => buildQuotationEnvelope(invalid, now))
    assert.throws(() => createQuotationRevisionInEnvelope(invalid, {}, now))
    assert.equal(JSON.stringify(invalid), before)
  }
  const inherited = structuredClone(valid)
  inherited.images = Object.create({ 'image-1': valid.images['image-1'] })
  assert.throws(() => decodeQuotationEnvelope(inherited), /existing image/)
  const mixedLegacy = decodeQuotationEnvelope(valid)
  mixedLegacy.quotation.branding.logoImageId = 'image-1'
  assert.throws(() => buildQuotationEnvelope(mixedLegacy, now), /mix inline/)
  const unused = structuredClone(valid)
  unused.images['image-9'] = createPngDataUrl(1, 1)
  assert.deepEqual(validateQuotationEnvelope(unused).errors, [])
  assert.deepEqual(encodeQuotationEnvelope(unused).images, valid.images)
})

test('limits stored v4 bytes while allowing decoded repeated images to exceed the limit', () => {
  const logo = createPngDataUrl(64, 32)
  const imageBytes = Buffer.concat([Buffer.from(logo.split(',')[1], 'base64'), Buffer.alloc(1024 * 1024)])
  const largeLogo = `data:image/png;base64,${imageBytes.toString('base64')}`
  let envelope = createEnvelope({ branding: { logoDataUrl: largeLogo, accentColor: '#047857' } })
  for (let index = 0; index < 9; index++) envelope = createQuotationRevisionInEnvelope(envelope, {}, now).envelope
  assert.equal(Object.keys(envelope.images).length, 1)
  assert.ok(Buffer.byteLength(JSON.stringify(decodeQuotationEnvelope(envelope))) > automationLimits.quotationJsonBytes)
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) < automationLimits.quotationJsonBytes)
  assert.deepEqual(validateQuotationJsonContent(JSON.stringify(envelope)).errors, [])
  assert.deepEqual(validateQuotationEnvelope(buildQuotationEnvelope(envelope, now).envelope).errors, [])
  assert.deepEqual(validateQuotationEnvelope(setPendingGoodsReceiptDraftInEnvelope(envelope, {}, now).envelope).errors, [])
  const overLimit = structuredClone(envelope)
  overLimit.quotation.header.notes = 'x'.repeat(automationLimits.quotationJsonBytes)
  assert.ok(validateQuotationEnvelope(overLimit).errors.some(error => error.includes('Quotation JSON exceeds')))
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

test('build defaults to schema 4 and upgrades legacy files without inventing archives', () => {
  const original = createEnvelope()
  assert.equal(original.schemaVersion, 4)
  assert.deepEqual(original.revisions, [])
  for (const schemaVersion of [1, 2]) {
    const legacy = { ...decodeQuotationEnvelope(original), schemaVersion }
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
  assert.equal(envelope.schemaVersion, 4)
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

test('all receipt mutations and revision creation upgrade valid legacy schema 2 to schema 4', () => {
  const legacy = decodeQuotationEnvelope(createEnvelope())
  legacy.schemaVersion = 2
  delete legacy.revisions
  const before = structuredClone(legacy)
  for (const envelope of [
    setPendingGoodsReceiptDraftInEnvelope(legacy, {}, now).envelope,
    clearPendingGoodsReceiptDraftInEnvelope(legacy, now).envelope,
    addGoodsReceiptToEnvelope(legacy, { filePath: 'C:\\receipt.pdf' }, now).envelope,
    createQuotationRevisionInEnvelope(legacy, {}, now).envelope,
  ]) {
    assert.equal(envelope.schemaVersion, 4)
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
