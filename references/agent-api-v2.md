# Open-editor automation API V2

Use this mode only when the quotation editor is already open and the user wants direct import, adjustment, validation, or export. The API is a renderer JavaScript API, not HTTP.

## Readiness and discovery

```js
const info = await window.quotationAgentReady
const api = window.quotationAgentV2
if (!api) throw new Error('Quotation automation API V2 is unavailable')
```

Call `api.getApiInfo()` when capabilities matter. The current renderer API is 2.2.0 and file schema is 3; discover both instead of comparing app-version strings. Path import/export and direct PDF export require desktop/headless capability; browser automation should use content methods and browser print. Legacy methods have no revision-management contract, so never fall back to them for revision operations.

## Preferred workflow

1. Import a complete offline-generated file with `importQuotationContent(content, name?)`, or create a new quotation with `createQuotation(input?)`.
2. Use semantic methods for changes: header/settings methods, stable-ID item-tree methods, pricing/tax/exchange-rate methods, or goods-receipt draft methods.
3. Use `applyOperations({ expectedRevision, operations })` when supported changes must be atomic. A revision conflict means the open quotation changed; read a fresh snapshot before retrying.
4. Run `validateQuotation()` and then `validateForExport({ document: 'quotation' })` or `validateForExport({ document: 'goods_receipt' })` before exporting.
5. Serialize or save the resulting state through `serializeQuotation()` or `saveQuotationToFile()` when the user needs updated JSON.

`serializeQuotation().data.content` is the complete history-preserving JSON. `getQuotationSnapshot().data.quotation` is only the working draft; serializing that alone loses history. `meta.revision` / `expectedRevision` are renderer-session concurrency counters, distinct from the saved archive ID and `quotation.header.revisionNumber`.

Most V2 operations return a discriminated result. Check the outer `result.ok` first; `getApiInfo()` and `waitUntilReady()` instead return API information directly. Successful validation calls still require checking `result.data.valid`. Successful goal-seek calls still require checking the nested `result.data.ok` before claiming a solved price or applying its markup.

Item goal seek may return `data.ok: false` with `reason: 'target_unreachable'` when cent rounding and four-decimal markup precision cannot reproduce the target. Quotation goal seek can report the closest amount/rate; do not describe that diagnostic as an exact solution. Both item and quotation successful solves use canonical prices, including mixed-tax rounding for the selected quotation target. Report structured issue codes and field paths.

The quotation currency's rate is locked to `1` inside `applyOperations` as well as individual FX calls. A batch that tries to change it fails with `base_currency_locked` before any following goal seek is applied. A currency rebase outside the supported rate range is rejected as a whole.

## Quotation revisions

Read [revisions.md](revisions.md) for operation semantics. Reads require `info.capabilities.revisionRead`; desktop/headless mutations require `revisionWrite` and the corresponding method. API 2.2 adds deletion. Browser revision reads work, but create/restore/delete return `unsupported_operation`.

```js
const info = await api.getApiInfo()
if (!info.capabilities.revisionRead) throw new Error('This build cannot read revision history')
const history = await api.listQuotationRevisions()
if (!history.ok) throw new Error(history.error.code)

// Resolve a user-requested business number to the returned archive ID.
const saved = history.data.find(entry => entry.revisionNumber === requestedRevisionNumber)
if (!saved) throw new Error('Requested saved revision does not exist')
const snapshot = await api.getQuotationRevision(saved.id)
if (!snapshot.ok) throw new Error(snapshot.error.code)

// Only when the user asked for this PDF; the active quotation stays unchanged.
const pdf = await api.exportPdfToFile(outputPdfPath, { quotationRevisionId: saved.id })
if (!pdf.ok) throw new Error(pdf.error.code)
```

For requested mutations, use `createQuotationRevision({ note?, filePath? })`, `restoreQuotationRevision(id, { filePath? })`, or `deleteQuotationRevision(id, { filePath? })`. The app persists the full document before committing the change. An unsaved quotation requires an explicit path; automation does not open a save dialog. Do not assign `revisionNumber` to switch views or create history.

`cacheWarning: true` is a successful file write with a recovery-cache problem, not permission to retry the mutation. On `history_unavailable`, reopen the original complete JSON; **Load Latest** contains only a recovery draft. On `operation_in_progress`, wait for the existing operation to settle and inspect the current document before deciding whether a retry is still needed.

## Reusable libraries

When the user identifies an existing customer or seller profile, use `listCustomers` / `getCustomer` / `applyCustomer` or `listCompanyProfiles` / `getCompanyProfile` / `applyCompanyProfile`. Do not guess a library ID or fabricate a snapshot. Offline JSON generation remains valid with `companyProfileId: null` and an evidence-based snapshot.

## Goods receipts

Use `createGoodsReceiptDraft`, edit its header and stable line IDs, apply a selection preset when appropriate, and run `validateGoodsReceiptDraft`. Successful direct goods-receipt PDF export clears the pending draft and records completed history. Browser Print does not perform that bookkeeping.
