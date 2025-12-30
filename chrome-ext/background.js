const ZOTERO_HOST = "http://localhost:23119";

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "START_SYNC") {
        runSyncProcess();
        sendResponse({ status: "Sync process started check browser console." });
    }
    return true;
});

async function runSyncProcess() {
    updateStatus("Getting list from Zotero...");

    try {
        // 1. Get list of files to sync
        console.log("[Sync] Fetching list from Zotero...");
        const listReq = await fetch(`${ZOTERO_HOST}/notebooklm/list`, {
            headers: { 'Zotero-Allowed-Request': 'true' }
        });
        
        if (!listReq.ok) {
            const errorText = await listReq.text();
            console.error("[Sync] Error response:", errorText);
            updateStatus(`Error: ${listReq.status} - ${errorText}`);
            return;
        }
        
        const filesToSync = await listReq.json();
        console.log("[Sync] Files to sync:", filesToSync);

        if (filesToSync.length === 0) {
            updateStatus("No items found with #NotebookLM tag.");
            return;
        }

        updateStatus(`Found ${filesToSync.length} items. Starting upload...`);

        // Get active tab
        let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab.url.includes("notebooklm.google.com")) {
            updateStatus("Error: Please open NotebookLM first.");
            return;
        }

        // Process each file
        for (const fileInfo of filesToSync) {
            updateStatus(`Processing: ${fileInfo.title}...`);
            
            // Fetch the PDF from Zotero
            const fileReq = await fetch(`${ZOTERO_HOST}/notebooklm/file`, {
                method: 'POST',
                headers: { 
                    'Zotero-Allowed-Request': 'true',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ id: fileInfo.id })
            });
            
            const fileResponse = await fileReq.json();
            
            if (!fileResponse.success) {
                console.error("[Sync] File fetch failed:", fileResponse);
                continue;
            }
            
            const base64Data = `data:${fileResponse.mimeType};base64,${fileResponse.data}`;
            console.log("[Sync] PDF fetched, size:", fileResponse.data.length);

            updateStatus(`Uploading: ${fileInfo.title}...`);
            
            try {
                await injectFileViaDebugger(tab.id, base64Data, fileInfo.filename, fileResponse.mimeType || 'application/pdf');
                console.log("[Sync] File injected successfully");
            } catch (e) {
                console.error("[Sync] Injection failed:", e);
                updateStatus(`Error: ${e.message}`);
                return;
            }

            // Delay between uploads
            await new Promise(r => setTimeout(r, 3000));
        }

        updateStatus("Sync complete!");

    } catch (err) {
        console.error(err);
        updateStatus("Error during sync: Is Zotero running?");
    }
}

/**
 * Use Chrome DevTools Protocol to inject files
 * CDP allows us to dispatch trusted events and set files directly
 */
async function injectFileViaDebugger(tabId, base64Data, fileName, mimeType) {
    console.log("[CDP] Starting file injection for:", fileName);
    
    // Attach debugger to tab
    try {
        await chrome.debugger.attach({ tabId }, "1.3");
    } catch (e) {
        if (!e.message.includes("Already attached")) {
            throw e;
        }
    }
    console.log("[CDP] Attached to tab");
    
    try {
        // Enable required domains
        await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
        await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
        // Note: Input.enable does not exist in CDP, Input domain is always available
        
        // Step 1: Open the upload dialog via content script
        console.log("[CDP] Telling content script to open dialog...");
        await chrome.tabs.sendMessage(tabId, { action: "OPEN_UPLOAD_DIALOG" });
        
        // Wait for dialog to open and for elements to be stable
        await new Promise(r => setTimeout(r, 2500));

        // NEW: Inject a suppression script into the page context to stop the system dialog
        console.log("[CDP] Injecting system dialog suppression...");
        const suppressionScript = `
            window._zoteroSuppressionActive = true;
            if (!window._zoteroOriginalClick) {
                window._zoteroOriginalClick = HTMLInputElement.prototype.click;
                HTMLInputElement.prototype.click = function() {
                    if (this.type === 'file' && window._zoteroSuppressionActive) {
                        console.log('[Page] Intercepted and suppressed native file picker click');
                        return;
                    }
                    return window._zoteroOriginalClick.apply(this, arguments);
                };
            }
        `;
        await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
            expression: suppressionScript
        });
        
        // Step 2: Find the trigger button and click it using CDP
        console.log("[CDP] Finding trigger button...");
        
        const { root } = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument");
        
        // Find the trigger button
        const { nodeId: triggerNodeId } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
            nodeId: root.nodeId,
            selector: '[xapscottyuploadertrigger]'
        });
        
        if (!triggerNodeId) {
            throw new Error("Trigger button not found in DOM via CDP");
        }
        
        console.log("[CDP] Found trigger, nodeId:", triggerNodeId);
        
        // Get the box model to find coordinates
        const { model } = await chrome.debugger.sendCommand({ tabId }, "DOM.getBoxModel", {
            nodeId: triggerNodeId
        });
        
        // Calculate center
        const x = (model.content[0] + model.content[2] + model.content[4] + model.content[6]) / 4;
        const y = (model.content[1] + model.content[3] + model.content[5] + model.content[7]) / 4;
        
        console.log("[CDP] Dispatching click at center:", x, y);
        
        // Dispatch trusted mouse click
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
            type: "mousePressed", x, y, button: "left", clickCount: 1
        });
        
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
            type: "mouseReleased", x, y, button: "left", clickCount: 1
        });
        
        console.log("[CDP] Click events dispatched");
        
        // Wait for file input to be created/activated
        await new Promise(r => setTimeout(r, 1000));
        
        // Step 3: Use Runtime.evaluate to set files and then disable suppression
        console.log("[CDP] Performing file injection and cleanup...");
        
        const injectionAndCleanupScript = `
            (async function() {
                try {
                    const input = document.querySelector('input[type="file"], input[name="Filedata"]');
                    if (!input) throw new Error('Input not found after triggering');
                    
                    const response = await fetch('${base64Data}');
                    const blob = await response.blob();
                    const file = new File([blob], '${fileName.replace(/'/g, "\\'")}', { type: '${mimeType}' });
                    
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    input.files = dt.files;
                    
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    console.log('[Page] File injected and change event dispatched');
                    
                    return { success: true };
                } catch (e) {
                    return { success: false, error: e.message };
                } finally {
                    // Turn off suppression so manual clicks still work later
                    window._zoteroSuppressionActive = false;
                }
            })()
        `;
        
        const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
            expression: injectionAndCleanupScript,
            awaitPromise: true,
            returnByValue: true
        });
        
        if (!result.result?.value?.success) {
            console.error("[CDP] Injection script error:", result.result?.value?.error);
        } else {
            console.log("[CDP] Injection successfully completed");
        }

        
        // Alternative: Try drag & drop via CDP
        console.log("[CDP] Trying drag & drop approach...");
        
        // Find dropzone
        const { nodeId: dropzoneNodeId } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
            nodeId: root.nodeId,
            selector: '[xapscottyuploaderdropzone]'
        });
        
        if (dropzoneNodeId) {
            const { model: dzModel } = await chrome.debugger.sendCommand({ tabId }, "DOM.getBoxModel", {
                nodeId: dropzoneNodeId
            });
            
            const dzContent = dzModel.content;
            const dzX = (dzContent[0] + dzContent[2]) / 2;
            const dzY = (dzContent[1] + dzContent[5]) / 2;
            
            // Use Runtime.evaluate to create and dispatch drop event
            const dropScript = `
                (async function() {
                    const dropzone = document.querySelector('[xapscottyuploaderdropzone]');
                    if (!dropzone) return { success: false, error: 'Dropzone not found' };
                    
                    try {
                        const response = await fetch('${base64Data}');
                        const blob = await response.blob();
                        const file = new File([blob], '${fileName.replace(/'/g, "\\'")}', { type: '${mimeType}' });
                        
                        const dt = new DataTransfer();
                        dt.items.add(file);
                        
                        const dropEvent = new DragEvent('drop', {
                            bubbles: true,
                            cancelable: true,
                            dataTransfer: dt
                        });
                        
                        dropzone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
                        dropzone.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
                        dropzone.dispatchEvent(dropEvent);
                        
                        return { success: true };
                    } catch (e) {
                        return { success: false, error: e.message };
                    }
                })()
            `;
            
            const dropResult = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
                expression: dropScript,
                awaitPromise: true,
                returnByValue: true
            });
            
            console.log("[CDP] Drop result:", dropResult);
        }
        
    } finally {
        // Detach debugger
        try {
            await chrome.debugger.detach({ tabId });
            console.log("[CDP] Detached from tab");
        } catch (e) {
            // Ignore
        }
    }
}

function updateStatus(text) {
    chrome.runtime.sendMessage({ action: "UPDATE_STATUS", text: text }).catch(() => {});
    console.log(`[Sync] ${text}`);
}