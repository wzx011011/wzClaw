// Indexing + Git + Symbol IPC channels
export const INDEXING_CHANNELS = {
  // Semantic index (renderer → main)
  'index:status': 'index:status',
  'index:reindex': 'index:reindex',
  'index:search': 'index:search',
  // main → renderer push (indexing progress)
  'index:progress': 'index:progress',
  // Git (renderer → main)
  'git:status': 'git:status',
  // Symbol navigation (main ↔ renderer via webContents.send for push query)
  'symbol:query': 'symbol:query',
  'symbol:result': 'symbol:result',
} as const
