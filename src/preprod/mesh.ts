import { createRequire } from 'node:module'

// Mesh is loaded through its CommonJS build. Its ESM build pulls libsodium-wrappers-sumo 0.7.16's ESM entry, which imports
// a file the package does not ship (ERR_MODULE_NOT_FOUND libsodium-sumo.mjs), so `import … from '@meshsdk/core'` fails
// under Node. The CJS entry loads and signs (checked 6 Oct, two partial signatures, hash unchanged).
// Values come from here; types may still be imported with `import type`.
const require = createRequire(import.meta.url)

export const mesh: typeof import('@meshsdk/core') = require('@meshsdk/core')
// The direct @meshsdk/core-cst dependency (1.9.0-beta.90): the copy that applies V1 params exactly (PLAN §10). Hex in, hex out.
export const cst: typeof import('@meshsdk/core-cst') = require('@meshsdk/core-cst')
// The core-cst copy @meshsdk/core builds with (beta.96): used only to re-encode a body it built, so the encoding matches.
export const builderCst: typeof import('@meshsdk/core-cst') = createRequire(require.resolve('@meshsdk/core'))('@meshsdk/core-cst')
