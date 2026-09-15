const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rustAPI', {
  // 窗口控制
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),
  openUrl: (url) => ipcRenderer.send('open-url', url),

  // 服务器管理
  getServers: () => ipcRenderer.invoke('get-servers'),
  saveServer: (server) => ipcRenderer.invoke('save-server', server),
  deleteServer: (name) => ipcRenderer.invoke('delete-server', name),
  setLastServer: (name) => ipcRenderer.invoke('set-last-server', name),

  // RCON 连接
  rconConnect: (server) => ipcRenderer.invoke('rcon-connect', server),
  rconDisconnect: () => ipcRenderer.invoke('rcon-disconnect'),
  rconCommand: (cmd) => ipcRenderer.invoke('rcon-command', cmd),
  rconCommandSilent: (cmd) => ipcRenderer.invoke('rcon-command-silent', cmd),

  // 数据查询
  getPlayers: () => ipcRenderer.invoke('get-players'),
  getBans: () => ipcRenderer.invoke('get-bans'),
  getGroups: () => ipcRenderer.invoke('get-groups'),
  getGroupDetail: (group) => ipcRenderer.invoke('get-group-detail', group),
  getPermissions: () => ipcRenderer.invoke('get-permissions'),
  groupGrantPerm: (group, perm) => ipcRenderer.invoke('group-grant-perm', group, perm),
  groupRevokePerm: (group, perm) => ipcRenderer.invoke('group-revoke-perm', group, perm),
  getPlugins: () => ipcRenderer.invoke('get-plugins'),
  getOfflinePlayers: () => ipcRenderer.invoke('get-offline-players'),
  clearOfflinePlayers: () => ipcRenderer.invoke('clear-offline-players'),
  deleteOfflinePlayer: (steamid, server) => ipcRenderer.invoke('delete-offline-player', steamid, server),
  // Steam 游戏封禁信息（集成到在线玩家表格）
  getSteamGameBansBatch: (steamids) => ipcRenderer.invoke('steam-get-game-bans-batch', steamids),

  // IP 地理位置（集成到在线玩家表格）
  getIpGeoBatch: (ips) => ipcRenderer.invoke('ip-geo-get-batch', ips),
  // 控制台日志本地持久化（按服务器分文件，重启后可回看）
  consoleLogAppend: (serverKey, lines) => ipcRenderer.invoke('console-log-append', serverKey, lines),
  consoleLogLoad: (serverKey, limit) => ipcRenderer.invoke('console-log-load', serverKey, limit),
  consoleLogClear: (serverKey) => ipcRenderer.invoke('console-log-clear', serverKey),
  consoleLogReveal: (serverKey) => ipcRenderer.invoke('console-log-reveal', serverKey),
  getBanDb: () => ipcRenderer.invoke('ban-get-db'),
  deleteBanEntry: (key) => ipcRenderer.invoke('ban-delete-entry', key),
  saveBanRule: (payload) => ipcRenderer.invoke('ban-upsert-rule', payload),
  exportBanDb: () => ipcRenderer.invoke('ban-export-db'),
  syncBanDb: () => ipcRenderer.invoke('ban-sync-db'),
  getBattleLog: (steamid, lines) => ipcRenderer.invoke('battle-get-log', steamid, lines),

  // 服务器配置
  serverSetHostname: (name) => ipcRenderer.invoke('server-set-hostname', name),
  serverSetWeather: (w) => ipcRenderer.invoke('server-set-weather', w),
  serverSetTime: (t) => ipcRenderer.invoke('server-set-time', t),
  serverTeamLimit: (n) => ipcRenderer.invoke('server-team-limit', n),
  serverSetMaxplayers: (n) => ipcRenderer.invoke('server-set-maxplayers', n),
  serverNpcEnabled: (enabled) => ipcRenderer.invoke('server-npc-enabled', enabled),
  serverCombatLog: (size) => ipcRenderer.invoke('server-combat-log', size),
  serverSave: () => ipcRenderer.invoke('server-save'),
  serverWriteCfg: () => ipcRenderer.invoke('server-writecfg'),
  serverStatus: () => ipcRenderer.invoke('server-status'),
  serverInfo: () => ipcRenderer.invoke('server-info'),
  serverGetConvars: (names) => ipcRenderer.invoke('server-get-convars', names),
  serverSetConvar: (name, value) => ipcRenderer.invoke('server-set-convar', name, value),

  // 玩家授权
  playerGrant: (perm, steamid) => ipcRenderer.invoke('player-grant', perm, steamid),
  playerRevoke: (perm, steamid) => ipcRenderer.invoke('player-revoke', perm, steamid),
  playerGrantAll: (perm) => ipcRenderer.invoke('player-grant-all', perm),
  playerRevokeAll: (perm) => ipcRenderer.invoke('player-revoke-all', perm),
  playerAddGroup: (steamid, group) => ipcRenderer.invoke('player-add-group', steamid, group),
  playerRemoveGroup: (steamid, group) => ipcRenderer.invoke('player-remove-group', steamid, group),
  playerGiveCurrency: (steamid, amount) => ipcRenderer.invoke('player-give-currency', steamid, amount),
  playerDeductCurrency: (steamid, amount) => ipcRenderer.invoke('player-deduct-currency', steamid, amount),
  playerGivePoints: (steamid, amount) => ipcRenderer.invoke('player-give-points', steamid, amount),
  playerDeductPoints: (steamid, amount) => ipcRenderer.invoke('player-deduct-points', steamid, amount),

  // 使用日志
  getUsageLog: () => ipcRenderer.invoke('get-usage-log'),
  exportUsageLog: () => ipcRenderer.invoke('export-usage-log'),
  clearUsageLog: () => ipcRenderer.invoke('clear-usage-log'),

  // 开发者验证（密码保护）
  devVerifyPassword: (pwd) => ipcRenderer.invoke('dev-verify-password', pwd),
  devSaveConfig: (config) => ipcRenderer.invoke('dev-save-config', config),
  devGetConfig: () => ipcRenderer.invoke('dev-get-config'),
  devTestQqBot: (url) => ipcRenderer.invoke('dev-test-qqbot', url),

  // 玩家属性本地持久化（按服务器存储）
  playerDataLoad: (serverKey) => ipcRenderer.invoke('player-data-load', serverKey),
  playerDataSave: (serverKey, data) => ipcRenderer.invoke('player-data-save', serverKey, data),

  // 聊天记录持久化（按服务器，30天）
  chatLogLoad: (serverKey) => ipcRenderer.invoke('chat-log-load', serverKey),
  chatLogAppend: (serverKey, msgs) => ipcRenderer.invoke('chat-log-append', serverKey, msgs),
  chatLogClear: (serverKey) => ipcRenderer.invoke('chat-log-clear', serverKey),
  chatLogReveal: (serverKey) => ipcRenderer.invoke('chat-log-reveal', serverKey),
  saveChatExport: (serverKey, content) => ipcRenderer.invoke('save-chat-export', serverKey, content),
  getAutoSaveStatus: () => ipcRenderer.invoke('get-autosave-status'),
  runAutoSaveNow: () => ipcRenderer.invoke('run-autosave-now'),
  onAutoSaveTick: (cb) => ipcRenderer.on('autosave-tick', (e, data) => cb(data)),

  // 日志
  getLogs: () => ipcRenderer.invoke('get-logs'),
  readLog: (path) => ipcRenderer.invoke('read-log', path),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
  saveConsoleLogLocal: (text) => ipcRenderer.invoke('save-console-log-local', text),

  // 自定义命令
  getCustomCommands: () => ipcRenderer.invoke('get-custom-commands'),
  saveCustomCommands: (cmds) => ipcRenderer.invoke('save-custom-commands', cmds),

  // Rust 最新新闻
  getRustNews: () => ipcRenderer.invoke('get-rust-news'),

  // 自动重连控制
  setAutoReconnect: (enabled) => ipcRenderer.invoke('set-auto-reconnect', enabled),
  getAutoReconnect: () => ipcRenderer.invoke('get-auto-reconnect'),

  // 事件监听
  onRconStatus: (cb) => ipcRenderer.on('rcon-status', (e, data) => cb(data)),
  onRconServerMeta: (cb) => ipcRenderer.on('rcon-server-meta', (e, data) => cb(data)),
  onRconConsole: (cb) => ipcRenderer.on('rcon-console', (e, data) => cb(data)),
  onRconChat: (cb) => ipcRenderer.on('rcon-chat', (e, data) => cb(data)),
  onRconReconnecting: (cb) => ipcRenderer.on('rcon-reconnecting', (e, data) => cb(data)),
});
