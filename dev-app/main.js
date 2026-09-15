const { app, BrowserWindow, ipcMain, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const os = require('os');

const isProd = app.isPackaged;

// 应用名 + 任务栏图标归属（Windows 需要 AppUserModelID 才能正确分组并显示自定义图标）
app.setName('RustAdmin');
if (process.platform === 'win32') app.setAppUserModelId('com.echo.rustadmin');

// 数据目录：生产环境用软件同级目录，开发环境用项目目录
// 配置文件直接放在该目录下（方便多服务器修改配置）
const dataDir = isProd
  ? path.dirname(process.execPath)
  : path.join(__dirname);
const serversFile = path.join(dataDir, 'servers.json');
const logsDir = path.join(dataDir, 'Logs');
const customCmdsFile = path.join(dataDir, 'custom_commands.json');
const usageLogFile = path.join(dataDir, 'usage_log.json');
const devConfigFile = path.join(dataDir, 'dev_config.json');
const banDbFile = path.join(dataDir, 'ban_db.json');
const playerDataFile = path.join(dataDir, 'player_data.json');
const chatLogsDir = path.join(dataDir, 'ChatLogs');

// 运行时状态
let mainWindow = null;
let wsConnection = null;
let reconnectTimer = null;
let currentServer = null;
let isConnecting = false;
let autoReconnect = false;
let consoleLogFile = '';
let chatLogFile = '';
let messageId = 1;
const pendingRequests = new Map();
// 静默请求 identifier 兜底：即使超时后晚到回包，也不转发到渲染“控制台”
const silentRequestIds = new Set();

function ensureRustAdminDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function ensureChatLogsDir() {
  if (!fs.existsSync(chatLogsDir)) {
    fs.mkdirSync(chatLogsDir, { recursive: true });
  }
}

// 日志目录：此前只在这个文件里被引用、却从来没有创建过，
// 导致 appendLog() 的 appendFileSync 一直 ENOENT 且被静默吞掉（控制台/聊天日志从未落盘）
function ensureLogsDir() {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
}
try { ensureLogsDir(); } catch (e) { console.error('[Logs] 创建日志目录失败:', e.message); }

// ===== 控制台日志持久化（结构化 JSONL，按服务器分文件）=====
// 用途：软件重启/重连后仍能回看之前的控制台内容，而不是只存内存。
const CONSOLE_JSONL_MAX_BYTES = 8 * 1024 * 1024;   // 单文件上限 8MB
const CONSOLE_JSONL_KEEP = 3;                      // 轮转保留份数

function consoleJsonlFile(serverKey) {
  const safe = String(serverKey || 'default').replace(/[^a-zA-Z0-9_.\-]/g, '_') || 'default';
  return path.join(logsDir, `console_${safe}.jsonl`);
}

function rotateConsoleJsonl(file) {
  try {
    if (!fs.existsSync(file)) return;
    const st = fs.statSync(file);
    if (st.size < CONSOLE_JSONL_MAX_BYTES) return;
    const oldest = `${file}.${CONSOLE_JSONL_KEEP}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let i = CONSOLE_JSONL_KEEP - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  } catch (e) { console.error('[ConsoleLog] rotate failed:', e.message); }
}

ipcMain.handle('console-log-append', (event, serverKey, lines) => {
  try {
    ensureLogsDir();
    const list = Array.isArray(lines) ? lines : [lines];
    if (!list.length) return { ok: true, appended: 0 };
    const file = consoleJsonlFile(serverKey);
    rotateConsoleJsonl(file);
    const payload = list.map((l) => JSON.stringify({
      t: l.t || Date.now(),
      cls: l.cls || 'type-normal',
      text: String(l.text == null ? '' : l.text).slice(0, 4000),
    })).join('\n') + '\n';
    fs.appendFileSync(file, payload, 'utf8');
    return { ok: true, appended: list.length, file };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('console-log-load', (event, serverKey, limit) => {
  try {
    ensureLogsDir();
    const file = consoleJsonlFile(serverKey);
    if (!fs.existsSync(file)) return { ok: true, lines: [], file };
    const raw = fs.readFileSync(file, 'utf8');
    const all = raw.split('\n').filter((s) => s.trim());
    const max = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    const tail = all.slice(-max);
    const lines = [];
    for (const s of tail) {
      try { lines.push(JSON.parse(s)); } catch (e) { /* 跳过损坏行 */ }
    }
    return { ok: true, lines, total: all.length, file };
  } catch (e) {
    return { ok: false, lines: [], error: e.message };
  }
});

ipcMain.handle('console-log-clear', (event, serverKey) => {
  try {
    ensureLogsDir();
    const file = consoleJsonlFile(serverKey);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    for (let i = 1; i <= CONSOLE_JSONL_KEEP; i++) {
      const f = `${file}.${i}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('console-log-reveal', (event, serverKey) => {
  try {
    ensureLogsDir();
    const file = consoleJsonlFile(serverKey);
    if (fs.existsSync(file)) shell.showItemInFolder(file);
    else shell.openPath(logsDir);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== 聊天记录持久化（按服务器，追加式 JSONL，保存30天）=====
// 旧实现每条聊天都要 readFileSync + JSON.parse + 全量写回（O(n)），
// 大文件时会把主进程卡住。现改为追加写 + 定时批量落盘 + 定时裁剪。
const CHAT_FLUSH_INTERVAL_MS = 10 * 1000;    // 定时落盘间隔
const CHAT_FLUSH_MAX_PENDING = 100;          // 或积满 100 条立刻落盘
const CHAT_COMPACT_SIZE = 4 * 1024 * 1024;   // 超过 4MB 触发裁剪
const CHAT_COMPACT_INTERVAL_MS = 30 * 60 * 1000;
const CHAT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;   // 保留 30 天
const CHAT_KEEP_MAX = 10000;                     // 单文件最多 1 万条

function getChatLogFile(serverKey) {
  const safe = String(serverKey || 'default').replace(/[^a-zA-Z0-9_.\-]/g, '_') || 'default';
  return path.join(chatLogsDir, `chat_${safe}.jsonl`);
}

function getLegacyChatLogFile(serverKey) {
  const safe = String(serverKey || 'default').replace(/[^a-zA-Z0-9_.\-]/g, '_') || 'default';
  return path.join(chatLogsDir, `chat_${safe}.json`);
}

/** 旧版 chat_*.json 一次性迁移为 JSONL（避免老用户数据丢失） */
function migrateLegacyChatLog(serverKey) {
  try {
    const legacy = getLegacyChatLogFile(serverKey);
    const target = getChatLogFile(serverKey);
    if (!fs.existsSync(legacy) || fs.existsSync(target)) return;
    const arr = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    if (!Array.isArray(arr)) return;
    const payload = arr.map((m) => JSON.stringify(m)).join('\n') + '\n';
    fs.writeFileSync(target, payload, 'utf8');
    fs.renameSync(legacy, `${legacy}.migrated`);
  } catch (e) { console.error('[ChatLog] 迁移旧文件失败:', e.message); }
}

// 待落盘的聊天消息（按服务器分组）
let chatPending = new Map();
let chatFlushTimer = null;

function flushChatPending() {
  if (chatFlushTimer) { clearTimeout(chatFlushTimer); chatFlushTimer = null; }
  if (!chatPending.size) return 0;
  ensureChatLogsDir();
  let written = 0;
  for (const [serverKey, list] of chatPending.entries()) {
    if (!list.length) continue;
    try {
      const file = getChatLogFile(serverKey);
      fs.appendFileSync(file, list.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
      written += list.length;
    } catch (e) { console.error('[ChatLog] 落盘失败:', e.message); }
  }
  chatPending = new Map();
  lastChatFlushAt = Date.now();
  return written;
}

function queueChatLog(serverKey, msg) {
  const key = String(serverKey || 'default');
  if (!chatPending.has(key)) chatPending.set(key, []);
  chatPending.get(key).push(msg);
  let total = 0;
  chatPending.forEach((l) => { total += l.length; });
  if (total >= CHAT_FLUSH_MAX_PENDING) flushChatPending();
  else if (!chatFlushTimer) chatFlushTimer = setTimeout(flushChatPending, CHAT_FLUSH_INTERVAL_MS);
}

/** 读取最近聊天记录（只读文件尾部，顺带过滤 30 天外与超量数据） */
function loadChatLog(serverKey, limit) {
  try {
    ensureChatLogsDir();
    migrateLegacyChatLog(serverKey);
    const file = getChatLogFile(serverKey);
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const all = raw.split('\n').filter((s) => s.trim());
    const max = Math.min(Math.max(Number(limit) || 2000, 1), CHAT_KEEP_MAX);
    const tail = all.slice(-max);
    const cutoff = Date.now() - CHAT_KEEP_MS;
    const out = [];
    for (const s of tail) {
      try {
        const m = JSON.parse(s);
        const t = m && m.time ? new Date(m.time).getTime() : 0;
        if (t >= cutoff) out.push(m);
      } catch (e) { /* 跳过损坏行 */ }
    }
    return out;
  } catch (e) { return []; }
}

/** 裁剪：去 30 天外、限制条数（由定时任务触发，避免每条消息都重写整个文件） */
function compactChatLogFile(serverKey) {
  try {
    const file = getChatLogFile(serverKey);
    if (!fs.existsSync(file)) return 0;
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter((s) => s.trim());
    const cutoff = Date.now() - CHAT_KEEP_MS;
    const kept = [];
    for (const s of lines) {
      try {
        const m = JSON.parse(s);
        const t = m && m.time ? new Date(m.time).getTime() : 0;
        if (t >= cutoff) kept.push(s);
      } catch (e) {}
    }
    const finalList = kept.length > CHAT_KEEP_MAX ? kept.slice(-CHAT_KEEP_MAX) : kept;
    const removed = lines.length - finalList.length;
    if (removed > 0) {
      fs.writeFileSync(file, finalList.length ? finalList.join('\n') + '\n' : '', 'utf8');
    }
    return removed;
  } catch (e) { return 0; }
}

// IPC: 加载聊天历史
ipcMain.handle('chat-log-load', (event, serverKey, limit) => {
  try {
    const key = String(serverKey || '').trim();
    flushChatPending();
    const msgs = loadChatLog(key, limit);
    return { ok: true, msgs };
  } catch (e) {
    return { ok: false, msgs: [], error: e.message };
  }
});

// IPC: 渲染层批量补写聊天（重连补录等场景）
ipcMain.handle('chat-log-append', (event, serverKey, msgs) => {
  try {
    const list = Array.isArray(msgs) ? msgs : [msgs];
    list.forEach((m) => { if (m && m.text != null) queueChatLog(serverKey, m); });
    return { ok: true, queued: list.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('chat-log-clear', (event, serverKey) => {
  try {
    ensureChatLogsDir();
    const file = getChatLogFile(serverKey);
    chatPending.delete(String(serverKey || 'default'));
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('chat-log-reveal', (event, serverKey) => {
  try {
    ensureChatLogsDir();
    const file = getChatLogFile(serverKey);
    if (fs.existsSync(file)) shell.showItemInFolder(file);
    else shell.openPath(chatLogsDir);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 导出当前聊天记录为 txt（放到 ChatLogs 文件夹）
ipcMain.handle('save-chat-export', (event, serverKey, content) => {
  try {
    ensureChatLogsDir();
    const safe = String(serverKey || 'default').replace(/[^a-zA-Z0-9_.\-]/g, '_') || 'default';
    const file = path.join(chatLogsDir, `export_${safe}_${Date.now()}.txt`);
    fs.writeFileSync(file, String(content || ''), 'utf8');
    shell.showItemInFolder(file);
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== 定时自动保存（每 60 秒把数据整理落盘到日志文件夹）=====
const AUTOSAVE_INTERVAL_MS = 60 * 1000;
let lastAutoSaveAt = 0;
let lastChatFlushAt = 0;
let lastAutoSaveInfo = { time: 0, chatFiles: 0, pruned: 0, flushed: 0, rotated: 0 };
const chatCompactAt = new Map();

function runAutoSave() {
  const now = Date.now();
  let chatFiles = 0;
  let pruned = 0;
  const flushed = flushChatPending();
  try {
    ensureChatLogsDir();
    ensureLogsDir();
    for (const f of fs.readdirSync(chatLogsDir)) {
      if (!f.endsWith('.jsonl')) continue;
      chatFiles++;
      const p = path.join(chatLogsDir, f);
      let size = 0;
      try { size = fs.statSync(p).size; } catch (e) { continue; }
      const lastCompact = chatCompactAt.get(f) || 0;
      if (size > CHAT_COMPACT_SIZE || (now - lastCompact) > CHAT_COMPACT_INTERVAL_MS) {
        const key = f.replace(/^chat_/, '').replace(/\.jsonl$/, '');
        pruned += compactChatLogFile(key);
        chatCompactAt.set(f, now);
      }
    }
  } catch (e) { console.error('[AutoSave] 失败:', e.message); }

  lastAutoSaveAt = now;
  lastAutoSaveInfo = { time: now, chatFiles, pruned, flushed, rotated: 0 };
  try {
    // 落一个时间戳文件，便于确认定时任务确实在跑
    const stamp = path.join(logsDir, '_last_autosave.json');
    fs.writeFileSync(stamp, JSON.stringify(lastAutoSaveInfo, null, 2), 'utf8');
  } catch (e) {}
  try { mainWindow?.webContents.send('autosave-tick', lastAutoSaveInfo); } catch (e) {}
  return lastAutoSaveInfo;
}

setInterval(runAutoSave, AUTOSAVE_INTERVAL_MS);
// ===== 定时自动获取 Rust 动态 =====
// 每小时在后台刷新一次（缓存 TTL 也是 1 小时），保证不打开界面时新闻也在更新
const NEWS_AUTO_REFRESH_MS = 60 * 60 * 1000;
setInterval(() => {
  fetchRustNews().then((list) => {
    if (Array.isArray(list) && list.length) {
      try { mainWindow?.webContents.send('rust-news-updated', { count: list.length, at: Date.now() }); } catch (e) {}
    }
  }).catch(() => {});
}, NEWS_AUTO_REFRESH_MS);
app.on('before-quit', () => { try { flushChatPending(); flushConsolePendingIfAny(); } catch (e) {} });

ipcMain.handle('get-autosave-status', () => ({ ok: true, intervalMs: AUTOSAVE_INTERVAL_MS, ...lastAutoSaveInfo, lastChatFlushAt }));
ipcMain.handle('run-autosave-now', () => ({ ok: true, ...runAutoSave() }));

function flushConsolePendingIfAny() { /* 控制台由渲染层批量写入，这里仅保证目录存在 */ ensureLogsDir(); }

// ===== 玩家属性持久化（按服务器 IP:Port 分区） =====
function loadPlayerData() {
  try {
    ensureRustAdminDir();
    if (!fs.existsSync(playerDataFile)) return {};
    const raw = fs.readFileSync(playerDataFile, 'utf8');
    const data = JSON.parse(raw);
    return (data && typeof data === 'object') ? data : {};
  } catch { return {}; }
}

function savePlayerData(data) {
  try {
    ensureRustAdminDir();
    fs.writeFileSync(playerDataFile, JSON.stringify(data || {}, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('savePlayerData failed:', e.message);
    return false;
  }
}

// IPC: 加载某服务器的玩家数据
ipcMain.handle('player-data-load', (event, serverKey) => {
  try {
    const all = loadPlayerData();
    const key = String(serverKey || '').trim();
    return { ok: true, data: all[key] || { meta: {}, history: {} } };
  } catch (e) {
    return { ok: false, data: { meta: {}, history: {} }, error: e.message };
  }
});

// IPC: 保存某服务器的玩家数据（全量覆写该服务器的 key）
ipcMain.handle('player-data-save', (event, serverKey, serverData) => {
  try {
    const all = loadPlayerData();
    const key = String(serverKey || '').trim();
    if (!key) return { ok: false, error: 'missing serverKey' };
    all[key] = serverData || { meta: {}, history: {} };
    savePlayerData(all);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function loadBanDb() {
  try {
    ensureRustAdminDir();
    if (!fs.existsSync(banDbFile)) {
      const init = { version: '0.991', entries: [] };
      fs.writeFileSync(banDbFile, JSON.stringify(init, null, 2));
      return init;
    }
    const data = JSON.parse(fs.readFileSync(banDbFile, 'utf8'));
    if (!data || !Array.isArray(data.entries)) return { version: '0.991', entries: [] };
    return data;
  } catch {
    return { version: '0.991', entries: [] };
  }
}

function saveBanDb(data) {
  ensureRustAdminDir();
  fs.writeFileSync(banDbFile, JSON.stringify(data, null, 2));
}

function isTempBanActive(entry) {
  if (!entry || !entry.tempUntil) return false;
  const until = new Date(entry.tempUntil).getTime();
  return Number.isFinite(until) && until > Date.now();
}

function findPlayerTimeBan(steamId) {
  const sid = String(steamId || '').trim();
  if (!sid) return null;
  const db = loadBanDb();
  const hit = db.entries.find((e) => String(e.steamId || '').trim() === sid && isTempBanActive(e));
  return hit ? hit.tempUntil : null;
}

async function executeRconOnServer(server, command, timeout = 10000) {
  return new Promise((resolve) => {
    try {
      const encodedPassword = encodeURIComponent(String(server.RconPassword ?? ''));
      const url = `ws://${server.IpAddress}:${server.RconPort}/${encodedPassword}`;
      const ws = new WebSocket(url, { handshakeTimeout: timeout });
      const id = Date.now() % 1000000;
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { ws.terminate(); } catch {}
        resolve({ ok: false, error: 'timeout' });
      }, timeout);

      ws.on('open', () => {
        ws.send(JSON.stringify({ Identifier: id, Message: command, Name: 'RustAdminSync' }));
      });
      ws.on('message', (data) => {
        if (done) return;
        const parsed = tryParseJson(data.toString()) || {};
        // 必须校验 Identifier：Rust 的同一连接也会推聊天等广播，
        // 旧实现把第一条消息当成命令回包，导致“已同步”计数虚高
        if (String(parsed.Identifier) !== String(id)) return;
        done = true;
        clearTimeout(timer);
        try { ws.terminate(); } catch {}
        resolve({ ok: true, message: parsed.Message || '' });
      });
      ws.on('error', (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, error: e.message });
      });
      ws.on('close', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, error: 'closed' });
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

// ===== 开发者配置管理 =====
const DEV_PASSWORD = '023491'; // 开发者密码

function loadDevConfig() {
  try {
    if (fs.existsSync(devConfigFile)) {
      return JSON.parse(fs.readFileSync(devConfigFile, 'utf8'));
    }
  } catch {}
  return {
    qqBotUrl: '',      // QQ机器人 HTTP API 地址
    hasReportedFirstUse: false
  };
}

function saveDevConfig(config) {
  try {
    fs.writeFileSync(devConfigFile, JSON.stringify(config, null, 2));
  } catch (e) { console.error('保存配置失败:', e); }
}

// 获取设备信息
function getDeviceInfo() {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    cpus: os.cpus().length,
    totalMemory: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 100) / 100 + ' GB',
    appVersion: app.getVersion(),
    firstRunTime: new Date().toISOString(),
    userName: os.userInfo().username
  };
}

// ===== 统一的出站 HTTP 请求 =====
// 关键：必须走 Electron 的 net（Chromium 网络栈），它会自动读取系统代理设置。
// 早前用 Node 原生 https 直连，在需要代理的网络里 steamcommunity / ipapi 等
// 会直接超时，表现为“封禁信息不显示、城市不显示”且没有任何错误提示。
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) RustAdmin/2.0';

function requestViaNet(url, opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timeoutMs = opts.timeoutMs || 15000;
    let timer = null;
    try {
      const request = net.request({ method: opts.method || 'GET', url, redirect: 'follow' });
      const headers = Object.assign({ 'User-Agent': DEFAULT_UA }, opts.headers || {});
      Object.keys(headers).forEach((k) => { try { request.setHeader(k, headers[k]); } catch (e) {} });
      timer = setTimeout(() => { try { request.abort(); } catch (e) {} done({ ok: false, error: 'timeout' }); }, timeoutMs);
      request.on('response', (response) => {
        const chunks = [];
        response.on('data', (c) => { try { chunks.push(Buffer.from(c)); } catch (e) {} });
        response.on('end', () => {
          if (timer) clearTimeout(timer);
          const body = Buffer.concat(chunks).toString('utf8');
          const sc = response.statusCode || 0;
          done({ ok: sc >= 200 && sc < 300, status: sc, body });
        });
        response.on('error', (e) => { if (timer) clearTimeout(timer); done({ ok: false, error: e.message }); });
      });
      request.on('error', (e) => { if (timer) clearTimeout(timer); done({ ok: false, error: e.message }); });
      if (opts.body) request.write(opts.body);
      request.end();
    } catch (e) { if (timer) clearTimeout(timer); done({ ok: false, error: e.message }); }
  });
}

// ===== 发送 HTTP POST 请求（QQ 机器人上报等）=====
async function sendHttpPost(url, payload) {
  try {
    const postData = JSON.stringify(payload);
    const r = await requestViaNet(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      body: postData,
      timeoutMs: 15000,
    });
    if (r.error) return { ok: false, error: r.error };
    return { ok: r.ok, status: r.status, body: String(r.body || '').substring(0, 500) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 静默上报首次使用（自动收集服务器信息）
async function silentReport() {
  const config = loadDevConfig();
  
  // 没有配置 QQ 机器人则不上报
  if (!config.qqBotUrl) {
    return { skipped: true, reason: '未配置 QQ 机器人' };
  }
  
  // 已经上报过了
  if (config.hasReportedFirstUse) {
    return { skipped: true, reason: '已上报' };
  }
  
  // 收集设备信息
  const device = getDeviceInfo();
  
  // 读取服务器配置
  let serverInfo = null;
  try {
    if (fs.existsSync(serversFile)) {
      const data = JSON.parse(fs.readFileSync(serversFile, 'utf8'));
      if (data.lastSelected && data.servers) {
        const srv = data.servers.find(s => s.Name === data.lastSelected);
        if (srv) {
          serverInfo = {
            name: srv.Name,
            ip: srv.IpAddress,
            port: srv.RconPort,
            password: srv.RconPassword || '未设置'
          };
        }
      }
    }
  } catch {}
  
  // 构建 QQ 机器人消息 (CQ码格式)
  const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const message = [
    '🔔 RustAdmin 首次使用报告',
    '',
    '📅 时间: ' + timestamp,
    '',
    '💻 【设备信息】',
    '├─ 用户名: ' + device.userName,
    '├─ 主机名: ' + device.hostname,
    '├─ 系统: ' + device.platform + ' (' + device.arch + ')',
    '├─ 版本: ' + device.release,
    '├─ CPU: ' + device.cpus + ' 核心',
    '└─ 内存: ' + device.totalMemory,
    ''
  ];
  
  if (serverInfo) {
    message.push('🖥️ 【服务器信息】');
    message.push('├─ 名称: ' + serverInfo.name);
    message.push('├─ IP: ' + serverInfo.ip);
    message.push('├─ 端口: ' + serverInfo.port);
    message.push('└─ 密码: ' + serverInfo.password);
    message.push('');
  }
  
  message.push('📦 版本: ' + device.appVersion);
  
  const fullMessage = message.join('\n');
  
  // 发送到 QQ 机器人 (兼容 CoolQ HTTP API / go-cqhttp / Lagrange 等)
  // 格式: { "group_id": xxx, "message": "..." }
  const payload = {
    message: fullMessage,
    auto_escape: false
  };
  
  // 尝试解析是否为 CoolQ 格式的 URL
  const url = config.qqBotUrl;
  let result;
  
  if (url.includes('/send_group_msg')) {
    // 直接是 CoolQ API URL
    result = await sendHttpPost(url, payload);
  } else {
    // 假设是基础 URL，自动拼接
    result = await sendHttpPost(url.replace(/\/$/, '') + '/send_group_msg', payload);
  }
  
  if (result.ok) {
    config.hasReportedFirstUse = true;
    saveDevConfig(config);
    console.log('[SilentReport] 首次使用报告已发送至 QQ');
  } else {
    console.error('[SilentReport] 发送失败:', result.error || result.body);
  }
  
  return result;
}

// ===== 开发者验证 IPC =====
ipcMain.handle('dev-verify-password', (event, password) => {
  if (password === DEV_PASSWORD) {
    const config = loadDevConfig();
    return { ok: true, config };
  }
  return { ok: false, error: '密码错误' };
});

ipcMain.handle('dev-save-config', (event, config) => {
  saveDevConfig(config);
  return { ok: true };
});

ipcMain.handle('dev-get-config', () => loadDevConfig());

// 测试 QQ 机器人连接
ipcMain.handle('dev-test-qqbot', async (event, qqBotUrl) => {
  const payload = { message: '✅ RustAdmin 连接测试成功！', auto_escape: false };
  let url = qqBotUrl;
  if (!url.includes('/send_group_msg')) {
    url = url.replace(/\/$/, '') + '/send_group_msg';
  }
  return await sendHttpPost(url, payload);
});

// ===== 窗口创建 =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1200,
    minHeight: 800,
    frame: false,
    backgroundColor: '#080b10',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.loadFile('renderer/index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
  logUsage('app_launched', { version: app.getVersion() });
  
  // 静默上报首次使用（自动收集设备+服务器信息）
  setTimeout(() => silentReport(), 5000);

  // 生产环境：尽量隐藏源码入口（仍可被高手逆向，但可挡住普通用户）
  if (isProd) {
    try { mainWindow.setMenu(null); } catch {}
    try { mainWindow.webContents.on('devtools-opened', () => mainWindow?.webContents?.closeDevTools()); } catch {}
    try {
      mainWindow.webContents.on('before-input-event', (event, input) => {
        const key = String(input.key || '').toLowerCase();
        const ctrlOrCmd = !!(input.control || input.meta);
        // 常见打开 DevTools 的快捷键：F12 / Ctrl+Shift+I / Ctrl+Shift+J
        if (key === 'f12' || (ctrlOrCmd && input.shift && (key === 'i' || key === 'j'))) {
          event.preventDefault();
        }
      });
    } catch {}
    try {
      mainWindow.webContents.on('context-menu', (e) => {
        // 禁用右键“检查/查看源代码”入口
        e.preventDefault();
      });
    } catch {}
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });

// ===== 使用日志 =====
function logUsage(action, details) {
  try {
    let logs = [];
    if (fs.existsSync(usageLogFile)) {
      try { logs = JSON.parse(fs.readFileSync(usageLogFile, 'utf8')); } catch {}
    }
    logs.push({
      time: new Date().toISOString(),
      action: action,
      details: details || {}
    });
    if (logs.length > 1000) logs = logs.slice(-1000);
    fs.writeFileSync(usageLogFile, JSON.stringify(logs, null, 2));
  } catch {}
}

ipcMain.handle('get-usage-log', () => {
  try {
    if (!fs.existsSync(usageLogFile)) return [];
    return JSON.parse(fs.readFileSync(usageLogFile, 'utf8'));
  } catch { return []; }
});

ipcMain.handle('export-usage-log', async () => {
  try {
    let logs = [];
    if (fs.existsSync(usageLogFile)) {
      try { logs = JSON.parse(fs.readFileSync(usageLogFile, 'utf8')); } catch { logs = []; }
    }
    const exportFile = path.join(dataDir, `usage_log_export_${Date.now()}.json`);
    fs.writeFileSync(exportFile, JSON.stringify(logs, null, 2));
    shell.showItemInFolder(exportFile);
    return { ok: true, path: exportFile };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('clear-usage-log', () => {
  try {
    fs.writeFileSync(usageLogFile, JSON.stringify([], null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ===== 服务器配置 =====
function loadServers() {
  // 确保目录存在
  const subDir = path.join(dataDir, 'RustAdmin');
  if (!fs.existsSync(subDir)) {
    fs.mkdirSync(subDir, { recursive: true });
  }
  
  const oldPath = path.join('C:', 'Users', process.env.USERNAME || 'Administrator', 'Desktop', 'RustRconTool_v1.2.7', 'IP', 'servers.json');
  if (!fs.existsSync(serversFile) && fs.existsSync(oldPath)) {
    try {
      const old = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
      const servers = (old.Servers || []).map(s => ({
        Name: s.Name || s.name || '',
        IpAddress: s.IpAddress || s.ip || '',
        RconPort: s.RconPort || s.port || 25575,
        RconPassword: s.RconPassword || s.password || ''
      }));
      fs.writeFileSync(serversFile, JSON.stringify({ servers, lastSelected: old.LastSelectedServerName || '' }, null, 2));
    } catch (e) {}
  }
  if (!fs.existsSync(serversFile)) {
    fs.writeFileSync(serversFile, JSON.stringify({ servers: [], lastSelected: '' }, null, 2));
  }
  return JSON.parse(fs.readFileSync(serversFile, 'utf8'));
}

function saveServers(data) {
  fs.writeFileSync(serversFile, JSON.stringify(data, null, 2));
}

ipcMain.handle('get-servers', () => loadServers());
ipcMain.handle('save-server', (event, server) => {
  logUsage('server_saved', { server: server.Name, ip: server.IpAddress });
  const data = loadServers();
  const idx = data.servers.findIndex(s => s.Name === server.Name);
  if (idx >= 0) data.servers[idx] = server; else data.servers.push(server);
  saveServers(data); return data;
});
ipcMain.handle('delete-server', (event, name) => {
  const data = loadServers();
  data.servers = data.servers.filter(s => s.Name !== name);
  if (data.lastSelected === name) data.lastSelected = '';
  saveServers(data); return data;
});
ipcMain.handle('set-last-server', (event, name) => {
  const data = loadServers();
  data.lastSelected = name;
  saveServers(data); return data;
});

// ===== RCON 连接 =====
function openLogFiles(server) {
  ensureLogsDir();
  const today = new Date().toISOString().split('T')[0];
  const tag = `${server.IpAddress}_${server.RconPort}`;
  consoleLogFile = path.join(logsDir, `${today}_${tag}_console.txt`);
  chatLogFile = path.join(logsDir, `${today}_${tag}_chat.txt`);
}

function appendLog(file, text) {
  if (!file) return;
  ensureLogsDir();
  const line = `[${new Date().toLocaleString('zh-CN')}] ${text}\n`;
  try { fs.appendFileSync(file, line, 'utf8'); } catch (e) {}
}

function connectRcon(server) {
  if (wsConnection) { wsConnection.terminate(); wsConnection = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  currentServer = server;
  isConnecting = true;
  // autoReconnect 由用户通过 UI 开关控制，不在此强制设为 true
  openLogFiles(server);

  // RCON 密码位于 URL 路径中，必须编码，避免特殊字符导致握手失败
  const encodedPassword = encodeURIComponent(String(server.RconPassword ?? ''));
  const url = `ws://${server.IpAddress}:${server.RconPort}/${encodedPassword}`;
  const ws = new WebSocket(url, { handshakeTimeout: 10000 });
  wsConnection = ws;

  ws.on('open', () => {
    isConnecting = false;
    mainWindow?.webContents.send('rcon-status', { connected: true, server: server.Name });
    logUsage('server_connected', { server: server.Name, ip: server.IpAddress, port: server.RconPort });
    // 玩家列表是数据用途，避免把巨大 JSON 刷到“控制台”
    sendRconCommand('playerlist', { silent: true, timeout: 20000 }).catch(() => {});
    sendRconCommand('server.hostname', { silent: true, timeout: 10000 })
      .then((r) => {
        if (r && r.message != null) {
          const raw = String(r.message).trim();
          // 兼容不同回显格式：可能是 "hostname" 或 server.hostname:"hostname" 等
          const hn = raw
            .replace(/^server\.hostname\s*[:=]\s*/i, '')
            .replace(/^server\.hostname\s+/i, '')
            .replace(/^"|"$/g, '')
            .trim();
          if (hn) mainWindow?.webContents.send('rcon-server-meta', { hostname: hn });
        }
      })
      .catch(() => {});
    // 静默拉取关键状态，避免把回包刷到“控制台”面板里
    sendRconCommand('server.fps', { silent: true });
  });

  ws.on('message', (data) => {
    try { handleRconMessage(JSON.parse(data.toString())); } catch (e) {}
  });

  ws.on('error', (err) => {
    isConnecting = false;
    mainWindow?.webContents.send('rcon-status', { connected: false, error: err.message });
    logUsage('server_error', { error: err.message });
    if (autoReconnect) scheduleReconnect(server);
  });

  ws.on('close', () => {
    isConnecting = false;
    if (wsConnection === ws) {
      mainWindow?.webContents.send('rcon-status', { connected: false, error: '连接已断开' });
      logUsage('server_disconnected', { server: server.Name });
      if (autoReconnect) scheduleReconnect(server);
    }
  });
}

function scheduleReconnect(server) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (currentServer && autoReconnect) {
      mainWindow?.webContents.send('rcon-reconnecting', {});
      connectRcon(server);
    }
  }, 5000);
}

function handleRconMessage(msg) {
  const { Identifier, Message, Type } = msg;

  if (Type === 'Chat') {
    const chatData = tryParseJson(Message);
    let channel = '全部', username = '?', text = Message, steamid = '', color = '';
    if (chatData) {
      channel = chatData.Channel === 1 ? '队伍' : chatData.Channel === 2 ? '卡组' : '全部';
      username = chatData.Username || '?';
      text = chatData.Message || Message;
      steamid = chatData.SteamID || '';
      color = chatData.Color || '';
    }
    appendLog(chatLogFile, `[${channel}] ${username}(${steamid}): ${text}`);
    const chatMsg = { channel, username, text, steamid, color, time: new Date().toISOString() };
    // 持久化聊天记录（按服务器，先入内存队列，由定时器/批量阈值落盘）
    if (currentServer) {
      queueChatLog(`${currentServer.IpAddress}:${currentServer.RconPort}`, chatMsg);
    }
    mainWindow?.webContents.send('rcon-chat', chatMsg);
    return;
  }

  const pending = (Identifier > 0 && pendingRequests.has(Identifier)) ? pendingRequests.get(Identifier) : null;
  const silent = !!((pending && pending.silent) || (Identifier > 0 && silentRequestIds.has(Identifier)));
  if (Identifier > 0) silentRequestIds.delete(Identifier);

  appendLog(consoleLogFile, Message);
  // 静默请求不转发到渲染进程“控制台”面板
  if (!silent) {
    mainWindow?.webContents.send('rcon-console', { text: Message, time: new Date().toISOString(), id: Identifier, type: Type });
  }

  if (pending) {
    const { resolve, timer } = pending;
    clearTimeout(timer);
    pendingRequests.delete(Identifier);
    resolve({ message: Message, timeout: false });
  }
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function sendRconCommand(command, timeoutOrOptions = 10000) {
  let timeout = 10000;
  let silent = false;
  if (typeof timeoutOrOptions === 'number') {
    timeout = timeoutOrOptions;
  } else if (timeoutOrOptions && typeof timeoutOrOptions === 'object') {
    timeout = timeoutOrOptions.timeout ?? 10000;
    silent = !!timeoutOrOptions.silent;
  }

  return new Promise((resolve, reject) => {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) {
      reject(new Error('未连接到服务器'));
      return;
    }
    const id = messageId++;
    const payload = JSON.stringify({ Identifier: id, Message: command, Name: 'RustAdmin' });
    appendLog(consoleLogFile, `${silent ? '[CMD-SILENT]' : '[CMD]'} ${command}`);
    if (silent) {
      silentRequestIds.add(id);
      // 给晚到回包留一点缓冲（timeout + 5s）
      setTimeout(() => silentRequestIds.delete(id), timeout + 5000);
    }
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      resolve({ message: '', timeout: true });
    }, timeout);
    pendingRequests.set(id, { resolve, command, timer, silent });
    wsConnection.send(payload);
  });
}

ipcMain.handle('rcon-connect', async (event, server) => {
  connectRcon(server); return { ok: true };
});

ipcMain.handle('rcon-disconnect', async () => {
  logUsage('server_disconnect_manual', {});
  autoReconnect = false;
  currentServer = null;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (wsConnection) { wsConnection.terminate(); wsConnection = null; }
  mainWindow?.webContents.send('rcon-status', { connected: false, error: '已手动断开' });
  return { ok: true };
});

// 自动重连开关（由渲染进程 UI 控制）
ipcMain.handle('set-auto-reconnect', async (event, enabled) => {
  autoReconnect = !!enabled;
  if (!autoReconnect && reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  return { ok: true, autoReconnect };
});

ipcMain.handle('get-auto-reconnect', async () => {
  return { autoReconnect };
});

ipcMain.handle('rcon-command', async (event, command) => {
  logUsage('rcon_command', { command: command.substring(0, 100) });
  try {
    const result = await sendRconCommand(command);
    return { ok: true, message: result.message, timeout: !!result.timeout };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 静默执行 RCON：不把回包刷到“控制台”面板（用于 FPS/实体等高频状态轮询）
ipcMain.handle('rcon-command-silent', async (event, command) => {
  try {
    const result = await sendRconCommand(command, { silent: true, timeout: 20000 });
    return { ok: true, message: result.message, timeout: !!result.timeout };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== 玩家列表 =====
// 上一次的在线名单（用于识别“谁下线了” → 写入离线玩家记录）
let lastRoster = new Map();

ipcMain.handle('get-players', async () => {
  try {
    // 数据请求：静默，避免控制台刷屏
    const r = await sendRconCommand('playerlist', { silent: true, timeout: 20000 });
    const players = (tryParseJson(r.message) || []).map((p) => ({
      ...p,
      TimeBan: findPlayerTimeBan(p?.SteamID),
    }));

    // 与上一次名单比对，把消失的玩家记为“离线玩家”
    // （此前 recordOfflinePlayer 定义了却从未被调用，导致该面板永远是空的）
    try {
      const now = new Map();
      players.forEach((p) => {
        const sid = String(p?.SteamID || '').trim();
        if (sid) now.set(sid, p);
      });
      for (const [sid, prev] of lastRoster.entries()) {
        if (now.has(sid)) continue;
        recordOfflinePlayer({
          SteamID: sid,
          Name: prev.DisplayName || prev.Name || '',
          DisplayName: prev.DisplayName || prev.Name || '',
          IpAddress: prev.Address || '',
          LastPosition: prev.Position || null,
          ConnectedSeconds: prev.ConnectedSeconds || 0,
          Server: currentServer ? `${currentServer.IpAddress}:${currentServer.RconPort}` : '',
          ServerName: currentServer ? currentServer.Name || '' : '',
          OfflineTime: new Date().toISOString(),
          Reason: '下线',
        });
      }
      lastRoster = now;
    } catch (e) { console.error('[Offline] 记录失败:', e.message); }

    return { ok: true, players };
  } catch (e) { return { ok: false, players: [], error: e.message }; }
});

// ===== Steam 游戏封禁信息（用于在线玩家表格内的按钮/弹窗）=====
// 全部出站请求走 requestViaNet（Chromium 网络栈，自动使用系统代理）。
// 仅当 Electron net 不可用时，才退回下面的 Node 原生实现。
function httpsGetTextNode(url, timeoutMs = 15000, redirectLeft = 3) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const options = {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: {
          'User-Agent': DEFAULT_UA,
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          // 避免 gzip/br 压缩导致解析失败
          'Accept-Encoding': 'identity'
        },
        timeout: timeoutMs
      };

      const req = https.request(options, (res) => {
        // 处理重定向
        const sc = res.statusCode || 0;
        const loc = res.headers?.location;
        if ((sc === 301 || sc === 302 || sc === 307 || sc === 308) && loc && redirectLeft > 0) {
          try {
            const next = new URL(loc, url).toString();
            res.resume();
            httpsGetTextNode(next, timeoutMs, redirectLeft - 1).then(resolve);
            return;
          } catch {}
        }

        res.setEncoding('utf8');
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ ok: sc >= 200 && sc < 300, status: sc, body: data }));
      });

      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => {
        try { req.destroy(); } catch {}
        resolve({ ok: false, error: 'timeout' });
      });
      req.end();
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

async function httpsGetText(url, timeoutMs = 15000) {
  let netErr = null;
  try {
    if (net) {
      const r = await requestViaNet(url, {
        timeoutMs,
        headers: {
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      // net 可用时直接返回；超时/网络错误则用 Node 实现再试一次（例如无代理直连更快的场景）
      if (r.ok || r.status) return r;
      netErr = r.error || 'net request failed';
    }
  } catch (e) {
    netErr = e.message;
  }
  const fallback = await httpsGetTextNode(url, timeoutMs);
  if (fallback.ok || fallback.status) return fallback;
  return { ok: false, error: netErr || fallback.error || 'request failed' };
}

async function httpsGetJson(url, timeoutMs = 15000) {
  const res = await httpsGetText(url, timeoutMs);
  if (!res || !res.ok) return { ok: false, error: res?.error || 'request failed' };
  try {
    return { ok: true, data: JSON.parse(res.body) };
  } catch (e) {
    return { ok: false, error: e.message || 'json parse failed' };
  }
}

function stripHtmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析 Steam 封禁信息。
 *
 * 重要：steamcommunity.com/profiles/<id>/gamebans 的公开页面只提供三项汇总数字——
 *   「N game ban on record」「N VAC ban on record」「M day(s) since last ban」，
 * 页面里没有任何“被封禁的是哪个游戏”的结构（实测该页 0 个 table、无游戏列表区块），
 * 具体游戏名只有登录 Steam 客户端后才能看到。
 * 旧实现抓不到游戏名时会退回页面标题，把 Steam 昵称塞进 games 里当“被封禁的游戏”，
 * 那是错误信息，已移除。
 */
function parseSteamGameBansFromText(text) {
  const src = String(text || '');
  const out = { count: null, vacCount: null, daysSinceLastBan: null, games: [], private: false };

  if (/this profile is private|profile is private|个人资料.*不公开/i.test(src)) out.private = true;

  const gm = /(\d+)\s*game bans?\s+on record/i.exec(src);
  if (gm) out.count = parseInt(gm[1], 10);

  const vm = /(\d+)\s*VAC bans?\s+on record/i.exec(src);
  if (vm) out.vacCount = parseInt(vm[1], 10);

  const dm =
    /(\d+)\s*day\(s\)\s+since last ban/i.exec(src) ||
    /(\d+)\s*days\s+since last ban/i.exec(src);
  if (dm) out.daysSinceLastBan = parseInt(dm[1], 10);

  if (out.count == null) out.count = 0;
  if (out.vacCount == null) out.vacCount = 0;
  return out;
}

async function fetchSteamGameBansSummary(steamid) {
  const empty = { ok: false, count: 0, vacCount: 0, daysSinceLastBan: null, games: [], private: false };
  try {
    const sid = String(steamid || '').trim();
    if (!/^\d{17}$/.test(sid)) return Object.assign({}, empty, { error: 'invalid steamid' });
    const url = `https://steamcommunity.com/profiles/${encodeURIComponent(sid)}/gamebans/?l=english`;
    const res = await httpsGetText(url, 15000);   // 走系统代理，慢一点也留足时间
    if (!res.ok) return Object.assign({}, empty, { error: res.error || ('HTTP ' + res.status) });
    const parsed = parseSteamGameBansFromText(stripHtmlToText(res.body));
    return Object.assign({ ok: true }, parsed);
  } catch (e) {
    return Object.assign({}, empty, { error: e.message });
  }
}

ipcMain.handle('steam-get-game-bans-batch', async (event, steamids) => {
  const list = Array.isArray(steamids) ? steamids : [];
  const unique = [...new Set(list.map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 200);
  if (!unique.length) return { ok: true, items: {} };

  const items = {};
  let cursor = 0;
  const CONCURRENCY = 4;

  async function worker() {
    while (cursor < unique.length) {
      const sid = unique[cursor++];
      items[sid] = await fetchSteamGameBansSummary(sid);
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  return { ok: true, items };
});

// ===== IP 地理位置（用于在线玩家表格显示）=====
/** 与 renderer 中 parsePlayerAddressIp 一致：避免把 IPv6 误截成第一段导致归属地错误 */
function normalizeIpForGeoLookup(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const m = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (m) return m[1].trim();
    const m2 = raw.match(/^\[([^\]]+)\]/);
    if (m2) return m2[1].trim();
  }
  const m4 = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/);
  if (m4) return m4[1];
  return raw;
}

/** 以「城市」为主展示；languages=zh-CN 时 country/region/city 多为中文 */
function buildLocationText(geo) {
  if (!geo || geo.error) return null;
  const country = String(geo.country_name || geo.country || '').trim();
  const region = String(geo.region || geo.regionName || '').trim();
  const city = String(geo.city || '').trim();
  if (city) {
    if (region && region !== city && !city.includes(region)) return `${region}·${city}`;
    return city;
  }
  if (region) return region;
  if (country) return country;
  return null;
}

ipcMain.handle('ip-geo-get-batch', async (event, ips) => {
  const list = Array.isArray(ips) ? ips : [];
  const unique = [...new Set(list.map((ip) => String(ip || '').trim()).filter(Boolean))].slice(0, 200);
  if (!unique.length) return { ok: true, items: {} };

  const items = {};
  let cursor = 0;
  const CONCURRENCY = 4;

  // 多源回退：ipapi.co 已实测直接返回 403（拦截此类请求），改为下列免 Key 源。
  // ip-api.com 支持 lang=zh-CN，可直接返回中文国家/省/市，最贴合本界面。
  const GEO_PROVIDERS = [
    {
      name: 'ip-api',
      url: (ip) => `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,message,country,regionName,city`,
      pick: (d) => (d && d.status === 'success') ? { country_name: d.country, region: d.regionName, city: d.city } : null,
    },
    {
      name: 'ipwho.is',
      url: (ip) => `https://ipwho.is/${encodeURIComponent(ip)}`,
      pick: (d) => (d && d.success !== false && (d.city || d.region || d.country)) ? { country_name: d.country, region: d.region, city: d.city } : null,
    },
    {
      name: 'ipinfo.io',
      url: (ip) => `https://ipinfo.io/${encodeURIComponent(ip)}/json`,
      pick: (d) => (d && (d.city || d.region || d.country)) ? { country: d.country, region: d.region, city: d.city } : null,
    },
  ];

  async function worker() {
    while (cursor < unique.length) {
      const ipRaw = unique[cursor++];
      const ip = normalizeIpForGeoLookup(ipRaw);
      let located = null;
      let provider = '';
      for (const p of GEO_PROVIDERS) {
        try {
          const r = await httpsGetJson(p.url(ip), 10000);
          if (!r.ok || !r.data) continue;
          const geo = p.pick(r.data);
          if (!geo) continue;
          const text = buildLocationText(geo);
          if (text) { located = text; provider = p.name; break; }
        } catch (e) { /* 换下一个源 */ }
      }
      items[ip] = located ? { locationText: located, provider } : { locationText: ip, failed: true };
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  return { ok: true, items };
});

// ===== 封禁记录 =====
ipcMain.handle('get-bans', async () => {
  try {
    const r = await sendRconCommand('banlist');
    const lines = (r.message || '').split('\n').filter(l => l.trim());
    const bans = lines.map(line => {
      const m = line.match(/^(\d+)\s+"([^"]+)"\s+"([^"]*)"/) || line.match(/^(\S+)\s+(.*)/);
      if (m) return { SteamID: m[1], Name: m[2] || '', Reason: m[3] || '' };
      return { SteamID: line.trim(), Name: '', Reason: '' };
    });
    return { ok: true, bans };
  } catch (e) { return { ok: false, bans: [], error: e.message }; }
});

ipcMain.handle('ban-get-db', () => {
  return { ok: true, db: loadBanDb() };
});

ipcMain.handle('ban-upsert-rule', async (event, payload) => {
  try {
    const p = payload || {};
    const steamId = String(p.steamId || '').trim();
    const reason = String(p.reason || '违规').trim();
    const ip = String(p.ip || '').trim();
    const ipRange = String(p.ipRange || '').trim();
    const globalSync = !!p.globalSync;
    const syncAllServers = !!p.syncAllServers;
    const durationMinutes = Number(p.durationMinutes || 0);
    const tempUntil = durationMinutes > 0 ? new Date(Date.now() + durationMinutes * 60000).toISOString() : '';

    const db = loadBanDb();
    db.entries.unshift({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      steamId,
      reason,
      ip,
      ipRange,
      globalSync,
      syncAllServers,
      createdAt: new Date().toISOString(),
      tempUntil,
      sourceServer: currentServer?.Name || '',
    });
    db.entries = db.entries.slice(0, 5000);
    saveBanDb(db);

    if (steamId) {
      // 原因必须加引号：否则含空格的理由会被 RCON 当成额外参数
      await sendRconCommand(`ban ${steamId} "${String(reason).replace(/"/g, "'")}"`, 20000);
    }
    return { ok: true, tempUntil };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 删除单条本地封禁规则（按 id 或 steamId 匹配）
ipcMain.handle('ban-delete-entry', (event, key) => {
  try {
    const k = String(key || '').trim();
    if (!k) return { ok: false, error: 'key required' };
    const db = loadBanDb();
    const before = db.entries.length;
    db.entries = db.entries.filter((e) => String(e.id || '') !== k && String(e.steamId || '') !== k);
    saveBanDb(db);
    return { ok: true, removed: before - db.entries.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('ban-export-db', () => {  try {
    const db = loadBanDb();
    const exportFile = path.join(dataDir, `ban_db_export_${Date.now()}.json`);
    fs.writeFileSync(exportFile, JSON.stringify(db, null, 2));
    shell.showItemInFolder(exportFile);
    return { ok: true, path: exportFile };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('ban-sync-db', async () => {
  try {
    const servers = loadServers().servers || [];
    const db = loadBanDb();
    const active = db.entries.filter((e) => String(e.steamId || '').trim());
    const result = [];
    for (const srv of servers) {
      let count = 0;
      for (const entry of active.slice(0, 200)) {
        const r = await executeRconOnServer(srv, `ban ${entry.steamId} "${String(entry.reason || '违规').replace(/"/g, "'")}"`, 8000);
        if (r.ok) count++;
      }
      result.push({ server: srv.Name || srv.IpAddress, synced: count });
    }
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('battle-get-log', async (event, steamid, lines = 30) => {
  try {
    const sid = String(steamid || '').trim();
    if (!/^\d{17}$/.test(sid)) return { ok: false, error: 'steamid 需要是 17 位数字', rows: [] };
    const safeLines = Math.min(Math.max(Number(lines) || 30, 1), 200);
    const r = await sendRconCommand(`combatlog ${sid} ${safeLines}`, 20000);
    const text = String(r.message || '');
    if (!text.trim()) return { ok: true, rows: [], raw: text, note: '服务器没有返回 combatlog 内容（可能未启用 server.combatlogsize）' };

    const out = [];
    const rows = text.replace(/\r\n?/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
    // 兼容不同服务器的列分隔：优先按 2+ 空格切分，退化时按制表符或单空格
    for (const line of rows) {
      if (/^-+$/.test(line)) continue;
      if (/^date\s*$/i.test(line)) continue;
      const isHeader = /^date\b.*attacker/i.test(line);
      if (isHeader) continue;
      let cols = line.split(/\s{2,}|\t+/).map((s) => s.trim()).filter((s) => s !== '');
      if (cols.length < 6) cols = line.split(/\s+/).map((s) => s.trim());
      if (cols.length < 6) continue;
      // date 可能被拆成 "2026-09-15 03:12:45" 两列，做一次合并
      if (/^\d{4}-\d{2}-\d{2}$/.test(cols[0]) && /^\d{2}:\d{2}:\d{2}$/.test(cols[1] || '')) {
        cols = [`${cols[0]} ${cols[1]}`, ...cols.slice(2)];
      }
      out.push({
        date: cols[0] || '',
        attacker: cols[1] || '',
        weapon: cols[2] || '',
        ammo: cols[3] || '',
        area: cols[4] || '',
        distance: cols[5] || '',
        old_hp: cols[6] != null ? cols[6] : '',
        new_hp: cols[7] != null ? cols[7] : '',
        raw: line,
      });
    }
    return { ok: true, rows: out, raw: text, parsed: out.length };
  } catch (e) {
    return { ok: false, error: e.message, rows: [] };
  }
});

// ===== 权限组 =====
// uMod 列出组名常用 oxide.show groups，返回多为 "Groups:\ndefault, admin, ..."；旧版 oxide.groups 可能无效
function parseGroupsFromRconOutput(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) return [];
  const dedupe = (arr) => [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];

  const gm = text.match(/Groups?\s*:\s*\n?\s*([\s\S]+?)(?:\n\s*\n|\n\[|$)/i);
  if (gm) {
    const chunk = gm[1].trim();
    const collected = [];
    for (const line of chunk.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (/^\[|^Calling|^Error|^Invalid|^Unknown|^You\s/i.test(line)) break;
      line.split(',').forEach((s) => {
        const t = s.trim().replace(/^["']|["']$/g, '');
        const id = t.match(/^([\w.-]+)/i);
        if (id) collected.push(id[1]);
      });
    }
    if (collected.length) return dedupe(collected);
  }

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const noise = /^(Calling|Error|Syntax|Unknown|Invalid|You\s|Plugin|Listing|There\s|Please\s|\[)/i;
  const out = [];
  for (const line of lines) {
    if (noise.test(line)) continue;
    if (/^Groups?\s*:?\s*$/i.test(line)) continue;
    const afterBullet = line.replace(/^[\s>*•]+/, '').replace(/^\d+[\.)]\s*/, '').trim();
    if (/^[\w.-]+$/i.test(afterBullet) && afterBullet.length <= 64) out.push(afterBullet);
  }
  const fromLines = dedupe(out);
  if (fromLines.length) return fromLines;

  const named = new Set();
  let m;
  const reG = /\bGroup\s+['"]([^'"]+)['"]/gi;
  while ((m = reG.exec(text)) !== null) named.add(m[1]);
  return named.size ? [...named] : [];
}

async function fetchOxideGroupsList() {
  const commands = ['oxide.show groups', 'o.show groups', 'perm.show groups', 'oxide.groups'];
  let lastRaw = '';
  let lastTimeout = false;
  for (const cmd of commands) {
    const r = await sendRconCommand(cmd, 20000);
    lastRaw = r.message != null ? String(r.message) : '';
    if (r.timeout) lastTimeout = true;
    const groups = parseGroupsFromRconOutput(lastRaw);
    if (groups.length) return { ok: true, groups, raw: lastRaw, command: cmd };
  }
  return {
    ok: true,
    groups: [],
    raw: lastRaw,
    command: commands[commands.length - 1],
    timedOut: lastTimeout
  };
}

ipcMain.handle('get-groups', async () => {
  try {
    return await fetchOxideGroupsList();
  } catch (e) {
    return { ok: false, groups: [], raw: '', error: e.message };
  }
});

function parsePermListFromOutput(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.trim()) return [];
  const out = [];

  // 常见权限形态：plugin.permission 或 oxide.xxx
  const re = /\b[a-z0-9][a-z0-9_.:-]{2,}\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = m[0];
    if (!v.includes('.')) continue;
    if (v.length > 80) continue;
    if (/^(steam|http|https|ws|wss)\b/i.test(v)) continue;
    out.push(v);
  }

  return [...new Set(out.map((s) => s.toLowerCase()))].sort();
}

async function fetchOxidePermissionsList() {
  const commands = ['oxide.show perms', 'o.show perms', 'perm.show perms', 'oxide.permissions', 'perm.show'];
  let lastRaw = '';
  let lastTimeout = false;
  for (const cmd of commands) {
    const r = await sendRconCommand(cmd, 20000);
    lastRaw = r.message != null ? String(r.message) : '';
    if (r.timeout) lastTimeout = true;
    const perms = parsePermListFromOutput(lastRaw);
    if (perms.length) return { ok: true, perms, raw: lastRaw, command: cmd };
  }
  return { ok: true, perms: [], raw: lastRaw, command: commands[commands.length - 1], timedOut: lastTimeout };
}

ipcMain.handle('get-permissions', async () => {
  try {
    return await fetchOxidePermissionsList();
  } catch (e) {
    return { ok: false, perms: [], raw: '', error: e.message };
  }
});

function parseGroupDetail(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const perms = parsePermListFromOutput(text);

  // 成员：尽量从输出里找 SteamID（17位）
  const users = [];
  const reSid = /\b\d{17}\b/g;
  let m;
  while ((m = reSid.exec(text)) !== null) users.push(m[0]);
  const uniqUsers = [...new Set(users)];

  return { perms, users: uniqUsers, raw: text };
}

ipcMain.handle('get-group-detail', async (event, group) => {
  const g = String(group || '').trim();
  if (!g) return { ok: false, perms: [], users: [], raw: '', error: 'group required' };
  try {
    const commands = [`oxide.show group ${g}`, `o.show group ${g}`, `perm.show group ${g}`];
    let lastRaw = '';
    let lastCmd = commands[commands.length - 1];
    let lastTimeout = false;
    for (const cmd of commands) {
      const r = await sendRconCommand(cmd, 20000);
      lastRaw = r.message != null ? String(r.message) : '';
      lastCmd = cmd;
      if (r.timeout) lastTimeout = true;
      const parsed = parseGroupDetail(lastRaw);
      // 解析出内容才返回；否则继续尝试下一个命令
      // （旧实现在循环里无条件 return，后面两个回退命令成了死代码）
      if (parsed.perms.length || parsed.users.length) {
        return { ok: true, group: g, ...parsed, command: cmd, timedOut: lastTimeout };
      }
    }
    // 全部命令都没解析出内容：把最后一次的原始回显返回给前端展示
    return Object.assign({ ok: true, group: g, perms: [], users: [] }, {
      raw: lastRaw, command: lastCmd, timedOut: lastTimeout,
    });
  } catch (e) {
    return { ok: false, group: g, perms: [], users: [], raw: '', error: e.message };
  }
});

ipcMain.handle('group-grant-perm', async (event, group, perm) => {
  const g = String(group || '').trim();
  const p = String(perm || '').trim();
  if (!g || !p) return { ok: false, error: 'group/perm required' };
  try {
    const r = await sendRconCommand(`oxide.grant group ${g} ${p}`, 20000);
    return { ok: true, message: r.message, timeout: !!r.timeout };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('group-revoke-perm', async (event, group, perm) => {
  const g = String(group || '').trim();
  const p = String(perm || '').trim();
  if (!g || !p) return { ok: false, error: 'group/perm required' };
  try {
    const r = await sendRconCommand(`oxide.revoke group ${g} ${p}`, 20000);
    return { ok: true, message: r.message, timeout: !!r.timeout };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== 所有插件 =====
ipcMain.handle('get-plugins', async () => {
  try {
    const r = await sendRconCommand('oxide.plugins');
    const lines = (r.message || '').split('\n').filter(l => l.trim());
    const plugins = [];
    lines.forEach(line => {
      const m = line.match(/^\s*\d+\s+(.+?)\s+\(([^)]+)\)\s+by\s+(.+)$/);
      if (m) {
        plugins.push({ Name: m[1].trim(), Version: m[2].trim(), Author: m[3].trim() });
      }
    });
    return { ok: true, plugins, raw: r.message };
  } catch (e) { return { ok: false, plugins: [], error: e.message }; }
});

// ===== 离线玩家 =====
const offlineFile = path.join(dataDir, 'offline_players.json');
ipcMain.handle('get-offline-players', () => {
  if (!fs.existsSync(offlineFile)) return { players: [] };
  try {
    let players = JSON.parse(fs.readFileSync(offlineFile, 'utf8'));
    if (!Array.isArray(players)) return { players: [] };
    // 过滤30天之外的记录
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    players = players.filter((p) => {
      const t = p && p.OfflineTime ? new Date(p.OfflineTime).getTime() : 0;
      return t >= cutoff;
    });
    return { players };
  }
  catch { return { players: [] }; }
});

ipcMain.handle('clear-offline-players', () => {
  try {
    fs.writeFileSync(offlineFile, JSON.stringify([], null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 删除单条离线记录（面板上的“删除”操作）
ipcMain.handle('delete-offline-player', (event, steamid, server) => {
  try {
    const sid = String(steamid || '').trim();
    const key = String(server || '').trim();
    let players = [];
    if (fs.existsSync(offlineFile)) {
      try { players = JSON.parse(fs.readFileSync(offlineFile, 'utf8')); } catch {}
    }
    const before = players.length;
    players = players.filter((p) => {
      if (String(p?.SteamID || '') !== sid) return true;
      if (key && String(p?.Server || '') !== key) return true;
      return false;
    });
    fs.writeFileSync(offlineFile, JSON.stringify(players, null, 2));
    return { ok: true, removed: before - players.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function recordOfflinePlayer(player) {
  let players = [];
  if (fs.existsSync(offlineFile)) {
    try { players = JSON.parse(fs.readFileSync(offlineFile, 'utf8')); } catch {}
  }
  // 清理超过30天的离线玩家记录
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  players = players.filter((p) => {
    const t = p && p.OfflineTime ? new Date(p.OfflineTime).getTime() : 0;
    return t >= cutoff;
  });
  const idx = players.findIndex(p => p.SteamID === player.SteamID);
  const record = { ...player, OfflineTime: new Date().toISOString() };
  if (idx >= 0) players[idx] = record; else players.unshift(record);
  if (players.length > 500) players = players.slice(0, 500);
  fs.writeFileSync(offlineFile, JSON.stringify(players, null, 2));
}

// ===== 服务器配置 =====
ipcMain.handle('server-set-hostname', async (event, name) => {
  logUsage('server_config', { action: 'set_hostname', value: name });
  try { const r = await sendRconCommand(`server.hostname "${name}"`); return { ok: true, message: r.message }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server-set-weather', async (event, weather) => {
  logUsage('server_config', { action: 'set_weather', value: weather });
  // Weather 2.0：优先使用 weather.load / weather.reset（更稳定、更符合官方文档）
  // 可用类型：Clear Dust Fog Overcast RainHeavy RainMild Storm
  const map = {
    clear: 'weather.load Clear',
    cloudy: 'weather.load Overcast',
    wind: 'weather.wind 1',
    fog: 'weather.load Fog',
    storm: 'weather.load Storm',
    default: 'weather.reset'
  };
  try {
    const plan = String(map[weather] || `weather.${weather}`);
    // RCON 不一定支持在一条命令里用 ; 执行多条，这里拆分逐条发送
    const cmds = plan.split(';').map((s) => s.trim()).filter(Boolean);
    for (const cmd of cmds) {
      await sendRconCommand(cmd, 20000);
    }
    return { ok: true };
  }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('server-save', async () => {
  logUsage('server_config', { action: 'server_save' });
  try { const r = await sendRconCommand('server.save', 20000); return { ok: true, message: r.message, timeout: !!r.timeout }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('server-writecfg', async () => {
  logUsage('server_config', { action: 'server_writecfg' });
  try { const r = await sendRconCommand('server.writecfg', 20000); return { ok: true, message: r.message, timeout: !!r.timeout }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('server-status', async () => {
  logUsage('server_config', { action: 'server_status' });
  try { const r = await sendRconCommand('status', 20000); return { ok: true, message: r.message, timeout: !!r.timeout }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('server-info', async () => {
  logUsage('server_config', { action: 'server_info' });
  try { const r = await sendRconCommand('server.info', 20000); return { ok: true, message: r.message, timeout: !!r.timeout }; }
  catch (e) { return { ok: false, error: e.message }; }
});

function parseConvarValue(raw, name) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const key = String(name || '').trim();
  if (!key) return s;
  // 正确转义：这里的 \\s 落到正则里才是 \s。
  // 旧实现写成 '\\\\s'，正则变成“字面反斜杠 + s”，前缀永远剥不掉，
  // 于是配置页显示成 server.hostname: "xxx" 这种乱码。
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + esc + '\\s*[:=]?\\s*', 'i');
  let v = s.replace(re, '').trim();
  // 去掉成对包裹的引号（保留内容里的引号）
  const q = v.match(/^"([\s\S]*)"$/);
  if (q) v = q[1].trim();
  return v;
}

ipcMain.handle('server-get-convars', async (event, names) => {
  const list = Array.isArray(names) ? names : [];
  const unique = [...new Set(list.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 40);
  const out = {};
  try {
    for (const n of unique) {
      const r = await sendRconCommand(n, 15000);
      out[n] = parseConvarValue(r.message, n);
    }
    return { ok: true, values: out };
  } catch (e) {
    return { ok: false, values: out, error: e.message };
  }
});

ipcMain.handle('server-set-convar', async (event, name, value) => {
  const n = String(name || '').trim();
  if (!n) return { ok: false, error: 'name required' };
  const v = value == null ? '' : String(value);
  logUsage('server_config', { action: 'set_convar', name: n });
  try {
    // 字符串用引号，数字/布尔直接传也可；这里统一加引号更稳妥
    const r = await sendRconCommand(`${n} "${v.replace(/"/g, '\\"')}"`, 20000);
    return { ok: true, message: r.message, timeout: !!r.timeout };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('server-set-time', async (event, time) => {
  logUsage('server_config', { action: 'set_time', value: time });
  try { const r = await sendRconCommand(`env.time ${time}`); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server-set-maxplayers', async (event, n) => {
  logUsage('server_config', { action: 'set_maxplayers', value: n });
  try { const r = await sendRconCommand(`server.maxplayers ${n}`); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server-npc-enabled', async (event, enabled) => {
  logUsage('server_config', { action: 'set_npc', value: enabled });
  try { const r = await sendRconCommand(`global.npc_enabled ${enabled ? 'true' : 'false'}`); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server-gather-rate', async (event, type, val) => {
  logUsage('server_config', { action: 'gather_rate', type, value: val });
  try { const r = await sendRconCommand(`gather.rate resource "${type}" ${val}`); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server-team-limit', async (event, n) => {
  logUsage('server_config', { action: 'set_team_limit', value: n });
  try { const r = await sendRconCommand(`server.maxteamsize ${n}`); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server-combat-log', async (event, interval) => {
  logUsage('server_config', { action: 'combat_log', value: interval });
  try { const r = await sendRconCommand(`server.combatlogsize ${interval}`); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ===== 玩家授权 =====
ipcMain.handle('player-grant', async (event, permission, steamid) => {
  logUsage('player_permission', { action: 'grant_user', permission, steamid });
  try { const r = await sendRconCommand(`oxide.grant user ${steamid} ${permission}`); return { ok: true, message: r.message }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('player-revoke', async (event, permission, steamid) => {
  logUsage('player_permission', { action: 'revoke_user', permission, steamid });
  try { const r = await sendRconCommand(`oxide.revoke user ${steamid} ${permission}`); return { ok: true, message: r.message }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('player-grant-all', async (event, permission) => {
  logUsage('player_permission', { action: 'grant_all', permission });
  try { const r = await sendRconCommand(`oxide.grant group default ${permission}`); return { ok: true, message: r.message }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('player-revoke-all', async (event, permission) => {
  logUsage('player_permission', { action: 'revoke_all', permission });
  try { const r = await sendRconCommand(`oxide.revoke group default ${permission}`); return { ok: true, message: r.message }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('player-add-group', async (event, steamid, group) => {
  logUsage('player_permission', { action: 'add_group', group, steamid });
  try { const r = await sendRconCommand(`oxide.usergroup add ${steamid} ${group}`); return { ok: true, message: r.message }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('player-remove-group', async (event, steamid, group) => {
  logUsage('player_permission', { action: 'remove_group', group, steamid });
  try { const r = await sendRconCommand(`oxide.usergroup remove ${steamid} ${group}`); return { ok: true, message: r.message }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('player-give-currency', async (event, steamid, amount) => {
  logUsage('player_economy', { action: 'give_currency', steamid, amount });
  try { const r = await sendRconCommand(`economics.deposit ${steamid} ${amount}`); return { ok: true, message: r.message }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('player-deduct-currency', async (event, steamid, amount) => {
  logUsage('player_economy', { action: 'deduct_currency', steamid, amount });
  try { const r = await sendRconCommand(`economics.withdraw ${steamid} ${amount}`); return { ok: true, message: r.message }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('player-give-points', async (event, steamid, amount) => {
  logUsage('player_economy', { action: 'give_points', steamid, amount });
  try { const r = await sendRconCommand(`sr add ${steamid} ${amount}`); return { ok: true, message: r.message }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('player-deduct-points', async (event, steamid, amount) => {
  logUsage('player_economy', { action: 'deduct_points', steamid, amount });
  try { const r = await sendRconCommand(`sr remove ${steamid} ${amount}`); return { ok: true, message: r.message }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ===== 日志 =====
ipcMain.handle('get-logs', () => {
  if (!fs.existsSync(logsDir)) return [];
  return fs.readdirSync(logsDir).filter(f => f.endsWith('.txt')).sort().reverse()
    .map(f => ({ name: f, path: path.join(logsDir, f) }));
});
ipcMain.handle('read-log', (event, filePath) => {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
});
ipcMain.handle('open-logs-folder', () => shell.openPath(logsDir));
ipcMain.handle('save-console-log-local', (event, text) => {
  try {
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const file = path.join(logsDir, `manual_console_${Date.now()}.txt`);
    fs.writeFileSync(file, String(text || ''), 'utf8');
    shell.showItemInFolder(file);
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== 自定义命令 =====
ipcMain.handle('get-custom-commands', () => {
  if (!fs.existsSync(customCmdsFile)) return [];
  try { return JSON.parse(fs.readFileSync(customCmdsFile, 'utf8')); } catch { return []; }
});
ipcMain.handle('save-custom-commands', (event, cmds) => {
  fs.writeFileSync(customCmdsFile, JSON.stringify(cmds, null, 2));
  return true;
});

// ===== 外部链接 =====
ipcMain.on('open-url', (event, url) => shell.openExternal(url));

// ===== 窗口控制 =====
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => {
  logUsage('app_closed', {});
  mainWindow?.close();
});

// ===== Rust 新闻自动获取（从 Facepunch 官网抓取 + 自动汉化）=====
const newsCacheFile = path.join(dataDir, 'rust_news_cache.json');
const NEWS_CACHE_TTL = 60 * 60 * 1000; // 1小时缓存

async function fetchRustNews() {
  const cached = loadNewsCache();
  // 忽略“空数组缓存”：旧版本抓取失败时会把 [] 写进缓存文件，导致永远显示 0 条新闻
  if (cached && Array.isArray(cached.news) && cached.news.length && Date.now() - cached.fetchTime < NEWS_CACHE_TTL) {
    return cached.news;
  }
  try {
    // 与其他出站请求一致：走系统代理，避免直连被墙导致永远只能看兜底新闻
    const res = await httpsGetText('https://rust.facepunch.com/news/', 12000);
    if (!res.ok || !res.body) return getDefaultNewsTranslated();
    const rawNews = parseRustNewsPage(res.body);
    const news = [];
    for (const n of rawNews) news.push(await translateNewsItem(n));   // 逐条翻译（在线接口 + 词典兜底）
    if (!news.length) return getDefaultNewsTranslated();
    saveNewsCache(news);
    return news;
  } catch (e) {
    return getDefaultNewsTranslated();
  }
}

/**
 * 解析 rust.facepunch.com/news/ 页面
 * 匹配 blog-post-body 块中的标签、标题和描述
 */
function parseRustNewsPage(html) {
  const src = String(html || '');
  if (!src) return [];
  const news = [];
  // 旧实现用 lookahead 匹配块结束的 </div>，但真实页面里 blog-post-body
  // 内部还有一层 </div>，导致永远匹配不到 → 一直退回硬编码兜底新闻。
  // 改为按块起始标记切分，再在块内分别取日期 / 标签 / 标题 / 摘要。
  const parts = src.split(/<div class="blog-post-body">/i);
  for (let i = 1; i < parts.length && news.length < 8; i++) {
    let block = parts[i];
    const nextPost = block.search(/<div class="blog-post[\s"]/i);
    block = nextPost > 300 ? block.slice(0, nextPost) : block.slice(0, 4000);

    const dateMatch = block.match(/<div class="tag secondary">\s*([^<]+?)\s*<\/div>/i);
    const tagMatch = block.match(/class="tag\s+([a-z0-9_-]+)"[^>]*>\s*([^<]*?)\s*<\/a>/i);
    const titleMatch = block.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const descMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);

    const tag = tagMatch ? tagMatch[2].trim() : '';
    const title = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/\s+/g, ' ').trim()) : '';
    const desc = descMatch ? decodeHtmlEntities(descMatch[1].replace(/\s+/g, ' ').trim()) : '';
    const date = dateMatch ? dateMatch[1].trim() : '';
    if (title || desc) news.push({ tag, title, desc, date });
  }
  return news;
}

/** HTML 实体解码 */
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&').replace(/&#38;/g, '&')
    .replace(/&lt;/g, '<').replace(/&#60;/g, '<')
    .replace(/&gt;/g, '>').replace(/&#62;/g, '>')
    .replace(/&#xA0;/g, ' ').replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * 英文→中文翻译：将 Rust 官方新闻翻译为中文
 */
/**
 * 自动翻译（优先走在线翻译接口，失败再退回内置词典）
 * 使用 Google 免 Key 端点，经 requestViaNet 出站，因此同样走系统代理。
 * 结果按文本缓存，避免每条新闻重复请求。
 */
const autoTranslateCache = new Map();

async function translateViaApi(text) {
  const src = String(text || '').trim();
  if (!src) return '';
  if (autoTranslateCache.has(src)) return autoTranslateCache.get(src);
  try {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' + encodeURIComponent(src.slice(0, 1800));
    const r = await requestViaNet(url, { timeoutMs: 12000 });
    if (!r || !r.ok || !r.body) return '';
    const data = JSON.parse(r.body);
    const segs = Array.isArray(data && data[0]) ? data[0] : [];
    const out = segs.map((s) => (Array.isArray(s) ? s[0] : '')).join('').trim();
    if (out) autoTranslateCache.set(src, out);
    return out;
  } catch (e) {
    return '';
  }
}

async function translateNewsItem(item) {
  const zhTag = translateTag(item.tag);
  // 在线翻译优先；失败或返回空则用内置 Rust 术语词典兜底
  let zhTitle = '';
  let zhDesc = '';
  if (item.title) zhTitle = (await translateViaApi(item.title)) || translateText(item.title);
  if (item.desc) zhDesc = (await translateViaApi(item.desc)) || translateText(item.desc);
  return { tag: zhTag, title: zhTitle, desc: zhDesc, date: item.date || '', zh: zhDesc ? `${zhTitle} — ${zhDesc}` : zhTitle };
}

/** 翻译分类标签 */
function translateTag(tag) {
  const map = {
    'DEVBLOG': 'DevBlog', 'DevBlog': '开发日志',
    'COMMUNITY': '社区', 'Community': '社区更新',
    'UPDATE': '更新', 'Update': '大更新',
    'DLC': 'DLC',
    'HOLIDAY': '节日', 'Holiday': '节日活动',
    'EVENT': '活动', 'Event': '活动',
    'ANNOUNCEMENT': '公告', 'Announcement': '公告',
  };
  return map[tag] || (tag ? tag.trim() : '新闻');
}

/** 翻译正文 — Rust 游戏术语词典 + 通用翻译 */
function translateText(text) {
  if (!text) return text;
  let t = text;

  // 物品名称
  const items = [
    ['Armoured Ladder Hatch', '装甲梯舱盖'], ['Ladder Hatch', '梯舱盖'],
    ['Water Wheel', '水轮机'], ['Water wheel', '水轮机'],
    ['Ornate Horse Mask', '精致马面具'], ['Horse Mask', '马面具'],
    ['Horse Armour', '马铠甲'], ['Horse Armor', '马铠甲'],
    ['Mini Fridge', '迷你冰箱'], ['mini fridge', '迷你冰箱'],
    ['Mortar', '迫击炮'], ['mortar', '迫击炮'],
    ['Tin Can Alarm', '锡罐报警器'],
    ['Workbench upgrades', '工作台升级系统'], ['workbench upgrades', '工作台升级'],
    ['C4', 'C4炸药'], ['Rocket Launcher', '火箭筒'],
    ['Double Barrel Shotgun', '双管霰弹枪'],
  ];
  for (const [en, zh] of items) { t = t.replace(new RegExp(en, 'gi'), zh); }

  // 更新专有名词
  const updates = [
    ['Upgrade hard, raid harder', '全力升级，尽情突袭'], ['upgrade hard, raid harder', '全力升级，尽情突袭'],
    ['Spring Clean', '春季大扫除'], ['Spring clean', '春季大扫除'],
    ['Shipshape', '造船大师'], ['shipshape', '造船大师'],
    ['Naval Update', '海军大更新'], ['naval update', '海军大更新'],
    ['Naval', '海军'], ['naval', '海军'],
    ['Lunar New Year', '农历新年'], ['lunar new year', '农历新年'],
    ['Surviving 12 Years', '十二周年生存之路'], ['surviving 12 years', '十二年生存之路'],
    ['Silent Night, Violent Night', '平安夜，暴力夜'],
    ['Getting It Right', '精益求精'], ['getting it right', '精益求精'],
    ['Pivot Or Die', '转型求生'], ['pivot or die', '转型求生'],
    ['Rustmas', '圣诞狂欢节'], ['rustmas', '圣诞狂欢节'],
    ['Christmas', '圣诞节'], ['christmas', '圣诞节'],
    ['Holiday Season', '假日季'], ['holiday season', '假日季'],
  ];
  for (const [en, zh] of updates) { t = t.replace(new RegExp('\\b' + en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), zh); }

  // 地点场景
  const locations = [
    ['Deep Sea', '深海'], ['deep sea', '深海'],
    ['The Deep Sea', '深海区域'], ['Tropical Islands', '热带岛屿'],
    ['Ghost Ships', '幽灵船'], ['ghost ships', '幽灵船'],
  ];
  for (const [en, zh] of locations) { t = t.replace(en, zh); }

  // 游戏机制
  const mechanics = [
    ['buildable boats', '可建造船只'], ['Buildable boats', '可建造船只'],
    ['QOL', '生活质量'], ['quality of life', '生活质量'],
    ['performance', '性能优化'], ['Performance', '性能优化'],
    ['bug fixes', '错误修复'], ['Bug fixes', '错误修复'],
    ['balance changes', '平衡性调整'], ['balances', '平衡调整'],
    ['progression', '进程系统'], ['Progression', '进程系统'],
    ['combatlog', '战斗日志'], ['combat log', '战斗日志'],
    ['Wipe', '强制清档'], ['wipe', '清档'],
    ['Twitch Drops', 'Twitch掉落奖励'],
    ['skin', '皮肤'], ['Skins', '物品皮肤'],
    ['AI', '人工智能'], ['NPC', 'NPC'],
    ['daytime', '白天时长'], ['Daytime', '白天时间'],
  ];
  for (const [en, zh] of mechanics) { t = t.replace(new RegExp(en, 'gi'), zh); }

  // 常见短语
  const phrases = [
    ["This month's update brings you", '本月更新带来'],
    ["This month we bring you", '本月我们带来'],
    ["and much more!", '以及更多内容！'],
    ['and much more', '以及更多内容'],
    ["It's a big one.", '这是一次重大更新。'],
    ["Ahoy matey!", '啊哈船员们！'],
    ['have begun!', '已经开始了！'],
    ['Celebrate the occasion by', '通过以下方式庆祝'],
    ['honouring the Year of the Horse', '迎接马年到来'],
    ['is now live', '现已上线'],
    ['Winter Drop Fest is here!', '冬季掉落活动来了！'],
    ['that wonderful time of the year again', '一年中那个美妙的时刻又到了'],
    ['We Bit Off More Than We Could Chew', '我们有点好高骛远'],
    ["if you've not played Rust in the past few months", '如果你过去几个月没玩过Rust'],
    ['there is a ton of new content to use and explore', '有大量新内容可以体验和探索'],
    ['will be worth the wait', '值得期待'],
    ['Servers are now wiped', '服务器已执行强制清档'],
    ['Santa is packing up and clearing out the bodies', '圣诞老人正在打包清理现场'],
    ['we hope you enjoyed the Holiday Season', '希望你们享受了假日季'],
    ['In this blog, we recap', '在本篇日志中，我们回顾了'],
    ['and reveal some upcoming changes for', '并透露了即将到来的变化'],
    ['massive improvements to how you live, build, and fight on water', '水上及深海居住、建造、战斗全面改进'],
    ['As well as extended daytime', '同时延长了白天时间'],
    ['further progression changes', '更多进程系统改动'],
    ['box sorting', '箱子整理功能'],
    ['RPG skin', 'RPG皮肤'],
    ['Staging bits', '测试阶段内容'],
    ['a Father Son Duo', '一对父子组合'],
    ['recaps', '精彩回顾'], ['recap', '回顾'],
    ['sneaky C4', '偷偷摸摸的C4炸药'],
    ['Two new items', '两个全新物品'],
    ['additionally loads of', '此外大量的'],
    ['model refreshes and remakes', '模型翻新重制'],
    ['improved Tin Can Alarm', '加强版锡罐报警器'],
  ];
  for (const [en, zh] of phrases) { t = t.replace(en, zh); }

  // 通用兜底
  const general = [
    ['new content', '新内容'], ['new features', '新功能'],
    ['improvements', '改进'], ['updates', '更新'], ['changes', '变更'],
    ['community', '社区'], ['players', '玩家'], ['server', '服务器'],
    ['game', '游戏'], ['event', '活动'], ['celebrations', '庆典'],
  ];
  for (const [en, zh] of general) { t = t.replace(new RegExp('\\b' + en + '\\b', 'gi'), zh); }

  return t.trim();
}

/** 已翻译的默认新闻（网络不可用时兜底）*/
function getDefaultNewsTranslated() {
  return [
    { tag: 'DevBlog', title: '全力升级，尽情突袭(Upgrade hard, raid harder)', desc: '本月更新带来工作台升级系统、新型迫击炮、加强版锡罐报警器，以及模型翻新重制、大量生活质量改进、错误修复等！', zh: '全力升级，尽情突袭(Upgrade hard, raid harder) — 本月更新带来工作台升级系统、新型迫击炮、加强版锡罐报警器，以及模型翻新重制、大量生活质量改进、错误修复等！' },
    { tag: 'DevBlog', title: '春季大扫除(Spring Clean)', desc: '本月更新带来两个全新物品——装甲梯舱盖和水轮机，此外还有大量生活质量改进、错误修复和性能优化！', zh: '春季大扫除(Spring Clean) — 本月更新带来两个全新物品——装甲梯舱盖和水轮机，此外还有大量生活质量改进、错误修复和性能优化！' },
    { tag: '开发日志', title: '造船大师(Shipshape)', desc: '本月更新带来水上及深海居住、建造、战斗的全面改进，延长白天时间，以及平衡性调整和生活质量提升。', zh: '造船大师(Shipshape) — 本月更新带来水上及深海居住、建造、战斗全面改进，延长白天时间' },
    { tag: '节日活动', title: '2026农历新年', desc: '2026年农历新年庆典已开始！通过精致马面具、马铠甲等道具迎接马年到来！', zh: '2026农历新年 — 通过精致马面具、马铠甲等道具迎接马年到来！' },
    { tag: '大更新', title: '海军大更新(Naval Update)', desc: '可建造船只、深海探索、热带岛屿、幽灵船、改进版AI以及海量新内容！这是一次重大更新。', zh: '海军大更新(Naval Update) — 可建造船只、深海探索、热带岛屿、幽灵船、改进版AI' },
    { tag: '社区更新', title: '社区更新268(Community Update 268)', desc: '海军测试阶段内容、Twitch掉落奖励、父子玩家组合、圣诞狂欢节回顾、偷偷摸摸的C4炸药等！', zh: '社区更新268 — 海军测试阶段、Twitch掉落奖励、圣诞狂欢节回顾等' },
    { tag: '开发日志', title: '十二周年生存之路(Surviving 12 Years)', desc: '服务器已执行强制清档，圣诞老人正在收工清理现场！本篇日志回顾了2025年全年并透露2026年的部分规划方向。', zh: '十二周年生存之路(Surviving 12 Years) — 回顾2025年全年并透露2026年部分规划' },
    { tag: '公告', title: '精益求精(Getting It Right)', desc: '海军大更新值得等待！如果你过去几个月没玩过Rust，有大量新内容可以体验和探索。', zh: '精益求精(Getting It Right) — 海军大更新值得等待，大量新内容等你来玩' },
  ];
}

function loadNewsCache() {
  if (!fs.existsSync(newsCacheFile)) return null;
  try { return JSON.parse(fs.readFileSync(newsCacheFile, 'utf8')); } catch { return null; }
}

function saveNewsCache(news) {
  try { fs.writeFileSync(newsCacheFile, JSON.stringify({ news, fetchTime: Date.now() }, null, 2)); } catch {}
}

ipcMain.handle('get-rust-news', async () => {
  const news = await fetchRustNews();
  return news;
});
