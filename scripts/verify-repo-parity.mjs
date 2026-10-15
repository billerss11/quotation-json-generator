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
  decodeQuotationEnvelope,
  encodeQuotationEnvelope,
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
  const { parseQuotationDocumentContent, createQuotationFileContent } = await server.ssrLoadModule('/src/features/quotations/utils/quotationFile.ts')
  const { proposeQuotationRevision } = await server.ssrLoadModule('/src/features/quotations/utils/quotationRevisions.ts')
  const { calculateMajorItemSummary, calculateQuotationTotals } = await server.ssrLoadModule('/src/features/quotations/utils/quotationCalculations.ts')
  const { normalizeQuotationOutputSettings } = await server.ssrLoadModule('/src/features/quotations/utils/quotationOutputSettings.ts')
  const { getQuotationSections, getQuotationSummaryItems, getQuotationSubtotalLabel, resolveQuotationInformationalTotals } = await server.ssrLoadModule('/src/features/quotations/utils/quotationSummaryDisplay.ts')
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

  let summaryDisplayCases = 0
  const defaultSummaryEnvelope = buildQuotationEnvelope(createCalculationInput({ outputSettings: { itemDetailLevel: 1 } }), now).envelope
  check('default output settings retain summary shape', defaultSummaryEnvelope, 100)
  assert.deepEqual(Object.keys(summarizeQuotationEnvelope(defaultSummaryEnvelope)).sort(), [
    'quotationNumber', 'currency', 'baseSubtotal', 'markupAmount', 'subtotalAfterMarkup',
    'taxableSubtotal', 'taxAmount', 'extraChargesTotal', 'grandTotal', 'taxBuckets',
  ].sort(), 'default financial summary remains backwards compatible')
  summaryDisplayCases += 1

  function checkSummaryDisplay(name, input, expectedAmounts, expectedTotal) {
    const before = structuredClone(input)
    const envelope = buildQuotationEnvelope(input, now).envelope
    assert.deepEqual(envelope.quotation.outputSettings,
      normalizeQuotationOutputSettings(input.outputSettings), `${name}: builder normalization matches app`)
    const quotation = check(name, envelope, expectedTotal)
    assert.deepEqual(quotation.outputSettings, envelope.quotation.outputSettings, `${name}: settings survive app import`)
    const summaries = quotation.majorItems.filter((item) => item.kind !== 'section_header')
      .map((item) => calculateMajorItemSummary(item, quotation.totalsConfig, quotation.exchangeRates))
    const rows = resolveQuotationInformationalTotals(
      quotation.outputSettings,
      getQuotationSections(quotation.majorItems, summaries),
      getQuotationSummaryItems(quotation, summaries),
    )
    const { summaryDisplay, ...financialSummary } = summarizeQuotationEnvelope(envelope)
    assert.deepEqual(summaryDisplay, {
      subtotalLabel: getQuotationSubtotalLabel(quotation.outputSettings, '') || null,
      ...(quotation.outputSettings.informationalTotalsNote === undefined ? {} : { informationalTotalsNote: quotation.outputSettings.informationalTotalsNote }),
      showInformationalTotals: quotation.outputSettings.showInformationalTotals === true,
      informationalTotals: rows,
    }, `${name}: resolved display matches app`)
    assert.deepEqual(rows.map((row) => row.amount), expectedAmounts, `${name}: selected selling amounts`)
    const baseline = structuredClone(envelope)
    baseline.quotation.outputSettings = { itemDetailLevel: quotation.outputSettings.itemDetailLevel }
    assert.deepEqual(financialSummary, summarizeQuotationEnvelope(baseline), `${name}: display settings do not change prices`)
    assert.deepEqual(input, before, `${name}: source is unchanged`)
    summaryDisplayCases += 1
    return envelope
  }

  for (const note of ['  Already included in the subtotal.\n仅供参考。  ', '', '  \n\t  ']) {
    const input = createCalculationInput({ outputSettings: { itemDetailLevel: 2, informationalTotalsNote: note } })
    const envelope = checkSummaryDisplay(`informational note ${JSON.stringify(note)}`, input, [], 100)
    assert.equal(envelope.quotation.outputSettings.informationalTotalsNote, note, 'note whitespace and line breaks remain exact')
  }
  for (const note of [null, 42, false, [], {}]) {
    const invalid = structuredClone(defaultSummaryEnvelope)
    invalid.quotation.outputSettings.informationalTotalsNote = note
    assert.ok(validateQuotationEnvelope(invalid).errors.some(error => error.includes('informationalTotalsNote must be a string')), 'offline rejects non-string notes')
    assert.throws(() => buildQuotationEnvelope(invalid, now), /informationalTotalsNote must be a string/, 'builder rejects non-string notes')
    assert.throws(() => parseQuotationDocumentContent(JSON.stringify(invalid)), /invalid_quotation/, 'app rejects non-string notes')
    assert.deepEqual(normalizeQuotationOutputSettings(invalid.quotation.outputSettings), { itemDetailLevel: 1 }, 'app normalization drops invalid note types')
  }
  summaryDisplayCases += 1

  const sectionInput = createCalculationInput({
    totalsConfig: {
      globalMarkupRate: 25, taxClasses: [{ id: 'materials', label: 'Materials', rate: 10 }], defaultTaxClassId: 'materials',
      extraCharges: [{ id: 'installation', label: 'Installation', amount: 70 }],
    },
    majorItems: [{ id: 'pump', name: 'Pump', quantity: 2, unitCost: 100 }, { id: 'pipe', name: 'Pipe', quantity: 3, unitCost: 10 }],
    outputSettings: {
      itemDetailLevel: 2, subtotalLabel: '  材料销售金额  ', showInformationalTotals: true,
      informationalTotals: [
        { id: 'equipment-total', label: '  Equipment selling total  ', sectionIds: ['equipment', 'equipment'], visible: true },
        { id: 'piping-total', label: '', source: 'sections', sectionIds: ['piping'], itemIds: ['unused-item'], visible: true },
        { id: 'materials-total', label: 'All materials', sectionIds: ['equipment', 'piping'], visible: true },
        { id: 'hidden-total', label: 'Hidden source', sectionIds: ['removed-section'], visible: false },
      ],
    },
  })
  sectionInput.majorItems = [
    { id: 'equipment', kind: 'section_header', title: 'Equipment' }, sectionInput.majorItems[0],
    { id: 'piping', kind: 'section_header', title: 'Piping' }, sectionInput.majorItems[1],
  ]
  const sectionEnvelope = checkSummaryDisplay('section summary selections', sectionInput, [250, 37.5, 287.5, null], 386.25)
  assert.equal(sectionEnvelope.quotation.outputSettings.subtotalLabel, '  材料销售金额  ', 'custom label whitespace is preserved in JSON')

  const itemInput = structuredClone(sectionInput)
  itemInput.majorItems = itemInput.majorItems.filter((item) => item.kind !== 'section_header')
  itemInput.outputSettings = {
    itemDetailLevel: 1, subtotalLabel: '  Selected materials  ', showInformationalTotals: true,
    informationalTotals: [
      { id: 'pump-total', label: 'Selected equipment', source: 'items', sectionIds: ['unused-section'], itemIds: ['pump', 'pump'], visible: true },
      { id: 'pipe-total', label: '', source: 'items', sectionIds: [], itemIds: ['pipe'], visible: true },
      { id: 'all-total', label: 'Both items', source: 'items', sectionIds: [], itemIds: ['pump', 'pipe'], visible: true },
      { id: 'hidden-item-total', label: 'Hidden item', source: 'items', sectionIds: [], itemIds: ['removed-item'], visible: false },
    ],
  }
  checkSummaryDisplay('arbitrary items without section headers', itemInput, [250, 37.5, 287.5, null], 386.25)

  const disabledInput = structuredClone(itemInput)
  disabledInput.outputSettings.subtotalLabel = '   '
  disabledInput.outputSettings.showInformationalTotals = false
  checkSummaryDisplay('disabled display retains item selections', disabledInput, [250, 37.5, 287.5, null], 386.25)

  const missingInput = structuredClone(sectionInput)
  missingInput.outputSettings.informationalTotals = [
    { id: 'empty-section', label: '', sectionIds: [], visible: true },
    { id: 'missing-section', label: 'Removed section', sectionIds: ['removed-section'], visible: true },
    { id: 'empty-item', label: '', source: 'items', sectionIds: ['unused-section'], itemIds: [], visible: true },
    { id: 'missing-item', label: 'Removed item', source: 'items', sectionIds: [], itemIds: ['removed-item'], visible: true },
  ]
  checkSummaryDisplay('missing and empty display sources', missingInput, [null, null, null, null], 386.25)

  const nestedInput = createCalculationInput({
    totalsConfig: {
      globalMarkupRate: 20, taxClasses: [{ id: 'materials', label: 'Materials', rate: 10 }], defaultTaxClassId: 'materials',
      extraCharges: [{ id: 'installation', label: 'Installation', amount: 7 }],
    },
    exchangeRates: { USD: 1, EUR: 1.2 },
    majorItems: [{ id: 'outer', quantity: 0.5, children: [
      { id: 'assembly', quantity: 1.5, children: [
        { id: 'manual', quantity: 2, pricingMethod: 'manual_price', manualUnitPrice: 10, unitCost: 99, costCurrency: 'EUR' },
        { id: 'converted', quantity: 3, unitCost: 5, costCurrency: 'EUR' },
      ] },
      { id: 'sibling', quantity: 0.25, pricingMethod: 'manual_price', manualUnitPrice: 20, unitCost: 0 },
    ] }],
    outputSettings: {
      itemDetailLevel: 1, subtotalLabel: 'Nested material sales', showInformationalTotals: true,
      informationalTotals: [
        { id: 'manual-total', label: 'Manual selling price', source: 'items', sectionIds: [], itemIds: ['manual'], visible: true },
        { id: 'fx-total', label: 'Converted cost plus markup', source: 'items', sectionIds: [], itemIds: ['converted'], visible: true },
        { id: 'assembly-total', label: '', source: 'items', sectionIds: [], itemIds: ['assembly', 'manual'], visible: true },
        { id: 'outer-total', label: '', source: 'items', sectionIds: [], itemIds: ['outer', 'assembly', 'manual', 'converted'], visible: true },
        { id: 'leaves-total', label: 'All leaves', source: 'items', sectionIds: [], itemIds: ['manual', 'converted', 'sibling'], visible: true },
      ],
    },
  })
  checkSummaryDisplay('nested fractional quantities manual price and FX', nestedInput, [15, 16.2, 31.2, 33.7, 33.7], 44.07)

  const centInput = createCalculationInput({
    majorItems: [{ id: 'cent-outer', quantity: 0.5, children: [{ id: 'cent-inner', quantity: 0.5, children: [
      { id: 'cent-a', pricingMethod: 'manual_price', manualUnitPrice: 0.03, unitCost: 0 },
      { id: 'cent-b', pricingMethod: 'manual_price', manualUnitPrice: 0.03, unitCost: 0 },
    ] }] }],
    outputSettings: {
      itemDetailLevel: 3, showInformationalTotals: true,
      informationalTotals: [
        { id: 'cent-group', label: '', source: 'items', sectionIds: [], itemIds: ['cent-outer'], visible: true },
        { id: 'cent-overlap', label: '', source: 'items', sectionIds: [], itemIds: ['cent-inner', 'cent-a'], visible: true },
        { id: 'cent-leaves', label: '', source: 'items', sectionIds: [], itemIds: ['cent-a', 'cent-b'], visible: true },
      ],
    },
  })
  checkSummaryDisplay('nested assigned rounding cents', centInput, [0.02, 0.02, 0.02], 0.02)

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
  const persistedRevisionInput = buildQuotationEnvelope(fixture, now).envelope
  assert.equal(persistedRevisionInput.schemaVersion, 4, 'builder defaults to schema 4')
  const revisionInput = decodeQuotationEnvelope(persistedRevisionInput)
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
  archived.outputSettings = {
    itemDetailLevel: 2, subtotalLabel: '  Archived material sales  ', showInformationalTotals: false,
    informationalTotalsNote: '  Archived reminder.\n保存的说明。  ',
    informationalTotals: [
      { id: 'archived-sections', label: '  Archived sections  ', source: 'sections', sectionIds: ['archived-section', 'archived-section'], itemIds: ['saved-inactive-item'], visible: true },
      { id: 'archived-items', label: '  Archived item  ', source: 'items', sectionIds: ['saved-inactive-section'], itemIds: [archived.majorItems[1].id], visible: false },
    ],
  }
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
  revisionInput.quotation.outputSettings = {
    itemDetailLevel: 1, subtotalLabel: '  Current material sales  ', showInformationalTotals: true,
    informationalTotalsNote: '',
    informationalTotals: [{ id: 'current-items', label: 'Current scope', source: 'items', sectionIds: ['unused-section'], itemIds: [revisionInput.quotation.majorItems[0].id], visible: true }],
  }

  let revisionCases = 0
  function readDocument(name, envelope) {
    assert.deepEqual(validateQuotationEnvelope(envelope).errors, [], `${name}: offline validation`)
    const document = parseQuotationDocumentContent(JSON.stringify(envelope))
    assert.deepEqual(document.revisions, decodeQuotationEnvelope(envelope).revisions, `${name}: exact archived content on import`)
    return document
  }
  const beforeRebuild = structuredClone(revisionInput)
  readDocument('schema 3 archived blanks', revisionInput)
  const rebuilt = decodeQuotationEnvelope(buildQuotationEnvelope(revisionInput, now).envelope)
  assert.deepEqual(rebuilt.revisions, revisionInput.revisions, 'builder preserves archived blanks and receipt snapshots')
  assert.deepEqual(revisionInput, beforeRebuild, 'builder does not mutate input history')
  readDocument('rebuilt schema 3 history', rebuilt)
  revisionCases += 1

  function checkRevisionProposal(name, input, result, options, timestamp) {
    const expected = proposeQuotationRevision({
      quotation: structuredClone(input.quotation), revisions: structuredClone(input.revisions),
    }, options, timestamp.toISOString())
    assert.equal(result.envelope.schemaVersion, 4, `${name}: persisted schema 4`)
    result = { ...result, envelope: decodeQuotationEnvelope(result.envelope) }
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
  assert.deepEqual(created.revisions.at(-1).quotation.outputSettings, revisionInput.quotation.outputSettings, 'create archives current summary settings')

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
  assert.deepEqual(restored.quotation.outputSettings, archived.outputSettings, 'restore uses archived summary settings verbatim')

  const deleteAt = new Date('2026-10-12T10:00:00.000Z')
  const beforeDelete = structuredClone(restored)
  const deletedId = restored.revisions.at(-1).id
  const deleted = decodeQuotationEnvelope(deleteQuotationRevisionFromEnvelope(restored, deletedId, deleteAt).envelope)
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
  summaryDisplayCases += 1

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

  // Cross both implementations at the persisted/expanded boundary, with images
  // that differ between offers and with a genuinely empty archived logo.
  const imageDataUrl = (width) => {
    const bytes = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
    Buffer.from('IHDR').copy(bytes, 12)
    bytes.writeUInt32BE(width, 16)
    bytes.writeUInt32BE(32, 20)
    return `data:image/png;base64,${bytes.toString('base64')}`
  }
  const legacyImages = structuredClone(revisionInput)
  legacyImages.quotation.branding.logoDataUrl = imageDataUrl(64)
  legacyImages.revisions[0].quotation.branding.logoDataUrl = imageDataUrl(32)
  for (const number of [2, 3]) {
    const snapshot = structuredClone(legacyImages.revisions[0])
    snapshot.id = `image-snapshot-${number}`
    snapshot.revisionNumber = snapshot.quotation.header.revisionNumber = number
    snapshot.quotation.branding.logoDataUrl = number === 2 ? '' : legacyImages.quotation.branding.logoDataUrl
    legacyImages.revisions.push(snapshot)
  }
  const legacyBefore = structuredClone(legacyImages)
  const skillStored = buildQuotationEnvelope(legacyImages, now).envelope
  assert.equal(skillStored.schemaVersion, 4)
  assert.deepEqual(Object.keys(skillStored.images), ['image-1', 'image-2'])
  assert.deepEqual(decodeQuotationEnvelope(skillStored).revisions, legacyBefore.revisions, 'v3 snapshots survive image migration exactly')
  const appExpanded = parseQuotationDocumentContent(JSON.stringify(skillStored))
  assert.deepEqual(appExpanded.revisions, legacyBefore.revisions, 'app expands skill images without altering saved snapshots')
  const appStored = JSON.parse(createQuotationFileContent(appExpanded.quotation, appExpanded.revisions))
  assert.equal(appStored.schemaVersion, 4)
  assert.deepEqual(appStored.images, skillStored.images, 'app/skill exact shared-image table')
  assert.deepEqual(decodeQuotationEnvelope(appStored).revisions, legacyBefore.revisions, 'skill expands app images without altering saved snapshots')
  assert.deepEqual(encodeQuotationEnvelope(appStored), appStored, 'codec round trip is deterministic')
  assert.deepEqual(summarizeQuotationEnvelope(skillStored), summarizeQuotationEnvelope(legacyImages), 'images do not change totals or summary settings')
  assert.deepEqual(legacyImages, legacyBefore, 'cross-codec migration leaves source unchanged')
  for (const version of [1, 2]) {
    const legacy = { ...structuredClone(legacyImages), schemaVersion: version }
    delete legacy.revisions
    const upgraded = buildQuotationEnvelope(legacy, now).envelope
    assert.deepEqual(upgraded.revisions, [], `v${version} does not invent history`)
    assert.equal(parseQuotationDocumentContent(JSON.stringify(upgraded)).quotation.branding.logoDataUrl,
      legacy.quotation.branding.logoDataUrl, `v${version} image bytes preserved`)
  }
  for (const mutate of [
    value => { value.quotation.branding.logoImageId = 'image-99' },
    value => { value.revisions[0].quotation.branding.logoImageId = '__proto__' },
    value => { value.quotation.branding.logoDataUrl = value.images['image-1'] },
    value => { value.images['image-3'] = 'broken-data' },
  ]) {
    const invalid = structuredClone(skillStored)
    mutate(invalid)
    assert.ok(validateQuotationEnvelope(invalid).errors.length > 0, 'offline rejects malformed shared images')
    assert.throws(() => parseQuotationDocumentContent(JSON.stringify(invalid)), 'app rejects malformed shared images')
  }

  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  console.log(JSON.stringify({ ok: true, quotationCases: checked, revisionCases, summaryDisplayCases, sharedImageParity: true, legacyImageMigrationParity: true, receiptLineParity: true, revisionHistoryParity: true, summaryDisplayParity: true, duplicateCurrencyRejected: true, repositoryCommit: commit }))
} finally {
  await server.close()
}
