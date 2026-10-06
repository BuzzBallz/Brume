import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Must be the first import of the entry point: later modules read process.env when they load. The repository's file,
// wherever the agent is started from: a path relative to the working directory silently missed it from elsewhere.
const file = join(import.meta.dirname, '..', '..', '.env')
if (existsSync(file)) process.loadEnvFile(file)
