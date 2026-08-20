#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { validateQuotationEnvelope } from './quotation-json.mjs'

const configSchemaVersion = 1

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

export async function exportDocuments({
  inputFile,
  quotationPdf,
  goodsReceiptPdf,
  resultJson,
  refreshExchangeRates = false,
  configPath = getDefaultConfigPath(),
}) {
  const resolvedInputFile = resolve(inputFile)
  const quotation = await readJson(resolvedInputFile)
  const validation = validateQuotationEnvelope(quotation)

  if (validation.errors.length > 0) {
    throw new Error(`Quotation JSON is invalid:\n- ${validation.errors.join('\n- ')}`)
  }
  if (!quotationPdf && !goodsReceiptPdf) {
    throw new Error('PDF export requires --quotation-pdf, --goods-receipt-pdf, or both.')
  }

  const status = await getSoftwareStatus(configPath)
  if (!status.usable || !status.softwarePath) {
    throw new Error(status.configured
      ? `The configured Quotation Software executable is missing: ${status.softwarePath}`
      : 'Quotation Software is not configured. Generate the JSON anyway, then ask the user for the portable .exe path before exporting PDF.')
  }

  const resolvedQuotationPdf = quotationPdf ? resolve(quotationPdf) : undefined
  const resolvedGoodsReceiptPdf = goodsReceiptPdf ? resolve(goodsReceiptPdf) : undefined
  const resolvedResultJson = resultJson ? resolve(resultJson) : undefined
  const args = [
    '--headless-export',
    '--input',
    resolvedInputFile,
    ...(resolvedQuotationPdf ? ['--quotation-pdf', resolvedQuotationPdf] : []),
    ...(resolvedGoodsReceiptPdf ? ['--goods-receipt-pdf', resolvedGoodsReceiptPdf] : []),
    ...(refreshExchangeRates ? ['--refresh-exchange-rates'] : []),
    ...(resolvedResultJson ? ['--result-json', resolvedResultJson] : []),
  ]

  for (const outputPath of [resolvedQuotationPdf, resolvedGoodsReceiptPdf, resolvedResultJson]) {
    if (outputPath) await mkdir(dirname(outputPath), { recursive: true })
  }

  const processResult = await runExecutable(status.softwarePath, args)
  const report = resolvedResultJson ? await readJsonIfPresent(resolvedResultJson) : parseStdoutReport(processResult.stdout)

  if (processResult.exitCode !== 0) {
    throw new Error(report?.error || processResult.stderr.trim() || `Quotation Software exited with code ${processResult.exitCode}.`)
  }
  for (const outputPath of [resolvedQuotationPdf, resolvedGoodsReceiptPdf]) {
    if (outputPath && !(await isFile(outputPath))) {
      throw new Error(`Quotation Software reported success but did not create: ${outputPath}`)
    }
  }

  return {
    softwarePath: status.softwarePath,
    ...(report ?? { ok: true }),
  }
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
  if (command === 'export') {
    if (!positional[0]) {
      throw new Error('Usage: quotation-software.mjs export <quotation.json> [--quotation-pdf <pdf>] [--goods-receipt-pdf <pdf>] [--refresh-exchange-rates] [--result-json <json>] [--config <config.json>]')
    }
    printJson(await exportDocuments({
      inputFile: positional[0],
      quotationPdf: options.quotationPdf,
      goodsReceiptPdf: options.goodsReceiptPdf,
      resultJson: options.resultJson,
      refreshExchangeRates: options.refreshExchangeRates === true,
      configPath,
    }))
    return
  }

  throw new Error('Usage: quotation-software.mjs status | configure <quotation-software.exe> | skip-setup | export <quotation.json> [PDF options]')
}

function parseArguments(args) {
  const [command, ...rest] = args
  const positional = []
  const options = {}
  const valueOptions = new Map([
    ['--config', 'config'],
    ['--quotation-pdf', 'quotationPdf'],
    ['--goods-receipt-pdf', 'goodsReceiptPdf'],
    ['--result-json', 'resultJson'],
  ])

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (argument === '--refresh-exchange-rates') {
      options.refreshExchangeRates = true
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

function runExecutable(executablePath, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executablePath, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', exitCode => resolvePromise({ exitCode, stdout, stderr }))
  })
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
