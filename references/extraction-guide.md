# Source Extraction Guide

Use this guide when quotation data comes from prose, screenshots, photographs, PDFs, or copied tables.

## Input handling

- Natural language: extract stated facts directly. Separate user instructions from quotation content.
- Native PDF: extract text and tables first, then visually inspect pages where columns, indentation, or totals may have been lost.
- Scanned PDF or image: use vision/OCR and inspect the page layout. Do not trust OCR alone for decimal points, currency symbols, quantities, or item nesting.
- Multiple files: reconcile duplicates by document date and context. Do not silently combine conflicting prices.

## Extraction order

1. Document header: quotation number, date, revision, customer, contact, project, validity, currency, language, notes, and terms.
2. Company profile: seller company name, email, and phone.
3. Line hierarchy: section header, parent/group, child, and grandchild. Use indentation, numbering such as `1`, `1.1`, `1.1.1`, and subtotal labels as evidence.
4. Per-line facts: name, description, quantity, unit, pricing meaning, currency, markup, and tax class.
5. Document-level pricing: global markup, tax classes, extra charges, and exchange rates.

## Financial ambiguity rules

Ask for clarification when the answer changes the total and the source does not resolve it, especially:

- unit cost versus unit selling price;
- unit price versus extended line total;
- tax-inclusive versus tax-exclusive price;
- percentage markup versus margin;
- exchange-rate direction;
- whether a subtotal row is a group or a separately charged line.

If the user prefers a draft despite missing values, use zero for the unknown monetary value and report the affected item names. Do not fabricate a plausible number.

## Mapping rules

- Cost plus: `pricingMethod: "cost_plus"`, source cost in `unitCost`, optional percentage in `markupRate`.
- Fixed selling price: `pricingMethod: "manual_price"`, unit selling price in `manualUnitPrice`. Keep a known cost in `unitCost`; otherwise use `0`.
- Extended total: divide by quantity only when it is clearly a line total and quantity is known and nonzero.
- Parent/group rows: put priced components in `children`. Parent `unitCost` and `manualUnitPrice` do not control totals.
- Source subtotal/check total: place in `expectedTotal` only when it is explicitly a comparison total for a group.
- Base currency: `header.currency`. Every cost currency needs a rate where `1 cost currency = rate base currency`.
- Item markup and tax class inherit through parent groups when omitted from children.

## Delivery report

Alongside the JSON link, state:

- which sources were used;
- defaults applied;
- missing monetary fields;
- assumptions that affect hierarchy or totals;
- low-confidence OCR values the user should check.

Keep this report outside the JSON file.
