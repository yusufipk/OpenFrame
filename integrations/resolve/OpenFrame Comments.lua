-- OpenFrame Comments for DaVinci Resolve.
--
-- Adds the comments of an OpenFrame video version as markers on the current
-- timeline. Install it in Resolve's Fusion/Scripts/Utility folder and run it from
-- Workspace > Scripts. It needs curl, which ships with Windows 10 and later,
-- macOS and Linux.

local M = {}

-- This script's release. The OpenFrame server sends the newest one with every sync.
M.VERSION = '0.1.0'

-- ---------------------------------------------------------------------------
-- Pure helpers. The unit tests load this file with OPENFRAME_TEST set and call
-- these directly, so they must not touch Resolve, files or the network.
-- ---------------------------------------------------------------------------

-- Resolve's timeline frame rate setting as the exact ratio the export API takes.
local RATES = {
  { 23.976, '24000/1001' },
  { 24, '24' },
  { 25, '25' },
  { 29.97, '30000/1001' },
  { 30, '30' },
  { 48, '48' },
  { 50, '50' },
  { 59.94, '60000/1001' },
  { 60, '60' },
}

function M.rate_from_setting(value)
  local number = tonumber((tostring(value or ''):gsub('%s*DF%s*$', '')))
  if not number then return nil end
  for _, rate in ipairs(RATES) do
    if math.abs(number - rate[1]) < 0.01 then return rate[2] end
  end
  return nil
end

-- Plain http only reaches a server on this machine or the local network.
function M.is_local_host(host)
  host = host:lower():gsub('^%[', ''):gsub('%]$', '')
  if host == 'localhost' or host == '::1' or host:match('%.local$') then return true end
  local a, b, c, d = host:match('^(%d+)%.(%d+)%.(%d+)%.(%d+)$')
  if not a then return false end
  a, b = tonumber(a), tonumber(b)
  if tonumber(c) > 255 or tonumber(d) > 255 or a > 255 or b > 255 then return false end
  return a == 127 or a == 10 or (a == 192 and b == 168) or (a == 172 and b >= 16 and b <= 31)
end

local function url_decode(value)
  if value:gsub('%%%x%x', ''):find('%%') then return nil end
  return (value:gsub('%%(%x%x)', function(hex) return string.char(tonumber(hex, 16)) end))
end

-- The address of a video page, e.g. https://open-frame.net/projects/<p>/videos/<v>
function M.parse_video_link(value)
  value = tostring(value or ''):match('^%s*(.-)%s*$')
  local scheme, host, port, path = value:match('^(https?)://([%w%.%-]+):?(%d*)(/[^?#]*)')
  if not scheme then
    scheme, host, port, path = value:match('^(https?)://(%[[%x:]+%]):?(%d*)(/[^?#]*)')
  end
  if not scheme then return nil end
  if scheme == 'http' and not M.is_local_host(host) then return nil end
  local project, video = path:match('^/projects/([^/]+)/videos/([^/]+)/?$')
  if not project then return nil end
  project, video = url_decode(project), url_decode(video)
  if not project or not video then return nil end
  local origin = scheme .. '://' .. host:lower() .. (port ~= '' and (':' .. port) or '')
  return { origin = origin, project_id = project, video_id = video }
end

function M.url_encode(value)
  return (tostring(value):gsub('[^%w%-%._~]', function(char)
    return string.format('%%%02X', string.byte(char))
  end))
end

-- The command line hands the address to curl inside double quotes. These characters
-- could still break out of them or expand in cmd.exe or sh, so an address holding
-- one is refused; everything the script builds avoids them.
function M.is_safe_url(url)
  return not url:find('["%%`$\\!]')
end

function M.versions_url(link)
  return link.origin .. '/api/projects/' .. M.url_encode(link.project_id) .. '/videos/'
    .. M.url_encode(link.video_id) .. '?includeComments=false'
end

-- The rate comes from the fixed table above, digits and a slash, so it goes in as is:
-- encoding the slash would put a % into the address.
function M.markers_url(origin, version_id, rate, include_resolved)
  return origin .. '/api/versions/' .. M.url_encode(version_id)
    .. '/comments/export?format=markers&fps=' .. rate
    .. '&includeResolved=' .. tostring(include_resolved == true)
end

-- Every marker this script writes carries this in its hidden custom data, so a later
-- sync finds its own markers for this version and leaves the editor's alone.
function M.marker_tag(version_id)
  return 'openframe:' .. version_id
end

-- A whole number without the ".0" Lua 5.3 would add; other values as they are.
local function number_text(value)
  if type(value) == 'number' and value == math.floor(value) then
    return string.format('%d', value)
  end
  return tostring(value)
end

-- Whether a dotted version such as 0.2.0 is newer than another. Anything that is
-- not a version reads as not newer, so a bad reply never nags the editor.
local function version_parts(value)
  if type(value) ~= 'string' or not value:match('^%d+[%d.]*$') or value:match('%.%.')
    or value:match('%.$') then
    return nil
  end
  local parts = {}
  for part in value:gmatch('%d+') do parts[#parts + 1] = tonumber(part) end
  return parts
end

function M.is_newer_version(latest, current)
  local a, b = version_parts(latest), version_parts(current)
  if not a or not b then return false end
  for i = 1, math.max(#a, #b) do
    local diff = (a[i] or 0) - (b[i] or 0)
    if diff ~= 0 then return diff > 0 end
  end
  return false
end

-- The line the script adds after a sync when the server knows a newer script.
function M.update_notice(plugin_versions)
  local latest = type(plugin_versions) == 'table' and plugin_versions.resolve or nil
  if not M.is_newer_version(latest, M.VERSION) then return nil end
  return 'A new version of this script (' .. latest .. ') is out. Download it again from the comments menu in OpenFrame and replace this file.'
end

function M.version_name(version)
  local label = version.versionLabel
  if type(label) == 'string' and label ~= '' then
    return 'v' .. number_text(version.versionNumber) .. ': ' .. label
  end
  return 'v' .. number_text(version.versionNumber)
end

function M.error_message(status, body)
  local err = type(body) == 'table' and body.error or nil
  if type(err) == 'table' and type(err.message) == 'string' then return err.message end
  if type(err) == 'string' then return err end
  return 'HTTP ' .. number_text(status)
end

-- A small JSON reader: objects, arrays, strings with escapes (including surrogate
-- pairs), numbers, true, false and null (read as nil).
local function utf8_char(code)
  if code < 0x80 then return string.char(code) end
  if code < 0x800 then
    return string.char(0xC0 + math.floor(code / 0x40), 0x80 + code % 0x40)
  end
  if code < 0x10000 then
    return string.char(
      0xE0 + math.floor(code / 0x1000),
      0x80 + math.floor(code / 0x40) % 0x40,
      0x80 + code % 0x40
    )
  end
  return string.char(
    0xF0 + math.floor(code / 0x40000),
    0x80 + math.floor(code / 0x1000) % 0x40,
    0x80 + math.floor(code / 0x40) % 0x40,
    0x80 + code % 0x40
  )
end

function M.json_decode(text)
  local pos = 1
  local function fail(message) error('Invalid JSON at ' .. pos .. ': ' .. message, 0) end
  local function skip() pos = text:find('[^ \t\r\n]', pos) or (#text + 1) end
  local value
  local function str()
    pos = pos + 1
    local parts = {}
    while true do
      local chunk_end = text:find('["\\]', pos)
      if not chunk_end then fail('unterminated string') end
      parts[#parts + 1] = text:sub(pos, chunk_end - 1)
      pos = chunk_end
      if text:sub(pos, pos) == '"' then
        pos = pos + 1
        return table.concat(parts)
      end
      local esc = text:sub(pos + 1, pos + 1)
      local simple = { ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f', n = '\n', r = '\r', t = '\t' }
      if simple[esc] then
        parts[#parts + 1] = simple[esc]
        pos = pos + 2
      elseif esc == 'u' then
        local hex = text:sub(pos + 2, pos + 5)
        if not hex:match('^%x%x%x%x$') then fail('bad \\u escape') end
        local code = tonumber(hex, 16)
        pos = pos + 6
        if code >= 0xD800 and code <= 0xDBFF and text:sub(pos, pos + 1) == '\\u' then
          local low = tonumber(text:sub(pos + 2, pos + 5), 16)
          if low and low >= 0xDC00 and low <= 0xDFFF then
            code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
            pos = pos + 6
          end
        end
        if code >= 0xD800 and code <= 0xDFFF then code = 0xFFFD end
        parts[#parts + 1] = utf8_char(code)
      else
        fail('bad escape')
      end
    end
  end
  value = function()
    skip()
    local char = text:sub(pos, pos)
    if char == '{' then
      local result = {}
      pos = pos + 1
      skip()
      if text:sub(pos, pos) == '}' then
        pos = pos + 1
        return result
      end
      while true do
        skip()
        if text:sub(pos, pos) ~= '"' then fail('expected a key') end
        local key = str()
        skip()
        if text:sub(pos, pos) ~= ':' then fail('expected :') end
        pos = pos + 1
        result[key] = value()
        skip()
        local sep = text:sub(pos, pos)
        pos = pos + 1
        if sep == '}' then return result end
        if sep ~= ',' then fail('expected , or }') end
      end
    elseif char == '[' then
      local result = {}
      pos = pos + 1
      skip()
      if text:sub(pos, pos) == ']' then
        pos = pos + 1
        return result
      end
      local index = 0
      while true do
        index = index + 1
        result[index] = value()
        skip()
        local sep = text:sub(pos, pos)
        pos = pos + 1
        if sep == ']' then return result end
        if sep ~= ',' then fail('expected , or ]') end
      end
    elseif char == '"' then
      return str()
    elseif text:sub(pos, pos + 3) == 'true' then
      pos = pos + 4
      return true
    elseif text:sub(pos, pos + 4) == 'false' then
      pos = pos + 5
      return false
    elseif text:sub(pos, pos + 3) == 'null' then
      pos = pos + 4
      return nil
    end
    local number = text:match('^-?%d+%.?%d*[eE]?[-+]?%d*', pos)
    if not number or not tonumber(number) then fail('unexpected character') end
    pos = pos + #number
    return tonumber(number)
  end
  local result = value()
  skip()
  if pos <= #text then fail('trailing characters') end
  return result
end

if OPENFRAME_TEST then return M end

-- ---------------------------------------------------------------------------
-- Resolve, files and network.
-- ---------------------------------------------------------------------------

local WINDOWS = package.config:sub(1, 1) == '\\'

local function temp_path(name)
  if WINDOWS then
    return (os.getenv('TEMP') or os.getenv('TMP') or '.') .. '\\openframe-' .. name .. '-' .. os.time() .. '.tmp'
  end
  return os.tmpname()
end

local function read_file(file)
  local handle = io.open(file, 'rb')
  if not handle then return nil end
  local data = handle:read('*a')
  handle:close()
  return data
end

local function write_file(file, data)
  local handle = assert(io.open(file, 'wb'))
  handle:write(data)
  handle:close()
end

-- curl with the token in a header file, so it never shows on a command line.
local function http_get(url, token)
  if not M.is_safe_url(url) then error('Refusing an unexpected character in the address.', 0) end
  local headers = temp_path('headers')
  local body_file = temp_path('body')
  write_file(headers, 'Authorization: Bearer ' .. token .. '\n')
  local command = string.format(
    'curl -sS -m 60 -H @"%s" -o "%s" -w "%%{http_code}" "%s"',
    headers,
    body_file,
    url
  )
  local pipe = io.popen(command)
  local status = pipe and pipe:read('*a') or ''
  if pipe then pipe:close() end
  os.remove(headers)
  local raw = read_file(body_file) or ''
  os.remove(body_file)
  local code = tonumber(status:match('(%d%d%d)%s*$'))
  if not code or code == 0 then
    error('Could not reach the server. Check the link and that curl is installed.', 0)
  end
  local ok, body = pcall(M.json_decode, raw)
  if not ok then body = nil end
  if code < 200 or code >= 300 then error(M.error_message(code, body), 0) end
  if type(body) ~= 'table' or type(body.data) ~= 'table' then
    error('The server sent an unexpected answer.', 0)
  end
  return body.data
end

-- Tokens are saved one per server in a file only this user can read, and filled in
-- only for a link to the server they were saved for.
local function settings_file()
  if WINDOWS then return (os.getenv('APPDATA') or '.') .. '\\OpenFrame-resolve.txt' end
  return (os.getenv('HOME') or '.') .. '/.openframe-resolve'
end

local function load_settings()
  local settings = { tokens = {}, link = '', include_resolved = false }
  for line in (read_file(settings_file()) or ''):gmatch('[^\n]+') do
    local key, a, b = line:match('^(%w+)\t([^\t]*)\t?(.*)$')
    if key == 'token' then settings.tokens[a] = b end
    if key == 'link' then settings.link = a end
    if key == 'resolved' then settings.include_resolved = a == 'true' end
  end
  return settings
end

local function save_settings(settings)
  local lines = {
    'link\t' .. settings.link,
    'resolved\t' .. tostring(settings.include_resolved),
  }
  for origin, token in pairs(settings.tokens) do
    lines[#lines + 1] = 'token\t' .. origin .. '\t' .. token
  end
  local file = settings_file()
  -- Restrict the file before the tokens go in, so it is never readable by others.
  if not WINDOWS then
    write_file(file, '')
    os.execute('chmod 600 "' .. file .. '"')
  end
  write_file(file, table.concat(lines, '\n') .. '\n')
end

local resolve_app = resolve or Resolve()
local ui = fu.UIManager
local dispatcher = bmd.UIDispatcher(ui)
local settings = load_settings()
local version_ids = {}
local shown_origin = nil

local window = dispatcher:AddWindow({
  ID = 'OpenFrameComments',
  WindowTitle = 'OpenFrame Comments',
  Geometry = { 200, 200, 460, 420 },
}, ui:VGroup({
  ui:Label({ Text = 'OpenFrame video link', Weight = 0 }),
  ui:LineEdit({ ID = 'Link', PlaceholderText = 'https://open-frame.net/projects/.../videos/...', Weight = 0 }),
  ui:Label({ ID = 'Server', Text = '', Weight = 0 }),
  ui:Label({ Text = 'API token (Read and Read comments)', Weight = 0 }),
  ui:LineEdit({ ID = 'Token', EchoMode = 'Password', Weight = 0 }),
  ui:Button({ ID = 'Load', Text = 'Load versions', Weight = 0 }),
  ui:Label({ Text = 'Version', Weight = 0 }),
  ui:ComboBox({ ID = 'Version', Weight = 0 }),
  ui:CheckBox({ ID = 'Resolved', Text = 'Include resolved comments', Weight = 0 }),
  ui:Button({ ID = 'Sync', Text = 'Add comments to the current timeline', Weight = 0 }),
  ui:TextEdit({ ID = 'Status', ReadOnly = true, Weight = 1 }),
}))
local items = window:GetItems()

local function set_status(message) items.Status.PlainText = message end

-- A changed link invalidates the loaded versions. The token field only changes when
-- the server does: it then shows the token saved for that server, or nothing, so a
-- token never follows a link to another host.
local function on_link_change()
  items.Version:Clear()
  version_ids = {}
  items.Sync.Enabled = false
  local link = M.parse_video_link(items.Link.Text)
  local origin = link and link.origin or nil
  items.Server.Text = origin and ('Server: ' .. origin) or ''
  if origin ~= shown_origin then
    items.Token.Text = origin and (settings.tokens[origin] or '') or ''
    shown_origin = origin
  end
end

local function read_link()
  local link = M.parse_video_link(items.Link.Text)
  if not link then
    error('Paste the address of an OpenFrame video page (https, or http on this machine or local network).', 0)
  end
  local token = items.Token.Text:match('^%s*(.-)%s*$')
  if token == '' then error('Paste an OpenFrame API token for ' .. link.origin .. '.', 0) end
  if token:find('[\r\n]') then error('The token has a line break in it.', 0) end
  return link, token
end

local function load_versions()
  local link, token = read_link()
  settings.link = items.Link.Text
  settings.tokens[link.origin] = token
  save_settings(settings)
  set_status('Loading versions...')
  local video = http_get(M.versions_url(link), token)
  items.Version:Clear()
  version_ids = {}
  for index, version in ipairs(video.versions or {}) do
    items.Version:AddItem(M.version_name(version))
    version_ids[index] = version.id
  end
  items.Sync.Enabled = #version_ids > 0
  set_status(tostring(video.title) .. ': ' .. #version_ids .. ' version(s).')
end

local function sync_markers()
  local link, token = read_link()
  local version_id = version_ids[(items.Version.CurrentIndex or 0) + 1]
  if not version_id then error('Load the versions and pick one.', 0) end
  local project = resolve_app:GetProjectManager():GetCurrentProject()
  local timeline = project and project:GetCurrentTimeline()
  if not timeline then error('Open a timeline first.', 0) end
  local setting = timeline:GetSetting('timelineFrameRate')
  if not setting or setting == '' then setting = project:GetSetting('timelineFrameRate') end
  local rate = M.rate_from_setting(setting)
  if not rate then error('This timeline frame rate (' .. tostring(setting) .. ') is not supported.', 0) end

  settings.include_resolved = items.Resolved.Checked
  save_settings(settings)
  set_status('Fetching comments...')
  local data = http_get(M.markers_url(link.origin, version_id, rate, items.Resolved.Checked), token)

  -- A Resolve marker owns its frame, so what an earlier sync wrote goes first.
  local tag = M.marker_tag(version_id)
  local removed = 0
  for frame, marker in pairs(timeline:GetMarkers() or {}) do
    if marker.customData == tag and timeline:DeleteMarkerAtFrame(frame) then removed = removed + 1 end
  end
  local added, blocked = 0, 0
  for _, marker in ipairs(data.markers or {}) do
    local ok = timeline:AddMarker(
      marker.startFrame,
      marker.resolveColor,
      marker.name,
      marker.comments,
      marker.durationFrames,
      tag
    )
    if ok then added = added + 1 else blocked = blocked + 1 end
  end

  local lines = {
    'Added ' .. added .. ' marker(s) from ' .. tostring(data.videoTitle) .. ' '
      .. M.version_name(data) .. ' at ' .. rate .. ' fps'
      .. (removed > 0 and (', replacing ' .. removed .. ' from the last sync.') or '.'),
  }
  if blocked > 0 then
    lines[#lines + 1] = blocked .. ' marker(s) could not be added, usually because another marker already sits on that frame.'
  end
  local notice = M.update_notice(data.pluginVersions)
  if notice then lines[#lines + 1] = notice end
  set_status(table.concat(lines, '\n'))
end

local function guarded(action)
  return function()
    local ok, err = pcall(action)
    if not ok then set_status(tostring(err)) end
  end
end

function window.On.OpenFrameComments.Close() dispatcher:ExitLoop() end
function window.On.Link.TextChanged() on_link_change() end
window.On.Load.Clicked = guarded(load_versions)
window.On.Sync.Clicked = guarded(sync_markers)

items.Link.Text = settings.link
items.Resolved.Checked = settings.include_resolved
on_link_change()
window:Show()
dispatcher:RunLoop()
window:Hide()
