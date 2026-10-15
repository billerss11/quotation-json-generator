# Quotation Software JSON Schema v4

This is the maintained skill reference for the current app contract. The application source of truth is `src/features/quotations/types.ts`, `src/features/quotations/utils/quotationFile.ts`, `src/features/quotations/utils/quotationCalculations.ts`, and `src/features/goods-receipts/utils/goodsReceipt.ts` in the Quotation Software repository.

## Envelope

```json
{
  "schemaVersion": 4,
  "app": "quotation-software",
  "exportedAt": "2026-08-19T08:00:00.000Z",
  "quotation": {},
  "revisions": [],
  "images": {}
}
```

`exportedAt` must be a canonical UTC ISO timestamp. The current app imports versions 1–4. Generate version 4 with explicit `revisions` and `images`. Versions 1 and 2 have no saved history; never fabricate it from a printed revision number. Version 3 history is retained in full. The offline validator accepts complete v2–v4 files; the builder also upgrades v1 input.

`quotation` is the editable working draft. Each entry in `revisions` contains `{ id, revisionNumber, createdAt, note?, quotation }`, where its `quotation` is a complete, unchanged saved snapshot. Read [revisions.md](revisions.md) for lifecycle commands. History is outside the working quotation and never nests inside a snapshot.

## Shared images and legacy upgrade

`images` maps IDs such as `image-1`, `image-2` to original image data URL strings. Each working or archived `branding` contains `logoImageId` in place of `logoDataUrl`. References must name an own property of the table; missing references, invalid IDs, and inline `logoDataUrl` in a v4 file are rejected. `null` expands to the legacy empty logo string.

The builder and all revision/receipt mutations emit v4. They collect the working logo first, then saved revisions in array order, deduplicate exact strings, and assign sequential IDs on each save. IDs are file-local, may change after an edit or deletion, and are not persistent image identities. Images are never resized, recompressed, or re-encoded. Deleting a revision removes only images no longer referenced anywhere. Validation also checks unused image-table values.

For a new partial builder input, supply `branding.logoDataUrl` as before. For an existing v4 file, retain the entire table and references while editing other fields. To replace a logo programmatically, use the bundled `decodeQuotationEnvelope` to obtain a detached expanded envelope, edit its `branding.logoDataUrl`, and pass the whole envelope to the builder. Do not relabel a v4 file as v3 or manually remove its table.

The module `scripts/quotation-json.mjs` re-exports `decodeQuotationEnvelope` and `encodeQuotationEnvelope` from the standalone, dependency-free `quotation-images.mjs` codec. Decode accepts legacy envelopes unchanged and expands v4 into a schema-3-shaped envelope; encode emits v4 and prunes unused assets. These format helpers do not replace the business validator. Public build/revision/receipt helpers return persisted v4 envelopes. Compare decoded snapshots when verifying legacy history, because branding representation and table IDs change on save while image strings and revision content remain exact.

## Quotation draft

Required complete output fields:

- `id`: unique non-empty string.
- `templateId`: `classic`, `technical-bid`, `executive-summary`, `luminous`, `signal`, `atelier`, or `spreadsheet`.
- `companyProfileId`: profile ID or `null`.
- `companyProfileSnapshot`: `{ companyName, email, phone }` strings.
- `header`: quotation metadata described below.
- `majorItems`: ordered root rows.
- `outputSettings`: item detail level plus optional custom subtotal wording, breakdown note, and informational totals (below).
- `totalsConfig`: markup, charges, and tax configuration.
- `exchangeRates`: currency-to-base rate table.
- `branding`: `{ logoImageId, accentColor }`; `logoImageId` is `null` for no logo or an image-table key, and `accentColor` is a six-digit hex string.
- `metadata`: `{ createdAt, updatedAt }` ISO timestamps.
- `pendingGoodsReceiptDraft` (optional): receipt draft loaded by **Generate GR** after import.
- `goodsReceiptHistory`: completed goods-receipt records stored with the quotation; use an empty array when none exist. Read [goods-receipt.md](goods-receipt.md) before creating or changing either receipt field.

### Header

```json
{
  "quotationNumber": "Q-2026-001",
  "revisionNumber": 1,
  "quotationDate": "2026-08-19",
  "customerCompany": "Customer Ltd",
  "contactPerson": "Jane Buyer",
  "contactDetails": "jane@example.com",
  "projectName": "Pump package",
  "validityPeriod": "30 days",
  "currency": "USD",
  "documentLocale": "en-US",
  "notes": "",
  "terms": ""
}
```

`documentLocale` is `en-US` or `zh-CN`. `revisionNumber` is a positive safe integer, no greater than `9007199254740991`. The working revision must be greater than every archived revision number. Do not map obsolete `customerName` into `contactPerson` without evidence.

## Output settings and informational totals

`itemDetailLevel` is `1`, `2`, or `3`. The other fields are optional; omit them when the user has not requested a custom summary.

```json
{
  "itemDetailLevel": 1,
  "subtotalLabel": "Materials total",
  "informationalTotalsNote": "Already included in Materials total.\nFor reference only.",
  "showInformationalTotals": true,
  "informationalTotals": [
    {
      "id": "equipment-summary",
      "label": "Equipment insulation",
      "source": "sections",
      "sectionIds": ["section-equipment"],
      "visible": true
    },
    {
      "id": "selected-materials-summary",
      "label": "Selected piping and valves",
      "source": "items",
      "sectionIds": [],
      "itemIds": ["pipe-1", "valve-1"],
      "visible": true
    }
  ]
}
```

The example source IDs must be replaced with IDs present in the quotation. Do not select by row number, name, description, or section title. The builder can create missing summary-row IDs, but cannot infer which source items the user meant.

- `subtotalLabel` changes the final subtotal label above tax/extra charges and the grand total. Empty or whitespace-only text uses the document-language default. Preserve custom wording exactly; the display trims surrounding whitespace.
- `informationalTotalsNote` is an optional string displayed with the breakdown. Omit it to use the app's document-language reminder: `Already included in {subtotalLabel}.` or `已包含在“{subtotalLabel}”中。`. An explicit empty or whitespace-only string hides the note; it does **not** restore the default. Preserve custom text and line breaks exactly. Custom notes are literal text, without placeholder substitution, and never change prices.
- `showInformationalTotals` controls the entire breakdown. Each row's `visible` controls that row. Hiding either preserves its configuration and never changes prices.
- Each row requires a unique nonempty `id`, string `label`, `sectionIds` array, and boolean `visible`. Optional `source` is `sections` or `items`; omission means `sections`. Optional `itemIds` is an array of nonempty strings. Use `sectionIds: []` for an item-only row.
- Section mode follows all priced root rows after each selected section header until the next header. New rows and moves change that section's contents automatically.
- Item mode selects root items, groups, or nested children. IDs remain selected when moved or renamed. A selected group includes its current descendants, including newly added children. Selecting a parent and its descendants counts the parent once; repeated IDs count once.
- Keep inactive `sectionIds` or `itemIds` when changing modes. Only the active source contributes to the amount and source-reference checks. A blank row label uses the selected section titles or item names.
- Amounts are selling contributions in quotation currency, after markup and FX conversion, before quotation tax and extra charges. Child contributions include every ancestor quantity. Rounding is reconciled at each hierarchy level so selected siblings/all leaves agree with their parent total. Output detail level never changes these sums.
- Do not store `amount`, an expression, or a copied calculated sum in a row. Do not turn informational totals into `extraCharges`. Informational rows may overlap and must not be added together to calculate the grand total.
- Empty or deleted active selections are saveable incomplete configuration: the offline validator warns, and the summary reports `amount: null`. A visible invalid row must be fixed or hidden before customer PDF/print export. Hidden or inactive sources are retained. Saved revisions retain their own display settings and source IDs.

When any summary setting is present, `summarize` adds `summaryDisplay` with a trimmed custom `subtotalLabel` (or `null` for the default), the master visibility, and resolved `informationalTotals`, including visibility and missing-reference information. It includes raw `informationalTotalsNote` only when supplied, including explicit blank text; an absent note remains omitted because the app chooses the localized default. Normal pricing totals remain unchanged. These optional fields also existed in schema 3; round-trip checks establish support beyond a reported schema number. See [software-pdf.md](software-pdf.md).

## Root rows and hierarchy

A root row is either a section header or quotation item.

Section header:

```json
{ "id": "unique-id", "kind": "section_header", "title": "Equipment" }
```

Quotation item:

```json
{
  "id": "unique-id",
  "name": "Pump",
  "description": "Model PX-100",
  "quantity": 2,
  "quantityUnit": "EA",
  "pricingMethod": "cost_plus",
  "unitCost": 1000,
  "costCurrency": "USD",
  "markupRate": 15,
  "taxClassId": "tax-standard",
  "expectedTotal": 2300,
  "notes": "",
  "children": []
}
```

Optional item fields are `manualUnitPrice`, `markupRate`, `taxClassId`, `expectedTotal`, and `notes`. Keep no more than three item levels because the editor's supported hierarchy and output detail levels are 1–3.

### Calculation invariants

Let `R(x)` mean rounding to two decimal places, with half cents rounded away from zero. With non-negative inputs, cost-plus pricing uses this exact sequence:

```text
converted unit cost = unitCost × exchangeRates[costCurrency]
unit markup = R(converted unit cost × effective markup / 100)
unit selling price = R(converted unit cost + unit markup)
leaf selling amount = R(quantity × unit selling price)
leaf cost amount = R(quantity × converted unit cost)
```

For example, cost `0.005`, markup `100%`, and quantity `7` gives a unit selling price of `0.02` and a line amount of `0.14`. Multiplying all operands before rounding gives a different answer.

- A leaf using `manual_price` sells for `R(quantity × R(manualUnitPrice))`. Its `unitCost` remains useful for cost/profit reporting; absent cost is not treated as pure profit.
- An explicit `pricingMethod` takes precedence over a stored inactive `manualUnitPrice`. Infer manual pricing from that field only when the method is absent or invalid, matching the app.
- A group with children ignores its own `unitCost` and `manualUnitPrice`. Its selling amount is `R(group quantity × sum(child selling amounts))`, rounded at each level. Costs roll up the same way. Child quantities are per one parent unit.
- `markupRate` inherits from the nearest ancestor, then falls back to `totalsConfig.globalMarkupRate`.
- `taxClassId` inherits from the nearest ancestor, then falls back to `defaultTaxClassId`.
- `expectedTotal` never changes calculations. It only enables a mismatch warning for groups.
- Negative values are normalized or clamped by calculations and should not be generated.

## Totals and tax

```json
{
  "globalMarkupRate": 0,
  "extraCharges": [
    { "id": "charge-id", "label": "Freight", "amount": 100 }
  ],
  "taxMode": "single",
  "taxClasses": [
    { "id": "tax-standard", "label": "Standard", "rate": 13 }
  ],
  "defaultTaxClassId": "tax-standard",
  "mixedTaxColumns": [
    "taxRate",
    "unitPrice",
    "unitPriceWithTax",
    "netAmount",
    "grossAmount"
  ]
}
```

Tax rates are percentages from 0 to 100. `taxMode` is `single` or `mixed`. Use mixed mode when effective leaf tax classes differ.

The builder migrates a valid legacy `totalsConfig.taxRate` into a tax class when no classes are supplied; it does not replace an explicit rate with zero. Explicit tax classes take precedence. Markup rates must be between 0 and 1000 percent.

Tax is rounded per quotation tax bucket, after hierarchy rollups. Group bucket subtotals are reconciled to the canonical group selling amount. Do not calculate quotation tax by adding independently rounded leaf taxes.

Extra charges are fixed, non-taxable amounts added after tax. Each charge is rounded to cents during building/import before summation. The builder reports any changed charge precision. The grand total is `R(pre-tax selling subtotal + tax + sum(rounded extra charges))`. Use the helper's `summarize` command for actual amounts.

Allowed mixed-tax columns: `taxRate`, `unitPrice`, `unitTax`, `unitPriceWithTax`, `taxAmount`, `netAmount`, and `grossAmount`.

## Exchange rates

The base quotation currency must equal `1`. Rates use quotation direction:

```json
{
  "USD": 1,
  "CNY": 0.1470588235
}
```

For this USD quotation, the value means `1 CNY = 0.1470588235 USD`. Do not store the inverse `6.8` value. Every currency used by an item's `costCurrency` must appear in the table.

Currency codes are trimmed and uppercased consistently in the builder, validator, and summary. Duplicate canonical keys such as `EUR` and `eur` are rejected, even when they carry the same rate. Accepted rates range from `0.000001` to `1,000,000`; the application rejects a currency rebase if any resulting rate leaves that range. Do not clamp a rebased rate or substitute zero.

## Safe defaults

When the source is silent, the builder uses these editable defaults and reports them:

- base currency `USD`;
- document locale `en-US`;
- quantity `1` and unit `EA`;
- monetary values and global markup `0`;
- one `0%` tax class;
- output detail level `3`;
- classic template and green accent `#047857`.

These are placeholders, not extracted facts.

## Strict validation and limits

Final files must not contain unknown fields outside the maintained schema. The bundled validator checks the complete generated structure without requiring the application. When a configured application is available, also run its `--automation validate` command because the application contract is authoritative.

- Stored quotation JSON, including the shared image table and all saved snapshots: at most 10 MiB UTF-8. Repeated decoded image strings do not count again. Never prune revisions automatically.
- Pending goods-receipt draft: at most 5 MiB serialized UTF-8.
- Logo: empty or a valid PNG, JPEG, GIF, or WebP base64 data URL. The declared MIME type must match the image bytes; decoded data must not exceed 5 MiB; dimensions must not exceed 4096 x 4096 pixels.
