# Zotero to NotebookLM Connector

A seamless bridge between Zotero and Google NotebookLM. This project consists of a Zotero 7 plugin and a Chrome extension that work together to sync your research library into NotebookLM in seconds.

## Features
- **Project-Based Sync**: Create custom sync rules (tags, collections, libraries) for different NotebookLM projects.
- **Smart Duplicate Detection**: Only uploads new or modified files. Tracks sync history per notebook.
- **Batch Upload**: Injects multiple files into NotebookLM simultaneously using a single click.
- **Modern UI**: Clean, icon-driven interface for managing your research streams.

---

## Setup Instructions

### 1. Zotero Plugin Installation
1. Download the `notebooklm-sync.xpi` file from this repository.
2. In Zotero 7, go to **Tools -> Plugins**.
3. Click the gear icon (⚙️) and select **"Install Plugin From File..."**.
4. Select the `.xpi` file and click **Install**.
5. Restart Zotero.

### 2. Chrome Extension Installation
1. Open Google Chrome and go to `chrome://extensions`.
2. Enable **"Developer mode"** (top right corner).
3. Click **"Load unpacked"**.
4. Select the `chrome-ext` folder from this repository.

---

## How to Sync
1. Open **Zotero** and ensure it's running.
2. Navigate to your target notebook in **Google NotebookLM**.
3. Click the **Zotero Connector** icon in your Chrome extension bar.
4. Click **"+"** to create a new project.
5. Enter your project name and optional filters (Collection name or #Tag).
6. Click **"Sync"** on your project card.
7. The extension will automatically open the "Add Source" dialog and inject your Zotero files.

## Practical Tips
- **Library ID**: For most users, this is `0` (your personal library).
- **Collection Name**: Enter the exact name of the Zotero folder you want to sync. It works recursively (includes sub-folders).
- **Reset**: If you want to re-upload everything regardless of history, you can delete and recreate the project or clear the extension storage.

---

## Troubleshooting
- **Connection Error**: Ensure Zotero is open and the NotebookLM tab is fully loaded.
- **No Files Found**: Double-check your Tag/Collection names. They are case-insensitive but must match the spelling.
- **Debugger Warning**: Chrome shows a bar saying "Debugger is attached". This is normal as the extension uses the Chrome DevTools Protocol to safely automate the file injection.
