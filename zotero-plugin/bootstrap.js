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
				const collectionKey = data?.collectionKey;
				
				const libraryID = (libraryIDStr && libraryIDStr !== "0") ? parseInt(libraryIDStr) : Zotero.Libraries.userLibraryID;

				let results = [];
				
				if ((collectionKey && collectionKey.trim()) || (collectionName && collectionName.trim())) {
					const findCollection = async (libID, key, title) => {
						const collections = await Zotero.Collections.getByLibrary(libID);
						if (key && key.trim()) {
							for (let col of collections) {
								if (col.key === key.trim()) return col;
							}
						}
						if (!title || !title.trim()) return null;
						for (let col of collections) {
							if (col.name.toLowerCase() === title.toLowerCase()) return col;
						}
						return null;
					};

					const collection = await findCollection(libraryID, collectionKey, collectionName);
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
						Zotero.debug("[NotebookLM Bridge] Collection not found: " + (collectionKey || collectionName));
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

// 3. Metadata endpoint for project setup choices
function MetadataEndpoint() {}
MetadataEndpoint.prototype = {
	supportedMethods: ['POST'],
	supportedDataTypes: ['application/json'],
	permitBookmarklet: true,

	init: function (urlObj, data, sendResponseCallback) {
		(async () => {
			try {
				const libraries = await getLibrariesForMetadata();
				const collections = [];
				const tags = [];

				for (let library of libraries) {
					const libraryID = library.actualLibraryID;

					try {
						const libraryCollections = await Zotero.Collections.getByLibrary(libraryID);
						const collectionByKey = {};
						for (let collection of libraryCollections) {
							collectionByKey[collection.key] = collection;
						}
						for (let collection of libraryCollections) {
							const path = buildCollectionPath(collection, collectionByKey);
							collections.push({
								key: collection.key,
								name: collection.name,
								path,
								libraryID: library.id,
								actualLibraryID: libraryID,
								parentKey: collection.parentKey || null,
								depth: Math.max(0, path.split(" / ").length - 1)
							});
						}
					} catch (e) {
						Zotero.debug("[NotebookLM Bridge] Failed to list collections: " + e);
					}

					try {
						const libraryTags = await getTagsForLibrary(libraryID);
						for (let tag of libraryTags) {
							tags.push({
								name: tag,
								libraryID: library.id,
								actualLibraryID: libraryID
							});
						}
					} catch (e) {
						Zotero.debug("[NotebookLM Bridge] Failed to list tags: " + e);
					}
				}

				sendResponseCallback(200, "application/json", JSON.stringify({
					libraries,
					collections: collections.sort((a, b) => a.path.localeCompare(b.path)),
					tags
				}));
			} catch (e) {
				Zotero.debug("[NotebookLM Bridge] Error listing metadata: " + e);
				sendResponseCallback(500, "text/plain", "Error: " + e);
			}
		})();
	}
};

function buildCollectionPath(collection, collectionByKey) {
	const names = [collection.name];
	let parentKey = collection.parentKey || null;
	let guard = 0;

	while (parentKey && collectionByKey[parentKey] && guard < 20) {
		const parent = collectionByKey[parentKey];
		names.unshift(parent.name);
		parentKey = parent.parentKey || null;
		guard += 1;
	}

	return names.join(" / ");
}

async function getLibrariesForMetadata() {
	const userLibraryID = Zotero.Libraries.userLibraryID;
	const libraries = [{
		id: "0",
		actualLibraryID: userLibraryID,
		name: "My Library",
		type: "user"
	}];

	if (Zotero.Libraries.getAll) {
		const allLibraries = await Promise.resolve(Zotero.Libraries.getAll());
		for (let library of allLibraries) {
			if (!library || library.libraryID === userLibraryID) continue;
			libraries.push({
				id: String(library.libraryID),
				actualLibraryID: library.libraryID,
				name: library.name || `Library ${library.libraryID}`,
				type: library.libraryType || "library"
			});
		}
	}

	return libraries;
}

async function getTagsForLibrary(libraryID) {
	if (Zotero.Tags && Zotero.Tags.getAll) {
		const rawTags = await Zotero.Tags.getAll(libraryID);
		return rawTags
			.map(tag => typeof tag === "string" ? tag : tag?.tag || tag?.name)
			.filter(Boolean)
			.sort((a, b) => a.localeCompare(b));
	}

	return Zotero.DB.columnQueryAsync(
		"SELECT DISTINCT tags.name FROM tags JOIN itemTags USING(tagID) JOIN items USING(itemID) WHERE items.libraryID=? ORDER BY tags.name",
		[libraryID]
	);
}

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
    Zotero.Server.Endpoints["/notebooklm/metadata"] = MetadataEndpoint;
    
    Zotero.debug("NotebookLM Sync: API Endpoints Registered");
}

function shutdown(data, reason) {
    delete Zotero.Server.Endpoints["/notebooklm/list"];
    delete Zotero.Server.Endpoints["/notebooklm/file"];
    delete Zotero.Server.Endpoints["/notebooklm/metadata"];
}

function install() {}
function uninstall() {}
