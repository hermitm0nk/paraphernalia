# KOReader Custom Plugins

Backup of two custom Lua plugins from a Kindle running KOReader.

## Installation

1. Copy each `.koplugin` folder to the KOReader plugins directory on your device:
   ```
   scp -r localdashboard.koplugin root@<kindle-ip>:/mnt/us/koreader/plugins/
   scp -r vocabcloudsync.koplugin root@<kindle-ip>:/mnt/us/koreader/plugins/
   ```
2. Restart KOReader (or run `killall -USR1 koreader` to reload plugins without a full restart).

To uninstall, delete the `.koplugin` folder from `/mnt/us/koreader/plugins/` and restart KOReader.

## Plugins

### 1. localdashboard.koplugin

A standalone clock dashboard that displays the current time, date, weather, and battery status in a full-screen modal view.

**Features:**
- Large clock display (120pt font) with minute-by-minute auto-refresh
- Date display (e.g., "Monday, 27 June 2026")
- Weather information (city, temperature, description with icon)
- Battery percentage and charging status
- Auto-rotates to landscape mode when opened
- Restores previous rotation on dismiss
- Weather refreshes hourly via wttr.in (geolocated by IP via ip-api.com)
- Dismiss by tapping anywhere or pressing any key

**Weather icons:** ☀ (clear), ⛅ (partly cloudy), ☁ (cloudy), ⚡ (thunder), ☂ (rain), ❄ (snow), ≡ (fog)

**Dependencies:** Uses KOReader's built-in `socket.http`, `json`, and UI widgets. No external setup required.

---

### 2. vocabcloudsync.koplugin

Automatically syncs KOReader's Vocabulary Builder SQLite database (`vocabulary_builder.sqlite3`) to a cloud server (WebDAV or Dropbox). Runs silently in the background with no success notifications — only error toasts for configuration problems.

**Sync triggers:**
| Trigger | Default | Description |
|---|---|---|
| Periodic | Every 15 min | Background timer while device is awake |
| On suspend | ✅ | Syncs just before Wi-Fi is torn down on sleep |
| On power off | ✅ | Syncs before device powers off (Kobo/Cervantes) |
| On resume | ❌ | Optional sync after waking up |
| On Wi-Fi up | ✅ | Syncs 3 seconds after network connection is established |
| Manual | — | "Sync now" from Tools menu |

**Sync flow:**
1. Check if enabled and online (skips silently when offline)
2. Resolve cloud server (manual override → vocabbuilder's server → cloudstorage index)
3. Checkpoint WAL into main DB file
4. Call `SyncService.sync()` with `DB.onSync` merge callback
5. Suppress success toast (background runs are silent)

**Settings** (stored in `vocabcloudsync.lua`):
- `enabled` — master switch
- `interval_index` — which interval to use (index into 5min/15min/30min/1h/2h/6h)
- `server_index` — which cloud server from `cloudstorage.lua` to use
- `server_override` / `server_type` — manual server selection
- `sync_on_suspend`, `sync_on_poweroff`, `sync_on_resume`, `sync_on_wifi_up` — trigger toggles

**Menu location:** Tools → Vocabulary cloud auto-sync (Status / Sync now / Settings)

**Design notes:**
- Wraps `UIManager.event_handlers.Suspend/Resume/PowerOff` directly instead of using broadcast events, because the broadcast path runs after `NetworkListener:onSuspend` disables Wi-Fi
- Reuses KOReader's `SyncService.sync()` for the actual WebDAV round-trip and merge logic
- Runs WAL checkpoint before sync to flush pending writes from the Vocabulary Builder UI
- Falls back to no-op if vocabbuilder plugin is disabled
