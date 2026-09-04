// The settings kit — the one set of building blocks every Settings page is made of.
//
// Before this existed, 25 pages hand-rolled their own heading, card, section label, key
// card and number field, and the result was four heading systems, toggles on both sides,
// three save models nobody announced, and forty-odd inputs with no accessible name (the
// 2026-09-03 settings evaluation, section S). The kit is the fix for the whole class, not
// a page: a page that uses only these pieces cannot drift on any of those axes.
//
// Conventions, in one place:
//
//   · The page TITLE is the tab label and SettingsDialog renders it. A page starts with
//     <SettingsPage purpose="…"> and never draws its own h2/h3 title.
//   · <SettingsSection label> groups rows under a small uppercase label.
//   · A row is a card: label and hint on the left, the control on the RIGHT.
//   · Boolean and single-choice settings AUTO-APPLY. Return the store's promise from
//     onChange and the row shows a short "Saved" mark when it resolves true; a failed
//     write is reverted and toasted by the store, so the mark never lies.
//   · Free text and numbers are DRAFTS: <NumberField> and <DraftTextarea> commit on blur or
//     Enter and clamp on commit, so "1000" can be typed into a field whose floor is 200.
//   · A form with several fields has ONE Save and registers useDirtyGuard, so leaving the
//     tab asks first.
//   · A read goes through query() and renders <PanelState> with <SettingsLoadError>; a
//     failed read is never painted as "nothing here".
//   · Every control carries an accessible name; the row primitives supply it from the label.
//   · Keys live in one card, <ProviderKeyCard>, whose status has an explicit "unknown".

export { SettingsPage } from './SettingsPage'
export { SettingsSection } from './SettingsSection'
export { SettingsRow, ToggleRow, SavedMark } from './SettingsRow'
export { NumberField, NumberRow } from './NumberField'
export { commitNumber, type NumberSpec } from './number-commit'
export { DraftTextarea } from './DraftTextarea'
export { SettingsLoadError, SettingsLoading } from './SettingsLoadError'
export { SettingsLink } from './SettingsLink'
export { SecretField } from './SecretField'
export { ProviderKeyCard, type KeyStatus } from './ProviderKeyCard'
export { useSavedFlash } from './useSavedFlash'
