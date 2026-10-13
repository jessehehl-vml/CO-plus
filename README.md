# CO Plus

This Chrome Extension content script adds tools and features to Choreograph Creative Optimizations, controlled via the side panel switches.

---

## 🛠 Installation

Follow these steps to install the extension in Chrome:

### 1. Download the Extension ZIP

- Click the download link: **[Download Extension ZIP](https://gitlab.com/jessehehl/creative-optimizations-plus/-/archive/main/creative-optimizations-plus-main.zip?ref_type=heads)**.
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
- Use the switches to turn on/off features like:
  - **Screenshots**
  - **Download**
  - **Auto‑map**
  - **Assets (ZIP/CSV)**
  - **Individual Reload**
  - **External Template Preview**

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
- Frame capture: for creatives that expose GSAP `frameN-preview` labels on `Creative.timeline`, the side panel detects the available frames per size (in a hidden background tab) and lets you pick which to capture. Frames are captured instantly, without the delay, and named `<variant>_<size>_frame<N>`. Creatives without labels, or with no frames selected, use the delayed single capture. Multiple frames from the single-ad button are downloaded as a ZIP.
- Option to double the dimensions of the ad for higher resolution images.

---

### 2. Bulk ad downloader

**Main Function:**

- `Download ads` – Fetches all meta or video creatives for current adset at chosen quality, zips, and downloads.

**Details:**

- Works with both images and video adsets.
- Picks best matching VAST video component based on the quality selected in the side panel.
- Progress and cancellation via side panel.

---

### 3. Auto-mapping

**Main Function:**

- `Auto-map` – Opens a popup to map targeting columns to node types & triggers, then updates targeting config via Lemonpi API.

---

### 4. Assets – Bulk Download

**Main Function:**

- `Download all` – Fetches asset list, downloads all files, zips, and saves.

**Details:**

- Only works on the Libraries > media page.

---

### 5. Assets – Export CSV

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

### 6. Other – External Template Preview

**Main Function:**

- `Add Template` - Adds a button to add an external template iframe to the preview page.

---
