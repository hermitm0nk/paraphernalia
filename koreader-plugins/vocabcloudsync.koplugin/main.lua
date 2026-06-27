--[[--
vocabcloudsync.koplugin

Automatically syncs KOReader's Vocabulary Builder SQLite database to a cloud
storage server (WebDAV or Dropbox) that the user has already configured in
KOReader's cloud storage settings (or in the Vocabulary Builder's own "Cloud
sync" feature). Sync happens:

  * periodically in the background,
  * on device suspend / resume / power-off (best-effort, while Wi-Fi is still up),
  * and once after Wi-Fi comes up.

The plugin is fully silent in all background paths: no success notification,
no error popup. A one-time WebDAV failure (network blip, server 5xx) is
treated as transient and the next tick will retry. A manual "Sync now" from
the main menu shows a brief toast *only* on real configuration errors
(missing cloud server, disabled vocabbuilder plugin) so the user can fix
them; it does not announce success.

Design notes:

  * We *wrap* UIManager.event_handlers.Suspend / Resume / PowerOff rather than
    chain via broadcastEvent listeners, because the broadcast path runs AFTER
    NetworkListener:onSuspend has already disabled Wi-Fi on Kindle.

  * We reuse KOReader's own SyncService.sync() for the actual WebDAV round-trip
    and merge logic. The merge callback (DB.onSync) lives in the
    vocabbuilder.koplugin module; we lazy-require it and fall back to a no-op
    if the plugin is disabled.

  * We run a WAL checkpoint before sync so any pending writes made by the
    Vocabulary Builder UI are merged into the main file before SyncService
    copies it to the cloud.
--]]

local DataStorage = require("datastorage")
local LuaSettings  = require("luasettings")
local NetworkMgr   = require("ui/network/manager")
local SQ3          = require("lua-ljsqlite3/init")
local SyncService  = require("frontend/apps/cloudstorage/syncservice")
local UIManager    = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local ffiUtil      = require("ffi/util")
local lfs          = require("libs/libkoreader-lfs")
local logger       = require("logger")
local T            = ffiUtil.template
local _            = require("gettext")

-- ---------------------------------------------------------------------------
-- Constants
-- ---------------------------------------------------------------------------

local PLUGIN_NAME          = "vocabcloudsync"
local SETTINGS_PATH        = DataStorage:getSettingsDir() .. "/" .. PLUGIN_NAME .. ".lua"
local CLOUD_SETTINGS_PATH  = DataStorage:getSettingsDir() .. "/cloudstorage.lua"
local DB_PATH              = DataStorage:getSettingsDir() .. "/vocabulary_builder.sqlite3"
local DB_SYNC_CACHE        = DB_PATH .. ".sync"

-- Tunables --------------------------------------------------------------------
local INTERVAL_CHOICES = {
    { text = _("5 minutes"),  value = 5 * 60 },
    { text = _("15 minutes"), value = 15 * 60 },
    { text = _("30 minutes"), value = 30 * 60 },
    { text = _("1 hour"),     value = 60 * 60 },
    { text = _("2 hours"),    value = 2 * 60 * 60 },
    { text = _("6 hours"),    value = 6 * 60 * 60 },
}
local DEFAULT_INTERVAL_INDEX = 2  -- 15 minutes

local DEFAULTS = {
    enabled             = true,
    sync_on_suspend     = true,
    sync_on_poweroff    = true,
    sync_on_resume      = false,  -- can be noisy when reopening a book
    sync_on_wifi_up     = true,
    interval_index      = DEFAULT_INTERVAL_INDEX,
    server_index        = 1,  -- index into cs_servers from cloudstorage.lua (1-based, see _getServer)
    last_success_time   = nil,  -- epoch of last successful sync
    last_attempt_time   = nil,  -- epoch of last sync attempt (success or fail)
    last_attempt_ok     = nil,  -- true/false/nil: result of last attempt
}

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------

local function fileExists(path)
    return lfs.attributes(path, "mode") == "file"
end

local function deepCopy(t)
    if type(t) ~= "table" then return t end
    local out = {}
    for k, v in pairs(t) do out[k] = deepCopy(v) end
    return out
end

-- Run `body` with UIManager.show temporarily patched to swallow the
-- "Successfully synchronized." toast that SyncService.show shows on every
-- successful round-trip. We only suppress that one specific translated
-- string, so any other toast the user might see is unaffected.
local function withSilencedSyncPopups(body)
    local success_text = _("Successfully synchronized.")
    local orig_show = UIManager.show
    UIManager.show = function(self_, w, ...)
        if w and type(w) == "table" and w.text == success_text then
            return
        end
        return orig_show(self_, w, ...)
    end
    local ok, err = pcall(body)
    UIManager.show = orig_show
    if not ok then error(err) end
end

-- Force-flush the WAL into the main database file. Best-effort: if the
-- vocabbuilder UI is holding a lock, we silently skip.
local function checkpointVocabDB()
    if not fileExists(DB_PATH) then return end
    local ok, conn = pcall(SQ3.open, DB_PATH)
    if not ok or not conn then return end
    pcall(function() conn:exec("PRAGMA wal_checkpoint(TRUNCATE);") end)
    pcall(function() conn:close() end)
end

-- ---------------------------------------------------------------------------
-- Vocabbuilder DB.onSync lazy resolver
-- ---------------------------------------------------------------------------

local cached_onSync = nil
local function getDBSyncCallback()
    if cached_onSync ~= nil then return cached_onSync end  -- may be `false`
    local ok, DB = pcall(require, "db")
    if ok and type(DB) == "table" and type(DB.onSync) == "function" then
        cached_onSync = DB.onSync
    else
        logger.warn("vocabcloudsync: cannot load vocabbuilder's DB.onSync, sync will be a no-op")
        cached_onSync = false
    end
    return cached_onSync or false
end

-- ---------------------------------------------------------------------------
-- Server resolution
-- ---------------------------------------------------------------------------

-- Read the cloud storage server list. Returns a list of (displayable) servers.
local function readCloudServers()
    if not fileExists(CLOUD_SETTINGS_PATH) then return {} end
    local s = LuaSettings:open(CLOUD_SETTINGS_PATH)
    return s:readSetting("cs_servers") or {}
end

-- Resolve the server the user wants us to use. Order of preference:
--   1. settings.server (manual override stored in our own settings file)
--   2. vocabulary_builder.server (whatever the user already selected in the
--      built-in Vocabulary Builder "Cloud sync" feature, if any)
--   3. cloudstorage.lua cs_servers[ settings.server_index ] (1-based)
local function resolveServer(self)
    local servers = readCloudServers()
    if #servers == 0 then return nil end

    -- 1. Manual override (deep-copied so we can persist)
    if self._settings.server_override then
        for _, srv in ipairs(servers) do
            if srv.name == self._settings.server_override
               and srv.type == self._settings.server_type then
                return deepCopy(srv)
            end
        end
    end

    -- 2. Vocabbuilder's existing choice
    local vb_settings = G_reader_settings:readSetting("vocabulary_builder", {})
    if vb_settings and vb_settings.server and vb_settings.server.name then
        for _, srv in ipairs(servers) do
            if srv.name == vb_settings.server.name
               and srv.type == vb_settings.server.type then
                return deepCopy(srv)
            end
        end
    end

    -- 3. Index-based pick (prefer first webdav)
    local idx = self._settings.server_index or 1
    if idx < 1 or idx > #servers then idx = 1 end
    return deepCopy(servers[idx])
end

-- ---------------------------------------------------------------------------
-- Main plugin
-- ---------------------------------------------------------------------------

local VocabularyCloudSync = WidgetContainer:extend{
    name = "vocabcloudsync",
    is_doc_only = false,
}

function VocabularyCloudSync:_loadSettings()
    self._settings = LuaSettings:open(SETTINGS_PATH)
    local stored = self._settings:readSetting(PLUGIN_NAME) or {}
    for k, v in pairs(DEFAULTS) do
        if stored[k] == nil then stored[k] = v end
    end
    -- Migration: drop keys that no longer exist (e.g. notify_on_success was
    -- removed when the plugin became fully silent on background success).
    local dirty = false
    for k in pairs(stored) do
        if DEFAULTS[k] == nil then
            stored[k] = nil
            dirty = true
        end
    end
    if dirty then
        self._settings:saveSetting(PLUGIN_NAME, stored)
        self._settings:flush()
    end
    self._settings = stored
end

function VocabularyCloudSync:_saveSettings()
    local s = LuaSettings:open(SETTINGS_PATH)
    s:saveSetting(PLUGIN_NAME, self._settings)
    s:flush()
end

-- The actual sync routine.
--   opts.force  - bypass the `enabled` setting (used by "Sync now")
--   opts.manual - show a brief toast on configuration errors (no server,
--                 vocabbuilder plugin disabled). WebDAV transient failures
--                 and successful syncs are always silent.
-- In all cases the sync itself never shows the "Successfully synchronized"
-- notification -- we suppress it via withSilencedSyncPopups because the
-- caller has no business notifying the user on every periodic tick.
function VocabularyCloudSync:_doSync(opts)
    opts = opts or {}
    local force    = opts.force
    local is_manual = opts.manual

    if not force and not self._settings.enabled then return end
    if not fileExists(DB_PATH) then
        logger.dbg("vocabcloudsync: vocab DB missing, skipping")
        return
    end

    -- Offline is not an error -- just skip. isOnline (vs isConnected) also
    -- covers the connected-but-no-WAN case, and we never trigger any
    -- beforeWifiAction prompt from SyncService that way.
    if not NetworkMgr:isOnline() then
        logger.dbg("vocabcloudsync: offline, skipping sync")
        return
    end

    local server = resolveServer(self)
    if not server then
        logger.warn("vocabcloudsync: no cloud server configured, skipping")
        if is_manual then
            self:_toast(_("No cloud server configured. Add one in Tools → Cloud storage."))
        end
        return
    end

    local onSync = getDBSyncCallback()
    if not onSync then
        logger.warn("vocabcloudsync: cannot load vocabbuilder's DB.onSync, skipping")
        if is_manual then
            self:_toast(_("Vocabulary Builder plugin is disabled; cannot sync."))
        end
        return
    end

    -- Flush WAL so SyncService copies the most recent state.
    checkpointVocabDB()

    -- Record attempt time
    self._settings.last_attempt_time = os.time()

    -- is_silent=true suppresses SyncService's built-in error popup, and
    -- withSilencedSyncPopups additionally suppresses the unconditional
    -- "Successfully synchronized." notification that SyncService shows on
    -- a successful round-trip.
    local ok, err = pcall(function()
        withSilencedSyncPopups(function()
            SyncService.sync(server, DB_PATH, onSync, true)
        end)
    end)

    -- Record outcome
    self._settings.last_attempt_ok = ok
    if ok then
        self._settings.last_success_time = os.time()
    end
    self:_saveSettings()
end

function VocabularyCloudSync:_toast(text)
    local Notification = require("ui/widget/notification")
    UIManager:show(Notification:new{ text = text, timeout = 3 })
end

-- ---------------------------------------------------------------------------
-- Periodic timer
-- ---------------------------------------------------------------------------

function VocabularyCloudSync:_scheduleNext()
    self:_unschedule()
    if not self._settings.enabled then return end
    local idx = self._settings.interval_index or DEFAULT_INTERVAL_INDEX
    local seconds = INTERVAL_CHOICES[idx] and INTERVAL_CHOICES[idx].value
                    or INTERVAL_CHOICES[DEFAULT_INTERVAL_INDEX].value
    self._timer_fn = function()
        self:_doSync()
        self:_scheduleNext()
    end
    UIManager:scheduleIn(seconds, self._timer_fn)
    logger.dbg("vocabcloudsync: next periodic sync in", seconds, "seconds")
end

function VocabularyCloudSync:_unschedule()
    if self._timer_fn then
        UIManager:unschedule(self._timer_fn)
        self._timer_fn = nil
    end
end

-- ---------------------------------------------------------------------------
-- Wrapping global event handlers
-- ---------------------------------------------------------------------------

-- Install a wrapper around `handler_name` on UIManager. Returns true on
-- success, false if the handler isn't a function. Idempotent: re-installing
-- replaces the previous wrapper.
function VocabularyCloudSync:_wrapHandler(handler_name, before_fn, after_fn)
    local prev = UIManager.event_handlers[handler_name]
    if type(prev) ~= "function" then return false end
    if self._wrapped[handler_name] then return true end
    self._wrapped[handler_name] = prev
    UIManager.event_handlers[handler_name] = function(...)
        if before_fn then before_fn() end
        local ret = prev(...)
        if after_fn then after_fn() end
        return ret
    end
    return true
end

function VocabularyCloudSync:_unwrapAll()
    for name, prev in pairs(self._wrapped or {}) do
        UIManager.event_handlers[name] = prev
    end
    self._wrapped = {}
end

function VocabularyCloudSync:_installWrappers()
    self._wrapped = self._wrapped or {}

    -- Suspend: sync BEFORE the Kindle powerd tears down Wi-Fi. This is the
    -- critical path: doing the sync via a broadcastEvent listener would be
    -- too late, because NetworkListener:onSuspend (also a broadcastEvent
    -- listener) runs first and disables Wi-Fi.
    self:_wrapHandler("Suspend", function()
        if self._settings.sync_on_suspend then
            local ok, err = pcall(function() self:_doSync() end)
            if not ok then logger.warn("vocabcloudsync: suspend sync error:", err) end
        end
    end, function()
        -- after_fn: reschedule the periodic timer once we come back up.
        self:_scheduleNext()
    end)

    -- Resume: optionally sync on wake, then reschedule the timer.
    self:_wrapHandler("Resume", nil, function()
        if self._settings.sync_on_resume then
            local ok, err = pcall(function() self:_doSync() end)
            if not ok then logger.warn("vocabcloudsync: resume sync error:", err) end
        end
        self:_scheduleNext()
    end)

    -- PowerOff: present on Kobo/Cervantes etc. May be nil on Kindle, in which
    -- case this wrap is a no-op (the hardware button bypasses KOReader anyway,
    -- and the Suspend path is hit first on Kindle).
    self:_wrapHandler("PowerOff", function()
        if self._settings.sync_on_poweroff then
            local ok, err = pcall(function() self:_doSync() end)
            if not ok then logger.warn("vocabcloudsync: poweroff sync error:", err) end
        end
    end)

    -- Reboot: same as PowerOff.
    self:_wrapHandler("Reboot", function()
        if self._settings.sync_on_poweroff then
            local ok, err = pcall(function() self:_doSync() end)
            if not ok then logger.warn("vocabcloudsync: reboot sync error:", err) end
        end
    end)
end

-- ---------------------------------------------------------------------------
-- UI: main menu and settings
-- ---------------------------------------------------------------------------

function VocabularyCloudSync:_info()
    local server = resolveServer(self)
    local server_name = server and (server.name .. " (" .. server.type .. ")") or _("(none)")
    local idx = self._settings.interval_index or DEFAULT_INTERVAL_INDEX
    local interval_text = INTERVAL_CHOICES[idx] and INTERVAL_CHOICES[idx].text
                          or INTERVAL_CHOICES[DEFAULT_INTERVAL_INDEX].text

    -- Format sync status
    local function formatTime(epoch)
        if not epoch or epoch == 0 then return _("never") end
        return os.date("%Y-%m-%d %H:%M:%S", epoch)
    end

    local last_success = formatTime(self._settings.last_success_time)
    local last_attempt = formatTime(self._settings.last_attempt_time)
    local last_state
    if self._settings.last_attempt_ok == nil then
        last_state = _("—")
    elseif self._settings.last_attempt_ok then
        last_state = _("success")
    else
        last_state = _("failed")
    end

    local lines = {
        T(_("Cloud server: %1"), server_name),
        T(_("Periodic interval: %1"), interval_text),
        T(_("Sync on suspend: %1"), self._settings.sync_on_suspend and _("yes") or _("no")),
        T(_("Sync on power off: %1"), self._settings.sync_on_poweroff and _("yes") or _("no")),
        T(_("Sync on resume: %1"), self._settings.sync_on_resume and _("yes") or _("no")),
        T(_("Sync on Wi-Fi up: %1"), self._settings.sync_on_wifi_up and _("yes") or _("no")),
        "",
        T(_("Last success: %1"), last_success),
        T(_("Last attempt: %1 (%2)"), last_attempt, last_state),
        "",
        T(_("DB path: %1"), DB_PATH),
        T(_("Online now: %1"), NetworkMgr:isOnline() and _("yes") or _("no")),
    }
    return table.concat(lines, "\n")
end

function VocabularyCloudSync:_addToggleMenu(menu_items, key, label, help)
    menu_items[PLUGIN_NAME .. "_" .. key] = {
        text = label,
        help_text = help,
        checked_func = function() return self._settings[key] end,
        callback = function()
            self._settings[key] = not self._settings[key]
            self:_saveSettings()
            if key == "enabled" then
                if self._settings.enabled then
                    self:_scheduleNext()
                else
                    self:_unschedule()
                end
            end
        end,
    }
end

function VocabularyCloudSync:_addIntervalMenu(menu_items)
    local idx = self._settings.interval_index or DEFAULT_INTERVAL_INDEX
    local submenu = {}
    for i, choice in ipairs(INTERVAL_CHOICES) do
        submenu[#submenu + 1] = {
            text = choice.text,
            checked_func = function() return i == (self._settings.interval_index or DEFAULT_INTERVAL_INDEX) end,
            callback = function()
                self._settings.interval_index = i
                self:_saveSettings()
                self:_scheduleNext()
            end,
        }
    end
    menu_items[PLUGIN_NAME .. "_interval"] = {
        text = _("Periodic interval"),
        sub_item_table = submenu,
        help_text = _("How often to sync in the background while the device is awake."),
        checked_func = function()
            return INTERVAL_CHOICES[self._settings.interval_index or DEFAULT_INTERVAL_INDEX].text
        end,
    }
end

function VocabularyCloudSync:_addServerMenu(menu_items)
    local servers = readCloudServers()
    if #servers == 0 then
        menu_items[PLUGIN_NAME .. "_server"] = {
            text = _("Cloud server (none configured)"),
            enabled = false,
            help_text = _("Add a server in Tools → Cloud storage first."),
        }
        return
    end
    local submenu = {}
    for i, srv in ipairs(servers) do
        submenu[#submenu + 1] = {
            text = T(_("%1 (%2)"), srv.name, srv.type),
            checked_func = function() return i == (self._settings.server_index or 1) end,
            callback = function()
                self._settings.server_index = i
                self._settings.server_override = nil
                self._settings.server_type = nil
                self:_saveSettings()
            end,
        }
    end
    menu_items[PLUGIN_NAME .. "_server"] = {
        text = _("Cloud server"),
        sub_item_table = submenu,
        help_text = _("Which configured server to sync to. If unsure, leave on the first WebDAV entry."),
        checked_func = function()
            local i = self._settings.server_index or 1
            return servers[i] and T(_("%1 (%2)"), servers[i].name, servers[i].type) or _("(none)")
        end,
    }
end

function VocabularyCloudSync:addToMainMenu(menu_items)
    menu_items.vocabcloudsync_main = {
        text = _("Vocabulary cloud auto-sync"),
        sorting_hint = "tools",
        help_text = _("Settings and manual sync for the auto-sync plugin."),
        sub_item_table = {
            {
                text = _("Status"),
                callback = function()
                    local InfoMessage = require("ui/widget/infomessage")
                    UIManager:show(InfoMessage:new{ text = self:_info() })
                end,
            },
            {
                text = _("Sync now"),
                help_text = _("Force an immediate sync. Works even when auto-sync is disabled."),
                callback = function()
                    self:_doSync({ manual = true, force = true })
                end,
            },
        },
    }
    -- Add settings submenu
    local settings_menu = {
        {
            text = _("Enabled"),
            help_text = _("Master switch for the plugin."),
            checked_func = function() return self._settings.enabled end,
            callback = function()
                self._settings.enabled = not self._settings.enabled
                self:_saveSettings()
                if self._settings.enabled then self:_scheduleNext() else self:_unschedule() end
            end,
        },
    }
    self:_addToggleMenu(settings_menu, "sync_on_suspend",  _("Sync on suspend"),
                        _("Sync the database just before the device goes to sleep."))
    self:_addToggleMenu(settings_menu, "sync_on_poweroff", _("Sync on power off"),
                        _("Sync the database just before the device powers off."))
    self:_addToggleMenu(settings_menu, "sync_on_resume",   _("Sync on resume"),
                        _("Sync shortly after waking up. Usually not needed."))
    self:_addToggleMenu(settings_menu, "sync_on_wifi_up",  _("Sync when Wi-Fi comes up"),
                        _("Sync when the network connection is established."))
    self:_addIntervalMenu(settings_menu)
    self:_addServerMenu(settings_menu)
    menu_items.vocabcloudsync_main.sub_item_table[#menu_items.vocabcloudsync_main.sub_item_table + 1] = {
        text = _("Settings"),
        sub_item_table = settings_menu,
    }

    -- Also expose a top-level shortcut for "Sync now" under tools.
    menu_items.vocabcloudsync_sync_now = {
        text = _("Sync vocabulary now"),
        sorting_hint = "tools",
        help_text = _("Manual one-shot sync of the Vocabulary Builder database."),
        callback = function()
            self:_doSync({ manual = true, force = true })
        end,
    }
end

-- ---------------------------------------------------------------------------
-- Broadcast event listeners (for things our wrapper can't catch cleanly)
-- ---------------------------------------------------------------------------

function VocabularyCloudSync:onNetworkConnected()
    if self._settings.enabled and self._settings.sync_on_wifi_up then
        -- Small delay to let the connection fully establish (DHCP, etc.).
        UIManager:scheduleIn(3, function()
            local ok, err = pcall(function() self:_doSync() end)
            if not ok then logger.warn("vocabcloudsync: wifi-up sync error:", err) end
        end)
    end
    self:_scheduleNext()
end

-- ---------------------------------------------------------------------------
-- init / stopPlugin
-- ---------------------------------------------------------------------------

function VocabularyCloudSync:init()
    self._wrapped = {}
    self:_loadSettings()
    self:_installWrappers()
    if self.ui and self.ui.menu then
        self.ui.menu:registerToMainMenu(self)
    end
    if self._settings.enabled then
        self:_scheduleNext()
    end
    logger.info("vocabcloudsync: initialized (enabled=",
        tostring(self._settings.enabled), ", interval_index=", tostring(self._settings.interval_index), ")")
end

function VocabularyCloudSync:stopPlugin(force)
    self:_unschedule()
    self:_unwrapAll()
    logger.info("vocabcloudsync: stopped")
end

return VocabularyCloudSync
