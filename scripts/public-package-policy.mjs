export const PUBLIC_DIST_FILES = Object.freeze([
  'main.js',
  'main.js.map',
  'film_core.wasm',
]);

export const PUBLIC_PACKAGE_ENTRIES = Object.freeze([
  'manifest.json',
  'index.html',
  ...PUBLIC_DIST_FILES.map((name) => `dist/${name}`),
]);

export const FORBIDDEN_PUBLIC_MARKERS = Object.freeze([
  'com.cheukwing.filmhalation',
  'filmHalationPanel',
  'FilmHalation-MigrationBridge',
  'Export Migration Package',
  'Import V1.5 State',
  'FilmEmulationMigration',
  'migration-receipt-',
  'film_core_simd.wasm',
]);

export function assertPublicBundleText(bundleText) {
  const required = [
    'Film Emulation V1.7 Public Beta 1',
    'Windows test build',
    'Film Resolution',
    'Randomize grain',
    'Apply memory',
    'Language',
  ];
  const missing = required.find((marker) => !bundleText.includes(marker));
  if (missing) throw new Error(`Public beta bundle is missing required marker: ${missing}`);
  const leaked = FORBIDDEN_PUBLIC_MARKERS.find((marker) => bundleText.includes(marker));
  if (leaked) throw new Error(`Public beta bundle contains retired or unsafe marker: ${leaked}`);
}

export function assertPublicPackageEntries(entries) {
  const actual = [...entries].sort();
  const expected = [...PUBLIC_PACKAGE_ENTRIES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Public package entries differ from policy: ${actual.join(', ')}`);
  }
}
