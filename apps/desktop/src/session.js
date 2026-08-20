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
    this.skippedFiles = [];   // Files dropped because their format differs
    this.gaps = [];           // Wall-clock discontinuities between adjacent files
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

    return this._buildFromInfos(fileInfos);
  }

  /**
   * Load multiple specific files as a session.
   */
  async loadFiles(filePaths) {
    const fileInfos = await window.electronAPI.scanFiles(filePaths);
    if (fileInfos.length === 0) {
      throw new Error('No valid WAV files in selection');
    }

    return this._buildFromInfos(fileInfos);
  }

  /**
   * Order file headers by when they were actually recorded.
   *
   * BWF only gives us a time of day, so a session that runs past midnight
   * comes out rotated by a plain sort: a file starting at 22:52 sorts after
   * one starting at 01:58 even though it was recorded first. The true order is
   * always some rotation of the time-of-day order, so cut the list at its
   * largest discontinuity — the stretch of the day the recorder was idle.
   * For a session that does not cross midnight the largest gap is already the
   * wrap-around, so the order is left alone.
   *
   * Note: origination date is deliberately not used. Some recorders stamp the
   * date/time at which the file was closed, which is a whole file ahead of the
   * timecode reference and lands on the wrong day for the file that spans
   * midnight.
   */
  _sortChronologically(fileInfos) {
    const untimed = fileInfos.some(f => f.startTimeOfDay === null || f.startTimeOfDay === undefined);
    if (untimed || fileInfos.length < 2) {
      fileInfos.sort((a, b) => a.filePath.localeCompare(b.filePath));
      return fileInfos;
    }

    fileInfos.sort((a, b) => a.startTimeOfDay - b.startTimeOfDay);

    const durationOf = f => {
      const blockAlign = f.channels * (f.bitsPerSample / 8);
      return blockAlign > 0 && f.sampleRate > 0
        ? Math.floor(f.dataSize / blockAlign) / f.sampleRate
        : 0;
    };

    const n = fileInfos.length;
    let cut = 0;
    let widest = -Infinity;
    for (let i = 0; i < n; i++) {
      const prev = fileInfos[(i - 1 + n) % n];
      let gap = fileInfos[i].startTimeOfDay - (prev.startTimeOfDay + durationOf(prev));
      if (i === 0) gap += 86400; // wrap-around from the last file back to the first
      if (gap > widest) { widest = gap; cut = i; }
    }

    if (cut > 0) {
      const rotated = fileInfos.slice(cut).concat(fileInfos.slice(0, cut));
      fileInfos.length = 0;
      fileInfos.push(...rotated);
      console.log(`Session crosses midnight: reordered starting at ${rotated[0].filePath.split(/[/\\]/).pop()}`);
    }
    return fileInfos;
  }

  /**
   * Sort file headers chronologically and stitch them into one timeline.
   * Shared by loadFolder() and loadFiles().
   */
  _buildFromInfos(fileInfos) {
    this._sortChronologically(fileInfos);

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
        // Dropping a file silently makes the timeline shorter than the folder,
        // so keep a record the UI can warn about.
        this.skippedFiles.push({
          fileName: f.filePath.split(/[/\\]/).pop(),
          filePath: f.filePath,
          reason: `${f.sampleRate} Hz / ${f.bitsPerSample}-bit / ${f.channels}ch ` +
                  `differs from ${this.sampleRate} Hz / ${this.bitsPerSample}-bit / ${this.channels}ch`
        });
        console.warn(`File ${f.filePath} has different format, skipping`);
        continue;
      }

      const fileSamples = Math.floor(f.dataSize / this.blockAlign);
      const fileDuration = fileSamples / this.sampleRate;

      // Count a day each time the time of day runs backwards, so a session
      // recorded across midnight keeps an unambiguous calendar position.
      const prev = this.files[this.files.length - 1];
      let dayOffset = prev ? prev.dayOffset : 0;
      if (prev && prev.wallClockStart !== null && f.startTimeOfDay !== null &&
          f.startTimeOfDay < prev.wallClockStart) {
        dayOffset++;
      }

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
        dayOffset,                             // Days past the session's first day
        originationDate: f.originationDate,
        originationTime: f.originationTime,
        bext: f.bext
      });

      this.totalSamples += fileSamples;
      this.totalDuration += fileDuration;
    }

    if (this.files.length === 0) {
      throw new Error('No WAV files with a consistent format');
    }

    // Set session wall-clock range
    if (this.files[0].wallClockStart !== null) {
      this.sessionStartTime = this.files[0].wallClockStart;
      const lastFile = this.files[this.files.length - 1];
      this.sessionEndTime = lastFile.wallClockStart + lastFile.duration;
    }

    this._detectGaps();

    return this;
  }

  /**
   * Compare each file's wall-clock start against where the previous file ended.
   * Files are butted together on the timeline, so any real-world gap (recorder
   * stopped, a file missing from the folder) means a wall-clock range covers
   * less audio than its span suggests.
   */
  _detectGaps() {
    this.gaps = [];
    const TOLERANCE = 0.5; // seconds — ignore sub-second rounding in BWF timestamps

    for (let i = 1; i < this.files.length; i++) {
      const prev = this.files[i - 1];
      const cur = this.files[i];
      if (prev.wallClockStart === null || cur.wallClockStart === null) continue;

      let curWall = cur.wallClockStart;
      const prevWallEnd = prev.wallClockStart + prev.duration;
      // Midnight crossing: the next file's clock wrapped past 00:00
      if (prevWallEnd - curWall > 43200) curWall += 86400;

      const delta = curWall - prevWallEnd;
      if (Math.abs(delta) > TOLERANCE) {
        this.gaps.push({
          afterFile: prev.fileName,
          beforeFile: cur.fileName,
          timeInSession: cur.timeStart,   // where the discontinuity sits on the timeline
          wallClockAt: prevWallEnd,
          seconds: delta                  // >0 = missing audio, <0 = overlap
        });
      }
    }
  }

  /**
   * Total wall-clock seconds missing inside a timeline range (0 if contiguous).
   */
  gapSecondsWithin(startTime, endTime) {
    let total = 0;
    for (const g of this.gaps) {
      if (g.seconds > 0 && g.timeInSession > startTime && g.timeInSession < endTime) {
        total += g.seconds;
      }
    }
    return total;
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
   * Wall clock as seconds from midnight of the session's FIRST day, running
   * past 86400 for a recording that continues into the next day. Use this
   * wherever a calendar date matters (export filenames, BWF timestamps);
   * toWallClock() is the plain time of day for display.
   */
  toWallClockContinuous(timeInSession) {
    if (this.sessionStartTime === null) return null;
    const file = this.fileAtTime(timeInSession);
    if (!file || file.wallClockStart === null) return null;
    const offsetInFile = timeInSession - file.timeStart;
    return file.wallClockStart + offsetInFile + (file.dayOffset || 0) * 86400;
  }

  /**
   * Convert wall-clock time (seconds from midnight) to unified timeline position.
   */
  fromWallClock(wallClockSeconds) {
    if (this.sessionStartTime === null) return null;

    const first = this.files[0];
    const last = this.files[this.files.length - 1];
    const sessionStart = first.wallClockStart;
    const sessionEnd = last.wallClockStart + (last.dayOffset || 0) * 86400 + last.duration;

    // A typed time is a time of day. Roll it forward onto the session's
    // continuous clock so a recording that runs past midnight resolves to the
    // right day rather than back to its own first hours.
    let target = wallClockSeconds;
    let rolled = false;
    while (target < sessionStart) { target += 86400; rolled = true; }

    for (const file of this.files) {
      const fileStart = file.wallClockStart + (file.dayOffset || 0) * 86400;
      if (target >= fileStart && target < fileStart + file.duration) {
        return file.timeStart + (target - fileStart);
      }
    }

    // Inside a gap between recordings: snap forward to the next real audio
    for (const file of this.files) {
      const fileStart = file.wallClockStart + (file.dayOffset || 0) * 86400;
      if (fileStart > target) return file.timeStart;
    }

    // Past the end. If we rolled the value forward it may really have been a
    // time before the session began — pick whichever end of the session it
    // sits closer to.
    if (rolled && (sessionStart + 86400 - target) < (target - sessionEnd)) return 0;
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
