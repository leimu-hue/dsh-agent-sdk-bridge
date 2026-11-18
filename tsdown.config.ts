import { defineConfig } from 'tsdown'

/**
 * Bundle the host half into `lib/index.js`. Declaration files come from the
 * `tsc` step that runs first (see `package.json` → `build`).
 *
 * The dsh peer packages and every Agent SDK stay external: the harness
 * supplies the former at runtime, and the SDKs must remain real node_modules
 * packages because each carries its own CLI. The non-CN SDKs are loaded
 * through variable dynamic imports (`src/host/infra/sdk.ts`), which the
 * bundler cannot resolve anyway; the rules keep them that way.
 */
const host = {
  entry: ['src/host/index.ts'],
  outDir: 'lib',
  format: ['esm'] as const,
  // The package's `exports` map names `lib/index.js`, so pin the extension
  // rather than letting tsdown pick `.mjs` from the module format.
  outExtensions: () => ({ js: '.js' }),
  platform: 'node' as const,
  target: 'node22',
  dts: false,
  clean: false,
  deps: {
    neverBundle: [
      /^@deepseek-ai\//,
      /^@qodercn-ai\//,
      /^@qoder-ai\//,
      /^@tencent-ai\//,
      'zod',
    ],
  },
}

/**
 * Bundle the browser half into `lib/client.js`.
 *
 * The dsh web shell does not import a module: it hands the file to
 * `window.__ModuleLoader__.load`, which calls `factory(require)` and only then
 * supplies `react`. So the bundle is CommonJS with `react` external — its
 * `require('react')` calls resolve against the factory's own parameter — and
 * the `banner`/`footer` below wrap that CommonJS body in the factory the shell
 * expects. Nothing else may run at file scope: the shell evaluates the file
 * before any component mounts, and a browser-only global touched there would
 * break the shell's own test harness.
 */
const client = {
  entry: { client: 'src/client/index.tsx' },
  // The bundle is build output, not a hand-maintained file at the repo root:
  // it belongs in `lib/` beside the host half, and `exports['./client']`
  // points there.
  outDir: 'lib',
  format: ['cjs'] as const,
  platform: 'browser' as const,
  target: 'es2022',
  // The client has its own program: DOM libs, and the classic JSX transform so
  // the emitted code calls `React.createElement` and never reaches for
  // `react/jsx-runtime` — which this shell's `require` does not resolve.
  tsconfig: 'tsconfig.client.json',
  dts: false,
  clean: false,
  deps: {
    neverBundle: ['react', 'react/jsx-runtime'],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: [
      'window.__ModuleLoader__.load({',
      "  id: 'dsh-agent-sdk-bridge',",
      '  factory: require => {',
      '    const module = { exports: {} };',
      '    const exports = module.exports;',
    ].join('\n'),
    footer: [
      '    return module.exports;',
      '  },',
      '});',
    ].join('\n'),
  },
}

export default defineConfig([host, client])
