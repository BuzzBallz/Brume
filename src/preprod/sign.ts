// pnpm sign — the file-drop signature path (guaranteed path; CIP-30 is the upgrade).
//   pnpm sign --prepare <escrowRef> [--share 0.4]   seller side: writes out/proposals/<hash>_<index>.json
//   pnpm sign --role buyer <file>                   buyer signs leg 2 in the file, in place
//   pnpm sign --role seller <file>                  seller: checks the buyer's leg-2 signature, signs leg 1, sends both
//   pnpm sign --resend <escrowRef>                  sends a saved, fully signed leg 2 once leg 1 is visible
// The split, negotiated first as CIP-8 signed messages (S-6), in out/negotiation/<hash>_<index>.json:
//   pnpm sign --offer <ref> --share 0.4 --role buyer|seller      opens the negotiation (the offer expires in 30 min)
//   pnpm sign --counter <ref> --share 0.3 --role buyer|seller    answers the open offer with another share
//   pnpm sign --accept <ref> --role buyer|seller                 accepts the share on the table; nothing follows it
//   pnpm sign --negotiation <ref>                                verifies and prints the transcript (no key needed)
// --prepare without --share takes the accepted share of a verified negotiation when one is on file; --share overrides it.
// Each message signs its own time, so an accepted negotiation stays verifiable as a record; --prepare acts on it only
// while the accept is fresh (30 min), and a new --offer replaces a negotiation whose accept is no longer fresh.
// One mode per run: a combination of modes, or a flag the mode would ignore, is refused before anything is read.
// Keys come from .env (PREPROD_BUYER_SKEY / PREPROD_SELLER_SKEY); nothing secret is printed or written to the file.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { Proposal, TxLogEntry } from '../../shared/types.ts'
import { expectedFor, negotiate, negotiated, negotiationFile, offerHash, parseMessage, readTranscript, verifyTranscript, type Offer, type OfferKind, type Outcome } from './cip8.ts'
import { prepare, proposalFile, resend, SettleError, sign, submit, txLogFile } from './settle.ts'

const DEFAULT_SHARE = 0.4 // --prepare's share when neither --share nor a negotiation gives one

const OPTIONS = {
  role: { type: 'string' }, prepare: { type: 'string' }, share: { type: 'string' }, resend: { type: 'string' }, 'no-replay': { type: 'boolean', default: false },
  offer: { type: 'string' }, counter: { type: 'string' }, accept: { type: 'string' }, negotiation: { type: 'string' },
} as const
const MODES = ['prepare', 'resend', 'offer', 'counter', 'accept', 'negotiation'] as const
export type Mode = (typeof MODES)[number] | 'file'
const STEP = { offer: 'propose', counter: 'counter', accept: 'accept' } as const satisfies Record<string, OfferKind>
const USAGE = 'usage: pnpm sign --prepare <ref> [--share 0.4] | --role buyer|seller <file> | --resend <ref> | --offer|--counter <ref> --share <s> --role buyer|seller | --accept <ref> --role buyer|seller | --negotiation <ref>'
const flag = (m: Mode): string => (m === 'file' ? 'a proposal file' : `--${m}`)

export type Args = { mode: Mode; target: string; role?: 'buyer' | 'seller'; share?: number; replay: boolean }

// The run's one mode and the flags it uses, from argv. Nothing is read, signed or fetched here.
export function parse(argv: string[]): Args {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS })
  const modes: Mode[] = [...MODES.filter((m) => values[m] !== undefined), ...(positionals.length ? ['file' as const] : [])]
  if (modes.length === 0) throw new SettleError(USAGE)
  if (modes.length > 1) throw new SettleError(`One mode at a time: ${modes.map(flag).join(' and ')} were given together.`)
  const mode = modes[0]
  if (positionals.length > 1) throw new SettleError(`One proposal file at a time: ${positionals.length} were given.`)
  const target = mode === 'file' ? positionals[0] : values[mode]
  if (!target) throw new SettleError(`${flag(mode)} names ${mode === 'file' ? 'a file' : 'an escrow: <tx hash>#<index>'}.`)
  const signs = mode === 'file' || mode === 'offer' || mode === 'counter' || mode === 'accept'
  if (values.role !== undefined && !signs) throw new SettleError(`--role is for a signing step, not ${flag(mode)}.`)
  if (signs && values.role !== 'buyer' && values.role !== 'seller') throw new SettleError(`${flag(mode)} needs --role buyer|seller`)
  if (values['no-replay'] && !(mode === 'file' && values.role === 'seller')) throw new SettleError('--no-replay is for pnpm sign --role seller <file> only.')
  let share: number | undefined
  if (values.share !== undefined) {
    if (mode === 'accept') throw new SettleError('An accept repeats the share on the table: no --share.')
    if (mode !== 'prepare' && mode !== 'offer' && mode !== 'counter') throw new SettleError(`--share is for --prepare, --offer and --counter, not ${flag(mode)}.`)
    share = Number(values.share)
    if (!(share > 0 && share < 1)) throw new SettleError('--share is a seller share strictly between 0 and 1.')
  }
  if ((mode === 'offer' || mode === 'counter') && share === undefined) throw new SettleError(`A ${STEP[mode]} names a seller share: --share 0.4`)
  const role = values.role === 'buyer' || values.role === 'seller' ? values.role : undefined
  return { mode, target, ...(role ? { role } : {}), ...(share !== undefined ? { share } : {}), replay: !values['no-replay'] }
}

const line = (e: TxLogEntry): string =>
  `  ${e.step}: ${e.status} at ${e.stage}${e.block ? `, block ${e.block.height}` : ''}${e.refusal ? ` (phase ${e.refusal.phase}: ${e.refusal.ledgerError.slice(0, 120)})` : ''}${e.error && !e.refusal ? ` — ${e.error.slice(0, 160)}` : ''}`

const iso = (ms: number): string => new Date(ms).toISOString()
const offerLine = (o: Offer): string => `  ${o.kind} by the ${o.by}: seller share ${o.sellerShare}, expires ${iso(o.expiresMs)}, hash ${offerHash(o)}${o.prev ? `, prev ${o.prev}` : ''}`
const verdict = (o: Outcome): string =>
  o.accepted ? `accepted: seller share ${o.sellerShare}, accepted by the ${o.by} at ${iso(o.last.atMs)}${o.fresh ? `, fresh until ${iso(o.last.expiresMs)}` : ', no longer fresh: negotiate again to prepare from it'}`
    : `${o.expired ? 'expired' : 'open'}: ${o.last.kind} by the ${o.last.by} at ${o.last.sellerShare}, ${o.expired ? 'expired' : 'expires'} ${iso(o.last.expiresMs)}`

// The share --prepare uses: --share, else the accepted share of the negotiation on file, else the default when there is none.
// A negotiation on file that is refused or not accepted stops the prepare: it never falls back to the default silently.
async function prepareShare(ref: string, given: number | undefined): Promise<{ share: number; from: string }> {
  const onFile = existsSync(negotiationFile(ref))
  if (given !== undefined) return { share: given, from: `--share${onFile ? ` (a negotiation is on file and not used: pnpm sign --negotiation ${ref})` : ''}` }
  if (!onFile) return { share: DEFAULT_SHARE, from: 'the default: no negotiation on file' }
  let o: Awaited<ReturnType<typeof negotiated>>
  try {
    o = await negotiated(ref)
  } catch (error: unknown) {
    if (error instanceof SettleError) throw new SettleError(`${error.message} (${negotiationFile(ref)}; negotiate again, or pass --share to prepare without it)`, { cause: error })
    throw error
  }
  if (!o?.accepted || o.sellerShare === undefined) throw new SettleError(`The negotiation of ${ref} is not accepted (${o ? verdict(o) : 'empty'}): accept it, or pass --share.`)
  if (!o.fresh) throw new SettleError(`The negotiation of ${ref} was accepted at ${o.sellerShare}, but its accept expired at ${iso(o.last.expiresMs)}: negotiate again, or pass --share.`)
  return { share: o.sellerShare, from: `the accepted negotiation, head ${o.head}` }
}

async function main(a: Args): Promise<void> {
  if (a.mode === 'prepare') {
    const { share, from } = await prepareShare(a.target, a.share)
    console.log(`seller share ${share}, from ${from}`)
    const p = await prepare(a.target, share)
    console.log(`proposal ${proposalFile(a.target)}`)
    console.log(`  leg 1 ${p.leg1?.txHash} (unsigned, valid until ${new Date(p.leg1?.validToMs ?? 0).toISOString()})`)
    console.log(`  leg 2 ${p.leg2?.txHash} (spends leg 1 output 0, which does not exist yet)`)
    console.log(`  split: seller ${JSON.stringify(p.payout.seller)} / buyer ${JSON.stringify(p.payout.buyer)}`)
    console.log(`next: pnpm sign --role buyer ${proposalFile(a.target)}`)
  } else if (a.mode === 'offer' || a.mode === 'counter' || a.mode === 'accept') {
    const ref = a.target
    const role = a.role as 'buyer' | 'seller'
    const step = await negotiate(ref, STEP[a.mode], role, a.share)
    if (step.replaced) console.log(`replaces the negotiation on file (${step.replaced})`)
    console.log(offerLine(step.message.offer))
    console.log(`  signed from ${step.address}`)
    console.log(`negotiation ${step.file} (${step.outcome.messages} message${step.outcome.messages > 1 ? 's' : ''}): ${verdict(step.outcome)}`)
    const other = role === 'buyer' ? 'seller' : 'buyer'
    console.log(step.outcome.accepted ? `next: pnpm sign --prepare ${ref}` : `next: pnpm sign --accept ${ref} --role ${other}, or pnpm sign --counter ${ref} --share <s> --role ${other}`)
  } else if (a.mode === 'negotiation') {
    const ref = a.target
    const raw = readTranscript(negotiationFile(ref))
    if (!raw) throw new SettleError(`No negotiation on file for ${ref} (${negotiationFile(ref)}).`)
    const o = await verifyTranscript(raw, await expectedFor(ref), Date.now())
    if (o.last.escrowRef !== ref) throw new SettleError(`${negotiationFile(ref)} is about another escrow.`)
    console.log(`negotiation ${negotiationFile(ref)}: ${o.messages} message${o.messages > 1 ? 's' : ''}, every signature checked against the escrow's datum on chain`)
    for (const m of raw.map(parseMessage)) console.log(offerLine(m.offer))
    console.log(verdict(o))
  } else if (a.mode === 'resend') {
    console.log(line(await resend(a.target)))
  } else {
    const file = a.target
    const proposal = JSON.parse(readFileSync(file, 'utf8')) as Proposal
    if (a.role === 'buyer') {
      writeFileSync(file, JSON.stringify(await sign('buyer', proposal), null, 2) + '\n')
      console.log(`buyer signed leg 2 ${proposal.leg2?.txHash} in ${file}`)
      console.log(`next: pnpm sign --role seller ${file}`)
    } else {
      const log = await submit(proposal, { replay: a.replay })
      for (const e of log) console.log(line(e))
      console.log(`log ${txLogFile(proposal.escrowRef)}`)
    }
  }
}

// Only as the CLI: a test imports parse() without running a mode.
if (import.meta.main) {
  try {
    await main(parse(process.argv.slice(2)))
  } catch (error: unknown) {
    // SettleError is the readable sentence meant for a person; anything else keeps its type and message.
    console.error(error instanceof SettleError ? error.message : error instanceof Error ? `${error.name}: ${error.message.slice(0, 600)}` : String(error))
    process.exitCode = 1
  }
}
