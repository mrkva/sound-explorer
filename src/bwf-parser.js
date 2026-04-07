/**
 * BWF/WAV Parser - Extracts timecode and metadata from Broadcast Wave Format files.
 *
 * Supports:
 * - Standard WAV fmt/data chunks
 * - BWF bext chunk (origination time, date, timecode reference)
 * - iXML chunk (timecode from XML metadata)
 */

export class BWFParser {
  /**
   * Parse WAV/BWF file header from an ArrayBuffer.
   * Returns metadata including timecode info.
   */
  static parse(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const result = {
      format: null,
      sampleRate: 0,
      channels: 0,
      bitsPerSample: 0,
      dataOffset: 0,
      dataSize: 0,
      duration: 0,
      bext: null,
      ixml: null,
      originationTime: null,   // HH:MM:SS from bext
      originationDate: null,   // YYYY-MM-DD from bext
      timecodeReference: 0,    // Sample count from midnight
      startTimeOfDay: null     // Computed start time as seconds from midnight
    };

    // Verify RIFF header
    const riffTag = this.readString(view, 0, 4);
    if (riffTag !== 'RIFF') {
      throw new Error('Not a valid WAV file (missing RIFF header)');
    }

    const waveTag = this.readString(view, 8, 4);
    if (waveTag !== 'WAVE') {
      throw new Error('Not a valid WAV file (missing WAVE tag)');
    }

    // Parse chunks
    let offset = 12;
    // Don't trust RIFF size field — it may be wrong for large files or use
    // 0xFFFFFFFF sentinel. Scan the entire header buffer instead.
    const bufSize = arrayBuffer.byteLength;

    while (offset + 8 <= bufSize) {
      const chunkId = this.readString(view, offset, 4);
      const chunkSize = view.getUint32(offset + 4, true);
      const chunkDataOffset = offset + 8;

      // Validate chunk: ID should be printable ASCII, size should be reasonable
      const isValidChunk = /^[\x20-\x7E]{4}$/.test(chunkId) && chunkSize < 0xFFFFFFF0;
      if (!isValidChunk) break; // Corrupt chunk header, stop scanning

      switch (chunkId) {
        case 'fmt ':
          this.parseFmtChunk(view, chunkDataOffset, chunkSize, result);
          break;
        case 'data':
          result.dataOffset = chunkDataOffset;
          result.dataSize = chunkSize;
          break;
        case 'bext':
          this.parseBextChunk(view, chunkDataOffset, chunkSize, result);
          break;
        case 'iXML':
        case 'IXML':
          this.parseIXMLChunk(view, chunkDataOffset, chunkSize, result);
          break;
      }

      // Move to next chunk (chunks are word-aligned)
      // For the data chunk, skip past it using the declared size
      // (which may be much larger than our buffer — that's OK, loop will end)
      offset = chunkDataOffset + chunkSize;
      if (offset % 2 !== 0) offset++;
    }

    // Compute duration
    if (result.sampleRate > 0 && result.channels > 0 && result.bitsPerSample > 0) {
      const bytesPerSample = result.channels * (result.bitsPerSample / 8);
      const totalSamples = result.dataSize / bytesPerSample;
      result.duration = totalSamples / result.sampleRate;
    }

    // Compute start time of day from bext data
    if (result.bext) {
      if (result.timecodeReference > 0 && result.sampleRate > 0) {
        result.startTimeOfDay = result.timecodeReference / result.sampleRate;
      } else if (result.originationTime) {
        const parts = result.originationTime.split(':');
        if (parts.length >= 2) {
          const h = parseInt(parts[0], 10) || 0;
          const m = parseInt(parts[1], 10) || 0;
          const s = parseInt(parts[2], 10) || 0;
          result.startTimeOfDay = h * 3600 + m * 60 + s;
        }
      }
    }

    return result;
  }

  static parseFmtChunk(view, offset, size, result) {
    result.format = view.getUint16(offset, true);       // 1 = PCM, 3 = IEEE float
    result.channels = view.getUint16(offset + 2, true);
    result.sampleRate = view.getUint32(offset + 4, true);
    result.bitsPerSample = view.getUint16(offset + 14, true);

    // WAVE_FORMAT_EXTENSIBLE: real format is in SubFormat GUID
    // IMPORTANT: Do NOT override bitsPerSample with wValidBitsPerSample!
    // bitsPerSample must remain the container size (e.g., 32) for correct
    // blockAlign calculation. wValidBitsPerSample (e.g., 24) only tells us
    // how many bits are meaningful, but each sample still occupies the
    // container size in the file. Overriding causes byte misalignment and
    // spectral artifacts (e.g., a bright line at sampleRate/3).
    if (result.format === 0xFFFE && size >= 40) {
      result.validBitsPerSample = view.getUint16(offset + 18, true);
      result.format = view.getUint16(offset + 24, true);        // SubFormat (1=PCM, 3=float)
    }
  }

  static parseBextChunk(view, offset, size, result) {
    const bext = {};

    // Description: 256 bytes ASCII
    bext.description = this.readString(view, offset, 256).trim();
    // Originator: 32 bytes
    bext.originator = this.readString(view, offset + 256, 32).trim();
    // OriginatorReference: 32 bytes
    bext.originatorReference = this.readString(view, offset + 288, 32).trim();
    // OriginationDate: 10 bytes (YYYY-MM-DD)
    bext.originationDate = this.readString(view, offset + 320, 10).trim();
    // OriginationTime: 8 bytes (HH:MM:SS)
    bext.originationTime = this.readString(view, offset + 330, 8).trim();
    // TimeReference: 8 bytes (uint64, sample count since midnight)
    // Read as two 32-bit values since JS doesn't have native uint64
    const timeLow = view.getUint32(offset + 338, true);
    const timeHigh = view.getUint32(offset + 342, true);
    bext.timeReference = timeHigh * 0x100000000 + timeLow;

    result.bext = bext;
    result.originationTime = bext.originationTime;
    result.originationDate = bext.originationDate;
    result.timecodeReference = bext.timeReference;
  }

  static parseIXMLChunk(view, offset, size, result) {
    // Read up to 256KB for iXML (can be large with many annotations)
    const xmlString = this.readString(view, offset, Math.min(size, 262144)).trim();
    result.ixml = xmlString;

    // Try to extract timecode from iXML
    const tcMatch = xmlString.match(/<TAPE_TIMECODE[^>]*>([^<]+)<\/TAPE_TIMECODE>/i)
      || xmlString.match(/<TIMECODE_RATE[^>]*>.*?<\/TIMECODE_RATE>.*?<TIMECODE_FLAG[^>]*>.*?<\/TIMECODE_FLAG>/is);

    if (tcMatch && tcMatch[1]) {
      const tc = tcMatch[1].trim();
      // If we don't already have a time from bext, use iXML
      if (!result.originationTime && tc.match(/\d{2}:\d{2}:\d{2}/)) {
        result.originationTime = tc;
        const parts = tc.split(':');
        const h = parseInt(parts[0], 10) || 0;
        const m = parseInt(parts[1], 10) || 0;
        const s = parseInt(parts[2], 10) || 0;
        result.startTimeOfDay = h * 3600 + m * 60 + s;
      }
    }

    // Parse structured iXML data using regex (no DOM in this context)
    result.ixmlData = this.parseIXMLStructured(xmlString, result.sampleRate);
  }

  /**
   * Parse iXML XML string into structured metadata using regex.
   * Works in both browser and Node.js contexts.
   */
  static parseIXMLStructured(xmlStr, sampleRate = 48000) {
    const meta = {};
    const tag = (name) => {
      const m = xmlStr.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
      return m ? m[1].trim() : '';
    };

    meta.project = tag('PROJECT');
    meta.scene = tag('SCENE');
    meta.tape = tag('TAPE');
    meta.take = tag('TAKE');
    meta.note = tag('NOTE');
    meta.file_uid = tag('FILE_UID');
    meta.circled = tag('CIRCLED').toUpperCase() === 'TRUE';

    // LOCATION
    const locBlock = xmlStr.match(/<LOCATION>([\s\S]*?)<\/LOCATION>/i);
    if (locBlock) {
      const lb = locBlock[1];
      const ltag = (name) => {
        const m = lb.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
        return m ? m[1].trim() : '';
      };
      meta.location = {
        name: ltag('LOCATION_NAME'),
        gps: ltag('LOCATION_GPS'),
        altitude: ltag('LOCATION_ALTITUDE'),
      };
    }

    // SPEED
    const speedBlock = xmlStr.match(/<SPEED>([\s\S]*?)<\/SPEED>/i);
    if (speedBlock) {
      const sb = speedBlock[1];
      const stag = (name) => {
        const m = sb.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
        return m ? m[1].trim() : '';
      };
      meta.speed = {
        sample_rate: parseInt(stag('FILE_SAMPLE_RATE')) || 0,
        bit_depth: parseInt(stag('AUDIO_BIT_DEPTH')) || 0,
      };
      if (meta.speed.sample_rate) sampleRate = meta.speed.sample_rate;
    }

    // TRACK_LIST
    const trackBlock = xmlStr.match(/<TRACK_LIST>([\s\S]*?)<\/TRACK_LIST>/i);
    if (trackBlock) {
      meta.tracks = [];
      const trackMatches = trackBlock[1].matchAll(/<TRACK>([\s\S]*?)<\/TRACK>/gi);
      for (const tm of trackMatches) {
        const tb = tm[1];
        const ttag = (name) => {
          const m = tb.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
          return m ? m[1].trim() : '';
        };
        meta.tracks.push({
          channel_index: parseInt(ttag('CHANNEL_INDEX')) || 0,
          interleave_index: parseInt(ttag('INTERLEAVE_INDEX')) || 0,
          name: ttag('n'),
          function: ttag('FUNCTION'),
        });
      }
    }

    // SYNC_POINT_LIST
    const splBlock = xmlStr.match(/<SYNC_POINT_LIST>([\s\S]*?)<\/SYNC_POINT_LIST>/i);
    if (splBlock) {
      meta.annotations = [];
      const spMatches = splBlock[1].matchAll(/<SYNC_POINT>([\s\S]*?)<\/SYNC_POINT>/gi);
      for (const sm of spMatches) {
        const sb = sm[1];
        const sptag = (name) => {
          const m = sb.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
          return m ? m[1].trim() : '';
        };
        const low = parseInt(sptag('SYNC_POINT_LOW')) || 0;
        const high = parseInt(sptag('SYNC_POINT_HIGH')) || 0;
        const sampleOffset = high * 0x100000000 + low;
        const durSamples = parseInt(sptag('SYNC_POINT_EVENT_DURATION')) || 0;
        meta.annotations.push({
          comment: sptag('SYNC_POINT_COMMENT'),
          offset_seconds: sampleOffset / sampleRate,
          duration_seconds: durSamples / sampleRate,
        });
      }
    }

    // USER — extract plain text key:value pairs
    const userBlock = xmlStr.match(/<USER>([\s\S]*?)<\/USER>/i);
    if (userBlock) {
      meta.user_data = {};
      const lines = userBlock[1].split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && trimmed.includes(': ') && !trimmed.startsWith('<')) {
          const idx = trimmed.indexOf(': ');
          meta.user_data[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 2).trim();
        }
      }
    }

    return meta;
  }

  static readString(view, offset, length) {
    let str = '';
    for (let i = 0; i < length; i++) {
      if (offset + i >= view.byteLength) break;
      const ch = view.getUint8(offset + i);
      if (ch === 0) break;
      str += String.fromCharCode(ch);
    }
    return str;
  }

  /**
   * Convert seconds-from-midnight to HH:MM:SS string.
   */
  static secondsToTimeString(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Parse a user-entered time string (HH:MM, HH:MM:SS, or H:MM) to seconds from midnight.
   */
  static parseTimeString(timeStr) {
    const parts = timeStr.trim().split(':').map(p => parseInt(p, 10));
    if (parts.some(isNaN)) return null;

    if (parts.length === 2) {
      return parts[0] * 3600 + parts[1] * 60;
    } else if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return null;
  }
}
