import assert from 'node:assert/strict';
import test from 'node:test';
import { readTelemetry, syncTelemetry } from '../src/telemetry.js';

// Synthetic readings only: no owner's VIN, route, or recording is stored here.
const testVin = 'WBA00000000000000';
function recording(format = 'legacy', vin = testVin) {
  return [{
    VIN: vin,
    entries: Array.from({ length: 91 }, (_, index) => ({
      id: index + 1,
      date: '01.01.2026',
      time: `12:00:0${Math.floor(index / 30)}`,
      latitude: 50 + index * 0.00001,
      longitude: 10 + index * 0.00001,
      ...(format === 'legacy'
        ? { velocity: index === 0 ? 0 : 30.3 }
        : { 'velocity_KM/H': index === 0 ? 0 : 30.3, 'velocity_MP/H': index === 0 ? '0.00' : '18.83' })
    }))
  }];
}

function read(data) {
  return readTelemetry(new Blob([JSON.stringify(data)]));
}

function errorKey(key) {
  return error => error.key === key;
}

test('iDrive 7 retains km/h speed, VIN, GPS, and clock timing', async () => {
  const data = await read(recording());
  assert.equal(data.vin, testVin);
  assert.equal(data.samples.length, 91);
  assert.equal(data.samples[0].velocity, 0);
  assert.equal(data.samples[1].velocity, 30.3);
  assert.equal(data.sampleRate, 30);
  assert.equal(data.clockSpan, 3);
  const synced = syncTelemetry(data, 3);
  assert.equal(synced.at(1).time, '12:00:01');
  assert.equal(synced.at(3).id, 91);
  assert.equal(synced.at(0).id, 1); // Seeking backwards still works.
  assert.deepEqual(synced.at(0).fix, { latitude: 50, longitude: 10 });
});

test('iDrive 8.5 uses km/h rather than the rounded mph string and allows a blank VIN', async () => {
  const modern = await read(recording('modern', ''));
  const legacy = await read(recording());
  assert.equal(modern.vin, null);
  assert.deepEqual(modern.samples.map(({ mph, ...rest }) => rest), legacy.samples.map(({ mph, ...rest }) => rest));
  assert.equal(modern.samples[1].mph, 18.83);
  assert.deepEqual(modern.gps, legacy.gps);
  assert.equal(modern.sampleRate, 30);
  // Telemetry cadence is independent of the video's frame rate.
  assert.equal(syncTelemetry(modern, 3).at(1 / 15).id, 3);
});

test('the explicitly labelled km/h field wins when both fields are present, including zero', async () => {
  const data = recording('modern');
  for (const entry of data[0].entries) entry.velocity = 99;
  const parsed = await read(data);
  assert.equal(parsed.samples[0].velocity, 0);
  assert.equal(parsed.samples[1].velocity, 30.3);
});

test('VIN is optional in both supported formats', async () => {
  for (const format of ['legacy', 'modern']) {
    for (const vin of [undefined, null, '', '   ', 123, 'invalid', 'IIIIIIIIIIIIIIIII']) {
      const data = recording(format);
      if (vin === undefined) delete data[0].VIN;
      else data[0].VIN = vin;
      const parsed = await read(data);
      assert.equal(parsed.vin, null);
      assert.equal(syncTelemetry(parsed, 3).at(2).velocity, 30.3);
    }
    assert.equal((await read(recording(format, ` ${testVin.toLowerCase()} `))).vin, testVin);
  }
});

test('missing or malformed speed is still rejected for both formats', async () => {
  for (const format of ['legacy', 'modern']) {
    const field = format === 'legacy' ? 'velocity' : 'velocity_KM/H';
    for (const value of [undefined, null, '', '30.3', -1, true, {}]) {
      if (format === 'modern' && value === undefined) continue; // A missing km/h field now falls back to mph.
      const data = recording(format);
      data[0].entries[1][field] = value;
      await assert.rejects(read(data), errorKey('invalidReading'));
    }
  }
  const data = recording('modern');
  data[0].entries[1].velocity = 30.3;
  data[0].entries[1]['velocity_KM/H'] = null;
  await assert.rejects(read(data), errorKey('invalidReading'));
});

test('duplicate IDs and invalid or reversed clocks remain rejected', async () => {
  for (const format of ['legacy', 'modern']) {
    const duplicate = recording(format);
    duplicate[0].entries[1].id = 1;
    await assert.rejects(read(duplicate), errorKey('invalidReading'));
    const invalidDate = recording(format);
    invalidDate[0].entries[1].date = '31.02.2026';
    await assert.rejects(read(invalidDate), errorKey('invalidTime'));
    const reversed = recording(format);
    reversed[0].entries[31].time = '12:00:00';
    await assert.rejects(read(reversed), errorKey('reversedClock'));
  }
});

test('both formats continue rejecting mismatched video and metadata durations', async () => {
  for (const format of ['legacy', 'modern']) {
    const data = await read(recording(format));
    assert.throws(() => syncTelemetry(data, 40.2), errorKey('mismatchedDuration'));
  }
});

test('unavailable GPS does not prevent conversion in either format', async () => {
  for (const format of ['legacy', 'modern']) {
    const data = recording(format, '');
    for (const entry of data[0].entries) entry.latitude = entry.longitude = 0;
    const parsed = await read(data);
    const synced = syncTelemetry(parsed, 3);
    assert.deepEqual(synced.points, []);
    assert.equal(synced.at(1).fix, null);
    assert.equal(synced.at(1).velocity, 30.3);
  }
});
