import { RecordingError } from './i18n.js';

const positions = {
  front: 'front', vorn: 'front', vorne: 'front', delantera: 'front', avant: 'front',
  rear: 'rear', back: 'rear', hinten: 'rear', trasera: 'rear', arriere: 'rear',
  left: 'left', links: 'left', izquierda: 'left', gauche: 'left',
  right: 'right', rechts: 'right', derecha: 'right', droite: 'right'
};
const order = ['front', 'rear', 'left', 'right'];

export function recordingFiles(videos, metadata) {
  const files = Array.isArray(videos) ? videos : [videos];
  if (!files.length || files.some(file => !file?.size) || !metadata?.size) throw new RecordingError('emptyFile');
  if (files.length === 1 && /\.ts$/i.test(files[0].name) && /\.json$/i.test(metadata.name)) {
    return { type: 'ts', cameras: [{ file: files[0] }] };
  }
  if (files.length > 4 || !/\.xml$/i.test(metadata.name) || files.some(file => !/\.mp4$/i.test(file.name))) {
    throw new RecordingError('invalidPair');
  }
  const cameras = files.map(file => {
    const match = /^(.*)_(?:camera|kamera|cámara|caméra)_([^_]+)(?:_(raw|rohdaten))?\.mp4$/i.exec(file.name);
    const position = positions[match?.[2].toLowerCase()];
    if (!position) throw new RecordingError('unknownCamera');
    return { file, position, prefix: match[1], raw: Boolean(match[3]) };
  });
  const first = cameras[0];
  if (cameras.some(camera => camera.prefix !== first.prefix || camera.raw !== first.raw) ||
      new Set(cameras.map(camera => camera.position)).size !== cameras.length ||
      metadata.name.replace(/\.xml$/i, '') !== first.prefix) throw new RecordingError('mixedCameras');
  cameras.sort((a, b) => order.indexOf(a.position) - order.indexOf(b.position));
  return { type: 'mp4', cameras };
}
