# Changelog

## 1.5 - 2026-11-24

The strategy checker is still in beta.

### Changed

- Strategy checker sample counts now default to 1 and accept values from 1 to 100. A maximum of 1 performs routing checks only, without additional variant sampling or missing-variant warnings.

### Removed

- The Adset delivery status feature: Live / Not live badges on campaign and adset pages, their tooltip, and the **Other** switch. Its stored setting is deleted on update.

## 1.4 - 2026-11-20

### Added

- Production-tag verification for every feed line ID and configured ad size in one sequential run, with offscreen tag execution, and feed comparison based on the returned content.
- Production-tag content is matched against all feed variants to identify cross-audience serves; the summary compares each served variant with its line's feed-expected set.
- Expandable production-tag evidence shows returned content values, per-variant field matches, differences, and missing feed columns. Unique partial candidates are labeled as unconfirmed.
- The strategy checker has two modes, Analyze strategy and Run tags, with controls on the left and results on the right.
- Production tag runs show live progress: step, progress bar, current tag, running counts, and elapsed time.
- Each production tag result shows the signals the tag actually sent (e.g. placement ID and postal code) and flags any simulated signal that was not sent.
- Production tag results start with a summary verdict on whether served variants match the strategy.
- Date & Time outcomes are verified by simulating a local time inside each time-of-day range; overlapping or identical sibling ranges are flagged.
- Multi-variant strategy nodes can be sampled until every assigned variant is served (maximum 1 by default, configurable up to 100), with observed variant counts and percentages per strategy node, size, and time (pooling the line IDs that reach each node). A maximum of 1 performs routing checks only.

### Changed

- Production tags for a strategy branch (for example one `dsp-placementid`) run only at the ad sizes that branch's variants use. Placement IDs are no longer tested at sizes they never serve, which made every tag return the root fallback variant.
- Lookup feeds (line ID → audience, without variant rows) are supported: variants are read from the adset's content feed, joined on the strategy's targeting column (for example `audience`). The variant ID column is detected from the strategy's variant IDs. If no feed contains them, the strategy checker shows an error, because served variants cannot be identified.
- The new tab now loads and visualizes the strategy before revealing production-tag controls; impression simulation and results have been removed.
- The feature is renamed **Strategy checker** (adset button, extension setting, and page title).
- Strategies with repeated copies of the same dynamic feed (for example one per DSP placement) and uploaded CSV feeds (`assets.lemonpi.io`) now load. When the feed is not keyed on the DSP line ID, or the strategy branches on another DSP signal, the strategy analysis is shown read-only and tag runs are disabled with the reason.
- Tag runs support DSP signal branches (for example placement ID) and postcode-keyed feeds: each placement × outcome is run once with a postcode from the mapping feed, sent as `location.postal-code` context.
- The strategy analysis starts with an overall summary: total outcomes not matching the feed, affected paths, and outcomes that mismatch under every path.
- Strategy analysis outcomes can be filtered by status, path (for example placement ID), and outcome name or variant ID.
- Tag verification always runs all feed line IDs and no longer displays the rendered creative.

### Fixed

- Feed columns renamed on import (for example `Line Item IDs (AD GroupID)` → `Line_Item_IDs_AD_GroupID`) are now resolved using the feed's column mappings.
- Production-tag results now read the content object from the sandbox response envelope before matching it to feed rows.

## 1.3 - 2026-11-20

### Fixed

- The Choreograph content script no longer fails to load due to an unsupported ES module import, restoring injected extension features.
- Recordings no longer hang on "Finalizing" while another app (such as a macOS screen recorder) holds the hardware H.264 encoder. A stalled finalization is cancelled and retried with Chrome's software encoder; an untrimmed recording falls back to the unprocessed MP4.

### Added

- Decision-tree impression simulator with an audience-branch overview, feed/strategy comparison, root fallback, and non-applying mismatch suggestions; its button can be enabled or disabled under **Other**.
- **Download PPTX** in the Recordings tab after a batch finishes. It builds a 16:9 PowerPoint file locally with one slide per recording, following the storyboard template: a "Banner format: WxH" label at the top left, a "*Hover over image for animation control bar" hint at the bottom left, and the embedded MP4 enlarged up to 2x to fill the remaining space, with its first frame as the poster image.

## 1.2 - 2026-10-21

### Removed

- The Auto-map feature: its side-panel tab, the "Generate Tree" menu item, and the bundled `content/node_types.json`.
- The Reporting tab and the Default rate feature: badges, report creation, background polling, the `alarms` permission, and the bundled PapaParse library. Stored default-rate results are deleted on update.

### Changed

- Side panel tabs are now Screenshots, Recordings, Download and Other. **Adset delivery status** and the Assets switches moved to **Other**, and each Other description names the page it runs on.
- Adset delivery badges show a styled tooltip explaining why an adset is Live or Not live, with the impression count and day, instead of the browser's plain tooltip.

### Fixed

- On adset pages the delivery badge no longer pushes the title row's menu button to the middle of the screen.
- Tab capture now requests native-size frames (up to 4096×2304). Chrome's default for tab capture rescaled the viewport into a fixed screen-sized frame with rounded letterbox bars, so the crop landed about one pixel right of the creative and showed a grey line on the right edge.
- Sub-pixel aspect mismatches between the rounded viewport size and the captured frame are no longer treated as letterbox padding. This padding shifted the crop right by about one pixel, cutting off the creative's left border and adding a grey strip on the right.
- Preserve exact fractional capture bounds instead of rounding outward into the preview background, removing a grey right-edge strip from recordings without trimming the creative's own border.
- Recording reloads wait for a new Chrome document ID when reusing the same preview URL, preventing scripts from targeting the document being removed. Readiness polling tolerates transient frame replacement within its timeout without hiding permission errors or cancellation.
- Recordings wait for a post-seek synchronization marker in the captured stream before starting the encoder, so the first video frame uses the selected start state instead of the creative's loaded state. The marker is outside the exported ad area.

### Added

- Per-ad recording progress in the side panel ("Current ad", elapsed / clip seconds). Frame endpoints are resolved to each size's label times before recording, so frame ranges show the same timed progress as seconds; preparing and finalizing show an indeterminate bar.
- Recording **Scale** option (1x or 2x, default 2x). 2x exports double-resolution MP4s, enlarging the preview on 1x displays. Seconds-only re-encoding now uses Mediabunny's very-high quality preset.
- Seconds-only recording for creatives without `Creative.timeline` or `Creative.ready()`. A fresh preview reload establishes the asset-ready clock; local H.264 trimming removes loading and pre-start content. Frame endpoints remain timeline-only.
- Recording Start/End controls support fractional seconds or detected frame labels independently, including mixed endpoints and per-size timeline resolution.
- Single-ad and selected-ad screen recordings, with MP4/H.264 output for PowerPoint.
- Side-panel controls for duration, enable/disable, Start/Cancel, selection progress, repeat recording, retained downloads, and clearing a batch.
- Toolbar-authorized tab capture, animation restart, native-size cropping, sequential recording, and ZIP downloads for batches.
- Local MP4 finalization using bundled Mediabunny 1.61.6, producing seekable, non-fragmented files without uploading video. Timeline recordings are remuxed; seconds-only fallback recordings are re-encoded when trimming.

### Changed (recordings)

- The Start frame menu includes Banner start, equivalent to 0 seconds, with all detected frames available as endpoints.
- Unavailable recording frame endpoints reset to the 0/15-second defaults. End frame menus only offer frames after the selected Start; selecting the last start frame switches End to seconds.
- Clicking the top recording icon opens the side panel directly on Recordings and stages settings without creating a preview tab or encoder. Start recording creates the preview and initializes capture; the toolbar-authorization overlay follows. Clearing an unstarted selection does not require an encoder.
- Recording authorization now shows a direct "Click CO Plus in Chrome's toolbar" instruction, the extension icon, and an Extensions-menu fallback in the side panel and preview. A GO toolbar badge highlights the required click; prompts are removed before capture starts.
- The top recording button shows the selected variant/size count, matching screenshots, and prepares the batch without starting it. Review the range and click Start recording in the side panel; Chrome's preview-toolbar authorization is still required.
- Recording uses Chrome's `tabCapture` permission instead of desktop sharing. Click CO Plus in the preview window's toolbar once per batch; no screen-sharing chooser or desktop-capture fallback is used.
- All recording UI lives in the side panel. A hidden offscreen document owns encoding and downloads, so closing the panel does not interrupt the batch or discard completed files.
- Only the creative preview opens as a tab in the source Chrome window. Cleanup closes only that preview tab. Crop geometry adapts when the side panel closes or changes the viewport.
- The offscreen permission is required; the encoder communicates with the worker using only `chrome.runtime`.
- Chrome 116 or newer is required for the service-worker tab-capture API.

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
