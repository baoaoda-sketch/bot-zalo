// index.js - Express server + Zalo OA webhook + AI integrations + game & bank
// This file provides a full, self-contained Express.js server that:
// - Serves a minimal index.html for verification
// - Exposes /zalo/webhook for Zalo OA events (challenge, user_send_text, user_click_button)
// - Integrates simple AI wrappers (Groq, OpenAI, DeepSeek)
// - Offers simple in-memory + disk-persisted user balance and account management
// - Hooks into TikTok automation via platform_automation and tiktok modules

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const platformAutomation = require('./platform_automation');
const tiktok = require('./tiktok');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Suppress ngrok browser warning (common header ngrok respects)
app.use((req, res, next) => {
	res.setHeader('ngrok-skip-browser-warning', '1');
	next();
});

// Persistent paths
const USER_BALANCES_PATH = path.join(__dirname, 'user_balances.json');
const PLATFORM_ACCOUNTS_PATH = path.join(__dirname, 'platform_accounts.json');

let userBalances = {};
let platformAccounts = [];

function loadState() {
	try { if (fs.existsSync(USER_BALANCES_PATH)) userBalances = JSON.parse(fs.readFileSync(USER_BALANCES_PATH, 'utf8')); } catch (e) { console.error('load balances', e.message); }
	try { if (fs.existsSync(PLATFORM_ACCOUNTS_PATH)) platformAccounts = JSON.parse(fs.readFileSync(PLATFORM_ACCOUNTS_PATH, 'utf8')); } catch (e) { console.error('load accounts', e.message); }
}
function saveBalances() { try { fs.writeFileSync(USER_BALANCES_PATH, JSON.stringify(userBalances, null, 2)); } catch (e) { console.error('save balances', e.message); } }
function saveAccounts() { try { fs.writeFileSync(PLATFORM_ACCOUNTS_PATH, JSON.stringify(platformAccounts, null, 2)); } catch (e) { console.error('save accounts', e.message); } }

loadState();

// --- AI wrappers ---
async function callGroq(prompt) {
	try {
		const apiKey = process.env.GROQ_API_KEY || '';
		if (!apiKey) throw new Error('GROQ_API_KEY not configured');
		const r = await axios.post('https://api.groq.ai/generate', { prompt }, { headers: { Authorization: `Bearer ${apiKey}` } });
		return r.data;
	} catch (e) {
		console.error('callGroq error', e.message);
		return null;
	}
}

async function callOpenAI(prompt) {
	try {
		const apiKey = process.env.OPENAI_API_KEY || '';
		if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
		const r = await axios.post('https://api.openai.com/v1/chat/completions', {
			model: 'gpt-4o-mini',
			messages: [{ role: 'user', content: prompt }]
		}, { headers: { Authorization: `Bearer ${apiKey}` } });
		return r.data;
	} catch (e) {
		console.error('callOpenAI error', e.message);
		return null;
	}
}

async function callDeepSeek(prompt) {
	try {
		const apiKey = process.env.DEEPSEEK_API_KEY || '';
		if (!apiKey) throw new Error('DEEPSEEK_API_KEY not configured');
		const r = await axios.post('https://api.deepseek.ai/query', { q: prompt }, { headers: { Authorization: `Bearer ${apiKey}` } });
		return r.data;
	} catch (e) {
		console.error('callDeepSeek error', e.message);
		return null;
	}
}

// --- Zalo webhook ---
app.post('/zalo/webhook', async (req, res) => {
	try {
		const body = req.body || {};
		// Automatic verification challenge
		if (body && body.challenge) return res.json({ challenge: body.challenge });

		const event = body.event || {};
		const type = event.type;

		if (type === 'user_send_text') {
			const data = event.data || {};
			const text = (data.text || '').trim();
			const senderId = String((data.sender && (data.sender.user_id || data.sender.id)) || 'unknown');
			const threadId = data.thread_id || data.room_id || senderId;

			if (text.startsWith('/')) await handleCommand(text, senderId, threadId);
			else {
				// Default: route to AI quick reply (non-blocking)
				callOpenAI(`Người dùng: ${text} \nTrả lời ngắn gọn, thân thiện.`).then(aiRes => {
					console.log('AI reply preview:', aiRes && aiRes.choices ? aiRes.choices[0].message.content : aiRes);
				}).catch(() => {});
			}

			return res.sendStatus(200);
		}

		if (type === 'user_click_button') {
			console.log('Zalo button click', event.data || {});
			return res.sendStatus(200);
		}

		return res.sendStatus(200);
	} catch (e) {
		console.error('zalo webhook error', e.message);
		return res.sendStatus(500);
	}
});

// Periodic refresh for Zalo access token (mocked)
async function refreshZaloAccessToken() {
	try {
		// Real workflow: call Zalo OA access_token endpoint and persist token
		console.log('[Zalo] refreshZaloAccessToken: (mock)');
	} catch (e) { console.error('refreshZaloAccessToken', e.message); }
}
setInterval(refreshZaloAccessToken, 1000 * 60 * 60);

// --- Command handling (games / bank / account / automations) ---
async function handleCommand(text, senderId, threadId) {
	const parts = text.split(/\s+/);
	const cmd = parts[0].toLowerCase();

	try {
		if (cmd === '/daily') {
			const key = senderId;
			const today = new Date().toISOString().slice(0,10);
			userBalances[key] = userBalances[key] || { balance: 0, lastDaily: null };
			if (userBalances[key].lastDaily === today) return console.log('daily already claimed');
			userBalances[key].balance += 5000;
			userBalances[key].lastDaily = today;
			saveBalances();
			console.log(`Gave daily 5k to ${key}`);
			return;
		}

		if (cmd === '/balance') {
			userBalances[senderId] = userBalances[senderId] || { balance: 0 };
			console.log(`Balance ${senderId}:`, userBalances[senderId].balance);
			return;
		}

		if (cmd === '/transfer') {
			const to = parts[1];
			const amt = parseInt(parts[2], 10) || 0;
			if (!to || amt <= 0) return console.log('invalid transfer');
			userBalances[senderId] = userBalances[senderId] || { balance: 0 };
			if (userBalances[senderId].balance < amt) return console.log('insufficient funds');
			userBalances[senderId].balance -= amt;
			userBalances[to] = userBalances[to] || { balance: 0 };
			userBalances[to].balance += amt;
			saveBalances();
			console.log(`Transfer ${amt} from ${senderId} -> ${to}`);
			return;
		}

		if (cmd === '/acc') {
			const sub = parts[1];
			if (sub === 'add') {
				const platform = parts[2];
				const nick = parts[3];
				const user = parts[4];
				const pass = parts[5] || '';
				platformAccounts.push({ platform, nick, user, pass });
				saveAccounts();
				console.log('Account added', nick);
				return;
			}
			if (sub === 'list') {
				console.log('Accounts:', platformAccounts);
				return;
			}
		}

		if (cmd === '/streak') {
			const nick = parts[1];
			const account = platformAccounts.find(a => a.nick === nick);
			if (!account) return console.log('account not found');
			tiktok.startStreakForAccount(account).then(r => console.log('streak job finished', r)).catch(e => console.error(e));
			return;
		}

		// Placeholder for game commands (implement game logic or integrate from other module)
		if (['/taixiu','/chanle','/baucua','/slot'].includes(cmd)) {
			console.log('Game command:', cmd, parts.slice(1));
			return;
		}

		console.log('Unknown command:', text);
	} catch (e) {
		console.error('handleCommand error', e.message);
	}
}

// Root + health
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/ping', (req, res) => res.json({ ok: true, now: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

module.exports = { app, callGroq, callOpenAI, callDeepSeek };
