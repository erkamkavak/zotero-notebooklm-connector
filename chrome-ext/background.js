const ZOTERO_HOST = "http://localhost:23119";
let syncLock = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "START_SYNC") {
        runSyncProcess(request.project);
        sendResponse({ status: `Syncing "${request.project.name}"...` });
        return true;
    }

    return true;
});

async function runSyncProcess(project) {
    if (syncLock) {
        notifySyncDone(project?.name || "");
        return;
    }
    syncLock = true;

    try {
        await runSyncProcessInner(project);
    } finally {
        syncLock = false;
        notifySyncDone(project?.name || "");
    }
}

function notifySyncDone(projectName) {
    chrome.runtime.sendMessage({ action: "SYNC_DONE", projectName }).catch(() => {});
}

function updateStatus(text) {
    chrome.runtime.sendMessage({ action: "UPDATE_STATUS", text }).catch(() => {});
}

function normalizeFilename(name) {
    return String(name || "").toLowerCase().trim().replace(/\s+/g, " ");
}

function buildHistoryKey(notebookId, fileId) {
    return `${notebookId}_${fileId}`;
}

function isFileUnchanged(file, historyEntry) {
    if (!historyEntry) return false;
    if (file.hash && historyEntry.hash) return file.hash === historyEntry.hash;
    return file.dateModified === historyEntry.dateModified;
}

function parseNotebookIdFromUrl(url) {
    if (!url) return null;
    const match = url.match(/\/notebook\/([^\/\?#]+)/);
    return match ? match[1] : null;
}

async function resolveNotebookTarget(project) {
    const configured = (project.notebookId || "").trim();
    const allTabs = await chrome.tabs.query({});
    const notebookTabs = allTabs
        .filter((t) => t.url && t.url.startsWith("https://notebooklm.google.com"))
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));

    if (notebookTabs.length === 0) {
        throw new Error("Open a NotebookLM tab while syncing so the extension can use your logged-in session.");
    }

    const targetTab = configured
        ? notebookTabs.find((tab) => parseNotebookIdFromUrl(tab.url) === configured) || notebookTabs[0]
        : notebookTabs[0];

    const notebookId = configured || parseNotebookIdFromUrl(targetTab.url);
    if (!notebookId) {
        throw new Error("Notebook ID is missing. Open a specific NotebookLM notebook tab or set Notebook ID in project settings.");
    }

    return { notebookId, tabId: targetTab.id };
}

async function sendNotebookMessage(tabId, message) {
    try {
        return await chrome.tabs.sendMessage(tabId, message);
    } catch (firstError) {
        if (!String(firstError?.message || "").includes("Receiving end does not exist")) {
            throw firstError;
        }

        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"]
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        return chrome.tabs.sendMessage(tabId, message);
    }
}

async function listNotebookSourcesViaExtension(tabId, notebookId) {
    const response = await sendNotebookMessage(tabId, {
        action: "NOTEBOOKLM_LIST_SOURCES",
        notebookId
    });

    if (!response?.success) {
        throw new Error(response?.error || "NotebookLM source scan failed");
    }

    const sourceNames = Array.isArray(response.sourceNames) ? response.sourceNames : [];
    const counts = new Map();

    for (const name of sourceNames) {
        const normalized = normalizeFilename(name);
        if (!normalized) continue;
        counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }

    const sources = [];
    const duplicates = [];

    for (const [normalizedName, count] of counts.entries()) {
        sources.push({ normalizedName });
        if (count > 1) {
            duplicates.push({ normalizedName, count });
        }
    }

    sources.sort((a, b) => a.normalizedName.localeCompare(b.normalizedName));
    duplicates.sort((a, b) => b.count - a.count);

    return {
        sources,
        duplicates,
        scanMethod: "api"
    };
}

async function uploadBatchViaExtension(tabId, notebookId, batchItems) {
    return sendNotebookMessage(tabId, {
        action: "NOTEBOOKLM_UPLOAD_FILES",
        notebookId,
        files: batchItems.map((item) => ({
            clientFileId: item.id,
            filename: item.filename,
            mimeType: item.mimeType,
            base64: item.base64
        }))
    });
}

async function runSyncProcessInner(project) {
    updateStatus(`[${project.name}] Getting list from Zotero...`);

    try {
        const listReq = await fetch(`${ZOTERO_HOST}/notebooklm/list`, {
            method: "POST",
            headers: {
                "Zotero-Allowed-Request": "true",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                tag: project.tag,
                collectionName: project.collection,
                libraryID: project.libraryID
            })
        });

        if (!listReq.ok) {
            const errorText = await listReq.text();
            updateStatus(`Error: ${listReq.status} - ${errorText}`);
            return;
        }

        const filesToSync = await listReq.json();
        if (filesToSync.length === 0) {
            updateStatus(`[${project.name}] No items found matching filters.`);
            return;
        }

        const { notebookId, tabId } = await resolveNotebookTarget(project);

        const storage = await chrome.storage.local.get("syncHistory");
        const syncHistory = storage.syncHistory || {};

        const uncertainCandidates = [];
        const decisionByFileId = new Map();
        let existingNotebookDuplicates = [];
        let notebookScanSucceeded = false;

        for (const file of filesToSync) {
            const historyKey = buildHistoryKey(notebookId, file.id);
            const history = syncHistory[historyKey];

            if (!history) {
                uncertainCandidates.push(file);
                continue;
            }

            if (isFileUnchanged(file, history)) {
                decisionByFileId.set(file.id, {
                    decision: "skip_up_to_date",
                    reason: "history_match"
                });
            } else {
                decisionByFileId.set(file.id, {
                    decision: "upload",
                    reason: "history_changed"
                });
            }
        }

        if (uncertainCandidates.length > 0) {
            updateStatus(`[${project.name}] Checking notebook sources...`);
            try {
                const sourceScan = await listNotebookSourcesViaExtension(tabId, notebookId);
                const existingSourceNames = new Set(
                    sourceScan.sources
                        .map((s) => normalizeFilename(s.normalizedName))
                        .filter(Boolean)
                );
                existingNotebookDuplicates = sourceScan.duplicates
                    .filter((d) => d && d.normalizedName && d.count > 1)
                    .map((d) => ({ name: d.normalizedName, count: d.count }));
                notebookScanSucceeded = true;

                for (const file of uncertainCandidates) {
                    const normalizedFileName = normalizeFilename(file.filename || file.title);
                    if (!normalizedFileName || existingSourceNames.has(normalizedFileName)) {
                        decisionByFileId.set(file.id, {
                            decision: "skip_possible_duplicate",
                            reason: "filename_already_present_in_notebook"
                        });
                    } else {
                        decisionByFileId.set(file.id, {
                            decision: "upload",
                            reason: "notebook_scan_clear"
                        });
                    }
                }
            } catch (e) {
                console.warn("[Sync] Notebook source API scan failed. Applying fail-closed policy:", e);
                for (const file of uncertainCandidates) {
                    decisionByFileId.set(file.id, {
                        decision: "skip_possible_duplicate",
                        reason: "notebook_scan_failed"
                    });
                }
                updateStatus(`[${project.name}] Could not verify notebook sources. Skipping ${uncertainCandidates.length} uncertain file(s) to avoid duplicates.`);
            }
        }

        const dedupDecisions = filesToSync.map((file) => {
            const decision = decisionByFileId.get(file.id);
            if (!decision) {
                return {
                    file,
                    decision: "skip_possible_duplicate",
                    reason: "missing_dedup_decision"
                };
            }
            return { file, ...decision };
        });

        let filesNeeded = dedupDecisions.filter((d) => d.decision === "upload").map((d) => d.file);
        const possibleDuplicateFiles = dedupDecisions
            .filter((d) => d.decision === "skip_possible_duplicate")
            .map((d) => d.file);

        let blockedPossibleDuplicates = possibleDuplicateFiles.map(
            (file) => file.filename || file.title || `attachment-${file.id}`
        );
        if (existingNotebookDuplicates.length > 0 && notebookScanSucceeded) {
            updateStatus(`[${project.name}] Notebook already contains duplicate source names (${existingNotebookDuplicates.length} groups).`);
        }

        if (blockedPossibleDuplicates.length > 0) {
            updateStatus(`[${project.name}] Skipped ${blockedPossibleDuplicates.length} possible duplicate(s).`);
        }

        if (filesNeeded.length === 0) {
            if (blockedPossibleDuplicates.length > 0) {
                return;
            }
            updateStatus(`[${project.name}] All items up to date.`);
            return;
        }

        const totalToSync = filesNeeded.length;
        updateStatus(`[${project.name}] Found ${totalToSync} file(s) to sync...`);

        const BATCH_SIZE = 5;
        let syncedCount = 0;

        for (let i = 0; i < totalToSync; i += BATCH_SIZE) {
            const currentBatchFiles = filesNeeded.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(totalToSync / BATCH_SIZE);

            updateStatus(`[${project.name}] Batch ${batchNum}/${totalBatches}: Fetching files from Zotero...`);

            const batchData = [];
            for (const fileInfo of currentBatchFiles) {
                try {
                    const fileReq = await fetch(`${ZOTERO_HOST}/notebooklm/file`, {
                        method: "POST",
                        headers: {
                            "Zotero-Allowed-Request": "true",
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({ id: fileInfo.id })
                    });

                    if (!fileReq.ok) {
                        console.error("[Sync] Failed to fetch file payload", fileInfo.id, await fileReq.text());
                        continue;
                    }

                    const fileRes = await fileReq.json();
                    if (!fileRes.success || !fileRes.data) {
                        continue;
                    }

                    batchData.push({
                        id: fileInfo.id,
                        title: fileInfo.title,
                        filename: fileInfo.filename,
                        mimeType: fileRes.mimeType,
                        base64: fileRes.data,
                        meta: {
                            hash: fileInfo.hash,
                            dateModified: fileInfo.dateModified,
                            version: fileInfo.version,
                            normalizedFilename: normalizeFilename(fileInfo.filename || fileInfo.title)
                        }
                    });
                } catch (e) {
                    console.error(`[Sync] Failed to fetch ${fileInfo.title}:`, e);
                }
            }

            if (batchData.length === 0) {
                continue;
            }

            updateStatus(`[${project.name}] Batch ${batchNum}/${totalBatches}: Uploading to NotebookLM...`);

            let uploadResult;
            try {
                uploadResult = await uploadBatchViaExtension(tabId, notebookId, batchData);
            } catch (e) {
                const detail = e?.message || String(e);
                throw new Error(`${detail}. Ensure you are signed in to NotebookLM in the open NotebookLM tab.`);
            }

            const uploadedList = Array.isArray(uploadResult.uploaded) ? uploadResult.uploaded : [];
            const failedList = Array.isArray(uploadResult.failed) ? uploadResult.failed : [];
            const uploadedIds = new Set(uploadedList.map((item) => item.clientFileId));

            for (const item of batchData) {
                if (!uploadedIds.has(item.id)) continue;
                const historyKey = buildHistoryKey(notebookId, item.id);
                syncHistory[historyKey] = {
                    ...item.meta,
                    timestamp: Date.now()
                };
                syncedCount += 1;
            }

            await chrome.storage.local.set({ syncHistory });

            if (failedList.length > 0) {
                const summary = failedList
                    .slice(0, 2)
                    .map((f) => `${f.filename || f.clientFileId}: ${f.error}`)
                    .join("; ");
                updateStatus(`[${project.name}] Batch ${batchNum}: ${failedList.length} file(s) failed (${summary}).`);
            }
        }

        updateStatus(`[${project.name}] Sync complete. ${syncedCount}/${totalToSync} file(s) uploaded.`);
    } catch (err) {
        console.error(err);
        updateStatus(`[${project.name}] Error: ${err.message || "Check console"}`);
    }
}
