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

Record rendered display creatives as **MP4 videos** for review or use in PowerPoint. This is separate from **Download Ads**, which downloads the original source media.

1. After updating CO Plus, reload it at `chrome://extensions/` and refresh the Choreograph page. If Chrome asks for permission to capture a tab, allow it. Pin CO Plus to the toolbar, or locate it in Chrome's Extensions menu (puzzle piece).
2. Select the ad sizes you want in the preview tree. Click the video-camera button beside the screenshot action to record the selection, or use an ad's video-camera button to record just that ad. In the **Recordings** tab, review the **Start** and **End** times, then click **Start recording**.
3. When the **CO Plus - Ad Recording** preview tab opens, click the CO Plus icon in Chrome's toolbar to authorize recording. This click starts capture for the batch; no screen-sharing chooser is needed.
4. Keep the Choreograph page and recording preview open. Don't minimize Chrome or navigate away from the preview while recording. You can close and reopen the side panel without stopping. The preview tab closes automatically when recording ends.
5. In **Recordings**, download individual MP4s, a ZIP of the completed videos, or a PowerPoint file with one video per slide using **Download PPTX**. Use **Clear selection** when you're done to choose other ads.

**Settings and tips:**

- **Start / End** default to 0 and 15 seconds. Fractional seconds are supported; End must be after Start, and a recording can be up to 120 seconds long.
- If frame options are available, choose **Frame** for Start or End to record between detected creative frames. You can mix a time and a frame endpoint. Use **Re-detect frames** to refresh the available frames. **Banner start** begins at the start of the creative and is available as a Start option.
- Frame times can differ between ad sizes, so the same frame range may produce different video lengths. If a selected frame is no longer available, choose a valid time or frame before recording.
- **Scale** sets the exported video size to **1x** or **2x** the ad's dimensions (**2x** is the default). Large ads may need a larger preview window for the best image quality.
- Videos are recorded without sound at 30 FPS. Ads in a batch are recorded one at a time; batches can contain up to 500 ads. Smaller batches are recommended for long recordings or large ads.
- Recording requires Chrome 116 or newer and H.264 video support. If your organization manages Chrome, its policies may prevent tab recording.
- Creatives with detected animation frames support frame-based recording. If frame options aren't available, use seconds for both Start and End. In that mode, recording follows the creative in real time and may take longer while the creative loads.
- The side panel shows batch progress and the active ad's recording progress. Completed videos remain available to download if you cancel a batch.

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

---
