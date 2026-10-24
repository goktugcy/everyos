# Video Player

Play user-selected videos through EveryOS's expiring media URLs and native browser controls.
Video bytes are streamed with range requests; the app never reads full videos into app memory or
storage. Only `files:pick` and `storage:app` are declared.

- Up to 20 named playlists of 100 selected videos each; create, rename, delete, select and remove
  references without deleting source files.
- Native play/pause/seek/volume, app play/pause, previous/next, 0.25–4× speed and fullscreen.
  Escape exits fullscreen. Playback advances to the next item and stops at the list's end.
- Resume after close/reopen from seek/pause and at most three-second playback checkpoints. URL
  renewal captures the native position and previous play state. Suspend pauses playback.
- Selected WebVTT/SRT sidecars, bounded to 1 MiB / 2,000 cues. Plain cue text is escaped; STYLE,
  REGION and markup are not executed. Subtitles can be shown/hidden and their handles restore.
- Actual `canPlayType` reports for common codecs, separated from successful decoding. Damaged or
  unsupported input gets a clear message and reload action. No transcoding is promised or run.

`video.v1` stores validated playlist/handle ids, names, up to 300 recent positions, 300 subtitle
references, speed, volume, muted state and caption preference. It never stores media bytes,
subtitle text or temporary URLs. Revocation hides the player and fences late calls. Restored
handle size may be unknown, which is normal for streamed media. Native browser codec and
fullscreen restrictions still apply.

Logic/interface tests cover limits, safe captions, resume offsets, streams without binary reads,
playlist management, restored position, decode failures and revoked access. The real browser
workflow uses a committed synthetic VP8 WebM: actual playback/range responses, speed, safe SRT
cues, fullscreen enter/exit, close/reopen position and settings, named lists, mobile layout,
end-of-list behavior and unsupported input. All 37 locale keys are supplied in ten languages.

```bash
pnpm exec vitest run --project official-apps official-apps/video
```

The owned test video can be regenerated with `node tests/e2e/make-video-fixture.ts`; CI consumes
its committed bytes and needs no recorder or transcoder installation.
