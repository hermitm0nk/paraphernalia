// ==UserScript==
// @name         Raindrop → Hypothesis Highlight Exporter
// @namespace    https://github.com/hermitm0nk/paraphernalia
// @version      1.0.0
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

            const textIndex = buildRenderedTextIndex(root);
            const metadata = readRaindropMetadata();
            const metadataById = new Map(
                metadata
                    .filter((item) => item && item._id != null)
                    .map((item) => [String(item._id), item]),
            );

            let extracted = extractModernHighlights(textIndex, metadataById);
            let sourceMode = "css-custom-highlights";

            if (!extracted.length) {
                extracted = extractLegacyMarks(textIndex, metadataById);
                sourceMode = "legacy-mark-elements";
            }

            const unique = deduplicateHighlights(extracted);
            if (!unique.length) {
                throw new Error(
                    "No Raindrop highlights were accessible on this page. " +
                    "Make sure Raindrop highlighting is enabled and the highlights are visible before running the command.",
                );
            }

            const annotations = unique.map((item, index) => ({
                id: `raindrop-${item.raindropId || index}`,
                uri: location.href,
                document: {
                    title: [document.title],
                },
                text: item.note || "",
                tags: [],
                target: [
                    {
                        source: location.href,
                        selector: [item.selector],
                    },
                ],
                // An empty read list makes the imported annotation private.
                // Hypothesis regenerates permissions for the current account/group
                // during interactive import.
                permissions: {
                    read: [],
                    update: [],
                    delete: [],
                },
                // Hypothesis ignores unknown fields on import. Keep the original
                // Raindrop data in the export file as migration provenance.
                raindrop: {
                    id: item.raindropId,
                    color: item.color,
                    position: item.position,
                    originalText: item.originalText,
                },
            }));

            const output = {
                source: "Raindrop.io live-page extraction",
                source_mode: sourceMode,
                source_url: location.href,
                source_title: document.title,
                extracted_at: new Date().toISOString(),
                annotation_count: annotations.length,
                raindrop_metadata_accessible: metadata.length > 0,
                annotations,
            };

            // Useful for inspection before/after the download.
            window.__RAINDROP_HYPOTHESIS_EXPORT__ = output;

            downloadJSON(output);

            console.group(`[Raindrop → Hypothesis] Exported ${annotations.length} highlights`);
            console.log("Extraction mode:", sourceMode);
            console.log(
                "Raindrop metadata:",
                metadata.length ? `accessible (${metadata.length} records)` : "not accessible; notes may be absent",
            );
            console.table(
                unique.map((item, index) => ({
                    n: index + 1,
                    id: item.raindropId,
                    text: item.selector.exact.slice(0, 100),
                    prefix: item.selector.prefix || "",
                    suffix: item.selector.suffix || "",
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

    /**
     * Match Hypothesis's TextQuoteSelector representation closely:
     * DOM textContent with each <br> represented as one space.
     */
    function renderedTextFromRange(range) {
        const container = document.createElement("div");
        container.appendChild(range.cloneContents());
        container.querySelectorAll("br").forEach((br) => {
            br.replaceWith(document.createTextNode(" "));
        });
        return container.textContent || "";
    }

    /**
     * Build a rendered-text index without recursively touching arbitrary page
     * objects. TreeWalker is deliberately used here because Firefox can expose
     * extension-injected/custom nodes through security wrappers that throw when
     * recursively inspecting properties such as nodeType.
     */
    function buildRenderedTextIndex(root) {
        const starts = new WeakMap();
        const pieces = [];
        let length = 0;

        const rejectedTags = new Set([
            "SCRIPT",
            "STYLE",
            "NOSCRIPT",
            "TEXTAREA",
            "OPTION",
            "RDH-UI",
        ]);

        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    try {
                        if (node.nodeType === Node.TEXT_NODE) {
                            return NodeFilter.FILTER_ACCEPT;
                        }

                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const element = node;
                            if (rejectedTags.has(element.tagName)) {
                                return NodeFilter.FILTER_REJECT;
                            }
                            if (element.getAttribute("contenteditable") === "true") {
                                return NodeFilter.FILTER_REJECT;
                            }
                            if (element.tagName === "BR") {
                                return NodeFilter.FILTER_ACCEPT;
                            }
                            return NodeFilter.FILTER_SKIP;
                        }
                    } catch (_error) {
                        return NodeFilter.FILTER_REJECT;
                    }

                    return NodeFilter.FILTER_SKIP;
                },
            },
        );

        let node;
        while ((node = walker.nextNode())) {
            try {
                if (node.nodeType === Node.TEXT_NODE) {
                    const text = node.nodeValue || "";
                    starts.set(node, length);
                    pieces.push(text);
                    length += text.length;
                } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "BR") {
                    pieces.push(" ");
                    length += 1;
                }
            } catch (_error) {
                // Skip Firefox security-wrapped nodes.
            }
        }

        return {
            text: pieces.join(""),
            starts,
            root,
        };
    }

    function boundaryOffset(index, container, offset) {
        try {
            if (container.nodeType === Node.TEXT_NODE && index.starts.has(container)) {
                return index.starts.get(container) + offset;
            }

            // Fallback for element-level range boundaries. Raindrop normally
            // resolves highlights to text-node boundaries, so this is uncommon.
            const range = document.createRange();
            range.selectNodeContents(index.root);
            range.setEnd(container, offset);
            return renderedTextFromRange(range).length;
        } catch (error) {
            console.warn("[Raindrop → Hypothesis] Could not calculate range boundary offset:", error);
            return null;
        }
    }

    function selectorFromRange(range, index) {
        const exact = renderedTextFromRange(range);
        const start = boundaryOffset(index, range.startContainer, range.startOffset);
        const end = boundaryOffset(index, range.endContainer, range.endOffset);

        const selector = {
            type: "TextQuoteSelector",
            exact,
        };

        if (start != null && end != null) {
            selector.prefix = index.text.slice(Math.max(0, start - CONTEXT_LEN), start);
            selector.suffix = index.text.slice(end, Math.min(index.text.length, end + CONTEXT_LEN));
        }

        return selector;
    }

    /**
     * Raindrop's Svelte UI keeps the original highlight records (_id, text,
     * note, color, position) on rdh-ui.store. Cross-extension isolation may hide
     * the expando property in Firefox, so metadata is optional: anchoring does
     * not depend on it.
     */
    function readRaindropMetadata() {
        try {
            const ui = document.querySelector("rdh-ui");
            const highlights = ui && ui.store && ui.store.highlights;
            return Array.isArray(highlights) ? highlights : [];
        } catch (_error) {
            return [];
        }
    }

    /**
     * Current Raindrop versions paint highlights with the CSS Custom Highlight
     * API using names of the form rh-<instance timestamp>-<Raindrop id>.
     */
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
            // Firefox may restrict registry enumeration across extension realms.
        }

        // Raindrop also emits ::highlight(...) rules into style[id^="rh-"].
        // Reading these gives us the names even if registry enumeration itself
        // is unavailable.
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

        // Extension reloads can leave stale registrations/styles behind. The
        // timestamp is per Raindrop instance, so use only the newest namespace.
        const newestTimestamp = Math.max(
            ...allNames
                .map((name) => RAINDROP_HIGHLIGHT_NAME.exec(name))
                .filter(Boolean)
                .map((match) => Number(match[1])),
        );

        return allNames.filter((name) => name.startsWith(`rh-${newestTimestamp}-`));
    }

    function extractModernHighlights(textIndex, metadataById) {
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
                        const selector = selectorFromRange(range, textIndex);
                        if (!selector.exact.trim()) {
                            continue;
                        }
                        extracted.push({
                            raindropId,
                            selector,
                            note: metadata && typeof metadata.note === "string" ? metadata.note : "",
                            color: metadata && typeof metadata.color === "string" ? metadata.color : null,
                            position: metadata && typeof metadata.position === "number" ? metadata.position : null,
                            originalText:
                                metadata && typeof metadata.text === "string" ? metadata.text : selector.exact,
                        });
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

    /**
     * Older Raindrop versions wrap highlight fragments in <mark> elements with
     * a shared rh-<timestamp> class and data-id. Reconstruct one Range per id.
     */
    function extractLegacyMarks(textIndex, metadataById) {
        const groups = new Map();
        const marks = document.querySelectorAll('mark[class^="rh-"][data-id]');

        marks.forEach((mark) => {
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

                const selector = selectorFromRange(range, textIndex);
                const metadata = metadataById.get(raindropId);

                if (!selector.exact.trim()) {
                    continue;
                }

                extracted.push({
                    raindropId,
                    selector,
                    note: metadata && typeof metadata.note === "string" ? metadata.note : "",
                    color: metadata && typeof metadata.color === "string" ? metadata.color : null,
                    position: metadata && typeof metadata.position === "number" ? metadata.position : null,
                    originalText: metadata && typeof metadata.text === "string" ? metadata.text : selector.exact,
                });
            } catch (error) {
                console.warn(`[Raindrop → Hypothesis] Could not extract legacy highlight ${raindropId}:`, error);
            }
        }

        return extracted;
    }

    function deduplicateHighlights(items) {
        const unique = [];
        const seen = new Set();

        for (const item of items) {
            const key = JSON.stringify([
                item.raindropId,
                item.selector.exact,
                item.selector.prefix || "",
                item.selector.suffix || "",
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
