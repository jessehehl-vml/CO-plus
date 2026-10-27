# CO Plus

This Chrome Extension content script adds tools and features to Choreograph Creative Optimizations, controlled via the side panel switches.

---

## 🛠 Installation

Follow these steps to install the extension in Chrome:

### 1. Download the Extension ZIP

- Click the download link: **[Download Extension ZIP](https://github.com/jessehehl-vml/CO-plus/archive/refs/heads/main.zip)**.
- Save the file somewhere easy to find (like your Desktop).

### 2. Unzip the File

- Locate the downloaded `.zip` file.
- **Windows**: Right‑click → "Extract All…"
- **Mac**: Double‑click the ZIP to extract.
- This will create a folder containing all the extension files.

### 3. Open Chrome Extensions Page

- In Google Chrome, type `chrome://extensions/` in the address bar and press **Enter**.
- Turn on **Developer mode** (the toggle switch in the top right).

### 4. Load the Extension

- Click the **"Load unpacked"** button.
- Select the folder you extracted in step 2.
- The extension will now appear in your extensions list.

### 5. Pin It

- Click the puzzle piece 🔧 icon in Chrome’s toolbar.
- Find your extension in the list and click the **pin icon** so it’s always visible.

### 6. Use the Side Panel

- Open the side panel by clicking the extension’s icon.
- Tabs, in order: **Screenshots**, **Recordings**, **Download** and **Other**.
- Use the switches to turn on/off features like:
  - **Screenshots**
  - **Recordings (MP4/H.264)**
  - **Download**
  - **Other:** Assets bulk download, Assets CSV export, Add template, Individual reload and Adset delivery status. Each description in the panel says which page the feature runs on.

---

### 📌 Updating the Extension

When a new version is released:

1. Download and unzip the new ZIP.
2. Go to `chrome://extensions/`.
3. Click **Remove** on the old extension.
4. Load the new folder using **"Load unpacked"**.

---

### ⚠ Notes for Use

- Only works on Choreograph creative pages that match the extension’s manifest.
- Requires you to be logged in to Choreograph with your Lemonpi session active — otherwise API features won’t work.

---

## ⚙ Features

### 1. Screenshots

**Main Functions:**

- `Screenshot all` – Captures all selected ad variants in a display adset's preview page.
- `Screenshot single ad` - Captures a single ad variant.

**Details:**

- Uses Lemonpi API to fetch variant data.
- Captures rendered ads via background script and saves as PNG/JPEG.
- Progress shown in side panel.
- Option to delay the capture to wait for animations to play.
- Option to double the dimensions of the ad for higher resolution images.

**Frames:**

Creatives that define GSAP `frameN-preview` labels on `Creative.timeline` (for example `frame1-preview`, `frame2-preview`) can be captured frame by frame.

- The side panel's **Frames** section shows a checkbox for each frame found. Select one or more frames, or none to take a single capture after the delay.
- Frames are detected automatically when the side panel is open on an adset page. The extension reads the labels from the template's code, and only renders the creative if they can't be read that way. Click **Re-detect** to run it again.
- Frame counts can differ per size. A selected frame that doesn't exist at a size is skipped for that size.
- Frames are captured instantly, so the **Delay** option is disabled (and shown as "(disabled)") while the current page has selected frames. Creatives without frame labels still use the delay.
- Files are named `<variant>_<size>_frame<N>`. `Screenshot all` adds each frame to the ZIP; `Screenshot single ad` downloads one file, or a ZIP when several frames are selected.

---

### 2. Screen Recordings

Record rendered display creatives as **MP4 with H.264 video**, suitable for importing into PowerPoint. This is separate from **Download Ads**, which downloads existing source media.

1. Reload the extension at `chrome://extensions/`, allow its new **tab-capture** extension permission if Chrome asks, then refresh the Choreograph page. Pin CO Plus to Chrome's toolbar so its icon is accessible from the preview tab.
2. Select ad sizes in the preview tree and click the top video-camera button beside the screenshot action. Its number shows the selected variant/size count, matching screenshots, and it is disabled when nothing is selected. The button opens the side panel directly on **Recordings** and stages the selected ads without opening a recording preview or encoder. Review **Start** and **End** (seconds or detected frames), then click **Start recording**. Only then does the preview tab open and recording initialization begin. The per-ad video-camera button uses the same staged review-and-start flow for one ad.
3. The **CO Plus - Ad Recording** preview tab becomes active in the same Chrome window. Click the **CO Plus extension icon in Chrome's toolbar while that tab is active** to authorize capture. One toolbar authorization covers the entire batch; there is no screen-sharing chooser or separate interface tab/window.
4. Keep the Choreograph source tab and preview tab open. Do not minimize Chrome or navigate the preview tab while recording. You can close and reopen the side panel without stopping the batch; the crop adapts to viewport changes. The preview tab closes automatically when the batch stops, leaving your other tabs open.
5. In **Recordings**, download the MP4 or ZIP for completed recordings, or click **Download PPTX** to get a PowerPoint file with each video on its own slide. Otherwise insert the extracted MP4 files into PowerPoint using **Insert > Video**. Use **Clear selection** after downloading to release the batch and select different ads.

While the toolbar click is needed, the side panel and preview show the CO Plus icon with an explicit instruction to click it in Chrome's toolbar. The actual toolbar icon also shows a **GO** badge. If the icon is not pinned, open Chrome's **Extensions** menu (puzzle piece) and choose **CO Plus**. The preview prompt and badge are removed before capture starts, so they are not included in the exported video.

**Defaults and limits:**

- **Start / End:** default to 0 and 15 seconds. Fractional seconds are supported; the end must follow the start, and the selected interval can be up to 120 seconds. An older duration setting does not override these defaults; explicitly saved start/end selections are retained.
- **Frame endpoints:** when the existing screenshot detector finds GSAP `frameN-preview` labels, choose **Frame** independently for Start or End. Frame-to-frame and mixed seconds/frame ranges are supported. **Re-detect frames** refreshes the menus. Recording endpoint selections are separate from screenshot frame checkboxes.
- The Start frame menu includes **Banner start**, which records from 0 seconds and allows any detected frame as End. It is a start-only option and is saved as a zero-second endpoint.
- Unavailable saved frame endpoints fall back to seconds: Start becomes **0 seconds**, End becomes **15 seconds**. With a frame-based start, the End frame menu only offers higher-numbered frames; changing Start advances an earlier End selection to the next valid frame. If there is no later frame, End switches to 15 seconds. Saved frames are preserved while detection is still pending.
- Frame labels resolve to their actual timeline times for each creative size. For example, Frame 3 to Frame 5 can produce different clip lengths at different sizes. A missing label or reversed interval stops the batch with an error and preserves completed clips; it never silently substitutes a different range.
- **Scale** (Recordings tab) exports at **2x** (default) or **1x** the creative size; a 160x600 ad at 2x becomes a 320x1200 MP4. On 1x displays the preview is enlarged so the 2x video has real detail; if the window is too small for that, the preview is shrunk to fit and the video is upscaled.
- **Progress:** the side panel shows the batch count and a **Current ad** bar with elapsed / clip seconds. Frame endpoints are converted to times per size before each ad starts, so frame ranges get timed progress too. Preparing and finalizing show a moving bar.
- MP4/H.264 is the only export format; unsupported browsers report an error rather than falling back to WebM. Use an up-to-date Chrome installation with H.264 encoding support.
- Capture uses Chrome's `tabCapture` API with the existing `activeTab` permission and requires Chrome 116 or newer. It no longer calls `getDisplayMedia()` or requests desktop/screen capture. Company Chrome policies can still prohibit tab capture; the extension does not override those policies or change macOS privacy settings.
- A hidden offscreen document owns the stream, H.264 encoder, MP4 finalization, and download URLs. The side panel owns all visible controls and progress. Closing the panel does not close the recording engine or discard downloads.
- Recordings are muted and target 30 FPS. Each creative is sought to the selected start before capture, then played for its resolved start/end interval.
- Creatives with a ready GSAP `Creative.timeline` use direct seeking and frame-label endpoints. Creatives without a timeline support **seconds-only** recording: choose Seconds for both Start and End. The recorder reloads the preview while capture is active, waits for its document/fonts/images, records through the selected end, then removes the loading and pre-start portions from the MP4.
- In seconds-only mode, time zero is the fresh creative's asset-ready point, not an animation-engine label. Arbitrary JavaScript animation startup cannot be sought or made frame-exact. The fallback runs in real time through End (plus loading), and finalization re-encodes the selected interval as H.264 so the exported first frame comes from that interval rather than an earlier keyframe. Long pre-rolls require more time and memory.
- Ads are recorded sequentially in real time. Batch size is limited to 500 ads; use smaller batches for long or large creatives, since recordings and the ZIP are held in memory.
- Only the ad area is exported, at the chosen scale. An odd width or height receives one pixel of white padding for H.264 compatibility. Tab capture runs at the tab's native resolution (up to 4096×2304). Large ads are scaled to fit the preview window before capture, so a larger available viewport gives better detail.
- **Cancel** stops the current ad and preserves completed recordings for download. **Record again** restarts the same selection and discards the previous download links, so download completed files first. **Clear selection** releases downloads and the offscreen document. One selection is retained at a time. Closing the source or preview tab stops the batch but retains completed files; reloading the extension discards recordings that have not been downloaded.
- Capture is bound to the toolbar-authorized preview tab. Its extension-scoped one-use stream token is consumed by the offscreen encoder, not a visible tab. Recordings are finalized locally into non-fragmented, seekable MP4 files with duration metadata; no video is uploaded.

MP4 finalization uses the bundled [Mediabunny](https://mediabunny.dev/) version **1.61.6**. Its original license is included in [recording/mediabunny-LICENSE](recording/mediabunny-LICENSE). No build step or runtime CDN is required.

To run the regression tests: `node --test tests/*.test.js`.

### 3. Bulk ad downloader

**Main Function:**

- `Download ads` – Fetches all meta or video creatives for current adset at chosen quality, zips, and downloads.

**Details:**

- Works with both images and video adsets.
- Picks best matching VAST video component based on the quality selected in the side panel.
- Progress and cancellation via side panel.

---

### 4. Other – Assets Bulk Download

**Main Function:**

- `Download all` – Fetches asset list, downloads all files, zips, and saves.

**Details:**

- Only works on the Libraries > media page.

---

### 5. Other – Assets Export CSV

**Main Function:**

- `Export CSV` – Fetches asset list, generates CSV with name, dimensions, and URL, then saves.

**Details:**

- Only works on the Libraries > media page.
- Significantly speeds up creating content feeds.

---

### 6. Other – Individual Reload

**Main Function:**

- `Reload` - Adds a reload button per ad variant on the preview page.

---

### 7. Other – External Template Preview

**Main Function:**

- `Add Template` - Adds a button to add an external template iframe to the preview page.

---

### 8. Other – Adset Delivery Status

Campaign pages replace the existing Status badges with delivery indicators for non-archived adsets while delivery status is enabled. Adset pages show the current adset's delivery indicator directly after its title; the page's menu stays on the right.

- Enable or disable it in the side panel under **Other > Adset delivery status**. Disabling it restores the original Status content and removes delivery indicators.
- **Live** means more than 1,000 impressions in the previous complete UTC calendar day.
- Hover over (or tab to) an indicator for a tooltip explaining why it is Live or Not live, with the impression count and date. This date is independent of the campaign table's selected date range.
- Exactly 1,000 impressions or fewer is **Not live**. Failed requests or unavailable totals show **Unknown**.
- Totals come from the adset analytics stats endpoint, not the top-10 variant endpoint.
- Checks are reused for five minutes within the page session, with at most three analytics requests in flight.
- Delivery checks never create reports.

Focused tests: `node --test tests/delivery-status.test.js`.

---
