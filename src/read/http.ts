// An HTTP failure is a hole, never a data point: retry 429/5xx/network with backoff, count it, and report a hole once retries run out.
export type Cfg = { base?: string; backoffMs?: number }

export const stats = { retries: 0, holes: 0 }

const MAX_RETRIES = 6

export type Reply = { status: number; body: unknown }

export async function request(url: string, init: RequestInit, backoffMs = 500): Promise<Reply | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, init)
      if (res.status !== 429 && res.status < 500) {
        const text = await res.text()
        return { status: res.status, body: text ? JSON.parse(text) : null }
      }
      if (attempt < MAX_RETRIES) {
        stats.retries++
        const wait = Number(res.headers.get('retry-after')) * 1000 || backoffMs * 2 ** attempt
        await new Promise((r) => setTimeout(r, wait))
      }
    } catch {
      if (attempt < MAX_RETRIES) {
        stats.retries++
        await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt))
      }
    }
  }
  stats.holes++
  return null
}
