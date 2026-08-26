import assert from 'node:assert/strict'
import test from 'node:test'

import { createAutomationArguments, runExecutable } from './quotation-software.mjs'

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

test('bounds a subprocess that never exits', async () => {
  await assert.rejects(
    runExecutable(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 100),
    /did not exit within 100 ms/,
  )
})
