import esbuild from 'esbuild';

/** UXP panel bundle: self-contained IIFE, browser-ish platform (UXP provides DOM globals). */
const options = {
  entryPoints: ['src/main.jsx'],
  bundle: true,
  outfile: 'dist/main.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'transform',
  sourcemap: true,
  logLevel: 'info',
  // UXP runtime modules — never bundled.
  external: ['photoshop', 'uxp'],
};

await esbuild.build(options);
console.log('build: dist/main.js written');
