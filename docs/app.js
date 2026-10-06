// Brume UI. One flag picks the data source: ?source=live (agent API), snapshot (docs/data, GitHub Pages) or mock (shared/mock).

const REDEEMERS = ['Withdraw', 'SetRefundRequested', 'UnSetRefundRequested', 'WithdrawRefund', 'WithdrawDisputed', 'SubmitResult', 'AuthorizeRefund'] // = REDEEMER in shared/types.ts
const ROLES = ['buyer', 'seller', 'admin']
const STATE_LABEL = { FundsLocked: 'Funds locked', ResultSubmitted: 'Result submitted', RefundRequested: 'Refund requested', Disputed: 'Disputed', Settled: 'Settled' } // Settled: UI only, a spent bank escrow
const MOCK_FILE = { census: 'census', grid: 'grid', datum: 'datum-disputed', solver: 'solver', proposal: 'proposal', settle: 'proposal', txlog: 'txlog' }
const USDM = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d' // = USDM in shared/constants.ts
const TUSDM = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d' // preprod test USDM in the bank escrows (stream A, 6 Oct); to move into shared/constants.ts
const SCRIPT_HASH = 'bd2adb685621e224aae7571cb6bd8f0beb0fdd31875eb3a27feee6c0' // = SCRIPT_HASH in shared/constants.ts: the shared V1 script, same bytes on mainnet and preprod
const EXPLORER = 'https://preprod.cexplorer.io/tx/' // DESIGN §10.2: format confirmed by eye on the first real tx
const POLL_MS = 2000

const params = new URLSearchParams(location.search)
const source = params.get('source') ?? (location.hostname.endsWith('github.io') ? 'snapshot' : 'live')
const live = source === 'live'
const $ = id => document.getElementById(id)

// Routes served by src/agent/server.ts; bank and txlog are requested from the back end (DESIGN §8).
const enc = encodeURIComponent
const LIVE = {
  census: () => '/api/census',
  bank: () => '/api/bank',
  datum: (ref, net) => `/api/datum?net=${net}&ref=${enc(ref)}`,
  grid: ref => `/api/grid?ref=${enc(ref)}`,
  solver: ref => `/api/solver?ref=${enc(ref)}`,
  proposal: ref => `/api/proposal/${enc(ref)}`,
  settle: ref => `/api/proposal/${enc(ref)}`, // the whole answer: { proposal, sending, error }
  txlog: ref => `/api/txlog?ref=${enc(ref)}`,
}

// A 404 on these means "nothing yet" (no proposal, no run, empty bank), not a failed read.
const NOTHING_YET = { proposal: null, settle: null, txlog: [], bank: [] }

// ponytail: snapshot and mock hold one escrow per kind; per-ref files once the list shows more than the hero escrow.
async function load(kind, ref, net) {
  const url = source === 'mock' ? `../shared/mock/${MOCK_FILE[kind]}.mock.json`
    : source === 'snapshot' ? `data/${kind}.json`
    : LIVE[kind](ref, net)
  const res = await fetch(url)
  if (res.status === 404 && kind in NOTHING_YET) return NOTHING_YET[kind]
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`)
  const json = await res.json()
  // Mock data is flagged by the agent's header (live) or by the shared mocks' "_note": "MOCK…" (snapshot files).
  if (res.headers.get('x-brume-source') === 'mock' || /^MOCK/.test(json._note ?? '')) { mocked.add(kind); renderSource() }
  return json[kind] ?? json
}

// The agent answers errors as {"error": "<one readable sentence>"}, shown as is; a 202 (submit) has no body.
async function post(path, body) {
  const res = await fetch(`/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  const json = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null
  if (!res.ok) throw new Error(json?.error ?? (text || `/api/${path} answered HTTP ${res.status}`))
  return json
}

// The preprod bank has no shared mock: in mock mode it is the escrow the mock proposal targets.
async function loadBank() {
  if (source !== 'mock') return load('bank')
  const proposal = await load('proposal')
  return [{ ref: proposal.escrowRef, state: 'Disputed' }]
}

// Elements are built with text nodes only: provider data never reaches innerHTML.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  el.append(...kids.flat(Infinity).filter(k => k != null && k !== false))
  return el
}

const short = ref => ref.length > 20 ? `${ref.slice(0, 8)}…${ref.slice(-8)}` : ref
const cap = s => s[0].toUpperCase() + s.slice(1)
const pct = x => `${Math.round(x * 100)}%`
const utc = ms => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const rel = (ms, nowMs) => {
  const days = (ms - nowMs) / 864e5
  return Math.abs(days) >= 1 ? rtf.format(Math.round(days), 'day') : rtf.format(Math.round(days * 24), 'hour')
}

function urlFor(ref, view) {
  const q = new URLSearchParams()
  if (params.has('source')) q.set('source', source)
  if (ref) q.set('escrow', ref)
  if (view) q.set('view', view)
  return `?${q}`
}

// JobResult.uiUrl puts the raw ref in the query, so its "#<index>" lands in location.hash.
function escrowFromUrl() {
  const e = new URLSearchParams(location.search).get('escrow')
  return e && !e.includes('#') && /^#\d+$/.test(location.hash) ? e + location.hash : e
}

const chip = state => h('span', { class: `chip state-${state}` }, h('span', { class: 'glyph', 'aria-hidden': 'true' }), STATE_LABEL[state] ?? 'Datum not decodable')
const txLink = hash => h('a', { class: 'mono', href: EXPLORER + hash, target: '_blank', rel: 'noopener', title: hash }, short(hash))
const txRef = e => e.status === 'accepted' ? txLink(e.txHash) : h('span', { class: 'mono', title: e.txHash }, short(e.txHash)) // a refused tx never reaches the chain
// A run against any other script is our own deployment (S-2), never to be read as the deployed bytes.
const ownTag = e => e?.scriptHash && e.scriptHash !== SCRIPT_HASH ? [' ', h('span', { class: 'tag', title: `script ${e.scriptHash}` }, 'our own deployment')] : null

// A Settle poll rebuilds the button, so the copied state lives here: a rebuilt button shows it without replaying the fade.
let copied = null // { text, timer }

function copyButton(text, label = 'Copy') {
  const btn = h('button', { class: 'btn copy', type: 'button', 'data-copied': copied?.text === text && 'held', onclick: async () => {
    await navigator.clipboard.writeText(text)
    clearTimeout(copied?.timer)
    if (copied?.text !== text) document.querySelectorAll('.copy[data-copied]').forEach(b => delete b.dataset.copied)
    if (!btn.dataset.copied) btn.dataset.copied = 'in'
    copied = { text, timer: setTimeout(() => {
      copied = null
      document.querySelectorAll('.copy[data-copied]').forEach(b => delete b.dataset.copied)
    }, 1500) }
  } }, h('span', { class: 'copy-face' }, h('span', { class: 'idle' }, label), h('span', { class: 'done' }, 'Copied')))
  return btn
}

const mocked = new Set() // kinds the live agent still serves from shared/mock (x-brume-source: mock)

function renderSource() {
  const partly = source !== 'mock' && mocked.size > 0
  const label = { live: 'Live', snapshot: 'Snapshot, read-only', mock: 'Mock data' }[source] ?? source
  $('source').textContent = partly ? `${label}, partly mock` : label
  if (source === 'mock' || partly) {
    $('band').hidden = false
    $('band').textContent = partly
      ? `Mock data for: ${[...mocked].join(', ')}. Hand-made for building, not evidence.`
      : 'Mock data, hand-made for building. Not evidence.'
  }
}

function renderList(census, bank, selected) {
  const row = r => h('a', { class: 'row', href: urlFor(r.ref), title: r.ref, 'aria-current': r.ref === selected ? 'page' : null },
    h('span', { class: 'mono' }, short(r.ref)), chip(r.state))
  $('list').replaceChildren(
    h('h2', { class: 'group' }, 'Mainnet, read-only'),
    h('p', { class: 'meta' }, `${census.byState.Disputed} disputed of ${census.open} open`),
    ...census.rows.filter(r => r.state === 'Disputed').map(row),
    h('h2', { class: 'group' }, 'Preprod bank'),
    h('p', { class: 'meta' }, `${bank.length} ${bank.length === 1 ? 'escrow' : 'escrows'} we locked`),
    ...bank.map(row),
  )
}

function renderFoot(census) {
  const second = census.secondProvider
  const holes = census.holes + (second ? second.holes : 1) // a skipped 2nd provider is a hole, never agreement
  $('foot').replaceChildren(
    h('span', {}, `Source: ${census.provider}`),
    h('span', {}, second ? `2nd provider: ${second.provider}, ${second.diff.length} differences` : '2nd provider: skipped, counted as a hole'),
    h('span', { class: holes ? 'warn' : null }, `Holes: ${holes}`),
    h('span', {}, `Tip block ${census.tip.height.toLocaleString('en')}, ${utc(census.tip.timeMs)}`),
  )
}

const viewsFor = row => row.spent ? [['settle', 'Settle']] // no grid or solver once the output is spent
  : row.network === 'preprod'
  ? [['settle', 'Settle'], ['reach', 'Reachability'], ['solver', 'Solver']]
  : [['reach', 'Reachability'], ['solver', 'Solver']]

function renderHead(row, view) {
  const views = viewsFor(row)
  return h('header', { class: 'head' },
    h('div', { class: 'title' },
      h('h1', { class: 'mono', title: row.ref }, short(row.ref)), copyButton(row.ref),
      chip(row.state),
      h('span', { class: 'chip net' }, row.network === 'mainnet' ? 'Mainnet, read-only' : 'Preprod')),
    views.length > 1 && h('nav', { class: 'seg', 'aria-label': 'View' },
      views.map(([id, label]) => h('a', { href: urlFor(row.ref, id), 'aria-current': id === view ? 'page' : null }, label))),
  )
}

/* Reachability */

const clock = (label, ms, nowMs) => h('div', {}, h('dt', {}, label), h('dd', { title: utc(ms) }, ms ? rel(ms, nowMs) : 'not set'))

function placePop(anchor) {
  const pop = $('pop')
  const r = anchor.getBoundingClientRect()
  const below = r.bottom + 8 + pop.offsetHeight <= innerHeight - 8
  pop.style.top = `${Math.max(8, below ? r.bottom + 8 : r.top - 8 - pop.offsetHeight)}px`
  pop.style.transformOrigin = below ? 'top left' : 'bottom left' // grows out of the cell it describes
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`
}

// The control filmed at 1:40: submit what the engine marks not permitted, and show the node refusing it. Preprod only.
function tryAnyway(row, v, anchor) {
  const out = h('div', { class: 'try-out', 'aria-live': 'polite' })
  const btn = h('button', { class: 'btn primary', type: 'button', disabled: !live, onclick: async () => {
    btn.disabled = true
    btn.textContent = 'Submitting to preprod…'
    try {
      const e = await post('try', { escrowRef: row.ref, redeemer: v.redeemer, role: v.role })
      btn.remove()
      // expected = the engine's prediction recorded before submitting; stage = where the outcome was decided.
      const predicted = e.expected === 'accept' ? 'accepted' : 'refused'
      const result = e.status === 'accepted' ? ['the node accepted it: ', txLink(e.txHash)] : [`${refusal(e)}.`, rawError(e)]
      const matched = (e.status === 'accepted') === (e.expected === 'accept')
      out.replaceChildren(matched
        ? h('p', { class: 'matched observed' }, `Engine predicted ${predicted}, and `, result, ownTag(e))
        : h('p', { class: 'error observed' }, `Engine predicted ${predicted}, but `, result, ownTag(e)))
    } catch (x) {
      out.replaceChildren(h('p', { class: 'error' }, x.message))
      btn.disabled = false
      btn.textContent = 'Try anyway'
    }
    placePop(anchor)
  } }, 'Try anyway')
  return h('div', { class: 'try' }, btn, !live && h('span', { class: 'hint' }, 'Runs in live mode'), out)
}

function openPop(anchor, v, row) {
  const list = (items, none) => items.length ? h('ul', {}, items.map(t => h('li', {}, t))) : h('p', {}, none)
  const pop = $('pop')
  pop.replaceChildren(
    h('h3', {}, `${cap(v.role)}, ${v.redeemer}`),
    h('p', {}, `The validator's source says the ${v.role} ${v.allowed ? 'can' : 'can\'t'} do this now.`),
    h('h4', {}, 'Deciding guards'), list(v.failed, 'None, every guard passes.'),
    h('h4', {}, 'Output rules'), list(v.outputRules, 'None.'),
    ...(!v.allowed && row?.network === 'preprod' ? [tryAnyway(row, v, anchor)] : []),
  )
  pop.showPopover()
  placePop(anchor)
}

function cell(v, i, row) {
  if (!v) return h('td', {}, h('span', { class: 'cell skel' }))
  return h('td', {}, h('button', {
    class: v.allowed ? 'cell can' : 'cell', type: 'button', style: `--i:${i}`, 'aria-haspopup': 'dialog',
    onclick: e => openPop(e.currentTarget, v, row),
  }, h('span', { class: 'glyph', 'aria-hidden': 'true' }), h('span', { class: 'cell-text' }, v.allowed ? 'can' : (v.failed[0] ?? 'not permitted by the source'))))
}

function renderGrid(grid, row) {
  const byKey = new Map((grid?.verdicts ?? []).map(v => [`${v.redeemer}/${v.role}`, v]))
  return h('table', { class: 'grid' },
    h('caption', {}, 'What the validator\'s source says each party can do now', grid && h('small', {}, `Verdicts at ${utc(grid.atMs)}`)),
    h('thead', {}, h('tr', {}, h('td'), ROLES.map(r => h('th', { scope: 'col' }, cap(r))))),
    h('tbody', {}, REDEEMERS.map((name, i) => h('tr', {},
      h('th', { scope: 'row' }, h('span', { class: 'idx mono' }, i), name.split(/(?=[A-Z])/).flatMap((part, k) => k ? [h('wbr'), part] : [part])), // narrow screens break at the camel-case humps
      ROLES.map((role, j) => cell(byKey.get(`${name}/${role}`), i * 3 + j, row))))),
  )
}

async function reachView(row) {
  const [grid, datum] = await Promise.all([load('grid', row.ref), load('datum', row.ref, row.network)])
  if (grid.ref !== row.ref) return blank('No verdicts for this escrow', 'The engine has not produced a grid for this reference in this data set.', false)
  const fields = Object.entries(datum).map(([k, v]) => [h('dt', {}, k), h('dd', { class: 'mono' }, typeof v === 'object' ? v.payment.hash : String(v))])
  return [
    h('dl', { class: 'clocks' },
      clock('Arbitration opened', datum.externalDisputeUnlockTime, grid.atMs),
      clock('Unlock', datum.unlockTime, grid.atMs),
      clock('Result deadline', datum.submitResultTime, grid.atMs),
      h('div', {}, h('dt', {}, 'Result hash'), h('dd', {}, datum.resultHash ? 'set' : 'empty'))),
    h('details', { class: 'datum' }, h('summary', {}, 'Datum, 16 fields'), h('dl', {}, fields)),
    renderGrid(grid, row),
  ]
}

/* Settle: SPEC-TRANSACTIONS §4 order, Carbon progress indicator glyphs, GOV.UK task-list statuses */

// The agent writes the proposal to out/proposals/<hash>_<index>.json ('#' → '_'); the seller's run also sends both legs.
const signCommand = (role, ref) => `pnpm sign --role ${role} out/proposals/${ref.replace('#', '_')}.json`

// Live m:ss since the current wait began. Each re-render makes a new span; the old one stops itself once detached.
function elapsed(wait) {
  const el = h('span', { class: 'tnum' })
  const tick = () => {
    if (!el.isConnected) return clearInterval(id)
    const s = Math.max(0, Math.floor((Date.now() - wait.since) / 1000))
    el.textContent = `, ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
  const id = setInterval(tick, 1000)
  requestAnimationFrame(tick)
  return el
}

// CIP-30 wallets the page can see (S-3). The file drop stays the guaranteed path; this only adds a shortcut next to it.
const wallets = () => Object.values(window.cardano ?? {}).filter(w => w?.apiVersion && typeof w.enable === 'function')

// Who signs which leg (stream A, 6 Oct). Path B: the buyer pre-signs the exit (leg 2); the seller signs the concession (leg 1)
// and adds its witness to leg 2, whose fee and collateral inputs it owns. Path A mirrors it.
const PATH_ROLES = { B: { exiter: 'buyer', conceder: 'seller' }, A: { exiter: 'seller', conceder: 'buyer' } }
const pathRoles = proposal => PATH_ROLES[proposal?.path] ?? PATH_ROLES.B
const legsToSign = (proposal, role) => role === pathRoles(proposal).exiter ? [2] : [1, 2]

// Leg 1's body is frozen at prepare() with an upper bound about 20 minutes out; past it, both sides sign new hashes.
function countdown(toMs, onExpire) {
  const el = h('span', { class: 'tnum' })
  const show = s => { el.textContent = `Leg 1 valid for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.` }
  const tick = () => {
    if (!el.isConnected) return clearInterval(id)
    const s = Math.floor((toMs - Date.now()) / 1000)
    if (s <= 0) { clearInterval(id); return onExpire() }
    show(s)
  }
  const id = setInterval(tick, 1000)
  show(Math.max(0, Math.floor((toMs - Date.now()) / 1000))) // built with its text, so a poll's re-render never pushes the steps below
  requestAnimationFrame(tick)
  return el
}

function prepareAgain(row, proposal, rerun) {
  const err = h('p', { class: 'error', hidden: true })
  const btn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    btn.disabled = true
    try { await post('proposal', { escrowRef: row.ref, sellerShare: proposal.sellerShare }); rerun() }
    catch (x) { err.hidden = false; err.textContent = x.message; btn.disabled = false }
  } }, 'Prepare again')
  return [h('p', {}, 'Leg 1 expired before it was sent. Prepare it again: both sides sign the new hashes.'), h('div', {}, btn, err)]
}

function walletSign(wallet, role, ctx) {
  const legs = legsToSign(ctx.proposal, role).map(n => [n, ctx.proposal?.[`leg${n}`]])
  const { wait } = ctx
  const msg = h('p', { class: 'error', hidden: !wait.errors[role] }, wait.errors[role]) // survives the 2 s re-render
  const fail = text => {
    wait.busy = false
    wait.errors[role] = text
    msg.hidden = false
    msg.textContent = text
    btn.disabled = false
    btn.textContent = label
  }
  const label = `Sign with ${wallet.name}`
  const btn = h('button', { class: 'btn', type: 'button', disabled: legs.some(([, leg]) => !leg), onclick: async () => {
    btn.disabled = true
    msg.hidden = true
    wait.errors[role] = null
    wait.busy = true // polling holds while the wallet is open, so this button is not re-rendered under the user
    wait.busySince = Date.now()
    try {
      btn.textContent = 'Connecting to the wallet…'
      const api = await wallet.enable()
      if (await api.getNetworkId() !== 0) return fail(`${wallet.name} is on mainnet. Switch it to preprod and try again. Nothing was signed.`)
      for (const [n, leg] of legs) {
        btn.textContent = legs.length > 1 ? `Confirm leg ${n} in your wallet…` : 'Confirm in your wallet…'
        const witnessSet = await api.signTx(leg.cborHex, true)
        btn.textContent = 'Sending the signature…'
        await post(`proposal/${enc(ctx.row.ref)}/witness`, { role, leg: n, witnessSet })
      }
      wait.busy = false
      ctx.rerun()
    } catch (x) {
      fail(x?.code === 2 ? 'Signature declined in the wallet. Nothing was sent.'
        : x?.code === 1 ? `${wallet.name} doesn't hold the ${role}'s key for this transaction.`
        : x?.code === -3 ? `${wallet.name} refused access to this page.`
        : x?.message ?? x?.info ?? String(x))
    }
  } }, label)
  return [btn, msg]
}

function waitingFor(role, ctx) {
  const cmd = signCommand(role, ctx.row.ref)
  return h('div', { class: 'cmd' },
    h('code', { class: 'mono' }, cmd), copyButton(cmd),
    h('span', { class: 'hint' }, 'Waiting for the signed file', live && elapsed(ctx.wait)),
    live && wallets().map(w => walletSign(w, role, ctx)))
}

// Prefilled with the top of the solver's band at the 30-day horizon: the most the seller can ask that the buyer still accepts.
function proposeForm(row, rerun, band) {
  const input = h('input', { type: 'number', min: '0', max: '1', step: '0.05', value: band ? band.sellerShareMax.toFixed(2) : null, required: true, class: 'mono share', 'aria-label': 'Seller share of the value' })
  const err = h('p', { class: 'error', hidden: true })
  const form = h('form', { class: 'propose', onsubmit: async e => {
    e.preventDefault()
    try { await post('proposal', { escrowRef: row.ref, sellerShare: Number(input.value) }); rerun() }
    catch (x) { err.hidden = false; err.textContent = x.message }
  } },
  h('label', {}, 'Seller share', input),
  h('button', { class: 'btn primary', type: 'submit', disabled: !live }, 'Propose this split'),
  !live && h('span', { class: 'hint' }, 'Runs in live mode'),
  h('p', { class: 'hint band-hint' }, band
    ? `Both sides can accept ${pct(band.sellerShareMin)} to ${pct(band.sellerShareMax)} of the value (30-day horizon).`
    : 'No solver band for this escrow yet.'),
  err)
  return form
}

function sendButton(row, rerun) {
  const err = h('p', { class: 'error', hidden: true })
  const btn = h('button', { class: 'btn primary', type: 'button', disabled: !live, onclick: async () => {
    btn.disabled = true
    btn.textContent = 'Sending…'
    // The agent answers 202 at once and submits in the background (1–2 min); progress arrives through GET /api/txlog.
    // 202 {status: 'sending'}: the send runs in the background; 200 {status: 'done', txlog}: it already ended.
    try { const answer = await post(`proposal/${enc(row.ref)}/submit`, { escrowRef: row.ref }); rerun({ submitted: true, txlog: answer?.txlog }) }
    catch (x) { err.hidden = false; err.textContent = x.message; btn.disabled = false; btn.textContent = 'Send both legs' }
  } }, 'Send both legs')
  return h('div', {}, btn, !live && h('span', { class: 'hint' }, 'Runs in live mode'), err)
}

// An accepted entry without a block is pending: submitted, not yet confirmed (stream A, 6 Oct).
const outcome = e => e.block ? `confirmed in block ${e.block.height.toLocaleString('en')}` : 'pending, not yet in a block'
const pending = e => e?.status === 'accepted' && !e.block

// Claims rule: only a phase-2 failure (the script failed) may be called the validator refusing. Phase 1 is a ledger rule.
// A sentence, never the node's raw text: that sits behind rawError().
function refusal(e) {
  if (e.stage === 'evaluate') return 'refused when evaluated, before submission'
  if (e.refusal?.phase === 2) return 'the validator refused it'
  if (e.refusal?.phase === 1 && /All inputs are spent|BadInputsUTxO/.test(`${e.error ?? ''} ${e.refusal.ledgerError ?? ''}`)) return 'the ledger refused it: its input was already spent'
  return 'the ledger refused it'
}
const rawError = e => (e.error || e.refusal) && h('details', { class: 'raw' }, h('summary', {}, 'raw error'),
  h('pre', { class: 'mono' }, JSON.stringify({ error: e.error, refusal: e.refusal, stage: e.stage }, null, 2)))
// A refusal the run predicted (a control such as the leg-2 replay) is the expected result, not a failure.
const expectedRefusal = e => e?.status === 'refused' && e.expected === 'refuse'

function settleSteps(row, proposal, log, rerun, band, wait) {
  const ctx = { row, proposal, rerun, wait }
  const { exiter, conceder } = pathRoles(proposal)
  // signedBy is UI state only (stream A): a leg accepted in the txlog proves both signatures, whatever signedBy says.
  const legSent = proposal && ['leg1', 'leg2'].some(k => proposal[k] && log.some(e => e.txHash === proposal[k].txHash && e.status === 'accepted'))
  const signed = role => legSent || (proposal?.signedBy.includes(role) ?? false)
  const bothSigned = signed('buyer') && signed('seller') // nothing can be sent before both signatures exist
  const entry = leg => bothSigned && proposal[leg] && log.find(e => e.txHash === proposal[leg].txHash && !expectedRefusal(e)) // the replay shares leg 2's hash
  const leg1 = entry('leg1')
  const leg2 = entry('leg2')
  const refused = [leg1, leg2].find(e => e?.status === 'refused')
  const submitted = !leg1 && !leg2 && (wait.submittedAt || wait.sending) // a send is running, no leg in the txlog yet: no second Send button
  const validTo = live && !leg1 && !submitted && proposal?.leg1?.validToMs // countdown only matters until leg 1 is sent
  const validity = validTo ? h('p', { class: 'hint' }, countdown(validTo, () => rerun())) : null
  const steps = [
    { label: 'Buyer raises the dispute', done: ['Disputed', 'RefundRequested'].includes(row.state) || !!proposal,
      waiting: 'Waiting for buyer', body: [] },
    { label: `${cap(conceder)} proposes the split`, done: !!proposal, waiting: `Waiting for ${conceder}`,
      body: proposal
        ? [h('p', {}, `Seller receives ${pct(proposal.sellerShare)} of the value, buyer ${pct(1 - proposal.sellerShare)}.`),
          proposal.leg1 && h('p', { class: 'hash' }, 'Leg 1 fixed, hash ', h('span', { class: 'mono', title: proposal.leg1.txHash, 'data-cue': 'hash leg1' }, short(proposal.leg1.txHash)))]
        : [proposeForm(row, rerun, band)] },
    { label: `${cap(exiter)} pre-signs the exit (leg 2)`, done: signed(exiter), waiting: `Waiting for ${exiter}`,
      body: signed(exiter)
        ? [proposal.leg2 && h('p', { class: 'hash' }, 'Exit signed, hash ', h('span', { class: 'mono', title: proposal.leg2.txHash, 'data-cue': 'hash leg2' }, short(proposal.leg2.txHash))),
          h('p', { class: 'lock' }, 'Split locked: changing leg 1 now would void this signature.')]
        : [waitingFor(exiter, ctx), validity] },
    { label: `${cap(conceder)} signs the concession (leg 1)`, done: signed(conceder), waiting: `Waiting for ${conceder}`,
      body: signed(conceder) ? [] : [waitingFor(conceder, ctx), validity] },
    { label: `${cap(conceder)} sends both legs`, done: !!(leg1?.block && leg2?.block), error: refused,
      waiting: leg1 || leg2 ? 'Waiting for confirmation' : submitted ? 'Submitted' : 'Ready to send',
      body: refused
        ? [h('p', {}, `${cap(refusal(refused))}. Start over on the next bank escrow.`), rawError(refused)]
        : leg1 || leg2
          ? [[leg1, leg2].filter(Boolean).map(e => h('p', { class: 'hash' }, `${e.step}: `, h('span', { 'data-cue': e.block && `block ${e.step}` }, outcome(e)), ', ',
              h('span', { 'data-cue': `hash ${e.step}` }, txLink(e.txHash)), ownTag(e)))]
          : submitted
            ? [h('p', {}, 'Submitted to the agent. Waiting for the first leg to appear on preprod.')]
            : [sendButton(row, rerun), validity] },
    { label: 'Balances read back from the second indexer', done: !!leg2?.readback,
      waiting: leg2?.block ? 'Read-back in progress' : 'Waiting for read-back', // the indexer may lag a confirmed leg 2: never a failure
      body: [
        leg2?.readback && h('p', {}, `Read back on ${leg2.readback.provider}: ${leg2.readback.validContract ? 'valid contract' : 'contract not valid'}.`),
        leg2?.block && proposal.payout && renderBalances(proposal.payout, leg2.readback?.balances ?? null), // what leg 2 wrote, until a read-back exists
      ] },
  ]
  // Leg 1 expired before it was sent: the first step still waiting turns into the re-prepare step.
  if (validTo && Date.now() >= validTo) {
    const stuck = steps.findIndex((s, i) => i >= 2 && !s.done)
    if (stuck >= 0) Object.assign(steps[stuck], { error: true, errorLabel: 'Expired', body: prepareAgain(row, proposal, rerun) })
  }
  // A send that failed after its 202: the agent's sentence, shown as is.
  if (wait.sendError && !steps[4].done) Object.assign(steps[4], { error: true, errorLabel: 'Send failed', body: [h('p', {}, wait.sendError)] })
  return steps
}

// One escrow's native quantities (DESIGN §10.1), in display units. A token missing here stays in base units.
const DECIMALS = { lovelace: 6, [USDM]: 6, [TUSDM]: 6 } // = DECIMALS in shared/constants.ts (the browser cannot import it)

function qty(unit, q) {
  const d = DECIMALS[unit]
  if (d === undefined) return q.toLocaleString('en')
  const scale = 10n ** BigInt(d)
  const abs = q < 0n ? -q : q
  return `${q < 0n ? '-' : ''}${(abs / scale).toLocaleString('en')}.${String(abs % scale).padStart(d, '0')}`
}
const unitLabel = unit => DECIMALS[unit] === undefined ? `${assetName(unit)} (base units)` : assetName(unit)

// Carbon data-table pattern. What leg 2 wrote for each party (Proposal.payout) against what the second indexer reads back
// (readback.balances, what each party received from leg 2): the split landed as signed, or it did not. readBack null = not read yet.
function renderBalances(written, readBack) {
  const rows = ['buyer', 'seller'].flatMap(party =>
    [...new Set([...Object.keys(written[party] ?? {}), ...Object.keys(readBack?.[party] ?? {})])].map(unit => {
      const w = BigInt(written[party]?.[unit] ?? 0)
      const r = readBack && BigInt(readBack[party]?.[unit] ?? 0)
      const cue = col => `amount ${party} ${unit} ${col}`
      return h('tr', {},
        h('td', {}, cap(party)),
        h('td', {}, unitLabel(unit)),
        h('td', { class: 'num mono', 'data-cue': cue('written') }, qty(unit, w)),
        readBack ? h('td', { class: 'num mono', 'data-cue': cue('read') }, qty(unit, r)) : h('td', { class: 'num hint' }, 'not read back yet'),
        readBack ? h('td', { class: w === r ? 'match ok' : 'match off' }, w === r ? 'Matches' : 'Differs') : h('td'))
    }))
  return h('div', { class: 'balances-wrap', 'data-cue': 'balances' }, h('table', { class: 'balances' },
    h('thead', {}, h('tr', {}, ['Party', 'Asset', 'Written in leg 2', 'Read back', ''].map((c, i) => h('th', { scope: 'col', class: i === 2 || i === 3 ? 'num' : null }, c)))),
    h('tbody', {}, rows)))
}

function renderSteps(steps) {
  let reached = false
  return h('ol', { class: 'steps' }, steps.map(s => {
    const state = s.error ? 'error' : s.done ? 'done' : reached ? 'later' : 'current'
    if (!s.done) reached = true
    const status = { done: 'Done', current: s.waiting, later: 'Cannot start yet', error: s.errorLabel ?? 'Refused' }[state]
    return h('li', { class: `step ${state}` },
      h('span', { class: 'mark', 'aria-hidden': 'true' }),
      h('div', { class: 'step-body' },
        h('div', { class: 'step-head' }, h('span', { class: 'step-label' }, s.label), h('span', { class: 'status' }, status)),
        state !== 'later' && s.body),
    )
  }))
}

// One-shot cues for a Settle step whose state changes while the same escrow stays on screen. Opening, switching, Reset
// and the first render of a panel only seed the map; an unchanged state at a poll plays nothing.
const brumeMotion = new Map() // "<escrowRef>:<step index>" → { state, status }, "<escrowRef>:<step index>:<data-cue>" → its text, at the last render

function stepCue(i, from, to) {
  if (to.status === 'Refused') return from.status === 'Refused' ? null : 'refused'
  if (to.status === 'Expired') return from.status === 'Expired' ? null : 'expired' // leg 1 ran out while on screen; the countdown is simply gone
  if (from.state === 'later' && to.state === 'current') return 'await-in'
  if (from.state === 'current' && to.state === 'done') return i === 4 ? 'confirmed' : 'tick' // step 4 done = both legs in a block
  if (from.status === 'Ready to send' && (to.status === 'Submitted' || to.status === 'Waiting for confirmation')) return 'tick'
  return null
}

function cueStep(li, key, i, seed) {
  const now = { state: li.classList[1], status: li.querySelector('.status').textContent }
  const was = brumeMotion.get(key)
  brumeMotion.set(key, now)
  const cue = !seed && was && stepCue(i, was, now)
  if (cue) play(li, cue)
}

// A value tagged data-cue (tx hash, block height, read-back balances) resolves once when it first appears (absent = "").
// An amount that changes swaps its text and fades in place; no other change plays anything.
function cueValue(el, key, seed) {
  const was = brumeMotion.get(key) ?? ''
  const now = el.textContent
  brumeMotion.set(key, now)
  if (seed || now === was) return
  if (!was && !el.dataset.cue.startsWith('amount ')) play(el, 'in')
  else if (was && el.dataset.cue.startsWith('amount ')) play(el, 'swap')
}

function play(el, cue) {
  el.dataset.motion = cue // el is built fresh on every render, so a cue never restarts on a rebuilt node
  const stop = () => { clearTimeout(timer); el.removeEventListener('animationend', end); delete el.dataset.motion }
  const end = () => { if (el.getAnimations({ subtree: true }).every(a => a.playState === 'finished')) stop() }
  const timer = setTimeout(stop, 320)
  el.addEventListener('animationend', end)
}

function renderLog(log) {
  if (!log.length) return null
  return h('section', { class: 'log' },
    h('h2', {}, 'Transactions'),
    h('ol', { class: 'timeline' }, log.map(e => h('li', { class: pending(e) ? 'pending' : expectedRefusal(e) ? 'accepted expected' : e.status },
      h('span', { class: 'mark', 'aria-hidden': 'true' }),
      h('span', {}, e.step, ownTag(e)),
      h('span', { class: 'status' },
        e.status === 'accepted' ? cap(outcome(e)) : expectedRefusal(e) ? `Prediction matched. ${cap(refusal(e))}.` : `${cap(refusal(e))}.`),
      txRef(e),
      e.status === 'refused' && rawError(e))))) // under the row, full width
}

async function settleView(row) {
  const panel = h('div', { class: 'settle' })
  const solver = row.spent ? null : await load('solver', row.ref) // a spent escrow has no solver; its share is in the proposal
  const band = solver?.ref === row.ref ? solver.bands.find(b => b.horizonDays === 30 && b.feasible !== false) : null
  let shown = null // label of the step last scrolled into view
  const wait = { label: null, since: Date.now(), busy: false, errors: {} } // elapsed counter, wallet in progress, wallet errors per role
  let timer = 0 // one polling chain per panel, whoever triggers the re-render
  let seeded = false // the first render of this panel seeds brumeMotion without playing a cue
  const seq = renderSeq // a newer render() clears brumeMotion before this panel leaves the screen
  const poll = () => {
    if (!panel.isConnected) return // the view was left
    // A wallet left open holds polling for 60 s at most, so a file-drop signature is still picked up.
    if (wait.busy && Date.now() - wait.busySince < 60_000) timer = setTimeout(poll, POLL_MS)
    else rerun().catch(() => { if (panel.isConnected) timer = setTimeout(poll, POLL_MS) }) // a failed read retries next cycle
  }
  const rerun = async ({ submitted, txlog } = {}) => {
    if (submitted) wait.submittedAt = Date.now()
    if (txlog) wait.doneLog = txlog
    const [answer, fetched] = await Promise.all([load('settle', row.ref), load('txlog', row.ref)])
    const proposal = answer?.proposal ?? null
    // A 'done' submit answer counts until the txlog file carries the same entries; earlier runs in the file stay listed.
    const log = [...fetched, ...(wait.doneLog ?? []).filter(d => !fetched.some(e => e.txHash === d.txHash && e.step === d.step))]
    Object.assign(wait, { sending: !!answer?.sending, sendError: answer?.error ?? null }) // survives a reload, unlike submittedAt
    const mine = proposal?.escrowRef === row.ref ? proposal : null
    const steps = settleSteps(row, mine, log, rerun, band, wait)
    const waiting = steps.find(s => !s.done)?.label ?? null
    if (waiting !== wait.label) Object.assign(wait, { label: waiting, since: Date.now() })
    panel.replaceChildren(...[renderSteps(steps), renderLog(log)].filter(Boolean))
    if (!seeded || (panel.isConnected && seq === renderSeq)) panel.querySelectorAll('.step').forEach((li, i) => { // a left panel never writes, even while still on screen
      cueStep(li, `${row.ref}:${i}`, i, !seeded)
      li.querySelectorAll('[data-cue]').forEach(el => cueValue(el, `${row.ref}:${i}:${el.dataset.cue}`, !seeded))
    })
    seeded = true
    const now = panel.querySelector('.step.current, .step.error')
    const label = now?.querySelector('.step-label').textContent ?? null
    if (now && label !== shown) requestAnimationFrame(() => now.scrollIntoView({ block: 'nearest' })) // only when the step changes, so polling never yanks the scroll
    shown = label
    // Poll until the flow ends: signatures dropped by file, a send made outside the page (the seller's pnpm sign sends both legs),
    // the background submit, the blocks, the read-back. A refusal or an expired leg 1 stops it.
    const ended = steps.every(s => s.done) || steps.some(s => s.error)
    clearTimeout(timer)
    if (live && mine && !ended && (!row.spent || steps[4].done)) timer = setTimeout(poll, POLL_MS) // a spent escrow's run is history, but for its read-back
  }
  await rerun()
  return panel
}

/* Solver: scale-free. Every figure is a share of one asset of this escrow, never a sum across assets. */

const assetName = unit => ({ lovelace: 'ADA', [USDM]: 'USDM', [TUSDM]: 'tUSDM' })[unit] ?? short(unit)

// Share of each asset when the escrow's value is known (mainnet census rows); base-unit quantities otherwise.
function perAsset(terms, value) {
  const units = [...new Set([...Object.keys(value ?? {}), ...Object.keys(terms)])]
  if (units.every(u => Number(terms[u] ?? 0) === 0)) return 'Nothing'
  return units.map(u => {
    const q = Number(terms[u] ?? 0)
    if (value?.[u]) return q === 0 ? `nothing of the ${assetName(u)}` : `${pct(q / Number(value[u]))} of the ${assetName(u)}`
    return `${qty(u, BigInt(terms[u] ?? 0))} ${unitLabel(u)}`
  }).join(', ')
}

function renderBands(solver) {
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const who = solver.path === 'A' ? 'buyer' : 'seller' // the bands are priced for one settle path
  return h('section', { class: 'bands' },
    h('h2', {}, `Splits both sides can accept, ${who} concedes first`),
    h('p', { class: 'hint' }, 'Seller\'s share of the escrow value, by how long the buyer is willing to wait for an arbiter.'),
    h('div', { class: 'band-grid' },
      solver.bands.map(b => [
        h('span', { class: 'band-label' }, `Buyer waits ${b.horizonDays} days`),
        b.feasible === false
          ? h('span', { class: 'band-none' }, 'No split both sides accept at this horizon.')
          : [h('div', { class: 'track', title: `${pct(b.sellerShareMin)} to ${pct(b.sellerShareMax)} of the value` },
              h('span', { class: 'range', style: `left:${b.sellerShareMin * 100}%;width:${(b.sellerShareMax - b.sellerShareMin) * 100}%` })),
            h('span', { class: 'band-value mono' }, `${pct(b.sellerShareMin)} to ${pct(b.sellerShareMax)}`)],
      ]),
      h('span'),
      h('div', { class: 'axis', 'aria-hidden': 'true' }, ticks.map(t => h('span', { style: `left:${t * 100}%` }, pct(t)))),
    ))
}

function renderPaths(solver, value) {
  const paths = [['Seller concedes first', solver.pathB], ['Buyer concedes first', solver.pathA, 'not offered: comparison only']] // Settle builds path B only
  const row = (label, cell) => h('tr', {}, h('th', { scope: 'row' }, label), paths.map(([, p]) => h('td', {}, cell(p))))
  return h('section', { class: 'paths' },
    h('h2', {}, 'What each exit path costs'),
    h('table', {},
      h('thead', {}, h('tr', {}, h('td'), paths.map(([name, , note]) => h('th', { scope: 'col' }, name, note && h('span', { class: 'hint col-note' }, note))))),
      h('tbody', {},
        row('Protocol fee', p => Object.keys(p.fee).length ? perAsset(p.fee, value) : 'None'),
        row('Exposed on the second leg', p => cap(p.exposedParty)),
        row('Least the exposed party keeps', p => perAsset(p.exposedFloor, value)),
        row('What a defector can take', p => perAsset(p.defectorKeeps, value)),
        row('Paid in on top to cover the fee', p => Object.keys(p.topUp ?? {}).length ? perAsset(p.topUp, value) : 'None')),
    ),
    solver.frontRunP && h('p', { class: 'hint front-run' }, solver.frontRunP.measured
      ? `Front-run risk on the second leg is priced at p = ${solver.frontRunP.used}, measured on preprod.`
      : `Front-run risk on the second leg is priced at p = ${solver.frontRunP.used}, the worst case, until it is measured.`))
}

async function solverView(row) {
  const solver = await load('solver', row.ref)
  if (solver.ref !== row.ref) return blank('No solver output for this escrow', 'The solver has not priced this reference in this data set.', false)
  return [renderBands(solver), renderPaths(solver, row.value)] // census and bank rows both carry the escrow's value
}

/* Shell */

function blank(title, text, back = true) {
  return h('div', { class: 'blank' }, h('h2', {}, title), h('p', {}, text), back && h('a', { class: 'btn', href: urlFor() }, 'Back to the list'))
}

let base = null // [census, bank], loaded once per page
let renderSeq = 0
let skeletonPainted = false

// Reads escrow and view from the URL. animate: the grid's one orchestrated reveal, never on keyboard or history moves.
async function render({ animate = true, focusList = false } = {}) {
  const seq = ++renderSeq
  brumeMotion.clear() // every open, switch, history move and Reset starts a new display
  if ($('pop').matches(':popover-open')) $('pop').hidePopover()
  try {
    base ??= await Promise.all([load('census'), loadBank()])
    const [census, bank] = base
    const rows = [...census.rows.map(r => ({ ...r, network: 'mainnet' })), ...bank.map(r => ({ ...r, network: 'preprod' }))]
    const ref = escrowFromUrl() ?? census.rows.find(r => r.state === 'Disputed')?.ref
    renderList(census, bank, ref)
    if (focusList) document.querySelector('.row[aria-current]')?.focus()
    renderFoot(census)
    // A settled bank escrow is spent and leaves /api/bank; its recorded run still opens, so a reload after a take shows it.
    const row = rows.find(r => r.ref === ref)
      ?? (live && ref && (await load('settle', ref))?.proposal ? { ref, network: 'preprod', state: 'Settled', spent: true } : null)
    if (!row) {
      $('detail').replaceChildren(blank('No escrow at this reference', 'It may have been spent, or it is not in this data set.'))
      return
    }
    document.title = `Brume, ${short(row.ref)}`
    const ids = viewsFor(row).map(([id]) => id)
    const asked = new URLSearchParams(location.search).get('view')
    const view = ids.includes(asked) ? asked : ids[0]
    const body = await { settle: settleView, reach: reachView, solver: solverView }[view](row)
    if (seq !== renderSeq) return // a newer navigation already rendered
    $('detail').classList.toggle('animate', animate)
    $('detail').classList.toggle('fade-in', animate && skeletonPainted && skeleton.isConnected) // once, over a skeleton that reached the screen
    $('detail').replaceChildren(renderHead(row, view), ...[body].flat())
  } catch (err) {
    if (seq !== renderSeq) return
    const hint = {
      live: 'Start the agent with pnpm agent, or open this page with ?source=snapshot.',
      snapshot: 'Regenerate the data with pnpm site:data.',
      mock: 'Serve the repository root so ../shared/mock is reachable.',
    }[source]
    $('detail').replaceChildren(blank('Couldn\'t load the escrow data', `${err.message}. ${hint}`))
  }
}

function go(href, opts) {
  history.pushState(null, '', href)
  const phone = matchMedia('(max-width: 900px)').matches // the list sits under the detail
  render(opts).then(() => phone && $('detail').scrollIntoView({ block: 'start' }))
}

// In-page links (?escrow=…&view=…) navigate without a reload. e.detail is 0 when Enter activated the link.
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="?"]')
  if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  const keyboard = e.detail === 0
  go(a.getAttribute('href'), { animate: !keyboard, focusList: keyboard && a.classList.contains('row') })
})
addEventListener('popstate', () => render({ animate: false }))

// j / k move focus through the escrow list, Enter opens (native link). Arrows move between view segments.
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, select')) return
  if (e.key === 'j' || e.key === 'k') {
    const rows = [...document.querySelectorAll('.row')]
    const from = rows.indexOf(document.activeElement)
    const at = from >= 0 ? from : rows.findIndex(r => r.hasAttribute('aria-current'))
    rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'j' ? 1 : -1)))]?.focus()
    e.preventDefault()
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target.closest('.seg')) {
    const links = [...e.target.closest('.seg').querySelectorAll('a')]
    links[(links.indexOf(e.target) + (e.key === 'ArrowRight' ? 1 : links.length - 1)) % links.length].focus()
    e.preventDefault()
  }
})

renderSource()
document.querySelector('.brand').setAttribute('href', urlFor())
$('reset').addEventListener('click', () => go(urlFor(), { animate: false }))
const skeleton = renderGrid(null)
$('detail').replaceChildren(skeleton)
requestAnimationFrame(() => { skeletonPainted = true }) // runs right before the frame that paints the skeleton
render()
