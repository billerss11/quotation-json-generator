---
name: quotation-json-generator
description: Generate or update import-ready Quotation Software JSON from natural language, images, PDFs, or extracted tables, including pending goods-receipt drafts and completed receipt history. Do not use for unrelated JSON.
---

# Quotation JSON Generator

Create a complete schema-v2 quotation file that the Quotation Software app can import. A prepared receipt that should open in **Generate GR** is stored as `quotation.pendingGoodsReceiptDraft`. Successfully exported receipts move into `quotation.goodsReceiptHistory`.

## Choose a mode

- **Quotation mode:** build a quotation from source material.
- **Pending goods-receipt mode:** prepare the receipt that the GUI should load after import. Use this when the user supplies quotation and goods-receipt information together.
- **Goods-receipt history mode:** add an already completed/exported receipt record.

Read [references/goods-receipt.md](references/goods-receipt.md) before either goods-receipt mode. Do not use history mode merely to prefill the GUI.

## Workflow

1. Inspect every supplied source. For PDFs or images, read [references/extraction-guide.md](references/extraction-guide.md) before extracting.
2. Convert the evidence into a partial quotation object. Keep hierarchy, quantities, units, currencies, pricing meaning, markup, and tax assignments separate.
3. Read [references/schema-v2.md](references/schema-v2.md) whenever the request includes nested groups, manual selling prices, multiple currencies, taxes, extra charges, or section headers.
4. Do not invent commercial facts. If missing information can be safely left editable, use the helper defaults and disclose the default. Ask only when an ambiguity would materially change the quotation total or structure.
5. Save the partial object as UTF-8 JSON, then build the final file:

   ```powershell
   node <skill-folder>\scripts\quotation-json.mjs build <partial.json> <quotation.json>
   node <skill-folder>\scripts\quotation-json.mjs validate <quotation.json>
   ```

6. To prepare a receipt for the GUI, save the receipt fields as a second UTF-8 JSON file and set the pending draft in the same quotation JSON:

   ```powershell
   node <skill-folder>\scripts\quotation-json.mjs set-goods-receipt-draft <quotation.json> <receipt.json> <quotation-with-receipt.json>
   node <skill-folder>\scripts\quotation-json.mjs validate <quotation-with-receipt.json>
   ```

7. Use history mode only for a receipt that is already completed/exported:

   ```powershell
   node <skill-folder>\scripts\quotation-json.mjs add-goods-receipt <quotation.json> <receipt.json> <quotation-with-receipt.json>
   node <skill-folder>\scripts\quotation-json.mjs validate <quotation-with-receipt.json>
   ```

8. Fix every validation error. Review warnings and report unresolved assumptions separately; do not add extraction notes or confidence metadata to the quotation JSON.
9. Return a clickable link to the generated JSON. If the quotation editor is open and the user asks for direct import, prefer `window.quotationAgent.importQuotationContent()` or `importQuotationFile()` over UI simulation.

## Required behavior

- Generate schema version 2, even when an example uses legacy version 1.
- Preserve source wording and row order unless the user asks for cleanup.
- Keep quotation hierarchy to at most three item levels. Section headers are root-only.
- Use unique IDs. The helper creates UUIDs when IDs are absent or duplicated.
- Treat `manualUnitPrice` as the selling price only when the source clearly gives a unit selling price. Divide a line total by quantity only when that meaning is explicit.
- Never use `expectedTotal` as a substitute for a price. It only records an expected group total for mismatch checking.
- Never guess exchange rates. A non-base item currency requires an explicit rate in quotation direction.
- Missing monetary values default to zero and must be disclosed. Zero is an editable placeholder, not an inferred price.
- Do not silently repair supplied currencies or discard malformed exchange rates or extra charges. Resolve every builder warning before delivery, or disclose it to the user.
- Map customer PO numbers to `customerReference`, delivery or dispatch document numbers to `deliveryReference`, delivery destination text to `deliveryAddress`, and general receipt notes to `remarks`. Do not put these values in the quotation header.
- Derive goods-receipt lines and quoted quantities from the quotation. The default `detailed` selection uses positive-quantity leaf lines, matching the app; disclose this default when the user did not state which items or quantities were received.
- For explicit receipt inclusion/exclusion, set matching line overrides to `selected: true` or `selected: false`. Use received `quantity` and line `remarks` only when supplied or clearly implied.
- When the user wants to import the JSON and then edit/export the receipt in the GUI, generate `pendingGoodsReceiptDraft`, not a history record.
- Preserve a real exported PDF path in the history record's `filePath` when supplied. An empty path is allowed with a warning, but it does not prove that the receipt was exported.
- A successful direct PDF export clears `pendingGoodsReceiptDraft` and adds the completed snapshot to `goodsReceiptHistory`. Browser Print leaves the pending draft unchanged.
- Validate the final file with the bundled helper before delivery.

Use [assets/quotation-v2-template.json](assets/quotation-v2-template.json) only as a manual starting point. Prefer the builder because it creates fresh IDs and timestamps.
