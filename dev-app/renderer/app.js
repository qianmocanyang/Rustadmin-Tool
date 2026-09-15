/* ===== RustAdmin app.js - Facepunch风格界面逻辑 ===== */

const api = window.rustAPI;

// ===== 状态 =====
let state = {
  connected: false,
  currentServer: null,
  players: [],
  offlinePlayers: [],
  serverHostname: null,
  maxPlayers: null,
  serverNameFallback: null,
  cmdHistory: [],
  chatLog: [],
  consoleLines: [],
  chatChannel: 'all',
  consoleFilter: 'all',
  // Steam 封禁信息缓存（用于在线玩家表格内的点击详情）
  // 结构: { [steamid]: { count, daysSinceLastBan, games: [{name}], fetchedAt } }
  steamGameBanInfoCache: {},
  // IP 地理位置缓存（用于在线玩家表格“所在城市”列）
  // 结构: { [ip]: { locationText, fetchedAt, uiVersion? } }
  ipGeoCache: {},
  /** 玩家授权「选插件增加」：oxide.plugins + oxide.show perms 缓存 */
  permGrantCatalog: { plugins: [], allPerms: [], loadedAt: 0 },
  joiningCount: 0,
  queueCount: 0,
};
let currentContextPlayer = null;
let currentBanTarget = null;
const PLAYER_META_KEY = 'rustadmin.playerMeta';
const PLAYER_HISTORY_KEY = 'rustadmin.playerHistory';

// ===== 玩家数据持久化（按服务器存储） =====
// 内存缓存，格式与 localStorage 相同
let _playerMetaCache = null;   // { steamid: { marked, note, ... } }
let _playerHistCache = null;   // { steamid: [{time, action, detail}] }
let _currentServerKey = '';    // "IP:Port"，连接后赋值
let _playerDataSaveTimer = null;

function _getCurrentServerKey() {
  if (_currentServerKey) return _currentServerKey;
  // 降级：从 state 里取
  if (state.currentServer) {
    return `${state.currentServer.IpAddress}:${state.currentServer.RconPort}`;
  }
  return '';
}

// 从文件加载当前服务器的玩家数据，写入内存缓存和 localStorage
async function loadServerPlayerData(serverKey) {
  _currentServerKey = serverKey || '';
  try {
    const r = await api.playerDataLoad(serverKey);
    const fileData = (r && r.ok) ? (r.data || {}) : {};
    _playerMetaCache = fileData.meta || {};
    _playerHistCache = fileData.history || {};
    // 同步到 localStorage（兼容旧逻辑）
    localStorage.setItem(PLAYER_META_KEY, JSON.stringify(_playerMetaCache));
    localStorage.setItem(PLAYER_HISTORY_KEY, JSON.stringify(_playerHistCache));
  } catch {
    // 降级为 localStorage
    _playerMetaCache = null;
    _playerHistCache = null;
  }
}

// 防抖持久化：500ms 内合并多次写入
function _schedulePlayerDataSave() {
  const key = _getCurrentServerKey();
  if (!key) return;
  if (_playerDataSaveTimer) clearTimeout(_playerDataSaveTimer);
  _playerDataSaveTimer = setTimeout(() => {
    _playerDataSaveTimer = null;
    const meta = _playerMetaCache || loadPlayerMetaStore();
    const history = _playerHistCache || loadPlayerHistoryStore();
    api.playerDataSave(key, { meta, history }).catch(() => {});
  }, 500);
}

function loadPlayerMetaStore() {
  if (_playerMetaCache !== null) return _playerMetaCache;
  try { return JSON.parse(localStorage.getItem(PLAYER_META_KEY) || '{}') || {}; } catch { return {}; }
}
function savePlayerMetaStore(data) {
  _playerMetaCache = data || {};
  localStorage.setItem(PLAYER_META_KEY, JSON.stringify(_playerMetaCache));
  _schedulePlayerDataSave();
}
function getPlayerMeta(steamid) {
  const sid = String(steamid || '').trim();
  if (!sid) return {};
  const store = loadPlayerMetaStore();
  return store[sid] || {};
}
function setPlayerMeta(steamid, patch) {
  const sid = String(steamid || '').trim();
  if (!sid) return;
  const store = loadPlayerMetaStore();
  store[sid] = { ...(store[sid] || {}), ...(patch || {}) };
  savePlayerMetaStore(store);
}
function clearPlayerMeta(steamid) {
  const sid = String(steamid || '').trim();
  if (!sid) return;
  const store = loadPlayerMetaStore();
  delete store[sid];
  savePlayerMetaStore(store);
}
function loadPlayerHistoryStore() {
  if (_playerHistCache !== null) return _playerHistCache;
  try { return JSON.parse(localStorage.getItem(PLAYER_HISTORY_KEY) || '{}') || {}; } catch { return {}; }
}
function savePlayerHistoryStore(data) {
  _playerHistCache = data || {};
  localStorage.setItem(PLAYER_HISTORY_KEY, JSON.stringify(_playerHistCache));
  _schedulePlayerDataSave();
}
function addPlayerHistory(steamid, action, detail = '') {
  const sid = String(steamid || '').trim();
  if (!sid) return;
  const store = loadPlayerHistoryStore();
  const arr = Array.isArray(store[sid]) ? store[sid] : [];
  arr.unshift({ time: new Date().toISOString(), action, detail: String(detail || '') });
  store[sid] = arr.slice(0, 100);
  savePlayerHistoryStore(store);
}

function ensureStartupPopupsHidden() {
  const ids = [
    'add-server-modal',
    'dev-password-modal',
    'player-modal',
    'player-profile-modal',
    'steam-ban-modal',
    'perm-picker-modal',
    'ban-config-modal',
    'teleport-modal',
    'player-context-menu',
    'dev-config-panel',
    'dev-password-error',
  ];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const devModal = document.querySelector('.dev-modal');
  if (devModal) devModal.style.display = 'block';
}
ensureStartupPopupsHidden();

// 初始化自动重连偏好（将 localStorage 中的值同步到后端）
if (typeof api.setAutoReconnect === 'function') {
  api.setAutoReconnect(document.getElementById('chk-auto-reconnect')?.checked === true).catch(() => {});
}

/**
 * 从 Rust playerlist 的 Address 解析真实 IP（供归属地与表格「IP」列使用）。
 * - IPv4: `1.2.3.4` 或 `1.2.3.4:port`
 * - IPv6: `[2001:db8::1]:port` 或裸 IPv6（无端口则整段返回）
 * 错误地用 `split(':')[0]` 会把 IPv6 截成第一段，归属地会完全错位（例如误成广东）。
 */
function parsePlayerAddressIp(addr) {
  const raw = String(addr || '').trim();
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

function localizeGeoParts(parts) {
  const map = {
    china: '中国',
    'united states': '美国',
    usa: '美国',
    us: '美国',
    'hong kong': '中国香港',
    macao: '中国澳门',
    taiwan: '中国台湾',
    'taiwan, province of china': '中国台湾',

    guangdong: '广东',
    guangzhou: '广州',
    shanghai: '上海',
    beijing: '北京',
    shenzhen: '深圳',
    zhejiang: '浙江',
    hangzhou: '杭州',
    jiangsu: '江苏',
    nanjing: '南京',
    suzhou: '苏州',
    wuxi: '无锡',
    chengdu: '成都',
    chongqing: '重庆',
    wuhan: '武汉',
    xian: '西安',
    fujian: '福建',
    xiamen: '厦门',
    shandong: '山东',
    qingdao: '青岛',
    liaoning: '辽宁',
    dalian: '大连',
    henan: '河南',
    zhengzhou: '郑州',
    hunan: '湖南',
    changsha: '长沙',
    sichuan: '四川',
    mianyang: '绵阳',
    deyang: '德阳',
    nanchong: '南充',
    luzhou: '泸州',
    yibin: '宜宾',
    zigong: '自贡',
    leshan: '乐山',
    meishan: '眉山',

    'new york': '纽约',
    california: '加利福尼亚',
    'los angeles': '洛杉矶',
    texas: '德克萨斯',
    florida: '佛罗里达',
    washington: '华盛顿州',
    illinois: '伊利诺伊',
    'united kingdom': '英国',
    england: '英格兰',
    germany: '德国',
    france: '法国',
    japan: '日本',
    'south korea': '韩国',
    korea: '韩国',
    russia: '俄罗斯',
    australia: '澳大利亚',
    canada: '加拿大',
    brazil: '巴西',
    india: '印度',
    singapore: '新加坡',
    thailand: '泰国',
    vietnam: '越南',
    malaysia: '马来西亚',
    indonesia: '印度尼西亚',
    philippines: '菲律宾',
  };

  return (parts || []).map((p) => {
    const s = String(p || '').trim();
    if (!s) return '';
    if (/[\u4e00-\u9fff]/.test(s)) return s;
    const key = s.toLowerCase();
    return map[key] || s;
  });
}

/** 展示为「省·市」或城市；兼容旧缓存「国家/省/市」斜杠格式并尽量汉化 */
function formatGeoText(locationText) {
  const raw = String(locationText || '').trim();
  if (!raw || raw === '-') return '-';

  if (raw.includes('·')) {
    const segs = raw.split('·').map((s) => s.trim()).filter(Boolean);
    const loc = localizeGeoParts(segs).join('·');
    return loc || raw;
  }

  const parts = raw.split('/').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return raw;

  if (parts.length >= 3) {
    const country = parts[0];
    const region = parts[parts.length - 2];
    const city = parts[parts.length - 1];
    if (/[\u4e00-\u9fff]/.test(city) || /[\u4e00-\u9fff]/.test(region)) {
      if (region && city && region !== city) return `${region}·${city}`;
      return city || region || country;
    }
    const lr = localizeGeoParts([region, city]).filter(Boolean);
    if (lr.length === 2 && lr[0] !== lr[1]) return `${lr[0]}·${lr[1]}`;
    if (lr.length) return lr[lr.length - 1];
    return localizeGeoParts([country])[0] || raw;
  }

  if (parts.length === 2) {
    const [a, b] = localizeGeoParts(parts);
    if (a && b && a !== b) return `${a}·${b}`;
    return a || b || raw;
  }

  return localizeGeoParts(parts)[0] || raw;
}

// ===== Toast 通知 =====
function toast(msg, type = 'info', dur = 3000) {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toast-in 0.3s ease reverse forwards';
    setTimeout(() => el.remove(), 300);
  }, dur);
}

// ===== 窗口控制 =====
document.getElementById('btn-min')?.addEventListener('click', () => api?.windowMinimize?.());
document.getElementById('btn-max')?.addEventListener('click', () => api?.windowMaximize?.());
document.getElementById('btn-close')?.addEventListener('click', () => api?.windowClose?.());

function safeCall(label, fn) {
  try {
    fn();
  } catch (e) {
    console.error('[RustAdmin]', label, e);
    toast(`${label} 出错，请打开开发者工具查看控制台`, 'error');
  }
}

// ===== Tab 切换 =====
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const panel = document.getElementById('panel-' + btn.dataset.tab);
    if (panel) panel.classList.add('active');
    const tab = btn.dataset.tab;
    if (tab === 'players') safeCall('在线玩家', () => refreshPlayers());
    if (tab === 'bans') safeCall('封禁记录', () => refreshBans());
    if (tab === 'groups') safeCall('权限组', () => refreshGroups());
    if (tab === 'allplugins') safeCall('插件列表', () => refreshPlugins());
    if (tab === 'offline') safeCall('离线玩家', () => refreshOfflinePlayers());
    if (tab === 'playerperm') safeCall('玩家授权', () => {
      refreshPermOnline(); refreshPermOffline(); renderPermGrid();
      loadPermGrantCatalog(false).then(() => { fillPermAddPluginSelect(); renderPermAddPluginPermChipList(); }).catch(() => {});
      scheduleRefreshPermSelectedPlayerPerms();
    });
    if (tab === 'serverconfig') safeCall('服务器配置', () => loadServerConfigSnapshot());
    if (tab === 'admincmds') safeCall('管理员指令', () => renderAdminCommands());
    if (tab === 'itemshop') safeCall('物品发放', () => initItemShop());
    if (tab === 'battle') safeCall('战斗记录', () => {});
    if (tab === 'usagelog') {
      loadUsageLog().catch(e => {
        console.error('[RustAdmin] 使用日志', e);
        toast('使用日志加载失败，请查看控制台', 'error');
      });
    }
  });
});

// ===== 服务器管理 =====
const DEFAULT_RCON_PORT = 28016;

/**
 * 把各种粘贴写法拆成 { host, port }：
 *   127.0.0.1 / 127.0.0.1:28016 / ws://127.0.0.1:28016 / 127.0.0.1:28016/password / [::1]:28016
 * 之前直接把输入当 IP 存盘，粘贴 "ip:port" 会拼出 ws://ip:port:port 导致永远握手失败
 */
function parseAddressInput(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return { host: '', port: null };
  s = s.replace(/^wss?:\/\//i, '').split('/')[0].trim();
  const v6 = s.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  if (v6) return { host: v6[1].trim(), port: v6[2] ? Number(v6[2]) : null };
  const v4 = s.match(/^(.+?):(\d{1,5})$/);
  if (v4) return { host: v4[1].trim(), port: Number(v4[2]) };
  return { host: s, port: null };
}

function parsePortInput(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

/**
 * 连接栏反馈：不再用常驻文字条（之前的“正在连接 …”连上后不会消失），
 * 改为 error / ok 走 toast 提示，info 由按钮与标题栏状态自身表达。
 * 字段级错误仍有红框 + 抖动动画。
 */
function setConnHint(text, kind) {
  if (!text) return;
  if (kind === 'error') toast(text, 'error');
  else if (kind === 'ok') toast(text, 'success');
}

function markFieldInvalid(id, invalid) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('invalid', !!invalid);
}

function clearFieldValidation() {
  ['field-ip', 'field-port', 'field-pass'].forEach((id) => markFieldInvalid(id, false));
}

/** 读取并规范化顶栏：自动拆分 ip:port、校验端口与密码；失败时给可视反馈 */
function readServerForm(opts) {
  const silent = !!(opts && opts.silent);
  const ipEl = document.getElementById('server-ip');
  const portEl = document.getElementById('server-port');
  const passEl = document.getElementById('server-pass');
  const parsed = parseAddressInput(ipEl.value);
  let port = parsed.port;
  if (port != null) portEl.value = String(port);
  else port = parsePortInput(portEl.value);

  clearFieldValidation();
  if (!parsed.host) { markFieldInvalid('field-ip', true); if (!silent) setConnHint('请填写服务器地址', 'error'); return null; }
  if (parsed.host !== ipEl.value) ipEl.value = parsed.host;
  if (port == null) { markFieldInvalid('field-port', true); if (!silent) setConnHint('RCON 端口需为 1–65535 的整数', 'error'); return null; }
  const pass = passEl.value;
  if (!pass) { markFieldInvalid('field-pass', true); if (!silent) setConnHint('请填写 RCON 密码', 'error'); return null; }
  return { host: parsed.host, port: port, pass: pass };
}

function syncDeleteButton() {
  const btn = document.getElementById('btn-delete-server');
  const sel = document.getElementById('server-select');
  if (!btn || !sel) return;
  btn.classList.toggle('u-hidden', !sel.value);
}

async function loadServerList() {
  let data = { servers: [], lastSelected: '' };
  try { data = (await api.getServers()) || data; } catch (e) { toast('读取服务器列表失败: ' + e.message, 'error'); }
  const sel = document.getElementById('server-select');
  sel.innerHTML = '<option value="">-- 选择服务器 --</option>';
  (data.servers || []).forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.Name;
    const auto = s.IpAddress + ':' + s.RconPort;
    // 自动命名的条目就直接显示地址，避免出现 "127.0.0.1:28016 · 127.0.0.1:28016"
    opt.textContent = (s.Name === auto) ? auto : (s.IpAddress + ':' + s.RconPort + '  ·  ' + s.Name);
    sel.appendChild(opt);
  });
  const restored = (data.servers || []).find((s) => s.Name === data.lastSelected);
  if (restored) { sel.value = restored.Name; fillServerBar(restored); }
  syncDeleteButton();
}

function fillServerBar(srv) {
  document.getElementById('server-ip').value = srv.IpAddress || '';
  document.getElementById('server-port').value = srv.RconPort || DEFAULT_RCON_PORT;
  document.getElementById('server-pass').value = srv.RconPassword || '';
  clearFieldValidation();
}

const btnDeleteServer = document.getElementById('btn-delete-server');

document.getElementById('server-select').onchange = async function () {
  syncDeleteButton();
  const name = this.value;
  if (!name) { setConnHint(''); return; }
  try {
    const data = await api.getServers();
    const srv = (data.servers || []).find((s) => s.Name === name);
    if (srv) { fillServerBar(srv); await api.setLastServer(name); }
    setConnHint('已载入「' + name + '」，可直接连接', 'info');
  } catch (e) { toast('载入服务器失败: ' + e.message, 'error'); }
};

// 删除已保存的服务器
btnDeleteServer.onclick = async () => {
  const sel = document.getElementById('server-select');
  const name = sel.value;
  if (!name) return;
  if (!confirm('确定要删除服务器「' + name + '」吗？此操作不可撤销。')) return;
  try {
    await api.deleteServer(name);
    await api.setLastServer('');
    await loadServerList();
    syncDeleteButton();
    toast('服务器「' + name + '」已删除', 'success');
  } catch (e) { toast('删除失败: ' + e.message, 'error'); }
};

/** 保存/更新当前顶栏内容；命中已选中配置则原地更新，否则按 host:port 命名 */
async function saveServerFromBar(customName) {
  const form = readServerForm();
  if (!form) return false;
  const sel = document.getElementById('server-select');
  let name = String(customName || '').trim();
  if (!name) {
    let list = [];
    try { const d = await api.getServers(); list = (d && d.servers) || []; } catch (e) {}
    const selected = list.find((s) => s.Name === sel.value);
    if (selected && selected.IpAddress === form.host) {
      // 同一台主机（端口/密码改了也算同一台）→ 原地更新，避免多出一条重复配置
      name = selected.Name;
    } else {
      // 未选中，或换了主机 → 视作新服务器，按 host:port 命名（同名则覆盖）
      name = form.host + ':' + form.port;
    }
  }
  const btn = document.getElementById('btn-add-server');
  try {
    await api.saveServer({ Name: name, IpAddress: form.host, RconPort: form.port, RconPassword: form.pass });
    await api.setLastServer(name);   // 之前漏了这步：保存后不写「上次选择」，重启后连接栏是空的
    await loadServerList();
    sel.value = name;
    syncDeleteButton();
    setConnHint('已保存「' + name + '」', 'ok');
    toast('服务器「' + name + '」已保存', 'success');
    if (btn) { btn.classList.add('is-saved'); setTimeout(() => btn.classList.remove('is-saved'), 900); }
    return true;
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    setConnHint('保存失败: ' + msg, 'error');
    toast('保存失败: ' + msg, 'error');
    return false;
  }
}

// 保存按钮：直接保存（不再强制弹窗重输密码）；Shift+点击 → 自定义名称
document.getElementById('btn-add-server').onclick = (e) => {
  if (e.shiftKey) {
    const form = readServerForm({ silent: true });
    const host = form ? form.host : document.getElementById('server-ip').value.trim();
    const port = form ? form.port : document.getElementById('server-port').value.trim();
    document.getElementById('new-srv-name').value = host + ':' + port;
    document.getElementById('new-srv-ip').value = host;
    document.getElementById('new-srv-port').value = port;
    document.getElementById('new-srv-pass').value = document.getElementById('server-pass').value;  // 之前被清空，逼用户重输
    document.getElementById('add-server-modal').style.display = 'flex';
    document.getElementById('new-srv-name').focus();
    return;
  }
  saveServerFromBar();
};

// 输入即时反馈：地址里带端口时同步到端口框
['server-ip', 'server-port', 'server-pass'].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => {
    clearFieldValidation();
    if (id === 'server-ip') {
      const p = parseAddressInput(el.value);
      if (p.port) document.getElementById('server-port').value = String(p.port);
    }
  });
  el.addEventListener('blur', () => {
    if (id === 'server-port') {
      const p = parsePortInput(el.value);
      if (p != null) el.value = String(p);
    } else if (id === 'server-ip') {
      const p = parseAddressInput(el.value);
      if (p.host && p.host !== el.value) el.value = p.host;
    }
  });
});

// 密码显示/隐藏
document.getElementById('btn-toggle-pass').onclick = () => {
  const el = document.getElementById('server-pass');
  const btn = document.getElementById('btn-toggle-pass');
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  btn.classList.toggle('is-on', show);
  btn.title = show ? '隐藏密码' : '显示密码';
};

document.getElementById('btn-cancel-modal').onclick = () => { document.getElementById('add-server-modal').style.display = 'none'; };
document.getElementById('btn-cancel-add-server').onclick = () => { document.getElementById('add-server-modal').style.display = 'none'; };
document.getElementById('btn-confirm-add-server').onclick = async () => {
  const name = document.getElementById('new-srv-name').value.trim();
  const ipRaw = document.getElementById('new-srv-ip').value;
  const portRaw = document.getElementById('new-srv-port').value;
  const pass = document.getElementById('new-srv-pass').value;
  if (!name) { toast('请填写服务器名称', 'error'); return; }
  const parsed = parseAddressInput(ipRaw);
  const port = parsed.port != null ? parsed.port : parsePortInput(portRaw);
  if (!parsed.host) { toast('请填写服务器地址', 'error'); return; }
  if (port == null) { toast('RCON 端口需为 1–65535 的整数', 'error'); return; }
  if (!pass) { toast('请填写 RCON 密码', 'error'); return; }
  document.getElementById('server-ip').value = parsed.host;
  document.getElementById('server-port').value = String(port);
  document.getElementById('server-pass').value = pass;
  const ok = await saveServerFromBar(name);
  if (ok) document.getElementById('add-server-modal').style.display = 'none';
};

// ===== 连接/断开按钮（单按钮切换）=====
const btnConnect = document.getElementById('btn-connect');

// ===== 自动重连开关 =====
const AR_KEY = 'rustadmin.autoReconnect';
const chkAutoReconnect = document.getElementById('chk-auto-reconnect');

// 从 localStorage 恢复上一次选择
chkAutoReconnect.checked = localStorage.getItem(AR_KEY) !== 'false';

// 连接前同步一次到后端
async function syncAutoReconnect() {
  const enabled = chkAutoReconnect.checked;
  localStorage.setItem(AR_KEY, String(enabled));
  try { await api.setAutoReconnect(enabled); } catch {}
}

chkAutoReconnect.addEventListener('change', syncAutoReconnect);

btnConnect.onclick = async () => {
  if (state.connected) {
    // 已连接状态 → 断开
    try { await api.rconDisconnect(); } catch (e) { toast('断开失败: ' + e.message, 'error'); }
    state.connected = false;
    setStatusDisconnected();
    toast('已断开服务器连接', 'info');
  } else {
    // 未连接 → 连接（先规范化/校验，避免 ip:port 之类写法拼出错误 URL）
    const form = readServerForm();
    if (!form) return;
    const ip = form.host, port = form.port, pass = form.pass;
    setConnHint('正在连接 ' + ip + ':' + port + ' …', 'info');
    // 连接前同步自动重连偏好到后端
    await syncAutoReconnect();
    const name = document.getElementById('server-select').value || (ip + ':' + port);
    state.currentServer = { Name: name, IpAddress: ip, RconPort: port, RconPassword: pass };
    setStatusConnecting();
    try {
      await api.rconConnect(state.currentServer);
    } catch (e) {
      // 之前没有兜底：一旦 IPC 抛错，按钮就永久卡在禁用的「连接中...」
      setStatusDisconnected('连接失败');
      setConnHint('连接失败: ' + (e && e.message ? e.message : e), 'error');
      toast('连接失败: ' + (e && e.message ? e.message : e), 'error');
    }
  }
};

// ===== RCON 状态 =====
function setStatusConnecting() {
  document.getElementById('conn-dot').className = 'conn-dot connecting';
  document.getElementById('conn-text').textContent = '连接中...';
  btnConnect.textContent = '连接中...';
  btnConnect.disabled = true;
}
function setStatusConnected(serverName) {
  document.getElementById('conn-dot').className = 'conn-dot connected';
  state.serverNameFallback = serverName;
  state.connected = true;
  updateConnText();
  // 按钮变为"断开连接"样式
  btnConnect.textContent = '断开连接';
  btnConnect.className = 'action-btn action-disconnect';
  btnConnect.disabled = false;
}
function setStatusDisconnected(msg) {
  document.getElementById('conn-dot').className = 'conn-dot';
  document.getElementById('conn-text').textContent = msg || '未连接';
  state.connected = false;
  state.serverHostname = null;
  state.maxPlayers = null;
  state.serverNameFallback = null;
  // 按钮恢复为"连接服务器"
  btnConnect.textContent = '连接服务器';
  btnConnect.className = 'action-btn action-connect';
  btnConnect.disabled = false;
  const joiningEl = document.getElementById('stat-joining');
  const queueEl = document.getElementById('stat-queue');
  if (joiningEl) joiningEl.textContent = '0';
  if (queueEl) queueEl.textContent = '0';
}

function updateConnText() {
  const el = document.getElementById('conn-text');
  if (!el) return;

  const hn = state.serverHostname || state.serverNameFallback || '';
  // 顶部只显示服务器名称本身
  el.textContent = hn || '';
}

api.onRconStatus((status) => {
  if (status.connected) {
    setStatusConnected(status.server);
    // 连接成功提示只显示服务器名称
    toast(`${status.server}`, 'success');
    // 重置插件加载标志位（修复一直读取插件目录的bug）
    pluginsLoaded = false;
    // 加载该服务器的玩家属性数据（标记、备注、历史）和历史聊天记录
    if (state.currentServer) {
      const svrKey = `${state.currentServer.IpAddress}:${state.currentServer.RconPort}`;
      // 清空聊天区（重新连接），再加载历史
      if (chatArea) chatArea.innerHTML = '';
      state.chatLog = [];
      loadServerPlayerData(svrKey).then(() => {
        renderPlayers(state.players);
      });
      loadHistoryChatMessages(svrKey);
    }
    refreshPlayers();
    // 刷新离线玩家列表（修复离线玩家不显示的问题）
    refreshOfflinePlayers();
    // 控制台：回看本地历史日志（按服务器分文件，重连/重启后仍可查阅）
    loadConsoleHistory();
    // 连接成功后自动读取服务器当前状态：配置快照 + server.info 回包
    setTimeout(() => {
      loadServerConfigSnapshot().catch(() => {});
      readServerInfoIntoMaint().catch(() => {});
    }, 900);
    setTimeout(() => pollServerStats(), 600);
  } else {
    setStatusDisconnected(status.error || '未连接');
    // 断开连接时也重置插件加载标志位
    pluginsLoaded = false;
    flushConsolePersist();   // 把待写队列落盘，避免丢日志
    if (status.error && status.error !== '已手动断开') toast(`连接断开: ${status.error}`, 'error');
  }
});

api.onRconServerMeta((meta) => {
  if (!meta) return;
  if (meta.hostname != null) state.serverHostname = String(meta.hostname);
  // 只展示服务器名称，maxPlayers 暂不使用
  if (state.connected) updateConnText();
});

api.onRconReconnecting(() => {
  setStatusConnecting();
  document.getElementById('conn-text').textContent = '重连中...';
});

// ===== 控制台 =====
const consoleArea = document.getElementById('console-area');
const MAX_CONSOLE_LINES = 5000;
const CONSOLE_PERSIST_FLUSH_MS = 700;
const CONSOLE_HISTORY_KEY = 'rustadmin.console.history';

let consoleFollow = true;          // 是否跟随最新（自动滚动）
let consolePendingNew = 0;         // 未跟随期间累积的新日志数
let consolePersistQueue = [];      // 待写盘的日志
let consolePersistTimer = null;

// 与聊天日志同一套命名：IP_端口（主进程会做文件名安全化）
function consoleServerKey() {
  const s = state.currentServer;
  if (s && s.IpAddress) return `${s.IpAddress}_${s.RconPort}`;
  return 'default';
}

/** 批量写盘：按服务器分组，避免每条日志一次 IPC/一次磁盘写入 */
function flushConsolePersist() {
  if (consolePersistTimer) { clearTimeout(consolePersistTimer); consolePersistTimer = null; }
  if (!consolePersistQueue.length) return;
  const queued = consolePersistQueue;
  consolePersistQueue = [];
  const byKey = {};
  queued.forEach((l) => { (byKey[l.key] = byKey[l.key] || []).push({ t: l.t, cls: l.cls, text: l.text }); });
  Object.keys(byKey).forEach((key) => {
    try {
      const p = api.consoleLogAppend && api.consoleLogAppend(key, byKey[key]);
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* 写盘失败不影响界面 */ }
  });
}

function queueConsolePersist(lineData) {
  consolePersistQueue.push({
    key: consoleServerKey(),
    t: lineData.t || Date.now(),
    cls: lineData.cls,
    text: lineData.text,
  });
  if (consolePersistQueue.length >= 40) flushConsolePersist();
  else if (!consolePersistTimer) consolePersistTimer = setTimeout(flushConsolePersist, CONSOLE_PERSIST_FLUSH_MS);
}

function consoleCategory(cls) {
  if (cls === 'type-join' || cls === 'type-leave') return 'join';
  if (cls === 'type-chat') return 'chat';
  if (cls === 'type-kill') return 'kill';
  if (cls === 'type-error' || cls === 'type-warn') return 'error';
  if (cls === 'type-cmd') return 'cmd';
  return 'normal';
}

function updateConsoleCounts() {
  const counts = { all: state.consoleLines.length, cmd: 0, chat: 0, join: 0, kill: 0, error: 0 };
  state.consoleLines.forEach((l) => {
    const c = consoleCategory(l.cls);
    if (counts[c] != null) counts[c]++;
  });
  document.querySelectorAll('#panel-console .fbtn-cnt').forEach((el) => {
    const k = el.dataset.cnt;
    el.textContent = counts[k] != null ? counts[k] : 0;
  });
}

function showConsoleEmpty() {
  if (!consoleArea) return;
  consoleArea.innerHTML =
    '<div class="console-empty">' +
    '<div>控制台还没有内容</div>' +
    '<div class="hint">连接服务器后，RCON 回包、玩家加入/离开、聊天与错误都会实时显示在这里</div>' +
    '<div class="hint">日志会自动保存到本地：' +
    '<b>日志目录</b> 按钮可直接打开，重连/重启后自动回看</div>' +
    '</div>';
}

function addConsoleDivider(text) {
  if (!consoleArea) return null;
  const el = document.createElement('div');
  el.className = 'console-divider';
  el.textContent = text;
  consoleArea.appendChild(el);
  return el;
}

function hideNewLinesBadge() {
  consolePendingNew = 0;
  const el = document.getElementById('console-newlines');
  if (el) el.classList.remove('is-visible');
}

function showNewLinesBadge() {
  const el = document.getElementById('console-newlines');
  if (!el) return;
  el.textContent = `↓ ${consolePendingNew} 条新日志`;
  el.classList.add('is-visible');
}

function consoleScrollToBottom() {
  if (!consoleArea) return;
  consoleArea.scrollTop = consoleArea.scrollHeight;
  hideNewLinesBadge();
}

function setConsoleFollow(on) {
  consoleFollow = !!on;
  const btn = document.getElementById('btn-console-follow');
  if (btn) {
    btn.classList.toggle('is-active', consoleFollow);
    btn.textContent = consoleFollow ? '跟随' : '已暂停';
  }
  if (consoleFollow) consoleScrollToBottom();
}

function afterConsoleAppend() {
  if (consoleFollow) consoleScrollToBottom();
  else { consolePendingNew++; showNewLinesBadge(); }
}

/** 统一的日志写入入口：DOM + 内存 + 本地持久化 + 计数 + 跟随 */
function pushConsoleLine(lineData, opts) {
  const o = opts || {};
  state.consoleLines.push(lineData);
  if (consoleArea) {
    const empty = consoleArea.querySelector('.console-empty');
    if (empty) empty.remove();
    const el = renderConsoleLine(lineData);
    // 当前过滤/搜索条件下这条是否需要隐藏
    try { if (!consoleLineMatches(lineData)) el.style.display = 'none'; } catch (e) {}
    consoleArea.appendChild(el);
    while (state.consoleLines.length > MAX_CONSOLE_LINES) {
      state.consoleLines.shift();
      const first = consoleArea.querySelector('.console-line');
      if (first) first.remove();
    }
  }
  updateConsoleCounts();
  if (o.persist !== false) queueConsolePersist(lineData);
  if (o.silent !== true) afterConsoleAppend();
}

/** 重连/重启后回看本地日志 */
async function loadConsoleHistory() {
  if (!api.consoleLogLoad) return;
  const key = consoleServerKey();
  let r = null;
  try { r = await api.consoleLogLoad(key, 500); } catch (e) { return; }
  if (!r || !r.ok || !Array.isArray(r.lines) || !r.lines.length) return;
  if (state.consoleLines.length) return;   // 本次会话已有内容，不覆盖
  addConsoleDivider(`历史日志（${r.lines.length} 条 · 来自本地 ${key}）`);
  r.lines.forEach((l) => {
    const d = new Date(l.t || Date.now());
    pushConsoleLine({
      ts: d.toLocaleTimeString('zh-CN', { hour12: false }),
      text: l.text == null ? '' : String(l.text),
      cls: l.cls || 'type-normal',
      history: true,
    }, { persist: false, silent: true });
  });
  addConsoleDivider('本次会话');
  setConsoleFollow(true);
  updateConsoleCounts();
}

// ===== 常用命令库（内置 + 自定义 + 历史）=====
const CONSOLE_COMMAND_LIBRARY = [
  // 玩家
  { cat: '玩家', name: '踢出玩家', cmd: 'kick {steamid} "原因"', desc: '把玩家踢下线（原因可省略）' },
  { cat: '玩家', name: '封禁玩家', cmd: 'ban {steamid} "原因"', desc: '永久封禁（原因建议加引号）' },
  { cat: '玩家', name: '解封玩家', cmd: 'unban {steamid}', desc: '解除封禁' },
  { cat: '玩家', name: '击杀玩家', cmd: 'kill {steamid}', desc: '让玩家立即死亡' },
  { cat: '玩家', name: '禁言', cmd: 'muteplayer {steamid} 3600', desc: '禁言指定秒数（示例 1 小时）' },
  { cat: '玩家', name: '解除禁言', cmd: 'unmuteplayer {steamid}', desc: '取消禁言' },
  { cat: '玩家', name: '传送玩家', cmd: 'teleport {steamid} {目标steamid}', desc: '把 A 传送到 B 身边' },
  { cat: '玩家', name: '传送到坐标', cmd: 'teleportpos {steamid} 0 100 0', desc: '传送到指定 XYZ' },
  { cat: '玩家', name: '在线玩家列表', cmd: 'playerlist', desc: '返回 JSON 格式的在线玩家' },
  { cat: '玩家', name: '玩家信息', cmd: 'playerinfo {steamid}', desc: '部分插件支持' },
  // 服务器
  { cat: '服务器', name: '服务器信息', cmd: 'server.info', desc: '版本 / 端口 / 地图等' },
  { cat: '服务器', name: '运行状态', cmd: 'status', desc: '在线人数与基本信息' },
  { cat: '服务器', name: '保存世界', cmd: 'server.save', desc: '立即保存存档' },
  { cat: '服务器', name: '写入配置', cmd: 'server.writecfg', desc: '把当前配置写入文件' },
  { cat: '服务器', name: '改服务器名', cmd: 'server.hostname "新名称"', desc: '修改显示名称' },
  { cat: '服务器', name: '最大人数', cmd: 'server.maxplayers 100', desc: '调整人数上限' },
  { cat: '服务器', name: 'FPS', cmd: 'server.fps', desc: '查看服务器帧率' },
  { cat: '服务器', name: '实体数', cmd: 'server.entities', desc: '查看实体数量' },
  // 天气时间
  { cat: '天气时间', name: '晴天', cmd: 'weather.load Clear', desc: '切换到晴天' },
  { cat: '天气时间', name: '雾天', cmd: 'weather.load Fog', desc: '切换到雾天' },
  { cat: '天气时间', name: '暴风雨', cmd: 'weather.load Storm', desc: '切换到暴风雨' },
  { cat: '天气时间', name: '恢复默认天气', cmd: 'weather.reset', desc: '天气循环交还系统' },
  { cat: '天气时间', name: '设置时间', cmd: 'env.time 12', desc: '0-24 小时制' },
  { cat: '天气时间', name: '白天时长', cmd: 'env.daylength 45', desc: '单位分钟' },
  { cat: '天气时间', name: '夜晚时长', cmd: 'env.nightlength 15', desc: '单位分钟' },
  // 物品
  { cat: '物品', name: '给物品', cmd: 'inventory.give {steamid} {item短名} {数量}', desc: '给指定玩家物品' },
  { cat: '物品', name: '给全服物品', cmd: 'inventory.giveall {item短名} {数量}', desc: '给所有在线玩家' },
  { cat: '物品', name: '给全服物品(Blueprint)', cmd: 'inventory.giveall {item短名} {数量} blueprint', desc: '发蓝图' },
  // 权限（uMod / Oxide）
  { cat: '权限', name: '授权给玩家', cmd: 'oxide.grant user {steamid} {权限}', desc: '给单个玩家权限' },
  { cat: '权限', name: '撤销玩家权限', cmd: 'oxide.revoke user {steamid} {权限}', desc: '移除单个玩家权限' },
  { cat: '权限', name: '加入用户组', cmd: 'oxide.usergroup add {steamid} {组名}', desc: '把玩家加进组' },
  { cat: '权限', name: '移出用户组', cmd: 'oxide.usergroup remove {steamid} {组名}', desc: '把玩家移出组' },
  { cat: '权限', name: '列出用户组', cmd: 'oxide.show groups', desc: '查看所有组' },
  { cat: '权限', name: '列出全部权限', cmd: 'oxide.show perms', desc: '查看已注册权限节点' },
  { cat: '权限', name: '插件列表', cmd: 'oxide.plugins', desc: '列出已加载插件' },
  { cat: '权限', name: '重载插件', cmd: 'oxide.reload {插件名}', desc: '热重载指定插件' },
  // 聊天
  { cat: '聊天', name: '全服广播', cmd: 'say "内容"', desc: '以系统身份发送消息' },
  { cat: '聊天', name: '私聊玩家', cmd: 'sayto {steamid} "内容"', desc: '部分插件支持' },
];

let paletteCategory = 'all';
let paletteCustom = [];
let paletteOpen = false;

function paletteAllCommands() {
  const custom = paletteCustom.map((c) => ({ cat: '自定义', name: c.name, cmd: c.cmd, desc: c.desc }));
  const history = state.cmdHistory.slice(-30).reverse().map((c) => ({ cat: '历史', name: c, cmd: c, desc: '最近执行过' }));
  return [...CONSOLE_COMMAND_LIBRARY, ...custom, ...history];
}

function renderPalette() {
  const listEl = document.getElementById('cmd-palette-list');
  const catsEl = document.getElementById('cmd-palette-cats');
  const countEl = document.getElementById('cmd-palette-count');
  if (!listEl || !catsEl) return;

  const all = paletteAllCommands();
  const cats = ['all', ...[...new Set(all.map((c) => c.cat))]];
  catsEl.innerHTML = cats.map((c) =>
    `<button type="button" class="cat-chip${paletteCategory === c ? ' active' : ''}" data-cat="${escAttr(c)}">${c === 'all' ? '全部' : escHtml(c)}</button>`
  ).join('');
  catsEl.querySelectorAll('.cat-chip').forEach((btn) => {
    btn.onclick = () => { paletteCategory = btn.dataset.cat || 'all'; renderPalette(); };
  });

  const searchEl = document.getElementById('cmd-palette-search');
  const q = (searchEl && searchEl.value ? searchEl.value : '').trim().toLowerCase();
  const filtered = all.filter((c) => {
    if (paletteCategory !== 'all' && c.cat !== paletteCategory) return false;
    if (!q) return true;
    return (c.name + ' ' + c.cmd + ' ' + (c.desc || '') + ' ' + c.cat).toLowerCase().includes(q);
  });

  if (!filtered.length) {
    listEl.innerHTML = '<div class="cmd-palette-empty">没有匹配的命令，换个关键词试试</div>';
  } else {
    listEl.innerHTML = filtered.slice(0, 300).map((c) => `
      <button type="button" class="cmd-item" data-cmd="${escAttr(c.cmd)}">
        <span class="cmd-item-top">
          <span class="cmd-item-name">${escHtml(c.name)}</span>
          <span class="cmd-item-badge">${escHtml(c.cat)}</span>
        </span>
        <span class="cmd-item-cmd">${escHtml(c.cmd)}</span>
        <span class="cmd-item-desc">${escHtml(c.desc || '')}</span>
      </button>`).join('');
  }
  if (countEl) countEl.textContent = `共 ${filtered.length} 条`;

  listEl.querySelectorAll('.cmd-item').forEach((item) => {
    item.onclick = (e) => {
      const cmd = item.dataset.cmd || '';
      if (e.shiftKey) { closePalette(); consoleInput.value = cmd; sendConsoleCmd(); return; }
      consoleInput.value = cmd;
      consoleInput.focus();
      const end = consoleInput.value.length;
      try { consoleInput.setSelectionRange(end, end); } catch (err) {}
      toast('已填入输入框，替换 {占位符} 后按 Enter 发送', 'info');
    };
    item.oncontextmenu = (e) => {
      e.preventDefault();
      const cmd = item.dataset.cmd || '';
      try { navigator.clipboard.writeText(cmd); toast('命令已复制', 'success'); } catch (err) {}
    };
  });
}

function openPalette() {
  const el = document.getElementById('cmd-palette');
  const btn = document.getElementById('btn-cmd-palette');
  if (!el) return;
  paletteOpen = true;
  el.classList.remove('u-hidden');
  if (btn) btn.classList.add('is-open');
  renderPalette();
  const s = document.getElementById('cmd-palette-search');
  if (s) { s.value = ''; s.focus(); }
}

function closePalette() {
  const el = document.getElementById('cmd-palette');
  const btn = document.getElementById('btn-cmd-palette');
  if (!el) return;
  paletteOpen = false;
  el.classList.add('u-hidden');
  if (btn) btn.classList.remove('is-open');
}

function togglePalette() { if (paletteOpen) closePalette(); else openPalette(); }

async function loadCustomCommands() {
  try {
    const list = api.getCustomCommands ? await api.getCustomCommands() : [];
    paletteCustom = (Array.isArray(list) ? list : []).map((c) => ({
      name: String(c.name || c.label || c.cmd || c.command || '自定义命令'),
      cmd: String(c.command || c.cmd || c.value || ''),
      desc: String(c.desc || c.description || ''),
    })).filter((c) => c.cmd);
    if (paletteOpen) renderPalette();
  } catch (e) { paletteCustom = []; }
}

function classifyLine(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('[chat]') || t.includes('say ') || t.includes('聊天')) return 'type-chat';
  if (
    t.includes('joined') || t.includes('entering') || t.includes('connected') ||
    t.includes('加入') || t.includes('进入服务器') || t.includes('上线')
  ) return 'type-join';
  if (
    t.includes('disconnected') || t.includes('leaving') ||
    t.includes('离开') || t.includes('退出服务器') || t.includes('下线')
  ) return 'type-leave';
  if (
    t.includes('killed') || t.includes('died') || t.includes('was shot') ||
    t.includes('was killed') || t.includes('hit') || t.includes('suicided') ||
    t.includes('击杀') || t.includes('被击杀') || t.includes('死亡')
  ) return 'type-kill';
  if (t.includes('error') || t.includes('exception') || t.includes('错误') || t.includes('失败')) return 'type-error';
  if (t.includes('warning') || t.includes('warn') || t.includes('警告')) return 'type-warn';
  return 'type-normal';
}

function renderConsoleLine(line) {
  const { ts, text, cls } = line;
  const el = document.createElement('div');
  el.className = `console-line ${cls}${line.history ? ' is-history' : ''}`;
  el.dataset.type = cls;
  el.innerHTML = `<span class="ts">${escHtml(ts)}</span><span class="msg">${escHtml(text)}</span>`;
  return el;
}

/** 单行是否匹配当前过滤（比每次全量遍历 5000 行便宜得多） */
function consoleLineMatches(line) {
  const filter = state.consoleFilter || 'all';
  const searchEl = document.getElementById('console-search');
  const search = (searchEl && searchEl.value) ? searchEl.value.toLowerCase() : '';
  let match = filter === 'all';
  if (!match) {
    const cat = consoleCategory(line.cls);
    match = filter === 'join' ? cat === 'join' : cat === filter;
  }
  const matchSearch = !search || String(line.text || '').toLowerCase().includes(search);
  return match && matchSearch;
}

api.onRconConsole((data) => {
  const text = data.text || '';
  if (!text.trim()) return;

  // 控制台噪声过滤：定时拉取的 FPS/Entities 回包不需要出现在“控制台”面板
  const t = String(text);
  // 仅精确过滤状态轮询相关噪音，避免误杀正常日志
  const isFpsNoise = /(?:^|\s)(?:server\.fps\b|["']server\.fps["']\s*[=:])|^\s*\d+(?:\.\d+)?\s*fps\s*$/i.test(t);
  const isEntitiesNoise =
    /(?:^|\s)(?:server\.entities\b|["']server\.entities["']\s*[=:])|^\s*entities?\s*[:=]\s*\d+\s*$/i.test(t);

  const isPlayerListNoise =
    /^\s*\[\s*\{[\s\S]*\}\s*\]\s*$/.test(t) &&
    /"SteamID"\s*:\s*"?\d{10,}"?/i.test(t);

  if (isFpsNoise || isEntitiesNoise || isPlayerListNoise) return;

  const cls = classifyLine(text);
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const lineData = { ts, text, cls, t: Date.now() };
  pushConsoleLine(lineData);

  // 在线玩家列表：仅在“玩家加入/离开”时按需刷新一次（去抖）
  if (state.connected && (cls === 'type-join' || cls === 'type-leave')) {
    schedulePlayersRefresh();
  }
});

let playersRefreshTimer = null;
function schedulePlayersRefresh() {
  if (playersRefreshTimer) clearTimeout(playersRefreshTimer);
  playersRefreshTimer = setTimeout(() => {
    playersRefreshTimer = null;
    refreshPlayers().catch(() => {});
  }, 1200);
}

// 控制台过滤器（仅绑定 #panel-console，避免与「使用日志」等面板的 .filter-btn 冲突）
function applyConsoleFilter() {
  if (!consoleArea) return;
  consoleArea.querySelectorAll('.console-line').forEach((el) => {
    const line = { cls: el.dataset.type, text: (el.querySelector('.msg') || el).textContent };
    el.style.display = consoleLineMatches(line) ? '' : 'none';
  });
}

document.querySelectorAll('#panel-console .filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#panel-console .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.consoleFilter = btn.dataset.filter || 'all';
    applyConsoleFilter();
  });
});

const consoleSearchEl = document.getElementById('console-search');
consoleSearchEl.addEventListener('input', () => {
  const clearBtn = document.getElementById('console-search-clear');
  if (clearBtn) clearBtn.classList.toggle('u-hidden', !consoleSearchEl.value);
  applyConsoleFilter();
});
document.getElementById('console-search-clear')?.addEventListener('click', () => {
  consoleSearchEl.value = '';
  document.getElementById('console-search-clear').classList.add('u-hidden');
  applyConsoleFilter();
  consoleSearchEl.focus();
});

// 跟随开关 + 手动滚动的联动
document.getElementById('btn-console-follow')?.addEventListener('click', () => setConsoleFollow(!consoleFollow));
consoleArea?.addEventListener('scroll', () => {
  const nearBottom = consoleArea.scrollHeight - consoleArea.scrollTop - consoleArea.clientHeight < 24;
  if (!nearBottom && consoleFollow) setConsoleFollow(false);
  else if (nearBottom && !consoleFollow) setConsoleFollow(true);
});
document.getElementById('console-newlines')?.addEventListener('click', () => { setConsoleFollow(true); });

// 清空（同时删除该服务器的本地日志文件）
document.getElementById('btn-clear-console').onclick = async () => {
  if (state.consoleLines.length && !confirm('清空控制台显示，并删除该服务器的本地控制台日志？此操作不可撤销。')) return;
  const key = consoleServerKey();
  if (consoleArea) consoleArea.innerHTML = '';
  state.consoleLines = [];
  consolePersistQueue = [];
  if (consolePersistTimer) { clearTimeout(consolePersistTimer); consolePersistTimer = null; }
  try { await api.consoleLogClear?.(key); } catch (e) {}
  showConsoleEmpty();
  updateConsoleCounts();
  hideNewLinesBadge();
  toast('控制台已清空', 'success');
};

document.getElementById('btn-open-logs')?.addEventListener('click', async () => {
  try {
    const r = await api.consoleLogReveal?.(consoleServerKey());
    if (r && r.ok === false) toast('打开日志目录失败: ' + (r.error || ''), 'error');
  } catch (e) { toast('打开日志目录失败', 'error'); }
});

document.getElementById('btn-save-console-local').onclick = async () => {
  try {
    if (!state.consoleLines.length) {
      toast('控制台暂无日志可保存', 'warn');
      return;
    }
    const content = state.consoleLines
      .map((line) => `[${line.ts}] ${line.text}`)
      .join('\n');
    const r = await api.saveConsoleLogLocal(content);
    if (!r?.ok) {
      toast(`保存失败: ${r?.error || '未知错误'}`, 'error');
      return;
    }
    toast('控制台日志已另存为本地 txt');
  } catch (e) {
    toast(`保存失败: ${e.message || e}`, 'error');
  }
};

// ===== 命令输入 / 历史 / 常用命令面板 =====
const consoleInput = document.getElementById('console-input');
let cmdHistoryIndex = 0;   // 指向 state.cmdHistory 的下标；等于长度表示"当前草稿"
let cmdDraft = '';

document.getElementById('btn-send-cmd').onclick = sendConsoleCmd;
document.getElementById('btn-cmd-palette')?.addEventListener('click', togglePalette);

const paletteSearchEl = document.getElementById('cmd-palette-search');
paletteSearchEl?.addEventListener('input', renderPalette);
paletteSearchEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = document.querySelector('#cmd-palette-list .cmd-item');
    if (first) { consoleInput.value = first.dataset.cmd || ''; consoleInput.focus(); }
  } else if (e.key === 'Escape') {
    closePalette();
    consoleInput.focus();
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
    e.preventDefault();
    togglePalette();
  } else if (e.key === 'Escape' && paletteOpen) {
    closePalette();
  }
});

consoleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendConsoleCmd(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); browseCmdHistory(1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); browseCmdHistory(-1); }
  else if (e.key === 'Escape') { consoleInput.value = ''; resetHistoryCursor(); }
});

function resetHistoryCursor() {
  cmdHistoryIndex = state.cmdHistory.length;
  cmdDraft = '';
}

function browseCmdHistory(dir) {
  const h = state.cmdHistory || [];
  if (!h.length) return;
  if (dir > 0) {                       // ↑ 往更旧
    if (cmdHistoryIndex === h.length) cmdDraft = consoleInput.value;
    cmdHistoryIndex = Math.max(0, cmdHistoryIndex - 1);
    consoleInput.value = h[cmdHistoryIndex] || '';
  } else {                             // ↓ 往更新
    cmdHistoryIndex = Math.min(h.length, cmdHistoryIndex + 1);
    consoleInput.value = cmdHistoryIndex === h.length ? cmdDraft : (h[cmdHistoryIndex] || '');
  }
  const end = consoleInput.value.length;
  try { consoleInput.setSelectionRange(end, end); } catch (e) {}
}

function loadCmdHistory() {
  try {
    const raw = localStorage.getItem(CONSOLE_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    state.cmdHistory = Array.isArray(arr) ? arr.filter((x) => typeof x === 'string').slice(-50) : [];
  } catch (e) { state.cmdHistory = []; }
  resetHistoryCursor();
}

function saveCmdHistory() {
  try { localStorage.setItem(CONSOLE_HISTORY_KEY, JSON.stringify((state.cmdHistory || []).slice(-50))); } catch (e) {}
}

async function sendConsoleCmd() {
  const cmd = consoleInput.value.trim();
  if (!cmd) return;
  if (!state.connected) { toast('未连接服务器', 'error'); return; }
  state.cmdHistory = (state.cmdHistory || []).filter((c) => c !== cmd);
  state.cmdHistory.push(cmd);
  if (state.cmdHistory.length > 50) state.cmdHistory.shift();
  saveCmdHistory();
  resetHistoryCursor();
  consoleInput.value = '';
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  pushConsoleLine({ ts, text: '> ' + cmd, cls: 'type-cmd', t: Date.now() });
  const r = await api.rconCommand(cmd);
  if (!r.ok) toast(`命令失败: ${r.error}`, 'error');
}

// 控制台初始化：历史命令（本地持久化）、空状态、过滤计数、自定义命令库
loadCmdHistory();
showConsoleEmpty();
updateConsoleCounts();
loadCustomCommands();
window.addEventListener('beforeunload', flushConsolePersist);

// ===== 聊天 =====
const chatArea = document.getElementById('chat-area');
const MAX_CHAT_LINES = 3000;
const CHAT_CONTINUE_MS = 2 * 60 * 1000;   // 同人 2 分钟内连发视为同一组

let chatFollow = true;
let chatPendingNew = 0;
let chatPlayerFilter = '';
let chatLastSid = '';
let chatLastAt = 0;
let chatLastDateKey = '';
let chatHistoryLoadedFor = '';   // 已回看过历史的服务器键

function chatServerKey() {
  const s = state.currentServer;
  if (s && s.IpAddress) return `${s.IpAddress}:${s.RconPort}`;
  return 'default';
}

function chatCounts() {
  const counts = { all: state.chatLog.length, '全部': 0, '队伍': 0, '卡组': 0, '管理': 0 };
  state.chatLog.forEach((m) => {
    const c = (m && m.channel) || '全部';
    if (counts[c] != null) counts[c]++;
  });
  return counts;
}

function updateChatCounts() {
  const counts = chatCounts();
  document.querySelectorAll('#panel-chat .fbtn-cnt').forEach((el) => {
    const k = el.dataset.chatcnt;
    el.textContent = counts[k] != null ? counts[k] : 0;
  });
}

function chatMsgMatches(el) {
  const q = (document.getElementById('chat-search')?.value || '').trim().toLowerCase();
  const ch = state.chatChannel || 'all';
  const matchCh = ch === 'all' || el.dataset.channel === ch;
  const matchPlayer = !chatPlayerFilter || el.dataset.steamid === chatPlayerFilter;
  const matchSearch = !q || String(el.dataset.search || '').includes(q);
  return matchCh && matchPlayer && matchSearch;
}

function applyChatFilter() {
  if (!chatArea) return;
  chatArea.querySelectorAll('.chat-msg').forEach((el) => { el.style.display = chatMsgMatches(el) ? '' : 'none'; });
  updateChatCounts();
}

function setChatPlayerFilter(steamid, name) {
  const chip = document.getElementById('chat-filter-chip');
  if (!steamid || chatPlayerFilter === steamid) {
    chatPlayerFilter = '';
    if (chip) { chip.classList.add('u-hidden'); chip.textContent = ''; }
  } else {
    chatPlayerFilter = steamid;
    if (chip) { chip.classList.remove('u-hidden'); chip.textContent = `只看：${name || steamid} ✕`; }
  }
  applyChatFilter();
}

function hideChatNewBadge() {
  chatPendingNew = 0;
  const el = document.getElementById('chat-newlines');
  if (el) el.classList.remove('is-visible');
}

function chatScrollToBottom() {
  if (!chatArea) return;
  chatArea.scrollTop = chatArea.scrollHeight;
  hideChatNewBadge();
}

function setChatFollow(on) {
  chatFollow = !!on;
  const btn = document.getElementById('btn-chat-follow');
  if (btn) {
    btn.classList.toggle('is-active', chatFollow);
    btn.textContent = chatFollow ? '跟随' : '已暂停';
  }
  if (chatFollow) chatScrollToBottom();
}

function showChatEmpty() {
  if (!chatArea) return;
  chatArea.innerHTML =
    '<div class="chat-empty">' +
    '<div>还没有聊天记录</div>' +
    '<div class="hint">连接服务器后，玩家聊天会实时出现在这里</div>' +
    '<div class="hint">记录会自动保存到本地 ChatLogs 文件夹，重连后可回看</div>' +
    '</div>';
}

function addChatDivider(text, className) {
  if (!chatArea) return null;
  const el = document.createElement('div');
  el.className = className || 'chat-history-sep';
  el.textContent = text;
  chatArea.appendChild(el);
  return el;
}

function chatDateLabel(d) {
  const today = new Date();
  const y = new Date(today.getTime() - 86400000);
  const key = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (key(d) === key(today)) return '今天';
  if (key(d) === key(y)) return '昨天';
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** 构建一条聊天 DOM；同一玩家连发时折叠重复的时间/昵称，视觉成组 */
function buildChatMessage(data, isHistory) {
  const sid = String(data?.steamid || '').trim();
  const meta = getPlayerMeta(sid);
  if (!isHistory && meta.ignoreAdmin && String(data?.channel || '') === '管理') return null;

  const d = new Date(data.time || Date.now());
  const dateKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const sameUser = !!sid && sid === chatLastSid && (d.getTime() - chatLastAt) < CHAT_CONTINUE_MS;
  const now = new Date();
  const isToday = dateKey === `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const timeStr = isToday
    ? d.toLocaleTimeString('zh-CN', { hour12: false })
    : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const chClass = data.channel === '队伍' ? 'ch-team' : data.channel === '管理' ? 'ch-admin' : 'ch-all';

  const el = document.createElement('div');
  el.className = 'chat-msg' + (isHistory ? ' chat-msg-history' : '') + (sameUser ? ' is-continuation' : '');
  el.dataset.channel = data.channel || '全部';
  el.dataset.steamid = sid;
  el.dataset.search = ((data.username || '') + ' ' + (data.text || '') + ' ' + (data.channel || '')).toLowerCase();
  el.innerHTML =
    `<span class="chat-time">${escHtml(timeStr)}</span>` +
    `<span class="chat-channel ${chClass}">${escHtml(data.channel || '全部')}</span>` +
    `<span class="chat-user" title="点击只看该玩家">${escHtml(data.username || '?')}</span>` +
    `<span class="chat-text">${escHtml(data.text || '')}</span>` +
    '<span class="chat-actions">' +
    '<button class="chat-act" data-chat-act="copy" title="复制这条消息">⧉</button>' +
    (sid ? '<button class="chat-act" data-chat-act="only" title="只看该玩家">☰</button>' : '') +
    '</span>';

  chatLastSid = sid;
  chatLastAt = d.getTime();
  chatLastDateKey = dateKey;
  return el;
}

/** 统一入口：DOM + 内存 + 计数 + 跟随 + 日期分隔 */
function pushChatMessage(data, opts) {
  const o = opts || {};
  if (!chatArea) return null;
  const empty = chatArea.querySelector('.chat-empty');
  if (empty) empty.remove();
  const d = new Date(data.time || Date.now());
  const dateKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (!o.history && chatLastDateKey && dateKey !== chatLastDateKey) {
    addChatDivider(chatDateLabel(d), 'chat-date-sep');
  }
  const el = buildChatMessage(data, !!o.history);
  if (!el) return null;
  chatArea.appendChild(el);
  state.chatLog.push(data);
  while (state.chatLog.length > MAX_CHAT_LINES) {
    state.chatLog.shift();
    const first = chatArea.querySelector('.chat-msg');
    if (first) first.remove();
  }
  try { if (!chatMsgMatches(el)) el.style.display = 'none'; } catch (e) {}
  updateChatCounts();
  if (!o.silent) {
    if (chatFollow) chatScrollToBottom();
    else { chatPendingNew++; const b = document.getElementById('chat-newlines'); if (b) { b.textContent = `↓ ${chatPendingNew} 条新消息`; b.classList.add('is-visible'); } }
  }
  return el;
}

// 加载并渲染历史聊天记录（连接服务器后调用）
async function loadHistoryChatMessages(serverKey) {
  if (!chatArea) return;
  try {
    const r = await api.chatLogLoad(serverKey, 2000);
    if (!r?.ok || !r.msgs?.length) {
      if (!state.chatLog.length) showChatEmpty();
      return;
    }
    if (chatHistoryLoadedFor === serverKey) return;   // 同一服务器只回看一次，避免重复插入
    chatHistoryLoadedFor = serverKey;
    const msgs = r.msgs;
    // 历史记录整体插到最上方：先临时关闭分组状态，避免与实时消息串组
    const prevSid = chatLastSid, prevAt = chatLastAt, prevDate = chatLastDateKey;
    chatLastSid = ''; chatLastAt = 0; chatLastDateKey = '';
    const frag = document.createDocumentFragment();
    msgs.forEach((m) => {
      const el = buildChatMessage(m, true);
      if (el) { el.style.display = ''; frag.appendChild(el); }
    });
    const sep = document.createElement('div');
    sep.className = 'chat-history-sep';
    sep.textContent = `历史记录（${msgs.length} 条 · 来自本地）`;
    chatArea.insertBefore(sep, chatArea.firstChild);
    chatArea.insertBefore(frag, sep.nextSibling);
    chatLastSid = prevSid; chatLastAt = prevAt; chatLastDateKey = prevDate;
    msgs.forEach((m) => state.chatLog.push(m));
    applyChatFilter();
    setChatFollow(true);
  } catch (e) {
    console.warn('[ChatHistory] load failed:', e);
  }
}

api.onRconChat((data) => {
  // 主进程已负责落盘（队列 + 定时 flush），渲染层只管展示
  pushChatMessage(data, {});
});

// 频道过滤按钮
document.querySelectorAll('.channel-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.channel-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.chatChannel = btn.dataset.channel || 'all';
    applyChatFilter();
  });
});

// 搜索 / 清空搜索
const chatSearchEl = document.getElementById('chat-search');
chatSearchEl?.addEventListener('input', () => {
  const clearBtn = document.getElementById('chat-search-clear');
  if (clearBtn) clearBtn.classList.toggle('u-hidden', !chatSearchEl.value);
  applyChatFilter();
});
document.getElementById('chat-search-clear')?.addEventListener('click', () => {
  chatSearchEl.value = '';
  document.getElementById('chat-search-clear').classList.add('u-hidden');
  applyChatFilter();
  chatSearchEl.focus();
});

// 跟随 + 滚动联动 + 新消息胶囊
document.getElementById('btn-chat-follow')?.addEventListener('click', () => setChatFollow(!chatFollow));
chatArea?.addEventListener('scroll', () => {
  const nearBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < 24;
  if (!nearBottom && chatFollow) setChatFollow(false);
  else if (nearBottom && !chatFollow) setChatFollow(true);
});
document.getElementById('chat-newlines')?.addEventListener('click', () => setChatFollow(true));

// 点击昵称或按钮：只看某玩家 / 复制消息
document.getElementById('chat-filter-chip')?.addEventListener('click', () => setChatPlayerFilter('', ''));
chatArea?.addEventListener('click', async (e) => {
  const msgEl = e.target.closest('.chat-msg');
  const actBtn = e.target.closest('[data-chat-act]');
  if (actBtn && msgEl) {
    const act = actBtn.dataset.chatAct;
    if (act === 'copy') {
      const text = msgEl.querySelector('.chat-text')?.textContent || '';
      try { await navigator.clipboard.writeText(text); toast('已复制该条消息', 'success'); } catch (err) { toast('复制失败', 'error'); }
    } else if (act === 'only') {
      setChatPlayerFilter(msgEl.dataset.steamid, msgEl.querySelector('.chat-user')?.textContent || '');
    }
    return;
  }
  const userEl = e.target.closest('.chat-user');
  if (userEl && msgEl) setChatPlayerFilter(msgEl.dataset.steamid, userEl.textContent || '');
});

// 导出 / 打开目录 / 清空
document.getElementById('btn-save-chat')?.addEventListener('click', async () => {
  if (!state.chatLog.length) { toast('暂无聊天记录可导出', 'warn'); return; }
  const content = state.chatLog
    .map((m) => `[${new Date(m.time || Date.now()).toLocaleString('zh-CN')}] [${m.channel || '全部'}] ${m.username || '?'}(${m.steamid || ''}): ${m.text || ''}`)
    .join('\n');
  try {
    const r = await api.saveChatExport?.(chatServerKey(), content);
    if (r && r.ok) toast('已导出到 ChatLogs 文件夹', 'success');
    else toast('导出失败: ' + ((r && r.error) || '未知错误'), 'error');
  } catch (e) { toast('导出失败: ' + (e.message || e), 'error'); }
});
document.getElementById('btn-open-chatlogs')?.addEventListener('click', async () => {
  try { await api.chatLogReveal?.(chatServerKey()); } catch (e) { toast('打开目录失败', 'error'); }
});
document.getElementById('btn-clear-chat').onclick = async () => {
  if (state.chatLog.length && !confirm('清空聊天显示，并删除该服务器的本地聊天记录？此操作不可撤销。')) return;
  const key = chatServerKey();
  state.chatLog = [];
  chatLastSid = ''; chatLastAt = 0; chatLastDateKey = '';
  showChatEmpty();
  updateChatCounts();
  hideChatNewBadge();
  try { await api.chatLogClear?.(key); } catch (e) {}
  toast('聊天记录已清空', 'success');
};

document.getElementById('btn-send-chat').onclick = async () => {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  if (!state.connected) { toast('未连接服务器', 'error'); return; }
  const r = await api.rconCommand(`say ${msg}`);
  if (!r || !r.ok) { toast('广播失败: ' + ((r && r.error) || ''), 'error'); return; }
  input.value = '';
  const data = { channel: '管理', username: 'SERVER', steamid: '', text: msg, time: new Date().toISOString() };
  pushChatMessage(data, {});
  try { api.chatLogAppend?.(chatServerKey(), [data]); } catch (e) {}
};
document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-send-chat').click();
});

// 自动保存状态：定时任务每 60 秒回传一次
api.onAutoSaveTick?.((info) => {
  const el = document.getElementById('chat-autosave');
  if (!el || !info) return;
  const t = info.time ? new Date(info.time).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  el.classList.remove('is-saving');
  el.textContent = `已自动保存 ${t}`;
  el.title = `已整理 ${info.chatFiles || 0} 个聊天文件 · 清理 ${info.pruned || 0} 条过期记录 · 落盘 ${info.flushed || 0} 条`;
});

(async () => {
  updateChatCounts();
  showChatEmpty();
  try {
    const st = await api.getAutoSaveStatus?.();
    const el = document.getElementById('chat-autosave');
    if (el && st && st.time) {
      el.textContent = `已自动保存 ${new Date(st.time).toLocaleTimeString('zh-CN', { hour12: false })}`;
      el.title = `每 ${Math.round((st.intervalMs || 60000) / 1000)} 秒自动保存到本地 ChatLogs / Logs 文件夹`;
    }
  } catch (e) {}
})();

// ===== 在线玩家 =====
let currentPlayerTarget = null;

async function refreshPlayers() {
  if (!state.connected) return;
  const btn = document.getElementById('btn-refresh-players');
  const firstLoad = playerRowMap.size === 0;
  if (firstLoad) renderPlayersSkeleton(6);   // 首次加载显示骨架屏，而不是空白
  if (btn) btn.classList.add('is-loading');
  try {
    const r = await api.getPlayers();
    if (!r.ok) { if (firstLoad) renderPlayers([]); return; }
    state.players = r.players || [];
    document.getElementById('stat-online').textContent = state.players.length;
    updateConnText();
    renderPlayers(state.players);
    try { updateBattlePlayerSelect(); } catch (e) {}
    ensureSteamGameBanInfo(state.players).catch(() => {});
    ensureIpGeoInfo(state.players).catch(() => {});
    syncItemShopAfterPlayersRefresh();
  } finally {
    if (btn) btn.classList.remove('is-loading');
  }
}

const STEAM_GAME_BAN_CACHE_TTL_MS = 6 * 3600 * 1000; // 6 小时（成功结果）
const STEAM_GAME_BAN_FAIL_RETRY_MS = 2 * 60 * 1000;  // 失败结果 2 分钟后重试

async function ensureSteamGameBanInfo(players) {
  if (!api.getSteamGameBansBatch) return;
  const now = Date.now();

  const unique = new Set();
  (players || []).forEach((p) => {
    const sid = String(p.SteamID || '').trim();
    if (sid) unique.add(sid);
  });
  const steamids = [...unique];
  const missing = steamids.filter((sid) => {
    const item = state.steamGameBanInfoCache[sid];
    if (!item) return true;
    if (!item.fetchedAt) return true;
    // 抓取失败不做长缓存，尽快重试
    if (item.ok === false) return (now - item.fetchedAt) > STEAM_GAME_BAN_FAIL_RETRY_MS;
    return (now - item.fetchedAt) > STEAM_GAME_BAN_CACHE_TTL_MS;
  });

  if (!missing.length) return;

  // 分段请求，避免一次拉太多导致卡顿
  const CHUNK = 25;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    const r = await api.getSteamGameBansBatch(chunk);
    if (!r || !r.ok || !r.items) continue;
    Object.entries(r.items).forEach(([sid, info]) => {
      state.steamGameBanInfoCache[sid] = { ...info, fetchedAt: now };
    });
  }

  // 更新表格按钮上的封禁数量
  renderPlayers(state.players);
}

const IP_GEO_CACHE_TTL_MS = 24 * 3600 * 1000; // 24 小时
const IP_GEO_UI_VERSION = 5; // 归属地改为多源回退（ipapi.co 已 403）后重拉缓存

async function ensureIpGeoInfo(players) {
  if (!api.getIpGeoBatch) return;
  const now = Date.now();

  const uniqueIps = new Set();
  (players || []).forEach((p) => {
    const ip = parsePlayerAddressIp(p.Address || '');
    if (ip) uniqueIps.add(ip);
  });

  const ips = [...uniqueIps];
  const missing = ips.filter((ip) => {
    const item = state.ipGeoCache[ip];
    if (!item) return true;
    if (item.uiVersion !== IP_GEO_UI_VERSION) return true;
    if (!item.fetchedAt) return true;
    // 只回显了 IP 说明查询失败，短时间后允许重试（否则会被 24h 缓存锁死）
    if (item.locationText === ip) return (now - item.fetchedAt) > 10 * 60 * 1000;
    return (now - item.fetchedAt) > IP_GEO_CACHE_TTL_MS;
  });

  if (!missing.length) return;

  const CHUNK = 40;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    const r = await api.getIpGeoBatch(chunk);
    if (!r || !r.ok || !r.items) continue;
    Object.entries(r.items).forEach(([ip, info]) => {
      const locationText = info?.locationText || ip;
      state.ipGeoCache[ip] = { locationText, fetchedAt: now, uiVersion: IP_GEO_UI_VERSION };
    });
  }

  renderPlayers(state.players);
}

// ===== 在线玩家表格：差量渲染 =====
// 旧实现每 1.2s 整体重写 tbody.innerHTML，导致无法做任何进入/离开动效，
// 悬停态与按钮状态也会被清掉。这里改为按 SteamID 复用 DOM 节点，只更新变化的部分。
const playerRowMap = new Map();      // steamid -> { el, sig, banCount, pingLevel }
let playerCtxBound = false;
const PLAYER_ROW_LEAVE_MS = 200;

function pingLevel(ping) { return ping < 80 ? 'good' : ping < 150 ? 'mid' : 'bad'; }
function formatCoord(pos) {
  if (!pos) return '-';
  return Math.round(pos.x || 0) + ',' + Math.round(pos.y || 0) + ',' + Math.round(pos.z || 0);
}

const ICON_DETAIL = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="3.4" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="12.6" cy="8" r="1.5"/></svg>';
const ICON_KICK = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.4 3H4v10h2.4"/><path d="M9.6 5.4L12.6 8l-3 2.6"/><path d="M12.4 8H7"/></svg>';
const ICON_BAN = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5.4"/><path d="M4.2 11.8L11.8 4.2" stroke-linecap="round"/></svg>';

/** 行内容签名：不含原始延迟（延迟单独就地更新，避免每次刷新都重建 DOM） */
function playerSignature(p) {
  const sid = String(p.SteamID || '').trim();
  const ip = p.Address ? (parsePlayerAddressIp(String(p.Address)) || '') : '';
  const geo = ip ? state.ipGeoCache[ip] : null;
  const meta = getPlayerMeta(sid);
  const ban = sid ? state.steamGameBanInfoCache[sid] : null;
  return [
    p.DisplayName || p.Name || '',
    String(p.SteamID || ''),
    ip,
    (geo && geo.locationText) || '',
    Math.floor((parseInt(p.Ping) || 0) / 10),   // 10ms 粒度，减少无意义重建
    p.ConnectedSeconds | 0,
    p.TimeBan || '',
    (ban && ban.count != null) ? ban.count : '',
    (ban && ban.vacCount != null) ? ban.vacCount : '',
    meta.marked ? 1 : 0,
  ].join('\u0001');
}

function playerRowCells(p) {
  const sid = String(p.SteamID || '').trim();
  const meta = getPlayerMeta(sid);
  const name = p.DisplayName || p.Name || '?';
  const addr = p.Address ? String(p.Address) : '';
  const ip = addr ? (parsePlayerAddressIp(addr) || '-') : '-';
  const geo = ip !== '-' ? state.ipGeoCache[ip] : null;
  const locText = formatGeoText((geo && geo.locationText) ? geo.locationText : '-');
  const ping = parseInt(p.Ping) || 0;
  const lvl = pingLevel(ping);
  const barW = Math.max(6, Math.min(100, ping / 3));
  const onlineTime = p.ConnectedSeconds ? formatDuration(p.ConnectedSeconds) : '-';
  const ban = sid ? state.steamGameBanInfoCache[sid] : null;
  const banCount = (ban && ban.count != null) ? ban.count : null;
  const vacCount = (ban && ban.vacCount != null) ? ban.vacCount : null;
  const banDays = (ban && ban.daysSinceLastBan != null) ? ban.daysSinceLastBan : null;
  const banTitle = [
    banCount != null ? ('游戏封禁 ' + banCount) : null,
    vacCount ? ('VAC ' + vacCount) : null,
    banDays != null ? ('距上次 ' + banDays + ' 天') : null,
  ].filter(Boolean).join(' · ') || '点击查看 Steam 封禁详情';
  const timeBan = p.TimeBan
    ? new Date(p.TimeBan).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';
  return `<td class="col-player">
      <div class="p-id">
        <div class="p-id-main">
          <span class="p-name" title="${escAttr(name)}"><b>${escHtml(name)}</b>${meta.marked ? '<i class="p-mark" title="已标记">★</i>' : ''}</span>
          <span class="p-sid" title="SteamID">${escHtml(sid || '-')}</span>
        </div>
      </div>
    </td>
    <td class="col-addr">
      <div class="p-addr">
        <span class="p-ip">${escHtml(ip)}</span>
        <span class="p-city" title="${escAttr(locText)}">${escHtml(locText)}</span>
      </div>
    </td>
    <td class="col-ping">
      <div class="p-ping p-ping-${lvl}" title="${ping} ms">
        <span class="p-ping-val">${ping}<i>ms</i></span>
        <span class="p-ping-bar"><i style="width:${barW}%"></i></span>
      </div>
    </td>
    <td class="col-pos"><span class="p-pos">${escHtml(formatCoord(p.Position))}</span></td>
    <td class="col-time"><span class="p-time">${escHtml(onlineTime)}</span></td>
    <td class="col-ban">
      <div class="p-ban">
        ${timeBan ? `<span class="p-timeban" title="临时封禁到期时间">${escHtml(timeBan)}</span>` : ''}
        <button class="ban-chip${(banCount || vacCount) ? ' is-hit' : ''}" data-act="steambans" data-sid="${escAttr(sid)}"${sid ? '' : ' disabled'} title="${escAttr(banTitle)}">${banCount == null ? '—' : banCount}</button>
      </div>
    </td>
    <td class="col-act">
      <div class="p-actions">
        <button class="p-act" data-act="modal" data-sid="${escAttr(sid)}" title="玩家详情 / 更多操作" aria-label="玩家详情">${ICON_DETAIL}</button>
        <button class="p-act p-act-kick" data-act="kick" data-sid="${escAttr(sid)}" title="踢出该玩家" aria-label="踢出">${ICON_KICK}</button>
        <button class="p-act p-act-ban" data-act="ban" data-sid="${escAttr(sid)}" title="封禁该玩家" aria-label="封禁">${ICON_BAN}</button>
      </div>
    </td>`;
}

function updatePingCell(row, p) {
  const cell = row.querySelector('.p-ping');
  if (!cell) return;
  const ping = parseInt(p.Ping) || 0;
  const lvl = pingLevel(ping);
  const val = cell.querySelector('.p-ping-val');
  if (val) val.innerHTML = ping + '<i>ms</i>';
  const bar = cell.querySelector('.p-ping-bar > i');
  if (bar) bar.style.width = Math.max(6, Math.min(100, ping / 3)) + '%';
  cell.className = 'p-ping p-ping-' + lvl;
}

/** 行之间平滑换位（FLIP）：先记录位置，重排后反向位移再过渡到 0 */
function flipRows(rows) {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const before = new Map();
  rows.forEach((el) => before.set(el, el.getBoundingClientRect().top));
  return () => {
    rows.forEach((el) => {
      const prev = before.get(el);
      if (prev == null) return;
      const delta = prev - el.getBoundingClientRect().top;
      if (!delta) return;
      el.style.transition = 'none';
      el.style.transform = 'translateY(' + delta + 'px)';
      requestAnimationFrame(() => {
        el.style.transition = 'transform 0.28s cubic-bezier(0.2, 0.8, 0.3, 1)';
        el.style.transform = '';
      });
    });
  };
}

function renderPlayersSkeleton(rows) {
  const tbody = document.getElementById('players-tbody');
  if (!tbody) return;
  const cols = ['', '', '', '', '', '', ''];
  tbody.innerHTML = Array.from({ length: rows || 6 }).map(() =>
    '<tr class="skeleton-row">' + cols.map(() => '<td><span class="sk"></span></td>').join('') + '</tr>'
  ).join('');
}

function renderPlayers(players) {
  players = Array.isArray(players) ? players : [];
  const searchEl = document.getElementById('player-search');
  const q = (searchEl ? searchEl.value : '').toLowerCase();
  const filtered = q ? players.filter((p) =>
    (p.DisplayName || '').toLowerCase().includes(q) ||
    (p.SteamID || '').includes(q) ||
    (p.Address || '').includes(q)
  ) : players;

  // 计数：显示“在线总数”，过滤时额外显示匹配数（旧实现把过滤后的数量当成在线总数）
  const countEl = document.getElementById('player-count');
  if (countEl) countEl.textContent = players.length;
  const filterChip = document.getElementById('player-count-filter');
  if (filterChip) {
    const showFilter = !!q && filtered.length !== players.length;
    filterChip.textContent = showFilter ? '· 匹配 ' + filtered.length : '';
    filterChip.classList.toggle('u-hidden', !showFilter);
  }
  if (searchEl) {
    const clearBtn = document.getElementById('player-search-clear');
    if (clearBtn) clearBtn.classList.toggle('u-hidden', !searchEl.value);
  }

  const tbody = document.getElementById('players-tbody');
  if (!tbody) return;

  if (!filtered.length) {
    playerRowMap.clear();
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">
      <div class="empty-state">
        <svg viewBox="0 0 48 48" width="42" height="42" fill="none" aria-hidden="true">
          <circle cx="24" cy="17" r="8.5" stroke="currentColor" stroke-width="2" opacity="0.55"/>
          <path d="M9 41c0-8.3 6.7-15 15-15s15 6.7 15 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>
          <circle cx="24" cy="17" r="3" fill="currentColor" opacity="0.5"/>
        </svg>
        <p>${q ? '没有匹配的玩家' : '暂无在线玩家'}</p>
        <span class="empty-sub">${q ? '换个关键词试试，或清空搜索框' : '连接服务器后这里会显示实时在线列表'}</span>
      </div>
    </td></tr>`;
    return;
  }

  // 清掉所有占位行（空状态 / 骨架屏）：之前只删第一个，骨架屏会残留
  tbody.querySelectorAll('.empty-row, .skeleton-row').forEach((el) => el.remove());

  const flip = flipRows([...playerRowMap.values()].map((v) => v.el).filter((el) => el.isConnected));
  const seen = new Set();
  const ordered = [];

  filtered.forEach((p) => {
    const sid = String(p.SteamID || '').trim();
    const key = sid || ('anon:' + (p.DisplayName || p.Name || Math.random()));
    seen.add(key);
    const sig = playerSignature(p);
    let entry = playerRowMap.get(key);
    if (!entry || !entry.el.isConnected) {
      const el = document.createElement('tr');
      el.className = 'player-row is-new';
      el.setAttribute('data-steamid', sid);
      el.innerHTML = playerRowCells(p);
      entry = { el, sig, banCount: null };
      playerRowMap.set(key, entry);
    } else if (entry.sig !== sig) {
      const prevBan = entry.banCount;
      const prevLvl = entry.pingLevel;
      const ban = sid ? state.steamGameBanInfoCache[sid] : null;
      const banCount = (ban && ban.count != null) ? ban.count : null;
      entry.el.innerHTML = playerRowCells(p);
      entry.sig = sig;
      // 只在“看得出来”的变化上闪一下，避免每次刷新都闪
      if ((prevBan !== null && banCount !== null && prevBan !== banCount) || (prevLvl && prevLvl !== pingLevel(parseInt(p.Ping) || 0))) {
        entry.el.classList.remove('is-flash');
        void entry.el.offsetWidth;
        entry.el.classList.add('is-flash');
      }
    }
    entry.pingLevel = pingLevel(parseInt(p.Ping) || 0);
    const ban = sid ? state.steamGameBanInfoCache[sid] : null;
    entry.banCount = (ban && ban.count != null) ? ban.count : null;
    updatePingCell(entry.el, p);
    ordered.push(entry.el);
  });

  // 离开的玩家：播完淡出动画再移除
  [...playerRowMap.keys()].forEach((key) => {
    if (seen.has(key)) return;
    const entry = playerRowMap.get(key);
    playerRowMap.delete(key);
    if (entry && entry.el.isConnected) {
      entry.el.classList.add('is-leaving');
      setTimeout(() => entry.el.remove(), PLAYER_ROW_LEAVE_MS);
    }
  });

  // 按新顺序重排（appendChild 可同时完成移动），再播放 FLIP 位移
  ordered.forEach((el) => tbody.appendChild(el));
  flip();

  // 进入动画结束后清掉标记类，避免重复播放
  tbody.querySelectorAll('.player-row.is-new').forEach((el) => {
    setTimeout(() => el.classList.remove('is-new'), 420);
  });

  bindPlayerContextMenu();
}

// 右键菜单：改为 tbody 上的事件委托，绑一次即可（差量渲染不会丢）
function bindPlayerContextMenu() {
  const tbody = document.getElementById('players-tbody');
  const menu = document.getElementById('player-context-menu');
  if (!tbody || !menu || playerCtxBound) return;
  playerCtxBound = true;
  tbody.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.player-row');
    if (!row) return;
    e.preventDefault();
    const sid = row.getAttribute('data-steamid') || '';
    currentContextPlayer = (state.players || []).find((p) => String(p.SteamID || '') === sid) || null;
    if (!currentContextPlayer) return;
    const meta = getPlayerMeta(currentContextPlayer.SteamID);
    const markBtn = document.getElementById('ctx-mark');
    if (markBtn) markBtn.textContent = meta.marked ? '取消标记' : '设置标记';
    menu.style.display = 'block';
    menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 220) + 'px';
  });
}

// 行内操作按钮：同样用委托，彻底摆脱内联 onclick 拼字符串
// （旧写法遇到名字里有单引号/引号的玩家会直接 SyntaxError 导致按钮失效）
document.getElementById('players-tbody')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const sid = btn.getAttribute('data-sid') || '';
  const player = (state.players || []).find((p) => String(p.SteamID || '') === sid) || null;
  const name = player ? (player.DisplayName || player.Name || sid) : sid;
  const act = btn.getAttribute('data-act');
  if (act === 'modal') {
    if (player) openPlayerModal(player);
  } else if (act === 'kick') {
    if (player) quickKick(sid, name);
  } else if (act === 'ban') {
    if (player) quickBan(sid, name);
  } else if (act === 'steambans') {
    if (sid) openSteamBanDetails(sid);
  }
});

document.addEventListener('click', () => {
  const menu = document.getElementById('player-context-menu');
  if (menu) menu.style.display = 'none';
});

document.getElementById('ctx-open-steam')?.addEventListener('click', () => {
  if (!currentContextPlayer?.SteamID) return;
  api.openUrl(`https://steamcommunity.com/profiles/${currentContextPlayer.SteamID}`);
});
document.getElementById('ctx-open-profile')?.addEventListener('click', () => {
  if (!currentContextPlayer?.SteamID) return;
  openPlayerProfileModal(currentContextPlayer);
});
document.getElementById('ctx-mark')?.addEventListener('click', () => {
  if (!currentContextPlayer?.SteamID) return;
  const sid = currentContextPlayer.SteamID;
  const meta = getPlayerMeta(sid);
  setPlayerMeta(sid, { marked: !meta.marked });
  addPlayerHistory(sid, meta.marked ? '取消标记' : '设置标记');
  renderPlayers(state.players);
});
document.getElementById('ctx-note')?.addEventListener('click', () => {
  if (!currentContextPlayer?.SteamID) return;
  openPlayerProfileModal(currentContextPlayer);
});

// ===== 玩家属性弹窗 =====
let _profileTarget = null;

function openPlayerProfileModal(player) {
  _profileTarget = player;
  const sid = player.SteamID || '';
  const meta = getPlayerMeta(sid);
  const histAll = loadPlayerHistoryStore()[sid] || [];

  // 填充基础信息
  document.getElementById('profile-modal-name').textContent =
    player.DisplayName || player.Name || sid || '?';
  document.getElementById('profile-modal-steamid').textContent = sid || '-';
  document.getElementById('profile-modal-ip').textContent =
    player.Address ? (parsePlayerAddressIp(player.Address) || '-') : '-';
  document.getElementById('profile-modal-marked').textContent =
    meta.marked ? '★ 已标记' : '无';

  // 备注
  const noteInput = document.getElementById('profile-note-input');
  if (noteInput) noteInput.value = meta.note || '';

  // 历史记录
  const histList = document.getElementById('profile-history-list');
  const histCount = document.getElementById('profile-hist-count');
  if (histCount) histCount.textContent = histAll.length ? `(${histAll.length})` : '';
  if (histList) {
    if (!histAll.length) {
      histList.innerHTML = '<div class="empty-state u-py-18"><p>暂无历史记录</p></div>';
    } else {
      histList.innerHTML = histAll.slice(0, 50).map((x) => {
        const t = new Date(x.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        return `<div class="profile-hist-item">
          <span class="profile-hist-time">${t}</span>
          <span class="profile-hist-action">${escHtml(x.action)}</span>
          ${x.detail ? `<span class="profile-hist-detail">${escHtml(x.detail)}</span>` : ''}
        </div>`;
      }).join('');
    }
  }

  document.getElementById('player-profile-modal').style.display = 'flex';
}

document.getElementById('btn-close-profile-modal')?.addEventListener('click', () => {
  document.getElementById('player-profile-modal').style.display = 'none';
});
document.getElementById('player-profile-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
});
document.getElementById('btn-profile-save-note')?.addEventListener('click', () => {
  if (!_profileTarget?.SteamID) return;
  const sid = _profileTarget.SteamID;
  const note = (document.getElementById('profile-note-input')?.value || '').trim();
  setPlayerMeta(sid, { note });
  addPlayerHistory(sid, '更新备注', note || '（已清除）');
  // 刷新弹窗中的标记状态
  const meta = getPlayerMeta(sid);
  document.getElementById('profile-modal-marked').textContent = meta.marked ? '★ 已标记' : '无';
  toast('备注已保存', 'success');
  renderPlayers(state.players);
});

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(String(text || ''));
    toast(`${label} 已复制`, 'success');
  } catch {
    toast(`复制${label}失败`, 'error');
  }
}
document.getElementById('ctx-copy-steamid')?.addEventListener('click', () => copyText(currentContextPlayer?.SteamID || '', 'SteamID'));
document.getElementById('ctx-copy-name')?.addEventListener('click', () => copyText(currentContextPlayer?.Name || '', '网名'));
document.getElementById('ctx-copy-displayname')?.addEventListener('click', () => copyText(currentContextPlayer?.DisplayName || currentContextPlayer?.Name || '', '玩家名字'));
document.getElementById('ctx-copy-ip')?.addEventListener('click', () => copyText(parsePlayerAddressIp(currentContextPlayer?.Address || '') || '', 'IP'));
document.getElementById('ctx-kick')?.addEventListener('click', async () => {
  if (!currentContextPlayer?.SteamID) return;
  await quickKick(currentContextPlayer.SteamID, currentContextPlayer.DisplayName || currentContextPlayer.Name || currentContextPlayer.SteamID);
  addPlayerHistory(currentContextPlayer.SteamID, '踢出');
});
// 封禁功能 - 右键菜单快速选项
document.getElementById('ctx-ban-permanent')?.addEventListener('click', async () => {
  if (!currentContextPlayer?.SteamID) return;
  await executeBan(currentContextPlayer, '违规行为', 0, true, false, false);
});
document.getElementById('ctx-ban-1h')?.addEventListener('click', async () => {
  if (!currentContextPlayer?.SteamID) return;
  await executeBan(currentContextPlayer, '违规行为', 60, true, false, false);
});
document.getElementById('ctx-ban-1d')?.addEventListener('click', async () => {
  if (!currentContextPlayer?.SteamID) return;
  await executeBan(currentContextPlayer, '违规行为', 1440, true, false, false);
});
document.getElementById('ctx-ban-7d')?.addEventListener('click', async () => {
  if (!currentContextPlayer?.SteamID) return;
  await executeBan(currentContextPlayer, '违规行为', 10080, true, false, false);
});
document.getElementById('ctx-ban-custom')?.addEventListener('click', () => {
  if (!currentContextPlayer) return;
  openBanConfigModal(currentContextPlayer, true);
  addPlayerHistory(currentContextPlayer.SteamID, '封禁弹窗');
});
document.getElementById('ctx-mute')?.addEventListener('click', async () => {
  if (!currentContextPlayer?.SteamID) return;
  const minutes = Number(prompt('禁言分钟数', '60') || 60);
  const hours = Math.max(1, Math.round((minutes / 60) * 100) / 100);
  await api.rconCommand(`mute ${currentContextPlayer.SteamID} ${hours}`);
  addPlayerHistory(currentContextPlayer.SteamID, '禁言', `${minutes}分钟`);
  toast('禁言命令已发送', 'success');
});
document.getElementById('ctx-unmute')?.addEventListener('click', async () => {
  if (!currentContextPlayer?.SteamID) return;
  await api.rconCommand(`unmute ${currentContextPlayer.SteamID}`);
  addPlayerHistory(currentContextPlayer.SteamID, '解除禁言');
  toast('已发送解除禁言', 'success');
});
document.getElementById('ctx-kill')?.addEventListener('click', async () => {
  if (!currentContextPlayer?.SteamID) return;
  const sid = currentContextPlayer.SteamID;
  let r = await api.rconCommand(`killplayer ${sid}`);
  if (!r?.ok) r = await api.rconCommand(`kill ${sid}`);
  if (r?.ok) {
    addPlayerHistory(sid, 'Kill');
    toast('Kill 命令已发送', 'success');
  } else {
    toast('Kill 失败（服务器可能不支持）', 'error');
  }
});
// 传送弹窗相关
document.getElementById('ctx-teleport')?.addEventListener('click', () => {
  if (!currentContextPlayer?.SteamID) return;
  openTeleportModal(currentContextPlayer);
});

function openTeleportModal(player) {
  if (!player || !player.SteamID) return;
  const modal = document.getElementById('teleport-modal');
  const fromName = document.getElementById('teleport-from-name');
  const fromSteamId = document.getElementById('teleport-from-steamid');
  const targetSelect = document.getElementById('teleport-target-select');
  
  // 设置当前玩家
  fromName.value = player.DisplayName || player.Name || player.SteamID;
  fromSteamId.value = player.SteamID;
  
  // 填充在线玩家列表（排除当前玩家）
  targetSelect.innerHTML = '<option value="">-- 选择在线玩家 --</option>';
  // 注意：在线玩家列表来自 state.players；此前误写成未声明的 players，
  // 会抛 ReferenceError 导致弹窗根本打不开
  const onlineList = Array.isArray(state.players) ? state.players : [];
  const onlinePlayers = onlineList.filter(p => String(p.SteamID) !== String(player.SteamID));
  onlinePlayers.forEach(p => {
    const option = document.createElement('option');
    option.value = p.SteamID;
    option.textContent = `${p.DisplayName || p.Name || p.SteamID} (${p.SteamID})`;
    targetSelect.appendChild(option);
  });
  
  modal.style.display = 'flex';
}

document.getElementById('btn-close-teleport')?.addEventListener('click', () => {
  document.getElementById('teleport-modal').style.display = 'none';
});

document.getElementById('btn-cancel-teleport')?.addEventListener('click', () => {
  document.getElementById('teleport-modal').style.display = 'none';
});

document.getElementById('btn-confirm-teleport')?.addEventListener('click', async () => {
  const fromSteamId = document.getElementById('teleport-from-steamid').value;
  const targetSteamId = document.getElementById('teleport-target-select').value;
  
  if (!targetSteamId) {
    toast('请选择目标玩家', 'error');
    return;
  }
  if (fromSteamId === targetSteamId) {
    toast('不能传送到自己', 'error');
    return;
  }
  
  const r = await api.rconCommand(`teleport ${fromSteamId} ${targetSteamId}`);
  if (r?.ok) {
    addPlayerHistory(fromSteamId, '传送', `to ${targetSteamId}`);
    toast('传送命令已发送', 'success');
    document.getElementById('teleport-modal').style.display = 'none';
  } else {
    toast('传送失败（服务器可能不支持）', 'error');
  }
});
document.getElementById('ctx-give-item')?.addEventListener('click', () => {
  if (!currentContextPlayer?.SteamID) return;
  const radioOnline = document.querySelector('input[name="item-target"][value="online"]');
  if (radioOnline) radioOnline.checked = true;
  const sidInput = document.getElementById('item-target-steamid');
  if (sidInput) sidInput.value = currentContextPlayer.SteamID;
  const itemTabBtn = document.querySelector('.tab-btn[data-tab="itemshop"]');
  if (itemTabBtn) itemTabBtn.click();
  addPlayerHistory(currentContextPlayer.SteamID, '给予物品入口');
});
document.getElementById('ctx-kd-stats')?.addEventListener('click', async () => {
  if (!currentContextPlayer?.SteamID) return;
  const sid = currentContextPlayer.SteamID;
  const r = await api.getBattleLog?.(sid, 80);
  if (!r?.ok) { toast('查询失败', 'error'); return; }
  const total = (r.rows || []).length;
  const lethal = (r.rows || []).filter((x) => Number(x.new_hp) <= 0).length;
  addPlayerHistory(sid, '查看K/D统计', `total=${total}, lethal=${lethal}`);
  alert(`玩家 ${sid}\n最近命中记录: ${total}\n疑似击杀条数(new_hp<=0): ${lethal}`);
});
document.getElementById('ctx-combat-records')?.addEventListener('click', async () => {
  if (!currentContextPlayer?.SteamID) return;
  const sid = currentContextPlayer.SteamID;
  const input = document.getElementById('battle-steamid');
  if (input) input.value = sid;
  const tabBtn = document.querySelector('.tab-btn[data-tab="battle"]');
  if (tabBtn) tabBtn.click();
  setTimeout(() => document.getElementById('btn-battle-query')?.click(), 0);
  addPlayerHistory(sid, '查看最近战斗记录');
});
document.getElementById('ctx-history')?.addEventListener('click', () => {
  if (!currentContextPlayer?.SteamID) return;
  openPlayerProfileModal(currentContextPlayer);
});

document.getElementById('ctx-reset-data')?.addEventListener('click', () => {
  if (!currentContextPlayer?.SteamID) return;
  const sid = currentContextPlayer.SteamID;
  if (!confirm(`确认重置 ${sid} 的本地标记/备注/历史数据？`)) return;
  clearPlayerMeta(sid);
  const store = loadPlayerHistoryStore();
  delete store[sid];
  savePlayerHistoryStore(store);
  renderPlayers(state.players);
  toast('本地玩家数据已重置', 'success');
});

document.getElementById('player-search').addEventListener('input', () => renderPlayers(state.players));
document.getElementById('player-search-clear')?.addEventListener('click', () => {
  const el = document.getElementById('player-search');
  el.value = '';
  el.focus();
  renderPlayers(state.players);
});
document.getElementById('btn-refresh-players').onclick = refreshPlayers;
// 在线玩家：不做固定轮询，避免频繁获取
// 将在“连接成功 + 有玩家加入/离开日志”时按需刷新

// ===== Steam 游戏封禁详情弹窗（来自在线玩家表格点击）=====
const steamBanModalState = {
  open: false,
  steamid: null,
  reqId: 0,
};

function openSteamBanDetails(steamid) {
  const modal = document.getElementById('steam-ban-modal');
  const steamidEl = document.getElementById('steam-ban-steamid');
  const countEl = document.getElementById('steam-ban-count');
  const vacEl = document.getElementById('steam-ban-vac');
  const daysEl = document.getElementById('steam-ban-days');
  const gamesEl = document.getElementById('steam-ban-games');
  if (!modal || !steamidEl || !countEl || !daysEl || !gamesEl) return;

  steamid = String(steamid || '').trim();
  steamidEl.textContent = steamid || '-';
  steamBanModalState.open = true;
  steamBanModalState.steamid = steamid || null;
  const myReqId = ++steamBanModalState.reqId;

  // 「被封禁的游戏」这一段：Steam 公开页面不提供游戏名（实测无任何游戏列表结构），
  // 因此这里如实说明，并给出直达该玩家 Steam 主页的入口，避免显示错误信息。
  const renderGamesSection = (daysText) => {
    gamesEl.innerHTML =
      '<div class="steam-ban-hint">Steam 公开页面只提供上面的汇总数字，' +
      '<b>不包含“被封禁的是哪个游戏”</b>（该信息仅登录 Steam 客户端后可见）。</div>' +
      '<div class="modal-row" style="margin-top:8px">' +
      (steamid ? '<button class="cfg-btn" id="btn-open-steam-profile">打开 Steam 主页查看</button>' : '') +
      (daysText && daysText !== '-' ? '<span class="steam-ban-days-note">距上次封禁 ' + escHtml(daysText) + '</span>' : '') +
      '</div>';
    const btn = document.getElementById('btn-open-steam-profile');
    if (btn && steamid) {
      btn.onclick = () => api.openUrl('https://steamcommunity.com/profiles/' + encodeURIComponent(steamid) + '/gamebans/');
    }
  };

  const cached = steamid ? state.steamGameBanInfoCache[steamid] : null;
  if (!cached || cached.ok === false) {
    countEl.textContent = '-';
    if (vacEl) vacEl.textContent = '-';
    daysEl.textContent = '-';
    gamesEl.innerHTML = '<div class="steam-ban-hint">封禁信息正在加载中…</div>';

    // 只拉取当前 SteamID，避免一次性请求太多
    api.getSteamGameBansBatch?.([steamid]).then((r) => {
      if (!r || !r.ok || !r.items || !r.items[steamid]) {
        gamesEl.innerHTML = '<div class="steam-ban-hint">读取 Steam 封禁信息失败（网络或代理不可用），请稍后重试。</div>';
        return;
      }
      state.steamGameBanInfoCache[steamid] = { ...r.items[steamid], fetchedAt: Date.now() };
      // 用户可能已关闭弹窗；不要“自动重新弹出”
      if (!steamBanModalState.open) return;
      if (steamBanModalState.reqId !== myReqId) return;
      if (steamBanModalState.steamid !== steamid) return;

      // 只刷新内容，不改变打开状态
      openSteamBanDetails(steamid);
      renderPlayers(state.players);
    }).catch(() => {
      gamesEl.innerHTML = '<div class="steam-ban-hint">读取 Steam 封禁信息失败，请稍后重试。</div>';
    });
  } else {
    countEl.textContent = cached.count != null ? cached.count : '-';
    if (vacEl) vacEl.textContent = cached.vacCount != null ? cached.vacCount : '-';
    daysEl.textContent = cached.daysSinceLastBan != null ? `${cached.daysSinceLastBan} 天` : '-';
    const daysText = cached.daysSinceLastBan != null ? `${cached.daysSinceLastBan} 天` : '-';

    const games = Array.isArray(cached.games) ? cached.games : [];
    if (!games.length) {
      if (cached.private) {
        gamesEl.innerHTML = '<div class="steam-ban-hint">该玩家 Steam 资料为私密状态，无法读取封禁汇总。</div>';
      } else {
        renderGamesSection(daysText);
      }
    } else {
      gamesEl.innerHTML = games
        .slice(0, 30)
        .map((g) => `<div style="padding:6px 0;border-bottom:1px dashed rgba(30,42,61,0.6)">${escHtml(g.name || '-')} <span style="color:var(--text-muted)">(${daysText})</span></div>`)
        .join('');
    }
  }

  modal.style.display = 'flex';
}

document.getElementById('btn-close-steam-ban-modal')?.addEventListener('click', () => {
  steamBanModalState.open = false;
  steamBanModalState.steamid = null;
  steamBanModalState.reqId++;
  document.getElementById('steam-ban-modal').style.display = 'none';
});
document.getElementById('steam-ban-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    steamBanModalState.open = false;
    steamBanModalState.steamid = null;
    steamBanModalState.reqId++;
    e.currentTarget.style.display = 'none';
  }
});

// 玩家操作弹窗
function openPlayerModal(player) {
  currentPlayerTarget = player;
  document.getElementById('modal-player-name').textContent = player.DisplayName || player.Name || '?';
  document.getElementById('modal-steamid').textContent = player.SteamID || '-';
  document.getElementById('modal-ip').textContent = player.Address ? (parsePlayerAddressIp(player.Address) || '-') : '-';
  document.getElementById('kick-reason').value = '';
  document.getElementById('ban-reason').value = '';
  document.getElementById('mute-duration').value = '';
  const muteUnitEl = document.getElementById('mute-unit');
  if (muteUnitEl) muteUnitEl.value = 'hours';

  // 传送：选择玩家A(要传送的) + 玩家B(传送到的)
  const fromSel = document.getElementById('teleport-from');
  const toSel = document.getElementById('teleport-to');
  if (fromSel && toSel) {
    fromSel.innerHTML = '';
    toSel.innerHTML = '';
    const list = (state.players && state.players.length) ? state.players : [player];
    list.forEach((p) => {
      const label = p.DisplayName || p.Name || p.SteamID || '-';
      const sid = p.SteamID || '';
      const o1 = document.createElement('option');
      o1.value = sid;
      o1.textContent = label;
      fromSel.appendChild(o1);

      const o2 = document.createElement('option');
      o2.value = sid;
      o2.textContent = label;
      toSel.appendChild(o2);
    });

    const curSid = player.SteamID || '';
    fromSel.value = curSid;
    // 默认目标选择“第一个不是自己的人”
    const firstOther = list.find((p) => (p.SteamID || '') && (p.SteamID !== curSid));
    toSel.value = (firstOther?.SteamID) || curSid;
  }
  document.getElementById('player-modal').style.display = 'flex';
}

document.getElementById('btn-close-modal').onclick = () => { document.getElementById('player-modal').style.display = 'none'; };
document.getElementById('player-modal').onclick = (e) => { if (e.target === e.currentTarget) e.currentTarget.style.display = 'none'; };

async function quickKick(steamid, name) {
  if (!state.connected) { toast('未连接服务器', 'error'); return; }
  const r = await api.rconCommand(`kick ${steamid} 您已被管理员踢出`);
  if (r.ok) { toast(`已踢出 ${name}`, 'success'); setTimeout(refreshPlayers, 2000); }
  else toast('踢出失败: ' + r.error, 'error');
}

async function quickBan(steamid, name) {
  openBanConfigModal({ SteamID: steamid, DisplayName: name, Name: name }, false);
}

document.getElementById('btn-do-kick').onclick = async () => {
  if (!currentPlayerTarget) return;
  const reason = document.getElementById('kick-reason').value || '您已被管理员踢出';
  const r = await api.rconCommand(`kick ${currentPlayerTarget.SteamID} ${reason}`);
  if (r.ok) { toast(`已踢出 ${currentPlayerTarget.DisplayName || currentPlayerTarget.Name}`, 'success'); document.getElementById('player-modal').style.display = 'none'; setTimeout(refreshPlayers, 2000); }
  else toast('踢出失败', 'error');
};

document.getElementById('btn-do-ban').onclick = async () => {
  if (!currentPlayerTarget) return;
  openBanConfigModal(currentPlayerTarget, false);
};

document.getElementById('btn-do-teleport').onclick = async () => {
  const fromSel = document.getElementById('teleport-from');
  const toSel = document.getElementById('teleport-to');
  const fromSteamId = fromSel?.value || '';
  const toSteamId = toSel?.value || '';
  if (!fromSteamId || !toSteamId) { toast('传送目标无效', 'error'); return; }
  if (fromSteamId === toSteamId) { toast('不能传送到自己', 'error'); return; }

  // 目标：把“当前玩家(from)”传送到“所选玩家(to)”
  // Rust 原生命令通常为：teleport <from> <to>（部分服务器可能不支持 RCON 执行该命令）
  const cmd = `teleport ${fromSteamId} ${toSteamId}`;
  const r = await api.rconCommand(cmd);
  if (r && r.ok) toast('传送命令已发送', 'success');
  else toast('传送失败：服务器可能不支持 RCON 传送（需要插件或在游戏内执行）', 'error');
};

document.getElementById('btn-do-mute').onclick = async () => {
  if (!currentPlayerTarget) return;
  const durInput = document.getElementById('mute-duration')?.value;
  let durVal = parseFloat(durInput);
  if (!Number.isFinite(durVal) || durVal <= 0) durVal = 1;

  const unit = document.getElementById('mute-unit')?.value || 'hours';
  // 目前你的观察“看起来只能禁言小时”，因此这里把服务器参数按“小时”处理
  // 若选择“分钟”，则换算为小时发送到 `mute steamid hours`
  let durSend = unit === 'minutes' ? (Math.round((durVal / 60) * 100) / 100) : durVal;
  if (!Number.isFinite(durSend) || durSend <= 0) durSend = 1;

  await api.rconCommand(`mute ${currentPlayerTarget.SteamID} ${durSend}`);
  if (unit === 'minutes') toast(`已禁言 ${durVal} 分钟`, 'success');
  else toast(`已禁言 ${durVal} 小时`, 'success');
};

document.getElementById('btn-do-unmute').onclick = async () => {
  if (!currentPlayerTarget) return;
  await api.rconCommand(`unmute ${currentPlayerTarget.SteamID}`);
  toast('已解除禁言', 'success');
};

// ===== 封禁记录 =====
// ===== 封禁记录（重做）=====
let banRows = [];
let banSourceFilter = 'all';

/** 统一的空状态行 */
function emptyTableRow(colspan, title, hint) {
  return `<tr class="empty-row"><td colspan="${colspan}">
    <div class="empty-state">
      <svg viewBox="0 0 48 48" width="40" height="40" fill="none" aria-hidden="true">
        <circle cx="24" cy="24" r="17" stroke="currentColor" stroke-width="2" opacity="0.5"/>
        <path d="M13 13L35 35M35 13L13 35" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.45"/>
      </svg>
      <p>${escHtml(title)}</p>
      ${hint ? `<span class="empty-sub">${escHtml(hint)}</span>` : ''}
    </div></td></tr>`;
}

// 数据没变的重渲染不播放进入动画（否则玩家进出触发刷新时会反复闪）
const __tableSignatures = new Map();
function tableDataChanged(key, signature) {
  const prev = __tableSignatures.get(key);
  __tableSignatures.set(key, signature);
  return prev !== signature;
}
function playRowEnter(tbody, changed) {
  if (!changed || !tbody) return;
  tbody.querySelectorAll('tr').forEach((tr) => tr.classList.add('row-enter'));
}

function updateBanCounts() {
  const counts = { all: banRows.length, local: 0, server: 0 };
  banRows.forEach((b) => {
    if (b.source === 'local' || b.local) counts.local++;
    if (b.source === 'server') counts.server++;
  });
  document.querySelectorAll('#panel-bans .fbtn-cnt').forEach((el) => {
    const k = el.dataset.bancnt;
    el.textContent = counts[k] != null ? counts[k] : 0;
  });
}

async function refreshBans() {
  const tbody = document.getElementById('bans-tbody');
  if (!tbody) return;
  if (!state.connected) {
    banRows = [];
    updateBanCounts();
    tbody.innerHTML = emptyTableRow(6, '未连接服务器', '连接后可读取服务器 banlist 与本地封禁库');
    return;
  }
  const btn = document.getElementById('btn-refresh-bans');
  if (btn) btn.classList.add('is-loading');
  try {
    const [r, dbResp] = await Promise.all([api.getBans(), (api.getBanDb ? api.getBanDb() : Promise.resolve(null))]);
    const serverBans = (r && r.ok) ? (r.bans || []) : [];
    const localEntries = (dbResp && dbResp.ok && Array.isArray(dbResp.db && dbResp.db.entries)) ? dbResp.db.entries : [];
    const sidOf = (x) => String((x && (x.SteamID != null ? x.SteamID : (x.steamid != null ? x.steamid : x.steamId))) || '').trim();
    const rows = [];
    const byId = new Map();
    serverBans.forEach((b) => {
      const sid = sidOf(b);
      if (!sid || byId.has(sid)) return;
      const item = { steamid: sid, name: String(b.Name || ''), ip: String(b.IP || '-'), time: b.BanTime || '', reason: String(b.Reason || '-'), source: 'server', tempUntil: '' };
      rows.push(item); byId.set(sid, item);
    });
    localEntries.forEach((e) => {
      const sid = String((e && e.steamId) || '').trim();
      if (!sid) return;
      const info = {
        steamid: sid,
        name: String(e.name || ''),
        ip: String(e.ip || e.ipRange || '-'),
        time: e.createdAt ? new Date(e.createdAt).toLocaleString('zh-CN') : '',
        reason: String(e.reason || '-'),
        source: 'local',
        tempUntil: e.tempUntil || '',
      };
      const exist = byId.get(sid);
      if (exist) { exist.local = info; exist.name = exist.name || info.name; return; }
      rows.push(info); byId.set(sid, info);
    });
    banRows = rows;
    updateBanCounts();
    renderBanTable();
  } catch (e) {
    toast('读取封禁记录失败: ' + (e.message || e), 'error');
  } finally {
    if (btn) btn.classList.remove('is-loading');
  }
}

function renderBanTable() {
  const tbody = document.getElementById('bans-tbody');
  if (!tbody) return;
  const q = (document.getElementById('ban-search')?.value || '').trim().toLowerCase();
  const filtered = banRows.filter((b) => {
    if (banSourceFilter === 'local' && !(b.source === 'local' || b.local)) return false;
    if (banSourceFilter === 'server' && b.source !== 'server') return false;
    if (!q) return true;
    return (b.steamid + ' ' + b.name + ' ' + b.reason + ' ' + b.ip).toLowerCase().includes(q);
  });
  if (!filtered.length) {
    tbody.innerHTML = emptyTableRow(6, q ? '没有匹配的封禁记录' : '暂无封禁记录',
      q ? '换个关键词，或清空搜索框' : '服务器 banlist 与本地封禁库的内容会汇总显示在这里');
    return;
  }
  const changed = tableDataChanged('bans', filtered.map((b) => b.steamid + '|' + b.reason + '|' + b.source).join('~'));
  tbody.classList.toggle('animate-rows', changed);
  tbody.innerHTML = filtered.map((b) => `<tr data-sid="${escAttr(b.steamid)}">
    <td class="col-player">
      <div class="cell-stack">
        <span class="cell-main">${escHtml(b.name || '(未知玩家)')}</span>
        <span class="id-chip" data-act="copy" title="点击复制 SteamID">${escHtml(b.steamid)}</span>
      </div>
    </td>
    <td class="col-ip">${escHtml(b.ip || '-')}</td>
    <td class="col-time">${escHtml(b.time || '-')}</td>
    <td class="col-reason">
      <div class="cell-stack">
        <span>${escHtml(b.reason || '-')}</span>
        ${b.tempUntil ? `<span class="temp-ban">临时封禁至 ${escHtml(new Date(b.tempUntil).toLocaleString('zh-CN'))}</span>` : ''}
      </div>
    </td>
    <td class="col-src"><span class="src-badge src-${b.source === 'local' ? 'local' : 'server'}">${b.source === 'local' ? '本地封禁库' : '服务器 banlist'}</span></td>
    <td class="col-act">
      <div class="row-actions">
        <button class="row-act row-act-ok" data-act="unban" title="解封该玩家（下发 unban）">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="5.4"/><path d="M5.4 8.6l1.8 1.8 3.6-4"/></svg>
        </button>
        <button class="row-act" data-act="steam" title="打开 Steam 主页">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 3h7v7"/><path d="M13 3L5 11"/><path d="M11 12v1.5H3.5V6H5"/></svg>
        </button>
        <button class="row-act row-act-danger" data-act="delrule" title="删除该玩家的本地封禁规则">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 5h10"/><path d="M6 5V3h4v2"/><path d="M5 5l.7 8h4.6L11 5"/></svg>
        </button>
      </div>
    </td>
  </tr>`).join('');
}

document.querySelectorAll('#panel-bans .filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#panel-bans .filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    banSourceFilter = btn.dataset.source || 'all';
    renderBanTable();
  });
});
const banSearchEl = document.getElementById('ban-search');
banSearchEl?.addEventListener('input', () => {
  document.getElementById('ban-search-clear')?.classList.toggle('u-hidden', !banSearchEl.value);
  renderBanTable();
});
document.getElementById('ban-search-clear')?.addEventListener('click', () => {
  banSearchEl.value = '';
  document.getElementById('ban-search-clear').classList.add('u-hidden');
  renderBanTable();
  banSearchEl.focus();
});

document.getElementById('bans-tbody')?.addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-sid]');
  if (!row) return;
  const sid = row.dataset.sid || '';
  const actBtn = e.target.closest('[data-act]');
  const act = actBtn ? actBtn.dataset.act : null;
  if (act === 'copy' || (!act && e.target.classList.contains('id-chip'))) {
    try { await navigator.clipboard.writeText(sid); toast('SteamID 已复制', 'success'); } catch (err) { toast('复制失败', 'error'); }
    return;
  }
  if (act === 'steam') { api.openUrl(`https://steamcommunity.com/profiles/${encodeURIComponent(sid)}`); return; }
  if (act === 'unban') { unbanPlayer(sid); return; }
  if (act === 'delrule') {
    if (!confirm(`从本地封禁库删除 ${sid} 的封禁规则？服务器上的封禁不受影响。`)) return;
    try {
      const r = await api.deleteBanEntry?.(sid);
      if (r && r.ok) {
        toast(r.removed ? '已从本地封禁库删除' : '本地封禁库中没有该规则', r.removed ? 'success' : 'warn');
        refreshBans();
      } else {
        toast('删除失败: ' + ((r && r.error) || '接口不可用'), 'error');
      }
    } catch (err) { toast('删除失败: ' + (err.message || err), 'error'); }
  }
});

async function unbanPlayer(steamid) {
  if (!state.connected) { toast('未连接服务器', 'error'); return; }
  const r = await api.rconCommand(`unban ${steamid}`);
  if (r && r.ok) { toast('已解封 ' + steamid, 'success'); setTimeout(refreshBans, 1200); }
  else toast('解封失败: ' + ((r && r.error) || ''), 'error');
}

// ===== Steam 封禁查询（当前实现为：服务器 banlist 封禁记录查询） =====
async function checkSteamBan() {
  const inputEl = document.getElementById('steamban-search');
  const resultEl = document.getElementById('steamban-result');
  if (!inputEl || !resultEl) return;

  const steamid = (inputEl.value || '').trim();
  if (!steamid) {
    resultEl.classList.add('empty-state');
    resultEl.innerHTML = '<p>请输入 SteamID，然后点击“查询”</p>';
    return;
  }

  resultEl.innerHTML = '<p style="color:var(--text-muted)">查询中…</p>';

  const r = await api.getBans();
  if (!r.ok) {
    resultEl.innerHTML = `<p style="color:var(--red)">查询失败：${escHtml(r.error || '未知错误')}</p>`;
    return;
  }

  const bans = (r.bans || []).filter(b => {
    const sid = String(b.SteamID || '').toLowerCase();
    const q = steamid.toLowerCase();
    return sid === q || sid.includes(q);
  });

  if (!bans.length) {
    resultEl.innerHTML = `<div class="empty-state"><p>未在服务器封禁列表中找到：${escHtml(steamid)}</p></div>`;
    return;
  }

  // 只展示第一条，同时给出原因；如需完整列表可以再扩展成 table
  const b = bans[0];
  resultEl.innerHTML = `
    <div class="empty-state" style="align-items:flex-start;gap:6px">
      <p><b style="color:var(--red)">已封禁</b></p>
      <p>SteamID：${escHtml(b.SteamID || '-')}</p>
      <p>玩家名：${escHtml(b.Name || '-')}</p>
      <p>原因：${escHtml(b.Reason || '-')}</p>
      ${bans.length > 1 ? `<p style="color:var(--text-muted);font-size:12px">匹配到 ${bans.length} 条记录</p>` : ''}
    </div>
  `;
}

document.getElementById('btn-steamban-check')?.addEventListener('click', checkSteamBan);
document.getElementById('steamban-search')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') checkSteamBan();
});

document.getElementById('btn-refresh-bans').onclick = refreshBans;
document.getElementById('ban-search').addEventListener('input', refreshBans);
document.getElementById('btn-export-bans')?.addEventListener('click', async () => {
  const r = await api.exportBanDb?.();
  if (r?.ok) toast('封禁库已导出', 'success');
  else toast('导出失败', 'error');
});
document.getElementById('btn-sync-bans')?.addEventListener('click', async () => {
  const r = await api.syncBanDb?.();
  if (!r?.ok) { toast('同步失败', 'error'); return; }
  const msg = (r.result || []).map((x) => `${x.server}:${x.synced}`).join(' | ');
  toast(`同步完成 ${msg}`, 'success', 5000);
});
document.getElementById('btn-ban-add').onclick = () => {
  const steamid = prompt('输入要封禁的SteamID:');
  if (!steamid) return;
  openBanConfigModal({ SteamID: steamid, DisplayName: steamid, Name: steamid }, false);
};

// 执行封禁的辅助函数
async function executeBan(player, reason, minutes, globalSync, syncAllServers, withIp) {
  if (!player?.SteamID) return;
  const ip = parsePlayerAddressIp(player.Address || '') || '';
  const ipRange = withIp && ip ? ip.split('.').slice(0, 3).join('.') + '.*' : '';
  const payload = {
    steamId: player.SteamID,
    reason: reason || '违规',
    durationMinutes: minutes || 0,
    globalSync,
    syncAllServers,
    ip,
    ipRange,
  };
  const r = await api.saveBanRule?.(payload);
  if (!r?.ok) {
    toast('封禁失败: ' + (r?.error || '未知错误'), 'error');
    return;
  }
  if (syncAllServers) {
    await api.syncBanDb?.();
  }
  const durationText = minutes > 0 ? `${minutes}分钟` : '永久';
  addPlayerHistory(player.SteamID, minutes > 0 ? '临时封禁' : '封禁', `${reason} (${durationText})`);
  toast(`封禁已生效: ${player.DisplayName || player.Name || player.SteamID} (${durationText})`, 'success');
  setTimeout(() => { refreshPlayers(); refreshBans(); }, 1200);
}

function openBanConfigModal(player, tempMode) {
  currentBanTarget = player;
  document.getElementById('ban-config-steamid').value = player?.SteamID || '';
  document.getElementById('ban-config-reason').value = '违规行为';
  document.getElementById('ban-config-minutes').value = tempMode ? '60' : '0';
  document.getElementById('ban-config-global').checked = true;
  document.getElementById('ban-config-sync').checked = false;
  document.getElementById('ban-config-ip').checked = false;
  document.getElementById('ban-config-modal').style.display = 'flex';
}

async function submitBanConfig() {
  if (!currentBanTarget?.SteamID) return;
  const reason = document.getElementById('ban-config-reason').value || '违规';
  const minutes = Number(document.getElementById('ban-config-minutes').value || 0);
  const globalSync = !!document.getElementById('ban-config-global').checked;
  const syncAllServers = !!document.getElementById('ban-config-sync').checked;
  const withIp = !!document.getElementById('ban-config-ip').checked;
  const ip = parsePlayerAddressIp(currentBanTarget.Address || '') || '';
  const ipRange = withIp && ip ? ip.split('.').slice(0, 3).join('.') + '.*' : '';
  const payload = {
    steamId: currentBanTarget.SteamID,
    reason,
    durationMinutes: minutes,
    globalSync,
    syncAllServers,
    ip,
    ipRange,
  };
  const r = await api.saveBanRule?.(payload);
  if (!r?.ok) {
    toast('封禁失败: ' + (r?.error || '未知错误'), 'error');
    return;
  }
  if (syncAllServers) {
    await api.syncBanDb?.();
  }
  addPlayerHistory(currentBanTarget.SteamID, minutes > 0 ? '临时封禁' : '封禁', reason);
  toast('封禁已生效', 'success');
  document.getElementById('ban-config-modal').style.display = 'none';
  document.getElementById('player-modal').style.display = 'none';
  setTimeout(() => { refreshPlayers(); refreshBans(); }, 1200);
}

document.getElementById('btn-close-ban-config')?.addEventListener('click', () => {
  document.getElementById('ban-config-modal').style.display = 'none';
});
document.getElementById('btn-cancel-ban-config')?.addEventListener('click', () => {
  document.getElementById('ban-config-modal').style.display = 'none';
});
document.getElementById('btn-confirm-ban-config')?.addEventListener('click', submitBanConfig);
document.getElementById('ban-config-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
});

// ===== 战斗记录（重做）=====
let battleRows = [];
let battleServerNote = '';

function battleHpCell(oldHp, newHp) {
  const o = Number(oldHp);
  const n = Number(newHp);
  if (!Number.isFinite(o) || !Number.isFinite(n)) {
    return `<span class="hp-text">${escHtml(String(oldHp || '-'))} <i>→</i> ${escHtml(String(newHp || '-'))}</span>`;
  }
  const maxHp = Math.max(100, o);
  const keptPct = Math.max(0, Math.min(100, (n / maxHp) * 100));
  const dmgPct = Math.max(0, Math.min(100 - keptPct, ((o - n) / maxHp) * 100));
  const dmg = Math.max(0, Math.round(o - n));
  return `<div class="hp-delta">
    <span class="hp-bar" title="血量 ${o} → ${n}"><i style="width:${keptPct}%"></i><u style="left:${keptPct}%;width:${dmgPct}%"></u></span>
    <span class="hp-text">${o} <i>→</i> <b>${n}</b>${dmg > 0 ? ` <i>(-${dmg})</i>` : ''}</span>
  </div>`;
}

function updateBattlePlayerSelect() {
  const sel = document.getElementById('battle-player-select');
  if (!sel) return;
  const cur = sel.value;
  const seen = new Set();
  const list = [];
  (state.players || []).forEach((p) => {
    const sid = String(p.SteamID || '').trim();
    if (!sid || seen.has(sid)) return;
    seen.add(sid);
    list.push({ sid, name: p.DisplayName || p.Name || '', online: true });
  });
  (state.offlinePlayers || []).forEach((p) => {
    const sid = String(p.SteamID || '').trim();
    if (!sid || seen.has(sid)) return;
    seen.add(sid);
    list.push({ sid, name: p.DisplayName || p.Name || '', online: false });
  });
  sel.innerHTML = '<option value="">-- 从在线/离线玩家选择 --</option>' +
    list.map((x) => `<option value="${escAttr(x.sid)}">${escHtml(x.name || x.sid)}${x.online ? '（在线）' : '（离线）'}</option>`).join('');
  if (cur && list.some((x) => x.sid === cur)) sel.value = cur;
}

function renderBattleRows() {
  const tbody = document.getElementById('battle-tbody');
  if (!tbody) return;
  const q = (document.getElementById('battle-search')?.value || '').trim().toLowerCase();
  const filtered = q ? battleRows.filter((x) => JSON.stringify(x).toLowerCase().includes(q)) : battleRows;
  const countEl = document.getElementById('battle-count');
  if (countEl) countEl.textContent = filtered.length;
  if (!filtered.length) {
    tbody.innerHTML = emptyTableRow(7,
      battleRows.length ? '没有匹配的战斗记录' : '暂无战斗记录',
      battleRows.length ? '换个关键词试试，或清空筛选框' : (battleServerNote || '选择玩家后点击「查询战斗记录」'));
    return;
  }
  const changed = tableDataChanged('battle', filtered.map((x) => x.date + x.attacker + x.weapon + x.old_hp + x.new_hp).join('~'));
  tbody.classList.toggle('animate-rows', changed);
  tbody.innerHTML = filtered.map((x) => `<tr>
    <td class="col-time">${escHtml(x.date || '-')}</td>
    <td>${escHtml(x.attacker || '-')}</td>
    <td><span class="weapon-tag" title="${escAttr(x.weapon || '')}">${escHtml(x.weapon || '-')}</span></td>
    <td class="col-num">${escHtml(x.ammo || '-')}</td>
    <td>${escHtml(x.area || '-')}</td>
    <td class="col-num">${escHtml(x.distance || '-')}</td>
    <td class="col-hp">${battleHpCell(x.old_hp, x.new_hp)}</td>
  </tr>`).join('');
}

async function queryBattleLog() {
  const steamid = (document.getElementById('battle-steamid')?.value || '').trim();
  const tbody = document.getElementById('battle-tbody');
  if (!state.connected) { toast('请先连接服务器', 'error'); return; }
  if (!/^\d{17}$/.test(steamid)) {
    toast('SteamID 需要是 17 位数字', 'error');
    if (tbody) tbody.innerHTML = emptyTableRow(7, 'SteamID 格式不正确', '请输入 17 位数字，或从上方下拉选择玩家');
    return;
  }
  const lines = Math.min(Math.max(Number(document.getElementById('battle-lines')?.value || 30), 1), 200);
  const btn = document.getElementById('btn-battle-query');
  if (btn) { btn.classList.add('is-loading'); }
  if (tbody) tbody.innerHTML = emptyTableRow(7, '正在查询 combatlog…', '服务器返回速度取决于 RCON 延迟');
  try {
    const r = await api.getBattleLog?.(steamid, lines);
    if (!r || !r.ok) {
      battleRows = [];
      battleServerNote = (r && r.error) || '查询失败';
      if (tbody) tbody.innerHTML = emptyTableRow(7, '查询失败', battleServerNote);
      toast('查询失败: ' + battleServerNote, 'error');
      return;
    }
    battleRows = r.rows || [];
    battleServerNote = r.note || '';
    renderBattleRows();
    if (!battleRows.length) toast(battleServerNote || '该玩家暂无战斗记录', 'warn');
    else toast(`解析到 ${battleRows.length} 条战斗记录`, 'success');
  } catch (e) {
    battleRows = [];
    if (tbody) tbody.innerHTML = emptyTableRow(7, '查询失败', String(e.message || e));
    toast('查询失败: ' + (e.message || e), 'error');
  } finally {
    if (btn) btn.classList.remove('is-loading');
  }
}
document.getElementById('btn-battle-query')?.addEventListener('click', queryBattleLog);
document.getElementById('battle-player-select')?.addEventListener('change', (e) => {
  const sid = e.target.value;
  if (!sid) return;
  const input = document.getElementById('battle-steamid');
  if (input) input.value = sid;
  queryBattleLog();
});
document.getElementById('battle-steamid')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') queryBattleLog(); });
document.getElementById('battle-search')?.addEventListener('input', renderBattleRows);
document.getElementById('btn-battle-export')?.addEventListener('click', async () => {
  if (!battleRows.length) { toast('暂无可导出的战斗记录', 'warn'); return; }
  const sid = (document.getElementById('battle-steamid')?.value || '').trim();
  const content = battleRows.map((x) => [x.date, x.attacker, x.weapon, x.ammo, x.area, x.distance, x.old_hp, x.new_hp].join('\t')).join('\n');
  try {
    const r = await api.saveChatExport?.(`battle_${sid || 'unknown'}`, `时间\t攻击者\t武器\t弹药\t部位\t距离\t旧血量\t新血量\n${content}`);
    if (r && r.ok) toast('战斗记录已导出', 'success');
    else toast('导出失败', 'error');
  } catch (e) { toast('导出失败: ' + (e.message || e), 'error'); }
});

// ===== 离线玩家（重做）=====
let offlineRange = 'all';

function offlineTimeMs(p) {
  const t = p && p.OfflineTime ? new Date(p.OfflineTime).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

function offlineInRange(p) {
  if (offlineRange === 'all') return true;
  const t = offlineTimeMs(p);
  if (!t) return false;
  const now = Date.now();
  if (offlineRange === 'today') {
    const d = new Date(t), n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  }
  if (offlineRange === '7d') return (now - t) <= 7 * 86400000;
  return true;
}

function updateOfflineCounts() {
  const list = state.offlinePlayers || [];
  const now = Date.now();
  const today = list.filter((p) => offlineInRange({ ...p, __r: 'today' }) && (() => {
    const d = new Date(offlineTimeMs(p)), n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  })()).length;
  const d7 = list.filter((p) => (now - offlineTimeMs(p)) <= 7 * 86400000).length;
  const counts = { all: list.length, today, '7d': d7 };
  document.querySelectorAll('#panel-offline .fbtn-cnt').forEach((el) => {
    const k = el.dataset.offcnt;
    el.textContent = counts[k] != null ? counts[k] : 0;
  });
}

function relativeTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return Math.floor(diff / 86400000) + ' 天前';
}

function renderOfflineTable() {
  const tbody = document.getElementById('offline-tbody');
  if (!tbody) return;
  const q = (document.getElementById('offline-search')?.value || '').trim().toLowerCase();
  const filtered = (state.offlinePlayers || []).filter((p) => {
    if (!offlineInRange(p)) return false;
    if (!q) return true;
    return ((p.DisplayName || p.Name || '') + ' ' + (p.SteamID || '') + ' ' + (p.IpAddress || '')).toLowerCase().includes(q);
  });
  if (!filtered.length) {
    tbody.innerHTML = emptyTableRow(6,
      q || offlineRange !== 'all' ? '没有匹配的离线记录' : '暂无离线玩家记录',
      q || offlineRange !== 'all' ? '换个筛选条件试试' : '玩家掉线后会自动记录在这里（连接服务器后生效）');
    return;
  }
  const changed = tableDataChanged('offline', filtered.map((p) => p.SteamID + (p.OfflineTime || '')).join('~'));
  tbody.classList.toggle('animate-rows', changed);
  tbody.innerHTML = filtered.map((p) => {
    const pos = p.LastPosition
      ? `${Math.round(p.LastPosition.x || 0)},${Math.round(p.LastPosition.y || 0)},${Math.round(p.LastPosition.z || 0)}`
      : (p.LastPos || '-');
    const ms = offlineTimeMs(p);
    const sid = String(p.SteamID || '');
    const name = p.DisplayName || p.Name || '(未知玩家)';
    const dur = p.ConnectedSeconds ? formatDuration(p.ConnectedSeconds) : '-';
    return `<tr data-sid="${escAttr(sid)}" data-server="${escAttr(p.Server || '')}">
      <td class="col-player">
        <div class="cell-stack">
          <span class="cell-main">${escHtml(name)}</span>
          <span class="id-chip" data-act="copy" title="点击复制 SteamID">${escHtml(sid || '-')}</span>
        </div>
      </td>
      <td class="col-ip">${escHtml(p.IpAddress || '-')}</td>
      <td><span class="cell-sub" style="font-family:'Consolas',monospace">${escHtml(pos)}</span></td>
      <td class="col-time">
        <div class="cell-stack">
          <span>${ms ? new Date(ms).toLocaleString('zh-CN') : '-'}</span>
          <span class="cell-sub">${escHtml(relativeTime(ms))}${p.Server ? ' · ' + escHtml(p.Server) : ''}</span>
        </div>
      </td>
      <td>${escHtml(dur)}</td>
      <td class="col-act">
        <div class="row-actions">
          <button class="row-act" data-act="steam" title="打开 Steam 主页">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 3h7v7"/><path d="M13 3L5 11"/><path d="M11 12v1.5H3.5V6H5"/></svg>
          </button>
          <button class="row-act row-act-danger" data-act="ban" title="封禁该玩家">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.4"/><path d="M4.2 11.8L11.8 4.2" stroke-linecap="round"/></svg>
          </button>
          <button class="row-act row-act-danger" data-act="del" title="删除这条离线记录">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 5h10"/><path d="M6 5V3h4v2"/><path d="M5 5l.7 8h4.6L11 5"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

async function refreshOfflinePlayers() {
  try {
    const r = await api.getOfflinePlayers();
    state.offlinePlayers = (r && r.players) ? r.players : [];
  } catch (e) {
    state.offlinePlayers = [];
  }
  updateOfflineCounts();
  renderOfflineTable();
  try { updateBattlePlayerSelect(); } catch (e) {}
}

document.querySelectorAll('#panel-offline .filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#panel-offline .filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    offlineRange = btn.dataset.range || 'all';
    renderOfflineTable();
  });
});

document.getElementById('offline-tbody')?.addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-sid]');
  if (!row) return;
  const sid = row.dataset.sid || '';
  const server = row.dataset.server || '';
  const actBtn = e.target.closest('[data-act]');
  const act = actBtn ? actBtn.dataset.act : null;
  if (act === 'copy' || (!act && e.target.classList.contains('id-chip'))) {
    try { await navigator.clipboard.writeText(sid); toast('SteamID 已复制', 'success'); } catch (err) { toast('复制失败', 'error'); }
    return;
  }
  if (act === 'steam') { if (sid) api.openUrl(`https://steamcommunity.com/profiles/${encodeURIComponent(sid)}`); return; }
  if (act === 'ban') { banOfflinePlayer(sid, row.querySelector('.cell-main')?.textContent || sid); return; }
  if (act === 'del') {
    if (!confirm('删除这条离线记录？（不影响服务器数据）')) return;
    try {
      const r = await api.deleteOfflinePlayer?.(sid, server);
      if (r && r.ok) { toast('已删除该条记录', 'success'); refreshOfflinePlayers(); }
      else toast('删除失败: ' + ((r && r.error) || '接口不可用'), 'error');
    } catch (err) { toast('删除失败: ' + (err.message || err), 'error'); }
  }
});

async function banOfflinePlayer(steamid, name) {
  if (!steamid) return;
  if (!state.connected) { toast('未连接服务器', 'error'); return; }
  const reason = prompt(`封禁 ${name} 的原因:`) || '违规';
  const r = await api.rconCommand(`ban ${steamid} "${String(reason).replace(/"/g, "'")}"`);
  if (r && r.ok) { toast('封禁成功', 'success'); setTimeout(refreshBans, 1200); }
  else toast('封禁失败: ' + ((r && r.error) || ''), 'error');
}

document.getElementById('offline-search')?.addEventListener('input', () => {
  const el = document.getElementById('offline-search');
  document.getElementById('offline-search-clear')?.classList.toggle('u-hidden', !el.value);
  renderOfflineTable();
});
document.getElementById('offline-search-clear')?.addEventListener('click', () => {
  const el = document.getElementById('offline-search');
  el.value = '';
  document.getElementById('offline-search-clear').classList.add('u-hidden');
  renderOfflineTable();
  el.focus();
});
document.getElementById('btn-refresh-offline')?.addEventListener('click', refreshOfflinePlayers);
document.getElementById('btn-clear-offline').onclick = async () => {
  if (!confirm('确认清空所有离线玩家记录？此操作不可撤销。')) return;
  await api.clearOfflinePlayers();
  state.offlinePlayers = [];
  await refreshOfflinePlayers();
  try { renderPermPlayerItems(); } catch (e) {}
  toast('离线记录已清空', 'success');
};

// ===== 权限组 =====
const groupsUIState = {
  groups: [],
  selected: null,
  detail: null,
  permsAll: null,
  permsAllFetchedAt: 0,
  meta: {},            // group -> { members, perms }（用于列表徽章，加载详情后回填）
};

function getPlayerNameBySteamId(steamid) {
  const sid = String(steamid || '').trim();
  if (!sid) return '-';
  const online = (state.players || []).find((p) => String(p.SteamID || '').trim() === sid);
  if (online) return online.DisplayName || online.Name || '-';
  const offline = (state.offlinePlayers || []).find((p) => String(p.SteamID || '').trim() === sid);
  if (offline) return offline.DisplayName || offline.Name || '-';
  return '-';
}

async function refreshGroups() {
  const listEl = document.getElementById('groups-list');
  const hintEl = document.getElementById('groups-count-hint');
  if (!listEl || !hintEl) return;
  if (!state.connected) {
    listEl.innerHTML = `<div class="empty-state" style="padding:28px 0"><p>请先连接服务器后再刷新权限组</p></div>`;
    hintEl.textContent = '0 个组';
    setGroupSelection(null);
    return;
  }

  listEl.innerHTML = `<div class="empty-state" style="padding:28px 0"><p>正在获取权限组…</p></div>`;
  const r = await api.getGroups();
  if (!r.ok) {
    listEl.innerHTML = `<div class="empty-state" style="padding:28px 0">
      <p>获取权限组失败</p>
      <p style="font-size:12px;color:var(--text-muted);margin-top:8px">${escHtml(r.error || '未知错误')}</p>
    </div>`;
    hintEl.textContent = '0 个组';
    setGroupSelection(null);
    return;
  }

  const groups = Array.isArray(r.groups) ? r.groups : [];
  groupsUIState.groups = groups;
  hintEl.textContent = `${groups.length} 个组`;

  if (!groups.length) {
    const rawPreview = (r.raw || '').trim().slice(0, 600);
    const extra = r.timedOut ? '<p style="font-size:11px;color:var(--text-warn,#d29922);margin-top:6px">RCON 可能超时，可再点一次刷新。</p>' : '';
    listEl.innerHTML = `<div class="empty-state" style="padding:28px 0;text-align:left">
      <p style="text-align:center">未解析到组名（需要 uMod/Oxide）</p>
      <p style="font-size:11px;color:var(--text-muted);margin:8px 0;text-align:center">已尝试：oxide.show groups / o.show groups / perm.show groups / oxide.groups</p>
      ${extra}
      <p style="font-size:10px;color:var(--text-muted);margin-top:6px">服务器原始返回（节选）：</p>
      <pre style="font-size:10px;font-family:monospace;background:var(--bg-input);padding:8px;border-radius:6px;max-height:100px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:0">${escHtml(rawPreview || '(空)')}</pre>
    </div>`;
    setGroupSelection(null);
    return;
  }

  updateGroupsCount();
  renderGroupList();

  // 默认选中第一个
  if (!groupsUIState.selected && groups.length) setGroupSelection(groups[0]);
}

/** 组列表的搜索过滤 + 徽章渲染（成员/权限数在加载详情后回填） */
function renderGroupList() {
  const listEl = document.getElementById('groups-list');
  if (!listEl) return;
  const q = (document.getElementById('group-search')?.value || '').trim().toLowerCase();
  const all = groupsUIState.groups || [];
  const list = q ? all.filter((g) => g.toLowerCase().includes(q)) : all;
  if (!list.length) {
    listEl.innerHTML = `<div class="empty-state u-py-24"><p>没有匹配的权限组</p><span class="empty-sub">换个关键词，或清空搜索框</span></div>`;
    return;
  }
  listEl.innerHTML = list.map((g) => {
    const active = groupsUIState.selected === g ? 'active' : '';
    const m = groupsUIState.meta[g];
    const badges = m
      ? `<div class="group-item-badges"><span class="gi-badge">${m.members} 成员</span><span class="gi-badge">${m.perms} 权限</span></div>`
      : '<div class="group-item-badge">点击加载详情</div>';
    return `<div class="group-item ${active}" data-group="${escAttr(g)}">
      <div class="group-item-name">${escHtml(g)}</div>
      ${badges}
    </div>`;
  }).join('');
  listEl.querySelectorAll('.group-item').forEach((el) => {
    el.addEventListener('click', () => setGroupSelection(el.getAttribute('data-group') || ''));
  });
}

function updateGroupsCount() {
  const el = document.getElementById('groups-count');
  if (el) el.textContent = (groupsUIState.groups || []).length;
  const hint = document.getElementById('groups-count-hint');
  if (hint) hint.textContent = `${(groupsUIState.groups || []).length} 个组`;
}

function updateGroupBadges(group, members, perms) {
  const nm = document.getElementById('group-head-members');
  const np = document.getElementById('group-head-perms');
  const cm = document.getElementById('group-member-count');
  const cp = document.getElementById('group-perm-count');
  const has = !!group;
  if (nm) { nm.textContent = `${members} 成员`; nm.classList.toggle('u-hidden', !has); }
  if (np) { np.textContent = `${perms} 权限`; np.classList.toggle('u-hidden', !has); }
  if (cm) cm.textContent = has ? members : 0;
  if (cp) cp.textContent = has ? perms : 0;
}

async function deleteGroup(name) {
  if (!confirm(`确认删除权限组 "${name}"?`)) return;
  const r = await api.rconCommand(`oxide.group remove ${name}`);
  if (r.ok) { toast('权限组已删除', 'success'); setTimeout(refreshGroups, 1500); }
  else toast('删除失败', 'error');
}

document.getElementById('btn-refresh-groups').onclick = refreshGroups;
document.getElementById('btn-create-group').onclick = async () => {
  const name = document.getElementById('new-group-name').value.trim();
  if (!name) { toast('请输入权限组名称', 'error'); return; }
  const r = await api.rconCommand(`oxide.group add ${name}`);
  if (r.ok) { toast(`权限组 "${name}" 已创建`, 'success'); document.getElementById('new-group-name').value = ''; setTimeout(refreshGroups, 1500); }
  else toast('创建失败', 'error');
};

function setGroupSelection(group) {
  groupsUIState.selected = group || null;
  groupsUIState.detail = null;
  const nameEl = document.getElementById('group-detail-name');
  const btnAddPerm = document.getElementById('btn-group-add-perm');
  const btnDel = document.getElementById('btn-group-delete');
  const btnRefresh = document.getElementById('btn-group-refresh-detail');
  const permListEl = document.getElementById('group-perm-list');
  const memberAdd = document.getElementById('btn-group-member-add');
  const memberRemove = document.getElementById('btn-group-member-remove');
  if (nameEl) nameEl.textContent = group || '未选择';
  const enabled = !!group;
  [btnAddPerm, btnDel, btnRefresh, memberAdd, memberRemove].forEach((b) => { if (b) b.disabled = !enabled; });
  if (permListEl) permListEl.innerHTML = `<div class="empty-state" style="padding:26px 0"><p>${enabled ? '正在加载组权限…' : '请选择左侧权限组'}</p></div>`;

  document.querySelectorAll('#groups-list .group-item').forEach((el) => {
    const g = el.getAttribute('data-group');
    el.classList.toggle('active', !!group && g === group);
  });

  if (group) loadGroupDetail(group).catch(() => {});
}

async function loadGroupDetail(group) {
  const g = String(group || '').trim();
  if (!g) return;
  const r = await api.getGroupDetail?.(g);
  if (!r || !r.ok) {
    renderGroupPerms(g, [], r?.raw || '', r?.error || '获取组详情失败');
    renderGroupMembers(g, [], r?.raw || '', r?.error || '获取组详情失败');
    return;
  }
  groupsUIState.detail = r;
  const perms = r.perms || [];
  const users = r.users || [];
  groupsUIState.meta[g] = { members: users.length, perms: perms.length };
  renderGroupList();                       // 回填列表徽章
  updateGroupBadges(g, users.length, perms.length);
  renderGroupPerms(g, perms, r.raw || '', null);
  renderGroupMembers(g, users, r.raw || '', null);
}

function renderGroupPerms(group, perms, raw, error) {
  const filterEl = document.getElementById('group-perm-filter');
  const permListEl = document.getElementById('group-perm-list');
  if (!permListEl) return;

  const q = String(filterEl?.value || '').trim().toLowerCase();
  const list = (perms || []).filter((p) => !q || String(p).toLowerCase().includes(q));

  if (error) {
    permListEl.innerHTML = `<div class="empty-state" style="padding:26px 0;text-align:left">
      <p style="text-align:center">获取组权限失败</p>
      <p style="font-size:12px;color:var(--text-muted);margin-top:8px;text-align:center">${escHtml(error)}</p>
      ${raw ? `<pre style="font-size:10px;font-family:monospace;background:var(--bg-input);padding:8px;border-radius:6px;max-height:160px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:10px 0 0">${escHtml(String(raw).slice(0,1200))}</pre>` : ''}
    </div>`;
    return;
  }

  const countEl = document.getElementById('group-perm-count');
  if (countEl) countEl.textContent = (perms || []).length;

  if (!list.length) {
    permListEl.innerHTML = `<div class="empty-state" style="padding:26px 0"><p>${q ? '没有匹配的权限' : '该组暂无权限'}</p>
      <span class="empty-sub">${q ? '换个关键词试试' : '点右上角「＋ 添加权限」从权限目录里选'}</span></div>`;
    return;
  }

  // 按插件前缀分组，长列表更易读
  const byPrefix = new Map();
  list.forEach((p) => {
    const perm = String(p);
    const key = perm.includes('.') ? perm.split('.')[0] : '(无前缀)';
    if (!byPrefix.has(key)) byPrefix.set(key, []);
    byPrefix.get(key).push(perm);
  });
  const prefixes = [...byPrefix.keys()].sort((a, b) => a.localeCompare(b));
  permListEl.innerHTML = prefixes.map((k) => `<div class="perm-group">
      <div class="perm-group-head">${escHtml(k)}<em>${byPrefix.get(k).length}</em></div>
      <div class="perm-group-body">${byPrefix.get(k).map((perm) => `
        <div class="perm-chip">
          <code>${escHtml(perm)}</code>
          <div class="perm-actions">
            <button class="member-act" data-copy="${escAttr(perm)}" title="复制该权限名" aria-label="复制权限名">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>
            </button>
            <button class="member-act member-act-danger" data-perm="${escAttr(perm)}" title="从该组移除该权限" aria-label="移除权限">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 5h10"/><path d="M6 5V3h4v2"/><path d="M5 5l.7 8h4.6L11 5"/></svg>
            </button>
          </div>
        </div>`).join('')}</div>
    </div>`).join('');

  permListEl.querySelectorAll('.member-act[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(btn.dataset.copy || ''); toast('权限名已复制', 'success'); } catch (e) { toast('复制失败', 'error'); }
    });
  });

  permListEl.querySelectorAll('button[data-perm]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const perm = btn.getAttribute('data-perm');
      if (!perm) return;
      const r = await api.groupRevokePerm?.(group, perm);
      if (r && r.ok) { toast('已移除权限', 'success'); await loadGroupDetail(group); }
      else toast('移除失败', 'error');
    });
  });
}

function renderGroupMembers(group, users, raw, error) {
  const listEl = document.getElementById('group-member-list');
  if (!listEl) return;
  const ids = Array.isArray(users) ? users.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const countEl = document.getElementById('group-member-count');
  if (countEl) countEl.textContent = ids.length;

  if (error) {
    listEl.innerHTML = `<div class="empty-state" style="padding:18px 0;text-align:left">
      <p style="text-align:center">获取成员失败</p>
      <p style="font-size:12px;color:var(--text-muted);margin-top:8px;text-align:center">${escHtml(error)}</p>
      ${raw ? `<pre style="font-size:10px;font-family:monospace;background:var(--bg-input);padding:8px;border-radius:6px;max-height:140px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:10px 0 0">${escHtml(String(raw).slice(0,1000))}</pre>` : ''}
    </div>`;
    return;
  }

  if (!ids.length) {
    listEl.innerHTML = `<div class="empty-state" style="padding:18px 0"><p>暂无成员数据</p></div>`;
    return;
  }

  listEl.innerHTML = ids.map((sid) => {
    const name = getPlayerNameBySteamId(sid);
    const displayName = (name && name !== '-') ? name : '未知玩家';
    const isOnline = (state.players || []).some((p) => String(p.SteamID || '').trim() === sid);
    return `<div class="member-chip${isOnline ? ' member-chip-online' : ''}">
      <span class="member-status" title="${isOnline ? '在线' : '离线'}" aria-hidden="true"></span>
      <div class="member-main">
        <div class="member-name"><span class="nm">${escHtml(displayName)}</span>${isOnline ? '<span class="member-online-badge">在线</span>' : ''}</div>
        <div class="member-sid" data-copy-sid="${escAttr(sid)}" title="点击复制 SteamID">${escHtml(sid)}</div>
      </div>
      <div class="member-actions">
        <button class="member-act" data-copy-sid="${escAttr(sid)}" title="复制 SteamID" aria-label="复制 SteamID">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>
        </button>
        <button class="member-act member-act-danger" data-sid="${escAttr(sid)}" title="移出该组" aria-label="移出该组">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 5h10"/><path d="M6 5V3h4v2"/><path d="M5 5l.7 8h4.6L11 5"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  // 复制 SteamID（点 sid 文本或复制按钮都可以）
  listEl.querySelectorAll('[data-copy-sid]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = el.getAttribute('data-copy-sid') || '';
      if (!sid) return;
      try { await navigator.clipboard.writeText(sid); toast('SteamID 已复制', 'success'); } catch (err) { toast('复制失败', 'error'); }
    });
  });

  listEl.querySelectorAll('button[data-sid]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sid = btn.getAttribute('data-sid');
      if (!sid) return;
      const r = await api.playerRemoveGroup?.(sid, group);
      if (r && r.ok) {
        toast('成员已移除', 'success');
        await loadGroupDetail(group);
      } else {
        toast('移除失败', 'error');
      }
    });
  });
}

document.getElementById('group-perm-filter')?.addEventListener('input', () => {
  if (groupsUIState.selected && groupsUIState.detail) {
    renderGroupPerms(groupsUIState.selected, groupsUIState.detail.perms || [], groupsUIState.detail.raw || '', null);
  }
});

document.getElementById('btn-group-refresh-detail')?.addEventListener('click', () => {
  if (groupsUIState.selected) loadGroupDetail(groupsUIState.selected);
});

document.getElementById('btn-group-delete')?.addEventListener('click', async () => {
  const g = groupsUIState.selected;
  if (!g) return;
  await deleteGroup(g);
  groupsUIState.selected = null;
  setGroupSelection(null);
  setTimeout(refreshGroups, 1500);
});

// 成员管理（复用 playerAddGroup / playerRemoveGroup）
document.getElementById('btn-group-member-add')?.addEventListener('click', async () => {
  const g = groupsUIState.selected;
  const sid = document.getElementById('group-member-steamid')?.value?.trim();
  if (!g || !sid) { toast('请输入 SteamID', 'error'); return; }
  if (!/^\d{17}$/.test(sid)) { toast('SteamID 应为 17 位数字', 'error'); return; }
  const r = await api.playerAddGroup?.(sid, g);
  if (r && r.ok) {
    toast('成员已添加到该组', 'success');
    const el = document.getElementById('group-member-steamid');
    if (el) el.value = '';
    const hint = document.getElementById('group-member-hint');
    if (hint) { hint.textContent = ''; hint.className = 'group-member-hint'; }
    await loadGroupDetail(g);
  } else toast('添加失败: ' + ((r && r.error) || ''), 'error');
});
document.getElementById('btn-group-member-remove')?.addEventListener('click', async () => {
  const g = groupsUIState.selected;
  const sid = document.getElementById('group-member-steamid')?.value?.trim();
  if (!g || !sid) { toast('请输入 SteamID', 'error'); return; }
  if (!/^\d{17}$/.test(sid)) { toast('SteamID 应为 17 位数字', 'error'); return; }
  const r = await api.playerRemoveGroup?.(sid, g);
  if (r && r.ok) {
    toast('成员已从该组移除', 'success');
    const el = document.getElementById('group-member-steamid');
    if (el) el.value = '';
    const hint = document.getElementById('group-member-hint');
    if (hint) { hint.textContent = ''; hint.className = 'group-member-hint'; }
    await loadGroupDetail(g);
  } else toast('移除失败: ' + ((r && r.error) || ''), 'error');
});

// 成员输入：实时格式提示 + Enter 直接添加
const groupMemberInput = document.getElementById('group-member-steamid');
groupMemberInput?.addEventListener('input', () => {
  const hint = document.getElementById('group-member-hint');
  if (!hint) return;
  const v = groupMemberInput.value.trim();
  if (!v) { hint.textContent = ''; hint.className = 'group-member-hint'; return; }
  const ok = /^\d{17}$/.test(v);
  hint.textContent = ok ? '✓ SteamID 格式正确' : 'SteamID 应为 17 位数字';
  hint.className = 'group-member-hint ' + (ok ? 'is-ok' : 'is-error');
});
groupMemberInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-group-member-add')?.click();
});

// 组列表搜索
const groupSearchEl = document.getElementById('group-search');
groupSearchEl?.addEventListener('input', () => {
  document.getElementById('group-search-clear')?.classList.toggle('u-hidden', !groupSearchEl.value);
  renderGroupList();
});
document.getElementById('group-search-clear')?.addEventListener('click', () => {
  groupSearchEl.value = '';
  document.getElementById('group-search-clear').classList.add('u-hidden');
  renderGroupList();
  groupSearchEl.focus();
});

// 复制该组全部权限名
document.getElementById('btn-group-perm-copy')?.addEventListener('click', async () => {
  const d = groupsUIState.detail;
  const perms = (d && Array.isArray(d.perms)) ? d.perms : [];
  if (!perms.length) { toast('该组暂无可复制的权限', 'warn'); return; }
  try {
    await navigator.clipboard.writeText(perms.join('\n'));
    toast(`已复制 ${perms.length} 个权限名`, 'success');
  } catch (e) { toast('复制失败', 'error'); }
});

// ===== 权限选择器弹窗 =====
function openPermPicker() {
  const g = groupsUIState.selected;
  if (!g) return;
  document.getElementById('perm-picker-group').textContent = g;
  document.getElementById('perm-picker-search').value = '';
  document.getElementById('perm-picker-selected').textContent = '0';
  document.getElementById('perm-picker-list').innerHTML = '<div class="empty-state" style="padding:18px 0"><p>加载权限列表中…</p></div>';
  document.getElementById('perm-picker-modal').style.display = 'flex';
  loadAllPermsAndRender();
}

function closePermPicker() {
  document.getElementById('perm-picker-modal').style.display = 'none';
}

async function loadAllPermsAndRender() {
  const now = Date.now();
  const needFetch = !groupsUIState.permsAll || (now - groupsUIState.permsAllFetchedAt) > 10 * 60 * 1000;
  if (needFetch) {
    const r = await api.getPermissions?.();
    if (r && r.ok) {
      groupsUIState.permsAll = r.perms || [];
      groupsUIState.permsAllFetchedAt = now;
    } else {
      groupsUIState.permsAll = [];
      groupsUIState.permsAllFetchedAt = now;
    }
  }
  renderPermPickerList();
}

function renderPermPickerList() {
  const listEl = document.getElementById('perm-picker-list');
  const totalEl = document.getElementById('perm-picker-total');
  const selectedEl = document.getElementById('perm-picker-selected');
  if (!listEl || !totalEl || !selectedEl) return;

  const q = String(document.getElementById('perm-picker-search')?.value || '').trim().toLowerCase();
  const perms = Array.isArray(groupsUIState.permsAll) ? groupsUIState.permsAll : [];
  const filtered = perms.filter((p) => !q || String(p).toLowerCase().includes(q));
  totalEl.textContent = String(perms.length);

  if (!filtered.length) {
    listEl.innerHTML = '<div class="empty-state" style="padding:18px 0"><p>没有匹配权限</p></div>';
    selectedEl.textContent = '0';
    return;
  }

  listEl.innerHTML = filtered.slice(0, 800).map((p) => {
    const perm = String(p);
    return `<label class="perm-row">
      <input type="checkbox" data-perm="${escAttr(perm)}">
      <code>${escHtml(perm)}</code>
    </label>`;
  }).join('');

  const updateSelectedCount = () => {
    selectedEl.textContent = String(listEl.querySelectorAll('input[type=\"checkbox\"]:checked').length);
  };
  listEl.querySelectorAll('input[type=\"checkbox\"]').forEach((cb) => cb.addEventListener('change', updateSelectedCount));
  updateSelectedCount();
}

document.getElementById('btn-group-add-perm')?.addEventListener('click', openPermPicker);
document.getElementById('btn-close-perm-picker')?.addEventListener('click', closePermPicker);
document.getElementById('btn-perm-picker-cancel')?.addEventListener('click', closePermPicker);
document.getElementById('perm-picker-modal')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closePermPicker(); });
document.getElementById('btn-perm-picker-clear')?.addEventListener('click', () => {
  document.getElementById('perm-picker-search').value = '';
  renderPermPickerList();
});
document.getElementById('perm-picker-search')?.addEventListener('input', renderPermPickerList);

document.getElementById('btn-perm-picker-apply')?.addEventListener('click', async () => {
  const g = groupsUIState.selected;
  if (!g) return;
  const listEl = document.getElementById('perm-picker-list');
  if (!listEl) return;
  const checked = [...listEl.querySelectorAll('input[type=\"checkbox\"]:checked')].map((cb) => cb.getAttribute('data-perm')).filter(Boolean);
  if (!checked.length) { toast('请先勾选权限', 'error'); return; }

  // 逐个添加（简单可靠）
  for (const perm of checked) {
    await api.groupGrantPerm?.(g, perm);
  }
  toast(`已添加 ${checked.length} 项权限`, 'success');
  closePermPicker();
  await loadGroupDetail(g);
});

// ===== 所有插件 =====
let pluginsLoaded = false; // 标志位：避免重复读取插件目录
async function refreshPlugins() {
  if (!state.connected) return;
  // 只在登录时读取一次，避免重复读取
  if (pluginsLoaded) {
    toast('插件列表已加载，如需刷新请点击刷新按钮', 'info');
    return;
  }
  const r = await api.getPlugins();
  pluginsLoaded = true; // 设置标志位
  const tbody = document.getElementById('allplugins-tbody');
  document.getElementById('plugin-count').textContent = `共 ${r.plugins ? r.plugins.length : 0} 个插件`;
  if (!r.ok || !r.plugins.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">
      <div class="empty-state">
        <svg viewBox="0 0 48 48" width="40" height="40" fill="none"><rect x="6" y="6" width="15" height="15" rx="3" stroke="#2a3348" stroke-width="2"/><rect x="27" y="6" width="15" height="15" rx="3" stroke="#2a3348" stroke-width="2"/><rect x="6" y="27" width="15" height="15" rx="3" stroke="#2a3348" stroke-width="2"/><rect x="27" y="27" width="15" height="15" rx="3" stroke="#2a3348" stroke-width="2"/></svg>
        <p>暂无插件数据（需连接服务器）</p>
      </div>
    </td></tr>`;
    return;
  }
  renderPluginsTable(r.plugins);
}

function renderPluginsTable(plugins) {
  const q = document.getElementById('plugin-search').value.toLowerCase();
  const filtered = q ? plugins.filter(p => p.Name.toLowerCase().includes(q)||p.Author.toLowerCase().includes(q)) : plugins;
  const tbody = document.getElementById('allplugins-tbody');
  if (!filtered.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5"><div class="empty-state"><p>无匹配插件</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map((p, i) => `<tr>
    <td style="color:#e8611a">${i+1}</td>
    <td><b>${escHtml(p.Name)}</b></td>
    <td><span style="color:#58a6ff;font-size:11px">${escHtml(p.Version)}</span></td>
    <td style="color:#7a8aa8">${escHtml(p.Author)}</td>
    <td><div class="td-actions">
      <button class="btn-xs" data-action="reload" data-plugin="${escAttr(p.Name)}">重载</button>
      <button class="btn-xs btn-xs-danger" data-action="unload" data-plugin="${escAttr(p.Name)}">卸载</button>
    </div></td>
  </tr>`).join('');
}

// 使用事件委托处理插件操作按钮点击
document.getElementById('allplugins-tbody')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  e.preventDefault();
  const action = btn.dataset.action;
  const name = btn.dataset.plugin;
  if (!name) return;
  if (action === 'reload') await reloadPlugin(btn, name);
  else if (action === 'unload') await unloadPlugin(btn, name);
});

async function reloadPlugin(btn, name) {
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '重载中...';
  try {
    // 使用完整命令格式：oxide.reload 插件名（不含 .cs 扩展名）
    const cmd = `oxide.reload ${name}`;
    const r = await api.rconCommand(cmd);
    // 输出到管理员指令结果面板，显示服务器原始回包
    appendAdminCmdOutput(cmd, r);
    if (r && r.ok && !r.timeout) {
      toast(`插件 "${name}" 重载成功`, 'success');
      // 1.5秒后刷新插件列表
      setTimeout(refreshPlugins, 1500);
    } else if (r && r.timeout) {
      toast(`插件 "${name}" 重载超时，请查看服务器控制台`, 'warn');
    } else {
      // 显示服务器返回的原始错误信息
      const errMsg = (r && r.message) ? r.message : (r?.error || '未知错误');
      toast(`插件 "${name}" 重载失败: ${errMsg}`, 'error');
    }
  } catch (err) {
    appendAdminCmdOutput(`oxide.reload ${name}`, null);
    toast(`插件 "${name}" 重载异常: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}
async function unloadPlugin(btn, name) {
  if (!confirm(`确认卸载插件 "${name}"？`)) return;
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '卸载中...';
  try {
    // 使用完整命令格式：oxide.unload 插件名
    const cmd = `oxide.unload ${name}`;
    const r = await api.rconCommand(cmd);
    appendAdminCmdOutput(cmd, r);
    if (r && r.ok && !r.timeout) {
      toast(`插件 "${name}" 已卸载`, 'success');
      setTimeout(refreshPlugins, 1500);
    } else if (r && r.timeout) {
      toast(`插件 "${name}" 卸载超时，请查看服务器控制台`, 'warn');
    } else {
      const errMsg = (r && r.message) ? r.message : (r?.error || '未知错误');
      toast(`插件 "${name}" 卸载失败: ${errMsg}`, 'error');
    }
  } catch (err) {
    appendAdminCmdOutput(`oxide.unload ${name}`, null);
    toast(`插件 "${name}" 卸载异常: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

document.getElementById('btn-refresh-plugins').onclick = () => {
  pluginsLoaded = false; // 重置标志位，允许重新读取
  refreshPlugins();
};
document.getElementById('plugin-search').addEventListener('input', async () => {
  if (!state.connected) return;
  const r = await api.getPlugins();
  renderPluginsTable(r.plugins || []);
});

// ===== 服务器配置 =====
document.querySelectorAll('.weather-btn').forEach(btn => {
  btn.onclick = async () => {
    if (!state.connected) { toast('未连接服务器', 'error'); return; }
    const prev = document.querySelector('.weather-btn.active');
    document.querySelectorAll('.weather-btn').forEach(b => b.disabled = true);
    const r = await api.serverSetWeather(btn.dataset.w);
    document.querySelectorAll('.weather-btn').forEach(b => b.disabled = false);
    if (r.ok) {
      document.querySelectorAll('.weather-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      toast('天气已设置: ' + btn.textContent, 'success');
    } else {
      if (prev) {
        document.querySelectorAll('.weather-btn').forEach(b => b.classList.remove('active'));
        prev.classList.add('active');
      }
      toast('设置失败: ' + (r.error || '未知错误'), 'error');
    }
  };
});

// 服务器维护：save/writecfg/status/info
function formatMaintOutputMessage(msg) {
  const s = String(msg || '');
  if (!s.trim()) return '(无回包)';
  const lines = s.split(/\r?\n/);
  const out = lines.map((line) => {
    const l = String(line || '');
    const m1 = l.match(/^\s*server\.description\s*[:=]\s*"([\s\S]*)"\s*$/i);
    if (m1) return m1[1];
    const m2 = l.match(/^\s*server\.description\s*[:=]\s*([\s\S]*)$/i);
    if (m2) return String(m2[1] || '').trim().replace(/^"+|"+$/g, '').trim();
    return l;
  });
  return out.join('\n').trim();
}

function localizeMaintLabel(label) {
  const key = String(label || '').trim();
  const map = {
    'server.save': '保存配置（server.save）',
    'server.writecfg': '写入配置（server.writecfg）',
    status: '服务器状态（status）',
    'server.info': '服务器信息（server.info）'
  };
  return map[key] || key;
}

function appendMaintOutput(label, r) {
  const ta = document.getElementById('server-maint-output');
  if (!ta) return;
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const ok = r && r.ok;
  const rawMsg = ok ? (r.message || '') : (r?.error || '未知错误');
  const msg = ok ? formatMaintOutputMessage(rawMsg) : String(rawMsg || '未知错误');
  ta.value = `${ta.value}${ta.value ? '\n\n' : ''}[${ts}] ${localizeMaintLabel(label)}\n${msg}`.trim();
  ta.scrollTop = ta.scrollHeight;
}

document.getElementById('btn-server-save')?.addEventListener('click', async () => {
  if (!state.connected) { toast('未连接服务器', 'error'); return; }
  const r = await api.serverSave?.();
  appendMaintOutput('server.save', r);
  if (r && r.ok) toast('已执行 server.save', 'success'); else toast('执行失败', 'error');
});
document.getElementById('btn-server-writecfg')?.addEventListener('click', async () => {
  if (!state.connected) { toast('未连接服务器', 'error'); return; }
  const r = await api.serverWriteCfg?.();
  appendMaintOutput('server.writecfg', r);
  if (r && r.ok) toast('已执行 server.writecfg', 'success'); else toast('执行失败', 'error');
});
document.getElementById('btn-server-status')?.addEventListener('click', async () => {
  if (!state.connected) { toast('未连接服务器', 'error'); return; }
  const r = await api.serverStatus?.();
  appendMaintOutput('status', r);
  if (r && r.ok) toast('已获取 status', 'success'); else toast('获取失败', 'error');
});
document.getElementById('btn-server-info')?.addEventListener('click', async () => {
  if (!state.connected) { toast('未连接服务器', 'error'); return; }
  const r = await api.serverInfo?.();
  appendMaintOutput('server.info', r);
  if (r && r.ok) toast('已获取 server.info', 'success'); else toast('获取失败', 'error');
});
document.getElementById('btn-copy-maint-output')?.addEventListener('click', async () => {
  const ta = document.getElementById('server-maint-output');
  const v = ta?.value || '';
  if (!v.trim()) { toast('没有可复制的内容', 'error'); return; }
  await navigator.clipboard.writeText(v);
  toast('已复制输出', 'success');
});
document.getElementById('btn-clear-maint-output')?.addEventListener('click', () => {
  const ta = document.getElementById('server-maint-output');
  if (ta) ta.value = '';
});

/** 渲染层兜底：即使主进程返回了未剥离前缀的值，也不要把乱码写进输入框 */
function stripConvarPrefix(val, name) {
  let v = String(val == null ? '' : val).trim();
  if (!v) return '';
  if (name) {
    const i = v.toLowerCase().indexOf(String(name).toLowerCase());
    if (i === 0) {
      v = v.slice(String(name).length).replace(/^\s*[:=]?\s*/, '').trim();
    }
  }
  const q = v.match(/^"([\s\S]*)"$/);
  if (q) v = q[1].trim();
  return v;
}

function setCfgStatus(kind, text) {
  const dot = document.getElementById('cfg-status-dot');
  const t = document.getElementById('cfg-status-text');
  if (t) t.textContent = text;
  if (dot) dot.className = 'cfg-status-dot' + (kind ? ' is-' + kind : '');
}

async function readServerInfoIntoMaint() {
  if (!state.connected) return;
  const ta = document.getElementById('server-maint-output');
  if (!ta) return;
  const r = await api.serverInfo?.();
  if (r && r.ok) {
    if (typeof appendMaintOutput === 'function') appendMaintOutput('server.info', r);
    else ta.value = `[${new Date().toLocaleString('zh-CN')}] server.info\n${r.message || ''}\n`;
  }
}

async function loadServerConfigSnapshot() {  if (!state.connected) {
    setCfgStatus('', '未连接服务器，无法读取配置快照');
    return;
  }
  const btn = document.getElementById('btn-refresh-cfg');
  if (btn) btn.classList.add('is-loading');
  setCfgStatus('', '正在读取配置快照…');
  try {
    const names = [
      'server.hostname',
      'server.description',
      'server.headerimage',
      'server.url',
      'server.tags',
      'heli.bulletdamagescale',
      'spawn.max_density',
      'spawn.min_density',
      'spawn.max_rate',
      'spawn.min_rate',
      'server.maxteamsize',
      'server.maxplayers',
      'env.time',
      'env.daylength',
      'env.nightlength',
      'server.combatlogsize',
      'global.npc_enabled',
    ];
    const r = await api.serverGetConvars?.(names);
    if (!r || !r.ok) {
      setCfgStatus('error', '读取配置快照失败：' + ((r && r.error) || '未知错误'));
      return;
    }
    const { okCount, failed } = applyServerConfigSnapshot(r.values || {});

    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    if (failed.length) {
      setCfgStatus('warn', `快照已读取 ${time} · 成功 ${okCount} 项 · 以下项服务器未返回：${failed.join('、')}`);
    } else {
      setCfgStatus('ok', `快照已读取 ${time} · 全部 ${okCount} 项`);
    }
  } catch (e) {
    setCfgStatus('error', '读取配置快照异常：' + (e.message || e));
  } finally {
    if (btn) btn.classList.remove('is-loading');
  }
}

/**
 * 把服务器返回的 convar 值回填到配置页各输入框（纯函数，便于单独验证）
 * @returns {{okCount:number, failed:string[]}}
 */
function applyServerConfigSnapshot(v) {
  const values = v || {};
  let okCount = 0;
  const failed = [];
  const setVal = (id, key) => {
    const val = stripConvarPrefix(values[key], key);
    if (val === '' || val == null) { failed.push(key); return; }
    const el = document.getElementById(id);
    if (el) el.value = val;
    okCount++;
  };
  setVal('cfg-hostname', 'server.hostname');
  setVal('cfg-desc', 'server.description');
  setVal('cfg-logo', 'server.headerimage');
  setVal('team-limit', 'server.maxteamsize');
  setVal('heli-dmg', 'heli.bulletdamagescale');
  setVal('res-maxden', 'spawn.max_density');
  setVal('res-minden', 'spawn.min_density');
  setVal('res-maxspd', 'spawn.max_rate');
  setVal('res-minspd', 'spawn.min_rate');
  // 连接后一并读出运行状态，使这些字段可读可改
  setVal('server-maxplayers', 'server.maxplayers');
  setVal('server-time', 'env.time');
  setVal('env-daylength', 'env.daylength');
  setVal('env-nightlength', 'env.nightlength');
  setVal('combatlog-size', 'server.combatlogsize');

  // NPC 开关：按读到的值高亮对应按钮
  const npcRaw = stripConvarPrefix(values['global.npc_enabled'], 'global.npc_enabled');
  if (npcRaw !== '') {
    const npcOn = /true|1|yes|on/i.test(npcRaw);
    document.getElementById('btn-npc-on')?.classList.toggle('is-active', npcOn);
    document.getElementById('btn-npc-off')?.classList.toggle('is-active', !npcOn);
    okCount++;
  } else {
    failed.push('global.npc_enabled');
  }

  // 服务器标签：把当前值回填到勾选框（此前从不回填，每次都显示为空）
  const tagsRaw = stripConvarPrefix(values['server.tags'], 'server.tags');
  if (tagsRaw) {
    const set = new Set(tagsRaw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean));
    document.querySelectorAll('.tag-chip input').forEach((cb) => { cb.checked = set.has(String(cb.value).toLowerCase()); });
    updateTagCounter();
    okCount++;
  } else {
    failed.push('server.tags');
  }

  // 连接链接：按当前服务器自动填好，省得手打
  const linkEl = document.getElementById('cfg-serverlink');
  if (linkEl && !linkEl.value.trim() && state.currentServer && state.currentServer.IpAddress) {
    const port = state.currentServer.QueryPort || 28015;
    linkEl.value = `steam://connect/${state.currentServer.IpAddress}:${port}`;
  }
  return { okCount, failed };
}

// 标签勾选：实时计数 + 超过 4 个直接拦住（而不是提交时才报错）
function updateTagCounter() {
  const boxes = [...document.querySelectorAll('.tag-chip input')];
  const checked = boxes.filter((b) => b.checked);
  const el = document.getElementById('tag-counter');
  if (el) {
    el.textContent = `已选 ${checked.length} / 4`;
    el.classList.toggle('is-full', checked.length >= 4);
  }
  boxes.forEach((b) => {
    const chip = b.closest('.tag-chip');
    if (chip) chip.classList.toggle('is-checked', b.checked);
    // 已达上限时，未勾选的置灰但仍可点（点击会给出提示）
    b.disabled = false;
  });
}
document.querySelectorAll('.tag-chip input').forEach((cb) => {
  cb.addEventListener('change', () => {
    const checked = [...document.querySelectorAll('.tag-chip input:checked')];
    if (checked.length > 4) {
      cb.checked = false;
      toast('最多只能选择 4 个标签', 'error');
    }
    updateTagCounter();
  });
});
(function initTagChips() {
  try { updateTagCounter(); } catch (e) {}
})();

document.getElementById('btn-refresh-cfg')?.addEventListener('click', () => loadServerConfigSnapshot());

// 最大玩家数（此前主进程有接口但 preload 没暴露，属于不可达功能）
document.getElementById('btn-set-maxplayers')?.addEventListener('click', async () => {
  if (!state.connected) { toast('未连接服务器', 'error'); return; }
  const v = parseInt(document.getElementById('server-maxplayers')?.value, 10);
  if (!Number.isFinite(v) || v < 1) { toast('请输入有效的人数', 'error'); return; }
  const r = await api.serverSetMaxplayers?.(v);
  if (r && r.ok) { toast(`最大玩家数已设为 ${v}`, 'success'); setTimeout(loadServerConfigSnapshot, 800); }
  else toast('设置失败: ' + ((r && r.error) || ''), 'error');
});

// 白天/夜晚时长（env.daylength / env.nightlength）
document.getElementById('btn-set-daynight')?.addEventListener('click', async () => {
  if (!state.connected) { toast('未连接服务器', 'error'); return; }
  const day = parseInt(document.getElementById('env-daylength')?.value, 10);
  const night = parseInt(document.getElementById('env-nightlength')?.value, 10);
  if (!Number.isFinite(day) && !Number.isFinite(night)) { toast('请至少填写一个时长', 'error'); return; }
  let ok = true;
  if (Number.isFinite(day)) { const r = await api.rconCommand(`env.daylength ${day}`); ok = ok && !!(r && r.ok); }
  if (Number.isFinite(night)) { const r = await api.rconCommand(`env.nightlength ${night}`); ok = ok && !!(r && r.ok); }
  if (ok) { toast('白天/夜晚时长已设置', 'success'); setTimeout(loadServerConfigSnapshot, 800); }
  else toast('设置失败', 'error');
});

// NPC / CombatLog
document.getElementById('btn-npc-on')?.addEventListener('click', async () => {
  if (!state.connected) { toast('未连接服务器', 'error'); return; }
  const r = await api.serverNpcEnabled?.(true);
  if (r && r.ok) toast('NPC 已开启', 'success'); else toast('NPC 开启失败', 'error');
});
document.getElementById('btn-npc-off')?.addEventListener('click', async () => {
  if (!state.connected) { toast('未连接服务器', 'error'); return; }
  const r = await api.serverNpcEnabled?.(false);
  if (r && r.ok) toast('NPC 已关闭', 'success'); else toast('NPC 关闭失败', 'error');
});
document.getElementById('btn-set-combatlog')?.addEventListener('click', async () => {
  if (!state.connected) { toast('未连接服务器', 'error'); return; }
  const v = parseInt(document.getElementById('combatlog-size')?.value, 10);
  if (!Number.isFinite(v) || v < 0) { toast('请输入有效数值', 'error'); return; }
  const r = await api.serverCombatLog?.(v);
  if (r && r.ok) toast('combatlogsize 已设置', 'success'); else toast('设置失败', 'error');
});

document.getElementById('btn-set-hostname').onclick = async () => {
  const name = document.getElementById('cfg-hostname').value.trim();
  if (!name) { toast('请输入服务器名称', 'error'); return; }
  const r = await api.serverSetHostname(name);
  if (r.ok) { toast('服务器名称已修改', 'success'); setTimeout(loadServerConfigSnapshot, 800); } else toast('修改失败: ' + r.error, 'error');
};

document.getElementById('btn-copy-link').onclick = () => {
  const link = document.getElementById('cfg-serverlink').value.trim();
  if (!link) { toast('请先输入链接', 'error'); return; }
  navigator.clipboard.writeText(link).then(() => toast('链接已复制', 'success'));
};

document.getElementById('btn-set-logo').onclick = async () => {
  const logo = document.getElementById('cfg-logo').value.trim();
  if (!state.connected) { toast('未连接服务器', 'error'); return; }
  const r = await api.serverSetConvar?.('server.headerimage', logo);
  if (r && r.ok) toast('HeaderImage 已设置', 'success'); else toast('设置失败', 'error');
};

document.getElementById('btn-set-desc').onclick = () => {
  const desc = document.getElementById('cfg-desc').value.trim();
  if (!state.connected) { toast('未连接服务器', 'error'); return; }
  (async () => {
    const r = await api.serverSetConvar?.('server.description', desc);
    if (!r || !r.ok) { toast('设置失败', 'error'); return; }

    // 立即读取校验一次，确认确实写入（避免权限不足/插件拦截导致“看似成功”）
    const vr = await api.serverGetConvars?.(['server.description']);
    const now = vr && vr.ok ? String((vr.values || {})['server.description'] || '').trim() : '';
    if (now && now === desc) toast('服务器介绍已保存（已校验）', 'success');
    else toast('服务器介绍已提交（未校验到一致值）', 'info');
  })().catch(() => toast('设置失败', 'error'));
};

document.getElementById('btn-set-team').onclick = async () => {
  const n = document.getElementById('team-limit').value;
  if (!n) { toast('请输入人数', 'error'); return; }
  const r = await api.serverTeamLimit(parseInt(n));
  if (r.ok) toast('组队限制已设置: ' + n, 'success'); else toast('设置失败', 'error');
};
document.getElementById('btn-default-team').onclick = async () => {
  const r = await api.serverTeamLimit(8);
  if (r.ok) toast('组队限制已恢复默认(8)', 'success');
};

document.getElementById('btn-set-time').onclick = async () => {
  const t = document.getElementById('server-time').value;
  if (t === '' || t === null) { toast('请输入时间值', 'error'); return; }
  const r = await api.serverSetTime(parseFloat(t));
  if (r.ok) toast('服务器时间已设置: ' + t, 'success'); else toast('设置失败', 'error');
};

document.getElementById('btn-set-heli-time').onclick = async () => {
  const t = document.getElementById('heli-time').value;
  if (!t) { toast('请输入时间', 'error'); return; }
  const r = await api.rconCommand(`heli.calltimer ${t}`);
  if (r.ok) toast('巡逻时间已设置', 'success'); else toast('设置失败', 'error');
};
document.getElementById('btn-set-heli-dmg').onclick = async () => {
  const d = document.getElementById('heli-dmg').value;
  if (!d) { toast('请输入伤害值', 'error'); return; }
  const r = await api.rconCommand(`heli.bulletdamagescale ${d}`);
  if (r.ok) {
    toast('伤害数值已设置', 'success');
    // 写入配置，防止重启丢失（可手动取消）
  } else toast('设置失败', 'error');
};
document.getElementById('btn-heli-no-gun').onclick = async () => {
  await api.rconCommand('heli.bulletdamagescale 0');
  toast('武直已设为不开枪', 'success');
};
document.getElementById('btn-heli-gun').onclick = async () => {
  await api.rconCommand('heli.bulletdamagescale 1');
  toast('武直已恢复开枪', 'success');
};
document.getElementById('btn-heli-default').onclick = async () => {
  await api.rconCommand('heli.bulletdamagescale 0.5');
  toast('武直已还原默认值', 'success');
};

document.getElementById('btn-scale-on').onclick = async () => {
  await api.rconCommand('server.pvpscale 1');
  toast('承重模式已开启', 'success');
};
document.getElementById('btn-scale-off').onclick = async () => {
  await api.rconCommand('server.pvpscale 0');
  toast('承重模式已关闭', 'success');
};

document.querySelectorAll('[data-res]').forEach(btn => {
  btn.onclick = async () => {
    const type = btn.dataset.res;
    const inputMap = { maxden: 'res-maxden', minden: 'res-minden', maxspd: 'res-maxspd', minspd: 'res-minspd' };
    const val = document.getElementById(inputMap[type])?.value;
    if (!val) { toast('请输入数值', 'error'); return; }
    const cmdMap = {
      maxden: `spawn.max_density ${val}`,
      minden: `spawn.min_density ${val}`,
      maxspd: `spawn.max_rate ${val}`,
      minspd: `spawn.min_rate ${val}`
    };
    const r = await api.rconCommand(cmdMap[type]);
    if (r.ok) toast('设置成功', 'success'); else toast('设置失败', 'error');
  };
});

document.getElementById('btn-confirm-tags').onclick = async () => {
  const checked = [...document.querySelectorAll('.tag-chip input:checked')].map(i => i.value);
  if (checked.length > 4) { toast('最多只能选择4个标签', 'error'); return; }
  // 参考 Rust 服务器标签：server.tags "weekly,vanilla"
  const r = await api.rconCommand(`server.tags "${checked.join(',')}"`);
  if (r.ok) { toast('服务器标签已更新', 'success'); setTimeout(loadServerConfigSnapshot, 800); } else toast('标签设置失败', 'error');
};

// ===== 玩家授权 =====
function showPermResult(msg, ok) {
  const el = document.getElementById('perm-result');
  if (!el) return;
  el.textContent = (ok ? '✓ ' : '✗ ') + msg;
  el.className = `perm-result show ${ok ? 'ok' : 'err'}`;
}

// （旧版 perm-name / btn-grant-user 等控件已移除，授权请使用「玩家授权」页内的网格与按钮。）

// ===== FPS / 实体：解析 RCON 常见格式（含 "convar" = "值"、纯数字、多数字取实体最大值等） =====
function parseFpsFromRconMessage(msg) {
  const s = String(msg || '').trim();
  if (!s) return null;
  const q = s.match(/=\s*"([\d.]+)"|=\s*([\d.]+)\s/);
  if (q) return String(Math.round(parseFloat(q[1] || q[2])));
  const m = s.match(/(\d+\.?\d*)\s*fps/i) || s.match(/fps[:\s]+(\d+\.?\d*)/i);
  if (m) return String(Math.round(parseFloat(m[1])));
  const one = s.match(/^([\d.]+)\s*$/);
  if (one) {
    const v = parseFloat(one[1]);
    if (v >= 1 && v <= 2000) return String(Math.round(v));
  }
  const nums = s.match(/\d+\.?\d*/g);
  if (!nums) return null;
  const vals = nums.map((x) => parseFloat(x)).filter((n) => n >= 1 && n <= 2000);
  if (!vals.length) return null;
  return String(Math.round(vals[0]));
}

function parseEntitiesFromRconMessage(msg) {
  const s = String(msg || '').replace(/,/g, ' ').trim();
  if (!s) return null;

  const low = s.toLowerCase();
  if (/unknown command|command not found|not available|no permission/i.test(low)) return null;

  // 常见直接格式：Entities: 123 / entities = 123 / server.entities = "123"
  const named =
    s.match(/server\.(?:entities)\s*[^0-9-]{0,20}(-?\d+)/i) ||
    s.match(/entities\s*[^0-9-]{0,20}(-?\d+)/i) ||
    s.match(/entity\s*(?:count|#)?\s*[^0-9-]{0,20}(-?\d+)/i);

  if (named && named[1] != null) {
    const n = parseInt(named[1], 10);
    if (!Number.isNaN(n) && n >= 0 && n <= 200000000) return String(n);
  }

  // 纯数字：123
  const sole = s.match(/^(\d+)$/);
  if (sole) return sole[1];

  // 兜底：提取所有数字，尽量避开常见端口号干扰
  const nums = s.match(/\d+/g);
  if (!nums || !nums.length) return null;

  const vals = nums.map((x) => parseInt(x, 10)).filter((n) => n >= 0 && n <= 200000000);
  if (!vals.length) return null;

  const skipPorts = new Set([25575, 28016, 28015, 27015, 27016]);
  const candidates = vals.filter((n) => !skipPorts.has(n) || vals.length === 1);
  return String(Math.max(...(candidates.length ? candidates : vals)));
}

function applyServerStatsFromConsoleText(text) {
  const t = String(text || '');
  if (!t.trim()) return;

  if (/server\.fps\b|["']server\.fps["']\s*=/i.test(t)) {
    const v = parseFpsFromRconMessage(t);
    if (v != null) {
      const el = document.getElementById('stat-fps');
      if (el) el.textContent = v;
    }
  }
  applyJoinQueueStatsFromStatusText(t);
}

function applyJoinQueueStatsFromStatusText(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return;
  // Rust status 文本格式: players: 5 (10 max) (0 joining) (1 queued)
  // 需要精确匹配括号内的 joining/queued 数字，避免匹配到 SteamID 等其他数字
  // 匹配模式: (数字 joining) 或 (数字 queued)
  const joiningMatch = /\(\s*(\d+)\s*joining\s*\)/i.exec(t);
  const queueMatch = /\(\s*(\d+)\s*queu?e?d?\s*\)/i.exec(t);
  if (joiningMatch) {
    const v = Number(joiningMatch[1] || 0);
    const el = document.getElementById('stat-joining');
    if (el) el.textContent = Number.isFinite(v) ? String(v) : '0';
  }
  if (queueMatch) {
    const v = Number(queueMatch[1] || 0);
    const el = document.getElementById('stat-queue');
    if (el) el.textContent = Number.isFinite(v) ? String(v) : '0';
  }
}

let statsPollingInFlight = false;
let statusPollTick = 0;
async function pollServerStats() {
  if (!state.connected) return;
  if (statsPollingInFlight) return;
  statsPollingInFlight = true;

  try {
    const r = await api.rconCommandSilent('server.fps');
    if (r.ok && !r.timeout && r.message) {
      const v = parseFpsFromRconMessage(r.message);
      if (v != null) {
        const el = document.getElementById('stat-fps');
        if (el) el.textContent = v;
      }
    }
    // 每 5 秒拉一次 status，用于“加入中/排队”统计
    statusPollTick = (statusPollTick + 1) % 5;
    if (statusPollTick === 0) {
      const s = await api.rconCommandSilent('status');
      if (s?.ok && !s.timeout && s.message) {
        applyJoinQueueStatsFromStatusText(s.message);
      }
    }
  } catch {}
  finally {
    statsPollingInFlight = false;
  }
}

// ===== FPS/实体 自动更新 =====
setInterval(pollServerStats, 1000);

// ===== 工具函数 =====
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function formatDuration(sec) {
  if (!sec) return '-';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

// ===== 主题切换 =====
let currentTheme = 'dark';
function applyTheme(theme) {
  currentTheme = theme === 'light' ? 'light' : 'dark';
  // 同时设置 html/body，避免变量作用域差异导致主题不生效
  document.documentElement.setAttribute('data-theme', currentTheme);
  document.body.setAttribute('data-theme', currentTheme);
  localStorage.setItem('rustadmin-theme', currentTheme);
  const darkIcon = document.getElementById('theme-icon-dark');
  const lightIcon = document.getElementById('theme-icon-light');
  if (darkIcon) {
    darkIcon.classList.toggle('u-hidden', currentTheme !== 'dark');
    darkIcon.style.display = '';
  }
  if (lightIcon) {
    lightIcon.classList.toggle('u-hidden', currentTheme !== 'light');
    lightIcon.style.display = '';
  }
}

document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
});

// ===== 最新 Rust 新闻滚动条（自动从 Facepunch 官网抓取 + 汉化）=====
const FALLBACK_NEWS = [
  { tag: 'DevBlog', zh: '全力升级，尽情突袭(Upgrade hard, raid harder) — 本月更新带来工作台升级系统、新型迫击炮、加强版锡罐报警器，以及模型翻新重制、大量生活质量改进、错误修复等！' },
  { tag: 'DevBlog', zh: '春季大扫除(Spring Clean) — 本月更新带来装甲梯舱盖和水轮机两个全新物品，以及大量生活质量改进、错误修复和性能优化！' },
  { tag: '开发日志', zh: '造船大师(Shipshape) — 水上及深海居住、建造、战斗全面改进，延长白天时间' },
  { tag: '节日活动', zh: '2026农历新年 — 通过精致马面具、马铠甲等道具迎接马年到来！' },
  { tag: '大更新', zh: '海军大更新(Naval Update) — 可建造船只、深海探索、热带岛屿、幽灵船、改进版AI' },
  { tag: '社区更新', zh: '社区更新268(Community Update 268) — 海军测试阶段、Twitch掉落奖励、父子玩家组合、圣诞狂欢节回顾等' },
  { tag: '开发日志', zh: '十二周年生存之路(Surviving 12 Years) — 回顾2025年全年并透露2026年部分规划' },
  { tag: '公告', zh: '精益求精(Getting It Right) — 海军大更新值得等待，大量新内容等你来玩' },
];

async function appendNewsDots() {
  const track = document.getElementById('news-ticker-track');
  if (!track) return;
  const content = track.querySelector('.news-ticker-content');
  if (!content) return;

  // 优先从后端（main.js 抓取+汉化）获取最新新闻
  let newsData = FALLBACK_NEWS;
  try {
    const liveNews = await api.getRustNews();
    if (liveNews && liveNews.length > 0) {
      // 后端返回的数据已经包含 zh 汉化字段
      newsData = liveNews.map(n => ({
        tag: n.tag || '新闻',
        zh: n.zh || (n.title ? `${n.title} — ${n.desc}` : (n.desc || ''))
      }));
      // 过滤空项
      newsData = newsData.filter(n => n.zh);
    }
  } catch {}

  // 如果最终数据为空则使用兜底
  if (!newsData || newsData.length === 0) newsData = FALLBACK_NEWS;

  // 构建双倍内容实现无缝滚动
  let html = '';
  for (let i = 0; i < 2; i++) {
    newsData.forEach(news => {
      html += `<span class="news-tag">${escHtml(news.tag)}</span>`;
      html += `<span class="news-item">${escHtml(news.zh)}</span>`;
      html += `<span class="news-dot">●</span>`;
    });
  }
  content.innerHTML = html;
}

// ===== 玩家授权（新界面）状态 =====
const PERM_OPTIONS = [
  { name: '基础权限', perms: [
    { label: '使用箱子', value: 'can_use_storages', code: 'can_use_storages' },
    { label: '使用工作台', value: 'workbench.use', code: 'workbench.use' },
    { label: '建造权限', value: 'building.manage', code: 'building.manage' },
    { label: '友方伤害', value: 'friendlyfire.use', code: 'friendlyfire.use' },
  ]},
  { name: '经济权限', perms: [
    { label: '给予物品', value: 'inventory.give', code: 'inventory.give' },
    { label: '给予金币', value: 'economics.grant', code: 'economics.grant' },
    { label: '给予积分', value: 'sr.grant', code: 'sr.grant' },
    { label: '交易权限', value: 'trading.use', code: 'trading.use' },
  ]},
  { name: '管理权限', perms: [
    { label: '踢出玩家', value: 'player.kick', code: 'player.kick' },
    { label: '封禁玩家', value: 'player.ban', code: 'player.ban' },
    { label: '传送玩家', value: 'player.teleport', code: 'player.teleport' },
    { label: '聊天管理', value: 'chat.enabled', code: 'chat.enabled' },
  ]},
  { name: 'VIP权限', perms: [
    { label: 'VIP权限', value: 'vip.use', code: 'vip.use' },
    { label: 'VIP飞行', value: 'vip.fly', code: 'vip.fly' },
    { label: 'VIP传送', value: 'vip.teleport', code: 'vip.teleport' },
    { label: 'VIP保护', value: 'vip.protect', code: 'vip.protect' },
  ]},
];

// ===== 管理员指令（模板中 {参数名} 可多处出现，发送时全部替换） =====
const ADMIN_COMMANDS = [
  {
    category: '基础查询与维护',
    icon: '📋',
    commands: [
      { name: '保存地图', desc: '立即保存当前地图与世界状态', code: 'server.save', example: 'server.save' },
      { name: '写入配置', desc: '把当前 convar 写入配置文件', code: 'server.writecfg', example: 'server.writecfg' },
      { name: '服务器状态', desc: '显示在线、帧率、内存等状态', code: 'status', example: 'status' },
      { name: '服务器信息', desc: '显示服务器基础配置信息', code: 'server.info', example: 'server.info' },
      { name: '在线列表', desc: '输出在线玩家 JSON 列表', code: 'playerlist', example: 'playerlist' },
      { name: '封禁列表', desc: '查看当前封禁列表', code: 'banlist', example: 'banlist' }
    ]
  },
  {
    category: '玩家管理',
    icon: '👤',
    commands: [
      { name: '全服广播', desc: '向全服发送聊天公告', code: 'say {message}', example: 'say 服务器将在 10 分钟后重启' },
      { name: '踢出玩家', desc: '踢出在线玩家（建议附带原因）', code: 'kick {steamid} {reason}', example: 'kick 76561198012345678 违反规则' },
      { name: '封禁玩家', desc: '封禁玩家并写入 banlist', code: 'ban {steamid} {reason}', example: 'ban 76561198012345678 使用外挂' },
      { name: '解封玩家', desc: '从封禁列表中移除', code: 'unban {steamid}', example: 'unban 76561198012345678' },
      { name: '禁言玩家', desc: '需服务器/插件支持 mute 指令', code: 'mute {steamid} {minutes}', example: 'mute 76561198012345678 60' },
      { name: '解除禁言', desc: '需服务器/插件支持 unmute', code: 'unmute {steamid}', example: 'unmute 76561198012345678' }
    ]
  },
  {
    category: '传送与天气时间',
    icon: '🌤',
    commands: [
      { name: '传送到领地柜', desc: '传送到玩家最近领地柜（服务器支持时）', code: 'teleport2owneditem {steamid}', example: 'teleport2owneditem 76561198012345678' },
      { name: '坐标传送', desc: '按 XYZ 坐标传送', code: 'teleport {x} {y} {z}', example: 'teleport 0 100 0' },
      { name: '设置时间', desc: '设置服务器游戏时间（0-24）', code: 'env.time {hour}', example: 'env.time 12' },
      { name: '晴天', desc: '清空天气效果', code: 'weather.reset', example: 'weather.reset' },
      { name: '暴雨', desc: '加载暴雨预设（推荐）', code: 'weather.load Storm', example: 'weather.load Storm' },
      { name: '浓雾', desc: '加载浓雾预设', code: 'weather.load Fog', example: 'weather.load Fog' }
    ]
  },
  {
    category: '服务器配置',
    icon: '⚙️',
    commands: [
      { name: '修改主机名', desc: '修改服务器名称（支持中文）', code: 'server.hostname "{name}"', example: 'server.hostname "我的 Rust 服"' },
      { name: '修改介绍', desc: '修改服务器介绍文本', code: 'server.description "{message}"', example: 'server.description "欢迎新玩家加入"' },
      { name: '设置队伍上限', desc: '设置最大组队人数', code: 'server.maxteamsize {n}', example: 'server.maxteamsize 8' },
      { name: 'NPC 开关', desc: 'true=开启，false=关闭', code: 'global.npc_enabled {bool}', example: 'global.npc_enabled true' },
      { name: '战斗日志长度', desc: '设置 combatlog 条数', code: 'server.combatlogsize {n}', example: 'server.combatlogsize 30' },
      { name: '武直机枪伤害倍率', desc: '0=不开枪，1=原始倍率', code: 'heli.bulletdamagescale {v}', example: 'heli.bulletdamagescale 0.5' }
    ]
  },
  {
    category: '资源刷新与经济插件',
    icon: '💰',
    commands: [
      { name: '资源最大密度', desc: '资源节点刷新密度上限', code: 'spawn.max_density {v}', example: 'spawn.max_density 1' },
      { name: '资源最小密度', desc: '资源节点刷新密度下限', code: 'spawn.min_density {v}', example: 'spawn.min_density 0.35' },
      { name: '资源最大速率', desc: '资源刷新速率上限', code: 'spawn.max_rate {v}', example: 'spawn.max_rate 1' },
      { name: '资源最小速率', desc: '资源刷新速率下限', code: 'spawn.min_rate {v}', example: 'spawn.min_rate 0.35' },
      { name: '给予物品（插件）', desc: '需支持 inventory.give 的插件', code: 'inventory.give {steamid} {shortname} {amount}', example: 'inventory.give 76561198012345678 wood 1000' },
      { name: '充值金币（Economics）', desc: '需 Economics 插件', code: 'economics.deposit {steamid} {amount}', example: 'economics.deposit 76561198012345678 5000' }
    ]
  },
  {
    category: 'Oxide 插件管理',
    icon: '🔌',
    commands: [
      { name: 'Oxide 版本', desc: '显示 Oxide/uMod 版本', code: 'oxide.version', example: 'oxide.version' },
      { name: '插件列表', desc: '显示已加载插件', code: 'oxide.plugins', example: 'oxide.plugins' },
      { name: '重载插件', desc: '插件名不要带 .cs', code: 'oxide.reload {plugin}', example: 'oxide.reload Vanish' },
      { name: '卸载插件', desc: '从内存卸载插件', code: 'oxide.unload {plugin}', example: 'oxide.unload Vanish' },
      { name: '加载插件', desc: '重新加载已存在插件文件', code: 'oxide.load {plugin}', example: 'oxide.load Vanish' },
      { name: '重载全部插件', desc: '高风险，可能造成短暂卡顿', code: 'oxide.reload *', example: 'oxide.reload *', dangerous: true, confirm: '将重载所有 Oxide 插件，可能造成短暂卡顿，确定执行？' }
    ]
  },
  {
    category: 'GM命令 1.5（集成）',
    icon: '🧰',
    commands: [
      { name: '无敌开关', desc: '1 开启 / 0 关闭', code: 'god {bool}', example: 'god 1' },
      { name: 'PVE 开关', desc: '1 开启 / 0 关闭', code: 'pve {bool}', example: 'pve 1' },
      { name: '建筑稳定性开关', desc: '1 开启 / 0 关闭', code: 'stability {bool}', example: 'stability 1' },
      { name: '海平面高度', desc: '0 为默认海平面，数值越大水位越高；改完用 server.writecfg 持久化', code: 'env.oceanlevel {v}', example: 'env.oceanlevel 0' },
      { name: '传送到地图标记', desc: '传送到当前地图标记位置', code: 'teleport2marker', example: 'teleport2marker' },
      { name: '武直巡逻时长(分钟)', desc: '设置武直存在时长', code: 'heli.lifetimeminutes {n}', example: 'heli.lifetimeminutes 15' },
      { name: '武直机枪开关', desc: '1 开启 / 0 关闭', code: 'heli.guns {bool}', example: 'heli.guns 1' },
      { name: '天气-雨强度', desc: '0-1', code: 'weather.rain {v}', example: 'weather.rain 1' },
      { name: '天气-雾强度', desc: '0-1', code: 'weather.fog {v}', example: 'weather.fog 0.5' },
      { name: '天气-云强度', desc: '0-1', code: 'weather.cloud {v}', example: 'weather.cloud 1' },
      { name: '天气-风强度', desc: '0-1', code: 'weather.wind {v}', example: 'weather.wind 1' },
      { name: '实体半径查询', desc: '查询半径范围内实体数量', code: 'entity.find_radius {n}', example: 'entity.find_radius 50' },
      { name: '聊天禁言(名字)', desc: '按名字禁言聊天', code: 'mutechat {name}', example: 'mutechat ABC' },
      { name: '聊天解禁(名字)', desc: '解除聊天禁言', code: 'unmutechat {name}', example: 'unmutechat ABC' },
      { name: '腐蚀倍率', desc: '1 默认 / 0 关闭', code: 'decay.scale {v}', example: 'decay.scale 0' },
      { name: '生成动物-熊', code: 'entity.spawn bear', example: 'entity.spawn bear' },
      { name: '生成动物-狼', code: 'entity.spawn wolf', example: 'entity.spawn wolf' },
      { name: '生成动物-鹿', code: 'entity.spawn stag', example: 'entity.spawn stag' },
      { name: '生成动物-马', code: 'entity.spawn horse', example: 'entity.spawn horse' },
      { name: '生成科学家(M249)', code: 'entity.spawn scientist_gunner', example: 'entity.spawn scientist_gunner' },
      { name: '生成普通科学家', code: 'entity.spawn Scientist', example: 'entity.spawn Scientist' },
      { name: '生成重装科学家', code: 'spawn heavyscientist', example: 'spawn heavyscientist' },
      { name: '生成武直', code: 'heli.call', example: 'heli.call' },
      { name: '武直到我位置', code: 'heli.calltome', example: 'heli.calltome' },
      { name: '当前点投放武直补给', code: 'heli.drop', example: 'heli.drop' },
      { name: '生成坦克', code: 'entity.spawn bradleyapc', example: 'entity.spawn bradleyapc' },
      { name: '生成货船', code: 'spawn cargoshiptest', example: 'spawn cargoshiptest' },
      { name: '生成小直升机', code: 'entity.spawn minicopter', example: 'entity.spawn minicopter' },
      { name: '生成划艇', code: 'entity.spawn rowboat', example: 'entity.spawn rowboat' },
      { name: '生成 RHIB 快艇', code: 'spawn rhib', example: 'spawn rhib' },
      { name: '生成双人潜艇', code: 'entity.spawn submarineduo.entity', example: 'entity.spawn submarineduo.entity' },
      { name: '生成单人潜艇', code: 'entity.spawn submarinesolo.entity', example: 'entity.spawn submarinesolo.entity' },
      { name: '生成空投箱', code: 'entity.spawn supply_drop', example: 'entity.spawn supply_drop' },
      { name: '生成精英箱', code: 'entity.spawn crate_elite', example: 'entity.spawn crate_elite' },
      { name: '生成坦克箱', code: 'entity.spawn bradley_crate', example: 'entity.spawn bradley_crate' },
      { name: '生成武直箱', code: 'entity.spawn heli_crate', example: 'entity.spawn heli_crate' },
      { name: '生成油井', code: 'entity.spawn survey_crater_oil', example: 'entity.spawn survey_crater_oil' },
      { name: '生成采油机', code: 'entity.spawn pumpjack-static', example: 'entity.spawn pumpjack-static' },
      { name: '生成采矿机', code: 'entity.spawn MiningQuarry', example: 'entity.spawn MiningQuarry' },
      { name: '生成领地柜', code: 'entity.spawn cupboard.tool', example: 'entity.spawn cupboard.tool' },
      { name: '生成大型熔炉', code: 'entity.spawn furnace.large', example: 'entity.spawn furnace.large' },
      { name: '封禁ID', desc: '按 SteamID 直接封禁', code: 'banid {steamid} {reason}', example: 'banid 76561198012345678 违规行为' },
      { name: '进入旁观', desc: '进入旁观指定玩家（需支持）', code: 'spectate {steamid}', example: 'spectate 76561198012345678' },
      { name: '退出旁观并重生', code: 'respawn me', example: 'respawn me' },
      { name: '解锁当前瞄准实体', code: 'ent unlock', example: 'ent unlock' },
      { name: '锁定当前瞄准实体', code: 'ent lock', example: 'ent lock' },
      { name: '查询当前瞄准实体所有者', code: 'ent who', example: 'ent who' },
      { name: '解锁全部蓝图', desc: '管理员本地角色生效', code: 'inventory.unlockall', example: 'inventory.unlockall' },
      { name: '给自己物品', code: 'giveto {shortname} {amount}', example: 'giveto wood 1000' },
      { name: '给所有玩家物品', code: 'giveall {shortname} {amount}', example: 'giveall wood 1000' },
      { name: '绑定穿墙飞行键(C)', desc: '客户端绑定命令，需在客户端控制台执行', code: 'bind c noclip', example: 'bind c noclip' },
      { name: '绑定删除瞄准实体键(X)', desc: '客户端绑定命令，危险操作', code: 'bind x ent kill', example: 'bind x ent kill', dangerous: true, confirm: '该快捷键会直接删除瞄准实体，确认继续？' },
      { name: '生成鸡', code: 'entity.spawn chicken', example: 'entity.spawn chicken' },
      { name: '生成野猪', code: 'entity.spawn boar', example: 'entity.spawn boar' },
      { name: '生成石矿节点', code: 'entity.spawn stone-ore', example: 'entity.spawn stone-ore' },
      { name: '生成硫矿节点', code: 'entity.spawn sulfur-ore', example: 'entity.spawn sulfur-ore' },
      { name: '生成金属矿节点', code: 'entity.spawn Metal-ore', example: 'entity.spawn Metal-ore' },
      { name: '生成僵尸', code: 'entity.spawn zombie', example: 'entity.spawn zombie' },
      { name: '生成持刀僵尸', code: 'entity.spawn murderer', example: 'entity.spawn murderer' },
      { name: '生成和平科学家', code: 'entity.spawn scientistpeacekeeper', example: 'entity.spawn scientistpeacekeeper' },
      { name: '生成路堆科学家', code: 'entity.spawn scientistjunkpile', example: 'entity.spawn scientistjunkpile' },
      { name: '生成货机', code: 'entity.spawn cargo_plane', example: 'entity.spawn cargo_plane' },
      { name: '生成科考队 CH47', code: 'entity.spawn ch47scientists.entity', example: 'entity.spawn ch47scientists.entity' },
      { name: '生成可驾驶 CH47', code: 'entity.spawn ch47.entity', example: 'entity.spawn ch47.entity' },
      { name: '生成轿车', code: 'entity.spawn sedan', example: 'entity.spawn sedan' },
      { name: '生成热气球', code: 'spawn hotair', example: 'spawn hotair' },
      { name: '生成工作矿车', code: 'spawn workcart.entity', example: 'spawn workcart.entity' },
      { name: '生成自动炮台(科学家)', code: 'entity.spawn sentry.scientist.static', example: 'entity.spawn sentry.scientist.static' },
      { name: '生成普通桶(蓝)', code: 'entity.spawn loot-barrel-1', example: 'entity.spawn loot-barrel-1' },
      { name: '生成普通桶(红)', code: 'entity.spawn loot-barrel-2', example: 'entity.spawn loot-barrel-2' },
      { name: '生成油桶', code: 'entity.spawn oil_barrel', example: 'entity.spawn oil_barrel' },
      { name: '生成食物箱', code: 'entity.spawn foodbox', example: 'entity.spawn foodbox' },
      { name: '生成工具箱', code: 'entity.spawn crate_tools', example: 'entity.spawn crate_tools' },
      { name: '生成普通箱', code: 'entity.spawn crate_normal', example: 'entity.spawn crate_normal' },
      { name: '生成医疗箱', code: 'entity.spawn crate_normal_2_medical', example: 'entity.spawn crate_normal_2_medical' },
      { name: '生成食物箱(普通)', code: 'entity.spawn crate_normal_2_food', example: 'entity.spawn crate_normal_2_food' },
      { name: '生成黑客锁箱', code: 'entity.spawn codelockedhackablecrate', example: 'entity.spawn codelockedhackablecrate' },
      { name: '生成水泵', code: 'spawn water.pump.deployed', example: 'spawn water.pump.deployed' },
      { name: '查询地道贴图目录', code: 'world.rendertunnels', example: 'world.rendertunnels' },
      { name: '生成树-冷杉', code: 'entity.spawn douglas_fir_a', example: 'entity.spawn douglas_fir_a' },
      { name: '生成树-山毛榉', code: 'entity.spawn american_beech_a', example: 'entity.spawn american_beech_a' },
      { name: '生成树-橡树', code: 'entity.spawn oak_b', example: 'entity.spawn oak_b' },
      { name: '生成树-沼泽树', code: 'entity.spawn swamp_tree_a', example: 'entity.spawn swamp_tree_a' }
    ]
  }
];

// ===== 使用日志状态 =====
let usageLogData = [];
let usageLogFilter = 'all';

const USAGE_FILTER_BTN_ID = {
  all: 'usage-filter-all',
  rcon_command: 'usage-filter-cmd',
  player_permission: 'usage-filter-perm',
  server_config: 'usage-filter-config',
};

function renderUsageLog() {
  const tbody = document.getElementById('usage-tbody');
  if (!tbody) return;
  const activeBtnId = USAGE_FILTER_BTN_ID[usageLogFilter] || 'usage-filter-all';
  document.querySelectorAll('#panel-usagelog .filter-btn').forEach(b => {
    b.classList.toggle('active', b.id === activeBtnId);
  });
  const filtered = usageLogFilter === 'all'
    ? usageLogData
    : usageLogData.filter(l => l.action?.startsWith(usageLogFilter));
  if (!filtered.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="3"><div class="empty-state"><p>暂无日志记录</p></div></td></tr>`;
    return;
  }
  const typeMap = {
    'server_connect': ['badge-connect', '连接'],
    'server_disconnect': ['badge-other', '断开'],
    'server_error': ['badge-error', '错误'],
    'rcon_command': ['badge-command', '指令'],
    'player_permission': ['badge-perm', '权限'],
    'server_config': ['badge-config', '配置'],
    'app_launched': ['badge-connect', '启动'],
    'app_closed': ['badge-other', '关闭'],
  };
  tbody.innerHTML = filtered.slice(0, 200).map(l => {
    const [tagClass, tagLabel] = typeMap[l.action] || ['badge-other', l.action || '其他'];
    const time = l.time ? new Date(l.time).toLocaleString('zh-CN') : '-';
    const details = l.details ? (l.details.command || JSON.stringify(l.details).substring(0, 80)) : '-';
    return `<tr>
      <td style="color:var(--text-muted);font-size:11px;white-space:nowrap">${time}</td>
      <td><span class="log-type-badge log-${tagClass}">${tagLabel}</span></td>
      <td style="font-size:11px;font-family:monospace;color:var(--text-secondary)">${escHtml(details)}</td>
    </tr>`;
  }).join('');
  document.getElementById('usage-log-count').textContent = `共 ${filtered.length} 条记录（最多显示200条）`;
}

async function loadUsageLog() {
  usageLogData = await api.getUsageLog();
  renderUsageLog();
}

document.getElementById('usage-filter-all')?.addEventListener('click', () => { usageLogFilter = 'all'; renderUsageLog(); });
document.getElementById('usage-filter-cmd')?.addEventListener('click', () => { usageLogFilter = 'rcon_command'; renderUsageLog(); });
document.getElementById('usage-filter-perm')?.addEventListener('click', () => { usageLogFilter = 'player_permission'; renderUsageLog(); });
document.getElementById('usage-filter-config')?.addEventListener('click', () => { usageLogFilter = 'server_config'; renderUsageLog(); });
document.getElementById('btn-export-log')?.addEventListener('click', async () => {
  const r = await api.exportUsageLog();
  if (r.ok) toast('日志已导出到桌面', 'success');
  else toast('导出失败', 'error');
});
document.getElementById('btn-clear-log')?.addEventListener('click', async () => {
  if (!confirm('确认清空所有使用日志？')) return;
  await api.clearUsageLog();
  usageLogData = [];
  renderUsageLog();
  toast('日志已清空', 'success');
});

// 定期上报使用日志到服主（echo 到服务器控制台，不再发入游戏聊天）
async function reportUsageToOwner() {
  if (!state.connected) { toast('请先连接服务器', 'error'); return; }
  const logs = await api.getUsageLog();
  if (!logs.length) { toast('暂无日志可上报', 'info'); return; }
  const today = logs.filter(l => l.time && new Date(l.time).toDateString() === new Date().toDateString());
  if (today.length === 0) { toast('今日暂无操作记录', 'info'); return; }
  const summary = `[RustAdmin 使用日志] ${new Date().toLocaleDateString('zh-CN')}: ${today.length} 条操作已记录`;
  // 使用 echo 命令输出到服务器控制台，而不是 say（避免发入游戏聊天）
  await api.rconCommand(`echo ${summary}`);
  toast(`已发送日志摘要到服务器控制台，共 ${today.length} 条`, 'success');
}

// ===== 玩家授权（新UI） =====
let permOnlineTab = 'online';
let permSelectedPlayers = [];
let permSelectedPerms = [];
/** 已选玩家插件权限列表：防抖拉取 */
let _permSelectedPermLoadTimer = null;

function switchPermTab(tab) {
  permOnlineTab = tab;
  document.getElementById('perm-tab-online').classList.toggle('active', tab === 'online');
  document.getElementById('perm-tab-offline').classList.toggle('active', tab === 'offline');
  document.getElementById('perm-player-list-online').style.display = tab === 'online' ? '' : 'none';
  document.getElementById('perm-player-list-offline').style.display = tab === 'offline' ? '' : 'none';
}

function togglePermPlayer(steamid, name) {
  const idx = permSelectedPlayers.indexOf(steamid);
  if (idx >= 0) {
    permSelectedPlayers.splice(idx, 1);
  } else {
    permSelectedPlayers.push(steamid);
  }
  renderPermPlayerItems();
  updatePermSelectedInfo();
}

function updatePermSelectedInfo() {
  const info = document.getElementById('perm-selected-info');
  if (!info) return;
  // 显示玩家名 + SteamID，而不是只丢一串数字
  const labels = permSelectedPlayers.map((sid) => {
    const name = getPlayerNameBySteamId(sid);
    return (name && name !== '-') ? `${escHtml(name)} <em>${escHtml(sid)}</em>` : `<em>${escHtml(sid)}</em>`;
  });
  if (!permSelectedPlayers.length) {
    info.className = 'perm-selected-info none-selected';
    info.innerHTML = '<span>⚠️</span> 尚未选择任何玩家，点击上方列表即可选择（支持多选）';
  } else {
    info.className = 'perm-selected-info';
    info.innerHTML = `<span>✅</span> 已选择 <b>${permSelectedPlayers.length}</b> 名玩家：` +
      `<span class="perm-selected-names">${labels.join('、')}</span>` +
      '<button type="button" class="perm-clear-selection" id="perm-clear-selection" title="清空选择">清空选择</button>';
    document.getElementById('perm-clear-selection')?.addEventListener('click', (e) => {
      e.stopPropagation();
      permSelectedPlayers = [];
      renderPermPlayerItems();
      updatePermSelectedInfo();
    });
  }
  const chip = document.getElementById('perm-selected-count');
  if (chip) {
    chip.textContent = permSelectedPlayers.length ? `已选 ${permSelectedPlayers.length}` : '未选择';
    chip.classList.toggle('is-active', permSelectedPlayers.length > 0);
  }
  scheduleRefreshPermSelectedPlayerPerms();
}

function scheduleRefreshPermSelectedPlayerPerms() {
  clearTimeout(_permSelectedPermLoadTimer);
  _permSelectedPermLoadTimer = setTimeout(() => {
    _permSelectedPermLoadTimer = null;
    refreshPermSelectedPlayerPerms();
  }, 320);
}

function groupPermsByPlugin(perms) {
  const groups = new Map();
  (perms || []).forEach((raw) => {
    const p = String(raw || '').trim();
    if (!p) return;
    const plugin = p.includes('.') ? p.split('.')[0] : '其他';
    if (!groups.has(plugin)) groups.set(plugin, []);
    groups.get(plugin).push(p);
  });
  for (const arr of groups.values()) arr.sort((a, b) => a.localeCompare(b));
  return new Map([...groups.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function renderSelectedPlayerPluginPermList(perms) {
  const listEl = document.getElementById('perm-selected-perms-list');
  if (!listEl) return;
  if (!perms || !perms.length) {
    listEl.innerHTML = '<div class="perm-lookup-empty">未解析到该玩家的单独权限节点（可能仅有用户组权限，或控制台回显格式不同）。可展开下方「原始回显」核对。</div>';
    return;
  }
  const grouped = groupPermsByPlugin(perms);
  let html = '';
  grouped.forEach((permArr, plugin) => {
    const rows = permArr.map((p) => {
      const enc = encodeURIComponent(p);
      return `<div class="perm-lookup-item">
        <code class="perm-lookup-code">${escHtml(p)}</code>
        <button type="button" class="cfg-btn cfg-btn-xs cfg-btn-danger" data-perm-selected-revoke="${enc}">删除权限</button>
      </div>`;
    }).join('');
    html += `<div class="perm-plugin-perm-group">
      <div class="perm-plugin-perm-group-title">插件：${escHtml(plugin)}</div>
      <div class="perm-plugin-perm-rows">${rows}</div>
    </div>`;
  });
  listEl.innerHTML = html;
}

function permSelectedSetRawPanel(text) {
  const wrap = document.getElementById('perm-selected-perms-raw-wrap');
  const pre = document.getElementById('perm-selected-perms-raw');
  if (!wrap || !pre) return;
  const raw = String(text || '').trim();
  if (!raw) {
    wrap.hidden = true;
    pre.textContent = '';
    return;
  }
  wrap.hidden = false;
  pre.textContent = raw;
}

async function refreshPermSelectedPlayerPerms() {
  const statusEl = document.getElementById('perm-selected-perms-status');
  const groupsEl = document.getElementById('perm-selected-perms-groups');
  const listEl = document.getElementById('perm-selected-perms-list');
  if (!statusEl || !listEl) return;

  if (!state.connected) {
    statusEl.innerHTML = '请先连接服务器后再查看权限。';
    if (groupsEl) { groupsEl.hidden = true; groupsEl.textContent = ''; }
    listEl.innerHTML = '';
    permSelectedSetRawPanel('');
    return;
  }

  const n = permSelectedPlayers.length;
  if (n === 0) {
    statusEl.innerHTML = '请先在左侧列表中点击选择<strong>一名</strong>玩家，将自动显示其 <strong>Oxide</strong> 插件权限（按插件分组）。';
    if (groupsEl) { groupsEl.hidden = true; groupsEl.textContent = ''; }
    listEl.innerHTML = '';
    permSelectedSetRawPanel('');
    return;
  }

  if (n > 1) {
    statusEl.innerHTML = `已选 <strong>${n}</strong> 名玩家。查看与删除/增加「单个玩家」的插件权限时，请<strong>只保留勾选一名玩家</strong>；批量授予/撤销仍可使用下方权限网格与按钮。`;
    if (groupsEl) { groupsEl.hidden = true; groupsEl.textContent = ''; }
    listEl.innerHTML = '';
    permSelectedSetRawPanel('');
    return;
  }

  const sid = String(permSelectedPlayers[0] || '').trim();
  if (!/^7656119\d{10}$/.test(sid)) {
    statusEl.innerHTML = '当前选中玩家缺少有效的 SteamID，无法查询 Oxide 权限。';
    if (groupsEl) { groupsEl.hidden = true; groupsEl.textContent = ''; }
    listEl.innerHTML = '';
    permSelectedSetRawPanel('');
    return;
  }

  const pname = (() => {
    const all = [...(state.players || []), ...((state.offlinePlayers || []))];
    const hit = all.find((p) => String(p.SteamID || '') === sid);
    return hit ? (hit.DisplayName || hit.Name || '') : '';
  })();

  statusEl.innerHTML = `正在加载 ${pname ? `<strong>${escHtml(pname)}</strong> ` : ''}<span style="font-family:monospace;color:var(--text-muted)">${escHtml(sid)}</span> 的权限…`;

  const r = await api.rconCommandSilent(`oxide.show user ${sid}`);
  if (!r || r.ok === false) {
    statusEl.innerHTML = `加载失败：${escHtml(r?.error || '未知错误')}`;
    if (groupsEl) { groupsEl.hidden = true; groupsEl.textContent = ''; }
    listEl.innerHTML = '';
    permSelectedSetRawPanel('');
    return;
  }
  if (r.timeout) {
    statusEl.innerHTML = '查询超时，请点击「刷新」重试。';
    if (groupsEl) { groupsEl.hidden = true; groupsEl.textContent = ''; }
    listEl.innerHTML = '';
    permSelectedSetRawPanel('');
    toast('权限查询超时', 'error');
    return;
  }

  const msg = String(r.message || '');
  permSelectedSetRawPanel(msg);
  const parsed = parseOxideShowUserMessage(msg);
  const userMissing = /user\s+not\s+found|unknown\s+user|player\s+not\s+found|unable\s+to\s+find|could\s+not\s+find|找不到该|未找到用户|no\s+such\s+user/i.test(msg);
  if (userMissing && !parsed.steamid && !parsed.displayName && !(parsed.groups && parsed.groups.length)) {
    statusEl.innerHTML = 'Oxide 中未找到该用户；请确认该 SteamID 曾进过服或已被写入用户数据。';
    if (groupsEl) { groupsEl.hidden = true; groupsEl.textContent = ''; }
    listEl.innerHTML = '';
    toast('未找到该玩家 Oxide 资料', 'error');
    return;
  }

  const label = parsed.displayName || pname || '';
  statusEl.innerHTML = `${label ? `<strong>${escHtml(label)}</strong> · ` : ''}<span style="font-family:monospace;color:var(--text-muted)">${escHtml(sid)}</span> — 以下为 Oxide 解析到的<strong>已直接授予该用户</strong>的权限（多含插件名，按插件分组）`;
  if (groupsEl) {
    if (parsed.groups && parsed.groups.length) {
      groupsEl.hidden = false;
      groupsEl.textContent = `所属用户组：${parsed.groups.join(', ')}`;
    } else {
      groupsEl.hidden = true;
      groupsEl.textContent = '';
    }
  }
  renderSelectedPlayerPluginPermList(parsed.perms);
  if (parsed.perms.length) toast(`已加载 ${parsed.perms.length} 条权限`, 'success');
  else toast('已加载（未解析到单独权限节点）', 'info');

  await loadPermGrantCatalog(false);
  fillPermAddPluginSelect();
  renderPermAddPluginPermChipList();
}

async function permSelectedRevokeOne(perm) {
  const p = String(perm || '').trim();
  if (!p) return;
  if (!state.connected) { toast('请先连接服务器', 'error'); return; }
  if (permSelectedPlayers.length !== 1) { toast('请只选择一名玩家后再删除权限', 'error'); return; }
  const sid = String(permSelectedPlayers[0] || '').trim();
  const r = await api.playerRevoke(p, sid);
  if (r && r.ok) {
    toast(`已删除权限：${p}`, 'success');
    await refreshPermSelectedPlayerPerms();
  } else {
    toast(r?.error || r?.message || '删除失败', 'error');
  }
}

async function permSelectedGrantOne() {
  const input = document.getElementById('perm-selected-perms-add-input');
  const p = String(input && input.value || '').trim();
  if (!p) { toast('请输入要增加的权限代码', 'error'); return; }
  if (!state.connected) { toast('请先连接服务器', 'error'); return; }
  if (permSelectedPlayers.length !== 1) { toast('请只选择一名玩家后再增加权限', 'error'); return; }
  const sid = String(permSelectedPlayers[0] || '').trim();
  const r = await api.playerGrant(p, sid);
  if (r && r.ok) {
    toast(`已增加权限：${p}`, 'success');
    if (input) input.value = '';
    await refreshPermSelectedPlayerPerms();
  } else {
    toast(r?.error || r?.message || '增加失败', 'error');
  }
}

const PERM_CATALOG_TTL_MS = 5 * 60 * 1000;

async function loadPermGrantCatalog(force) {
  if (!state.connected || !api.getPlugins || !api.getPermissions) return;
  const cat = state.permGrantCatalog || { plugins: [], allPerms: [], loadedAt: 0 };
  if (!force && cat.loadedAt && (Date.now() - cat.loadedAt) < PERM_CATALOG_TTL_MS && cat.allPerms.length) return;

  const [rp, rq] = await Promise.all([api.getPlugins(), api.getPermissions()]);
  const plugins = (rp && rp.ok && rp.plugins) ? rp.plugins : [];
  const allPerms = (rq && rq.ok && rq.perms) ? rq.perms.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean) : [];
  state.permGrantCatalog = { plugins, allPerms, loadedAt: Date.now() };
}

function matchPluginPerms(pluginDisplayName, allPerms) {
  const n = String(pluginDisplayName || '').trim();
  if (!n || !allPerms || !allPerms.length) return [];
  const candidates = new Set([
    n.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(),
    n.replace(/\s+/g, '').toLowerCase(),
    n.replace(/\s+/g, '_').toLowerCase(),
    n.split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase(),
  ].filter(Boolean));

  const out = [];
  const seen = new Set();
  for (const p of allPerms) {
    const pl = String(p).toLowerCase();
    const seg0 = pl.includes('.') ? pl.split('.')[0] : pl;
    for (const c of candidates) {
      if (!c) continue;
      if (pl === c || pl.startsWith(`${c}.`) || seg0 === c) {
        if (!seen.has(pl)) {
          seen.add(pl);
          out.push(pl);
        }
        break;
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function fillPermAddPluginSelect() {
  const sel = document.getElementById('perm-add-plugin-select');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = '— 选择插件 —';
  sel.appendChild(opt0);
  const plugins = (state.permGrantCatalog && state.permGrantCatalog.plugins) ? [...state.permGrantCatalog.plugins] : [];
  plugins.sort((a, b) => String(a.Name || '').localeCompare(String(b.Name || ''), 'zh-CN'));
  plugins.forEach((pl) => {
    const nm = String(pl.Name || '').trim();
    if (!nm) return;
    const opt = document.createElement('option');
    opt.value = encodeURIComponent(nm);
    opt.textContent = pl.Version ? `${nm} (${pl.Version})` : nm;
    sel.appendChild(opt);
  });
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function renderPermAddPluginPermChipList() {
  const box = document.getElementById('perm-add-plugin-perm-chips');
  const sel = document.getElementById('perm-add-plugin-select');
  const filterEl = document.getElementById('perm-add-perm-filter');
  if (!box || !sel) return;

  const encName = sel.value || '';
  const pluginName = encName ? (() => { try { return decodeURIComponent(encName); } catch { return ''; } })() : '';
  const allPerms = (state.permGrantCatalog && state.permGrantCatalog.allPerms) ? state.permGrantCatalog.allPerms : [];
  const q = String((filterEl && filterEl.value) || '').trim().toLowerCase();

  if (!pluginName) {
    box.innerHTML = '<div class="perm-lookup-empty">请先选择插件；若无数据请点击「刷新目录」（需已连接服务器）。</div>';
    return;
  }
  if (!allPerms.length) {
    box.innerHTML = '<div class="perm-lookup-empty">暂无全服权限目录，请点击「刷新目录」；若仍为空，请确认服务器 Oxide 支持列出权限（如 oxide.show perms）。</div>';
    return;
  }

  let list = matchPluginPerms(pluginName, allPerms);
  if (q) list = list.filter((p) => p.includes(q));
  if (!list.length) {
    box.innerHTML = `<div class="perm-lookup-empty">未匹配到该插件下的权限节点（名称可能与权限前缀不一致）。可使用下方「高级」手动输入，或在筛选框缩小范围。</div>`;
    return;
  }

  box.innerHTML = list.map((p) => {
    const enc = encodeURIComponent(p);
    return `<button type="button" class="cfg-btn cfg-btn-xs cfg-btn-ghost perm-add-perm-chip" data-perm-grant-chip="${enc}" title="点击为当前选中玩家增加该权限">${escHtml(p)}</button>`;
  }).join('');
}

async function permSelectedGrantCatalogPerm(perm) {
  const p = String(perm || '').trim().toLowerCase();
  if (!p) return;
  if (!state.connected) { toast('请先连接服务器', 'error'); return; }
  if (permSelectedPlayers.length !== 1) { toast('请只选择一名玩家后再增加权限', 'error'); return; }
  const sid = String(permSelectedPlayers[0] || '').trim();
  const r = await api.playerGrant(p, sid);
  if (r && r.ok) {
    toast(`已增加权限：${p}`, 'success');
    await refreshPermSelectedPlayerPerms();
  } else {
    toast(r?.error || r?.message || '增加失败', 'error');
  }
}

function renderPermPlayerItems() {
  const listOnline = document.getElementById('perm-player-list-online');
  const listOffline = document.getElementById('perm-player-list-offline');
  const searchEl = document.getElementById('perm-player-search');
  if (!listOnline || !listOffline || !searchEl) return;
  const search = String(searchEl.value || '').toLowerCase();
  document.getElementById('perm-search-clear')?.classList.toggle('u-hidden', !searchEl.value);

  const online = Array.isArray(state.players) ? state.players : [];
  const offline = Array.isArray(state.offlinePlayers) ? state.offlinePlayers : [];
  const match = (p) => (p.DisplayName || p.Name || '').toLowerCase().includes(search) || String(p.SteamID || '').includes(search);
  const onlineFiltered = online.filter(match);
  const offlineFiltered = offline.filter(match);

  // 标签上直接显示数量
  const tOn = document.getElementById('perm-tab-online');
  const tOff = document.getElementById('perm-tab-offline');
  if (tOn) tOn.innerHTML = `在线玩家 <em class="perm-tab-count">${online.length}</em>`;
  if (tOff) tOff.innerHTML = `曾玩玩家 <em class="perm-tab-count">${offline.length}</em>`;

  const renderList = (players, listEl, isOnline) => {
    if (!players.length) {
      listEl.innerHTML = `<div class="perm-player-empty">${search ? '没有匹配的玩家' : (isOnline ? '暂无在线玩家' : '暂无曾玩玩家记录')}</div>`;
      return;
    }
    // 事件委托式标记：不把玩家名拼进内联 JS（名字带引号会导致按钮失效）
    listEl.innerHTML = players.map((p) => {
      const sid = String(p.SteamID || '');
      const selected = permSelectedPlayers.includes(sid);
      return `<div class="perm-player-item ${selected ? 'selected' : ''}" data-sid="${escAttr(sid)}">
        <div class="perm-player-avatar">👤</div>
        <div class="perm-player-info">
          <div class="perm-player-name">${escHtml(p.DisplayName || p.Name || '?')}</div>
          <div class="perm-player-steamid">${escHtml(sid || '-')}</div>
        </div>
        <div class="perm-player-badges">
          <span class="perm-player-badge ${isOnline ? 'perm-badge-online' : 'perm-badge-offline'}">${isOnline ? '在线' : '离线'}</span>
          ${selected ? '<span class="perm-player-badge perm-badge-selected">已选</span>' : ''}
        </div>
      </div>`;
    }).join('');
  };

  renderList(onlineFiltered, listOnline, true);
  renderList(offlineFiltered, listOffline, false);
}

// 玩家列表点击（事件委托，替代原来的内联 onclick）
document.getElementById('perm-player-list-online')?.addEventListener('click', (e) => {
  const item = e.target.closest('.perm-player-item[data-sid]');
  if (item) togglePermPlayer(item.dataset.sid);
});
document.getElementById('perm-player-list-offline')?.addEventListener('click', (e) => {
  const item = e.target.closest('.perm-player-item[data-sid]');
  if (item) togglePermPlayer(item.dataset.sid);
});
document.getElementById('perm-player-search')?.addEventListener('input', renderPermPlayerItems);
document.getElementById('perm-search-clear')?.addEventListener('click', () => {
  const el = document.getElementById('perm-player-search');
  if (el) { el.value = ''; el.focus(); }
  renderPermPlayerItems();
});

async function refreshPermOnline() {
  if (!state.connected) return;
  const r = await api.getPlayers();
  if (r.ok) state.players = r.players || [];
  renderPermPlayerItems();
  scheduleRefreshPermSelectedPlayerPerms();
}

async function refreshPermOffline() {
  const r = await api.getOfflinePlayers();
  state.offlinePlayers = (r && r.players) ? r.players : [];
  renderPermPlayerItems();
  scheduleRefreshPermSelectedPlayerPerms();
}

function renderPermGrid() {
  const grid = document.getElementById('perm-perm-grid');
  if (!grid) return;
  let html = '<div class="perm-grid-wrap">';
  PERM_OPTIONS.forEach(group => {
    html += `<div class="perm-grid-card">
      <div class="perm-grid-card-title">${escHtml(group.name)}</div>`;
    group.perms.forEach(perm => {
      const selected = permSelectedPerms.includes(perm.value);
      html += `<div class="perm-perm-item ${selected ? 'selected' : ''}" data-perm="${escAttr(perm.value)}">
        <span class="perm-perm-name">${escHtml(perm.label)}</span>
        <div class="perm-perm-check">${selected ? '✓' : ''}</div>
      </div>`;
    });
    html += '</div>';
  });
  html += '</div>';
  grid.innerHTML = html;
  const cnt = document.getElementById('perm-perm-count');
  if (cnt) cnt.textContent = permSelectedPerms.length;
}

// 权限网格点击（事件委托）
document.getElementById('perm-perm-grid')?.addEventListener('click', (e) => {
  const item = e.target.closest('.perm-perm-item[data-perm]');
  if (item) togglePerm(item.dataset.perm);
});

function togglePerm(permValue) {
  const idx = permSelectedPerms.indexOf(permValue);
  if (idx >= 0) permSelectedPerms.splice(idx, 1);
  else permSelectedPerms.push(permValue);
  renderPermGrid();
}

async function permGrantSelected() {
  if (!state.connected) { toast('请先连接服务器', 'error'); return; }
  if (!permSelectedPlayers.length) { toast('请先选择玩家', 'error'); return; }
  if (!permSelectedPerms.length) { toast('请先选择要授予的权限', 'error'); return; }
  for (const sid of permSelectedPlayers) {
    for (const p of permSelectedPerms) {
      await api.rconCommand(`oxide.grant user ${sid} ${p}`);
    }
  }
  showPermResult(`已授予 ${permSelectedPlayers.length} 名玩家 ${permSelectedPerms.length} 项权限`, true);
}

async function permRevokeSelected() {
  if (!state.connected) { toast('请先连接服务器', 'error'); return; }
  if (!permSelectedPlayers.length) { toast('请先选择玩家', 'error'); return; }
  if (!permSelectedPerms.length) { toast('请先选择要撤销的权限', 'error'); return; }
  for (const sid of permSelectedPlayers) {
    for (const p of permSelectedPerms) {
      await api.rconCommand(`oxide.revoke user ${sid} ${p}`);
    }
  }
  showPermResult(`已撤销 ${permSelectedPlayers.length} 名玩家的 ${permSelectedPerms.length} 项权限`, true);
}

async function permAddAdmin() {
  if (!state.connected) { toast('请先连接服务器', 'error'); return; }
  if (!permSelectedPlayers.length) { toast('请先选择玩家', 'error'); return; }
  for (const sid of permSelectedPlayers) {
    await api.rconCommand(`oxide.usergroup add ${sid} admin`);
  }
  showPermResult(`已将 ${permSelectedPlayers.length} 名玩家设为管理员`, true);
}

async function permRemoveAdmin() {
  if (!state.connected) { toast('请先连接服务器', 'error'); return; }
  if (!permSelectedPlayers.length) { toast('请先选择玩家', 'error'); return; }
  for (const sid of permSelectedPlayers) {
    await api.rconCommand(`oxide.usergroup remove ${sid} admin`);
  }
  showPermResult(`已移除 ${permSelectedPlayers.length} 名玩家的管理员权限`, true);
}

async function permCustomGrant() {
  if (!state.connected) { toast('请先连接服务器', 'error'); return; }
  if (!permSelectedPlayers.length) { toast('请先选择玩家', 'error'); return; }
  const code = document.getElementById('perm-custom-code').value.trim();
  if (!code) { toast('请输入权限代码', 'error'); return; }
  for (const sid of permSelectedPlayers) {
    await api.rconCommand(`oxide.grant user ${sid} ${code}`);
  }
  showPermResult(`已授予自定义权限 ${code} 给 ${permSelectedPlayers.length} 名玩家`, true);
}

async function permGiveCoins() {
  if (!state.connected) { toast('请先连接服务器', 'error'); return; }
  if (!permSelectedPlayers.length) { toast('请先选择玩家', 'error'); return; }
  const amount = document.getElementById('perm-coins').value.trim();
  if (!amount) { toast('请输入金币数量', 'error'); return; }
  for (const sid of permSelectedPlayers) {
    await api.rconCommand(`economics.deposit ${sid} ${amount}`);
  }
  showPermResult(`已向 ${permSelectedPlayers.length} 名玩家发放 ${amount} 金币`, true);
}

async function permGivePoints() {
  if (!state.connected) { toast('请先连接服务器', 'error'); return; }
  if (!permSelectedPlayers.length) { toast('请先选择玩家', 'error'); return; }
  const amount = document.getElementById('perm-points').value.trim();
  if (!amount) { toast('请输入积分数量', 'error'); return; }
  for (const sid of permSelectedPlayers) {
    await api.rconCommand(`sr add ${sid} ${amount}`);
  }
  showPermResult(`已向 ${permSelectedPlayers.length} 名玩家发放 ${amount} 积分`, true);
}

function isProbableOxidePermToken(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t || t.length > 160) return false;
  if (/^(true|false|none|null|oxide|user|player|group|default|calling|listing|error|invalid|unknown|syntax|please|there)$/i.test(t)) return false;
  if (t.includes('.')) return /^[a-z0-9_.*-]+$/.test(t);
  return /^[a-z0-9_-]{3,40}$/.test(t);
}

/** 从 oxide.show user 全文中尽量提取所有用户级权限节点（多行、逗号分隔、项目符号等） */
function extractAllUserPermsFromShowUserOutput(raw) {
  const body = String(raw || '');
  const lower = body.toLowerCase();
  const permSet = new Set();

  let sliceStart = lower.indexOf('has permissions');
  if (sliceStart < 0) {
    const mH = lower.match(/\b(permissions?(?:\s*\([^)]+\))?|user\s+permissions)\s*[:.\-–—]/i);
    sliceStart = mH ? mH.index : 0;
  }
  const slice = sliceStart >= 0 ? body.slice(sliceStart) : body;

  const lines = slice.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^user\s+'/i.test(t) && i > 1) break;
    if (/^belongs to\s+group/i.test(t)) break;
    if (/^groups?\s*:/i.test(t)) break;

    const segments = t.split(/[,，;|]/);
    segments.forEach((seg) => {
      const bullet = seg.trim().replace(/^[\-\*\u2022\u00b7\u25cf\s]+/, '').replace(/^\d+[\.)]\s*/, '').trim();
      const firstTok = bullet.split(/\s+/)[0].replace(/^["'`<]|["'`>]$/g, '');
      if (firstTok && isProbableOxidePermToken(firstTok)) permSet.add(firstTok.toLowerCase());
    });
  }

  const re = /\b([a-z][a-z0-9_]{0,48}(?:\.[a-z0-9_.-]+)+)\b/gi;
  let m;
  while ((m = re.exec(slice)) !== null) {
    const p = m[1].toLowerCase();
    if (isProbableOxidePermToken(p)) permSet.add(p);
  }

  return [...permSet].sort((a, b) => a.localeCompare(b));
}

function parseOxideShowUserMessage(raw) {
  const text = String(raw || '');
  const groups = [];
  const mSid = text.match(/7656119\d{10}/);
  const steamid = mSid ? mSid[0] : '';

  const gLine = text.match(/belongs to group(?:\(s\))?\s*:\s*([^\n\r]+)/i);
  if (gLine) {
    gLine[1].split(/[,;，]/).forEach((part) => {
      const g = part.trim().replace(/^['"]|['"]$/g, '');
      if (g && /^[a-zA-Z0-9_.-]+$/.test(g)) groups.push(g);
    });
  }

  const perms = extractAllUserPermsFromShowUserOutput(text);
  const displayMatch = text.match(/User\s+'([^']+)'\s+\(/i) || text.match(/User\s+"([^"]+)"\s+\(/i);
  const displayName = displayMatch ? displayMatch[1] : '';

  const uniq = (a) => [...new Set(a.map((x) => String(x).trim()).filter(Boolean))];
  return { steamid, displayName, perms: uniq(perms), groups: uniq(groups), raw: text };
}

// ===== 管理员指令面板（新版 adm-cmd-* 布局） =====
const ADM_CMD_PARAM_LABELS = {
  steamid: 'Steam ID',
  shortname: '物品 shortname',
  amount: '数量',
  message: '广播内容',
  reason: '原因',
  item: '物品 shortname',
  minutes: '时长（分钟）',
  name: '玩家名称',
  hour: '时间（0–24 点）',
  x: '坐标 X',
  y: '坐标 Y',
  z: '坐标 Z',
  v: '数值（如 0–1）',
  n: '数值',
  bool: 'true / false',
  plugin: '插件名（不要带 .cs）'
};

function admCmdParamLabel(key) {
  return ADM_CMD_PARAM_LABELS[key] || key;
}

function admCmdRowIcon(cmd, catIcon) {
  if (cmd && cmd.icon) return cmd.icon;
  const n = (cmd && cmd.name) ? cmd.name : '';
  if (/保存|save/i.test(n)) return '💾';
  if (/列表|list|banlist|playerlist/i.test(n)) return '📋';
  if (/广播|^say|全服/i.test(n)) return '📣';
  if (/oxide|插件|reload|unload|^加载|^卸载/i.test(n)) return '🔌';
  if (/踢|封|解|禁言|mute|旁观|spectate/i.test(n)) return '👤';
  if (/传|坐标|teleport|领地/i.test(n)) return '📍';
  if (/时间|雨|雾|天气|队伍|env\.|maxteam/i.test(n)) return '🌤';
  if (/主机名|hostname|npc|quit|进程|关服/i.test(n)) return '⚙️';
  if (/金币|economics|积分|\bsr\b|给予物品|扣除/i.test(n)) return '🎁';
  if (/版本|oxide\.version/i.test(n)) return '📌';
  return catIcon || '▸';
}

function buildAdminCommandFromRow(btn, template) {
  const card = btn.closest('.adm-cmd-item') || btn.closest('.cmd-card');
  if (!card) return { error: '内部错误' };
  let finalCode = template;
  const quickEl = document.getElementById('cmd-quick-steamid');
  const quickSid = quickEl && quickEl.value.trim() ? quickEl.value.trim() : '';
  const inputs = card.querySelectorAll('.adm-cmd-param-input, .cmd-param-input');
  const wrapTextParam = (key, value, tpl) => {
    const k = String(key || '').toLowerCase();
    const raw = String(value || '').trim();
    if (!raw) return raw;
    if (!['message', 'reason', 'name'].includes(k)) return raw;
    // 若模板本身已写成 "{name}" 这种形式，避免二次加引号
    if (String(tpl || '').includes(`"{${key}}"`)) return raw;
    if (/^".*"$/.test(raw)) return raw;
    return `"${raw.replace(/"/g, '\\"')}"`;
  };
  for (const input of inputs) {
    const key = input.dataset.param;
    let val = input.value.trim();
    if (!val && key === 'steamid' && quickSid) val = quickSid;
    if (!val) {
      return { error: `请填写「${input.getAttribute('aria-label') || key}」` };
    }
    val = wrapTextParam(key, val, template);
    const re = new RegExp(`\\{${key}\\}`, 'g');
    finalCode = finalCode.replace(re, val);
  }
  if (/\{[^}]+\}/.test(finalCode)) {
    return { error: '仍有未替换的参数占位符，请检查模板' };
  }
  return { code: finalCode };
}

function filterAdminCmdCards() {
  const q = (document.getElementById('cmd-global-search')?.value || '').toLowerCase().trim();
  const category = (document.getElementById('cmd-category-filter')?.value || 'all').toLowerCase();
  document.querySelectorAll('#cmd-layout .adm-cmd-group').forEach((sec) => {
    const secCat = String(sec.getAttribute('data-category') || '').toLowerCase();
    if (category !== 'all' && secCat !== category) {
      sec.style.display = 'none';
      return;
    }
    let visible = 0;
    sec.querySelectorAll('.adm-cmd-item').forEach((card) => {
      const hay = (card.getAttribute('data-search') || '').toLowerCase();
      const show = !q || hay.includes(q);
      card.classList.toggle('adm-cmd-item-hidden', !show);
      if (show) visible++;
    });
    sec.style.display = visible ? '' : 'none';
  });
}

function getAdminCategoryKey(name) {
  return String(name || '').trim().toLowerCase();
}

function setupAdminCategoryFilter() {
  const el = document.getElementById('cmd-category-filter');
  if (!el) return;
  const old = el.value || 'all';
  const options = ['<option value="all">全部分类</option>'];
  let total = 0;
  for (const cat of ADMIN_COMMANDS) {
    const label = String(cat.category || '').trim();
    if (!label) continue;
    const key = getAdminCategoryKey(label);
    const n = (cat.commands || []).length;
    total += n;
    options.push(`<option value="${escAttr(key)}">${escHtml(label)} (${n})</option>`);
  }
  // 全部分类后面也带上总数
  options[0] = `<option value="all">全部分类 (${total})</option>`;
  el.innerHTML = options.join('');
  el.value = options.some((x) => x.includes(`value="${old}"`)) ? old : 'all';
}

function applyAdminCompactMode() {
  const compact = !!document.getElementById('cmd-compact-toggle')?.checked;
  const root = document.querySelector('#cmd-layout .adm-cmd-layout');
  if (!root) return;
  root.classList.toggle('adm-cmd-layout-compact', compact);
}

function renderAdminCommands() {
  const layout = document.getElementById('cmd-layout');
  if (!layout) return;
  let html = '<div class="adm-cmd-layout adm-cmd-text-layout">';
  ADMIN_COMMANDS.forEach((cat) => {
    const catKey = getAdminCategoryKey(cat.category);
    html += `<section class="adm-cmd-group" data-category="${escAttr(catKey)}">
      <h2 class="adm-cmd-group-title" data-group-toggle="1" title="点击折叠 / 展开该分类">
        <span class="adm-cmd-group-ico" aria-hidden="true">${cat.icon}</span>
        <span>${escHtml(cat.category)}</span>
        <span class="adm-cmd-group-count">${cat.commands.length} 条</span>
        <span class="adm-cmd-group-chevron" aria-hidden="true">⌄</span>
      </h2>
      <div class="adm-cmd-list">`;
    cat.commands.forEach((cmd) => {
      const seen = new Set();
      const paramList = [];
      const matches = cmd.code.match(/\{([^}]+)\}/g) || [];
      matches.forEach((m) => {
        const name = m.replace(/[{}]/g, '');
        if (!seen.has(name)) {
          seen.add(name);
          paramList.push(name);
        }
      });
      const searchBlob = `${cmd.name} ${cmd.desc || ''} ${cmd.code} ${cmd.example || ''}`.toLowerCase();
      const rowIcon = admCmdRowIcon(cmd, cat.icon);
      let paramsHtml = '';
      if (paramList.length) {
        paramsHtml = `<div class="adm-cmd-fields cmd-text-params">${paramList.map((p) => {
          const ph = p === 'steamid' ? '765611989…' : (p === 'bool' ? 'true' : admCmdParamLabel(p));
          const lab = admCmdParamLabel(p);
          return `<label class="adm-cmd-field">
            <span class="adm-cmd-field-caption"><span class="adm-cmd-field-title">${escHtml(lab)}</span><span class="adm-cmd-field-key">{${escHtml(p)}}</span></span>
            <input type="text" class="adm-cmd-param-input cfg-input" data-param="${escAttr(p)}"
              placeholder="${escAttr(ph)}" aria-label="${escAttr(lab + ' ' + p)}" autocomplete="off" spellcheck="false" onclick="event.stopPropagation()">
          </label>`;
        }).join('')}</div>`;
      } else {
        paramsHtml = '<div class="adm-cmd-no-params">无需参数，可直接发送</div>';
      }
      const dangerous = cmd.dangerous ? '1' : '';
      const confirmMsg = (cmd.confirm || '确认执行此指令？').replace(/"/g, '&quot;');
      const codeJs = JSON.stringify(cmd.code);
      const ex = cmd.example != null ? cmd.example : '';
      const exJs = JSON.stringify(ex || cmd.code);
      const tplAttr = escAttr(cmd.code);
      html += `<article class="adm-cmd-item" data-search="${escAttr(searchBlob)}">
        <div class="adm-cmd-head">
          <div class="adm-cmd-ico cmd-text-ico" aria-hidden="true">${rowIcon}</div>
          <div class="adm-cmd-text">
            <h3 class="adm-cmd-title cmd-text-title">${escHtml(cmd.name)}</h3>
            ${cmd.desc ? `<p class="adm-cmd-desc cmd-text-desc">${escHtml(cmd.desc)}</p>` : ''}
          </div>
          <div class="adm-cmd-actions cmd-text-actions">
            <button type="button" class="adm-cmd-btn adm-cmd-btn-primary cmd-send-btn" data-need-confirm="${dangerous}" data-confirm="${confirmMsg}"
              data-template="${tplAttr}">发送指令</button>
            <button type="button" class="adm-cmd-btn adm-cmd-btn-ghost"
              data-template="${tplAttr}" data-action="copy">复制指令</button>
          </div>
        </div>
        ${paramsHtml}
        <div class="adm-cmd-meta cmd-text-meta">
          <div class="adm-cmd-meta-block cmd-text-meta-block">
            <span class="adm-cmd-meta-label">命令</span>
            <code class="adm-cmd-code">${escHtml(cmd.code)}</code>
          </div>
          <div class="adm-cmd-meta-block cmd-text-meta-block">
            <span class="adm-cmd-meta-label">示例</span>
            <code class="adm-cmd-code adm-cmd-code-muted">${escHtml(ex)}</code>
          </div>
        </div>
      </article>`;
    });
    html += '</div></section>';
  });
  html += '</div>';
  layout.innerHTML = html;
  setupAdminCategoryFilter();
  applyAdminCompactMode();
  filterAdminCmdCards();
}

document.getElementById('cmd-global-search')?.addEventListener('input', filterAdminCmdCards);
document.getElementById('cmd-category-filter')?.addEventListener('change', filterAdminCmdCards);
document.getElementById('cmd-compact-toggle')?.addEventListener('change', applyAdminCompactMode);
document.getElementById('btn-cmd-refresh')?.addEventListener('click', () => {
  renderAdminCommands();
  toast('指令列表已刷新', 'info');
});

async function writeClipboardCompat(text) {
  const v = String(text || '');
  if (!v) return false;
  try {
    await navigator.clipboard.writeText(v);
    return true;
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = v;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch {}
  return false;
}

async function copyAdminCmdSmart(btn, template) {
  const built = buildAdminCommandFromRow(btn, template);
  const txt = built && built.code ? built.code : String(template || '');
  const ok = await writeClipboardCompat(txt);
  if (ok) toast('已复制指令', 'success');
  else toast('复制失败：系统剪贴板不可用', 'error');
}

// 管理员指令：事件委托（避免 inline onclick 在部分环境失效）
document.getElementById('cmd-layout')?.addEventListener('click', (e) => {
  // 分类标题：点击折叠 / 展开
  const title = e.target.closest('.adm-cmd-group-title[data-group-toggle]');
  if (title) {
    const sec = title.closest('.adm-cmd-group');
    if (sec) {
      sec.classList.toggle('is-collapsed');
      applyAdminCompactMode();
    }
    return;
  }
  const btn = e.target.closest('button');
  if (!btn) return;
  const tpl = btn.getAttribute('data-template');
  if (!tpl) return;
  if (btn.classList.contains('cmd-send-btn')) {
    sendAdminCmdWithParams(btn, tpl);
    return;
  }
  if (btn.getAttribute('data-action') === 'copy') {
    copyAdminCmdSmart(btn, tpl);
  }
});

// 参数输入框里按 Enter 直接发送该卡片指令（省得再去点按钮）
document.getElementById('cmd-layout')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest('.adm-cmd-param-input');
  if (!input) return;
  e.preventDefault();
  const card = input.closest('.adm-cmd-item');
  const sendBtn = card && card.querySelector('.cmd-send-btn');
  if (sendBtn) sendAdminCmdWithParams(sendBtn, sendBtn.getAttribute('data-template') || '');
});

// 默认 SteamID 输入框里按 Enter：直接聚焦到第一个卡片
document.getElementById('cmd-quick-steamid')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = document.querySelector('#cmd-layout .adm-cmd-param-input');
  if (first) first.focus();
});

// 兜底：仍允许外部/控制台调用
window.sendAdminCmdWithParams = sendAdminCmdWithParams;
window.copyAdminCmdSmart = copyAdminCmdSmart;

function appendAdminCmdOutput(cmd, r) {
  const ta = document.getElementById('admincmd-output');
  if (!ta) return;
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const status = !r ? '失败' : (r.ok ? (r.timeout ? '超时' : '成功') : '失败');
  const body = (!r || !r.ok)
    ? String(r?.error || '未知错误')
    : (r.timeout ? '命令超时（服务器未及时回包）' : String(r.message || '(无回包，命令可能已执行)'));
  ta.value = `${ta.value}${ta.value ? '\n\n' : ''}[${ts}] ${status}\n> ${cmd}\n${body}`.trim();
  ta.scrollTop = ta.scrollHeight;
}

async function sendAdminCmdWithParams(btn, template) {
  if (!state.connected) { toast('请先连接服务器', 'error'); return; }
  if (btn.dataset.needConfirm === '1') {
    const msg = btn.getAttribute('data-confirm') || '确认执行？';
    if (!confirm(msg)) return;
  }
  const built = buildAdminCommandFromRow(btn, template);
  if (built.error) { toast(built.error, 'error'); return; }
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '发送中...';
  try {
    const r = await api.rconCommand(built.code);
    appendAdminCmdOutput(built.code, r);
    if (r && r.ok && !r.timeout) toast(`已发送: ${built.code.length > 56 ? built.code.slice(0, 56) + '…' : built.code}`, 'success');
    else if (r && r.timeout) toast('命令已发送但服务器回包超时', 'info');
    else toast('发送失败: ' + ((r && r.error) || '未知错误'), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = oldText || '发送指令';
  }
}

document.getElementById('btn-copy-admincmd-output')?.addEventListener('click', async () => {
  const ta = document.getElementById('admincmd-output');
  const v = ta?.value || '';
  if (!v.trim()) { toast('没有可复制的内容', 'error'); return; }
  await navigator.clipboard.writeText(v);
  toast('已复制执行结果', 'success');
});
document.getElementById('btn-clear-admincmd-output')?.addEventListener('click', () => {
  const ta = document.getElementById('admincmd-output');
  if (ta) ta.value = '';
});

// 支持直接点击代码块复制（除手动框选复制外）
document.getElementById('cmd-layout')?.addEventListener('click', async (e) => {
  const codeEl = e.target.closest('.adm-cmd-code');
  if (!codeEl) return;
  const txt = (codeEl.textContent || '').trim();
  if (!txt) return;
  try {
    await navigator.clipboard.writeText(txt);
    toast('代码已复制', 'success');
  } catch {}
});

// 玩家授权搜索
document.getElementById('perm-player-search')?.addEventListener('input', renderPermPlayerItems);

document.getElementById('perm-selected-perms-refresh')?.addEventListener('click', () => { refreshPermSelectedPlayerPerms(); });
document.getElementById('perm-selected-perms-add-btn')?.addEventListener('click', () => { permSelectedGrantOne(); });
document.getElementById('perm-selected-perms-add-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); permSelectedGrantOne(); }
});
document.getElementById('perm-selected-perms-list')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-perm-selected-revoke]');
  if (!btn) return;
  const enc = btn.getAttribute('data-perm-selected-revoke') || '';
  let perm = '';
  try { perm = decodeURIComponent(enc); } catch { perm = ''; }
  if (!perm) return;
  permSelectedRevokeOne(perm);
});

document.getElementById('perm-add-plugin-select')?.addEventListener('change', () => { renderPermAddPluginPermChipList(); });
let _permChipFilterTimer = null;
document.getElementById('perm-add-perm-filter')?.addEventListener('input', () => {
  clearTimeout(_permChipFilterTimer);
  _permChipFilterTimer = setTimeout(() => { renderPermAddPluginPermChipList(); }, 200);
});
document.getElementById('perm-add-catalog-refresh')?.addEventListener('click', async () => {
  if (!state.connected) { toast('请先连接服务器', 'error'); return; }
  await loadPermGrantCatalog(true);
  fillPermAddPluginSelect();
  renderPermAddPluginPermChipList();
  toast('插件与权限目录已刷新', 'success');
});
document.getElementById('perm-add-plugin-perm-chips')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-perm-grant-chip]');
  if (!btn) return;
  const enc = btn.getAttribute('data-perm-grant-chip') || '';
  let perm = '';
  try { perm = decodeURIComponent(enc); } catch { perm = ''; }
  if (!perm) return;
  permSelectedGrantCatalogPerm(perm);
});

// ===== 物品发放系统 =====
// 全量物品见 renderer/rust_items.json（与 RustLabs 分类对应），进入本页时加载
let rustItemCatalog = [];
let rustItemCatalogPromise = null;
const ITEMSHOP_PRESET_KEY = 'rustadmin-item-presets';
// 兜底补充：若 rust_items.json 缺失这些常用项，会自动并入
const ITEMSHOP_SUPPLEMENT_ITEMS = [
  { name: 'Assault Rifle', shortname: 'rifle.ak', cat: 'weapon', image: 'https://rustlabs.com/img/items180/rifle.ak.png' },
  { name: 'LR-300 Assault Rifle', shortname: 'rifle.lr300', cat: 'weapon', image: 'https://rustlabs.com/img/items180/rifle.lr300.png' },
  { name: 'M39 Rifle', shortname: 'rifle.m39', cat: 'weapon', image: 'https://rustlabs.com/img/items180/rifle.m39.png' },
  { name: 'L96 Rifle', shortname: 'rifle.l96', cat: 'weapon', image: 'https://rustlabs.com/img/items180/rifle.l96.png' },
  { name: 'M249', shortname: 'lmg.m249', cat: 'weapon', image: 'https://rustlabs.com/img/items180/lmg.m249.png' },
  { name: 'HMLMG', shortname: 'hmlmg', cat: 'weapon', image: 'https://rustlabs.com/img/items180/hmlmg.png' },
  { name: 'MP5A4', shortname: 'smg.mp5', cat: 'weapon', image: 'https://rustlabs.com/img/items180/smg.mp5.png' },
  { name: 'Pistol Bullet', shortname: 'ammo.pistol', cat: 'ammo', image: 'https://rustlabs.com/img/items180/ammo.pistol.png' },
  { name: '5.56 Rifle Ammo', shortname: 'ammo.rifle', cat: 'ammo', image: 'https://rustlabs.com/img/items180/ammo.rifle.png' },
  { name: 'Explosive 5.56 Rifle Ammo', shortname: 'ammo.rifle.explosive', cat: 'ammo', image: 'https://rustlabs.com/img/items180/ammo.rifle.explosive.png' },
  { name: 'High Velocity 5.56 Rifle Ammo', shortname: 'ammo.rifle.hv', cat: 'ammo', image: 'https://rustlabs.com/img/items180/ammo.rifle.hv.png' },
  { name: 'Rocket', shortname: 'ammo.rocket.basic', cat: 'ammo', image: 'https://rustlabs.com/img/items180/ammo.rocket.basic.png' }
];

function readItemPresets() {
  try {
    const raw = localStorage.getItem(ITEMSHOP_PRESET_KEY);
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeItemPresets(presets) {
  try {
    localStorage.setItem(ITEMSHOP_PRESET_KEY, JSON.stringify(Array.isArray(presets) ? presets : []));
    return true;
  } catch {
    return false;
  }
}

function mapLabsCategoryToShopCat(labs) {
  const L = String(labs || '').toLowerCase();
  if (L === 'weapon') return 'weapon';
  if (L === 'ammunition') return 'ammo';
  if (L === 'attire') return 'armor';
  if (L === 'medical') return 'medical';
  if (L === 'component' || L === 'resources') return 'resource';
  return 'tool';
}

/** 仅允许 RustLabs CDN，避免任意 URL 注入 */
function safeRustItemImageUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const u = url.trim();
  if (!/^https:\/\//i.test(u)) return '';
  try {
    const host = new URL(u).hostname.toLowerCase();
    if (host === 'rustlabs.com' || host.endsWith('.rustlabs.com')) return u;
  } catch {}
  return '';
}

function itemShopIconCellHtml(item) {
  const url = safeRustItemImageUrl(item.image || '');
  const emoji = getItemEmoji(item.cat);
  if (!url) {
    return `<div class="itemshop-item-icon">${emoji}</div>`;
  }
  /* 仅保留一种主视觉：图片 onload 后隐藏 emoji，避免透明 PNG 与旧 emoji 叠在一起 */
  return `<div class="itemshop-item-icon-wrap">
    <span class="itemshop-item-icon-fallback">${emoji}</span>
    <img class="itemshop-item-img" src="${escHtml(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"
      onload="var p=this.previousElementSibling;if(p)p.style.display='none';"
      onerror="this.style.display='none';">
  </div>`;
}

function getItemShopCatalogMeta(shortname) {
  return rustItemCatalog.find(i => i.shortname === shortname);
}

function getItemShopCatalog() {
  return rustItemCatalog;
}

async function ensureRustItemCatalog() {
  if (rustItemCatalog.length) return rustItemCatalog;
  if (!rustItemCatalogPromise) {
    rustItemCatalogPromise = fetch('rust_items.json')
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(data => {
        const seen = new Set();
        const out = [];
        for (const row of data) {
          const sn = String(row.shortName || row.shortname || '').trim();
          if (!sn || seen.has(sn)) continue;
          seen.add(sn);
          out.push({
            id: row.id != null ? String(row.id) : '',
            name: row.displayName || row.name || sn,
            shortname: sn,
            cat: mapLabsCategoryToShopCat(row.category),
            image: safeRustItemImageUrl(row.image)
          });
        }
        for (const s of ITEMSHOP_SUPPLEMENT_ITEMS) {
          const sn = String(s.shortname || '').trim();
          if (!sn || seen.has(sn)) continue;
          seen.add(sn);
          out.push({
            id: s.id != null ? String(s.id) : '',
            name: s.name || sn,
            shortname: sn,
            cat: s.cat || 'tool',
            image: safeRustItemImageUrl(s.image || '')
          });
        }
        out.sort((a, b) => a.name.localeCompare(b.name, 'en'));
        rustItemCatalog = out;
        return out;
      })
      .catch(e => {
        console.error('rust_items.json', e);
        toast('物品目录加载失败，请检查 rust_items.json 或使用下方手动输入', 'error');
        rustItemCatalog = [];
        return [];
      });
  }
  return rustItemCatalogPromise;
}

function syncItemShopAfterPlayersRefresh() {
  const panel = document.getElementById('panel-itemshop');
  if (!panel || !panel.classList.contains('active')) return;
  const onlineIds = new Set(state.players.map(p => p.SteamID));
  if (itemShopState.targetMode === 'online') {
    itemShopState.selectedPlayers = itemShopState.selectedPlayers.filter(id => onlineIds.has(id));
    renderItemShopPlayerList();
  } else {
    const playerList = document.getElementById('itemshop-player-list');
    const targetInfo = document.getElementById('itemshop-target-info');
    if (playerList) {
      playerList.innerHTML = '<div class="itemshop-all-hint">将发放给全体在线玩家（人数随列表刷新更新）</div>';
    }
    if (targetInfo) {
      targetInfo.innerHTML = '目标：<b>全体在线玩家</b>（<b id="item-target-count">' + state.players.length + '</b> 名）';
    }
  }
  updateItemShopSummary();
}

function setupItemShopGridDelegation() {
  const grid = document.getElementById('itemshop-items-grid');
  if (!grid || grid._itemShopDelegated) return;
  grid._itemShopDelegated = true;
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.itemshop-item');
    if (!card) return;
    const sn = card.dataset.shortname;
    const nm = card.dataset.name;
    if (!sn) return;
    toggleItemSelection(sn, nm || sn);
  });
}

function addCustomShortnameToSelection() {
  const input = document.getElementById('item-custom-shortname');
  const v = (input && input.value) ? input.value.trim() : '';
  if (!v) {
    toast('请输入 shortname', 'error');
    return;
  }
  if (itemShopState.selectedItems.some(i => i.shortname === v)) {
    toast('已在已选列表中', 'info');
    return;
  }
  const meta = rustItemCatalog.find(i => i.shortname === v);
  itemShopState.selectedItems.push({
    shortname: v,
    name: meta ? meta.name : v,
    quantity: 1,
    image: meta && meta.image ? meta.image : ''
  });
  if (input) input.value = '';
  renderItemShopGrid();
  renderItemShopSelectedList();
  updateItemShopSummary();
}

// 物品发放状态
let itemShopState = {
  selectedItems: [], // [{shortname, name, quantity}]
  selectedPlayers: [], // [steamid]
  targetMode: 'online', // 'online' | 'all'
  currentCategory: 'all',
  itemSearch: '',
  presets: []
};

// 切换物品分类
function switchItemCat(cat) {
  itemShopState.currentCategory = cat;
  document.querySelectorAll('.itemshop-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cat === cat);
  });
  renderItemShopGrid();
}

// 切换目标模式
function switchItemTarget(mode) {
  itemShopState.targetMode = mode;
  const playerList = document.getElementById('itemshop-player-list');
  const targetInfo = document.getElementById('itemshop-target-info');
  const sidEl = document.getElementById('item-target-steamid');
  
  if (mode === 'all') {
    // 若填写了 SteamID，则强制走单人发放，避免误用全服逻辑
    const sid = String(sidEl?.value || '').trim();
    if (/^\d{10,20}$/.test(sid)) {
      itemShopState.targetMode = 'online';
      const radioOnline = document.querySelector('input[name="item-target"][value="online"]');
      if (radioOnline) radioOnline.checked = true;
      toast('已填写 SteamID：将按单人发放（不走全服）', 'info');
      renderItemShopPlayerList();
      updateItemShopSummary();
      return;
    }
    itemShopState.selectedPlayers = [];
    if (playerList) playerList.innerHTML = '<div class="itemshop-all-hint">将发放给全体在线玩家（人数随列表刷新更新）</div>';
    if (targetInfo) targetInfo.innerHTML = '目标：<b>全体在线玩家</b>（<b id="item-target-count">' + state.players.length + '</b> 名）';
  } else {
    itemShopState.selectedPlayers = [];
    renderItemShopPlayerList();
  }
  updateItemShopSummary();
}

// 渲染物品选择网格
function renderItemShopGrid() {
  const grid = document.getElementById('itemshop-items-grid');
  if (!grid) return;
  setupItemShopGridDelegation();
  const search = (document.getElementById('item-search')?.value || '').toLowerCase();
  itemShopState.itemSearch = search;
  const catalog = getItemShopCatalog();
  if (!catalog.length) {
    grid.innerHTML = '<div class="itemshop-empty-hint">正在加载物品目录…</div>';
    updateItemSelectedCount();
    return;
  }

  let filtered = catalog;
  if (itemShopState.currentCategory !== 'all') {
    filtered = filtered.filter(i => i.cat === itemShopState.currentCategory);
  }
  if (search) {
    filtered = filtered.filter(i => {
      const nm = String(i.name != null ? i.name : '').toLowerCase();
      const sn = String(i.shortname != null ? i.shortname : '').toLowerCase();
      return nm.includes(search) || sn.includes(search);
    });
  }

  const hint = (!search && itemShopState.currentCategory === 'all' && filtered.length > 400)
    ? '<div class="itemshop-catalog-hint">共 ' + filtered.length + ' 条，建议用分类或搜索缩小范围</div>'
    : '';

  grid.innerHTML = hint + filtered.map(item => {
    const selected = itemShopState.selectedItems.find(i => i.shortname === item.shortname);
    return `<div class="itemshop-item ${selected ? 'selected' : ''}" data-shortname="${escHtml(item.shortname)}" data-name="${escHtml(item.name)}">
      ${itemShopIconCellHtml(item)}
      <div class="itemshop-item-name">${escHtml(item.name)}</div>
      <div class="itemshop-item-shortname">${escHtml(item.shortname)}</div>
      <button type="button" class="itemshop-copy-btn" data-copy-shortname="${escHtml(item.shortname)}" title="复制 shortname" aria-label="复制 shortname">⧉</button>
      ${selected ? `<span class="itemshop-item-badge">✓</span>` : ''}
    </div>`;
  }).join('');

  updateItemSelectedCount();
  updateItemShopCategoryCounts();
}

/** 分类页签上的数量（数据来自已加载的物品目录） */
function updateItemShopCategoryCounts() {
  const catalog = getItemShopCatalog();
  if (!catalog.length) return;
  const counts = { all: catalog.length, weapon: 0, ammo: 0, armor: 0, resource: 0, tool: 0, medical: 0 };
  catalog.forEach((i) => {
    const c = i.cat || 'tool';
    if (counts[c] != null) counts[c]++;
  });
  document.querySelectorAll('#panel-itemshop .itemshop-tab-count').forEach((el) => {
    const k = el.dataset.catCount;
    el.textContent = counts[k] != null ? counts[k] : 0;
  });
}

// 获取物品 emoji（无图标 URL 或图片加载失败时显示）
function getItemEmoji(cat) {
  const emojis = {
    weapon: '🔫',
    ammo: '💣',
    armor: '🛡️',
    resource: '⛏️',
    tool: '🔧',
    medical: '💊'
  };
  return emojis[cat] || '📦';
}

// ===== 物品发放面板：委托事件与状态提示 =====
// 分类页签（原先是内联 onclick，改为委托，避免内联处理器失效）
document.getElementById('itemshop-tabs')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.itemshop-tab-btn[data-cat]');
  if (btn) switchItemCat(btn.dataset.cat);
});

// 搜索框：输入即过滤 + 清空按钮
const itemSearchEl = document.getElementById('item-search');
itemSearchEl?.addEventListener('input', () => {
  document.getElementById('item-search-clear')?.classList.toggle('u-hidden', !itemSearchEl.value);
  renderItemShopGrid();
});
document.getElementById('item-search-clear')?.addEventListener('click', () => {
  itemSearchEl.value = '';
  document.getElementById('item-search-clear').classList.add('u-hidden');
  renderItemShopGrid();
  itemSearchEl.focus();
});

// 物品卡上的「复制 shortname」：用捕获阶段拦截，避免同时触发选中/取消
document.getElementById('itemshop-items-grid')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy-shortname]');
  if (!btn) return;
  e.stopPropagation();
  e.preventDefault();
  const sn = btn.getAttribute('data-copy-shortname') || '';
  if (!sn) return;
  navigator.clipboard.writeText(sn)
    .then(() => toast('已复制 ' + sn, 'success'))
    .catch(() => toast('复制失败', 'error'));
}, true);

// 已选物品的数量摘要 + 清空按钮（用 MutationObserver 跟随列表重绘，不依赖内部实现）
(function observeItemShopSelectedList() {
  const el = document.getElementById('itemshop-selected-list');
  if (!el) return;
  const refresh = () => {
    const items = itemShopState.selectedItems || [];
    const total = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
    const sum = document.getElementById('itemshop-selected-summary');
    if (sum) sum.textContent = `${items.length} 种 · 共 ${total} 件`;
    const clr = document.getElementById('itemshop-clear-selected');
    if (clr) clr.classList.toggle('u-hidden', !items.length);
  };
  new MutationObserver(refresh).observe(el, { childList: true, subtree: true });
  refresh();
  document.getElementById('itemshop-clear-selected')?.addEventListener('click', () => {
    if (!(itemShopState.selectedItems || []).length) return;
    if (!confirm('清空已选物品？')) return;
    itemShopState.selectedItems = [];
    try { renderItemShopGrid(); renderItemShopSelectedList(); } catch (err) {}
    toast('已清空已选物品', 'success');
  });
})();

// 切换物品选择
function toggleItemSelection(shortname, name) {  const idx = itemShopState.selectedItems.findIndex(i => i.shortname === shortname);
  if (idx >= 0) {
    itemShopState.selectedItems.splice(idx, 1);
  } else {
    const meta = getItemShopCatalogMeta(shortname);
    itemShopState.selectedItems.push({
      shortname,
      name,
      quantity: 1,
      image: meta && meta.image ? meta.image : ''
    });
  }
  renderItemShopGrid();
  renderItemShopSelectedList();
  updateItemShopSummary();
}

// 渲染已选物品列表
function renderItemShopSelectedList() {
  const list = document.getElementById('itemshop-selected-list');
  if (!list) return;
  if (!itemShopState.selectedItems.length) {
    list.innerHTML = '<div class="itemshop-empty-hint">👈 请从左侧选择要发放的物品</div>';
    return;
  }
  
  list.innerHTML = itemShopState.selectedItems.map(item => {
    const url = safeRustItemImageUrl(item.image || '') || (getItemShopCatalogMeta(item.shortname)?.image || '');
    const safeUrl = safeRustItemImageUrl(url);
    const cat = getItemShopCatalogMeta(item.shortname)?.cat || 'tool';
    const emoji = getItemEmoji(cat);
    const thumb = `<span class="itemshop-selected-thumb-inner">
      <span class="itemshop-selected-thumb-fallback">${emoji}</span>
      ${safeUrl ? `<img class="itemshop-selected-thumb" src="${escHtml(safeUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer"
        onload="var p=this.previousElementSibling;if(p)p.style.display='none';"
        onerror="this.style.display='none';">` : ''}
    </span>`;
    return `
    <div class="itemshop-selected-item">
      <span class="itemshop-selected-thumb-cell">${thumb}</span>
      <span class="itemshop-selected-name">${escHtml(item.name)}</span>
      <div class="itemshop-selected-qty">
        <label>数量:</label>
        <input type="number" class="cfg-input cfg-input-xs item-qty-input"
          data-shortname="${escAttr(item.shortname)}"
          value="${item.quantity}" min="1">
      </div>
      <button type="button" class="itemshop-remove-btn" data-remove-shortname="${escAttr(item.shortname)}">✕</button>
    </div>`;
  }).join('');
}

// 更新物品数量
function updateItemQuantity(shortname, qty) {
  const item = itemShopState.selectedItems.find(i => i.shortname === shortname);
  if (item) {
    item.quantity = Math.max(1, parseInt(qty) || 1);
    updateItemShopSummary();
  }
}

function syncSelectedItemQuantitiesFromDom() {
  const list = document.getElementById('itemshop-selected-list');
  if (!list) return;
  list.querySelectorAll('.item-qty-input').forEach((el) => {
    const sn = String(el.getAttribute('data-shortname') || '').trim();
    if (!sn) return;
    updateItemQuantity(sn, el.value);
  });
}

// 从选择中移除物品
function removeItemFromSelection(shortname) {
  const idx = itemShopState.selectedItems.findIndex(i => i.shortname === shortname);
  if (idx >= 0) {
    itemShopState.selectedItems.splice(idx, 1);
    renderItemShopGrid();
    renderItemShopSelectedList();
    updateItemShopSummary();
  }
}

// 更新已选物品计数
function updateItemSelectedCount() {
  const el = document.getElementById('item-selected-count');
  if (el) el.textContent = `已选 ${itemShopState.selectedItems.length} 种物品`;
}

// 批量设置数量
function setBulkQuantity() {
  const bulkEl = document.getElementById('bulk-quantity');
  const qty = Math.max(1, parseInt(bulkEl && bulkEl.value) || 1);
  itemShopState.selectedItems.forEach(item => item.quantity = qty);
  renderItemShopSelectedList();
  updateItemShopSummary();
  toast(`已将所有物品数量设为 ${qty}`, 'info');
}

// 渲染玩家选择列表
function renderItemShopPlayerList() {
  const list = document.getElementById('itemshop-player-list');
  const targetInfo = document.getElementById('itemshop-target-info');
  if (!list || !targetInfo) return;
  
  if (!state.players.length) {
    list.innerHTML = '<div class="itemshop-empty-hint">暂无在线玩家</div>';
    targetInfo.innerHTML = '已选择 <b id="item-target-count">0</b> 名玩家';
    return;
  }
  
  list.innerHTML = state.players.map(p => {
    const selected = itemShopState.selectedPlayers.includes(p.SteamID);
    return `<div class="itemshop-player-item ${selected ? 'selected' : ''}" 
      onclick="toggleItemPlayer('${p.SteamID}')">
      <span class="itemshop-player-check">${selected ? '✓' : ''}</span>
      <span class="itemshop-player-name">${escHtml(p.DisplayName || p.Name || '?')}</span>
      <span class="itemshop-player-sid">${p.SteamID}</span>
    </div>`;
  }).join('');
  
  targetInfo.innerHTML = '已选择 <b id="item-target-count">' + itemShopState.selectedPlayers.length + '</b> 名玩家';
}

// 切换玩家选择
function toggleItemPlayer(steamid) {
  const idx = itemShopState.selectedPlayers.indexOf(steamid);
  if (idx >= 0) {
    itemShopState.selectedPlayers.splice(idx, 1);
  } else {
    itemShopState.selectedPlayers.push(steamid);
  }
  renderItemShopPlayerList();
  updateItemShopSummary();
}

// 更新摘要
function updateItemShopSummary() {
  const itemCount = itemShopState.selectedItems.length;
  let playerCount = 0;
  if (itemShopState.targetMode === 'all') {
    playerCount = state.players.length;
  } else {
    playerCount = itemShopState.selectedPlayers.length;
  }
  const totalCmds = itemCount * playerCount;
  
  const elI = document.getElementById('summary-item-count');
  const elP = document.getElementById('summary-player-count');
  const elT = document.getElementById('summary-total-cmd');
  if (elI) elI.textContent = itemCount;
  if (elP) elP.textContent = playerCount;
  if (elT) elT.textContent = totalCmds;
}

// 发送物品
async function sendItemShopItems() {
  if (!state.connected) { toast('请先连接服务器', 'error'); return; }
  // 发送前强制同步一次输入框数量（避免未失焦时仍用旧值）
  syncSelectedItemQuantitiesFromDom();

  if (!itemShopState.selectedItems.length) {
    toast('请先选择要发放的物品', 'error'); return;
  }

  let targets = [];
  const directSid = String(document.getElementById('item-target-steamid')?.value || '').trim();
  if (/^\d{10,20}$/.test(directSid)) {
    // 明确指定 SteamID 时，强制单人精准发放
    // 同时确保 UI 不会被“全体在线”误导
    itemShopState.targetMode = 'online';
    const radioOnline = document.querySelector('input[name="item-target"][value="online"]');
    if (radioOnline) radioOnline.checked = true;
    targets = [directSid];
  } else if (itemShopState.targetMode === 'all') {
    targets = state.players.map(p => p.SteamID).filter(Boolean);
  } else {
    targets = [...itemShopState.selectedPlayers];
  }

  if (!targets.length) {
    if (itemShopState.targetMode === 'all') {
      toast('当前没有在线玩家，请稍后刷新玩家列表再试', 'error');
    } else {
      toast('请先选择目标玩家', 'error');
    }
    return;
  }
  
  // 确认发放
  const totalCmds = itemShopState.selectedItems.length * targets.length;
  if (!confirm(`确认向 ${targets.length} 名玩家发放 ${itemShopState.selectedItems.length} 种物品（共 ${totalCmds} 次指令）？`)) {
    return;
  }
  
  toast(`开始发放物品...`, 'info');
  appendAdminCmdOutput('itemshop.send', { ok: true, message: `开始执行：玩家 ${targets.length}，物品 ${itemShopState.selectedItems.length}，总计 ${totalCmds} 次` });
  let successCount = 0;
  let failCount = 0;
  let firstFailDetail = '';
  let doneCount = 0;

  const isRconFailureText = (msg) => /unknown command|command not found|invalid|syntax|error|failed|no permission|not allowed/i.test(String(msg || ''));
  const tryGiveItem = async (steamid, shortname, qty) => {
    const meta = getItemShopCatalogMeta(shortname) || {};
    const itemId = String(meta.id || '').trim();
    const sid = String(steamid || '').trim();
    const amount = Math.max(1, parseInt(qty, 10) || 1);

    const cmds = [];
    if (itemShopState.targetMode === 'all' && !directSid) {
      // 全体发放优先走 giveall（部分服仅支持该形式）
      cmds.push(`inventory.giveall ${shortname} ${amount}`);
      cmds.push(`giveall ${shortname} ${amount}`);
    }
    // 单人发放：仅按 SteamID 尝试，避免按名字误发/失败
    // GM命令 1.5：giveto / giveall 是主要口径，优先尝试
    cmds.push(`giveto ${sid} ${shortname} ${amount}`);
    cmds.push(`giveto ${sid} "${shortname}" ${amount}`);
    // 常见顺序变体：giveto <steamid> <amount> <shortname>
    cmds.push(`giveto ${sid} ${amount} ${shortname}`);
    cmds.push(`giveto ${sid} ${amount} "${shortname}"`);
    // 其它兼容（部分服/插件才有）
    cmds.push(`inventory.give ${sid} ${shortname} ${amount}`);
    cmds.push(`inventory.give "${shortname}" ${amount} ${sid}`);
    cmds.push(`inventory.give ${shortname} ${amount} ${sid}`);
    cmds.push(`inv.giveplayer ${sid} ${shortname} ${amount}`);
    cmds.push(`inv.giveplayer ${sid} "${shortname}" ${amount}`);

    if (itemId) {
      cmds.push(`inventory.giveid ${itemId} ${amount} ${sid}`);
    }
    // 去重
    const uniqCmds = [...new Set(cmds.filter(Boolean))];
    let last = null;
    const samples = [];
    for (const c of uniqCmds) {
      let r = null;
      try {
        r = await api.rconCommand(c);
      } catch (e) {
        r = { ok: false, error: e?.message || String(e || 'unknown') };
      }
      last = { cmd: c, res: r };
      if (samples.length < 5) {
        const brief = String(r?.message || r?.error || '').replace(/\s+/g, ' ').slice(0, 120);
        samples.push(`${c} -> ${r && r.ok ? 'ok' : 'fail'} ${brief}`);
      }
      if (r && r.ok && !isRconFailureText(r.message)) return { ok: true, cmd: c, res: r };
    }
    return { ok: false, cmd: last?.cmd || uniqCmds[0], res: last?.res || { ok: false, error: 'unknown' }, samples };
  };
  
  try {
    for (const steamid of targets) {
      for (const item of itemShopState.selectedItems) {
        const rr = await tryGiveItem(steamid, item.shortname, item.quantity);
        if (rr.ok) successCount++;
        else {
          failCount++;
          if (!firstFailDetail) {
            const em = rr?.res?.message || rr?.res?.error || '未知错误';
            firstFailDetail = `${rr?.cmd || 'n/a'} -> ${String(em).slice(0, 120)}`;
          if (rr?.samples?.length) {
            appendAdminCmdOutput('itemshop.try', { ok: false, error: rr.samples.join('\n') });
          }
          }
        }
        doneCount++;
        if (doneCount % 10 === 0 || doneCount === totalCmds) {
          appendAdminCmdOutput('itemshop.progress', { ok: true, message: `进度 ${doneCount}/${totalCmds}，成功 ${successCount}，失败 ${failCount}` });
        }
      }
    }
  } catch (e) {
    const em = e?.message || String(e || '未知错误');
    appendAdminCmdOutput('itemshop.exception', { ok: false, error: em });
    toast('发放中断：' + em, 'error');
    return;
  }
  
  if (failCount === 0) {
    toast(`物品发放完成！成功 ${successCount} 次`, 'success');
    appendAdminCmdOutput('itemshop.done', { ok: true, message: `完成：成功 ${successCount} / ${totalCmds}` });
  } else {
    toast(`发放完成：成功 ${successCount} 次，失败 ${failCount} 次`, 'error');
    appendAdminCmdOutput('itemshop.done', { ok: false, error: `完成：成功 ${successCount}，失败 ${failCount}` });
    if (firstFailDetail) {
      appendAdminCmdOutput('itemshop.send', { ok: false, error: firstFailDetail });
    }
  }
}

// 清空选择
function clearItemShopSelection() {
  itemShopState.selectedItems = [];
  itemShopState.selectedPlayers = [];
  itemShopState.targetMode = 'online';
  const radioOnline = document.querySelector('input[name="item-target"][value="online"]');
  if (radioOnline) radioOnline.checked = true;
  renderItemShopGrid();
  renderItemShopSelectedList();
  renderItemShopPlayerList();
  updateItemShopSummary();
  updateItemSelectedCount();
  toast('已清空所有选择', 'info');
}

// 保存预设
async function saveItemPreset() {
  if (!itemShopState.selectedItems.length) {
    toast('请先选择物品', 'error'); return;
  }
  
  const nameEl = document.getElementById('item-preset-name');
  const typed = String(nameEl?.value || '').trim();
  const autoName = '预设-' + new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/: ]/g, '-');
  const finalName = typed || autoName;
  
  const preset = {
    name: finalName,
    items: [...itemShopState.selectedItems],
    createdAt: new Date().toISOString()
  };
  
  // 从本地存储加载现有预设
  let presets = readItemPresets();
  presets = presets.filter((p) => p && p.name !== preset.name);
  presets.push(preset);
  if (!writeItemPresets(presets)) {
    toast('预设保存失败（存储写入异常）', 'error');
    return;
  }
  
  itemShopState.presets = presets;
  renderPresetSelect();
  renderPresetList();
  if (nameEl) nameEl.value = '';
  toast(`预设 "${finalName}" 已保存`, 'success');
}

// 加载预设
function loadItemPreset() {
  const select = document.getElementById('item-preset-select');
  const presetName = select.value;
  if (!presetName) return;
  
  const presets = readItemPresets();
  const preset = presets.find(p => p.name === presetName);
  if (!preset) return;
  
  itemShopState.selectedItems = [...preset.items];
  renderItemShopGrid();
  renderItemShopSelectedList();
  updateItemShopSummary();
  toast(`已加载预设 "${presetName}"（${preset.items.length} 种物品）`, 'success');
  select.value = '';
}

// 删除预设
async function deleteItemPreset(name) {
  if (!confirm(`确认删除预设 "${name}"？`)) return;
  
  let presets = readItemPresets();
  presets = presets.filter(p => p.name !== name);
  if (!writeItemPresets(presets)) {
    toast('删除失败（存储写入异常）', 'error');
    return;
  }
  
  itemShopState.presets = presets;
  renderPresetSelect();
  renderPresetList();
  toast(`预设 "${name}" 已删除`, 'info');
}

// 渲染预设选择下拉框
function renderPresetSelect() {
  const select = document.getElementById('item-preset-select');
  if (!select) return;
  const presets = readItemPresets();
  
  select.innerHTML = '<option value="">-- 加载预设 --</option>' + 
    presets.map(p => `<option value="${p.name}">${p.name} (${p.items.length}种)</option>`).join('');
}

// 渲染预设列表
function renderPresetList() {
  const list = document.getElementById('itemshop-preset-list');
  if (!list) return;
  const presets = readItemPresets();
  
  if (!presets.length) {
    list.innerHTML = '<div class="itemshop-preset-empty">暂无保存的预设</div>';
    return;
  }
  
  list.innerHTML = presets.map(p => `
    <div class="itemshop-preset-item">
      <div class="itemshop-preset-name">${p.name}</div>
      <div class="itemshop-preset-info">${p.items.length} 种物品</div>
      <div class="itemshop-preset-actions">
        <button class="cfg-btn cfg-btn-xs" onclick="loadPresetByName('${p.name}')">加载</button>
        <button class="cfg-btn cfg-btn-xs cfg-btn-danger" onclick="deleteItemPreset('${p.name}')">删除</button>
      </div>
    </div>
  `).join('');
}

// 通过名称加载预设
function loadPresetByName(name) {
  const select = document.getElementById('item-preset-select');
  select.value = name;
  loadItemPreset();
}

// 兼容 inline onclick：确保按钮可直接调用
window.saveItemPreset = saveItemPreset;
window.loadItemPreset = loadItemPreset;
window.deleteItemPreset = deleteItemPreset;
window.loadPresetByName = loadPresetByName;
window.sendItemShopItems = sendItemShopItems;
window.clearItemShopSelection = clearItemShopSelection;
window.setBulkQuantity = setBulkQuantity;
window.switchItemTarget = switchItemTarget;
window.switchItemCat = switchItemCat;
window.toggleItemPlayer = toggleItemPlayer;
window.updateItemQuantity = updateItemQuantity;
window.removeItemFromSelection = removeItemFromSelection;

// 物品搜索输入
document.getElementById('item-search')?.addEventListener('input', () => {
  renderItemShopGrid();
});

document.getElementById('item-custom-add')?.addEventListener('click', addCustomShortnameToSelection);
document.getElementById('item-custom-shortname')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addCustomShortnameToSelection();
});

// 填写 SteamID 时，强制单人发放模式（不走全服）
document.getElementById('item-target-steamid')?.addEventListener('input', () => {
  const sidEl = document.getElementById('item-target-steamid');
  const sid = String(sidEl?.value || '').trim();
  if (/^\d{10,20}$/.test(sid)) {
    itemShopState.targetMode = 'online';
    itemShopState.selectedPlayers = [];
    const radioOnline = document.querySelector('input[name="item-target"][value="online"]');
    if (radioOnline) radioOnline.checked = true;
    const targetInfo = document.getElementById('itemshop-target-info');
    if (targetInfo) targetInfo.innerHTML = '目标：<b>SteamID</b>（<b id="item-target-count">1</b> 名）';
    updateItemShopSummary();
  }
});

// 已选物品列表：委托处理“删项 / 数量变更”
document.getElementById('itemshop-selected-list')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.itemshop-remove-btn');
  if (!btn) return;
  const sn = String(btn.getAttribute('data-remove-shortname') || '').trim();
  if (!sn) return;
  removeItemFromSelection(sn);
});
document.getElementById('itemshop-selected-list')?.addEventListener('input', (e) => {
  const inp = e.target.closest('.item-qty-input');
  if (!inp) return;
  const sn = String(inp.getAttribute('data-shortname') || '').trim();
  if (!sn) return;
  updateItemQuantity(sn, inp.value);
});

// 初始化物品发放Tab
function initItemShop() {
  itemShopState.presets = readItemPresets();
  setupItemShopGridDelegation();
  renderItemShopGrid();
  renderItemShopPlayerList();
  renderPresetSelect();
  renderPresetList();
  updateItemShopSummary();
  syncItemShopAfterPlayersRefresh();
  ensureRustItemCatalog()
    .then(() => {
      renderItemShopGrid();
      updateItemShopSummary();
    })
    .catch(e => {
      console.error('[RustAdmin] rust_items.json', e);
      toast('物品目录加载异常，可用手动输入 shortname', 'error');
    });
}

// ===== 开发者模式（密码保护） =====
let devPanelVisible = false;

// 开发者密码弹窗事件
document.addEventListener('keydown', async (e) => {
  // Ctrl+Shift+D 打开开发者密码弹窗
  if (e.ctrlKey && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    openDevPasswordModal();
  }
});

// 打开密码验证弹窗
function openDevPasswordModal() {
  document.getElementById('dev-password-modal').style.display = 'flex';
  document.getElementById('dev-password-input').value = '';
  document.getElementById('dev-password-error').style.display = 'none';
  document.getElementById('dev-config-panel').style.display = 'none';
  document.querySelector('.dev-modal').style.display = 'block';
  document.getElementById('dev-password-input').focus();
}

// 关闭开发者弹窗
document.getElementById('btn-close-dev-modal')?.addEventListener('click', () => {
  document.getElementById('dev-password-modal').style.display = 'none';
  devPanelVisible = false;
});

document.getElementById('btn-close-dev-config')?.addEventListener('click', () => {
  document.getElementById('dev-password-modal').style.display = 'none';
  devPanelVisible = false;
});

// 密码验证
document.getElementById('btn-verify-dev-password')?.addEventListener('click', verifyDevPassword);
document.getElementById('dev-password-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') verifyDevPassword();
});

async function verifyDevPassword() {
  const password = document.getElementById('dev-password-input').value;
  const errorEl = document.getElementById('dev-password-error');
  
  const result = await api.devVerifyPassword(password);
  
  if (result.ok) {
    errorEl.style.display = 'none';
    document.querySelector('.dev-modal').style.display = 'none';
    document.getElementById('dev-config-panel').style.display = 'block';
    devPanelVisible = true;
    
    // 加载配置
    document.getElementById('dev-qqbot-url').value = result.config.qqBotUrl || '';
    updateDevReportStatus(result.config.hasReportedFirstUse);
  } else {
    errorEl.style.display = 'flex';
    document.getElementById('dev-password-input').value = '';
    document.getElementById('dev-password-input').focus();
  }
}

// 更新上报状态显示
function updateDevReportStatus(reported) {
  const dot = document.querySelector('.dev-status-dot');
  const text = document.getElementById('dev-report-text');
  if (!text) return;
  if (reported) {
    dot?.classList.add('active');
    text.textContent = '已上报（' + new Date().toLocaleString('zh-CN') + '）';
  } else {
    dot?.classList.remove('active');
    text.textContent = '未上报';
  }
}

// 测试 QQ 机器人
document.getElementById('btn-test-qqbot')?.addEventListener('click', async () => {
  const url = document.getElementById('dev-qqbot-url').value.trim();
  if (!url) { toast('请输入 QQ 机器人地址', 'error'); return; }
  toast('正在测试...', 'info', 5000);
  const result = await api.devTestQqBot(url);
  if (result.ok) toast('QQ 机器人连接成功！', 'success');
  else toast('连接失败: ' + (result.error || 'HTTP ' + result.status), 'error');
});

// 保存开发者配置
document.getElementById('btn-save-dev-config')?.addEventListener('click', async () => {
  const qqBotUrl = document.getElementById('dev-qqbot-url').value.trim();
  const config = await api.devGetConfig();
  config.qqBotUrl = qqBotUrl;
  await api.devSaveConfig(config);
  toast('配置已保存', 'success');
});

// 重置上报状态（用于测试）
document.getElementById('btn-reset-report')?.addEventListener('click', async () => {
  const config = await api.devGetConfig();
  config.hasReportedFirstUse = false;
  await api.devSaveConfig(config);
  updateDevReportStatus(false);
  toast('已重置上报状态，重新启动应用后将再次上报', 'info');
});

// ===== 初始化 =====
(async function init() {
  // 加载主题
  const savedTheme = localStorage.getItem('rustadmin-theme');
  applyTheme(savedTheme || 'dark');
  // 初始化新闻
  appendNewsDots();
  // 加载服务器列表
  await loadServerList();
  // 加载使用日志
  loadUsageLog();
  // 加载离线玩家列表（修复离线玩家不显示的问题）
  await refreshOfflinePlayers();
  // 每日自动上报（每小时检查一次）
  setInterval(reportUsageToOwner, 3600000);
  toast('RustAdmin 已就绪', 'info', 2000);
})();

// ===== 左下角：下次官方清档（force wipe）时间 =====
// Rust 官方每月第一个周四 19:00 UTC 强制清档；北京时间 = 次日 03:00
function nextForceWipeUtc(fromMs) {
  const from = new Date(fromMs);
  let y = from.getUTCFullYear();
  let mo = from.getUTCMonth();
  for (let k = 0; k < 4; k++) {
    const first = new Date(Date.UTC(y, mo, 1));
    const add = (4 - first.getUTCDay() + 7) % 7;   // 4 = 周四
    const thu = Date.UTC(y, mo, 1 + add, 19, 0, 0);
    if (thu > fromMs) return thu;
    mo++; if (mo > 11) { mo = 0; y++; }
  }
  return null;
}

(function initWipeChip() {
  const el = document.getElementById('wipe-chip');
  if (!el) return;
  const pad = (n) => String(n).padStart(2, '0');
  const render = () => {
    const now = Date.now();
    const t = nextForceWipeUtc(now);
    if (!t) { el.textContent = '下次官清 未知'; return; }
    const d = new Date(t);
    const bj = new Date(t + 8 * 3600 * 1000);           // 北京时间
    const dateStr = `${bj.getUTCMonth() + 1}月${bj.getUTCDate()}日 ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
    const leftMs = t - now;
    const days = Math.floor(leftMs / 86400000);
    const hours = Math.floor((leftMs % 86400000) / 3600000);
    const left = days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时`;
    el.textContent = `下次官清 ${dateStr}（${left}后）`;
    el.classList.toggle('is-soon', leftMs < 48 * 3600 * 1000);
  };
  render();
  setInterval(render, 60 * 1000);
})();