import { t } from '@/lib/i18n'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { NumberRow, SettingsPage, SettingsRow, SettingsSection, ToggleRow } from '@/components/ui/settings'
import { invoke, query } from '@/lib/ipc-client'
import { panelFromResult, panelLoading, panelReady, type PanelStatus } from '@/lib/panel-state'
import { describeError } from '@/lib/result'
import type { EmbedderInfo } from '@/lib/types'
import { toast } from '@/stores/toast-store'
import { useRagStore } from '@/stores/rag-store'
import { useSettingsStore } from '@/stores/settings-store'

// RAG settings. Surfaces the rag block of AppSettings; every control auto-applies.
//
// Every control here has a main-side reader: chat-augmentation.ts reads lexK / vecK /
// fusedTopN / rerankMode / citationRequired / multiQueryRewrite and retrieve-agent.ts
// reads rerankMode. The panel used to also persist `enabled`, `autoRagInConversations`,
// `defaultEmbedderId`, `chunkSize` and `chunkOverlap`, which nothing read: retrieval runs
// on every turn regardless, chunking is per collection, and the live embedder is set
// through rag.embedder.setActive. Those controls are gone rather than wired, so nothing
// on this page claims to do something it does not.

interface RagSettingsValue {
  lexK: number
  vecK: number
  fusedTopN: number
  rerankMode: 'off' | 'local-cross-encoder' | 'llm'
  multiQueryRewrite: boolean
  citationRequired: boolean
}

const DEFAULTS: RagSettingsValue = {
  lexK: 30,
  vecK: 30,
  fusedTopN: 8,
  rerankMode: 'local-cross-encoder',
  multiQueryRewrite: false,
  citationRequired: false
}

interface EmbedderView {
  embedders: EmbedderInfo[]
  activeId: string | null
}

export function RagSettings(): React.ReactElement {
  // The embedder catalogue is read here rather than through the rag store, whose loader
  // dropped a failed read on the floor and left the select on "Loading…" for good.
  const [catalog, setCatalog] = useState<PanelStatus<EmbedderView>>(panelLoading())
  const [switching, setSwitching] = useState(false)
  const loadEmbedders = useRagStore((s) => s.loadEmbedders)

  // OCR lives in the TOP-LEVEL AppSettings block (ocrEnabled / ocrEngine), not
  // the nested `rag` block — the main-process loader reads those keys directly
  // (readSettings().ocrEnabled). Bind straight to the settings store so the
  // toggle persists across restarts and the `DUIN_OCR` env override still wins.
  const ocrEnabled = useSettingsStore((s) => s.settings.ocrEnabled ?? true)
  const ocrEngine = useSettingsStore((s) => s.settings.ocrEngine ?? 'tesseract')
  const rag = useSettingsStore((s) => s.settings.rag)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const value: RagSettingsValue = { ...DEFAULTS, ...((rag ?? {}) as Partial<RagSettingsValue>) }

  const loadCatalog = useCallback(async (): Promise<void> => {
    const [list, active] = await Promise.all([
      query<EmbedderInfo[]>('embedding models', window.api?.rag?.embedder?.catalog),
      query<{ id: string }>('active embedding model', window.api?.rag?.embedder?.active)
    ])
    if (!list.ok) {
      setCatalog(panelFromResult(list))
      return
    }
    setCatalog(panelReady({ embedders: list.data, activeId: active.ok ? active.data.id : null }))
  }, [])

  useEffect(() => {
    void loadCatalog()
  }, [loadCatalog])

  // Through the settings store, so the write is serialized with every other settings
  // write, reverted (with a toast) when it fails, and the store's copy never goes stale.
  // Merging over the stored block keeps the keys this panel does not show (rerankerId,
  // minRerankScore) instead of replacing the block wholesale. Returns the store promise
  // so a row can show its Saved mark.
  const update = (patch: Partial<RagSettingsValue>): Promise<boolean> =>
    updateSettings({ rag: { ...(rag ?? {}), ...patch } })

  const switchEmbedder = async (id: string): Promise<void> => {
    if (!id) return
    setSwitching(true)
    try {
      await invoke('switch embedding model', () => window.api.rag.embedder.setActive(id))
      setCatalog((s) => (s.phase === 'ready' ? panelReady({ ...s.data, activeId: id }) : s))
      toast.success(t('Embeddings model switched'))
      // The rag store's copy is the default for new Library collections; keep it current.
      void loadEmbedders()
    } catch (e) {
      toast.error(describeError(e, t('Could not switch the embeddings model')))
    } finally {
      setSwitching(false)
    }
  }

  const embedderControl = (): React.ReactElement => {
    if (catalog.phase === 'error') {
      return (
        <div className="flex items-center gap-2">
          <Select aria-label={t('Embeddings model')} value="" disabled>
            <option value="">{t('Couldn\'t load models')}</option>
          </Select>
          <Button size="sm" onClick={() => void loadCatalog()}>
            {t('Retry')}
          </Button>
        </div>
      )
    }
    if (catalog.phase === 'loading') {
      return (
        <Select aria-label={t('Embeddings model')} value="" disabled>
          <option value="">{t('Loading…')}</option>
        </Select>
      )
    }
    const { embedders, activeId } = catalog.data
    return (
      <Select
        aria-label={t('Embeddings model')}
        value={activeId ?? ''}
        disabled={switching}
        onChange={(e) => void switchEmbedder(e.target.value)}
      >
        {activeId === null && (
          <option value="" disabled>
            {t('Choose a model')}
          </option>
        )}
        {embedders.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name} — {Math.round(e.approxBytes / 1024 / 1024)} MB
          </option>
        ))}
      </Select>
    )
  }

  return (
    <SettingsPage
      purpose={t('Retrieval over your indexed documents. Embeddings and search run on this machine; the reranker and the multi-query rewrite below can call your active model.')}
    >
      <SettingsSection label={t('OCR')}>
        <ToggleRow
          label={t('OCR for images and scanned documents')}
          hint={t('Extracts text from screenshots and scanned pages so they can be searched. Runs on this computer.')}
          checked={ocrEnabled}
          onChange={(v) => updateSettings({ ocrEnabled: v })}
        />
        <SettingsRow
          label={t('OCR engine')}
          hint={t('Tesseract is the default. PaddleOCR reads Chinese, Japanese and Korean better.')}
          control={
            <Select
              aria-label={t('OCR engine')}
              value={ocrEngine}
              disabled={!ocrEnabled}
              onChange={(e) => void updateSettings({ ocrEngine: e.target.value as 'tesseract' | 'paddle' })}
            >
              <option value="tesseract">{t('Tesseract (default)')}</option>
              <option value="paddle">{t('PaddleOCR (better for Chinese, Japanese and Korean)')}</option>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection label={t('Embeddings')}>
        <SettingsRow
          label={t('Embeddings model')}
          hint={t('The on-device model that indexes new documents for search.')}
          control={embedderControl()}
        >
          {catalog.phase === 'error' && (
            <p className="text-[12px] text-[var(--error)]">{catalog.error}</p>
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection label={t('Retrieval')}>
        <NumberRow
          label={t('Lex top-K')}
          hint={t('How many keyword matches to fetch before the results are fused.')}
          value={value.lexK}
          spec={{ min: 0, max: 100 }}
          defaultValue={DEFAULTS.lexK}
          onCommit={(n) => update({ lexK: n })}
        />
        <NumberRow
          label={t('Vec top-K')}
          hint={t('How many vector matches to fetch before the results are fused.')}
          value={value.vecK}
          spec={{ min: 0, max: 100 }}
          defaultValue={DEFAULTS.vecK}
          onCommit={(n) => update({ vecK: n })}
        />
        <NumberRow
          label={t('Fused top-N')}
          hint={t('How many fused results reach the model.')}
          value={value.fusedTopN}
          spec={{ min: 1, max: 50 }}
          defaultValue={DEFAULTS.fusedTopN}
          onCommit={(n) => update({ fusedTopN: n })}
        />
      </SettingsSection>

      <SettingsSection label={t('Rerank')}>
        <SettingsRow
          label={t('Rerank mode')}
          hint={t('Re-orders the fused results before they reach the model.')}
          control={
            <Select
              aria-label={t('Rerank mode')}
              value={value.rerankMode}
              onChange={(e) => void update({ rerankMode: e.target.value as RagSettingsValue['rerankMode'] })}
            >
              <option value="off">{t('Off (fastest)')}</option>
              <option value="local-cross-encoder">{t('Local cross-encoder (slow, highest quality)')}</option>
              <option value="llm">{t('LLM as reranker (uses active model)')}</option>
            </Select>
          }
        />
        <ToggleRow
          label={t('Multi-query rewrite')}
          hint={t('Your active model rewrites the question into two or three phrasings and the results are merged. Costs one extra model call per turn.')}
          checked={value.multiQueryRewrite}
          onChange={(v) => update({ multiQueryRewrite: v })}
        />
        <ToggleRow
          label={t('Citation required')}
          hint={t('Model is instructed to refuse if no source supports a claim.')}
          checked={value.citationRequired}
          onChange={(v) => update({ citationRequired: v })}
        />
      </SettingsSection>
    </SettingsPage>
  )
}
