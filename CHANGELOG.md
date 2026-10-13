# Changelog

## 1.1

### Added

- **Frame screenshots.** Creatives that define GSAP `frameN-preview` labels on `Creative.timeline` can be captured frame by frame. The side panel has a new **Frames** section with a checkbox per frame; select none to keep the single delayed capture.
- Frames are detected per size by reading the template's source (fast), falling back to rendering the creative when the labels can't be read from the code.
- Frames are captured instantly, without the delay, and named `<variant>_<size>_frame<N>`. The single-ad button zips multiple frames.
- The Delay field shows "(disabled)" and is greyed out while the current page has selected frames.
- Screenshot errors are also shown on the Choreograph page, not only in the side panel.

### Fixed

- 401 errors after the session token refreshed: the token is no longer cached at page load.
- 403 `no-permission-for-advertiser` when several Choreograph windows are open: each tab now uses the token its own app last sent successfully (recorded by `page-auth.js`), with the stored session only as a fallback.
- Scale 1 (and other scales) captured only part of the ad on high-DPI displays: the crop now follows the real pixel ratio and is resized to the chosen scale.
- The bulk screenshot button rewrote itself in a loop, which could swallow the first click.
- The per-ad screenshot button sometimes ignored the first click; it now starts on press and ignores repeat clicks while running.
- Captures now run one at a time and respect Chrome's capture rate limit, so repeated clicks no longer open many tabs.
- A stray statement in the bulk screenshot loop that threw when a selected variant had no matching data.
- The Frames section no longer resets when the extension's own capture tab becomes active.
- Frame detection error messages are shown in red.
