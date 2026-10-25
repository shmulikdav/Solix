import { expect, mock, test } from 'claude-code/testing'

import type { BandSnapshot } from '../types'

const BAND = {
  plugin: 'solix-band',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    columns: 100,
    scroll: { offset: 0, bodyRows: 10 },
  },
} as const

const WAITING: BandSnapshot = {
  pending: 2,
  top: {
    requestId: 'req-1',
    sessionId: 'sess-1',
    tool: 'Bash',
    detail: 'rm -rf ./canary',
    sessionName: 'qa',
  },
  active: 1,
  needsYou: 1,
  idle: 3,
  spendUsd: 2.5,
  version: '1.12.1',
}

const QUIET: BandSnapshot = {
  pending: 0,
  top: null,
  active: 3,
  needsYou: 0,
  idle: 4,
  spendUsd: 1.25,
  version: '1.12.1',
}

/** Stand in for the engine, answering the band's poll with `snapshot`. */
function engine(
  on: Parameters<Parameters<typeof test>[1]>[1],
  snapshot: BandSnapshot | null,
  calls: { url: string; init?: unknown }[] = [],
): void {
  on('command.register', () => ({ value: { command: 'solix-band' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  // `$.clock` and `$.env` answered from memory. The band registers a timer on
  // start; the test does not advance the clock, so the one poll it does on
  // start is the one under test.
  mock.clock(on)
  mock.env(on, {})
  // Beneath the plugin, the engine draws its own band. A test for "the band
  // stays quiet" asserts this is what shows, rather than merely that nothing
  // of the band's is found — which would also pass if nothing drew at all.
  on('ui.render', ($: { ui: { resolve: (e: unknown) => { Text: unknown } } }, e: unknown) => {
    const { Text } = $.ui.resolve(e) as { Text: never }
    return h(Text, null, 'engine')
  })
  on('http.fetch', (_: unknown, e: { url: string; init?: unknown }) => {
    calls.push({ url: e.url, init: e.init })
    if (snapshot === null) {
      return { value: { status: 503, ok: false, headers: {}, text: '' } }
    }
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify(snapshot),
      },
    }
  })
}

test('shows the pending command, not just a count', async ($, on) => {
  engine(on, WAITING)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(BAND)

  // The command itself has to be on screen: Approve is only honest next to
  // the text of what it approves.
  expect((await ui.find({ type: 'Text', text: /rm -rf \.\/canary/ }))?.text).toContain(
    'rm -rf ./canary',
  )
  // And the queue depth, so a second one is not invisible.
  expect((await ui.find({ type: 'Text', text: /\+1 more/ }))?.text).toContain('+1 more')
  await ui.unmount()
})

test('Approve posts the decision to Solix', async ($, on) => {
  const calls: { url: string; init?: unknown }[] = []
  engine(on, WAITING, calls)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'approve' })

  const post = calls.find((c) => c.url.includes('/permission'))
  expect(post).toBeTruthy()
  expect(post!.url).toContain('/api/sessions/sess-1/permission')
  const body = JSON.parse(
    (post!.init as { body: string }).body,
  ) as { requestId: string; approved: boolean }
  expect(body).toEqual({ requestId: 'req-1', approved: true })
  await ui.unmount()
})

test('Deny posts approved:false', async ($, on) => {
  const calls: { url: string; init?: unknown }[] = []
  engine(on, WAITING, calls)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'deny' })

  const post = calls.find((c) => c.url.includes('/permission'))
  const body = JSON.parse((post!.init as { body: string }).body) as {
    approved: boolean
  }
  expect(body.approved).toBe(false)
  await ui.unmount()
})

test('with nothing pending it reports the fleet quietly', async ($, on) => {
  engine(on, QUIET)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(BAND)
  const row = await ui.find({ type: 'Text', text: /solix/ })
  expect(row?.text).toContain('3 active')
  expect(row?.text).toContain('$1.25')
  // No approve button when there is nothing to approve.
  expect(await ui.find({ type: 'Button', key: 'approve' })).toBeUndefined()
  await ui.unmount()
})

/**
 * Most sessions run without Solix. The band must then draw nothing at all —
 * an error row above every prompt would be worse than no band.
 */
test('draws nothing when Solix is not running', async ($, on) => {
  engine(on, null)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(BAND)
  // The engine's own band is what shows.
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  expect(await ui.find({ type: 'Text', text: /solix/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'approve' })).toBeUndefined()
  await ui.unmount()
})

test('a survey owns the row, so the band yields', async ($, on) => {
  engine(on, WAITING)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  expect(await ui.find({ type: 'Button', key: 'approve' })).toBeUndefined()
  await ui.unmount()
})
