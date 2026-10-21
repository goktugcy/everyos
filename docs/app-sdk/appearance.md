# Appearance for desktop apps

Apps holding `appearance:manage` (a sensitive capability approved at install; the person's role
must allow `preferences:manage`) work with the person's wallpapers and folder icons, as Wallpaper
Studio and Icon Studio do. It runs in windows only.

| `app.appearance`                   | What it does                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `get()`                            | the default wallpaper, each desktop's own, presets, uploaded images, folder icon   |
| `image(source, maxEdge)`           | an uploaded image, or a preview of a preset wallpaper or folder icon, as a `Blob`  |
| `upload(kind, blob)`               | stores a JPEG, PNG or WebP the person made (crop, colors …) as a wallpaper or icon |
| `deleteImage(kind, id)`            | removes an uploaded image (a folder icon in use stays)                             |
| `setWallpaper(choice, desktopId?)` | one desktop's wallpaper, or the default of every desktop without its own           |
| `setFolderIcon(icon)`              | the default folder icon (a preset or an uploaded image)                            |
| `onChange(listener)`               | the person changed them (in Settings or another app)                               |

- Images go through `/api/app-sdk/appearance`, where the server checks the app's grant on every
  call, and are the same images the person manages in Settings: the same checks (real JPEG, PNG or
  WebP, decoded dimensions), sizes (10 MiB wallpapers, 2 MiB and 1024 px folder icons) and the
  limit of 20 each. Uploads and deletions are audited.
- Choices are the person's own preferences: the desktop checks the app's grant and the choice
  (known presets, `#rrggbb` colors, images that exist, desktops that exist) and applies it the way
  Settings does, so the desktop changes at once.
- Apps never load EveryOS URLs: images reach them as bytes, and they show them with `blob:` URLs.
- SVG is not accepted. An app that imports SVG (Icon Studio) sanitizes it and draws it to PNG in
  its own sandbox before uploading.
