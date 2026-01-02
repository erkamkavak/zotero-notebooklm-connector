const ZOTERO_HOST = "http://localhost:23119";

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "START_SYNC") {
        runSyncProcess(request.project);
        sendResponse({ status: `Syncing "${request.project.name}"...` });
    }
    return true;
});

async function runSyncProcess(project) {
    updateStatus(`[${project.name}] Getting list...`);

    try {
        // 1. Get list of files from Zotero with project filters
        const listReq = await fetch(`${ZOTERO_HOST}/notebooklm/list`, {
            method: 'POST',
            headers: { 
                'Zotero-Allowed-Request': 'true',
                'Content-Type': 'application/json'
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

        // 2. Find the NotebookLM tab and extract Notebook ID
        let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url || !tab.url.includes("notebooklm.google.com")) {
            const allTabs = await chrome.tabs.query({});
            tab = allTabs.find(t => t.url && t.url.includes("notebooklm.google.com"));
        }

        if (!tab) {
            updateStatus("Error: Please open NotebookLM first.");
            return;
        }

        // Extract Notebook ID from URL: e.g. https://notebooklm.google.com/notebook/ID
        let notebookId = "global";
        const match = tab.url.match(/\/notebook\/([^\/\?#]+)/);
        if (match) {
            notebookId = match[1];
        }
        console.log(`[Sync] Target Notebook ID: ${notebookId}`);

        // 3. Filter using sync history (scoped by notebookId)
        const storage = await chrome.storage.local.get("syncHistory");
        const syncHistory = storage.syncHistory || {};
        
        const filesNeeded = filesToSync.filter(file => {
            const historyKey = `${notebookId}_${file.id}`;
            const history = syncHistory[historyKey];
            if (!history) return true;
            if (file.hash && history.hash !== file.hash) return true;
            if (file.dateModified !== history.dateModified) return true;
            return false;
        });

        if (filesNeeded.length === 0) {
            updateStatus(`[${project.name}] All items up to date.`);
            return;
        }

        const totalToSync = filesNeeded.length;
        updateStatus(`[${project.name}] Found ${totalToSync} files to sync...`);
        
        // Let's wait a second so the user can see the count
        await new Promise(r => setTimeout(r, 1000));

        // 4. Process in batches of 10
        const BATCH_SIZE = 10;
        let syncedCount = 0;

        for (let i = 0; i < totalToSync; i += BATCH_SIZE) {
            const currentBatchFiles = filesNeeded.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(totalToSync / BATCH_SIZE);

            updateStatus(`[${project.name}] Batch ${batchNum}/${totalBatches}: Fetching ${currentBatchFiles.length} files...`);

            const batchData = [];
            for (const fileInfo of currentBatchFiles) {
                try {
                    const fileReq = await fetch(`${ZOTERO_HOST}/notebooklm/file`, {
                        method: 'POST',
                        headers: { 'Zotero-Allowed-Request': 'true', 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: fileInfo.id })
                    });
                    const fileRes = await fileReq.json();
                    if (fileRes.success) {
                        batchData.push({
                            id: fileInfo.id,
                            title: fileInfo.title,
                            filename: fileInfo.filename,
                            mimeType: fileRes.mimeType,
                            base64: `data:${fileRes.mimeType};base64,${fileRes.data}`,
                            meta: {
                                hash: fileInfo.hash,
                                dateModified: fileInfo.dateModified,
                                version: fileInfo.version
                            }
                        });
                    }
                } catch (e) {
                    console.error(`Failed to fetch ${fileInfo.title}:`, e);
                }
            }

            if (batchData.length > 0) {
                updateStatus(`[${project.name}] Batch ${batchNum}/${totalBatches}: Injecting...`);
                await injectBatchViaDebugger(tab.id, batchData);

                // Update history for this batch immediately
                for (const item of batchData) {
                    const historyKey = `${notebookId}_${item.id}`;
                    syncHistory[historyKey] = {
                        ...item.meta,
                        timestamp: Date.now()
                    };
                }
                await chrome.storage.local.set({ syncHistory });
                
                syncedCount += batchData.length;
                
                // Pause slightly between batches to let NotebookLM process
                if (i + BATCH_SIZE < totalToSync) {
                    updateStatus(`[${project.name}] Batch ${batchNum} done. Resting...`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }

        updateStatus(`[${project.name}] Success! ${syncedCount} files synced.`);

    } catch (err) {
        console.error(err);
        updateStatus(`[${project.name}] Sync error: ${err.message || 'Check console'}`);
    }
}

async function injectBatchViaDebugger(tabId, batchItems) {
    try {
        await chrome.debugger.attach({ tabId }, "1.3");
    } catch (e) {
        if (!e.message.includes("Already attached")) throw e;
    }
    
    try {
        await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
        await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
        // Open dialog once
        console.log("[CDP] Opening upload dialog...");
        try {
            await sendMessageWithRetry(tabId, { action: "OPEN_UPLOAD_DIALOG" });
        } catch (e) {
            throw new Error("Failed to communicate with NotebookLM tab. Please refresh the page and try again.");
        }
        await new Promise(r => setTimeout(r, 2500));

        const suppressionScript = `
            window._zoteroSuppressionActive = true;
            if (!window._zoteroOriginalClick) {
                window._zoteroOriginalClick = HTMLInputElement.prototype.click;
                HTMLInputElement.prototype.click = function() {
                    if (this.type === 'file' && window._zoteroSuppressionActive) return;
                    return window._zoteroOriginalClick.apply(this, arguments);
                };
            }
        `;
        await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: suppressionScript });
        
        const { root } = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument");
        const { nodeId } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
            nodeId: root.nodeId,
            selector: '[xapscottyuploadertrigger]'
        });
        
        if (!nodeId) throw new Error("Trigger button not found");
        
        const { model } = await chrome.debugger.sendCommand({ tabId }, "DOM.getBoxModel", { nodeId });
        const x = (model.content[0] + model.content[2] + model.content[4] + model.content[6]) / 4;
        const y = (model.content[1] + model.content[3] + model.content[5] + model.content[7]) / 4;
        
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        
        await new Promise(r => setTimeout(r, 1200));
        
        const injectionScript = `
            (async function() {
                try {
                    const input = document.querySelector('input[type="file"], input[name="Filedata"]');
                    if (!input) throw new Error('File input missing');
                    
                    const dt = new DataTransfer();
                    const items = ${JSON.stringify(batchItems.map(i => ({ name: i.filename, type: i.mimeType, base64: i.base64 })))};
                    
                    for (const item of items) {
                        const response = await fetch(item.base64);
                        const file = new File([await response.blob()], item.name, { type: item.type });
                        dt.items.add(file);
                    }
                    
                    input.files = dt.files;
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    return { success: true };
                } catch (e) {
                    return { success: false, error: e.message };
                } finally {
                    window._zoteroSuppressionActive = false;
                }
            })()
        `;
        
        const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
            expression: injectionScript,
            awaitPromise: true,
            returnByValue: true
        });
        
        if (!result.result?.value?.success) {
            throw new Error(result.result?.value?.error || "Injection failed");
        }
        
    } finally {
        await chrome.debugger.detach({ tabId }).catch(() => {});
    }
}

function updateStatus(text) {
    chrome.runtime.sendMessage({ action: "UPDATE_STATUS", text: text }).catch(() => {});
}

/**
 * Send a message to a tab, retrying if the connection fails (e.g. content script loading)
 */
async function sendMessageWithRetry(tabId, message, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await chrome.tabs.sendMessage(tabId, message);
        } catch (e) {
            console.warn(`[Sync] Message failed, retrying (${i + 1}/${maxRetries})...`, e.message);
            
            // If the content script is missing, try to inject it
            if (e.message.includes("Could not establish connection") || e.message.includes("Receiver does not exist")) {
                console.log("[Sync] Content script not found. Attempting to inject...");
                try {
                    await chrome.scripting.executeScript({
                        target: { tabId },
                        files: ["content.js"]
                    });
                    // Wait a bit for injection to settle
                    await new Promise(r => setTimeout(r, 500));
                } catch (injectErr) {
                    console.error("[Sync] Failed to inject content script:", injectErr);
                }
            }

            if (i === maxRetries - 1) throw e;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}