const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();
const platformAutomation = require('./platform_automation');

/**
 * Hàm tính toán biểu thức toán học an toàn (Safe Math Evaluator)
 */
function safeEvaluateMath(expression) {
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


const app = express();
app.use(express.json());
app.use(express.static('.'));

app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

const PORT = process.env.PORT || 3000;
const ZALO_ACCESS_TOKEN = process.env.ZALO_ACCESS_TOKEN || '';
const ZALO_REFRESH_TOKEN = process.env.ZALO_REFRESH_TOKEN || '';
const ZALO_APP_ID = process.env.ZALO_APP_ID || '';
const ZALO_APP_SECRET = process.env.ZALO_APP_SECRET || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

let cachedAccessToken = ZALO_ACCESS_TOKEN;
let tokenExpiresAt = 0;

const db = {
  users: {}
};

function ensureUser(userId) {
  if (!db.users[userId]) {
    db.users[userId] = { 
      balance: 10000,
      gameAccount: null,
      name: null,
      createdAt: new Date().toISOString(),
      dailyClaimedAt: null
    };
  }
  return db.users[userId];
}

function formatMoney(value) {
  return Number(value).toLocaleString('vi-VN') + 'đ';
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.all('/webhook', async (req, res) => {
  if (req.query && req.query.challenge) {
    return res.status(200).send(req.query.challenge);
  }

  try {
    const data = req.body;
    const eventName = data?.event_name;
    const senderId = data?.sender?.id;

    if (!senderId) {
      return res.sendStatus(200);
    }

    if (eventName === 'user_send_text') {
      const userMessage = (data?.message?.text || '').trim();
      if (!userMessage) {
        return res.sendStatus(200);
      }

      if (userMessage.startsWith('/')) {
        const parts = userMessage.slice(1).split(/\s+/).filter(Boolean);
        const command = parts[0]?.toLowerCase() || 'help';
        const args = parts.slice(1).join(' ');
        await handleCommand(senderId, command, args);
      } else {
        const aiReply = await askGroq(userMessage);
        await sendZaloMessage(senderId, aiReply);
      }
    } else if (eventName === 'user_click_button') {
      const payload = data?.payload || '';
      await handleButton(senderId, payload);
    }
  } catch (error) {
    console.error('Webhook error:', error.message);
  }

  res.sendStatus(200);
});

async function handleButton(userId, payload) {
  let replyText = 'Bạn đã chọn một mục.';

  switch (payload) {
    case 'MENU':
      replyText = 'Chọn một mục dưới đây:';
      await sendZaloMessage(userId, replyText, [
        { title: 'Tư vấn AI', payload: 'AI_HELP' },
        { title: 'Đặt lịch', payload: 'BOOKING' },
        { title: 'Hỗ trợ', payload: 'SUPPORT' }
      ]);
      return;
    case 'AI_HELP':
      replyText = 'Bạn có thể gửi câu hỏi cho Groq, GPT hoặc DeepSeek.';
      break;
    case 'BOOKING':
      replyText = 'Vui lòng cung cấp thời gian và dịch vụ bạn muốn đặt lịch.';
      break;
    case 'SUPPORT':
      replyText = 'Đội ngũ hỗ trợ sẽ liên hệ lại bạn sớm nhất.';
      break;
    default:
      replyText = 'Mục không được hỗ trợ.';
  }

  await sendZaloMessage(userId, replyText);
}

async function handleCommand(userId, command, args) {
  const user = ensureUser(userId);
  let replyText = '';

  switch (command) {
    // --- 1. THÔNG TIN & TRỢ GIÚP ---
    case 'help':
    case 'menu':
      replyText = 'Danh sách lệnh mẫu:\n/help - trợ giúp\n/info - thông tin tài khoản\n/groq [câu hỏi] - hỏi AI\n/gpt [câu hỏi]\n/deepseek [câu hỏi]\n/daily - nhận điểm danh\n/bank - quản lý ngân hàng\n/taixiu [tai|xiu] [số tiền]\n/chanle [chan|le] [số tiền]\n/girl /boy /anime /vdgirl /vdboy';
      break;
    case 'command':
    case 'commands':
      replyText = 'Danh sách lệnh đang được mở rộng. Bạn có thể dùng /help để xem nhóm lệnh cơ bản.';
      break;
    case 'info':
    case 'profile':
      replyText = `Thông tin tài khoản:\n- ID: ${userId}\n- Tên: ${user.name || 'Chưa đăng ký'}\n- Số dư: ${formatMoney(user.balance)}\n- Tài khoản game: ${user.gameAccount || 'Chưa đăng ký'}`;
      break;
    case 'about':
      replyText = 'Bot Zalo OA Node.js + Express + Axios, hỗ trợ AI, game, bank và menu nút bấm.';
      break;

    // --- 2. AI ---
    case 'gemini':
    case 'groq':
      if (!args) {
        replyText = 'Vui lòng nhập câu hỏi. VD: /groq thời tiết hôm nay';
        break;
      }
      replyText = await askGroq(args);
      break;
    case 'gpt':
      if (!args) {
        replyText = 'Vui lòng nhập câu hỏi. VD: /gpt 1+1=?';
        break;
      }
      replyText = await askOpenAI(args);
      break;
    case 'deepseek':
      if (!args) {
        replyText = 'Vui lòng nhập câu hỏi. VD: /deepseek phân tích doanh thu';
        break;
      }
      replyText = await askDeepSeek(args);
      break;
    case 'ai':
    case 'ask':
      replyText = await askGroq(args || 'Hãy trả lời ngắn gọn và hữu ích.');
      break;

    // --- 3. GIẢI TRÍ ---
    case 'lo':
      replyText = `Độ lờ của bạn hôm nay là: ${Math.floor(Math.random() * 101)}%!`;
      break;
    case 'moc':
      replyText = `Độ móc của bạn hôm nay là: ${Math.floor(Math.random() * 101)}%!`;
      break;
    case 'check':
      replyText = `Điểm cute/ngoan/ngáo của bạn: ${Math.floor(Math.random() * 101)}%!`;
      break;
    case 'gay':
      replyText = `Độ gay của bạn hiện tại là: ${Math.floor(Math.random() * 101)}% 🔥`;
      break;
    case 'dam':
      replyText = `Độ đâm của bạn hiện tại là: ${Math.floor(Math.random() * 101)}% 💥`;
      break;
    case 'cute':
      replyText = `Độ dễ thương của bạn là: ${Math.floor(Math.random() * 101)}% 🥰`;
      break;
    case 'rich':
      replyText = `Độ giàu của bạn là: ${Math.floor(Math.random() * 101)}% 💸`;
      break;
    case 'joke':
      replyText = 'Tại sao máy tính không đi chơi? Vì nó bị lỗi rồi 😄';
      break;
    case 'fact':
      replyText = 'Fact: Động vật nhỏ nhất thế giới là một loài côn trùng siêu nhỏ.';
      break;

    // --- 4. MEDIA / ẢNH / VIDEO ---
    case 'girl':
      replyText = getMediaReply('girl');
      break;
    case 'boy':
      replyText = getMediaReply('boy');
      break;
    case 'anime':
      replyText = getMediaReply('anime');
      break;
    case 'vdgirl':
      replyText = getMediaReply('vdgirl');
      break;
    case 'vdboy':
      replyText = getMediaReply('vdboy');
      break;
    case 'image':
    case 'img':
      replyText = getMediaReply('image');
      break;
    case 'video':
    case 'vd':
      replyText = getMediaReply('video');
      break;

    // --- 5. GAME & BANK ---
    case 'register':
    case 'dangky':
      if (user.name) {
        replyText = `Bạn đã đăng ký tài khoản rồi: ${user.name}`;
        break;
      }
      if (!args) {
        replyText = 'Cách dùng: /register [tên tài khoản]';
        break;
      }
      user.name = args;
      user.gameAccount = args;
      replyText = `Đăng ký thành công! Tên tài khoản: ${args}`;
      break;
    case 'login':
    case 'dangnhap':
      if (!args) {
        replyText = 'Cách dùng: /login [tên tài khoản]';
        break;
      }
      user.name = args;
      user.gameAccount = args;
      replyText = `Đăng nhập thành công với tài khoản: ${args}`;
      break;
    case 'bank':
    case 'bankinfo':
      replyText = `Thông tin ngân hàng:\n- Số dư: ${formatMoney(user.balance)}\n- Gõ /nap [số tiền] để nạp\n- Gõ /rut [số tiền] để rút\n- Gõ /chuyen [id] [số tiền] để chuyển`;
      break;
    case 'nap':
    case 'deposit':
      if (!args || Number.isNaN(Number(args))) {
        replyText = 'Cách dùng: /nap [số tiền]';
        break;
      }
      const amountDeposit = Number(args);
      if (amountDeposit <= 0) {
        replyText = 'Số tiền phải lớn hơn 0.';
        break;
      }
      user.balance += amountDeposit;
      replyText = `Nạp thành công ${formatMoney(amountDeposit)}. Số dư hiện tại: ${formatMoney(user.balance)}`;
      break;
    case 'rut':
    case 'withdraw':
      if (!args || Number.isNaN(Number(args))) {
        replyText = 'Cách dùng: /rut [số tiền]';
        break;
      }
      const amountWithdraw = Number(args);
      if (amountWithdraw <= 0) {
        replyText = 'Số tiền phải lớn hơn 0.';
        break;
      }
      if (user.balance < amountWithdraw) {
        replyText = 'Số dư không đủ để rút.';
        break;
      }
      user.balance -= amountWithdraw;
      replyText = `Rút thành công ${formatMoney(amountWithdraw)}. Số dư còn lại: ${formatMoney(user.balance)}`;
      break;
    case 'chuyen':
    case 'transfer':
      {
        const parts = args.split(/\s+/).filter(Boolean);
        const targetId = parts[0];
        const amount = Number(parts[1]);
        if (!targetId || !amount || Number.isNaN(amount) || amount <= 0) {
          replyText = 'Cách dùng: /chuyen [userId] [số tiền]';
          break;
        }
        if (!db.users[targetId]) {
          replyText = 'Không tìm thấy người nhận.';
          break;
        }
        if (user.balance < amount) {
          replyText = 'Số dư không đủ để chuyển.';
          break;
        }
        user.balance -= amount;
        db.users[targetId].balance += amount;
        replyText = `Chuyển thành công ${formatMoney(amount)} cho ${targetId}. Số dư còn lại: ${formatMoney(user.balance)}`;
        break;
      }
    case 'daily':
      const now = Date.now();
      const lastClaim = user.dailyClaimedAt ? new Date(user.dailyClaimedAt).getTime() : 0;
      const oneDay = 24 * 60 * 60 * 1000;
      if (now - lastClaim < oneDay) {
        replyText = 'Bạn vừa nhận điểm danh rồi. Hãy quay lại sau ít phút nữa.';
        break;
      }
      user.balance += 5000;
      user.dailyClaimedAt = new Date().toISOString();
      replyText = `Chúc mừng bạn nhận được 5,000đ điểm danh. Số dư hiện tại: ${formatMoney(user.balance)}`;
      break;
    case 'taixiu':
      {
        const parts = args.split(/\s+/).filter(Boolean);
        const pick = parts[0]?.toLowerCase();
        const amount = Number(parts[1]);
        if (!pick || !['tai', 'xiu'].includes(pick) || !amount || Number.isNaN(amount) || amount <= 0) {
          replyText = 'Cách dùng: /taixiu [tai|xiu] [số tiền]';
          break;
        }
        if (user.balance < amount) {
          replyText = 'Số dư không đủ.';
          break;
        }
        const result = Math.random() < 0.5 ? 'tai' : 'xiu';
        const win = result === pick;
        user.balance += win ? amount : -amount;
        replyText = `Kết quả: ${result.toUpperCase()}. Bạn ${win ? 'thắng' : 'thua'} ${formatMoney(Math.abs(amount))}. Số dư hiện tại: ${formatMoney(user.balance)}`;
        break;
      }
    case 'chanle':
      {
        const parts = args.split(/\s+/).filter(Boolean);
        const pick = parts[0]?.toLowerCase();
        const amount = Number(parts[1]);
        if (!pick || !['chan', 'le'].includes(pick) || !amount || Number.isNaN(amount) || amount <= 0) {
          replyText = 'Cách dùng: /chanle [chan|le] [số tiền]';
          break;
        }
        if (user.balance < amount) {
          replyText = 'Số dư không đủ.';
          break;
        }
        const result = Math.floor(Math.random() * 10) % 2 === 0 ? 'chan' : 'le';
        const win = result === pick;
        user.balance += win ? amount : -amount;
        replyText = `Kết quả: ${result.toUpperCase()}. Bạn ${win ? 'thắng' : 'thua'} ${formatMoney(Math.abs(amount))}. Số dư hiện tại: ${formatMoney(user.balance)}`;
        break;
      }
    case 'baucua':
      {
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
          replyText = '🎲 **CÁCH CHƠI BẦU CUA**:\n👉 `/baucua [bau|cua|tom|ca|ga|nai] [số_tiền]`\n(Ví dụ: `/baucua cua 10000`)';
          break;
        }

        if (user.balance < amount) {
          replyText = `❌ Số dư của bạn không đủ! Số dư hiện tại: ${formatMoney(user.balance)}`;
          break;
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
        const diceResult = [dice1, dice2, dice3];

        const matchCount = diceResult.filter(item => item.name === chosen.name).length;

        if (matchCount > 0) {
          const winAmount = amount * matchCount;
          user.balance += winAmount;
          replyText = `🎲 **KẾT QUẢ BẦU CUA**:\n[ ${dice1.emoji} | ${dice2.emoji} | ${dice3.emoji} ]\n\n🎉 Bạn cược ${chosen.emoji} ${chosen.name} và **TRÚNG ${matchCount} CON**!\n💰 Tiền thắng: +${formatMoney(winAmount)}\n💵 Số dư mới: ${formatMoney(user.balance)}`;
        } else {
          user.balance -= amount;
          replyText = `🎲 **KẾT QUẢ BẦU CUA**:\n[ ${dice1.emoji} | ${dice2.emoji} | ${dice3.emoji} ]\n\n😭 Bạn cược ${chosen.emoji} ${chosen.name} nhưng **THUA RỒI**!\n💸 Tiền mất: -${formatMoney(amount)}\n💵 Số dư còn lại: ${formatMoney(user.balance)}`;
        }
        break;
      }
    case 'slot':
      {
        const amount = Number(args.trim());
        if (!amount || Number.isNaN(amount) || amount <= 0) {
          replyText = '🎰 **CÁCH CHƠI SLOT MACHINE**:\n👉 `/slot [số_tiền]` (Ví dụ: `/slot 10000`)\n\n🏆 **BẢNG THƯỞNG**:\n• 🎰🎰🎰 hoặc 7️⃣7️⃣7️⃣ (JACKPOT): X10 tiền cược\n• 3 ô giống nhau khác: X5 tiền cược\n• 2 ô giống nhau: X2 tiền cược';
          break;
        }

        if (user.balance < amount) {
          replyText = `❌ Số dư của bạn không đủ! Số dư hiện tại: ${formatMoney(user.balance)}`;
          break;
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

        if (winMultiplier > 0) {
          const winAmount = amount * winMultiplier;
          user.balance += winAmount;
          replyText = `🎰 **SLOT MACHINE** 🎰\n[  ${s1}  |  ${s2}  |  ${s3}  ]\n\n🎉 ${winType}!\n💰 Thắng: +${formatMoney(winAmount)}\n💵 Số dư mới: ${formatMoney(user.balance)}`;
        } else {
          user.balance -= amount;
          replyText = `🎰 **SLOT MACHINE** 🎰\n[  ${s1}  |  ${s2}  |  ${s3}  ]\n\n😭 Chúc bạn may mắn lần sau!\n💸 Thua: -${formatMoney(amount)}\n💵 Số dư còn lại: ${formatMoney(user.balance)}`;
        }
        break;
      }

    // --- 6. TIỆN ÍCH ---
    case 'time':
      replyText = `Bây giờ là: ${new Date().toLocaleTimeString('vi-VN')}`;
      break;
    case 'date':
      replyText = `Hôm nay là: ${new Date().toLocaleDateString('vi-VN')}`;
      break;
    case 'calc':
      {
        if (!args) {
          replyText = '🔢 **CÁCH DÙNG LỆNH CALC**:\n👉 `/calc [biểu_thức]`\nVí dụ:\n• `/calc 2 + 3 * 4`\n• `/calc sqrt(144) + 2^5`\n• `/calc abs(-100) / 4`';
          break;
        }
        try {
          const result = safeEvaluateMath(args);
          replyText = `🔢 Phép tính: \`${args}\` \n✅ Kết quả: **${result.toLocaleString('vi-VN')}**`;
        } catch (e) {
          replyText = `❌ ${e.message}`;
        }
        break;
      }
    case 'weather':
      replyText = 'Bạn có thể tích hợp API thời tiết sau.';
      break;

    // --- 7. QUẢN LÝ TÀI KHOẢN MXH & TIKTOK STREAK ---
    case 'acc':
    case 'account':
      {
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
          replyText = msg;
        } else if (subCmd === 'add' || subCmd === 'them') {
          const plat = parts[1] || 'tiktok';
          const nick = parts[2];
          const userAcc = parts[3];
          const passAcc = parts[4] || 'imported_session';

          if (!nick || !userAcc) {
            replyText = '⚠️ Thiếu tham số! Cú pháp: `/acc add <platform> <biệt_danh> <username> [password]`';
            break;
          }

          const added = platformAutomation.addAccount(plat, {
            nickname: nick,
            username: userAcc,
            password: passAcc,
            gmail: userAcc
          });

          replyText = `✅ Đã thêm tài khoản [${added.nickname}] vào phân vùng ${plat.toUpperCase()}!`;
        } else if (subCmd === 'del' || subCmd === 'xoa') {
          const plat = parts[1] || 'tiktok';
          const nick = parts[2];

          if (!nick) {
            replyText = '⚠️ Thiếu biệt danh! Cú pháp: `/acc del <platform> <biệt_danh>`';
            break;
          }

          const success = platformAutomation.deleteAccount(plat, nick);
          replyText = success 
            ? `🗑️ Đã xóa tài khoản [${nick}] khỏi ${plat.toUpperCase()}!`
            : `⚠️ Không tìm thấy tài khoản [${nick}] trong ${plat.toUpperCase()}.`;
        } else if (subCmd === 'check' || subCmd === 'kt') {
          const nick = parts[1];
          if (!nick) {
            replyText = '⚠️ Cú pháp: `/acc check <biệt_danh>`';
            break;
          }
          const found = platformAutomation.findAccount(nick);
          if (!found) {
            replyText = `❌ Không tìm thấy tài khoản [${nick}] trong hệ thống.`;
            break;
          }
          const acc = found.account;
          replyText = `🔍 **THÔNG TIN TÀI KHOẢN** [${acc.nickname}]:\n• Platform: ${found.platform.toUpperCase()}\n• Email/User: ${acc.username}\n• Trạng thái: ${acc.status || 'N/A'}\n• Session Cookie: ${acc.hasSession ? '✅ Đã nạp' : '❌ Chưa nạp'}\n• Lần thắp lửa gần nhất: ${acc.lastStreakAt ? new Date(acc.lastStreakAt).toLocaleString('vi-VN') : 'Chưa thắp'}`;
        }
        break;
      }

    case 'streak':
    case 'thapluatiktok':
      {
        const nick = args.trim();
        const found = nick ? platformAutomation.findAccount(nick) : null;
        const targetAcc = found ? found.account : platformAutomation.getAccountsList('tiktok')[0];

        if (!targetAcc) {
          replyText = '❌ Chưa có tài khoản TikTok nào trong hệ thống! Dùng `/acc add tiktok <nick> <user>` để thêm.';
          break;
        }

        replyText = `🔥 Đang chạy tiến trình thắp lửa chuỗi TikTok cho [${targetAcc.nickname}]...\nVui lòng chờ trong giây lát.`;
        await sendZaloMessage(userId, replyText);

        platformAutomation.repChuoiComments('tiktok', targetAcc)
          .then((repCount) => {
            let resMsg = '';
            if (repCount === -1) {
              resMsg = `❌ **ĐĂNG NHẬP THẤT BẠI!** Cookie session của [${targetAcc.nickname}] đã hết hạn. Nạp lại bằng \`/session import ${targetAcc.nickname} <sessionid>\``;
            } else if (repCount === -3) {
              resMsg = `🛑 **CẢNH BÁO BOT!** Tài khoản [${targetAcc.nickname}] gặp Captcha xác minh người dùng. Hãy đăng nhập thủ công trên trình duyệt.`;
            } else if (repCount > 0) {
              resMsg = `🔥 **THẮP LỬA THÀNH CÔNG!** Đã thắp lại lửa cho ${repCount} chuỗi bị xám cho [${targetAcc.nickname}]!`;
            } else {
              resMsg = `✅ Tất cả chuỗi tin nhắn TikTok của [${targetAcc.nickname}] đều đang sáng rực!`;
            }
            sendZaloMessage(userId, resMsg);
          })
          .catch((err) => {
            sendZaloMessage(userId, `❌ Lỗi khi thắp lửa chuỗi: ${err.message}`);
          });

        return;
      }

    default:
      replyText = `Không tìm thấy lệnh "/${command}". Gõ /help để xem danh sách lệnh hỗ trợ.`;
  }

  if (replyText) {
    await sendZaloMessage(userId, replyText);
  }
}

async function getValidZaloAccessToken() {
  if (!cachedAccessToken) {
    throw new Error('Thiếu ZALO_ACCESS_TOKEN hoặc refresh không thành công.');
  }

  if (Date.now() >= tokenExpiresAt - 60 * 1000) {
    await refreshZaloAccessToken();
  }

  return cachedAccessToken;
}

async function refreshZaloAccessToken() {
  if (!ZALO_APP_ID || !ZALO_APP_SECRET || !ZALO_REFRESH_TOKEN) {
    throw new Error('Thiếu ZALO_APP_ID, ZALO_APP_SECRET hoặc ZALO_REFRESH_TOKEN.');
  }

  try {
    const response = await axios.post(
      'https://openapi.zalo.me/v3.0/oa/access_token',
      {
        app_id: ZALO_APP_ID,
        app_secret: ZALO_APP_SECRET,
        refresh_token: ZALO_REFRESH_TOKEN
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );

    const data = response?.data || {};
    if (data.access_token) {
      cachedAccessToken = data.access_token;
      tokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
      console.log('Refresh Zalo access token thành công');
      return cachedAccessToken;
    }

    throw new Error('Không nhận được access token mới từ Zalo.');
  } catch (error) {
    console.error('Lỗi refresh token:', error.response?.data || error.message);
    throw error;
  }
}

async function askGroq(prompt) {
  if (!GROQ_API_KEY) {
    return 'Bạn chưa cấu hình GROQ_API_KEY. Hãy thêm vào file .env.';
  }

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 400
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_API_KEY}`
        }
      }
    );

    return response?.data?.choices?.[0]?.message?.content || 'Groq không trả lời.';
  } catch (error) {
    console.error('Lỗi gọi Groq:', error.response?.data || error.message);
    return 'Không thể kết nối Groq.';
  }
}

async function askOpenAI(prompt) {
  if (!OPENAI_API_KEY) {
    return 'Bạn chưa cấu hình OPENAI_API_KEY. Hãy thêm vào file .env.';
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`
        }
      }
    );

    return response?.data?.choices?.[0]?.message?.content || 'OpenAI không trả lời.';
  } catch (error) {
    console.error('Lỗi gọi OpenAI:', error.response?.data || error.message);
    return 'Không thể kết nối OpenAI.';
  }
}

async function askDeepSeek(prompt) {
  if (!DEEPSEEK_API_KEY) {
    return 'Bạn chưa cấu hình DEEPSEEK_API_KEY. Hãy thêm vào file .env.';
  }

  try {
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`
        }
      }
    );

    return response?.data?.choices?.[0]?.message?.content || 'DeepSeek không trả lời.';
  } catch (error) {
    console.error('Lỗi gọi DeepSeek:', error.response?.data || error.message);
    return 'Không thể kết nối DeepSeek.';
  }
}

function getMediaReply(type) {
  const safeList = {
    girl: [
      'https://example.com/media/girl-1.jpg',
      'https://example.com/media/girl-2.jpg',
      'https://example.com/media/girl-3.jpg'
    ],
    boy: [
      'https://example.com/media/boy-1.jpg',
      'https://example.com/media/boy-2.jpg',
      'https://example.com/media/boy-3.jpg'
    ],
    anime: [
      'https://example.com/media/anime-1.jpg',
      'https://example.com/media/anime-2.jpg',
      'https://example.com/media/anime-3.jpg'
    ],
    vdgirl: [
      'https://example.com/media/vdgirl-1.mp4',
      'https://example.com/media/vdgirl-2.mp4'
    ],
    vdboy: [
      'https://example.com/media/vdboy-1.mp4',
      'https://example.com/media/vdboy-2.mp4'
    ],
    image: [
      'https://example.com/media/sample-1.jpg',
      'https://example.com/media/sample-2.jpg'
    ],
    video: [
      'https://example.com/media/sample-1.mp4',
      'https://example.com/media/sample-2.mp4'
    ]
  };

  if (type === 'vdsex' || type === 'sex' || type === 'xxx') {
    return 'Tôi không hỗ trợ các nội dung nhạy cảm hoặc không phù hợp.';
  }

  const list = safeList[type] || safeList.image;
  const randomItem = list[Math.floor(Math.random() * list.length)];
  return `Link mẫu cho ${type}: ${randomItem}\nNếu bạn có thư mục media local, hãy thay bằng đường dẫn thật như /media/${type}/file.jpg.`;
}

async function sendZaloMessage(userId, textReply, buttons = []) {
  const accessToken = await getValidZaloAccessToken();
  const message = { text: textReply };

  if (buttons.length > 0) {
    message.attachment = {
      type: 'template',
      payload: {
        template_type: 'button',
        text: textReply,
        buttons: buttons.map((button) => ({
          title: button.title,
          type: 'postback',
          payload: button.payload
        }))
      }
    };
  }

  const body = {
    recipient: { user_id: userId },
    message
  };

  try {
    await axios.post('https://openapi.zalo.me/v3.0/oa/message', body, {
      headers: {
        access_token: accessToken,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Lỗi khi gọi Zalo API:', error.response?.data || error.message);
  }
}

app.listen(PORT, () => {
  console.log(`Server Bot Zalo đang chạy tại port ${PORT}`);
});
