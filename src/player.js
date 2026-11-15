const el = id => document.getElementById(id);
const picker = el('picker');
const dropZone = el('drop-zone');
const mapOption = el('include-map');
const convert = el('convert');
const preview = el('preview');
const placeholder = el('placeholder');
const download = el('download');
const clear = el('clear');
const progress = el('progress');
const cancel = el('cancel');
const error = el('error');
const verification = el('verification');
const resultStatus = el('result-status');
const files = { video: null, metadata: null };
const defaults = {
  video: ['Recorder video', '.ts file'],
  metadata: ['Recording metadata', 'Metadata.json']
};
const resultHelp = 'Playback is local to this tab. Download the MP4 to keep a copy.';
let worker;
let info;
let url;
let rendering = false;
let dragCount = 0;

function errorMessage(message) {
  error.textContent = message;
  error.hidden = !message;
}

function setVerification(message) {
  verification.textContent = message;
  verification.hidden = !message;
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showSlot(name, verified) {
  const file = files[name];
  const [title, detail] = defaults[name];
  el(name + '-title').textContent = file?.name ?? title;
  el(name + '-title').title = file?.name ?? '';
  el(name + '-detail').textContent = file ? (verified ? 'Verified · ' : '') + formatBytes(file.size) : detail;
  el(name + '-state').setAttribute('href', verified ? '#icon-check' : '#icon-plus');
  el(name + '-slot').classList.toggle('verified', verified);
}

function clearOutput() {
  preview.hidden = true;
  preview.pause();
  preview.removeAttribute('src');
  preview.load();
  if (url) URL.revokeObjectURL(url);
  url = undefined;
  download.removeAttribute('href');
  download.removeAttribute('download');
  download.setAttribute('aria-disabled', 'true');
  placeholder.hidden = false;
  el('player-title').textContent = 'Your video will appear here';
  el('player-detail').textContent = 'Convert a recording to preview the MP4.';
  resultStatus.textContent = resultHelp;
  progress.value = 0;
  progress.hidden = true;
  cancel.hidden = true;
}

function stopWorker() {
  worker?.terminate();
  worker = undefined;
}

function setRendering(value) {
  rendering = value;
  for (const control of [el('browse'), el('video-slot'), el('metadata-slot'), mapOption, clear]) {
    control.disabled = value;
  }
  convert.disabled = value || !info;
  progress.hidden = !value;
  cancel.hidden = !value;
}

function failWork(message) {
  const wasRendering = rendering;
  stopWorker();
  setRendering(false);
  if (wasRendering) clearOutput();
  else setVerification('');
  errorMessage(message);
}

function startWorker(action) {
  stopWorker();
  const active = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker = active;
  active.onerror = () => {
    if (worker === active) failWork('The video converter stopped. Try again in a current desktop browser.');
  };
  active.onmessage = ({ data }) => {
    if (worker !== active) return;
    if (data.type === 'error') {
      failWork(data.message);
    } else if (data.type === 'verified') {
      ({ info } = data);
      stopWorker();
      showSlot('video', true);
      showSlot('metadata', true);
      setVerification(`File formats and durations verified · ${info.duration.toFixed(1)} seconds · ${info.sampleCount.toLocaleString()} readings` +
        (info.hasGps ? '' : ' · GPS unavailable'));
      convert.disabled = false;
    } else if (data.type === 'progress') {
      progress.value = data.value;
      el('player-detail').textContent = `Rendering your recording · ${Math.round(data.value * 100)}%`;
    } else if (data.type === 'finished') {
      stopWorker();
      setRendering(false);
      url = URL.createObjectURL(data.file);
      preview.src = url;
      preview.hidden = false;
      placeholder.hidden = true;
      download.href = url;
      download.download = files.video.name.replace(/\.ts$/i, '') + '_with_telemetry.mp4';
      download.removeAttribute('aria-disabled');
      const mapNote = mapOption.checked && info.hasGps && !data.roads ? ' Road map unavailable. The MP4 shows the GPS route.' : '';
      resultStatus.textContent = `MP4 ready · ${formatBytes(data.file.size)} · Playback is local to this tab.` + mapNote;
    }
  };
  active.postMessage({ action, ...files, info, includeRoadMap: mapOption.checked });
}

function receive(incoming) {
  if (rendering || !incoming.length) return;
  const videos = incoming.filter(file => /\.ts$/i.test(file.name));
  const metadata = incoming.filter(file => /\.json$/i.test(file.name));
  if (videos.length > 1 || metadata.length > 1 || !videos.length && !metadata.length) {
    errorMessage('Choose one .ts recording and one matching JSON file.');
    return;
  }
  if ([...videos, ...metadata].some(file => !file.size)) {
    errorMessage('One of the selected files is empty. Choose the original BMW export files.');
    return;
  }

  stopWorker();
  info = undefined;
  clearOutput();
  errorMessage('');
  setVerification('');
  if (videos.length) files.video = videos[0];
  if (metadata.length) files.metadata = metadata[0];
  for (const name of Object.keys(files)) showSlot(name, false);
  clear.hidden = false;
  convert.disabled = true;
  if (files.video && files.metadata) {
    setVerification('Checking video and metadata…');
    startWorker('inspect');
  }
}

for (const input of [picker, el('video-picker'), el('metadata-picker')]) {
  input.addEventListener('change', () => {
    receive(Array.from(input.files));
    input.value = '';
  });
}
el('browse').onclick = () => picker.click();
el('video-slot').onclick = () => el('video-picker').click();
el('metadata-slot').onclick = () => el('metadata-picker').click();

dropZone.addEventListener('dragenter', event => {
  event.preventDefault();
  dragCount++;
  if (!rendering) dropZone.classList.add('dragging');
});
dropZone.addEventListener('dragleave', () => {
  if (--dragCount <= 0) dropZone.classList.remove('dragging');
});
dropZone.addEventListener('dragover', event => {
  event.preventDefault();
  event.dataTransfer.dropEffect = rendering ? 'none' : 'copy';
});
async function droppedFiles(transfer) {
  const files = Array.from(transfer.files);
  const folders = Array.from(transfer.items, item => item.webkitGetAsEntry?.()).filter(entry => entry?.isDirectory);
  const fromFolders = await Promise.all(folders.map(async folder => {
    const reader = folder.createReader();
    const fileEntries = [];
    while (true) {
      const entries = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (entries.length === 0) break;
      fileEntries.push(...entries.filter(entry => entry.isFile && /\.(ts|json)$/i.test(entry.name)));
    }
    return Promise.all(fileEntries.map(entry => new Promise((resolve, reject) => entry.file(resolve, reject))));
  }));
  return [...files.filter(file => !folders.some(folder => folder.name === file.name)), ...fromFolders.flat()];
}

dropZone.addEventListener('drop', async event => {
  event.preventDefault();
  dragCount = 0;
  dropZone.classList.remove('dragging');
  if (rendering) return;
  try {
    receive(await droppedFiles(event.dataTransfer));
  } catch {
    errorMessage('The recording folder could not be opened. Choose its .ts and JSON files directly.');
  }
});
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, event => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  });
}

convert.onclick = () => {
  if (!info || rendering) return;
  clearOutput();
  errorMessage('');
  setRendering(true);
  el('player-title').textContent = 'Creating your MP4';
  el('player-detail').textContent = mapOption.checked && info.hasGps ? 'Preparing the road map…' : 'Preparing the video…';
  resultStatus.textContent = 'Keep this tab open while the browser renders the recording.';
  startWorker('render');
};

cancel.onclick = () => {
  stopWorker();
  setRendering(false);
  clearOutput();
  resultStatus.textContent = 'Conversion cancelled. You can export the recording again.';
  convert.focus();
};

clear.onclick = () => {
  stopWorker();
  info = undefined;
  files.video = files.metadata = null;
  clearOutput();
  setVerification('');
  errorMessage('');
  clear.hidden = true;
  convert.disabled = true;
  for (const name of Object.keys(files)) showSlot(name, false);
  el('browse').focus();
};

preview.addEventListener('error', () => {
  if (url) resultStatus.textContent = 'This browser could not play the MP4. You can still download the file.';
});
