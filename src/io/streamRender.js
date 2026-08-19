// @ts-nocheck
/** Host row-band renderer: keeps 24MP 16-bit peak memory below a whole-float-image pipeline. */
import { processTiledWithTrc } from './tileRender.js';
import { readDocumentPixels, encodeDisplayRgbaBuffer, writeDocumentRgbaBuffer } from './imageAccess.js';
import { streamGeometry } from './streamGeometry.js';
import { normalizeComponentSize } from './bitDepth.js';
import { documentProfileName, resolvePixelTRC } from './colorPipeline.js';
export { streamGeometry } from './streamGeometry.js';

/**
 * Read source bands, render them, quantize directly into one final RGBA buffer, then perform
 * exactly one target putPixels. The Photoshop source layer is read-only throughout.
 */
export async function renderDocumentToLayer(doc, sourceLayer, targetLayer, sourceBounds, targetBounds, params, trc, options = {}) {
  const width = sourceBounds.right - sourceBounds.left;
  const height = sourceBounds.bottom - sourceBounds.top;
  if (targetBounds.right - targetBounds.left !== width || targetBounds.bottom - targetBounds.top !== height) {
    throw new Error('Safe copy bounds do not match source bounds');
  }
  const componentSize = normalizeComponentSize(options.componentSize ?? doc.bitsPerChannel);
  const output = componentSize === 8 ? new Uint8Array(width * height * 4) : componentSize === 16 ? new Uint16Array(width * height * 4) : new Float32Array(width * height * 4);
  const geometry = streamGeometry(width, height, params);
  let pixelProfile = '';
  let outputTrc = null;
  for (let bandIndex = 0; bandIndex < geometry.bands.length; bandIndex++) {
    if (options.signal?.aborted) throw new Error('Film render cancelled');
    const band = geometry.bands[bandIndex];
    const bandBounds = {
      left: sourceBounds.left,
      top: sourceBounds.top + band.start,
      right: sourceBounds.right,
      bottom: sourceBounds.top + band.end,
    };
    const source = await readDocumentPixels(doc, {
      // Native-depth reads preserve the document encoding. Forcing a 16-bit
      // document to componentSize 32 can make Photoshop return Linear Profile
      // pixels, which must not be decoded again as gamma-encoded Rec.2020.
      componentSize,
      layerID: sourceLayer.id,
      layerName: sourceLayer.name,
      bounds: bandBounds,
    });
    const sourceTrc = resolvePixelTRC(doc, source.colorProfile);
    const bandProfile = String(source.colorProfile || documentProfileName(doc)).trim();
    if (!outputTrc) {
      outputTrc = sourceTrc;
      pixelProfile = bandProfile;
      console.log(`[film-halation] Apply pixel profile: "${pixelProfile || 'document default'}" (${sourceTrc.profileKey})`);
    } else if (bandProfile && pixelProfile && bandProfile !== pixelProfile) {
      throw new Error(`Imaging API changed color profile between bands: "${pixelProfile}" vs "${bandProfile}"`);
    }
    const rendered = processTiledWithTrc(source, geometry.params, sourceTrc, {
      tileThreshold: Number.MAX_SAFE_INTEGER,
      // Keep the rendered buffer in the exact profile returned by getPixels.
      // Declaring a different Rec.2020 profile on write makes Photoshop perform
      // another conversion and changes the base image even at strength=0.
      outputTrc: sourceTrc,
    });
    const encoded = encodeDisplayRgbaBuffer(rendered, componentSize, {
      rolloff: geometry.params.rolloff,
      dither: componentSize !== 32,
      seed: options.seed ?? 0x46534c4d,
      pixelOffset: band.start * width,
    });
    const sourceRow = (band.y0 - band.start) * width * 4;
    const targetRow = band.y0 * width * 4;
    const values = (band.y1 - band.y0) * width * 4;
    output.set(encoded.subarray(sourceRow, sourceRow + values), targetRow);
    options.onProgress?.((bandIndex + 1) / geometry.bands.length);
  }
  await writeDocumentRgbaBuffer(doc, { width, height, buffer: output }, {
    componentSize,
    layerID: targetLayer.id,
    layerName: targetLayer.name,
    bounds: targetBounds,
    // The buffer remains in the document pixel space returned by getPixels.
    // Leave the image-data profile empty so putPixels adopts the target
    // document profile. Some returned labels are not accepted by
    // createImageDataFromBuffer and produce Photoshop error -26120.
    colorProfile: '',
  });
  return {
    width,
    height,
    bands: geometry.bands.length,
    outputBytes: output.byteLength,
    colorProfile: pixelProfile,
  };
}
