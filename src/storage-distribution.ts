import {
  StorageSectionOrder,
  categoryBytes,
  categorySection,
  snapshotGeneratedAssetBytes,
  snapshotSessionBytes,
  snapshotWorktreeBytes,
  workspaceBytes,
  type ScanSnapshot,
  type StorageSection
} from '../shared/types'

export type StorageDistributionKind = 'workspace' | 'sessions' | 'generatedAssets' | 'worktrees' | StorageSection | 'other'

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
  const generatedAssets = snapshotGeneratedAssetBytes(snapshot)
  const worktrees = snapshotWorktreeBytes(snapshot)
  const sections: StorageDistributionItem[] = StorageSectionOrder.map((section) => ({
    kind: section,
    bytes: snapshot.categories
      // Session databases already belong to the session total. Their category is a
      // detail affordance, not additional physical storage.
      .filter((category) => category.kind !== 'sessionDatabase' && categorySection(category) === section)
      .reduce((sum, category) => sum + categoryBytes(category), 0)
  }))
  const classifiedCodexBytes = sessions + generatedAssets + worktrees + sections.reduce((sum, item) => sum + item.bytes, 0)

  // Protected marketplace sources can live outside CODEX_HOME. Count them instead of
  // allowing their percentages to overflow the chart's managed-space denominator.
  const codexBytes = Math.max(snapshot.totalCodexBytes, classifiedCodexBytes)
  const other = Math.max(0, codexBytes - classifiedCodexBytes)
  const candidates: StorageDistributionItem[] = [
    { kind: 'workspace', bytes: workspace },
    { kind: 'sessions', bytes: sessions },
    { kind: 'generatedAssets', bytes: generatedAssets },
    { kind: 'worktrees', bytes: worktrees },
    ...sections,
    { kind: 'other', bytes: other }
  ]
  const items = candidates.filter((item) => item.bytes > 0).sort((a, b) => b.bytes - a.bytes)

  return { items, total: items.reduce((sum, item) => sum + item.bytes, 0) }
}
