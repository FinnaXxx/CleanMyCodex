import { useEffect, useMemo, useState } from 'react'
import {
  formatBytes,
  generatedAssetDisplayName,
  generatedAssetBytes,
  sessionDisplayName,
  type CleanupProgress,
  type CleanupSelection,
  type GeneratedAssetItem,
  type GeneratedAssetKind,
  type ScanSnapshot,
  type SessionItem
} from '../../shared/types'
import { FolderIcon } from '../icons'
import { formatShortDate } from '../format'
import { usePreferences } from '../preferences'

interface Props {
  snapshot: ScanSnapshot
  cleaning: boolean
  actionsDisabled: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (selection: CleanupSelection) => void
}

type Scope = 'all' | GeneratedAssetKind
type Sort = 'size' | 'date' | 'source'

export default function GeneratedAssetsView({ snapshot, cleaning, actionsDisabled, cleanProgress, onCleanup }: Props) {
  const { t, locale } = usePreferences()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scope, setScope] = useState<Scope>('all')
  const [sort, setSort] = useState<Sort>('size')
  const [query, setQuery] = useState('')
  const sessionsByID = useMemo(() => new Map(snapshot.sessions.map((session) => [session.id, session])), [snapshot.sessions])

  useEffect(() => {
    const current = new Set(snapshot.generatedAssets.map((asset) => asset.id))
    setSelected((previous) => new Set([...previous].filter((id) => current.has(id))))
  }, [snapshot.generatedAssets, snapshot.scannedAt])

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const assets = snapshot.generatedAssets.filter((asset) => {
      if (scope !== 'all' && asset.kind !== scope) return false
      const session = asset.sourceSessionID ? sessionsByID.get(asset.sourceSessionID) : undefined
      if (!needle) return true
      return [asset.path, asset.sourceThreadID, session ? sessionDisplayName(session) : null]
        .filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)
    })
    return assets.sort((a, b) => {
      if (sort === 'date') return b.modifiedAt - a.modifiedAt
      if (sort === 'source') return generatedAssetDisplayName(a, assetSession(a, sessionsByID)).localeCompare(generatedAssetDisplayName(b, assetSession(b, sessionsByID)))
      return b.bytes - a.bytes
    })
  }, [query, scope, sessionsByID, snapshot.generatedAssets, sort])

  const chosen = useMemo(() => snapshot.generatedAssets.filter((asset) => selected.has(asset.id)), [selected, snapshot.generatedAssets])
  const chosenBytes = generatedAssetBytes(chosen)
  const allVisibleSelected = visible.length > 0 && visible.every((asset) => selected.has(asset.id))

  const toggle = (id: string): void => setSelected((previous) => {
    const next = new Set(previous)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  return <>
    <div className="detail-content">
      <section className="asset-metrics card">
        <div><small>{t('总占用', 'Total')}</small><strong>{formatBytes(generatedAssetBytes(snapshot.generatedAssets))}</strong></div>
        <div><small>ImageGen</small><strong>{snapshot.generatedAssets.filter((asset) => asset.kind === 'imageGen').length}</strong></div>
        <div><small>Visualization</small><strong>{snapshot.generatedAssets.filter((asset) => asset.kind === 'visualization').length}</strong></div>
      </section>

      <section className="filters">
        <select value={scope} onChange={(event) => setScope(event.target.value as Scope)}>
          <option value="all">{t('全部类型', 'All types')} {snapshot.generatedAssets.length}</option>
          <option value="imageGen">ImageGen {snapshot.generatedAssets.filter((asset) => asset.kind === 'imageGen').length}</option>
          <option value="visualization">Visualization {snapshot.generatedAssets.filter((asset) => asset.kind === 'visualization').length}</option>
        </select>
        <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} aria-label={t('排序方式', 'Sort by')}>
          <option value="size">{t('按占用大小', 'Size')}</option>
          <option value="date">{t('按最后修改', 'Last modified')}</option>
          <option value="source">{t('按来源会话', 'Source conversation')}</option>
        </select>
        <input className="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索来源会话或路径', 'Search source or path')} />
      </section>

      <div className="card asset-table">
        <div className="table-head asset-head">
          <input type="checkbox" aria-label={t('全选', 'Select all')} checked={allVisibleSelected}
            ref={(input) => { if (input) input.indeterminate = visible.some((asset) => selected.has(asset.id)) && !allVisibleSelected }}
            onChange={() => setSelected((previous) => {
              const next = new Set(previous)
              for (const asset of visible) allVisibleSelected ? next.delete(asset.id) : next.add(asset.id)
              return next
            })} />
          <span>{t('生成资产', 'Generated asset')}</span>
          <span>{t('类型', 'Type')}</span>
          <span className="col-num">{t('文件', 'Files')}</span>
          <span>{t('最后修改', 'Modified')}</span>
          <span className="col-num">{t('占用', 'Size')}</span>
          <span />
        </div>
        <ul className="asset-list">
          {visible.map((asset) => <AssetRow key={asset.id} asset={asset} session={asset.sourceSessionID ? sessionsByID.get(asset.sourceSessionID) : undefined}
            checked={selected.has(asset.id)} locale={locale} onToggle={() => toggle(asset.id)} />)}
        </ul>
        {!visible.length && <p className="empty-inline">{snapshot.generatedAssets.length
          ? t('没有符合筛选条件的生成资产', 'No generated assets match these filters')
          : t('没有扫描到本地生成资产', 'No local generated assets found')}</p>}
      </div>
    </div>

    {chosen.length > 0 && <div className="action-bar">
      <span>{t(`已选 ${chosen.length} 项生成资产`, `${chosen.length} generated assets selected`)} · {formatBytes(chosenBytes)}</span>
      <button className="btn danger" disabled={cleaning || actionsDisabled}
        onClick={() => onCleanup({ kind: 'generated-assets', ids: chosen.map((asset) => asset.id) })}>
        {cleaning
          ? t(`删除中… ${cleanProgress?.completed ?? 0}/${chosen.length}`, `Deleting… ${cleanProgress?.completed ?? 0}/${chosen.length}`)
          : t('删除', 'Delete')}
      </button>
    </div>}
  </>
}

function AssetRow({ asset, session, checked, locale, onToggle }: {
  asset: GeneratedAssetItem
  session?: SessionItem
  checked: boolean
  locale: string
  onToggle: () => void
}) {
  const { t } = usePreferences()
  return <li className="asset-row">
    <input type="checkbox" aria-label={generatedAssetDisplayName(asset, session)} checked={checked} onChange={onToggle} />
    <div className="asset-title">
      <span className="asset-name">{generatedAssetDisplayName(asset, session)}</span>
      <span className="asset-path" title={[asset.path, ...asset.companionPaths].join('\n')}>{asset.path}{asset.companionPaths.length
        ? t(` · 另含 ${asset.companionPaths.length} 个配套目录`, ` · ${asset.companionPaths.length} companion ${asset.companionPaths.length === 1 ? 'folder' : 'folders'}`)
        : ''}</span>
    </div>
    <span className="asset-type"><span className={`pill asset-kind-${asset.kind}`}>{assetKindLabel(asset.kind)}</span>
      <small>{asset.formats.length ? asset.formats.map((format) => format.toUpperCase()).join(' · ') : t('未知格式', 'Unknown')}</small></span>
    <span className="col-num">{asset.fileCount}</span>
    <span className="col-date" title={new Date(asset.modifiedAt).toLocaleString(locale)}>{formatShortDate(asset.modifiedAt, locale)}</span>
    <span className="col-num">{formatBytes(asset.bytes)}</span>
    <button className="icon-button" title={t('打开资产目录', 'Open asset folder')} aria-label={t('打开资产目录', 'Open asset folder')}
      onClick={() => void window.cleanmycodex.openPath(asset.path)}><FolderIcon /></button>
  </li>
}

function assetSession(asset: GeneratedAssetItem, sessionsByID: Map<string, SessionItem>): SessionItem | undefined {
  return asset.sourceSessionID ? sessionsByID.get(asset.sourceSessionID) : undefined
}

function assetKindLabel(kind: GeneratedAssetKind): string {
  if (kind === 'imageGen') return 'ImageGen'
  return 'Visualization'
}
