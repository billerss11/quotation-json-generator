---
name: quotation-json-generator
description: Generate import-ready quotation-software JSON from natural language, images, PDFs, or extracted tables. Use when source material must become a quotation draft JSON file; do not use for unrelated JSON.
---

# Quotation JSON Generator

Create a complete schema-v2 quotation file that the Quotation Software app can import.

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

6. Fix every validation error. Review warnings and report unresolved assumptions separately; do not add extraction notes or confidence metadata to the quotation JSON.
7. Return a clickable link to the generated JSON. If the quotation editor is open and the user asks for direct import, prefer `window.quotationAgent.importQuotationContent()` or `importQuotationFile()` over UI simulation.

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
- Validate the final file with the bundled helper before delivery.

Use [assets/quotation-v2-template.json](assets/quotation-v2-template.json) only as a manual starting point. Prefer the builder because it creates fresh IDs and timestamps.
