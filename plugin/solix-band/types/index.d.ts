/** What `GET /api/band` answers with. */
export type BandSnapshot = {
  pending: number
  top: {
    requestId: string
    sessionId: string
    tool: string
    /** The command for a shell call, the path for a file write. */
    detail: string
    sessionName: string | null
  } | null
  active: number
  needsYou: number
  idle: number
  spendUsd: number
  version: string
}

declare module 'claude-code' {
  interface PluginState {
    'solix-band': {
      /** Last successful poll, or null when Solix is not reachable. */
      snapshot: BandSnapshot | null
      /** Hidden for this session by `/solix-band off`. */
      isHidden: boolean
    }
  }
}
