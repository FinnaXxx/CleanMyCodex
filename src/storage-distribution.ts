import {
  StorageSectionOrder,
  categoryBytes,
  categorySection,
  snapshotSessionBytes,
  workspaceBytes,
  type ScanSnapshot,
  type StorageSection
} from '../shared/types'

export type StorageDistributionKind = 'workspace' | 'sessions' | StorageSection | 'other'

export interface StorageDistributionItem {
  kind: StorageDistributionKind
  bytes: number
}

export interface StorageDistribution {
  items: StorageDistributionItem[]
  total: number
}

/** Mutually exclusive buckets for the overview chart. */
export function storageDistribution(snapshot: ScanSnapshot): StorageDistribution {
  const workspace = workspaceBytes(snapshot.workspace)
  const sessions = snapshotSessionBytes(snapshot)
  const sections: StorageDistributionItem[] = StorageSectionOrder.map((section) => ({
    kind: section,
    bytes: snapshot.categories
      .filter((category) => category.kind !== 'sessionDatabase' && categorySection(category) === section)
      .reduce((sum, category) => sum + categoryBytes(category), 0)
  }))
  const classifiedCodexBytes = sessions + sections.reduce((sum, item) => sum + item.bytes, 0)

  // Protected marketplace sources can live outside CODEX_HOME. Count them instead of
  // allowing their percentages to overflow the chart's managed-space denominator.
  const codexBytes = Math.max(snapshot.totalCodexBytes, classifiedCodexBytes)
  const other = Math.max(0, codexBytes - classifiedCodexBytes)
  const candidates: StorageDistributionItem[] = [
    { kind: 'workspace', bytes: workspace },
    { kind: 'sessions', bytes: sessions },
    ...sections,
    { kind: 'other', bytes: other }
  ]
  const items = candidates.filter((item) => item.bytes > 0)

  return { items, total: items.reduce((sum, item) => sum + item.bytes, 0) }
}
