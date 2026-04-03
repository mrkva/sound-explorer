/**
 * Session manager - handles multiple WAV files as one continuous timeline.
 *
 * Scans a folder, parses BWF headers, sorts chronologically,
 * and provides a unified time coordinate system.
 */

import { BWFParser } from './bwf-parser.js';

export class Session {
  constructor() {
    this.files = [];          // Sorted array of file descriptors
    this.totalDuration = 0;   // Total duration in seconds
    this.totalSamples = 0;
    this.sampleRate = 0;
    this.channels = 0;
    this.bitsPerSample = 0;
    this.format = 1;          // 1=PCM, 3=IEEE float
    this.bytesPerSample = 0;
    this.blockAlign = 0;      // bytes per sample frame (all channels)
    this.sessionStartTime = null;  // Seconds from midnight (wall clock)
    this.sessionEndTime = null;
    this.sessionDate = null;
  }

  /**
   * Load a session from a folder of WAV files.
   * @param {string} folderPath
   * @returns {Session}
   */
  async loadFolder(folderPath) {
    const fileInfos = await window.electronAPI.scanFolder(folderPath);

    if (fileInfos.length === 0) {
      throw new Error('No WAV files found in folder');
    }

    // Sort by BWF start time, falling back to filename
    fileInfos.sort((a, b) => {
      if (a.startTimeOfDay !== null && b.startTimeOfDay !== null) {
        // Handle midnight crossing: if times differ by more than 12 hours,
        // the earlier one is probably the next day
        let timeA = a.startTimeOfDay;
        let timeB = b.startTimeOfDay;
        if (Math.abs(timeA - timeB) > 43200) {
          if (timeA > timeB) timeA -= 86400;
          else timeB -= 86400;
        }
        return timeA - timeB;
      }
      return a.filePath.localeCompare(b.filePath);
    });

    // Validate all files have compatible format
    const ref = fileInfos[0];
    this.sampleRate = ref.sampleRate;
    this.channels = ref.channels;
    this.bitsPerSample = ref.bitsPerSample;
    this.format = ref.format || 1;
    this.bytesPerSample = ref.bitsPerSample / 8;
    this.blockAlign = this.channels * this.bytesPerSample;
    this.sessionDate = ref.originationDate;

    for (const f of fileInfos) {
      if (f.sampleRate !== this.sampleRate || f.channels !== this.channels ||
          f.bitsPerSample !== this.bitsPerSample) {
        console.warn(`File ${f.filePath} has different format, skipping`);
        continue;
      }

      const fileSamples = Math.floor(f.dataSize / this.blockAlign);
      const fileDuration = fileSamples / this.sampleRate;

      this.files.push({
        filePath: f.filePath,
        fileName: f.filePath.split(/[/\\]/).pop(),
        dataOffset: f.dataOffset,
        dataSize: f.dataSize,
        samples: fileSamples,
        duration: fileDuration,
        sampleStart: this.totalSamples,       // Start sample in unified timeline
        timeStart: this.totalDuration,         // Start time (seconds) in unified timeline
        wallClockStart: f.startTimeOfDay,      // Wall clock start (seconds from midnight)
        originationDate: f.originationDate,
        originationTime: f.originationTime,
        bext: f.bext
      });

      this.totalSamples += fileSamples;
      this.totalDuration += fileDuration;
    }

    // Set session wall-clock range
    if (this.files[0].wallClockStart !== null) {
      this.sessionStartTime = this.files[0].wallClockStart;
      const lastFile = this.files[this.files.length - 1];
      this.sessionEndTime = lastFile.wallClockStart + lastFile.duration;
    }

    return this;
  }

  /**
   * Load multiple specific files as a session.
   */
  async loadFiles(filePaths) {
    const fileInfos = await window.electronAPI.scanFiles(filePaths);
    if (fileInfos.length === 0) {
      throw new Error('No valid WAV files in selection');
    }

    // Reuse the same sorting and stitching logic as loadFolder
    fileInfos.sort((a, b) => {
      if (a.startTimeOfDay !== null && b.startTimeOfDay !== null) {
        let timeA = a.startTimeOfDay;
        let timeB = b.startTimeOfDay;
        if (Math.abs(timeA - timeB) > 43200) {
          if (timeA > timeB) timeA -= 86400;
          else timeB -= 86400;
        }
        return timeA - timeB;
      }
      return a.filePath.localeCompare(b.filePath);
    });

    const ref = fileInfos[0];
    this.sampleRate = ref.sampleRate;
    this.channels = ref.channels;
    this.bitsPerSample = ref.bitsPerSample;
    this.format = ref.format || 1;
    this.bytesPerSample = ref.bitsPerSample / 8;
    this.blockAlign = this.channels * this.bytesPerSample;
    this.sessionDate = ref.originationDate;

    for (const f of fileInfos) {
      if (f.sampleRate !== this.sampleRate || f.channels !== this.channels ||
          f.bitsPerSample !== this.bitsPerSample) {
        console.warn(`File ${f.filePath} has different format, skipping`);
        continue;
      }

      const fileSamples = Math.floor(f.dataSize / this.blockAlign);
      const fileDuration = fileSamples / this.sampleRate;

      this.files.push({
        filePath: f.filePath,
        fileName: f.filePath.split(/[/\\]/).pop(),
        dataOffset: f.dataOffset,
        dataSize: f.dataSize,
        samples: fileSamples,
        duration: fileDuration,
        sampleStart: this.totalSamples,
        timeStart: this.totalDuration,
        wallClockStart: f.startTimeOfDay,
        originationDate: f.originationDate,
        originationTime: f.originationTime,
        bext: f.bext
      });

      this.totalSamples += fileSamples;
      this.totalDuration += fileDuration;
    }

    if (this.files[0].wallClockStart !== null) {
      this.sessionStartTime = this.files[0].wallClockStart;
      const lastFile = this.files[this.files.length - 1];
      this.sessionEndTime = lastFile.wallClockStart + lastFile.duration;
    }

    return this;
  }

  /**
   * Load a single file as a session.
   */
  async loadFile(filePath) {
    const { header, fileSize } = await window.electronAPI.readFileHeader(filePath);
    const metadata = BWFParser.parse(header);

    this.sampleRate = metadata.sampleRate;
    this.channels = metadata.channels;
    this.bitsPerSample = metadata.bitsPerSample;
    this.format = metadata.format || 1;
    this.bytesPerSample = metadata.bitsPerSample / 8;
    this.blockAlign = this.channels * this.bytesPerSample;
    this.sessionDate = metadata.originationDate;

    // Correct dataSize if the chunk header is wrong (0, 0xFFFFFFFF sentinel,
    // or exceeds file size). Use actual file size to compute the real data extent.
    if (metadata.dataOffset > 0) {
      const maxDataSize = fileSize - metadata.dataOffset;
      if (metadata.dataSize === 0 || metadata.dataSize === 0xFFFFFFFF ||
          metadata.dataSize > maxDataSize) {
        metadata.dataSize = maxDataSize;
      }
    }

    const fileSamples = Math.floor(metadata.dataSize / this.blockAlign);
    const fileDuration = fileSamples / this.sampleRate;

    this.files.push({
      filePath,
      fileName: filePath.split(/[/\\]/).pop(),
      dataOffset: metadata.dataOffset,
      dataSize: metadata.dataSize,
      samples: fileSamples,
      duration: fileDuration,
      sampleStart: 0,
      timeStart: 0,
      wallClockStart: metadata.startTimeOfDay,
      originationDate: metadata.originationDate,
      originationTime: metadata.originationTime,
      bext: metadata.bext
    });

    this.totalSamples = fileSamples;
    this.totalDuration = fileDuration;

    if (metadata.startTimeOfDay !== null && metadata.startTimeOfDay !== undefined) {
      this.sessionStartTime = metadata.startTimeOfDay;
      this.sessionEndTime = metadata.startTimeOfDay + fileDuration;
    }

    return this;
  }

  /**
   * Convert unified timeline position (seconds) to wall-clock time (seconds from midnight).
   */
  toWallClock(timeInSession) {
    if (this.sessionStartTime === null) return null;

    // Find which file this time falls in
    const file = this.fileAtTime(timeInSession);
    if (!file) return null;

    // Use that file's wall clock start + offset within file
    const offsetInFile = timeInSession - file.timeStart;
    return file.wallClockStart + offsetInFile;
  }

  /**
   * Convert wall-clock time (seconds from midnight) to unified timeline position.
   */
  fromWallClock(wallClockSeconds) {
    if (this.sessionStartTime === null) return null;

    // Handle midnight crossing
    let target = wallClockSeconds;
    if (this.sessionStartTime > 43200 && target < 43200) {
      target += 86400; // Next day
    }

    // Find the file that contains this wall-clock time
    for (const file of this.files) {
      if (file.wallClockStart === null) continue;
      let fileWallStart = file.wallClockStart;
      if (this.sessionStartTime > 43200 && fileWallStart < 43200) {
        fileWallStart += 86400;
      }
      const fileWallEnd = fileWallStart + file.duration;

      if (target >= fileWallStart && target < fileWallEnd) {
        const offsetInFile = target - fileWallStart;
        return file.timeStart + offsetInFile;
      }
    }

    // If not in any file, try to extrapolate from closest file
    const first = this.files[0];
    let firstWall = first.wallClockStart;
    if (this.sessionStartTime > 43200 && firstWall < 43200) firstWall += 86400;

    if (target < firstWall) return 0;
    return this.totalDuration;
  }

  /**
   * Find which file contains a given unified time position.
   */
  fileAtTime(timeInSession) {
    const t = Math.max(0, Math.min(timeInSession, this.totalDuration));
    for (let i = this.files.length - 1; i >= 0; i--) {
      if (t >= this.files[i].timeStart) return this.files[i];
    }
    return this.files[0];
  }

  /**
   * Find which file contains a given unified sample position.
   */
  fileAtSample(sample) {
    for (let i = this.files.length - 1; i >= 0; i--) {
      if (sample >= this.files[i].sampleStart) return this.files[i];
    }
    return this.files[0];
  }

  /**
   * Get info for the audio server (file list with data positions).
   */
  getServerFileList() {
    return this.files.map(f => ({
      filePath: f.filePath,
      dataOffset: f.dataOffset,
      dataSize: f.dataSize,
      channels: this.channels,
      sampleRate: this.sampleRate,
      bitsPerSample: this.bitsPerSample,
      format: this.format
    }));
  }

  /**
   * Get a summary string for display.
   */
  getSummary() {
    const fileCount = this.files.length;
    const durationStr = BWFParser.secondsToTimeString(this.totalDuration);
    let summary = `${fileCount} file${fileCount > 1 ? 's' : ''}  |  ${durationStr}  |  `;
    summary += `${this.sampleRate} Hz  |  ${this.bitsPerSample}-bit  |  ${this.channels}ch`;

    if (this.sessionDate) summary += `  |  ${this.sessionDate}`;
    if (this.sessionStartTime !== null) {
      const startStr = BWFParser.secondsToTimeString(this.sessionStartTime);
      const endStr = BWFParser.secondsToTimeString(this.sessionEndTime);
      summary += `  |  ${startStr} \u2013 ${endStr}`;
    }

    return summary;
  }
}
