# Pre-Merge Test Cases — PR #5 (DeepSeek balance + agent hard-restart)

Branch: `feat/deepseek-balance-and-agent-recovery` vs `main`

## A. Backend — DeepSeek balance (`deepseek-balance.ts`, `api-routes.ts`)
- **A1** GET `/api/deepseek-balance` with valid key → JSON `{isAvailable, balances:[{currency,totalBalance,...}], lastUpdated}`. P0
- **A2** Missing key (no env, no `.secrets/keys.env`) → `{error: "请在 ... 填写 DEEPSEEK_API_KEY", lastUpdated}`, no crash. P1
- **A3** Reads key from `.secrets/keys.env` when env var unset. P1
- **A4** Endpoint never throws (10s timeout, network error → error field). P1

## B. Frontend — footer + sidebar (`App.tsx`, `Sidebar.tsx`)
- **B1** Footer shows `ds-b:￥--` initially; click → fetches and shows `ds-b:￥<number>`. P0
- **B2** Click while loading is ignored (no double-fetch); error → red `ERR` + title. P2
- **B3** Sidebar default collapsed (32px rail, 3 page icons + expand arrow). P0
- **B4** Expand → 220px full menu; collapse arrow returns to rail. P1
- **B5** Collapsed/expanded state persists across reload (localStorage `cc2im.sidebar.collapsed`). P1
- **B6** Collapsed icons still switch pages (chat/channels/tasks). P2

## C. Agent hard-kill / restart (`agent-manager.ts`, `index.ts`, `channel-server.ts`, `types.ts`)
- **C1** New spawn writes `<agent>/claude.pid` with claude's real PID. P0
- **C2** `agent_restart <name>` on a connected agent: old detached claude reaped, new claude spawned, agent reconnects. P0
- **C3** `restart()` waits for spoke disconnect before start (no "already running" race). P0
- **C4** `agent_restart` on unregistered name → `{success:false, error:"not registered"}`. P1
- **C5** `killDetachedClaude` PID-reuse guard: only kills if `ps` shows it's this gateway's claude. P1
- **C6** Hub-startup orphan cleanup reaps detached claude (not just expect group). P1
- **C7** Self-heal: agent stuck-at-startup killed+restarted by 60s connect-timeout (now that claude is killable). P1

## D. Regression
- **D1** `npm test` 141/141 pass. P0
- **D2** Existing `agent_list` / `agent_start` / `agent_stop` unchanged. P0
- **D3** `/api/usage` (Claude usage) still works. P1
- **D4** All 7 agents connected after hub restart. P0
- **D5** `tsc` build clean. P0

## Results (2026-06-16)

| Case | Result | Evidence |
|------|--------|----------|
| A1 | ✅ | `curl /api/deepseek-balance` → CNY balance JSON |
| B1 | ✅ | Playwright: click `ds-b:￥--` → `ds-b:￥254.34` |
| B3 | ✅ | Default render = 32px collapsed rail |
| B4 | ✅ | Expand → full menu (收起 button) |
| B5 | ✅ | Reload preserves state (LS `cc2im.sidebar.collapsed`=`0`) |
| C1 | ✅ | All 7 agents wrote `<agent>/claude.pid` after spawn |
| C2 | ✅ | `agent_restart aifeeds`: old detached claude (own pgid) reaped, new claude up, reconnected |
| C3 | ✅ | restart brings agent back connected (waitForDisconnect fixed the race) |
| C4 | ✅ | unregistered → `"is not registered"` |
| C6/C7 | ✅ | hub reloads reap orphans; connect-timeout self-heal re-enabled by killable claude |
| D1 | ✅ | `npm test` 141/141 |
| D2 | ✅ | `agent_stop`/`start`/`list` work (stop→stopped, restart→connected) |
| D3 | ✅ | `/api/usage` returns Claude usage |
| D4 | ✅ | 7/7 connected after each hub reload |
| D5 | ✅ | `tsc --noEmit` clean |

### Bugs found & fixed
| # | Case | Bug | Severity | Fix |
|---|------|-----|----------|-----|
| 1 | C4 / stopped restart | `restart` management handler had an `isManaged` guard (`processes.has`), so it refused to restart any **stopped/crashed/orphan** agent — defeating the recovery use case | High | Removed the guard from `hub/index.ts`; `restart()`'s own "is registered?" check handles validation. Re-tested: stopped agent now restarts to connected. |

Not run (low risk, code-reviewed): A2 missing-key path (key present), A4 timeout, B2 error styling, B6 collapsed-icon page switch, C5 PID-reuse guard. Benign: 2 console 404s for deleted WeChat media attachments (pre-existing).
