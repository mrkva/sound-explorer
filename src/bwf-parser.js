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
    const fileSize = Math.min(arrayBuffer.byteLength, view.getUint32(4, true) + 8);

    while (offset + 8 <= fileSize) {
      const chunkId = this.readString(view, offset, 4);
      const chunkSize = view.getUint32(offset + 4, true);
      const chunkDataOffset = offset + 8;

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
    const xmlString = this.readString(view, offset, Math.min(size, 8192)).trim();
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
