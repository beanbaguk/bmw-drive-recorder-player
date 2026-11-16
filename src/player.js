import { textLimits } from './overlay.js';
import { languageFor, messagesFor, pageSpanish } from './i18n.js';

const locale = location.protocol === 'recorder:'
  ? new URLSearchParams(location.search).get('locale') || navigator.language
  : navigator.language;
const language = languageFor(locale);
const messages = messagesFor(language);
document.documentElement.lang = language;
if (language === 'es') {
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = pageSpanish[element.dataset.i18n];
  }
  for (const element of document.querySelectorAll('[data-i18n-label]')) {
    element.setAttribute('aria-label', pageSpanish[element.dataset.i18nLabel]);
  }
  document.querySelector('meta[name="description"]').content = pageSpanish.description;
}

const decimal = new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat(language);
const percent = new Intl.NumberFormat(language, { style: 'percent' });

const el = id => document.getElementById(id);
const picker = el('picker');
const dropZone = el('drop-zone');
const mapOption = el('include-map');
const vinOption = el('include-vin');
const vinHelp = el('vin-help');
const vinDescription = vinHelp.textContent;
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
const speedUnit = el('speed-unit'), dateFormat = el('date-format'), sourceDateOrder = el('source-date-order');
const identityInputs = { carModel: el('car-model'), registration: el('registration'), name: el('name') };
const optionControls = [speedUnit, dateFormat, sourceDateOrder, ...Object.values(identityInputs)];
if (/^en-US\b/i.test(locale)) { speedUnit.value = 'mph'; dateFormat.value = 'us'; }
function exportOptions() {
  return { includeRoadMap: mapOption.checked, includeVin: vinOption.checked,
    speedUnit: speedUnit.value, dateFormat: dateFormat.value, sourceDateOrder: sourceDateOrder.value,
    ...Object.fromEntries(Object.entries(identityInputs).map(([key, input]) => [key, input.value])) };
}

const defaults = {
  video: [el('video-title').textContent, el('video-detail').textContent],
  metadata: [el('metadata-title').textContent, el('metadata-detail').textContent]
};
const resultHelp = resultStatus.textContent;
const playerTitle = el('player-title').textContent;
const playerDetail = el('player-detail').textContent;
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
  return bytes < 1024 * 1024 ? `${integer.format(Math.round(bytes / 1024))} KB` : `${decimal.format(bytes / (1024 * 1024))} MB`;
}

function showSlot(name, verified) {
  const selected = files[name];
  const file = Array.isArray(selected) ? { name: selected.map(file => file.name).join(', '), size: selected.reduce((sum, file) => sum + file.size, 0) } : selected;
  const [title, detail] = defaults[name];
  el(name + '-title').textContent = file?.name ?? title;
  el(name + '-title').title = file?.name ?? '';
  el(name + '-detail').textContent = file ? (verified ? `${messages.verified} · ` : '') + formatBytes(file.size) : detail;
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
  el('player-title').textContent = playerTitle;
  el('player-detail').textContent = playerDetail;
  resultStatus.textContent = resultHelp;
  progress.value = 0;
  progress.hidden = true;
  cancel.hidden = true;
}

function stopWorker() {
  worker?.terminate();
  worker = undefined;
}

function updateVinOption() {
  vinOption.disabled = rendering || !info?.hasVin;
  if (!info?.hasVin) vinOption.checked = false;
  vinHelp.textContent = info && !info.hasVin ? messages.noVin : vinDescription;
}

function setRendering(value) {
  rendering = value;
  for (const control of [el('browse'), el('video-slot'), el('metadata-slot'), mapOption, clear, ...optionControls]) {
    control.disabled = value;
  }
  convert.disabled = value || !info;
  updateVinOption();
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
    if (worker === active) failWork(messages.stopped);
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
      setVerification(messages.verification(decimal.format(info.duration), integer.format(info.sampleCount), info.hasGps));
      updateVinOption();
      convert.disabled = false;
    } else if (data.type === 'progress') {
      progress.value = data.value;
      el('player-detail').textContent = messages.rendering(percent.format(data.value));
    } else if (data.type === 'finished') {
      stopWorker();
      setRendering(false);
      url = URL.createObjectURL(data.file);
      preview.src = url;
      preview.hidden = false;
      placeholder.hidden = true;
      download.href = url;
      download.download = (files.video.length === 1 && /\.ts$/i.test(files.video[0].name) ? files.video[0].name : files.metadata.name).replace(/\.(ts|json|xml)$/i, '') + '_with_telemetry.mp4';
      download.removeAttribute('aria-disabled');
      const mapNote = mapOption.checked && info.hasGps && !data.roads ? ` ${messages.mapUnavailable}` : '';
      resultStatus.textContent = messages.mp4Ready(formatBytes(data.file.size)) + mapNote;
    }
  };
  active.postMessage({
    action, ...files, info, language,
    options: exportOptions()
  });
}

function receive(incoming) {
  if (rendering || !incoming.length) return;
  const videos = incoming.filter(file => /\.(ts|mp4)$/i.test(file.name));
  const metadata = incoming.filter(file => /\.(json|xml)$/i.test(file.name));
  if (videos.length > 4 || (videos.some(file => /\.ts$/i.test(file.name)) && videos.length > 1) || metadata.length > 1 || !videos.length && !metadata.length) {
    errorMessage(messages.invalidPair);
    return;
  }
  if ([...videos, ...metadata].some(file => !file.size)) {
    errorMessage(messages.emptyFile);
    return;
  }

  stopWorker();
  info = undefined;
  updateVinOption();
  clearOutput();
  errorMessage('');
  setVerification('');
  if (videos.length) files.video = videos;
  if (metadata.length) files.metadata = metadata[0];
  for (const name of Object.keys(files)) showSlot(name, false);
  clear.hidden = false;
  convert.disabled = true;
  if (files.video && files.metadata) {
    setVerification(messages.checkFiles);
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
      fileEntries.push(...entries.filter(entry => entry.isFile && /\.(ts|json|mp4|xml)$/i.test(entry.name)));
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
    errorMessage(messages.failedFolder);
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
  el('player-title').textContent = messages.creating;
  el('player-detail').textContent = mapOption.checked && info.hasGps ? messages.preparingMap : messages.preparingVideo;
  resultStatus.textContent = messages.stayOpen;
  startWorker('render');
};

function settingsChanged() {
  if (!url) return;
  clearOutput();
  resultStatus.textContent = messages.vinChanged;
}
for (const control of [vinOption, mapOption, speedUnit, dateFormat]) control.addEventListener('change', settingsChanged);
sourceDateOrder.onchange = () => {
  stopWorker(); info = undefined; convert.disabled = true;
  clearOutput(); updateVinOption(); errorMessage('');
  if (files.video && files.metadata) { setVerification(messages.checkFiles); startWorker('inspect'); }
};
for (const [key, input] of Object.entries(identityInputs)) {
  input.addEventListener('input', () => {
    if (input.composing) return;
    const chars = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input.value), item => item.segment);
    input.value = chars.slice(0, textLimits[key]).join('');
    el(input.id + '-count').textContent = `${Math.min(chars.length, textLimits[key])} / ${textLimits[key]}`;
    settingsChanged();
  });
  input.addEventListener('compositionstart', () => { input.composing = true; });
  input.addEventListener('compositionend', () => { input.composing = false; input.dispatchEvent(new Event('input')); });
}

cancel.onclick = () => {
  stopWorker();
  setRendering(false);
  clearOutput();
  resultStatus.textContent = messages.cancelled;
  convert.focus();
};

clear.onclick = () => {
  stopWorker();
  info = undefined;
  updateVinOption();
  files.video = files.metadata = null;
  sourceDateOrder.value = 'auto';
  for (const input of Object.values(identityInputs)) { input.value = ''; input.dispatchEvent(new Event('input')); }
  clearOutput();
  setVerification('');
  errorMessage('');
  clear.hidden = true;
  convert.disabled = true;
  for (const name of Object.keys(files)) showSlot(name, false);
  el('browse').focus();
};

preview.addEventListener('error', () => {
  if (url) resultStatus.textContent = messages.failedPlayback;
});
