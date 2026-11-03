# Creality Cloud Downloader

Chrome extension that exports the files you are authorized to download from a Creality Cloud model into one ZIP archive. It uses the signed-in session already open in the website and never requests or stores passwords, cookies, or tokens.

The ZIP contains a folder named after the model, `metadata.txt`, `description.txt`, `description.html`, STL/CAD files, 3MF profiles published by the model author, and gallery images converted to PNG.

## Install

1. Download `dist/creality-cloud-downloader.zip` and extract it to a permanent folder.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the extracted `creality-cloud-downloader` folder — the folder containing `manifest.json`.
5. Pin the extension icon if desired.

To build the package from source, use Node.js 20 or newer:

```bash
npm install
npm test
npm run package
```

## Use

1. Sign in to `crealitycloud.com`.
2. Open a model details page, such as `https://www.crealitycloud.com/model-detail/drill-dust-collector-v3`.
3. Click the extension icon. Its popup shows the export status and begins the export for a new model automatically.
4. Reopen the popup at any time to see the current stage, details, and progress. You may close it while the export continues.

The action icon includes a progress bar at its bottom edge. It is blue while working, green after the ZIP is ready, and red after an error.

The extension includes all STL/CAD files that Creality Cloud permits your account to download and only 3MF profiles published by the model author. A failed item does not stop the remaining items: the extension creates a partial ZIP and lists every missing item and its reason in the extension popup.

If ZIP creation, the final download, or individual files fail, files that were already transferred stay in temporary private browser storage. Retry the export on the same page to reuse them. The cache is discarded when you reload or leave the model page, cancel the export, or finish an export without missing files.

## Permissions

- `activeTab` and `scripting`: read data already loaded in the active model page and request official URLs from that page.
- `downloads`: starts one final ZIP download.
- `offscreen`: downloads files, converts images to PNG, and creates the ZIP without interrupting work when the background service is suspended.
- `storage`: temporary private browser storage for the export and popup status.
- Access to `crealitycloud.com`: required for the site APIs, images, and official download URLs.

The extension does not read cookies directly, intercept network traffic, access unrelated websites, or load remote code. It writes a standards-compliant ZIP directly in the offscreen document, without WebAssembly, generated workers, or remote code, which keeps it compatible with Manifest V3 extension security rules.

## Known limits

- Your account must be entitled to download the model. Paid, removed, Premium-limited, or restricted files remain subject to Creality Cloud rules.
- One export can run at a time. An export does not resume after Chrome is closed.
- Creality Cloud issues final file URLs after authentication. If it changes these APIs, the extension will need an update.
