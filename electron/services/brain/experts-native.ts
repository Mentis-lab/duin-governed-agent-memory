// experts-native — TS port of server.py:load_experts. The advisory lens personas (Legal /
// Financial / Strategic / Ethical / Red-team) used to pressure-test a decision. Python reads
// a bundled agui_experts.json else DEFAULT_EXPERTS (derived from LENSES); that file is absent
// in the DUIN model, so this returns the static defaults verbatim (byte-parity with the
// sidecar's DEFAULT_EXPERTS). Pure.

interface Expert {
  key: string
  label: string
  frame: string
}

const DEFAULT_EXPERTS: Expert[] = [
  {
    key: 'legal',
    label: 'Legal',
    frame:
      'You are a sharp general counsel. Pressure-test this decision for legal, contractual, IP, regulatory, and liability exposure. Name the single biggest legal risk.'
  },
  {
    key: 'financial',
    label: 'Financial',
    frame:
      'You are a seasoned CFO. Pressure-test the financial logic: cost, upside, downside, cash, and opportunity cost. Name the one number that would change the call.'
  },
  {
    key: 'strategic',
    label: 'Strategic',
    frame:
      'You are a strategy partner. Pressure-test fit with long-term position, competitive dynamics, and second-order consequences two moves out.'
  },
  {
    key: 'ethical',
    label: 'Ethical',
    frame:
      'You are a principled ethicist. Surface the values at stake, who is affected, reputational and integrity risk, and the strongest moral objection.'
  },
  {
    key: 'redteam',
    label: 'Red-team',
    frame:
      'You are a skeptical red-teamer. Argue the strongest case AGAINST this decision and name the single most likely way it goes wrong.'
  }
]

export function listExperts(_vaultDir?: string | null): { experts: Expert[] } {
  return { experts: DEFAULT_EXPERTS }
}
