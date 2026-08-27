// @ts-nocheck
/**
 * UXP capability probe (Phase 0 spike).
 * Covers TDD R-1 (imaging throughput / single-call size ceiling), R-2 (32-bit Float32
 * roundtrip hash + colorProfile + HDR >1 behavior), R-6 (Web Worker availability).
 *
 * Uses require('photoshop').imaging API (getPixels/putPixels live on the imaging
 * submodule, NOT on Document). Document state changes require executeAsModal.
 *
 * Run inside Photoshop via UDT: click "Run capability probe" or rely on the auto-run;
 * results are persisted to the plugin data folder as capability-report.json.
 */
const ps = require('photoshop');
const app = ps.app;
const imaging = ps.imaging;

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** V-1: getPixels/putPixels throughput + single-call size ceiling (24MP target = 6000x4000). */
async function probeSizeLimit() {
  return ps.core.executeAsModal(async () => {
    const sizes = [
      [512, 512],
      [1024, 1024],
      [2048, 2048],
      [4096, 4096],
      [6000, 4000],
    ];
    const out = [];
    for (const [w, h] of sizes) {
      const entry = { size: `${w}x${h}` };
      let doc = null;
      let writeData = null;
      try {
        doc = await app.documents.add({ width: w, height: h, resolution: 72, mode: 'RGBColorMode', depth: 8, fill: 'black' });
        const layerID = doc.activeLayers[0].id;
        const bounds = { left: 0, top: 0, right: w, bottom: h };

        const t0 = Date.now();
        const { imageData } = await imaging.getPixels({
          layerID, sourceBounds: bounds, colorSpace: 'RGB', componentSize: 8, applyAlpha: true,
        });
        const arr = await imageData.getData();
        const t1 = Date.now();

        writeData = await imaging.createImageDataFromBuffer(arr, {
          width: w, height: h, components: 4, colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1',
        });
        await imaging.putPixels({ layerID, imageData: writeData, replace: true, targetBounds: { left: 0, top: 0 } });
        const t2 = Date.now();

        entry.readMs = t1 - t0;
        entry.writeMs = t2 - t1;
        entry.pixelCount = w * h;
        entry.byteLength = arr.byteLength;
        entry.hash = fnv1a(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
      } catch (e) {
        entry.error = String(e);
        out.push(entry);
        break; // hit the ceiling — stop escalating
      } finally {
        if (writeData) { try { writeData.dispose(); } catch (_) {} }
        if (doc) { try { await doc.close({ save: false }); } catch (_) {} }
      }
      out.push(entry);
    }
    return out;
  }, { commandName: 'film-halation-capability-imaging' });
}

/** V-2 / R-2: 32-bit Float32 roundtrip hash + colorProfile read + HDR (>1) clamp behavior. */
async function probeRoundtrip() {
  return ps.core.executeAsModal(async () => {
    const out = { depth32: {}, profile: null, hdr: {} };
    let doc = null;
    let writeData = null;
    try {
      const w = 64;
      const h = 64;
      doc = await app.documents.add({ width: w, height: h, resolution: 72, mode: 'RGBColorMode', depth: 32, fill: 'black' });
      out.profile = doc.colorProfile ?? null;
      const layerID = doc.activeLayers[0].id;
      const bounds = { left: 0, top: 0, right: w, bottom: h };

      const buf = new Float32Array(w * h * 4);
      for (let i = 0; i < buf.length; i += 4) {
        buf[i] = 1.5; // R > 1 (HDR probe)
        buf[i + 1] = 0.25;
        buf[i + 2] = 0.5;
        buf[i + 3] = 1.0;
      }
      writeData = await imaging.createImageDataFromBuffer(buf, {
        width: w, height: h, components: 4, colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1',
      });
      await imaging.putPixels({ layerID, imageData: writeData, replace: true, targetBounds: { left: 0, top: 0 } });

      const { imageData: back } = await imaging.getPixels({
        layerID, sourceBounds: bounds, colorSpace: 'RGB', componentSize: 32, applyAlpha: true,
      });
      const arr = await back.getData();
      out.depth32.byteLength = arr.byteLength;
      out.depth32.hash = fnv1a(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
      out.hdr = {
        writtenR: 1.5,
        readR: arr[0],
        readG: arr[1],
        readB: arr[2],
        readA: arr[3],
      };
      back.dispose();
    } catch (e) {
      out.error = String(e);
    } finally {
      if (writeData) { try { writeData.dispose(); } catch (_) {} }
      if (doc) { try { await doc.close({ save: false }); } catch (_) {} }
    }
    return out;
  }, { commandName: 'film-halation-capability-roundtrip' });
}

/** R-6: Web Worker availability in the UXP runtime. */
async function probeWorker() {
  try {
    const code = 'self.onmessage = function (e) { self.postMessage("pong:" + e.data); };';
    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ available: true, reply: 'timeout' }), 3000);
      worker.onmessage = (e) => {
        clearTimeout(timer);
        resolve({ available: true, reply: String(e.data) });
      };
      worker.onerror = (e) => {
        clearTimeout(timer);
        resolve({ available: false, error: String(e.message || e) });
      };
      worker.postMessage('ping');
    });
  } catch (e) {
    return { available: false, error: String(e) };
  }
}

/** Runs all probes, returns the serializable report, logs to console, and persists to the plugin data folder. */
export async function runProbe() {
  const report = {
    ts: new Date().toISOString(),
    psVersion: app.version,
    imaging: await probeSizeLimit(),
    roundtrip32: await probeRoundtrip(),
    worker: await probeWorker(),
  };
  const json = JSON.stringify(report, null, 2);
  console.log('[film-emulation] capability report:\n' + json);
  try {
    const { localFileSystem } = require('uxp').storage;
    const folder = await localFileSystem.getDataFolder();
    const file = await folder.createFile('capability-report.json', { overwrite: true });
    await file.write(json);
    console.log('[film-emulation] capability report written to plugin data folder');
  } catch (e) {
    console.log('[film-emulation] could not persist report: ' + e);
  }
  return report;
}
