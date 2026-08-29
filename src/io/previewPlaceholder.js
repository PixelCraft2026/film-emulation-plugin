// @ts-check
import { gaussianBlurSep } from '../core/diffuse/conv.js';
import { downsampleBox, downsamplePlane } from './preview.js';

/**
 * Build a deliberately heavy, host-independent Gaussian placeholder.
 * The tiny blurred raster is later displayed at the source layout size; this
 * avoids relying on CSS filter support in Photoshop UXP.
 *
 * @param {{width:number,height:number,rgb:Float32Array,alpha?:Float32Array,layoutWidth?:number,layoutHeight?:number}} source
 * @param {{maxEdge?:number,sigma?:number}} [options]
 */
export function createHeavyBlurPlaceholder(source, options = {}) {
  const width = Math.floor(Number(source?.width));
  const height = Math.floor(Number(source?.height));
  if (!(width > 0 && height > 0) || !(source?.rgb instanceof Float32Array) || source.rgb.length !== width * height * 3) {
    throw new RangeError('Heavy blur placeholder source dimensions do not match RGB data');
  }
  if (source.alpha && (!(source.alpha instanceof Float32Array) || source.alpha.length !== width * height)) {
    throw new RangeError('Heavy blur placeholder alpha dimensions do not match');
  }
  const maxEdge = Math.max(16, Math.floor(Number(options.maxEdge ?? 40)));
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const reduced = scale < 1
    ? downsampleBox(source.rgb, width, height, targetWidth, targetHeight)
    : new Float32Array(source.rgb);
  const pixels = targetWidth * targetHeight;
  const plane = new Float32Array(pixels);
  const blurred = new Float32Array(pixels);
  const tempA = new Float32Array(pixels);
  const tempB = new Float32Array(pixels);
  const output = new Float32Array(pixels * 3);
  const sigma = Math.max(1, Math.min(4, Number(options.sigma ?? 2.4)));
  for (let channel = 0; channel < 3; channel += 1) {
    for (let index = 0; index < pixels; index += 1) plane[index] = reduced[index * 3 + channel];
    gaussianBlurSep(plane, blurred, tempA, tempB, targetWidth, targetHeight, sigma);
    for (let index = 0; index < pixels; index += 1) output[index * 3 + channel] = blurred[index];
  }
  const alpha = source.alpha
    ? (scale < 1
      ? downsamplePlane(source.alpha, width, height, targetWidth, targetHeight)
      : new Float32Array(source.alpha))
    : undefined;
  return {
    width: targetWidth,
    height: targetHeight,
    layoutWidth: Math.floor(Number(source.layoutWidth ?? width)),
    layoutHeight: Math.floor(Number(source.layoutHeight ?? height)),
    rgb: output,
    alpha,
  };
}
