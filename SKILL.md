---
name: quotation-json-generator
description: Create or update import-ready Quotation Software schema-v2 JSON from prose, images, PDFs, or tables; prepare pending or completed goods receipts; and optionally export PDFs through a configured portable Quotation Software executable. Use for quotation or goods-receipt creation, editing, import, automation, validation, or rendering. Do not use for unrelated JSON.
---

# Quotation JSON Generator

Create a complete schema-v2 quotation JSON that works independently of Quotation Software. PDF export and application validation are optional enhancements and must never block JSON generation.

## Load only what the request needs

- Images, scans, PDFs, or copied tables: read [references/extraction-guide.md](references/extraction-guide.md).
- Nested groups, manual prices, multiple currencies, taxes, extra charges, section headers, or unfamiliar fields: read [references/schema-v2.md](references/schema-v2.md).
- Pending or completed goods receipts: read [references/goods-receipt.md](references/goods-receipt.md).
- PDF export, portable-app setup, or application validation: read [references/software-pdf.md](references/software-pdf.md).
- Matching or auditing document-affecting GUI settings: read [references/gui-parity.md](references/gui-parity.md).
- Direct work in an already open editor: read [references/agent-api-v2.md](references/agent-api-v2.md).

Receipt modes are distinct: use `quotation.pendingGoodsReceiptDraft` for a receipt the user will edit or export through **Generate GR**; use `quotation.goodsReceiptHistory` only for an already completed/exported receipt or an explicitly requested archival record.

## Workflow

1. Inspect every supplied source. Extract evidence into a partial quotation object while keeping hierarchy, quantities, units, currencies, pricing meaning, markup, and tax assignments separate.
2. Do not invent commercial facts. Use builder defaults only when the missing value can remain editable, and disclose those defaults. Ask when ambiguity would materially change totals or structure.
3. Save the partial object as UTF-8 JSON, then build and validate:

   ```powershell
   node <skill-folder>\scripts\quotation-json.mjs build <partial.json> <quotation.json>
   node <skill-folder>\scripts\quotation-json.mjs validate <quotation.json>
   ```

4. For receipt work, follow `goods-receipt.md` and run the appropriate helper command. Validate the resulting complete quotation again.
5. Fix every validation error. Resolve builder warnings where possible; otherwise disclose them separately. Keep extraction notes, confidence, defaults, and assumptions outside the quotation JSON.
6. When application validation or PDF output is relevant, follow `software-pdf.md`. Offline validation comes first. If the executable is missing or incompatible, still deliver the validated JSON.
7. Return a clickable link to the final JSON. Export requested PDFs only after validation succeeds, and verify each output exists before reporting success.

## Non-negotiable rules

- Always generate schema version 2, even when examples or inputs use version 1.
- JSON creation and offline validation must not depend on an executable path, application availability, network access, or PDF success. Never store the executable path in quotation JSON.
- Validate the final file with the bundled helper. When the configured application is used, treat its V2 structured validation issues as authoritative.
- Preserve source wording and row order unless the user asks for cleanup.
- Keep quotation item hierarchy to three levels maximum. Section headers are root-only.
- Use unique IDs; the builder creates fresh UUIDs for missing or duplicated IDs.
- Compose final JSON values for document-affecting GUI controls. Do not require a separate CLI mutation for state that belongs in schema-v2 JSON.
- Treat `manualUnitPrice` as a unit selling price only when the evidence clearly says so. Divide a line total by quantity only when its meaning and a nonzero quantity are explicit.
- `expectedTotal` is only a group mismatch check; it never supplies or changes a price.
- Never guess exchange rates. Each non-base item currency needs an explicit rate in quotation direction: `1 item currency = rate base currency`.
- Missing monetary values may default to zero only as disclosed, editable placeholders—not inferred prices.
- Do not silently repair currencies, malformed rates, charges, or other supplied commercial data. Resolve or disclose every warning.
- Derive goods-receipt lines and quoted quantities from the quotation. If the user does not specify receipt selection, use the app-matching `detailed` default of positive-quantity leaf lines and disclose it.
- Use the configured Quotation Software for quotation and goods-receipt PDFs. If unavailable, report the PDF as pending; do not substitute another renderer.
- Enforce the shared limits: quotation JSON at most 10 MB; serialized pending receipt at most 5 MB; logo must be PNG/JPEG/GIF/WebP, at most 5 MB and 4096 x 4096 pixels.

Use [assets/quotation-v2-template.json](assets/quotation-v2-template.json) only as a manual starting point. Prefer the builder because it creates fresh IDs and timestamps.
