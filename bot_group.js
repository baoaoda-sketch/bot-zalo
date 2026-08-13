const { Zalo, ThreadType, AvatarSize } = require('zca-js');
const fs = require('fs');
const path = require('path');
const LINK_WARNINGS_PATH = path.join(__dirname, 'link_warnings.json');
const axios = require('axios');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
require('dotenv').config();

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const PLATFORM_ACCOUNTS_PATH = path.join(__dirname, 'platform_accounts.json');
const USER_BALANCES_PATH = path.join(__dirname, 'user_balances.json');
const platformAutomation = require('./platform_automation');
const userStates = {}; // key: `${threadId}_${userId}` -> state object
const sentMessages = new Set(); // Theo dõi tin nhắn bot tự gửi để tránh tự lặp

let userBalances = {};
if (fs.existsSync(USER_BALANCES_PATH)) {
    try {
        userBalances = JSON.parse(fs.readFileSync(USER_BALANCES_PATH, 'utf8'));
    } catch (e) {
        userBalances = {};
    }
}

function getUserBalance(userId, name = 'Người dùng') {
    if (!userBalances[userId]) {
        userBalances[userId] = { balance: 10000, name: name };
    }
    return userBalances[userId];
}

function saveUserBalances() {
    try {
        fs.writeFileSync(USER_BALANCES_PATH, JSON.stringify(userBalances, null, 2), 'utf8');
    } catch (e) {}
}

function formatVnd(val) {
    return Number(val).toLocaleString('vi-VN') + 'đ';
}

function safeEvaluateMathGroup(expression) {
    if (!expression || typeof expression !== 'string') return null;
    let clean = expression.trim().toLowerCase();

    clean = clean.replace(/(\d+)\^(\d+)/g, 'Math.pow($1,$2)');
    clean = clean.replace(/sqrt\(([^)]+)\)/g, 'Math.sqrt($1)');
    clean = clean.replace(/abs\(([^)]+)\)/g, 'Math.abs($1)');
    clean = clean.replace(/floor\(([^)]+)\)/g, 'Math.floor($1)');
    clean = clean.replace(/ceil\(([^)]+)\)/g, 'Math.ceil($1)');
    clean = clean.replace(/round\(([^)]+)\)/g, 'Math.round($1)');
    clean = clean.replace(/\bpi\b/g, 'Math.PI');
    clean = clean.replace(/\be\b/g, 'Math.E');

    if (!/^[0-9+\-*/%^().,\s Math\.powsqrabsflocirundPIE]+$/i.test(clean)) {
        throw new Error('Biểu thức chứa ký tự hoặc hàm không được hỗ trợ!');
    }

    try {
        const fn = new Function('Math', `return (${clean});`);
        const result = fn(Math);
        if (typeof result !== 'number' || isNaN(result) || !isFinite(result)) {
            throw new Error('Kết quả tính toán không xác định (NaN / Infinity)');
        }
        return result;
    } catch (e) {
        throw new Error(`Lỗi tính toán: ${e.message}`);
    }
}


async function sendBotMessage(api, content, threadId, type) {
    let msgText = "";
    if (typeof content === "string") {
        msgText = content;
    } else if (content && typeof content === "object" && typeof content.msg === "string") {
        msgText = content.msg;
    }
    if (msgText) {
        sentMessages.add(msgText.trim());
    }
    return api.sendMessage(content, threadId, type);
}

const BANNED_USERS_PATH = path.join(__dirname, 'banned_users.json');
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const HUGGING_FACE_API_KEY = process.env.HUGGING_FACE_API_KEY || process.env.HF_API_KEY || '';
const HUGGING_FACE_IMAGE_MODEL = process.env.HF_IMAGE_MODEL || 'stabilityai/stable-diffusion-xl-base-1.0';
const ENABLED_CHATS_PATH = path.join(__dirname, 'enabled_chats.json');
const enabledThreads = new Set();

if (fs.existsSync(ENABLED_CHATS_PATH)) {
    try {
        const data = JSON.parse(fs.readFileSync(ENABLED_CHATS_PATH, 'utf8'));
        if (Array.isArray(data)) {
            data.forEach(id => enabledThreads.add(id));
        }
    } catch (e) {
        console.error("Lỗi đọc file enabled_chats.json:", e.message);
    }
}

function saveEnabledChats() {
    try {
        fs.writeFileSync(ENABLED_CHATS_PATH, JSON.stringify(Array.from(enabledThreads), null, 2), 'utf8');
    } catch (e) {
        console.error("Lỗi ghi file enabled_chats.json:", e.message);
    }
}

const ANTILINK_STATUS_PATH = path.join(__dirname, 'antilink_status.json');
const ALLOWED_LINK_USERS_PATH = path.join(__dirname, 'link_allowed_users.json');
const antilinkThreads = new Set();
const allowedLinkUsersByThread = new Map();

if (fs.existsSync(ANTILINK_STATUS_PATH)) {
    try {
        const data = JSON.parse(fs.readFileSync(ANTILINK_STATUS_PATH, 'utf8'));
        if (Array.isArray(data)) {
            data.forEach(id => antilinkThreads.add(id));
        }
    } catch (e) {
        console.error("Lỗi đọc file antilink_status.json:", e.message);
    }
}

function saveAntilinkStatus() {
    try {
        fs.writeFileSync(ANTILINK_STATUS_PATH, JSON.stringify(Array.from(antilinkThreads), null, 2), 'utf8');
    } catch (e) {
        console.error("Lỗi ghi file antilink_status.json:", e.message);
    }
}

function loadAllowedLinkUsers() {
    if (!fs.existsSync(ALLOWED_LINK_USERS_PATH)) {
        return;
    }

    try {
        const data = JSON.parse(fs.readFileSync(ALLOWED_LINK_USERS_PATH, 'utf8'));
        if (data && typeof data === 'object') {
            Object.entries(data).forEach(([threadId, userIds]) => {
                if (Array.isArray(userIds)) {
                    allowedLinkUsersByThread.set(String(threadId), new Set(userIds.filter(Boolean).map(String)));
                }
            });
        }
    } catch (e) {
        console.error("Lỗi đọc file link_allowed_users.json:", e.message);
    }
}

function saveAllowedLinkUsers() {
    try {
        const payload = {};
        allowedLinkUsersByThread.forEach((userIds, threadId) => {
            payload[String(threadId)] = Array.from(userIds);
        });
        fs.writeFileSync(ALLOWED_LINK_USERS_PATH, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
        console.error("Lỗi ghi file link_allowed_users.json:", e.message);
    }
}

function getAllowedLinkUsersForThread(threadId) {
    const key = String(threadId);
    if (!allowedLinkUsersByThread.has(key)) {
        allowedLinkUsersByThread.set(key, new Set());
    }
    return allowedLinkUsersByThread.get(key);
}

function addAllowedLinkUser(threadId, userId) {
    if (!threadId || !userId) return false;
    const userIds = getAllowedLinkUsersForThread(threadId);
    userIds.add(String(userId));
    return true;
}

function isAllowedLinkUser(threadId, userId) {
    if (!threadId || !userId) return false;
    const userIds = allowedLinkUsersByThread.get(String(threadId));
    return !!userIds && userIds.has(String(userId));
}

function extractMentionedUserId(rawText = '', mentions = []) {
    if (Array.isArray(mentions) && mentions.length > 0) {
        for (const mention of mentions) {
            if (mention && (mention.uid || mention.userId)) {
                return String(mention.uid || mention.userId);
            }
        }
    }

    const match = (rawText || '').match(/@([^\s]+)/);
    return match ? match[1].trim() : '';
}

loadAllowedLinkUsers();

let bannedUsers = new Set();
if (fs.existsSync(BANNED_USERS_PATH)) {
    try {
        const data = JSON.parse(fs.readFileSync(BANNED_USERS_PATH, 'utf8'));
        if (Array.isArray(data)) {
            bannedUsers = new Set(data);
        }
    } catch (e) {
        console.error("Lỗi đọc file banned_users.json:", e.message);
    }
}

function saveBannedUsers() {
    try {
        fs.writeFileSync(BANNED_USERS_PATH, JSON.stringify(Array.from(bannedUsers), null, 2), 'utf8');
    } catch (e) {
        console.error("Lỗi ghi file banned_users.json:", e.message);
    }
}

// 🔗 LƯU TRỮ VÀ QUẢN LÝ CẢNH CÁO LINK
let linkWarnings = [];
if (fs.existsSync(LINK_WARNINGS_PATH)) {
    try {
        const data = JSON.parse(fs.readFileSync(LINK_WARNINGS_PATH, 'utf8'));
        if (Array.isArray(data)) {
            linkWarnings = data;
        }
    } catch (e) {
        console.error("Lỗi đọc file link_warnings.json:", e.message);
    }
}

function saveLinkWarnings() {
    try {
        fs.writeFileSync(LINK_WARNINGS_PATH, JSON.stringify(linkWarnings, null, 2), 'utf8');
    } catch (e) {
        console.error("Lỗi ghi file link_warnings.json:", e.message);
    }
}

// Hàm kiểm tra tin nhắn có chứa link không (cơ bản)
function containsLink(text) {
    // Biểu thức chính quy phát hiện URL (http/https)
    const urlRegex = /https?:\/\/[^\s]+/i;
    // Phát hiện tên miền cơ bản (ví dụ.com, .vn, bit.ly, my-site.vn, zalo.me/g/abc)
    const domainRegex = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,6})\b(?:\/[^\s]*)?/i;
    
    return urlRegex.test(text) || domainRegex.test(text);
}

// Hàm xử lý vi phạm link
async function handleLinkViolation(api, threadId, userId, userName, messageType) {
    // Tìm xem user đã có trong danh sách cảnh cáo chưa
    let userWarning = linkWarnings.find(w => w.uid === userId);

    if (!userWarning) {
        // Lần vi phạm đầu tiên
        userWarning = { uid: userId, name: userName, count: 1 };
        linkWarnings.push(userWarning);
    } else {
        // Từ lần vi phạm thứ 2 trở đi
        userWarning.count += 1;
    }
    
    saveLinkWarnings(); // Lưu lại số lần vi phạm

    let warningMsg = `🚫 **ANTI-LINK DETECTED** 🚫\n@${userName} Ơ kìa! Nhóm cấm gửi link mà ní vẫn cố chấp á? 🤡\n\n`;

    if (userWarning.count === 1) {
        warningMsg += `⚠️ **Cảnh cáo lần 1:** Bớt nha! Gửi link nữa là bot cho bay màu á! 👁️👄👁️`;
    } else if (userWarning.count === 2) {
        warningMsg += `⚠️ **Cảnh cáo lần 2:** Lần cuối nha! Lần sau là bị kick khỏi nhóm ráng chịu đó! 😡`;
    } else if (userWarning.count >= 3) {
        warningMsg += `💀 **Cảnh cáo lần 3 (Vi phạm quá giới hạn):** Bye bye! Bot kick ní ra khỏi nhóm nè! 💅`;
    }

    await api.sendMessage({ msg: warningMsg, mentions: [{ uid: userId, pos: 0, len: userName.length + 1 }] }, threadId, messageType);

    // Thực hiện hành động kick nếu vi phạm lần 3 (chỉ áp dụng cho chat nhóm)
    if (userWarning.count >= 3 && messageType === ThreadType.Group) {
        setTimeout(async () => {
            try {
                // Kiểm tra quyền admin của bot trước khi kick (quan trọng)
                // ZCA-JS hiện tại không hỗ trợ kiểm tra quyền admin một cách dễ dàng,
                // nên bạn cần chắc chắn bot là quản trị viên để thực hiện lệnh này.
                if (typeof api.removeGroupMember === 'function') {
                    await api.removeGroupMember(userId, threadId);
                } else {
                    console.error("API removeGroupMember không khả dụng.");
                }
            } catch (err) {
                console.error("Lỗi khi kick thành viên:", err.message);
                api.sendMessage("❌ Không thể kick thành viên này! Có thể bot không phải là quản trị viên.", threadId, messageType);
            }
        }, 1500); // Đợi 1.5 giây sau cảnh báo rồi kick
    }
}

// 🐺 Lưu trạng thái game Ma Sói theo từng threadId
const werewolfGames = new Map();
const playerActiveGame = new Map();

function formatGroqPrompt(prompt) {
    return `Bạn là một trợ lý ảo siêu lầy lội, thân thiện và mặn mòi của nhóm chat. Hãy trả lời 100% bằng phong cách Gen Z Việt Nam cực kỳ tự nhiên.
Quy tắc trả lời:
- Xưng hô thân mật: dùng "ní", "mấy ní", "khứa", "bro", "fen", "ông/bà", "chị em".
- Sử dụng các từ lóng giới trẻ phổ biến: "vãi chưởng", "uy tín", "keo lỳ", "mãi mận", "xu cà na", "cứu cái", "flex", "over hợp", "thao túng tâm lý", "ố dề", "slay", "combat", "ét ô ét", "chê nha".
- Viết chữ kiểu teencode nhẹ hoặc viết thường toàn bộ, viết sai chính tả vui nhộn (z zậy, dthg, bít, j, thía, khum, mng, cóa, nà, rùi, chứ lị, á).
- Thêm nhiều emoji sinh động: 💀, 🤡, 👁️👄👁️, 😭, 😂, ✨, 💅, 🥺, 🔥.
- Trả lời cực kỳ ngắn gọn, dí dỏm, mang tính đùa vui, tránh giải thích dài dòng hay nghiêm túc như robot.

Yêu cầu của người dùng: ${prompt}`;
}

// Hàm gọi Groq AI
async function askGroq(prompt) {
    if (!GROQ_API_KEY) {
        return '⚠️ Bạn chưa cấu hình GROQ_API_KEY trong file .env.';
    }

    try {
        const groqPrompt = formatGroqPrompt(prompt);
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: groqPrompt }],
                temperature: 0.7,
                max_tokens: 400
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_API_KEY}`
                }
            }
        );

        return response?.data?.choices?.[0]?.message?.content || 'Groq không trả về câu trả lời phù hợp.';
    } catch (error) {
        console.error('Lỗi gọi Groq:', error.response?.data || error.message);
        return '❌ Hiện tại bot không thể kết nối Groq. Vui lòng thử lại sau.';
    }
}

function normalizePromptText(text) {
    return (text || '').trim().toLowerCase();
}

function removeImageCommandPrefix(text) {
    return (text || '').replace(/^(?:\/vẽ|vẽ|\/ve|ve|\/tạo ảnh|tạo ảnh|\/tao anh|tao anh|\/tạo hình|tạo hình|\/tạo bức|tạo bức)\s+/i, '').trim();
}

function translateVietnamesePrompt(text) {
    const mapping = {
        'mèo': 'cat',
        'chó': 'dog',
        'cô gái': 'girl',
        'con gái': 'girl',
        'con trai': 'boy',
        'phong cảnh': 'landscape',
        'biệt thự': 'villa',
        'lâu đài': 'castle',
        'thành phố': 'city',
        'hoàng hôn': 'sunset',
        'mặt trăng': 'moon',
        'bầu trời': 'sky',
        'hoa': 'flowers',
        'đẹp': 'beautiful',
        'dễ thương': 'cute',
        'ngầu': 'cool',
        'tinh tế': 'elegant',
        'nữ thần': 'goddess',
        'chibi': 'chibi',
        'phim hoạt hình': 'cartoon',
        'sơn dầu': 'oil painting',
        'phong cách': 'style',
        'siêu thực': 'surreal',
        'thực tế': 'realistic',
        'nhiếp ảnh': 'photography',
        'vector': 'vector art',
        'thủy mặc': 'ink wash painting',
        'fantasy': 'fantasy'
    };

    let result = text;
    Object.entries(mapping).forEach(([vi, en]) => {
        result = result.replace(new RegExp(`\\b${vi}\\b`, 'gi'), en);
    });
    return result;
}

function optimizeImagePrompt(text) {
    let prompt = removeImageCommandPrefix(text);
    prompt = translateVietnamesePrompt(prompt);
    prompt = prompt.replace(/\s+/g, ' ').trim();

    if (!prompt) {
        prompt = 'modern illustration';
    }

    const cartoonKeywords = ['chibi', 'cartoon', 'anime', 'manga', 'vector'];
    const photoKeywords = ['realistic', 'photorealistic', 'photo', 'portrait', 'landscape', 'cinematic', 'studio', 'real life'];
    const lowerPrompt = prompt.toLowerCase();
    const isCartoon = cartoonKeywords.some(k => lowerPrompt.includes(k));
    const isPhoto = photoKeywords.some(k => lowerPrompt.includes(k));

    if (isCartoon) {
        return `${prompt}, high quality cartoon illustration, vibrant colors, crisp line art, detailed shading, dynamic composition`;
    }

    if (isPhoto) {
        return `${prompt}, ultra realistic, high quality, professional photography, cinematic lighting, sharp details, 4k`;
    }

    return `${prompt}, ultra detailed, high quality, cinematic lighting, realistic textures, vibrant colors, sharp focus, 4k`;
}

async function generateImageFromHuggingFace(prompt) {
    const response = await axios.post(
        `https://api-inference.huggingface.co/models/${HUGGING_FACE_IMAGE_MODEL}`,
        {
            inputs: prompt,
            options: { wait_for_model: true },
            parameters: {
                width: 1024,
                height: 1024,
                guidance_scale: 7.5,
                num_inference_steps: 30
            }
        },
        {
            responseType: 'arraybuffer',
            headers: {
                Authorization: `Bearer ${HUGGING_FACE_API_KEY}`,
                'Content-Type': 'application/json'
            }
        }
    );

    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
        const json = JSON.parse(Buffer.from(response.data).toString('utf8'));
        throw new Error(json.error || JSON.stringify(json));
    }

    return Buffer.from(response.data);
}

// Hàm xử lý tương tác AI: hỗ trợ vẽ ảnh hoặc trả lời văn bản
async function handleAIInteraction(prompt, threadId, message, api) {
    const isImageRequest = (text) => {
        const lower = normalizePromptText(text);
        const prefixes = [
            '/vẽ ',
            'vẽ ',
            '/ve ',
            've ',
            '/tạo ảnh ',
            'tạo ảnh ',
            '/tao anh ',
            'tao anh ',
            '/tạo hình ',
            'tạo hình ',
            '/tạo bức ',
            'tạo bức '
        ];
        return prefixes.some(prefix => lower.startsWith(prefix));
    };

    if (isImageRequest(prompt)) {
        if (!HUGGING_FACE_API_KEY) {
            await api.sendMessage({ msg: '⚠️ Bot chưa cấu hình HUGGING_FACE_API_KEY. Vui lòng thiết lập biến môi trường HUGGING_FACE_API_KEY.', quote: message.data }, threadId, message.type);
            return;
        }

        try {
            await api.sendMessage({ msg: '🎨 Đang tạo ảnh AI chất lượng cao...', quote: message.data }, threadId, message.type);
            const optimizedPrompt = optimizeImagePrompt(prompt);
            let imageBuffer;

            try {
                imageBuffer = await generateImageFromHuggingFace(optimizedPrompt);
            } catch (hfError) {
                console.error('Hugging Face image error:', hfError.message);
                await api.sendMessage({ msg: '⚠️ Không thể tạo ảnh với Hugging Face. Đang thử bằng Pollinations tạm thời...', quote: message.data }, threadId, message.type);
                const fallbackUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(optimizedPrompt)}?width=1024&height=1024&nologo=true`;
                const fallbackResponse = await axios.get(fallbackUrl, { responseType: 'arraybuffer' });
                imageBuffer = Buffer.from(fallbackResponse.data);
            }

            const tempPath = path.join(__dirname, `ai_${Date.now()}.png`);
            fs.writeFileSync(tempPath, imageBuffer);

            await api.sendMessage({
                msg: `🎨 Ảnh vẽ của bạn cho yêu cầu: "${prompt}"`,
                attachments: tempPath
            }, threadId, message.type);

            fs.unlinkSync(tempPath);
        } catch (error) {
            console.error('Lỗi vẽ ảnh AI:', error.response?.data || error.message);
            await api.sendMessage({ msg: '❌ Đã xảy ra lỗi khi tạo ảnh. Vui lòng thử lại sau.', quote: message.data }, threadId, message.type);
        }
    } else {
        try {
            await api.sendMessage({ msg: '🤖 Đang suy nghĩ...', quote: message.data }, threadId, message.type);
            const reply = await askGroq(prompt);
            await api.sendMessage({ msg: reply, quote: message.data }, threadId, message.type);
        } catch (err) {
            console.error('Lỗi gửi tin AI:', err);
        }
    }
}

// Hàm vẽ hình trái tim trang trí
function drawHeart(ctx, x, y, width, height, color) {
    ctx.save();
    ctx.beginPath();
    const topCurveHeight = height * 0.3;
    ctx.moveTo(x, y + topCurveHeight);
    ctx.bezierCurveTo(x, y, x - width / 2, y, x - width / 2, y + topCurveHeight);
    ctx.bezierCurveTo(x - width / 2, y + (height + topCurveHeight) / 2, x, y + height, x, y + height);
    ctx.bezierCurveTo(x, y + height, x + width / 2, y + (height + topCurveHeight) / 2, x + width / 2, y + topCurveHeight);
    ctx.bezierCurveTo(x + width / 2, y, x, y, x, y + topCurveHeight);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
}

// Hàm vẽ ảnh và tạo thẻ độ dễ thương
async function generateCuteCard(avatarUrl, name, score) {
    const canvas = createCanvas(600, 400);
    const ctx = canvas.getContext('2d');

    // 1. Vẽ nền gradient hồng phấn - cam đào ngọt ngào
    const grad = ctx.createLinearGradient(0, 0, 600, 400);
    grad.addColorStop(0, '#ff9a9e');
    grad.addColorStop(0.5, '#fecfef');
    grad.addColorStop(1, '#ffc3a0');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 600, 400);

    // Vẽ các vòng tròn trang trí mờ tạo chiều sâu nghệ thuật
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.beginPath();
    ctx.arc(80, 80, 140, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(520, 320, 160, 0, Math.PI * 2);
    ctx.fill();

    // Vẽ vài trái tim bay bổng xung quanh nền
    drawHeart(ctx, 480, 80, 30, 30, 'rgba(255, 255, 255, 0.4)');
    drawHeart(ctx, 120, 320, 20, 20, 'rgba(255, 255, 255, 0.4)');
    drawHeart(ctx, 350, 50, 15, 15, 'rgba(255, 255, 255, 0.3)');

    // 2. Tải và vẽ Avatar người dùng tròn xoe lung linh
    let avatarImg;
    if (avatarUrl) {
        try {
            const response = await axios.get(avatarUrl, { responseType: 'arraybuffer' });
            avatarImg = await loadImage(Buffer.from(response.data));
        } catch (e) {
            console.error("Lỗi khi tải avatar từ URL:", e.message);
        }
    }

    const avatarX = 60;
    const avatarY = 100;
    const avatarSize = 200;

    // Viền phát sáng màu trắng cho avatar
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2 + 6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(255, 105, 180, 0.5)';
    ctx.shadowBlur = 15;
    ctx.fill();
    ctx.restore();

    // Cắt avatar thành hình tròn
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
    ctx.clip();
    if (avatarImg) {
        ctx.drawImage(avatarImg, avatarX, avatarY, avatarSize, avatarSize);
    } else {
        // Fallback màu sắc nếu không tải được avatar
        ctx.fillStyle = '#ffb3c6';
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 80px "DejaVu Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(name.charAt(0).toUpperCase(), avatarX + avatarSize / 2, avatarY + avatarSize / 2);
    }
    ctx.restore();

    // 3. Viết chữ thông tin ở phía bên phải
    const textX = 300;

    // Tên hiển thị
    ctx.fillStyle = '#4a4a4a';
    ctx.font = 'bold 28px "DejaVu Sans", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    // Đảm bảo tên không bị quá dài đè lên các phần khác
    let displayName = name;
    if (displayName.length > 15) displayName = displayName.slice(0, 15) + '...';
    ctx.fillText(displayName, textX, 110);

    // Nhãn "Độ dễ thương"
    ctx.fillStyle = '#7a7a7a';
    ctx.font = '500 18px "DejaVu Sans", sans-serif';
    ctx.fillText('Độ dễ thương của bạn:', textX, 155);

    // Con số phần trăm to nổi bật
    ctx.fillStyle = '#ff4d6d';
    ctx.font = 'bold 72px "DejaVu Sans", sans-serif';
    ctx.shadowColor = 'rgba(255, 77, 109, 0.3)';
    ctx.shadowBlur = 10;
    ctx.fillText(`${score}%`, textX, 185);
    ctx.shadowBlur = 0; // reset shadow

    // Nhận xét tương ứng với điểm số
    let comment = "Bình thường thui";
    let commentColor = "#ff758c";
    if (score >= 95) {
        comment = "Cực phẩm dễ thương!";
        commentColor = "#d90429";
    } else if (score >= 80) {
        comment = "Siêu cấp đáng yêu!";
        commentColor = "#ef233c";
    } else if (score >= 60) {
        comment = "Rất cute nha!";
        commentColor = "#ff4d6d";
    } else if (score >= 40) {
        comment = "Cũng dễ nhìn đó chứ";
        commentColor = "#ff758c";
    } else if (score >= 20) {
        comment = "Hơi hơi thiếu cute xíu";
        commentColor = "#ffb3c6";
    } else {
        comment = "Cần nạp thêm vitamin cute";
        commentColor = "#8d99ae";
    }

    ctx.fillStyle = commentColor;
    ctx.font = 'italic bold 22px "DejaVu Sans", sans-serif';
    ctx.fillText(comment, textX, 275);

    // Vẽ thêm 1 trái tim nhỏ xinh xắn cạnh nhận xét
    drawHeart(ctx, textX + ctx.measureText(comment).width + 25, 288, 16, 16, commentColor);

    return canvas.toBuffer('image/png');
}

// Hàm vẽ ảnh thẻ đo độ Gay chuẩn giao diện mẫu
// Hàm vẽ ảnh thẻ đo độ Gay an toàn tuyệt đối, không bị lỗi vặt
async function generateGayCard(avatarUrl, name, score) {
    const canvas = createCanvas(700, 450);
    const ctx = canvas.getContext('2d');

    // 1. Nền tối tổng thể và khung thẻ
    ctx.fillStyle = '#0f0e17';
    ctx.fillRect(0, 0, 700, 450);

    ctx.fillStyle = '#1e1b2e';
    ctx.fillRect(30, 25, 640, 400);

    // 2. Vẽ Tên đổi màu cầu vồng từng chữ cái
    const nameX = 260;
    const nameY = 55;
    ctx.font = 'bold 38px "DejaVu Sans", sans-serif';
    ctx.textBaseline = 'top';

    const colors = ['#ff4d4d', '#ffa500', '#ffff00', '#00e676', '#00b0ff', '#9c27b0'];
    let currentX = nameX;
    for (let i = 0; i < (name || 'User').length; i++) {
        ctx.fillStyle = colors[i % colors.length];
        const char = name[i];
        ctx.fillText(char, currentX, nameY);
        currentX += ctx.measureText(char).width;
    }

    // 3. Dòng giới tính
    ctx.font = 'bold 22px "DejaVu Sans", sans-serif';
    ctx.fillStyle = '#cccccc';
    ctx.fillText('Giới tính: ', nameX, nameY + 55);
    const genderLabelWidth = ctx.measureText('Giới tính: ').width;

    ctx.fillStyle = '#00bfff';
    ctx.fillText('Nam ♂', nameX + genderLabelWidth, nameY + 55);

    // 4. Nhãn "Mức độ Gay:"
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px "DejaVu Sans", sans-serif';
    ctx.fillText('Mức độ Gay:', nameX, nameY + 105);

    // 5. Thanh tiến trình phần trăm
    const barX = nameX;
    const barY = nameY + 145;
    const barWidth = 240;
    const barHeight = 22;

    ctx.fillStyle = '#333045';
    ctx.fillRect(barX, barY, barWidth, barHeight);

    const filledWidth = Math.max(20, (barWidth * score) / 100);
    ctx.fillStyle = '#ff0055';
    ctx.fillRect(barX, barY, filledWidth, barHeight);

    // 6. Con số phần trăm
    ctx.fillStyle = '#00ffff';
    ctx.font = 'bold 42px "DejaVu Sans", sans-serif';
    ctx.fillText(`${score}%`, barX + barWidth + 25, barY - 10);

    // 7. Phần Nhận xét
    let comment = "Có những cử chỉ thân mật hơi quá trớn với bạn đồng giới.";
    if (score >= 90) comment = "Đích thực là chúa tể cầu vồng!";
    else if (score >= 70) comment = "Thẳng như cọng bún thiu!";
    else if (score >= 50) comment = "Tâm hồn hướng ngoại nhưng hệ điều hành hơi rén.";
    else if (score <= 20) comment = "Trai thẳng tuyệt đối, không có cửa bẻ cong!";

    ctx.font = 'bold 18px "DejaVu Sans", sans-serif';
    ctx.fillStyle = '#ffcc00';
    ctx.fillText('Nhận xét: ', nameX, barY + 55);
    const commentLabelW = ctx.measureText('Nhận xét: ').width;

    ctx.fillStyle = '#ffffff';
    ctx.font = '16px "DejaVu Sans", sans-serif';
    ctx.fillText(comment, nameX, barY + 90);

    // 8. Tải và vẽ Avatar tròn phía bên trái
    let avatarImg;
    if (avatarUrl) {
        try {
            const response = await axios.get(avatarUrl, { responseType: 'arraybuffer' });
            avatarImg = await loadImage(Buffer.from(response.data));
        } catch (e) {
            console.error("Lỗi tải avatar:", e.message);
        }
    }

    const avatX = 65;
    const avatY = 110;
    const avatSize = 180;

    // Viền trắng ngoài avatar
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(avatX + avatSize / 2, avatY + avatSize / 2, avatSize / 2 + 4, 0, Math.PI * 2);
    ctx.fill();

    // Cắt và vẽ ảnh Avatar tròn
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatX + avatSize / 2, avatY + avatSize / 2, avatSize / 2, 0, Math.PI * 2);
    ctx.clip();
    if (avatarImg) {
        ctx.drawImage(avatarImg, avatX, avatY, avatSize, avatSize);
    } else {
        ctx.fillStyle = '#333';
        ctx.fillRect(avatX, avatY, avatSize, avatSize);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 60px "DejaVu Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((name || 'U').charAt(0).toUpperCase(), avatX + avatSize / 2, avatY + avatSize / 2);
    }
    ctx.restore();

    return canvas.toBuffer('image/png');
}

async function generateMenuCard(category = 'all') {
    const menus = {
        all: {
            title: '📋 MENU BOT TỔNG HỢP',
            colors: ['#1e1b4b', '#312e81', '#4338ca'],
            accent: '#f59e0b',
            subtitle: 'Các nhóm danh mục menu chính:',
            items: [
                '1️⃣ /menu mxh       : Quản lý TikTok DM Streak, Session Cookie, Acc MXH',
                '2️⃣ /menu minigame  : Game Bầu Cua, Slot Machine, Tài Xỉu, Bank, Điểm danh',
                '3️⃣ /menu basic     : Lệnh AI (Groq, GPT, DeepSeek), Calc, Thông tin cá nhân',
                '4️⃣ /menu giaitri   : Ảnh/Video Girl/Boy/Anime, Bói vui cute/gay/rich',
                '5️⃣ /menu quanlybox : Bật/Tắt bot, Chống link rác, Ban/Unban member',
                '',
                '👉 Cú pháp mẫu: /menu minigame hoặc /menu mxh'
            ]
        },
        mxh: {
            title: '📱 MENU TỰ ĐỘNG HÓA MXH & TIKTOK',
            colors: ['#0f172a', '#1e293b', '#334155'],
            accent: '#38bdf8',
            subtitle: 'Các lệnh quản lý tài khoản & tự động hóa TikTok:',
            items: [
                '🔥 /streak [nick] hoặc /thapluatiktok [nick] : Thắp lửa chuỗi DM TikTok ngầm',
                '💬 /repchuoi <nick>                         : Thắp lửa cho 1 tài khoản TikTok',
                '📱 /acc list (hoặc /acc ds)                : Xem danh sách tài khoản MXH',
                '➕ /acc add <plat> <nick> <user> [pass]     : Thêm tài khoản MXH mới',
                '❌ /acc del <plat> <nick>                   : Xóa tài khoản MXH khỏi hệ thống',
                '🔍 /acc check <nick>                        : Kiểm tra trạng thái & session',
                '📋 /session list                           : Xem danh sách cookie đã nạp',
                '📥 /session import <nick> <sessionid>      : Nạp cookie sessionid cho TikTok',
                '🔍 /session check <email>                   : Kiểm tra cookie còn sống không',
                '🗑️ /session clear <email>                   : Xóa sessionid đã nạp',
                '🔑 /otp <mã_6_số>                           : Nhập mã xác minh 2FA Google'
            ]
        },
        minigame: {
            title: '🎲 MENU MINI GAME & TÀI CHÍNH',
            colors: ['#2e1065', '#3b0764', '#581c87'],
            accent: '#fbbf24',
            subtitle: 'Các trò chơi giải trí & quản lý tài chính:',
            items: [
                '🎲 /baucua [bau|cua|tom|ca|ga|nai] [tiền] : Game Bầu Cua 6 con (X1, X2, X3)',
                '🎰 /slot [số_tiền]                      : Slot Machine (Thưởng X2, X5, Nổ Hũ X10)',
                '🎲 /taixiu [tai|xiu] [số_tiền]          : Chơi Tài Xỉu',
                '🎲 /chanle [chan|le] [số_tiền]          : Chơi Chẵn Lẻ',
                '🎁 /daily                               : Điểm danh nhận 5.000đ mỗi 24h',
                '💳 /bank                                : Thông tin tài khoản ngân hàng & số dư',
                '💵 /nap [số_tiền]                       : Nạp tiền vào tài khoản',
                '💸 /rut [số_tiền]                       : Rút tiền từ tài khoản',
                '🔄 /chuyen [user_id] [số_tiền]          : Chuyển tiền cho người chơi khác'
            ]
        },
        basic: {
            title: '🛠️ MENU CƠ BẢN, AI & TIỆN ÍCH',
            colors: ['#064e3b', '#047857', '#059669'],
            accent: '#a7f3d0',
            subtitle: 'Các lệnh trợ lý AI, thông tin & tính toán:',
            items: [
                '❓ /help / /menu                        : Xem hướng dẫn menu bot',
                '👤 /info / /profile                     : Xem thông tin tài khoản & số dư',
                '🤖 /groq [câu_hỏi] / /gemini            : Hỏi đáp AI Groq Llama-3.3 70B',
                '🤖 /gpt [câu_hỏi]                       : Hỏi đáp OpenAI GPT-4o Mini',
                '🤖 /deepseek [câu_hỏi]                  : Hỏi đáp DeepSeek AI',
                '🤖 /ai [câu_hỏi]                        : Hỏi đáp nhanh với AI mặc định',
                '🔢 /calc [biểu_thức]                    : Tính toán đại số an toàn (VD: sqrt(144)+2^5)',
                '🕒 /time / /date / /weather             : Thời gian & thời tiết hiện tại'
            ]
        },
        giaitri: {
            title: '🎉 MENU GIẢI TRÍ & MEDIA',
            colors: ['#831843', '#9d174d', '#be185d'],
            accent: '#f472b6',
            subtitle: 'Ảnh/Video media và trò chơi bói vui nhộn:',
            items: [
                '🖼️ /girl / /boy / /anime                : Xem ảnh ngẫu nhiên theo chủ đề',
                '🎥 /vdgirl / /vdboy                     : Xem video ngẫu nhiên theo chủ đề',
                '🥰 /cute [@tag]                         : Kiểm tra độ dễ thương',
                '🌈 /gay [@tag]                          : Kiểm tra độ gay vui nhộn',
                '💥 /dam / /rich / /check / /lo / /moc   : Kiểm tra các chỉ số bói vui',
                '😄 /joke                                : Kể câu nói đùa hài hước',
                '💡 /fact                                : Sự thật ngẫu nhiên thú vị'
            ]
        },
        quanlybox: {
            title: '🛡️ MENU QUẢN LÝ NHÓM (BOX)',
            colors: ['#1e3a8a', '#1d4ed8', '#2563eb'],
            accent: '#60a5fa',
            subtitle: 'Lệnh quản trị nhóm & bảo vệ an toàn:',
            items: [
                '🟢 /on / 🔴 /off                         : Bật / Tắt bot trong nhóm chat',
                '🛡️ /baove [on|off]                      : Bật/Tắt bảo vệ nhóm chống link rác/lừa đảo',
                '📋 /list / /trangthai                   : Danh sách các nhóm và trạng thái bảo vệ',
                '🗳️ /vote [lý_do]                        : Tạo cuộc bình chọn duyệt bài/nội dung',
                '⏭️ /skip                                : Bỏ qua nội dung bình chọn',
                '🚫 ?ban @user / ?unban @user            : Chặn / Bỏ chặn thành viên (Quyền bot/admin)'
            ]
        }
    };

    const targetKey = category.toLowerCase();
    const targetMenu = menus[targetKey] || menus.all;
    const items = targetMenu.items;

    const cardHeight = Math.max(480, 175 + items.length * 34);
    const canvas = createCanvas(820, cardHeight);
    const ctx = canvas.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 820, cardHeight);
    grad.addColorStop(0, targetMenu.colors[0]);
    grad.addColorStop(0.5, targetMenu.colors[1]);
    grad.addColorStop(1, targetMenu.colors[2]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 820, cardHeight);

    ctx.fillStyle = targetMenu.accent;
    ctx.fillRect(0, 0, 820, 8);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px "DejaVu Sans", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(targetMenu.title, 40, 52);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(30, 75, 760, cardHeight - 115);

    ctx.fillStyle = targetMenu.accent;
    ctx.font = 'bold 18px "DejaVu Sans", sans-serif';
    ctx.fillText(targetMenu.subtitle, 50, 110);

    let y = 150;
    items.forEach(line => {
        if (!line.trim()) {
            y += 12;
            return;
        }
        ctx.fillStyle = line.startsWith('👉') || line.startsWith('💡') ? targetMenu.accent : '#f8fafc';
        ctx.font = line.startsWith('👉') || line.startsWith('💡') ? 'italic 16px "DejaVu Sans", sans-serif' : '15px "DejaVu Sans", sans-serif';
        ctx.fillText(line, 55, y);
        y += 32;
    });

    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.font = 'italic 14px "DejaVu Sans", sans-serif';
    ctx.fillText('🤖 Bot Zalo OA & TikTok Automation System | Node.js', 50, cardHeight - 20);

    return canvas.toBuffer('image/png');
}

// Hàm phụ trợ để lấy thông tin profile của một user từ ID
async function getUserProfile(api, userId) {
    try {
        const userInfo = await api.getUserInfo(userId, AvatarSize.Large);
        const profiles = Object.values(userInfo?.changed_profiles || {});
        if (profiles.length > 0) {
            return {
                displayName: profiles[0].displayName || profiles[0].zaloName || "Người dùng",
                avatar: profiles[0].avatar
            };
        }
    } catch (error) {
        console.error("Lỗi khi lấy thông tin người dùng:", error.message);
    }
    return null;
}


// Hàm lấy thông tin ảnh để Zalo gửi đi (yêu cầu từ v2.0.0 của zca-js)
async function imageMetadataGetter(filePath) {
    try {
        const data = fs.readFileSync(filePath);
        const img = await loadImage(data);
        return {
            height: img.height,
            width: img.width,
            size: data.length,
        };
    } catch (err) {
        console.error("Lỗi lấy metadata ảnh:", err);
        return { height: 1024, width: 1024, size: 0 };
    }
}

/**
 * Hàm trích xuất URL hình ảnh từ một tin nhắn Zalo hoặc tin nhắn được trích dẫn (quote).
 * Hỗ trợ lấy từ tin nhắn ảnh (chat.photo) trực tiếp hoặc gián tiếp.
 */
function getMessageImage(message) {
    // 1. Lấy trực tiếp từ tin nhắn hiện tại nếu là ảnh
    if (message.data && message.data.msgType === "chat.photo") {
        if (message.data.content && typeof message.data.content === "object") {
            return message.data.content.href || message.data.content.oriUrl || message.data.content.normalUrl || message.data.content.thumb;
        }
    }
    
    // 2. Lấy từ tin nhắn được phản hồi (quoted message) nếu tin nhắn đó chứa ảnh
    if (message.data && message.data.quote) {
        const quote = message.data.quote;
        if (quote.attach) {
            try {
                const attachData = JSON.parse(quote.attach);
                return attachData.href || attachData.oriUrl || attachData.normalUrl || attachData.thumb;
            } catch (e) {
                if (typeof quote.attach === "string" && quote.attach.startsWith("http")) {
                    return quote.attach;
                }
            }
        }
    }
    return null;
}

/**
 * Hàm xử lý quy trình hội thoại nhiều bước (Conversation State Flow) cho lệnh /add acc
 */
async function handleStateFlow(api, message, state, stateKey) {
    const threadId = message.threadId;
    
    // Xác định nội dung tin nhắn văn bản từ người dùng
    const isPlainText = typeof message.data.content === "string";
    const rawText = isPlainText ? message.data.content.trim() : "";
    
    if (!rawText) {
        await sendBotMessage(api, `⚠️ Vui lòng nhập thông tin bằng tin nhắn văn bản. Hoặc gõ "hủy" để thoát khỏi quy trình thêm tài khoản.`, threadId, message.type)
            .catch(() => {});
        return;
    }

    if (rawText.toLowerCase() === 'hủy' || rawText.toLowerCase() === 'cancel') {
        delete userStates[stateKey];
        await sendBotMessage(api, `🚫 Đã hủy quy trình thêm tài khoản ${state.platform.toUpperCase()}.`, threadId, message.type)
            .catch(() => {});
        return;
    }

    if (state.command === 'add_acc') {
        if (state.step === 1) {
            // Bước 1: Lưu tên tài khoản (username/gmail/phone) và chuyển sang bước 2
            state.username = rawText;
            state.step = 2;
            await sendBotMessage(api, `[Thêm tài khoản ${state.platform.toUpperCase()}]\n👉 Bước 2: Vui lòng nhập mật khẩu (mật khẩu sẽ được bot bảo mật cục bộ):`, threadId, message.type)
                .catch(() => {});
        } else if (state.step === 2) {
            // Bước 2: Lưu mật khẩu và chạy tiến trình kiểm tra đăng nhập thực tế (test login)
            state.password = rawText;
            
            await sendBotMessage(api, `⏳ Đang tiến hành kiểm tra đăng nhập thực tế vào ${state.platform.toUpperCase()}... Vui lòng đợi trong giây lát.`, threadId, message.type)
                .catch(() => {});
            
            try {
                const loginSuccess = await platformAutomation.testLogin(state.platform, state.username, state.password);
                
                // Đọc file platform_accounts.json và lưu thông tin cho cả trường hợp đăng nhập thành công hay thất bại
                let accounts = {};
                if (fs.existsSync(PLATFORM_ACCOUNTS_PATH)) {
                    try {
                        accounts = JSON.parse(fs.readFileSync(PLATFORM_ACCOUNTS_PATH, 'utf8'));
                    } catch (e) {
                        accounts = {};
                    }
                }
                if (!accounts[state.platform]) {
                    accounts[state.platform] = [];
                }
                
                // Tìm kiếm xem tài khoản đã tồn tại chưa để cập nhật mật khẩu, ngược lại thêm mới
                const existingAccIdx = accounts[state.platform].findIndex(acc => acc.username === state.username);
                if (existingAccIdx !== -1) {
                    accounts[state.platform][existingAccIdx].password = state.password;
                    accounts[state.platform][existingAccIdx].status = loginSuccess ? "active" : "offline";
                    accounts[state.platform][existingAccIdx].updatedAt = new Date().toISOString();
                } else {
                    accounts[state.platform].push({
                        username: state.username,
                        password: state.password,
                        status: loginSuccess ? "active" : "offline",
                        addedAt: new Date().toISOString()
                    });
                }
                
                fs.writeFileSync(PLATFORM_ACCOUNTS_PATH, JSON.stringify(accounts, null, 2), 'utf8');

                if (loginSuccess) {
                    await sendBotMessage(api, `✅ Đã lưu thành công tài khoản [${state.username}]!`, threadId, message.type)
                        .catch(() => {});
                } else {
                    await sendBotMessage(api, `⚠️ Đăng nhập không thành công (hoặc yêu cầu xác minh), nhưng bot vẫn tiến hành lưu lại tài khoản [${state.username}] theo yêu cầu!`, threadId, message.type)
                        .catch(() => {});
                }
            } catch (err) {
                console.error("Lỗi khi đăng nhập thử nghiệm:", err);
                // Trường hợp lỗi kết nối, vẫn cố gắng lưu tài khoản dự phòng
                try {
                    let accounts = {};
                    if (fs.existsSync(PLATFORM_ACCOUNTS_PATH)) accounts = JSON.parse(fs.readFileSync(PLATFORM_ACCOUNTS_PATH, 'utf8'));
                    if (!accounts[state.platform]) accounts[state.platform] = [];
                    const existingAccIdx = accounts[state.platform].findIndex(acc => acc.username === state.username);
                    if (existingAccIdx !== -1) {
                        accounts[state.platform][existingAccIdx].password = state.password;
                        accounts[state.platform][existingAccIdx].status = "unknown";
                        accounts[state.platform][existingAccIdx].updatedAt = new Date().toISOString();
                    } else {
                        accounts[state.platform].push({ username: state.username, password: state.password, status: "unknown", addedAt: new Date().toISOString() });
                    }
                    fs.writeFileSync(PLATFORM_ACCOUNTS_PATH, JSON.stringify(accounts, null, 2), 'utf8');
                } catch (saveErr) {}
                
                await sendBotMessage(api, `❌ Gặp lỗi kết nối khi kiểm tra đăng nhập: ${err.message}. Tài khoản [${state.username}] vẫn được lưu dạng dự phòng.`, threadId, message.type)
                    .catch(() => {});
            } finally {
                // Xóa trạng thái hội thoại sau khi hoàn tất hoặc lỗi
                delete userStates[stateKey];
            }
        }
    }
}


async function startBot() {
    const zalo = new Zalo({ imageMetadataGetter, selfListen: true });
    let api;

    // 1. Tự động đăng nhập lại bằng cookie cũ trong file credentials.json
    if (fs.existsSync(CREDENTIALS_PATH)) {
        try {
            console.log("🔄 Đang thử đăng nhập bằng thông tin lưu trữ cũ (credentials.json)...");
            const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
            api = await zalo.login(credentials);
        } catch (error) {
            console.error("❌ Lỗi khi đăng nhập bằng thông tin cũ:", error.message);
        }
    }

    // 2. Nếu chưa có credentials hoặc cookie hết hạn, đăng nhập bằng mã QR
    if (!api) {
        console.log("📸 Đang tạo mã QR đăng nhập mới...");
        api = await zalo.loginQR({ qrPath: path.join(__dirname, 'qr.png') }, async (event) => {
            if (event.type === 0) { // QRCodeGenerated
                try {
                    await event.actions.saveToFile();
                    console.log("📸 Đã tạo file qr.png thành công!");
                    const artifactQrPath = "/home/gia/.gemini/antigravity-ide/brain/cad863e0-cc5a-4dc8-8d51-e6c6a8f1cc53/qr.png";
                    fs.copyFileSync(path.join(__dirname, 'qr.png'), artifactQrPath);
                    console.log("📸 Đã copy qr.png vào thư mục artifact!");
                } catch (err) {
                    console.error("❌ Lỗi khi lưu file QR code:", err.message);
                }
            }
            if (event.type === 4) { // GotLoginInfo
                console.log("💾 Đăng nhập QR thành công! Lưu credentials...");
                fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(event.data, null, 2), 'utf8');
            }
        });
    }

    console.log("✅ Bot đã đăng nhập thành công và sẵn sàng hoạt động!");

    // 3. Lắng nghe tin nhắn từ Zalo
    api.listener.on("message", async (message) => {
        // if (message.isSelf) return; // Bỏ qua tin nhắn của chính bot gửi

        const isPlainText = typeof message.data.content === "string";
        const isPhoto = message.data && message.data.msgType === "chat.photo";
        const isLinkAttachment = typeof message.data.content === "object" && message.data.content !== null && typeof message.data.content.href === "string";
        
        if (!isPlainText && !isLinkAttachment && !isPhoto) return;

        let rawText = "";
        if (isPlainText) {
            rawText = message.data.content.trim();
        } else if (isPhoto) {
            if (message.data.content && typeof message.data.content === "object") {
                rawText = (message.data.content.title || message.data.content.description || "").trim();
            } else if (typeof message.data.content === "string") {
                rawText = message.data.content.trim();
            }
        } else {
            rawText = message.data.content.href.trim();
        }

        const msgText = rawText.toLowerCase();
        const threadId = message.threadId;
        const userId = message.data.uidFrom;
        const isSelf = message.isSelf || userId === api.getOwnId();

        // 🔒 TRÁNH LOOP TỰ GỬI TIN NHẮN CỦA BOT
        if (isSelf) {
            const trimmedText = rawText.trim();
            if (sentMessages.has(trimmedText)) {
                sentMessages.delete(trimmedText);
                return;
            }
        }

        // 🔒 CHẶN NGƯỜI DÙNG TRONG DANH SÁCH BANNED
        if (bannedUsers.has(userId) && !isSelf) {
            return;
        }

        // 💬 XỬ LÝ CONVERSATION STATE FLOW (Thêm tài khoản từng bước)
        const stateKey = `${threadId}_${userId}`;
        if (userStates[stateKey]) {
            await handleStateFlow(api, message, userStates[stateKey], stateKey);
            return;
        }

        // Phân tích sơ bộ command và args để kiểm tra bật/tắt bot
        let tempCmd = '';
        let tempArgs = '';
        if (rawText.startsWith('/') || rawText.startsWith('?')) {
            const parts = rawText.split(/\s+/);
            tempCmd = parts[0].toLowerCase();
            tempArgs = parts.slice(1).join(' ').trim();
        }

        // Lệnh BẬT / TẮT bot (áp dụng cho cả chat riêng lẫn chat nhóm)
        if (tempCmd === '/bot') {
            const action = tempArgs.toLowerCase();
            if (action === 'onl') {
                enabledThreads.add(threadId);
                saveEnabledChats();
                
                // Tự động bật Anti-link cho chat nhóm khi bật bot
                if (message.type === ThreadType.Group) {
                    antilinkThreads.add(threadId);
                    saveAntilinkStatus();
                }

                api.sendMessage('✅ Bot đã được cấp quyền và bật cho cuộc trò chuyện này.', threadId, message.type)
                    .catch(err => { });
                return;
            } else if (action === 'off') {
                enabledThreads.delete(threadId);
                saveEnabledChats();
                api.sendMessage('⛔ Bot đã bị thu hồi quyền và tắt trong cuộc trò chuyện này.', threadId, message.type)
                    .catch(err => { });
                return;
            }
        }

        // Bỏ qua mọi tin nhắn/lệnh khác nếu bot chưa được bật cho cuộc trò chuyện này
        if (!enabledThreads.has(threadId)) {
            return;
        }

        // Lệnh BẬT / TẮT Anti-link (chỉ chạy khi bot đã được bật)
        if (tempCmd === '/antilink') {
            const action = tempArgs.toLowerCase();
            if (action === 'on') {
                antilinkThreads.add(threadId);
                saveAntilinkStatus();
                api.sendMessage('✅ Đã bật tính năng Anti-link (chống gửi link) cho cuộc trò chuyện này.', threadId, message.type)
                    .catch(err => { });
                return;
            } else if (action === 'off') {
                antilinkThreads.delete(threadId);
                saveAntilinkStatus();
                api.sendMessage('⛔ Đã tắt tính năng Anti-link (chống gửi link) cho cuộc trò chuyện này.', threadId, message.type)
                    .catch(err => { });
                return;
            } else {
                api.sendMessage('⚠️ Hướng dẫn sử dụng Anti-link:\n- `/antilink on`: Bật chặn link\n- `/antilink off`: Tắt chặn link\n- `/linkon @người dùng Zalo`: Cho phép người được nhắc tên gửi link', threadId, message.type)
                    .catch(err => { });
                return;
            }
        }

        if (tempCmd === '/linkon') {
            const targetUserId = extractMentionedUserId(rawText, message.data?.mentions || []);
            if (!targetUserId) {
                api.sendMessage('⚠️ Vui lòng nhắc tên người dùng bằng @, ví dụ: `/linkon @người dùng Zalo`', threadId, message.type)
                    .catch(err => { });
                return;
            }

            addAllowedLinkUser(threadId, targetUserId);
            saveAllowedLinkUsers();
            api.sendMessage(`✅ Đã cho phép người này gửi link trong cuộc trò chuyện này.`, threadId, message.type)
                .catch(err => { });
            return;
        }

        // 🟢 CHẶN LINK (ANTI-LINK) - Thực hiện cho cả chat nhóm lẫn chat riêng khi bot đã bật và anti-link đang BẬT
        if (!isSelf && antilinkThreads.has(threadId)) {
            if (containsLink(rawText)) {
                const isAllowed = isAllowedLinkUser(threadId, userId);
                if (isAllowed) {
                    console.log(`[Anti-link] Cho phép user ${userId} gửi link trong thread ${threadId}`);
                } else {
                    try {
                        if (typeof api.deleteMessage === 'function') {
                            await api.deleteMessage(message);
                        }
                    } catch (delErr) {
                        console.error("Không thể xóa tin nhắn link:", delErr.message);
                    }
                    
                    await handleLinkViolation(api, threadId, userId, message.data.dName || "Bạn", message.type);
                    return;
                }
            }
        }

        // Xử lý cơ chế lệnh AI (/ai)
        // Bot chỉ phản hồi khi tin nhắn bắt đầu bằng /ai hoặc chứa /ai dưới dạng một từ độc lập
        const hasAi = /(?:^|\s)\/ai(?:\s|$)/i.test(rawText);
        if (hasAi) {
            // Cắt bỏ phần chữ "/ai" (kèm khoảng trắng xung quanh) để lấy câu hỏi thực tế
            const prompt = rawText.replace(/(?:^|\s)\/ai(?:\s|$)/i, ' ').replace(/\s+/g, ' ').trim();

            if (!prompt) {
                api.sendMessage("⚠️ Vui lòng nhập câu hỏi hoặc yêu cầu vẽ ảnh sau lệnh. Ví dụ: /ai vẽ một con mèo dễ thương", threadId, message.type)
                    .catch(err => console.error("Lỗi gửi tin nhắn:", err));
            } else {
                handleAIInteraction(prompt, threadId, message, api);
            }
            return;
        }

        // Xử lý các câu lệnh bắt đầu bằng "/" hoặc "?"
        if (rawText.startsWith('/') || rawText.startsWith('?')) {
            const parts = rawText.split(/\s+/);
            const command = parts[0].toLowerCase();
            const args = parts.slice(1).join(' ').trim();

            if (command === '/add') {
                const parts = args.split(/\s+/);
                const subCommand = parts[0] ? parts[0].toLowerCase() : '';

                if (subCommand === 'acc') {
                    // Xử lý riêng cho cú pháp: /add acc tiktok gg <email> <password>
                    let nickname, platform, username, password;
                    
                    if (parts[1] && parts[1].toLowerCase() === 'tiktok' && parts[2] && parts[2].toLowerCase() === 'gg') {
                        // Cú pháp riêng: /add acc tiktok gg <email> <password>
                        platform = 'tiktok-gg';
                        username = parts[3];
                        password = parts[4];
                        // Tự lấy nickname từ prefix email (VD: user@gmail.com -> user)
                        nickname = username ? username.split('@')[0] : '';
                    } else {
                        // Cú pháp chuẩn: /add acc <biệt_danh> <mxh> <email_sdt> <mật_khẩu>
                        nickname = parts[1];
                        platform = parts[2] ? parts[2].toLowerCase() : '';
                        username = parts[3];
                        password = parts[4];
                    }

                    const validPlatforms = ['thread', 'facebook', 'ig', 'yt', 'tiktok', 'tiktok-gg'];

                    if (!platform || !username || !password || (!nickname && platform !== 'tiktok-gg')) {
                        await sendBotMessage(api, `⚠️ Thiếu tham số! Cú pháp đúng:\n👉 \`/add acc tiktok gg <địa_chỉ_email> <mật_khẩu_email>\`\n👉 Hoặc: \`/add acc <biệt_danh> <mxh> <tên_đăng_nhập> <mật_khẩu>\``, threadId, message.type)
                            .catch(() => {});
                        return;
                    }

                    if (!validPlatforms.includes(platform)) {
                        await sendBotMessage(api, `⚠️ Nền tảng không hợp lệ!\n📋 Các nền tảng hỗ trợ: ${validPlatforms.join(', ')}\n💡 Dùng: \`/add acc tiktok gg <email> <pass>\` để đăng nhập TikTok bằng Google.`, threadId, message.type)
                            .catch(() => {});
                        return;
                    }

                    // Xử lý đặc biệt cho TikTok đăng nhập bằng Google
                    const isTikTokGoogle = (platform === 'tiktok-gg');
                    const storagePlatform = isTikTokGoogle ? 'tiktok' : platform; // Lưu chung vào phân vùng 'tiktok'
                    const displayPlatform = isTikTokGoogle ? 'TIKTOK (Google Login)' : platform.toUpperCase();

                    if (isTikTokGoogle) {
                        // Validate email Google
                        if (!username || !username.includes('@')) {
                            await sendBotMessage(api, `⚠️ Địa chỉ email không hợp lệ! Vui lòng nhập đúng định dạng email (ví dụ: user@gmail.com).`, threadId, message.type)
                                .catch(() => {});
                            return;
                        }
                        await sendBotMessage(api, `⏳ Đang kiểm tra đăng nhập TikTok bằng Google cho tài khoản [${username}]...`, threadId, message.type)
                            .catch(() => {});
                    } else {
                        await sendBotMessage(api, `⏳ Đang tiến hành kiểm tra đăng nhập vào ${displayPlatform} cho tài khoản [${username}]...`, threadId, message.type)
                            .catch(() => {});
                    }

                    try {
                        const loginOptions = {
                            onRequire2FA: async (email) => {
                                await sendBotMessage(api, `🔐 **XÁC MINH 2 BƯỚC (2FA) GOOGLE**\n\nTài khoản [${email}] yêu cầu mã xác minh OTP từ Google!\n👉 Vui lòng nhập mã theo cú pháp:\n\`/otp <mã_6_số>\` (ví dụ: \`/otp 123456\`)\n\n⏰ Bạn có 90 giây để gửi mã!`, threadId, message.type)
                                    .catch(() => {});
                            }
                        };

                        const loginResult = isTikTokGoogle 
                            ? await platformAutomation.testLoginTikTokGoogle(username, password, loginOptions)
                            : await platformAutomation.testLogin(platform, username, password);
                        
                        const forceSave = rawText.toLowerCase().includes('--force') || rawText.toLowerCase().includes(' force');

                        // testLogin cho tiktok-gg hoặc các platform khác giờ trả về object { success, usedSession, sessionSaved, reason } hoặc boolean
                        const loginSuccess = isTikTokGoogle 
                            ? (typeof loginResult === 'object' ? loginResult.success : loginResult)
                            : (typeof loginResult === 'object' ? loginResult.success : loginResult);
                        const usedSession = isTikTokGoogle && typeof loginResult === 'object' ? loginResult.usedSession : false;
                        const sessionSaved = isTikTokGoogle && typeof loginResult === 'object' ? loginResult.sessionSaved : false;
                        const loginReason = typeof loginResult === 'object' ? (loginResult.reason || '') : '';
                        const captchaRequired = typeof loginResult === 'object' && loginResult && loginResult.captchaRequired;
                        const shouldPersistPendingAccount = Boolean(loginResult && (loginResult.captchaRequired || loginResult.profileReady));

                        if (loginSuccess || forceSave || shouldPersistPendingAccount) {
                            // Đăng nhập thành công, captcha/verify đang chờ xử lý người dùng, hoặc ép lưu
                            let accounts = {};
                            if (fs.existsSync(PLATFORM_ACCOUNTS_PATH)) {
                                try {
                                    accounts = JSON.parse(fs.readFileSync(PLATFORM_ACCOUNTS_PATH, 'utf8'));
                                } catch (e) {
                                    accounts = {};
                                }
                            }

                            if (!accounts[storagePlatform]) {
                                accounts[storagePlatform] = [];
                            }

                            // Kiểm tra trùng nickname hoặc username trên cùng platform
                            const existingIdx = accounts[storagePlatform].findIndex(acc => (acc.nickname && acc.nickname.toLowerCase() === nickname.toLowerCase()) || (acc.username && acc.username.toLowerCase() === username.toLowerCase()));

                            const accountData = {
                                nickname: nickname,
                                username: username,
                                password: password,
                                loginType: isTikTokGoogle ? 'google' : 'direct', // Đánh dấu kiểu đăng nhập
                                gmail: isTikTokGoogle ? username : undefined, // Lưu email Google nếu đăng nhập qua GG
                                hasSession: isTikTokGoogle ? true : false, // Đánh dấu có session lưu không
                                status: loginSuccess ? 'active' : (captchaRequired ? 'pending_manual_verify' : 'active'),
                                verificationRequired: Boolean(captchaRequired),
                                addedAt: new Date().toISOString()
                            };

                            // Xóa trường undefined để JSON sạch
                            Object.keys(accountData).forEach(key => accountData[key] === undefined && delete accountData[key]);

                            if (existingIdx !== -1) {
                                accounts[storagePlatform][existingIdx] = accountData;
                            } else {
                                accounts[storagePlatform].push(accountData);
                            }

                            fs.writeFileSync(PLATFORM_ACCOUNTS_PATH, JSON.stringify(accounts, null, 2), 'utf8');

                            const forceMsg = (!loginSuccess && forceSave) ? ' ⚠️ [Lưu bắt buộc với --force]' : '';
                            if (captchaRequired) {
                                await sendBotMessage(api, `⏳ Đã lưu tài khoản vào hệ thống với trạng thái chờ xác minh người dùng!\n📧 ${username}\n🏷️ Biệt danh: [${nickname}]\n⚠️ TikTok đang yêu cầu xác minh captcha/verify, hãy mở tab xử lý thủ công rồi tiếp tục.`, threadId, message.type)
                                    .catch(() => {});
                            } else if (isTikTokGoogle) {
                                let sessionInfo = '';
                                if (usedSession) {
                                    sessionInfo = '\n🔄 Đăng nhập bằng Session đã lưu.';
                                } else if (sessionSaved) {
                                    sessionInfo = '\n💾 Đã lưu Session tự động cho các lần sau.';
                                }
                                await sendBotMessage(api, `✅ Thêm tài khoản thành công!${forceMsg}\n📧 Email: ${username}\n🏷️ Biệt danh: [${nickname}]${sessionInfo}`, threadId, message.type)
                                    .catch(() => {});
                            } else {
                                await sendBotMessage(api, `✅ Đã lưu tài khoản vào phân vùng ${displayPlatform} với biệt danh [${nickname}]!${forceMsg}`, threadId, message.type)
                                    .catch(() => {});
                            }
                        } else {
                            // Đăng nhập thất bại -> Báo lý do chi tiết
                            const reasonText = loginReason ? `\n📝 **Lý do chi tiết**: ${loginReason}` : '';
                            const normalizedReason = String(loginReason || '').toLowerCase();
                            const isWrongCredentialMessage = normalizedReason.includes('sai mật khẩu')
                                || normalizedReason.includes('mật khẩu không chính xác')
                                || normalizedReason.includes('tài khoản/email google không tồn tại')
                                || normalizedReason.includes('email không hợp lệ')
                                || normalizedReason.includes('không tồn tại')
                                || normalizedReason.includes('sai email')
                                || normalizedReason.includes('wrong password')
                                || normalizedReason.includes('email hoặc mật khẩu')
                                || normalizedReason.includes('tài khoản/email không tồn tại');

                            const readableReason = isWrongCredentialMessage
                                ? '\n❌ Sai email hoặc mật khẩu Google/TikTok! Vui lòng kiểm tra lại thông tin đăng nhập.'
                                : reasonText;

                            const helpText = `\n💡 *Mẹo*: Nếu chắc chắn đúng mật khẩu, bạn có thể thêm \`--force\` vào cuối lệnh để bắt buộc lưu tài khoản vào bot! (Ví dụ: \`/add acc ${nickname || 'nick'} tiktok ${username} ${password} --force\`)`;

                            await sendBotMessage(api, `❌ Thêm tài khoản thất bại!${readableReason}\n${helpText}`, threadId, message.type)
                                .catch(() => {});
                        }
                    } catch (err) {
                        console.error("Lỗi khi kiểm tra đăng nhập trước khi lưu:", err);
                        await sendBotMessage(api, `❌ Lỗi kết nối khi kiểm tra đăng nhập: ${err.message}. Từ chối lưu tài khoản!`, threadId, message.type)
                            .catch(() => {});
                    }
                    return;
                }
            }

            // ===== LỆNH /OTP - NHẬP MÃ XÁC MINH 2 BƯỚC (2FA) GOOGLE =====
            else if (command === '/otp') {
                const parts = args.trim().split(/\s+/);
                const otpCode = parts[0] || '';
                const targetEmail = parts[1] || ''; // Tuỳ chọn nếu có nhiều acc

                if (!otpCode) {
                    await sendBotMessage(api, `⚠️ Thiếu mã OTP!\n👉 Cú pháp: \`/otp <mã_6_số>\` (Ví dụ: \`/otp 123456\`)`, threadId, message.type)
                        .catch(() => {});
                    return;
                }

                // Gửi OTP cho trình duyệt ngầm đang chờ
                const sent = platformAutomation.submitOtp(targetEmail || '', otpCode);

                if (sent) {
                    await sendBotMessage(api, `🔑 Đã gửi mã OTP [${otpCode}] đến trình duyệt ngầm! Đang tiến hành xác minh 2FA...`, threadId, message.type)
                        .catch(() => {});
                } else {
                    await sendBotMessage(api, `⚠️ Không tìm thấy phiên đăng nhập nào đang chờ mã OTP 2FA (hoặc đã quá thời gian 90s).`, threadId, message.type)
                        .catch(() => {});
                }
                return;
            }

            // ===== LỆNH /SESSION - QUẢN LÝ SESSION TIKTOK =====
            else if (command === '/session') {
                const parts = args.trim().split(/\s+/);
                const subCommand = (parts[0] || 'list').toLowerCase();

                if (subCommand === 'list' || subCommand === 'ds') {
                    // Liệt kê tất cả sessions đã lưu
                    const sessions = platformAutomation.listSessions();
                    if (sessions.length === 0) {
                        await sendBotMessage(api, `📋 Chưa có session TikTok nào được lưu.\n💡 Dùng /add acc <biệt_danh> tiktok-gg <email> <pass> để tạo session.`, threadId, message.type)
                            .catch(() => {});
                    } else {
                        let msg = `📋 **DANH SÁCH SESSION TIKTOK** (${sessions.length} session)\n${'─'.repeat(30)}`;
                        for (let i = 0; i < sessions.length; i++) {
                            const s = sessions[i];
                            const status = s.isExpired ? '❌ Hết hạn' : '✅ Hoạt động';
                            const savedDate = s.savedAt ? new Date(s.savedAt).toLocaleString('vi-VN') : 'N/A';
                            const lastUsed = s.lastUsed ? new Date(s.lastUsed).toLocaleString('vi-VN') : 'N/A';
                            const expiresDate = s.expiresAt ? new Date(s.expiresAt).toLocaleString('vi-VN') : 'N/A';
                            msg += `\n\n${i + 1}. 📧 ${s.identifier || '(không rõ)'}`;
                            msg += `\n   ${status} | 🍪 ${s.cookieCount || 0} cookies`;
                            msg += `\n   📅 Lưu: ${savedDate}`;
                            msg += `\n   🕐 Dùng gần nhất: ${lastUsed}`;
                            msg += `\n   ⏰ Hết hạn: ${expiresDate}`;
                            msg += `\n   🔢 Số lần đăng nhập: ${s.loginCount || 1}`;
                        }
                        msg += `\n\n${'─'.repeat(30)}`;
                        msg += `\n💡 Lệnh: /session clear <email> | /session clear all | /session check <email>`;
                        await sendBotMessage(api, msg, threadId, message.type).catch(() => {});
                    }
                }

                else if (subCommand === 'clear' || subCommand === 'xoa' || subCommand === 'xóa' || subCommand === 'delete') {
                    const identifier = parts[1] || '';
                    if (!identifier) {
                        await sendBotMessage(api, `⚠️ Thiếu tham số!\n👉 Cú pháp:\n• /session clear <email> - Xóa session của 1 tài khoản\n• /session clear all - Xóa tất cả sessions`, threadId, message.type)
                            .catch(() => {});
                        return;
                    }
                    const result = platformAutomation.clearSession(identifier);
                    if (result.success) {
                        await sendBotMessage(api, `🗑️ ${result.message}\n💡 Lần đăng nhập tiếp theo sẽ cần nhập lại mật khẩu Google.`, threadId, message.type)
                            .catch(() => {});
                    } else {
                        await sendBotMessage(api, `⚠️ ${result.message}`, threadId, message.type)
                            .catch(() => {});
                    }
                }

                else if (subCommand === 'check' || subCommand === 'kt' || subCommand === 'kiểm' || subCommand === 'kiem') {
                    const identifier = parts[1] || '';
                    if (!identifier) {
                        await sendBotMessage(api, `⚠️ Thiếu email!\n👉 Cú pháp: /session check <email>`, threadId, message.type)
                            .catch(() => {});
                        return;
                    }
                    await sendBotMessage(api, `⏳ Đang kiểm tra session cho [${identifier}]...`, threadId, message.type)
                        .catch(() => {});
                    
                    const result = await platformAutomation.checkSessionValid(identifier);
                    if (result.valid) {
                        let msg = `✅ Session cho [${identifier}] CÒN HIỆU LỰC!`;
                        msg += `\n📊 ${result.reason}`;
                        if (result.stats) {
                            msg += `\n🍪 Cookies: ${result.stats.validCookies}/${result.stats.totalCookies} còn hiệu lực`;
                            msg += `\n📅 Lưu lúc: ${new Date(result.stats.savedAt).toLocaleString('vi-VN')}`;
                            msg += `\n🕐 Dùng gần nhất: ${new Date(result.stats.lastUsed).toLocaleString('vi-VN')}`;
                            msg += `\n🔢 Đã đăng nhập: ${result.stats.loginCount} lần`;
                        }
                        await sendBotMessage(api, msg, threadId, message.type).catch(() => {});
                    } else {
                        await sendBotMessage(api, `❌ Session cho [${identifier}] KHÔNG HỢP LỆ!\n📝 Lý do: ${result.reason}\n💡 Cần đăng nhập lại: /add acc <biệt_danh> tiktok-gg ${identifier} <mật_khẩu>`, threadId, message.type)
                            .catch(() => {});
                    }
                }

                else if (subCommand === 'import' || subCommand === 'add' || subCommand === 'nap' || subCommand === 'nạp') {
                    const identifier = parts[1] || '';
                    const sessionIdValue = parts[2] || '';

                    if (!identifier || !sessionIdValue) {
                        await sendBotMessage(api, `⚠️ Thiếu tham số!\n👉 Cú pháp đúng:\n\`/session import <tên_user_hoặc_email> <chuỗi_sessionid>\`\n\n*(Ví dụ: \`/session import hahahi67 8f4a2b90c1...\`)*`, threadId, message.type)
                            .catch(() => {});
                        return;
                    }

                    await sendBotMessage(api, `⏳ Đang mở trình duyệt kiểm tra thử đăng nhập bằng Cookie cho [${identifier}] trên TikTok... Vui lòng chờ 10-15s!`, threadId, message.type)
                        .catch(() => {});

                    // TEST đăng nhập thực tế bằng Cookie trước khi lưu
                    const verifyResult = await platformAutomation.verifyTikTokCookie(identifier, sessionIdValue);

                    if (!verifyResult.success) {
                        await sendBotMessage(api, `❌ **XÁC MINH COOKIE THẤT BẠI!**\n📝 Lý do: ${verifyResult.reason}\n\n⚠️ Cookie \`sessionid\` bạn vừa nhập KHÔNG HỢP LỆ hoặc ĐÃ HẾT HẠN.\n👉 Vui lòng lấy lại mã \`sessionid\` mới nhất từ Chrome máy tính và nhập lại!`, threadId, message.type)
                            .catch(() => {});
                        return;
                    }

                    const cookies = [
                        {
                            name: 'sessionid',
                            value: sessionIdValue,
                            domain: '.tiktok.com',
                            path: '/',
                            httpOnly: true,
                            secure: true
                        }
                    ];

                    const saved = platformAutomation.saveCookies(identifier, cookies, {
                        loginMethod: 'manual_cookie_import',
                        platform: 'tiktok'
                    });

                    if (saved) {
                        // Tự động lưu tài khoản vào platform_accounts.json nếu chưa có
                        let accounts = {};
                        if (fs.existsSync(PLATFORM_ACCOUNTS_PATH)) {
                            try { accounts = JSON.parse(fs.readFileSync(PLATFORM_ACCOUNTS_PATH, 'utf8')); } catch (e) { accounts = {}; }
                        }
                        if (!accounts['tiktok']) accounts['tiktok'] = [];

                        const cleanUser = identifier.startsWith('@') ? identifier.substring(1) : identifier;
                        const nickname = cleanUser.includes('@') ? cleanUser.split('@')[0] : cleanUser;
                        
                        const existingIdx = accounts['tiktok'].findIndex(acc => 
                            (acc.nickname && acc.nickname.toLowerCase() === nickname.toLowerCase()) || 
                            acc.username.toLowerCase() === cleanUser.toLowerCase()
                        );

                        const accountData = {
                            nickname: nickname,
                            username: cleanUser,
                            password: 'imported_cookie_session',
                            loginType: 'cookie',
                            hasSession: true,
                            status: "active",
                            addedAt: new Date().toISOString()
                        };

                        if (existingIdx !== -1) {
                            accounts['tiktok'][existingIdx] = { ...accounts['tiktok'][existingIdx], ...accountData };
                        } else {
                            accounts['tiktok'].push(accountData);
                        }

                        fs.writeFileSync(PLATFORM_ACCOUNTS_PATH, JSON.stringify(accounts, null, 2), 'utf8');

                        await sendBotMessage(api, `✅ **XÁC MINH & NẠP SESSION COOKIE TIKTOK THÀNH CÔNG!**\n📧 Tài khoản: [${cleanUser}]\n🏷️ Biệt danh: [${nickname}]\n🌐 Đăng nhập thực tế: THÀNH CÔNG 100%!\n💾 Trạng thái: Session đã được lưu vĩnh viễn trên máy!`, threadId, message.type)
                            .catch(() => {});
                    } else {
                        await sendBotMessage(api, `❌ Lỗi khi lưu Session Cookie cho [${identifier}]. Vui lòng thử lại!`, threadId, message.type)
                            .catch(() => {});
                    }
                }

                else {
                    await sendBotMessage(api, `📋 **QUẢN LÝ SESSION TIKTOK**\n${'─'.repeat(30)}\n\n🔹 /session import <user> <sessionid> - Nạp Cookie TikTok trực tiếp\n🔹 /session list - Xem danh sách sessions\n🔹 /session check <email> - Kiểm tra session\n🔹 /session clear <email> - Xóa session 1 acc\n🔹 /session clear all - Xóa tất cả sessions\n\n${'─'.repeat(30)}\n💡 Session giúp đăng nhập TikTok mà không cần nhập lại mật khẩu Google (tự động hết hạn sau 30 ngày).`, threadId, message.type)
                        .catch(() => {});
                }
                return;
            }

            else if (command === '/spam') {
                // Cú pháp: /spam <biệt_danh_acc> <link> <chủ_đề>  (gửi kèm ảnh)
                const parts = args.split(/\s+/);
                const accNickname = parts[0] || '';
                const validPlatforms = ['thread', 'facebook', 'ig', 'yt', 'tiktok', 'tiktok-gg'];

                if (!accNickname) {
                    await sendBotMessage(api, `⚠️ Thiếu tham số!\n👉 Cú pháp: /spam <biệt_danh_acc> <link> <chủ_đề>\n(Ví dụ: /spam acc_chinh https://youtube.com marketing)\n📎 Đính kèm ảnh khi gửi tin nhắn.`, threadId, message.type)
                        .catch(() => {});
                    return;
                }

                // Tìm account từ biệt danh trong toàn bộ platform_accounts.json
                let account = null;
                let platform = '';
                if (fs.existsSync(PLATFORM_ACCOUNTS_PATH)) {
                    try {
                        const accounts = JSON.parse(fs.readFileSync(PLATFORM_ACCOUNTS_PATH, 'utf8'));
                        for (const plat of validPlatforms) {
                            if (accounts[plat]) {
                                const found = accounts[plat].find(acc =>
                                    acc.nickname && acc.nickname.toLowerCase() === accNickname.toLowerCase()
                                );
                                if (found) {
                                    account = found;
                                    platform = plat;
                                    break;
                                }
                            }
                        }
                    } catch (e) {
                        console.error("Lỗi đọc tài khoản:", e);
                    }
                }

                if (!account) {
                    await sendBotMessage(api, `❌ Không tìm thấy tài khoản với biệt danh [${accNickname}] trong hệ thống!\n👉 Thêm tài khoản bằng: /add acc <biệt_danh> <mxh> <đăng_nhập> <mật_khẩu>`, threadId, message.type)
                        .catch(() => {});
                    return;
                }

                // Trích xuất hình ảnh đính kèm hoặc quote
                const imageUrl = getMessageImage(message);
                if (!imageUrl) {
                    await sendBotMessage(api, `⚠️ Không tìm thấy ảnh đính kèm! Vui lòng gửi kèm hình ảnh hoặc quote tin nhắn ảnh cùng lệnh này.`, threadId, message.type)
                        .catch(() => {});
                    return;
                }

                // Tìm link và chủ đề trong các phần đối số (bỏ qua phần tử đầu là biệt_danh)
                let link = '';
                let topic = '';
                let urlIndex = -1;

                for (let i = 1; i < parts.length; i++) {
                    const part = parts[i];
                    if (part.startsWith('http://') || part.startsWith('https://') || /^\S+\.\S+/.test(part)) {
                        urlIndex = i;
                        link = part;
                        break;
                    }
                }

                if (urlIndex !== -1) {
                    const topicParts = [...parts.slice(1, urlIndex), ...parts.slice(urlIndex + 1)];
                    topic = topicParts.join(' ').trim();
                } else {
                    link = parts[1] || '';
                    topic = parts.slice(2).join(' ').trim();
                }

                if (!link || !topic) {
                    await sendBotMessage(api, `⚠️ Thiếu link hoặc chủ đề rải bài.\n👉 Cú pháp: /spam <biệt_danh_acc> <link> <chủ_đề>`, threadId, message.type)
                        .catch(() => {});
                    return;
                }

                await sendBotMessage(api, `⏳ Đang rải nội dung lên ${platform.toUpperCase()} bằng tài khoản [${account.nickname}]...`, threadId, message.type)
                    .catch(() => {});

                try {
                    const success = await platformAutomation.postSpam(platform, imageUrl, link, topic, account);
                    if (success) {
                        await sendBotMessage(api, `✅ Rải bài thành công lên ${platform.toUpperCase()}!\n👤 Tài khoản: [${account.nickname}]\n📌 Link: ${link}\n📂 Chủ đề: ${topic}`, threadId, message.type)
                            .catch(() => {});
                    } else {
                        await sendBotMessage(api, `❌ Gặp sự cố khi đăng bài lên ${platform.toUpperCase()}. Vui lòng xem log.`, threadId, message.type)
                            .catch(() => {});
                    }
                } catch (err) {
                    console.error("Lỗi khi thực hiện postSpam:", err);
                    await sendBotMessage(api, `❌ Lỗi rải bài đăng: ${err.message}`, threadId, message.type)
                        .catch(() => {});
                }
                return;
            }

            else if (command === '/repchuoi') {
                // Cú pháp: /repchuoi <biệt_danh_acc_tiktok>
                const parts = args.split(/\s+/);
                const accNickname = parts[0] || '';

                if (!accNickname) {
                    await sendBotMessage(api, `⚠️ Thiếu tham số!\n👉 Cú pháp dành riêng cho TikTok: \`/repchuoi <biệt_danh_acc_tiktok>\`\n*(Ví dụ: \`/repchuoi hahahi67\`)*`, threadId, message.type)
                        .catch(() => {});
                    return;
                }

                // Tìm tài khoản TikTok từ biệt danh trong platform_accounts.json (chỉ áp dụng cho TikTok)
                const tiktokPlatforms = ['tiktok', 'tiktok-gg'];
                let matchedAccount = null;
                let platform = '';
                if (fs.existsSync(PLATFORM_ACCOUNTS_PATH)) {
                    try {
                        const accounts = JSON.parse(fs.readFileSync(PLATFORM_ACCOUNTS_PATH, 'utf8'));
                        for (const plat of tiktokPlatforms) {
                            if (accounts[plat]) {
                                const found = accounts[plat].find(acc =>
                                    (acc.nickname && acc.nickname.toLowerCase() === accNickname.toLowerCase()) ||
                                    acc.username.toLowerCase() === accNickname.toLowerCase()
                                );
                                if (found) {
                                    matchedAccount = found;
                                    platform = plat;
                                    break;
                                }
                            }
                        }
                    } catch (e) {
                        console.error("Lỗi đối chiếu tài khoản TikTok:", e);
                    }
                }

                if (!matchedAccount) {
                    await sendBotMessage(api, `❌ Chưa tìm thấy tài khoản TikTok nào với biệt danh [${accNickname}] trong hệ thống!\n👉 Thêm tài khoản bằng: \`/add acc ${accNickname} tiktok <user> <pass>\` hoặc \`/session import ${accNickname} <sessionid>\``, threadId, message.type)
                        .catch(() => {});
                    return;
                }

                await sendBotMessage(api, `🔥 Tìm thấy tài khoản TikTok [${matchedAccount.nickname}]!\n⏳ Đang mở Hộp thư TikTok (DM)...\n🩶 Quét tìm các chuỗi bị XÁM / chưa thắp hôm nay...\n🎯 Sẽ chỉ gửi 🔥❤️ cho những chuỗi đang xám!`, threadId, message.type)
                    .catch(() => {});

                try {
                    const repCount = await platformAutomation.repChuoiComments(platform, matchedAccount);
                    if (repCount === -1) {
                        await sendBotMessage(api, `❌ **ĐĂNG NHẬP TIKTOK THẤT BẠI!**\nTài khoản [${matchedAccount.nickname}] chưa có Session Cookie hoặc Cookie đã hết hạn.\n\n👉 Cách nạp Cookie:\n1️⃣ Mở TikTok trên Chrome máy tính → F12 → Application → Cookies → tiktok.com\n2️⃣ Copy giá trị của \`sessionid\`\n3️⃣ Gửi lệnh: \`/session import ${matchedAccount.nickname} <chuỗi_sessionid>\``, threadId, message.type)
                            .catch(() => {});
                    } else if (repCount === -3) {
                        await sendBotMessage(api, `🛑 **CẢNH BÁO BOT / CAPTCHA!**\nTài khoản [${matchedAccount.nickname}] gặp màn hình xác minh Captcha TikTok.\n👉 Vui lòng đăng nhập trên trình duyệt để xác minh thủ công hoặc cập nhật lại Cookie mới.`, threadId, message.type)
                            .catch(() => {});
                    } else if (repCount === -2) {
                        await sendBotMessage(api, `❌ Lỗi kỹ thuật khi mở trình duyệt thắp lửa chuỗi TikTok cho [${matchedAccount.nickname}].\n💡 Thử lại sau hoặc kiểm tra log.`, threadId, message.type)
                            .catch(() => {});
                    } else if (repCount > 0) {
                        await sendBotMessage(api, `🔥 **THẮP LỬA CHUỖI TIKTOK HOÀN TẤT!**\n✅ Đã thắp lại lửa cho **${repCount}** chuỗi bị xám trên TikTok cho tài khoản [${matchedAccount.nickname}]!\n💡 Các chuỗi đã sáng sẽ tự động bỏ qua.`, threadId, message.type)
                            .catch(() => {});
                    } else {
                        await sendBotMessage(api, `✅ Không tìm thấy chuỗi nào bị xám cần thắp!\n🔥 Tất cả chuỗi của [${matchedAccount.nickname}] đều đang sáng rực rồi!`, threadId, message.type)
                            .catch(() => {});
                    }
                } catch (err) {
                    console.error("Lỗi khi chạy thắp lửa chuỗi TikTok:", err);
                    await sendBotMessage(api, `❌ Lỗi khi thắp lửa chuỗi TikTok: ${err.message}`, threadId, message.type)
                        .catch(() => {});
                }
                return;
            }

            else if (command === '/cute') {
                const randomCute = Math.floor(Math.random() * 101);

                // Xác định mục tiêu (người được tag hoặc chính người gửi)
                let targetId = message.data.uidFrom;
                let targetName = message.data.dName || "Bạn";
                let targetAvatar = "";

                const mentions = message.data.mentions;
                if (mentions && mentions.length > 0) {
                    const firstMention = mentions[0];
                    targetId = firstMention.uid;
                    try {
                        // Cắt tên hiển thị từ tin nhắn theo vị trí mention
                        targetName = rawText.substring(firstMention.pos, firstMention.pos + firstMention.len).replace(/^@/, '').trim();
                    } catch (e) {
                        targetName = "Người dùng";
                    }
                }

                // Gửi thông báo đang tạo ảnh
                api.sendMessage(`📸 Đang tạo ảnh độ dễ thương cho ${targetName}...`, threadId, message.type)
                    .then(async () => {
                        // Lấy thông tin profile từ API để có avatar chất lượng cao và tên đúng
                        const profile = await getUserProfile(api, targetId);
                        if (profile) {
                            targetAvatar = profile.avatar;
                            if (!mentions || mentions.length === 0) {
                                targetName = profile.displayName;
                            }
                        }

                        try {
                            const imageBuffer = await generateCuteCard(targetAvatar, targetName, randomCute);
                            const tempPath = path.join(__dirname, `cute_${Date.now()}.png`);
                            fs.writeFileSync(tempPath, imageBuffer);

                            await api.sendMessage({
                                msg: `🥰 Độ dễ thương của ${targetName} là: ${randomCute}%`,
                                attachments: tempPath
                            }, threadId, message.type);

                            // Xóa file tạm sau khi gửi
                            fs.unlinkSync(tempPath);
                        } catch (err) {
                            console.error("Lỗi khi tạo/gửi ảnh cute:", err);
                            // Gửi tin nhắn text dự phòng nếu có lỗi
                            api.sendMessage(`🥰 Độ dễ thương của ${targetName} là: ${randomCute}% (Không thể tạo thẻ ảnh lúc này)`, threadId, message.type)
                                .catch(e => console.error("Lỗi gửi tin nhắn fallback:", e));
                        }
                    })
                    .catch(err => console.error("Lỗi gửi trạng thái tạo ảnh:", err));
            }

            else if (command === '/role' || command === '/soi') {
                const userId = message.data.uidFrom;
                
                // Giai đoạn đêm: Soi của Tiên Tri trong inbox riêng
                if (message.type === ThreadType.User) {
                    const gameThreadId = playerActiveGame.get(userId);
                    if (!gameThreadId) {
                        api.sendMessage('⚠️ Bạn không tham gia ván Ma Sói nào!', threadId, message.type);
                        return;
                    }
                    const game = werewolfGames.get(gameThreadId);
                    if (!game || game.status !== 'night') {
                        api.sendMessage('⚠️ Bây giờ không phải là ban đêm hoặc game chưa bắt đầu!', threadId, message.type);
                        return;
                    }
                    if (!game.alive[userId]) {
                        api.sendMessage('💀 Bạn đã chết, không thể thực hiện hành động!', threadId, message.type);
                        return;
                    }
                    const userRole = game.roles[userId] || '';
                    if (!userRole.includes('Tiên Tri')) {
                        api.sendMessage('⚠️ Bạn không phải là Tiên Tri!', threadId, message.type);
                        return;
                    }
                    if (game.actions.seerChoice) {
                        api.sendMessage('🔮 Bạn đã soi một người đêm nay rồi!', threadId, message.type);
                        return;
                    }
                    if (!args) {
                        api.sendMessage('⚠️ Vui lòng nhập số thứ tự hoặc tên người muốn soi. VD: `/soi 2`', threadId, message.type);
                        return;
                    }
                    const targetId = findPlayerByInput(game, args);
                    if (!targetId || !game.alive[targetId]) {
                        api.sendMessage('⚠️ Không tìm thấy người chơi hợp lệ hoặc người chơi đó đã chết!', threadId, message.type);
                        return;
                    }
                    
                    game.actions.seerChoice = targetId;
                    const targetRole = game.roles[targetId];
                    const faction = targetRole.includes('Sói') ? '🔴 MA SÓI (Phe Ác)' : '🟢 DÂN THƯỜNG / THẦN (Phe Thiện)';
                    const targetName = game.playerNames.get(targetId);
                    
                    api.sendMessage(`🔮 Kết quả soi: **${targetName}** là **${faction}**!`, threadId, message.type);
                    
                    if (checkNightActionsComplete(game)) {
                        if (game.timer) clearTimeout(game.timer);
                        endNight(api, gameThreadId);
                    }
                    return;
                }
                
                // Ở group chat: Xem vai trò của bản thân
                const game = werewolfGames.get(threadId);
                if (!game || (game.status === 'waiting')) {
                    api.sendMessage('⚠️ Hiện tại nhóm không có ván Ma Sói nào đang diễn ra!', threadId, message.type);
                    return;
                }
                const myRole = game.roles && game.roles[userId];
                if (!myRole) {
                    api.sendMessage('⚠️ Bạn không tham gia ván Ma Sói này hoặc chưa được chia vai trò!', threadId, message.type);
                    return;
                }
                
                try {
                    if (userId === api.getOwnId()) {
                        await api.sendMessage(`🤫 Vai trò hiện tại của bạn là: **${myRole}** *(Gửi từ My Cloud)*`, api.getOwnId(), ThreadType.User);
                    } else {
                        await api.sendMessage(`🤫 Vai trò hiện tại của bạn là: **${myRole}**`, userId, ThreadType.User);
                    }
                    api.sendMessage('✅ Đã gửi lại vai trò bí mật vào tin nhắn riêng cho bạn rồi nhé!', threadId, message.type);
                } catch (e) {
                    api.sendMessage(`🤫 Vai trò của bạn là: **${myRole}** (Không thể gửi inbox nên bot hiện ở đây).`, threadId, message.type);
                }
            }

            else if (command === '/can') {
                if (message.type !== ThreadType.User) {
                    api.sendMessage('⚠️ Lệnh này chỉ sử dụng được trong nhắn tin riêng với bot để bảo mật!', threadId, message.type);
                    return;
                }
                const userId = message.data.uidFrom;
                const gameThreadId = playerActiveGame.get(userId);
                if (!gameThreadId) {
                    api.sendMessage('⚠️ Bạn không tham gia ván Ma Sói nào!', threadId, message.type);
                    return;
                }
                const game = werewolfGames.get(gameThreadId);
                if (!game || game.status !== 'night') {
                    api.sendMessage('⚠️ Bây giờ không phải là ban đêm hoặc game chưa bắt đầu!', threadId, message.type);
                    return;
                }
                if (!game.alive[userId]) {
                    api.sendMessage('💀 Bạn đã chết, không thể thực hiện hành động!', threadId, message.type);
                    return;
                }
                const userRole = game.roles[userId] || '';
                if (!userRole.includes('Sói')) {
                    api.sendMessage('⚠️ Bạn không phải là Ma Sói!', threadId, message.type);
                    return;
                }
                if (!args) {
                    api.sendMessage('⚠️ Vui lòng nhập số thứ tự hoặc tên người muốn cắn. VD: `/can 2`', threadId, message.type);
                    return;
                }
                const targetId = findPlayerByInput(game, args);
                if (!targetId || !game.alive[targetId]) {
                    api.sendMessage('⚠️ Không tìm thấy người chơi hợp lệ hoặc người chơi đó đã chết!', threadId, message.type);
                    return;
                }
                
                game.actions.wolfVote[userId] = targetId;
                const targetName = game.playerNames.get(targetId);
                api.sendMessage(`🐺 Bạn đã vote cắn **${targetName}** thành công!`, threadId, message.type);
                
                // Gửi thông báo cho đồng minh sói khác
                const allies = game.players.filter(pId => game.alive[pId] && game.roles[pId].includes('Sói') && pId !== userId);
                for (const aId of allies) {
                    api.sendMessage(`🐺 Đồng minh Sói của bạn (**${game.playerNames.get(userId)}**) đã chọn cắn **${targetName}**.`, aId, ThreadType.User).catch(() => {});
                }
                
                if (checkNightActionsComplete(game)) {
                    if (game.timer) clearTimeout(game.timer);
                    endNight(api, gameThreadId);
                }
            }

            else if (command === '/baove') {
                if (message.type !== ThreadType.User) {
                    api.sendMessage('⚠️ Lệnh này chỉ sử dụng được trong nhắn tin riêng với bot để bảo mật!', threadId, message.type);
                    return;
                }
                const userId = message.data.uidFrom;
                const gameThreadId = playerActiveGame.get(userId);
                if (!gameThreadId) {
                    api.sendMessage('⚠️ Bạn không tham gia ván Ma Sói nào!', threadId, message.type);
                    return;
                }
                const game = werewolfGames.get(gameThreadId);
                if (!game || game.status !== 'night') {
                    api.sendMessage('⚠️ Bây giờ không phải là ban đêm hoặc game chưa bắt đầu!', threadId, message.type);
                    return;
                }
                if (!game.alive[userId]) {
                    api.sendMessage('💀 Bạn đã chết, không thể thực hiện hành động!', threadId, message.type);
                    return;
                }
                const userRole = game.roles[userId] || '';
                if (!userRole.includes('Bảo Vệ')) {
                    api.sendMessage('⚠️ Bạn không phải là Bảo Vệ!', threadId, message.type);
                    return;
                }
                if (game.actions.guardChoice) {
                    api.sendMessage('🛡️ Bạn đã bảo vệ một người đêm nay rồi!', threadId, message.type);
                    return;
                }
                if (!args) {
                    api.sendMessage('⚠️ Vui lòng nhập số thứ tự hoặc tên người muốn bảo vệ. VD: `/baove 2`', threadId, message.type);
                    return;
                }
                const targetId = findPlayerByInput(game, args);
                if (!targetId || !game.alive[targetId]) {
                    api.sendMessage('⚠️ Không tìm thấy người chơi hợp lệ hoặc người chơi đó đã chết!', threadId, message.type);
                    return;
                }
                if (game.lastGuarded[userId] === targetId) {
                    api.sendMessage('⚠️ Bạn không thể bảo vệ cùng một người 2 đêm liên tiếp!', threadId, message.type);
                    return;
                }
                
                game.actions.guardChoice = targetId;
                game.lastGuarded[userId] = targetId;
                const targetName = game.playerNames.get(targetId);
                api.sendMessage(`🛡️ Bạn đã chọn bảo vệ **${targetName}** đêm nay thành công!`, threadId, message.type);
                
                if (checkNightActionsComplete(game)) {
                    if (game.timer) clearTimeout(game.timer);
                    endNight(api, gameThreadId);
                }
            }

            else if (command === '/vote') {
                if (message.type !== ThreadType.Group) {
                    api.sendMessage('⚠️ Lệnh này chỉ sử dụng được trong nhóm chat!', threadId, message.type);
                    return;
                }
                const game = werewolfGames.get(threadId);
                if (!game || game.status !== 'day_voting') {
                    api.sendMessage('⚠️ Bây giờ không phải giai đoạn vote treo cổ!', threadId, message.type);
                    return;
                }
                const userId = message.data.uidFrom;
                if (!game.players.includes(userId)) {
                    api.sendMessage('⚠️ Bạn không tham gia ván đấu này!', threadId, message.type);
                    return;
                }
                if (!game.alive[userId]) {
                    api.sendMessage('💀 Bạn đã chết, không thể biểu quyết!', threadId, message.type);
                    return;
                }
                if (!args) {
                    api.sendMessage('⚠️ Vui lòng nhập số thứ tự hoặc tên người muốn vote. VD: `/vote 2`', threadId, message.type);
                    return;
                }
                const targetId = findPlayerByInput(game, args);
                if (!targetId || !game.alive[targetId]) {
                    api.sendMessage('⚠️ Không tìm thấy người chơi hợp lệ hoặc người chơi đó đã chết!', threadId, message.type);
                    return;
                }
                
                game.votes[userId] = targetId;
                const voterName = game.playerNames.get(userId);
                const targetName = game.playerNames.get(targetId);
                
                const totalVotes = Object.values(game.votes).filter(id => id === targetId).length;
                api.sendMessage(`🗳️ **${voterName}** đã vote treo cổ **${targetName}** (Đã có ${totalVotes} vote).`, threadId, message.type);
                
                const alivePlayersCount = game.players.filter(pId => game.alive[pId]).length;
                const votesCount = Object.keys(game.votes).length;
                if (votesCount >= alivePlayersCount) {
                    if (game.timer) clearTimeout(game.timer);
                    endDayVoting(api, threadId);
                }
            }

            else if (command === '/skip') {
                if (message.type !== ThreadType.Group) {
                    api.sendMessage('⚠️ Lệnh này chỉ sử dụng được trong nhóm chat!', threadId, message.type);
                    return;
                }
                const game = werewolfGames.get(threadId);
                if (!game || game.status !== 'day_discussion') {
                    api.sendMessage('⚠️ Chỉ có thể skip trong giai đoạn thảo luận ban ngày!', threadId, message.type);
                    return;
                }
                const userId = message.data.uidFrom;
                if (!game.players.includes(userId)) {
                    api.sendMessage('⚠️ Bạn không tham gia ván đấu này!', threadId, message.type);
                    return;
                }
                if (!game.alive[userId]) {
                    api.sendMessage('💀 Bạn đã chết, không thể skip!', threadId, message.type);
                    return;
                }
                
                if (!game.skips) game.skips = new Set();
                game.skips.add(userId);
                
                const alivePlayersCount = game.players.filter(pId => game.alive[pId]).length;
                const skipCount = game.skips.size;
                const voterName = game.playerNames.get(userId);
                
                api.sendMessage(`⏭️ **${voterName}** muốn bỏ qua thảo luận và vote ngay (${skipCount}/${alivePlayersCount} vote skip).`, threadId, message.type);
                
                if (skipCount >= Math.ceil(alivePlayersCount / 2)) {
                    api.sendMessage('⏭️ Quá bán dân làng đồng ý skip thảo luận! Chuyển sang giai đoạn bỏ phiếu...', threadId, message.type);
                    if (game.timer) clearTimeout(game.timer);
                    startDayVoting(api, threadId);
                }
            }

            else if (command === '/list' || command === '/danhsach' || command === '/status' || command === '/trangthai') {
                const game = werewolfGames.get(threadId);
                if (!game) {
                    api.sendMessage('⚠️ Hiện tại nhóm này không có ván Ma Sói nào!', threadId, message.type);
                    return;
                }
                
                if (game.status === 'waiting') {
                    let listMsg = `📋 **DANH SÁCH PHÒNG CHỜ MA SÓI** (${game.players.length} người):\n`;
                    let index = 1;
                    for (const pId of game.players) {
                        const name = game.playerNames.get(pId) || `Người chơi ${index}`;
                        listMsg += `- ${index}. ${name}\n`;
                        index++;
                    }
                    listMsg += `\nTrạng thái phòng: *Đang đợi người tham gia*`;
                    api.sendMessage(listMsg, threadId, message.type);
                    return;
                }
                
                let statusName = '';
                if (game.status === 'day_intro') statusName = '☀️ Bắt đầu ngày mới';
                else if (game.status === 'night') statusName = '🌙 Đêm thứ ' + game.phaseNumber;
                else if (game.status === 'day_discussion') statusName = '🗣️ Thảo luận ban ngày';
                else if (game.status === 'day_voting') statusName = '⚖️ Bỏ phiếu treo cổ';
                
                let listMsg = `📋 **TRẠNG THÁI VÁN ĐẤU MA SÓI**\n⚡ Giai đoạn: **${statusName}**\n\nDanh sách người chơi:\n`;
                let index = 1;
                for (const pId of game.players) {
                    const name = game.playerNames.get(pId) || `Người chơi`;
                    const statusText = game.alive[pId] ? '🟢 Còn sống' : '🔴 Đã chết';
                    
                    let voteText = '';
                    if (game.status === 'day_voting' && game.votes[pId]) {
                        const votedName = game.playerNames.get(game.votes[pId]) || 'Chưa rõ';
                        voteText = ` -> 🗳️ vote ${votedName}`;
                    }
                    
                    listMsg += `${index}. ${name} (${statusText})${voteText}\n`;
                    index++;
                }
                api.sendMessage(listMsg, threadId, message.type);
            }

            // 🐺 KHO HÀNG LỆNH MA SÓI CHO NHÓM
            else if (command === '/masoi') {
                const subCmd = args.toLowerCase();
                if (subCmd === 'create' || subCmd === 'tạo') {
                    if (werewolfGames.has(threadId)) {
                        api.sendMessage('⚠️ Nhóm này đang có sẵn một phòng Ma Sói rồi! Gõ `/masoi huy` để hủy phòng cũ nếu muốn tạo mới.', threadId, message.type);
                        return;
                    }
                    werewolfGames.set(threadId, {
                        host: message.data.uidFrom,
                        players: [],
                        playerNames: new Map(),
                        status: 'waiting',
                        roles: {},
                        alive: {},
                        actions: {
                            wolfVote: {},
                            seerChoice: null,
                            guardChoice: null
                        },
                        lastGuarded: {},
                        votes: {},
                        phaseNumber: 1,
                        timer: null
                    });
                    api.sendMessage('🐺 Đã tạo phòng Ma Sói thành công! Mọi người hãy gõ `/vao` hoặc `/join` để tham gia, chủ phòng gõ `/masoi start` khi đủ người nhé.', threadId, message.type);
                }
                else if (subCmd === 'start' || subCmd === 'bắt đầu') {
                    const game = werewolfGames.get(threadId);
                    if (!game || game.status !== 'waiting') {
                        api.sendMessage('⚠️ Hiện tại không có phòng Ma Sói nào đang chờ ở nhóm này cả!', threadId, message.type);
                        return;
                    }
                    if (game.players.length < 2) {
                        api.sendMessage('⚠️ Cần ít nhất 2 người chơi tham gia mới có thể bắt đầu ván đấu!', threadId, message.type);
                        return;
                    }

                    startWerewolfGame(api, threadId, game);
                }
                else if (subCmd === 'huy' || subCmd === 'reset') {
                    const game = werewolfGames.get(threadId);
                    if (!game) {
                        api.sendMessage('⚠️ Nhóm này có phòng Ma Sói nào đang mở đâu mà hủy!', threadId, message.type);
                        return;
                    }
                    cleanupGame(game);
                    werewolfGames.delete(threadId);
                    api.sendMessage('🗑️ Đã hủy phòng Ma Sói cũ thành công. Bạn có thể gõ `/masoi tạo` để lập phòng mới!', threadId, message.type);
                }
                else {
                    api.sendMessage('⚠️ Hướng dẫn lệnh Ma Sói:\n- `/masoi tạo`: Mở phòng chơi\n- `/masoi start`: Bắt đầu ván\n- `/masoi huy`: Hủy phòng cũ', threadId, message.type);
                }
            }

            else if (command === '/vao' || command === '/join') {
                const game = werewolfGames.get(threadId);
                if (!game || game.status !== 'waiting') {
                    api.sendMessage('⚠️ Hiện tại không có phòng Ma Sói nào đang mở. Hãy gõ `/masoi tạo` trước nhé!', threadId, message.type);
                    return;
                }
                const userId = message.data.uidFrom;
                if (!game.players.includes(userId)) {
                    game.players.push(userId);
                    const profile = await getUserProfile(api, userId);
                    const displayName = profile ? profile.displayName : `Người chơi ${game.players.length}`;
                    game.playerNames.set(userId, displayName);
                    api.sendMessage(`✅ Đã thêm bạn (**${displayName}**) vào danh sách! Tổng số người chơi: ${game.players.length}`, threadId, message.type);
                } else {
                    api.sendMessage('⚠️ Bạn đã ở trong phòng chờ từ trước rồi mà!', threadId, message.type);
                }
            }

            else if (command === '/gay') {
                const randomGay = Math.floor(Math.random() * 101);
                let targetId = message.data.uidFrom;
                let targetName = message.data.dName || "Bạn";
                let targetAvatar = "";

                const mentions = message.data.mentions;
                if (mentions && mentions.length > 0) {
                    targetId = mentions[0].uid;
                    try {
                        targetName = rawText.substring(mentions[0].pos, mentions[0].pos + mentions[0].len).replace(/^@/, '').trim();
                    } catch (e) {
                        targetName = "Người dùng";
                    }
                }

                api.sendMessage(`🔥 Đang đo độ gay cho ${targetName}...`, threadId, message.type)
                    .then(async () => {
                        const profile = await getUserProfile(api, targetId);
                        if (profile) {
                            targetAvatar = profile.avatar;
                            if (!mentions || mentions.length === 0) {
                                targetName = profile.displayName;
                            }
                        }

                        try {
                            const imageBuffer = await generateGayCard(targetAvatar, targetName, randomGay);
                            const tempPath = path.join(__dirname, `gay_${Date.now()}.png`);
                            fs.writeFileSync(tempPath, imageBuffer);

                            await api.sendMessage({
                                msg: `🔥 Mức độ gay của ${targetName} là: ${randomGay}%`,
                                attachments: tempPath
                            }, threadId, message.type);

                            fs.unlinkSync(tempPath);
                        } catch (err) {
                            console.error("Lỗi khi tạo/gửi ảnh gay:", err);
                            api.sendMessage(`🔥 Mức độ gay của ${targetName} là: ${randomGay}%`, threadId, message.type)
                                .catch(e => { });
                        }
                    })
                    .catch(err => { });
            }

            else if (command === '/baucua') {
                const senderId = message.data.uidFrom;
                const senderName = message.data.dName || 'Bạn';
                const user = getUserBalance(senderId, senderName);

                const parts = args.split(/\s+/).filter(Boolean);
                const pickRaw = parts[0]?.toLowerCase();
                const amount = Number(parts[1]);

                const itemMap = {
                    'bau': { name: 'Bầu', emoji: '🥒' },
                    'baucua': { name: 'Bầu', emoji: '🥒' },
                    'cua': { name: 'Cua', emoji: '🦀' },
                    'tom': { name: 'Tôm', emoji: '🦐' },
                    'ca': { name: 'Cá', emoji: '🐟' },
                    'ga': { name: 'Gà', emoji: '🐓' },
                    'nai': { name: 'Nai', emoji: '🦌' }
                };

                if (!pickRaw || !itemMap[pickRaw] || !amount || Number.isNaN(amount) || amount <= 0) {
                    await sendBotMessage(api, `🎲 **CÁCH CHƠI BẦU CUA**:\n👉 \`/baucua [bau|cua|tom|ca|ga|nai] [số_tiền]\`\n(Ví dụ: \`/baucua cua 10000\`)\n💰 Số dư hiện tại: ${formatVnd(user.balance)}`, threadId, message.type);
                    return;
                }

                if (user.balance < amount) {
                    await sendBotMessage(api, `❌ Số dư của bạn không đủ! Số dư hiện tại: ${formatVnd(user.balance)}`, threadId, message.type);
                    return;
                }

                const chosen = itemMap[pickRaw];
                const allItems = [
                    { name: 'Bầu', emoji: '🥒' },
                    { name: 'Cua', emoji: '🦀' },
                    { name: 'Tôm', emoji: '🦐' },
                    { name: 'Cá', emoji: '🐟' },
                    { name: 'Gà', emoji: '🐓' },
                    { name: 'Nai', emoji: '🦌' }
                ];

                const dice1 = allItems[Math.floor(Math.random() * allItems.length)];
                const dice2 = allItems[Math.floor(Math.random() * allItems.length)];
                const dice3 = allItems[Math.floor(Math.random() * allItems.length)];
                const matchCount = [dice1, dice2, dice3].filter(item => item.name === chosen.name).length;

                let msgText = '';
                if (matchCount > 0) {
                    const winAmount = amount * matchCount;
                    user.balance += winAmount;
                    saveUserBalances();
                    msgText = `🎲 **KẾT QUẢ BẦU CUA**:\n[ ${dice1.emoji} | ${dice2.emoji} | ${dice3.emoji} ]\n\n🎉 ${senderName} cược ${chosen.emoji} ${chosen.name} và **TRÚNG ${matchCount} CON**!\n💰 Tiền thắng: +${formatVnd(winAmount)}\n💵 Số dư mới: ${formatVnd(user.balance)}`;
                } else {
                    user.balance -= amount;
                    saveUserBalances();
                    msgText = `🎲 **KẾT QUẢ BẦU CUA**:\n[ ${dice1.emoji} | ${dice2.emoji} | ${dice3.emoji} ]\n\n😭 ${senderName} cược ${chosen.emoji} ${chosen.name} nhưng **THUA RỒI**!\n💸 Tiền mất: -${formatVnd(amount)}\n💵 Số dư còn lại: ${formatVnd(user.balance)}`;
                }
                await sendBotMessage(api, msgText, threadId, message.type);
            }

            else if (command === '/slot') {
                const senderId = message.data.uidFrom;
                const senderName = message.data.dName || 'Bạn';
                const user = getUserBalance(senderId, senderName);

                const amount = Number(args.trim());
                if (!amount || Number.isNaN(amount) || amount <= 0) {
                    await sendBotMessage(api, `🎰 **CÁCH CHƠI SLOT MACHINE**:\n👉 \`/slot [số_tiền]\` (Ví dụ: \`/slot 10000\`)\n\n🏆 **BẢNG THƯỞNG**:\n• 🎰🎰🎰 hoặc 7️⃣7️⃣7️⃣ (JACKPOT): X10 tiền cược\n• 3 ô giống nhau khác: X5 tiền cược\n• 2 ô giống nhau: X2 tiền cược\n💰 Số dư hiện tại: ${formatVnd(user.balance)}`, threadId, message.type);
                    return;
                }

                if (user.balance < amount) {
                    await sendBotMessage(api, `❌ Số dư của bạn không đủ! Số dư hiện tại: ${formatVnd(user.balance)}`, threadId, message.type);
                    return;
                }

                const slotSymbols = ['🎰', '7️⃣', '💎', '🍇', '🍋', '🔔', '🍒'];
                const s1 = slotSymbols[Math.floor(Math.random() * slotSymbols.length)];
                const s2 = slotSymbols[Math.floor(Math.random() * slotSymbols.length)];
                const s3 = slotSymbols[Math.floor(Math.random() * slotSymbols.length)];

                let winMultiplier = 0;
                let winType = '';

                if (s1 === s2 && s2 === s3) {
                    if (s1 === '🎰' || s1 === '7️⃣') {
                        winMultiplier = 10;
                        winType = '🔥 NỔ HŨ JACKPOT (X10) 🔥';
                    } else {
                        winMultiplier = 5;
                        winType = '🌟 THẮNG LỚN 3 Ô GIỐNG NHAU (X5) 🌟';
                    }
                } else if (s1 === s2 || s1 === s3 || s2 === s3) {
                    winMultiplier = 2;
                    winType = '✨ THẮNG 2 Ô GIỐNG NHAU (X2) ✨';
                }

                let msgText = '';
                if (winMultiplier > 0) {
                    const winAmount = amount * winMultiplier;
                    user.balance += winAmount;
                    saveUserBalances();
                    msgText = `🎰 **SLOT MACHINE** 🎰\n[  ${s1}  |  ${s2}  |  ${s3}  ]\n\n🎉 ${winType}!\n💰 Thắng: +${formatVnd(winAmount)}\n💵 Số dư mới: ${formatVnd(user.balance)}`;
                } else {
                    user.balance -= amount;
                    saveUserBalances();
                    msgText = `🎰 **SLOT MACHINE** 🎰\n[  ${s1}  |  ${s2}  |  ${s3}  ]\n\n😭 Chúc ${senderName} may mắn lần sau!\n💸 Thua: -${formatVnd(amount)}\n💵 Số dư còn lại: ${formatVnd(user.balance)}`;
                }
                await sendBotMessage(api, msgText, threadId, message.type);
            }

            else if (command === '/calc') {
                if (!args) {
                    await sendBotMessage(api, '🔢 **CÁCH DÙNG LỆNH CALC**:\n👉 `/calc [biểu_thức]`\nVí dụ:\n• `/calc 2 + 3 * 4`\n• `/calc sqrt(144) + 2^5`\n• `/calc abs(-100) / 4`', threadId, message.type);
                    return;
                }
                try {
                    const result = safeEvaluateMathGroup(args);
                    await sendBotMessage(api, `🔢 Phép tính: \`${args}\` \n✅ Kết quả: **${result.toLocaleString('vi-VN')}**`, threadId, message.type);
                } catch (e) {
                    await sendBotMessage(api, `❌ ${e.message}`, threadId, message.type);
                }
            }

            else if (command === '/acc' || command === '/account') {
                const parts = args.trim().split(/\s+/).filter(Boolean);
                const subCmd = (parts[0] || 'list').toLowerCase();

                if (subCmd === 'list' || subCmd === 'ds') {
                    const accounts = platformAutomation.loadAccounts();
                    let msg = '📱 **DANH SÁCH TÀI KHOẢN MẠNG XÃ HỘI**\n' + '─'.repeat(30);

                    for (const plat in accounts) {
                        msg += `\n\n📌 **${plat.toUpperCase()}** (${accounts[plat].length} tài khoản):`;
                        if (accounts[plat].length === 0) {
                            msg += '\n   (Chưa có tài khoản nào)';
                        } else {
                            accounts[plat].forEach((acc, idx) => {
                                const statusIcon = acc.status === 'active' ? '✅' : acc.status === 'warning' ? '⚠️' : '❌';
                                const lastStreak = acc.lastStreakAt ? new Date(acc.lastStreakAt).toLocaleString('vi-VN') : 'Chưa thắp';
                                msg += `\n   ${idx + 1}. ${statusIcon} [${acc.nickname || acc.username}] - Username: ${acc.username}`;
                                msg += `\n      Trạng thái: ${acc.status || 'N/A'} | 🔥 Đã thắp: ${acc.streakCount || 0} lần`;
                                msg += `\n      Thắp gần nhất: ${lastStreak}`;
                            });
                        }
                    }
                    msg += '\n\n' + '─'.repeat(30) + '\n💡 Lệnh: `/acc add tiktok <nick> <user> [pass]` | `/acc del tiktok <nick>` | `/streak [nick]`';
                    await sendBotMessage(api, msg, threadId, message.type);
                } else if (subCmd === 'add' || subCmd === 'them') {
                    const plat = parts[1] || 'tiktok';
                    const nick = parts[2];
                    const userAcc = parts[3];
                    const passAcc = parts[4] || 'imported_session';

                    if (!nick || !userAcc) {
                        await sendBotMessage(api, '⚠️ Thiếu tham số! Cú pháp: `/acc add <platform> <biệt_danh> <username> [password]`', threadId, message.type);
                        return;
                    }

                    const added = platformAutomation.addAccount(plat, {
                        nickname: nick,
                        username: userAcc,
                        password: passAcc,
                        gmail: userAcc
                    });

                    await sendBotMessage(api, `✅ Đã thêm tài khoản [${added.nickname}] vào phân vùng ${plat.toUpperCase()}!`, threadId, message.type);
                } else if (subCmd === 'del' || subCmd === 'xoa') {
                    const plat = parts[1] || 'tiktok';
                    const nick = parts[2];

                    if (!nick) {
                        await sendBotMessage(api, '⚠️ Thiếu biệt danh! Cú pháp: `/acc del <platform> <biệt_danh>`', threadId, message.type);
                        return;
                    }

                    const success = platformAutomation.deleteAccount(plat, nick);
                    const replyText = success 
                        ? `🗑️ Đã xóa tài khoản [${nick}] khỏi ${plat.toUpperCase()}!`
                        : `⚠️ Không tìm thấy tài khoản [${nick}] trong ${plat.toUpperCase()}.`;
                    await sendBotMessage(api, replyText, threadId, message.type);
                } else if (subCmd === 'check' || subCmd === 'kt') {
                    const nick = parts[1];
                    if (!nick) {
                        await sendBotMessage(api, '⚠️ Cú pháp: `/acc check <biệt_danh>`', threadId, message.type);
                        return;
                    }
                    const found = platformAutomation.findAccount(nick);
                    if (!found) {
                        await sendBotMessage(api, `❌ Không tìm thấy tài khoản [${nick}] trong hệ thống.`, threadId, message.type);
                        return;
                    }
                    const acc = found.account;
                    const replyText = `🔍 **THÔNG TIN TÀI KHOẢN** [${acc.nickname}]:\n• Platform: ${found.platform.toUpperCase()}\n• Email/User: ${acc.username}\n• Trạng thái: ${acc.status || 'N/A'}\n• Session Cookie: ${acc.hasSession ? '✅ Đã nạp' : '❌ Chưa nạp'}\n• Lần thắp lửa gần nhất: ${acc.lastStreakAt ? new Date(acc.lastStreakAt).toLocaleString('vi-VN') : 'Chưa thắp'}`;
                    await sendBotMessage(api, replyText, threadId, message.type);
                }
            }

            else if (command === '/streak') {
                const nick = args.trim();
                const found = nick ? platformAutomation.findAccount(nick) : null;
                const targetAcc = found ? found.account : platformAutomation.getAccountsList('tiktok')[0];

                if (!targetAcc) {
                    await sendBotMessage(api, '❌ Chưa có tài khoản TikTok nào trong hệ thống! Dùng `/acc add tiktok <nick> <user>` để thêm.', threadId, message.type);
                    return;
                }

                await sendBotMessage(api, `🔥 Đang chạy tiến trình thắp lửa chuỗi TikTok cho [${targetAcc.nickname}]...\nVui lòng chờ trong giây lát.`, threadId, message.type);

                try {
                    const repCount = await platformAutomation.repChuoiComments('tiktok', targetAcc);
                    if (repCount === -1) {
                        await sendBotMessage(api, `❌ **ĐĂNG NHẬP THẤT BẠI!** Cookie session của [${targetAcc.nickname}] đã hết hạn. Nạp lại bằng \`/session import ${targetAcc.nickname} <sessionid>\``, threadId, message.type);
                    } else if (repCount === -3) {
                        await sendBotMessage(api, `🛑 **CẢNH BÁO BOT!** Tài khoản [${targetAcc.nickname}] gặp Captcha xác minh người dùng. Hãy đăng nhập thủ công trên trình duyệt.`, threadId, message.type);
                    } else if (repCount > 0) {
                        await sendBotMessage(api, `🔥 **THẮP LỬA THÀNH CÔNG!** Đã thắp lại lửa cho ${repCount} chuỗi bị xám cho [${targetAcc.nickname}]!`, threadId, message.type);
                    } else {
                        await sendBotMessage(api, `✅ Tất cả chuỗi tin nhắn TikTok của [${targetAcc.nickname}] đều đang sáng rực!`, threadId, message.type);
                    }
                } catch (err) {
                    await sendBotMessage(api, `❌ Lỗi khi thắp lửa chuỗi: ${err.message}`, threadId, message.type);
                }
            }

            else if (command === '/joke') {
                api.sendMessage("Tại sao máy tính không đi chơi? Vì nó bị lỗi rồi! 😁", threadId, message.type)
                    .catch(err => console.error("Lỗi gửi tin nhắn:", err));
            }
            else if (command === '/menu') {
                const subMenu = (args.trim().split(/\s+/)[0] || 'all').toLowerCase();

                const menuDict = {
                    mxh: `📱 **MENU TỰ ĐỘNG HÓA MXH & TIKTOK**\n${'─'.repeat(32)}\n• /streak [nick] hoặc /thapluatiktok [nick] : Thắp lửa / giữ chuỗi TikTok ngầm\n• /repchuoi <nick>                         : Thắp lửa cho 1 tài khoản TikTok\n• /acc list (hoặc /acc ds)                : Danh sách tài khoản MXH & trạng thái\n• /acc add <platform> <nick> <user> [pass]: Thêm tài khoản MXH mới\n• /acc del <platform> <nick>               : Xóa tài khoản khỏi hệ thống\n• /acc check <nick>                        : Kiểm tra trạng thái tài khoản & session\n• /session list                           : Xem danh sách session cookie đã nạp\n• /session import <nick> <sessionid>      : Nạp cookie sessionid cho TikTok\n• /session check <email>                   : Kiểm tra trạng thái sống của cookie\n• /session clear <email>                   : Xóa sessionid đã nạp\n• /otp <mã_6_số>                           : Nhập mã xác minh 2FA Google`,

                    minigame: `🎲 **MENU MINI GAME & TÀI CHÍNH**\n${'─'.repeat(32)}\n• /baucua [bau|cua|tom|ca|ga|nai] [tiền]: Game Bầu Cua 6 linh vật (X1, X2, X3)\n• /slot [số_tiền]                      : Slot Machine 3 ô (Thưởng X2, X5, Nổ Hũ X10)\n• /taixiu [tai|xiu] [số_tiền]          : Chơi Tài Xỉu\n• /chanle [chan|le] [số_tiền]          : Chơi Chẵn Lẻ\n• /daily                               : Điểm danh nhận 5.000đ mỗi 24h\n• /bank                                : Thông tin tài khoản ngân hàng & số dư\n• /nap [số_tiền]                       : Nạp tiền vào tài khoản\n• /rut [số_tiền]                       : Rút tiền từ tài khoản\n• /chuyen [user_id] [số_tiền]          : Chuyển tiền cho người chơi khác`,

                    basic: `🛠️ **MENU CƠ BẢN, AI & TIỆN ÍCH**\n${'─'.repeat(32)}\n• /help / /menu                        : Hướng dẫn danh mục menu\n• /info / /profile                     : Xem thông tin tài khoản & số dư\n• /groq [câu_hỏi] / /gemini            : Hỏi đáp AI Groq Llama-3.3 70B\n• /gpt [câu_hỏi]                       : Hỏi đáp OpenAI GPT-4o Mini\n• /deepseek [câu_hỏi]                  : Hỏi đáp DeepSeek AI\n• /ai [câu_hỏi]                        : Hỏi đáp nhanh với AI\n• /calc [biểu_thức]                    : Tính toán đại số an toàn (VD: /calc sqrt(144) + 2^5)\n• /time / /date / /weather             : Thời gian & thời tiết`,

                    giaitri: `🎉 **MENU GIẢI TRÍ & MEDIA**\n${'─'.repeat(32)}\n• /girl / /boy / /anime                : Xem ảnh ngẫu nhiên theo chủ đề\n• /vdgirl / /vdboy                     : Xem video ngẫu nhiên theo chủ đề\n• /cute [@tag]                         : Kiểm tra độ dễ thương\n• /gay [@tag]                          : Kiểm tra độ gay vui nhộn\n• /dam / /rich / /check / /lo / /moc   : Kiểm tra các chỉ số vui nhộn\n• /joke                                : Câu nói đùa hài hước\n• /fact                                : Sự thật ngẫu nhiên thú vị`,

                    quanlybox: `🛡️ **MENU QUẢN LÝ NHÓM (BOX)**\n${'─'.repeat(32)}\n• /on / /off                           : Bật / Tắt bot trong nhóm chat\n• /baove [on|off]                      : Bật / Tắt bảo vệ nhóm chống link rác/lừa đảo\n• /list / /trangthai                   : Danh sách các nhóm và trạng thái bảo vệ\n• /vote [lý_do]                        : Tạo cuộc bình chọn duyệt bài/nội dung\n• /skip                                : Bỏ qua nội dung bình chọn\n• ?ban @user / ?unban @user            : Chặn / Bỏ chặn thành viên (Quyền bot/admin)`
                };

                let menuText = menuDict[subMenu];
                if (!menuText) {
                    menuText = `📋 **DANH SÁCH DANH MỤC MENU BOT**\n${'─'.repeat(32)}\n\n` +
                        `1️⃣ \`/menu mxh\`      : Quản lý tài khoản MXH, Session, TikTok DM Streak\n` +
                        `2️⃣ \`/menu minigame\` : Game Bầu Cua, Slot Machine, Tài Xỉu, Bank, Điểm danh\n` +
                        `3️⃣ \`/menu basic\`    : Lệnh AI (Groq, GPT, DeepSeek), Calc, Thông tin cá nhân\n` +
                        `4️⃣ \`/menu giaitri\`  : Ảnh/Video Girl/Boy/Anime, Bói vui cute/gay/rich\n` +
                        `5️⃣ \`/menu quanlybox\`: Bật/Tắt bot, Chống link rác, Ban/Unban member\n\n` +
                        `${'─'.repeat(32)}\n` +
                        `👉 *Cú pháp*: Gõ \`/menu <tên_danh_mục>\` để xem chi tiết! (Ví dụ: \`/menu minigame\`)\n` +
                        `💡 Hoặc gõ \`/menu all\` để xem tất cả các nhóm menu.`;
                }

                try {
                    const imageBuffer = await generateMenuCard(subMenu);
                    const tempPath = path.join(__dirname, `menu_${subMenu}_${Date.now()}.png`);
                    fs.writeFileSync(tempPath, imageBuffer);

                    await api.sendMessage({
                        msg: menuText,
                        attachments: tempPath
                    }, threadId, message.type);

                    fs.unlinkSync(tempPath);
                } catch (err) {
                    console.error('Lỗi tạo/gửi menu card:', err);
                    await sendBotMessage(api, menuText, threadId, message.type);
                }
            }

            // 🚫 LỆNH CHẶN NGƯỜI DÙNG (CHỈ TÀI KHOẢN BOT MỚI DÙNG ĐƯỢC, ẨN KHỎI MENU)
            if (command === '?ban' || command === '/ban') {
                if (!isSelf) {
                    await api.sendMessage({ msg: '⚠️ Lệnh này chỉ có tài khoản bot mới có quyền sử dụng!', quote: message.data }, threadId, message.type);
                    return;
                }

                let targetId = null;
                let targetName = "";

                const mentions = message.data.mentions;
                if (mentions && mentions.length > 0) {
                    targetId = mentions[0].uid;
                    try {
                        targetName = rawText.substring(mentions[0].pos, mentions[0].pos + mentions[0].len).replace(/^@/, '').trim();
                    } catch (e) {
                        targetName = "Người dùng";
                    }
                } else if (args) {
                    targetId = args.trim().replace(/^@/, '');
                } else if (message.data.quote && message.data.quote.uidFrom) {
                    targetId = message.data.quote.uidFrom;
                }

                if (!targetId) {
                    await api.sendMessage({ msg: '⚠️ Vui lòng tag người muốn chặn hoặc nhập UID. Ví dụ: ?ban @TênNgườiDùng', quote: message.data }, threadId, message.type);
                    return;
                }

                if (targetId === api.getOwnId()) {
                    await api.sendMessage({ msg: '⚠️ Bạn không thể tự chặn chính tài khoản bot!', quote: message.data }, threadId, message.type);
                    return;
                }

                bannedUsers.add(targetId);
                saveBannedUsers();

                let blockMsg = `⛔ Đã chặn người dùng ${targetName ? targetName + ' ' : ''}(${targetId}) thành công!`;

                try {
                    if (typeof api.blockUser === 'function') {
                        await api.blockUser(targetId);
                    }
                } catch (err) {
                    console.error("Lỗi gọi api.blockUser:", err.message);
                }

                if (message.type === ThreadType.Group) {
                    try {
                        if (typeof api.addGroupBlockedMember === 'function') {
                            await api.addGroupBlockedMember(targetId, threadId);
                        }
                    } catch (err) {
                        console.error("Lỗi gọi api.addGroupBlockedMember:", err.message);
                    }
                }

                await api.sendMessage({ msg: blockMsg, quote: message.data }, threadId, message.type);
                return;
            }

            if (command === '?unban' || command === '/unban') {
                if (!isSelf) {
                    await api.sendMessage({ msg: '⚠️ Lệnh này chỉ có tài khoản bot mới có quyền sử dụng!', quote: message.data }, threadId, message.type);
                    return;
                }

                let targetId = null;
                const mentions = message.data.mentions;
                if (mentions && mentions.length > 0) {
                    targetId = mentions[0].uid;
                } else if (args) {
                    targetId = args.trim().replace(/^@/, '');
                } else if (message.data.quote && message.data.quote.uidFrom) {
                    targetId = message.data.quote.uidFrom;
                }

                if (!targetId) {
                    await api.sendMessage({ msg: '⚠️ Vui lòng tag người muốn bỏ chặn hoặc nhập UID. Ví dụ: ?unban @TênNgườiDùng', quote: message.data }, threadId, message.type);
                    return;
                }

                bannedUsers.delete(targetId);
                saveBannedUsers();

                try {
                    if (typeof api.unblockUser === 'function') {
                        await api.unblockUser(targetId);
                    }
                } catch (err) {
                    console.error("Lỗi gọi api.unblockUser:", err.message);
                }

                await api.sendMessage({ msg: `✅ Đã bỏ chặn người dùng (${targetId}) thành công!`, quote: message.data }, threadId, message.type);
                return;
            }

        }
    });

    api.listener.start();
    console.log("📡 Đang lắng nghe tin nhắn trực tuyến từ Zalo...");
}

startBot().catch(console.error);
// 🐺 Hàm xử lý logic chia vai và bắt đầu vòng chơi Ma Sói chi tiết
// Hàm tìm người chơi theo STT hoặc tên
function findPlayerByInput(game, input) {
    const trimmed = input.trim();
    if (!trimmed) return null;
    
    const index = parseInt(trimmed, 10);
    if (!isNaN(index) && index >= 1 && index <= game.players.length) {
        return game.players[index - 1];
    }
    
    const lowerInput = trimmed.toLowerCase();
    for (const pId of game.players) {
        const name = (game.playerNames.get(pId) || "").toLowerCase();
        if (name.includes(lowerInput)) {
            return pId;
        }
    }
    
    return null;
}

// Hàm kiểm tra các vai trò đêm đã hành động xong chưa
function checkNightActionsComplete(game) {
    const aliveWolves = game.players.filter(pId => game.alive[pId] && game.roles[pId].includes('Sói'));
    const aliveSeer = game.players.find(pId => game.alive[pId] && game.roles[pId].includes('Tiên Tri'));
    const aliveGuard = game.players.find(pId => game.alive[pId] && game.roles[pId].includes('Bảo Vệ'));
    
    // Cần tất cả Sói sống vote cắn
    const wolvesVoted = Object.keys(game.actions.wolfVote).length;
    if (wolvesVoted < aliveWolves.length) return false;
    
    // Tiên Tri còn sống cần soi xong
    if (aliveSeer && !game.actions.seerChoice) return false;
    
    // Bảo Vệ còn sống cần bảo vệ xong
    if (aliveGuard && !game.actions.guardChoice) return false;
    
    return true;
}

// Hàm tạo danh sách người chơi còn sống để hiển thị cho các hành động
function getAlivePlayersChoiceText(game) {
    let text = "";
    game.players.forEach((pId, index) => {
        if (game.alive[pId]) {
            const name = game.playerNames.get(pId) || "Người chơi";
            text += `[${index + 1}] ${name}\n`;
        }
    });
    return text.trim();
}

// Hàm kiểm tra game đã kết thúc chưa
function checkGameOver(api, threadId, game) {
    let aliveWolves = 0;
    let aliveGood = 0;
    for (const pId of game.players) {
        if (game.alive[pId]) {
            if (game.roles[pId].includes('Sói')) {
                aliveWolves++;
            } else {
                aliveGood++;
            }
        }
    }
    
    if (aliveWolves === 0) {
        let msg = "🎉 **DÂN LÀNG CHIẾN THẮNG!** 🎉\nTất cả Ma Sói đã bị tiêu diệt!\n\n📋 **VAI TRÒ CỦA CÁC NGƯỜI CHƠI:**\n";
        game.players.forEach((pId, index) => {
            const name = game.playerNames.get(pId) || "Người chơi";
            msg += `${index + 1}. ${name}: **${game.roles[pId]}**\n`;
        });
        api.sendMessage(msg, threadId, ThreadType.Group);
        
        cleanupGame(game);
        werewolfGames.delete(threadId);
        return true;
    }
    
    if (aliveWolves >= aliveGood) {
        let msg = "🐺 **MA SÓI CHIẾN THẮNG!** 🐺\nSố lượng Ma Sói đã cân bằng hoặc vượt trội hơn dân làng!\n\n📋 **VAI TRÒ CỦA CÁC NGƯỜI CHƠI:**\n";
        game.players.forEach((pId, index) => {
            const name = game.playerNames.get(pId) || "Người chơi";
            msg += `${index + 1}. ${name}: **${game.roles[pId]}**\n`;
        });
        api.sendMessage(msg, threadId, ThreadType.Group);
        
        cleanupGame(game);
        werewolfGames.delete(threadId);
        return true;
    }
    
    return false;
}

// Hàm dọn dẹp game
function cleanupGame(game) {
    if (game.timer) clearTimeout(game.timer);
    for (const pId of game.players) {
        playerActiveGame.delete(pId);
    }
}

// Bắt đầu trời tối (Đêm)
function startNight(api, threadId) {
    const game = werewolfGames.get(threadId);
    if (!game) return;
    
    if (game.timer) clearTimeout(game.timer);
    game.status = 'night';
    game.actions = {
        wolfVote: {},
        seerChoice: null,
        guardChoice: null
    };
    
    let groupMsg = `🌙 **ĐÊM THỨ ${game.phaseNumber} CHILL CHILL BẮT ĐẦU** 🌙\nTrời tối thui rùi mng ơi, đắp chăn đi ngủ lẹ thui... 💤\nMấy khứa có chức năng đặc biệt (Ma Sói, Tiên Tri, Bảo Vệ) check ngay tin nhắn riêng từ Bot để hành động nhá. Nhớ là chỉ có tối đa 45 giây thui đó nha, lẹ cái chân lên! 💀`;
    api.sendMessage(groupMsg, threadId, ThreadType.Group);
    
    const aliveChoiceText = getAlivePlayersChoiceText(game);
    
    // 1. Sói Đêm
    const wolves = game.players.filter(pId => game.alive[pId] && game.roles[pId].includes('Sói'));
    wolves.forEach(wId => {
        let wolfPM = `🐺 **LƯỢT MA SÓI (Đêm ${game.phaseNumber})** 🐺\nĐêm nay mấy khứa muốn táp khứa nào nè? 😈\nCú pháp: Phản hồi tin nhắn này bằng cách gõ: \`/can [Số thứ tự hoặc Tên]\`\n\nDanh sách người chơi còn sống sót:\n${aliveChoiceText}`;
        if (wId === api.getOwnId()) {
            api.sendMessage(wolfPM, api.getOwnId(), ThreadType.User).catch(() => {});
        } else {
            api.sendMessage(wolfPM, wId, ThreadType.User).catch(() => {});
        }
    });
    
    // 2. Tiên Tri
    const seer = game.players.find(pId => game.alive[pId] && game.roles[pId].includes('Tiên Tri'));
    if (seer) {
        let seerPM = `🔮 **LƯỢT TIÊN TRI (Đêm ${game.phaseNumber})** 🔮\nĐêm nay ní muốn soi xem ai là Ma Sói nè? 👁️👄👁️\nCú pháp: Phản hồi tin nhắn này bằng cách gõ: \`/soi [Số thứ tự hoặc Tên]\`\n\nDanh sách người chơi còn sống sót:\n${aliveChoiceText}`;
        if (seer === api.getOwnId()) {
            api.sendMessage(seerPM, api.getOwnId(), ThreadType.User).catch(() => {});
        } else {
            api.sendMessage(seerPM, seer, ThreadType.User).catch(() => {});
        }
    }
    
    // 3. Bảo Vệ
    const guard = game.players.find(pId => game.alive[pId] && game.roles[pId].includes('Bảo Vệ'));
    if (guard) {
        const lastTargetId = game.lastGuarded[guard];
        const lastTargetName = lastTargetId ? (game.playerNames.get(lastTargetId) || "Khum có") : "Khum có";
        let guardPM = `🛡️ **LƯỢT BẢO VỆ (Đêm ${game.phaseNumber})** 🛡️\nĐêm nay ní định cover cho khứa nào đây? 🛡️✨\nCú pháp: Phản hồi tin nhắn này bằng cách gõ: \`/baove [Số thứ tự hoặc Tên]\`\n*(Đêm trước ní đã bảo kê cho: ${lastTargetName})*\n\nDanh sách người chơi còn sống sót:\n${aliveChoiceText}`;
        if (guard === api.getOwnId()) {
            api.sendMessage(guardPM, api.getOwnId(), ThreadType.User).catch(() => {});
        } else {
            api.sendMessage(guardPM, guard, ThreadType.User).catch(() => {});
        }
    }
    
    // Timer 45s cho Đêm
    game.timer = setTimeout(() => {
        endNight(api, threadId);
    }, 45000);
}

// Kết thúc trời tối (Đêm)
function endNight(api, threadId) {
    const game = werewolfGames.get(threadId);
    if (!game) return;
    
    if (game.timer) clearTimeout(game.timer);
    
    const wolfVotes = Object.values(game.actions.wolfVote);
    let targetKilled = null;
    if (wolfVotes.length > 0) {
        const counts = {};
        let maxVotes = 0;
        for (const tId of wolfVotes) {
            counts[tId] = (counts[tId] || 0) + 1;
            if (counts[tId] > maxVotes) {
                maxVotes = counts[tId];
                targetKilled = tId;
            }
        }
    }
    
    const protectedId = game.actions.guardChoice;
    if (protectedId && targetKilled === protectedId) {
        targetKilled = null;
    }
    
    let reportMsg = `☀️ **TRỜI SÁNG RÙI MẤY NÍ ƠI! (Ngày thứ ${game.phaseNumber})** ☀️\nMọi người thức dậy đón bình minh thui... 🥱✨\n\n`;
    if (targetKilled) {
        game.alive[targetKilled] = false;
        const victimName = game.playerNames.get(targetKilled) || "Người chơi";
        reportMsg += `💀 Xu cà na rùi, đêm qua khứa **${victimName}** đã bị Ma Sói táp bay màu và lên bảng đếm số! 😭`;
    } else {
        reportMsg += `🕊️ Đêm qua bình yên vãi chưởng, chả có khứa nào bị cắn cả, cả làng lại thở phào! 😂`;
    }
    
    api.sendMessage(reportMsg, threadId, ThreadType.Group);
    
    if (checkGameOver(api, threadId, game)) return;
    
    startDayDiscussion(api, threadId);
}

// Bắt đầu thảo luận ban ngày
function startDayDiscussion(api, threadId) {
    const game = werewolfGames.get(threadId);
    if (!game) return;
    
    if (game.timer) clearTimeout(game.timer);
    game.status = 'day_discussion';
    game.skips = new Set();
    
    let discussMsg = `🗣️ **GIAI ĐOẠN COMBAT THẢO LUẬN (Ngày ${game.phaseNumber})** 🗣️\nMấy ní hãy tranh thủ combat, thao túng tâm lý xem ai là Sói ẩn danh đi nào! 🔥\n- Thời gian thảo luận: 45 giây.\n- Muốn skip thảo luận để vote treo cổ luôn, gõ: \`/skip\` (cần quá bán người sống đồng ý).`;
    api.sendMessage(discussMsg, threadId, ThreadType.Group);
    
    game.timer = setTimeout(() => {
        startDayVoting(api, threadId);
    }, 45000);
}

// Bắt đầu vote treo cổ
function startDayVoting(api, threadId) {
    const game = werewolfGames.get(threadId);
    if (!game) return;
    
    if (game.timer) clearTimeout(game.timer);
    game.status = 'day_voting';
    game.votes = {};
    
    const aliveChoiceText = getAlivePlayersChoiceText(game);
    let voteMsg = `⚖️ **ĐẾN GIỜ VOTE TREO CỔ RÙI (Ngày ${game.phaseNumber})** ⚖️\nHãy bỏ phiếu tiễn khứa ní nghi ngờ nhất lên đĩa nào! ⚖️🤡\nCú pháp: Gõ \`/vote [Số thứ tự hoặc Tên]\` trong nhóm này.\n- Thời gian vote: 45 giây nha mng.\n\nDanh sách các khứa còn sống sót:\n${aliveChoiceText}`;
    api.sendMessage(voteMsg, threadId, ThreadType.Group);
    
    game.timer = setTimeout(() => {
        endDayVoting(api, threadId);
    }, 45000);
}

// Kết thúc vote treo cổ
function endDayVoting(api, threadId) {
    const game = werewolfGames.get(threadId);
    if (!game) return;
    
    if (game.timer) clearTimeout(game.timer);
    
    const voteCounts = {};
    let votedPlayer = null;
    let maxVotes = 0;
    let isTie = false;
    
    Object.entries(game.votes).forEach(([voterId, targetId]) => {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });
    
    Object.entries(voteCounts).forEach(([targetId, count]) => {
        if (count > maxVotes) {
            maxVotes = count;
            votedPlayer = targetId;
            isTie = false;
        } else if (count === maxVotes) {
            isTie = true;
        }
    });
    
    let resultMsg = `⚖️ **KẾT QUẢ BỎ PHIẾU TREO CỔ** ⚖️\n`;
    if (!votedPlayer || isTie || maxVotes === 0) {
        resultMsg += `Khum có ai bị treo cổ hôm nay (hòa vote hoặc khum có vote nào)! Cả làng tha bổng nha! 🕊️`;
    } else {
        game.alive[votedPlayer] = false;
        const victimName = game.playerNames.get(votedPlayer) || "Người chơi";
        const role = game.roles[votedPlayer];
        resultMsg += `💀 Cả làng đồng lòng tiễn khứa **${victimName}** lên đĩa với ${maxVotes} lượt vote! Vai trò của khứa này là: **${role}** 🤡`;
    }
    
    api.sendMessage(resultMsg, threadId, ThreadType.Group);
    
    if (checkGameOver(api, threadId, game)) return;
    
    game.phaseNumber++;
    api.sendMessage(`🌙 Chuẩn bị đi ngủ vào Đêm thứ ${game.phaseNumber} sau 10 giây... Nằm im chờ Sói gõ cửa nhé! 💀`, threadId, ThreadType.Group);
    
    game.timer = setTimeout(() => {
        startNight(api, threadId);
    }, 10000);
}

// Hàm khởi chạy game chính thức
async function startWerewolfGame(api, threadId, game) {
    const players = game.players;
    const N = players.length;
    if (N < 2) {
        api.sendMessage('⚠️ Cần ít nhất 2 người chơi để chia vai trò Ma Sói!', threadId, ThreadType.Group);
        return;
    }

    let roles = [];
    if (N === 2) {
        roles = ['🐺 Sói Đêm', '🔮 Tiên Tri'];
    } else if (N === 3) {
        roles = ['🐺 Sói Đêm', '🔮 Tiên Tri', '👨‍🌾 Dân Làng'];
    } else if (N === 4) {
        roles = ['🐺 Sói Đêm', '🔮 Tiên Tri', '🛡️ Bảo Vệ', '👨‍🌾 Dân Làng'];
    } else if (N === 5) {
        roles = ['🐺 Sói Đêm', '🐺 Sói Đêm', '🔮 Tiên Tri', '🛡️ Bảo Vệ', '👨‍🌾 Dân Làng'];
    } else if (N === 6) {
        roles = ['🐺 Sói Đêm', '🐺 Sói Đêm', '🔮 Tiên Tri', '🛡️ Bảo Vệ', '👨‍🌾 Dân Làng', '👨‍🌾 Dân Làng'];
    } else if (N === 7) {
        roles = ['🐺 Sói Đêm', '🐺 Sói Đêm', '🔮 Tiên Tri', '🛡️ Bảo Vệ', '👨‍🌾 Dân Làng', '👨‍🌾 Dân Làng', '👨‍🌾 Dân Làng'];
    } else {
        roles = ['🐺 Sói Đêm', '🐺 Sói Đêm', '🐺 Sói Đêm', '🔮 Tiên Tri', '🛡️ Bảo Vệ'];
        while (roles.length < N) {
            roles.push('👨‍🌾 Dân Làng');
        }
    }

    roles.sort(() => Math.random() - 0.5);

    game.status = 'day_intro';
    game.roles = {};
    game.alive = {};
    game.lastGuarded = {};
    game.phaseNumber = 1;
    
    api.sendMessage('🔄 Đang lấy danh sách tên mấy ní và gửi vai trò bí mật... Chờ xíu nha! ✨', threadId, ThreadType.Group);
    
    game.playerNames = new Map();
    for (let i = 0; i < N; i++) {
        const pId = players[i];
        const profile = await getUserProfile(api, pId);
        game.playerNames.set(pId, profile ? profile.displayName : `Người chơi ${i + 1}`);
        game.alive[pId] = true;
        playerActiveGame.set(pId, threadId);
    }
    
    const wolves = players.filter((_, i) => roles[i].includes('Sói'));

    for (let i = 0; i < N; i++) {
        const pId = players[i];
        const assignedRole = roles[i];
        game.roles[pId] = assignedRole;

        let privateMsg = `🤫 Vai trò bí mật của ní trong ván Ma Sói này nà: **${assignedRole}** 👁️👄👁️`;
        
        if (assignedRole.includes('Sói') && wolves.length > 1) {
            const allies = wolves.filter(id => id !== pId);
            const allyNames = allies.map(id => game.playerNames.get(id) || "Ẩn danh");
            privateMsg += `\n👥 Đồng minh Sói của ní nà: **${allyNames.join(', ')}**`;
        }

        try {
            if (pId === api.getOwnId()) {
                await api.sendMessage(`${privateMsg} *(Gửi từ My Cloud)*`, api.getOwnId(), ThreadType.User);
            } else {
                await api.sendMessage(privateMsg, pId, ThreadType.User);
            }
        } catch (e) {
            console.error(`Không thể gửi tin nhắn riêng cho user ${pId}:`, e.message);
        }
    }

    let introMsg = `🎮 **ĐÃ PHÂN PHÁT VAI TRÒ BÍ MẬT XONG XUÔI** 🎮\nTrò chơi chính thức bắt đầu rùi nha! Mấy ní check tin nhắn riêng/My Cloud gấp để xem chức vụ bí mật nhé.\n\n📋 **DANH SÁCH NGƯỜI CHƠI:**\n`;
    players.forEach((pId, index) => {
        introMsg += `${index + 1}. ${game.playerNames.get(pId)}\n`;
    });
    introMsg += `\n☀️ Trời đang sáng để mọi người ổn định chỗ ngồi. Đêm thứ 1 sẽ tự động bắt đầu sau 15 giây... Chuẩn bị tinh thần nha! 💀`;

    api.sendMessage(introMsg, threadId, ThreadType.Group);
    
    game.timer = setTimeout(() => {
        startNight(api, threadId);
    }, 15000);
}