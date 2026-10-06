// pnpm sign — the file-drop signature path (guaranteed path; CIP-30 is the upgrade).
//   pnpm sign --prepare <escrowRef> [--share 0.4]   seller side: writes out/proposals/<hash>_<index>.json
//   pnpm sign --role buyer <file>                   buyer signs leg 2 in the file, in place
//   pnpm sign --role seller <file>                  seller: checks the buyer's leg-2 signature, signs leg 1, sends both
//   pnpm sign --resend <escrowRef>                  sends a saved, fully signed leg 2 once leg 1 is visible
// Keys come from .env (PREPROD_BUYER_SKEY / PREPROD_SELLER_SKEY); nothing secret is printed or written to the file.
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { Proposal, TxLogEntry } from '../../shared/types.ts'
import { prepare, proposalFile, resend, SettleError, sign, submit, txLogFile } from './settle.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { role: { type: 'string' }, prepare: { type: 'string' }, share: { type: 'string', default: '0.4' }, resend: { type: 'string' }, 'no-replay': { type: 'boolean', default: false } },
})

const line = (e: TxLogEntry): string =>
  `  ${e.step}: ${e.status} at ${e.stage}${e.block ? `, block ${e.block.height}` : ''}${e.refusal ? ` (phase ${e.refusal.phase}: ${e.refusal.ledgerError.slice(0, 120)})` : ''}${e.error && !e.refusal ? ` — ${e.error.slice(0, 160)}` : ''}`

try {
  if (values.prepare) {
    const p = await prepare(values.prepare, Number(values.share))
    console.log(`proposal ${proposalFile(values.prepare)}`)
    console.log(`  leg 1 ${p.leg1?.txHash} (unsigned, valid until ${new Date(p.leg1?.validToMs ?? 0).toISOString()})`)
    console.log(`  leg 2 ${p.leg2?.txHash} (spends leg 1 output 0, which does not exist yet)`)
    console.log(`  split: seller ${JSON.stringify(p.payout.seller)} / buyer ${JSON.stringify(p.payout.buyer)}`)
    console.log(`next: pnpm sign --role buyer ${proposalFile(values.prepare)}`)
  } else if (values.resend) {
    console.log(line(await resend(values.resend)))
  } else if (values.role && positionals[0]) {
    const file = positionals[0]
    const proposal = JSON.parse(readFileSync(file, 'utf8')) as Proposal
    if (values.role === 'buyer') {
      writeFileSync(file, JSON.stringify(await sign('buyer', proposal), null, 2) + '\n')
      console.log(`buyer signed leg 2 ${proposal.leg2?.txHash} in ${file}`)
      console.log(`next: pnpm sign --role seller ${file}`)
    } else if (values.role === 'seller') {
      const log = await submit(proposal, { replay: !values['no-replay'] })
      for (const e of log) console.log(line(e))
      console.log(`log ${txLogFile(proposal.escrowRef)}`)
    } else throw new SettleError('--role buyer|seller')
  } else {
    throw new SettleError('usage: pnpm sign --prepare <ref> [--share 0.4] | --role buyer|seller <file> | --resend <ref>')
  }
} catch (error: unknown) {
  // SettleError is the readable sentence meant for a person; anything else keeps its type and message.
  console.error(error instanceof SettleError ? error.message : error instanceof Error ? `${error.name}: ${error.message.slice(0, 600)}` : String(error))
  process.exitCode = 1
}
