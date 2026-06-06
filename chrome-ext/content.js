// Browser-native NotebookLM API bridge.
// Adapted from the source-list and file-upload flow in agmmnn/notebooklm-sdk.

if (!globalThis.zoteroNotebookLMBridgeLoaded) {
    globalThis.zoteroNotebookLMBridgeLoaded = true;

    const RPC_METHOD = {
        GET_NOTEBOOK: "rLM1Ne",
        ADD_SOURCE_FILE: "o4cbdc"
    };

    const SOURCE_TYPE_BY_CODE = {
        1: "google_docs",
        2: "google_slides",
        3: "pdf",
        4: "pasted_text",
        5: "web_page",
        8: "markdown",
        9: "youtube",
        10: "media",
        11: "docx",
        13: "image",
        14: "google_spreadsheet",
        16: "csv"
    };

    const SOURCE_STATUS_BY_CODE = {
        1: "processing",
        2: "ready",
        3: "error",
        5: "preparing"
    };

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "NOTEBOOKLM_LIST_SOURCES") {
            listSources(request.notebookId)
                .then((sources) => {
                    sendResponse({
                        success: true,
                        sources,
                        sourceNames: sources.map((source) => source.title).filter(Boolean)
                    });
                })
                .catch((err) => sendResponse({ success: false, error: formatError(err) }));
            return true;
        }

        if (request.action === "NOTEBOOKLM_UPLOAD_FILES") {
            uploadFiles(request.notebookId, request.files || [])
                .then((result) => sendResponse(result))
                .catch((err) => sendResponse({ success: false, uploaded: [], failed: [], error: formatError(err) }));
            return true;
        }

        return false;
    });

    async function listSources(notebookId) {
        const params = [notebookId, null, [2], null, 0];
        const notebook = await rpcCall(RPC_METHOD.GET_NOTEBOOK, params, {
            sourcePath: `/notebook/${notebookId}`
        });

        if (!Array.isArray(notebook) || notebook.length === 0) return [];
        const notebookInfo = notebook[0];
        if (!Array.isArray(notebookInfo) || notebookInfo.length <= 1) return [];
        const sourcesList = notebookInfo[1];
        if (!Array.isArray(sourcesList)) return [];

        return sourcesList
            .filter((source) => Array.isArray(source) && source.length > 0)
            .map(parseSource);
    }

    async function uploadFiles(notebookId, files) {
        const uploaded = [];
        const failed = [];

        for (const file of files) {
            const clientFileId = file.clientFileId;
            const filename = file.filename || "file";

            try {
                if (!file.base64 || typeof file.base64 !== "string") {
                    throw new Error("Missing base64 payload");
                }

                const bytes = base64ToUint8Array(file.base64);
                const source = await addFileBuffer(notebookId, bytes, filename);

                uploaded.push({
                    clientFileId,
                    filename,
                    sourceId: source.id,
                    sourceName: source.title
                });
            } catch (err) {
                failed.push({
                    clientFileId,
                    filename,
                    error: formatError(err)
                });
            }
        }

        return {
            success: failed.length === 0,
            uploaded,
            failed
        };
    }

    async function addFileBuffer(notebookId, data, fileName) {
        const params = [
            [[fileName]],
            notebookId,
            [2],
            [1, null, null, null, null, null, null, null, null, null, [1]]
        ];

        const result = await rpcCall(RPC_METHOD.ADD_SOURCE_FILE, params, {
            sourcePath: `/notebook/${notebookId}`,
            allowNull: true
        });
        const sourceId = extractSourceId(result);

        const uploadUrl = await startResumableUpload(notebookId, fileName, data.length, sourceId);
        await uploadFile(uploadUrl, data);

        return {
            id: sourceId,
            title: fileName,
            status: "processing"
        };
    }

    async function startResumableUpload(notebookId, fileName, fileSize, sourceId) {
        const response = await fetch("https://notebooklm.google.com/upload/_/?authuser=0", {
            method: "POST",
            credentials: "include",
            headers: {
                "Accept": "*/*",
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                "x-goog-authuser": "0",
                "x-goog-upload-command": "start",
                "x-goog-upload-header-content-length": String(fileSize),
                "x-goog-upload-protocol": "resumable"
            },
            body: JSON.stringify({
                PROJECT_ID: notebookId,
                SOURCE_NAME: fileName,
                SOURCE_ID: sourceId
            })
        });

        if (!response.ok) {
            throw new Error(`Upload initiation failed: HTTP ${response.status}`);
        }

        const uploadUrl = response.headers.get("x-goog-upload-url");
        if (!uploadUrl) {
            throw new Error("NotebookLM did not return an upload session URL");
        }

        return uploadUrl;
    }

    async function uploadFile(uploadUrl, data) {
        const response = await fetch(uploadUrl, {
            method: "POST",
            credentials: "include",
            headers: {
                "Accept": "*/*",
                "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
                "X-Goog-Upload-Command": "upload, finalize",
                "X-Goog-Upload-Offset": "0"
            },
            body: data
        });

        if (!response.ok) {
            throw new Error(`File upload failed: HTTP ${response.status}`);
        }

        return response.text();
    }

    async function rpcCall(methodId, params, options = {}, retried = false) {
        const tokens = await getTokens();
        const rpcRequest = [[[methodId, JSON.stringify(params), null, "generic"]]];
        const body = `f.req=${encodeURIComponent(JSON.stringify(rpcRequest))}&at=${encodeURIComponent(tokens.csrfToken)}&`;
        const urlParams = new URLSearchParams({
            rpcids: methodId,
            "source-path": options.sourcePath || "/",
            "f.sid": tokens.sessionId,
            hl: "en",
            rt: "c"
        });
        const url = `https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?${urlParams.toString()}`;

        const response = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
            },
            body
        });

        if ((response.status === 401 || response.status === 403) && !retried) {
            tokenCache = null;
            return rpcCall(methodId, params, options, true);
        }

        if (!response.ok) {
            throw new Error(`NotebookLM RPC ${methodId} failed: HTTP ${response.status}`);
        }

        return decodeResponse(await response.text(), methodId, Boolean(options.allowNull));
    }

    let tokenCache = null;

    async function getTokens() {
        if (tokenCache) return tokenCache;

        let html = document.documentElement?.innerHTML || "";
        let tokens = extractTokens(html);

        if (!tokens) {
            const response = await fetch("https://notebooklm.google.com/", {
                credentials: "include",
                redirect: "follow"
            });
            if (!response.ok) {
                throw new Error(`Could not load NotebookLM auth page: HTTP ${response.status}`);
            }
            if (response.url.includes("accounts.google.com") || response.url.includes("signin")) {
                throw new Error("NotebookLM session is not signed in");
            }
            html = await response.text();
            tokens = extractTokens(html);
        }

        if (!tokens) {
            throw new Error("Could not extract NotebookLM session tokens");
        }

        tokenCache = tokens;
        return tokenCache;
    }

    function extractTokens(html) {
        const csrf = /"SNlM0e"\s*:\s*"([^"]+)"/.exec(html);
        const session = /"FdrFJe"\s*:\s*"([^"]+)"/.exec(html);
        if (!csrf?.[1] || !session?.[1]) return null;
        return {
            csrfToken: csrf[1],
            sessionId: session[1]
        };
    }

    function decodeResponse(rawResponse, rpcId, allowNull = false) {
        const cleaned = stripAntiXSSI(rawResponse);
        const chunks = parseChunkedResponse(cleaned);
        const foundIds = collectRPCIds(chunks);
        const result = extractRPCResult(chunks, rpcId);

        if (result === undefined && !allowNull) {
            if (foundIds.length > 0 && !foundIds.includes(rpcId)) {
                throw new Error(`No result for RPC ID ${rpcId}. Response had IDs: ${foundIds.join(", ")}`);
            }
            throw new Error(`No result found for RPC ID ${rpcId}`);
        }

        return result ?? null;
    }

    function stripAntiXSSI(response) {
        if (response.startsWith(")]}'")) {
            const match = /\)\]\}'\r?\n/.exec(response);
            if (match) return response.slice(match[0].length);
        }
        return response;
    }

    function parseChunkedResponse(response) {
        if (!response || !response.trim()) return [];

        const chunks = [];
        const lines = response.trim().split("\n");
        let skippedCount = 0;
        let index = 0;

        while (index < lines.length) {
            const line = (lines[index] || "").trim();
            if (!line) {
                index += 1;
                continue;
            }

            if (/^\d+$/.test(line)) {
                index += 1;
                if (index < lines.length) {
                    try {
                        chunks.push(JSON.parse(lines[index] || ""));
                    } catch (_) {
                        skippedCount += 1;
                    }
                }
                index += 1;
                continue;
            }

            try {
                chunks.push(JSON.parse(line));
            } catch (_) {
                skippedCount += 1;
            }
            index += 1;
        }

        if (skippedCount > 0 && skippedCount / lines.length > 0.1) {
            throw new Error(`NotebookLM response parsing failed: ${skippedCount} malformed chunk(s)`);
        }

        return chunks;
    }

    function collectRPCIds(chunks) {
        const ids = [];
        for (const chunk of chunks) {
            if (!Array.isArray(chunk)) continue;
            const items = Array.isArray(chunk[0]) ? chunk : [chunk];
            for (const item of items) {
                if (!Array.isArray(item) || item.length < 2) continue;
                if ((item[0] === "wrb.fr" || item[0] === "er") && typeof item[1] === "string") {
                    ids.push(item[1]);
                }
            }
        }
        return ids;
    }

    function extractRPCResult(chunks, rpcId) {
        for (const chunk of chunks) {
            if (!Array.isArray(chunk)) continue;
            const items = Array.isArray(chunk[0]) ? chunk : [chunk];
            for (const item of items) {
                if (!Array.isArray(item) || item.length < 3) continue;

                if (item[0] === "er" && item[1] === rpcId) {
                    throw new Error(`NotebookLM RPC ${rpcId} returned error: ${String(item[2] || "unknown")}`);
                }

                if (item[0] === "wrb.fr" && item[1] === rpcId) {
                    const resultData = item[2];
                    if (typeof resultData === "string") {
                        try {
                            return JSON.parse(resultData);
                        } catch (_) {
                            return resultData;
                        }
                    }
                    return resultData;
                }
            }
        }
        return undefined;
    }

    function parseSource(source) {
        const id = Array.isArray(source[0]) ? source[0][0] : source[0];
        const title = typeof source[1] === "string" ? source[1] : null;
        let url = null;
        if (Array.isArray(source[2]) && Array.isArray(source[2][7]) && typeof source[2][7][0] === "string") {
            url = source[2][7][0];
        }

        let createdAt = null;
        if (Array.isArray(source[2]) && Array.isArray(source[2][2]) && typeof source[2][2][0] === "number") {
            createdAt = source[2][2][0] * 1000;
        }

        let statusCode = 2;
        if (Array.isArray(source[3]) && typeof source[3][1] === "number") {
            statusCode = source[3][1];
        }

        let typeCode = null;
        if (Array.isArray(source[2]) && typeof source[2][4] === "number") {
            typeCode = source[2][4];
        }

        return {
            id: String(id),
            title,
            url,
            kind: SOURCE_TYPE_BY_CODE[typeCode] || "unknown",
            createdAt,
            status: SOURCE_STATUS_BY_CODE[statusCode] || "unknown",
            _typeCode: typeCode
        };
    }

    function extractSourceId(result) {
        if (Array.isArray(result)) {
            let current = result;
            while (Array.isArray(current) && current.length > 0) {
                if (typeof current[0] === "string" && current[0].length > 8) {
                    return current[0];
                }
                current = current[0];
            }

            for (const item of result) {
                if (typeof item === "string" && item.length > 8) return item;
            }
        }

        if (typeof result === "string" && result.length > 8) return result;
        throw new Error("Could not extract source ID from NotebookLM response");
    }

    function base64ToUint8Array(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    function formatError(err) {
        return err?.message || String(err);
    }
}
