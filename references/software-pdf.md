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

`status` confirms only that the configured file exists. Before V2 validation or rendering, the helper automatically probes `--automation api-info` with a bounded timeout and a temporary result file because packaged Windows GUI executables may not expose standard output. If that probe fails, the executable predates the stable automation CLI or is incompatible; continue delivering offline-validated JSON and configure a current portable build.

When `setupAcknowledged` is `false`, ask the user once for the full path to the portable `.exe`, while continuing any JSON-generation work. The software question must never become a prerequisite for JSON.

Configure a supplied executable:

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
  --result-json <validation-result.json>
```

The application reports stable issue codes and field paths. Fix its errors before PDF delivery. If the application is unavailable, keep the independently validated JSON and state that application validation was not run.

## Render sequence

Build and validate the schema-v2 JSON before rendering. This ordering preserves the useful JSON artifact even if the application is absent, moved, incompatible, or fails.

Export either or both documents:

```powershell
node <skill-folder>\scripts\quotation-software.mjs render <quotation.json> `
  --quotation-pdf <quotation.pdf> `
  --goods-receipt-pdf <goods-receipt.pdf> `
  --output-json <normalized-quotation.json> `
  --no-network `
  --result-json <export-result.json>
```

`export` remains a skill-helper alias for `render`, but new workflows should use `render`. Goods-receipt export requires a valid `quotation.pendingGoodsReceiptDraft`. Add `--refresh-exchange-rates` only when the user requests current/latest published rates; omit `--no-network` in that case. Do not replace an explicitly supplied historical or contract rate without permission.

Optional controls:

- `--force` (or `--overwrite`) replaces existing outputs using the application's backup behavior.
- `--timeout-ms <1-600000>` changes the per-phase timeout.
- `--progress-json <path>` writes structured progress at phase boundaries.
- `--cancel-file <path>` cancels safely when the file appears between phases.
- `--output-json <path>` saves the normalized quotation state used for rendering.

The result JSON records the rate date, exact rates applied, output paths, warnings, and failure details. A refresh changes the in-memory quotation used for the PDFs; it does not modify the input quotation JSON.

## Failure behavior

- If configuration is missing or the executable moved, keep and deliver the validated JSON, explain why PDF was not produced, and ask for a new `.exe` path only when the user still wants PDF.
- If the API-info compatibility probe fails or times out, do not retry by opening the GUI. The configured executable is outdated or incompatible; rebuild/configure the current portable application.
- If the application returns a nonzero automation exit code, keep the JSON and report its structured errors. Never claim that a PDF exists without checking the output file.
- Do not substitute browser printing, HTML-to-PDF tools, screenshots, office converters, or a separately recreated PDF template. PDF output must come from the configured Quotation Software application.
- Headless export does not modify the input JSON. To record a successfully exported goods receipt in JSON history, explicitly run `add-goods-receipt` with the real PDF path.
