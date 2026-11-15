import { BlobSource, BufferTarget, Conversion, Input, MPEG_TS, Mp4OutputFormat, Output, QUALITY_HIGH, VideoSampleSink, canEncodeVideo } from 'mediabunny';
import { readTelemetry, syncTelemetry } from './telemetry.js';
import { buildRouteMap } from './road-map.js';

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
      throw new Error('The .ts file could not be read as a video. Choose an intact BMW Drive Recorder export.');
    }

    const telemetry = await readTelemetry(metadata);
    const synchronized = syncTelemetry(telemetry, duration);
    if (!self.isSecureContext || typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
      throw new Error('MP4 conversion needs a secure page and a browser with video encoding. Try a current version of desktop Chrome or Safari.');
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
      throw new Error('This browser could not decode the BMW video. Open the player in desktop Google Chrome and choose the files again.');
    }
    const output = panelDimensions(width, height);
    if (!await canEncodeVideo('avc', { width: output.width, height: output.height, bitrate: QUALITY_HIGH })) {
      throw new Error('This browser cannot export H.264 at this recording’s size. Try another desktop browser.');
    }
    return { duration, width, height, sampleCount: telemetry.samples.length, hardwareAcceleration, hasGps: synchronized.points.length > 0 };
  } finally {
    input.dispose();
  }
}

function drawTelemetry(ctx, layout, map, sample) {
  const { width, height, panel } = layout;
  const left = width - panel;
  const pad = 18;
  const x = left + pad;
  const s = Math.min(1.42, height / 650);
  const label = (text, baseline) => {
    ctx.fillStyle = '#a9bad0';
    ctx.font = `600 ${Math.max(11, 13 * s)}px sans-serif`;
    ctx.fillText(text, x, baseline);
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
  label('SPEED', height * 0.185);
  value(`${Math.round(sample.velocity)} km/h`, height * 0.284, 38, '#79b8ff');
  label('RECORDED DATE & TIME', height * 0.387);
  value(sample.date, height * 0.445, 23);
  value(sample.time, height * 0.504, 22);
  label('GPS POSITION', height * 0.614);
  if (sample.fix) {
    value(`${sample.fix.latitude.toFixed(5)}, ${sample.fix.longitude.toFixed(5)}`, height * 0.669, 17);
  } else {
    value('Unavailable', height * 0.669, 17);
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

export async function renderRecording(video, metadata, info, includeRoadMap, onProgress) {
  const telemetry = syncTelemetry(await readTelemetry(metadata), info.duration);
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
          drawTelemetry(ctx, layout, map, telemetry.at(sample.timestamp));
          return canvas;
        }
      }
    });
    if (!conversion.isValid || conversion.discardedTracks.some(({ track }) => track.type === 'video')) {
      throw new Error('This browser could not create an MP4 for this recording. Try desktop Chrome or Safari.');
    }
    conversion.onProgress = onProgress;
    try {
      await conversion.execute();
    } catch (error) {
      if (!['EncodingError', 'NotSupportedError', 'DataError'].includes(error?.name)) throw error;
      throw new Error('The browser could not finish converting this video. Try desktop Google Chrome or another BMW export.');
    }
    if (!target.buffer?.byteLength) throw new Error('The recording produced an empty MP4.');
    return { file: new Blob([target.buffer], { type: 'video/mp4' }), roads: map.roads };
  } finally {
    input.dispose();
  }
}
