// World-state TYPES. The Stack-A worldState(store) engine that produced these was retired in the
// two-brain fuse — the per-track situation now comes from the fs-native world-state-native reader.
// These interfaces stay: they're the shared shape consumed across the IPC/HTTP/renderer surfaces.

export interface WorldEvent {
  date: string
  label: string
  kind: 'milestone' | 'risk' | 'deadline'
  confidence: number
}

export interface WorldTrack {
  key: string
  label: string
  open: number
  due_soon: number
  next_due: string | null
  risks: number
  top_risk: string | null
  risk_list: string[]
  drivers: string[]
  status: string
  events: WorldEvent[]
}

export interface WorldState {
  tracks: WorldTrack[]
  generated: string
}
