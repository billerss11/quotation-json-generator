# Legacy schema-v2 compatibility

The current format is [schema v4](schema-v4.md). Version 2 has the same quotation payload with inline logos but no envelope-level `revisions` or `images`. Existing v2 files remain valid inputs to the offline validator and current application; the builder upgrades them to v4 with empty history and shared images.

Do not label a history-bearing document as version 2 or remove its history to accommodate an old executable. Read [software-pdf.md](software-pdf.md) for the compatibility check. The retained v2 template is a legacy example only.
