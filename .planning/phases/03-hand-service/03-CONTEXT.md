# Phase 3 Context: Hand Service — Independent npm Package

## Phase Goal
`wzxclaw-hand` 独立包，任何机器一行命令注册为 Brain 的 Hand。

## Dependencies
- **Phase 2 (agent-server)**: Hand protocol types, message format, HandsRouter registration expectations
- **@wzxclaw/brain**: IToolExecutor, IToolExecutionContext, IToolExecutionResult interfaces

## Protocol Contract (from agent-server server.ts handleHandConnection)

The Hand connects via WebSocket with `?type=hand` query parameter and token auth. The server expects:

### Hand → Server Messages
1. **hand:register** — Initial registration after connect
   ```json
   { "event": "hand:register", "data": { "id": "hand-unique-id", "capabilities": ["FileRead", "Bash"], "definitions": [{ "name": "FileRead", "description": "...", "inputSchema": {}, "isReadOnly": true }] } }
   ```
2. **hand:result** — Tool execution result
   ```json
   { "event": "hand:result", "data": { "callId": "uuid", "output": "result string", "isError": false } }
   ```
3. **hand:heartbeat** — Periodic keepalive
   ```json
   { "event": "hand:heartbeat" }
   ```

### Server → Hand Messages
1. **hand:execute** — Tool execution request (from HandAwareToolExecutor)
   ```json
   { "event": "hand:execute", "data": { "callId": "uuid", "name": "FileRead", "input": { "path": "/a.ts" }, "context": { "workingDirectory": "/project", "projectRoots": ["/project"] } } }
   ```
2. **hand:heartbeat_ack** — Heartbeat acknowledgment

### Connection Flow
1. Hand opens WebSocket to `ws://host:port/?type=hand` with token in `Sec-WebSocket-Protocol: wzxclaw-{token}` header or `?token=` query param
2. Server authenticates token
3. Server routes to handleHandConnection (type=hand)
4. Hand sends `hand:register` with its id, capabilities, definitions
5. Server registers in HandsRouter
6. Hand sends `hand:heartbeat` every ~15s, server responds `hand:heartbeat_ack`
7. Server sends `hand:execute` when Brain routes a tool call to this Hand
8. Hand executes tool locally, sends `hand:result`
9. On disconnect, server unregisters Hand and cleans pending calls

## Key Types (from agent-server and brain packages)

```typescript
// From hands-router.ts
interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  isReadOnly?: boolean
}

// From interfaces.ts (brain)
interface IToolExecutionContext {
  workingDirectory: string
  projectRoots: string[]
  abortSignal: AbortSignal
  workspaceId?: string
}

interface IToolExecutionResult {
  output: string
  isError: boolean
}

interface IToolExecutor {
  execute(name: string, input: Record<string, unknown>, context: IToolExecutionContext): Promise<IToolExecutionResult>
  getDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  isReadOnly(toolName: string): boolean
}
```

## Decisions

### D-01: Package name and location
- Package: `packages/hand/`
- npm name: `@wzxclaw/hand` (private package, not published)
- CLI command: `npx wzxclaw-hand` via `bin` field in package.json

### D-02: Configuration
- Config file: `~/.wzxclaw/hand.json` or env vars
- Required: server URL, auth token
- Optional: hand ID (auto-generated if not set), tool whitelist/blacklist
- Priority: CLI args > env vars > config file

### D-03: Tool framework
- Tools implement the same `Tool` interface pattern from desktop (name, description, inputSchema, execute)
- Hand-specific Tool interface simplified (no requiresApproval, no requiresSnapshot — those are Brain-side concerns)
- Hand loads tools from a built-in set, extensible via plugin directory `~/.wzxclaw/hand-tools/`

### D-04: Heartbeat interval
- Hand sends heartbeat every 15 seconds
- Server timeout is 30 seconds (from HandsRouter DEFAULT_HEARTBEAT_TIMEOUT)
- If heartbeat_ack not received within 5s, reconnect

### D-05: Error handling
- Tool execution errors caught and returned as `{ output: error.message, isError: true }`
- WebSocket disconnect triggers automatic reconnection with exponential backoff (1s, 2s, 4s, 8s, max 30s)
- Re-registration after reconnect

### D-06: Build and test conventions
- Follow exact same patterns as agent-server: tsc for build, vitest for test, ES2022/NodeNext module
- Chinese code comments
- Test file naming: `src/**/*.test.ts`, excluded from tsc

## Deferred Ideas
- Custom tool loading from npm packages (Phase 7+ concern)
- Tool result streaming/progress (future enhancement)
- Multiple Hand instances on same machine (not needed yet)

## Claude's Discretion
- Exact directory structure within `packages/hand/src/`
- Which built-in tools to include (start minimal: FileRead, Bash, Glob, Grep, FileWrite — the core 5)
- CLI argument parsing library (keep minimal: no library, parse process.argv directly or use a tiny parser)
- Reconnection strategy details (backoff algorithm specifics)
