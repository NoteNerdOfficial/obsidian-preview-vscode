import * as esbuild from 'esbuild';

const production = process.argv.includes('production');
const watch = process.argv.includes('watch');

/** Extension host bundle: Node/CJS, `vscode` stays external. */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info'
};

/**
 * Webview bundle: browser/IIFE. Everything is inlined because the webview
 * cannot reach the filesystem or a CDN.
 */
const webviewConfig = {
  entryPoints: ['webview/main.ts'],
  outfile: 'dist/webview.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2021',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  // moment pulls in its whole locale directory otherwise.
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' }
};

const cssConfig = {
  entryPoints: ['webview/style.css'],
  outfile: 'dist/webview.css',
  bundle: true,
  minify: production,
  logLevel: 'info'
};

const configs = [extensionConfig, webviewConfig, cssConfig];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[esbuild] watching...');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  console.log('[esbuild] build complete');
}
