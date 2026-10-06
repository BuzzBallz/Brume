// Brume UI. One flag picks the data source: ?source=live (agent API), snapshot (docs/data, GitHub Pages) or mock (shared/mock).

const REDEEMERS = ['Withdraw', 'SetRefundRequested', 'UnSetRefundRequested', 'WithdrawRefund', 'WithdrawDisputed', 'SubmitResult', 'AuthorizeRefund'] // = REDEEMER in shared/types.ts
const ROLES = ['buyer', 'seller', 'admin']
const STATE_LABEL = { FundsLocked: 'Funds locked', ResultSubmitted: 'Result submitted', RefundRequested: 'Refund requested', Disputed: 'Disputed' }
const MOCK_FILE = { census: 'census', grid: 'grid', datum: 'datum-disputed' }

const params = new URLSearchParams(location.search)
const source = params.get('source') ?? (location.hostname.endsWith('github.io') ? 'snapshot' : 'live')
const $ = id => document.getElementById(id)

// ponytail: snapshot and mock hold one escrow per kind; per-ref files once the list shows more than the hero escrow.
async function load(kind, ref) {
  const url = source === 'mock' ? `../shared/mock/${MOCK_FILE[kind]}.mock.json`
    : source === 'snapshot' ? `data/${kind}.json`
    : `/api/${kind}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`)
  const json = await res.json()
  return json[kind] ?? json
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

const short = ref => `${ref.slice(0, 8)}…${ref.slice(-8)}`
const cap = s => s[0].toUpperCase() + s.slice(1)
const utc = ms => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const rel = (ms, nowMs) => {
  const days = (ms - nowMs) / 864e5
  return Math.abs(days) >= 1 ? rtf.format(Math.round(days), 'day') : rtf.format(Math.round(days * 24), 'hour')
}

function urlFor(ref) {
  const q = new URLSearchParams()
  if (params.has('source')) q.set('source', source)
  if (ref) q.set('escrow', ref)
  return `?${q}`
}

// JobResult.uiUrl puts the raw ref in the query, so its "#<index>" lands in location.hash.
function escrowFromUrl() {
  const e = params.get('escrow')
  return e && !e.includes('#') && /^#\d+$/.test(location.hash) ? e + location.hash : e
}

const chip = state => h('span', { class: `chip state-${state}` }, h('span', { class: 'glyph', 'aria-hidden': 'true' }), STATE_LABEL[state] ?? 'Datum not decodable')

function renderSource() {
  $('source').textContent = { live: 'Live', snapshot: 'Snapshot, read-only', mock: 'Mock data' }[source] ?? source
  if (source === 'mock') {
    $('band').hidden = false
    $('band').textContent = 'Mock data, hand-made for building. Not evidence.'
  }
}

function renderList(census, selected) {
  $('list').replaceChildren(
    h('h2', { class: 'group' }, 'Mainnet, read-only'),
    h('p', { class: 'meta' }, `${census.byState.Disputed} disputed of ${census.open} open`),
    ...census.rows.map(r => h('a', { class: 'row', href: urlFor(r.ref), title: r.ref, 'aria-current': r.ref === selected ? 'page' : null },
      h('span', { class: 'mono' }, short(r.ref)), chip(r.state))),
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

function copyButton(text) {
  const btn = h('button', { class: 'btn copy', type: 'button', onclick: async () => {
    await navigator.clipboard.writeText(text)
    btn.textContent = 'Copied'
    setTimeout(() => { btn.textContent = 'Copy' }, 1200)
  } }, 'Copy')
  return btn
}

const clock = (label, ms, nowMs) => h('div', {}, h('dt', {}, label), h('dd', { title: utc(ms) }, ms ? rel(ms, nowMs) : 'not set'))

function renderHead(ref, grid, datum, network) {
  const fields = Object.entries(datum).map(([k, v]) => [h('dt', {}, k), h('dd', { class: 'mono' }, typeof v === 'object' ? v.payment.hash : String(v))])
  return h('header', { class: 'head' },
    h('div', { class: 'title' },
      h('h1', { class: 'mono', title: ref }, short(ref)), copyButton(ref),
      chip(grid.state),
      h('span', { class: 'chip net' }, network === 'mainnet' ? 'Mainnet, read-only' : 'Preprod')),
    h('dl', { class: 'clocks' },
      clock('Arbitration opened', datum.externalDisputeUnlockTime, grid.atMs),
      clock('Unlock', datum.unlockTime, grid.atMs),
      clock('Result deadline', datum.submitResultTime, grid.atMs),
      h('div', {}, h('dt', {}, 'Result hash'), h('dd', {}, datum.resultHash ? 'set' : 'empty'))),
    h('details', { class: 'datum' }, h('summary', {}, 'Datum, 16 fields'), h('dl', {}, fields)),
  )
}

function openPop(anchor, v) {
  const list = (items, none) => items.length ? h('ul', {}, items.map(t => h('li', {}, t))) : h('p', {}, none)
  const pop = $('pop')
  pop.replaceChildren(
    h('h3', {}, `${cap(v.role)}, ${v.redeemer}`),
    h('p', {}, `The validator's source says the ${v.role} ${v.allowed ? 'can' : 'can\'t'} do this now.`),
    h('h4', {}, 'Deciding guards'), list(v.failed, 'None, every guard passes.'),
    h('h4', {}, 'Output rules'), list(v.outputRules, 'None.'),
  )
  pop.showPopover()
  const r = anchor.getBoundingClientRect()
  pop.style.top = `${Math.max(8, Math.min(r.bottom + 8, innerHeight - pop.offsetHeight - 8))}px`
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`
}

function cell(v, i) {
  if (!v) return h('td', {}, h('span', { class: 'cell skel' }))
  return h('td', {}, h('button', {
    class: v.allowed ? 'cell can' : 'cell', type: 'button', style: `--i:${i}`, 'aria-haspopup': 'dialog',
    onclick: e => openPop(e.currentTarget, v),
  }, h('span', { class: 'glyph', 'aria-hidden': 'true' }), v.allowed ? 'can' : (v.failed[0] ?? 'not permitted')))
}

function renderGrid(grid) {
  const byKey = new Map((grid?.verdicts ?? []).map(v => [`${v.redeemer}/${v.role}`, v]))
  return h('table', { class: 'grid' },
    h('caption', {}, 'What each party can do now', grid && h('small', {}, `Verdicts at ${utc(grid.atMs)}`)),
    h('thead', {}, h('tr', {}, h('td'), ROLES.map(r => h('th', { scope: 'col' }, cap(r))))),
    h('tbody', {}, REDEEMERS.map((name, i) => h('tr', {},
      h('th', { scope: 'row' }, h('span', { class: 'idx mono' }, i), name),
      ROLES.map((role, j) => cell(byKey.get(`${name}/${role}`), i * 3 + j))))),
  )
}

function blank(title, text) {
  return h('div', { class: 'blank' }, h('h2', {}, title), h('p', {}, text), h('a', { class: 'btn', href: urlFor() }, 'Back to the list'))
}

async function main() {
  renderSource()
  $('reset').addEventListener('click', () => { location.href = urlFor() })
  $('detail').replaceChildren(renderGrid(null))
  try {
    const census = await load('census')
    const ref = escrowFromUrl() ?? census.rows.find(r => r.state === 'Disputed')?.ref
    renderList(census, ref)
    renderFoot(census)
    const [grid, datum] = await Promise.all([load('grid', ref), load('datum', ref)])
    if (grid.ref !== ref) {
      $('detail').replaceChildren(blank('No escrow at this reference', 'It may have been spent, or it is not in this data set.'))
      return
    }
    $('detail').replaceChildren(renderHead(ref, grid, datum, census.network), renderGrid(grid))
  } catch (err) {
    const hint = {
      live: 'Start the agent with pnpm agent, or open this page with ?source=snapshot.',
      snapshot: 'Regenerate the data with pnpm site:data.',
      mock: 'Serve the repository root so ../shared/mock is reachable.',
    }[source]
    $('detail').replaceChildren(blank('Couldn\'t load the escrow data', `${err.message}. ${hint}`))
  }
}

main()
