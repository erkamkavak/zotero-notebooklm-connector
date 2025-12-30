/**
 * Zotero 7 Bootstrap Plugin for NotebookLM Sync
 */

// 1. The Endpoint to LIST items tagged #NotebookLM
function ListEndpoint() {}
ListEndpoint.prototype = {
	supportedMethods: ['GET'],
	supportedDataTypes: '*',
	permitBookmarklet: true,

	init: function (urlObj, data, sendResponseCallback) {
		(async () => {
			try {
				const search = new Zotero.Search();
				const tag = Zotero.Prefs.get('extensions.notebooklm-sync.tag') || '#NotebookLM';
				search.addCondition('tag', 'is', tag);
				search.addCondition('itemType', 'isNot', 'attachment');
				search.addCondition('itemType', 'isNot', 'note');
				const results = await search.search();

				let fileList = [];

				for (let id of results) {
					let item = await Zotero.Items.getAsync(id);
					let attachment = await item.getBestAttachment();
					if (!attachment) continue;

					if (attachment.attachmentContentType !== 'application/pdf') continue;

					fileList.push({
						id: attachment.id,
						parentId: id,
						title: item.getField('title'),
						filename: attachment.attachmentFilename
					});
				}
				
				sendResponseCallback(200, "application/json", JSON.stringify(fileList));

			} catch (e) {
				Zotero.debug("[NotebookLM Bridge] Error listing items: " + e);
				sendResponseCallback(500, "text/plain", "Error: " + e);
			}
		})();
	}
};

// 2. POST endpoint for file - receives JSON with { id: 37 }
function FileEndpoint() {}
FileEndpoint.prototype = {
	supportedMethods: ['POST'],
	supportedDataTypes: ['application/json'],
	permitBookmarklet: true,

	init: function (urlObj, data, sendResponseCallback) {
		(async () => {
			try {
				Zotero.debug("[NotebookLM Bridge] File POST data: " + JSON.stringify(data));
				
				// data should be the parsed JSON object { id: 37 }
				const attachmentId = data?.id;
				
				Zotero.debug("[NotebookLM Bridge] Parsed attachmentId: " + attachmentId);

				if (!attachmentId) {
					sendResponseCallback(400, "text/plain", "No attachment ID provided. Send JSON: { id: 37 }");
					return;
				}

				let attachment = await Zotero.Items.getAsync(parseInt(attachmentId));
				if (!attachment) {
					sendResponseCallback(404, "text/plain", "Attachment not found: " + attachmentId);
					return;
				}
				
				let filePath = await attachment.getFilePathAsync();
				Zotero.debug("[NotebookLM Bridge] File path: " + filePath);

				if (!filePath || !await IOUtils.exists(filePath)) {
					sendResponseCallback(404, "text/plain", "File not found on disk: " + filePath);
					return;
				}

				let fileBytes = await IOUtils.read(filePath);
				Zotero.debug("[NotebookLM Bridge] File size: " + fileBytes.length);

				// Convert Uint8Array to base64 for safe binary transfer
				let binary = '';
				const len = fileBytes.length;
				for (let i = 0; i < len; i++) {
					binary += String.fromCharCode(fileBytes[i]);
				}
				const base64 = btoa(binary);

				// Return as JSON with base64 data
				sendResponseCallback(200, "application/json", JSON.stringify({
					success: true,
					data: base64,
					mimeType: "application/pdf"
				}));

			} catch (e) {
				Zotero.debug("[NotebookLM Bridge] Error serving file: " + e);
				sendResponseCallback(500, "text/plain", "Error reading file: " + e);
			}
		})();
	}
};


// Zotero 7 lifecycle hook
function startup({ id, version, resourceURI, rootURI }, reason) {
    Zotero.debug("NotebookLM Sync: Initializing...");
    
    if (Zotero.initialized) {
        initPlugin(rootURI);
    } else {
        Zotero.Promise.resolve().then(() => Zotero.uiReadyPromise).then(() => initPlugin(rootURI));
    }
}

function initPlugin(rootURI) {
    Zotero.Server.Endpoints["/notebooklm/list"] = ListEndpoint;
    Zotero.Server.Endpoints["/notebooklm/file"] = FileEndpoint;
    
    Zotero.PreferencePanes.register({
        pluginID: 'notebooklm-sync@erkam.dev',
        src: rootURI + 'preferences.xhtml',
        label: 'NotebookLM Sync'
    });

    Zotero.debug("NotebookLM Sync: API Endpoints Registered");
}

function shutdown(data, reason) {
    delete Zotero.Server.Endpoints["/notebooklm/list"];
    delete Zotero.Server.Endpoints["/notebooklm/file"];
}

function install() {}
function uninstall() {}
