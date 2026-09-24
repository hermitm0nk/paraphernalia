# paraphernalia

A collection of standalone tools and plugins for personal productivity.

## Repository structure

```text
paraphernalia/
├── koreader2anki/
│   ├── .env.example
│   ├── .gitignore
│   ├── README.md
│   └── sync_to_anki.py
├── koreader-plugins/
│   ├── README.md
│   ├── localdashboard.koplugin/
│   │   ├── _meta.lua
│   │   └── main.lua
│   └── vocabcloudsync.koplugin/
│       ├── _meta.lua
│       └── main.lua
├── violentmonkey-scripts/
│   ├── chatgpt-exporter.user.js
│   ├── middle-click-translate.user.js
│   └── raindrop-to-hypothesis.user.js
├── tgrm/
│   └── tgrm-secretary/
│       ├── .env.example
│       ├── .gitignore
│       ├── README.md
│       ├── SYSTEM.md
│       ├── about.html
│       ├── secretary_bot.py
│       └── tests/
│           └── test_secretary.py
├── .gitignore
├── LICENSE
└── README.md
```

## Components

### koreader2anki

A Python utility that synchronizes words collected by KOReader's Vocabulary Builder with Anki. It reads the Vocabulary Builder SQLite database, looks up definitions in an MDX dictionary, and creates new cards through AnkiConnect.

It:

1. Optionally downloads the database from WebDAV.
2. Reads vocabulary words from the local SQLite database.
3. Looks up words in an MDX dictionary.
4. Creates the `KOReader` Anki deck if necessary.
5. Adds new cards with the word on the front and a formatted definition on the back.
6. Leaves existing cards untouched and does not create duplicates.

The script uses PEP 723 inline metadata, so [uv](https://docs.astral.sh/uv/getting-started/installation/) can create its isolated environment and install dependencies automatically.

See [koreader2anki/README.md](koreader2anki/README.md) for setup, configuration, authentication, and command-line options.

### koreader-plugins

Two custom Lua plugins for [KOReader](https://github.com/koreader/koreader), intended for installation on a Kindle or another KOReader device.

#### `localdashboard.koplugin`

A full-screen dashboard showing:

- Current time with minute-level refresh
- Current date
- Weather, temperature, description, and an icon
- Battery percentage and charging status
- Automatic landscape rotation while the dashboard is open
- Restoration of the previous rotation after dismissal

Weather is refreshed hourly through wttr.in, with location determined through ip-api.com. The dashboard can be dismissed by tapping anywhere or pressing a key. It uses KOReader's built-in HTTP, JSON, and UI modules.

#### `vocabcloudsync.koplugin`

A background synchronizer for KOReader's `vocabulary_builder.sqlite3` database. It uses KOReader's existing `SyncService` and supports WebDAV or another cloud-storage backend exposed by KOReader.

Supported triggers include:

- Periodic synchronization, configurable from 5 minutes to 6 hours
- Before suspend
- Before power-off
- After Wi-Fi becomes available
- Optional synchronization after resume
- Manual synchronization from the Tools menu

The plugin checkpoints SQLite's WAL before synchronization, skips silently while offline, suppresses successful background notifications, and displays error toasts for configuration problems. Its settings include the enabled state, interval, server selection or override, and per-trigger switches.

See [koreader-plugins/README.md](koreader-plugins/README.md) for installation and configuration details.

### violentmonkey-scripts

Three browser userscripts for [Violentmonkey](https://violentmonkey.github.io/) and compatible userscript managers.

#### `chatgpt-exporter.user.js`

Adds export controls to supported AI chat pages:

- ChatGPT
- Claude
- Microsoft Copilot
- Google Gemini
- Grok

It detects user and assistant messages, preserves common Markdown structures such as headings, lists, links, code blocks, tables, and LaTeX, and lets you select individual user messages together with their corresponding responses. Selected content can be copied to the clipboard or downloaded as a Markdown file.

[Install chatgpt-exporter.user.js](https://raw.githubusercontent.com/hermitm0nk/paraphernalia/master/violentmonkey-scripts/chatgpt-exporter.user.js)

#### `middle-click-translate.user.js`

Translates selected text when it is middle-clicked:

- Works on local files and web pages
- Replaces line breaks, tabs, and repeated whitespace with single spaces
- Preserves punctuation
- Automatically detects the source language
- Displays the result in a small popup near the selection
- Uses Google's translation endpoint through `GM_xmlhttpRequest`

[Install middle-click-translate.user.js](https://raw.githubusercontent.com/hermitm0nk/paraphernalia/master/violentmonkey-scripts/middle-click-translate.user.js)

#### `raindrop-to-hypothesis.user.js`

Exports Raindrop.io highlights that are currently rendered on the active page into JSON that can be imported by Hypothesis.

Run **Export Raindrop highlights → Hypothesis JSON** from the Violentmonkey menu while Raindrop's highlights are visible. The userscript:

- Reads Raindrop's current CSS Custom Highlight ranges directly from the live page instead of trying to re-find passages from exported text
- Builds Hypothesis-compatible `TextQuoteSelector` objects with the exact quote plus 32 characters of prefix/suffix context
- Falls back to Raindrop's older `<mark>`-element implementation when necessary
- Attempts to preserve Raindrop notes, color, occurrence position, and highlight IDs when Firefox's extension isolation exposes that metadata
- Keeps Raindrop migration metadata in ignored extra JSON fields for provenance
- Marks generated annotations as private for Hypothesis's interactive importer
- Runs only when explicitly selected from the Violentmonkey menu

To migrate a page:

1. Open the original page and make sure its Raindrop highlights are visible.
2. Run the userscript command from the Violentmonkey menu.
3. Keep the page open, activate Hypothesis, and choose **Share → Import**.
4. Select the downloaded `raindrop-to-hypothesis-*.json` file.

The script uses `@inject-into page` because the CSS Custom Highlight registry belongs to the page realm. On Firefox pages whose Content Security Policy blocks page-context userscript injection, the Violentmonkey command may not be available. Raindrop notes may also be absent from the export when Firefox prevents access to Raindrop's in-memory extension state; the highlight anchors themselves do not depend on that metadata.

[Install raindrop-to-hypothesis.user.js](https://raw.githubusercontent.com/hermitm0nk/paraphernalia/master/violentmonkey-scripts/raindrop-to-hypothesis.user.js)

### tgrm-secretary

A Telegram Secretary Bot backend in stdlib-only Python, answered by the [pi.dev](https://pi.dev/) agent. Attach a Secretary-Mode bot to your Telegram account and it auto-replies in one allowlisted private chat as your friendly assistant, with quiet rules (never answers your own messages, defers to anything you already handled) and a full 3-actor transcript (owner / visitor / secretary) for context.

See [tgrm/tgrm-secretary/README.md](tgrm/tgrm-secretary/README.md) for setup and configuration.

## License

[MIT](LICENSE)
