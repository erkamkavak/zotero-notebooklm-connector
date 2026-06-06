# Zotero to NotebookLM Connector

A seamless bridge between Zotero and Google NotebookLM. This project now uses:
- a Zotero 7 plugin (local file/metadata API),
- a Chrome extension UI for project management,
- a browser-native NotebookLM API bridge adapted from `agmmnn/notebooklm-sdk`.

## Features
- **Project-Based Sync**: Create custom sync rules (tags, collections, libraries) for different NotebookLM projects.
- **Smart Duplicate Detection**: Only uploads new or modified files. Tracks sync history per notebook.
- **Batch Upload**: Uploads files to NotebookLM through NotebookLM's internal API from the logged-in NotebookLM tab.
- **Zotero Metadata Picker**: Choose Zotero libraries, collections, and tags from detected values while creating projects.
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
2. Open NotebookLM in Chrome and sign in.
3. Open your target NotebookLM notebook tab, or copy its notebook ID into the project settings.
4. Click the **Zotero Connector** icon in your Chrome extension bar.
5. Click **"+"** to create a new project.
6. Enter your project details:
    - **Project Name**: Any name you'd like.
    - **Zotero Library**: Choose your personal library or a group library.
    - **Zotero Collection**: (Optional) Choose or type a Zotero collection. If blank, searches the selected library.
    - **Sync Tag**: (Optional) Choose or type a tag applied to items you want to sync.
    - **Notebook ID**: (Optional but recommended) NotebookLM notebook ID from URL (`.../notebook/<ID>`). If omitted, the extension tries to detect it from your active NotebookLM tab.
7. Click **"Sync"** on your project card.

---

## Troubleshooting
- **Connection Error**: Ensure Zotero is open.
- **NotebookLM Auth Error**: Ensure a NotebookLM tab is open in Chrome and signed in.
- **No Files Found**: Double-check your Tag/Collection names. They are case-insensitive but must match the spelling.
