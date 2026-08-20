---
name: quotation-json-generator
description: Generate or update import-ready Quotation Software schema-v2 JSON from natural language, images, PDFs, or extracted tables, including pending goods-receipt drafts and completed receipt history; optionally export quotation and goods-receipt PDFs through a user-configured portable Quotation Software executable. Use whenever the user asks to create, edit, import, automate, or render a quotation or goods receipt. JSON generation must work without the application. Do not use for unrelated JSON.
---

# Quotation JSON Generator

Create a complete schema-v2 quotation file that the Quotation Software app can import. The JSON file is the primary, independent artifact: build and validate it whether or not Quotation Software is installed or configured. PDF export is an optional second step that must use the configured portable application.

A prepared receipt that should open in **Generate GR** is stored as `quotation.pendingGoodsReceiptDraft`. Successfully exported receipts may be recorded in `quotation.goodsReceiptHistory`.

## First-run software setup

At the start of an invocation, run:

```powershell
node <skill-folder>\scripts\quotation-software.mjs status
```

If `setupAcknowledged` is `false`, ask the user for the full portable Quotation Software `.exe` path, or let them say they do not have it. Treat this as non-blocking setup: continue generating the requested JSON while waiting for the answer. Configure or remember the answer using [references/software-pdf.md](references/software-pdf.md).

Never store the executable path inside quotation JSON. A missing, moved, or unconfigured executable disables only PDF export; it never disables or delays JSON generation.

## Choose a mode

- **Quotation mode:** build a quotation from source material.
- **Pending goods-receipt mode:** prepare the receipt that the GUI should load after import. Use this when the user supplies quotation and goods-receipt information together.
- **Goods-receipt history mode:** add an already completed/exported receipt record.
- **PDF delivery:** after the JSON is valid, ask the configured application to export the quotation PDF, goods-receipt PDF, or both.

Read [references/goods-receipt.md](references/goods-receipt.md) before either goods-receipt mode. Do not use history mode merely to prefill the GUI.
Read [references/software-pdf.md](references/software-pdf.md) whenever PDF is requested. Read [references/gui-parity.md](references/gui-parity.md) when composing or reviewing a complete quotation so every document-affecting GUI choice is represented.

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
9. Return a clickable link to the generated JSON even when PDF export is unavailable or fails.
10. When PDF is requested, export only after step 8 succeeds. Use `scripts/quotation-software.mjs export`; do not simulate clicks or recreate the PDF in another tool. Verify each requested PDF exists before reporting success.
11. If the quotation editor is already open and the user asks for direct import or adjustment, prefer `window.quotationAgent` over UI simulation when its named method supports the action.

## Required behavior

- Generate schema version 2, even when an example uses legacy version 1.
- JSON creation and validation must not depend on the software path, application availability, or PDF success.
- Compose the final JSON state for document-affecting GUI controls. Do not require a separate CLI mutation when the same state belongs in schema-v2 JSON.
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
- Headless PDF export uses temporary application storage and does not rewrite the input JSON. Keep the original JSON deliverable; add a completed receipt history record explicitly when the user requests that archival state.
- Use the configured application for every quotation or goods-receipt PDF. If it is unavailable, deliver JSON and state that PDF is pending rather than substituting another renderer.
- Validate the final file with the bundled helper before delivery.

Use [assets/quotation-v2-template.json](assets/quotation-v2-template.json) only as a manual starting point. Prefer the builder because it creates fresh IDs and timestamps.
