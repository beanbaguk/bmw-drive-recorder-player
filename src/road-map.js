import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

const tileEndpoint = 'https://tiles.openfreemap.org/planet/latest';
const tileSize = 256;
const mapCredit = 'OpenFreeMap · © OpenMapTiles';
const dataCredit = '© OpenStreetMap contributors';
const licenseUrl = 'openstreetmap.org/copyright';
const attributionHeight = 42;

function project(latitude, longitude, reference) {
  const lon = reference + ((longitude - reference + 540) % 360) - 180;
  const sin = Math.sin(Math.max(-85.051, Math.min(85.051, latitude)) * Math.PI / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
}

function mapViewport(points, width, height, reservedHeight) {
  const reference = points[0]?.longitude;
  if (reference === undefined) return null;
  const coords = points.map(p => project(p.latitude, p.longitude, reference));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const zoom = Math.min(16, Math.max(0, Math.floor(Math.log2(Math.min(
    width * 0.72 / Math.max(1e-9, maxX - minX) / tileSize,
    (height - reservedHeight) * 0.65 / Math.max(1e-9, maxY - minY) / tileSize
  )))));
  const tileCount = 2 ** zoom;
  const scale = tileCount * tileSize;
  const left = cx * scale - width / 2;
  const top = cy * scale - (height - reservedHeight) / 2;
  const position = fix => {
    const [x, y] = project(fix.latitude, fix.longitude, reference);
    return [x * scale - left, y * scale - top];
  };
  const tiles = [];
  for (let row = Math.max(0, Math.floor(top / tileSize));
       row < Math.min(tileCount, Math.ceil((top + height) / tileSize)); row++) {
    for (let column = Math.floor(left / tileSize); column < Math.ceil((left + width) / tileSize); column++) {
      const x = ((column % tileCount) + tileCount) % tileCount;
      tiles.push({ x, row, left: column * tileSize - left, top: row * tileSize - top });
    }
  }
  return { width, height, zoom, position, tiles };
}

function layerStyle(group, properties) {
  if (group === 'water') return ['#203e5b'];
  if (group === 'landcover') return ['#1a303c'];
  if (group === 'park') return ['#193a39'];
  if (group === 'building') return ['#2e3e50'];
  if (group === 'waterway') return ['#294b65', 1.4];
  if (group === 'transportation') {
    if (['motorway', 'trunk', 'primary', 'secondary'].includes(properties.class)) return ['#7387a0', 2.4];
    if (['rail', 'transit', 'ferry'].includes(properties.class)) return ['#495d74', 0.9];
    return ['#485a71', properties.class === 'path' ? 0.7 : 1.4];
  }
  return ['#53657b', 1];
}

function drawLayer(ctx, tiles, group, geometryType) {
  for (const { tile, left, top } of tiles) {
    const layer = tile.layers[group];
    if (!layer) continue;
    for (let index = 0; index < layer.length; index++) {
      const feature = layer.feature(index);
      if (feature.type !== geometryType) continue;
      const scale = tileSize / feature.extent;
      ctx.beginPath();
      for (const ring of feature.loadGeometry()) {
        for (let pointIndex = 0; pointIndex < ring.length; pointIndex++) {
          const { x, y } = ring[pointIndex];
          if (pointIndex === 0) ctx.moveTo(left + x * scale, top + y * scale);
          else ctx.lineTo(left + x * scale, top + y * scale);
        }
        if (geometryType === 3) ctx.closePath();
      }
      const [color, weight] = layerStyle(group, feature.properties);
      if (geometryType === 3) {
        ctx.fillStyle = color;
        ctx.fill('evenodd');
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = weight;
        ctx.stroke();
      }
    }
  }
}

async function loadTiles(view, signal) {
  const tiles = [];
  for (let index = 0; index < view.tiles.length; index += 4) {
    const batch = await Promise.all(view.tiles.slice(index, index + 4).map(async tile => {
      const response = await fetch(`${tileEndpoint}/${view.zoom}/${tile.x}/${tile.row}.pbf`, {
        signal, credentials: 'omit', referrerPolicy: 'no-referrer'
      });
      if (!response.ok) throw new Error('Road map unavailable.');
      return { ...tile, tile: new VectorTile(new Pbf(await response.arrayBuffer())) };
    }));
    tiles.push(...batch);
  }
  return tiles;
}

export async function buildRouteMap(points, width, height, includeRoadMap) {
  const view = mapViewport(points, width, height, includeRoadMap ? attributionHeight : 0);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#17263b';
  ctx.fillRect(0, 0, width, height);
  if (!view) return { canvas, view, roads: false };
  let roads = false;
  if (includeRoadMap) {
    try {
      const tiles = await loadTiles(view, AbortSignal.timeout(7500));
      for (const layer of ['landcover', 'park', 'water', 'building']) drawLayer(ctx, tiles, layer, 3);
      for (const layer of ['waterway', 'boundary', 'transportation']) drawLayer(ctx, tiles, layer, 2);
      roads = tiles.length > 0;
    } catch {
      ctx.fillStyle = '#17263b';
      ctx.fillRect(0, 0, width, height);
    }
  }
  if (!roads) {
    ctx.strokeStyle = '#233752';
    ctx.lineWidth = 1;
    for (let x = 18; x < width; x += 24) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = 16; y < height; y += 24) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
  }

  ctx.beginPath();
  points.forEach((point, index) => {
    const [x, y] = view.position(point);
    if (index === 0 || point.offset - points[index - 1].offset > 2.5) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#66afff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  if (roads) {
    ctx.fillStyle = '#102036';
    ctx.fillRect(0, height - attributionHeight, width, attributionHeight);
    ctx.fillStyle = '#e0eafa';
    ctx.font = '11px sans-serif';
    ctx.fillText(mapCredit, 7, height - 29);
    ctx.fillText(dataCredit, 7, height - 17);
    ctx.fillText(licenseUrl, 7, height - 5);
  }
  return { canvas, view, roads };
}
