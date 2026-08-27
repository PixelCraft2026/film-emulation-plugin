// @ts-nocheck
import { installWasmModule, getWasmBackendStatus } from '../core/wasmBackend.js';

/** Load the precompiled module from the installed plugin. Failure is intentionally non-fatal. */
export async function loadBundledWasm() {
  try {
    if (typeof WebAssembly === 'undefined') return { available: false, backend: 'js', error: 'WebAssembly unavailable' };
    const { localFileSystem, formats } = require('uxp').storage;
    const pluginFolder = await localFileSystem.getPluginFolder();
    const dist = await pluginFolder.getEntry('dist');
    const wasm = await dist.getEntry('film_core.wasm');
    const bytes = await wasm.read({ format: formats.binary });
    return installWasmModule(bytes);
  } catch (error) {
    console.warn('[film-emulation] WASM unavailable; using JS fallback: ' + (error && (error.message || error)));
    return { ...getWasmBackendStatus(), error: error && (error.message || String(error)) };
  }
}
