/**
 * FRM (.frm.txt) — Field Recording Metadata parser and serializer.
 *
 * Handles the YAML subset used by .frm.txt files: nested mappings,
 * block/flow sequences, flow mappings, block scalars, and comments.
 * No external YAML library needed.
 */

// ── YAML subset parser ───────────────────────────────────────────────────

/**
 * Parse a .frm.txt YAML string into a JavaScript object.
 */
export function parseFRM(text) {
  const lines = text.split('\n');
  const root = {};
  // Stack: [{obj, indent, key}]
  // key: the key in obj that points to the current child container
  const stack = [{ obj: { '': root }, indent: -2, key: '' }];

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    i++;

    const stripped = raw.replace(/\s+$/, '');
    if (stripped === '' || /^\s*#/.test(stripped)) continue;

    const indent = stripped.search(/\S/);
    const content = stripped.slice(indent);

    // Pop stack to find parent at lower indent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const top = stack[stack.length - 1];
    const container = top.obj[top.key];

    // List item: "- key: val" or "- val"
    if (content.startsWith('- ')) {
      const itemContent = content.slice(2).trim();

      // Convert container to array if it was initialized as {}
      if (!Array.isArray(container)) {
        top.obj[top.key] = [];
      }
      const arr = top.obj[top.key];

      if (itemContent.includes(':')) {
        const item = {};
        _parseKVInto(item, itemContent);
        // Collect continuation lines at deeper indent
        while (i < lines.length) {
          const nextRaw = lines[i].replace(/\s+$/, '');
          if (nextRaw === '' || /^\s*#/.test(nextRaw)) { i++; continue; }
          const nextIndent = nextRaw.search(/\S/);
          if (nextIndent <= indent) break;
          if (nextRaw.trim().startsWith('- ')) break;
          _parseKVInto(item, nextRaw.trim());
          i++;
        }
        arr.push(item);
      } else {
        arr.push(_parseValue(itemContent));
      }
      continue;
    }

    // Key-value: "key: value" or "key:"
    const colonIdx = content.indexOf(':');
    if (colonIdx > 0) {
      const key = content.slice(0, colonIdx).trim();
      const afterColon = content.slice(colonIdx + 1).trim();
      const val = _stripInlineComment(afterColon);

      if (val === '' || val === undefined) {
        // Nested mapping — next lines are children
        container[key] = {};
        stack.push({ obj: container, indent, key });
      } else if (val === '|') {
        container[key] = _collectBlockScalar(lines, i, indent);
        while (i < lines.length) {
          const bRaw = lines[i].replace(/\s+$/, '');
          if (bRaw === '') { i++; continue; }
          const bIndent = bRaw.search(/\S/);
          if (bIndent <= indent) break;
          i++;
        }
      } else if (val.startsWith('[')) {
        container[key] = _parseFlowSequence(val);
      } else if (val.startsWith('{')) {
        container[key] = _parseFlowMapping(val);
      } else {
        container[key] = _parseValue(val);
      }
      // If value is a nested object, push to stack
      if (typeof container[key] === 'object' && !Array.isArray(container[key]) && container[key] !== null) {
        stack.push({ obj: container, indent, key });
      }
    }
  }

  return root;
}

function _parseKVInto(obj, str) {
  const colonIdx = str.indexOf(':');
  if (colonIdx <= 0) return;
  const key = str.slice(0, colonIdx).trim();
  const val = _stripInlineComment(str.slice(colonIdx + 1).trim());
  if (val.startsWith('[')) obj[key] = _parseFlowSequence(val);
  else if (val.startsWith('{')) obj[key] = _parseFlowMapping(val);
  else obj[key] = _parseValue(val);
}

function _stripInlineComment(str) {
  // Remove inline comment, but not inside quotes
  if (!str.includes('#')) return str;
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inQuote) {
      if (ch === quoteChar) inQuote = false;
    } else {
      if (ch === '"' || ch === "'") { inQuote = true; quoteChar = ch; }
      if (ch === '#' && (i === 0 || str[i - 1] === ' ')) {
        return str.slice(0, i).trim();
      }
    }
  }
  return str;
}

function _collectBlockScalar(lines, startIdx, baseIndent) {
  const parts = [];
  let i = startIdx;
  let scalarIndent = -1;
  while (i < lines.length) {
    const raw = lines[i].replace(/\s+$/, '');
    if (raw === '') { parts.push(''); i++; continue; }
    const ind = raw.search(/\S/);
    if (ind <= baseIndent) break;
    if (scalarIndent < 0) scalarIndent = ind;
    parts.push(raw.slice(scalarIndent));
    i++;
  }
  // Trim trailing blank lines
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.join('\n') + '\n';
}

function _parseFlowSequence(str) {
  // "[a, b, c]" → ["a", "b", "c"]
  const inner = str.slice(1, str.lastIndexOf(']')).trim();
  if (inner === '') return [];
  return _splitFlowItems(inner).map(s => _parseValue(s.trim()));
}

function _parseFlowMapping(str) {
  // "{ k: v, k2: v2 }" → {k: v, k2: v2}
  const inner = str.slice(1, str.lastIndexOf('}')).trim();
  if (inner === '') return {};
  const obj = {};
  for (const part of _splitFlowItems(inner)) {
    const ci = part.indexOf(':');
    if (ci > 0) {
      const k = part.slice(0, ci).trim();
      const v = part.slice(ci + 1).trim();
      obj[k] = _parseValue(v);
    }
  }
  return obj;
}

function _splitFlowItems(str) {
  // Split by comma, respecting quotes
  const items = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inQuote) {
      current += ch;
      if (ch === quoteChar) inQuote = false;
    } else {
      if (ch === '"' || ch === "'") { inQuote = true; quoteChar = ch; current += ch; }
      else if (ch === '[' || ch === '{') { depth++; current += ch; }
      else if (ch === ']' || ch === '}') { depth--; current += ch; }
      else if (ch === ',' && depth === 0) { items.push(current); current = ''; }
      else { current += ch; }
    }
  }
  if (current.trim()) items.push(current);
  return items;
}

function _parseValue(str) {
  if (str === '' || str === 'null' || str === '~') return null;
  if (str === 'true') return true;
  if (str === 'false') return false;
  // Quoted string
  if ((str.startsWith('"') && str.endsWith('"')) ||
      (str.startsWith("'") && str.endsWith("'"))) {
    return str.slice(1, -1);
  }
  // Number
  if (/^-?\d+$/.test(str)) return parseInt(str, 10);
  if (/^-?\d+\.\d+$/.test(str)) return parseFloat(str);
  // Unquoted string (includes ISO 8601 timestamps)
  return str;
}


// ── YAML serializer ──────────────────────────────────────────────────────

/**
 * Serialize a JavaScript object to .frm.txt YAML format.
 */
export function serializeFRM(data) {
  let out = '# .frm.txt v0.2\n';

  const sectionOrder = [
    'session', 'datetime', 'location', 'conditions',
    'equipment', 'channels', 'files', 'annotations', 'notes'
  ];

  const sectionComments = {
    session: '--- SESSION IDENTITY ---',
    datetime: '--- TIME ---',
    location: '--- LOCATION ---',
    conditions: '--- CONDITIONS ---',
    equipment: '--- EQUIPMENT ---',
    channels: '--- CHANNEL ROUTING ---',
    files: '--- FILES ---',
    annotations: '--- ANNOTATIONS ---',
    notes: '--- NOTES ---'
  };

  // Output known sections in order, then any custom keys
  const outputKeys = new Set();
  for (const key of sectionOrder) {
    if (data[key] === undefined || data[key] === null) continue;
    if (_isEmpty(data[key])) continue;
    out += '\n';
    if (sectionComments[key]) out += `# ${sectionComments[key]}\n`;
    out += _serializeEntry(key, data[key], 0);
    outputKeys.add(key);
  }

  // Custom keys (x-* etc.)
  for (const key of Object.keys(data)) {
    if (outputKeys.has(key)) continue;
    out += '\n';
    out += _serializeEntry(key, data[key], 0);
  }

  return out;
}

function _isEmpty(val) {
  if (val === null || val === undefined || val === '') return true;
  if (Array.isArray(val)) return val.length === 0;
  if (typeof val === 'object') return Object.keys(val).length === 0;
  return false;
}

function _serializeEntry(key, value, indent) {
  const prefix = ' '.repeat(indent);

  if (key === 'notes' && typeof value === 'string') {
    // Block scalar
    const lines = value.replace(/\n+$/, '').split('\n');
    let out = `${prefix}${key}: |\n`;
    for (const line of lines) {
      out += `${prefix}  ${line}\n`;
    }
    return out;
  }

  if (Array.isArray(value)) {
    // Check if it's a simple array (all primitives) → flow style
    if (value.length > 0 && value.every(v => typeof v !== 'object' || v === null)) {
      const items = value.map(v => _serializeScalar(v));
      return `${prefix}${key}: [${items.join(', ')}]\n`;
    }
    // Complex array (objects) → block style
    let out = `${prefix}${key}:\n`;
    for (const item of value) {
      if (typeof item === 'object' && item !== null) {
        const entries = Object.entries(item);
        // Use flow style for small channel-like mappings
        if (entries.length <= 3 && entries.every(([, v]) => typeof v !== 'object')) {
          const parts = entries.map(([k, v]) => `${k}: ${_serializeScalar(v)}`);
          out += `${prefix}  - {${parts.join(', ')}}\n`;
        } else {
          // Block style
          const first = entries[0];
          out += `${prefix}  - ${first[0]}: ${_serializeScalar(first[1])}\n`;
          for (let i = 1; i < entries.length; i++) {
            const [ek, ev] = entries[i];
            if (typeof ev === 'object' && ev !== null && !Array.isArray(ev)) {
              out += `${prefix}    ${ek}:\n`;
              for (const [sk, sv] of Object.entries(ev)) {
                out += `${prefix}      ${sk}: ${_serializeScalar(sv)}\n`;
              }
            } else if (Array.isArray(ev)) {
              if (ev.every(v => typeof v !== 'object')) {
                out += `${prefix}    ${ek}: [${ev.map(v => _serializeScalar(v)).join(', ')}]\n`;
              }
            } else {
              out += `${prefix}    ${ek}: ${_serializeScalar(ev)}\n`;
            }
          }
        }
      } else {
        out += `${prefix}  - ${_serializeScalar(item)}\n`;
      }
    }
    return out;
  }

  if (typeof value === 'object' && value !== null) {
    // Check for channel-style integer-keyed flow mappings
    const entries = Object.entries(value);
    if (entries.length > 0 && entries.every(([k, v]) =>
        /^\d+$/.test(k) && typeof v === 'object' && v !== null && !Array.isArray(v) &&
        Object.values(v).every(sv => typeof sv !== 'object'))) {
      // Channels: "1: { label: ..., source: ... }"
      let out = `${prefix}${key}:\n`;
      for (const [ck, cv] of entries) {
        const parts = Object.entries(cv).map(([k2, v2]) => `${k2}: ${_serializeScalar(v2)}`);
        out += `${prefix}  ${ck}: {${parts.join(', ')}}\n`;
      }
      return out;
    }

    // Regular nested mapping
    let out = `${prefix}${key}:\n`;
    for (const [k, v] of entries) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'object' && !Array.isArray(v)) {
        out += _serializeEntry(k, v, indent + 2);
      } else if (Array.isArray(v)) {
        out += _serializeEntry(k, v, indent + 2);
      } else {
        out += `${prefix}  ${k}: ${_serializeScalar(v)}\n`;
      }
    }
    return out;
  }

  return `${prefix}${key}: ${_serializeScalar(value)}\n`;
}

function _serializeScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const str = String(value);
  // Quote if contains special chars, looks like a number, or is a YAML keyword
  if (/[:{}\[\],#&*!|>'"%@`]/.test(str) || /^\d/.test(str) ||
      ['true', 'false', 'null', 'yes', 'no', 'on', 'off'].includes(str.toLowerCase())) {
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return str;
}


// ── FRM ↔ App conversion utilities ───────────────────────────────────────

/**
 * Auto-populate a FRM data object from a Session's BWF metadata.
 */
export function autoPopulateFromSession(session) {
  const frm = {
    session: { title: '', tags: [] },
    datetime: {},
    location: {},
    conditions: {},
    equipment: { recorder: {}, microphones: [], setup: '', accessories: [] },
    channels: {},
    files: [],
    annotations: [],
    notes: ''
  };

  if (!session) return frm;

  // Equipment from format info
  frm.equipment.recorder.sample_rate = session.sampleRate;
  frm.equipment.recorder.bit_depth = session.format === 3 ? '32float' : session.bitsPerSample;
  frm.equipment.recorder.file_format = 'WAV';

  // Channel stubs
  for (let ch = 1; ch <= session.channels; ch++) {
    frm.channels[ch] = { label: `Ch ${ch}`, source: '' };
  }

  // Files with BWF timestamps
  for (const file of session.files) {
    const fileEntry = { filename: file.fileName };
    if (file.wallClockStart !== null && file.originationDate) {
      fileEntry.start = _wallClockToISO(file.originationDate, file.wallClockStart);
    }
    fileEntry.duration = _formatDuration(file.duration);
    frm.files.push(fileEntry);
  }

  // Datetime from BWF
  if (session.sessionStartTime !== null && session.sessionDate) {
    frm.datetime.start = _wallClockToISO(session.sessionDate, session.sessionStartTime);
    if (session.sessionEndTime !== null) {
      frm.datetime.end = _wallClockToISO(session.sessionDate, session.sessionEndTime);
    }
  }

  // Bext metadata from first file
  const firstBext = session.files[0]?.bext;
  if (firstBext) {
    if (firstBext.originator) frm.equipment.recorder.model = firstBext.originator;
  }

  return frm;
}

/**
 * Convert app annotations → FRM annotation format (wall-clock HH:MM:SS ranges).
 */
export function annotationsToFRM(appAnnotations, session) {
  if (!session) return [];
  return appAnnotations.map(ann => {
    const wallStart = session.toWallClock(ann.sessionStart);
    const wallEnd = session.toWallClock(ann.sessionEnd);
    const entry = { note: ann.note };

    if (wallStart !== null && wallEnd !== null) {
      const startStr = _secsToHMS(wallStart);
      const endStr = _secsToHMS(wallEnd);
      entry.range = `${startStr} - ${endStr}`;
    } else {
      // Fallback to session-relative times
      entry.range = `${_secsToHMS(ann.sessionStart)} - ${_secsToHMS(ann.sessionEnd)}`;
    }

    // Extract tags from note if bracketed, e.g. "[highlight] Wolf howl"
    const tagMatch = ann.note.match(/^\[([^\]]+)\]\s*/);
    if (tagMatch) {
      entry.tags = tagMatch[1].split(',').map(t => t.trim().toLowerCase());
      entry.note = ann.note.slice(tagMatch[0].length);
    }

    return entry;
  });
}

/**
 * Convert FRM annotations → app annotation format (session-relative seconds).
 */
export function annotationsFromFRM(frmAnnotations, session) {
  if (!session || !frmAnnotations) return [];
  const sessionDate = session.sessionDate;

  return frmAnnotations.map(frmAnn => {
    const { rangeStart, rangeEnd } = _parseRange(frmAnn.range);

    // Convert wall-clock HH:MM:SS to session time
    let sessionStart, sessionEnd;
    if (session.sessionStartTime !== null) {
      sessionStart = session.fromWallClock(rangeStart);
      sessionEnd = rangeEnd !== null ? session.fromWallClock(rangeEnd) : sessionStart + 1;
    } else {
      // No wall-clock — treat range times as session-relative
      sessionStart = rangeStart;
      sessionEnd = rangeEnd !== null ? rangeEnd : rangeStart + 1;
    }

    if (sessionStart === null || sessionEnd === null) return null;
    if (sessionEnd <= sessionStart) sessionEnd = sessionStart + 1;

    // Build note with tags prefix
    let note = frmAnn.note || 'untitled';
    if (frmAnn.tags && frmAnn.tags.length > 0) {
      note = `[${frmAnn.tags.join(', ')}] ${note}`;
    }

    // Build segment info
    const segments = [];
    for (const file of session.files) {
      const fileEnd = file.timeStart + file.duration;
      if (sessionStart >= fileEnd || sessionEnd <= file.timeStart) continue;
      const segStart = Math.max(sessionStart, file.timeStart);
      const segEnd = Math.min(sessionEnd, fileEnd);
      segments.push({
        fileName: file.fileName,
        filePath: file.filePath,
        startInFile: segStart - file.timeStart,
        endInFile: segEnd - file.timeStart,
        wallClockStart: file.wallClockStart !== null
          ? file.wallClockStart + (segStart - file.timeStart) : null,
        wallClockEnd: file.wallClockStart !== null
          ? file.wallClockStart + (segEnd - file.timeStart) : null,
        originationDate: file.originationDate
      });
    }

    return {
      note,
      sessionStart,
      sessionEnd,
      segments,
      wallClockStartISO: sessionDate ? _wallClockToISO(sessionDate, session.toWallClock(sessionStart)) : null,
      wallClockEndISO: sessionDate ? _wallClockToISO(sessionDate, session.toWallClock(sessionEnd)) : null
    };
  }).filter(Boolean);
}


// ── Helpers ──────────────────────────────────────────────────────────────

function _parseRange(rangeStr) {
  if (!rangeStr) return { rangeStart: 0, rangeEnd: null };
  const parts = rangeStr.split(/\s*-\s*/);
  const rangeStart = _hmsToSecs(parts[0].trim());
  const rangeEnd = parts.length > 1 ? _hmsToSecs(parts[1].trim()) : null;
  return { rangeStart, rangeEnd };
}

function _hmsToSecs(str) {
  const parts = str.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
  return parts[0] || 0;
}

function _secsToHMS(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function _wallClockToISO(dateStr, wallSecs) {
  const d = (dateStr || '2000-01-01').replace(/:/g, '-');
  let s = wallSecs;
  if (s >= 86400) s -= 86400;
  if (s < 0) s += 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function _formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
