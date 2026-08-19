#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const templates = new Set(['legacy', 'technical-bid', 'executive-summary', 'luminous', 'signal', 'atelier'])
const locales = new Set(['en-US', 'zh-CN'])
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
      extraCharges: buildExtraCharges(totalsSource.extraCharges),
      taxMode: totalsSource.taxMode === 'mixed' ? 'mixed' : 'single',
      taxClasses,
      defaultTaxClassId,
      mixedTaxColumns: Array.isArray(totalsSource.mixedTaxColumns)
        ? [...new Set(totalsSource.mixedTaxColumns.filter((column) => allowedMixedTaxColumns.has(column)))]
        : [...defaultMixedTaxColumns],
    },
    exchangeRates: buildExchangeRates(source.exchangeRates, baseCurrency),
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
  return { errors, warnings: [...new Set(warnings)] }
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
  if (!name) warnings.push(`${path}: item name was missing.`)
  if (!finiteNumber(raw.quantity)) warnings.push(`${path}: quantity was missing or invalid; used 1.`)
  if (!text(raw.quantityUnit)) warnings.push(`${path}: quantity unit was missing; used EA.`)
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
    costCurrency: normalizeCurrency(raw.costCurrency) ?? baseCurrency,
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

function buildExtraCharges(value) {
  if (!Array.isArray(value)) return []
  const ids = new Set()
  return value.filter(isRecord).map((charge) => ({
    id: uniqueId(charge.id, ids),
    label: text(charge.label),
    amount: finiteNumber(charge.amount) ? charge.amount : 0,
  }))
}

function buildExchangeRates(value, baseCurrency) {
  const rates = {}
  if (isRecord(value)) for (const [rawCurrency, rate] of Object.entries(value)) {
    const currency = normalizeCurrency(rawCurrency)
    if (currency && finiteNumber(rate)) rates[currency] = rate
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
  const [command, inputPath, outputPath] = process.argv.slice(2)
  if (command === 'self-test') return runSelfTest(inputPath)
  if (!['build', 'validate'].includes(command) || !inputPath || (command === 'build' && !outputPath)) {
    throw new Error('Usage: quotation-json.mjs build <partial.json> <quotation.json> | validate <quotation.json> | self-test')
  }
  const input = JSON.parse((await readFile(resolve(inputPath), 'utf8')).replace(/^\uFEFF/, ''))
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
