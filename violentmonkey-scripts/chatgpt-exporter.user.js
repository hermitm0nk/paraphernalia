// ==UserScript==
// @name         AI Chat Exporter by RevivalStack (Selection & DOM Fix)
// @namespace    https://github.com/revivalstack/chatgpt-exporter
// @version      3.0.0
// @description  Export AI chats to Markdown while preserving message formatting.
// @author       Mic Mejia (Refactored; fixed by ChatGPT)
// @updateURL    https://raw.githubusercontent.com/hermitm0nk/paraphernalia/master/violentmonkey-scripts/chatgpt-exporter.user.js
// @downloadURL  https://raw.githubusercontent.com/hermitm0nk/paraphernalia/master/violentmonkey-scripts/chatgpt-exporter.user.js
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @match        https://claude.ai/*
// @match        https://www.copilot.com/*
// @match        https://gemini.google.com/*
// @match        https://grok.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    "use strict";

    const EXPORT_CONTAINER_ID = "export-controls-container";
    const OUTLINE_CONTAINER_ID = "export-outline-container";
    const STYLE_ID = "exporter-style-v300";

    let isOutlineVisible = false;
    let selectedMessageIds = new Set();
    let deselectedMessageIds = new Set();
    let masterData = [];

    const SafeDOM = {
        createIcon(pathD) {
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("viewBox", "0 0 24 24");
            svg.setAttribute("width", "20");
            svg.setAttribute("height", "20");
            svg.setAttribute("fill", "currentColor");
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", pathD);
            svg.appendChild(path);
            return svg;
        },
        applyStyles(el, styles) {
            for (const [prop, val] of Object.entries(styles)) {
                el.style.setProperty(prop, val, "important");
            }
        },
        clearElement(el) {
            if (!el) return;
            while (el.firstChild) el.removeChild(el.firstChild);
        }
    };

    const PATHS = {
        COPY: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z",
        DOWNLOAD: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z",
        SETTINGS: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"
    };

    function normalizeText(raw) {
        return (raw || "")
            .replace(/\u00a0/g, " ")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n[ \t]+/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .replace(/\bShow more\s+Show less\b/gi, "")
            .replace(/^\s*(You said|ChatGPT said|Claude said|Gemini said|Copilot said|Grok said):?\s*/i, "")
            .trim();
    }

    function normalizeMarkdown(raw) {
        return (raw || "")
            .replace(/\u00a0/g, " ")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .replace(/\bShow more\s+Show less\b/gi, "")
            .replace(/^\s*(You said|ChatGPT said|Claude said|Gemini said|Copilot said|Grok said):?\s*/i, "")
            .trim();
    }

    function escapeMarkdownText(text) {
        return text
            .replace(/([\\`*_{}\[\]<>#+.!|()-])/g, "\\$1");
    }

    function inlineCode(text) {
        const runs = text.match(/`+/g) || [];
        const fence = "`".repeat(Math.max(1, ...runs.map(run => run.length + 1)));
        const padding = /^ | $/.test(text) ? " " : "";
        return `${fence}${padding}${text}${padding}${fence}`;
    }

    function renderList(el, ordered, renderNode) {
        const start = Number(el.getAttribute("start")) || 1;
        return Array.from(el.children)
            .filter(child => child.tagName === "LI")
            .map((li, index) => {
                const marker = ordered ? `${start + index}. ` : "- ";
                const content = Array.from(li.childNodes).map(child => renderNode(child)).join("").trim();
                const lines = content.split("\n");
                return marker + lines.map((line, lineIndex) => lineIndex ? `  ${line}` : line).join("\n");
            })
            .join("\n") + "\n\n";
    }

    function domToMarkdown(root) {
        const renderNode = node => {
            if (node.nodeType === Node.TEXT_NODE) return escapeMarkdownText(node.nodeValue || "");
            if (node.nodeType !== Node.ELEMENT_NODE) return "";

            const el = node;
            const tag = el.tagName.toLowerCase();
            const children = () => Array.from(el.childNodes).map(renderNode).join("");

            if (el.matches(".katex, .katex-display")) {
                const tex = el.querySelector("annotation[encoding='application/x-tex']")?.textContent?.trim();
                if (tex) return el.matches(".katex-display") || el.closest(".katex-display") ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
            }

            if (/^h[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${children().trim()}\n\n`;
            if (tag === "p") return `${children().trim()}\n\n`;
            if (tag === "br") return "\\\n";
            if (tag === "strong" || tag === "b") return `**${children()}**`;
            if (tag === "em" || tag === "i") return `*${children()}*`;
            if (tag === "del" || tag === "s" || tag === "strike") return `~~${children()}~~`;
            if (tag === "code" && el.parentElement?.tagName !== "PRE") return inlineCode(el.textContent || "");
            if (tag === "pre") {
                const code = el.querySelector("code");
                const value = (code?.textContent || el.textContent || "").replace(/\n$/, "");
                const language = (code?.className.match(/(?:language-|lang-)([\w+-]+)/) || [])[1] || "";
                const longest = Math.max(0, ...(value.match(/`+/g) || []).map(run => run.length));
                const fence = "`".repeat(Math.max(3, longest + 1));
                return `\n\n${fence}${language}\n${value}\n${fence}\n\n`;
            }
            if (tag === "a") {
                const label = children().trim() || el.getAttribute("href") || "";
                const href = el.getAttribute("href");
                return href ? `[${label}](${href.replace(/\)/g, "\\)")})` : label;
            }
            if (tag === "img") {
                const src = el.getAttribute("src");
                return src ? `![${(el.getAttribute("alt") || "").replace(/]/g, "\\]")}](${src.replace(/\)/g, "\\)")})` : "";
            }
            if (tag === "ul") return renderList(el, false, renderNode);
            if (tag === "ol") return renderList(el, true, renderNode);
            if (tag === "blockquote") return children().trim().split("\n").map(line => `> ${line}`).join("\n") + "\n\n";
            if (tag === "hr") return "\n\n---\n\n";
            if (tag === "table") {
                const rows = Array.from(el.querySelectorAll("tr")).map(row =>
                    Array.from(row.querySelectorAll(":scope > th, :scope > td")).map(cell =>
                        Array.from(cell.childNodes).map(renderNode).join("").trim().replace(/\|/g, "\\|").replace(/\n+/g, " ")
                    )
                ).filter(row => row.length);
                if (!rows.length) return "";
                const width = Math.max(...rows.map(row => row.length));
                const formatRow = row => `| ${Array.from({ length: width }, (_, i) => row[i] || "").join(" | ")} |`;
                return `\n\n${formatRow(rows[0])}\n${formatRow(Array(width).fill("---"))}\n${rows.slice(1).map(formatRow).join("\n")}\n\n`;
            }
            if (["div", "section", "article", "main", "header", "footer", "figure", "figcaption", "details", "summary"].includes(tag)) {
                return `${children()}\n`;
            }
            return children();
        };

        return normalizeMarkdown(Array.from(root.childNodes).map(renderNode).join(""));
    }

    function getReadableMarkdown(el) {
        if (!el) return "";
        const clone = el.cloneNode(true);

        // Remove controls/decoration. Keep the actual message body.
        clone.querySelectorAll([
            "script", "style", "svg", "button", "textarea", "input", "select",
            ".sr-only", "[aria-hidden='true']", "[role='button']", "[role='menu']",
            "[data-testid='copy-turn-action-button']", "[data-testid='webpage-citation-pill']",
            "#export-controls-container", "#export-outline-container"
        ].join(",")).forEach(n => n.remove());

        return domToMarkdown(clone);
    }

    function textFromChatGPTMessage(node, role) {
        // Prefer the real body container rather than the whole turn. The whole turn
        // includes screen-reader headings, copy/edit buttons, and expansion controls.
        const selectors = role === "user"
            ? [
                "[data-testid='user-message']",
                ".whitespace-pre-wrap",
                ".query-content"
            ]
            : [
                ".markdown",
                "message-content",
                "[data-testid='assistant-message']",
                ".prose"
            ];

        for (const selector of selectors) {
            const target = node.querySelector(selector);
            const text = getReadableMarkdown(target);
            if (text) return text;
        }

        return getReadableMarkdown(node);
    }

    function stableId(node, role, index, text) {
        const attrId = node.getAttribute("data-message-id") ||
            node.getAttribute("data-turn-id") ||
            node.closest("[data-turn-id]")?.getAttribute("data-turn-id");
        if (attrId) return `${role}-${attrId}`;

        // Deterministic enough for loaded DOMs that do not expose message IDs.
        let hash = 0;
        const seed = `${role}:${index}:${text.slice(0, 200)}`;
        for (let i = 0; i < seed.length; i++) {
            hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
        }
        return `${role}-${index}-${Math.abs(hash)}`;
    }

    function topLevelMessageNodes() {
        const nodes = Array.from(document.querySelectorAll("[data-message-author-role='user'], [data-message-author-role='assistant']"));
        return nodes.filter(node => node.closest("[data-message-author-role]") === node);
    }

    function collectChatGPT() {
        const nodes = topLevelMessageNodes();
        const data = [];
        let lastUserId = null;

        if (nodes.length) {
            nodes.forEach((node, idx) => {
                const rawRole = node.getAttribute("data-message-author-role");
                const author = rawRole === "user" ? "User" : "AI";
                const text = textFromChatGPTMessage(node, rawRole);
                if (!text) return;

                const id = stableId(node, rawRole, idx, text);
                const item = { id, author, text, parentUserId: lastUserId };

                if (author === "User") {
                    item.parentUserId = id;
                    lastUserId = id;
                    if (!deselectedMessageIds.has(id)) selectedMessageIds.add(id);
                }

                data.push(item);
            });
            return data;
        }

        // Fallback for older ChatGPT DOMs: use turn containers.
        const turns = Array.from(document.querySelectorAll("[data-testid^='conversation-turn-'], [data-turn]"));
        turns.forEach((turn, idx) => {
            const roleAttr = turn.getAttribute("data-turn");
            const label = (turn.querySelector("h4, h5")?.textContent || "").toLowerCase();
            const isUser = roleAttr === "user" || label.includes("you said");
            const role = isUser ? "user" : "assistant";
            const author = isUser ? "User" : "AI";
            const text = textFromChatGPTMessage(turn, role);
            if (!text) return;

            const id = stableId(turn, role, idx, text);
            const item = { id, author, text, parentUserId: lastUserId };
            if (isUser) {
                item.parentUserId = id;
                lastUserId = id;
                if (!deselectedMessageIds.has(id)) selectedMessageIds.add(id);
            }
            data.push(item);
        });
        return data;
    }

    function collectGemini() {
        const items = Array.from(document.querySelectorAll("user-query, model-response"));
        const data = [];
        let lastUserId = null;

        items.forEach((item, idx) => {
            const isUser = item.tagName.toLowerCase() === "user-query";
            const role = isUser ? "user" : "assistant";
            const author = isUser ? "User" : "AI";
            const body = item.querySelector(".query-content, message-content, .markdown, .model-response-text") || item;
            const text = getReadableMarkdown(body);
            if (!text) return;

            const id = stableId(item, role, idx, text);
            const entry = { id, author, text, parentUserId: lastUserId };
            if (isUser) {
                entry.parentUserId = id;
                lastUserId = id;
                if (!deselectedMessageIds.has(id)) selectedMessageIds.add(id);
            }
            data.push(entry);
        });

        return data;
    }

    function collectGeneric() {
        // Local saved ChatGPT HTML has no chatgpt.com hostname, so still
        // prefer the modern ChatGPT role markers when they are present.
        if (topLevelMessageNodes().length) return collectChatGPT();

        const selectors = [
            "[data-testid^='conversation-turn-']",
            "[data-turn]",
            "user-query",
            "model-response"
        ];
        const items = Array.from(document.querySelectorAll(selectors.join(",")));
        const data = [];
        let lastUserId = null;

        items.forEach((item, idx) => {
            const textAll = (item.textContent || "").toLowerCase();
            const roleAttr = item.getAttribute("data-turn") || "";
            const isUser = roleAttr === "user" || textAll.includes("you said") || item.tagName.toLowerCase() === "user-query";
            const role = isUser ? "user" : "assistant";
            const author = isUser ? "User" : "AI";
            const body = item.querySelector(".query-content, message-content, .markdown, .whitespace-pre-wrap, .prose") || item;
            const text = getReadableMarkdown(body);
            if (!text) return;

            const id = stableId(item, role, idx, text);
            const entry = { id, author, text, parentUserId: lastUserId };
            if (isUser) {
                entry.parentUserId = id;
                lastUserId = id;
                if (!deselectedMessageIds.has(id)) selectedMessageIds.add(id);
            }
            data.push(entry);
        });

        return data;
    }

    const ChatExporter = {
        updateMasterData() {
            const host = window.location.hostname;
            if (host.includes("gemini")) {
                masterData = collectGemini();
            } else if (host.includes("chatgpt") || host.includes("openai")) {
                masterData = collectChatGPT();
            } else {
                masterData = collectGeneric();
            }
        },

        buildOutput() {
            this.updateMasterData();
            const safeTitle = normalizeText(document.title) || "chat-transcript";
            let output = `# ${safeTitle}\n\n`;

            const selectedUsers = new Set(selectedMessageIds);
            const included = masterData.filter(m => {
                if (m.author === "User") return selectedUsers.has(m.id);
                return m.parentUserId && selectedUsers.has(m.parentUserId);
            });

            for (const m of included) {
                output += `### ${m.author}\n\n${m.text}\n\n---\n\n`;
            }

            return output;
        },

        async copyText(text) {
            if (typeof GM_setClipboard === "function") {
                GM_setClipboard(text, "text");
                return;
            }
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return;
            }

            // Last-resort fallback for pages/browsers without Clipboard API access.
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.left = "-9999px";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            document.execCommand("copy");
            ta.remove();
        },

        async export(mode) {
            const output = this.buildOutput();
            if (mode === "copy") {
                await this.copyText(output);
            } else {
                const blob = new Blob([output], { type: "text/markdown;charset=utf-8" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `${(normalizeText(document.title) || "chat-transcript").replace(/[/\\?%*:|"<>]/g, "-")}.md`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            }
        }
    };

    const UIManager = {
        injectThemeStyles() {
            if (document.getElementById(STYLE_ID)) return;
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = `
                #${EXPORT_CONTAINER_ID} { position: fixed; bottom: 20px; right: 20px; z-index: 214748364; display: flex; align-items: center; gap: 10px; }
                #${EXPORT_CONTAINER_ID} button { all: initial; width: 40px; height: 40px; border-radius: 50%; background-color: #222; color: #ccc; border: 1px solid #444; cursor: pointer; display: flex; justify-content: center; align-items: center; box-shadow: 0 4px 12px rgba(0,0,0,0.1); transition: transform 0.2s; flex-shrink: 0; }
                #${EXPORT_CONTAINER_ID} button:hover { background-color: #333; transform: scale(1.05); }
                #${OUTLINE_CONTAINER_ID} { position: fixed; bottom: 75px; right: 20px; z-index: 2147483646; width: 320px; max-height: 450px; border-radius: 12px; display: none; flex-direction: column; padding: 15px; font-family: sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,0.2); border: 1px solid #ddd; background-color: #ffffff; color: #333; }
                @media (prefers-color-scheme: dark) {
                    #${OUTLINE_CONTAINER_ID} { background-color: #1a1a1a; color: #e0e0e0; border-color: #444; }
                    #${OUTLINE_CONTAINER_ID} input[type="text"] { background-color: #2a2a2a; color: #fff; border-color: #555; }
                    #${OUTLINE_CONTAINER_ID} div { border-color: #333; }
                }
            `;
            document.head.appendChild(style);
        },

        renderOutlineContent() {
            ChatExporter.updateMasterData();
            const container = document.getElementById(OUTLINE_CONTAINER_ID);
            SafeDOM.clearElement(container);
            if (!container) return;

            const userMsgs = masterData.filter(m => m.author === "User");

            const header = document.createElement("div");
            SafeDOM.applyStyles(header, { "display": "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "10px", "padding-bottom": "8px", "border-bottom": "1px solid #eee" });

            const title = document.createElement("span");
            title.textContent = `Outline Selection (${userMsgs.length})`;
            title.style.fontWeight = "bold";

            const masterCB = document.createElement("input");
            masterCB.type = "checkbox";
            masterCB.title = "Select/Deselect All";
            masterCB.checked = userMsgs.length > 0 && userMsgs.every(m => selectedMessageIds.has(m.id));

            masterCB.onchange = () => {
                userMsgs.forEach(m => {
                    if (masterCB.checked) {
                        selectedMessageIds.add(m.id);
                        deselectedMessageIds.delete(m.id);
                    } else {
                        selectedMessageIds.delete(m.id);
                        deselectedMessageIds.add(m.id);
                    }
                });
                this.renderOutlineContent();
            };

            header.appendChild(title);
            header.appendChild(masterCB);
            container.appendChild(header);

            const search = document.createElement("input");
            search.type = "text";
            search.placeholder = "Filter list...";
            SafeDOM.applyStyles(search, { "width": "100%", "padding": "6px", "margin-bottom": "10px", "border": "1px solid #ddd", "border-radius": "4px", "box-sizing": "border-box" });
            search.oninput = (e) => {
                const term = e.target.value.toLowerCase();
                container.querySelectorAll(".row").forEach(row => {
                    row.style.display = row.textContent.toLowerCase().includes(term) ? "flex" : "none";
                });
            };
            container.appendChild(search);

            const list = document.createElement("div");
            list.style.overflowY = "auto";

            userMsgs.forEach(m => {
                const row = document.createElement("div");
                row.className = "row";
                SafeDOM.applyStyles(row, { "display": "flex", "align-items": "center", "padding": "5px 0" });

                const cb = document.createElement("input");
                cb.type = "checkbox";
                cb.checked = selectedMessageIds.has(m.id);
                cb.onchange = () => {
                    if (cb.checked) {
                        selectedMessageIds.add(m.id);
                        deselectedMessageIds.delete(m.id);
                    } else {
                        selectedMessageIds.delete(m.id);
                        deselectedMessageIds.add(m.id);
                    }
                    masterCB.checked = userMsgs.every(msg => selectedMessageIds.has(msg.id));
                };

                const label = document.createElement("span");
                label.textContent = m.text.slice(0, 65) + (m.text.length > 65 ? "..." : "");
                SafeDOM.applyStyles(label, { "font-size": "12px", "margin-left": "8px", "cursor": "default" });

                row.appendChild(cb);
                row.appendChild(label);
                list.appendChild(row);
            });
            container.appendChild(list);
        },

        addControls() {
            if (document.getElementById(EXPORT_CONTAINER_ID)) return;

            const outline = document.createElement("div");
            outline.id = OUTLINE_CONTAINER_ID;

            const container = document.createElement("div");
            container.id = EXPORT_CONTAINER_ID;

            const createBtn = (id, path, title, action) => {
                const b = document.createElement("button");
                b.id = id;
                b.title = title;
                b.appendChild(SafeDOM.createIcon(path));
                b.onclick = action;
                return b;
            };

            container.appendChild(createBtn("copy", PATHS.COPY, "Copy Selected", () => ChatExporter.export("copy")));
            container.appendChild(createBtn("down", PATHS.DOWNLOAD, "Download Selected", () => ChatExporter.export("download")));
            container.appendChild(createBtn("cog", PATHS.SETTINGS, "Outline", () => {
                const outlineEl = document.getElementById(OUTLINE_CONTAINER_ID);
                isOutlineVisible = !isOutlineVisible;
                outlineEl.style.display = isOutlineVisible ? "flex" : "none";
                if (isOutlineVisible) this.renderOutlineContent();
            }));

            document.documentElement.appendChild(outline);
            document.documentElement.appendChild(container);
        },

        init() {
            this.injectThemeStyles();
            this.addControls();
            ChatExporter.updateMasterData();

            let pending = false;
            const obs = new MutationObserver(() => {
                if (pending) return;
                pending = true;
                setTimeout(() => {
                    pending = false;
                    this.injectThemeStyles();
                    this.addControls();
                    ChatExporter.updateMasterData();
                    if (isOutlineVisible) this.renderOutlineContent();
                }, 300);
            });
            obs.observe(document.documentElement, { childList: true, subtree: true });
        }
    };

    UIManager.init();
})();
