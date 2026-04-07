/**
 * WAV/BWF file parser — client-side, streaming via File API.
 * Supports PCM 16/24/32-bit int, 32-bit float, mono & multichannel, any sample rate.
 * Parses BWF bext chunk for timecode.
 */

export class WavParser {
  /**
   * Parse WAV header from a File object.
   * Returns metadata without reading sample data.
   */
  static async parse(file) {
    // Read first 128 bytes for RIFF header + fmt chunk (most files)
    const headerSize = Math.min(file.size, 4096);
    const headerBuf = await file.slice(0, headerSize).arrayBuffer();
    const view = new DataView(headerBuf);

    // Validate RIFF header
    const riffTag = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (riffTag !== 'RIFF') {
      throw new Error('Not a valid WAV file (missing RIFF header)');
    }

    const waveTag = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    if (waveTag !== 'WAVE') {
      throw new Error('Not a valid WAV file (missing WAVE tag)');
    }

    const result = {
      file,
      fileName: file.name,
      fileSize: file.size,
      format: null,        // 'pcm_int' or 'pcm_float'
      bitsPerSample: 0,
      sampleRate: 0,
      channels: 0,
      blockAlign: 0,
      dataOffset: 0,       // byte offset of PCM data in file
      dataSize: 0,         // byte size of PCM data
      totalSamples: 0,     // total sample frames
      duration: 0,         // seconds
      bext: null,          // BWF metadata if present
    };

    // Walk RIFF chunks starting at offset 12
    let offset = 12;
    let fmtFound = false;
    let dataFound = false;

    // We may need to read more of the file for large headers
    let buf = headerBuf;
    let bufView = view;

    const ensureBytes = async (off, need) => {
      if (off + need <= buf.byteLength) return;
      const newSize = Math.min(file.size, off + need + 4096);
      buf = await file.slice(0, newSize).arrayBuffer();
      bufView = new DataView(buf);
    };

    while (offset < file.size - 8) {
      await ensureBytes(offset, 8);
      if (offset + 8 > buf.byteLength) break;

      const chunkId = String.fromCharCode(
        bufView.getUint8(offset), bufView.getUint8(offset + 1),
        bufView.getUint8(offset + 2), bufView.getUint8(offset + 3)
      );
      const chunkSize = bufView.getUint32(offset + 4, true);

      // Validate chunk ID is printable ASCII
      if (!/^[\x20-\x7E]{4}$/.test(chunkId)) break;
      // Validate chunk size
      if (chunkSize > 0xFFFFFFF0) break;

      if (chunkId === 'fmt ') {
        await ensureBytes(offset, 8 + chunkSize);
        WavParser._parseFmt(bufView, offset + 8, chunkSize, result);
        fmtFound = true;
      } else if (chunkId === 'data') {
        result.dataOffset = offset + 8;
        result.dataSize = chunkSize;
        dataFound = true;
      } else if (chunkId === 'bext') {
        await ensureBytes(offset, 8 + Math.min(chunkSize, 700));
        result.bext = WavParser._parseBext(bufView, offset + 8, chunkSize);
      }

      // Move to next chunk (chunks are word-aligned)
      offset += 8 + chunkSize;
      if (chunkSize % 2 !== 0) offset += 1;

      if (fmtFound && dataFound && result.bext !== null) break;
    }

    if (!fmtFound) throw new Error('WAV file missing fmt chunk');
    if (!dataFound) throw new Error('WAV file missing data chunk');

    // Correct dataSize if invalid
    if (result.dataSize === 0 || result.dataSize === 0xFFFFFFFF ||
        result.dataSize > file.size - result.dataOffset) {
      result.dataSize = file.size - result.dataOffset;
    }

    // Align to blockAlign
    result.dataSize = result.dataSize - (result.dataSize % result.blockAlign);

    result.totalSamples = Math.floor(result.dataSize / result.blockAlign);
    result.duration = result.totalSamples / result.sampleRate;

    return result;
  }

  static _parseFmt(view, offset, size, result) {
    let formatCode = view.getUint16(offset, true);
    result.channels = view.getUint16(offset + 2, true);
    result.sampleRate = view.getUint32(offset + 4, true);
    // byteRate at offset+8
    result.blockAlign = view.getUint16(offset + 12, true);
    result.bitsPerSample = view.getUint16(offset + 14, true);

    // Handle WAVE_FORMAT_EXTENSIBLE
    if (formatCode === 0xFFFE && size >= 40) {
      // SubFormat GUID starts at offset+24 within fmt chunk data
      const subFormat = view.getUint16(offset + 24, true);
      formatCode = subFormat;
    }

    if (formatCode === 1) {
      result.format = 'pcm_int';
    } else if (formatCode === 3) {
      result.format = 'pcm_float';
    } else {
      throw new Error(`Unsupported WAV format code: ${formatCode}`);
    }
  }

  static _parseBext(view, offset, size) {
    if (size < 602) return null;

    const readString = (off, len) => {
      const bytes = [];
      for (let i = 0; i < len; i++) {
        const b = view.getUint8(off + i);
        if (b === 0) break;
        bytes.push(b);
      }
      return String.fromCharCode(...bytes);
    };

    const description = readString(offset, 256);
    const originator = readString(offset + 256, 32);
    const originatorReference = readString(offset + 288, 32);
    const originationDate = readString(offset + 320, 10); // YYYY-MM-DD
    const originationTime = readString(offset + 330, 8);  // HH:MM:SS

    // timeReference is a uint64 LE at offset+338
    const timeLow = view.getUint32(offset + 338, true);
    const timeHigh = view.getUint32(offset + 342, true);
    const timeReference = timeHigh * 4294967296 + timeLow;

    const version = view.getUint16(offset + 346, true);

    return {
      description,
      originator,
      originatorReference,
      originationDate,
      originationTime,
      timeReference,
      version,
    };
  }

  /**
   * Read raw PCM bytes from the file.
   * @param {object} wavInfo - parsed WAV info
   * @param {number} startSample - first sample frame
   * @param {number} numSamples - number of sample frames to read
   * @returns {ArrayBuffer}
   */
  static async readSamples(wavInfo, startSample, numSamples) {
    const byteOffset = wavInfo.dataOffset + startSample * wavInfo.blockAlign;
    const byteLength = numSamples * wavInfo.blockAlign;
    const end = Math.min(byteOffset + byteLength, wavInfo.dataOffset + wavInfo.dataSize);
    return wavInfo.file.slice(byteOffset, end).arrayBuffer();
  }

  /**
   * Decode raw PCM bytes to Float32Array (mono downmix or specific channel).
   * @param {ArrayBuffer} buffer - raw PCM bytes
   * @param {object} wavInfo - parsed WAV info
   * @param {number|'mix'} channel - channel index (0-based) or 'mix' for mono downmix
   * @returns {Float32Array}
   */
  static decodeSamples(buffer, wavInfo, channel = 'mix') {
    const view = new DataView(buffer);
    const { channels, bitsPerSample, format, blockAlign } = wavInfo;
    const bytesPerSample = bitsPerSample / 8;
    const numFrames = Math.floor(buffer.byteLength / blockAlign);
    const output = new Float32Array(numFrames);

    for (let i = 0; i < numFrames; i++) {
      const frameOffset = i * blockAlign;

      if (channel === 'mix') {
        let sum = 0;
        for (let ch = 0; ch < channels; ch++) {
          sum += WavParser._readSample(view, frameOffset + ch * bytesPerSample, format, bitsPerSample);
        }
        output[i] = sum / channels;
      } else {
        const chOffset = frameOffset + channel * bytesPerSample;
        output[i] = WavParser._readSample(view, chOffset, format, bitsPerSample);
      }
    }

    return output;
  }

  static _readSample(view, offset, format, bitsPerSample) {
    if (format === 'pcm_float') {
      return view.getFloat32(offset, true);
    }
    switch (bitsPerSample) {
      case 16:
        return view.getInt16(offset, true) / 32768;
      case 24: {
        const b0 = view.getUint8(offset);
        const b1 = view.getUint8(offset + 1);
        const b2 = view.getInt8(offset + 2); // signed
        return (b2 * 65536 + b1 * 256 + b0) / 8388608;
      }
      case 32:
        return view.getInt32(offset, true) / 2147483648;
      default:
        return 0;
    }
  }

  /**
   * Build a WAV file Blob for export.
   */
  static async buildWavBlob(wavInfo, startSample, numSamples, bextInfo = null, overrideSampleRate = null) {
    const { channels, bitsPerSample, format, blockAlign } = wavInfo;
    const sampleRate = overrideSampleRate || wavInfo.sampleRate;
    const bytesPerSample = bitsPerSample / 8;
    const dataSize = numSamples * blockAlign;

    // Read raw PCM data in chunks to avoid loading entire file into memory
    const maxChunkSamples = Math.floor(8 * 1024 * 1024 / blockAlign);
    const pcmParts = [];
    for (let pos = startSample; pos < startSample + numSamples; pos += maxChunkSamples) {
      const count = Math.min(maxChunkSamples, startSample + numSamples - pos);
      pcmParts.push(await WavParser.readSamples(wavInfo, pos, count));
    }

    // Calculate sizes
    const bextChunkSize = bextInfo ? 8 + 602 : 0;
    const fmtChunkSize = 8 + 16;
    const dataChunkHeaderSize = 8;
    const riffSize = 4 + fmtChunkSize + bextChunkSize + dataChunkHeaderSize + dataSize;

    const totalSize = 8 + riffSize;
    const header = new ArrayBuffer(totalSize - dataSize);
    const hView = new DataView(header);
    let off = 0;

    // RIFF header
    const writeStr = (str) => {
      for (let i = 0; i < str.length; i++) hView.setUint8(off + i, str.charCodeAt(i));
      off += str.length;
    };

    writeStr('RIFF');
    hView.setUint32(off, riffSize, true); off += 4;
    writeStr('WAVE');

    // fmt chunk
    writeStr('fmt ');
    hView.setUint32(off, 16, true); off += 4;
    hView.setUint16(off, format === 'pcm_float' ? 3 : 1, true); off += 2;
    hView.setUint16(off, channels, true); off += 2;
    hView.setUint32(off, sampleRate, true); off += 4;
    hView.setUint32(off, sampleRate * blockAlign, true); off += 4;
    hView.setUint16(off, blockAlign, true); off += 2;
    hView.setUint16(off, bitsPerSample, true); off += 2;

    // bext chunk
    if (bextInfo) {
      writeStr('bext');
      hView.setUint32(off, 602, true); off += 4;

      const writePaddedStr = (str, len) => {
        for (let i = 0; i < len; i++) {
          hView.setUint8(off + i, i < str.length ? str.charCodeAt(i) : 0);
        }
        off += len;
      };

      writePaddedStr(bextInfo.description || '', 256);
      writePaddedStr(bextInfo.originator || '', 32);
      writePaddedStr(bextInfo.originatorReference || '', 32);
      writePaddedStr(bextInfo.originationDate || '', 10);
      writePaddedStr(bextInfo.originationTime || '', 8);

      // timeReference uint64 LE - use modulo/division NOT bitwise
      const timeRef = bextInfo.timeReference || 0;
      const timeLow = timeRef % 4294967296;
      const timeHigh = Math.floor(timeRef / 4294967296);
      hView.setUint32(off, timeLow, true); off += 4;
      hView.setUint32(off, timeHigh, true); off += 4;

      hView.setUint16(off, 0, true); off += 2; // version

      // UMID + reserved (254 bytes zeroed)
      for (let i = 0; i < 254; i++) hView.setUint8(off + i, 0);
      off += 254;
    }

    // data chunk header
    writeStr('data');
    hView.setUint32(off, dataSize, true); off += 4;

    return new Blob([header, ...pcmParts], { type: 'audio/wav' });
  }

  /**
   * Decimate a WAV file to <= 48kHz for browser playback.
   * Returns a Blob URL.
   */
  static async decimateForPlayback(wavInfo) {
    const maxRate = 48000;
    if (wavInfo.sampleRate <= maxRate) {
      // No decimation needed, create blob URL directly
      return URL.createObjectURL(wavInfo.file);
    }

    const factor = Math.ceil(wavInfo.sampleRate / maxRate);
    const outRate = Math.round(wavInfo.sampleRate / factor);
    const outSamples = Math.floor(wavInfo.totalSamples / factor);
    const outChannels = wavInfo.channels;
    const outBytesPerSample = 2; // always 16-bit output
    const outBlockAlign = outChannels * outBytesPerSample;
    const outDataSize = outSamples * outBlockAlign;

    // Build header
    const headerSize = 44;
    const header = new ArrayBuffer(headerSize);
    const hv = new DataView(header);
    let o = 0;

    const ws = (s) => { for (let i = 0; i < s.length; i++) hv.setUint8(o + i, s.charCodeAt(i)); o += s.length; };
    ws('RIFF');
    hv.setUint32(o, 36 + outDataSize, true); o += 4;
    ws('WAVE');
    ws('fmt ');
    hv.setUint32(o, 16, true); o += 4;
    hv.setUint16(o, 1, true); o += 2; // PCM
    hv.setUint16(o, outChannels, true); o += 2;
    hv.setUint32(o, outRate, true); o += 4;
    hv.setUint32(o, outRate * outBlockAlign, true); o += 4;
    hv.setUint16(o, outBlockAlign, true); o += 2;
    hv.setUint16(o, 16, true); o += 2;
    ws('data');
    hv.setUint32(o, outDataSize, true); o += 4;

    // Process in chunks
    const chunkFrames = 1024 * 1024; // ~1M frames per chunk
    const parts = [header];

    for (let pos = 0; pos < wavInfo.totalSamples; pos += chunkFrames) {
      const count = Math.min(chunkFrames, wavInfo.totalSamples - pos);
      const raw = await WavParser.readSamples(wavInfo, pos, count);
      const view = new DataView(raw);

      // Count output frames in this chunk
      const firstOutIdx = Math.ceil(pos / factor);
      const lastSample = pos + count;
      const lastOutIdx = Math.ceil(lastSample / factor);
      const outCount = lastOutIdx - firstOutIdx;
      if (outCount <= 0) continue;

      const outBuf = new ArrayBuffer(outCount * outBlockAlign);
      const outView = new DataView(outBuf);
      let outOff = 0;

      for (let i = firstOutIdx; i < lastOutIdx; i++) {
        const srcFrame = i * factor;
        if (srcFrame < pos || srcFrame >= lastSample) continue;
        const localFrame = srcFrame - pos;
        const frameOff = localFrame * wavInfo.blockAlign;

        for (let ch = 0; ch < outChannels; ch++) {
          const sampleOff = frameOff + ch * (wavInfo.bitsPerSample / 8);
          const val = WavParser._readSample(view, sampleOff, wavInfo.format, wavInfo.bitsPerSample);
          const int16 = Math.max(-32768, Math.min(32767, Math.round(val * 32768)));
          outView.setInt16(outOff, int16, true);
          outOff += 2;
        }
      }

      if (outOff > 0) {
        parts.push(outBuf.slice(0, outOff));
      }
    }

    const blob = new Blob(parts, { type: 'audio/wav' });
    return URL.createObjectURL(blob);
  }
}
