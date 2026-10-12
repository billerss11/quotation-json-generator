# Legacy schema-v2 compatibility

The current format is [schema v3](schema-v3.md). Version 2 has the same quotation payload but no envelope-level `revisions` array. Existing v2 files remain valid inputs to the offline validator and current application; the builder upgrades them to v3 with empty history.

Do not label a history-bearing document as version 2 or remove its history to accommodate an old executable. Read [software-pdf.md](software-pdf.md) for the compatibility check. The retained v2 template is a legacy example only.
