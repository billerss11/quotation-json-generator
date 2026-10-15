---
name: quotation-json-generator
description: Create or update import-ready schema-v4 quotation JSON from prose, images, PDFs, or tables. Preserve and manage requested revisions, prepare goods receipts, validate files, and export PDFs through a compatible configured Quotation Software app. Not for unrelated JSON.
---

# Quotation JSON Generator

Deliver complete schema-v4 JSON independently of application availability or PDF success. New quotations have empty revision history; existing files retain the complete envelope and shared images. Accept only v4 files and unversioned partial inputs for new quotations. Reject schema versions 1–3; do not migrate or downgrade them.

## Read when relevant

- Images, scans, PDFs, copied tables: [extraction-guide.md](references/extraction-guide.md).
- Unfamiliar fields, hierarchy, pricing, tax, currencies, summary settings, or logo changes: [schema-v4.md](references/schema-v4.md).
- Existing history or requested create/restore/delete/view: [revisions.md](references/revisions.md).
- Receipt drafts or completed receipts: [goods-receipt.md](references/goods-receipt.md).
- PDF export, app setup, or app validation: [software-pdf.md](references/software-pdf.md).
- Matching document-affecting GUI controls: [gui-parity.md](references/gui-parity.md).
- Direct work in an already open editor: [agent-api-v2.md](references/agent-api-v2.md).
- Updating helpers or checking source parity: [maintenance.md](references/maintenance.md).

## Build and deliver

1. Inspect every source. Preserve wording, row order, hierarchy, quantities, units, price meaning, markup, tax assignments, and currencies. Ask when ambiguity materially changes totals or structure. Do not invent commercial facts or missing history; disclose editable defaults and uncertain extraction outside the JSON.
2. For a new quotation, save an unversioned partial quotation as UTF-8 JSON. For an existing file, edit only the working `quotation` and rebuild the complete v4 envelope. A requested new revision must archive the unchanged source **before** edits; use the revision helpers for lifecycle changes.
3. Build and validate with the bundled helper:

   ```powershell
   node <skill-folder>\scripts\quotation-json.mjs build <input.json> <quotation.json> --json
   node <skill-folder>\scripts\quotation-json.mjs validate <quotation.json> --json
   ```

4. Fix all errors; resolve warnings or disclose them. When totals matter, use `quotation-json.mjs summarize <quotation.json> --json`. Validate again after revision or receipt changes. [quotation-v4-template.json](assets/quotation-v4-template.json) is a manual starting point; the builder supplies fresh IDs and timestamps.
5. Return a clickable link to the validated JSON. Follow `software-pdf.md` for requested app validation/PDFs, treating the app's V2 structured issues as authoritative. If unavailable or incompatible, deliver the JSON and report PDF/app validation as pending. Verify output files before claiming PDF success.

Use compact results: offline `--json`; app `--compact --result-json <path>`. Read full app reports only for errors, warnings, or needed details. Configuration paths never belong in quotation JSON.

## Preserve meaning and history

- Keep item hierarchy within three levels and section headers at the root.
- Preserve quotation family ID, saved revision IDs, and decoded snapshot contents exactly. Saved revisions are read-only; never repair, renumber, fabricate, or delete them except through the requested lifecycle operation. Changing `header.revisionNumber` does not create or restore history.
- Preserve the full `images` table and `logoImageId` references during ordinary edits. For logo changes, decode the envelope, edit expanded `logoDataUrl`, then encode to v4 before building; see `schema-v4.md`.
- `manualUnitPrice` is a unit selling price only when supported by evidence. Divide a line total only when its meaning and a nonzero quantity are explicit. `expectedTotal` checks group mismatches and never supplies a price.
- Never guess exchange rates: `1 item currency = rate base currency`. Unknown monetary values may be zero only as disclosed editable placeholders. Do not silently repair supplied rates, currencies, charges, or other commercial data.
- Compose document-affecting state in JSON. Custom subtotal wording, breakdown notes, and informational selections belong in `outputSettings` and never change prices. Preserve note text, blanks, and line breaks; omission differs from blank. Resolve selections to existing stable IDs and check `summaryDisplay` sums.
- Use `pendingGoodsReceiptDraft` for a receipt to edit/export through **Generate GR**; use `goodsReceiptHistory` only for completed/exported receipts or explicitly requested archives. Derive lines and quoted quantities from the quotation. If selection is unspecified, disclose the `detailed` default of positive-quantity leaves.
- Use configured Quotation Software for quotation/receipt PDFs. Do not substitute a renderer. App setup and exports never block offline JSON generation.
- Stored JSON including history/images: at most 10 MiB UTF-8; pending receipt: at most 5 MiB serialized UTF-8; logo: PNG/JPEG/GIF/WebP, at most 5 MiB and 4096 × 4096 pixels. Deduplicate exact image strings without altering bytes. Never resize/recompress logos or discard history to fit.
