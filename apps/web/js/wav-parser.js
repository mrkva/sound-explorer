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
    if (riffTag !== 'RIFF' && riffTag !== 'RF64') {
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
      ixml: null,          // raw iXML string if present
    };

    // Walk RIFF chunks starting at offset 12.
    // Read each chunk header and body as its own small slice — recorders often
    // put the iXML chunk AFTER a multi-gigabyte data chunk, and buffering the
    // file from byte 0 to reach it would pull the whole recording into memory.
    let offset = 12;
    let fmtFound = false;
    let dataFound = false;
    let rf64DataSize = null; // set by a ds64 chunk in RF64 files

    const readAt = async (off, len) => {
      const end = Math.min(file.size, off + len);
      if (end <= off) return null;
      return new DataView(await file.slice(off, end).arrayBuffer());
    };

    while (offset + 8 <= file.size) {
      const head = await readAt(offset, 8);
      if (!head || head.byteLength < 8) break;

      const chunkId = String.fromCharCode(
        head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3)
      );
      const chunkSize = head.getUint32(4, true);

      // Validate chunk ID is printable ASCII
      if (!/^[\x20-\x7E]{4}$/.test(chunkId)) break;
      // Validate chunk size. In RF64 the data chunk carries a 0xFFFFFFFF
      // sentinel and its real size comes from ds64.
      if (chunkSize > 0xFFFFFFF0 && !(chunkId === 'data' && chunkSize === 0xFFFFFFFF)) break;

      if (chunkId === 'ds64') {
        const v = await readAt(offset + 8, Math.min(chunkSize, 28));
        if (v && v.byteLength >= 24) {
          rf64DataSize = v.getUint32(8, true) + v.getUint32(12, true) * 0x100000000;
        }
      } else if (chunkId === 'fmt ') {
        const v = await readAt(offset + 8, chunkSize);
        if (v) { WavParser._parseFmt(v, 0, chunkSize, result); fmtFound = true; }
      } else if (chunkId === 'data') {
        result.dataOffset = offset + 8;
        result.dataSize = rf64DataSize !== null ? rf64DataSize : chunkSize;
        dataFound = true;
      } else if (chunkId === 'bext') {
        const v = await readAt(offset + 8, Math.min(chunkSize, 700));
        if (v) result.bext = WavParser._parseBext(v, 0, chunkSize);
      } else if (chunkId === 'iXML' || chunkId === 'IXML') {
        const ixmlSize = Math.min(chunkSize, 262144); // cap at 256KB
        const v = await readAt(offset + 8, ixmlSize);
        if (v) {
          result.ixml = new TextDecoder('utf-8').decode(
            new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
          );
        }
      }

      // Move to next chunk (chunks are word-aligned)
      const advance = (chunkId === 'data' && rf64DataSize !== null) ? rf64DataSize : chunkSize;
      offset += 8 + advance;
      if (advance % 2 !== 0) offset += 1;

      if (fmtFound && dataFound && result.bext !== null && result.ixml !== null) break;
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
    return WavParser.buildWavBlobFromSegments(
      [{ wavInfo, startSample, numSamples }], bextInfo, overrideSampleRate
    );
  }

  /**
   * Build a WAV Blob from one or more source ranges, concatenated in order.
   * A selection that spans several recordings of a session produces one
   * segment per file, so the export is joined rather than taken from the
   * first file only.
   *
   * @param {Array<{wavInfo: object, startSample: number, numSamples: number}>} segments
   * @param {object|null} bextInfo - BWF metadata for the exported file
   * @param {number|null} overrideSampleRate - declare a different rate (speed shift)
   * @returns {Blob}
   */
  static async buildWavBlobFromSegments(segments, bextInfo = null, overrideSampleRate = null) {
    if (!segments.length) throw new Error('Nothing to export');

    const ref = segments[0].wavInfo;
    const { channels, bitsPerSample, format, blockAlign } = ref;
    const sampleRate = overrideSampleRate || ref.sampleRate;

    let totalSamples = 0;
    for (const seg of segments) {
      if (seg.wavInfo.blockAlign !== blockAlign || seg.wavInfo.channels !== channels ||
          seg.wavInfo.bitsPerSample !== bitsPerSample) {
        throw new Error(`Cannot join ${seg.wavInfo.fileName}: format differs from ${ref.fileName}`);
      }
      totalSamples += seg.numSamples;
    }
    const dataSize = totalSamples * blockAlign;

    // Read raw PCM in chunks to avoid loading whole files into memory
    const maxChunkSamples = Math.floor(8 * 1024 * 1024 / blockAlign);
    const pcmParts = [];
    for (const seg of segments) {
      const last = seg.startSample + seg.numSamples;
      for (let pos = seg.startSample; pos < last; pos += maxChunkSamples) {
        const count = Math.min(maxChunkSamples, last - pos);
        pcmParts.push(await WavParser.readSamples(seg.wavInfo, pos, count));
      }
    }

    const bextChunkSize = bextInfo ? 8 + 602 : 0;
    const fmtChunkSize = 8 + 16;
    const dataChunkHeaderSize = 8;
    // Plain RIFF tops out at 4 GB; past that the sizes must be carried in a
    // ds64 chunk (RF64, EBU Tech 3306) or they wrap and the file reads short.
    const DS64_SIZE = 28;
    const plainHeaderSize = 12 + fmtChunkSize + bextChunkSize + dataChunkHeaderSize;
    const isRF64 = (plainHeaderSize - 8 + dataSize) > 0xFFFFFFFF;
    const headerSize = plainHeaderSize + (isRF64 ? 8 + DS64_SIZE : 0);
    const riffSize = headerSize - 8 + dataSize;

    const header = new ArrayBuffer(headerSize);
    const hView = new DataView(header);
    let off = 0;

    const writeStr = (str) => {
      for (let i = 0; i < str.length; i++) hView.setUint8(off + i, str.charCodeAt(i));
      off += str.length;
    };
    const writeU64 = (value) => {
      hView.setUint32(off, value % 4294967296, true); off += 4;
      hView.setUint32(off, Math.floor(value / 4294967296), true); off += 4;
    };

    writeStr(isRF64 ? 'RF64' : 'RIFF');
    hView.setUint32(off, isRF64 ? 0xFFFFFFFF : riffSize, true); off += 4;
    writeStr('WAVE');

    // ds64 must be the first chunk after WAVE
    if (isRF64) {
      writeStr('ds64');
      hView.setUint32(off, DS64_SIZE, true); off += 4;
      writeU64(riffSize);
      writeU64(dataSize);
      writeU64(totalSamples);
      hView.setUint32(off, 0, true); off += 4; // no chunk size table
    }

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
      writeU64(bextInfo.timeReference || 0);

      hView.setUint16(off, 0, true); off += 2; // version

      // UMID + reserved (254 bytes zeroed)
      for (let i = 0; i < 254; i++) hView.setUint8(off + i, 0);
      off += 254;
    }

    // data chunk header
    writeStr('data');
    hView.setUint32(off, isRF64 ? 0xFFFFFFFF : dataSize, true); off += 4;

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
