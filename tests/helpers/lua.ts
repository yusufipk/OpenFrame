// Runs a Lua file's pure helpers inside fengari (Lua in JavaScript), so the Resolve
// script can be unit tested without Resolve. The file is loaded with OPENFRAME_TEST
// set, which makes it return its helper table before touching Resolve.
import { readFileSync } from 'node:fs';
import { lauxlib, lua, lualib, to_jsstring, to_luastring } from 'fengari';

type LuaState = unknown;
export type LuaValue = null | boolean | number | string | LuaValue[] | { [key: string]: LuaValue };

function push(L: LuaState, value: unknown): void {
  if (value === null || value === undefined) lua.lua_pushnil(L);
  else if (typeof value === 'boolean') lua.lua_pushboolean(L, value);
  else if (typeof value === 'number') lua.lua_pushnumber(L, value);
  else if (typeof value === 'string') lua.lua_pushstring(L, to_luastring(value));
  else if (Array.isArray(value)) {
    lua.lua_createtable(L, value.length, 0);
    value.forEach((item, index) => {
      push(L, item);
      lua.lua_rawseti(L, -2, index + 1);
    });
  } else if (typeof value === 'object') {
    lua.lua_createtable(L, 0, 0);
    for (const [key, item] of Object.entries(value)) {
      push(L, item);
      lua.lua_setfield(L, -2, to_luastring(key));
    }
  } else throw new Error(`Cannot pass ${typeof value} to Lua`);
}

function read(L: LuaState, index: number): LuaValue {
  switch (lua.lua_type(L, index)) {
    case lua.LUA_TNIL:
      return null;
    case lua.LUA_TBOOLEAN:
      return lua.lua_toboolean(L, index);
    case lua.LUA_TNUMBER:
      return lua.lua_tonumber(L, index);
    case lua.LUA_TSTRING:
      return to_jsstring(lua.lua_tostring(L, index));
    case lua.LUA_TTABLE: {
      const at = lua.lua_absindex(L, index);
      const entries: [LuaValue, LuaValue][] = [];
      lua.lua_pushnil(L);
      while (lua.lua_next(L, at) !== 0) {
        lua.lua_pushvalue(L, -2);
        const key = read(L, -1);
        lua.lua_pop(L, 1);
        entries.push([key, read(L, -1)]);
        lua.lua_pop(L, 1);
      }
      const isArray = entries.every(([key]) => typeof key === 'number');
      if (isArray && entries.length > 0) {
        const array: LuaValue[] = [];
        for (const [key, item] of entries) array[(key as number) - 1] = item;
        return array;
      }
      return Object.fromEntries(entries.map(([key, item]) => [String(key), item]));
    }
    default:
      throw new Error(
        `Cannot read a Lua ${to_jsstring(lua.lua_typename(L, lua.lua_type(L, index)))}`
      );
  }
}

export function loadLuaHelpers(file: string) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  lua.lua_pushboolean(L, true);
  lua.lua_setglobal(L, to_luastring('OPENFRAME_TEST'));
  const source = new Uint8Array(readFileSync(file));
  if (lauxlib.luaL_loadbuffer(L, source, null, to_luastring(file)) !== lua.LUA_OK) {
    throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  }
  lua.lua_call(L, 0, 1);
  const helpers = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);

  // Calls module.<name>(...args) and returns its first result; a Lua error throws.
  return function call(name: string, ...args: unknown[]): LuaValue {
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, helpers);
    lua.lua_getfield(L, -1, to_luastring(name));
    for (const arg of args) push(L, arg);
    if (lua.lua_pcall(L, args.length, 1, 0) !== lua.LUA_OK) {
      const message = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_pop(L, 2);
      throw new Error(message);
    }
    const result = read(L, -1);
    lua.lua_pop(L, 2);
    return result;
  };
}
