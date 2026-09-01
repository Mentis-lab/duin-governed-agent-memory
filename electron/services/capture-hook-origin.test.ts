// Backlog finding 43. capture-hook read DUIN_BRAIN_URL as though it were already a bare
// ORIGIN, while duin-bridge reads the SAME variable as a full ENDPOINT (its default ends
// in /agui) and additionally coerces the retired :8765 stub port back to :8799. One env
// var, two meanings — so setting it to the endpoint shape duin-bridge documents made
// capture-hook build `http://host/agui/learn/correction`, which is not a route, and left
// the :8765 footgun unguarded on this path.

import { describe, it, expect, afterEach } from 'vitest'
import { origin } from './capture-hook'

const OLD = process.env.DUIN_BRAIN_URL
afterEach(() => {
  if (OLD === undefined) delete process.env.DUIN_BRAIN_URL
  else process.env.DUIN_BRAIN_URL = OLD
})

describe('capture-hook origin()', () => {
  it('reduces a full endpoint to its origin', () => {
    // The shape duin-bridge documents and defaults to.
    process.env.DUIN_BRAIN_URL = 'http://127.0.0.1:8799/agui'
    expect(origin()).toBe('http://127.0.0.1:8799')
  })

  it('reduces a remote endpoint with a path the same way', () => {
    process.env.DUIN_BRAIN_URL = 'https://brain.example.com/agui/run'
    expect(origin()).toBe('https://brain.example.com')
  })

  it('coerces the retired :8765 stub port, as duin-bridge does', () => {
    process.env.DUIN_BRAIN_URL = 'http://127.0.0.1:8765/agui'
    expect(origin()).toBe('http://127.0.0.1:8799')
  })

  it('defaults when unset', () => {
    delete process.env.DUIN_BRAIN_URL
    expect(origin()).toBe('http://127.0.0.1:8799')
  })

  it('passes an unparseable value through, so the error names it', () => {
    process.env.DUIN_BRAIN_URL = 'not a url'
    expect(origin()).toBe('not a url')
  })

  it('a bare origin still works — no trailing-slash surprise', () => {
    process.env.DUIN_BRAIN_URL = 'http://127.0.0.1:9000/'
    expect(origin()).toBe('http://127.0.0.1:9000')
  })
})
