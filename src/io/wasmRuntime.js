// @ts-nocheck
import { installWasmModule, getWasmBackendStatus } from '../core/wasmBackend.js';

export const BUNDLED_SIMD_POLICY = 'disabled-uxp-host-compatibility';

/**
 * Load the precompiled scalar module from the installed plugin. Failure is
 * intentionally non-fatal.
 *
 * The separately built SIMD artifact remains available to Node QA, but must
 * not be read, validated, or instantiated by UXP. Photoshop 27.1 / UXP 9.0.2
 * can terminate the host process while compiling the current simd128 module;
 * that failure occurs below JavaScript and therefore cannot be caught here.
 *
 * @param {{storage?: any, install?: typeof installWasmModule}} [options]
 */
export async function loadBundledWasm(options = {}) {
  try {
    if (typeof WebAssembly === 'undefined') return { available: false, backend: 'js', error: 'WebAssembly unavailable' };
    const { localFileSystem, formats } = options.storage ?? require('uxp').storage;
    const install = options.install ?? installWasmModule;
    const pluginFolder = await localFileSystem.getPluginFolder();
    const dist = await pluginFolder.getEntry('dist');
    const wasm = await dist.getEntry('film_core.wasm');
    const bytes = await wasm.read({ format: formats.binary });
    const status = await install(bytes);
    return { ...status, simdPolicy: BUNDLED_SIMD_POLICY };
  } catch (error) {
    console.warn('[film-emulation] WASM unavailable; using JS fallback: ' + (error && (error.message || error)));
    return {
      ...getWasmBackendStatus(),
      error: error && (error.message || String(error)),
      simdPolicy: BUNDLED_SIMD_POLICY,
    };
  }
}
