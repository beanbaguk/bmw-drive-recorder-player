const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron, chromium } = require('playwright-core');
const ffmpeg = process.env.FFMPEG_PATH || require('ffmpeg-static');

const [exe, workDir, fixtureManifest] = process.argv.slice(2);
function decode(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'FFmpeg failed');
  return result.stdout;
}

async function fixtures() {
  if (fixtureManifest) return JSON.parse(await fs.readFile(fixtureManifest, 'utf8'));
  // Public CI uses synthetic images and metadata; no owner recordings are uploaded.
  const video = path.join(workDir, 'synthetic-front-and-rear.ts');
  decode(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x480:rate=15:duration=8',
    '-f', 'lavfi', '-i', 'smptebars=size=1280x480:rate=15:duration=8',
    '-filter_complex', '[0:v][1:v]vstack=inputs=2', '-an', '-c:v', 'libx264',
    '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-g', '15', '-muxdelay', '0', '-y', video]);
  const cases = [];
  for (const name of ['idrive7', 'idrive85-blank-vin', 'idrive85-missing-vin']) {
    const modern = name !== 'idrive7';
    const entries = Array.from({ length: 240 }, (_, i) => ({
      id: i + 1, date: '01.01.2026', time: '10:00:0' + Math.floor(i / 30),
      latitude: 50 + i * 0.00001, longitude: 10 + i * 0.00001,
      ...(modern ? { 'velocity_KM/H': 30.3, 'velocity_MP/H': '18.83' } : { velocity: 30.3 })
    }));
    const data = { entries };
    if (name !== 'idrive85-missing-vin') data.VIN = modern ? '' : 'WBA00000000000000';
    const metadata = path.join(workDir, `${name}.json`);
    await fs.writeFile(metadata, JSON.stringify([data]));
    cases.push({ name, video, metadata, duration: 8, samples: 240, hasVin: !modern });
  }
  const us = path.join(workDir, 'us-mph.json');
  await fs.writeFile(us, JSON.stringify([{ entries: Array.from({ length: 240 }, (_, i) => ({ id: i + 1, date: '11/29/2025', time: '01:32:0' + Math.floor(i / 30) + 'pm', 'velocity_MP/H': '60.00', latitude: 0, longitude: 0 })) }]));
  cases.push({ name: 'us-mph', video, metadata: us, duration: 8, samples: 240, hasVin: false });
  const cameras = [];
  for (const [position, color] of [['Front', 'red'], ['Rear', 'blue'], ['Left', 'green'], ['Right', 'yellow']]) {
    const camera = path.join(workDir, `synthetic_Camera_${position}.mp4`);
    decode(['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:size=640x480:rate=15:duration=8`, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', '-y', camera]);
    cameras.push(camera);
  }
  const metadata = path.join(workDir, 'synthetic.xml');
  const entries = Array.from({ length: 17 }, (_, i) => `<ENTRY><ID>${i * 15 + 1}</ID><DATE_UTC>29.11.2025</DATE_UTC><TIME_UTC>13:32:0${Math.floor(i / 2)}</TIME_UTC><VELOCITY_KMH>96.56</VELOCITY_KMH><LATITUDE>50.001</LATITUDE><LONGITUDE>10.001</LONGITUDE></ENTRY>`).join('');
  await fs.writeFile(metadata, `<DATA><VIN>WBA00000000000000</VIN><LOG>${entries}</LOG></DATA>`);
  cases.push({ name: 'mp4-xml', video: cameras, metadata, duration: 8, samples: 17, hasVin: true });
  return cases;
}

async function main() {
  await fs.mkdir(workDir, { recursive: true });
  const cases = await fixtures();
  const args = ['--user-data-dir=' + path.join(workDir, 'isolated-profile')];
  if (process.platform === 'darwin') args.push('-AppleLanguages', '(es-ES)');
  const browserMode = Boolean(process.env.BMW_QA_URL);
  const browser = browserMode ? await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true }) : null;
  const app = browserMode ? null : await _electron.launch({ executablePath: exe, args, timeout: 45000 });
  const results = [];
  try {
    const page = browserMode ? await browser.newPage({ locale: 'es-ES', viewport: { width: 1440, height: 1100 } }) : await app.firstWindow({ timeout: 30000 });
    if (browserMode) await page.goto(process.env.BMW_QA_URL);
    page.setDefaultTimeout(30000);
    const runtime = browserMode ? { browser: 'Chrome' } : await app.evaluate(({ app }) => ({ platform: process.platform, arch: process.arch, packaged: app.isPackaged, version: app.getVersion() }));
    if (!browserMode) assert.deepEqual(runtime, { platform: process.platform, arch: process.arch, packaged: true, version: '1.1.0' });
    assert.equal(await page.locator('html').getAttribute('lang'), 'es');
    assert.equal(await page.locator('#import-heading').textContent(), 'Abrir una grabación');
    console.log('PASS: v1.1.0 opened in Spanish on ' + runtime.platform + '/' + runtime.arch);
    const errors = [], outgoing = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(process.env.BMW_QA_URL || 'recorder:')) outgoing.push(request.url()); });
    for (const fixture of cases) {
      const chooser = page.waitForEvent('filechooser');
      await page.locator('#browse').click();
      await (await chooser).setFiles([fixture.video, fixture.metadata].flat());
      await page.waitForFunction(() => !document.querySelector('#convert').disabled || !document.querySelector('#error').hidden);
      const error = page.locator('#error');
      if (await error.isVisible()) throw new Error(await error.textContent());
      const verified = await page.locator('#verification').textContent();
      assert.ok(verified.includes(new Intl.NumberFormat('es', { minimumFractionDigits: 1 }).format(fixture.duration) + ' segundos'));
      assert.ok(verified.includes(new Intl.NumberFormat('es').format(fixture.samples) + ' lecturas'));
      assert.equal(await page.locator('#include-vin').isDisabled(), !fixture.hasVin);
      assert.equal(await page.locator('#include-vin').isChecked(), false);
      assert.equal(await page.locator('#include-map').isChecked(), false);
      if (fixture.hasVin) await page.locator('#include-vin').check();
      else assert.match(await page.locator('#vin-help').textContent(), /Puedes convertirla sin él/);
      await page.locator('#speed-unit').selectOption('mph');
      await page.locator('#date-format').selectOption(fixture.name === 'us-mph' ? 'us' : 'eu');
      if (fixture.name === 'mp4-xml') {
        await page.locator('#car-model').fill('W'.repeat(50));
        await page.locator('#registration').fill('W'.repeat(20));
        await page.locator('#name').fill('W'.repeat(30));
        assert.equal((await page.locator('#car-model').inputValue()).length, 36);
        assert.equal((await page.locator('#registration').inputValue()).length, 14);
        assert.equal((await page.locator('#name').inputValue()).length, 24);
      }
      await page.locator('#convert').click();
      await page.waitForFunction(() => document.querySelector('#download').hasAttribute('href') || !document.querySelector('#error').hidden, null, { timeout: 180000 });
      if (await error.isVisible()) throw new Error(await error.textContent());
      assert.match(await page.locator('#result-status').textContent(), /^MP4 listo/);
      const preview = page.locator('#preview');
      await preview.evaluate(async video => { video.muted = true; await video.play(); });
      await page.waitForFunction(() => document.querySelector('#preview').currentTime > 0.5);
      const playback = await preview.evaluate(async video => {
        video.pause();
        const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
        video.currentTime = video.duration / 2;
        await seeked;
        return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, local: video.src.startsWith('blob:') };
      });
      assert.deepEqual(playback, { duration: fixture.duration, width: fixture.width || 1706, height: fixture.height || 960, local: true });
      const saved = path.join(workDir, `${fixture.name}.mp4`);
      if (browserMode) {
        const download = page.waitForEvent('download');
        await page.locator('#download').click();
        await (await download).saveAs(saved);
      } else {
      await app.evaluate(({ BrowserWindow }, outputPath) => {
        globalThis.releaseQaSave = { title: null, state: null };
        BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
          globalThis.releaseQaSave.title = item.getSaveDialogOptions().title;
          item.setSavePath(outputPath);
          item.once('done', (_event, state) => { globalThis.releaseQaSave.state = state; });
        });
      }, saved);
      await page.locator('#download').click();
      for (let attempt = 0; ; attempt++) {
        const state = await app.evaluate(() => globalThis.releaseQaSave);
        if (state.state) { assert.deepEqual(state, { title: 'Guardar MP4', state: 'completed' }); break; }
        if (attempt >= 60) throw new Error('Saving timed out');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      }
      if (fixture.name === 'mp4-xml') {
        // Check camera identity with tolerance for H.264 colour-space conversion.
        for (const [x, y, expected] of [[320, 240, 'red'], [960, 240, 'blue'], [320, 720, 'green'], [960, 720, 'yellow']]) {
          const pixel = spawnSync(ffmpeg, ['-v', 'error', '-ss', '3', '-i', saved, '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
          assert.equal(pixel.status, 0);
          const [r, g, b] = pixel.stdout;
          assert.ok(expected === 'red' ? r > 200 && g < 60 && b < 60 : expected === 'blue' ? b > 200 && r < 60 && g < 60 : expected === 'green' ? g > 80 && r < 40 && b < 40 : r > 200 && g > 200 && b < 60, `Camera position ${expected}`);
        }
      }
      const bytes = await fs.readFile(saved);
      assert.equal(bytes.subarray(4, 8).toString(), 'ftyp');
      const decoded = decode(['-v', 'error', '-xerror', '-progress', 'pipe:1', '-i', saved, '-map', '0:v:0', '-f', 'null', '-']);
      const frames = Number([...decoded.matchAll(/^frame=(\d+)\s*$/gm)].at(-1)?.[1]);
      assert.equal(frames, Math.round(fixture.duration * (fixture.fps || 15)));
      await page.screenshot({ path: path.join(workDir, fixture.name + '.png'), fullPage: true });
      results.push({ name: fixture.name, frames, ...playback });
      await page.locator('#name').fill('Changed');
      assert.equal(await page.locator('#download').getAttribute('href'), null);
      await page.locator('#clear').click();
      assert.equal(await page.locator('#name').inputValue(), '');
      console.log('PASS: ' + fixture.name + ' import, VIN controls, conversion, playback, seeking, download, and ' + frames + ' independently decoded frames');
    }
    assert.deepEqual(outgoing, []);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(workDir, 'results.json'), JSON.stringify({ runtime, results, externalRequests: 0, rendererErrors: 0 }, null, 2));
  } finally { if (app) await app.close(); if (browser) await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
