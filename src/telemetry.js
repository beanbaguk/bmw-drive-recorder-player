import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { RecordingError } from './i18n.js';

const coordinate = value => typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) ? Number(value) : NaN;
const numeric = value => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;

function dateOrder(entries, requested) {
  if (requested === 'us' || requested === 'eu') return requested;
  let order;
  for (const { date } of entries) {
    const match = /^(\d{1,2})\/(\d{1,2})\/\d{4}$/.exec(date);
    if (!match) continue;
    const [, a, b] = match.map(Number);
    const found = a > 12 ? 'eu' : b > 12 ? 'us' : null;
    if (found && order && found !== order) throw new RecordingError('invalidTime');
    order ||= found;
  }
  if (!order && entries.some(({ date }) => {
    const match = /^(\d{1,2})\/(\d{1,2})\/\d{4}$/.exec(date);
    return match && Number(match[1]) !== Number(match[2]);
  })) throw new RecordingError('ambiguousDate');
  return order || 'us';
}

function clockValue(date, time, order) {
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(date);
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  let dd, mm, yyyy;
  if (dotted) [, dd, mm, yyyy] = dotted.map(Number);
  else if (slash) {
    const [, a, b, year] = slash.map(Number);
    [dd, mm, yyyy] = order === 'eu' ? [a, b, year] : [b, a, year];
  } else if (iso) [, yyyy, mm, dd] = iso.map(Number);
  else throw new RecordingError('invalidTime');
  const clock = /^(\d{1,2}):(\d{2}):(\d{2})(?:\s*([ap]m))?$/i.exec(time.trim());
  if (!clock) throw new RecordingError('invalidTime');
  let hh = Number(clock[1]);
  const min = Number(clock[2]), ss = Number(clock[3]), period = clock[4]?.toLowerCase();
  if (period) {
    if (hh < 1 || hh > 12) throw new RecordingError('invalidTime');
    hh = hh % 12 + (period === 'pm' ? 12 : 0);
  }
  // UTC arithmetic avoids a viewer's timezone/DST altering the recorded clock.
  const stamp = Date.UTC(yyyy, mm - 1, dd, hh, min, ss);
  const parsed = new Date(stamp);
  if (parsed.getUTCFullYear() !== yyyy || parsed.getUTCMonth() !== mm - 1 ||
      parsed.getUTCDate() !== dd || hh > 23 || min > 59 || ss > 59) throw new RecordingError('invalidTime');
  return stamp / 1000;
}

export function displayClock(sample, format = 'original') {
  if (format === 'original') return { date: sample.date, time: sample.time };
  const clock = new Date(sample.clock * 1000);
  const pad = n => String(n).padStart(2, '0');
  const day = pad(clock.getUTCDate()), month = pad(clock.getUTCMonth() + 1), year = clock.getUTCFullYear();
  const hour = clock.getUTCHours(), minutes = pad(clock.getUTCMinutes()), seconds = pad(clock.getUTCSeconds());
  return format === 'us'
    ? { date: `${month}/${day}/${year}`, time: `${pad(hour % 12 || 12)}:${minutes}:${seconds} ${hour < 12 ? 'AM' : 'PM'}` }
    : { date: `${day}.${month}.${year}`, time: `${pad(hour)}:${minutes}:${seconds}` };
}

export function displaySpeed(sample, unit = 'kmh') {
  return unit === 'mph' ? sample.mph ?? sample.velocity / 1.609344 : sample.velocity;
}

function validGps(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && (latitude !== 0 || longitude !== 0);
}

export async function readTelemetry(file, { sourceDateOrder = 'auto' } = {}) {
  if (file.size > 32 * 1024 * 1024) throw new RecordingError('metadataTooLarge');
  let root, isXml = /\.xml$/i.test(file.name ?? '');
  try {
    const text = await file.text();
    isXml ||= text.trimStart().startsWith('<');
    if (isXml) {
      if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw new Error();
      const parsed = new XMLParser({ parseTagValue: false, processEntities: false }).parse(text);
      const data = parsed.DATA;
      if (!data || !Array.isArray(data.LOG?.ENTRY)) throw new Error();
      root = { VIN: data.VIN, entries: data.LOG.ENTRY.map(entry => ({
        id: numeric(entry.ID), date: entry.DATE_UTC, time: entry.TIME_UTC,
        latitude: coordinate(entry.LATITUDE), longitude: coordinate(entry.LONGITUDE),
        ...(Object.hasOwn(entry, 'VELOCITY_KMH') ? { 'velocity_KM/H': numeric(entry.VELOCITY_KMH) } : {}),
        ...(Object.hasOwn(entry, 'VELOCITY_MPH') ? { 'velocity_MP/H': entry.VELOCITY_MPH } : {})
      })) };
    } else {
      const data = JSON.parse(text);
      if (!Array.isArray(data) || data.length !== 1) throw new Error();
      root = data[0];
    }
  } catch { throw new RecordingError('unreadableMetadata'); }
  if (!Array.isArray(root?.entries) || root.entries.length < 2) throw new RecordingError('unsupportedMetadata');
  if (root.entries.some(entry => !entry || typeof entry.date !== 'string' || typeof entry.time !== 'string')) {
    throw new RecordingError('invalidReading');
  }
  const order = dateOrder(root.entries, sourceDateOrder);
  let previousId = -Infinity, previousClock = -Infinity;
  const transitions = [], gps = [];
  const samples = root.entries.map((entry, index) => {
    const { id, date, time, latitude, longitude } = entry;
    const kmhKey = Object.hasOwn(entry, 'velocity_KM/H') ? 'velocity_KM/H' : 'velocity';
    const hasKmh = Object.hasOwn(entry, kmhKey), hasMph = Object.hasOwn(entry, 'velocity_MP/H');
    const mph = hasMph ? (typeof entry['velocity_MP/H'] === 'number' ? entry['velocity_MP/H'] : numeric(entry['velocity_MP/H'])) : null;
    const velocity = hasKmh ? entry[kmhKey] : mph === null ? NaN : mph * 1.609344;
    if (!Number.isSafeInteger(id) || id <= previousId || !Number.isFinite(velocity) || velocity < 0 ||
        (hasMph && (!Number.isFinite(mph) || mph < 0))) throw new RecordingError('invalidReading');
    previousId = id;
    const clock = clockValue(date, time, order);
    if (clock < previousClock) throw new RecordingError('reversedClock');
    if (clock !== previousClock && index > 0) transitions.push({ id, clock });
    previousClock = clock;
    const fix = validGps(latitude, longitude) ? { id, latitude, longitude } : null;
    const last = gps.at(-1);
    if (fix && (fix.latitude !== last?.latitude || fix.longitude !== last?.longitude)) gps.push(fix);
    return { id, date, time, clock, velocity, mph, fix };
  });
  const firstTransition = transitions[0], lastTransition = transitions.at(-1);
  const measuredRate = transitions.length > 1
    ? (lastTransition.id - firstTransition.id) / (lastTransition.clock - firstTransition.clock) : null;
  const sampleRate = measuredRate > 0 && Number.isFinite(measuredRate) ? measuredRate : null;
  const vin = typeof root.VIN === 'string' ? root.VIN.trim() : '';
  return { samples, gps, sampleRate, clockSpan: previousClock - samples[0].clock,
    utc: isXml, format: isXml ? 'xml' : 'json',
    vin: /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin) ? vin.toUpperCase() : null };
}

export function syncTelemetry(telemetry, duration) {
  const { samples, gps, sampleRate, clockSpan } = telemetry;
  const startId = samples[0].id;
  const idSpan = samples.at(-1).id - startId;
  if (Math.abs(clockSpan - duration) > Math.max(2, duration * 0.06) ||
      (sampleRate && Math.abs(idSpan / sampleRate - duration) > Math.max(2, duration * 0.06))) {
    throw new RecordingError('mismatchedDuration');
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
