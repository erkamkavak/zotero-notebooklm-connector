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
                .then((result) => sendResponse({ success: true, ...result }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;
        }
        if (request.action === "CHECK_DIALOG_STATE") {
            const state = checkDialogState();
            sendResponse(state);
            return true;
        }
    });
}

/**
 * Selectors for NotebookLM UI elements - centralized for easy updates
 */
const SELECTORS = {
    // Add Source button
    addSourceButton: [
        '.add-source-button',
        'button.add-source-button',
        'button[jslog*="189032"]',
        '[aria-label*="source" i]',
        '[aria-label*="kaynak" i]'  // Turkish
    ],
    // Upload file button (in the dialog)
    uploadButton: [
        '[xapscottyuploadertrigger]',
        '.drop-zone-icon-button',
        'button[xapscottyuploadertrigger]',
        '.xap-uploader-trigger'
    ],
    // Dropzone area
    dropzone: [
        '[xapscottyuploaderdropzone]',
        '.xap-uploader-dropzone'
    ],
    // File input
    fileInput: [
        'input[type="file"][name="Filedata"]',
        'input[type="file"]'
    ],
    // Upload text patterns (multi-language)
    uploadTextPatterns: [
        'upload', 'yükle', 'dosya yükle', 'browse', 'select file', 
        'computer', 'device', 'local file'
    ]
};

/**
 * Wait for an element matching any of the selectors
 */
async function waitForAny(selectors, timeout = 5000) {
    const start = Date.now();
    const selectorList = Array.isArray(selectors) ? selectors : [selectors];
    
    while (Date.now() - start < timeout) {
        for (const selector of selectorList) {
            const el = document.querySelector(selector);
            if (el && isVisible(el)) {
                return { element: el, selector };
            }
        }
        await new Promise(r => setTimeout(r, 100));
    }
    return null;
}

/**
 * Check if element is visible (not hidden, has dimensions)
 */
function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

/**
 * Find element by text content (case-insensitive)
 */
function findByText(patterns, containerSelector = 'body') {
    const container = document.querySelector(containerSelector) || document.body;
    const buttons = container.querySelectorAll('button, [role="button"], [role="menuitem"]');
    
    for (const btn of buttons) {
        if (!isVisible(btn)) continue;
        const text = (btn.textContent || btn.innerText || '').toLowerCase().trim();
        for (const pattern of patterns) {
            if (text.includes(pattern.toLowerCase())) {
                return { element: btn, matchedText: text, pattern };
            }
        }
    }
    return null;
}

/**
 * Simulate a realistic click on an element
 */
function simulateClick(element) {
    if (!element) return false;
    
    // Focus the element first
    element.focus?.();
    
    // Try native click first
    element.click();
    
    // Also dispatch mouse events for Angular/React components
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    const mouseEvents = ['mousedown', 'mouseup', 'click'];
    for (const type of mouseEvents) {
        element.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: centerX,
            clientY: centerY
        }));
    }
    
    return true;
}

/**
 * Check current dialog state
 */
function checkDialogState() {
    // Check for file input visibility
    for (const selector of SELECTORS.fileInput) {
        const input = document.querySelector(selector);
        if (input) {
            return { 
                ready: true, 
                hasFileInput: true, 
                fileInputSelector: selector,
                inputVisible: isVisible(input)
            };
        }
    }
    
    // Check for upload button
    for (const selector of SELECTORS.uploadButton) {
        const btn = document.querySelector(selector);
        if (btn && isVisible(btn)) {
            return { 
                ready: false, 
                hasUploadButton: true, 
                needsUploadClick: true,
                uploadButtonSelector: selector
            };
        }
    }
    
    // Check for dropzone
    for (const selector of SELECTORS.dropzone) {
        const dz = document.querySelector(selector);
        if (dz && isVisible(dz)) {
            return { 
                ready: true, 
                hasDropzone: true, 
                dropzoneSelector: selector
            };
        }
    }
    
    return { ready: false, dialogNotOpen: true };
}

/**
 * Open the upload dialog - handles the two-step process
 */
async function openUploadDialog() {
    console.log("[Injector] Starting dialog open sequence...");
    
    // Step 1: Check if we're already in the right state
    let state = checkDialogState();
    console.log("[Injector] Initial state:", JSON.stringify(state));
    
    if (state.ready) {
        console.log("[Injector] Dialog already ready");
        return { alreadyOpen: true, state };
    }
    
    // Step 2: If upload button is visible, click it
    if (state.hasUploadButton) {
        console.log("[Injector] Upload button found, clicking...");
        const result = await waitForAny(SELECTORS.uploadButton, 1000);
        if (result) {
            simulateClick(result.element);
            await new Promise(r => setTimeout(r, 500));
            state = checkDialogState();
            if (state.ready) {
                return { uploadButtonClicked: true, state };
            }
        }
    }
    
    // Step 3: Need to click "Add Source" button first
    console.log("[Injector] Looking for 'Add Source' button...");
    
    let addSourceResult = await waitForAny(SELECTORS.addSourceButton, 2000);
    
    // Fallback: search by text
    if (!addSourceResult) {
        const byText = findByText(['add source', 'kaynak ekle', 'new source']);
        if (byText) {
            addSourceResult = { element: byText.element, selector: 'text:' + byText.pattern };
        }
    }
    
    if (!addSourceResult) {
        throw new Error("Could not find 'Add Source' button. Make sure you're on a NotebookLM notebook page.");
    }
    
    console.log(`[Injector] Found Add Source button via: ${addSourceResult.selector}`);
    simulateClick(addSourceResult.element);
    
    // Step 4: Wait for the dialog to appear with upload options
    await new Promise(r => setTimeout(r, 800));
    
    // Step 5: Look for and click the upload button
    console.log("[Injector] Looking for 'Upload file' button in dialog...");
    
    let uploadResult = await waitForAny(SELECTORS.uploadButton, 3000);
    
    // Fallback: search by text
    if (!uploadResult) {
        const byText = findByText(SELECTORS.uploadTextPatterns);
        if (byText) {
            uploadResult = { element: byText.element, selector: 'text:' + byText.pattern };
            console.log(`[Injector] Found upload button by text: "${byText.matchedText}"`);
        }
    }
    
    if (!uploadResult) {
        // Log available buttons for debugging
        const buttons = document.querySelectorAll('button, [role="button"]');
        const visibleButtons = Array.from(buttons).filter(isVisible).map(b => ({
            text: (b.textContent || '').substring(0, 50),
            classes: b.className
        }));
        console.log("[Injector] Available buttons:", visibleButtons);
        throw new Error("Could not find 'Upload file' button in dialog. Please try manually opening the upload dialog first.");
    }
    
    console.log(`[Injector] Found Upload button via: ${uploadResult.selector}`);
    simulateClick(uploadResult.element);
    
    // Step 6: Wait for file input to be ready
    await new Promise(r => setTimeout(r, 500));
    
    // Verify final state
    state = checkDialogState();
    console.log("[Injector] Final state:", JSON.stringify(state));
    
    if (!state.ready && !state.hasFileInput) {
        console.warn("[Injector] Dialog may not be fully ready, but continuing...");
    }
    
    return { dialogOpened: true, state };
}
