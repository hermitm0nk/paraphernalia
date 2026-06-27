# koreader2anki

Sync KOReader vocabulary builder words to Anki with dictionary definitions.

## Prerequisites

- [uv](https://docs.astral.sh/uv/getting-started/installation/) — runs the script and manages dependencies automatically
- [AnkiConnect](https://git.sr.ht/~foosoft/anki-connect) add-on for Anki
- An MDX dictionary file (e.g. Webster's Collegiate)

## Setup

This script uses **PEP 723 inline script metadata**. No installation or virtualenv needed — `uv` reads dependencies right from the script header.

1. [Install uv](https://docs.astral.sh/uv/getting-started/installation/) (one-time)
2. Place a `*.mdx` dictionary file in this directory
3. Run:

```bash
uv run sync_to_anki.py
```

Or make it executable and run directly:

```bash
chmod +x sync_to_anki.py
./sync_to_anki.py
```

`uv` will automatically create an isolated environment, install `readmdict` and `python-lzo`, and run the script.

## Usage

```bash
uv run sync_to_anki.py [options]
```

### Environment (.env)

Create a `.env` file in the script directory or repo root to set defaults.
Real environment variables (`export DAV_URL=...`) always take precedence.

See `.env.example` for available variables.

### Options

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--mdx PATH` | — | first `*.mdx` in script dir | Path to MDX dictionary |
| `--db PATH` | — | `vocabulary_builder.sqlite3` | Local SQLite DB path |
| `--db-url URL` | `DAV_URL` | `https://example.com/data/vocabulary_builder.sqlite3` | WebDAV URL to download DB from |
| `--anki-address URL` | `ANKI_ADDRESS` | `http://localhost:8765` | AnkiConnect address |
| `--deck NAME` | — | `KOReader` | Anki deck name |
| `--auth-env NAME` | `DAV_AUTH` | `DAV_AUTH` | Env var with `user:password` for HTTP auth (falls back to `~/.davfs2/secrets`) |

### Auth

Credentials are resolved in this order:

1. **Env var** — set `DAV_AUTH=user:password` (override name with `--auth-env`)
2. **davfs2 secrets** — read from `~/.davfs2/secrets` (tab-separated: `URL\tuser\tpassword`)

### Examples

```bash
# Minimal — uses webster.mdx and vocabulary_builder.sqlite3 from script dir
uv run sync_to_anki.py

# Custom dictionary and local DB
uv run sync_to_anki.py --mdx ~/dictionaries/mw.mdx --db ./my_vocab.db

# Download from WebDAV with env auth
export DAV_URL=https://example.com/data/vocabulary_builder.sqlite3
export DAV_AUTH='user:secret'
uv run sync_to_anki.py

# Remote AnkiConnect
uv run sync_to_anki.py --anki-address http://192.168.1.50:8765
```

## What it does

1. Downloads the vocabulary builder SQLite DB from WebDAV (if `--db-url` or `DAV_URL` is set)
2. Reads all words from the DB
3. Looks up each word in the MDX dictionary
4. Creates the KOReader deck in Anki (if missing)
5. Adds new cards with **Front:** word, **Back:** formatted definition (pronunciation, part of speech, numbered definitions, examples)
6. Words not found in the dictionary are still added with an empty back
7. Never removes or duplicates existing cards

## License

[MIT](../LICENSE)
