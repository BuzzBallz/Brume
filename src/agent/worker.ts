// Sokosumi Coworker worker: finds the Tasks assigned to Brume, runs the same job as MIP-003 /start_job on the escrow the
// Task names, and completes the Task with that result. The Sokosumi CLI does the I/O: the account login lists Tasks, the
// Coworker runtime key in the CLI vault starts and completes them (no key is read here).
// One journal per Task in out/worker/, written before every external write, so a restart resumes instead of redoing work:
// an uncertain start or completion is checked against the Task's status before it is retried.
//   COWORKER_ID=<id> node src/agent/worker.ts [--once]
import './env.ts'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HttpError, parseNet, parseRef, ROOT } from './escrow.ts'
import { run } from './mip003.ts'

type Task = { id: string; status: string; coworkerId?: string; description?: string | null }
type Journal = { phase: 'starting' | 'started' | 'result-saved' | 'completing' | 'completed'; input?: string; completedAt?: string }

const COWORKER_ID = process.env.COWORKER_ID ?? ''
if (!/^[0-9a-f-]{36}$/i.test(COWORKER_ID)) throw new Error('COWORKER_ID must be the Brume Coworker id')
const DIR = join(ROOT, 'out', 'worker')
const POLL_MS = 5_000
mkdirSync(DIR, { recursive: true })

const cli = (args: string[]) =>
  JSON.parse(execFileSync('sokosumi', ['--preprod', ...args, '--json'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 << 20 }))
const journalFile = (id: string) => join(DIR, `${id}.json`)
const resultFile = (id: string) => join(DIR, `${id}.txt`)
const read = (id: string): Journal | null => (existsSync(journalFile(id)) ? JSON.parse(readFileSync(journalFile(id), 'utf8')) : null)
const write = (id: string, j: Journal) => writeFileSync(journalFile(id), JSON.stringify(j, null, 1))
const taskNow = (id: string): Task => cli(['tasks', 'get', id]).task ?? cli(['tasks', 'get', id])

// The Task names its escrow in free text: the first `<64 hex>#<index>`, on mainnet unless the text says preprod.
export async function answer(input: string): Promise<string> {
  const ref = input.match(/[0-9a-f]{64}#\d+/i)?.[0]
  if (!ref) return 'No escrow reference found. Put one V1 escrow UTxO in the Task, as <64-hex tx hash>#<index>, and say "preprod" for a preprod escrow (mainnet otherwise, read-only).'
  try {
    return await run(parseNet(/\bpreprod\b/i.test(input) ? 'preprod' : 'mainnet'), parseRef(ref.toLowerCase()))
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return `Escrow ${ref}: ${e.message}`
    throw e // a provider hole: leave the Task running and retry on the next poll, never answer from a failed read
  }
}

async function advance(t: Task) {
  let j = read(t.id)
  if (j?.phase === 'completed') return
  if (!j || j.phase === 'starting') {
    if (t.status === 'READY') {
      write(t.id, { phase: 'starting' })
      const started = cli(['runtime', 'start', t.id, '--personal', '--coworker-id', COWORKER_ID])
      j = { phase: 'started', input: (started.task ?? started).description ?? t.description ?? '' }
    } else if (t.status === 'RUNNING') j = { phase: 'started', input: taskNow(t.id).description ?? '' } // a start whose answer was lost
    else return
    write(t.id, j)
  }
  if (j.phase === 'started') {
    writeFileSync(resultFile(t.id), await answer(j.input ?? ''))
    j = { ...j, phase: 'result-saved' }
    write(t.id, j)
  }
  if (j.phase === 'result-saved' || j.phase === 'completing') {
    // an uncertain completion is retried only if the Task is not COMPLETED already
    if (taskNow(t.id).status !== 'COMPLETED') {
      write(t.id, { ...j, phase: 'completing' })
      cli(['runtime', 'complete', t.id, '--personal', '--coworker-id', COWORKER_ID, '--result-file', resultFile(t.id)])
    }
    write(t.id, { ...j, phase: 'completed', completedAt: new Date().toISOString() })
    console.log(`completed ${t.id}`)
  }
}

async function poll() {
  const tasks: Task[] = cli(['tasks', 'list', '--coworker-id', COWORKER_ID]).tasks ?? []
  for (const t of tasks.filter((t) => t.coworkerId === COWORKER_ID && (t.status === 'READY' || t.status === 'RUNNING'))) {
    try {
      await advance(t)
    } catch (e) {
      console.error(`task ${t.id} not advanced this round: ${(e as Error).message.slice(0, 200)}`)
    }
  }
}

if (process.argv[1]?.endsWith('worker.ts')) {
  console.log(`Brume worker for Coworker ${COWORKER_ID}, journals in out/worker/`)
  for (;;) {
    try {
      await poll()
    } catch (e) {
      console.error(`poll failed: ${(e as Error).message.slice(0, 200)}`)
    }
    if (process.argv.includes('--once')) break
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}
