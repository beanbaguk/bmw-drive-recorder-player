const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require('playwright-core');
const ffmpeg = require('ffmpeg-static');

const [exe, workDir] = process.argv.slice(2);
const videoFile = path.join(workDir, 'synthetic-front-and-rear.ts');
const metadataFile = path.join(workDir, 'Metadata.json');
const savedFile = path.join(workDir, 'windows-export.mp4');
const testVin = 'ZZZ12345678901234';

function runFfmpeg(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', ...args], {encoding:'utf8'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'FFmpeg returned an error.');
  return result.stdout;
}

async function makeRecording() {
  runFfmpeg([
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x480:rate=15:duration=8',
    '-f', 'lavfi', '-i', 'smptebars=size=1280x480:rate=15:duration=8',
    '-filter_complex', '[0:v][1:v]vstack=inputs=2', '-an', '-c:v', 'libx264',
    '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-g', '15',
    '-muxdelay', '0', '-y', videoFile
  ]);
  const entries = Array.from({length: 240}, (_, i) => ({
    id: i + 1,
    date: '01.01.2026',
    time: '10:00:0' + Math.floor(i / 30),
    velocity: 42 + i / 30,
    latitude: 48.858 + 0.00014 * Math.floor(i / 30),
    longitude: 2.296 + 0.00016 * Math.sin(Math.floor(i / 30))
  }));
  await fs.writeFile(metadataFile, JSON.stringify([{ VIN: testVin, entries }]));
}

async function testInstalledApp() {
  const app = await _electron.launch({
    executablePath: exe,
    args: ['--user-data-dir=' + path.join(workDir, 'isolated-profile')],
    timeout: 45000
  });
  try {
    const page = await app.firstWindow({timeout:30000});
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => console.log('Renderer exception:', error.message));
    page.on('console', message => {
      if (message.type() === 'error') console.log('Renderer error:', message.text());
    });
    const runtime = await app.evaluate(({ app }) => ({
      platform: process.platform, arch: process.arch, packaged: app.isPackaged, version: app.getVersion()
    }));
    assert.deepEqual(runtime, {platform:'win32', arch:'x64', packaged:true, version:'1.0.1'});
    assert.match(await page.title(), /BMW Drive Recorder Player/);
    console.log('PASS: installed Windows x64 app launched.');

    const outgoing = [];
    page.on('request', request => {
      if (/^https?:/.test(request.url())) outgoing.push(new URL(request.url()).hostname);
    });
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', {name:'browse files'}).click();
    await (await chooser).setFiles([videoFile, metadataFile]);
    const error = page.locator('#error');
    await page.waitForFunction(() => !document.querySelector('#convert').disabled || !document.querySelector('#error').hidden);
    if (await error.isVisible()) throw new Error(await error.textContent());
    assert.match(await page.locator('#verification').textContent(), /8\.0 seconds.*240 readings/);
    assert.equal(await page.locator('#include-map').isChecked(), false);
    assert.equal(await page.locator('#include-vin').isChecked(), false);
    await page.locator('#include-vin').check();
    console.log('PASS: opened both files and verified their metadata.');

    await page.getByRole('button', {name:'Convert to MP4'}).click();
    await page.waitForFunction(() => document.querySelector('#download').hasAttribute('href') || !document.querySelector('#error').hidden, null, {timeout:120000});
    if (await error.isVisible()) throw new Error(await error.textContent());
    const preview = page.locator('#preview');
    await preview.evaluate(async video => { video.muted = true; await video.play(); });
    await page.waitForFunction(() => document.querySelector('#preview').currentTime > 0.5);
    const playback = await preview.evaluate(async video => {
      video.pause();
      const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, {once:true}));
      video.currentTime = 6;
      await seeked;
      return {seconds:video.duration, width:video.videoWidth, height:video.videoHeight, local:video.src.startsWith('blob:')};
    });
    assert.deepEqual(playback, {seconds:8, width:1558, height:960, local:true});
    console.log('PASS: created a local preview, played it, and sought to 6 seconds.');

    const saveState = await app.evaluate(({ BrowserWindow }, outputPath) => {
      const status = {dialogTitle:null, state:null};
      globalThis.windowsQaSaveStatus = status;
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
        status.dialogTitle = item.getSaveDialogOptions().title;
        if (status.dialogTitle === 'Save MP4') item.setSavePath(outputPath);
        item.once('done', (_event, state) => { status.state = state; });
      });
      return status;
    }, savedFile);
    assert.equal(saveState.state, null);
    await page.getByRole('link', {name:'Download MP4'}).click();
    for (let attempt = 0; attempt < 60; attempt++) {
      const state = await app.evaluate(() => globalThis.windowsQaSaveStatus);
      if (state.state) {
        assert.deepEqual(state, {dialogTitle:'Save MP4', state:'completed'});
        break;
      }
      if (attempt === 59) throw new Error('Saving the MP4 timed out.');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.deepEqual(outgoing, []);
    assert.ok((await fs.stat(savedFile)).size > 0);
    console.log('PASS: the app saved an MP4 with no external requests.');
  } finally {
    await app.close();
  }
}

(async () => {
  await makeRecording();
  await testInstalledApp();
  const bytes = await fs.readFile(savedFile);
  assert.equal(bytes.subarray(4,8).toString(), 'ftyp');
  const result = runFfmpeg(['-v', 'error', '-xerror', '-progress', 'pipe:1', '-i', savedFile, '-map', '0:v:0', '-f', 'null', '-']);
  const decoded = [...result.matchAll(/^frame=(\d+)\s*$/gm)].at(-1);
  assert.equal(Number(decoded?.[1]), 120);
  console.log('PASS: independent FFmpeg decoding read all 120 frames of the saved MP4.');
})().catch(error => { console.error(error); process.exitCode = 1; });
