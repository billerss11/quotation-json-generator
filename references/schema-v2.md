# Quotation Software JSON Schema v2

This is the maintained skill reference for the current app contract. The application source of truth is `src/features/quotations/types.ts`, `src/features/quotations/utils/quotationFile.ts`, `src/features/quotations/utils/quotationCalculations.ts`, and `src/features/goods-receipts/utils/goodsReceipt.ts` in the Quotation Software repository.

## Envelope

```json
{
  "schemaVersion": 2,
  "app": "quotation-software",
  "exportedAt": "2026-08-19T08:00:00.000Z",
  "quotation": {}
}
```

`exportedAt` must be a canonical UTC ISO timestamp. The current app imports versions 1 and 2; always generate version 2.

## Quotation draft

Required complete output fields:

- `id`: unique non-empty string.
- `templateId`: `classic`, `technical-bid`, `executive-summary`, `luminous`, `signal`, `atelier`, or `spreadsheet`.
- `companyProfileId`: profile ID or `null`.
- `companyProfileSnapshot`: `{ companyName, email, phone }` strings.
- `header`: quotation metadata described below.
- `majorItems`: ordered root rows.
- `outputSettings.itemDetailLevel`: `1`, `2`, or `3`.
- `totalsConfig`: markup, charges, and tax configuration.
- `exchangeRates`: currency-to-base rate table.
- `branding`: `{ logoDataUrl, accentColor }` strings.
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

`documentLocale` is `en-US` or `zh-CN`. Do not map obsolete `customerName` into `contactPerson` without evidence.

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

- Quotation JSON: at most 10 MB UTF-8.
- Pending goods-receipt draft: at most 5 MB serialized UTF-8.
- Logo: empty or a valid PNG, JPEG, GIF, or WebP base64 data URL. The declared MIME type must match the image bytes; decoded data must not exceed 5 MB; dimensions must not exceed 4096 x 4096 pixels.
