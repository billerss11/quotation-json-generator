# Goods-receipt draft and history schema

The application source of truth is `src/features/goods-receipts/utils/goodsReceipt.ts`. Both pending and completed goods receipts are stored inside the same schema-v2 quotation JSON.

## Lifecycle

- `quotation.pendingGoodsReceiptDraft` is loaded when the user opens **Generate GR** after importing the JSON.
- A successful direct PDF export clears the pending draft, appends its completed snapshot to `quotation.goodsReceiptHistory`, and saves the quotation to local app storage.
- Browser Print does not add history and leaves the pending draft unchanged.
- Changes made only inside the open dialog are not written back to the pending draft. If the user closes the dialog without direct export, the imported pending draft remains unchanged.
- After direct export, the user must save or export the quotation JSON again to update a file on disk.

## Pending draft

Use this field when generating a quotation JSON that the user will import and continue in the GUI:

```json
{
  "quotation": {
    "pendingGoodsReceiptDraft": {
      "quotationId": "quotation-id",
      "quotationNumber": "Q-2026-001",
      "quotationDate": "2026-08-20",
      "grNumber": "GR-20260820",
      "documentDate": "2026-08-20",
      "customerReference": "PO-4500123",
      "deliveryReference": "DN-8821",
      "receivingCompany": "Customer Ltd",
      "deliveryAddress": "88 Harbour Road, Shanghai",
      "deliveryContact": "Jane Buyer",
      "contactDetails": "jane@example.com | +86 21 5555 0100",
      "supplierCompany": "Supplier Ltd",
      "supplierContact": "sales@example.com | +86 21 5555 0200",
      "projectName": "Pump package",
      "preparedBy": "Alex",
      "remarks": "Inspect packaging on arrival.",
      "templateId": "standard",
      "lines": []
    }
  }
}
```

## Completed history record

```json
{
  "quotation": {
    "goodsReceiptHistory": [
      {
        "id": "unique-record-id",
        "exportedAt": "2026-08-20T08:30:00.000Z",
        "filePath": "C:\\Receipts\\GR-20260820.pdf",
        "draft": {}
      }
    ]
  }
}
```

- `id`: unique non-empty record ID.
- `exportedAt`: canonical UTC ISO timestamp.
- `filePath`: string path of the exported PDF. It may be empty for an explicitly requested archival placeholder, but the builder warns because no PDF is referenced.
- `draft`: complete `GoodsReceiptDraft` snapshot.

## GoodsReceiptDraft

```json
{
  "quotationId": "quotation-id",
  "quotationNumber": "Q-2026-001",
  "quotationDate": "2026-08-20",
  "grNumber": "GR-20260820",
  "documentDate": "2026-08-20",
  "customerReference": "PO-4500123",
  "deliveryReference": "DN-8821",
  "receivingCompany": "Customer Ltd",
  "deliveryAddress": "88 Harbour Road, Shanghai",
  "deliveryContact": "Jane Buyer",
  "contactDetails": "jane@example.com | +86 21 5555 0100",
  "supplierCompany": "Supplier Ltd",
  "supplierContact": "sales@example.com | +86 21 5555 0200",
  "projectName": "Pump package",
  "preparedBy": "Alex",
  "remarks": "Inspect packaging on arrival.",
  "templateId": "standard",
  "lines": []
}
```

All fields above are required in final output. Text fields may be empty. `quotationDate` and `documentDate` use `YYYY-MM-DD`. `templateId` is `standard` or `compact`.

Use these mappings:

- customer PO number or customer reference -> `customerReference`;
- delivery note, dispatch note, packing-list number, or delivery document reference -> `deliveryReference`;
- receiving destination -> `deliveryAddress`;
- person accepting delivery -> `deliveryContact`;
- general goods-receipt notes -> `remarks`;
- item-specific notes -> the matching line's `remarks`.

Do not put goods-receipt values into `quotation.header.notes`. Split vague “delivery information” into the appropriate reference, address, contact, and contact-details fields based on the evidence. Ask only when the meaning materially changes the document.

## Stored line

```json
{
  "id": "quotation-item-id",
  "sourceItemId": "quotation-item-id",
  "sourceItemNumber": "1.1",
  "sourceGroupPath": [
    {
      "id": "parent-item-id",
      "itemNumber": "1",
      "label": "Pump package",
      "depth": 0
    }
  ],
  "sourceDepth": 1,
  "sourceHasChildren": false,
  "selected": true,
  "description": "Pump, Model PX-100",
  "quotedDescription": "Pump, Model PX-100",
  "quantity": 2,
  "quotedQuantity": 2,
  "unit": "EA",
  "quotedUnit": "EA",
  "remarks": "Two crates received."
}
```

The helper derives the complete line array, hierarchy, item numbers, descriptions, units, and quoted quantities from the quotation. Parent quantities multiply into descendant quoted quantities, matching the application.

## Pending-draft builder input

Use a compact partial receipt file with `set-goods-receipt-draft`:

```json
{
  "documentDate": "2026-08-20",
  "grNumber": "GR-20260820",
  "customerReference": "PO-4500123",
  "deliveryReference": "DN-8821",
  "deliveryAddress": "88 Harbour Road, Shanghai",
  "remarks": "Inspect packaging on arrival.",
  "templateId": "standard",
  "selectionPreset": "detailed",
  "lines": [
    {
      "sourceItemNumber": "1.1",
      "selected": true,
      "quantity": 2,
      "remarks": "Two crates received."
    },
    {
      "sourceItemNumber": "1.2",
      "selected": false
    }
  ]
}
```

Run:

```powershell
node <skill-folder>\scripts\quotation-json.mjs set-goods-receipt-draft <quotation.json> <receipt.json> <output-quotation.json>
```

`selectionPreset` is a builder-only field and is not stored. Supported values match the GUI:

- `summary`: eligible root items;
- `grouped`: eligible second-level items or shallower leaves;
- `detailed`: positive-quantity leaf items.

Line overrides may identify a quotation line by `sourceItemId`, `sourceItemNumber`, or `id`, then set `selected`, `description`, `quantity`, `unit`, or `remarks`. Overrides do not replace the full line array.

The builder defaults missing document date to today, GR number to `GR-YYYYMMDD`, template to `standard`, and selection to `detailed`. It prefills customer, supplier, project, and contact values using the same quotation fields as the GUI. Disclose defaults that affect the receipt.

For an already exported receipt, use `add-goods-receipt` with `{ exportedAt, filePath, draft }`. That command adds a completed history record and clears any pending draft, matching the application after successful direct PDF export.

## Validation

The validator checks the complete quotation, pending goods-receipt draft, and every stored history record. It rejects malformed record metadata, dates, templates, line fields, hierarchy paths, negative quantities, duplicate IDs, and receipts with no selected positive-quantity lines. It warns when received quantity exceeds quoted quantity, a selected line has zero quantity, ancestor and descendant selections overlap, quotation identity differs from the current quotation, or a history record's `filePath` is empty.
