# Interface sound effects

The header's **Sound effects: On/Off** switch is shared by the hub, Intelligence
Map, Crypto, Facial, Social, Dark Web and IP workspaces. It defaults to On at a
low fixed gain (0.075). The preference lives in `ct_atlas_sound_effects` in
localStorage (`on` / `off`), per browser origin; the main site and its Cloudflare
mirror therefore have separate preferences.

No audio files, network audio service, or dependency is required. A lazy Web
Audio context generates damped sine transients: 60 ms click, 100 ms success,
85 ms error. Browsers may require a user gesture before audio can run. Failure
or absence of Web Audio or browser storage never blocks the interface.

Only module links, Dark Web view changes, explicit analysis submissions and
principal saves are wired. Hover, scrolling, form edits, map filters, automatic
refresh and Crypto URL autorun are silent. Save clicks in the Crypto workspace
acknowledge the local action; they do not claim that its deferred server save
has completed. Analysis result cues follow the actual response path; degraded
results use the error cue in Facial, Social, IP and Custom Intelligence.

`CTAtlasSound.begin()` plays the action click and returns a one-shot completion
callback accepting `success` or `error`. Muting invalidates pending callbacks,
including when the user enables sound again before a result arrives. Muting
zeros the master gain, stops/disconnects the active oscillator and cancels
pending context-resume playback. Storage events synchronize open tabs. Hidden
pages suppress feedback. There is one voice, no queue, and a 120 ms minimum
interval: very fast completions/rapid repeated actions can intentionally be
silent instead of producing overlapping sounds.

## Validation

- `node --test tests/*.test.cjs`: repository tests, including audio lifecycle,
  suspended-context mute, storage restrictions and selective navigation.
- `node tests/sound-browser-smoke.cjs`: Chrome/Chromium integration tests with
  Playwright installed. Optional `PLAYWRIGHT_MODULE` and `CHROME_EXECUTABLE`
  environment variables select existing installations. All HTTP responses are
  intercepted; no real session, analysis service or stored outlet is changed.
  Checks all seven page switches, persistence, 390 px layout, analysis failures,
  Facial success and mute-in-flight, and Dark Web views/save confirmation.

Both GitHub Pages and `tools/deploy_mirror.sh` include `sound-effects.js`.
