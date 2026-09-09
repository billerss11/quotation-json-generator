import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAutomationArguments,
  createBatchArguments,
  createCompactAutomationSummary,
  runExecutable,
} from './quotation-software.mjs'

test('builds the stable render command with production options', () => {
  assert.deepEqual(createAutomationArguments({
    command: 'render',
    inputFile: 'input.json',
    quotationPdf: 'quotation.pdf',
    goodsReceiptPdf: 'receipt.pdf',
    outputJson: 'normalized.json',
    resultJson: 'result.json',
    progressJson: 'progress.json',
    cancelFile: 'stop.cancel',
    timeoutMs: 45000,
    noNetwork: true,
    force: true,
  }), [
    '--automation', 'render',
    '--input', 'input.json',
    '--quotation-pdf', 'quotation.pdf',
    '--goods-receipt-pdf', 'receipt.pdf',
    '--output-json', 'normalized.json',
    '--result-json', 'result.json',
    '--progress-json', 'progress.json',
    '--cancel-file', 'stop.cancel',
    '--timeout-ms', '45000',
    '--no-network',
    '--force',
  ])
})

test('builds the stable validation command', () => {
  assert.deepEqual(createAutomationArguments({
    command: 'validate',
    inputFile: 'input.json',
    resultJson: 'validation.json',
    noNetwork: true,
  }), [
    '--automation', 'validate',
    '--input', 'input.json',
    '--result-json', 'validation.json',
    '--no-network',
  ])
})

test('rejects conflicting network options', () => {
  assert.throws(() => createAutomationArguments({
    command: 'render',
    inputFile: 'input.json',
    quotationPdf: 'quotation.pdf',
    refreshExchangeRates: true,
    noNetwork: true,
  }), /cannot be used with --no-network/)
})

test('builds the sequential batch command', () => {
  assert.deepEqual(createBatchArguments({
    manifestFile: 'jobs.json',
    resultJson: 'result.json',
    progressJson: 'progress.json',
    cancelFile: 'stop.cancel',
    timeoutMs: 45000,
    noNetwork: true,
    force: true,
  }), [
    '--automation', 'batch',
    '--manifest', 'jobs.json',
    '--result-json', 'result.json',
    '--progress-json', 'progress.json',
    '--cancel-file', 'stop.cancel',
    '--timeout-ms', '45000',
    '--no-network',
    '--force',
  ])
})

test('compacts reports without losing the first actionable error', () => {
  assert.deepEqual(createCompactAutomationSummary({
    ok: false,
    command: 'render',
    exitCode: 6,
    requestId: 'request-1',
    quotationNumber: 'Q-1',
    currency: 'USD',
    canonicalTotals: { grandTotal: 125 },
    warnings: [{ code: 'warning' }],
    errors: [{ code: 'goods_receipt_missing', message: 'Missing receipt.', fieldPath: 'quotation.pendingGoodsReceiptDraft' }],
    outputs: [],
  }), {
    ok: false,
    command: 'render',
    exitCode: 6,
    requestId: 'request-1',
    errorCount: 1,
    warningCount: 1,
    outputCount: 0,
    quotationNumber: 'Q-1',
    currency: 'USD',
    grandTotal: 125,
    firstError: {
      code: 'goods_receipt_missing',
      message: 'Missing receipt.',
      fieldPath: 'quotation.pendingGoodsReceiptDraft',
    },
  })
})

test('compacts batch job counts and errors', () => {
  assert.deepEqual(createCompactAutomationSummary({
    ok: false,
    command: 'batch',
    exitCode: 6,
    requestId: 'batch-1',
    errors: [],
    summary: { total: 2, completed: 2, succeeded: 1, failed: 1, canceled: 0 },
    jobs: [
      { outputs: [{ kind: 'quotation-pdf' }], errors: [], warnings: [] },
      {
        outputs: [{ kind: 'quotation-json' }],
        errors: [{ code: 'render_failed', message: 'Second job failed.' }],
        warnings: [{ code: 'layout_warning' }],
      },
    ],
  }), {
    ok: false,
    command: 'batch',
    exitCode: 6,
    requestId: 'batch-1',
    errorCount: 1,
    warningCount: 1,
    outputCount: 2,
    summary: { total: 2, completed: 2, succeeded: 1, failed: 1, canceled: 0 },
    firstError: { code: 'render_failed', message: 'Second job failed.' },
  })
})

test('bounds a subprocess that never exits', async () => {
  await assert.rejects(
    runExecutable(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 100),
    /did not exit within 100 ms/,
  )
})
