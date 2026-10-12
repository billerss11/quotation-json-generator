import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { buildQuotationEnvelope } from './quotation-json.mjs'
import {
  QuotationSoftwareExecutionError,
  configureCurrentSoftware,
  configureSoftware,
  createAutomationArguments,
  createBatchArguments,
  createCompactAutomationSummary,
  getSoftwareStatus,
  renderDocuments,
  runAutomationBatch,
  runExecutable,
  validateDocument,
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

async function mockPortableApplication(t, directory, apiInfo) {
  const executablePath = join(directory, 'mock-portable.exe')
  const configPath = join(directory, 'config.json')
  await writeFile(executablePath, '')
  await configureSoftware(executablePath, configPath)
  const calls = []
  const originalSpawn = childProcess.spawn
  const spawnMock = t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    if (executable !== executablePath) return originalSpawn(executable, args, options)
    calls.push(args)
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    queueMicrotask(async () => {
      try {
        const argument = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined
        const command = args[1]
        if (command !== 'api-info' && argument('--output-json')) {
          await writeFile(argument('--output-json'), await readFile(argument('--input')))
        }
        await writeJson(argument('--result-json'), command === 'api-info'
          ? apiInfo
          : { ok: true, command, exitCode: 0, errors: [], warnings: [], outputs: [] })
        child.emit('close', 0)
      } catch (error) {
        child.emit('error', error)
      }
    })
    return child
  })
  syncBuiltinESMExports()
  t.after(() => {
    spawnMock.mock.restore()
    syncBuiltinESMExports()
  })
  return { configPath, calls }
}

function createSchemaInput(schemaVersion) {
  const { envelope } = buildQuotationEnvelope({
    header: { quotationNumber: 'Q-1', currency: 'USD', documentLocale: 'en-US' },
    majorItems: [{ id: 'line-1', name: 'Valve', quantity: 2, unitCost: 50, costCurrency: 'USD' }],
  }, new Date('2026-10-12T08:00:00.000Z'))
  envelope.schemaVersion = schemaVersion
  delete envelope.revisions
  if (schemaVersion === 3) {
    const snapshot = structuredClone(envelope.quotation)
    snapshot.header.revisionNumber = 1
    envelope.quotation.header.revisionNumber = 2
    envelope.revisions = [{
      id: 'revision-1', revisionNumber: 1, createdAt: '2026-10-12T08:00:00.000Z',
      note: 'Original offer', quotation: snapshot,
    }]
  }
  return envelope
}

test('blocks schema 3 document jobs on a schema 2 portable without changing files or history', async (t) => {
  const directory = await createTestDirectory(t)
  const { configPath, calls } = await mockPortableApplication(t, directory, {
    apiVersion: '2.0.0', quotationSchemaVersion: 2, commands: ['validate', 'render', 'batch'],
  })
  const inputFile = join(directory, 'quotation.json')
  const outputJson = join(directory, 'normalized.json')
  await writeJson(inputFile, createSchemaInput(3))
  const before = await readFile(inputFile, 'utf8')
  const configBefore = await readFile(configPath, 'utf8')
  for (const run of [validateDocument, renderDocuments]) {
    await assert.rejects(run({ inputFile, outputJson, configPath, noNetwork: true }), error => {
      assert.ok(error instanceof QuotationSoftwareExecutionError)
      assert.equal(error.exitCode, 3)
      assert.equal(error.report.errors[0].code, 'quotation_schema_unsupported')
      assert.equal(error.report.errors[0].details.inputSchemaVersion, 3)
      assert.equal(error.report.errors[0].details.supportedSchemaVersion, 2)
      assert.match(error.message, /configure-current/)
      assert.match(error.message, /Keep the JSON and revision history unchanged/)
      return true
    })
  }
  assert.deepEqual(calls.map(args => args[1]), ['api-info', 'api-info'])
  assert.equal(await readFile(inputFile, 'utf8'), before)
  assert.equal(await readFile(configPath, 'utf8'), configBefore)
  await assert.rejects(readFile(outputJson), { code: 'ENOENT' })
})

test('checks all relative batch inputs before starting any job on an old portable', async (t) => {
  const directory = await createTestDirectory(t)
  const { configPath, calls } = await mockPortableApplication(t, directory, {
    apiVersion: '2.0.0', quotationSchemaVersion: 2, commands: ['batch'],
  })
  const manifestFile = join(directory, 'batch', 'jobs.json')
  const inputs = [2, 3, 3].map((version, index) => ({
    path: join(dirname(manifestFile), 'input', `${index}.json`), value: createSchemaInput(version),
  }))
  for (const input of inputs) await writeJson(input.path, input.value)
  await writeJson(manifestFile, {
    schemaVersion: 1,
    jobs: inputs.map((_, index) => ({ id: `job-${index}`, command: 'validate', input: `input/${index}.json` })),
  })
  const before = await Promise.all(inputs.map(input => readFile(input.path, 'utf8')))
  const manifestBefore = await readFile(manifestFile, 'utf8')
  await assert.rejects(runAutomationBatch({ manifestFile, configPath, noNetwork: true }), error => {
    assert.ok(error instanceof QuotationSoftwareExecutionError)
    assert.equal(error.exitCode, 3)
    assert.equal(error.report.errors.length, 2)
    assert.deepEqual(error.report.errors.map(issue => issue.fieldPath), ['jobs[1].input', 'jobs[2].input'])
    assert.deepEqual(error.report.errors.map(issue => issue.details.jobId), ['job-1', 'job-2'])
    assert.ok(error.report.errors.every(issue => issue.code === 'quotation_schema_unsupported'))
    return true
  })
  assert.deepEqual(calls.map(args => args[1]), ['api-info'])
  assert.deepEqual(await Promise.all(inputs.map(input => readFile(input.path, 'utf8'))), before)
  assert.equal(await readFile(manifestFile, 'utf8'), manifestBefore)

  await writeFile(manifestFile, '{invalid json', 'utf8')
  await assert.rejects(runAutomationBatch({ manifestFile, configPath }), error => {
    assert.equal(error.exitCode, 3)
    assert.equal(error.report.errors[0].code, 'manifest_read_failed')
    return true
  })
  assert.deepEqual(calls.map(args => args[1]), ['api-info', 'api-info'])
})

test('schema 3 portable API 2.1 accepts schema 2 and 3 documents and mixed batches', async (t) => {
  const directory = await createTestDirectory(t)
  const { configPath, calls } = await mockPortableApplication(t, directory, {
    apiVersion: '2.1.0', quotationSchemaVersion: 3, commands: ['validate', 'render', 'batch'],
  })
  for (const schemaVersion of [2, 3]) {
    const inputFile = join(directory, `schema-${schemaVersion}.json`)
    const outputJson = join(directory, `output-${schemaVersion}.json`)
    await writeJson(inputFile, createSchemaInput(schemaVersion))
    const before = await readFile(inputFile, 'utf8')
    for (const run of [validateDocument, renderDocuments]) {
      const report = await run({ inputFile, outputJson, configPath, noNetwork: true, force: true })
      assert.equal(report.ok, true)
      assert.equal(await readFile(inputFile, 'utf8'), before)
      assert.equal(await readFile(outputJson, 'utf8'), before)
    }
  }
  const manifestFile = join(directory, 'jobs.json')
  await writeJson(manifestFile, {
    schemaVersion: 1,
    jobs: [2, 3].map(version => ({ command: 'validate', input: `schema-${version}.json` })),
  })
  assert.equal((await runAutomationBatch({ manifestFile, configPath, noNetwork: true })).ok, true)
  assert.deepEqual(calls.map(args => args[1]), [
    'api-info', 'validate', 'api-info', 'render',
    'api-info', 'validate', 'api-info', 'render', 'api-info', 'batch',
  ])
  assert.ok(calls.filter(args => args[1] !== 'api-info').every(args => args.includes('--no-network')))
})

test('refuses an app with unknown schema support before opening a quotation', async (t) => {
  const directory = await createTestDirectory(t)
  const { configPath, calls } = await mockPortableApplication(t, directory, {
    apiVersion: '2.2.0', commands: ['validate'],
  })
  const inputFile = join(directory, 'quotation.json')
  await writeJson(inputFile, createSchemaInput(2))
  await assert.rejects(validateDocument({ inputFile, configPath }), error => {
    assert.equal(error.exitCode, 3)
    assert.equal(error.report.errors[0].code, 'quotation_schema_unknown')
    return true
  })
  assert.deepEqual(calls.map(args => args[1]), ['api-info'])
})

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
