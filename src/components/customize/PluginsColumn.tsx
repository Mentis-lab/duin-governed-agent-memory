import { t } from '@/lib/i18n'
import { useEffect, useMemo, useState } from 'react'
import { IconButton } from '@/components/ui/IconButton'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import type { LoadedPlugin } from '@/lib/types'
import { usePluginsStore } from '@/stores/plugins-store'
import { InstallPluginFlow } from './InstallPluginFlow'

interface DetailDrawerProps {
  plugin: LoadedPlugin
  onClose: () => void
  onRemove: () => Promise<void>
}

function DetailDrawer({ plugin, onClose, onRemove }: DetailDrawerProps) {
  const { manifest, surfaceCounts, rootPath } = plugin

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-end bg-black/40">
      <div className="flex h-full w-[460px] flex-col border-l border-[var(--panel-border)] bg-[var(--bg-secondary)] shadow-2xl">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--panel-border)] px-4">
          <span className="truncate text-[14px] font-semibold text-[var(--text-primary)]">
            {manifest.name}
          </span>
          <span className="rounded bg-[var(--bg-tertiary)] px-1 py-0 font-mono text-[11px] text-[var(--text-muted)]">
            v{manifest.version}
          </span>
          <div className="flex-1" />
          <IconButton
            onClick={onClose}
            aria-label={t('Close')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </IconButton>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <p className="text-[12px] text-[var(--text-primary)]">{manifest.description}</p>

          <dl className="grid grid-cols-[100px_1fr] gap-y-1 text-[11px]">
            <dt className="text-[var(--text-muted)]">ID</dt>
            <dd className="font-mono text-[var(--text-primary)]">{manifest.id}</dd>
            {manifest.author && (
              <>
                <dt className="text-[var(--text-muted)]">{t('Author')}</dt>
                <dd className="text-[var(--text-primary)]">{manifest.author}</dd>
              </>
            )}
            {manifest.category && (
              <>
                <dt className="text-[var(--text-muted)]">{t('Category')}</dt>
                <dd className="text-[var(--text-primary)]">{manifest.category}</dd>
              </>
            )}
            {manifest.homepage && (
              <>
                <dt className="text-[var(--text-muted)]">{t('Homepage')}</dt>
                <dd className="truncate font-mono text-[var(--text-primary)]">
                  {manifest.homepage}
                </dd>
              </>
            )}
            <dt className="text-[var(--text-muted)]">{t('Path')}</dt>
            <dd className="truncate font-mono text-[var(--text-muted)]" title={rootPath}>
              {rootPath}
            </dd>
          </dl>

          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
              {t('Bundled assets')}
            </div>
            <ul className="space-y-0.5 text-[12px]">
              <li>
                <span className="text-[var(--text-secondary)]">{t('Skills:')}</span>{' '}
                <span className="font-mono text-[var(--text-primary)]">{surfaceCounts.skills}</span>
              </li>
              <li>
                <span className="text-[var(--text-secondary)]">{t('Slash commands:')}</span>{' '}
                <span className="font-mono text-[var(--text-primary)]">
                  {surfaceCounts.slashCommands}
                </span>
              </li>
              <li>
                <span className="text-[var(--text-secondary)]">{t('Connectors:')}</span>{' '}
                <span className="font-mono text-[var(--text-primary)]">
                  {surfaceCounts.connectors}
                </span>
              </li>
            </ul>
          </div>
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-[var(--panel-border)] px-4 py-3">
          <Button variant="danger" className="bg-[var(--bg-primary)] hover:border-[var(--error)]"
            onClick={() => {
              if (!confirm(`Remove plugin "${manifest.name}"? Files on disk will be deleted.`)) return
              void onRemove()
            }}
          >
            {t('Remove')}
          </Button>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-3 py-1.5 text-[12px] hover:border-[var(--accent)]"
          >
            {t('Close')}
          </button>
        </footer>
      </div>
    </div>
  )
}

export function PluginsColumn() {
  const plugins = usePluginsStore((s) => s.plugins)
  const loadPlugins = usePluginsStore((s) => s.loadPlugins)
  const setPluginsFromEvent = usePluginsStore((s) => s.setPluginsFromEvent)
  const enable = usePluginsStore((s) => s.enable)
  const disable = usePluginsStore((s) => s.disable)
  const remove = usePluginsStore((s) => s.remove)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [installOpen, setInstallOpen] = useState(false)

  useEffect(() => {
    void loadPlugins()
  }, [loadPlugins])

  useEffect(() => {
    if (!window.api?.plugins?.onChanged) return
    const dispose = window.api.plugins.onChanged((entries) => {
      setPluginsFromEvent(entries as LoadedPlugin[])
    }) as unknown
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, [setPluginsFromEvent])

  const grouped = useMemo(() => {
    const map = new Map<string, LoadedPlugin[]>()
    for (const p of plugins) {
      const cat = p.manifest.category?.trim() || 'Other'
      const arr = map.get(cat) ?? []
      arr.push(p)
      map.set(cat, arr)
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [plugins])

  const detail = useMemo(
    () => plugins.find((p) => p.manifest.id === detailId) ?? null,
    [plugins, detailId]
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--panel-border)] px-3 py-2">
        <span className="text-[12px] text-[var(--text-secondary)]">
          {plugins.length} plugin{plugins.length === 1 ? '' : 's'}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setInstallOpen(true)}
          className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] hover:border-[var(--accent)]"
          title={t('Install a plugin')}
        >
          + Install
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {plugins.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">
            {t('No plugins installed yet.')}
          </div>
        )}
        {grouped.map(([category, list]) => (
          <section key={category} className="mb-3">
            <h3 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {category}
            </h3>
            <div className="space-y-1">
              {list.map((plugin) => {
                const { manifest, surfaceCounts } = plugin
                return (
                  <div
                    key={manifest.id}
                    className="group flex items-start gap-2 rounded border border-transparent p-2 hover:border-[var(--panel-border)] hover:bg-[var(--bg-tertiary)]"
                  >
                    <Toggle
                      checked={plugin.enabled}
                      onChange={() => void (plugin.enabled ? disable(manifest.id) : enable(manifest.id))}
                      aria-label={plugin.enabled ? 'Disable plugin' : 'Enable plugin'}
                      className="mt-0.5"
                    />

                    <button
                      onClick={() => setDetailId(manifest.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">
                          {manifest.name}
                        </span>
                        <span className="rounded bg-[var(--bg-tertiary)] px-1 py-0 font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                          v{manifest.version}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-[var(--text-secondary)]">
                        {manifest.description}
                      </div>
                      <div className="mt-0.5 flex gap-2 text-[11px] text-[var(--text-muted)]">
                        {surfaceCounts.skills > 0 && (
                          <span>{surfaceCounts.skills} skill{surfaceCounts.skills === 1 ? '' : 's'}</span>
                        )}
                        {surfaceCounts.slashCommands > 0 && (
                          <span>
                            {surfaceCounts.slashCommands} command
                            {surfaceCounts.slashCommands === 1 ? '' : 's'}
                          </span>
                        )}
                        {surfaceCounts.connectors > 0 && (
                          <span>
                            {surfaceCounts.connectors} connector
                            {surfaceCounts.connectors === 1 ? '' : 's'}
                          </span>
                        )}
                      </div>
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      {detail && (
        <DetailDrawer
          plugin={detail}
          onClose={() => setDetailId(null)}
          onRemove={async () => {
            await remove(detail.manifest.id)
            setDetailId(null)
          }}
        />
      )}
      {installOpen && <InstallPluginFlow onClose={() => setInstallOpen(false)} />}
    </div>
  )
}
