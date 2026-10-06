// Sokosumi Coworker worker: finds the Tasks assigned to Brume, runs the same job as MIP-003 /start_job on the escrow the
// Task names, and completes the Task with that result. The Sokosumi CLI does the I/O: the account login lists Tasks, the
// Coworker runtime key in the CLI vault starts and completes them (no key is read here).
// One journal per Task in out/worker/, written before every external write, so a restart resumes instead of redoing work:
// an uncertain start or completion is checked against the Task's status before it is retried.
// PAID_TASKS=true: each newly started Task is paid first (1 test USDM through our payment service, see paid.ts).
//   COWORKER_ID=<id> [PAID_TASKS=true] node src/agent/worker.ts [--once]
import './env.ts'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HttpError, parseNet, parseRef, ROOT } from './escrow.ts'
import { run } from './mip003.ts'
import { advancePaid, type Paid } from './paid.ts'

type Task = { id: string; status: string; coworkerId?: string; description?: string | null }
// Where Tasks come from: the personal Workspace, and the TOKEN2049 event Workspace once the Coworker's access is granted.
type Scope = { name: string; list: string[]; runtime: string[] }
const SCOPES: Scope[] = [
  { name: 'personal', list: [], runtime: ['--personal'] },
  { name: 'event', list: ['--organization-slug', 'token2049-origins-hackathon-2026-nws2r7'], runtime: ['--organization-id', '01a109d1-32a9-71a3-a0e3-658b2a7987cd'] },
]
type Journal = { phase: 'starting' | 'started' | 'result-saved' | 'completing' | 'completed' | 'paid'; input?: string; completedAt?: string; scope?: string; paid?: Paid }

const COWORKER_ID = process.env.COWORKER_ID ?? ''
if (!/^[0-9a-f-]{36}$/i.test(COWORKER_ID)) throw new Error('COWORKER_ID must be the Brume Coworker id')
const DIR = join(ROOT, 'out', 'worker')
const POLL_MS = 5_000
const PAID = process.env.PAID_TASKS === 'true'
mkdirSync(DIR, { recursive: true })

const cli = (args: string[]) =>
  JSON.parse(execFileSync('sokosumi', ['--preprod', ...args, '--json'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 << 20 }))
const journalFile = (id: string) => join(DIR, `${id}.json`)
const resultFile = (id: string) => join(DIR, `${id}.txt`)
const read = (id: string): Journal | null => (existsSync(journalFile(id)) ? JSON.parse(readFileSync(journalFile(id), 'utf8')) : null)
const write = (id: string, j: Journal) => writeFileSync(journalFile(id), JSON.stringify(j, null, 1))
const taskNow = (id: string, s: Scope): Task => {
  const r = cli(['tasks', 'get', id, ...s.list])
  return r.task ?? r
}

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

async function advance(t: Task, s: Scope) {
  let j = read(t.id)
  if (j?.phase === 'completed') return
  if (!j || j.phase === 'starting') {
    if (t.status === 'READY') {
      write(t.id, { phase: 'starting' })
      const started = cli(['runtime', 'start', t.id, ...s.runtime, '--coworker-id', COWORKER_ID])
      j = { phase: 'started', input: (started.task ?? started).description ?? t.description ?? '' }
    } else if (t.status === 'RUNNING') j = { phase: 'started', input: taskNow(t.id, s).description ?? '' } // a start whose answer was lost
    else return
    write(t.id, j)
  }
  if (j.phase === 'started' && PAID) j = { ...j, phase: 'paid', scope: s.name, paid: { stage: 'new' } }
  if (j.phase === 'paid') return pay(t.id, j, s)
  if (j.phase === 'started') {
    writeFileSync(resultFile(t.id), await answer(j.input ?? ''))
    j = { ...j, phase: 'result-saved' }
    write(t.id, j)
  }
  if (j.phase === 'result-saved' || j.phase === 'completing') {
    // an uncertain completion is retried only if the Task is not COMPLETED already
    if (taskNow(t.id, s).status !== 'COMPLETED') {
      write(t.id, { ...j, phase: 'completing' })
      cli(['runtime', 'complete', t.id, ...s.runtime, '--coworker-id', COWORKER_ID, '--result-file', resultFile(t.id)])
    }
    write(t.id, { ...j, phase: 'completed', completedAt: new Date().toISOString() })
    console.log(`completed ${t.id} (${s.name})`)
  }
}

// A paid Task advances one stage per poll until it settles; it stays in the journal after its completion, until the
// payment service has collected and the seller receipt is in.
async function pay(id: string, j: Journal, s: Scope) {
  let p = j.paid as Paid
  for (let step = 0; step < 6; step++) {
    const before = p.stage
    p = await advancePaid(p, {
      taskId: id, input: j.input ?? '', coworkerId: COWORKER_ID,
      answer, saveResult: (r) => writeFileSync(resultFile(id), r),
      complete: () => cli(['runtime', 'complete', id, ...s.runtime, '--coworker-id', COWORKER_ID, '--result-file', resultFile(id)]),
      receipt: () => cli(['runtime', 'receipt', id, '--coworker-id', COWORKER_ID]),
      save: (q) => write(id, { ...j, paid: q }),
    })
    if (p.stage === before) break
    console.log(`task ${id}: ${p.stage}`)
  }
  if (p.stage === 'settled') write(id, { ...j, phase: 'completed', paid: p, completedAt: new Date().toISOString() })
}

async function poll() {
  for (const f of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
    const j: Journal = JSON.parse(readFileSync(join(DIR, f), 'utf8'))
    const s = SCOPES.find((x) => x.name === j.scope)
    if (j.phase !== 'paid' || j.paid?.stage !== 'awaiting-withdrawal' || !s) continue
    try {
      await pay(f.slice(0, -5), j, s)
    } catch (e) {
      console.error(`task ${f.slice(0, -5)} not advanced this round: ${(e as Error).message.slice(0, 200)}`)
    }
  }
  for (const s of SCOPES) {
    let tasks: Task[]
    try {
      tasks = cli(['tasks', 'list', '--coworker-id', COWORKER_ID, ...s.list]).tasks ?? []
    } catch (e) {
      console.error(`${s.name}: list failed: ${(e as Error).message.slice(0, 200)}`)
      continue
    }
    for (const t of tasks.filter((t) => t.coworkerId === COWORKER_ID && (t.status === 'READY' || t.status === 'RUNNING'))) {
      try {
        await advance(t, s)
      } catch (e) {
        console.error(`task ${t.id} not advanced this round: ${(e as Error).message.slice(0, 200)}`)
      }
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
