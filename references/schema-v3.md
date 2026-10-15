# Legacy Quotation Software JSON Schema v3

The current format is [schema v4](schema-v4.md). Version 3 has the same working quotation, saved revision structure, and business fields, with inline `branding.logoDataUrl` in every working and archived quotation and no top-level `images` table.

The offline validator accepts complete v3 files. The builder and revision/receipt commands upgrade them to v4, preserving every saved revision ID, timestamp, note, receipt, item, output setting, and original image string. Shared references replace only the serialized branding representation. Never downgrade a history-bearing file or delete images/history for an older application.
