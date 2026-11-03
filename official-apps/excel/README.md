# Spreadsheet Editor

Official EveryOS reader and editor for `.xlsx`, legacy binary `.xls` workbooks and `.csv` files.
The bundled BetterOffice 0.5.1 engine provides a spreadsheet grid, cell editing,
formatting, sheets and formula recalculation. Open, Save and Save as use permissioned
EveryOS file handles, including direct Files/Desktop handoff.

Legacy XLS import uses the official SheetJS CE 0.20.3 distribution to convert BIFF data into XLSX.
It retains supported sheet data, formulas and number formats. Layout, drawings and other
unsupported features can change. The app displays this limitation and **always saves a modern
`.xlsx` copy**, leaving the original `.xls` unchanged. Native XLS writeback is not supported.
This is not full Microsoft Excel compatibility. Password-protected files are rejected and
macros are never executed or carried into the converted workbook.

All processing runs in the browser with bundled engine/WASM and no external conversion service.
Only `files:pick` and `files:save` are requested. Unsaved replacement and close actions require
confirmation, and save failures retain dirty state. Input is limited to 20 MiB, expanded OOXML
to 64 MiB, imported legacy workbooks to 100 sheets and 250,000 occupied cells. Conversion uses
a terminable worker and validates ZIP sizes, CRC and XML before opening in the editor.
English is the manifest default. Native controls support all ten EveryOS locales; engine labels
are complete in Turkish and English, with English fallback for unavailable translations elsewhere.

Run `pnpm --filter @everyos-official/excel build` and the tests in `test/`.
The real sandbox/open/edit/save acceptance test is `tests/e2e/office.spec.ts`.

CSV import detects comma, semicolon and tab separators, including Excel `sep=` lines. It accepts
UTF-8 (with or without BOM) and BOM-marked UTF-16 LE/BE, quoted fields and embedded line breaks.
Identifiers with leading zeroes, long integers and formula-looking source text remain text.
Ordinary safe numeric fields become numbers. Invalid encoding and malformed quotes are rejected.
Save writes CSV using its delimiter, encoding/BOM and record separator; quoting is normalized.
Only first-sheet values can be represented in CSV, so a multi-sheet CSV save requires confirmation.
Use Save as with an `.xlsx` filename to keep workbook features. The app never overwrites a CSV
with ZIP/OOXML bytes and preserves unsaved state if the save picker or sheet warning is cancelled.
