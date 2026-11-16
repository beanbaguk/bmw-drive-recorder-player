import { displayClock, displaySpeed } from './telemetry.js';

export const textLimits = { carModel: 36, registration: 14, name: 24 };
const segments = text => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), item => item.segment);

export function cleanText(value, limit) {
  return segments(String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
}

export function panelDimensions(width, height) {
  // Keep readable text even for small exports; never crop the camera image.
  const outputHeight = Math.max(720, Math.ceil(height / 2) * 2);
  const pictureWidth = Math.round(width * outputHeight / height / 2) * 2;
  const panel = Math.round(outputHeight * 480 / 1080 / 2) * 2;
  return { panel, pictureWidth, width: pictureWidth + panel, height: outputHeight };
}

function fit(ctx, text, width, preferred = 34, minimum = 30) {
  let size = preferred;
  for (; size > minimum; size--) {
    ctx.font = `600 ${size}px sans-serif`;
    if (ctx.measureText(text).width <= width) break;
  }
  ctx.font = `600 ${size}px sans-serif`;
  return size;
}

function linesFor(ctx, text, width, maxLines) {
  const chars = segments(text), lines = [];
  while (chars.length && lines.length < maxLines) {
    let line = '';
    while (chars.length && ctx.measureText(line + chars[0]).width <= width) line += chars.shift();
    if (!line) line = chars.shift();
    if (chars.length && lines.length === maxLines - 1) {
      while (ctx.measureText(line + '…').width > width) line = segments(line).slice(0, -1).join('');
      line += '…';
    }
    lines.push(line.trim());
  }
  return lines;
}

export function overlayLayout(ctx, layout, options, vin, messages) {
  // Layout in a fixed coordinate space; drawing is scaled uniformly with the video.
  const width = 416;
  const rows = [];
  for (const [key, limit] of Object.entries(textLimits)) {
    const text = cleanText(options[key], limit);
    if (!text) continue;
    const size = fit(ctx, text, width);
    const lines = linesFor(ctx, text, width, key === 'registration' ? 1 : 2);
    rows.push({ label: messages[key], lines, size, height: 36 + lines.length * 40 });
  }
  if (vin) rows.push({ lines: [`VIN ${vin}`], size: 29, height: 42 });
  const rowsHeight = rows.reduce((total, row) => total + row.height, 0);
  const mapBottom = rows.length ? 1052 - rowsHeight - 20 : 1052;
  return { rows, rowTop: 1052 - rowsHeight, mapTop: 507, mapHeight: mapBottom - 507,
    scale: layout.height / 1080, mapWidth: width };
}

export function drawTelemetry(ctx, layout, overlay, map, sample, options, utc, messages) {
  ctx.save();
  ctx.translate(layout.pictureWidth, 0);
  ctx.scale(overlay.scale, overlay.scale);
  ctx.fillStyle = '#101d30';
  ctx.fillRect(0, 0, 480, 1080);
  const text = (value, y, size, color = '#f3f7fe') => {
    ctx.font = `600 ${size}px sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(value, 32, y, 416);
  };
  const label = (value, y) => text(value, y, 29, '#a9bad0');
  text('Drive Recorder', 58, 30);
  ctx.fillStyle = '#304057'; ctx.fillRect(32, 82, 416, 1);
  label(messages.speed, 128);
  const speed = String(Math.round(displaySpeed(sample, options.speedUnit)));
  const speedSize = fit(ctx, speed, 295, 106, 65);
  ctx.font = `600 ${speedSize}px sans-serif`; ctx.fillStyle = '#79b8ff';
  ctx.fillText(speed, 32, 233, 295);
  const speedWidth = Math.min(295, ctx.measureText(speed).width);
  ctx.font = '600 34px sans-serif';
  ctx.fillText(options.speedUnit === 'mph' ? 'mph' : 'km/h', Math.min(350, 48 + speedWidth), 233, 100);
  label(messages.recordedTime + (utc ? ' · UTC' : ''), 294);
  const clock = displayClock(sample, options.dateFormat);
  text(clock.date, 337, 34);
  text(clock.time, 387, 42);
  label(messages.gpsPosition, 439);
  text(sample.fix ? `${sample.fix.latitude.toFixed(5)}, ${sample.fix.longitude.toFixed(5)}` : messages.unavailable, 480, 29);
  if (map.view) {
    ctx.drawImage(map.canvas, 32, overlay.mapTop, overlay.mapWidth, overlay.mapHeight);
    if (sample.fix) {
      const [x, y] = map.view.position(sample.fix);
      ctx.beginPath();
      ctx.arc(32 + x / overlay.scale, overlay.mapTop + y / overlay.scale, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#f8fcff'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = '#0872ef'; ctx.stroke();
    }
  }
  let top = overlay.rowTop;
  for (const row of overlay.rows) {
    if (row.label) {
      ctx.fillStyle = '#304057'; ctx.fillRect(32, top, 416, 1);
      label(row.label, top + 27);
    }
    row.lines.forEach((line, i) => text(line, top + (row.label ? 62 : 30) + i * 40, row.size));
    top += row.height;
  }
  ctx.restore();
}
