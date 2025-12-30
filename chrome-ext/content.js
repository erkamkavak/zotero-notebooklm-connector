// NotebookLM Injector - Content Script
// This script helps prepare the upload dialog for the CDP-based injection

if (window.zoteroNotebookLMInjectorLoaded) {
    console.log("NotebookLM Injector already active.");
} else {
    window.zoteroNotebookLMInjectorLoaded = true;
    console.log("NotebookLM Injector loaded.");

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "OPEN_UPLOAD_DIALOG") {
            console.log("[Injector] Opening upload dialog...");
            openUploadDialog()
                .then(() => sendResponse({ success: true }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;
        }
    });
}

/**
 * Wait for an element matching the selector
 */
async function waitFor(selector, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const el = document.querySelector(selector);
        if (el) return el;
        await new Promise(r => setTimeout(r, 150));
    }
    return null;
}

/**
 * Open the upload dialog so CDP can interact with it
 */
async function openUploadDialog() {
    // Check if dropzone is already visible
    let dropzone = document.querySelector('[xapscottyuploaderdropzone]') || 
                   document.querySelector('.xap-uploader-dropzone');
    
    if (dropzone) {
        console.log("[Injector] Dropzone already visible");
        return;
    }
    
    console.log("[Injector] Looking for 'Add Source' button...");
    
    const addSourceBtn = document.querySelector('.add-source-button') || 
                         document.querySelector('button.add-source-button') ||
                         document.querySelector('button[jslog*="189032"]');
    
    if (!addSourceBtn) {
        throw new Error("Could not find 'Add Source' button");
    }
    
    // Simple click - CDP will handle the rest
    addSourceBtn.click();
    
    // Wait for dropzone to appear
    dropzone = await waitFor('[xapscottyuploaderdropzone], .xap-uploader-dropzone', 8000);
    
    if (!dropzone) {
        // Try to find and click upload option
        console.log("[Injector] Looking for upload option...");
        const allButtons = document.querySelectorAll('button, [role="button"], [jslog]');
        for (const btn of allButtons) {
            const text = (btn.textContent || '').toLowerCase();
            if (text.includes('upload') || text.includes('yükle') || text.includes('dosya')) {
                console.log("[Injector] Clicking upload option:", text.substring(0, 30));
                btn.click();
                await waitFor('[xapscottyuploaderdropzone], .xap-uploader-dropzone', 5000);
                break;
            }
        }
    }
    
    console.log("[Injector] Upload dialog should be ready now");
}