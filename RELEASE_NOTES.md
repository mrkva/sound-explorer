## What's New in v0.9.0

This release fixes several problems that could silently produce a wrong, truncated, or unopenable WAV when working with a folder of continuous recordings, and adds wall-clock range selection. Both apps are affected.

### New Features

#### Desktop & Web
- **Wall-clock range selection** — A new **File / Wall** selector next to the From/To fields lets you type a time of day (`23:00:00` → `03:00:00`) instead of a position within the session. Times map onto the timeline and resolve to the correct day for recordings that run past midnight
- **RF64 support for files over 4 GB** — Exports larger than 4 GB are written as RF64 (EBU Tech 3306) with a `ds64` chunk, and RF64 files can be opened again in Sound Explorer
- **Gap reporting** — Loading a folder now reports wall-clock gaps between recordings and overlapping files. Setting a range that spans a gap says how much audio is actually inside it

#### Desktop Only
- **Range entry without a selection** — The From/To fields appear as soon as a folder is loaded, so an exact range can be typed directly instead of dragging a rough selection first
- **Skipped-file reporting** — Any file dropped for a mismatched sample rate, bit depth or channel count is now named in the status bar

### Bug Fixes

#### Desktop & Web
- **Fixed file ordering for sessions recorded across midnight** — BWF stores only a time of day, and files were sorted directly on it, so a session running from afternoon into the next morning was assembled rotated: the next day's early files were placed before the previous day's. Files are now ordered by cutting the time-of-day sequence at its largest discontinuity, which recovers the true recording order. This also removes the phantom gap the old ordering invented at the seam
- **Fixed export timestamps past midnight** — Export filenames and the BWF `OriginationDate` written into exported files now advance to the next day when a selection crosses midnight, instead of using the session's first date throughout
- **Origination date no longer used for file ordering** — Some recorders stamp the bext date and time when a file is closed rather than opened, which is a whole file ahead of the timecode reference and lands on the wrong day for the file spanning midnight. Ordering now relies on the timecode reference only

#### Desktop Only
- **Fixed truncated exports longer than about three hours** — A plain WAV header cannot describe more than 4 GB, and the sizes were being clamped to that ceiling. All the audio was written, but players stopped at the 4 GB mark — at 48 kHz / 32-bit float / stereo that is 3:06:25, regardless of how much was selected. Long exports now use RF64 and report their true length
- **Short reads during export are no longer silent** — If a source file cannot supply its full range, the export reports which file came up short and corrects the header to the real length, instead of quietly writing a shorter file that looks complete
- **Files with large metadata are no longer dropped** — A WAV whose `data` chunk sits beyond the first megabyte of the file parsed as zero samples and vanished from a multi-file session. The data chunk is now located by seeking through the file
- **Files skipped for format mismatch are now visible** — A file whose sample rate, bit depth or channel count differs from the rest of the folder was dropped with only a console warning, silently shortening the timeline

#### Web Only
- **Fixed opening large recordings** — Files that place their iXML chunk after the audio (common on field recorders) made the parser buffer the file from the start to reach it, pulling multi-gigabyte recordings into memory and hanging the tab. Chunks are now read individually, so header size no longer depends on file size
- **Fixed exports taking audio from the wrong file** — A selection spanning more than one recording was exported entirely from the first file. Exports now read each file the range covers and join them
- **Fixed the wall-clock axis across files** — Wall-clock labels were derived from the first file's timestamp plus an offset, so they drifted after the first file boundary. Each position now reads the clock from the file it falls in
- **Export size warning** — Ranges over 4 GB warn that browsers usually cannot assemble a download that large and point to the desktop app
