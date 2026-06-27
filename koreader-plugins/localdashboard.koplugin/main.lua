--[[
Local Dashboard - KOReader Plugin
Clock, date, weather, battery
]]

local Blitbuffer = require("ffi/blitbuffer")
local Device = require("device")
local Font = require("ui/font")
local FrameContainer = require("ui/widget/container/framecontainer")
local Geom = require("ui/geometry")
local GestureRange = require("ui/gesturerange")
local InputContainer = require("ui/widget/container/inputcontainer")
local TextBoxWidget = require("ui/widget/textboxwidget")
local UIManager = require("ui/uimanager")
local VerticalGroup = require("ui/widget/verticalgroup")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local _ = require("gettext")

local Screen = Device.screen
local Input = Device.input
local PowerD = Device:getPowerDevice()

local menu_inserted = false

-- ── Helpers ───────────────────────────────────────────────────

local function getBatteryText()
    local pct = PowerD:getCapacityHW()
    local text = string.format("%d%%", pct)
    if PowerD:isCharging() then
        text = text .. " (charging)"
    end
    return text
end

-- Map weather description to icon character
local function weatherDescToIcon(desc)
    local l = desc:lower()
    if l:find("clear") or l:find("sunny") then
        return "☀"
    elseif l:find("partly") then
        return "⛅"
    elseif l:find("cloud") or l:find("overcast") then
        return "☁"
    elseif l:find("thunder") then
        return "⚡"
    elseif l:find("rain") or l:find("drizzle") or l:find("shower") then
        return "☂"
    elseif l:find("snow") or l:find("sleet") or l:find("ice") or l:find("blizzard") then
        return "❄"
    elseif l:find("fog") or l:find("mist") or l:find("haze") then
        return "≡"
    end
    return "☀"
end

-- Fetch weather data: geolocate by IP, then get current conditions
local function fetchWeather()
    local http = require("socket.http")
    local ltn12 = require("ltn12")
    local json = require("json")

    http.TIMEOUT = 8

    -- Step 1: Geolocate by IP
    local geo_resp = {}
    local ok, geo_code = http.request{
        url = "http://ip-api.com/json/?fields=city,lat,lon",
        sink = ltn12.sink.table(geo_resp),
    }
    if not ok or geo_code ~= 200 or #geo_resp == 0 then
        return nil
    end

    local ok_loc, loc = pcall(json.decode, table.concat(geo_resp))
    if not ok_loc or not loc.city or not loc.lat or not loc.lon then
        return nil
    end

    local city = loc.city

    -- Step 2: Get weather from wttr.in (city-based, plain HTTP)
    local encoded = city:gsub(" ", "%%20"):gsub("'", "%%27"):gsub("%,", "%%2C")
    local wtr_resp = {}
    local ok2, wtr_code = http.request{
        url = "http://wttr.in/" .. encoded .. "?m&format=j1",
        sink = ltn12.sink.table(wtr_resp),
    }
    if not ok2 or wtr_code ~= 200 or #wtr_resp == 0 then
        return { city = city, icon = "☀", temp = "--", desc = "" }
    end

    local ok_wtr, weather = pcall(json.decode, table.concat(wtr_resp))
    if not ok_wtr or not weather.current_condition then
        return { city = city, icon = "☀", temp = "--", desc = "" }
    end

    local current = weather.current_condition[1]
    local desc = (current.weatherDesc and current.weatherDesc[1] and current.weatherDesc[1].value) or ""
    local icon = weatherDescToIcon(desc)

    return {
        city = city,
        icon = icon,
        temp = current.temp_C .. "°C",
        desc = desc,
    }
end

-- ── Dashboard Widget ──────────────────────────────────────────

local DashboardWidget = InputContainer:extend{
    name = "local_dashboard_widget",
    saved_rotation = nil,
    weather_data = nil,
}

function DashboardWidget:init()
    self.covers_fullscreen = true
    self.modal = true

    self.target_rotation = Screen.DEVICE_ROTATED_CLOCKWISE

    self.saved_rotation = Screen:getRotationMode()

    if Device:isTouchDevice() then
        self.ges_events = {
            TapDashboard = {
                GestureRange:new{ ges = "tap", range = Geom:new{
                    x = 0, y = 0,
                    w = Screen:getWidth(),
                    h = Screen:getHeight(),
                }},
            },
        }
    end
    if Device:hasKeys() then
        self.key_events.AnyKeyPressed = { { Input.group.Any } }
    end

    self[1] = self:build()
end

function DashboardWidget:build()
    Screen:setRotationMode(self.target_rotation)

    local w = Screen:getWidth()
    local h = Screen:getHeight()

    -- Big clock
    self.time_widget = TextBoxWidget:new{
        text = os.date("%H:%M", os.time()),
        face = Font:getFace("tfont", 120),
        width = w,
        alignment = "center",
        bold = true,
    }

    -- Date
    self.date_widget = TextBoxWidget:new{
        text = os.date("%A, %d %B %Y", os.time()),
        face = Font:getFace("infofont", 34),
        width = w,
        alignment = "center",
    }

    -- Padding between date and weather
    self.date_weather_pad = TextBoxWidget:new{
        text = "",
        face = Font:getFace("cfont", 1),
        width = w,
        height = 24,
    }

    -- City name
    self.city_widget = TextBoxWidget:new{
        text = "---",
        face = Font:getFace("infofont", 28),
        width = w,
        alignment = "center",
    }

    -- Weather line (icon + temp + description)
    self.weather_widget = TextBoxWidget:new{
        text = "",
        face = Font:getFace("infofont", 28),
        width = w,
        alignment = "center",
    }

    -- Battery (bottom)
    self.battery_widget = TextBoxWidget:new{
        text = getBatteryText(),
        face = Font:getFace("infofont", 12),
        width = w,
        alignment = "center",
    }

    -- Fetch weather (blocking, short timeout)
    self:refreshWeather()

    -- Layout: everything except battery is centred vertically
    local time_h      = self.time_widget:getSize().h
    local date_h      = self.date_widget:getSize().h
    local pad_h       = self.date_weather_pad:getSize().h
    local city_h      = self.city_widget:getSize().h
    local weather_h   = self.weather_widget:getSize().h
    local battery_h   = self.battery_widget:getSize().h

    local centre_h = time_h + date_h + pad_h + city_h + weather_h
    local remaining = h - centre_h - battery_h
    local spacer_h = math.floor(math.max(remaining / 2, 0))

    local spacer_top = TextBoxWidget:new{
        text = "",
        face = Font:getFace("cfont", 1),
        width = w,
        height = spacer_h,
    }
    local spacer_bot = TextBoxWidget:new{
        text = "",
        face = Font:getFace("cfont", 1),
        width = w,
        height = spacer_h,
    }

    self.group = VerticalGroup:new{
        spacer_top,
        self.time_widget,
        self.date_widget,
        self.date_weather_pad,
        self.city_widget,
        self.weather_widget,
        spacer_bot,
        self.battery_widget,
    }

    return FrameContainer:new{
        geom = Geom:new{ w = w, h = h },
        bordersize = 0,
        padding = 0,
        margin = 0,
        background = Blitbuffer.COLOR_WHITE,
        self.group,
    }
end

function DashboardWidget:refreshClock()
    self.now = os.time()
    self.time_widget:setText(os.date("%H:%M", self.now))
    self.date_widget:setText(os.date("%A, %d %B %Y", self.now))
    self.battery_widget:setText(getBatteryText())

    -- Re-fetch weather every hour
    if not self.last_weather_fetch or self.now - self.last_weather_fetch >= 3600 then
        self:refreshWeather()
    end

    UIManager:setDirty("all", "ui")

    local sec = tonumber(os.date("%S", self.now))
    self._scheduled = UIManager:scheduleIn(60 - sec, function()
        self:refreshClock()
    end)
end

function DashboardWidget:refreshWeather()
    local weather = fetchWeather()
    if weather then
        self.weather_data = weather
        self.city_widget:setText(weather.city)
        if weather.desc and weather.desc ~= "" then
            self.weather_widget:setText(weather.icon .. "  " .. weather.temp .. "  " .. weather.desc)
        else
            self.weather_widget:setText(weather.icon .. "  " .. weather.temp)
        end
    end
    self.last_weather_fetch = os.time()
end

function DashboardWidget:onShow()
    if Screen:getRotationMode() ~= self.target_rotation then
        Screen:setRotationMode(self.target_rotation)
        UIManager:setDirty("all", "full")
    end
    self:refreshClock()
    UIManager:setDirty("all", "ui")
end

function DashboardWidget:onCloseWidget()
    if self.saved_rotation and Screen:getRotationMode() ~= self.saved_rotation then
        Screen:setRotationMode(self.saved_rotation)
        UIManager:setDirty("all", "full")
    end
    if self._scheduled then
        UIManager:unschedule(self._scheduled)
        self._scheduled = nil
    end
end

function DashboardWidget:onTapDashboard()
    self:_dismiss()
    return true
end

function DashboardWidget:onAnyKeyPressed()
    self:_dismiss()
    return true
end

function DashboardWidget:_dismiss()
    UIManager:close(self)
end

-- ── Plugin Registration ───────────────────────────────────────

local LocalDashboard = WidgetContainer:extend{
    name = "localdashboard",
    is_doc_only = false,
}

function LocalDashboard:init()
    self.ui.menu:registerToMainMenu(self)
    if not menu_inserted then
        menu_inserted = true
        require("ui/plugin/insert_menu").add("localdashboard")
    end
end

function LocalDashboard:addToMainMenu(menu_items)
    menu_items.localdashboard = {
        text = _("Local Dashboard"),
        callback = function(touchmenu_instance)
            if touchmenu_instance then
                touchmenu_instance:closeMenu()
            end
            UIManager:nextTick(function()
                UIManager:show(DashboardWidget:new{})
            end)
        end,
    }
end

return LocalDashboard
