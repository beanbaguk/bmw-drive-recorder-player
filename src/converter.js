import { BlobSource, BufferTarget, CanvasSource, Conversion, Input, MPEG_TS, MP4, Mp4OutputFormat, Output, QUALITY_HIGH, VideoSampleSink, canEncodeVideo } from 'mediabunny';
import { readTelemetry, syncTelemetry } from './telemetry.js';
import { buildRouteMap } from './road-map.js';
import { messagesFor, RecordingError } from './i18n.js';
import { recordingFiles } from './recording-files.js';
import { panelDimensions, overlayLayout, drawTelemetry } from './overlay.js';

const openVideo = file => new Input({ source: new BlobSource(file), formats: [MPEG_TS, MP4] });

async function inspectVideo(input) {
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error();
    const [end, start, width, height, stats] = await Promise.all([
      track.computeDuration(), track.getFirstTimestamp(), track.getDisplayWidth(), track.getDisplayHeight(), track.computePacketStats(100)
    ]);
    const duration = end - start;
    if (!Number.isFinite(duration) || duration <= 0 || width <= 0 || height <= 0) throw new Error();
    return { track, start, duration, width, height, frameRate: stats.averagePacketRate };
  } catch { throw new RecordingError('invalidVideo'); }
}

export async function inspectRecording(video, metadata, options = {}) {
  const group = recordingFiles(video, metadata);
  const inputs = group.cameras.map(camera => openVideo(camera.file));
  try {
    const data = await readTelemetry(metadata, options);
    if ((group.type === 'mp4') !== (data.format === 'xml')) throw new RecordingError('invalidPair');
    const tracks = await Promise.all(inputs.map(inspectVideo));
    const first = tracks[0];
    // Separate camera streams must describe the same interval; do not silently truncate one.
    if (tracks.some(track => Math.abs(track.duration - first.duration) > 0.15 || Math.abs(track.start - first.start) > 0.15)) {
      throw new RecordingError('mismatchedCameras');
    }
    const duration = Math.min(...tracks.map(track => track.duration));
    const synchronized = syncTelemetry(data, duration);
    if (!self.isSecureContext || typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') throw new RecordingError('needsEncoding');
    for (const track of tracks) {
      for (const mode of ['prefer-software', 'no-preference']) {
        try {
          const sample = await new VideoSampleSink(track.track, { hardwareAcceleration: mode }).getSample(track.start);
          if (!sample) continue;
          sample.close(); track.hardwareAcceleration = mode; break;
        } catch { /* Retry with the browser's preferred decoder. */ }
      }
      if (!track.hardwareAcceleration) throw new RecordingError('failedDecode');
    }
    const width = group.type === 'ts' ? first.width : Math.max(...tracks.map(track => track.width)) * 2;
    const height = group.type === 'ts' ? first.height : Math.max(...tracks.map(track => track.height)) * 2;
    const layout = panelDimensions(width, height);
    if (!await canEncodeVideo('avc', { width: layout.width, height: layout.height, bitrate: QUALITY_HIGH })) throw new RecordingError('unsupportedSize');
    return {
      duration, width, height, type: group.type, sampleCount: data.samples.length,
      tracks: tracks.map(({ track, ...details }) => details),
      hasGps: synchronized.points.length > 0, hasVin: data.vin !== null,
      cameraCount: tracks.length
    };
  } finally { inputs.forEach(input => input.dispose()); }
}

async function composeCameras(inputs, group, info, output, canvas, ctx, draw, onProgress, messages) {
  const source = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
  const rate = Math.min(60, Math.max(1, info.tracks[0].frameRate || 30));
  output.addVideoTrack(source, { frameRate: rate });
  const cursors = [];
  const layout = panelDimensions(info.width, info.height);
  const cells = { front: [0, 0], rear: [1, 0], left: [0, 1], right: [1, 1] };
  try {
    for (let i = 0; i < inputs.length; i++) {
      const track = await inputs[i].getPrimaryVideoTrack();
      const iterator = new VideoSampleSink(track, { hardwareAcceleration: info.tracks[i].hardwareAcceleration }).samples();
      cursors.push({ iterator, current: null, next: (await iterator.next()).value });
    }
    await output.start();
    const frames = Math.ceil(info.duration * rate - 1e-6);
    for (let frame = 0; frame < frames; frame++) {
      const time = frame / rate;
      ctx.fillStyle = '#080e17'; ctx.fillRect(0, 0, layout.pictureWidth, layout.height);
      const cellWidth = layout.pictureWidth / 2, cellHeight = layout.height / 2;
      for (const [position, [col, row]] of Object.entries(cells)) {
        const i = group.cameras.findIndex(camera => camera.position === position);
        if (i >= 0) {
          const cursor = cursors[i], detail = info.tracks[i];
          while (cursor.next && cursor.next.timestamp <= detail.start + time + 1e-5) {
            cursor.current?.close(); cursor.current = cursor.next;
            cursor.next = (await cursor.iterator.next()).value;
          }
          if (!cursor.current) throw new RecordingError('failedDecode');
          const scale = Math.min(cellWidth / detail.width, cellHeight / detail.height);
          const w = detail.width * scale, h = detail.height * scale;
          cursor.current.draw(ctx, col * cellWidth + (cellWidth - w) / 2, row * cellHeight + (cellHeight - h) / 2, w, h);
        }
        const labelSize = Math.max(13, layout.height / 50);
        ctx.font = `600 ${labelSize}px sans-serif`;
        const label = messages[position] + (i < 0 ? ` · ${messages.noCamera}` : '');
        const x = col * cellWidth + 12, y = row * cellHeight + 12;
        ctx.fillStyle = '#101d30d9'; ctx.fillRect(x, y, ctx.measureText(label).width + 18, labelSize + 14);
        ctx.fillStyle = '#f3f7fe'; ctx.fillText(label, x + 9, y + labelSize + 3);
      }
      draw(time);
      await source.add(time, Math.min(1 / rate, info.duration - time));
      onProgress((frame + 1) / frames);
    }
    source.close();
    await output.finalize();
  } finally {
    for (const cursor of cursors) {
      cursor.current?.close(); cursor.next?.close();
      await cursor.iterator.return();
    }
  }
}

export async function renderRecording(video, metadata, info, options, onProgress) {
  const messages = messagesFor(options.language);
  const group = recordingFiles(video, metadata);
  const data = await readTelemetry(metadata, options);
  const telemetry = syncTelemetry(data, info.duration);
  const inputs = group.cameras.map(camera => openVideo(camera.file));
  const layout = panelDimensions(info.width, info.height);
  const canvas = new OffscreenCanvas(layout.width, layout.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  const overlay = overlayLayout(ctx, layout, options, options.includeVin ? data.vin : null, messages);
  const map = await buildRouteMap(telemetry.points, Math.round(overlay.mapWidth * overlay.scale), Math.round(overlay.mapHeight * overlay.scale), options.includeRoadMap);
  const draw = time => drawTelemetry(ctx, layout, overlay, map, telemetry.at(time), options, data.utc, messages);
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  try {
    if (group.type === 'mp4') {
      await composeCameras(inputs, group, info, output, canvas, ctx, draw, onProgress, messages);
    } else {
      const conversion = await Conversion.init({
        input: inputs[0], output, tracks: 'primary', tags: {},
        trim: { start: info.tracks[0].start, end: info.tracks[0].start + info.duration },
        audio: { codec: 'aac' },
        video: {
          codec: 'avc', quality: QUALITY_HIGH, keyFrameInterval: 2,
          hardwareAcceleration: info.tracks[0].hardwareAcceleration,
          processedWidth: layout.width, processedHeight: layout.height,
          process(sample) {
            sample.draw(ctx, 0, 0, layout.pictureWidth, layout.height);
            draw(sample.timestamp);
            return canvas;
          }
        }
      });
      if (!conversion.isValid || conversion.discardedTracks.some(({ track }) => track.type === 'video')) throw new RecordingError('unsupportedExport');
      conversion.onProgress = onProgress;
      await conversion.execute();
    }
    if (!target.buffer?.byteLength) throw new RecordingError('emptyExport');
    return { file: new Blob([target.buffer], { type: 'video/mp4' }), roads: map.roads };
  } catch (error) {
    if (['EncodingError', 'NotSupportedError', 'DataError'].includes(error?.name)) throw new RecordingError('failedExport');
    throw error;
  } finally { inputs.forEach(input => input.dispose()); }
}
