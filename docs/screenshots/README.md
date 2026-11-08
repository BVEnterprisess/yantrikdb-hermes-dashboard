# Synthetic screenshot gallery

The legacy screenshot PNGs showed product-specific, Hermes-oriented copy and have been removed as part of the standalone dashboard refactor. Regenerate screenshots from the current generic UI with the synthetic HTTP-only fixture server:

```bash
python -m pip install -r requirements-dev.txt
python scripts/generate_mock_screenshots.py
```

The script requires Chrome/Chromium and `websocket-client` (provided by `requirements-dev.txt`). Set `CHROME_BIN` if the browser executable is not on `PATH`. It does not start YantrikDB, access a database, or read private records.
