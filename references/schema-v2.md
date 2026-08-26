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
- `lineItemEntryMode`: `detailed` or `quick`.
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

- A leaf using `cost_plus` sells for `quantity × converted unitCost × (1 + effective markup / 100)`.
- A leaf using `manual_price` sells for `quantity × manualUnitPrice`. Its `unitCost` remains useful for cost/profit reporting.
- A group with children ignores its own `unitCost` and `manualUnitPrice`. Its selling amount is `group quantity × sum(child selling amounts)`.
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

## Safe defaults

When the source is silent, the builder uses these editable defaults and reports them:

- base currency `USD`;
- document locale `en-US`;
- quantity `1` and unit `EA`;
- monetary values and global markup `0`;
- one `0%` tax class;
- detailed entry mode and output detail level `3`;
- classic template and green accent `#047857`.

These are placeholders, not extracted facts.

## Strict validation and limits

Final files must not contain unknown fields outside the maintained schema. The bundled validator checks the complete generated structure without requiring the application. When a configured application is available, also run its `--automation validate` command because the application contract is authoritative.

- Quotation JSON: at most 10 MB UTF-8.
- Pending goods-receipt draft: at most 5 MB serialized UTF-8.
- Logo: empty or a valid PNG, JPEG, GIF, or WebP base64 data URL. The declared MIME type must match the image bytes; decoded data must not exceed 5 MB; dimensions must not exceed 4096 x 4096 pixels.
