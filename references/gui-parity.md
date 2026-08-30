# GUI-to-JSON parity map

The automation contract is the complete schema-v2 quotation state, not a command-line flag for every GUI control. Compose these fields so importing the JSON produces the same document-affecting state a user could enter in the GUI.

| GUI area | JSON path | Notes |
| --- | --- | --- |
| Seller/company profile | `quotation.companyProfileId`, `quotation.companyProfileSnapshot` | The snapshot controls the document. A library selection itself is not required. |
| Logo and accent color | `quotation.branding.logoDataUrl`, `quotation.branding.accentColor` | Logo is a base64 image data URL; accent is a six-digit hex color. |
| Template | `quotation.templateId` | Use one of the seven quotation templates in `schema-v2.md`, including `spreadsheet`. |
| Quotation identity | `quotation.header.quotationNumber`, `revisionNumber`, `quotationDate` | Revision is a positive integer; date is `YYYY-MM-DD`. |
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
| Prepared goods receipt | `quotation.pendingGoodsReceiptDraft` | Complete draft loaded by **Generate GR** and used by headless goods-receipt PDF export. |
| Completed receipt records | `quotation.goodsReceiptHistory` | Use only for receipts already exported or explicitly archived. |

GUI-only working state such as the active panel, selected row, dialog visibility, preview-window position, undo/redo history, draft browser, and analysis charts is not serialized because it does not affect either PDF.

Before delivery, compare the user request against every relevant row above. A field being absent from the agent API does not make it unavailable when its final state is represented in the imported JSON.
