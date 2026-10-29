EveryOS 0.1.39 adds process inspection, assistant explanations and responsive desktop actions.

- Select a process in System Monitor to inspect its CPU, memory, threads, parent PID, start time
  and supervisor in a side panel within the same window. Right-click and Shift+F10 expose its
  context menu. Supported service/container controls require confirmation and preserve existing
  permissions, audit events and protected-system rules; independent processes remain read-only.
- Ask an available Hermes Agent, OpenClaw or local model to explain a process with one click.
  Replies stream into the panel. The request includes process identity and measurements, with
  command arguments, private filesystem paths and environment variables excluded.
- Newly installed desktop apps and their icons appear immediately. Adding a desktop shortcut
  from the Dock no longer requires a page refresh.
- Application lists and the launcher offer Open, Add to Desktop, Pin/Unpin Dock and confirmed
  removal of installed apps. Removing an app also clears its saved shortcuts and open windows.
- A completed system update refreshes an older web client once after the new API confirms the
  installed version. Background recovery covers missed restart events even with Updates closed.
- Update the catalog field validator to `re2js` 2.8.7, which fixes
  [GHSA-gg6h-894w-4m9c](https://github.com/advisories/GHSA-gg6h-894w-4m9c).
- The coordinated SDK advances to 1.0.2 and the official catalog retains all 29 apps.

29 Ekim Cumhuriyet Bayramımız kutlu olsun! Cumhuriyetimizin kurucusu Gazi Mustafa Kemal Atatürk’ü
ve silah arkadaşlarını saygı, minnet ve özlemle anıyoruz. Yaşasın Cumhuriyet!
