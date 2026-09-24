// ==UserScript==
// @name         Raindrop → Hypothesis Highlight Exporter
// @namespace    https://github.com/hermitm0nk/paraphernalia
// @version      1.1.0
// @description  Export Raindrop.io highlights currently rendered on a page to Hypothesis-compatible JSON from the Violentmonkey menu.
// @author       Hermit
// @updateURL    https://raw.githubusercontent.com/hermitm0nk/paraphernalia/master/violentmonkey-scripts/raindrop-to-hypothesis.user.js
// @downloadURL  https://raw.githubusercontent.com/hermitm0nk/paraphernalia/master/violentmonkey-scripts/raindrop-to-hypothesis.user.js
// @match        *://*/*
// @match        file:///*
// @grant        GM_registerMenuCommand
// @inject-into  page
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    "use strict";

    const CONTEXT_LEN = 32;
    const COMMAND = "Export Raindrop highlights → Hypothesis JSON";
    const RAINDROP_HIGHLIGHT_NAME = /^rh-(\d{10,})-(.+)$/;
    const RAINDROP_STYLE_ID = /^rh-\d{10,}-?$/;
    const LEGACY_MARK_CLASS = /^rh-\d{10,}$/;

    // Hypothesis's import UI groups imported annotations by `annotation.user`.
    // This synthetic source identity is only for that UI; imported annotations
    // are saved under the currently logged-in Hypothesis account.
    const IMPORT_SOURCE_USER = "acct:raindrop-import@raindrop.io";
    const IMPORT_SOURCE_USER_INFO = { display_name: "Raindrop import" };

    GM_registerMenuCommand(COMMAND, exportRaindropHighlights, {
        id: "raindrop-to-hypothesis-export",
        title: "Export Raindrop highlights on the current page as Hypothesis import JSON",
    });

    async function exportRaindropHighlights() {
        try {
            const root = document.body;
            if (!root) {
                throw new Error("Document body is not available yet.");
            }

            const metadata = readRaindropMetadata();
            const metadataById = new Map(
                metadata
                    .filter((item) => item && item._id != null)
                    .map((item) => [String(item._id), item]),
            );

            let extracted = extractModernHighlights(root, metadataById);
            let sourceMode = "css-custom-highlights";

            if (!extracted.length) {
                extracted = extractLegacyMarks(root, metadataById);
                sourceMode = "legacy-mark-elements";
            }

            const unique = deduplicateHighlights(extracted);
            if (!unique.length) {
                throw new Error(
                    "No Raindrop highlights were accessible on this page. " +
                    "Make sure Raindrop highlighting is enabled and the highlights are visible before running the command.",
                );
            }

            const extractedAt = new Date().toISOString();
            const annotations = unique.map((item, index) => ({
                id: `raindrop-${item.raindropId || index}`,
                user: IMPORT_SOURCE_USER,
                user_info: IMPORT_SOURCE_USER_INFO,
                uri: location.href,
                document: { title: [document.title] },
                text: item.note || "",
                tags: [],
                target: [
                    {
                        source: location.href,
                        selector: item.selectors,
                    },
                ],
                permissions: {
                    read: [],
                    update: [],
                    delete: [],
                },
                raindrop: {
                    id: item.raindropId,
                    color: item.color,
                    position: item.position,
                    originalText: item.originalText,
                },
            }));

            const output = {
                export_date: extractedAt,
                export_userid: IMPORT_SOURCE_USER,
                client_version: "raindrop-to-hypothesis-userscript/1.1.0",
                source: "Raindrop.io live-page extraction",
                source_mode: sourceMode,
                source_url: location.href,
                source_title: document.title,
                extracted_at: extractedAt,
                annotation_count: annotations.length,
                raindrop_metadata_accessible: metadata.length > 0,
                selector_model: "Hypothesis RangeSelector + TextPositionSelector + TextQuoteSelector",
                annotations,
            };

            window.__RAINDROP_HYPOTHESIS_EXPORT__ = output;
            downloadJSON(output);

            console.group(`[Raindrop → Hypothesis] Exported ${annotations.length} highlights`);
            console.log("Extraction mode:", sourceMode);
            console.log("Selector model: native Hypothesis HTML selector trio");
            console.log(
                "Raindrop metadata:",
                metadata.length ? `accessible (${metadata.length} records)` : "not accessible; notes may be absent",
            );
            console.table(
                unique.map((item, index) => ({
                    n: index + 1,
                    id: item.raindropId,
                    text: quoteSelector(item.selectors).exact.slice(0, 100),
                    selectors: item.selectors.map((selector) => selector.type).join(", "),
                    note: item.note,
                })),
            );
            console.log("Raw export: window.__RAINDROP_HYPOTHESIS_EXPORT__");
            console.groupEnd();
        } catch (error) {
            console.error("[Raindrop → Hypothesis] Export failed:", error);
            alert(`Raindrop → Hypothesis export failed:\n\n${error instanceof Error ? error.message : String(error)}`);
        }
    }

    function quoteSelector(selectors) {
        return selectors.find((selector) => selector.type === "TextQuoteSelector") || { exact: "" };
    }

    // Hypothesis represents text inside a selector as DOM textContent, except
    // that each <br> contributes one literal space.
    function renderedTextFromRange(range) {
        const container = document.createElement("div");
        container.appendChild(range.cloneContents());
        container.querySelectorAll("br").forEach((br) => {
            br.replaceWith(document.createTextNode(" "));
        });
        return container.textContent || "";
    }

    // The following helpers intentionally mirror Hypothesis's current HTML
    // anchoring implementation. In particular, TextPositionSelector offsets are
    // UTF-16 offsets in document.body.textContent, not visual/rendered offsets.
    function nodeTextLength(node) {
        try {
            if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
                return (node.textContent || "").length;
            }
        } catch (_error) {
            // Security-wrapped nodes contribute no usable text here.
        }
        return 0;
    }

    function previousSiblingsTextLength(node) {
        let sibling = node.previousSibling;
        let length = 0;
        while (sibling) {
            length += nodeTextLength(sibling);
            sibling = sibling.previousSibling;
        }
        return length;
    }

    function textPositionFromPoint(node, offset) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (!node.parentElement) {
                throw new Error("Text node has no parent element");
            }
            return {
                element: node.parentElement,
                offset: previousSiblingsTextLength(node) + offset,
            };
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            let textOffset = 0;
            for (let i = 0; i < offset; i += 1) {
                textOffset += nodeTextLength(node.childNodes[i]);
            }
            return { element: node, offset: textOffset };
        }

        throw new Error("Range boundary is not an element or text node");
    }

    function positionRelativeToRoot(position, root) {
        let element = position.element;
        let offset = position.offset;

        while (element !== root) {
            if (!element || !element.parentElement) {
                throw new Error("Range boundary is outside document.body");
            }
            offset += previousSiblingsTextLength(element);
            element = element.parentElement;
        }

        return offset;
    }

    function resolveRawOffset(root, targetOffset) {
        const iterator = document.createNodeIterator(root, NodeFilter.SHOW_TEXT);
        let node = iterator.nextNode();
        let lastNode = null;
        let consumed = 0;

        while (node) {
            const length = node.data.length;
            if (consumed + length > targetOffset) {
                return { node, offset: targetOffset - consumed };
            }
            lastNode = node;
            consumed += length;
            node = iterator.nextNode();
        }

        if (lastNode && consumed === targetOffset) {
            return { node: lastNode, offset: lastNode.data.length };
        }

        throw new RangeError("Offset exceeds document.body text length");
    }

    function rangeFromRawOffsets(root, start, end) {
        const startPoint = resolveRawOffset(root, start);
        const endPoint = resolveRawOffset(root, end);
        const range = document.createRange();
        range.setStart(startPoint.node, startPoint.offset);
        range.setEnd(endPoint.node, endPoint.offset);
        return range;
    }

    function getNodePosition(node) {
        let position = 0;
        let current = node;
        while (current) {
            if (current.nodeName === node.nodeName) {
                position += 1;
            }
            current = current.previousSibling;
        }
        return position;
    }

    function xpathFromNode(node, root) {
        let xpath = "";
        let current = node;

        while (current !== root) {
            if (!current) {
                throw new Error("Node is not a descendant of document.body");
            }
            const name = current.nodeName.toLowerCase();
            xpath = `${name}[${getNodePosition(current)}]/${xpath}`;
            current = current.parentNode;
        }

        return (`/${xpath}`).replace(/\/$/, "");
    }

    function selectorsFromRange(range, root) {
        const start = textPositionFromPoint(range.startContainer, range.startOffset);
        const end = textPositionFromPoint(range.endContainer, range.endOffset);
        const rawStart = positionRelativeToRoot(start, root);
        const rawEnd = positionRelativeToRoot(end, root);

        const rangeSelector = {
            type: "RangeSelector",
            startContainer: xpathFromNode(start.element, root),
            startOffset: start.offset,
            endContainer: xpathFromNode(end.element, root),
            endOffset: end.offset,
        };

        const positionSelector = {
            type: "TextPositionSelector",
            start: rawStart,
            end: rawEnd,
        };

        const rawTextLength = (root.textContent || "").length;
        const prefixRange = rangeFromRawOffsets(root, Math.max(0, rawStart - CONTEXT_LEN), rawStart);
        const suffixRange = rangeFromRawOffsets(root, rawEnd, Math.min(rawTextLength, rawEnd + CONTEXT_LEN));
        const textQuoteSelector = {
            type: "TextQuoteSelector",
            exact: renderedTextFromRange(range),
            prefix: renderedTextFromRange(prefixRange),
            suffix: renderedTextFromRange(suffixRange),
        };

        return [rangeSelector, positionSelector, textQuoteSelector];
    }

    function readRaindropMetadata() {
        try {
            const ui = document.querySelector("rdh-ui");
            const highlights = ui && ui.store && ui.store.highlights;
            return Array.isArray(highlights) ? highlights : [];
        } catch (_error) {
            return [];
        }
    }

    // Current Raindrop versions use CSS Custom Highlights named
    // rh-<instance timestamp>-<Raindrop id>.
    function discoverModernHighlightNames() {
        const names = new Set();

        try {
            if (CSS && CSS.highlights) {
                for (const name of CSS.highlights.keys()) {
                    if (RAINDROP_HIGHLIGHT_NAME.test(name)) {
                        names.add(name);
                    }
                }
            }
        } catch (_error) {
            // Registry enumeration may be restricted across extension realms.
        }

        document.querySelectorAll('style[id^="rh-"]').forEach((style) => {
            try {
                if (!RAINDROP_STYLE_ID.test(style.id)) {
                    return;
                }
                const css = style.textContent || "";
                for (const match of css.matchAll(/::highlight\(\s*(rh-\d{10,}-[\w-]+)\s*\)/g)) {
                    names.add(match[1]);
                }
            } catch (_error) {
                // Ignore inaccessible extension-injected styles.
            }
        });

        const allNames = [...names];
        if (!allNames.length) {
            return [];
        }

        const timestamps = allNames
            .map((name) => RAINDROP_HIGHLIGHT_NAME.exec(name))
            .filter(Boolean)
            .map((match) => Number(match[1]));
        const newestTimestamp = Math.max(...timestamps);
        return allNames.filter((name) => name.startsWith(`rh-${newestTimestamp}-`));
    }

    function extractModernHighlights(root, metadataById) {
        const names = discoverModernHighlightNames();
        const extracted = [];

        if (!names.length || !CSS || !CSS.highlights) {
            return extracted;
        }

        for (const name of names) {
            let highlight;
            try {
                highlight = CSS.highlights.get(name);
            } catch (error) {
                console.warn(`[Raindrop → Hypothesis] Cannot access CSS highlight ${name}:`, error);
                continue;
            }
            if (!highlight) {
                continue;
            }

            const match = RAINDROP_HIGHLIGHT_NAME.exec(name);
            const raindropId = match ? match[2] : name;
            const metadata = metadataById.get(raindropId);

            try {
                for (const range of highlight) {
                    try {
                        const selectors = selectorsFromRange(range, root);
                        if (!quoteSelector(selectors).exact.trim()) {
                            continue;
                        }
                        extracted.push(highlightRecord(raindropId, selectors, metadata));
                    } catch (error) {
                        console.warn(`[Raindrop → Hypothesis] Failed to convert range ${raindropId}:`, error);
                    }
                }
            } catch (error) {
                console.warn(`[Raindrop → Hypothesis] Cannot enumerate ranges for ${name}:`, error);
            }
        }

        return extracted;
    }

    // Older Raindrop versions wrap highlight fragments in <mark> elements.
    function extractLegacyMarks(root, metadataById) {
        const groups = new Map();
        document.querySelectorAll('mark[class^="rh-"][data-id]').forEach((mark) => {
            try {
                if (!LEGACY_MARK_CLASS.test(mark.className)) {
                    return;
                }
                const id = mark.getAttribute("data-id");
                if (!id) {
                    return;
                }
                if (!groups.has(id)) {
                    groups.set(id, []);
                }
                groups.get(id).push(mark);
            } catch (_error) {
                // Skip inaccessible marks.
            }
        });

        const extracted = [];
        for (const [raindropId, group] of groups) {
            try {
                const first = group[0];
                const last = group[group.length - 1];
                const startNode = first.firstChild || first;
                const endNode = last.lastChild || last;
                const range = document.createRange();

                range.setStart(startNode, 0);
                range.setEnd(
                    endNode,
                    endNode.nodeType === Node.TEXT_NODE
                        ? (endNode.textContent || "").length
                        : endNode.childNodes.length,
                );

                const selectors = selectorsFromRange(range, root);
                if (!quoteSelector(selectors).exact.trim()) {
                    continue;
                }
                extracted.push(highlightRecord(raindropId, selectors, metadataById.get(raindropId)));
            } catch (error) {
                console.warn(`[Raindrop → Hypothesis] Could not extract legacy highlight ${raindropId}:`, error);
            }
        }

        return extracted;
    }

    function highlightRecord(raindropId, selectors, metadata) {
        return {
            raindropId,
            selectors,
            note: metadata && typeof metadata.note === "string" ? metadata.note : "",
            color: metadata && typeof metadata.color === "string" ? metadata.color : null,
            position: metadata && typeof metadata.position === "number" ? metadata.position : null,
            originalText:
                metadata && typeof metadata.text === "string"
                    ? metadata.text
                    : quoteSelector(selectors).exact,
        };
    }

    function deduplicateHighlights(items) {
        const unique = [];
        const seen = new Set();

        for (const item of items) {
            const quote = quoteSelector(item.selectors);
            const key = JSON.stringify([
                item.raindropId,
                quote.exact,
                quote.prefix || "",
                quote.suffix || "",
            ]);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            unique.push(item);
        }
        return unique;
    }

    function downloadJSON(output) {
        const blob = new Blob([JSON.stringify(output, null, 2)], {
            type: "application/json;charset=utf-8",
        });
        const blobURL = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        const host = (location.hostname || "local-file").replace(/[^a-z0-9.-]+/gi, "_");

        anchor.href = blobURL;
        anchor.download = `raindrop-to-hypothesis-${host}-${Date.now()}.json`;
        anchor.style.display = "none";
        document.documentElement.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(blobURL), 1000);
    }
})();