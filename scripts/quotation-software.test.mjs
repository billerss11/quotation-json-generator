import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import {
  configureCurrentSoftware,
  configureSoftware,
  createAutomationArguments,
  createBatchArguments,
  createCompactAutomationSummary,
  getSoftwareStatus,
  runExecutable,
} from './quotation-software.mjs'

async function createTestDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'quotation-software-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeManifest(filePath, softwarePath, appVersion, builtAt) {
  await writeJson(filePath, { schemaVersion: 1, softwarePath, appVersion, builtAt })
}

test('keeps direct executable configuration compatible', async (t) => {
  const directory = await createTestDirectory(t)
  const executablePath = join(directory, 'Quotation Software.exe')
  const configPath = join(directory, 'config', 'config.json')
  await writeFile(executablePath, '')

  const status = await configureSoftware(executablePath, configPath)
  assert.equal(status.softwarePath, resolve(executablePath))
  assert.equal(status.exists, true)
  assert.equal(status.usable, true)
  assert.equal(status.currentManifestPath, undefined)
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
    schemaVersion: 1,
    setupAcknowledged: true,
    softwarePath: resolve(executablePath),
  })
})

test('resolves a switched current manifest on every status call', async (t) => {
  const directory = await createTestDirectory(t)
  const configPath = join(directory, 'config.json')
  const manifestPath = join(directory, 'current-portable.json')
  const executableA = join(directory, 'releases', 'Quotation Software A.exe')
  const executableB = join(directory, 'releases', 'Quotation Software B.exe')
  await mkdir(dirname(executableA), { recursive: true })
  await Promise.all([writeFile(executableA, ''), writeFile(executableB, '')])
  await writeManifest(manifestPath, join('releases', 'Quotation Software A.exe'), '1.0.0', '2026-09-15T01:00:00.000Z')

  const statusA = await configureCurrentSoftware(manifestPath, configPath)
  assert.equal(statusA.currentManifestPath, resolve(manifestPath))
  assert.equal(statusA.softwarePath, resolve(executableA))
  assert.equal(statusA.appVersion, '1.0.0')

  await writeManifest(manifestPath, join('releases', 'Quotation Software B.exe'), '2.0.0', '2026-09-15T02:00:00.000Z')
  const statusB = await getSoftwareStatus(configPath)
  assert.equal(statusB.softwarePath, resolve(executableB))
  assert.equal(statusB.appVersion, '2.0.0')
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
    schemaVersion: 1,
    setupAcknowledged: true,
    currentManifestPath: resolve(manifestPath),
  })
})

test('rejects invalid or missing current manifests without using a direct fallback', async (t) => {
  const directory = await createTestDirectory(t)
  const configPath = join(directory, 'config.json')
  const manifestPath = join(directory, 'current-portable.json')
  const directExecutable = join(directory, 'direct.exe')
  await writeFile(directExecutable, '')

  await assert.rejects(
    configureCurrentSoftware(manifestPath, configPath),
    /manifest was not found/,
  )

  await writeFile(manifestPath, '{not json', 'utf8')
  await assert.rejects(
    configureCurrentSoftware(manifestPath, configPath),
    /Could not read Quotation Software manifest/,
  )

  await writeJson(manifestPath, {
    schemaVersion: 1,
    softwarePath: 'missing.exe',
    builtAt: '2026-09-15T01:00:00.000Z',
  })
  await assert.rejects(
    configureCurrentSoftware(manifestPath, configPath),
    /manifest appVersion must be a non-empty string/,
  )

  await writeManifest(manifestPath, resolve(directExecutable), '1.0.0', '2026-09-15T01:00:00.000Z')
  await assert.rejects(
    configureCurrentSoftware(manifestPath, configPath),
    /softwarePath must be relative/,
  )

  await writeManifest(manifestPath, 'missing.exe', '1.0.0', '2026-09-15T01:00:00.000Z')
  await assert.rejects(
    configureCurrentSoftware(manifestPath, configPath),
    /executable from the current manifest was not found/,
  )

  await writeJson(configPath, {
    schemaVersion: 1,
    setupAcknowledged: true,
    currentManifestPath: join(directory, 'deleted-manifest.json'),
    softwarePath: directExecutable,
  })
  await assert.rejects(
    getSoftwareStatus(configPath),
    /manifest was not found/,
  )
})

test('reports a configured manifest executable that was removed', async (t) => {
  const directory = await createTestDirectory(t)
  const configPath = join(directory, 'config.json')
  const manifestPath = join(directory, 'current-portable.json')
  const executablePath = join(directory, 'Quotation Software.exe')
  await writeFile(executablePath, '')
  await writeManifest(manifestPath, 'Quotation Software.exe', '1.0.0', '2026-09-15T01:00:00.000Z')
  await configureCurrentSoftware(manifestPath, configPath)

  await unlink(executablePath)
  const status = await getSoftwareStatus(configPath)
  assert.equal(status.configured, true)
  assert.equal(status.softwarePath, resolve(executablePath))
  assert.equal(status.exists, false)
  assert.equal(status.usable, false)
})

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
