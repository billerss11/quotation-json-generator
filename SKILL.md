---
name: quotation-json-generator
description: Create or update import-ready Quotation Software JSON from prose, images, PDFs, or tables, preserving schema-v4 revision history. Create, restore, or delete requested revisions, prepare goods receipts, and export PDFs through a compatible configured app. Use for quotation or goods-receipt authoring, revision management, validation, or rendering; not unrelated JSON.
---

# Quotation JSON Generator

Create a complete schema-v4 quotation JSON that works independently of Quotation Software. PDF export and application validation are optional enhancements and must never block JSON generation. The envelope contains a working `quotation`, a separate `revisions` array, and one `images` table shared by all versions; new quotations start with empty history.

## Load only what the request needs

- Images, scans, PDFs, or copied tables: read [references/extraction-guide.md](references/extraction-guide.md).
- Nested groups, manual prices, currencies, taxes, extra charges, section headers, custom subtotal wording, breakdown notes, informational totals, or unfamiliar fields: read [references/schema-v4.md](references/schema-v4.md).
- Existing history, a new revision, restoration, deletion, or viewing an earlier offer: read [references/revisions.md](references/revisions.md).
- Pending or completed goods receipts: read [references/goods-receipt.md](references/goods-receipt.md).
- PDF export, portable-app setup, or application validation: read [references/software-pdf.md](references/software-pdf.md).
- Matching or auditing document-affecting GUI settings: read [references/gui-parity.md](references/gui-parity.md).
- Direct work in an already open editor: read [references/agent-api-v2.md](references/agent-api-v2.md).

Receipt modes are distinct: use `quotation.pendingGoodsReceiptDraft` for a receipt the user will edit or export through **Generate GR**; use `quotation.goodsReceiptHistory` only for an already completed/exported receipt or an explicitly requested archival record.

For a maintained portable build with a `current-portable.json` manifest, use the `configure-current` setup described in `software-pdf.md` so later builds are discovered automatically. Direct `.exe` configuration remains supported for a fixed build.

## Workflow

1. Inspect every supplied source. For an existing JSON, keep the complete envelope, including `revisions`; do not extract only `quotation` and silently lose history. For a new quotation, extract evidence into a partial quotation object while keeping hierarchy, quantities, units, currencies, pricing meaning, markup, and tax assignments separate.
2. If a new revision was requested, follow `revisions.md` to archive the unchanged source **before** applying requested edits. Do not invent commercial facts or missing history. Use builder defaults only when the missing value can remain editable, and disclose those defaults. Ask when ambiguity would materially change totals or structure.
3. Save the partial object as UTF-8 JSON, then build and validate:

   ```powershell
   node <skill-folder>\scripts\quotation-json.mjs build <partial.json> <quotation.json> --json
   node <skill-folder>\scripts\quotation-json.mjs validate <quotation.json> --json
   ```

4. Follow `revisions.md` for requested restore/delete operations and `goods-receipt.md` for receipt work. Ordinary edits update the working quotation and retain existing history. Validate the resulting complete envelope again.
5. Fix every validation error. Resolve builder warnings where possible; otherwise disclose them separately. When totals matter, run `quotation-json.mjs summarize <quotation.json>` instead of recalculating them in prose. Keep extraction notes, confidence, defaults, and assumptions outside the quotation JSON.
6. When application validation or PDF output is relevant, follow `software-pdf.md`. Offline validation comes first. If the executable is missing or incompatible, still deliver the validated JSON.
7. Return a clickable link to the final JSON. Export requested PDFs only after validation succeeds, and verify each output exists before reporting success.

Keep command output compact: use `--json` for offline commands and `--compact` plus `--result-json` for application commands. Read the full result file only when the compact result reports errors, warnings, or details needed by the request.

## Non-negotiable rules

- Generate schema version 4. The offline validator accepts legacy versions 2 and 3, and the builder upgrades legacy inputs without inventing earlier revisions. Never downgrade a history-bearing file for an older app.
- JSON creation and offline validation must not depend on an executable path, application availability, network access, or PDF success. Never store the executable path in quotation JSON.
- Validate the final file with the bundled helper. When the configured application is used, treat its V2 structured validation issues as authoritative.
- Preserve source wording and row order unless the user asks for cleanup.
- Keep quotation item hierarchy to three levels maximum. Section headers are root-only.
- Preserve the image table and `logoImageId` references when editing v4; read `schema-v4.md` before changing images. New partial inputs may use inline `logoDataUrl`; all saved outputs use v4 shared images.
- Keep the quotation family ID and all saved revision IDs/content unchanged. The builder supplies IDs for new working content; saved snapshots are validated rather than repaired or renumbered.
- Compose final JSON values for document-affecting GUI controls. Do not require a separate CLI mutation for state that belongs in the quotation JSON.
- Store custom subtotal wording, breakdown notes, and informational section/item selections in `outputSettings`. Preserve supplied note text, including blank strings and line breaks; note omission and blank text have different meanings in `schema-v4.md`. These settings never change prices. Resolve selections to existing stable IDs; use the helper's `summaryDisplay` results to check their calculated sums.
- Saved revisions are read-only. Use the create/restore/delete helpers for requested lifecycle changes; never emulate them by changing `header.revisionNumber`. Delete only a saved revision the user has asked to remove.
- Treat `manualUnitPrice` as a unit selling price only when the evidence clearly says so. Divide a line total by quantity only when its meaning and a nonzero quantity are explicit.
- `expectedTotal` is only a group mismatch check; it never supplies or changes a price.
- Never guess exchange rates. Each non-base item currency needs an explicit rate in quotation direction: `1 item currency = rate base currency`.
- Missing monetary values may default to zero only as disclosed, editable placeholders—not inferred prices.
- Do not silently repair currencies, malformed rates, charges, or other supplied commercial data. Resolve or disclose every warning.
- Derive goods-receipt lines and quoted quantities from the quotation. If the user does not specify receipt selection, use the app-matching `detailed` default of positive-quantity leaf lines and disclose it.
- Use the configured Quotation Software for quotation and goods-receipt PDFs. If unavailable, report the PDF as pending; do not substitute another renderer.
- Enforce the shared limits: the complete quotation JSON, including shared images and history, is at most 10 MiB of stored UTF-8 bytes; serialized pending receipt at most 5 MiB; logo must be PNG/JPEG/GIF/WebP, at most 5 MiB and 4096 x 4096 pixels. Deduplicate identical image strings without changing their bytes; never resize/recompress logos or discard history to fit the limit.

Use [assets/quotation-v4-template.json](assets/quotation-v4-template.json) only as a manual starting point. Prefer the builder because it creates fresh IDs and timestamps. The retained v2/v3 templates are legacy examples, not the default output.

## Maintenance checks

Calculation, import, revision, and summary-display behavior verified on 2026-10-15 against the working checkout based on commit `df7f1a23e68d6c1b680083b978f7c534bc7dff96`, including its uncommitted shared-image, summary-display, and editable-note changes (file schema 4; renderer API 2.2.0). This is source parity, not proof that a packaged EXE contains those changes. The offline helper remains independent of the repository and executable. The software helper checks schema support and round-trips summary settings when present; API/schema version numbers alone do not establish support for these newer optional fields.

When changing the helper or syncing repository behavior, run:

```powershell
node --test <skill-folder>\scripts\quotation-json.test.mjs <skill-folder>\scripts\quotation-software.test.mjs
node <skill-folder>\scripts\quotation-json.mjs self-test
node <skill-folder>\scripts\verify-repo-parity.mjs <quotation-software-repo>
```

The optional parity check uses the checkout's existing Vite installation, compares actual import/calculation results, and prints the verified commit. Do not make it a prerequisite for ordinary JSON generation. Evaluation file paths in `evals/evals.json` are relative to the skill folder; fixtures are bundled under `evals/fixtures/`.
