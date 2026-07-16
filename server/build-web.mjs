import { build } from 'esbuild'

await build({
  entryPoints: ['server/web/lan-pairing.js'],
  outfile: 'server/web/lan-pairing.bundle.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome109', 'safari16'],
  minify: true,
  legalComments: 'none',
})
