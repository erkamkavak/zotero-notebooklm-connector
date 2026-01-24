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
        // IMPORTANT: We must find a valid NotebookLM tab, not a chrome-extension:// URL
        // which would cause "Cannot access a chrome-extension:// URL" error
        const allTabs = await chrome.tabs.query({});
        let tab = allTabs.find(t => t.url && t.url.startsWith("https://notebooklm.google.com"));
        
        if (!tab) {
            updateStatus("Error: Please open NotebookLM first (https://notebooklm.google.com).");
            return;
        }
        
        // Verify the tab URL is valid for our operations
        if (!tab.url || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("chrome://")) {
            updateStatus("Error: Invalid tab. Please navigate to NotebookLM and try again.");
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
                
                try {
                    await injectBatchViaDebugger(tab.id, batchData);
                } catch (injectError) {
                    console.error(`[Sync] Injection error:`, injectError);
                    updateStatus(`[${project.name}] Error: ${injectError.message}`);
                    return;
                }

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

/**
 * Selectors for NotebookLM UI - must match content.js
 */
const SELECTORS = {
    uploadButton: [
        '[xapscottyuploadertrigger]',
        '.drop-zone-icon-button',
        'button[xapscottyuploadertrigger]',
        '.xap-uploader-trigger'
    ],
    dropzone: [
        '[xapscottyuploaderdropzone]',
        '.xap-uploader-dropzone'
    ],
    fileInput: [
        'input[type="file"][name="Filedata"]',
        'input[type="file"]'
    ],
    uploadTextPatterns: [
        'upload', 'yükle', 'dosya', 'browse', 'select', 'computer', 'device', 'local'
    ]
};

async function injectBatchViaDebugger(tabId, batchItems) {
    console.log(`[CDP] Starting injection of ${batchItems.length} files...`);
    
    // Verify the tab is still valid before attaching debugger
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab || !tab.url) {
            throw new Error("Tab no longer exists. Please try again.");
        }
        if (tab.url.startsWith("chrome-extension://") || tab.url.startsWith("chrome://")) {
            throw new Error("Cannot attach to extension pages. Please navigate to NotebookLM and try again.");
        }
        if (!tab.url.startsWith("https://notebooklm.google.com")) {
            throw new Error("Tab is not on NotebookLM. Please navigate to NotebookLM and try again.");
        }
    } catch (e) {
        if (e.message.includes("No tab with id")) {
            throw new Error("NotebookLM tab was closed. Please reopen it and try again.");
        }
        throw e;
    }
    
    try {
        await chrome.debugger.attach({ tabId }, "1.3");
    } catch (e) {
        if (e.message.includes("Already attached")) {
            // Already attached is OK
        } else if (e.message.includes("Cannot access")) {
            throw new Error("Cannot access this page. Make sure you're on NotebookLM (not another extension).");
        } else {
            throw e;
        }
    }
    
    try {
        await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
        await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
        
        // Step 1: Open dialog via content script
        console.log("[CDP] Opening upload dialog...");
        let dialogResult;
        try {
            dialogResult = await sendMessageWithRetry(tabId, { action: "OPEN_UPLOAD_DIALOG" });
            console.log("[CDP] Dialog result:", dialogResult);
        } catch (e) {
            throw new Error("Failed to communicate with NotebookLM tab. Please refresh the page and try again.");
        }
        
        if (!dialogResult.success) {
            throw new Error(dialogResult.error || "Failed to open upload dialog");
        }
        
        // Wait for dialog to fully render
        await new Promise(r => setTimeout(r, 1500));
        
        // Step 2: Suppress native file picker
        const suppressionScript = `
            window._zoteroSuppressionActive = true;
            if (!window._zoteroOriginalClick) {
                window._zoteroOriginalClick = HTMLInputElement.prototype.click;
                HTMLInputElement.prototype.click = function() {
                    if (this.type === 'file' && window._zoteroSuppressionActive) {
                        console.log('[Zotero] Suppressed native file picker');
                        return;
                    }
                    return window._zoteroOriginalClick.apply(this, arguments);
                };
            }
        `;
        await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: suppressionScript });
        
        // Step 3: Find and click the upload trigger button (the one that activates the file input)
        const findAndClickTrigger = await findAndClickUploadTrigger(tabId);
        if (!findAndClickTrigger.success) {
            throw new Error(findAndClickTrigger.error || "Could not find upload trigger button");
        }
        
        console.log(`[CDP] Trigger clicked via: ${findAndClickTrigger.method}`);
        
        // Wait for file input to be ready after clicking trigger
        await new Promise(r => setTimeout(r, 800));
        
        // Step 4: Verify file input exists
        const fileInputCheck = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
            expression: `
                (function() {
                    const selectors = ${JSON.stringify(SELECTORS.fileInput)};
                    for (const s of selectors) {
                        const input = document.querySelector(s);
                        if (input) {
                            return { found: true, selector: s, accept: input.accept };
                        }
                    }
                    return { found: false };
                })()
            `,
            returnByValue: true
        });
        
        if (!fileInputCheck.result?.value?.found) {
            throw new Error("File input not found. The upload dialog may not have opened correctly.");
        }
        
        console.log(`[CDP] File input found: ${fileInputCheck.result.value.selector}`);
        
        // Step 5: Inject files
        const injectionScript = `
            (async function() {
                try {
                    const selectors = ${JSON.stringify(SELECTORS.fileInput)};
                    let input = null;
                    for (const s of selectors) {
                        input = document.querySelector(s);
                        if (input) break;
                    }
                    
                    if (!input) throw new Error('File input not found');
                    
                    const dt = new DataTransfer();
                    const items = ${JSON.stringify(batchItems.map(i => ({ name: i.filename, type: i.mimeType, base64: i.base64 })))};
                    
                    console.log('[Zotero] Creating ' + items.length + ' files...');
                    
                    for (const item of items) {
                        const response = await fetch(item.base64);
                        const blob = await response.blob();
                        const file = new File([blob], item.name, { type: item.type });
                        dt.items.add(file);
                        console.log('[Zotero] Added file: ' + item.name);
                    }
                    
                    // Set files on input
                    input.files = dt.files;
                    
                    // Dispatch change event with bubbling
                    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                    
                    // Also dispatch input event as some frameworks listen to this
                    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                    
                    console.log('[Zotero] Files injected successfully');
                    return { success: true, fileCount: items.length };
                } catch (e) {
                    console.error('[Zotero] Injection error:', e);
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
            throw new Error(result.result?.value?.error || "File injection failed");
        }
        
        console.log(`[CDP] Successfully injected ${result.result.value.fileCount} files`);
        
    } finally {
        // Cleanup: restore click handler and detach debugger
        try {
            await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
                expression: `window._zoteroSuppressionActive = false;`
            });
        } catch (e) { /* ignore */ }
        
        await chrome.debugger.detach({ tabId }).catch(() => {});
    }
}

/**
 * Find and click the upload trigger button using CDP
 */
async function findAndClickUploadTrigger(tabId) {
    // First, try to find by selectors
    const findTriggerScript = `
        (function() {
            function isVisible(el) {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                    return false;
                }
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            }
            
            // Primary selectors for the upload trigger button
            const selectors = ${JSON.stringify(SELECTORS.uploadButton)};
            
            for (const s of selectors) {
                const el = document.querySelector(s);
                if (el && isVisible(el)) {
                    const rect = el.getBoundingClientRect();
                    return { 
                        x: rect.left + rect.width / 2, 
                        y: rect.top + rect.height / 2, 
                        found: true, 
                        method: 'selector:' + s 
                    };
                }
            }
            
            // Fallback: find by text content
            const textPatterns = ${JSON.stringify(SELECTORS.uploadTextPatterns)};
            const buttons = document.querySelectorAll('button, [role="button"], [role="menuitem"]');
            
            for (const el of buttons) {
                if (!isVisible(el)) continue;
                const text = (el.innerText || el.textContent || '').toLowerCase();
                
                for (const pattern of textPatterns) {
                    if (text.includes(pattern)) {
                        const rect = el.getBoundingClientRect();
                        return { 
                            x: rect.left + rect.width / 2, 
                            y: rect.top + rect.height / 2, 
                            found: true, 
                            method: 'text:' + pattern,
                            matchedText: text.substring(0, 30)
                        };
                    }
                }
            }
            
            // Debug: list available buttons
            const availableButtons = [];
            buttons.forEach(b => {
                if (isVisible(b)) {
                    availableButtons.push({
                        text: (b.textContent || '').substring(0, 50),
                        class: b.className,
                        tag: b.tagName
                    });
                }
            });
            
            return { found: false, availableButtons };
        })()
    `;

    const searchResult = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { 
        expression: findTriggerScript,
        returnByValue: true
    });

    if (!searchResult.result?.value?.found) {
        console.log("[CDP] Available buttons:", searchResult.result?.value?.availableButtons);
        return { 
            success: false, 
            error: "Upload trigger button not found. Available buttons: " + 
                   JSON.stringify(searchResult.result?.value?.availableButtons || [])
        };
    }
    
    const { x, y, method } = searchResult.result.value;
    console.log(`[CDP] Found trigger via ${method} at (${x}, ${y})`);
    
    // Send mouse events via CDP
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { 
        type: "mousePressed", x, y, button: "left", clickCount: 1 
    });
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { 
        type: "mouseReleased", x, y, button: "left", clickCount: 1 
    });
    
    return { success: true, method };
}

function updateStatus(text) {
    console.log(`[Status] ${text}`);
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
            
            // Check for chrome-extension:// URL error
            if (e.message.includes("Cannot access a chrome-extension://")) {
                throw new Error("Cannot communicate with extension pages. Please make sure you're on NotebookLM.");
            }
            
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
                    // Check if it's a URL access issue
                    if (injectErr.message.includes("Cannot access")) {
                        throw new Error("Cannot inject into this page. Please navigate to NotebookLM first.");
                    }
                }
            }

            if (i === maxRetries - 1) throw e;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}
