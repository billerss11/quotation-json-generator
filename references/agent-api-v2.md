# Open-editor automation API V2

Use this mode only when the quotation editor is already open and the user wants direct import, adjustment, validation, or export. The API is a renderer JavaScript API, not HTTP.

## Readiness and discovery

```js
const info = await window.quotationAgentReady
const api = window.quotationAgentV2
if (!api) throw new Error('Quotation automation API V2 is unavailable')
```

Call `api.getApiInfo()` when capabilities matter. Path import/export and direct PDF export require desktop/headless capability; browser automation should use content methods and browser print. Use `window.quotationAgent` only when V2 is unavailable and the required legacy method exists.

## Preferred workflow

1. Import a complete offline-generated file with `importQuotationContent(content, name?)`, or create a new quotation with `createQuotation(input?)`.
2. Use semantic methods for changes: header/settings methods, stable-ID item-tree methods, pricing/tax/exchange-rate methods, or goods-receipt draft methods.
3. Use `applyOperations({ expectedRevision, operations })` when supported changes must be atomic. A revision conflict means the open quotation changed; read a fresh snapshot before retrying.
4. Run `validateQuotation()` and then `validateForExport({ document: 'quotation' })` or `validateForExport({ document: 'goods_receipt' })` before exporting.
5. Serialize or save the resulting state through `serializeQuotation()` or `saveQuotationToFile()` when the user needs updated JSON.

Every V2 call returns a discriminated result. Check `result.ok`; report structured error/issue codes and field paths instead of reducing them to an untraceable message.

## Reusable libraries

When the user identifies an existing customer or seller profile, use `listCustomers` / `getCustomer` / `applyCustomer` or `listCompanyProfiles` / `getCompanyProfile` / `applyCompanyProfile`. Do not guess a library ID or fabricate a snapshot. Offline JSON generation remains valid with `companyProfileId: null` and an evidence-based snapshot.

## Goods receipts

Use `createGoodsReceiptDraft`, edit its header and stable line IDs, apply a selection preset when appropriate, and run `validateGoodsReceiptDraft`. Successful direct goods-receipt PDF export clears the pending draft and records completed history. Browser Print does not perform that bookkeeping.
