# Synthetic legacy Office fixtures

These files contain only synthetic test data and no user documents.

- `legacy.doc`: created with macOS `textutil` from an authored RTF containing a bold heading,
  Turkish characters and a two-cell table. Author/company metadata is explicitly EveryOS Tests/EveryOS.
- `legacy.xls`: created independently with `xlwt` 1.3.0, with two sheets, Unicode text, a SUM formula
  and a decimal number format.

Converted output was independently checked with `python-docx` 1.2.0 and `openpyxl` 3.1.5.
The browser applications use neither these generators nor those Python libraries.
