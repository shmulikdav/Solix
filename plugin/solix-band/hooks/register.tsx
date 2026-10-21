import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BandSnapshot } from '../types'

/**
 * Solix, above the Claude Code prompt.
 *
 * Solix's argument is "stop alt-tabbing", and its decision surface lived in a
 * browser tab — so the one genuinely time-critical thing, an agent frozen
 * waiting for an answer, was the one thing you had to switch windows to see.
 * Cost can wait. A held command cannot.
 *
 * Approve and Deny are drawn next to the command text, never on their own.
 * The browser panel refuses to resolve a decision that is not on screen
 * (`selectCanResolveByKey`), and the same rule has to hold here, or the band
 * becomes a faster way to approve something unread.
 */
const snapshot = atom(
  { plugin: 'solix-band', key: 'snapshot' } as const,
  null as BandSnapshot | null,
)
const isHidden = atom({ plugin: 'solix-band', key: 'isHidden' } as const, false)

/**
 * Resolved from the engine, not `process.env` — a hooks module runs with no
 * Node, so reaching for `process` stops the whole module loading.
 */
async function baseUrl($: EngineInterface): Promise<string> {
  const port = (await $.env.get('SOLIX_PORT')) ?? '4242'
  return `http://127.0.0.1:${port}`
}

/** Often enough that a frozen agent is noticed, cheap enough to ignore. */
const POLL_MS = 2000

/** Longest command shown inline before it is cut. */
const DETAIL_MAX = 64

async function poll($: EngineInterface): Promise<void> {
  try {
    const res = await $.http.fetch(`${await baseUrl($)}/api/band`)
    await update($, snapshot, () =>
      res.ok ? (JSON.parse(res.text) as BandSnapshot) : null,
    )
  } catch {
    // Solix not running is the ordinary case for most sessions, not an error
    // worth reporting. The band simply does not draw.
    await update($, snapshot, () => null)
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    $.command.register({
      name: 'solix-band',
      description: 'Show or hide the Solix band (on | off)',
    })
    // Awaited, so the first draw is already correct rather than blank for a
    // poll interval. Solix is on loopback, so an absent server refuses at
    // once; a hook that somehow overran its budget is dropped by the engine,
    // which costs the band its first frame and nothing else.
    await poll($)
    $.clock.every(POLL_MS, () => void poll($))
    return next(e)
  })

  on('command.run', { command: 'solix-band' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const hidden = await read($, isHidden)
    const wantHidden = arg === 'off' ? true : arg === 'on' ? false : !hidden
    await update($, isHidden, () => wantHidden)
    return { text: wantHidden ? 'Solix band hidden.' : 'Solix band shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    // Stay out of the way: nothing to say, Solix not running, hidden by the
    // person, or a survey already owns the row.
    if (!s || e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    if (s.pending > 0 && s.top) {
      const top = s.top
      const detail =
        top.detail.length > DETAIL_MAX
          ? `${top.detail.slice(0, DETAIL_MAX)}…`
          : top.detail
      const more = s.pending > 1 ? ` (+${s.pending - 1} more)` : ''

      const resolve = async (approved: boolean): Promise<void> => {
        try {
          const res = await $.http.fetch(
            `${await baseUrl($)}/api/sessions/${encodeURIComponent(top.sessionId)}/permission`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ requestId: top.requestId, approved }),
            },
          )
          $.ui.toast(
            res.ok
              ? approved
                ? 'Approved in Solix.'
                : 'Denied in Solix.'
              : 'Solix refused that — answer it in the browser.',
          )
        } catch {
          $.ui.toast('Could not reach Solix — answer it in the browser.')
        }
        void poll($)
      }

      return (
        <Box>
          <Text color="yellow">⏸ waiting{more}: </Text>
          <Text>
            {top.tool}
            {detail ? ` ${detail}` : ''}{' '}
          </Text>
          <Button key="approve" label="Approve" onPress={() => void resolve(true)} />
          <Button key="deny" label="Deny" onPress={() => void resolve(false)} />
        </Box>
      )
    }

    // Quiet state: what the fleet is doing and what it has cost so far.
    return (
      <Box>
        <Text dimColor>
          solix {s.active} active · {s.idle} idle · ${s.spendUsd.toFixed(2)}{' '}
        </Text>
        <Button
          key="hide"
          label="Hide"
          onPress={() => void update($, isHidden, () => true)}
        />
      </Box>
    )
  })
}
