const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require('playwright-core');
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
  return cases;
}

async function main() {
  await fs.mkdir(workDir, { recursive: true });
  const cases = await fixtures();
  const args = ['--user-data-dir=' + path.join(workDir, 'isolated-profile')];
  if (process.platform === 'darwin') args.push('-AppleLanguages', '(es-ES)');
  const app = await _electron.launch({ executablePath: exe, args, timeout: 45000 });
  const results = [];
  try {
    const page = await app.firstWindow({ timeout: 30000 });
    page.setDefaultTimeout(30000);
    const runtime = await app.evaluate(({ app }) => ({ platform: process.platform, arch: process.arch, packaged: app.isPackaged, version: app.getVersion() }));
    assert.deepEqual(runtime, { platform: process.platform, arch: process.arch, packaged: true, version: '1.0.3' });
    assert.equal(await page.locator('html').getAttribute('lang'), 'es');
    assert.equal(await page.locator('#import-heading').textContent(), 'Abrir una grabación');
    console.log('PASS: packaged v1.0.3 opened in Spanish on ' + runtime.platform + '/' + runtime.arch);
    const errors = [], outgoing = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) outgoing.push(request.url()); });
    for (const fixture of cases) {
      const chooser = page.waitForEvent('filechooser');
      await page.locator('#browse').click();
      await (await chooser).setFiles([fixture.video, fixture.metadata]);
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
      assert.deepEqual(playback, { duration: fixture.duration, width: 1558, height: 960, local: true });
      const saved = path.join(workDir, `${fixture.name}.mp4`);
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
      const bytes = await fs.readFile(saved);
      assert.equal(bytes.subarray(4, 8).toString(), 'ftyp');
      const decoded = decode(['-v', 'error', '-xerror', '-progress', 'pipe:1', '-i', saved, '-map', '0:v:0', '-f', 'null', '-']);
      const frames = Number([...decoded.matchAll(/^frame=(\d+)\s*$/gm)].at(-1)?.[1]);
      assert.equal(frames, Math.round(fixture.duration * 15));
      results.push({ name: fixture.name, frames, ...playback });
      console.log('PASS: ' + fixture.name + ' import, VIN controls, conversion, playback, seeking, download, and ' + frames + ' independently decoded frames');
    }
    assert.deepEqual(outgoing, []);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(workDir, 'results.json'), JSON.stringify({ runtime, results, externalRequests: 0, rendererErrors: 0 }, null, 2));
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
