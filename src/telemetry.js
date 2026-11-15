const clockPattern = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;

function clockValue(date, time) {
  const match = clockPattern.exec(date + ' ' + time);
  if (!match) throw new Error('The metadata has an invalid date or time.');
  const [, dd, mm, yyyy, hh, min, ss] = match.map(Number);
  // UTC is only used for arithmetic. The video displays the BMW clock verbatim.
  const stamp = Date.UTC(yyyy, mm - 1, dd, hh, min, ss);
  const parsed = new Date(stamp);
  if (parsed.getUTCFullYear() !== yyyy || parsed.getUTCMonth() !== mm - 1 ||
      parsed.getUTCDate() !== dd || hh > 23 || min > 59 || ss > 59) {
    throw new Error('The metadata has an invalid date or time.');
  }
  return stamp / 1000;
}

function validGps(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && (latitude !== 0 || longitude !== 0);
}

export async function readTelemetry(file) {
  if (file.size > 32 * 1024 * 1024) throw new Error('The metadata file is too large for this player.');
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('Choose a readable BMW Metadata.json file.');
  }
  if (!Array.isArray(data) || data.length !== 1 || !Array.isArray(data[0]?.entries) ||
      data[0].entries.length < 2) {
    throw new Error('This JSON does not contain a supported BMW Drive Recorder recording.');
  }

  let previousId = -Infinity;
  let previousClock = -Infinity;
  let clockKey = '';
  const transitions = [];
  const gps = [];
  const samples = data[0].entries.map((entry, index) => {
    const { id, date, time, velocity, latitude, longitude } = entry ?? {};
    if (!Number.isSafeInteger(id) || id <= previousId || typeof date !== 'string' ||
        typeof time !== 'string' || !Number.isFinite(velocity) || velocity < 0) {
      throw new Error('The metadata has a missing or invalid recording sample.');
    }
    previousId = id;
    const key = date + ' ' + time;
    if (key !== clockKey) {
      const clock = clockValue(date, time);
      if (clock < previousClock) throw new Error('The recording clock moves backwards in this file.');
      if (index > 0) transitions.push({ id, clock });
      previousClock = clock;
      clockKey = key;
    }
    const fix = validGps(latitude, longitude) ? { id, latitude, longitude } : null;
    const last = gps.at(-1);
    if (fix && (fix.latitude !== last?.latitude || fix.longitude !== last?.longitude)) gps.push(fix);
    return { id, date, time, velocity, fix };
  });

  const firstClock = clockValue(samples[0].date, samples[0].time);
  const lastTransition = transitions.at(-1);
  const firstTransition = transitions[0];
  const measuredRate = transitions.length > 1
    ? (lastTransition.id - firstTransition.id) / (lastTransition.clock - firstTransition.clock)
    : null;
  const sampleRate = measuredRate > 0 && Number.isFinite(measuredRate) ? measuredRate : null;
  const rawVin = data[0].VIN;
  const vin = typeof rawVin === 'string' ? rawVin.trim() : '';
  return {
    samples, gps, sampleRate, clockSpan: previousClock - firstClock,
    vin: /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin) ? vin.toUpperCase() : null
  };
}

export function syncTelemetry(telemetry, duration) {
  const { samples, gps, sampleRate, clockSpan } = telemetry;
  const startId = samples[0].id;
  const idSpan = samples.at(-1).id - startId;
  if (Math.abs(clockSpan - duration) > Math.max(2, duration * 0.06) ||
      (sampleRate && Math.abs(idSpan / sampleRate - duration) > Math.max(2, duration * 0.06))) {
    throw new Error('The video and metadata have different recording lengths. Choose files from the same export.');
  }
  const rate = sampleRate ?? idSpan / duration;
  const points = gps.map(fix => ({ ...fix, offset: (fix.id - startId) / rate }));
  let index = 0;
  let nextFix = 0;

  return {
    points,
    at(seconds) {
      const id = startId + Math.max(0, seconds) * rate;
      if (samples[index].id > id) index = 0;
      while (index + 1 < samples.length && samples[index + 1].id <= id + 1e-6) index++;
      if (nextFix > 0 && points[nextFix - 1].offset > seconds) nextFix = 0;
      while (nextFix < points.length && points[nextFix].offset <= seconds + 1e-6) nextFix++;
      const sample = samples[index];
      const from = points[nextFix - 1];
      const to = points[nextFix];
      if (!sample.fix || !from) return { ...sample, fix: null };
      if (!to || to.offset - from.offset > 2.5) return { ...sample, fix: sample.fix };

      const fraction = Math.max(0, (seconds - from.offset) / (to.offset - from.offset));
      const delta = ((to.longitude - from.longitude + 540) % 360) - 180;
      const longitude = ((from.longitude + delta * fraction + 540) % 360) - 180;
      return {
        ...sample,
        fix: { latitude: from.latitude + (to.latitude - from.latitude) * fraction, longitude }
      };
    }
  };
}
