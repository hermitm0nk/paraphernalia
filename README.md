# paraphernalia

A collection of standalone tools for personal productivity.

## Tools

### [koreader2anki](koreader2anki/README.md)

Sync KOReader vocabulary builder words to Anki with dictionary definitions from an MDX file (e.g. Merriam-Webster's Collegiate). Uses [PEP 723](https://peps.python.org/pep-0723/) inline script metadata — zero-install with `uv`.

```bash
uv run koreader2anki/sync_to_anki.py
```

### [koreader-plugins](koreader-plugins/README.md)

Custom Lua plugins for KOReader on Kindle — a clock dashboard and automatic vocabulary cloud sync.

## Requirements

- [uv](https://docs.astral.sh/uv/getting-started/installation/) — project and package manager
- [AnkiConnect](https://git.sr.ht/~foosoft/anki-connect) add-on for Anki (for koreader2anki)

## License

[MIT](LICENSE)
