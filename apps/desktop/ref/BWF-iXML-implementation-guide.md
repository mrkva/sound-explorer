# BWF/iXML Field Recording Metadata — Implementation Guide

## What is this?

This document describes how to read and write metadata in BWF (Broadcast Wave Format) `.wav` files for field recording workflows. It covers three standardized metadata layers inside WAV files: the `bext` chunk, the `iXML` chunk, and the ASWG iXML extension. The goal is to embed rich, searchable metadata — location, equipment, conditions, annotations — directly into each audio file so it travels with the recording and no sidecar files are needed.

All metadata described here follows published standards (EBU Tech 3285, iXML spec at ixml.info, Sony ASWG-G006). Tools that read iXML (Pro Tools, Reaper, Nuendo, FCPX, Resolve, Soundminer, BaseHead, BWF MetaEdit) will correctly interpret the standard fields. Custom fields are carried in the `<USER>` and `<NOTE>` blocks which are part of the iXML standard.

## Architecture: three layers inside one WAV file

```
┌─────────────────────────────────────┐
│ WAV file                            │
│ ┌─────────────────────────────────┐ │
│ │ fmt chunk (sample rate, bits,   │ │  ← automatic, written by recorder
│ │           channels)             │ │
│ ├─────────────────────────────────┤ │
│ │ bext chunk                      │ │  ← basic: description, date, time,
│ │  (EBU Broadcast Audio Extension)│ │     timecode, originator
│ ├─────────────────────────────────┤ │
│ │ iXML chunk                      │ │  ← rich: project, location, GPS,
│ │  (XML inside RIFF chunk)        │ │     track names, notes, markers,
│ │  ├─ LOCATION                    │ │     equipment, user data
│ │  ├─ TRACK_LIST                  │ │
│ │  ├─ SYNC_POINT_LIST             │ │
│ │  ├─ USER (free text + XML tags) │ │
│ │  ├─ ASWG (extension)            │ │
│ │  └─ ...                         │ │
│ ├─────────────────────────────────┤ │
│ │ cue + adtl chunks               │ │  ← markers with labels (oldest
│ │  (sample-accurate markers)      │ │     standard, widest support)
│ ├─────────────────────────────────┤ │
│ │ data chunk (audio samples)      │ │  ← the actual audio
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

**What the recorder writes automatically:** `fmt`, `bext` (date, time, timecode, originator), and basic `iXML` (track names, sample rate, bit depth, timecode). Everything else is added after recording.

## Complete iXML structure for field recordings

Below is the full iXML structure with every field relevant to field recording. All fields are optional — use what applies, skip the rest.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<BWFXML>
  <IXML_VERSION>2.10</IXML_VERSION>

  <!-- === SESSION IDENTITY === -->
  <PROJECT>string — project or collection name</PROJECT>
  <SCENE>string — session identifier (e.g. "kobyla-dawn")</SCENE>
  <TAPE>string — sound roll / day identifier (e.g. "20260404")</TAPE>
  <TAKE>string — take number within scene</TAKE>
  <CIRCLED>TRUE/FALSE — mark as selected/highlighted take</CIRCLED>
  <FILE_UID>string — unique file identifier</FILE_UID>

  <!-- === FREE-TEXT NOTE === -->
  <!-- Primary place for description, conditions, species, observations. -->
  <!-- Keep it human-readable. Can be multi-line. -->
  <NOTE>
Dawn chorus, Devínska Kobyla nature reserve.
Weather: clear, light fog in valleys, 6°C, humidity 82%, calm wind.
Noise floor: very quiet, distant highway barely audible.
Species: blackcap, chiffchaff, great tit, European robin, green woodpecker.
Blackcap singing prominently from ~06:00 into recording.
  </NOTE>

  <!-- === LOCATION (standard iXML) === -->
  <LOCATION>
    <LOCATION_NAME>string — human-readable place name</LOCATION_NAME>
    <LOCATION_GPS>latitude, longitude — WGS84 decimal degrees, e.g. "48.1948, 17.0012"</LOCATION_GPS>
    <LOCATION_ALTITUDE>string — meters above sea level</LOCATION_ALTITUDE>
    <LOCATION_TYPE>dictionary value — see iXML location type dictionary</LOCATION_TYPE>
    <LOCATION_TIME>dictionary value — see iXML location time dictionary</LOCATION_TIME>
  </LOCATION>

  <!-- === SPEED / TECHNICAL (standard iXML) === -->
  <!-- Much of this is redundant with fmt/bext (written by recorder). -->
  <!-- Included here for human readability when inspecting iXML. -->
  <SPEED>
    <FILE_SAMPLE_RATE>int — Hz, e.g. 96000</FILE_SAMPLE_RATE>
    <AUDIO_BIT_DEPTH>int — e.g. 24, 32</AUDIO_BIT_DEPTH>
    <DIGITIZER_SAMPLE_RATE>int — true A/D rate if different from file rate</DIGITIZER_SAMPLE_RATE>
    <TIMECODE_RATE>string — e.g. "24/1", "25/1", "30000/1001"</TIMECODE_RATE>
    <TIMECODE_FLAG>NDF or DF</TIMECODE_FLAG>
  </SPEED>

  <!-- === TRACK LIST (standard iXML — widely supported) === -->
  <!-- This is what DAWs use for channel naming. -->
  <TRACK_LIST>
    <TRACK_COUNT>int — number of tracks</TRACK_COUNT>
    <TRACK>
      <CHANNEL_INDEX>int — source input number on recorder (1-indexed)</CHANNEL_INDEX>
      <INTERLEAVE_INDEX>int — position in interleaved file (1-indexed)</INTERLEAVE_INDEX>
      <n>string — human-readable channel name, e.g. "Uši Left"</n>
      <FUNCTION>string — from function dictionary: LEFT, RIGHT, CENTER, MONO, etc.</FUNCTION>
    </TRACK>
    <!-- repeat TRACK for each channel -->
  </TRACK_LIST>

  <!-- === FILE SET (standard iXML) === -->
  <!-- Links files recorded simultaneously (e.g. poly split to mono). -->
  <FILE_SET>
    <TOTAL_FILES>int — how many files in this recording group</TOTAL_FILES>
    <FAMILY_UID>string — shared ID across all files in the group</FAMILY_UID>
    <FAMILY_NAME>string — human name for the group</FAMILY_NAME>
    <FILE_SET_INDEX>string — this file's position in the group</FILE_SET_INDEX>
  </FILE_SET>

  <!-- === HISTORY (standard iXML) === -->
  <HISTORY>
    <ORIGINAL_FILENAME>string — name when first created</ORIGINAL_FILENAME>
    <PARENT_FILENAME>string — if derived from another file</PARENT_FILENAME>
    <PARENT_UID>string — FILE_UID of parent</PARENT_UID>
  </HISTORY>

  <!-- === SYNC POINTS / ANNOTATIONS (standard iXML) === -->
  <!-- Sample-accurate markers with optional duration (= regions). -->
  <!-- Use for highlighting moments, marking disturbances, species, etc. -->
  <SYNC_POINT_LIST>
    <SYNC_POINT_COUNT>int</SYNC_POINT_COUNT>
    <SYNC_POINT>
      <SYNC_POINT_TYPE>RELATIVE or ABSOLUTE</SYNC_POINT_TYPE>
      <!-- RELATIVE = sample count from file start -->
      <!-- ABSOLUTE = sample count since midnight -->
      <SYNC_POINT_FUNCTION>string — from sync point function dictionary, or CUSTOM</SYNC_POINT_FUNCTION>
      <SYNC_POINT_COMMENT>string — free text, e.g. "Blackcap singing [highlight, species]"</SYNC_POINT_COMMENT>
      <SYNC_POINT_LOW>int — sample offset (32-bit low word)</SYNC_POINT_LOW>
      <SYNC_POINT_HIGH>int — sample offset (32-bit high word, usually 0)</SYNC_POINT_HIGH>
      <SYNC_POINT_EVENT_DURATION>int — duration in samples (0 = point marker)</SYNC_POINT_EVENT_DURATION>
    </SYNC_POINT>
    <!-- repeat SYNC_POINT for each annotation -->
  </SYNC_POINT_LIST>

  <!-- === USER (standard iXML — free text + optional XML sub-tags) === -->
  <!-- This is the flexible catch-all for everything without a dedicated field. -->
  <!-- iXML v2.0 allows both plain text AND XML tags inside USER. -->
  <!-- Keep the plain text part human-readable (key: value format). -->
  <USER>
    Recordist: Jonas Gruska
    Contact: jonas@lom.audio
    License: CC BY-SA 4.0
    Recorder: Sound Devices MixPre-3 II (fw v9.00)
    Microphones: LOM Uši (USI-0247, USI-0248), omni electret, plug-in power
    Setup: AB pair, 35cm spacing, 1.5m on Manfrotto 5001B, Prikulis windscreens
    Gain: 40dB (ch1), 40dB (ch2)
    Limiter: off
    Highpass: off
    TC source: Deity TC-1
    Environment: deciduous forest edge, south-facing slope
    Tags: dawn-chorus, forest, spring, nature-reserve

    <!-- iXML v2.0 machine-readable sub-tags (optional, for tools that parse them) -->
    <SOUND_MIXER_NAME>Jonas Gruska</SOUND_MIXER_NAME>
    <SOUND_MIXER_EMAIL>jonas@lom.audio</SOUND_MIXER_EMAIL>
    <AUDIO_RECORDER_MODEL>Sound Devices MixPre-3 II</AUDIO_RECORDER_MODEL>
    <AUDIO_RECORDER_SERIAL_NUMBER>SN12345</AUDIO_RECORDER_SERIAL_NUMBER>
    <AUDIO_RECORDER_FIRMWARE>v9.00</AUDIO_RECORDER_FIRMWARE>
  </USER>

  <!-- === ASWG EXTENSION (Sony ASWG-G006 — optional) === -->
  <!-- Useful fields for sound library / searchability purposes. -->
  <!-- Supported by Soundminer, BaseHead, and growing ecosystem. -->
  <ASWG>
    <ASWG_TEXT_DESCRIPTION>string — detailed description of content</ASWG_TEXT_DESCRIPTION>
    <ASWG_TEXT_KEYWORDS>string — comma-separated keywords</ASWG_TEXT_KEYWORDS>
    <ASWG_TEXT_CATEGORY>string — e.g. "Ambience", "SFX", "Foley"</ASWG_TEXT_CATEGORY>
    <ASWG_TEXT_SUBCATEGORY>string — e.g. "Nature", "Urban", "Industrial"</ASWG_TEXT_SUBCATEGORY>
    <ASWG_TEXT_LOCATION>string — environment description</ASWG_TEXT_LOCATION>
    <ASWG_TEXT_STATE>string — region/state</ASWG_TEXT_STATE>
    <ASWG_TEXT_COUNTRY>string — country</ASWG_TEXT_COUNTRY>
    <ASWG_TEXT_MICROPHONE>string — microphone(s) used</ASWG_TEXT_MICROPHONE>
    <ASWG_TEXT_RECORDIST>string — person who recorded</ASWG_TEXT_RECORDIST>
    <ASWG_TEXT_ARTIST>string — artist/creator</ASWG_TEXT_ARTIST>
    <ASWG_TEXT_LIBRARY>string — library or collection name</ASWG_TEXT_LIBRARY>
    <ASWG_PROJECT_USAGE_RIGHTS>string — license, e.g. "CC BY-SA 4.0"</ASWG_PROJECT_USAGE_RIGHTS>
  </ASWG>
</BWFXML>
```

## USER field conventions

The `<USER>` field is the most important for field recording metadata that has no dedicated iXML tag. It supports both plain text and XML sub-tags simultaneously. Follow these conventions:

### Plain text section (human-readable, key: value pairs)

```
Recordist: Jonas Gruska
Contact: jonas@lom.audio
License: CC BY-SA 4.0
Recorder: Sound Devices MixPre-3 II (fw v9.00)
Microphones: LOM Uši (USI-0247, USI-0248), omni electret, plug-in power
Setup: AB pair, 35cm spacing, 1.5m on stand, Prikulis windscreens
Gain: 40dB (ch1), 40dB (ch2)
Limiter: off
Highpass: off
TC source: Deity TC-1
Environment: deciduous forest edge, south-facing slope
Tags: dawn-chorus, forest, spring
```

Rules:
- One key-value pair per line
- Key and value separated by `: ` (colon space)
- Tags are comma-separated lowercase hyphenated words
- Microphone serials in parentheses after model name
- Gain values listed per channel in parentheses

### XML sub-tags section (machine-readable, iXML v2.0)

These go after the plain text in the same `<USER>` block:
```xml
<SOUND_MIXER_NAME>Jonas Gruska</SOUND_MIXER_NAME>
<SOUND_MIXER_EMAIL>jonas@lom.audio</SOUND_MIXER_EMAIL>
<AUDIO_RECORDER_MODEL>Sound Devices MixPre-3 II</AUDIO_RECORDER_MODEL>
<AUDIO_RECORDER_SERIAL_NUMBER>SN12345</AUDIO_RECORDER_SERIAL_NUMBER>
<AUDIO_RECORDER_FIRMWARE>v9.00</AUDIO_RECORDER_FIRMWARE>
```

The plain text and XML sub-tags will have duplicate information. This is intentional — the plain text is for humans opening the file in any iXML viewer; the XML tags are for tools that specifically parse iXML v2.0 USER sub-tags.

## NOTE field conventions

The `<NOTE>` field holds the recording description and conditions. Structure it as:

```
Line 1: One-sentence description of what was recorded and where.
Line 2: Weather, temperature, humidity, wind.
Line 3: Noise floor / ambient environment.
Remaining lines: Observations, species heard, events during recording, plans.
```

Example:
```
Dawn chorus at Devínska Kobyla nature reserve, south-facing forest edge.
Weather: clear, light fog in valleys, 6°C, humidity 82%, calm wind.
Noise floor: very quiet, distant highway barely audible.
Species: blackcap (confirmed), chiffchaff (confirmed), great tit, European robin (probable), green woodpecker.
Blackcap prominent from ~6min into recording. Brief aircraft at ~70min.
Follow-up visit planned mid-April.
```

## Annotation conventions

Annotations are stored as SYNC_POINTs with sample-accurate positions. Encode tags in square brackets at the end of the comment:

```
Blackcap singing prominently, very close [highlight, species]
Aircraft flyover, low altitude [disturbance]
Beautiful layered polyphony — blackcap, chiffchaff, robin [highlight]
Pumpjack startup sequence [highlight, mechanical]
```

### Converting time to samples

To create a SYNC_POINT from a human-readable time offset:

```
sample_offset = time_in_seconds × sample_rate
duration_samples = duration_in_seconds × sample_rate
```

For a marker at 6 minutes into a 96kHz file:
```
SYNC_POINT_LOW = 360 × 96000 = 34560000
```

For a 1:45 region starting at 6:00 in a 96kHz file:
```
SYNC_POINT_LOW = 360 × 96000 = 34560000
SYNC_POINT_EVENT_DURATION = 105 × 96000 = 10080000
```

Always use `SYNC_POINT_TYPE=RELATIVE` for file-relative offsets. Use `ABSOLUTE` only when referencing time-of-day in samples since midnight.

## How to read metadata from a WAV file

### Python (using wavinfo)

```python
# pip install wavinfo
from wavinfo import WavInfoReader

info = WavInfoReader("recording.wav")

# bext chunk (date, time, timecode, description)
if info.bext:
    print(f"Date: {info.bext.origination_date}")
    print(f"Time: {info.bext.origination_time}")
    print(f"Description: {info.bext.description}")

# iXML chunk
if info.ixml:
    print(f"Project: {info.ixml.project}")
    print(f"Scene: {info.ixml.scene}")
    print(f"Take: {info.ixml.take}")
    print(f"Note: {info.ixml.note}")
    print(f"Family UID: {info.ixml.family_uid}")

# For full iXML access including LOCATION, USER, SYNC_POINT_LIST,
# parse the raw XML:
import xml.etree.ElementTree as ET

with open("recording.wav", "rb") as f:
    data = f.read()

# Find iXML chunk in the WAV file
ixml_tag = b"iXML"
idx = data.find(ixml_tag)
if idx >= 0:
    # Read chunk size (4 bytes little-endian after the tag)
    import struct
    chunk_size = struct.unpack_from("<I", data, idx + 4)[0]
    xml_bytes = data[idx + 8 : idx + 8 + chunk_size]
    xml_str = xml_bytes.decode("utf-8").rstrip("\x00")
    root = ET.fromstring(xml_str)

    # Read standard fields
    project = root.findtext("PROJECT", "")
    note = root.findtext("NOTE", "")

    # Read LOCATION
    loc = root.find("LOCATION")
    if loc is not None:
        loc_name = loc.findtext("LOCATION_NAME", "")
        loc_gps = loc.findtext("LOCATION_GPS", "")
        loc_alt = loc.findtext("LOCATION_ALTITUDE", "")

    # Read TRACK_LIST
    track_list = root.find("TRACK_LIST")
    if track_list is not None:
        for track in track_list.findall("TRACK"):
            ch_idx = track.findtext("CHANNEL_INDEX", "")
            name = track.findtext("n", "")
            function = track.findtext("FUNCTION", "")
            print(f"  Ch{ch_idx}: {name} ({function})")

    # Read SYNC_POINT_LIST (annotations)
    spl = root.find("SYNC_POINT_LIST")
    if spl is not None:
        for sp in spl.findall("SYNC_POINT"):
            offset = int(sp.findtext("SYNC_POINT_LOW", "0"))
            duration = int(sp.findtext("SYNC_POINT_EVENT_DURATION", "0"))
            comment = sp.findtext("SYNC_POINT_COMMENT", "")
            sample_rate = int(root.findtext(".//SPEED/FILE_SAMPLE_RATE", "48000"))
            time_s = offset / sample_rate
            print(f"  @{time_s:.1f}s: {comment}")

    # Read USER (parse key-value pairs from plain text portion)
    user_text = root.findtext("USER", "")
    user_data = {}
    for line in user_text.strip().split("\n"):
        line = line.strip()
        if ": " in line and not line.startswith("<"):
            key, _, value = line.partition(": ")
            user_data[key.strip()] = value.strip()
    # user_data is now {"Recordist": "Jonas Gruska", "Tags": "dawn-chorus, forest", ...}

    # Read USER XML sub-tags
    user_el = root.find("USER")
    if user_el is not None:
        recorder_model = user_el.findtext("AUDIO_RECORDER_MODEL", "")
        mixer_name = user_el.findtext("SOUND_MIXER_NAME", "")
```

### Reading cue + adtl markers

```python
# cue/adtl markers are binary chunks — use a library:
# pip install pysoundfile  (or parse manually)

# Manual approach to find cue points:
cue_tag = b"cue "
cue_idx = data.find(cue_tag)
if cue_idx >= 0:
    chunk_size = struct.unpack_from("<I", data, cue_idx + 4)[0]
    num_cues = struct.unpack_from("<I", data, cue_idx + 8)[0]
    # Each cue point is 24 bytes: id, position, chunk, chunk_start, block_start, sample_offset
    for i in range(num_cues):
        base = cue_idx + 12 + (i * 24)
        cue_id = struct.unpack_from("<I", data, base)[0]
        sample_offset = struct.unpack_from("<I", data, base + 20)[0]
        print(f"  Cue {cue_id} at sample {sample_offset}")

# Labels are in the adtl LIST chunk — parse labl sub-chunks for text
```

## How to write/embed metadata into a WAV file

### Using BWF MetaEdit (CLI, free, cross-platform)

BWF MetaEdit can write bext and INFO fields. For iXML, it has limited support — it's best for bext description and originator fields.

```bash
# Write bext description
bwfmetaedit --Description="Dawn chorus, Devínska Kobyla" recording.wav

# Write bext originator
bwfmetaedit --Originator="LOM" recording.wav
```

### Python: writing full iXML

The most flexible approach is to construct the iXML XML and inject it into the WAV file's RIFF structure. Here is a pattern:

```python
import struct
import xml.etree.ElementTree as ET
from xml.dom import minidom


def build_ixml(metadata: dict) -> bytes:
    """Build an iXML XML string from a metadata dictionary.

    Expected metadata keys (all optional):
        project, scene, tape, take, note, circled,
        location_name, location_gps, location_altitude,
        sample_rate, bit_depth,
        tracks: list of {channel_index, interleave_index, name, function},
        annotations: list of {offset_seconds, duration_seconds, comment},
        user_text: str (key: value block),
        user_tags: dict of XML sub-tag name → value,
        aswg: dict of ASWG tag name → value
    """
    root = ET.Element("BWFXML")
    ET.SubElement(root, "IXML_VERSION").text = "2.10"

    # Simple fields
    for tag, key in [
        ("PROJECT", "project"), ("SCENE", "scene"), ("TAPE", "tape"),
        ("TAKE", "take"), ("NOTE", "note"), ("FILE_UID", "file_uid"),
    ]:
        if key in metadata and metadata[key]:
            ET.SubElement(root, tag).text = str(metadata[key])

    if metadata.get("circled"):
        ET.SubElement(root, "CIRCLED").text = "TRUE"

    # LOCATION
    if any(k in metadata for k in ["location_name", "location_gps", "location_altitude"]):
        loc = ET.SubElement(root, "LOCATION")
        if metadata.get("location_name"):
            ET.SubElement(loc, "LOCATION_NAME").text = metadata["location_name"]
        if metadata.get("location_gps"):
            ET.SubElement(loc, "LOCATION_GPS").text = metadata["location_gps"]
        if metadata.get("location_altitude"):
            ET.SubElement(loc, "LOCATION_ALTITUDE").text = str(metadata["location_altitude"])

    # SPEED
    sr = metadata.get("sample_rate")
    bd = metadata.get("bit_depth")
    if sr or bd:
        speed = ET.SubElement(root, "SPEED")
        if sr:
            ET.SubElement(speed, "FILE_SAMPLE_RATE").text = str(sr)
        if bd:
            ET.SubElement(speed, "AUDIO_BIT_DEPTH").text = str(bd)

    # TRACK_LIST
    tracks = metadata.get("tracks", [])
    if tracks:
        tl = ET.SubElement(root, "TRACK_LIST")
        ET.SubElement(tl, "TRACK_COUNT").text = str(len(tracks))
        for t in tracks:
            track = ET.SubElement(tl, "TRACK")
            ET.SubElement(track, "CHANNEL_INDEX").text = str(t["channel_index"])
            ET.SubElement(track, "INTERLEAVE_INDEX").text = str(t["interleave_index"])
            name_el = ET.SubElement(track, "n")  # note: lowercase tag per iXML spec
            name_el.text = t["name"]
            if t.get("function"):
                ET.SubElement(track, "FUNCTION").text = t["function"]

    # SYNC_POINT_LIST (annotations)
    annotations = metadata.get("annotations", [])
    sample_rate = metadata.get("sample_rate", 48000)
    if annotations:
        spl = ET.SubElement(root, "SYNC_POINT_LIST")
        ET.SubElement(spl, "SYNC_POINT_COUNT").text = str(len(annotations))
        for a in annotations:
            sp = ET.SubElement(spl, "SYNC_POINT")
            ET.SubElement(sp, "SYNC_POINT_TYPE").text = "RELATIVE"
            ET.SubElement(sp, "SYNC_POINT_FUNCTION").text = "CUSTOM"
            ET.SubElement(sp, "SYNC_POINT_COMMENT").text = a["comment"]
            sample_offset = int(a["offset_seconds"] * sample_rate)
            ET.SubElement(sp, "SYNC_POINT_LOW").text = str(sample_offset)
            ET.SubElement(sp, "SYNC_POINT_HIGH").text = "0"
            dur = int(a.get("duration_seconds", 0) * sample_rate)
            ET.SubElement(sp, "SYNC_POINT_EVENT_DURATION").text = str(dur)

    # USER
    user_text = metadata.get("user_text", "")
    user_tags = metadata.get("user_tags", {})
    if user_text or user_tags:
        user = ET.SubElement(root, "USER")
        # Build combined text: plain text + XML tags
        # We need to set text manually since USER mixes text and child elements
        user.text = user_text + "\n" if user_text else ""
        for tag_name, tag_value in user_tags.items():
            ET.SubElement(user, tag_name).text = str(tag_value)

    # ASWG
    aswg = metadata.get("aswg", {})
    if aswg:
        aswg_el = ET.SubElement(root, "ASWG")
        for tag_name, tag_value in aswg.items():
            ET.SubElement(aswg_el, tag_name).text = str(tag_value)

    xml_str = ET.tostring(root, encoding="unicode", xml_declaration=False)
    xml_str = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml_str
    return xml_str.encode("utf-8")


def inject_ixml_chunk(wav_path: str, ixml_bytes: bytes, output_path: str):
    """Inject or replace the iXML chunk in a WAV file.

    Reads the input WAV, removes any existing iXML chunk,
    inserts the new iXML chunk, and writes to output_path.
    output_path can be the same as wav_path for in-place update.
    """
    with open(wav_path, "rb") as f:
        data = bytearray(f.read())

    # Verify RIFF/WAVE header
    assert data[:4] == b"RIFF", "Not a RIFF file"
    assert data[8:12] == b"WAVE", "Not a WAVE file"

    # Remove existing iXML chunk if present
    pos = 12
    new_data = bytearray(data[:12])
    while pos < len(data):
        if pos + 8 > len(data):
            break
        chunk_id = bytes(data[pos:pos+4])
        chunk_size = struct.unpack_from("<I", data, pos + 4)[0]
        total_chunk = 8 + chunk_size
        if chunk_size % 2 == 1:
            total_chunk += 1  # RIFF pad byte
        if chunk_id == b"iXML":
            # Skip this chunk (we'll add our own)
            pos += total_chunk
            continue
        new_data.extend(data[pos:pos + total_chunk])
        pos += total_chunk

    # Append new iXML chunk
    ixml_padded = ixml_bytes
    if len(ixml_bytes) % 2 == 1:
        ixml_padded += b"\x00"  # RIFF pad byte
    new_data.extend(b"iXML")
    new_data.extend(struct.pack("<I", len(ixml_bytes)))
    new_data.extend(ixml_padded)

    # Update RIFF size
    struct.pack_into("<I", new_data, 4, len(new_data) - 8)

    with open(output_path, "wb") as f:
        f.write(new_data)


# --- Usage example ---

metadata = {
    "project": "Spring Migration 2026",
    "scene": "kobyla-dawn",
    "tape": "20260404",
    "take": "1",
    "circled": True,
    "note": (
        "Dawn chorus at Devínska Kobyla nature reserve, south-facing forest edge.\n"
        "Weather: clear, light fog in valleys, 6°C, humidity 82%, calm wind.\n"
        "Noise floor: very quiet, distant highway barely audible.\n"
        "Species: blackcap (confirmed), chiffchaff (confirmed), European robin (probable)."
    ),
    "location_name": "Devínska Kobyla, nature reserve, Bratislava, Slovakia",
    "location_gps": "48.1948, 17.0012",
    "location_altitude": "415",
    "sample_rate": 96000,
    "bit_depth": 32,
    "tracks": [
        {"channel_index": 1, "interleave_index": 1, "name": "Uši Left", "function": "LEFT"},
        {"channel_index": 2, "interleave_index": 2, "name": "Uši Right", "function": "RIGHT"},
    ],
    "annotations": [
        {"offset_seconds": 360, "duration_seconds": 105, "comment": "Blackcap singing, very close [highlight, species]"},
        {"offset_seconds": 4200, "duration_seconds": 90, "comment": "Aircraft flyover [disturbance]"},
    ],
    "user_text": (
        "Recordist: Jonas Gruska\n"
        "Contact: jonas@lom.audio\n"
        "License: CC BY-SA 4.0\n"
        "Recorder: Sound Devices MixPre-3 II (fw v9.00)\n"
        "Microphones: LOM Uši (USI-0247, USI-0248), omni electret, plug-in power\n"
        "Setup: AB pair, 35cm spacing, 1.5m on Manfrotto 5001B, Prikulis windscreens\n"
        "Gain: 40dB (ch1), 40dB (ch2)\n"
        "Limiter: off\n"
        "Highpass: off\n"
        "TC source: Deity TC-1\n"
        "Environment: deciduous forest edge, south-facing slope\n"
        "Tags: dawn-chorus, forest, spring, nature-reserve"
    ),
    "user_tags": {
        "SOUND_MIXER_NAME": "Jonas Gruska",
        "SOUND_MIXER_EMAIL": "jonas@lom.audio",
        "AUDIO_RECORDER_MODEL": "Sound Devices MixPre-3 II",
        "AUDIO_RECORDER_FIRMWARE": "v9.00",
    },
    "aswg": {
        "ASWG_TEXT_DESCRIPTION": "Dawn chorus ambience, deciduous forest, spring",
        "ASWG_TEXT_KEYWORDS": "dawn-chorus, forest, spring, blackcap, nature-reserve",
        "ASWG_TEXT_CATEGORY": "Ambience",
        "ASWG_TEXT_SUBCATEGORY": "Nature",
        "ASWG_TEXT_LOCATION": "Deciduous forest edge, south-facing slope",
        "ASWG_TEXT_COUNTRY": "Slovakia",
        "ASWG_TEXT_MICROPHONE": "LOM Uši, AB omni pair",
        "ASWG_TEXT_RECORDIST": "Jonas Gruska",
        "ASWG_PROJECT_USAGE_RIGHTS": "CC BY-SA 4.0",
    },
}

ixml_bytes = build_ixml(metadata)
inject_ixml_chunk("240404_kobyla_dawn_01.wav", ixml_bytes, "240404_kobyla_dawn_01.wav")
```

## How to build an indexing/search tool

Scan a directory tree, parse each WAV's iXML, build a searchable index:

```python
import os
import json

def index_recordings(root_dir: str) -> list[dict]:
    """Walk a directory tree, extract metadata from every WAV file."""
    index = []
    for dirpath, _, filenames in os.walk(root_dir):
        for fname in filenames:
            if not fname.lower().endswith(".wav"):
                continue
            filepath = os.path.join(dirpath, fname)
            meta = extract_ixml_metadata(filepath)  # use the reading code above
            meta["_filepath"] = filepath
            meta["_filename"] = fname
            index.append(meta)
    return index

# Example queries against the index:
# - By date:       [r for r in index if r.get("date", "").startswith("2026-04")]
# - By location:   [r for r in index if "Kobyla" in r.get("location_name", "")]
# - By equipment:  [r for r in index if "Uši" in r.get("user_text", "")]
# - By tag:        [r for r in index if "dawn-chorus" in r.get("tags", "")]
# - By GPS radius: haversine distance from query point to location_gps
# - Full text:     search across note, user_text, annotation comments
```

## Exporting annotated segments

```python
import subprocess

def export_annotation(wav_path: str, offset_s: float, duration_s: float, output_path: str):
    """Extract a segment from a WAV file using ffmpeg."""
    subprocess.run([
        "ffmpeg", "-y",
        "-i", wav_path,
        "-ss", str(offset_s),
        "-t", str(duration_s),
        "-c", "copy",  # lossless for WAV
        output_path,
    ], check=True)

# Export all annotations tagged [highlight] from a file:
for annotation in annotations:
    if "[highlight" in annotation["comment"]:
        export_annotation(
            wav_path,
            annotation["offset_seconds"],
            annotation["duration_seconds"],
            f"export_{annotation['offset_seconds']:.0f}s.wav",
        )
```

## Quick reference: field priority

When building tools, read metadata in this priority order (most reliable first):

1. **`fmt` chunk** — sample rate, bit depth, channels (always present, always correct)
2. **`bext` chunk** — date, time, timecode, description (written by recorder, trustworthy)
3. **`iXML` core fields** — PROJECT, SCENE, TAKE, NOTE, TRACK_LIST, LOCATION (widely supported)
4. **`iXML` USER plain text** — key: value pairs for equipment, conditions, tags (custom convention)
5. **`iXML` USER XML sub-tags** — SOUND_MIXER_NAME, AUDIO_RECORDER_MODEL etc. (iXML v2.0)
6. **`iXML` SYNC_POINT_LIST** — annotations with sample-accurate positions (standard)
7. **`cue` + `adtl` chunks** — markers (oldest standard, supported by most audio editors)
8. **ASWG extension** — category, keywords, microphone, recordist (growing adoption)

If the same information appears in multiple places (e.g. date in bext and iXML BEXT), prefer the `bext` chunk as authoritative for EBU-specified fields, and the iXML body for everything else.

## Standards references

- **EBU Tech 3285** — BWF specification (bext chunk): https://tech.ebu.ch/docs/tech/tech3285.pdf
- **iXML specification** — http://www.gallery.co.uk/ixml/
- **iXML field details** — http://www.gallery.co.uk/ixml/object_Details.html
- **Sony ASWG-G006** — iXML extension: https://github.com/Sony-ASWG/iXML-Extension
- **WAVRef Book** — comprehensive WAV chunk reference: https://wavref.til.cafe/chunk/ixml/
- **BWF MetaEdit** — free open source tool: https://mediaarea.net/BWFMetaEdit
- **wavinfo** (Python) — https://wavinfo.readthedocs.io/
- **FADGI guidelines** — https://www.digitizationguidelines.gov/guidelines/digitize-embedding.html
