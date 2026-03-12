/**
 * 微信群文件统计机器人 - 带 Web 配置界面
 */

const { WechatyBuilder, Message } = require('wechaty');
const schedule = require('node-schedule');
const http = require('http');
const path = require('path');
const fs = require('fs');
const url = require('url');

// 文件路径
const DATA_FILE = path.join(__dirname, 'data', 'records.json');
const CONFIG_FILE = path.join(__dirname, 'data', 'user-config.json');

// 确保数据目录存在
const dataDir = path.dirname(DATA_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// 默认配置
const defaultConfig = {
  monitorRooms: [],
  dailyTargets: {},
  reminderTimes: [{ hour: 10, minute: 0 }],
  queryKeywords: ['统计', '文件统计', '今日统计'],
  countImages: false,
  countVideos: false,
  messages: {
    notEnough: '⚠️ 今日文件统计提醒\n已提交: {count} 份\n目标: {target} 份\n还缺少: {missing} 份\n请尽快提交！',
    completed: '✅ 今日文件已全部提交！\n共计: {count} 份，达到目标 {target} 份。',
    fileReceived: '',
    statusQuery: '📊 今日文件统计\n已提交: {count} 份\n目标: {target} 份\n{status}',
  }
};

// 加载用户配置
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const userConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      return { ...defaultConfig, ...userConfig };
    }
  } catch (e) {
    console.error('加载配置失败:', e.message);
  }
  return defaultConfig;
}

// 保存用户配置
function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// 加载数据
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('加载数据失败:', e.message);
  }
  return { records: [] };
}

// 保存数据
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// 获取今天的日期字符串
function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

// 获取群的目标文件数量
function getTargetCount(roomName, config) {
  return config.dailyTargets[roomName] || config.dailyTargets['default'] || 3;
}

// 获取今日文件数量
function getTodayFileCount(roomId) {
  const today = getTodayDate();
  const data = loadData();
  return data.records.filter(r => r.roomId === roomId && r.date === today).length;
}

// 记录文件
function recordFile(roomId, roomName, senderId, senderName, fileName, fileType) {
  const today = getTodayDate();
  const data = loadData();
  
  data.records.push({
    roomId,
    roomName,
    senderId,
    senderName,
    fileName,
    fileType,
    date: today,
    createdAt: new Date().toISOString()
  });
  
  // 只保留最近 30 天的数据
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoffDate = thirtyDaysAgo.toISOString().split('T')[0];
  data.records = data.records.filter(r => r.date >= cutoffDate);
  
  saveData(data);
  log('info', `记录文件: ${roomName} - ${senderName} - ${fileName}`);
}

// 格式化消息
function formatMessage(template, data) {
  let message = template;
  for (const [key, value] of Object.entries(data)) {
    message = message.replace(new RegExp(`{${key}}`, 'g'), value);
  }
  return message;
}

// 日志
function log(level, message) {
  const timestamp = new Date().toLocaleString('zh-CN');
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

// 全局变量
let bot = null;
let botStatus = 'stopped';
let qrcodeUrl = '';
let loginUser = '';
let scheduledJobs = [];

// 发送提醒消息
async function sendReminder(room, roomName) {
  const config = loadConfig();
  const roomId = room.id;
  const count = getTodayFileCount(roomId);
  const target = getTargetCount(roomName, config);
  const missing = Math.max(0, target - count);
  
  const data = {
    count,
    target,
    missing,
    status: count >= target ? '已完成 ✅' : `还差 ${missing} 份 ⚠️`
  };
  
  let message;
  if (count >= target) {
    message = formatMessage(config.messages.completed, data);
  } else {
    message = formatMessage(config.messages.notEnough, data);
  }
  
  await room.say(message);
  log('info', `发送提醒到群 [${roomName}]: ${count}/${target}`);
}

// 更新定时任务
function updateScheduledJobs() {
  // 清除现有任务
  scheduledJobs.forEach(job => job.cancel());
  scheduledJobs = [];
  
  if (!bot || botStatus !== 'logged_in') return;
  
  const config = loadConfig();
  
  for (const time of config.reminderTimes) {
    const cronExpression = `${time.minute} ${time.hour} * * *`;
    
    const job = schedule.scheduleJob(cronExpression, async () => {
      log('info', `执行定时提醒任务: ${time.hour}:${time.minute}`);
      const currentConfig = loadConfig();
      
      for (const roomName of currentConfig.monitorRooms) {
        try {
          const room = await bot.Room.find({ topic: roomName });
          if (room) {
            await sendReminder(room, roomName);
          } else {
            log('warn', `未找到群: ${roomName}`);
          }
        } catch (error) {
          log('error', `提醒失败 [${roomName}]: ${error.message}`);
        }
      }
    });
    
    scheduledJobs.push(job);
    log('info', `已设置定时提醒: 每天 ${time.hour}:${String(time.minute).padStart(2, '0')}`);
  }
}

// 启动机器人
async function startBot() {
  if (bot && botStatus !== 'stopped') {
    return;
  }
  
  log('info', '正在启动微信机器人...');
  botStatus = 'starting';
  
  bot = WechatyBuilder.build({
    name: 'file-counter-bot',
    puppet: 'wechaty-puppet-wechat4u',
  });

  bot.on('login', async (user) => {
    loginUser = user.name();
    botStatus = 'logged_in';
    qrcodeUrl = '';
    log('info', `登录成功: ${loginUser}`);
    updateScheduledJobs();
  });

  bot.on('logout', (user) => {
    loginUser = '';
    botStatus = 'logged_out';
    log('warn', `已登出: ${user.name()}`);
  });

  bot.on('scan', (qrcode, status) => {
    qrcodeUrl = `https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`;
    botStatus = 'waiting_scan';
    log('info', `等待扫码登录`);
  });

  bot.on('message', async (message) => {
    if (message.self()) return;
    
    const room = message.room();
    if (!room) return;
    
    const roomName = await room.topic();
    const config = loadConfig();
    
    if (!config.monitorRooms.includes(roomName)) return;
    
    const sender = message.talker();
    const senderName = sender.name();
    const messageType = message.type();
    
    let isCountable = false;
    let fileType = '';
    let fileName = '';
    
    switch (messageType) {
      case Message.Type.Attachment:
        isCountable = true;
        fileType = 'file';
        try {
          const fileBox = await message.toFileBox();
          fileName = fileBox.name;
        } catch (e) {
          fileName = '未知文件';
        }
        break;
        
      case Message.Type.Image:
        if (config.countImages) {
          isCountable = true;
          fileType = 'image';
          fileName = '图片';
        }
        break;
        
      case Message.Type.Video:
        if (config.countVideos) {
          isCountable = true;
          fileType = 'video';
          fileName = '视频';
        }
        break;
    }
    
    if (isCountable) {
      recordFile(room.id, roomName, sender.id, senderName, fileName, fileType);
      
      if (config.messages.fileReceived) {
        const count = getTodayFileCount(room.id);
        const target = getTargetCount(roomName, config);
        const data = { count, target };
        const replyMsg = formatMessage(config.messages.fileReceived, data);
        await room.say(replyMsg);
      }
    }
    
    if (messageType === Message.Type.Text) {
      const text = message.text().trim();
      
      if (config.queryKeywords.includes(text)) {
        const count = getTodayFileCount(room.id);
        const target = getTargetCount(roomName, config);
        const missing = Math.max(0, target - count);
        const data = {
          count,
          target,
          missing,
          status: count >= target ? '已完成 ✅' : `还差 ${missing} 份 ⚠️`
        };
        const replyMsg = formatMessage(config.messages.statusQuery, data);
        await room.say(replyMsg);
      }
    }
  });

  bot.on('error', (error) => {
    log('error', `机器人错误: ${error.message}`);
  });

  await bot.start();
  log('info', '机器人已启动');
}

// HTML 页面
const htmlPage = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>微信文件统计机器人 - 配置</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
    }
    h1 {
      color: #333;
      margin-bottom: 8px;
      font-size: 24px;
    }
    h2 {
      color: #333;
      margin-bottom: 16px;
      font-size: 18px;
      border-bottom: 2px solid #667eea;
      padding-bottom: 8px;
    }
    .subtitle {
      color: #666;
      margin-bottom: 20px;
      font-size: 14px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 14px;
      margin-bottom: 16px;
    }
    .status.online { background: #d4edda; color: #155724; }
    .status.offline { background: #f8d7da; color: #721c24; }
    .status.waiting { background: #fff3cd; color: #856404; }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    .status.online .status-dot { background: #28a745; }
    .status.offline .status-dot { background: #dc3545; }
    .status.waiting .status-dot { background: #ffc107; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .qrcode-link {
      display: block;
      background: #667eea;
      color: white;
      text-align: center;
      padding: 12px;
      border-radius: 8px;
      text-decoration: none;
      margin: 16px 0;
    }
    .qrcode-link:hover { background: #5a6fd6; }
    label {
      display: block;
      color: #333;
      font-weight: 500;
      margin-bottom: 6px;
      font-size: 14px;
    }
    input, select {
      width: 100%;
      padding: 12px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      margin-bottom: 16px;
      transition: border-color 0.3s;
    }
    input:focus, select:focus {
      outline: none;
      border-color: #667eea;
    }
    .room-item {
      display: flex;
      gap: 10px;
      align-items: center;
      background: #f8f9fa;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 10px;
    }
    .room-item input {
      margin-bottom: 0;
      flex: 1;
    }
    .room-item input:last-child {
      width: 80px;
      flex: none;
    }
    .btn {
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      cursor: pointer;
      transition: all 0.3s;
    }
    .btn-primary {
      background: #667eea;
      color: white;
    }
    .btn-primary:hover { background: #5a6fd6; }
    .btn-success {
      background: #28a745;
      color: white;
    }
    .btn-success:hover { background: #218838; }
    .btn-danger {
      background: #dc3545;
      color: white;
      padding: 8px 12px;
      font-size: 14px;
    }
    .btn-danger:hover { background: #c82333; }
    .btn-secondary {
      background: #6c757d;
      color: white;
    }
    .btn-secondary:hover { background: #5a6268; }
    .btn-group {
      display: flex;
      gap: 10px;
      margin-top: 20px;
    }
    .time-inputs {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .time-inputs input {
      width: 80px;
      text-align: center;
    }
    .time-inputs span {
      font-size: 18px;
      color: #666;
    }
    .hint {
      color: #666;
      font-size: 12px;
      margin-top: -12px;
      margin-bottom: 16px;
    }
    .alert {
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 16px;
      font-size: 14px;
    }
    .alert-success {
      background: #d4edda;
      color: #155724;
    }
    .alert-error {
      background: #f8d7da;
      color: #721c24;
    }
    #alertBox { display: none; }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-top: 16px;
    }
    .stat-item {
      text-align: center;
      padding: 16px;
      background: #f8f9fa;
      border-radius: 8px;
    }
    .stat-value {
      font-size: 24px;
      font-weight: bold;
      color: #667eea;
    }
    .stat-label {
      font-size: 12px;
      color: #666;
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>🤖 微信文件统计机器人</h1>
      <p class="subtitle">自动统计群内文件数量，不达标自动提醒</p>
      
      <div id="statusBox">
        <div class="status offline" id="statusBadge">
          <span class="status-dot"></span>
          <span id="statusText">未连接</span>
        </div>
      </div>
      
      <div id="qrcodeBox" style="display:none;">
        <a href="#" id="qrcodeLink" class="qrcode-link" target="_blank">📱 点击扫码登录微信</a>
      </div>
      
      <div id="userBox" style="display:none;">
        <p>👤 已登录: <strong id="userName"></strong></p>
      </div>
    </div>

    <div id="alertBox" class="alert"></div>

    <div class="card">
      <h2>📋 群配置</h2>
      <div id="roomsList"></div>
      <button class="btn btn-secondary" onclick="addRoom()">+ 添加群</button>
    </div>

    <div class="card">
      <h2>⏰ 提醒时间</h2>
      <label>每天提醒时间</label>
      <div class="time-inputs">
        <input type="number" id="reminderHour" min="0" max="23" value="10">
        <span>:</span>
        <input type="number" id="reminderMinute" min="0" max="59" value="0">
      </div>
      <p class="hint">24小时制，例如：10:00 表示早上10点</p>
    </div>

    <div class="card">
      <h2>📁 每日目标文件数</h2>
      <label>所有群的默认目标数量</label>
      <input type="number" id="defaultTarget" min="1" value="5" placeholder="每天需要提交的文件数">
      <p class="hint">如果在群配置中单独设置了数量，会优先使用单独设置的值</p>
    </div>

    <div class="btn-group">
      <button class="btn btn-success" onclick="saveAll()">💾 保存配置</button>
      <button class="btn btn-primary" onclick="testReminder()">🔔 测试提醒</button>
    </div>
  </div>

  <script>
    let config = {};

    // 加载配置
    async function loadConfig() {
      const res = await fetch('/api/config');
      config = await res.json();
      renderConfig();
    }

    // 渲染配置
    function renderConfig() {
      // 群列表
      const roomsList = document.getElementById('roomsList');
      roomsList.innerHTML = '';
      
      config.monitorRooms = config.monitorRooms || [];
      config.dailyTargets = config.dailyTargets || {};
      
      config.monitorRooms.forEach((room, index) => {
        const target = config.dailyTargets[room] || 3;
        const div = document.createElement('div');
        div.className = 'room-item';
        div.innerHTML = \`
          <input type="text" value="\${room}" placeholder="群名称" onchange="updateRoom(\${index}, 'name', this.value)">
          <input type="number" value="\${target}" min="1" placeholder="目标" onchange="updateRoom(\${index}, 'target', this.value)">
          <button class="btn btn-danger" onclick="removeRoom(\${index})">删除</button>
        \`;
        roomsList.appendChild(div);
      });

      // 时间
      if (config.reminderTimes && config.reminderTimes.length > 0) {
        document.getElementById('reminderHour').value = config.reminderTimes[0].hour || 10;
        document.getElementById('reminderMinute').value = config.reminderTimes[0].minute || 0;
      }

      // 默认目标数量
      document.getElementById('defaultTarget').value = config.dailyTargets['default'] || 5;
    }

    // 添加群
    function addRoom() {
      config.monitorRooms.push('');
      renderConfig();
    }

    // 更新群
    function updateRoom(index, field, value) {
      if (field === 'name') {
        const oldName = config.monitorRooms[index];
        const oldTarget = config.dailyTargets[oldName];
        delete config.dailyTargets[oldName];
        config.monitorRooms[index] = value;
        if (oldTarget) {
          config.dailyTargets[value] = oldTarget;
        }
      } else if (field === 'target') {
        const roomName = config.monitorRooms[index];
        config.dailyTargets[roomName] = parseInt(value) || 3;
      }
    }

    // 删除群
    function removeRoom(index) {
      const roomName = config.monitorRooms[index];
      delete config.dailyTargets[roomName];
      config.monitorRooms.splice(index, 1);
      renderConfig();
    }

    // 保存配置
    async function saveAll() {
      // 收集配置
      config.reminderTimes = [{
        hour: parseInt(document.getElementById('reminderHour').value) || 10,
        minute: parseInt(document.getElementById('reminderMinute').value) || 0
      }];
      
      // 默认目标数量
      config.dailyTargets = config.dailyTargets || {};
      config.dailyTargets['default'] = parseInt(document.getElementById('defaultTarget').value) || 5;
      
      // 过滤空群名
      config.monitorRooms = config.monitorRooms.filter(r => r.trim());

      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });

      if (res.ok) {
        showAlert('配置已保存！', 'success');
      } else {
        showAlert('保存失败', 'error');
      }
    }

    // 测试提醒
    async function testReminder() {
      const res = await fetch('/api/test-reminder', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showAlert('测试提醒已发送！', 'success');
      } else {
        showAlert('发送失败: ' + data.error, 'error');
      }
    }

    // 显示提示
    function showAlert(message, type) {
      const alertBox = document.getElementById('alertBox');
      alertBox.textContent = message;
      alertBox.className = 'alert alert-' + type;
      alertBox.style.display = 'block';
      setTimeout(() => { alertBox.style.display = 'none'; }, 3000);
    }

    // 更新状态
    async function updateStatus() {
      const res = await fetch('/api/status');
      const data = await res.json();
      
      const badge = document.getElementById('statusBadge');
      const statusText = document.getElementById('statusText');
      const qrcodeBox = document.getElementById('qrcodeBox');
      const qrcodeLink = document.getElementById('qrcodeLink');
      const userBox = document.getElementById('userBox');
      const userName = document.getElementById('userName');
      
      badge.className = 'status';
      qrcodeBox.style.display = 'none';
      userBox.style.display = 'none';
      
      if (data.status === 'logged_in') {
        badge.classList.add('online');
        statusText.textContent = '已登录';
        userBox.style.display = 'block';
        userName.textContent = data.user;
      } else if (data.status === 'waiting_scan') {
        badge.classList.add('waiting');
        statusText.textContent = '等待扫码';
        qrcodeBox.style.display = 'block';
        qrcodeLink.href = data.qrcode;
      } else {
        badge.classList.add('offline');
        statusText.textContent = '未连接';
      }
    }

    // 初始化
    loadConfig();
    updateStatus();
    setInterval(updateStatus, 3000);
  </script>
</body>
</html>
`;

// 创建 HTTP 服务器
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // API 路由
  if (pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: botStatus,
      qrcode: qrcodeUrl,
      user: loginUser
    }));
    return;
  }
  
  if (pathname === '/api/config') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadConfig()));
      return;
    }
    
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const newConfig = JSON.parse(body);
          const currentConfig = loadConfig();
          saveConfig({ ...currentConfig, ...newConfig });
          updateScheduledJobs();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }
  
  if (pathname === '/api/test-reminder' && req.method === 'POST') {
    if (botStatus !== 'logged_in') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '机器人未登录' }));
      return;
    }
    
    const config = loadConfig();
    if (config.monitorRooms.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '未配置群' }));
      return;
    }
    
    try {
      const roomName = config.monitorRooms[0];
      const room = await bot.Room.find({ topic: roomName });
      if (room) {
        await sendReminder(room, roomName);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `未找到群: ${roomName}` }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }
  
  // 默认返回 HTML
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlPage);
});

// 启动
const PORT = 3000;
server.listen(PORT, () => {
  log('info', `配置界面已启动: http://localhost:${PORT}`);
  startBot();
});

process.on('SIGINT', () => {
  log('info', '正在关闭...');
  process.exit(0);
});
