#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { validateQuotationJsonContent } from './quotation-json.mjs'

const configSchemaVersion = 1
const apiProbeTimeoutMs = 15_000

export function getDefaultConfigPath() {
  const configRoot = process.env.APPDATA || process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configRoot, 'quotation-json-generator', 'config.json')
}

export async function getSoftwareStatus(configPath = getDefaultConfigPath()) {
  const resolvedConfigPath = resolve(configPath)
  const config = await readConfig(resolvedConfigPath)
  const softwarePath = typeof config?.softwarePath === 'string' && config.softwarePath.trim()
    ? resolve(config.softwarePath)
    : null
  const exists = softwarePath ? await isExecutableFile(softwarePath) : false

  return {
    configPath: resolvedConfigPath,
    setupAcknowledged: config?.setupAcknowledged === true,
    configured: softwarePath !== null,
    softwarePath,
    exists,
    usable: softwarePath !== null && exists,
  }
}

export async function configureSoftware(softwarePath, configPath = getDefaultConfigPath()) {
  const executablePath = resolve(cleanPathInput(softwarePath))

  if (!(await isExecutableFile(executablePath))) {
    throw new Error(`Quotation Software executable was not found: ${executablePath}`)
  }

  await writeConfig(configPath, {
    schemaVersion: configSchemaVersion,
    setupAcknowledged: true,
    softwarePath: executablePath,
  })

  return getSoftwareStatus(configPath)
}

export async function acknowledgeMissingSoftware(configPath = getDefaultConfigPath()) {
  await writeConfig(configPath, {
    schemaVersion: configSchemaVersion,
    setupAcknowledged: true,
    softwarePath: null,
  })

  return getSoftwareStatus(configPath)
}

export async function getSoftwareApiInfo(configPath = getDefaultConfigPath(), probeDirectory = process.cwd()) {
  const status = await getSoftwareStatus(configPath)
  if (!status.usable || !status.softwarePath) {
    throw new Error(status.configured
      ? `The configured Quotation Software executable is missing: ${status.softwarePath}`
      : 'Quotation Software is not configured.')
  }

  const probeResultPath = join(
    resolve(probeDirectory),
    `.quotation-software-api-info-${process.pid}-${randomUUID()}.json`,
  )

  try {
    await mkdir(dirname(probeResultPath), { recursive: true })
    const processResult = await runExecutable(
      status.softwarePath,
      ['--automation', 'api-info', '--result-json', probeResultPath],
      apiProbeTimeoutMs,
    )
    const apiInfo = await readJsonIfPresent(probeResultPath) ?? parseStdoutReport(processResult.stdout)
    if (processResult.exitCode !== 0 || !apiInfo || typeof apiInfo.apiVersion !== 'string') {
      throw new Error('The configured executable does not expose the stable automation API. Rebuild or configure the current portable application.')
    }
    if (Number(apiInfo.apiVersion.split('.')[0]) < 2) {
      throw new Error(`Quotation Software automation API ${apiInfo.apiVersion} is too old; version 2 or later is required.`)
    }
    return { softwarePath: status.softwarePath, ...apiInfo }
  } finally {
    await unlink(probeResultPath).catch(() => undefined)
  }
}

export async function validateDocument({
  inputFile,
  outputJson,
  resultJson,
  progressJson,
  cancelFile,
  noNetwork = false,
  force = false,
  timeoutMs,
  configPath = getDefaultConfigPath(),
}) {
  return runAutomationDocument({
    command: 'validate',
    inputFile,
    outputJson,
    resultJson,
    progressJson,
    cancelFile,
    noNetwork,
    force,
    timeoutMs,
    configPath,
  })
}

export async function exportDocuments(options) {
  return renderDocuments(options)
}

export async function renderDocuments({
  inputFile,
  quotationPdf,
  goodsReceiptPdf,
  outputJson,
  resultJson,
  progressJson,
  cancelFile,
  refreshExchangeRates = false,
  noNetwork = false,
  force = false,
  timeoutMs,
  configPath = getDefaultConfigPath(),
}) {
  return runAutomationDocument({
    command: 'render',
    inputFile,
    quotationPdf,
    goodsReceiptPdf,
    outputJson,
    resultJson,
    progressJson,
    cancelFile,
    refreshExchangeRates,
    noNetwork,
    force,
    timeoutMs,
    configPath,
  })
}

async function runAutomationDocument({
  command,
  inputFile,
  quotationPdf,
  goodsReceiptPdf,
  outputJson,
  resultJson,
  progressJson,
  cancelFile,
  refreshExchangeRates = false,
  noNetwork = false,
  force = false,
  timeoutMs,
  configPath,
}) {
  const resolvedInputFile = resolve(inputFile)
  const validation = validateQuotationJsonContent(await readFile(resolvedInputFile, 'utf8'))

  if (validation.errors.length > 0) {
    throw new Error(`Quotation JSON is invalid:\n- ${validation.errors.join('\n- ')}`)
  }
  if (command === 'render' && !quotationPdf && !goodsReceiptPdf && !outputJson) {
    throw new Error('Render requires --quotation-pdf, --goods-receipt-pdf, --output-json, or a combination.')
  }

  const status = await getSoftwareStatus(configPath)
  if (!status.usable || !status.softwarePath) {
    throw new Error(status.configured
      ? `The configured Quotation Software executable is missing: ${status.softwarePath}`
      : 'Quotation Software is not configured. Generate the JSON anyway, then ask the user for the portable .exe path before exporting PDF.')
  }

  const resolvedQuotationPdf = quotationPdf ? resolve(quotationPdf) : undefined
  const resolvedGoodsReceiptPdf = goodsReceiptPdf ? resolve(goodsReceiptPdf) : undefined
  const resolvedOutputJson = outputJson ? resolve(outputJson) : undefined
  const resolvedResultJson = resultJson ? resolve(resultJson) : undefined
  const resolvedProgressJson = progressJson ? resolve(progressJson) : undefined
  const resolvedCancelFile = cancelFile ? resolve(cancelFile) : undefined
  const args = createAutomationArguments({
    command,
    inputFile: resolvedInputFile,
    quotationPdf: resolvedQuotationPdf,
    goodsReceiptPdf: resolvedGoodsReceiptPdf,
    outputJson: resolvedOutputJson,
    resultJson: resolvedResultJson,
    progressJson: resolvedProgressJson,
    cancelFile: resolvedCancelFile,
    refreshExchangeRates,
    noNetwork,
    force,
    timeoutMs,
  })

  for (const outputPath of [
    resolvedQuotationPdf, resolvedGoodsReceiptPdf, resolvedOutputJson, resolvedResultJson, resolvedProgressJson,
  ]) {
    if (outputPath) await mkdir(dirname(outputPath), { recursive: true })
  }
  await getSoftwareApiInfo(configPath, dirname(resolvedResultJson ?? resolvedInputFile))

  const processResult = await runExecutable(status.softwarePath, args)
  const report = resolvedResultJson ? await readJsonIfPresent(resolvedResultJson) : parseStdoutReport(processResult.stdout)

  if (processResult.exitCode !== 0) {
    throw new Error(formatExecutionError(report, processResult))
  }
  for (const outputPath of [
    resolvedQuotationPdf, resolvedGoodsReceiptPdf, resolvedOutputJson, resolvedResultJson, resolvedProgressJson,
  ]) {
    if (outputPath && !(await isFile(outputPath))) {
      throw new Error(`Quotation Software reported success but did not create: ${outputPath}`)
    }
  }

  return {
    softwarePath: status.softwarePath,
    ...(report ?? { ok: true }),
  }
}

export function createAutomationArguments({
  command,
  inputFile,
  quotationPdf,
  goodsReceiptPdf,
  outputJson,
  resultJson,
  progressJson,
  cancelFile,
  refreshExchangeRates = false,
  noNetwork = false,
  force = false,
  timeoutMs,
}) {
  if (!['validate', 'render'].includes(command)) throw new Error('Automation command must be validate or render.')
  if (refreshExchangeRates && noNetwork) {
    throw new Error('--refresh-exchange-rates cannot be used with --no-network.')
  }
  if (command === 'validate' && refreshExchangeRates) {
    throw new Error('--refresh-exchange-rates is only supported by render.')
  }

  return [
    '--automation', command,
    '--input', inputFile,
    ...(quotationPdf ? ['--quotation-pdf', quotationPdf] : []),
    ...(goodsReceiptPdf ? ['--goods-receipt-pdf', goodsReceiptPdf] : []),
    ...(outputJson ? ['--output-json', outputJson] : []),
    ...(resultJson ? ['--result-json', resultJson] : []),
    ...(progressJson ? ['--progress-json', progressJson] : []),
    ...(cancelFile ? ['--cancel-file', cancelFile] : []),
    ...(timeoutMs !== undefined ? ['--timeout-ms', String(timeoutMs)] : []),
    ...(refreshExchangeRates ? ['--refresh-exchange-rates'] : []),
    ...(noNetwork ? ['--no-network'] : []),
    ...(force ? ['--force'] : []),
  ]
}

async function main() {
  const { command, positional, options } = parseArguments(process.argv.slice(2))
  const configPath = options.config || getDefaultConfigPath()

  if (command === 'status') {
    printJson(await getSoftwareStatus(configPath))
    return
  }
  if (command === 'configure') {
    if (!positional[0]) throw new Error('Usage: quotation-software.mjs configure <quotation-software.exe> [--config <config.json>]')
    printJson(await configureSoftware(positional[0], configPath))
    return
  }
  if (command === 'skip-setup') {
    printJson(await acknowledgeMissingSoftware(configPath))
    return
  }
  if (command === 'api-info') {
    printJson(await getSoftwareApiInfo(configPath))
    return
  }
  if (['validate', 'render', 'export'].includes(command)) {
    if (!positional[0]) {
      throw new Error('Usage: quotation-software.mjs validate|render <quotation.json> [automation options]')
    }
    const operation = command === 'validate' ? validateDocument : renderDocuments
    printJson(await operation({
      inputFile: positional[0],
      quotationPdf: options.quotationPdf,
      goodsReceiptPdf: options.goodsReceiptPdf,
      outputJson: options.outputJson,
      resultJson: options.resultJson,
      progressJson: options.progressJson,
      cancelFile: options.cancelFile,
      refreshExchangeRates: options.refreshExchangeRates === true,
      noNetwork: options.noNetwork === true,
      force: options.force === true,
      timeoutMs: options.timeoutMs,
      configPath,
    }))
    return
  }

  throw new Error('Usage: quotation-software.mjs status | api-info | configure <quotation-software.exe> | skip-setup | validate <quotation.json> | render <quotation.json> [options]')
}

function parseArguments(args) {
  const [command, ...rest] = args
  const positional = []
  const options = {}
  const valueOptions = new Map([
    ['--config', 'config'],
    ['--quotation-pdf', 'quotationPdf'],
    ['--goods-receipt-pdf', 'goodsReceiptPdf'],
    ['--output-json', 'outputJson'],
    ['--result-json', 'resultJson'],
    ['--progress-json', 'progressJson'],
    ['--cancel-file', 'cancelFile'],
    ['--timeout-ms', 'timeoutMs'],
  ])

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (argument === '--refresh-exchange-rates') {
      options.refreshExchangeRates = true
      continue
    }
    if (argument === '--no-network') {
      options.noNetwork = true
      continue
    }
    if (argument === '--force' || argument === '--overwrite') {
      options.force = true
      continue
    }
    if (valueOptions.has(argument)) {
      const value = rest[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`Missing value after ${argument}.`)
      options[valueOptions.get(argument)] = value
      index += 1
      continue
    }
    if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`)
    positional.push(argument)
  }

  return { command, positional, options }
}

async function readConfig(configPath) {
  try {
    const value = await readJson(configPath)
    return value?.schemaVersion === configSchemaVersion ? value : null
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error(`Could not read Quotation Software configuration: ${error.message}`)
  }
}

async function writeConfig(configPath, value) {
  const resolvedPath = resolve(configPath)
  await mkdir(dirname(resolvedPath), { recursive: true })
  const temporaryPath = `${resolvedPath}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, resolvedPath)
}

async function readJson(filePath) {
  return JSON.parse((await readFile(resolve(filePath), 'utf8')).replace(/^\uFEFF/, ''))
}

async function readJsonIfPresent(filePath) {
  try {
    return await readJson(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function isExecutableFile(filePath) {
  return extname(filePath).toLowerCase() === '.exe' && await isFile(filePath)
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

export function runExecutable(executablePath, args, executionTimeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executablePath, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timeout = executionTimeoutMs
      ? setTimeout(() => {
          timedOut = true
          terminateProcessTree(child)
        }, executionTimeoutMs)
      : null

    const finish = (callback) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      callback()
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => finish(() => reject(error)))
    child.once('close', exitCode => finish(() => {
      if (timedOut) {
        reject(new Error(`Quotation Software did not exit within ${executionTimeoutMs} ms. The executable may predate the stable automation CLI.`))
        return
      }
      resolvePromise({ exitCode, stdout, stderr })
    }))
  })
}

function terminateProcessTree(child) {
  if (process.platform !== 'win32' || !child.pid) {
    child.kill('SIGKILL')
    return
  }
  const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
  })
  killer.once('error', () => child.kill('SIGKILL'))
}

function parseStdoutReport(stdout) {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index])
    } catch {
      // Portable GUI executables may not expose stdout; --result-json is preferred.
    }
  }
  return null
}

function formatExecutionError(report, processResult) {
  if (Array.isArray(report?.errors) && report.errors.length > 0) {
    return report.errors
      .map((error) => [error?.code, error?.message].filter(Boolean).join(': '))
      .filter(Boolean)
      .join('; ')
  }
  if (typeof report?.error === 'string' && report.error.trim()) return report.error
  if (typeof report?.error?.message === 'string' && report.error.message.trim()) return report.error.message
  return processResult.stderr.trim() || `Quotation Software exited with code ${processResult.exitCode}.`
}

function cleanPathInput(value) {
  const trimmed = String(value ?? '').trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
