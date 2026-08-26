import { useMemo, useState } from 'react'
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
import { CleanupSelectionBar, DetailSummary, FunnelFilter, SelectAllCheckbox, SortHeader, useListSelection, useSortState, type SortDir } from '../components/list-controls'

interface Props {
  snapshot: ScanSnapshot
  cleaning: boolean
  actionsDisabled: boolean
  cleanProgress: CleanupProgress | null
  onCleanup: (selection: CleanupSelection) => void
}

type Scope = 'all' | GeneratedAssetKind
type SortKey = 'size' | 'date' | 'source'

const defaultSortDir = (key: SortKey): SortDir => (key === 'source' ? 'asc' : 'desc')
const assetID = (asset: GeneratedAssetItem): string => asset.id

export default function GeneratedAssetsView({ snapshot, cleaning, actionsDisabled, cleanProgress, onCleanup }: Props) {
  const { t, locale } = usePreferences()
  const selection = useListSelection({ items: snapshot.generatedAssets, getID: assetID })
  const [scope, setScope] = useState<Scope>('all')
  const { sortKey, sortDir, cycleSort } = useSortState<SortKey>('size', defaultSortDir)
  const [query, setQuery] = useState('')
  const sessionsByID = useMemo(() => new Map(snapshot.sessions.map((session) => [session.id, session])), [snapshot.sessions])

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const assets = snapshot.generatedAssets.filter((asset) => {
      if (scope !== 'all' && asset.kind !== scope) return false
      const session = asset.sourceSessionID ? sessionsByID.get(asset.sourceSessionID) : undefined
      if (!needle) return true
      return [asset.path, asset.title, asset.sourceThreadID, session ? sessionDisplayName(session) : null]
        .filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)
    })
    return assets.sort((a, b) => {
      let cmp: number
      if (sortKey === 'date') cmp = a.modifiedAt - b.modifiedAt
      else if (sortKey === 'source') cmp = generatedAssetDisplayName(a, assetSession(a, sessionsByID)).localeCompare(generatedAssetDisplayName(b, assetSession(b, sessionsByID)))
      else cmp = a.bytes - b.bytes
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [query, scope, sessionsByID, snapshot.generatedAssets, sortKey, sortDir])

  const chosen = selection.selectedItems
  const chosenBytes = generatedAssetBytes(chosen)
  const allVisibleSelected = selection.allSelected(visible)

  const scopeOptions = [
    { value: 'all' as const, label: t('全部类型', 'All types'), count: snapshot.generatedAssets.length },
    ...(['imageGen', 'visualization', 'plan'] as GeneratedAssetKind[]).map((kind) => ({
      value: kind, label: assetKindLabel(kind), count: snapshot.generatedAssets.filter((asset) => asset.kind === kind).length
    })),
  ]

  return <>
    <div className="detail-content">
      <DetailSummary items={[
        { label: t('总占用', 'Total'), value: formatBytes(generatedAssetBytes(snapshot.generatedAssets)) },
        ...scopeOptions.slice(1).map((option) => ({ label: option.label, value: option.count })),
      ]} />

      <section className="filters">
        <input className="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索来源会话或路径', 'Search source or path')} />
      </section>

      <div className="card asset-table">
        <div className="table-head asset-head">
          <SelectAllCheckbox ariaLabel={t('全选', 'Select all')} allSelected={allVisibleSelected}
            someSelected={selection.someSelected(visible)} onToggle={() => selection.toggleAll(visible)} />
          <span className="col-sortable">
            <SortHeader active={sortKey === 'source'} dir={sortDir} onClick={() => cycleSort('source')}>
              {t('会话资产', 'Session asset')}
            </SortHeader>
          </span>
          <span className="status-head">
            {t('类型', 'Type')}
            <FunnelFilter ariaLabel={t('筛选类型', 'Filter type')} active={scope !== 'all'}
              options={scopeOptions} value={scope} onChange={setScope} />
          </span>
          <span className="col-num">{t('文件', 'Files')}</span>
          <span className="col-date col-sortable">
            <SortHeader active={sortKey === 'date'} dir={sortDir} onClick={() => cycleSort('date')}>
              {t('最后修改', 'Modified')}
            </SortHeader>
          </span>
          <span className="col-num">
            <SortHeader align="end" active={sortKey === 'size'} dir={sortDir} onClick={() => cycleSort('size')}>
              {t('占用', 'Size')}
            </SortHeader>
          </span>
          <span />
        </div>
        <ul className="asset-list">
          {visible.map((asset) => <AssetRow key={asset.id} asset={asset} session={asset.sourceSessionID ? sessionsByID.get(asset.sourceSessionID) : undefined}
            checked={selection.isSelected(asset)} locale={locale} onToggle={() => selection.toggle(asset)} />)}
        </ul>
        {!visible.length && <p className="empty-inline">{snapshot.generatedAssets.length
          ? t('没有符合筛选条件的会话资产', 'No session assets match these filters')
          : t('没有扫描到本地会话资产', 'No local session assets found')}</p>}
      </div>
    </div>

    <CleanupSelectionBar count={chosen.length}
      summary={<>{t(`已选 ${chosen.length} 项会话资产`, `${chosen.length} session assets selected`)} · {formatBytes(chosenBytes)}</>}
      cleaning={cleaning} actionsDisabled={actionsDisabled} progress={cleanProgress}
      onDelete={() => onCleanup({ kind: 'generated-assets', ids: chosen.map(assetID) })} />
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
  if (kind === 'plan') return 'Plan'
  return 'Visualization'
}
