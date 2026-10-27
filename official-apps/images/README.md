# Image Viewer

Open selected JPEG, PNG, GIF, WebP, AVIF, BMP, ICO and SVG files through EveryOS. Native browser
image decoding determines actual support. No network images or ambient filesystem paths are used.
Permissions: `files:pick`, `files:save`, `storage:app`.

- Keep up to 100 persistent selected handles and restore the current image.
- Fit, zoom from 10% to 800%, pan by dragging or Alt+arrows, rotate by 90 degrees and reset.
- Navigate with previous/next or keyboard arrows and run a configurable slideshow. Suspend stops it.
- Show actual filename, read byte length, MIME, decoded dimensions and selected EXIF fields.
  exifr parses only bounded selected bytes; malformed metadata does not prevent native preview.
- Save an exact copy of the original through the EveryOS picker. Preview transforms do not alter
  the original. Unknown restored handle size is not invented as zero; streamed reads enforce the
  50 MiB ceiling. The preview refuses decoded images beyond 80 megapixels.

`images.v1` stores validated handle ids, current id and slide interval only. It never stores file
bytes, EXIF or temporary capability URLs. Read cancellation and revision fences handle selection,
permission/share changes and URL renewal. Revoked/absent handles are explicitly unavailable.
A capability URL is renewed on resume and every nine minutes. Browser strings are ordinary
managed memory, not an encrypted image cache.

Nine logic/interface tests cover bounded state, supported files, metadata failures, transforms,
original export, restored selection, suspend, late revoked reads and the SDK streamed-byte guard.
The real-browser workflow decodes synthetic real PNGs, reads a real EXIF Make tag, transforms
and pans them, verifies the
saved original bytes, restores selection, advances a mobile slideshow and reports damaged input.
All 26 locale keys are supplied in ten languages. The preview component and bounded reader are
shared with Gallery by explicit first-party source imports.

```bash
pnpm exec vitest run --project official-apps official-apps/images
```
