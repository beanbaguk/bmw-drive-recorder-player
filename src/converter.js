import { BlobSource, BufferTarget, Conversion, Input, MPEG_TS, Mp4OutputFormat, Output, QUALITY_HIGH, VideoSampleSink, canEncodeVideo } from 'mediabunny';
import { readTelemetry, syncTelemetry } from './telemetry.js';
import { buildRouteMap } from './road-map.js';
import { messagesFor, RecordingError } from './i18n.js';

function openVideo(file) {
  return new Input({ source: new BlobSource(file), formats: [MPEG_TS] });
}

function panelDimensions(width, height) {
  const panel = Math.max(260, Math.round(height * 0.29 / 2) * 2);
  return { panel, width: Math.ceil((width + panel) / 2) * 2, height: Math.ceil(height / 2) * 2 };
}

export async function inspectRecording(video, metadata) {
  const input = openVideo(video);
  try {
    let track;
    let duration;
    let width;
    let height;
    let start;
    try {
      track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error();
      const end = await track.computeDuration();
      start = await track.getFirstTimestamp();
      duration = end - start;
      [width, height] = await Promise.all([track.getDisplayWidth(), track.getDisplayHeight()]);
      if (!Number.isFinite(duration) || duration <= 0 || width <= 0 || height <= 0) throw new Error();
    } catch {
      throw new RecordingError('invalidVideo');
    }

    const telemetry = await readTelemetry(metadata);
    const synchronized = syncTelemetry(telemetry, duration);
    if (!self.isSecureContext || typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
      throw new RecordingError('needsEncoding');
    }
    let hardwareAcceleration;
    for (const mode of ['prefer-software', 'no-preference']) {
      try {
        const frame = await new VideoSampleSink(track, { hardwareAcceleration: mode }).getSample(start);
        if (!frame) continue;
        frame.close();
        hardwareAcceleration = mode;
        break;
      } catch {
        // Some BMW streams are supported only by the browser's software decoder.
      }
    }
    if (!hardwareAcceleration) {
      throw new RecordingError('failedDecode');
    }
    const output = panelDimensions(width, height);
    if (!await canEncodeVideo('avc', { width: output.width, height: output.height, bitrate: QUALITY_HIGH })) {
      throw new RecordingError('unsupportedSize');
    }
    return {
      duration, width, height, sampleCount: telemetry.samples.length, hardwareAcceleration,
      hasGps: synchronized.points.length > 0,
      hasVin: telemetry.vin !== null
    };
  } finally {
    input.dispose();
  }
}

function drawTelemetry(ctx, layout, map, sample, vin, messages) {
  const { width, height, panel } = layout;
  const left = width - panel;
  const pad = 18;
  const x = left + pad;
  const s = Math.min(1.42, height / 650);
  const label = (text, baseline) => {
    ctx.fillStyle = '#a9bad0';
    ctx.font = `600 ${Math.max(11, 13 * s)}px sans-serif`;
    ctx.fillText(text, x, baseline, panel - 2 * pad);
  };
  const value = (text, baseline, size, color = '#f3f7fe') => {
    ctx.fillStyle = color;
    ctx.font = `600 ${Math.max(13, size * s)}px sans-serif`;
    ctx.fillText(text, x, baseline, panel - 2 * pad);
  };

  ctx.fillStyle = '#101d30';
  ctx.fillRect(left, 0, panel, height);
  ctx.fillStyle = '#203653';
  ctx.fillRect(left, 0, 2, height);
  value('Drive Recorder', height * 0.084, 22);
  if (vin) value(`VIN ${vin}`, height * 0.136, 14, '#c4d4ea');
  label(messages.speed, height * 0.185);
  value(`${Math.round(sample.velocity)} km/h`, height * 0.284, 38, '#79b8ff');
  label(messages.recordedTime, height * 0.387);
  value(sample.date, height * 0.445, 23);
  value(sample.time, height * 0.504, 22);
  label(messages.gpsPosition, height * 0.614);
  if (sample.fix) {
    value(`${sample.fix.latitude.toFixed(5)}, ${sample.fix.longitude.toFixed(5)}`, height * 0.669, 17);
  } else {
    value(messages.unavailable, height * 0.669, 17);
  }

  const y = height * 0.72;
  if (map.view) {
    ctx.drawImage(map.canvas, x, y);
    if (sample.fix) {
      const [dx, dy] = map.view.position(sample.fix);
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#f8fcff';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#0872ef';
      ctx.stroke();
    }
  }
}

export async function renderRecording(video, metadata, info, { includeRoadMap, includeVin, language }, onProgress) {
  const messages = messagesFor(language);
  const data = await readTelemetry(metadata);
  const telemetry = syncTelemetry(data, info.duration);
  const vin = includeVin ? data.vin : null;
  const input = openVideo(video);
  const layout = panelDimensions(info.width, info.height);
  const map = await buildRouteMap(telemetry.points, layout.panel - 36, Math.max(80, Math.floor(layout.height * 0.23)), includeRoadMap);
  const canvas = new OffscreenCanvas(layout.width, layout.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  try {
    const conversion = await Conversion.init({
      input, output, tracks: 'primary', tags: {},
      audio: { codec: 'aac' },
      video: {
        codec: 'avc', quality: QUALITY_HIGH, keyFrameInterval: 2,
        hardwareAcceleration: info.hardwareAcceleration,
        processedWidth: layout.width,
        processedHeight: layout.height,
        process(sample) {
          sample.draw(ctx, 0, 0, info.width, info.height);
          drawTelemetry(ctx, layout, map, telemetry.at(sample.timestamp), vin, messages);
          return canvas;
        }
      }
    });
    if (!conversion.isValid || conversion.discardedTracks.some(({ track }) => track.type === 'video')) {
      throw new RecordingError('unsupportedExport');
    }
    conversion.onProgress = onProgress;
    try {
      await conversion.execute();
    } catch (error) {
      if (!['EncodingError', 'NotSupportedError', 'DataError'].includes(error?.name)) throw error;
      throw new RecordingError('failedExport');
    }
    if (!target.buffer?.byteLength) throw new RecordingError('emptyExport');
    return { file: new Blob([target.buffer], { type: 'video/mp4' }), roads: map.roads };
  } finally {
    input.dispose();
  }
}
