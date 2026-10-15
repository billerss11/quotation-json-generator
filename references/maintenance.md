# Maintenance and source parity

Source parity checks calculation, import, revision, image, receipt, and summary behavior against a supplied Quotation Software checkout. Verify packaged executable behavior separately; source parity does not establish which changes a build contains.

The offline helper remains independent of the repository and executable. It supports v4 persisted files and unversioned new partial quotations; it rejects v1–v3 rather than converting them. Keep file-schema support separate from runtime expanded image data, renderer API V2, configuration schema 1, and manifest schema 1.

When changing helpers or syncing repository behavior, run:

```powershell
node --test <skill-folder>\scripts\quotation-json.test.mjs <skill-folder>\scripts\quotation-software.test.mjs
node <skill-folder>\scripts\quotation-json.mjs self-test
node <skill-folder>\scripts\verify-repo-parity.mjs <quotation-software-repo>
```

The optional parity check uses the checkout's existing Vite installation, compares actual import/calculation results, and prints the verified commit. It is not required for ordinary JSON generation. Evaluation paths in `evals/evals.json` are relative to the skill folder; bundled inputs are in `evals/fixtures/`.

Retain the software helper's optional summary-setting round-trip probes: API/schema numbers alone do not prove support for custom subtotal labels, informational totals, or editable notes. See [software-pdf.md](software-pdf.md) for compatibility behavior. For a maintained portable build, use its `current-portable.json` through `configure-current`; direct `.exe` configuration remains supported for a fixed build.
