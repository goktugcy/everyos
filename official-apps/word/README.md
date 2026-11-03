# Word Editor

Official EveryOS reader and editor for `.docx` and legacy binary `.doc` files.
The bundled BetterOffice 0.5.1 engine provides page rendering, text editing, formatting,
images and tables. Open, Save and Save as use permissioned EveryOS file handles.
Opening a document from Files or Desktop delivers only its explicit file grant.

Legacy DOC import uses a pinned 0BSD reader (see `packages/office-core/src/vendor/legacy-doc/`).
It converts paragraphs, formatting, tables, supported images and links into DOCX.
Other text stories are retained as labeled appendices; their original placement is not retained.
Complex layout, drawings and unsupported features can change. The app displays this limitation
and **always saves a modern `.docx` copy**, leaving the original `.doc` unchanged.
This is not full Microsoft Word compatibility. Password-protected Office files are rejected;
macros are never executed. Native DOC writeback is not supported.

The app bundles its engine, WASM and fonts, with license notices inside the package.
On plain HTTP LAN origins, a bundled SHA-256 adapter supports the document writer without
requiring native SubtleCrypto; native WebCrypto is used when available. No document
is sent to an external conversion service. It requests only `files:pick` and `files:save`.
Unsaved replacement and close actions require confirmation; save failures retain dirty state.
Input is limited to 20 MiB, with validated ZIP sizes/CRC/XML and a bounded conversion worker.
English is the manifest default. Native controls support all ten EveryOS locales; engine labels
are complete in Turkish and English, with English fallback for unavailable translations elsewhere.

Run `pnpm --filter @everyos-official/word build` and the tests in `test/`.
The real sandbox/open/edit/save acceptance test is `tests/e2e/office.spec.ts`.
