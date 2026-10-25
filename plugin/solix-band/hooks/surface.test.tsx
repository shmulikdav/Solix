import { expect, mock, test } from 'claude-code/testing'

const SNAP = {
  pending: 1,
  top: { requestId: 'r1', sessionId: 's1', tool: 'Bash', detail: 'git push', sessionName: 'qa' },
  active: 1, needsYou: 1, idle: 2, spendUsd: 1.5, version: '1.12.1',
}

function engine(on: any) {
  on('command.register', () => ({ value: { command: 'solix-band' } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  mock.clock(on); mock.env(on, {})
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(SNAP) } }))
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return h(Text, null, 'engine') })
}

for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  test(`band draws on ${surface}`, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({
      plugin: 'solix-band', component: 'AbovePrompt', requestId: 'ap', surface,
      props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 100, scroll: { offset: 0, bodyRows: 10 } },
    })
    const row = await ui.find({ type: 'Text', text: /git push/ })
    expect(row?.text, `nothing drawn on ${surface}`).toBeTruthy()
    await ui.unmount()
  })
}

test('/solix-band status says it is loaded even when Solix is not running', async ($, on) => {
  on('command.register', () => ({ value: { command: 'solix-band' } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  mock.clock(on); mock.env(on, {})
  on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return h(Text, null, 'engine') })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const res = await $.command.run({ command: 'solix-band', args: 'status' })
  // The whole point: distinguishable from silence.
  expect(res.text).toContain('loaded')
  expect(res.text).toContain('4242')
})

test('/solix-band status reports the connection when Solix answers', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const res = await $.command.run({ command: 'solix-band', args: 'status' })
  expect(res.text).toContain('connected')
  expect(res.text).toContain('1 waiting')
})
