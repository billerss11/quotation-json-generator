#!/usr/bin/env node

// Optional maintenance check. Normal JSON generation does not load the repo or Vite.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { calculationCases, createCalculationInput } from './calculation-cases.mjs'
import { buildQuotationEnvelope, summarizeQuotationEnvelope, validateQuotationEnvelope } from './quotation-json.mjs'

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
  const { parseQuotationFileContent } = await server.ssrLoadModule('/src/features/quotations/utils/quotationFile.ts')
  const { calculateQuotationTotals } = await server.ssrLoadModule('/src/features/quotations/utils/quotationCalculations.ts')
  const { createGoodsReceiptLineDrafts } = await server.ssrLoadModule('/src/features/goods-receipts/utils/goodsReceipt.ts')
  const now = new Date('2026-09-08T08:00:00.000Z')
  let checked = 0
  function check(name, envelope, expectedTotal) {
    assert.deepEqual(validateQuotationEnvelope(envelope).errors, [], `${name}: offline validation`)
    const quotation = parseQuotationFileContent(JSON.stringify(envelope))
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
  assert.throws(() => parseQuotationFileContent(JSON.stringify(ambiguous)), /duplicate_currency/)

  const fixture = JSON.parse(await readFile(new URL('../evals/fixtures/quotation-with-receipt.json', import.meta.url), 'utf8'))
  const fixtureQuotation = check('portable evaluation fixture', fixture)
  assert.deepEqual(fixture.quotation.pendingGoodsReceiptDraft.lines, createGoodsReceiptLineDrafts(fixtureQuotation.majorItems))

  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  console.log(JSON.stringify({ ok: true, quotationCases: checked, receiptLineParity: true, duplicateCurrencyRejected: true, repositoryCommit: commit }))
} finally {
  await server.close()
}
