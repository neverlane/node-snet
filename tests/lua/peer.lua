-- Lua SNET test peer (RazorRw/SNET). Controlled by node tests through SNET packets.
-- usage: luajit peer.lua <server|client> <port> [drain=200]
--
-- stdout protocol (one line per event):
--   READY
--   CLIENT <address> <port> <type>          (server only, onClientUpdate)
--   RECV <packetId> <hex payload>           (every packet except load packets 122)
--   TYPED <u8> <i8> <u16> <i16> <u32> <i32> <float> <bool> <str>
--
-- control packets (node -> lua):
--   100 ECHO   [u8 priority][rest]              -> 101 rest (with given priority)
--   110 TYPED  u8 i8 u16 i16 u32 i32 float bool u8 len, str
--                                               -> 111 same values re-encoded by lua bstream (HIGH)
--   120 BURST  u32 count, u8 priority, u16 size -> count x 121 [u32 seq][filler]
--   122 LOAD   u32 seq                          (counted, not printed)
--   130 STATS                                   -> 131 u32 pending, u32 load_unique, u32 load_total
--   140 SEND   u32 packetId, u8 priority, rest  -> packetId rest (raw passthrough)

io.stdout:setvbuf('line')

-- Razor's client.lua/server.lua use a *global* `socket` (socket.gettime) without requiring it
-- (upstream bug @19aecbe: init.lua only has `local socket`). Hosts like MoonLoader expose it globally.
socket = require('socket')
local snet = require('snet')
local bstream = snet.bstream

local mode, port, drain = arg[1], tonumber(arg[2]), tonumber(arg[3] or '200')
assert(mode == 'server' or mode == 'client', 'mode must be server|client')
assert(port, 'port required')

local function hex(s)
  return (s:gsub('.', function(c) return string.format('%02x', c:byte()) end))
end

local peer
if mode == 'server' then
  peer = snet.server('127.0.0.1', port)
else
  peer = snet.client('127.0.0.1', port)
end

-- optional: bigger OS receive buffer (Razor uses the OS default)
local rcvbuf = tonumber(os.getenv('SNET_LUA_RCVBUF') or '')
if rcvbuf then assert(peer.socket:setoption('recv-buffer-size', rcvbuf)) end

local load_seen, load_unique, load_total = {}, 0, 0

local function reply(packet_id, bs, priority, address, rport)
  if mode == 'server' then
    peer:send(packet_id, bs, priority, address, rport)
  else
    peer:send(packet_id, bs, priority)
  end
end

local handlers = {}

handlers[100] = function(bs, address, rport)
  local priority = bs:read(BS_UINT8)
  reply(101, bstream.new(bs.bytes:sub(2)), priority, address, rport)
end

handlers[110] = function(bs, address, rport)
  local u8 = bs:read(BS_UINT8)
  local i8 = bs:read(BS_INT8)
  local u16 = bs:read(BS_UINT16)
  local i16 = bs:read(BS_INT16)
  local u32 = bs:read(BS_UINT32)
  local i32 = bs:read(BS_INT32)
  local f = bs:read(BS_FLOAT)
  local b = bs:read(BS_BOOLEAN)
  local len = bs:read(BS_UINT8)
  local str = bs:read(BS_STRING, len)
  print(string.format('TYPED %d %d %d %d %d %d %.9g %s %s', u8, i8, u16, i16, u32, i32, f, tostring(b), hex(str)))

  local out = bstream.new()
  out:write(BS_UINT8, u8)
  out:write(BS_INT8, i8)
  out:write(BS_UINT16, u16)
  out:write(BS_INT16, i16)
  out:write(BS_UINT32, u32)
  out:write(BS_INT32, i32)
  out:write(BS_FLOAT, f)
  out:write(BS_BOOLEAN, b)
  out:write(BS_UINT8, #str)
  out:write(BS_STRING, str)
  reply(111, out, SNET_HIGH_PRIORITY, address, rport)
end

handlers[120] = function(bs, address, rport)
  local count = bs:read(BS_UINT32)
  local priority = bs:read(BS_UINT8)
  local size = bs:read(BS_UINT16)
  for seq = 0, count - 1 do
    local out = bstream.new()
    out:write(BS_UINT32, seq)
    if size > 4 then out:write(BS_STRING, string.rep(string.char(seq % 256), size - 4)) end
    reply(121, out, priority, address, rport)
  end
end

handlers[122] = function(bs)
  local seq = bs:read(BS_UINT32)
  load_total = load_total + 1
  if not load_seen[seq] then
    load_seen[seq] = true
    load_unique = load_unique + 1
  end
end

handlers[130] = function(_, address, rport)
  local out = bstream.new()
  out:write(BS_UINT32, #peer.packets)
  out:write(BS_UINT32, load_unique)
  out:write(BS_UINT32, load_total)
  reply(131, out, SNET_BYPASS_PRIORITY, address, rport)
end

handlers[140] = function(bs, address, rport)
  local packet_id = bs:read(BS_UINT32)
  local priority = bs:read(BS_UINT8)
  reply(packet_id, bstream.new(bs.bytes:sub(6)), priority, address, rport)
end

peer:add_event_handler('onReceivePacket', function(packet_id, bs, address, rport)
  if packet_id ~= 122 then print(string.format('RECV %d %s', packet_id, hex(bs.bytes))) end
  local h = handlers[packet_id]
  if h then h(bs, address, rport) end
end)

if mode == 'server' then
  peer:add_event_handler('onClientUpdate', function(address, rport, typ)
    print(string.format('CLIENT %s %s %s', address, tostring(rport), typ))
  end)
else
  local hello = bstream.new()
  hello:write(BS_STRING, 'lua')
  peer:send(1, hello, SNET_HIGH_PRIORITY)
end

print('READY')

while true do
  -- Razor's process() reads a single datagram per call, so drain the socket a few times per tick.
  for _ = 1, drain do peer:process() end
  socket.sleep(0.001)
end
