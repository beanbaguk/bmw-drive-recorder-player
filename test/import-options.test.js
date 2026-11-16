import assert from 'node:assert/strict';
import test from 'node:test';
import { readTelemetry, syncTelemetry, displayClock, displaySpeed } from '../src/telemetry.js';
import { recordingFiles } from '../src/recording-files.js';
import { cleanText } from '../src/overlay.js';
const json = (entries, options) => readTelemetry(new Blob([JSON.stringify([{ entries }])]), options);
const sample = (id, date, time, speed = { 'velocity_MP/H': '67.14' }) => ({ id, date, time, ...speed });
const key = key => error => error.key === key;

test('US 12-hour clocks, source mph and European output preserve the same wall clock', async () => {
  const parsed = await json([sample(1, '11/29/2025', '01:32:11pm'), sample(31, '11/29/2025', '01:32:12 PM')]);
  const first = parsed.samples[0];
  assert.deepEqual(displayClock(first, 'eu'), { date: '29.11.2025', time: '13:32:11' });
  assert.deepEqual(displayClock(first, 'us'), { date: '11/29/2025', time: '01:32:11 PM' });
  assert.equal(displaySpeed(first, 'mph'), 67.14);
  assert.equal(displaySpeed(first, 'kmh'), 67.14 * 1.609344);
  const both = await json([sample(1, '29.11.2025', '13:32:11', { 'velocity_KM/H': 108.03, 'velocity_MP/H': '67.14' }), sample(31, '29.11.2025', '13:32:12', { velocity: 0 })]);
  assert.equal(displaySpeed(both.samples[0], 'kmh'), 108.03);
  assert.equal(displaySpeed(both.samples[0], 'mph'), 67.14);
  assert.equal(displaySpeed(both.samples[1], 'mph'), 0);
});

test('ambiguous slash dates need an explicit source order, independent of display format', async () => {
  const entries = [sample(1, '03/04/2026', '12:00:00am'), sample(31, '03/04/2026', '12:00:01am')];
  await assert.rejects(json(entries), key('ambiguousDate'));
  for (const [order, date] of [['us', '04.03.2026'], ['eu', '03.04.2026']]) {
    const parsed = await json(entries, { sourceDateOrder: order });
    assert.deepEqual(displayClock(parsed.samples[0], 'eu'), { date, time: '00:00:00' });
  }
});

test('midnight, noon, leap days, and US month/day order are validated without timezone conversion', async () => {
  const parsed = await json([sample(1, '12/31/2024', '11:59:59pm'), sample(31, '01/01/2025', '12:00:00am')]);
  assert.equal(parsed.clockSpan, 1);
  assert.deepEqual(displayClock(parsed.samples[1], 'us'), { date: '01/01/2025', time: '12:00:00 AM' });
  const leap = await json([sample(1, '02/29/2024', '12:00:00pm'), sample(31, '02/29/2024', '12:00:01pm')]);
  assert.equal(displayClock(leap.samples[0], 'eu').time, '12:00:00');
  for (const [date, time] of [['02/29/2025', '12:00:00pm'], ['29.02.2024', '00:00:00pm'], ['29.02.2024', '13:00:00am'], ['29.02.2024', '24:00:00'], ['29.02.2024', '12:60:00']]) {
    await assert.rejects(json([sample(1, date, time), sample(31, date, time)]), key('invalidTime'));
  }
});

const xml = entries => `<DATA><VIN>dummy</VIN><LOG>${entries.map(([id, time]) => `<ENTRY><ID>${id}</ID><DATE_UTC>14.08.2026</DATE_UTC><TIME_UTC>${time}</TIME_UTC><VELOCITY_KMH>24.92</VELOCITY_KMH><LATITUDE>50.001</LATITUDE><LONGITUDE>10.001</LONGITUDE></ENTRY>`).join('')}</LOG></DATA>`;
test('XML sparse IDs keep a 30 fps timeline rather than treating entries as consecutive frames', async () => {
  const parsed = await readTelemetry(new Blob([xml([[1, '12:38:42'], [16, '12:38:42'], [31, '12:38:43'], [61, '12:38:44'], [91, '12:38:45']])]));
  assert.equal(parsed.format, 'xml'); assert.equal(parsed.utc, true); assert.equal(parsed.vin, null);
  assert.equal(parsed.sampleRate, 30);
  const timeline = syncTelemetry(parsed, 3);
  assert.equal(timeline.at(0.5).id, 16);
  assert.equal(timeline.at(2).id, 61);
  assert.equal(timeline.at(0).id, 1);
  assert.equal(displaySpeed(timeline.at(1), 'mph'), 24.92 / 1.609344);
});

test('malformed XML, external entities, duplicate fields and malformed mph are rejected', async () => {
  for (const text of ['<DATA><LOG></DATA>', '<!DOCTYPE DATA [<!ENTITY x SYSTEM "file:///etc/passwd">]><DATA>&x;</DATA>', xml([[1, '12:38:42'], [31, '12:38:43']]).replace('<ID>1</ID>', '<ID>1</ID><ID>2</ID>')]) {
    await assert.rejects(readTelemetry(new Blob([text])));
  }
  for (const mph of ['', ' ', '67mph', 'Infinity', '-1', null, true]) {
    await assert.rejects(json([sample(1, '29.11.2025', '00:00:00', { 'velocity_MP/H': mph }), sample(2, '29.11.2025', '00:00:01')]), key('invalidReading'));
  }
});

const file = name => ({ name, size: 100 });
test('MP4/XML cameras are sorted, matched to one export and raw variants kept separate', () => {
  const group = recordingFiles(['Rechts', 'Vorn', 'Hinten', 'Links'].map(name => file(`sample_Kamera_${name}.mp4`)), file('sample.xml'));
  assert.deepEqual(group.cameras.map(camera => camera.position), ['front', 'rear', 'left', 'right']);
  assert.equal(recordingFiles([file('sample_Camera_Front_Raw.mp4')], file('sample.xml')).cameras[0].raw, true);
  for (const [videos, metadata, error] of [
    [['sample_Camera_Front.mp4', 'other_Camera_Rear.mp4'], 'sample.xml', 'mixedCameras'],
    [['sample_Camera_Front.mp4', 'sample_Kamera_Vorn.mp4'], 'sample.xml', 'mixedCameras'],
    [['sample_Camera_Front_Raw.mp4', 'sample_Camera_Rear.mp4'], 'sample.xml', 'mixedCameras'],
    [['sample_Camera_Front.mp4'], 'other.xml', 'mixedCameras'],
    [['sample.mp4'], 'sample.xml', 'unknownCamera'],
    [['sample.ts'], 'sample.xml', 'invalidPair'],
    [['sample_Camera_Front.mp4'], 'sample.json', 'invalidPair']
  ]) assert.throws(() => recordingFiles(videos.map(file), file(metadata)), key(error));
});

test('optional identity fields omit whitespace, remove controls and cap graphemes without splitting emoji', () => {
  assert.equal(cleanText(' \n\t ', 24), '');
  assert.equal(cleanText('  BMW   5 Series  ', 36), 'BMW 5 Series');
  assert.equal(cleanText('Nick\u202eABC\n', 24), 'NickABC');
  assert.equal(cleanText('👩‍👩‍👧‍👦'.repeat(25), 24), '👩‍👩‍👧‍👦'.repeat(24));
  assert.equal(cleanText('W'.repeat(100), 36).length, 36);
});
