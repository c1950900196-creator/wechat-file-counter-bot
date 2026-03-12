/**
 * 微信群文件统计机器人
 * 功能：自动统计微信群内的文件数量，不达标时自动提醒
 */

const { WechatyBuilder, Message } = require('wechaty');
const schedule = require('node-schedule');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// 数据文件路径
const DATA_FILE = path.join(__dirname, 'data', 'records.json');

// 确保数据目录存在
const dataDir = path.dirname(DATA_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
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

// 日志函数
function log(level, message) {
  const levels = ['debug', 'info', 'warn', 'error'];
  const configLevel = levels.indexOf(config.logLevel);
  const msgLevel = levels.indexOf(level);
  
  if (msgLevel >= configLevel) {
    const timestamp = new Date().toLocaleString('zh-CN');
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
  }
}

// 获取今天的日期字符串
function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

// 获取群的目标文件数量
function getTargetCount(roomName) {
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

// 发送提醒消息
async function sendReminder(room, roomName) {
  const roomId = room.id;
  const count = getTodayFileCount(roomId);
  const target = getTargetCount(roomName);
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

// 主程序
async function main() {
  log('info', '正在启动微信文件统计机器人...');
  
  const bot = WechatyBuilder.build({
    name: 'file-counter-bot',
    puppet: 'wechaty-puppet-wechat',
  });

  // 登录事件
  bot.on('login', async (user) => {
    log('info', `登录成功: ${user.name()}`);
    
    // 设置定时提醒任务
    for (const time of config.reminderTimes) {
      const cronExpression = `${time.minute} ${time.hour} * * *`;
      
      schedule.scheduleJob(cronExpression, async () => {
        log('info', `执行定时提醒任务: ${time.hour}:${time.minute}`);
        
        for (const roomName of config.monitorRooms) {
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
      
      log('info', `已设置定时提醒: 每天 ${time.hour}:${String(time.minute).padStart(2, '0')}`);
    }
  });

  // 登出事件
  bot.on('logout', (user) => {
    log('warn', `已登出: ${user.name()}`);
  });

  // 扫码事件
  bot.on('scan', (qrcode, status) => {
    const qrcodeUrl = `https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`;
    log('info', `请扫描二维码登录: ${qrcodeUrl}`);
    console.log('\n========================================');
    console.log('请用微信扫描以下链接中的二维码:');
    console.log(qrcodeUrl);
    console.log('========================================\n');
  });

  // 消息事件
  bot.on('message', async (message) => {
    // 忽略自己的消息
    if (message.self()) return;
    
    const room = message.room();
    if (!room) return; // 只处理群消息
    
    const roomName = await room.topic();
    
    // 检查是否是监控的群
    if (!config.monitorRooms.includes(roomName)) return;
    
    const sender = message.talker();
    const senderName = sender.name();
    const messageType = message.type();
    
    // 检查消息类型
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
    
    // 记录文件
    if (isCountable) {
      recordFile(room.id, roomName, sender.id, senderName, fileName, fileType);
      
      // 发送确认消息（如果配置了）
      if (config.messages.fileReceived) {
        const count = getTodayFileCount(room.id);
        const target = getTargetCount(roomName);
        const data = { count, target };
        const replyMsg = formatMessage(config.messages.fileReceived, data);
        await room.say(replyMsg);
      }
    }
    
    // 处理查询关键词
    if (messageType === Message.Type.Text) {
      const text = message.text().trim();
      
      if (config.queryKeywords.includes(text)) {
        const count = getTodayFileCount(room.id);
        const target = getTargetCount(roomName);
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

  // 错误处理
  bot.on('error', (error) => {
    log('error', `机器人错误: ${error.message}`);
  });

  // 启动机器人
  await bot.start();
  log('info', '机器人已启动，等待扫码登录...');
}

// 优雅退出
process.on('SIGINT', () => {
  log('info', '正在关闭机器人...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('info', '正在关闭机器人...');
  process.exit(0);
});

// 启动
main().catch((error) => {
  log('error', `启动失败: ${error.message}`);
  console.error(error);
  process.exit(1);
});
