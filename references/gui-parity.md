# GUI-to-JSON parity map

The automation contract is the complete schema-v4 envelope: the working quotation plus its saved revision history. Compose these fields so importing JSON produces the requested document and preserves existing archives.

| GUI area | JSON path | Notes |
| --- | --- | --- |
| Seller/company profile | `quotation.companyProfileId`, `quotation.companyProfileSnapshot` | The snapshot controls the document. A library selection itself is not required. |
| Logo and accent color | `quotation.branding.logoImageId`, `quotation.branding.accentColor` | Logo references its original data URL in the top-level `images` table; accent is a six-digit hex color. |
| Template | `quotation.templateId` | Use one of the seven quotation templates in `schema-v4.md`, including `spreadsheet`. |
| Quotation identity | `quotation.id`, `quotation.header.quotationNumber`, `revisionNumber`, `quotationDate` | Keep the family ID stable. Revision is a positive safe integer managed by revision operations; date is `YYYY-MM-DD`. |
| Revision history | Envelope `revisions` | Immutable quotation snapshots with unique archive IDs, numbers, timestamps, and optional notes. Never place history inside `quotation`. |
| Revision selector / View revision | No working-draft change | Read the selected saved snapshot. Switching views does not restore or increment a revision. |
| Create / Restore / Delete revision | Revision helper or matching V2 operation | See `revisions.md`; do not emulate these by editing the number field. Deleting does not renumber remaining revisions. |
| Customer and contact | `quotation.header.customerCompany`, `contactPerson`, `contactDetails` | Preserve distinct company/person/contact meanings. |
| Project and commercial text | `quotation.header.projectName`, `validityPeriod`, `notes`, `terms` | Keep receipt-only delivery data out of these fields. |
| Currency and language | `quotation.header.currency`, `documentLocale` | Locale is `en-US` or `zh-CN`; base exchange rate is `1`. |
| Sections and item hierarchy | `quotation.majorItems` | Root section headers plus item trees up to three item levels. |
| Item descriptions and quantities | Item `name`, `description`, `quantity`, `quantityUnit`, `notes` | Preserve order and wording from evidence. |
| Item pricing | Item `pricingMethod`, `unitCost`, `costCurrency`, `manualUnitPrice`, `markupRate` | A manual price is a selling price; cost-plus uses cost and effective markup. |
| Item tax | Item `taxClassId` | May inherit from a parent or the default class. |
| Global pricing | `quotation.totalsConfig.globalMarkupRate`, `extraCharges` | Goal-seek is a GUI calculator; write its final accepted markup values here. |
| Tax configuration | `quotation.totalsConfig.taxMode`, `taxClasses`, `defaultTaxClassId` | Use mixed mode when effective leaf tax classes differ. |
| PDF tax columns | `quotation.totalsConfig.mixedTaxColumns` | Controls mixed-tax preview and PDF columns. |
| Exchange-rate table | `quotation.exchangeRates` | Store `1 cost currency = rate base currency`. Include every item cost currency. |
| PDF hierarchy detail | `quotation.outputSettings.itemDetailLevel` | `1`, `2`, or `3`. |
| Summary display / Subtotal label | `quotation.outputSettings.subtotalLabel` | Changes the final subtotal wording; blank restores the document-language default. |
| Breakdown note | `quotation.outputSettings.informationalTotalsNote` | Omission uses the localized reminder; blank hides it. Preserve custom text and newlines. |
| Show informational breakdown | `quotation.outputSettings.showInformationalTotals` | Master visibility only; hiding retains rows and never changes prices. |
| Breakdown rows | `quotation.outputSettings.informationalTotals` | Each row has `id`, `label`, `visible`, `sectionIds`, optional `source` and `itemIds`. The source defaults to `sections`. |
| Calculate from / Selected sections | Row `source: "sections"`, `sectionIds` | Stable root section IDs; follows the current items between headers. |
| Calculate from / Selected items | Row `source: "items"`, `itemIds` | Stable item IDs at any level; includes ancestor quantities and counts a selected parent and its descendants once. Keep unused `sectionIds: []` or preserve its prior selection. |
| Prepared goods receipt | `quotation.pendingGoodsReceiptDraft` | Complete draft loaded by **Generate GR** and used by headless goods-receipt PDF export. |
| Completed receipt records | `quotation.goodsReceiptHistory` | Use only for receipts already exported or explicitly archived. |

GUI-only working state such as the active panel, selected row, dialog visibility, preview-window position, undo/redo history, draft browser, and analysis charts is not serialized because it does not affect either PDF.

Before delivery, compare the user request against every relevant row above. A field being absent from the agent API does not make it unavailable when its final state is represented in the imported JSON.
