import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const tests = process.argv.includes('--tests');

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** Extension host: Node, CommonJS, `vscode` provided by the editor. */
const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
};

/** Webview UI: browser bundle + extracted CSS. */
const webview = {
  ...common,
  entryPoints: { webview: 'src/webview/main.tsx' },
  outdir: 'dist',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  loader: { '.svg': 'text', '.ttf': 'file' },
  assetNames: '[name]',
};

/** Unit tests for the core (no vscode dependency). */
const testBuild = () => ({
  ...common,
  entryPoints: readdirSync('src/test')
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `src/test/${f}`),
  outdir: 'dist-test',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  alias: { vscode: './src/test/vscode-mock.ts' },
});

const configs = tests ? [testBuild()] : [extension, webview];

if (watch) {
  for (const cfg of configs) await (await esbuild.context(cfg)).watch();
} else {
  await Promise.all(configs.map((cfg) => esbuild.build(cfg)));
}
