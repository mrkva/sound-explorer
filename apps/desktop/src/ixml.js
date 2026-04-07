/**
 * iXML metadata builder and parser for BWF/WAV files.
 *
 * Builds iXML XML from a metadata object and parses iXML XML strings
 * back into structured metadata. Follows the iXML v2.10 spec with
 * LOCATION, TRACK_LIST, SYNC_POINT_LIST, USER, NOTE, and ASWG support.
 */

/**
 * Escape XML special characters.
 */
function escXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build an iXML XML string from a metadata object.
 *
 * @param {object} meta - Metadata object with optional keys:
 *   project, scene, tape, take, note, circled, file_uid,
 *   location: {name, gps, altitude, type, time},
 *   speed: {sample_rate, bit_depth, digitizer_sample_rate, timecode_rate, timecode_flag},
 *   tracks: [{channel_index, interleave_index, name, function}],
 *   annotations: [{offset_seconds, duration_seconds, comment}],
 *   sample_rate (used for annotation sample conversion),
 *   user_text, user_tags: {TAG: value},
 *   aswg: {TAG: value}
 * @returns {string} iXML XML string (UTF-8)
 */
export function buildIXML(meta) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<BWFXML>');
  lines.push('  <IXML_VERSION>2.10</IXML_VERSION>');

  // Simple top-level fields
  const simple = [
    ['PROJECT', 'project'], ['SCENE', 'scene'], ['TAPE', 'tape'],
    ['TAKE', 'take'], ['NOTE', 'note'], ['FILE_UID', 'file_uid'],
  ];
  for (const [tag, key] of simple) {
    if (meta[key]) lines.push(`  <${tag}>${escXml(meta[key])}</${tag}>`);
  }
  if (meta.circled) lines.push('  <CIRCLED>TRUE</CIRCLED>');

  // LOCATION
  const loc = meta.location;
  if (loc && (loc.name || loc.gps || loc.altitude)) {
    lines.push('  <LOCATION>');
    if (loc.name) lines.push(`    <LOCATION_NAME>${escXml(loc.name)}</LOCATION_NAME>`);
    if (loc.gps) lines.push(`    <LOCATION_GPS>${escXml(loc.gps)}</LOCATION_GPS>`);
    if (loc.altitude != null) lines.push(`    <LOCATION_ALTITUDE>${escXml(loc.altitude)}</LOCATION_ALTITUDE>`);
    if (loc.type) lines.push(`    <LOCATION_TYPE>${escXml(loc.type)}</LOCATION_TYPE>`);
    if (loc.time) lines.push(`    <LOCATION_TIME>${escXml(loc.time)}</LOCATION_TIME>`);
    lines.push('  </LOCATION>');
  }

  // SPEED
  const spd = meta.speed;
  if (spd && (spd.sample_rate || spd.bit_depth)) {
    lines.push('  <SPEED>');
    if (spd.sample_rate) lines.push(`    <FILE_SAMPLE_RATE>${spd.sample_rate}</FILE_SAMPLE_RATE>`);
    if (spd.bit_depth) lines.push(`    <AUDIO_BIT_DEPTH>${spd.bit_depth}</AUDIO_BIT_DEPTH>`);
    if (spd.digitizer_sample_rate) lines.push(`    <DIGITIZER_SAMPLE_RATE>${spd.digitizer_sample_rate}</DIGITIZER_SAMPLE_RATE>`);
    if (spd.timecode_rate) lines.push(`    <TIMECODE_RATE>${escXml(spd.timecode_rate)}</TIMECODE_RATE>`);
    if (spd.timecode_flag) lines.push(`    <TIMECODE_FLAG>${escXml(spd.timecode_flag)}</TIMECODE_FLAG>`);
    lines.push('  </SPEED>');
  }

  // TRACK_LIST
  const tracks = meta.tracks;
  if (tracks && tracks.length > 0) {
    lines.push('  <TRACK_LIST>');
    lines.push(`    <TRACK_COUNT>${tracks.length}</TRACK_COUNT>`);
    for (const t of tracks) {
      lines.push('    <TRACK>');
      lines.push(`      <CHANNEL_INDEX>${t.channel_index}</CHANNEL_INDEX>`);
      lines.push(`      <INTERLEAVE_INDEX>${t.interleave_index}</INTERLEAVE_INDEX>`);
      lines.push(`      <n>${escXml(t.name)}</n>`);
      if (t.function) lines.push(`      <FUNCTION>${escXml(t.function)}</FUNCTION>`);
      lines.push('    </TRACK>');
    }
    lines.push('  </TRACK_LIST>');
  }

  // SYNC_POINT_LIST (annotations)
  const annotations = meta.annotations;
  const sampleRate = meta.sample_rate || meta.speed?.sample_rate || 48000;
  if (annotations && annotations.length > 0) {
    lines.push('  <SYNC_POINT_LIST>');
    lines.push(`    <SYNC_POINT_COUNT>${annotations.length}</SYNC_POINT_COUNT>`);
    for (const a of annotations) {
      const sampleOffset = Math.round(a.offset_seconds * sampleRate);
      const durSamples = Math.round((a.duration_seconds || 0) * sampleRate);
      lines.push('    <SYNC_POINT>');
      lines.push('      <SYNC_POINT_TYPE>RELATIVE</SYNC_POINT_TYPE>');
      lines.push('      <SYNC_POINT_FUNCTION>CUSTOM</SYNC_POINT_FUNCTION>');
      lines.push(`      <SYNC_POINT_COMMENT>${escXml(a.comment)}</SYNC_POINT_COMMENT>`);
      lines.push(`      <SYNC_POINT_LOW>${sampleOffset}</SYNC_POINT_LOW>`);
      lines.push('      <SYNC_POINT_HIGH>0</SYNC_POINT_HIGH>');
      lines.push(`      <SYNC_POINT_EVENT_DURATION>${durSamples}</SYNC_POINT_EVENT_DURATION>`);
      lines.push('    </SYNC_POINT>');
    }
    lines.push('  </SYNC_POINT_LIST>');
  }

  // USER (mixed plain text + XML sub-tags)
  const userText = meta.user_text || '';
  const userTags = meta.user_tags || {};
  if (userText || Object.keys(userTags).length > 0) {
    lines.push('  <USER>');
    if (userText) {
      // Indent each line of user text
      for (const line of userText.split('\n')) {
        lines.push(escXml(line));
      }
    }
    for (const [tag, val] of Object.entries(userTags)) {
      lines.push(`    <${tag}>${escXml(val)}</${tag}>`);
    }
    lines.push('  </USER>');
  }

  // ASWG
  const aswg = meta.aswg || {};
  if (Object.keys(aswg).length > 0) {
    lines.push('  <ASWG>');
    for (const [tag, val] of Object.entries(aswg)) {
      lines.push(`    <${tag}>${escXml(val)}</${tag}>`);
    }
    lines.push('  </ASWG>');
  }

  lines.push('</BWFXML>');
  return lines.join('\n');
}

/**
 * Parse an iXML XML string into a structured metadata object.
 *
 * @param {string} xmlStr - Raw iXML XML string
 * @returns {object} Parsed metadata
 */
export function parseIXML(xmlStr) {
  const meta = {};

  // Use DOMParser (available in browser context)
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, 'text/xml');
  const root = doc.documentElement; // <BWFXML>

  const text = (tag, parent) => {
    const el = (parent || root).querySelector(tag);
    return el ? (el.textContent || '').trim() : '';
  };

  // Simple fields
  meta.project = text('PROJECT') || '';
  meta.scene = text('SCENE') || '';
  meta.tape = text('TAPE') || '';
  meta.take = text('TAKE') || '';
  meta.note = text('NOTE') || '';
  meta.file_uid = text('FILE_UID') || '';
  meta.circled = text('CIRCLED').toUpperCase() === 'TRUE';

  // LOCATION
  const locEl = root.querySelector('LOCATION');
  if (locEl) {
    meta.location = {
      name: text('LOCATION_NAME', locEl),
      gps: text('LOCATION_GPS', locEl),
      altitude: text('LOCATION_ALTITUDE', locEl),
      type: text('LOCATION_TYPE', locEl),
      time: text('LOCATION_TIME', locEl),
    };
  }

  // SPEED
  const speedEl = root.querySelector('SPEED');
  if (speedEl) {
    meta.speed = {
      sample_rate: parseInt(text('FILE_SAMPLE_RATE', speedEl)) || 0,
      bit_depth: parseInt(text('AUDIO_BIT_DEPTH', speedEl)) || 0,
      digitizer_sample_rate: parseInt(text('DIGITIZER_SAMPLE_RATE', speedEl)) || 0,
      timecode_rate: text('TIMECODE_RATE', speedEl),
      timecode_flag: text('TIMECODE_FLAG', speedEl),
    };
  }

  // TRACK_LIST
  const trackListEl = root.querySelector('TRACK_LIST');
  if (trackListEl) {
    meta.tracks = [];
    for (const trackEl of trackListEl.querySelectorAll('TRACK')) {
      meta.tracks.push({
        channel_index: parseInt(text('CHANNEL_INDEX', trackEl)) || 0,
        interleave_index: parseInt(text('INTERLEAVE_INDEX', trackEl)) || 0,
        name: text('n', trackEl),
        function: text('FUNCTION', trackEl),
      });
    }
  }

  // SYNC_POINT_LIST
  const splEl = root.querySelector('SYNC_POINT_LIST');
  const sampleRate = meta.speed?.sample_rate || 48000;
  if (splEl) {
    meta.annotations = [];
    for (const spEl of splEl.querySelectorAll('SYNC_POINT')) {
      const low = parseInt(text('SYNC_POINT_LOW', spEl)) || 0;
      const high = parseInt(text('SYNC_POINT_HIGH', spEl)) || 0;
      const sampleOffset = high * 0x100000000 + low;
      const durSamples = parseInt(text('SYNC_POINT_EVENT_DURATION', spEl)) || 0;
      meta.annotations.push({
        type: text('SYNC_POINT_TYPE', spEl) || 'RELATIVE',
        function: text('SYNC_POINT_FUNCTION', spEl),
        comment: text('SYNC_POINT_COMMENT', spEl),
        offset_seconds: sampleOffset / sampleRate,
        duration_seconds: durSamples / sampleRate,
        sample_offset: sampleOffset,
        sample_duration: durSamples,
      });
    }
  }

  // USER — parse both plain text key:value pairs and XML sub-tags
  const userEl = root.querySelector('USER');
  if (userEl) {
    // Get raw text content (excluding child element text)
    let plainText = '';
    for (const node of userEl.childNodes) {
      if (node.nodeType === 3) { // TEXT_NODE
        plainText += node.textContent;
      }
    }
    meta.user_text = plainText.trim();

    // Parse key:value pairs from plain text
    meta.user_data = {};
    for (const line of meta.user_text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && trimmed.includes(': ') && !trimmed.startsWith('<')) {
        const idx = trimmed.indexOf(': ');
        meta.user_data[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 2).trim();
      }
    }

    // XML sub-tags
    meta.user_tags = {};
    for (const child of userEl.children) {
      meta.user_tags[child.tagName] = (child.textContent || '').trim();
    }
  }

  // ASWG
  const aswgEl = root.querySelector('ASWG');
  if (aswgEl) {
    meta.aswg = {};
    for (const child of aswgEl.children) {
      meta.aswg[child.tagName] = (child.textContent || '').trim();
    }
  }

  return meta;
}

/**
 * Convert app annotations array to iXML SYNC_POINT annotation format.
 *
 * @param {Array} annotations - App annotations [{start, end, note}] in session-relative seconds
 * @returns {Array} iXML annotations [{offset_seconds, duration_seconds, comment}]
 */
export function annotationsToSyncPoints(annotations) {
  return annotations.map(a => ({
    offset_seconds: a.start,
    duration_seconds: (a.end != null && a.end > a.start) ? a.end - a.start : 0,
    comment: a.note || '',
  }));
}

/**
 * Convert iXML SYNC_POINT annotations to app annotation format.
 *
 * @param {Array} syncPoints - [{offset_seconds, duration_seconds, comment}]
 * @returns {Array} App annotations [{start, end, note}]
 */
export function syncPointsToAnnotations(syncPoints) {
  return syncPoints.map(sp => ({
    start: sp.offset_seconds,
    end: sp.duration_seconds > 0 ? sp.offset_seconds + sp.duration_seconds : sp.offset_seconds,
    note: sp.comment || '',
  }));
}

/**
 * Build a complete iXML metadata object from the FRM form data structure.
 * Maps the UI form fields into the iXML metadata shape.
 *
 * @param {object} formData - Data from _readFRMForm() or equivalent
 * @param {object} session - Session object with sampleRate, channels, etc.
 * @param {Array} appAnnotations - App annotation array [{start, end, note}]
 * @returns {object} iXML metadata object ready for buildIXML()
 */
export function formDataToIXML(formData, session, appAnnotations) {
  const s = formData.session || {};
  const loc = formData.location || {};
  const cond = formData.conditions || {};
  const eq = formData.equipment || {};
  const rec = eq.recorder || {};

  const sampleRate = session?.sampleRate || rec.sample_rate || 48000;

  const meta = {};

  // Session identity
  if (s.project) meta.project = s.project;
  if (s.title) meta.scene = s.title; // Map title → scene (session identifier)
  if (formData.datetime?.start) {
    // Extract date as tape identifier
    const dateMatch = formData.datetime.start.match(/\d{4}-?\d{2}-?\d{2}/);
    if (dateMatch) meta.tape = dateMatch[0].replace(/-/g, '');
  }

  // NOTE — combine notes, conditions, and environment info
  const noteLines = [];
  if (formData.notes) noteLines.push(formData.notes.trim());
  if (cond.weather) noteLines.push(`Weather: ${cond.weather}${cond.temperature_c != null ? `, ${cond.temperature_c}°C` : ''}${cond.humidity_pct != null ? `, humidity ${cond.humidity_pct}%` : ''}${cond.wind ? `, ${cond.wind}` : ''}`);
  if (cond.noise_floor) noteLines.push(`Noise floor: ${cond.noise_floor}`);
  if (noteLines.length > 0) meta.note = noteLines.join('\n');

  // LOCATION
  if (loc.name || loc.latitude != null || loc.elevation_m != null) {
    meta.location = {};
    const locName = [loc.name, loc.region].filter(Boolean).join(', ');
    if (locName) meta.location.name = locName;
    if (loc.latitude != null && loc.longitude != null) {
      meta.location.gps = `${loc.latitude}, ${loc.longitude}`;
    }
    if (loc.elevation_m != null) meta.location.altitude = String(loc.elevation_m);
  }

  // SPEED
  meta.speed = {
    sample_rate: sampleRate,
    bit_depth: session?.bitsPerSample || rec.bit_depth || 0,
  };
  meta.sample_rate = sampleRate;

  // TRACK_LIST from channels
  const channels = formData.channels || {};
  if (Object.keys(channels).length > 0) {
    meta.tracks = Object.entries(channels).map(([num, ch]) => ({
      channel_index: parseInt(num),
      interleave_index: parseInt(num),
      name: ch.label || `Ch ${num}`,
      function: ch.source || '',
    }));
  }

  // Annotations → SYNC_POINTs
  if (appAnnotations && appAnnotations.length > 0) {
    meta.annotations = annotationsToSyncPoints(appAnnotations);
  }

  // USER plain text — build key:value block
  const userLines = [];
  if (s.recordist) userLines.push(`Recordist: ${s.recordist}`);
  if (s.license) userLines.push(`License: ${s.license}`);
  if (rec.model) userLines.push(`Recorder: ${rec.model}`);

  // Microphone summary
  const mics = eq.microphones || [];
  if (mics.length > 0) {
    const micDesc = mics.map(m => {
      let desc = m.model || m.id || '';
      if (m.id && m.model) desc = `${m.model} (${m.id})`;
      if (m.type) desc += `, ${m.type}`;
      return desc;
    }).join('; ');
    userLines.push(`Microphones: ${micDesc}`);
  }

  if (eq.setup) userLines.push(`Setup: ${eq.setup}`);
  if (rec.gain_db != null) {
    const g = Array.isArray(rec.gain_db) ? rec.gain_db.map(v => `${v}dB`).join(', ') : `${rec.gain_db}dB`;
    userLines.push(`Gain: ${g}`);
  }
  if (rec.limiter != null) userLines.push(`Limiter: ${rec.limiter ? 'on' : 'off'}`);
  if (rec.highpass_hz != null) userLines.push(`Highpass: ${rec.highpass_hz === false ? 'off' : rec.highpass_hz + 'Hz'}`);
  if (loc.environment) userLines.push(`Environment: ${loc.environment}`);
  if (s.tags && s.tags.length > 0) userLines.push(`Tags: ${s.tags.join(', ')}`);

  if (userLines.length > 0) meta.user_text = userLines.join('\n');

  // USER XML sub-tags
  const userTags = {};
  if (s.recordist) userTags.SOUND_MIXER_NAME = s.recordist;
  if (rec.model) userTags.AUDIO_RECORDER_MODEL = rec.model;
  if (Object.keys(userTags).length > 0) meta.user_tags = userTags;

  // ASWG
  const aswg = {};
  if (meta.note) aswg.ASWG_TEXT_DESCRIPTION = meta.note.split('\n')[0];
  if (s.tags && s.tags.length > 0) aswg.ASWG_TEXT_KEYWORDS = s.tags.join(', ');
  if (loc.environment) aswg.ASWG_TEXT_LOCATION = loc.environment;
  if (loc.region) {
    const parts = loc.region.split(',').map(p => p.trim());
    if (parts.length >= 2) aswg.ASWG_TEXT_COUNTRY = parts[parts.length - 1];
  }
  if (mics.length > 0) aswg.ASWG_TEXT_MICROPHONE = mics.map(m => m.model || m.id).filter(Boolean).join(', ');
  if (s.recordist) aswg.ASWG_TEXT_RECORDIST = s.recordist;
  if (s.license) aswg.ASWG_PROJECT_USAGE_RIGHTS = s.license;
  if (Object.keys(aswg).length > 0) meta.aswg = aswg;

  return meta;
}

/**
 * Convert parsed iXML metadata back into FRM form data structure
 * for populating the UI form.
 *
 * @param {object} ixmlMeta - Parsed iXML metadata from parseIXML()
 * @returns {object} FRM form data structure
 */
export function ixmlToFormData(ixmlMeta) {
  const data = {};
  const ud = ixmlMeta.user_data || {};

  // Session
  const session = {};
  if (ixmlMeta.project) session.project = ixmlMeta.project;
  if (ixmlMeta.scene) session.title = ixmlMeta.scene;
  if (ud.Recordist) session.recordist = ud.Recordist;
  else if (ixmlMeta.user_tags?.SOUND_MIXER_NAME) session.recordist = ixmlMeta.user_tags.SOUND_MIXER_NAME;
  if (ud.License) session.license = ud.License;
  else if (ixmlMeta.aswg?.ASWG_PROJECT_USAGE_RIGHTS) session.license = ixmlMeta.aswg.ASWG_PROJECT_USAGE_RIGHTS;
  if (ud.Tags) session.tags = ud.Tags.split(',').map(t => t.trim()).filter(Boolean);
  else if (ixmlMeta.aswg?.ASWG_TEXT_KEYWORDS) session.tags = ixmlMeta.aswg.ASWG_TEXT_KEYWORDS.split(',').map(t => t.trim()).filter(Boolean);
  if (Object.keys(session).length) data.session = session;

  // Location
  const locSrc = ixmlMeta.location;
  if (locSrc) {
    const loc = {};
    if (locSrc.name) {
      // Try to split "Name, Region" format
      const parts = locSrc.name.split(',').map(p => p.trim());
      if (parts.length >= 3) {
        loc.name = parts.slice(0, -1).join(', ');
        loc.region = parts.slice(-1)[0];
      } else {
        loc.name = locSrc.name;
      }
    }
    if (locSrc.gps) {
      const gpsParts = locSrc.gps.split(',').map(p => parseFloat(p.trim()));
      if (gpsParts.length >= 2 && !isNaN(gpsParts[0]) && !isNaN(gpsParts[1])) {
        loc.latitude = gpsParts[0];
        loc.longitude = gpsParts[1];
      }
    }
    if (locSrc.altitude) loc.elevation_m = parseFloat(locSrc.altitude);
    if (ud.Environment) loc.environment = ud.Environment;
    else if (ixmlMeta.aswg?.ASWG_TEXT_LOCATION) loc.environment = ixmlMeta.aswg.ASWG_TEXT_LOCATION;
    if (Object.keys(loc).length) data.location = loc;
  }

  // Conditions — parse from NOTE if present
  if (ixmlMeta.note) {
    const cond = {};
    const noteLines = ixmlMeta.note.split('\n');
    for (const line of noteLines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('Weather:')) {
        const weatherStr = trimmed.slice(8).trim();
        // Try to extract temp, humidity from weather line
        const tempMatch = weatherStr.match(/(\d+)\s*°C/);
        const humMatch = weatherStr.match(/humidity\s+(\d+)%/i);
        const windMatch = weatherStr.match(/(?:wind|calm|breeze)[^,.]*/i);
        // Remove extracted parts for weather string
        let weather = weatherStr;
        if (tempMatch) cond.temperature_c = parseFloat(tempMatch[1]);
        if (humMatch) cond.humidity_pct = parseFloat(humMatch[1]);
        if (windMatch) cond.wind = windMatch[0].trim();
        // Clean up weather string
        weather = weather.replace(/,?\s*\d+\s*°C/, '').replace(/,?\s*humidity\s+\d+%/i, '').replace(/,?\s*(?:calm|wind|breeze)[^,.]*/i, '').replace(/,\s*$/, '').trim();
        if (weather) cond.weather = weather;
      } else if (trimmed.startsWith('Noise floor:')) {
        cond.noise_floor = trimmed.slice(12).trim();
      }
    }
    if (Object.keys(cond).length) data.conditions = cond;
  }

  // Equipment
  const eq = {};
  const rec = {};
  if (ud.Recorder) rec.model = ud.Recorder;
  else if (ixmlMeta.user_tags?.AUDIO_RECORDER_MODEL) rec.model = ixmlMeta.user_tags.AUDIO_RECORDER_MODEL;
  if (ixmlMeta.speed?.sample_rate) rec.sample_rate = ixmlMeta.speed.sample_rate;
  if (ixmlMeta.speed?.bit_depth) rec.bit_depth = ixmlMeta.speed.bit_depth;

  if (ud.Gain) {
    const gains = ud.Gain.replace(/dB/gi, '').split(',').map(g => parseFloat(g.trim())).filter(g => !isNaN(g));
    rec.gain_db = gains.length === 1 ? gains[0] : gains;
  }
  if (ud.Highpass) rec.highpass_hz = ud.Highpass.toLowerCase() === 'off' ? false : parseFloat(ud.Highpass);
  if (ud.Limiter) rec.limiter = ud.Limiter.toLowerCase() === 'on';
  if (Object.keys(rec).length) eq.recorder = rec;

  if (ud.Setup) eq.setup = ud.Setup;
  if (ud.Microphones) {
    // Parse microphone string into structured entries
    const micParts = ud.Microphones.split(';').map(p => p.trim()).filter(Boolean);
    eq.microphones = micParts.map(part => {
      const idMatch = part.match(/\(([^)]+)\)/);
      const typeMatch = part.match(/,\s*([^,(]+)$/);
      let model = part;
      if (typeMatch) model = model.replace(typeMatch[0], '').trim();
      if (idMatch) model = model.replace(idMatch[0], '').trim();
      const mic = {};
      if (model) mic.model = model;
      if (idMatch) mic.id = idMatch[1];
      if (typeMatch) mic.type = typeMatch[1].trim();
      return mic;
    });
  }
  if (Object.keys(eq).length) data.equipment = eq;

  // Tracks → Channels
  if (ixmlMeta.tracks && ixmlMeta.tracks.length > 0) {
    const channels = {};
    for (const t of ixmlMeta.tracks) {
      channels[String(t.interleave_index)] = {
        label: t.name || '',
        source: t.function || '',
      };
    }
    data.channels = channels;
  }

  // Notes — use NOTE content, excluding Weather/Noise floor lines already parsed
  if (ixmlMeta.note) {
    const noteLines = ixmlMeta.note.split('\n')
      .filter(l => !l.trim().startsWith('Weather:') && !l.trim().startsWith('Noise floor:'))
      .join('\n').trim();
    if (noteLines) data.notes = noteLines + '\n';
  }

  return data;
}
