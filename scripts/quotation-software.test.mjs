import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { buildQuotationEnvelope, decodeQuotationEnvelope, encodeQuotationEnvelope } from './quotation-json.mjs'
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

async function mockPortableApplication(t, directory, apiInfo, { normalizeInput, documentReport } = {}) {
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
          const content = await readFile(argument('--input'), 'utf8')
          if (normalizeInput) await writeJson(argument('--output-json'), await normalizeInput(JSON.parse(content), { command, args }))
          else await writeFile(argument('--output-json'), content)
        }
        for (const flag of ['--quotation-pdf', '--goods-receipt-pdf']) {
          if (argument(flag)) await writeFile(argument(flag), 'mock PDF')
        }
        const report = command === 'api-info'
          ? apiInfo
          : documentReport?.({ command, args }) ?? { ok: true, command, exitCode: 0, errors: [], warnings: [], outputs: [] }
        await writeJson(argument('--result-json'), report)
        child.emit('close', report.exitCode ?? 0)
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
  const { envelope: persisted } = buildQuotationEnvelope({
    header: { quotationNumber: 'Q-1', currency: 'USD', documentLocale: 'en-US' },
    majorItems: [{ id: 'line-1', name: 'Valve', quantity: 2, unitCost: 50, costCurrency: 'USD' }],
  }, new Date('2026-10-12T08:00:00.000Z'))
  const envelope = decodeQuotationEnvelope(persisted)
  envelope.schemaVersion = schemaVersion === 4 ? 3 : schemaVersion
  delete envelope.revisions
  if (schemaVersion >= 3) {
    const snapshot = structuredClone(envelope.quotation)
    snapshot.header.revisionNumber = 1
    envelope.quotation.header.revisionNumber = 2
    envelope.revisions = [{
      id: 'revision-1', revisionNumber: 1, createdAt: '2026-10-12T08:00:00.000Z',
      note: 'Original offer', quotation: snapshot,
    }]
  }
  return schemaVersion === 4 ? encodeQuotationEnvelope(envelope) : envelope
}

const summaryApiInfo = {
  apiVersion: '2.2.0', appVersion: '0.1.0', quotationSchemaVersion: 3,
  commands: ['validate', 'render', 'batch'],
}

function addSummarySettings(envelope, { archivedOnly = false } = {}) {
  const quotation = archivedOnly ? envelope.revisions[0].quotation : envelope.quotation
  quotation.outputSettings = {
    itemDetailLevel: 2,
    subtotalLabel: '  Materials selling total  ',
    informationalTotalsNote: '  Included in the subtotal.\n请勿重复相加。  ',
    showInformationalTotals: false,
    informationalTotals: [{
      id: 'summary-1', label: '  阀门与管道  ', source: 'items',
      sectionIds: ['old-section', 'old-section'], itemIds: ['line-1', 'line-1'], visible: false,
    }],
  }
  return envelope
}

function stripWorkingSummarySettings(envelope) {
  envelope.quotation.outputSettings = { itemDetailLevel: envelope.quotation.outputSettings.itemDetailLevel }
  return envelope
}

function argumentValue(args, flag) {
  return args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined
}

async function assertSummaryProbeFilesRemoved(calls) {
  const probes = calls.filter(args => argumentValue(args, '--input')?.includes('summary-input'))
  assert.ok(probes.length > 0)
  for (const args of probes) {
    for (const flag of ['--input', '--output-json', '--result-json']) {
      await assert.rejects(readFile(argumentValue(args, flag)), { code: 'ENOENT' })
    }
    assert.ok(args.includes('--no-network'))
    assert.ok(!args.includes('--quotation-pdf'))
    assert.ok(!args.includes('--goods-receipt-pdf'))
  }
}

test('blocks summary-enabled validation and rendering on an app with matching old API/schema versions', async (t) => {
  const directory = await createTestDirectory(t)
  const { configPath, calls } = await mockPortableApplication(t, directory, summaryApiInfo, { normalizeInput: stripWorkingSummarySettings })
  const inputFile = join(directory, 'quotation.json')
  const outputJson = join(directory, 'normalized.json')
  const quotationPdf = join(directory, 'quotation.pdf')
  const resultJson = join(directory, 'requested-result.json')
  await writeJson(inputFile, addSummarySettings(createSchemaInput(3)))
  const before = await readFile(inputFile, 'utf8')
  const configBefore = await readFile(configPath, 'utf8')
  for (const run of [validateDocument, renderDocuments]) {
    await assert.rejects(run({ inputFile, outputJson, quotationPdf, resultJson, configPath }), error => {
      assert.ok(error instanceof QuotationSoftwareExecutionError)
      assert.equal(error.exitCode, 3)
      assert.equal(error.report.errors[0].code, 'quotation_summary_settings_unsupported')
      assert.match(error.message, /configure-current/)
      assert.match(error.message, /Keep the JSON and revision history unchanged/)
      assert.deepEqual(error.report.outputs, [])
      return true
    })
  }
  assert.deepEqual(calls.map(args => args[1]), ['api-info', 'validate', 'api-info', 'validate'])
  assert.equal(await readFile(inputFile, 'utf8'), before)
  assert.equal(await readFile(configPath, 'utf8'), configBefore)
  for (const filePath of [outputJson, quotationPdf, resultJson]) await assert.rejects(readFile(filePath), { code: 'ENOENT' })
  await assertSummaryProbeFilesRemoved(calls)
})

for (const [key, value] of [
  ['subtotalLabel', ''], ['showInformationalTotals', false], ['informationalTotals', []],
  ['informationalTotalsNote', '  Custom reminder.\n第二行。  '], ['informationalTotalsNote', ''], ['informationalTotalsNote', '  \n  '],
]) {
  test(`checks compatibility when only ${key} is supplied (${JSON.stringify(value)})`, async (t) => {
    const directory = await createTestDirectory(t)
    const { configPath, calls } = await mockPortableApplication(t, directory, summaryApiInfo, { normalizeInput: stripWorkingSummarySettings })
    const inputFile = join(directory, 'quotation.json')
    const input = createSchemaInput(3)
    input.quotation.outputSettings[key] = value
    await writeJson(inputFile, input)
    await assert.rejects(validateDocument({ inputFile, configPath }), error => error.report?.errors[0]?.code === 'quotation_summary_settings_unsupported')
    assert.deepEqual(calls.map(args => args[1]), ['api-info', 'validate'])
    await assertSummaryProbeFilesRemoved(calls)
  })
}

test('accepts a supporting app, allowing ID deduplication and preserving raw labels and archived settings', async (t) => {
  const directory = await createTestDirectory(t)
  const { configPath, calls } = await mockPortableApplication(t, directory, summaryApiInfo, {
    normalizeInput: envelope => {
      for (const row of envelope.quotation.outputSettings.informationalTotals ?? []) {
        row.sectionIds = [...new Set(row.sectionIds)]
        if (row.itemIds) row.itemIds = [...new Set(row.itemIds)]
      }
      return envelope
    },
  })
  const inputFile = join(directory, 'quotation.json')
  const outputJson = join(directory, 'normalized.json')
  const quotationPdf = join(directory, 'quotation.pdf')
  const input = addSummarySettings(createSchemaInput(3))
  input.revisions[0].quotation.outputSettings = structuredClone(input.quotation.outputSettings)
  await writeJson(inputFile, input)
  const before = await readFile(inputFile, 'utf8')
  for (const run of [validateDocument, renderDocuments]) {
    assert.equal((await run({ inputFile, outputJson, quotationPdf, configPath, force: true })).ok, true)
    const normalized = JSON.parse(await readFile(outputJson, 'utf8'))
    assert.equal(normalized.quotation.outputSettings.subtotalLabel, input.quotation.outputSettings.subtotalLabel)
    assert.equal(normalized.quotation.outputSettings.informationalTotalsNote, input.quotation.outputSettings.informationalTotalsNote)
    assert.equal(normalized.quotation.outputSettings.informationalTotals[0].label, input.quotation.outputSettings.informationalTotals[0].label)
    assert.deepEqual(normalized.quotation.outputSettings.informationalTotals[0].itemIds, ['line-1'])
    assert.deepEqual(normalized.revisions, input.revisions)
  }
  assert.deepEqual(calls.map(args => args[1]), ['api-info', 'validate', 'validate', 'api-info', 'validate', 'render'])
  assert.equal(await readFile(inputFile, 'utf8'), before)
  assert.ok(calls.filter(args => ['render', 'validate'].includes(args[1]) && !argumentValue(args, '--input').includes('summary-input'))
    .every(args => argumentValue(args, '--input') === inputFile))
  await assertSummaryProbeFilesRemoved(calls)
})

test('checks archived-only summary settings through the working normalizer without changing history', async (t) => {
  const directory = await createTestDirectory(t)
  let mirroredSettings
  const { configPath, calls } = await mockPortableApplication(t, directory, summaryApiInfo, {
    normalizeInput: envelope => {
      mirroredSettings = structuredClone(envelope.quotation.outputSettings)
      return stripWorkingSummarySettings(envelope)
    },
  })
  const inputFile = join(directory, 'quotation.json')
  const input = addSummarySettings(createSchemaInput(3), { archivedOnly: true })
  await writeJson(inputFile, input)
  const before = await readFile(inputFile, 'utf8')
  await assert.rejects(validateDocument({ inputFile, configPath }), error => {
    assert.equal(error.report.errors[0].code, 'quotation_summary_settings_unsupported')
    assert.match(error.report.errors[0].fieldPath, /^revisions\[0\]\.quotation\.outputSettings/)
    return true
  })
  assert.equal(mirroredSettings.informationalTotals[0].source, 'items')
  assert.equal(mirroredSettings.subtotalLabel, input.revisions[0].quotation.outputSettings.subtotalLabel)
  assert.equal(await readFile(inputFile, 'utf8'), before)
  await assertSummaryProbeFilesRemoved(calls)
})

test('checks advanced archived item settings even when the working draft only uses sections', async (t) => {
  const directory = await createTestDirectory(t)
  const { configPath, calls } = await mockPortableApplication(t, directory, summaryApiInfo, {
    normalizeInput: envelope => {
      for (const row of envelope.quotation.outputSettings.informationalTotals ?? []) {
        delete row.source
        delete row.itemIds
      }
      return envelope
    },
  })
  const inputFile = join(directory, 'quotation.json')
  const input = addSummarySettings(createSchemaInput(3), { archivedOnly: true })
  input.quotation.outputSettings = {
    itemDetailLevel: 3, showInformationalTotals: false,
    informationalTotals: [{ id: 'summary-1', label: 'Section summary', sectionIds: [], visible: false }],
  }
  await writeJson(inputFile, input)
  const before = await readFile(inputFile, 'utf8')
  await assert.rejects(renderDocuments({ inputFile, outputJson: join(directory, 'output.json'), configPath }), error => {
    assert.equal(error.report.errors[0].code, 'quotation_summary_settings_unsupported')
    assert.ok(error.report.errors[0].details.changedFields.includes('revisions[0].quotation.outputSettings.informationalTotals[0].source'))
    return true
  })
  assert.deepEqual(calls.map(args => args[1]), ['api-info', 'validate'])
  assert.equal(await readFile(inputFile, 'utf8'), before)
  await assertSummaryProbeFilesRemoved(calls)
})

test('rejects dropped archive-only blank notes even when the app preserves saved snapshots verbatim', async (t) => {
  const directory = await createTestDirectory(t)
  const { configPath, calls } = await mockPortableApplication(t, directory, summaryApiInfo, {
    normalizeInput: envelope => {
      delete envelope.quotation.outputSettings.informationalTotalsNote
      return envelope
    },
  })
  const inputFile = join(directory, 'quotation.json')
  const input = createSchemaInput(3)
  input.revisions[0].quotation.outputSettings.informationalTotalsNote = ''
  await writeJson(inputFile, input)
  const before = await readFile(inputFile, 'utf8')
  await assert.rejects(validateDocument({ inputFile, configPath }), error => {
    assert.equal(error.report.errors[0].code, 'quotation_summary_settings_unsupported')
    assert.equal(error.report.errors[0].fieldPath, 'revisions[0].quotation.outputSettings.informationalTotalsNote')
    return true
  })
  assert.equal(await readFile(inputFile, 'utf8'), before)
  assert.deepEqual(calls.map(args => args[1]), ['api-info', 'validate'])
  await assertSummaryProbeFilesRemoved(calls)
})

test('preflights every unique summary batch input before starting any requested job', async (t) => {
  const directory = await createTestDirectory(t)
  const { configPath, calls } = await mockPortableApplication(t, directory, summaryApiInfo, {
    normalizeInput: envelope => envelope.quotation.outputSettings.subtotalLabel === 'Unsupported'
      ? stripWorkingSummarySettings(envelope) : envelope,
  })
  const manifestFile = join(directory, 'batch', 'jobs.json')
  const inputs = [createSchemaInput(3), addSummarySettings(createSchemaInput(3)), addSummarySettings(createSchemaInput(3))]
  inputs[2].quotation.outputSettings.subtotalLabel = 'Unsupported'
  const inputPaths = inputs.map((_, index) => join(dirname(manifestFile), `${index}.json`))
  for (const [index, input] of inputs.entries()) await writeJson(inputPaths[index], input)
  await writeJson(manifestFile, { schemaVersion: 1, jobs: [0, 1, 2, 2].map((inputIndex, index) => ({
    id: `job-${index}`, command: 'render', input: `${inputIndex}.json`, outputJson: `output-${index}.json`,
  })) })
  const before = await Promise.all([...inputPaths, manifestFile].map(filePath => readFile(filePath, 'utf8')))
  await assert.rejects(runAutomationBatch({ manifestFile, configPath }), error => {
    assert.equal(error.report.errors.length, 2)
    assert.deepEqual(error.report.errors.map(issue => issue.fieldPath), ['jobs[2].input', 'jobs[3].input'])
    assert.deepEqual(error.report.errors.map(issue => issue.details.jobId), ['job-2', 'job-3'])
    assert.ok(error.report.errors.every(issue => issue.code === 'quotation_summary_settings_unsupported'))
    return true
  })
  assert.deepEqual(calls.map(args => args[1]), ['api-info', 'validate', 'validate'])
  assert.deepEqual(await Promise.all([...inputPaths, manifestFile].map(filePath => readFile(filePath, 'utf8'))), before)
  for (let index = 0; index < 4; index++) await assert.rejects(readFile(join(dirname(manifestFile), `output-${index}.json`)), { code: 'ENOENT' })
  await assertSummaryProbeFilesRemoved(calls)
})

test('starts a compatible summary batch after checking repeated inputs once', async (t) => {
  const directory = await createTestDirectory(t)
  const { configPath, calls } = await mockPortableApplication(t, directory, summaryApiInfo)
  const inputFile = join(directory, 'quotation.json')
  const manifestFile = join(directory, 'jobs.json')
  await writeJson(inputFile, addSummarySettings(createSchemaInput(3)))
  await writeJson(manifestFile, { schemaVersion: 1, jobs: [1, 2].map(index => ({
    id: `job-${index}`, command: 'validate', input: 'quotation.json',
  })) })
  assert.equal((await runAutomationBatch({ manifestFile, configPath })).ok, true)
  assert.deepEqual(calls.map(args => args[1]), ['api-info', 'validate', 'batch'])
  await assertSummaryProbeFilesRemoved(calls)
})

test('pins the same executable for summary probing and the requested command when configuration changes', async (t) => {
  const directory = await createTestDirectory(t)
  const replacementPath = join(directory, 'replacement.exe')
  await writeFile(replacementPath, '')
  const { configPath, calls } = await mockPortableApplication(t, directory, summaryApiInfo, {
    normalizeInput: async envelope => {
      await writeJson(join(directory, 'config.json'), { schemaVersion: 1, setupAcknowledged: true, softwarePath: replacementPath })
      return envelope
    },
  })
  const inputFile = join(directory, 'quotation.json')
  await writeJson(inputFile, addSummarySettings(createSchemaInput(3)))
  const report = await validateDocument({ inputFile, configPath })
  assert.equal(report.softwarePath, join(directory, 'mock-portable.exe'))
  assert.equal((await getSoftwareStatus(configPath)).softwarePath, replacementPath)
  assert.deepEqual(calls.map(args => args[1]), ['api-info', 'validate', 'validate'])
  await assertSummaryProbeFilesRemoved(calls)
})

for (const [name, alter] of [
  ['raw subtotal label', settings => { settings.subtotalLabel = settings.subtotalLabel.trim() }],
  ['raw multiline breakdown note', settings => { settings.informationalTotalsNote = settings.informationalTotalsNote.trim() }],
  ['raw row label', settings => { settings.informationalTotals[0].label = settings.informationalTotals[0].label.trim() }],
  ['row order', settings => { settings.informationalTotals.reverse() }],
  ['default section source', settings => { settings.informationalTotals[0].source = 'items' }],
  ['inactive item IDs', settings => { settings.informationalTotals[0].itemIds = ['injected-item'] }],
]) {
  test(`refuses an app that alters ${name}`, async (t) => {
    const directory = await createTestDirectory(t)
    const { configPath, calls } = await mockPortableApplication(t, directory, summaryApiInfo, {
      normalizeInput: envelope => { alter(envelope.quotation.outputSettings); return envelope },
    })
    const inputFile = join(directory, 'quotation.json')
    const input = addSummarySettings(createSchemaInput(3))
    delete input.quotation.outputSettings.informationalTotals[0].source
    delete input.quotation.outputSettings.informationalTotals[0].itemIds
    input.quotation.outputSettings.informationalTotals.push({ id: 'second', label: 'Other', sectionIds: [], visible: false })
    await writeJson(inputFile, input)
    await assert.rejects(validateDocument({ inputFile, configPath }), error => error.report?.errors[0]?.code === 'quotation_summary_settings_unsupported')
    assert.deepEqual(calls.map(args => args[1]), ['api-info', 'validate'])
    await assertSummaryProbeFilesRemoved(calls)
  })
}

test('cleans probe files and retains authoritative validation errors when round-trip checking fails', async (t) => {
  const directory = await createTestDirectory(t)
  const { configPath, calls } = await mockPortableApplication(t, directory, summaryApiInfo, {
    documentReport: ({ command }) => ({ ok: false, command, exitCode: 3, errors: [{ code: 'quotation_number_required', message: 'A quotation number is required.' }], warnings: [], outputs: [] }),
  })
  const inputFile = join(directory, 'quotation.json')
  await writeJson(inputFile, addSummarySettings(createSchemaInput(3)))
  await assert.rejects(validateDocument({ inputFile, configPath }), error => {
    assert.equal(error.report.errors[0].code, 'quotation_summary_settings_check_failed')
    assert.equal(error.report.errors[0].details.validationReport.errors[0].code, 'quotation_number_required')
    return true
  })
  assert.deepEqual(calls.map(args => args[1]), ['api-info', 'validate'])
  await assertSummaryProbeFilesRemoved(calls)
})

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

test('blocks schema 4 validation, render and mixed batch inputs on a schema 3 application', async (t) => {
  const directory = await createTestDirectory(t)
  const { configPath, calls } = await mockPortableApplication(t, directory, summaryApiInfo)
  const inputFile = join(directory, 'shared-images.json')
  await writeJson(inputFile, addSummarySettings(createSchemaInput(4)))
  const before = await readFile(inputFile, 'utf8')
  for (const run of [validateDocument, renderDocuments]) {
    await assert.rejects(run({ inputFile, outputJson: join(directory, 'normalized.json'), configPath, noNetwork: true }), error => {
      assert.equal(error.report.errors[0].code, 'quotation_schema_unsupported')
      assert.equal(error.report.errors[0].details.inputSchemaVersion, 4)
      return true
    })
  }
  await writeJson(join(directory, 'legacy.json'), createSchemaInput(3))
  const manifestFile = join(directory, 'jobs.json')
  await writeJson(manifestFile, { schemaVersion: 1, jobs: [
    { command: 'validate', input: 'legacy.json' },
    { command: 'render', input: 'shared-images.json' },
  ] })
  await assert.rejects(runAutomationBatch({ manifestFile, configPath }), error => {
    assert.equal(error.report.errors[0].fieldPath, 'jobs[1].input')
    return true
  })
  assert.deepEqual(calls.map(args => args[1]), ['api-info', 'api-info', 'api-info'])
  assert.equal(await readFile(inputFile, 'utf8'), before)
})

test('summary compatibility decodes v4 output and keeps shared images in its v4 probe', async (t) => {
  const directory = await createTestDirectory(t)
  let probeSeen = false
  const { configPath } = await mockPortableApplication(t, directory, { ...summaryApiInfo, quotationSchemaVersion: 4 }, {
    normalizeInput: (envelope, { args }) => {
      if (argumentValue(args, '--input').includes('summary-input')) {
        if (envelope.schemaVersion === 4) {
          assert.deepEqual(envelope.images, { 'image-1': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6n6sAAAAASUVORK5CYII=' })
          assert.equal(envelope.quotation.branding.logoImageId, 'image-1')
          probeSeen = true
        }
      }
      return encodeQuotationEnvelope(envelope)
    },
  })
  for (const version of [2, 3, 4]) {
    const input = addSummarySettings(createSchemaInput(version))
    if (version === 4) {
      input.images = { 'image-1': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6n6sAAAAASUVORK5CYII=' }
      input.quotation.branding.logoImageId = 'image-1'
      input.revisions[0].quotation.branding.logoImageId = 'image-1'
    }
    const inputFile = join(directory, `input-${version}.json`)
    const outputJson = join(directory, `output-${version}.json`)
    await writeJson(inputFile, input)
    const before = await readFile(inputFile, 'utf8')
    assert.equal((await validateDocument({ inputFile, outputJson, configPath })).ok, true)
    const output = JSON.parse(await readFile(outputJson, 'utf8'))
    assert.equal(output.schemaVersion, 4)
    assert.deepEqual(decodeQuotationEnvelope(output).quotation, decodeQuotationEnvelope(input).quotation)
    assert.equal(await readFile(inputFile, 'utf8'), before)
  }
  assert.equal(probeSeen, true)
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
