// ==UserScript==
// @name         Middle-Click Selection Translator (Keep Punctuation)
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Translates selected text on middle-click. Removes line breaks/tabs but keeps punctuation. Auto-detects the source language from the selected text.
// @author       Gemini
// @match file:///*
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      translate.google.com
// ==/UserScript==

(function() {
    'use strict';

    // CSS for the popup
    GM_addStyle(`
        #gm-translate-popup {
            position: absolute;
            z-index: 10000;
            background: #222;
            color: #fff;
            padding: 10px 15px;
            border-radius: 5px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            font-family: sans-serif;
            font-size: 14px;
            line-height: 1.4;
            max-width: 400px;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.2s;
        }
        #gm-translate-popup.visible {
            opacity: 1;
            pointer-events: auto;
        }
    `);

    // Create the popup element attached to body
    let popup = document.createElement('div');
    popup.id = 'gm-translate-popup';
    document.body.appendChild(popup);

    // Hide popup on any left click outside of it
    document.addEventListener('mousedown', (e) => {
        if (e.button === 0 && popup.classList.contains('visible')) {
            if (!popup.contains(e.target)) {
                hidePopup();
            }
        }
    });

    document.addEventListener('auxclick', handleMiddleClick);

    function handleMiddleClick(e) {
        if (e.button !== 1) return;

        const selection = window.getSelection();
        const selectedText = selection.toString();

        if (selectedText.trim().length > 0) {
            e.preventDefault();
            e.stopPropagation();

            const processedText = cleanText(selectedText);

            translateText(processedText, e.pageX, e.pageY);
        }
    }

    function cleanText(text) {
        // Replace all whitespace sequences (newlines, tabs, spaces) with a single space.
        // This preserves all punctuation and letters.
        return text.replace(/\s+/g, " ").trim();
    }

    function translateText(text, x, y) {
        if (!text) return;
        showPopup("Translating...", x, y);
        const url = `https://translate.google.com/m?sl=auto&tl=en&q=${encodeURIComponent(text)}`;

        GM_xmlhttpRequest({
            method: "GET",
            url: url,
            onload: function(response) {
                try {
                    const status = Number(response.status);
                    if (status && (status < 200 || status >= 300)) {
                        throw new Error(`Google web translation failed with HTTP ${status}`);
                    }

                    const document = new DOMParser().parseFromString(response.responseText, "text/html");
                    const result = document.querySelector(".result-container");
                    const translation = result ? result.textContent.trim() : "";
                    if (!translation) {
                        throw new Error("Google web translation returned no result");
                    }
                    showPopup(translation, x, y);
                } catch (err) {
                    const status = response.status ? ` (HTTP ${response.status})` : "";
                    showPopup(`Translation unavailable${status}.`, x, y);
                    console.error("Translation error:", err);
                }
            },
            onerror: function(err) {
                showPopup("Network error.", x, y);
                console.error("Google web translation network error:", err);
            },
            ontimeout: function() {
                showPopup("Translation timed out.", x, y);
            }
        });
    }

    function showPopup(text, x, y) {
        popup.textContent = text;
        popup.style.top = (y + 15) + 'px';
        popup.style.left = x + 'px';
        popup.classList.add('visible');
        popup.lang = "en";
    }

    function hidePopup() {
        popup.classList.remove('visible');
    }

})();
