/**
 * Zotero 7 Bootstrap Plugin for NotebookLM Sync
 */

// 1. The Endpoint to LIST items
function ListEndpoint() {}
ListEndpoint.prototype = {
	supportedMethods: ['POST'],
	supportedDataTypes: ['application/json'],
	permitBookmarklet: true,

	init: function (urlObj, data, sendResponseCallback) {
		(async () => {
			try {
				// Get filters from POST data - exclusively managed by extension now
				const tag = data?.tag;
				const libraryIDStr = data?.libraryID;
				const collectionName = data?.collectionName;
				
				const libraryID = (libraryIDStr !== null && libraryIDStr !== "" && libraryIDStr !== undefined) ? parseInt(libraryIDStr) : Zotero.Libraries.userLibraryID;

				let results = [];
				
				if (collectionName && collectionName.trim()) {
					// Direct collection-based search helper
					const findCollectionByTitle = async (libID, title) => {
						const collections = await Zotero.Collections.getByLibrary(libID);
						for (let col of collections) {
							if (col.name.toLowerCase() === title.toLowerCase()) return col;
						}
						return null;
					};

					const collection = await findCollectionByTitle(libraryID, collectionName.trim());
					if (collection) {
						// Get all items in this collection (recursive)
						results = await collection.getChildItems(true);
						
						// If a tag is also provided, filter the results manually
						if (tag && tag.trim()) {
							const taggedResults = [];
							const tagLower = tag.trim().toLowerCase();
							for (let id of results) {
								let item = await Zotero.Items.getAsync(id);
								if (item.getTags().some(t => t.tag.toLowerCase() === tagLower)) {
									taggedResults.push(id);
								}
							}
							results = taggedResults;
						}
					} else {
						Zotero.debug("[NotebookLM Bridge] Collection not found: " + collectionName);
						results = []; // Collection specified but not found
					}
				} else {
					// General library search
					const search = new Zotero.Search();
					search.libraryID = libraryID;
					
					if (tag && tag.trim()) {
						search.addCondition('tag', 'is', tag.trim());
					}
					
					search.addCondition('itemType', 'isNot', 'attachment');
					search.addCondition('itemType', 'isNot', 'note');
					
					results = await search.search();
				}

				let fileList = [];

				for (let id of results) {
					let item = await Zotero.Items.getAsync(id);
					
					// Ensure we don't process attachments/notes if they came from collection.getChildItems
					if (item.isAttachment() || item.isNote()) continue;

					let attachment = await item.getBestAttachment();
					if (!attachment) continue;

					const validTypes = ['application/pdf', 'text/plain', 'text/markdown', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
					if (!validTypes.includes(attachment.attachmentContentType)) continue;

					let hash = "";
					try {
						hash = await Zotero.DB.valueQueryAsync(
							"SELECT fingerprint FROM itemAttachments WHERE itemID=?", 
							[attachment.id]
						);
					} catch (e) {
						Zotero.debug("[NotebookLM Bridge] Failed to get fingerprint: " + e);
					}

					fileList.push({
						id: attachment.id,
						parentId: id,
						title: item.getField('title'),
						filename: attachment.attachmentFilename,
						mimeType: attachment.attachmentContentType,
						dateModified: item.dateModified,
						version: item.version,
						hash: hash || ""
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
				const attachmentId = data?.id;
				if (!attachmentId) {
					sendResponseCallback(400, "text/plain", "No attachment ID provided.");
					return;
				}

				let attachment = await Zotero.Items.getAsync(parseInt(attachmentId));
				if (!attachment) {
					sendResponseCallback(404, "text/plain", "Attachment not found");
					return;
				}
				
				let filePath = await attachment.getFilePathAsync();
				if (!filePath || !await IOUtils.exists(filePath)) {
					sendResponseCallback(404, "text/plain", "File not found on disk");
					return;
				}

				let fileBytes = await IOUtils.read(filePath);
				let base64 = encodeBase64(fileBytes);

				sendResponseCallback(200, "application/json", JSON.stringify({
					success: true,
					data: base64,
					mimeType: attachment.attachmentContentType
				}));

			} catch (e) {
				Zotero.debug("[NotebookLM Bridge] Error serving file: " + e);
				sendResponseCallback(500, "text/plain", "Error reading file: " + e);
			}
		})();
	}
};

function encodeBase64(bytes) {
    let binary = '';
    const len = bytes.length;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function startup({ id, version, resourceURI, rootURI }, reason) {
    if (Zotero.initialized) {
        initPlugin(rootURI);
    } else {
        Zotero.Promise.resolve().then(() => Zotero.uiReadyPromise).then(() => initPlugin(rootURI));
    }
}

function initPlugin(rootURI) {
    Zotero.Server.Endpoints["/notebooklm/list"] = ListEndpoint;
    Zotero.Server.Endpoints["/notebooklm/file"] = FileEndpoint;
    
    Zotero.debug("NotebookLM Sync: API Endpoints Registered");
}

function shutdown(data, reason) {
    delete Zotero.Server.Endpoints["/notebooklm/list"];
    delete Zotero.Server.Endpoints["/notebooklm/file"];
}

function install() {}
function uninstall() {}
