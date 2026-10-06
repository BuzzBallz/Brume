import { existsSync } from 'node:fs'

// Must be the first import of the entry point: later modules read process.env when they load.
if (existsSync('.env')) process.loadEnvFile('.env')
