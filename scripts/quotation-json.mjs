#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const templates = new Set(['legacy', 'technical-bid', 'executive-summary', 'luminous', 'signal', 'atelier'])
const locales = new Set(['en-US', 'zh-CN'])
const goodsReceiptTemplates = new Set(['standard', 'compact'])
const goodsReceiptSelectionPresets = new Set(['summary', 'grouped', 'detailed'])
const allowedMixedTaxColumns = new Set([
  'taxRate', 'unitPrice', 'unitTax', 'unitPriceWithTax', 'taxAmount', 'netAmount', 'grossAmount',
])
const defaultMixedTaxColumns = ['taxRate', 'unitPrice', 'unitPriceWithTax', 'netAmount', 'grossAmount']
const maxMarkupRate = 1000
const maxTaxRate = 100
const maxExchangeRate = 1_000_000
const supportedCurrencies = new Set(
  typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('currency')
    : ['CNY', 'EUR', 'GBP', 'JPY', 'USD'],
)

export function buildQuotationEnvelope(input, now = new Date()) {
  if (!isRecord(input)) throw new Error('Input must be a JSON object.')

  const warnings = []
  const source = isRecord(input.quotation) ? input.quotation : input
  const headerSource = isRecord(source.header) ? source.header : {}
  const locale = locales.has(headerSource.documentLocale) ? headerSource.documentLocale : 'en-US'
  const parsedCurrency = normalizeCurrency(headerSource.currency)
  const baseCurrency = parsedCurrency ?? 'USD'
  const timestamp = now.toISOString()

  if (!locales.has(headerSource.documentLocale)) warnings.push('Document locale was missing or invalid; used en-US.')
  if (!parsedCurrency) warnings.push('Base currency was missing or invalid; used USD.')

  const itemIds = new Set()
  const rawItems = Array.isArray(source.majorItems) ? source.majorItems : []
  if (rawItems.length === 0) warnings.push('No quotation items were supplied.')
  const majorItems = rawItems.map((item, index) =>
    buildRootRow(item, index, baseCurrency, itemIds, warnings),
  )

  const totalsSource = isRecord(source.totalsConfig) ? source.totalsConfig : {}
  const taxClasses = buildTaxClasses(totalsSource.taxClasses, warnings)
  const taxClassIds = new Set(taxClasses.map((taxClass) => taxClass.id))
  const requestedDefaultTaxClassId = text(totalsSource.defaultTaxClassId).trim()
  const defaultTaxClassId = taxClassIds.has(requestedDefaultTaxClassId)
    ? requestedDefaultTaxClassId
    : taxClasses[0].id

  const quotationNumber = text(headerSource.quotationNumber) || `DRAFT-${timestamp.slice(0, 10)}`
  if (!text(headerSource.quotationNumber)) warnings.push(`Quotation number was missing; used ${quotationNumber}.`)
  if (!finiteNumber(totalsSource.globalMarkupRate)) warnings.push('Global markup was missing or invalid; used 0%.')

  const quotation = {
    id: nonEmpty(source.id) ? source.id.trim() : randomUUID(),
    templateId: templates.has(source.templateId) ? source.templateId : 'legacy',
    companyProfileId: nonEmpty(source.companyProfileId) ? source.companyProfileId.trim() : null,
    companyProfileSnapshot: buildCompanyProfile(source.companyProfileSnapshot),
    header: {
      quotationNumber,
      revisionNumber: positiveInteger(headerSource.revisionNumber, 1),
      quotationDate: dateOnly(headerSource.quotationDate) ?? timestamp.slice(0, 10),
      customerCompany: text(headerSource.customerCompany),
      contactPerson: text(headerSource.contactPerson),
      contactDetails: text(headerSource.contactDetails),
      projectName: text(headerSource.projectName),
      validityPeriod: text(headerSource.validityPeriod) || (locale === 'zh-CN' ? '30天' : '30 days'),
      currency: baseCurrency,
      documentLocale: locale,
      notes: text(headerSource.notes),
      terms: text(headerSource.terms),
    },
    majorItems,
    lineItemEntryMode: source.lineItemEntryMode === 'quick' ? 'quick' : 'detailed',
    outputSettings: {
      itemDetailLevel: [1, 2, 3].includes(source.outputSettings?.itemDetailLevel)
        ? source.outputSettings.itemDetailLevel
        : 3,
    },
    totalsConfig: {
      globalMarkupRate: finiteNumber(totalsSource.globalMarkupRate) ? totalsSource.globalMarkupRate : 0,
      extraCharges: buildExtraCharges(totalsSource.extraCharges, warnings),
      taxMode: totalsSource.taxMode === 'mixed' ? 'mixed' : 'single',
      taxClasses,
      defaultTaxClassId,
      mixedTaxColumns: Array.isArray(totalsSource.mixedTaxColumns)
        ? [...new Set(totalsSource.mixedTaxColumns.filter((column) => allowedMixedTaxColumns.has(column)))]
        : [...defaultMixedTaxColumns],
    },
    exchangeRates: buildExchangeRates(source.exchangeRates, baseCurrency, warnings),
    branding: {
      logoDataUrl: text(source.branding?.logoDataUrl),
      accentColor: /^#[0-9a-f]{6}$/i.test(source.branding?.accentColor)
        ? source.branding.accentColor
        : '#047857',
    },
    metadata: {
      createdAt: canonicalIso(source.metadata?.createdAt) ?? timestamp,
      updatedAt: canonicalIso(source.metadata?.updatedAt) ?? timestamp,
    },
    goodsReceiptHistory: [],
  }
  if (source.pendingGoodsReceiptDraft !== undefined) {
    quotation.pendingGoodsReceiptDraft = structuredClone(source.pendingGoodsReceiptDraft)
  }
  if (source.goodsReceiptHistory !== undefined) {
    if (!Array.isArray(source.goodsReceiptHistory)) {
      throw new Error('goodsReceiptHistory must be an array when supplied.')
    }
    quotation.goodsReceiptHistory = structuredClone(source.goodsReceiptHistory)
  }

  const envelope = { schemaVersion: 2, app: 'quotation-software', exportedAt: timestamp, quotation }
  const result = validateQuotationEnvelope(envelope)
  if (result.errors.length > 0) throw new Error(`Cannot build quotation:\n- ${result.errors.join('\n- ')}`)
  return { envelope, warnings: [...new Set([...warnings, ...result.warnings])] }
}

export function validateQuotationEnvelope(value) {
  const errors = []
  const warnings = []
  if (!isRecord(value)) return { errors: ['Root value must be an object.'], warnings }
  if (value.schemaVersion !== 2) errors.push('schemaVersion must be 2.')
  if (value.app !== 'quotation-software') errors.push('app must be quotation-software.')
  if (!canonicalIso(value.exportedAt)) errors.push('exportedAt must be a canonical UTC ISO timestamp.')
  if (!isRecord(value.quotation)) return { errors: [...errors, 'quotation must be an object.'], warnings }

  const quotation = value.quotation
  if (!nonEmpty(quotation.id)) errors.push('quotation.id must be non-empty.')
  if (!templates.has(quotation.templateId)) errors.push('quotation.templateId is unsupported.')
  if (!(quotation.companyProfileId === null || nonEmpty(quotation.companyProfileId))) {
    errors.push('companyProfileId must be null or non-empty.')
  }
  validateCompanyProfile(quotation.companyProfileSnapshot, errors)
  validateHeader(quotation.header, errors)
  if (!['detailed', 'quick'].includes(quotation.lineItemEntryMode)) {
    errors.push('lineItemEntryMode must be detailed or quick.')
  }
  if (![1, 2, 3].includes(quotation.outputSettings?.itemDetailLevel)) {
    errors.push('outputSettings.itemDetailLevel must be 1, 2, or 3.')
  }

  const taxClassIds = validateTotals(quotation.totalsConfig, errors)
  const itemIds = new Set()
  const usedCurrencies = new Set()
  if (!Array.isArray(quotation.majorItems)) {
    errors.push('majorItems must be an array.')
  } else {
    if (quotation.majorItems.length === 0) warnings.push('Quotation contains no line items.')
    quotation.majorItems.forEach((row, index) =>
      validateRootRow(row, `majorItems[${index}]`, itemIds, usedCurrencies, taxClassIds, errors, warnings),
    )
  }

  validateExchangeRates(quotation.exchangeRates, quotation.header?.currency, usedCurrencies, errors)
  if (!isRecord(quotation.branding)
    || typeof quotation.branding.logoDataUrl !== 'string'
    || !/^#[0-9a-f]{6}$/i.test(quotation.branding.accentColor)) {
    errors.push('branding must contain a string logoDataUrl and six-digit hex accentColor.')
  }
  if (!isRecord(quotation.metadata)
    || !canonicalIso(quotation.metadata.createdAt)
    || !canonicalIso(quotation.metadata.updatedAt)) {
    errors.push('metadata must contain canonical createdAt and updatedAt ISO timestamps.')
  }
  if (quotation.pendingGoodsReceiptDraft !== undefined) {
    validateGoodsReceiptDraftAtPath(
      quotation.pendingGoodsReceiptDraft,
      'pendingGoodsReceiptDraft',
      quotation,
      errors,
      warnings,
    )
  }
  validateGoodsReceiptHistory(quotation.goodsReceiptHistory, quotation, errors, warnings)
  return { errors, warnings: [...new Set(warnings)] }
}

export function setPendingGoodsReceiptDraftInEnvelope(value, input, now = new Date()) {
  if (!isRecord(value)) throw new Error('Quotation file must be a JSON object.')
  if (!isRecord(input)) throw new Error('Goods-receipt input must be a JSON object.')

  const envelope = structuredClone(value)
  const existing = validateQuotationEnvelope(envelope)
  if (existing.errors.length > 0) {
    throw new Error(`Cannot set goods-receipt draft on an invalid quotation:\n- ${existing.errors.join('\n- ')}`)
  }

  const warnings = [...existing.warnings]
  const timestamp = now.toISOString()
  const draftSource = isRecord(input.draft) ? input.draft : input
  envelope.quotation.pendingGoodsReceiptDraft = buildGoodsReceiptDraft(
    envelope.quotation,
    draftSource,
    warnings,
    timestamp,
  )
  envelope.exportedAt = timestamp
  envelope.quotation.metadata.updatedAt = timestamp

  const result = validateQuotationEnvelope(envelope)
  if (result.errors.length > 0) {
    throw new Error(`Cannot set goods-receipt draft:\n- ${result.errors.join('\n- ')}`)
  }

  return { envelope, warnings: [...new Set([...warnings, ...result.warnings])] }
}

export function addGoodsReceiptToEnvelope(value, input, now = new Date()) {
  if (!isRecord(value)) throw new Error('Quotation file must be a JSON object.')
  if (!isRecord(input)) throw new Error('Goods-receipt input must be a JSON object.')

  const envelope = structuredClone(value)
  const existing = validateQuotationEnvelope(envelope)
  if (existing.errors.length > 0) {
    throw new Error(`Cannot add goods receipt to an invalid quotation:\n- ${existing.errors.join('\n- ')}`)
  }

  const warnings = [...existing.warnings]
  const timestamp = now.toISOString()
  const draftSource = isRecord(input.draft) ? input.draft : input
  const draft = buildGoodsReceiptDraft(envelope.quotation, draftSource, warnings, timestamp)
  const exportedAt = canonicalIso(input.exportedAt) ?? timestamp

  if (input.exportedAt !== undefined && !canonicalIso(input.exportedAt)) {
    warnings.push('Goods-receipt exportedAt was invalid; used the current timestamp.')
  }

  const filePath = text(input.filePath)
  if (!filePath.trim()) {
    warnings.push('Goods-receipt filePath is empty. The record will not point to an exported PDF.')
  }

  envelope.quotation.goodsReceiptHistory = [
    ...(envelope.quotation.goodsReceiptHistory ?? []),
    {
      id: nonEmpty(input.id) ? input.id.trim() : randomUUID(),
      exportedAt,
      filePath,
      draft,
    },
  ]
  delete envelope.quotation.pendingGoodsReceiptDraft
  envelope.exportedAt = timestamp
  envelope.quotation.metadata.updatedAt = timestamp

  const result = validateQuotationEnvelope(envelope)
  if (result.errors.length > 0) {
    throw new Error(`Cannot add goods receipt:\n- ${result.errors.join('\n- ')}`)
  }

  return { envelope, warnings: [...new Set([...warnings, ...result.warnings])] }
}

export function buildGoodsReceiptDraft(quotation, input, warnings = [], timestamp = new Date().toISOString()) {
  if (!isRecord(quotation)) throw new Error('Quotation must be a JSON object.')
  if (!isRecord(input)) throw new Error('Goods-receipt draft must be a JSON object.')

  const documentDate = dateOnly(input.documentDate) ?? timestamp.slice(0, 10)
  if (!dateOnly(input.documentDate)) {
    warnings.push(`Goods-receipt document date was missing or invalid; used ${documentDate}.`)
  }

  const templateId = goodsReceiptTemplates.has(input.templateId) ? input.templateId : 'standard'
  if (input.templateId !== undefined && !goodsReceiptTemplates.has(input.templateId)) {
    warnings.push('Goods-receipt template was invalid; used standard.')
  }

  const selectionPreset = goodsReceiptSelectionPresets.has(input.selectionPreset)
    ? input.selectionPreset
    : 'detailed'
  if (input.selectionPreset === undefined) {
    warnings.push('Goods-receipt line selection was missing; used detailed leaf lines at quoted quantities.')
  } else if (!goodsReceiptSelectionPresets.has(input.selectionPreset)) {
    warnings.push('Goods-receipt line selection was invalid; used detailed leaf lines at quoted quantities.')
  }

  const lines = createGoodsReceiptLineDrafts(quotation.majorItems)
  applyGoodsReceiptSelectionPreset(lines, selectionPreset)
  applyGoodsReceiptLineOverrides(lines, input.lines, warnings)

  const supplierContact = [quotation.companyProfileSnapshot?.email, quotation.companyProfileSnapshot?.phone]
    .map((value) => text(value).trim())
    .filter(Boolean)
    .join(' | ')

  return {
    quotationId: text(quotation.id),
    quotationNumber: text(quotation.header?.quotationNumber),
    quotationDate: text(quotation.header?.quotationDate),
    grNumber: text(input.grNumber) || createGoodsReceiptNumber(documentDate),
    documentDate,
    customerReference: text(input.customerReference ?? input.poNumber),
    deliveryReference: text(input.deliveryReference),
    receivingCompany: typeof input.receivingCompany === 'string'
      ? input.receivingCompany
      : text(quotation.header?.customerCompany),
    deliveryAddress: text(input.deliveryAddress),
    deliveryContact: typeof input.deliveryContact === 'string'
      ? input.deliveryContact
      : text(quotation.header?.contactPerson),
    contactDetails: typeof input.contactDetails === 'string'
      ? input.contactDetails
      : text(quotation.header?.contactDetails),
    supplierCompany: typeof input.supplierCompany === 'string'
      ? input.supplierCompany
      : text(quotation.companyProfileSnapshot?.companyName),
    supplierContact: typeof input.supplierContact === 'string' ? input.supplierContact : supplierContact,
    projectName: typeof input.projectName === 'string'
      ? input.projectName
      : text(quotation.header?.projectName),
    preparedBy: text(input.preparedBy),
    remarks: text(input.remarks ?? input.notes),
    templateId,
    lines,
  }
}

export function validateGoodsReceiptDraft(value, quotation) {
  const errors = []
  const warnings = []
  validateGoodsReceiptDraftAtPath(value, 'goodsReceiptDraft', quotation, errors, warnings)
  return { errors, warnings: [...new Set(warnings)] }
}

function validateGoodsReceiptHistory(value, quotation, errors, warnings) {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push('goodsReceiptHistory must be an array when supplied.')
    return
  }

  const recordIds = new Set()
  value.forEach((record, index) => {
    const path = `goodsReceiptHistory[${index}]`
    if (!isRecord(record)) {
      errors.push(`${path} must be an object.`)
      return
    }
    validateUniqueId(record.id, path, recordIds, errors)
    if (!canonicalIso(record.exportedAt)) errors.push(`${path}.exportedAt must be a canonical UTC ISO timestamp.`)
    if (typeof record.filePath !== 'string') errors.push(`${path}.filePath must be a string.`)
    else if (!record.filePath.trim()) warnings.push(`${path}.filePath is empty and does not point to an exported PDF.`)
    validateGoodsReceiptDraftAtPath(record.draft, `${path}.draft`, quotation, errors, warnings)
  })
}

function validateGoodsReceiptDraftAtPath(value, path, quotation, errors, warnings) {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`)
    return
  }

  for (const key of [
    'quotationId', 'quotationNumber', 'quotationDate', 'grNumber', 'documentDate',
    'customerReference', 'deliveryReference', 'receivingCompany', 'deliveryAddress',
    'deliveryContact', 'contactDetails', 'supplierCompany', 'supplierContact', 'projectName',
    'preparedBy', 'remarks',
  ]) {
    if (typeof value[key] !== 'string') errors.push(`${path}.${key} must be a string.`)
  }
  if (!dateOnly(value.quotationDate)) errors.push(`${path}.quotationDate must use YYYY-MM-DD.`)
  if (!dateOnly(value.documentDate)) errors.push(`${path}.documentDate must use YYYY-MM-DD.`)
  if (!goodsReceiptTemplates.has(value.templateId)) {
    errors.push(`${path}.templateId must be standard or compact.`)
  }
  if (isRecord(quotation)) {
    if (value.quotationId !== quotation.id) warnings.push(`${path}.quotationId does not match the current quotation.`)
    if (value.quotationNumber !== quotation.header?.quotationNumber) {
      warnings.push(`${path}.quotationNumber does not match the current quotation number.`)
    }
  }
  if (!Array.isArray(value.lines)) {
    errors.push(`${path}.lines must be an array.`)
    return
  }

  const lineIds = new Set()
  let exportableLineCount = 0
  for (const [index, line] of value.lines.entries()) {
    const linePath = `${path}.lines[${index}]`
    if (!isRecord(line)) {
      errors.push(`${linePath} must be an object.`)
      continue
    }
    validateUniqueId(line.id, linePath, lineIds, errors)
    for (const key of ['sourceItemId', 'sourceItemNumber']) {
      if (!nonEmpty(line[key])) errors.push(`${linePath}.${key} must be a non-empty string.`)
    }
    for (const key of ['description', 'unit', 'remarks']) {
      if (typeof line[key] !== 'string') errors.push(`${linePath}.${key} must be a string.`)
    }
    if (line.quotedDescription !== undefined && typeof line.quotedDescription !== 'string') {
      errors.push(`${linePath}.quotedDescription must be a string when supplied.`)
    }
    if (line.quotedUnit !== undefined && typeof line.quotedUnit !== 'string') {
      errors.push(`${linePath}.quotedUnit must be a string when supplied.`)
    }
    if (!Number.isInteger(line.sourceDepth) || line.sourceDepth < 0) {
      errors.push(`${linePath}.sourceDepth must be a non-negative integer.`)
    }
    if (typeof line.sourceHasChildren !== 'boolean') errors.push(`${linePath}.sourceHasChildren must be a boolean.`)
    if (typeof line.selected !== 'boolean') errors.push(`${linePath}.selected must be a boolean.`)
    if (!finiteNonNegative(line.quantity)) errors.push(`${linePath}.quantity must be a non-negative number.`)
    if (!finiteNonNegative(line.quotedQuantity)) {
      errors.push(`${linePath}.quotedQuantity must be a non-negative number.`)
    }
    validateGoodsReceiptGroupPath(line.sourceGroupPath, linePath, errors)
    if (Array.isArray(line.sourceGroupPath) && line.sourceDepth !== line.sourceGroupPath.length) {
      errors.push(`${linePath}.sourceDepth must equal sourceGroupPath.length.`)
    }
    if (line.selected && line.quantity === 0) warnings.push(`${linePath} is selected with zero quantity.`)
    if (line.selected && finiteNumber(line.quantity) && finiteNumber(line.quotedQuantity)
      && line.quantity > line.quotedQuantity) {
      warnings.push(`${linePath}.quantity exceeds the quoted quantity.`)
    }
    if (line.selected && finiteNumber(line.quantity) && line.quantity > 0) exportableLineCount += 1
  }

  if (exportableLineCount === 0) errors.push(`${path} has no selected positive-quantity lines.`)
  warnAboutOverlappingGoodsReceiptLines(value.lines, path, warnings)
}

function validateGoodsReceiptGroupPath(value, linePath, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${linePath}.sourceGroupPath must be an array.`)
    return
  }
  value.forEach((group, index) => {
    const path = `${linePath}.sourceGroupPath[${index}]`
    if (!isRecord(group)) {
      errors.push(`${path} must be an object.`)
      return
    }
    for (const key of ['id', 'itemNumber', 'label']) {
      if (typeof group[key] !== 'string') errors.push(`${path}.${key} must be a string.`)
    }
    if (!Number.isInteger(group.depth) || group.depth < 0) {
      errors.push(`${path}.depth must be a non-negative integer.`)
    }
  })
}

function warnAboutOverlappingGoodsReceiptLines(lines, path, warnings) {
  const selectedIds = new Set(
    lines.filter((line) => isRecord(line) && line.selected && line.quantity > 0).map((line) => line.sourceItemId),
  )
  lines.forEach((line, index) => {
    if (!isRecord(line) || !line.selected || line.quantity <= 0 || !Array.isArray(line.sourceGroupPath)) return
    if (line.sourceGroupPath.some((group) => isRecord(group) && selectedIds.has(group.id))) {
      warnings.push(`${path}.lines[${index}] is hidden because a selected ancestor is used as one receipt line.`)
    }
  })
}

function createGoodsReceiptLineDrafts(items) {
  const lines = []
  let rootItemNumber = 0
  for (const item of Array.isArray(items) ? items : []) {
    if (!isRecord(item) || item.kind === 'section_header') continue
    rootItemNumber += 1
    collectGoodsReceiptLines(item, String(rootItemNumber), [], lines, 1)
  }
  return lines
}

function collectGoodsReceiptLines(item, itemNumber, groupPath, lines, ancestorQuantityMultiplier) {
  const extendedQuantity = ancestorQuantityMultiplier * Math.max(finiteNumber(item.quantity) ? item.quantity : 0, 0)
  const quantity = Math.round((extendedQuantity + Number.EPSILON) * 100) / 100
  const children = Array.isArray(item.children) ? item.children.filter(isRecord) : []
  const sourceHasChildren = children.length > 0
  const description = [text(item.name), text(item.description)].map((value) => value.trim()).filter(Boolean).join(', ')
  const unit = text(item.quantityUnit).trim()

  lines.push({
    id: item.id,
    sourceItemId: item.id,
    sourceItemNumber: itemNumber,
    sourceGroupPath: groupPath,
    sourceDepth: groupPath.length,
    sourceHasChildren,
    selected: !sourceHasChildren && quantity > 0,
    description,
    quotedDescription: description,
    quantity,
    quotedQuantity: quantity,
    unit,
    quotedUnit: unit,
    remarks: '',
  })

  if (!sourceHasChildren) return
  const nextGroupPath = [...groupPath, {
    id: item.id,
    itemNumber,
    label: text(item.name).trim() || text(item.description).trim(),
    depth: groupPath.length,
  }]
  children.forEach((child, index) => {
    collectGoodsReceiptLines(child, `${itemNumber}.${index + 1}`, nextGroupPath, lines, extendedQuantity)
  })
}

function applyGoodsReceiptSelectionPreset(lines, preset) {
  const targetDepth = preset === 'summary' ? 0 : 1
  lines.forEach((line) => {
    if (line.quantity <= 0) {
      line.selected = false
    } else if (preset === 'detailed') {
      line.selected = !line.sourceHasChildren
    } else {
      line.selected = line.sourceDepth === targetDepth
        || (!line.sourceHasChildren && line.sourceDepth < targetDepth)
    }
  })
}

function applyGoodsReceiptLineOverrides(lines, value, warnings) {
  if (value === undefined) return
  if (!Array.isArray(value)) throw new Error('Goods-receipt lines must be an array of line overrides.')

  value.forEach((override, index) => {
    if (!isRecord(override)) throw new Error(`Goods-receipt line override ${index + 1} must be an object.`)
    const line = lines.find((candidate) => (
      (nonEmpty(override.sourceItemId) && candidate.sourceItemId === override.sourceItemId.trim())
      || (nonEmpty(override.sourceItemNumber) && candidate.sourceItemNumber === override.sourceItemNumber.trim())
      || (nonEmpty(override.id) && candidate.id === override.id.trim())
    ))
    if (!line) {
      warnings.push(`Goods-receipt line override ${index + 1} did not match a quotation item and was ignored.`)
      return
    }
    for (const key of ['description', 'unit', 'remarks']) {
      if (override[key] !== undefined && typeof override[key] !== 'string') {
        throw new Error(`Goods-receipt line override ${index + 1}.${key} must be a string.`)
      }
      if (typeof override[key] === 'string') line[key] = override[key]
    }
    if (override.selected !== undefined && typeof override.selected !== 'boolean') {
      throw new Error(`Goods-receipt line override ${index + 1}.selected must be a boolean.`)
    }
    if (typeof override.selected === 'boolean') line.selected = override.selected
    if (override.quantity !== undefined && !finiteNumber(override.quantity)) {
      throw new Error(`Goods-receipt line override ${index + 1}.quantity must be a number.`)
    }
    if (finiteNumber(override.quantity)) line.quantity = override.quantity
  })
}

function createGoodsReceiptNumber(documentDate) {
  const dateStamp = documentDate.replace(/\D/g, '').slice(0, 8)
  return dateStamp.length === 8 ? `GR-${dateStamp}` : 'GR'
}

function buildRootRow(raw, index, baseCurrency, ids, warnings) {
  if (!isRecord(raw)) throw new Error(`majorItems[${index}] must be an object.`)
  if (raw.kind === 'section_header') {
    return { id: uniqueId(raw.id, ids), kind: 'section_header', title: text(raw.title) }
  }
  return buildItem(raw, `majorItems[${index}]`, baseCurrency, ids, warnings)
}

function buildItem(raw, path, baseCurrency, ids, warnings) {
  if (!isRecord(raw)) throw new Error(`${path} must be an object.`)
  if (raw.kind === 'section_header') throw new Error(`${path}: section headers are allowed only at the root.`)
  const rawChildren = Array.isArray(raw.children)
    ? raw.children
    : Array.isArray(raw.subItems) ? raw.subItems : []
  const children = rawChildren.map((child, index) =>
    buildItem(child, `${path}.children[${index}]`, baseCurrency, ids, warnings),
  )
  const name = text(raw.name || raw.title)
  const pricingMethod = raw.pricingMethod === 'manual_price' || finiteNumber(raw.manualUnitPrice)
    ? 'manual_price'
    : 'cost_plus'
  const hasCostCurrency = Object.prototype.hasOwnProperty.call(raw, 'costCurrency')
  const costCurrency = normalizeCurrency(raw.costCurrency)
  if (!name) warnings.push(`${path}: item name was missing.`)
  if (!finiteNumber(raw.quantity)) warnings.push(`${path}: quantity was missing or invalid; used 1.`)
  if (!text(raw.quantityUnit)) warnings.push(`${path}: quantity unit was missing; used EA.`)
  if (hasCostCurrency && !costCurrency) {
    throw new Error(`${path}: supplied costCurrency is invalid or unsupported.`)
  }
  if (!hasCostCurrency && children.length === 0) {
    warnings.push(`${path}: cost currency was missing; used base currency ${baseCurrency}.`)
  }
  if (children.length > 0 && finiteNumber(raw.unitCost) && raw.unitCost !== 0) {
    warnings.push(`${path}: parent unitCost was ignored because the item has children.`)
  }

  const item = {
    id: uniqueId(raw.id, ids),
    name: name || 'Unnamed item',
    description: text(raw.description),
    quantity: finiteNumber(raw.quantity) ? raw.quantity : 1,
    quantityUnit: text(raw.quantityUnit) || 'EA',
    pricingMethod: children.length > 0 ? 'cost_plus' : pricingMethod,
    unitCost: children.length > 0 ? 0 : finiteNumber(raw.unitCost) ? raw.unitCost : 0,
    costCurrency: costCurrency ?? baseCurrency,
    notes: text(raw.notes),
    children,
  }
  if (children.length === 0 && pricingMethod === 'manual_price') {
    item.manualUnitPrice = finiteNumber(raw.manualUnitPrice) ? raw.manualUnitPrice : 0
    if (!finiteNumber(raw.manualUnitPrice)) warnings.push(`${path}: manual unit price was missing or invalid; used 0.`)
  } else if (children.length === 0 && !finiteNumber(raw.unitCost)) {
    warnings.push(`${path}: unit cost was missing or invalid; used 0.`)
  }
  if (finiteNumber(raw.markupRate)) item.markupRate = raw.markupRate
  if (nonEmpty(raw.taxClassId)) item.taxClassId = raw.taxClassId.trim()
  if (finiteNumber(raw.expectedTotal)) item.expectedTotal = raw.expectedTotal
  return item
}

function validateRootRow(row, path, ids, currencies, taxIds, errors, warnings) {
  if (!isRecord(row)) return errors.push(`${path} must be an object.`)
  if (row.kind === 'section_header') {
    validateUniqueId(row.id, path, ids, errors)
    if (typeof row.title !== 'string') errors.push(`${path}.title must be a string.`)
    return
  }
  validateItem(row, path, 1, ids, currencies, taxIds, errors, warnings)
}

function validateItem(item, path, depth, ids, currencies, taxIds, errors, warnings) {
  if (!isRecord(item)) return errors.push(`${path} must be an object.`)
  validateUniqueId(item.id, path, ids, errors)
  for (const key of ['name', 'description', 'quantityUnit', 'notes']) {
    if (typeof item[key] !== 'string') errors.push(`${path}.${key} must be a string.`)
  }
  if (!finiteNonNegative(item.quantity)) errors.push(`${path}.quantity must be a non-negative number.`)
  if (!['cost_plus', 'manual_price'].includes(item.pricingMethod)) errors.push(`${path}.pricingMethod is invalid.`)
  if (!finiteNonNegative(item.unitCost)) errors.push(`${path}.unitCost must be a non-negative number.`)
  const currency = normalizeCurrency(item.costCurrency)
  if (!currency) errors.push(`${path}.costCurrency must be a three-letter currency code.`)
  else currencies.add(currency)
  if (item.markupRate !== undefined
    && (!finiteNonNegative(item.markupRate) || item.markupRate > maxMarkupRate)) {
    errors.push(`${path}.markupRate must be between 0 and ${maxMarkupRate}.`)
  }
  if (item.expectedTotal !== undefined && !finiteNonNegative(item.expectedTotal)) {
    errors.push(`${path}.expectedTotal must be non-negative.`)
  }
  if (item.taxClassId !== undefined && !taxIds.has(item.taxClassId)) {
    errors.push(`${path}.taxClassId does not exist in totalsConfig.taxClasses.`)
  }
  if (!Array.isArray(item.children)) return errors.push(`${path}.children must be an array.`)
  if (depth >= 3 && item.children.length > 0) errors.push(`${path} exceeds the supported three-level hierarchy.`)
  if (item.children.length > 0) {
    if (item.unitCost !== 0) warnings.push(`${path}: parent unitCost is ignored by the app.`)
    if (item.manualUnitPrice !== undefined) warnings.push(`${path}: parent manualUnitPrice is ignored by the app.`)
    if (item.expectedTotal !== undefined) {
      warnings.push(`${path}: expectedTotal is comparison-only and does not set the price.`)
    }
  } else if (item.pricingMethod === 'manual_price' && !finiteNonNegative(item.manualUnitPrice)) {
    errors.push(`${path}.manualUnitPrice is required for manual_price.`)
  }
  item.children.forEach((child, index) =>
    validateItem(child, `${path}.children[${index}]`, depth + 1, ids, currencies, taxIds, errors, warnings),
  )
}

function buildTaxClasses(raw, warnings) {
  if (!Array.isArray(raw) || raw.length === 0) {
    warnings.push('Tax configuration was missing; used one 0% tax class.')
    return [{ id: 'default-tax-class', label: '0%', rate: 0 }]
  }
  const ids = new Set()
  return raw.map((value, index) => {
    if (!isRecord(value)) throw new Error(`taxClasses[${index}] must be an object.`)
    const rate = finiteNumber(value.rate) ? value.rate : 0
    return { id: uniqueId(value.id, ids), label: text(value.label) || `${rate}%`, rate }
  })
}

function validateTotals(value, errors) {
  const ids = new Set()
  if (!isRecord(value)) {
    errors.push('totalsConfig must be an object.')
    return ids
  }
  if (!finiteNonNegative(value.globalMarkupRate) || value.globalMarkupRate > maxMarkupRate) {
    errors.push(`globalMarkupRate must be between 0 and ${maxMarkupRate}.`)
  }
  if (!Array.isArray(value.extraCharges)) errors.push('extraCharges must be an array.')
  else value.extraCharges.forEach((charge, index) => {
    if (!isRecord(charge) || !nonEmpty(charge.id) || typeof charge.label !== 'string'
      || !finiteNonNegative(charge.amount)) errors.push(`extraCharges[${index}] is invalid.`)
  })
  if (!['single', 'mixed'].includes(value.taxMode)) errors.push('taxMode must be single or mixed.')
  if (!Array.isArray(value.taxClasses) || value.taxClasses.length === 0) {
    errors.push('taxClasses must contain at least one class.')
  } else value.taxClasses.forEach((taxClass, index) => {
    if (!isRecord(taxClass) || !nonEmpty(taxClass.id) || typeof taxClass.label !== 'string'
      || !finiteNonNegative(taxClass.rate) || taxClass.rate > maxTaxRate) {
      errors.push(`taxClasses[${index}] is invalid.`)
    } else if (ids.has(taxClass.id)) errors.push(`Duplicate tax class ID: ${taxClass.id}.`)
    else ids.add(taxClass.id)
  })
  if (!ids.has(value.defaultTaxClassId)) errors.push('defaultTaxClassId must reference a tax class.')
  if (!Array.isArray(value.mixedTaxColumns)
    || value.mixedTaxColumns.some((column) => !allowedMixedTaxColumns.has(column))) {
    errors.push('mixedTaxColumns contains an invalid column.')
  }
  return ids
}

function validateHeader(value, errors) {
  if (!isRecord(value)) return errors.push('header must be an object.')
  for (const key of [
    'quotationNumber', 'quotationDate', 'customerCompany', 'contactPerson', 'contactDetails',
    'projectName', 'validityPeriod', 'notes', 'terms',
  ]) if (typeof value[key] !== 'string') errors.push(`header.${key} must be a string.`)
  if (!Number.isInteger(value.revisionNumber) || value.revisionNumber < 1) {
    errors.push('header.revisionNumber must be a positive integer.')
  }
  if (!dateOnly(value.quotationDate)) errors.push('header.quotationDate must use YYYY-MM-DD.')
  if (!normalizeCurrency(value.currency)) errors.push('header.currency must be a three-letter currency code.')
  if (!locales.has(value.documentLocale)) errors.push('header.documentLocale must be en-US or zh-CN.')
}

function buildCompanyProfile(value) {
  const source = isRecord(value) ? value : {}
  return { companyName: text(source.companyName), email: text(source.email), phone: text(source.phone) }
}

function validateCompanyProfile(value, errors) {
  if (!isRecord(value)
    || ['companyName', 'email', 'phone'].some((key) => typeof value[key] !== 'string')) {
    errors.push('companyProfileSnapshot must contain companyName, email, and phone strings.')
  }
}

function buildExtraCharges(value, warnings) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    warnings.push('Extra charges were invalid and were ignored.')
    return []
  }
  const ids = new Set()
  return value.flatMap((charge, index) => {
    if (!isRecord(charge)) {
      warnings.push(`Extra charge ${index + 1} was not an object and was ignored.`)
      return []
    }
    if (typeof charge.label !== 'string') {
      warnings.push(`Extra charge ${index + 1} label was missing or invalid; used an empty label.`)
    }
    if (!finiteNumber(charge.amount)) {
      warnings.push(`Extra charge ${index + 1} amount was missing or invalid; used 0.`)
    }
    return [{
      id: uniqueId(charge.id, ids),
      label: text(charge.label),
      amount: finiteNumber(charge.amount) ? charge.amount : 0,
    }]
  })
}

function buildExchangeRates(value, baseCurrency, warnings) {
  const rates = {}
  if (value !== undefined && !isRecord(value)) {
    warnings.push('Exchange rates were invalid and were ignored.')
  }
  if (isRecord(value)) for (const [rawCurrency, rate] of Object.entries(value)) {
    const currency = normalizeCurrency(rawCurrency)
    if (!currency) {
      warnings.push(`Exchange rate entry ${rawCurrency} used an invalid or unsupported currency and was ignored.`)
      continue
    }
    if (!finiteNumber(rate) || rate <= 0 || rate > maxExchangeRate) {
      warnings.push(`Exchange rate for ${currency} was invalid and was ignored.`)
      continue
    }
    if (currency === baseCurrency && rate !== 1) {
      warnings.push(`Exchange rate for base currency ${baseCurrency} was replaced with 1.`)
      continue
    }
    rates[currency] = rate
  }
  rates[baseCurrency] = 1
  return rates
}

function validateExchangeRates(value, baseCurrency, usedCurrencies, errors) {
  if (!isRecord(value)) return errors.push('exchangeRates must be an object.')
  for (const [currency, rate] of Object.entries(value)) {
    if (!normalizeCurrency(currency) || !finiteNumber(rate) || rate <= 0 || rate > maxExchangeRate) {
      errors.push(`Invalid exchange rate for ${currency}.`)
    }
  }
  if (value[baseCurrency] !== 1) errors.push(`Base currency ${baseCurrency} must have exchange rate 1.`)
  for (const currency of usedCurrencies) {
    if (!finiteNumber(value[currency]) || value[currency] <= 0) {
      errors.push(`Missing exchange rate for item currency ${currency}.`)
    }
  }
}

function validateUniqueId(id, path, ids, errors) {
  if (!nonEmpty(id)) errors.push(`${path}.id must be non-empty.`)
  else if (ids.has(id)) errors.push(`Duplicate item ID: ${id}.`)
  else ids.add(id)
}

function uniqueId(value, ids) {
  let id = nonEmpty(value) ? value.trim() : randomUUID()
  while (ids.has(id)) id = randomUUID()
  ids.add(id)
  return id
}

function canonicalIso(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) || date.toISOString() !== value ? null : value
}

function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value ? null : value
}

function normalizeCurrency(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value.trim())) return null
  const currency = value.trim().toUpperCase()
  return supportedCurrencies.has(currency) ? currency : null
}

function positiveInteger(value, fallback) { return Number.isInteger(value) && value > 0 ? value : fallback }
function finiteNumber(value) { return typeof value === 'number' && Number.isFinite(value) }
function finiteNonNegative(value) { return finiteNumber(value) && value >= 0 }
function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0 }
function text(value) { return typeof value === 'string' ? value : '' }
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) }

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'self-test') return runSelfTest(args[0])
  if (command === 'set-goods-receipt-draft') {
    const [quotationPath, receiptPath, outputPath] = args
    if (!quotationPath || !receiptPath || !outputPath) {
      throw new Error('Usage: quotation-json.mjs set-goods-receipt-draft <quotation.json> <receipt.json> <output-quotation.json>')
    }
    const quotationInput = await readJsonFile(quotationPath)
    const receiptInput = await readJsonFile(receiptPath)
    const { envelope, warnings } = setPendingGoodsReceiptDraftInEnvelope(quotationInput, receiptInput)
    await writeFile(resolve(outputPath), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
    printResult({ errors: [], warnings })
    process.stdout.write(`Built ${resolve(outputPath)}\n`)
    return
  }
  if (command === 'add-goods-receipt') {
    const [quotationPath, receiptPath, outputPath] = args
    if (!quotationPath || !receiptPath || !outputPath) {
      throw new Error('Usage: quotation-json.mjs add-goods-receipt <quotation.json> <receipt.json> <output-quotation.json>')
    }
    const quotationInput = await readJsonFile(quotationPath)
    const receiptInput = await readJsonFile(receiptPath)
    const { envelope, warnings } = addGoodsReceiptToEnvelope(quotationInput, receiptInput)
    await writeFile(resolve(outputPath), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
    printResult({ errors: [], warnings })
    process.stdout.write(`Built ${resolve(outputPath)}\n`)
    return
  }

  const [inputPath, outputPath] = args
  if (!['build', 'validate'].includes(command) || !inputPath || (command === 'build' && !outputPath)) {
    throw new Error('Usage: quotation-json.mjs build <partial.json> <quotation.json> | set-goods-receipt-draft <quotation.json> <receipt.json> <output-quotation.json> | add-goods-receipt <quotation.json> <receipt.json> <output-quotation.json> | validate <quotation.json> | self-test')
  }
  const input = await readJsonFile(inputPath)
  if (command === 'validate') {
    const result = validateQuotationEnvelope(input)
    printResult(result)
    if (result.errors.length > 0) process.exitCode = 1
    return
  }
  const { envelope, warnings } = buildQuotationEnvelope(input)
  await writeFile(resolve(outputPath), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
  printResult({ errors: [], warnings })
  process.stdout.write(`Built ${resolve(outputPath)}\n`)
}

async function readJsonFile(filePath) {
  return JSON.parse((await readFile(resolve(filePath), 'utf8')).replace(/^\uFEFF/, ''))
}

function printResult({ errors, warnings }) {
  for (const error of errors) process.stderr.write(`ERROR: ${error}\n`)
  for (const warning of warnings) process.stdout.write(`WARNING: ${warning}\n`)
  if (errors.length === 0) process.stdout.write('Validation passed.\n')
}

async function runSelfTest(outputPath) {
  const { envelope } = buildQuotationEnvelope({
    header: {
      quotationNumber: 'Q-TEST-001', quotationDate: '2026-08-19', currency: 'USD',
      documentLocale: 'en-US', customerCompany: 'Acme', projectName: 'Pump package',
    },
    companyProfileSnapshot: {
      companyName: 'CX Engineering', email: 'sales@example.com', phone: '+1 555 0100',
    },
    totalsConfig: {
      globalMarkupRate: 10,
      taxClasses: [{ id: 'tax-0', label: '0%', rate: 0 }],
      defaultTaxClassId: 'tax-0',
    },
    exchangeRates: { USD: 1, CNY: 0.14 },
    majorItems: [{ name: 'Pump package', quantity: 1, quantityUnit: 'SET', children: [
      { name: 'Pump', quantity: 2, quantityUnit: 'EA', unitCost: 1000, costCurrency: 'USD' },
      {
        name: 'Commissioning', quantity: 1, quantityUnit: 'JOB', pricingMethod: 'manual_price',
        manualUnitPrice: 500, unitCost: 0, costCurrency: 'USD',
      },
      { name: 'Imported seal', quantity: 4, quantityUnit: 'EA', unitCost: 100, costCurrency: 'CNY' },
    ] }],
  }, new Date('2026-08-19T08:00:00.000Z'))
  const result = validateQuotationEnvelope(envelope)
  if (result.errors.length > 0) throw new Error(result.errors.join('\n'))
  if (envelope.quotation.majorItems[0].children.length !== 3) {
    throw new Error('Nested item generation failed.')
  }
  const invalidCurrency = structuredClone(envelope)
  invalidCurrency.quotation.header.currency = 'ZZZ'
  invalidCurrency.quotation.exchangeRates = { ZZZ: 1 }
  if (validateQuotationEnvelope(invalidCurrency).errors.length === 0) {
    throw new Error('Unsupported currency validation failed.')
  }

  const missingCurrency = buildQuotationEnvelope({
    header: { currency: 'USD', documentLocale: 'en-US' },
    majorItems: [{ name: 'Unpriced item', quantity: 1, quantityUnit: 'EA', unitCost: 0 }],
  }, new Date('2026-08-19T08:00:00.000Z'))
  if (missingCurrency.envelope.quotation.majorItems[0].costCurrency !== 'USD'
    || !missingCurrency.warnings.some((warning) => warning.includes('cost currency was missing'))) {
    throw new Error('Missing cost currency warning failed.')
  }

  let invalidCostCurrencyRejected = false
  try {
    buildQuotationEnvelope({
      header: { currency: 'USD', documentLocale: 'en-US' },
      majorItems: [{ name: 'Bad currency', costCurrency: 'ZZZ' }],
    }, new Date('2026-08-19T08:00:00.000Z'))
  } catch {
    invalidCostCurrencyRejected = true
  }
  if (!invalidCostCurrencyRejected) throw new Error('Invalid item cost currency was not rejected.')

  let invalidUsedRateRejected = false
  try {
    buildQuotationEnvelope({
      header: { currency: 'USD', documentLocale: 'en-US' },
      exchangeRates: { USD: 1, CNY: 'bad' },
      majorItems: [{ name: 'Imported item', unitCost: 100, costCurrency: 'CNY' }],
    }, new Date('2026-08-19T08:00:00.000Z'))
  } catch {
    invalidUsedRateRejected = true
  }
  if (!invalidUsedRateRejected) throw new Error('Invalid required exchange rate was not rejected.')

  const repairedCommercialFields = buildQuotationEnvelope({
    header: { currency: 'USD', documentLocale: 'en-US' },
    totalsConfig: {
      extraCharges: [null, { label: 42, amount: '100' }],
    },
    exchangeRates: { USD: 2, ZZZ: 3, EUR: 'bad' },
    majorItems: [{ name: 'Manual service', pricingMethod: 'manual_price', manualUnitPrice: 100, costCurrency: 'USD' }],
  }, new Date('2026-08-19T08:00:00.000Z'))
  const repairWarnings = repairedCommercialFields.warnings.join('\n')
  for (const expectedWarning of [
    'was not an object and was ignored',
    'label was missing or invalid',
    'amount was missing or invalid',
    'base currency USD was replaced with 1',
    'invalid or unsupported currency and was ignored',
    'Exchange rate for EUR was invalid and was ignored',
  ]) {
    if (!repairWarnings.includes(expectedWarning)) {
      throw new Error(`Missing fallback warning: ${expectedWarning}`)
    }
  }

  const pendingResult = setPendingGoodsReceiptDraftInEnvelope(envelope, {
    documentDate: '2026-08-19',
    grNumber: 'GR-20260819-01',
    customerReference: 'PO-12345',
    deliveryReference: 'DN-88',
    deliveryAddress: '88 Harbour Road',
    remarks: 'Inspect packaging on arrival.',
    selectionPreset: 'detailed',
    lines: [
      { sourceItemNumber: '1.1', selected: true, quantity: 1.5, remarks: 'One crate opened.' },
      { sourceItemNumber: '1.2', selected: false },
      { sourceItemNumber: '1.3', selected: false },
    ],
  }, new Date('2026-08-19T08:30:00.000Z'))
  const pendingDraft = pendingResult.envelope.quotation.pendingGoodsReceiptDraft
  if (pendingDraft.customerReference !== 'PO-12345'
    || pendingDraft.lines.find((line) => line.sourceItemNumber === '1.1')?.selected !== true
    || pendingDraft.lines.find((line) => line.sourceItemNumber === '1.2')?.selected !== false
    || pendingDraft.lines.find((line) => line.sourceItemNumber === '1.3')?.selected !== false) {
    throw new Error('Pending goods-receipt generation failed.')
  }
  const rebuiltWithPendingDraft = buildQuotationEnvelope(
    pendingResult.envelope,
    new Date('2026-08-19T08:45:00.000Z'),
  )
  if (rebuiltWithPendingDraft.envelope.quotation.pendingGoodsReceiptDraft.customerReference !== 'PO-12345') {
    throw new Error('Existing pending goods-receipt draft was not preserved.')
  }

  const receiptResult = addGoodsReceiptToEnvelope(pendingResult.envelope, {
    exportedAt: '2026-08-19T09:00:00.000Z',
    filePath: 'C:\\Receipts\\GR-20260819.pdf',
    draft: {
      documentDate: '2026-08-19',
      grNumber: 'GR-20260819-01',
      customerReference: 'PO-12345',
      deliveryReference: 'DN-88',
      deliveryAddress: '88 Harbour Road',
      remarks: 'Inspect packaging on arrival.',
      selectionPreset: 'detailed',
      lines: [{ sourceItemNumber: '1.1', quantity: 1.5, remarks: 'One crate opened.' }],
    },
  }, new Date('2026-08-19T09:00:00.000Z'))
  const receipt = receiptResult.envelope.quotation.goodsReceiptHistory[0]
  if (receipt.draft.customerReference !== 'PO-12345'
    || receipt.draft.deliveryAddress !== '88 Harbour Road'
    || receipt.draft.remarks !== 'Inspect packaging on arrival.'
    || receipt.draft.lines.find((line) => line.sourceItemNumber === '1.1')?.quantity !== 1.5) {
    throw new Error('Goods-receipt generation failed.')
  }
  if (receiptResult.envelope.quotation.pendingGoodsReceiptDraft !== undefined) {
    throw new Error('Completed goods receipt did not clear the pending draft.')
  }
  const rebuiltWithHistory = buildQuotationEnvelope(
    receiptResult.envelope,
    new Date('2026-08-19T10:00:00.000Z'),
  )
  if (rebuiltWithHistory.envelope.quotation.goodsReceiptHistory.length !== 1
    || rebuiltWithHistory.envelope.quotation.goodsReceiptHistory[0].draft.customerReference !== 'PO-12345') {
    throw new Error('Existing goods-receipt history was not preserved.')
  }
  const invalidReceipt = structuredClone(receiptResult.envelope)
  invalidReceipt.quotation.goodsReceiptHistory[0].draft.lines[0].quantity = -1
  if (!validateQuotationEnvelope(invalidReceipt).errors.some((error) => error.includes('quantity must be a non-negative'))) {
    throw new Error('Goods-receipt quantity validation failed.')
  }
  if (outputPath) {
    await writeFile(resolve(outputPath), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
    process.stdout.write(`Wrote ${resolve(outputPath)}\n`)
  }
  process.stdout.write('Self-test passed.\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
