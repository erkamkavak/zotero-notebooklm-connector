document.getElementById('syncBtn').addEventListener('click', async () => {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent = "Contacting Zotero local server...";

    // Send message to background script to start the process
    chrome.runtime.sendMessage({ action: "START_SYNC" }, (response) => {
        if (chrome.runtime.lastError) {
             statusDiv.textContent = "Error: " + chrome.runtime.lastError.message;
        } else {
             statusDiv.textContent = response.status;
        }
    });
});

// Listen for updates from background script
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "UPDATE_STATUS") {
        document.getElementById('status').textContent = message.text;
    }
});