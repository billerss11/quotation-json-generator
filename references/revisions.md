# Quotation revision workflows

Use the complete schema-v3 envelope throughout editing: `{ schemaVersion, app, exportedAt, quotation, revisions }`. A new quotation has `revisions: []`. Existing schema-v2 quotations can be upgraded without inventing earlier offers, even if their printed revision number is greater than 1.

## Choose the requested operation

| User intent | Operation |
| --- | --- |
| Change a price, note, or item in the current draft | Edit only `quotation`, then build/validate the complete envelope. Keep all `revisions` unchanged. |
| Create the next revision or keep the current offer before editing | Create a revision first, then edit the next working quotation. |
| View or switch to an older offer | Read its saved snapshot. Do not restore or change the working quotation merely to view it. |
| Restore an earlier offer for further editing | Restore as a new working revision; the current work is archived first. |
| Remove a specified saved revision | Delete that archive only. If the target is ambiguous, identify it before deleting. |

The app's sidebar revision number is read-only. Saved revisions are selected by stable archive ID, not by changing `quotation.header.revisionNumber`. The toolbar selector switches between saved read-only views and the current working draft.

## Offline commands

These commands work without the application or a network connection. Use a new output path by default; replace a source file only when the user requested an in-place update.

```powershell
# Read archive IDs, revision numbers, timestamps, and notes.
node <skill-folder>\scripts\quotation-json.mjs list-revisions <quotation.json> --json

# Freeze the current working revision, then start the next number.
node <skill-folder>\scripts\quotation-json.mjs create-revision <quotation.json> <next.json> --note "Customer offer" --json

# Preserve current work, then restore the selected snapshot into the next revision.
node <skill-folder>\scripts\quotation-json.mjs restore-revision <quotation.json> <revision-id> <restored.json> --json

# Delete only the requested archive; current and remaining revision numbers do not change.
node <skill-folder>\scripts\quotation-json.mjs delete-revision <quotation.json> <revision-id> <updated.json> --json

node <skill-folder>\scripts\quotation-json.mjs validate <updated.json> --json
```

When the user asks for a new revision with changes, run `create-revision` on the unmodified source first. Apply requested changes to the resulting working `quotation`, retaining the complete envelope, then run `build` and `validate`. Do not create the historical snapshot after applying the new prices.

Create and restore preserve the quotation family ID, archive the current working quotation, and advance its number by one. Restore retains the current completed `goodsReceiptHistory` and clears `pendingGoodsReceiptDraft` in the new working revision. Earlier snapshots and their receipt data remain unchanged.

Deletion never creates a replacement archive or renumbers anything. Deleting the final archive leaves `revisions: []`; the working revision number stays where it was, so subsequent revision creation continues from it. The working quotation is not a deletable archive. Delete only on the user's explicit request; ordinary edits and file-size limits are not reasons to remove history.

## Validation and preservation

- Archive records contain `id`, positive safe-integer `revisionNumber`, UTC `createdAt`, optional string `note`, and a complete `quotation` snapshot.
- Archive IDs and numbers are unique within the file. Each snapshot keeps the working quotation's family ID and its own matching header revision number.
- Item IDs can recur across different snapshots; validate uniqueness within each quotation independently.
- The working revision number is greater than every saved number. Gaps after deletion are valid. Do not fabricate missing revisions.
- Preserve saved fields exactly, including blank strings, whitespace, original labels, pricing, rates, branding, and receipt records. Reject invalid history rather than repairing or dropping entries.
- Validate every snapshot and the whole envelope's 10 MiB limit. A failed operation leaves the source intact; never drop history or wrap history recursively inside a snapshot.

## Working in an open app

Follow [agent-api-v2.md](agent-api-v2.md). Discover `revisionRead` and `revisionWrite` capabilities and check the required methods. Deletion requires a build exposing `deleteQuotationRevision` (API 2.2 or later); schema version and API version are separate.

Use `listQuotationRevisions`, `getQuotationRevision`, `createQuotationRevision`, `restoreQuotationRevision`, or `deleteQuotationRevision`. Persisted mutations need the current file path or an explicit output path and never open an automation save dialog. A successful result with `cacheWarning: true` means the file operation already succeeded: retain that file and reopen it; do not repeat creation or deletion just to retry the cache.

`meta.revision` and `expectedRevision` are session concurrency counters, not the business revision number or archive ID. The local **Load Latest** recovery cache does not include full history. On `history_unavailable`, reopen the original quotation file rather than rebuilding an empty history from the recovered draft.

For an archived PDF, use `exportPdfToFile(path, { quotationRevisionId })`; it leaves the working draft unchanged. The portable CLI's `render` command exports the working quotation and has no revision-selection flag. An archived PDF is newly rendered from its snapshot, not an archived copy of the PDF originally issued.

Older portable builds that report schema 2 cannot read new schema-3 files. The helper detects this before rendering. Deliver the valid JSON and report application validation/PDF as pending until a compatible build is configured; never discard history for compatibility.
