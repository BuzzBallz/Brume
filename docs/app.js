// Brume UI. One flag picks the data source: ?source=live (agent API), snapshot (docs/data, GitHub Pages) or mock (shared/mock).

const REDEEMERS = ['Withdraw', 'SetRefundRequested', 'UnSetRefundRequested', 'WithdrawRefund', 'WithdrawDisputed', 'SubmitResult', 'AuthorizeRefund'] // = REDEEMER in shared/types.ts
const ROLES = ['buyer', 'seller', 'admin']
const STATE_LABEL = { FundsLocked: 'Funds locked', ResultSubmitted: 'Result submitted', RefundRequested: 'Refund requested', Disputed: 'Disputed' }
const MOCK_FILE = { census: 'census', grid: 'grid', datum: 'datum-disputed', solver: 'solver', proposal: 'proposal', txlog: 'txlog' }
const USDM = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d' // = USDM in shared/constants.ts
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
  txlog: ref => `/api/txlog?ref=${enc(ref)}`,
}

// A 404 on these means "nothing yet" (no proposal, no run, empty bank), not a failed read.
const NOTHING_YET = { proposal: null, txlog: [], bank: [] }

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

async function post(path, body) {
  const res = await fetch(`/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`/api/${path} answered HTTP ${res.status}: ${await res.text()}`)
  return res.json()
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

function copyButton(text, label = 'Copy') {
  const btn = h('button', { class: 'btn copy', type: 'button', onclick: async () => {
    await navigator.clipboard.writeText(text)
    btn.textContent = 'Copied'
    setTimeout(() => { btn.textContent = label }, 1200)
  } }, label)
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

const viewsFor = row => row.network === 'preprod'
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
      out.replaceChildren(e.status === 'refused'
        ? h('p', { class: 'matched' }, `Engine predicted refused. Node refused: ${e.error ?? 'no reason given'}.`)
        : h('p', { class: 'error' }, 'Engine predicted refused, but the node accepted it: ', txLink(e.txHash)))
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
  }, h('span', { class: 'glyph', 'aria-hidden': 'true' }), h('span', { class: 'cell-text' }, v.allowed ? 'can' : (v.failed[0] ?? 'not permitted'))))
}

function renderGrid(grid, row) {
  const byKey = new Map((grid?.verdicts ?? []).map(v => [`${v.redeemer}/${v.role}`, v]))
  return h('table', { class: 'grid' },
    h('caption', {}, 'What each party can do now', grid && h('small', {}, `Verdicts at ${utc(grid.atMs)}`)),
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

const signCommand = role => `pnpm sign --role ${role} proposal.json`

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

function walletSign(wallet, role, ctx) {
  const leg = role === 'buyer' ? ctx.proposal?.leg2 : ctx.proposal?.leg1 // buyer pre-signs the exit, seller signs the concession
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
  const btn = h('button', { class: 'btn', type: 'button', disabled: !leg, onclick: async () => {
    btn.disabled = true
    msg.hidden = true
    wait.errors[role] = null
    wait.busy = true // polling holds while the wallet is open, so this button is not re-rendered under the user
    try {
      btn.textContent = 'Connecting to the wallet…'
      const api = await wallet.enable()
      if (await api.getNetworkId() !== 0) return fail(`${wallet.name} is on mainnet. Switch it to preprod and try again. Nothing was signed.`)
      btn.textContent = 'Confirm in your wallet…'
      const witnessSet = await api.signTx(leg.cborHex, true)
      btn.textContent = 'Sending the signature…'
      await post(`proposal/${enc(ctx.row.ref)}/witness`, { role, witnessSet })
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
  const cmd = signCommand(role)
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
    try { rerun(await post(`proposal/${enc(row.ref)}/submit`, { escrowRef: row.ref })) }
    catch (x) { err.hidden = false; err.textContent = x.message; btn.disabled = false; btn.textContent = 'Send both legs' }
  } }, 'Send both legs')
  return h('div', {}, btn, !live && h('span', { class: 'hint' }, 'Runs in live mode'), err)
}

function settleSteps(row, proposal, log, rerun, band, wait) {
  const ctx = { row, proposal, rerun, wait }
  const signed = role => proposal?.signedBy.includes(role) ?? false
  const bothSigned = signed('buyer') && signed('seller') // nothing can be sent before both signatures exist
  const entry = leg => bothSigned && proposal[leg] && log.find(e => e.txHash === proposal[leg].txHash)
  const leg1 = entry('leg1')
  const leg2 = entry('leg2')
  const refused = [leg1, leg2].find(e => e?.status === 'refused')
  return [
    { label: 'Buyer raises the dispute', done: ['Disputed', 'RefundRequested'].includes(row.state) || !!proposal,
      waiting: 'Waiting for buyer', body: [] },
    { label: 'Seller proposes the split', done: !!proposal, waiting: 'Waiting for seller',
      body: proposal
        ? [h('p', {}, `Seller receives ${pct(proposal.sellerShare)} of the value, buyer ${pct(1 - proposal.sellerShare)}.`),
          proposal.leg1 && h('p', { class: 'hash' }, 'Leg 1 fixed, hash ', h('span', { class: 'mono', title: proposal.leg1.txHash }, short(proposal.leg1.txHash)))]
        : [proposeForm(row, rerun, band)] },
    { label: 'Buyer pre-signs the exit (leg 2)', done: signed('buyer'), waiting: 'Waiting for buyer',
      body: signed('buyer')
        ? [proposal.leg2 && h('p', { class: 'hash' }, 'Exit signed, hash ', h('span', { class: 'mono', title: proposal.leg2.txHash }, short(proposal.leg2.txHash))),
          h('p', { class: 'lock' }, 'Split locked: changing leg 1 now would void this signature.')]
        : [waitingFor('buyer', ctx)] },
    { label: 'Seller signs the concession (leg 1)', done: signed('seller'), waiting: 'Waiting for seller',
      body: signed('seller') ? [] : [waitingFor('seller', ctx)] },
    { label: 'Seller sends both legs', done: leg1?.status === 'accepted' && leg2?.status === 'accepted', error: refused, waiting: 'Ready to send',
      body: refused
        ? [h('p', {}, `Refused by the node: ${refused.error ?? 'no reason given'}. Start over on the next bank escrow.`)]
        : leg1 || leg2
          ? [[leg1, leg2].filter(Boolean).map(e => h('p', { class: 'hash' }, `${e.step}: accepted, `, txLink(e.txHash)))]
          : [sendButton(row, rerun)] },
    { label: 'Balances read back from the second indexer', done: !!leg2?.readback, waiting: 'Waiting for read-back',
      body: leg2?.readback ? [
        h('p', {}, `Read back on ${leg2.readback.provider}: ${leg2.readback.validContract ? 'valid contract' : 'contract not valid'}.`),
        leg2.readback.balances && renderBalances(leg2.readback.balances),
      ] : [] },
  ]
}

// One escrow's native quantities (DESIGN §10.1). ADA has 6 decimals; other tokens stay in base units until their decimals are pinned in shared/constants.ts.
function qty(unit, q) {
  if (unit !== 'lovelace') return q.toLocaleString('en')
  const sign = q < 0n ? '-' : ''
  const abs = q < 0n ? -q : q
  return `${sign}${(abs / 1_000_000n).toLocaleString('en')}.${String(abs % 1_000_000n).padStart(6, '0')}`
}

// Carbon data-table pattern: compact rows, mono numbers right-aligned, before and after side by side.
function renderBalances(balances) {
  const signed = (unit, d) => `${d > 0n ? '+' : ''}${qty(unit, d)}`
  return h('div', { class: 'balances-wrap' }, h('table', { class: 'balances' },
    h('thead', {}, h('tr', {}, ['Party', 'Asset', 'Before', 'After', 'Change'].map((c, i) => h('th', { scope: 'col', class: i > 1 ? 'num' : null }, c)))),
    h('tbody', {}, balances.map(b => {
      const before = BigInt(b.before)
      const after = BigInt(b.after)
      return h('tr', {},
        h('td', {}, cap(b.party)),
        h('td', {}, b.asset === 'lovelace' ? 'ADA' : `${assetName(b.asset)} (base units)`),
        h('td', { class: 'num mono' }, qty(b.asset, before)),
        h('td', { class: 'num mono' }, qty(b.asset, after)),
        h('td', { class: 'num mono' }, signed(b.asset, after - before)))
    }))))
}

function renderSteps(steps) {
  let reached = false
  return h('ol', { class: 'steps' }, steps.map(s => {
    const state = s.error ? 'error' : s.done ? 'done' : reached ? 'later' : 'current'
    if (!s.done) reached = true
    const status = { done: 'Done', current: s.waiting, later: 'Cannot start yet', error: 'Refused' }[state]
    return h('li', { class: `step ${state}` },
      h('span', { class: 'mark', 'aria-hidden': 'true' }),
      h('div', { class: 'step-body' },
        h('div', { class: 'step-head' }, h('span', { class: 'step-label' }, s.label), h('span', { class: 'status' }, status)),
        state !== 'later' && s.body),
    )
  }))
}

function renderLog(log) {
  if (!log.length) return null
  return h('section', { class: 'log' },
    h('h2', {}, 'Transactions'),
    h('ol', { class: 'timeline' }, log.map(e => h('li', { class: e.status },
      h('span', { class: 'mark', 'aria-hidden': 'true' }),
      h('span', {}, e.step),
      h('span', { class: 'status' }, e.status === 'accepted' ? 'Accepted' : `Refused: ${e.error ?? 'no reason given'}`),
      txRef(e)))))
}

async function settleView(row) {
  const panel = h('div', { class: 'settle' })
  const solver = await load('solver', row.ref)
  const band = solver.ref === row.ref ? solver.bands.find(b => b.horizonDays === 30) : null
  let sent = [] // the submit response, shown while GET /api/txlog has nothing for this escrow
  let shown = null // label of the step last scrolled into view
  const wait = { label: null, since: Date.now(), busy: false, errors: {} } // elapsed counter, wallet in progress, wallet errors per role
  let timer = 0 // one polling chain per panel, whoever triggers the re-render
  const poll = () => {
    if (!panel.isConnected) return // the view was left
    if (wait.busy) timer = setTimeout(poll, POLL_MS)
    else rerun()
  }
  const rerun = async justSent => {
    if (Array.isArray(justSent)) sent = justSent
    const [proposal, fetched] = await Promise.all([load('proposal', row.ref), load('txlog', row.ref)])
    const log = fetched.length ? fetched : sent
    const mine = proposal?.escrowRef === row.ref ? proposal : null
    const steps = settleSteps(row, mine, log, rerun, band, wait)
    const waiting = steps.find(s => !s.done)?.label ?? null
    if (waiting !== wait.label) Object.assign(wait, { label: waiting, since: Date.now() })
    panel.replaceChildren(...[renderSteps(steps), renderLog(log)].filter(Boolean))
    const now = panel.querySelector('.step.current, .step.error')
    const label = now?.querySelector('.step-label').textContent ?? null
    if (now && label !== shown) requestAnimationFrame(() => now.scrollIntoView({ block: 'nearest' })) // only when the step changes, so polling never yanks the scroll
    shown = label
    const waitingOnSignature = mine && (!mine.signedBy.includes('buyer') || !mine.signedBy.includes('seller'))
    clearTimeout(timer)
    if (live && waitingOnSignature) timer = setTimeout(poll, POLL_MS) // picks up the signed file dropped by pnpm sign
  }
  await rerun()
  return panel
}

/* Solver: scale-free. Every figure is a share of one asset of this escrow, never a sum across assets. */

const assetName = unit => unit === 'lovelace' ? 'ADA' : unit === USDM ? 'USDM' : short(unit)

// Share of each asset when the escrow's value is known (mainnet census rows); base-unit quantities otherwise.
function perAsset(terms, value) {
  const units = [...new Set([...Object.keys(value ?? {}), ...Object.keys(terms)])]
  if (units.every(u => Number(terms[u] ?? 0) === 0)) return 'Nothing'
  return units.map(u => {
    const q = Number(terms[u] ?? 0)
    if (value?.[u]) return q === 0 ? `nothing of the ${assetName(u)}` : `${pct(q / Number(value[u]))} of the ${assetName(u)}`
    return `${q.toLocaleString('en')} ${u === 'lovelace' ? 'lovelace' : `${assetName(u)} base units`}`
  }).join(', ')
}

function renderBands(bands) {
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  return h('section', { class: 'bands' },
    h('h2', {}, 'Splits both sides can accept'),
    h('p', { class: 'hint' }, 'Seller\'s share of the escrow value, by how long the buyer is willing to wait for an arbiter.'),
    h('div', { class: 'band-grid' },
      bands.map(b => [
        h('span', { class: 'band-label' }, `Buyer waits ${b.horizonDays} days`),
        h('div', { class: 'track', title: `${pct(b.sellerShareMin)} to ${pct(b.sellerShareMax)} of the value` },
          h('span', { class: 'range', style: `left:${b.sellerShareMin * 100}%;width:${(b.sellerShareMax - b.sellerShareMin) * 100}%` })),
        h('span', { class: 'band-value mono' }, `${pct(b.sellerShareMin)} to ${pct(b.sellerShareMax)}`),
      ]),
      h('span'),
      h('div', { class: 'axis', 'aria-hidden': 'true' }, ticks.map(t => h('span', { style: `left:${t * 100}%` }, pct(t)))),
    ))
}

function renderPaths(solver, value) {
  const paths = [['Seller concedes first', solver.pathB], ['Buyer concedes first', solver.pathA]]
  const row = (label, cell) => h('tr', {}, h('th', { scope: 'row' }, label), paths.map(([, p]) => h('td', {}, cell(p))))
  return h('section', { class: 'paths' },
    h('h2', {}, 'What each exit path costs'),
    h('table', {},
      h('thead', {}, h('tr', {}, h('td'), paths.map(([name]) => h('th', { scope: 'col' }, name)))),
      h('tbody', {},
        row('Protocol fee', p => Object.keys(p.fee).length ? perAsset(p.fee, value) : 'None'),
        row('Exposed on the second leg', p => cap(p.exposedParty)),
        row('Least the exposed party keeps', p => perAsset(p.exposedFloor, value)),
        row('What a defector can take', p => perAsset(p.defectorKeeps, value)))))
}

async function solverView(row) {
  const solver = await load('solver', row.ref)
  if (solver.ref !== row.ref) return blank('No solver output for this escrow', 'The solver has not priced this reference in this data set.', false)
  return [renderBands(solver.bands), renderPaths(solver, row.value)]
}

/* Shell */

function blank(title, text, back = true) {
  return h('div', { class: 'blank' }, h('h2', {}, title), h('p', {}, text), back && h('a', { class: 'btn', href: urlFor() }, 'Back to the list'))
}

let base = null // [census, bank], loaded once per page
let renderSeq = 0

// Reads escrow and view from the URL. animate: the grid's one orchestrated reveal, never on keyboard or history moves.
async function render({ animate = true, focusList = false } = {}) {
  const seq = ++renderSeq
  if ($('pop').matches(':popover-open')) $('pop').hidePopover()
  try {
    base ??= await Promise.all([load('census'), loadBank()])
    const [census, bank] = base
    const rows = [...census.rows.map(r => ({ ...r, network: 'mainnet' })), ...bank.map(r => ({ ...r, network: 'preprod' }))]
    const ref = escrowFromUrl() ?? census.rows.find(r => r.state === 'Disputed')?.ref
    renderList(census, bank, ref)
    if (focusList) document.querySelector('.row[aria-current]')?.focus()
    renderFoot(census)
    const row = rows.find(r => r.ref === ref)
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
  render(opts)
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
$('detail').replaceChildren(renderGrid(null))
render()
