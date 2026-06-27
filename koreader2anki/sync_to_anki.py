#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "readmdict",
#   "python-lzo",
#   "python-dotenv",
# ]
# ///
"""
Sync KOReader vocabulary builder words to Anki via AnkiConnect.

Reads words from a KOReader vocabulary_builder.sqlite3 database (either
local or downloaded from a WebDAV server), looks up definitions in a
Webster's MDX dictionary, and adds them as cards to an Anki deck.

Usage:
    # Default — uses webster.mdx and vocabulary_builder.sqlite3 in script dir
    python3 sync_to_anki.py

    # Custom dictionary and database
    python3 sync_to_anki.py --mdx ~/dictionaries/webster.mdx --db ./my_vocab.db

    # Download from WebDAV with explicit auth
    export DAV_URL=https://example.com/data/vocab.sqlite3
    export DAV_AUTH='user:secret'
    uv run sync_to_anki.py

    # Custom AnkiConnect
    uv run sync_to_anki.py --anki-address http://192.168.1.100:8765
"""

import argparse
import base64
import glob
import json
import os
import re
import sqlite3
import html as htmllib
import time
import urllib.request
import urllib.error
from pathlib import Path

# Load .env — real env vars take precedence (override=False is the default)
from dotenv import load_dotenv
load_dotenv()                                   # cwd
load_dotenv(Path(__file__).resolve().parent)    # script dir
load_dotenv(Path(__file__).resolve().parent.parent)  # repo root

from readmdict import MDX

# --- Config ---
DEFAULT_ANKI = "http://localhost:8765"
DEFAULT_DECK = "KOReader"
DEFAULT_DB = "vocabulary_builder.sqlite3"
DEFAULT_DB_URL = "https://example.com/data/vocabulary_builder.sqlite3"
DEFAULT_SECRETS = Path.home() / ".davfs2" / "secrets"
DOWNLOAD_RETRIES = 5
DOWNLOAD_TIMEOUT = 60


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    script_dir = Path(__file__).resolve().parent

    # Default MDX: first *.mdx file in script dir
    default_mdx = None
    mdx_files = sorted(glob.glob(str(script_dir / "*.mdx")))
    if mdx_files:
        default_mdx = mdx_files[0]

    ap = argparse.ArgumentParser(
        description="Sync KOReader vocabulary builder words to Anki",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument(
        "--mdx", "-m",
        default=default_mdx,
        help="Path to MDX dictionary file (default: first *.mdx in script dir)",
    )
    ap.add_argument(
        "--db", "-d",
        default=str(script_dir / DEFAULT_DB),
        help=f"Path to local SQLite DB (default: {script_dir / DEFAULT_DB})",
    )
    ap.add_argument(
        "--db-url",
        default=None,
        help="URL to download SQLite DB from WebDAV (default: $DAV_URL or "
             f"{DEFAULT_DB_URL})",
    )
    ap.add_argument(
        "--anki-address",
        default=os.environ.get("ANKI_ADDRESS", DEFAULT_ANKI),
        help=f"AnkiConnect address (default: $ANKI_ADDRESS or {DEFAULT_ANKI})",
    )
    ap.add_argument(
        "--deck",
        default=DEFAULT_DECK,
        help=f"Anki deck name (default: {DEFAULT_DECK})",
    )
    ap.add_argument(
        "--auth-env",
        default="DAV_AUTH",
        help="Env var containing user:password for HTTP Basic auth "
             "(default: $DAV_AUTH; falls back to ~/.davfs2/secrets)",
    )
    return ap.parse_args()


def resolve_credentials(auth_env: str) -> tuple[str, str] | None:
    """Try to read credentials from env var, then from davfs2 secrets."""
    # 1. Try env var
    val = os.environ.get(auth_env)
    if val and ":" in val:
        user, password = val.split(":", 1)
        if user and password:
            return user, password
    # 2. Fall back to davfs2 secrets
    if DEFAULT_SECRETS.exists():
        for line in DEFAULT_SECRETS.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) >= 3:
                return parts[1], parts[2]
    return None


def download_with_retry(url: str, dst: Path, auth_env: str) -> None:
    """Download a file via HTTP GET with retry and backoff."""
    headers = {
        "Cache-Control": "no-cache",
        "User-Agent": "koreader2anki-sync/1.0",
    }
    creds = resolve_credentials(auth_env)
    if creds:
        user, password = creds
        auth = base64.b64encode(f"{user}:{password}".encode()).decode()
        headers["Authorization"] = f"Basic {auth}"

    last_err = None
    for attempt in range(1, DOWNLOAD_RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT) as resp:
                data = resp.read()
            dst.write_bytes(data)
            print(f"  downloaded {dst.name} on attempt {attempt}")
            return
        except (OSError, IOError, urllib.error.URLError, TimeoutError) as e:
            last_err = e
            print(f"  attempt {attempt}/{DOWNLOAD_RETRIES} failed: {e}")
            if dst.exists():
                try:
                    dst.unlink()
                except OSError:
                    pass
            if attempt < DOWNLOAD_RETRIES:
                wait = 2 ** attempt
                print(f"  retrying in {wait}s...")
                time.sleep(wait)
    raise RuntimeError(
        f"Failed to download {url} after {DOWNLOAD_RETRIES} attempts: {last_err}"
    )


def sync_source_files(db_url: str | None, db_path: str, auth_env: str) -> None:
    """Download the SQLite DB from WebDAV if a URL is configured."""
    url = db_url or os.environ.get("DAV_URL") or DEFAULT_DB_URL
    print(f"Downloading {url} -> {db_path}...")
    download_with_retry(url, Path(db_path), auth_env)


def anki_request(anki_address: str, action: str, **params) -> dict:
    """Send a request to AnkiConnect."""
    payload = json.dumps({"action": action, "version": 6, "params": params}).encode()
    req = urllib.request.Request(
        anki_address, data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read().decode())
    if result.get("error"):
        raise RuntimeError(f"AnkiConnect error: {result['error']}")
    return result["result"]


def load_mdx(path: str) -> dict[str, bytes]:
    """Load MDX dictionary into a word -> content map."""
    reader = MDX(path)
    word_map: dict[str, bytes] = {}
    for key, val in reader.items():
        word = key.decode("utf-8", errors="replace") if isinstance(key, bytes) else key
        word_map[word] = val
    print(f"Loaded {len(word_map)} MDX entries")
    return word_map


def lookup_mdx(word_map: dict[str, bytes], word: str) -> str | None:
    """Case-insensitive lookup in the MDX map. Returns raw HTML content or None."""
    if word in word_map:
        raw = word_map[word]
        return raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
    lower = word.lower()
    for k, v in word_map.items():
        if k.lower() == lower:
            return v.decode("utf-8", errors="replace") if isinstance(v, bytes) else v
    return None


def extract_definition(raw: str) -> str:
    """Extract a clean definition string from an MW MDX entry."""
    raw = htmllib.unescape(raw)

    m = re.search(r'<font\s+size=\+1\s*>\s*<b>([^<]+)</b>', raw)
    headword = m.group(1).strip() if m else ""

    pronunciation = ""
    if m:
        chunk = raw[m.end():]
        m2 = re.search(r'<i>\s*<font[^>]*>\s*<com>', chunk)
        if m2:
            pron = chunk[:m2.start()]
            pron = re.sub(r'<br\s*/?>', ' ', pron)
            pron = re.sub(r'<a\s+href="sound://[^"]*">([^<]*)</a>', r'\1', pron)
            pron = re.sub(r'\b(I|II|III|IV|V|VI)\.\s+', ' ', pron)
            pron = re.sub(r'<[^>]+>', ' ', pron)
            pron = htmllib.unescape(pron)
            mb = re.match(r'^\\\s*(.*?)\s*\\$', pron)
            if mb:
                pron = mb.group(1).strip()
            else:
                pron = re.sub(r'\s*\\$', '', pron)
                pron = re.sub(r'^\\\s*', '', pron)
                pron = pron.replace('\\', '')
            pron = re.sub(r'\s+', ' ', pron).strip()
            if pron and re.search(r"[əɪɛæʊʌɒɑɔʃʒθðŋɹɾʔˈˌ]", pron):
                pronunciation = pron

    m = re.search(r'<com>\s*([^<]+?)\s*</com>', raw, flags=re.IGNORECASE)
    pos = m.group(1).strip() if m else ""
    if pos.lower().startswith(("etymology", "first known", "see ", "date")):
        pos = ""

    segments = re.split(r'<b>\s*:\s*</b>', raw, flags=re.IGNORECASE)
    defs = []
    for seg in segments[1:]:
        seg = re.sub(r'<b>\s*\d+\s*\.\s*</b>', '', seg)
        seg = re.sub(r'^\s*\d+\s*[\. \)]\s*', '', seg)
        m2 = re.search(r'<(?:b|ex|com|i|font|br|hr|table)\b', seg, flags=re.IGNORECASE)
        if m2:
            seg = seg[:m2.start()]
        text = htmllib.unescape(re.sub(r'<[^>]+>', ' ', seg))
        text = re.sub(r'\s+', ' ', text).strip()
        text = re.sub(r'^[·•\.\-—]+\s*', '', text)
        if text and len(text) >= 3 and not text.lower().startswith(
            ("etymology", "date", "first known", "see ", "compare ")
        ):
            defs.append(text)

    has_long = any(len(d.split()) >= 2 for d in defs)
    clean = []
    for d in defs:
        words = d.split()
        if (has_long and len(words) == 1 and len(d) <= 12
                and d[0].islower() and not d.endswith("ing") and clean):
            continue
        clean.append(d)

    seen: set[str] = set()
    uniq = []
    for d in clean:
        if d not in seen:
            seen.add(d)
            uniq.append(d)

    examples = []
    for m in re.finditer(r'<ex[^>]*>(.*?)</ex>', raw, flags=re.IGNORECASE | re.DOTALL):
        text = htmllib.unescape(re.sub(r'<[^>]+>', '', m.group(1)))
        text = re.sub(r'\s+', ' ', text).strip().strip("<>\"' ")
        if text and len(text) > 3:
            examples.append(text)

    parts = []
    if headword:
        parts.append(f"<b>{htmllib.escape(headword)}</b>")
    if pronunciation:
        parts.append(f"<i>/{htmllib.escape(pronunciation)}/</i>")
    if pos:
        parts.append(f"<i>({htmllib.escape(pos)})</i>")
    if uniq:
        parts.append(
            "<ol>" + "".join(f"<li>{htmllib.escape(d)}</li>" for d in uniq) + "</ol>"
        )
    if examples:
        parts.append(
            "<br><i>Examples:</i><ul>"
            + "".join(f"<li>{htmllib.escape(e)}</li>" for e in examples[:3])
            + "</ul>"
        )

    return "<br>".join(parts) if parts else ""


def load_words_from_db(db_path: str) -> list[str]:
    """Load all words from the KOReader vocabulary builder SQLite DB."""
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("SELECT word FROM vocabulary ORDER BY word")
    words = [row[0] for row in cur.fetchall()]
    conn.close()
    return words


def get_existing_notes(anki_address: str, deck_name: str) -> set[str]:
    """Get all existing note front fields (words) in the Anki deck."""
    note_ids = anki_request(anki_address, "findNotes", query=f"deck:{deck_name}")
    if not note_ids:
        return set()
    notes = anki_request(anki_address, "notesInfo", notes=note_ids)
    existing = set()
    for note in notes:
        front = note["fields"].get("Front", {}).get("value", "")
        existing.add(front.strip().lower())
    return existing


def create_deck(anki_address: str, deck_name: str) -> None:
    """Create the Anki deck if it doesn't exist."""
    anki_request(anki_address, "createDeck", deck=deck_name)
    print(f"Deck '{deck_name}' ready")


def add_note(anki_address: str, deck_name: str, word: str, definition: str) -> bool:
    """Add a single note to the Anki deck. Returns True if added."""
    note = {
        "deckName": deck_name,
        "modelName": "Basic",
        "fields": {
            "Front": word,
            "Back": definition,
        },
        "options": {"allowDuplicate": False},
        "tags": ["koreader"],
    }
    try:
        anki_request(anki_address, "addNote", note=note)
        return True
    except RuntimeError as e:
        if "duplicate" in str(e).lower():
            return False
        raise


def main() -> None:
    args = parse_args()

    if not args.mdx:
        print("Error: no MDX dictionary found. Pass --mdx or place a *.mdx file in the script directory.")
        sys.exit(1)

    # Optionally download DB from WebDAV
    if args.db_url or os.environ.get("DAV_URL"):
        print("Syncing source files from WebDAV...")
        sync_source_files(args.db_url, args.db, args.auth_env)

    if not Path(args.db).exists():
        print(f"Error: SQLite DB not found at {args.db}")
        sys.exit(1)

    print("Loading MDX dictionary...")
    word_map = load_mdx(args.mdx)

    print("Loading words from SQLite DB...")
    words = load_words_from_db(args.db)
    print(f"Found {len(words)} words in vocabulary builder")

    print(f"Creating/checking deck '{args.deck}'...")
    create_deck(args.anki_address, args.deck)

    print("Checking existing cards...")
    existing = get_existing_notes(args.anki_address, args.deck)
    print(f"Found {len(existing)} existing cards")

    added = 0
    skipped = 0
    missing_defs = 0

    for word in words:
        if word.lower() in existing:
            skipped += 1
            continue

        raw = lookup_mdx(word_map, word)
        if raw:
            definition = extract_definition(raw)
        else:
            definition = ""
            missing_defs += 1

        if add_note(args.anki_address, args.deck, word, definition):
            added += 1
            print(f"  + {word}" + ("" if definition else " (no definition)"))
        else:
            skipped += 1

    print(f"\nDone: {added} added, {skipped} skipped (already exist), {missing_defs} without definitions")


if __name__ == "__main__":
    import sys
    main()
