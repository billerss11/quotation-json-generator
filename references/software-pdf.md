# Optional Quotation Software and PDF export

PDF export is a secondary capability layered on top of the independent JSON builder. The portable Electron application is the only supported PDF renderer because it guarantees the same templates, calculations, localization, and goods-receipt layout as the GUI.

## Persistent configuration

The helper stores per-user configuration outside the skill folder so skill updates do not erase it. On Windows the default is:

```text
%APPDATA%\quotation-json-generator\config.json
```

Check configuration at the start of a skill invocation:

```powershell
node <skill-folder>\scripts\quotation-software.mjs status
```

`status` resolves the current manifest and confirms that its selected executable exists; `usable: true` is not a schema-compatibility claim. Before validation or rendering, the helper probes `--automation api-info` with a bounded timeout and temporary result file, then checks the input schema against the reported `quotationSchemaVersion`. Batch jobs are all checked before any job runs. One operation pins the resolved executable for both probe and execution, even if the manifest changes. A schema-2/3 executable cannot process schema-4 image references; do not remove history or relabel the file to get past that check.

Use `node <skill-folder>\scripts\quotation-software.mjs api-info` to inspect the configured build. Newly generated files require reported schema support of 4 or later; legacy v2/v3 files may still be read by compatible older builds. API 2.2 adds renderer revision deletion. A source checkout update does not automatically rebuild the portable executable. If the selected build is old, keep the valid JSON and report PDF/application validation as pending until a current build is available.

Custom subtotal wording, editable breakdown notes, and informational section/item totals were added without changing schema 3 or API 2.2.0. For files using any of these settings, the helper also performs a temporary, no-network `validate --output-json` round trip and checks that the working quotation and saved revisions retain their summary settings. Requested validation/render/batch jobs start only after these checks succeed. The temporary files are cleaned up; the source JSON is unchanged. Duplicate selected IDs may be normalized, but labels, raw note text (including blanks and line breaks), visibility, source choices, and retained selections must survive. The probe retains schema-v4 shared images, expands normalized output for comparison, and never counts repeated decoded logos toward the stored size limit. A quotation number is needed for the application's output-JSON validation step.

An older executable that drops the settings is incompatible even if its schema/API numbers match. Keep the independently validated JSON and report app validation/PDF export as pending; rebuilding the portable application is separate work. Do not remove the new settings to make an old build accept the file. In an already open editor, verify the serialized settings and preview before delivering these features.

When `setupAcknowledged` is `false`, ask the user once for the full path to the portable `.exe`, while continuing any JSON-generation work. The software question must never become a prerequisite for JSON.

For a maintained build, configure its fixed manifest path. The project command `npm run package:win:portable:current` updates `release/current-portable.json` only after verifying the new portable executable; `package:win:portable` is an alias. Installer packaging preserves the selected portable build. Packaging is separate work and is not required for offline JSON generation.

```powershell
node <skill-folder>\scripts\quotation-software.mjs configure-current 'D:\Quotation Software\release\current-portable.json'
```

The helper stores the absolute `currentManifestPath`, then reads the manifest again on every `status`, validation, render, or batch invocation. The manifest contract is:

```json
{
  "schemaVersion": 1,
  "softwarePath": "portable/Quotation Software 0.2.0.exe",
  "appVersion": "0.2.0",
  "builtAt": "2026-09-15T01:00:00.000Z"
}
```

`softwarePath` must be a relative path to an `.exe`, resolved from the manifest directory. `appVersion` and `builtAt` must be non-empty strings. A missing or invalid configured manifest is an error; the helper does not fall back to an older direct executable path.

Direct configuration remains available when the user wants to pin one supplied executable:

```powershell
node <skill-folder>\scripts\quotation-software.mjs configure 'D:\Tools\Quotation Software 0.1.0.exe'
```

If the user says they do not have the software or do not want to configure it, remember that answer without disabling JSON generation:

```powershell
node <skill-folder>\scripts\quotation-software.mjs skip-setup
```

If the user supplies a directory rather than an executable, inspect that directory for `Quotation Software*.exe`. Configure the exact file when there is one clear match; ask which file to use when there are multiple matches. Do not hardcode a machine-specific path in `SKILL.md` or in quotation JSON.

## Application validation

Always run the bundled offline validator first. When the configured executable is usable, run the application's authoritative V2 validation without network access:

```powershell
node <skill-folder>\scripts\quotation-software.mjs validate <quotation.json> `
  --no-network `
  --result-json <validation-result.json> `
  --compact
```

The application reports stable issue codes and field paths. Fix its errors before PDF delivery. If the application is unavailable, keep the independently validated JSON and state that application validation was not run.

## Render sequence

Build and validate schema-v4 JSON before rendering. This ordering preserves the JSON artifact even if the application is absent, moved, incompatible, or fails. Existing legacy-v2/v3 files may still be validated/rendered unchanged by a compatible older app.

Export either or both documents:

```powershell
node <skill-folder>\scripts\quotation-software.mjs render <quotation.json> `
  --quotation-pdf <quotation.pdf> `
  --goods-receipt-pdf <goods-receipt.pdf> `
  --output-json <normalized-quotation.json> `
  --no-network `
  --result-json <export-result.json> `
  --compact
```

`export` remains a skill-helper alias for `render`, but new workflows should use `render`. Goods-receipt export requires a valid `quotation.pendingGoodsReceiptDraft`. Add `--refresh-exchange-rates` only when the user requests current/latest published rates; omit `--no-network` in that case. Do not replace an explicitly supplied historical or contract rate without permission.

The portable CLI renders the working quotation. It has no saved-revision selection flag. For an archived quotation PDF in an open compatible app, use the renderer API's `exportPdfToFile(path, { quotationRevisionId })` from [agent-api-v2.md](agent-api-v2.md). Do not overwrite the working quotation or fabricate a CLI flag to select history.

Optional controls:

- `--force` (or `--overwrite`) atomically replaces existing outputs without creating `.backup` copies in current builds; pre-existing backups remain unchanged.
- `--timeout-ms <1-600000>` changes the per-phase timeout.
- `--progress-json <path>` writes structured progress at phase boundaries.
- `--cancel-file <path>` cancels safely when the file appears between phases.
- `--output-json <path>` saves the normalized quotation state used for rendering.

The result JSON records the rate date, exact rates applied, output paths, warnings, and failure details. `--compact` keeps console output to counts, key totals, and the first actionable error while the full report remains in `--result-json`. If no result path is supplied, the helper captures the GUI executable's report through a temporary file and removes it after use. A refresh changes the in-memory quotation used for the PDFs; it does not modify the input quotation JSON.

## Sequential batch work

For multiple quotations, use the application's native sequential batch command instead of launching portable-app operations in parallel:

```powershell
node <skill-folder>\scripts\quotation-software.mjs batch <manifest.json> `
  --result-json <batch-result.json> `
  --progress-json <batch-progress.json> `
  --no-network `
  --compact
```

Manifest schema and limits follow the configured application's `api-info`: schema version 1, up to 100 jobs, with paths resolved relative to the manifest. Read the full batch result only when its compact summary reports failures or warnings.

## Failure behavior

- If configuration is missing or the executable moved, keep and deliver the validated JSON, explain why PDF was not produced, and ask for a new `.exe` path only when the user still wants PDF.
- The API-info probe allows 60 seconds for portable startup. If it fails or times out, compatibility is unverified; a timeout alone does not prove the executable is outdated. Inspect the failure before recommending a rebuild. Do not retry by opening the GUI.
- `quotation_schema_unsupported` or `quotation_schema_unknown` (exit code 3) means compatibility could not be established before execution. Keep the input and all history unchanged. Do not rebuild/configure software unless that work is part of the user's request.
- `quotation_summary_settings_unsupported` means the configured build did not retain the requested summary settings. `quotation_summary_settings_check_failed` means its temporary compatibility validation could not finish; inspect the included validation details. Neither is permission to strip settings or saved history. Keep the valid JSON and report application/PDF verification as pending.
- If the application returns a nonzero automation exit code, keep the JSON and report its structured errors. Never claim that a PDF exists without checking the output file.
- The helper preserves the application's stable exit codes (`2` through `7`) so callers can distinguish usage, input, network, filesystem, rendering, and internal failures.
- Do not substitute browser printing, HTML-to-PDF tools, screenshots, office converters, or a separately recreated PDF template. PDF output must come from the configured Quotation Software application.
- Headless export does not modify the input JSON. To record a successfully exported goods receipt in JSON history, explicitly run `add-goods-receipt` with the real PDF path.
