#!/usr/bin/env python3
"""Build release body from RELEASE_NOTES.md + standard downloads table."""

import os

notes = ""
notes_path = os.path.join(os.path.dirname(__file__), "..", "..", "RELEASE_NOTES.md")
if os.path.exists(notes_path):
    with open(notes_path) as f:
        notes = f.read().rstrip()

downloads = """

---

### Downloads

| Platform | File | Notes |
|----------|------|-------|
| **Windows** | `Sound Explorer Setup *.exe` | Installer with Start Menu shortcut and .wav file association |
| **Windows (portable)** | `Sound Explorer *.exe` | Single executable, no installation required |
| **macOS** | `Sound Explorer-*.dmg` | Drag to Applications |
| **Linux** | `Sound-Explorer-*.AppImage` | Portable — `chmod +x` and run |
| **Linux (Debian/Ubuntu)** | `sound-explorer_*.deb` | Install with `sudo dpkg -i` |

### Web App

The web version is always available at **[mrkva.github.io/sound-explorer](https://mrkva.github.io/sound-explorer/)** — no install needed.
"""

print(notes + downloads)
