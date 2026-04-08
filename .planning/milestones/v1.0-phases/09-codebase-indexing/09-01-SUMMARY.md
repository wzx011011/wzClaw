---
phase: 09-codebase-indexing
plan: 01
subsystem: indexing
tags: [code-chunking, tfidf, embeddings, vector-store, cosine-similarity, jsonl]

# Dependency graph
requires:
  - phase: 08-advanced-features
    provides: "Tool registry pattern, workspace manager with SKIP_DIRS, settings manager FullConfig"
provides:
  - "CodeChunker for splitting source files at code boundaries into <=512 token chunks"
  - "VectorStore for persisting embeddings as JSONL with cosine similarity search"
  - "EmbeddingClient with OpenAI-compatible API support and TF-IDF fallback"
  - "IndexingEngine for full/incremental workspace indexing orchestration"
affects: [09-codebase-indexing, semantic-search-tool, status-bar]

# Tech tracking
tech-stack:
  added: []
  patterns: [jsonl-storage, tfidf-fallback, incremental-mtime-indexing, batch-embedding]

key-files:
  created:
    - src/main/indexing/code-chunker.ts
    - src/main/indexing/vector-store.ts
    - src/main/indexing/embedding-client.ts
    - src/main/indexing/indexing-engine.ts
    - src/main/indexing/__tests__/code-chunker.test.ts
    - src/main/indexing/__tests__/vector-store.test.ts
    - src/main/indexing/__tests__/embedding-client.test.ts
    - src/main/indexing/__tests__/indexing-engine.test.ts
  modified: []

key-decisions:
  - "D-IDX-01: Use sha256 instead of md5 for entry ID hashing (md5 not available in all Node.js environments)"
  - "D-IDX-02: Skip all hidden directories (including .wzxclaw) during workspace walk to avoid indexing metadata files"
  - "D-IDX-03: Use native fetch with AbortController for embedding API calls instead of openai SDK (avoids import overhead)"
  - "D-IDX-04: Mock fetch in tests instead of hitting real API (eliminates 10s timeout failures)"
  - "D-IDX-05: VectorStore cache updated in-place after upsert/deleteByFile (avoids stale cache issue for synchronous search)"

patterns-established:
  - "JSONL storage pattern: one JSON object per line in .wzxclaw/index/vectors.jsonl"
  - "TF-IDF vocabulary persistence: tfidf-vocab.json stores terms, IDF values, and doc count"
  - "Incremental indexing: compare file mtime with stored mtime in IndexEntry, skip unchanged files"
  - "Batch embedding: collect up to 50 chunks, embed as single batch, then store entries"

requirements-completed: [IDX-01, IDX-02, IDX-03, IDX-04, IDX-08]

# Metrics
duration: 24min
completed: 2026-04-08
---

# Phase 9 Plan 1: Core Indexing Pipeline Summary

**Code chunking at function/class boundaries, JSONL vector storage with cosine similarity, embedding API with TF-IDF fallback, and incremental workspace indexing engine**

## Performance

- **Duration:** 24 min
- **Started:** 2026-04-08T09:55:00Z
- **Completed:** 2026-04-08T10:18:55Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- CodeChunker splits TypeScript, JavaScript, Python files at function/class/interface/export/type boundaries with 512-token max per chunk
- VectorStore persists embeddings to .wzxclaw/index/vectors.jsonl with cosine similarity search, upsert, deleteByFile
- EmbeddingClient calls OpenAI-compatible embedding API with 10s timeout, falls back to local TF-IDF with vocabulary persistence
- IndexingEngine orchestrates full workspace indexing with incremental mtime-based updates and batch embedding

## Task Commits

Each task was committed atomically:

1. **Task 1: Create CodeChunker and VectorStore** - `91a385b` (feat)
2. **Task 2: Create EmbeddingClient and IndexingEngine** - `24a9b0e` (feat)

## Files Created/Modified
- `src/main/indexing/code-chunker.ts` - Splits source files at code boundaries into chunks <=512 tokens
- `src/main/indexing/vector-store.ts` - JSONL-based vector storage with cosine similarity search
- `src/main/indexing/embedding-client.ts` - Embedding API client with TF-IDF fallback
- `src/main/indexing/indexing-engine.ts` - Full/incremental indexing orchestration
- `src/main/indexing/__tests__/code-chunker.test.ts` - 12 tests for chunking logic
- `src/main/indexing/__tests__/vector-store.test.ts` - 19 tests for vector storage
- `src/main/indexing/__tests__/embedding-client.test.ts` - 10 tests for embedding client
- `src/main/indexing/__tests__/indexing-engine.test.ts` - 14 tests for indexing engine

## Decisions Made
- Used sha256 instead of md5 for entry ID hashing -- md5 threw "Digest method not supported" in test environment
- Skipped all hidden directories (including .wzxclaw) during workspace walk to prevent indexing metadata
- Used native fetch with AbortController for API calls instead of openai SDK to avoid import overhead
- VectorStore cache updated in-place after mutations to avoid stale cache for synchronous search()

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed createHash duplicate and wrong algorithm in IndexingEngine**
- **Found during:** Task 2 (IndexingEngine implementation)
- **Issue:** Used `import { createHash } from 'crypto'` and called `createHash(id)` which creates a hash object, not a hash string. Also md5 algorithm threw "Digest method not supported" in test environment. Duplicate import at file end after initial import.
- **Fix:** Changed to `import { createHash as cryptoCreateHash } from 'node:crypto'`, created helper function `hashId()` using sha256 algorithm, fixed all call sites
- **Files modified:** src/main/indexing/indexing-engine.ts, src/main/indexing/vector-store.ts
- **Verification:** All 55 tests pass after fix

**2. [Rule 1 - Bug] Fixed VectorStore search returning empty due to stale cache**
- **Found during:** Task 1 (VectorStore tests)
- **Issue:** `upsert` and `deleteByFile` set `this.cache = null`, but `search()` is synchronous and checked `this.cache` which was null. Tests that called `await upsert()` then `search()` got 0 results.
- **Fix:** Changed `upsert` and `deleteByFile` to update `this.cache` with final state instead of nullifying it
- **Files modified:** src/main/indexing/vector-store.ts
- **Verification:** search tests now return expected results

**3. [Rule 2 - Missing Critical] Added AbortController timeout to embedding API fetch**
- **Found during:** Task 2 (EmbeddingClient API test)
- **Issue:** fetch to OpenAI API with invalid key hung for 10+ seconds, exceeding the 5s test timeout
- **Fix:** Added AbortController with 10s timeout around fetch, moved response handling into try/finally block
- **Files modified:** src/main/indexing/embedding-client.ts
- **Verification:** API fallback test now completes instantly via mocked fetch rejection

**4. [Rule 3 - Blocking] Fixed fs.utimesSync EINVAL on Windows**
- **Found during:** Task 2 (re-indexes modified files test)
- **Issue:** `fs.utimesSync(path, Date.now(), Date.now())` threw EINVAL because it requires seconds, not milliseconds
- **Fix:** Changed to `fs.utimesSync(path, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000))`
- **Files modified:** src/main/indexing/__tests__/indexing-engine.test.ts
- **Verification:** Re-index test passes on Windows

---

**Total deviations:** 4 auto-fixed (2 bugs, 1 missing critical, 1 blocking)
**Impact on plan:** All auto-fixes necessary for correctness and cross-platform compatibility. No scope creep.

## Issues Encountered
- Node.js crypto md5 algorithm not available in vitest test environment -- switched to sha256
- Windows fs.utimesSync requires seconds not milliseconds -- adjusted test code
- VectorStore cache invalidation strategy needed refinement for synchronous search

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Core indexing pipeline complete and tested
- Ready for Plan 02: SemanticSearch tool integration with agent loop
- EmbeddingClient needs real API key configuration for production use (currently uses TF-IDF fallback)

---
*Phase: 09-codebase-indexing*
*Completed: 2026-04-08*
