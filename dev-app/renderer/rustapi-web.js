/* Web/Capacitor fallback for rustAPI (non-Electron runtime) */
(function initRustApiWeb() {
  if (window.rustAPI) return;

  const STORAGE_KEYS = {
    servers: "rustadmin.servers",
    customCommands: "rustadmin.customCommands",
    usageLog: "rustadmin.usageLog",
    offlinePlayers: "rustadmin.offlinePlayers",
  };

  const listeners = {
    status: [],
    serverMeta: [],
    console: [],
    chat: [],
    reconnecting: [],
  };

  const pending = new Map();
  let ws = null;
  let currentServer = null;
  let msgId = 1;
  let reconnectTimer = null;
  let autoReconnect = false;

  function emit(type, data) {
    const arr = listeners[type] || [];
    arr.forEach((cb) => {
      try {
        cb(data);
      } catch (e) {
        console.error("[rustapi-web] listener error:", e);
      }
    });
  }

  function addListener(type, cb) {
    if (!listeners[type]) return;
    listeners[type].push(cb);
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function loadServersData() {
    return readJson(STORAGE_KEYS.servers, { servers: [], lastSelected: "" });
  }

  function saveServersData(data) {
    writeJson(STORAGE_KEYS.servers, data || { servers: [], lastSelected: "" });
  }

  function mapCloseError(ev) {
    if (!ev) return "连接已断开";
    if (ev.reason) return ev.reason;
    return "连接已断开";
  }

  function parseMaybeJson(str) {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  function scheduleReconnect() {
    if (!autoReconnect || reconnectTimer || !currentServer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      emit("reconnecting", {});
      rustAPI.rconConnect(currentServer).catch(() => {});
    }, 5000);
  }

  function sendRcon(command, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("未连接到服务器"));
        return;
      }
      const id = msgId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: true, message: "", timeout: true });
      }, Math.max(1000, timeoutMs || 10000));
      pending.set(id, { resolve, timer, command });
      ws.send(JSON.stringify({ Identifier: id, Message: command, Name: "RustAdmin-Android" }));
    });
  }

  function parseIncoming(payloadText) {
    const msg = parseMaybeJson(payloadText);
    if (!msg || typeof msg !== "object") return;
    const identifier = msg.Identifier;
    const message = String(msg.Message || "");
    const type = msg.Type;

    if (type === "Chat") {
      const chat = parseMaybeJson(message);
      emit("chat", {
        channel: chat?.Channel === 1 ? "队伍" : chat?.Channel === 2 ? "卡组" : "全部",
        username: chat?.Username || "?",
        text: chat?.Message || message,
        steamid: chat?.SteamID || "",
        color: chat?.Color || "",
        time: new Date().toISOString(),
      });
      return;
    }

    emit("console", { text: message, time: new Date().toISOString(), id: identifier, type });

    if (identifier && pending.has(identifier)) {
      const req = pending.get(identifier);
      clearTimeout(req.timer);
      pending.delete(identifier);
      req.resolve({ ok: true, message, timeout: false });
    }
  }

  const rustAPI = {
    windowMinimize: () => {},
    windowMaximize: () => {},
    windowClose: () => {},
    openUrl: (url) => {
      try {
        window.open(String(url || ""), "_blank");
      } catch {}
    },

    getServers: async () => loadServersData(),
    saveServer: async (server) => {
      const data = loadServersData();
      const idx = data.servers.findIndex((s) => s.Name === server.Name);
      if (idx >= 0) data.servers[idx] = server;
      else data.servers.push(server);
      saveServersData(data);
      return data;
    },
    deleteServer: async (name) => {
      const data = loadServersData();
      data.servers = data.servers.filter((s) => s.Name !== name);
      if (data.lastSelected === name) data.lastSelected = "";
      saveServersData(data);
      return data;
    },
    setLastServer: async (name) => {
      const data = loadServersData();
      data.lastSelected = name || "";
      saveServersData(data);
      return data;
    },

    rconConnect: async (server) => {
      currentServer = server;
      autoReconnect = true;
      if (ws) {
        try {
          ws.close();
        } catch {}
      }
      const url = `ws://${server.IpAddress}:${server.RconPort}/${encodeURIComponent(String(server.RconPassword || ""))}`;
      ws = new WebSocket(url);

      ws.onopen = async () => {
        emit("status", { connected: true, server: server.Name });
        try {
          const h = await sendRcon("server.hostname", 10000);
          const raw = String(h?.message || "").trim();
          const hn = raw
            .replace(/^server\.hostname\s*[:=]\s*/i, "")
            .replace(/^server\.hostname\s+/i, "")
            .replace(/^"|"$/g, "")
            .trim();
          if (hn) emit("serverMeta", { hostname: hn });
        } catch {}
      };
      ws.onmessage = (ev) => parseIncoming(ev.data);
      ws.onerror = () => {
        emit("status", { connected: false, error: "连接失败" });
      };
      ws.onclose = (ev) => {
        emit("status", { connected: false, error: mapCloseError(ev) });
        scheduleReconnect();
      };
      return { ok: true };
    },
    rconDisconnect: async () => {
      autoReconnect = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {}
        ws = null;
      }
      return { ok: true };
    },
    rconCommand: async (cmd) => {
      try {
        const r = await sendRcon(cmd, 15000);
        return { ok: true, message: r.message || "", timeout: !!r.timeout };
      } catch (e) {
        return { ok: false, error: e?.message || "执行失败" };
      }
    },
    rconCommandSilent: async (cmd) => rustAPI.rconCommand(cmd),

    getPlayers: async () => {
      const r = await rustAPI.rconCommand("playerlist");
      if (!r.ok) return { ok: false, players: [], error: r.error };
      const players = parseMaybeJson(r.message) || [];
      return { ok: true, players };
    },
    getBans: async () => ({ ok: true, bans: [] }),
    getGroups: async () => ({ ok: true, groups: [] }),
    getGroupDetail: async () => ({ ok: true, perms: [], users: [], raw: "" }),
    getPermissions: async () => ({ ok: true, perms: [] }),
    groupGrantPerm: async () => ({ ok: false, error: "Android 版本暂不支持该功能" }),
    groupRevokePerm: async () => ({ ok: false, error: "Android 版本暂不支持该功能" }),
    getPlugins: async () => ({ ok: true, plugins: [] }),
    getOfflinePlayers: async () => ({ players: readJson(STORAGE_KEYS.offlinePlayers, []) }),
    clearOfflinePlayers: async () => {
      writeJson(STORAGE_KEYS.offlinePlayers, []);
      return { ok: true };
    },
    getSteamGameBansBatch: async () => ({ ok: true, items: {} }),
    getIpGeoBatch: async () => ({ ok: true, items: {} }),
    // 控制台日志：Web 版落到 localStorage，保持同样的调用契约
    consoleLogAppend: async (serverKey, lines) => {
      const key = `rustadmin.consoleLog.${serverKey || "default"}`;
      const list = readJson(key, []);
      const arr = Array.isArray(list) ? list : [];
      (Array.isArray(lines) ? lines : [lines]).forEach((l) => arr.push(l));
      writeJson(key, arr.slice(-2000));
      return { ok: true, appended: 1 };
    },
    consoleLogLoad: async (serverKey) => {
      const key = `rustadmin.consoleLog.${serverKey || "default"}`;
      const list = readJson(key, []);
      return { ok: true, lines: Array.isArray(list) ? list : [] };
    },
    consoleLogClear: async (serverKey) => {
      writeJson(`rustadmin.consoleLog.${serverKey || "default"}`, []);
      return { ok: true };
    },
    consoleLogReveal: async () => ({ ok: false, error: "浏览器版本不支持打开本地目录" }),
    // 聊天记录：Web 版同样落 localStorage
    chatLogAppend: async (serverKey, msgs) => {
      const key = `rustadmin.chatLog.${serverKey || "default"}`;
      const list = readJson(key, []);
      const arr = Array.isArray(list) ? list : [];
      (Array.isArray(msgs) ? msgs : [msgs]).forEach((m) => arr.push(m));
      writeJson(key, arr.slice(-2000));
      return { ok: true };
    },
    chatLogClear: async (serverKey) => {
      writeJson(`rustadmin.chatLog.${serverKey || "default"}`, []);
      return { ok: true };
    },
    chatLogReveal: async () => ({ ok: false, error: "浏览器版本不支持打开本地目录" }),
    deleteBanEntry: async () => ({ ok: false, error: "浏览器版本不支持删除本地封禁规则" }),
    deleteOfflinePlayer: async () => ({ ok: false, error: "浏览器版本不支持删除离线记录" }),
    saveChatExport: async (serverKey, content) => {
      try {
        const blob = new Blob([String(content || "")], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `chat_${String(serverKey || "default").replace(/[^a-zA-Z0-9_.\-]/g, "_")}.txt`;
        a.click();
        return { ok: true };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    getAutoSaveStatus: async () => ({ ok: true, time: Date.now(), intervalMs: 60000 }),
    runAutoSaveNow: async () => ({ ok: true, time: Date.now() }),
    onAutoSaveTick: () => {},

    serverSetHostname: async (name) => rustAPI.rconCommand(`server.hostname "${String(name || "").replace(/"/g, '\\"')}"`),
    serverSetWeather: async (w) => {
      const map = {
        clear: "weather.load Clear",
        cloudy: "weather.load Overcast",
        wind: "weather.wind 1",
        fog: "weather.load Fog",
        storm: "weather.load Storm",
        default: "weather.reset",
      };
      return rustAPI.rconCommand(map[w] || `weather.${w}`);
    },
    serverSetTime: async (t) => rustAPI.rconCommand(`env.time ${t}`),
    serverTeamLimit: async (n) => rustAPI.rconCommand(`server.maxteamsize ${n}`),
    serverSetMaxplayers: async (n) => rustAPI.rconCommand(`server.maxplayers ${n}`),
    serverNpcEnabled: async (enabled) => rustAPI.rconCommand(`global.npc_enabled ${enabled ? "true" : "false"}`),
    serverCombatLog: async (size) => rustAPI.rconCommand(`server.combatlogsize ${size}`),
    serverSave: async () => rustAPI.rconCommand("server.save"),
    serverWriteCfg: async () => rustAPI.rconCommand("server.writecfg"),
    serverStatus: async () => rustAPI.rconCommand("status"),
    serverInfo: async () => rustAPI.rconCommand("server.info"),
    serverGetConvars: async () => ({ ok: true, values: {} }),
    serverSetConvar: async (name, value) => rustAPI.rconCommand(`${name} "${String(value || "").replace(/"/g, '\\"')}"`),

    playerGrant: async (perm, steamid) => {
      const p = String(perm || "").trim();
      const s = String(steamid || "").trim();
      if (!p || !s) return { ok: false, error: "参数无效" };
      return rustAPI.rconCommand(`oxide.grant user ${s} ${p}`);
    },
    playerRevoke: async (perm, steamid) => {
      const p = String(perm || "").trim();
      const s = String(steamid || "").trim();
      if (!p || !s) return { ok: false, error: "参数无效" };
      return rustAPI.rconCommand(`oxide.revoke user ${s} ${p}`);
    },
    playerGrantAll: async () => ({ ok: false, error: "Android 版本暂不支持该功能" }),
    playerRevokeAll: async () => ({ ok: false, error: "Android 版本暂不支持该功能" }),
    playerAddGroup: async () => ({ ok: false, error: "Android 版本暂不支持该功能" }),
    playerRemoveGroup: async () => ({ ok: false, error: "Android 版本暂不支持该功能" }),
    playerGiveCurrency: async () => ({ ok: false, error: "Android 版本暂不支持该功能" }),
    playerDeductCurrency: async () => ({ ok: false, error: "Android 版本暂不支持该功能" }),
    playerGivePoints: async () => ({ ok: false, error: "Android 版本暂不支持该功能" }),
    playerDeductPoints: async () => ({ ok: false, error: "Android 版本暂不支持该功能" }),

    getUsageLog: async () => readJson(STORAGE_KEYS.usageLog, []),
    exportUsageLog: async () => ({ ok: false, error: "Android 版本不支持导出文件" }),
    clearUsageLog: async () => {
      writeJson(STORAGE_KEYS.usageLog, []);
      return { ok: true };
    },

    devVerifyPassword: async () => ({ ok: false, error: "Android 版本不支持开发者验证" }),
    devSaveConfig: async () => ({ ok: false, error: "Android 版本不支持此功能" }),
    devGetConfig: async () => ({ qqBotUrl: "", hasReportedFirstUse: false }),
    devTestQqBot: async () => ({ ok: false, error: "Android 版本不支持此功能" }),

    getLogs: async () => [],
    readLog: async () => "",
    openLogsFolder: async () => {},

    getCustomCommands: async () => readJson(STORAGE_KEYS.customCommands, []),
    saveCustomCommands: async (cmds) => {
      writeJson(STORAGE_KEYS.customCommands, Array.isArray(cmds) ? cmds : []);
      return true;
    },
    getRustNews: async () => [],

    onRconStatus: (cb) => addListener("status", cb),
    onRconServerMeta: (cb) => addListener("serverMeta", cb),
    onRconConsole: (cb) => addListener("console", cb),
    onRconChat: (cb) => addListener("chat", cb),
    onRconReconnecting: (cb) => addListener("reconnecting", cb),
  };

  document.addEventListener("DOMContentLoaded", () => {
    document.body.classList.add("android-runtime");
  });

  window.rustAPI = rustAPI;
})();
