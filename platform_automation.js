const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execSync } = require('child_process');

// Tự động kiểm tra và import Puppeteer / Puppeteer-Core
let puppeteer;
let hasPuppeteer = false;
try {
    puppeteer = require('puppeteer-core');
    hasPuppeteer = true;
    console.log("🚀 Puppeteer-core đã được tải thành công.");
} catch (e) {
    try {
        puppeteer = require('puppeteer');
        hasPuppeteer = true;
    } catch (e2) {
        console.warn("⚠️ CẢNH BÁO: Thư viện 'puppeteer' chưa được cài đặt.");
        console.warn("👉 Bot sẽ chạy các tác vụ tự động hóa ở chế độ GIẢ LẬP (Mock Mode).");
        console.warn("👉 Để chạy thực tế trên trình duyệt, vui lòng thực hiện: npm install puppeteer");
    }
}

// Cấu hình chạy giả lập (Đặt false để bật trình duyệt thực chạy ngầm)
const USE_MOCK_MODE = false;

// ========= TÍCH HỢP PUppeteer-Extra + Stealth =========
let puppeteerExtra;
let PuppeteerExtraStealth;
try {
    puppeteerExtra = require('puppeteer-extra');
    PuppeteerExtraStealth = require('puppeteer-extra-plugin-stealth');
    if (puppeteerExtra && PuppeteerExtraStealth) {
        puppeteerExtra.use(PuppeteerExtraStealth());
        console.log('[TikTok AntiBot] ✅ Puppeteer-extra + stealth plugin đã được tải.');
    }
} catch (err) {
    console.warn('[TikTok AntiBot] ⚠️ puppeteer-extra / stealth chưa có trong dependencies; sẽ chuyển về Puppeteer gốc.');
}

// ========== TỰ ĐỘNG XÁC ĐỊNH ĐƯỜNG DẪN CHROME ==========
function getChromePath() {
    const paths = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

/**
 * Tìm và kill tiến trình Chrome đang giữ cùng profileDir.
 * Dùng trong trường hợp Puppeteer báo "The browser is already running...".
 * @param {string} profileDir Đường dẫn profile.
 */
function clearStaleProfileLocks(profileDir) {
    try {
        const ps = execSync('ps -eo pid=,args=', { encoding: 'utf8' });
        const lines = ps.split('\n');
        const locks = [];

        for (const line of lines) {
            if (!line || !line.trim()) continue;
            const match = line.trim().match(/^\s*(\d+)\s+(.*)$/);
            if (!match) continue;
            const pid = Number(match[1]);
            const args = match[2] || '';
            const isChromeProcess = /chrome|chromium|chromedriver|puppeteer|browser/i.test(args);
            const pointsToProfile = args.includes('--user-data-dir=') && args.includes(profileDir)
                || args.includes(profileDir);

            if (isChromeProcess && pointsToProfile && pid !== process.pid) {
                locks.push(pid);
            }
        }

        for (const pid of locks) {
            try {
                process.kill(pid, 'SIGTERM');
                console.warn(`[TikTok Browser] 🔪 Đóng tiến trình Chrome/Puppeteer cũ PID=${pid} đang khóa profile ${profileDir}`);
            } catch (e) {
                console.warn(`[TikTok Browser] ⚠️ Không thể kill PID=${pid}: ${e.message}`);
            }
        }

        return locks.length;
    } catch (e) {
        console.warn(`[TikTok Browser] ⚠️ Không thể quét/cắt lock profile ${profileDir}: ${e.message}`);
        return 0;
    }
}

// ========== HỆ THỐNG QUẢN LÝ COOKIE/SESSION & 2FA ==========
const SESSIONS_DIR = path.join(__dirname, 'tiktok_sessions');
const TIKTOK_PROFILE_DIR = path.resolve(path.join(__dirname, 'session_data', 'tiktok_account'));
const activeOtpRequests = {}; // Lưu trữ callback chờ mã OTP từ Zalo

/**
 * Tạo thư mục profile TikTok nếu chưa có.
 * @param {string} profileDir Đường dẫn profile.
 */
function ensureProfileDir(profileDir = TIKTOK_PROFILE_DIR) {
    try {
        if (!fs.existsSync(profileDir)) {
            fs.mkdirSync(profileDir, { recursive: true });
        }
        return true;
    } catch (err) {
        console.error('[TikTok Profile] ❌ Không thể tạo thư mục profile:', err.message);
        return false;
    }
}

/**
 * Khởi tạo browser TikTok với userDataDir cố định.
 * Mục đích: lưu profile/ cookies/session giữa các lần chạy.
 * Lần đầu: headless false để người dùng thực hiện login tay hoặc QR/2FA.
 * Các lần sau: browser sẽ load lại session từ profile đã lưu.
 *
 * @param {object} options
 * @returns {Promise<Browser>} Puppeteer browser instance
 */
async function createTikTokBrowserWithProfile(options = {}) {
    const profileDir = path.resolve(options.profileDir || TIKTOK_PROFILE_DIR);
    const identifier = options.identifier || 'default_tiktok';
    const forceVisible = Boolean(options.forceVisible);

    try {
        ensureProfileDir(profileDir);

        const profileExists = fs.existsSync(path.join(profileDir, 'Default')) || fs.existsSync(path.join(profileDir, 'Local State'));
        const chromePath = getChromePath();
        const launcher = puppeteerExtra || puppeteer;

        if (!launcher) {
            console.warn('[TikTok Browser] ⚠️ Không có Puppeteer/puppeteer-extra, trả về mock browser.');
            return null;
        }

        const shouldBeVisibleOnFirstRun = !profileExists && options.allowHeadlessFirstRun !== true;
        const launchOptions = {
            headless: forceVisible || options.headless === false || shouldBeVisibleOnFirstRun
                ? false
                : (options.headless ?? (profileExists ? 'new' : false)),
            executablePath: chromePath || undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--window-size=1280,800',
                '--profile-directory=Default',
                `--user-data-dir=${profileDir}`,
                '--disable-gpu'
            ],
            ignoreDefaultArgs: ['--enable-automation']
        };

        if (profileExists) {
            console.log(`[TikTok Browser] ✅ Reusing profile folder: ${profileDir}`);
        } else {
            console.log(`[TikTok Browser] 🔓 First run detected, opening visible browser for manual login/QR/2FA. Profile path: ${profileDir}`);
            console.log(`[TikTok Browser] 💡Lần sau profile sẽ được reload tự động từ ${profileDir} mà không cần login lại.`);
        }

        const stale = clearStaleProfileLocks(profileDir);
        if (stale > 0) {
            console.log(`[TikTok Browser] 🔄 Đã thực hiện cleanup ${stale} Chromium/Puppeteer process đang chiếm profile ${profileDir}.`);
        }

        const browser = await launcher.launch(launchOptions);
        const page = await browser.newPage();

        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        return { browser, page, profileDir, identifier, firstRun: !profileExists };
    } catch (err) {
        console.error(`[TikTok Browser] ❌ Lỗi khởi tạo browser với profile ${profileDir}:`, err.message);
        return { browser: null, page: null, profileDir, identifier, firstRun: !fs.existsSync(path.join(profileDir, 'Default')), error: err.message };
    }
}

/**
 * Kiểm tra trạng thái đăng nhập TikTok bằng selector/DOM.
 * Hàm này chạy trước khi thực hiện tác vụ đốt lửa/automation.
 *
 * @param {Page} page page instance
 * @param {object} options
 * @returns {Promise<object>} { loggedIn, reason, details }
 */
async function checkTikTokLoginStatus(page, options = {}) {
    const accountId = options.accountId || 'tiktok_default';

    try {
        if (!page) {
            return { loggedIn: false, reason: 'Browser page is missing', details: {} };
        }

        await page.goto('https://www.tiktok.com/', { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

        await new Promise(resolve => setTimeout(resolve, 1200));
        const bodyText = (await page.evaluate(() => document.body?.innerText || '')).toLowerCase();

        const selectors = [
            '[data-e2e="user-avatar"]',
            'a[href*="/@"]',
            'img[alt*="avatar"]',
            'button[data-e2e="top-nav-profile"]',
            'div[data-e2e="user-title"]'
        ];

        const found = [];
        for (const selector of selectors) {
            try {
                const handle = await page.$(selector);
                if (handle) {
                    found.push(selector);
                }
            } catch (e) {
                // selector không tồn tại trên DOM, bỏ qua
            }
        }

        const explicitLoginSignals = [
            'log in',
            'đăng nhập',
            'login',
            'continue with',
            'email or username'
        ];

        const loginDetected = explicitLoginSignals.some(token => bodyText.includes(token));
        const loggedIn = found.length > 0 && !loginDetected;

        const details = {
            selectorsFound: found,
            bodyContainsLoginCopy: loginDetected,
            bodyLength: bodyText.length,
            url: page.url(),
            verifiedAt: new Date().toISOString()
        };

        if (!loggedIn) {
            console.warn(`[TikTok Session] ⚠️ Login status failed for [${accountId}]. reason=${loginDetected ? 'Landing login page detected' : 'Missing user-profile UI signal'}; details=${JSON.stringify(details)}`);
            if (typeof options.onSessionExpired === 'function') {
                await options.onSessionExpired({ accountId, page, details, reason: 'TikTok session expired or redirected to login page' });
            }
        } else {
            console.log(`[TikTok Session] ✅ Login status OK for [${accountId}]. Profile/UI detection passed.`);
        }

        return { loggedIn, reason: loggedIn ? 'Session valid' : 'Session expired/login required', details };
    } catch (err) {
        console.error(`[TikTok Session] ❌ Lỗi kiểm tra login status:`, err.message);
        if (typeof options.onSessionExpired === 'function') {
            await options.onSessionExpired({ accountId, error: err.message, reason: 'Unexpected login-status check failure' });
        }
        return { loggedIn: false, reason: `Lỗi kiểm tra session: ${err.message}`, details: { error: err.message } };
    }
}

/**
 * Gửi cảnh báo hệ thống khi phát hiện session TikTok bị văng ra login.
 * Cấu hình không crash chương trình; luôn trả về warning object.
 *
 * @param {object} payload Thông tin cảnh báo
 * @returns {Promise<object>} Trạng thái gửi cảnh báo
 */
async function sendTikTokSessionWarning(payload = {}) {
    try {
        const alert = {
            platform: 'tiktok',
            module: 'platform_automation',
            event: 'session_expired_or_login_required',
            timestamp: new Date().toISOString(),
            accountId: payload.accountId || 'unknown',
            reason: payload.reason || 'TikTok session invalid',
            details: payload.details || {}
        };

        console.warn(`[TikTok-OA Warning] 🚨 ${JSON.stringify(alert)}`);

        // Nếu có callback gửi Zalo OA ở runtime, gọi nếu được đăng ký.
        if (typeof global.sendZaloWarning === 'function') {
            await global.sendZaloWarning(alert);
        }

        if (typeof payload.onAlert === 'function') {
            await payload.onAlert(alert);
        }

        return { success: true, alert };
    } catch (err) {
        console.error('[TikTok-OA Warning] ❌ Lỗi gửi cảnh báo:', err.message);
        return { success: false, reason: 'send warning failed', error: err.message };
    }
}

/**
 * Gửi mã OTP từ Zalo cho trình duyệt ngầm đang chờ
 * @param {string} identifier Email Google
 * @param {string} code Mã OTP 6 số
 * @returns {boolean} Đã truyền thành công hay không
 */
function submitOtp(identifier, code) {
    if (activeOtpRequests[identifier]) {
        activeOtpRequests[identifier](code);
        return true;
    }
    // Tìm tương đối nếu không khớp tuyệt đối
    const key = Object.keys(activeOtpRequests).find(k => k.toLowerCase().includes(identifier.toLowerCase()));
    if (key && activeOtpRequests[key]) {
        activeOtpRequests[key](code);
        return true;
    }
    return false;
}

// Đảm bảo thư mục sessions tồn tại
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

/**
 * Tạo tên file session an toàn từ email/username
 * @param {string} identifier Email hoặc username
 * @returns {string} Tên file session
 */
function getSessionFileName(identifier) {
    // Thay thế ký tự đặc biệt để tạo tên file hợp lệ
    const safeName = identifier.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `session_${safeName}.json`;
}

/**
 * Lưu cookies/session sau khi đăng nhập thành công
 * @param {string} identifier Email hoặc username để nhận diện session
 * @param {Array} cookies Mảng cookies từ trình duyệt
 * @param {object} extraData Dữ liệu bổ sung (localStorage, sessionStorage, etc.)
 * @returns {boolean} Lưu thành công hay không
 */
function saveCookies(identifier, cookies, extraData = {}) {
    try {
        const sessionFile = path.join(SESSIONS_DIR, getSessionFileName(identifier));
        const sessionData = {
            identifier: identifier,
            cookies: cookies,
            extraData: extraData,
            savedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // Hết hạn sau 30 ngày
            loginCount: 1,
            lastUsed: new Date().toISOString()
        };

        // Nếu đã có session cũ, tăng loginCount
        if (fs.existsSync(sessionFile)) {
            try {
                const oldSession = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
                sessionData.loginCount = (oldSession.loginCount || 0) + 1;
                sessionData.firstSavedAt = oldSession.firstSavedAt || oldSession.savedAt;
            } catch (e) { /* bỏ qua lỗi đọc file cũ */ }
        } else {
            sessionData.firstSavedAt = sessionData.savedAt;
        }

        fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2), 'utf8');
        console.log(`[Session] ✅ Đã lưu session cho [${identifier}] tại: ${sessionFile}`);
        return true;
    } catch (err) {
        console.error(`[Session] ❌ Lỗi lưu session cho [${identifier}]:`, err.message);
        return false;
    }
}

/**
 * Tải cookies/session đã lưu trước đó
 * @param {string} identifier Email hoặc username
 * @returns {object|null} Dữ liệu session hoặc null nếu không có/hết hạn
 */
function loadCookies(identifier) {
    // Thử nhiều biến thể tên để tìm file session (có @, không @, v.v.)
    const variants = [
        identifier,
        identifier.startsWith('@') ? identifier.substring(1) : `@${identifier}`,
    ];

    for (const tryId of variants) {
        try {
            const sessionFile = path.join(SESSIONS_DIR, getSessionFileName(tryId));
            
            if (!fs.existsSync(sessionFile)) {
                continue; // Thử biến thể tiếp theo
            }

            const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

            // Kiểm tra hết hạn
            if (sessionData.expiresAt && new Date(sessionData.expiresAt) < new Date()) {
                console.log(`[Session] ⚠️ Session cho [${identifier}] đã hết hạn. Xóa session cũ...`);
                fs.unlinkSync(sessionFile);
                return null;
            }

            // Cập nhật thời gian sử dụng cuối
            sessionData.lastUsed = new Date().toISOString();
            fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2), 'utf8');

            console.log(`[Session] ✅ Đã tải session cho [${identifier}] (file: ${getSessionFileName(tryId)})`);
            return sessionData;
        } catch (err) {
            // Tiếp tục thử biến thể khác
        }
    }

    // Thử tìm tất cả file trong thư mục sessions có chứa tên identifier
    try {
        const files = fs.readdirSync(SESSIONS_DIR);
        const cleanId = identifier.replace('@', '').toLowerCase();
        const matchFile = files.find(f => f.toLowerCase().includes(cleanId) && f.endsWith('.json'));
        
        if (matchFile) {
            const sessionFile = path.join(SESSIONS_DIR, matchFile);
            const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

            if (sessionData.expiresAt && new Date(sessionData.expiresAt) < new Date()) {
                console.log(`[Session] ⚠️ Session cho [${identifier}] đã hết hạn.`);
                fs.unlinkSync(sessionFile);
                return null;
            }

            sessionData.lastUsed = new Date().toISOString();
            fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2), 'utf8');
            console.log(`[Session] ✅ Đã tải session cho [${identifier}] (tìm thấy file: ${matchFile})`);
            return sessionData;
        }
    } catch (e) { /* bỏ qua */ }

    console.log(`[Session] Không tìm thấy session đã lưu cho [${identifier}].`);
    return null;
}

/**
 * Kiểm tra session có hợp lệ không (thử load cookie vào trình duyệt và kiểm tra)
 * @param {string} identifier Email hoặc username
 * @returns {Promise<object>} { valid: boolean, session: object|null, reason: string }
 */
async function checkSessionValid(identifier) {
    const sessionData = loadCookies(identifier);
    
    if (!sessionData) {
        return { valid: false, session: null, reason: 'Không có session đã lưu' };
    }

    if (!sessionData.cookies || sessionData.cookies.length === 0) {
        return { valid: false, session: null, reason: 'Session không chứa cookies' };
    }

    // Kiểm tra cookies TikTok quan trọng
    const importantCookieNames = ['sessionid', 'sid_tt', 'uid_tt', 'passport_csrf_token'];
    const hasTikTokCookies = sessionData.cookies.some(c => 
        importantCookieNames.some(name => c.name && c.name.toLowerCase().includes(name))
    );

    if (!hasTikTokCookies && !USE_MOCK_MODE) {
        return { valid: false, session: sessionData, reason: 'Thiếu cookies TikTok quan trọng' };
    }

    // Kiểm tra cookies có bị hết hạn không
    const now = Date.now() / 1000;
    const expiredCookies = sessionData.cookies.filter(c => c.expires && c.expires > 0 && c.expires < now);
    const validCookies = sessionData.cookies.filter(c => !c.expires || c.expires <= 0 || c.expires >= now);

    if (validCookies.length === 0) {
        return { valid: false, session: sessionData, reason: 'Tất cả cookies đã hết hạn' };
    }

    if (expiredCookies.length > 0) {
        console.log(`[Session] ⚠️ ${expiredCookies.length}/${sessionData.cookies.length} cookies đã hết hạn cho [${identifier}]`);
    }

    return { 
        valid: true, 
        session: sessionData, 
        reason: `Session hợp lệ (${validCookies.length} cookies còn hiệu lực)`,
        stats: {
            totalCookies: sessionData.cookies.length,
            validCookies: validCookies.length,
            expiredCookies: expiredCookies.length,
            savedAt: sessionData.savedAt,
            lastUsed: sessionData.lastUsed,
            loginCount: sessionData.loginCount
        }
    };
}

/**
 * Dùng lại session đã lưu để khôi phục đăng nhập trực tiếp vào TikTok.
 * Hàm này sẽ inject cookies vào page hiện tại và kiểm tra xem TikTok đã đăng nhập hay chưa.
 * @param {string} identifier Email hoặc username
 * @param {object} page Puppeteer page instance
 * @param {object} options
 * @returns {Promise<object>} { success, usedSession, reason, session }
 */
async function tryReuseSavedTikTokSession(identifier, page, options = {}) {
    if (!page) {
        return { success: false, usedSession: false, reason: 'Browser page is missing', session: null };
    }

    const sessionData = loadCookies(identifier);
    if (!sessionData || !sessionData.cookies || sessionData.cookies.length === 0) {
        return { success: false, usedSession: false, reason: 'Không có session đã lưu', session: null };
    }

    try {
        if (typeof page.setCookie === 'function') {
            await page.setCookie(...sessionData.cookies);
        }

        const targetUrl = options.targetUrl || 'https://www.tiktok.com/';
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 1200));

        const currentUrl = (page.url && page.url()) || '';
        const bodyText = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).toLowerCase();
        const loginDetected = /log in|đăng nhập|login|continue with|email or username/i.test(bodyText) || currentUrl.includes('/login');
        const isLoggedIn = !loginDetected && currentUrl.includes('tiktok.com') && !currentUrl.includes('/login') && !currentUrl.includes('/signup');

        if (isLoggedIn) {
            try {
                const refreshedCookies = await page.cookies();
                if (refreshedCookies.length > 0) {
                    saveCookies(identifier, refreshedCookies, {
                        ...(sessionData.extraData || {}),
                        loginMethod: sessionData.extraData?.loginMethod || 'saved_session',
                        platform: 'tiktok',
                        reusedFromSavedSession: true
                    });
                }
            } catch (e) {
                // bỏ qua nếu cập nhật cookie mới thất bại
            }

            return { success: true, usedSession: true, reason: 'Đăng nhập bằng session đã lưu', session: sessionData };
        }

        return { success: false, usedSession: false, reason: 'Session đã lưu nhưng chưa thể xác nhận đăng nhập', session: sessionData };
    } catch (err) {
        return { success: false, usedSession: false, reason: `Lỗi dùng lại session: ${err.message}`, session: sessionData };
    }
}

/**
 * Xóa session đã lưu
 * @param {string} identifier Email hoặc username (hoặc 'all' để xóa tất cả)
 * @returns {object} { success: boolean, message: string, deletedCount: number }
 */
function clearSession(identifier) {
    try {
        if (identifier === 'all') {
            // Xóa tất cả sessions
            const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.startsWith('session_') && f.endsWith('.json'));
            let count = 0;
            for (const file of files) {
                fs.unlinkSync(path.join(SESSIONS_DIR, file));
                count++;
            }
            console.log(`[Session] 🗑️ Đã xóa tất cả ${count} session(s).`);
            return { success: true, message: `Đã xóa tất cả ${count} session(s)`, deletedCount: count };
        }

        const sessionFile = path.join(SESSIONS_DIR, getSessionFileName(identifier));
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            console.log(`[Session] 🗑️ Đã xóa session cho [${identifier}].`);
            return { success: true, message: `Đã xóa session cho [${identifier}]`, deletedCount: 1 };
        } else {
            return { success: false, message: `Không tìm thấy session cho [${identifier}]`, deletedCount: 0 };
        }
    } catch (err) {
        console.error(`[Session] ❌ Lỗi xóa session:`, err.message);
        return { success: false, message: `Lỗi: ${err.message}`, deletedCount: 0 };
    }
}

/**
 * Liệt kê tất cả sessions đã lưu
 * @returns {Array<object>} Danh sách sessions với thông tin chi tiết
 */
function listSessions() {
    try {
        if (!fs.existsSync(SESSIONS_DIR)) return [];
        
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.startsWith('session_') && f.endsWith('.json'));
        const sessions = [];

        for (const file of files) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
                const isExpired = data.expiresAt && new Date(data.expiresAt) < new Date();
                sessions.push({
                    identifier: data.identifier,
                    cookieCount: (data.cookies || []).length,
                    savedAt: data.savedAt,
                    lastUsed: data.lastUsed,
                    expiresAt: data.expiresAt,
                    loginCount: data.loginCount || 1,
                    isExpired: isExpired,
                    fileName: file
                });
            } catch (e) {
                sessions.push({
                    identifier: '(lỗi đọc)',
                    fileName: file,
                    isExpired: true
                });
            }
        }

        return sessions;
    } catch (err) {
        console.error(`[Session] ❌ Lỗi liệt kê sessions:`, err.message);
        return [];
    }
}

// ========== KẾT THÚC HỆ THỐNG QUẢN LÝ SESSION ==========

/**
 * Hàm tải ảnh từ URL về cục bộ để Puppeteer upload lên nền tảng
 * @param {string} url 
 * @returns {Promise<string>} Đường dẫn file cục bộ
 */
async function downloadImageToTemp(url) {
    const tempDir = path.join(__dirname, 'temp_images');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const fileName = `img_${Date.now()}_${Math.floor(Math.random() * 1000)}.png`;
    const destPath = path.join(tempDir, fileName);

    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });

    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(destPath);
        response.data.pipe(writer);
        let error = null;
        writer.on('error', err => {
            error = err;
            writer.close();
            reject(err);
        });
        writer.on('close', () => {
            if (!error) {
                resolve(destPath);
            }
        });
    });
}

/**
 * Kiểm tra/truy cập Google và đăng nhập Google trước khi đưa browser sang TikTok OAuth.
 * Mục tiêu: sử dụng cùng profile Chromium lưu session Google để đăng nhập nhanh hơn.
 * @param {Page} page
 * @param {string} googleEmail
 * @param {string} googlePassword
 * @param {object} options
 */
async function loginGoogleFirst(page, googleEmail, googlePassword, options = {}) {
    if (!page) {
        return { success: false, reason: 'Browser page is missing' };
    }

    try {
        console.log(`[TikTok-GG Puppeteer] 🔑 Đăng nhập Google trước, rồi mới dùng Google để vào TikTok...`);
        await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await new Promise(resolve => setTimeout(resolve, 1200));

        const bodyText = (await page.evaluate(() => document.body?.innerText || '')).toLowerCase();
        const currentUrl = page.url().toLowerCase();
        const alreadyGoogleLogged = bodyText.includes('google apps') || bodyText.includes('my account') || currentUrl.includes('myaccount.google.com');
        const accountChooser = currentUrl.includes('accountchooser') || currentUrl.includes('accounts.google.com/accountchooser');
        const challengePage = currentUrl.includes('challenge') || currentUrl.includes('signin/v2/challenge') || bodyText.includes('verify') || bodyText.includes('xác minh');

        if (alreadyGoogleLogged || accountChooser || challengePage) {
            console.log(`[TikTok-GG Puppeteer] ✅ Google session/profile có thể đang hợp lệ trên cùng browser profile hoặc Google đang ở màn hình lạ.`);
            if (challengePage) {
                return { success: false, reason: 'Google requires additional verification' };
            }
            return { success: true, reason: 'Google profile/session already available' };
        }

        try {
            const emailInput = await page.$('input[type="email"]');
            if (emailInput) {
                await page.type('input[type="email"]', googleEmail, { delay: 30 });
                const nextButton = await page.$('#identifierNext, #next, button[type="submit"]');
                if (nextButton) {
                    await nextButton.click();
                }
                await new Promise(resolve => setTimeout(resolve, 1500));
            } else {
                console.log(`[TikTok-GG Puppeteer] ℹ️ Google email form không xuất hiện hoặc đã ở Google đang login sẵn.`);
            }
        } catch (e) {
            console.log(`[TikTok-GG Puppeteer] ℹ️ Google email form không xuất hiện hoặc đã ở Google đang login sẵn: ${e.message}`);
        }

        try {
            const passwordInput = await page.$('input[type="password"]');
            if (passwordInput) {
                await page.type('input[type="password"]', googlePassword, { delay: 30 });
                const passwordButton = await page.$('#passwordNext, #submit, button[type="submit"]');
                if (passwordButton) {
                    await passwordButton.click();
                }
                await new Promise(resolve => setTimeout(resolve, 3500));
            } else {
                console.warn(`[TikTok-GG Puppeteer] ⚠️ Không tìm thấy input password Google. Có thể page đã đăng nhập hoặc đang bị challenge.`);
            }
        } catch (e) {
            console.warn(`[TikTok-GG Puppeteer] ⚠️ Không điền được password Google hoặc Google đã ở trạng thái đã đăng nhập: ${e.message}`);
        }

        const finalGoogleUrl = page.url();
        const bodyAfter = (await page.evaluate(() => document.body?.innerText || '')).toLowerCase();
        const googleChallenge = finalGoogleUrl.includes('challenge') || finalGoogleUrl.includes('signin/v2/challenge') || bodyAfter.includes('verify') || bodyAfter.includes('xác minh');
        const googleBadPassword = bodyAfter.includes('wrong password') || bodyAfter.includes('mật khẩu không đúng') || bodyAfter.includes('sai mật khẩu') || bodyAfter.includes('không đúng') || bodyAfter.includes('try again');
        const googleBadEmail = bodyAfter.includes('couldn\'t find your google account') || bodyAfter.includes('không tìm thấy') || bodyAfter.includes('tài khoản google') || bodyAfter.includes('email không đúng');

        if (googleBadEmail) {
            return { success: false, reason: 'Sai email hoặc mật khẩu Google/TikTok!' };
        }

        if (googleBadPassword) {
            return { success: false, reason: 'Sai email hoặc mật khẩu Google/TikTok!' };
        }

        if (googleChallenge) {
            console.log(`[TikTok-GG Puppeteer] ⚠️ Google cần xác minh bổ sung (2FA/challenge).`);
            return { success: false, reason: 'Google requires additional verification' };
        }

        return { success: true, reason: 'Google login flow attempted' };
    } catch (err) {
        console.error(`[TikTok-GG Puppeteer] Lỗi khi preload Google login:`, err.message);
        return { success: false, reason: err.message };
    }
}

async function scanGoogleLoginInputFields(page) {
    if (!page) {
        return { emailInput: null, passwordInput: null, emailSelector: null, passwordSelector: null, reason: 'Browser page is missing' };
    }

    try {
        const inputEls = await page.$$('input');
        if (!inputEls || inputEls.length === 0) {
            return { emailInput: null, passwordInput: null, emailSelector: null, passwordSelector: null, reason: 'No input elements on Google page' };
        }

        const inputMeta = await page.$$eval('input', (els) => els.map((el) => ({
            type: (el.type || '').toLowerCase(),
            name: (el.name || '').toLowerCase(),
            id: (el.id || '').toLowerCase(),
            autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
            placeholder: (el.getAttribute('placeholder') || '').toLowerCase(),
            aria: (el.getAttribute('aria-label') || '').toLowerCase(),
            value: (el.value || '')
        })));

        const emailIndexes = inputMeta.map((item, idx) => {
            const fieldText = `${item.type} ${item.name} ${item.id} ${item.autocomplete} ${item.placeholder} ${item.aria}`;
            const isEmailCandidate = /email|identifier|user|username|phone|account/i.test(fieldText) || item.type === 'email';
            return isEmailCandidate ? idx : -1;
        }).filter(idx => idx >= 0);

        const passwordIndexes = inputMeta.map((item, idx) => {
            const fieldText = `${item.type} ${item.name} ${item.id} ${item.autocomplete} ${item.placeholder} ${item.aria}`;
            const isPasswordCandidate = /password|pass|current-password/i.test(fieldText) || item.type === 'password';
            return isPasswordCandidate ? idx : -1;
        }).filter(idx => idx >= 0);

        const emailInput = emailIndexes.length > 0 ? inputEls[emailIndexes[0]] : null;
        const passwordInput = passwordIndexes.length > 0 ? inputEls[passwordIndexes[0]] : null;

        return {
            emailInput,
            passwordInput,
            emailSelector: emailIndexes.length > 0 ? `input` : null,
            passwordSelector: passwordIndexes.length > 0 ? `input` : null,
            reason: 'Field scan successful'
        };
    } catch (err) {
        console.warn(`[TikTok-GG Scanner] ⚠️ Không quét được Google input DOM: ${err.message}`);
        return { emailInput: null, passwordInput: null, emailSelector: null, passwordSelector: null, reason: err.message };
    }
}

/**
 * Thử đăng nhập vào TikTok qua tài khoản Google (OAuth)
 * @param {string} googleEmail Email Google để đăng nhập TikTok
 * @param {string} googlePassword Mật khẩu Google
 * @returns {Promise<boolean>} Đăng nhập thành công hay không
 */
async function testLoginTikTokGoogle(googleEmail, googlePassword, options = {}) {
    const { skipSessionCheck = false, forceRelogin = false } = options;
    console.log(`[Test Login TikTok-GG] Đang kiểm tra đăng nhập TikTok bằng Google cho: ${googleEmail}`);
    
    // Kiểm tra định dạng email Google cơ bản
    if (!googleEmail || !googlePassword) {
        console.log(`[Test Login TikTok-GG] Thiếu email hoặc mật khẩu Google.`);
        return { success: false, usedSession: false, reason: 'Thiếu email hoặc mật khẩu' };
    }
    
    if (!googleEmail.includes('@')) {
        console.log(`[Test Login TikTok-GG] Email không hợp lệ: ${googleEmail}`);
        return { success: false, usedSession: false, reason: 'Email không hợp lệ' };
    }

    if (googlePassword.length < 4) {
        console.log(`[Test Login TikTok-GG] Mật khẩu quá ngắn.`);
        return { success: false, usedSession: false, reason: 'Mật khẩu quá ngắn' };
    }

    // ===== BƯỚC 0: THỬ DÙNG SESSION ĐÃ LƯU TRƯỚC =====
    if (!skipSessionCheck && !forceRelogin) {
        const sessionCheck = await checkSessionValid(googleEmail);
        if (sessionCheck.valid) {
            console.log(`[Test Login TikTok-GG] 🔄 Tìm thấy session hợp lệ cho [${googleEmail}]! Bỏ qua đăng nhập lại.`);
            console.log(`[Test Login TikTok-GG] 📊 ${sessionCheck.reason}`);
            console.log(`[Test Login TikTok-GG] 📅 Lưu lần đầu: ${sessionCheck.stats.savedAt} | Dùng gần nhất: ${sessionCheck.stats.lastUsed}`);
            console.log(`[Test Login TikTok-GG] 🔢 Số lần đăng nhập: ${sessionCheck.stats.loginCount}`);
            
            // Trong chế độ thực tế, sẽ thử load cookies vào browser để kiểm tra
            if (!USE_MOCK_MODE && hasPuppeteer) {
                const browserCheck = await _verifySessionWithBrowser(sessionCheck.session);
                if (browserCheck) {
                    return { success: true, usedSession: true, session: sessionCheck.session, reason: 'Đăng nhập bằng session đã lưu' };
                } else {
                    console.log(`[Test Login TikTok-GG] ⚠️ Session đã lưu không còn hiệu lực trên TikTok. Tiến hành đăng nhập lại...`);
                }
            } else {
                // Mock mode: coi session đã lưu là hợp lệ
                return { success: true, usedSession: true, session: sessionCheck.session, reason: 'Đăng nhập bằng session đã lưu (mock)' };
            }
        } else {
            console.log(`[Test Login TikTok-GG] ℹ️ ${sessionCheck.reason}. Tiến hành đăng nhập mới...`);
        }
    } else if (forceRelogin) {
        console.log(`[Test Login TikTok-GG] 🔄 Bắt buộc đăng nhập lại (bỏ qua session cũ)...`);
    }

    // ===== ĐĂNG NHẬP MỚI =====
    if (USE_MOCK_MODE || !hasPuppeteer) {
        // Giả lập quy trình đăng nhập TikTok qua Google OAuth nhiều bước
        console.log(`[GIẢ LẬP TikTok-GG] Bước 1: Mở trang đăng nhập TikTok...`);
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        console.log(`[GIẢ LẬP TikTok-GG] Bước 2: Nhấn nút "Tiếp tục với Google"...`);
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        console.log(`[GIẢ LẬP TikTok-GG] Bước 3: Chuyển hướng sang trang đăng nhập Google...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log(`[GIẢ LẬP TikTok-GG] Bước 4: Nhập email Google: ${googleEmail}...`);
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        console.log(`[GIẢ LẬP TikTok-GG] Bước 5: Nhập mật khẩu Google...`);
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Mô phỏng: Giả định đăng nhập thất bại nếu password sai
        if (googlePassword.toLowerCase() === 'wrong' || googlePassword.toLowerCase() === 'sai') {
            console.log(`[GIẢ LẬP TikTok-GG] ❌ Đăng nhập Google thất bại! Sai mật khẩu.`);
            return { success: false, usedSession: false, reason: 'Sai mật khẩu' };
        }
        
        console.log(`[GIẢ LẬP TikTok-GG] Bước 6: Xác thực Google thành công, đang quay lại TikTok...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Giả lập cookies TikTok sau đăng nhập thành công
        const mockCookies = [
            { name: 'sessionid', value: `mock_sid_${Date.now()}`, domain: '.tiktok.com', path: '/', expires: (Date.now() / 1000) + 86400 * 30 },
            { name: 'sid_tt', value: `mock_sidtt_${Date.now()}`, domain: '.tiktok.com', path: '/', expires: (Date.now() / 1000) + 86400 * 30 },
            { name: 'uid_tt', value: `mock_uid_${Date.now()}`, domain: '.tiktok.com', path: '/', expires: (Date.now() / 1000) + 86400 * 30 },
            { name: 'passport_csrf_token', value: `mock_csrf_${Date.now()}`, domain: '.tiktok.com', path: '/', expires: (Date.now() / 1000) + 86400 * 7 },
            { name: 'tt_csrf_token', value: `mock_ttcsrf_${Date.now()}`, domain: '.tiktok.com', path: '/', expires: (Date.now() / 1000) + 86400 * 7 },
            { name: 'ttwid', value: `mock_ttwid_${Date.now()}`, domain: '.tiktok.com', path: '/', expires: (Date.now() / 1000) + 86400 * 365 }
        ];

        // Lưu session
        const saved = saveCookies(googleEmail, mockCookies, {
            loginMethod: 'google_oauth',
            platform: 'tiktok',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        });

        console.log(`[GIẢ LẬP TikTok-GG] ✅ Đăng nhập TikTok bằng Google thành công!`);
        console.log(`[GIẢ LẬP TikTok-GG] 💾 Lưu session: ${saved ? 'Thành công' : 'Thất bại'}`);
        
        return { success: true, usedSession: false, sessionSaved: saved, reason: 'Đăng nhập mới thành công' };
    }

    // Luồng thực tế bằng Puppeteer cho TikTok Google OAuth (Chạy ngầm 100%)
    let browser;
    try {
        console.log(`[TikTok-GG Headless] 🚀 Mở trình duyệt profile TikTok để xác thực tài khoản Google...`);
        const profileSession = await createTikTokBrowserWithProfile({
            identifier: googleEmail,
            profileDir: path.join(__dirname, 'session_data', 'tiktok_account'),
            forceVisible: false,
            allowHeadlessFirstRun: false,
            headless: 'new'
        });

        if (!profileSession || !profileSession.browser || !profileSession.page) {
            return { success: false, usedSession: false, reason: 'Không thể mở browser profile để chạy Google login TikTok' };
        }

        browser = profileSession.browser;
        const page = profileSession.page;

        const reusedSession = await tryReuseSavedTikTokSession(googleEmail, page, { targetUrl: 'https://www.tiktok.com/' });
        if (reusedSession.success) {
            console.log(`[TikTok-GG Puppeteer] ✅ Dùng lại session đã lưu cho [${googleEmail}] mà không cần đăng nhập lại.`);
            return { success: true, usedSession: true, sessionSaved: true, reason: reusedSession.reason };
        }

        // Bước 0: Đăng nhập Google trước trong cùng profile browser.
        const googlePreLogin = await loginGoogleFirst(page, googleEmail, googlePassword, options);
        if (!googlePreLogin.success && googlePreLogin.reason !== 'Google profile/session already available') {
            console.warn(`[TikTok-GG Puppeteer] ⚠️ Google preload không hoàn tất, tiếp tục thử flow TikTok/Google. Lý do: ${googlePreLogin.reason}`);
        }

        // Bước 1: Mở trang đăng nhập TikTok
        console.log(`[TikTok-GG Puppeteer] Mở trang login TikTok...`);
        await page.goto('https://www.tiktok.com/login', { waitUntil: 'networkidle2', timeout: 30000 });

        const tikTokLoginBody = (await page.evaluate(() => document.body?.innerText || '')).toLowerCase();
        if (/captcha|xác minh|verify|challenge|security|robot|human|bot/i.test(tikTokLoginBody) || page.url().includes('verify') || page.url().includes('challenge')) {
            console.warn(`[TikTok-GG Puppeteer] ⚠️ Google OAuth hoặc TikTok gặp CAPTCHA/xác minh trong bước login. Mở chế độ hiển thị để xử lý thủ công.`);
            await page.screenshot({ path: path.join(__dirname, `google_tiktok_manual_${Date.now()}.png`), fullPage: false });

            try {
                await browser.close();
            } catch (closeErr) {
                console.warn(`[TikTok-GG Puppeteer] ⚠️ Không đóng browser headless trước fallback UI: ${closeErr.message}`);
            }

            const visibleSession = await createTikTokBrowserWithProfile({
                identifier: googleEmail,
                profileDir: path.join(__dirname, 'session_data', 'tiktok_account'),
                forceVisible: true,
                headless: false,
                allowHeadlessFirstRun: true
            });

            if (visibleSession && visibleSession.page) {
                await visibleSession.page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded', timeout: 15000 });
            }

            return {
                success: false,
                usedSession: false,
                captchaRequired: true,
                profileReady: true,
                reason: 'Google/TikTok yêu cầu captcha/xác minh. Trình duyệt hiển thị đã mở để người dùng giải quyết thủ công.'
            };
        }
        
        // Bước 2: Tìm và click nút "Continue with Google" / "Tiếp tục với Google"
        console.log(`[TikTok-GG Puppeteer] Tìm nút đăng nhập bằng Google...`);
        const googleBtnSelectors = [
            'div[class*="google"]',
            'a[href*="google"]',
            'button[class*="google"]',
            '[data-type="google"]',
            'div.tiktok-google-login'
        ];
        
        let googleBtnClicked = false;
        for (const selector of googleBtnSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 5000 });
                await page.click(selector);
                googleBtnClicked = true;
                console.log(`[TikTok-GG Puppeteer] Đã click nút Google login.`);
                break;
            } catch (e) {
                // Thử selector tiếp theo
            }
        }
        
        if (!googleBtnClicked) {
            // Thử tìm bằng text content
            try {
                await page.evaluate(() => {
                    const elements = document.querySelectorAll('div, a, button, span');
                    for (const el of elements) {
                        const text = (el.textContent || '').toLowerCase();
                        if (text.includes('google') && (text.includes('continue') || text.includes('tiếp tục') || text.includes('đăng nhập'))) {
                            el.click();
                            return true;
                        }
                    }
                    return false;
                });
                googleBtnClicked = true;
            } catch (e) {
                console.error(`[TikTok-GG Puppeteer] Không tìm thấy nút Google login.`);
            }
        }
        
        if (!googleBtnClicked) {
            console.error(`[TikTok-GG Puppeteer] Không thể click nút đăng nhập Google trên TikTok.`);
            return { success: false, usedSession: false, reason: 'Không tìm thấy nút đăng nhập Google trên TikTok' };
        }
        
        // Bước 3: Chờ popup hoặc redirect sang trang Google OAuth
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Xử lý popup Google OAuth (nếu mở tab mới)
        const pages = await browser.pages();
        const pageSnapshot = await Promise.all(pages.map(async (p) => {
            try {
                const pageUrl = await p.url();
                return { page: p, url: pageUrl };
            } catch (e) {
                return { page: p, url: '' };
            }
        }));

        let googlePage = pageSnapshot.find(entry => {
            const url = (entry.url || '').toLowerCase();
            return url.includes('accounts.google.com') || url.includes('google.com');
        })?.page || null;

        if (!googlePage && page.url().toLowerCase().includes('accounts.google.com')) {
            googlePage = page;
        }

        if (!googlePage) {
            console.warn(`[TikTok-GG Puppeteer] ⚠️ Google popup/redirect không mở được sau khi click "Google login" trên TikTok. Fallback: tiến hành login Google trong cùng profile/browser trước khi quay lại TikTok.`);

            const fallbackGoogleLogin = await loginGoogleFirst(page, googleEmail, googlePassword, options);
            if (!fallbackGoogleLogin.success && fallbackGoogleLogin.reason !== 'Google profile/session already available') {
                console.error(`[TikTok-GG Puppeteer] ❌ Fallback Google login trong profile không thành công: ${fallbackGoogleLogin.reason}`);
                return { success: false, usedSession: false, reason: `Google popup chưa mở và Google profile fallback không đăng nhập được: ${fallbackGoogleLogin.reason}` };
            }

            await page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded', timeout: 25000 });
            await new Promise(resolve => setTimeout(resolve, 1500));

            const pagesAfterFallback = await browser.pages();
            const pageSnapshotAfterFallback = await Promise.all(pagesAfterFallback.map(async (p) => {
                try {
                    return { page: p, url: await p.url() };
                } catch (e) {
                    return { page: p, url: '' };
                }
            }));

            googlePage = pageSnapshotAfterFallback.find(entry => {
                const url = (entry.url || '').toLowerCase();
                return url.includes('accounts.google.com') || url.includes('google.com');
            })?.page || page;

            if (!googlePage) {
                return { success: false, usedSession: false, reason: 'Google popup chưa mở, nhưng Google profile fallback đã chạy xong, vẫn chưa có page OAuth bên cạnh để tiếp tục.' };
            }
        }

        console.log(`[TikTok-GG Puppeteer] 🔎 Đã chọn tab Google OAuth: ${await googlePage.url()}`);
        
        // Bước 4: Nhập email Google theo DOM live, không hard-code selector email
        console.log(`[TikTok-GG Puppeteer] Nhập email Google...`);
        try {
            const googleFieldScan = await scanGoogleLoginInputFields(googlePage);
            if (!googleFieldScan.emailInput) {
                const bodyText = (await googlePage.evaluate(() => document.body?.innerText || '')).toLowerCase();
                const googleBody = bodyText || '';
                const isGoogleChallenge = /verify|xác minh|challenge|two step|2fa|try another way|security|login|again later|captcha|too many/i.test(googleBody);
                if (isGoogleChallenge) {
                    console.warn(`[TikTok-GG Puppeteer] ⚠️ Google page không có email form cụ thể nhưng đang ở challenge/verify. Trả về manual verify.`);
                    return { success: false, usedSession: false, captchaRequired: true, profileReady: true, reason: 'Google page đang ở challenge/verify/manual flow' };
                }
                console.error(`[TikTok-GG Puppeteer] Lỗi nhập email: không tìm thấy Google email/identifier form. URL=${await googlePage.url()}; body=${googleBody.substring(0,160)}`);
                return { success: false, usedSession: false, reason: `Lỗi nhập email (Google form không phải email/identifier form): URL=${await googlePage.url()}` };
            }

            await googleFieldScan.emailInput.type(googleEmail, { delay: 50 });

            const nextBtnSelectors = ['#identifierNext', '#next', 'button[type="submit"]', 'button', 'input[type="submit"]'];
            for (const sel of nextBtnSelectors) {
                try {
                    await googlePage.click(sel);
                    break;
                } catch (e) { /* thử tiếp */ }
            }
            
            await new Promise(resolve => setTimeout(resolve, 3000));

            const pageText = await googlePage.evaluate(() => document.body.innerText || '');
            if (pageText.includes('Couldn\'t find your Google Account') || pageText.includes('Không tìm thấy tài khoản Google')) {
                return { success: false, usedSession: false, reason: 'Tài khoản/Email Google không tồn tại' };
            }
            if (pageText.includes('Couldn\'t sign you in') || pageText.includes('Trình duyệt này không an toàn')) {
                return { success: false, usedSession: false, reason: 'Google chặn trình duyệt tự động (Trình duyệt không an toàn)' };
            }
        } catch (e) {
            console.error(`[TikTok-GG Puppeteer] Lỗi nhập email:`, e.message);
            const googlePageBody = await googlePage.evaluate(() => document.body.innerText || '').catch(() => '');
            if (/verify|xác minh|challenge|two step|2fa|too many|captcha|try again/i.test(googlePageBody)) {
                return { success: false, usedSession: false, captchaRequired: true, profileReady: true, reason: `Google cần verification/challenge: ${e.message}` };
            }
            return { success: false, usedSession: false, reason: `Lỗi nhập email (Google timeout/block): ${e.message}` };
        }
        
        // Bước 5: Nhập mật khẩu Google bằng scan DOM và không gán selector cứng
        console.log(`[TikTok-GG Puppeteer] Nhập mật khẩu Google...`);
        try {
            const googleFieldScanAfterEmail = await scanGoogleLoginInputFields(googlePage);
            if (!googleFieldScanAfterEmail.passwordInput) {
                const passPageText = await googlePage.evaluate(() => document.body.innerText || '').catch(() => '');
                if (/wrong password|mật khẩu không đúng|sai mật khẩu|password/i.test(passPageText) || /challenge|verify|xác minh|two step|2fa|security/i.test(passPageText)) {
                    return { success: false, usedSession: false, captchaRequired: true, profileReady: true, reason: 'Google đang kiếm xác minh/challenge/password step sau khi điền email' };
                }
                console.warn(`[TikTok-GG Puppeteer] ⚠️ Google page không thấy password form sau khi điền email. URL=${await googlePage.url()}; body=${passPageText.substring(0,160)}`);
                return { success: false, usedSession: false, reason: `Google page không có password form để nhập: ${await googlePage.url()}` };
            }

            await googleFieldScanAfterEmail.passwordInput.type(googlePassword, { delay: 50 });

            const passBtnSelectors = ['#passwordNext', '#submit', 'button[type="submit"]', 'button', 'input[type="submit"]'];
            for (const sel of passBtnSelectors) {
                try {
                    await googlePage.click(sel);
                    break;
                } catch (e) { /* thử tiếp */ }
            }
            
            await new Promise(resolve => setTimeout(resolve, 4000));

            const passPageText = await googlePage.evaluate(() => document.body.innerText || '');
            if (passPageText.includes('Wrong password') || passPageText.includes('Mật khẩu không đúng') || passPageText.includes('Sai mật khẩu')) {
                return { success: false, usedSession: false, reason: 'Mật khẩu Google không chính xác' };
            }
        } catch (e) {
            console.error(`[TikTok-GG Puppeteer] Lỗi nhập mật khẩu:`, e.message);
            const passPageText = await googlePage.evaluate(() => document.body.innerText || '').catch(() => '');
            if (passPageText.includes('Wrong password') || passPageText.includes('Mật khẩu không đúng')) {
                return { success: false, usedSession: false, reason: 'Mật khẩu Google không chính xác' };
            }
            if (/verify|xác minh|challenge|two step|2fa|security|captcha/i.test(passPageText)) {
                return { success: false, usedSession: false, captchaRequired: true, profileReady: true, reason: `Google verification/challenge đang chặn bước tiếp: ${e.message}` };
            }
            return { success: false, usedSession: false, reason: `Lỗi nhập mật khẩu: ${e.message}` };
        }
        
        // Bước 5.5: Kiểm tra xác minh 2 bước (2FA) Google
        let currentGoogleUrl = googlePage.url();
        const is2FA = currentGoogleUrl.includes('challenge') || 
                      currentGoogleUrl.includes('signin/v2/challenge') || 
                      currentGoogleUrl.includes('two-step-verification') ||
                      (await googlePage.$('input[type="tel"], input[name="totpPin"], #totpPin'));

        if (is2FA) {
            console.log(`[TikTok-GG Puppeteer] ⚠️ Phát hiện Yêu cầu xác minh 2 bước (2FA)!`);
            
            // Gọi callback thông báo qua Zalo nếu được truyền vào options
            if (typeof options.onRequire2FA === 'function') {
                options.onRequire2FA(googleEmail);
            }

            // Lưu Promise chờ OTP từ người dùng gửi qua Zalo trong tối đa 90 giây
            const otpCode = await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    delete activeOtpRequests[googleEmail];
                    resolve(null);
                }, 90000); // Hạn ngạch 90s

                activeOtpRequests[googleEmail] = (code) => {
                    clearTimeout(timeout);
                    delete activeOtpRequests[googleEmail];
                    resolve(code);
                };
            });

            if (!otpCode) {
                console.error(`[TikTok-GG Puppeteer] ❌ Hết thời gian chờ nhập OTP 2FA cho [${googleEmail}].`);
                return { success: false, usedSession: false, reason: 'Quá thời gian 90s chờ nhập mã 2FA OTP từ Zalo' };
            }

            console.log(`[TikTok-GG Puppeteer] 🔑 Đã nhận mã OTP: ${otpCode}. Đang điền vào Google...`);

            try {
                // Điền OTP vào input
                const otpSelector = 'input[type="tel"], input[name="totpPin"], #totpPin, input[type="text"]';
                await googlePage.waitForSelector(otpSelector, { timeout: 10000 });
                await googlePage.type(otpSelector, otpCode, { delay: 50 });

                // Click Next / Tiếp theo
                const nextBtnSelectors = ['#totpNext', '#idvPreregisteredPhoneNext', 'button[type="submit"]', '#next'];
                for (const sel of nextBtnSelectors) {
                    try {
                        await googlePage.click(sel);
                        break;
                    } catch (e) { /* thử tiếp */ }
                }

                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (otpErr) {
                console.error(`[TikTok-GG Puppeteer] Lỗi khi điền OTP:`, otpErr.message);
                return { success: false, usedSession: false, reason: `Mã OTP không đúng hoặc lỗi: ${otpErr.message}` };
            }
        }

        // Bước 6: Kiểm tra kết quả - xem đã về TikTok chưa
        await new Promise(resolve => setTimeout(resolve, 3000));
        const finalUrl = page.url();
        const isLoggedIn = !finalUrl.includes('/login') && (finalUrl.includes('tiktok.com') || finalUrl.includes('foryou'));
        
        if (isLoggedIn) {
            // ===== LƯU COOKIES SAU KHI ĐĂNG NHẬP THÀNH CÔNG =====
            console.log(`[TikTok-GG Puppeteer] ✅ Đăng nhập thành công! Đang lưu cookies...`);
            const cookies = await page.cookies();
            const saved = saveCookies(googleEmail, cookies, {
                loginMethod: 'google_oauth',
                platform: 'tiktok',
                finalUrl: finalUrl,
                userAgent: await page.evaluate(() => navigator.userAgent)
            });
            console.log(`[TikTok-GG Puppeteer] 💾 Lưu ${cookies.length} cookies: ${saved ? 'Thành công' : 'Thất bại'}`);
        }
        
        console.log(`[TikTok-GG Puppeteer] URL hiện tại: ${finalUrl} | Đăng nhập: ${isLoggedIn ? 'Thành công' : 'Thất bại'}`);
        return { 
            success: isLoggedIn, 
            usedSession: false, 
            sessionSaved: isLoggedIn, 
            reason: isLoggedIn ? 'Đăng nhập mới thành công' : 'Không xác nhận được trạng thái đăng nhập thành công trên TikTok' 
        };
        
    } catch (err) {
        console.error(`[TikTok-GG Puppeteer Error]:`, err.message);
        return { success: false, usedSession: false, reason: `Lỗi Puppeteer: ${err.message}` };
    } finally {
        if (browser) await browser.close();
    }
}

/**
 * Xác minh session đã lưu bằng cách load cookies vào trình duyệt (chỉ dùng khi Puppeteer khả dụng)
 * @param {object} sessionData Dữ liệu session đã load
 * @returns {Promise<boolean>} Session còn hiệu lực trên TikTok không
 */
async function _verifySessionWithBrowser(sessionData) {
    if (!hasPuppeteer || !sessionData || !sessionData.cookies) return false;
    
    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: getChromePath(),
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();
        await page.setUserAgent(sessionData.extraData?.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");

        // Load cookies đã lưu vào trình duyệt
        await page.setCookie(...sessionData.cookies);

        // Truy cập TikTok để kiểm tra đã đăng nhập chưa
        await page.goto('https://www.tiktok.com/foryou', { waitUntil: 'networkidle2', timeout: 20000 });
        
        const finalUrl = page.url();
        const isLoggedIn = !finalUrl.includes('/login');
        
        if (isLoggedIn) {
            // Cập nhật cookies mới (có thể TikTok đã refresh một số cookies)
            const newCookies = await page.cookies();
            if (newCookies.length > 0) {
                saveCookies(sessionData.identifier, newCookies, sessionData.extraData);
            }
        }

        return isLoggedIn;
    } catch (err) {
        console.error(`[Session Verify] Lỗi xác minh session:`, err.message);
        return false;
    } finally {
        if (browser) await browser.close();
    }
}

/**
 * Thử đăng nhập vào nền tảng để kiểm tra tài khoản hoạt động
 * @param {string} platform Nền tảng: facebook, thread, ig, yt, tiktok, tiktok-gg
 * @param {string} username Tên đăng nhập (hoặc email Google nếu tiktok-gg)
 * @param {string} password Mật khẩu (hoặc mật khẩu Google nếu tiktok-gg)
 * @returns {Promise<object|boolean>} Đăng nhập thành công hay không
 */
async function testLogin(platform, username, password, options = {}) {
    console.log(`[Test Login] Đang kiểm tra đăng nhập nền tảng: ${platform.toUpperCase()} cho user: ${username}`);
    
    // Xử lý đặc biệt cho TikTok đăng nhập bằng Google
    if (platform === 'tiktok-gg') {
        return await testLoginTikTokGoogle(username, password);
    }
    
    // Kiểm tra định dạng cơ bản trước
    if (!username || !password || username.length < 3 || password.length < 4) {
        console.log(`[Test Login] Thông tin đăng nhập không hợp lệ.`);
        return { success: false, reason: 'Tên đăng nhập hoặc mật khẩu quá ngắn' };
    }

    if (USE_MOCK_MODE || !hasPuppeteer) {
        // Mô phỏng độ trễ kiểm tra mạng xã hội thực tế
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Mô phỏng: Giả định đăng nhập thành công nếu thông tin không phải chuỗi test sai
        if (password.toLowerCase() === 'wrong' || password.toLowerCase() === 'sai') {
            return { success: false, reason: 'Mật khẩu sai (Giả lập)' };
        }
        return { success: true, reason: 'Đăng nhập thành công (Giả lập)' };
    }

    // Luồng thực tế bằng Puppeteer
    let browser;
    try {
        if (platform === 'tiktok') {
            const cleanUser = username.startsWith('@') ? username.substring(1) : username;
            console.log(`[TikTok Direct Login] Đang thử kiểm tra tài khoản TikTok cho: ${cleanUser}`);

            const profileSession = await createTikTokBrowserWithProfile({
                identifier: cleanUser,
                profileDir: path.join(__dirname, 'session_data', 'tiktok_account'),
                // Cố gắng chạy tự động trên headless Chromium; nếu cần dùng UI thủ công thì forceVisible sẽ được bật ở fallback.
                forceVisible: false,
                headless: 'new'
            });

            if (!profileSession || !profileSession.browser || !profileSession.page) {
                return { success: false, reason: 'Không thể khởi tạo browser TikTok profile/re-login flow.' };
            }

            browser = profileSession.browser;
            const page = profileSession.page;

            const reusedDirectSession = await tryReuseSavedTikTokSession(cleanUser, page, { targetUrl: 'https://www.tiktok.com/' });
            if (reusedDirectSession.success) {
                console.log(`[TikTok Direct Login] ✅ Dùng lại session đã lưu cho [${cleanUser}]`);
                return { success: true, usedSession: true, reason: reusedDirectSession.reason };
            }

            try {
                const loginRoutes = [
                    'https://www.tiktok.com/login',
                    'https://www.tiktok.com/login/phone-or-email/email',
                    'https://www.tiktok.com/login/phone-or-email/phone'
                ];

                let selectedTikTokLoginUrl = null;
                let pageReadyForCredentials = false;

                for (const loginUrl of loginRoutes) {
                    try {
                        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
                        await new Promise(r => setTimeout(r, 1200));

                        const liveBody = (await page.evaluate(() => document.body?.innerText || '')).toLowerCase();
                        const inputCount = await page.$$eval('input', (els) => els.length);
                        const hasUserField = await page.$$eval('input', (els) => els.some((el) => {
                            const name = (el.name || '').toLowerCase();
                            const type = (el.type || '').toLowerCase();
                            const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
                            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                            const fieldText = `${name} ${type} ${placeholder} ${aria}`;
                            return /username|user|email|phone|account/i.test(fieldText) || type === 'text';
                        }));
                        const hasPasswordField = await page.$$eval('input', (els) => els.some((el) => (el.type || '').toLowerCase() === 'password' || (el.name || '').toLowerCase() === 'password'));

                        if (inputCount > 0 && hasUserField && hasPasswordField) {
                            console.log(`[TikTok Direct Login] ✅ Chọn URL login hiện có form: ${loginUrl}`);
                            selectedTikTokLoginUrl = loginUrl;
                            pageReadyForCredentials = true;
                            break;
                        } else if (liveBody.includes('login') || liveBody.includes('đăng nhập') || liveBody.includes('email') || liveBody.includes('phone')) {
                            console.log(`[TikTok Direct Login] ℹ️ URL login có trả về UI nhưng chưa xác định đủ field: ${loginUrl}`);
                        }
                    } catch (e) {
                        console.warn(`[TikTok Direct Login] ⚠️ Route login ${loginUrl} không mở được: ${e.message}`);
                    }
                }

                if (!selectedTikTokLoginUrl) {
                    console.warn(`[TikTok Direct Login] ⚠️ Không tìm thấy URL login nào trả về form đăng nhập rõ ràng. Dừng flow và trả về cảnh báo UI.`);
                    return { success: false, reason: 'Không phát hiện được form login TikTok phù hợp với login route hiện tại.' };
                }

                const userInputCandidates = [
                    'input[name="username"]',
                    'input[name="email"]',
                    'input[name="phone"]',
                    'input[type="text"]',
                    'input[type="email"]',
                    'input[autocomplete="username"]',
                    'input[aria-label*="email"]',
                    'input[placeholder*="email"]',
                    'input[placeholder*="phone"]',
                    'input[placeholder*="username"]'
                ];

                let userInput = null;
                for (const selector of userInputCandidates) {
                    try {
                        const element = await page.$(selector);
                        if (element) {
                            userInput = element;
                            break;
                        }
                    } catch (e) {
                        // selector không hợp lệ/đọc không thành công => thử tiếp
                    }
                }

                // Fallback DOM-detect: tìm qua node input trong DOM nếu CSS selector không bắt được
                if (!userInput) {
                    try {
                        const inputEls = await page.$$('input');
                        const inputMeta = await page.$$eval('input', (els) => els.map((el) => ({
                            name: (el.name || '').toLowerCase(),
                            type: (el.type || '').toLowerCase(),
                            autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
                            aria: (el.getAttribute('aria-label') || '').toLowerCase(),
                            placeholder: (el.getAttribute('placeholder') || '').toLowerCase()
                        })));

                        const fallbackIdx = inputMeta.findIndex((item) => {
                            const textHints = `${item.name} ${item.type} ${item.autocomplete} ${item.aria} ${item.placeholder}`;
                            return /username|user|email|phone|số điện thoại|account/i.test(textHints) || item.type === 'text';
                        });

                        if (fallbackIdx >= 0 && inputEls[fallbackIdx]) {
                            userInput = inputEls[fallbackIdx];
                        }
                    } catch (e) {
                        console.warn(`[TikTok Direct Login] ⚠️ DOM fallback finder không kết nối input được: ${e.message}`);
                    }
                }

                const passInput = await page.$('input[type="password"], input[name="password"]');

                if (userInput && passInput) {
                    await userInput.type(cleanUser, { delay: 50 });
                    await passInput.type(password, { delay: 50 });

                    const loginBtn = await page.$('button[type="submit"], button[data-e2e="login-button"], button[data-e2e="submit"]');
                    if (loginBtn) {
                        await loginBtn.click();
                        await new Promise(r => setTimeout(r, 4000));
                    } else {
                        const btns = await page.$$eval('button, a, div', (els) => els);
                        const loginButtonIndex = btns.findIndex((el) => /đăng nhập|log in|login|continue|tiếp tục/i.test((el.textContent || '').trim()) || el.getAttribute('type') === 'submit');
                        if (loginButtonIndex >= 0) {
                            await btns[loginButtonIndex].click();
                            await new Promise(r => setTimeout(r, 3000));
                        }
                    }
                } else {
                    const bodyText = await page.evaluate(() => document.body?.innerText || '');
                    const bodyLower = (bodyText || '').toLowerCase();
                    const loginUiChanged = /login|đăng nhập|captcha|xác minh|verify|challenge|security|robot|hoạt động|email|phone/i.test(bodyLower);
                    if (loginUiChanged) {
                        console.warn(`[TikTok Direct Login] ⚠️ TikTok đang ở UI login mới hoặc bẫy xác minh. Thực hiện trả về chính xác "không thấy form" thay vì giả định nhập field đã có.`);
                    }
                }

                const currentUrl = page.url();
                const inVerification = /verify|challenge|captcha|security|robot|human/i.test(currentUrl)
                    || /verify|challenge|captcha|security|robot|human/i.test((await page.evaluate(() => document.body?.innerText || '')).toLowerCase());

                if (inVerification) {
                    console.warn(`[TikTok Direct Login] ⚠️ Chuyển sang trang xác minh/captcha sau khi gửi form.`);
                    await sendTikTokSessionWarning({
                        accountId: cleanUser,
                        reason: 'Direct TikTok login reached verify/challenge/captcha page',
                        details: { url: currentUrl }
                    });
                    return {
                        success: false,
                        captchaRequired: true,
                        reason: 'TikTok yêu cầu captcha/xác minh. Trình duyệt hiển thị đã mở để xử lý thủ công.',
                        profileReady: true
                    };
                }

                const pageBodyAfterSubmit = (await page.evaluate(() => document.body?.innerText || '')).toLowerCase();
                const otpOr2faSignup = /two-step|2fa|two step|xác minh 2|mã otp|tài khoản bảo mật|otp|điện thoại|verification code/i.test(pageBodyAfterSubmit);
                if (otpOr2faSignup) {
                    console.warn(`[TikTok Direct Login] ⚠️ 2FA/OTP/TikTok xác minh được phát hiện cho [${cleanUser}]`);
                    if (typeof options.onRequire2FA === 'function') {
                        await options.onRequire2FA(cleanUser);
                    }

                    const otpCode = await new Promise((resolve) => {
                        const timeout = setTimeout(() => {
                            delete activeOtpRequests[cleanUser];
                            resolve(null);
                        }, 90000);

                        activeOtpRequests[cleanUser] = (code) => {
                            clearTimeout(timeout);
                            delete activeOtpRequests[cleanUser];
                            resolve(code);
                        };
                    });

                    if (!otpCode) {
                        return { success: false, reason: 'Quá thời gian 90s chờ mã OTP/Zalo 2FA cho TikTok trực tiếp.' };
                    }

                    const otpInputs = await page.$$('input[type="text"], input[type="tel"], input[name="otp"], input[name="code"]');
                    if (otpInputs.length > 0) {
                        for (const input of otpInputs) {
                            await input.type(otpCode, { delay: 40 });
                        }
                        await page.click('button[type="submit"]');
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }

                const afterSubmitUrl = page.url();
                const isLoggedIn = !afterSubmitUrl.includes('/login');

                if (isLoggedIn) {
                    const cookies = await page.cookies();
                    saveCookies(cleanUser, cookies, { platform: 'tiktok', loginMethod: 'direct' });
                    return { success: true, reason: 'Đăng nhập TikTok trực tiếp thành công!' };
                }

                const bodyText = await page.evaluate(() => document.body.innerText || '');
                const bodyLower = (bodyText || '').toLowerCase();
                const captchaDetected = /captcha|xác minh|verify|challenge|security|robot|human|bot/i.test(bodyLower);
                const rateLimitDetected = /maximum number of attempts reached|too many attempts|try again later|too many attempts|rate limit|rate-limited|quá nhiều lần thử|quá số lần thử|bị khóa tạm thời|khóa tạm thời|too many login attempts|too much traffic|đăng nhập quá nhiều|tài khoản tạm thời/i.test(bodyLower);
                const credentialFailure = /wrong password|mật khẩu không đúng|sai mật khẩu|wrong username|email\/sdt|nhầm|incorrect|not found|không chính xác|username or password|login failed|tài khoản hoặc mật khẩu/i.test(bodyLower);

                if (rateLimitDetected) {
                    console.warn(`[TikTok Direct Login] ⚠️ Tiktok đang chặn/bỏ qua do rate-limit/anti-bot/block cho [${cleanUser}].`);
                    await sendTikTokSessionWarning({
                        accountId: cleanUser,
                        reason: 'TikTok rate-limit or anti-bot protection triggered during direct login',
                        details: { url: page.url(), bodySnippet: bodyText.substring(0, 250) }
                    });

                    const tempImageDir = path.join(__dirname, 'temp_images');
                    if (!fs.existsSync(tempImageDir)) fs.mkdirSync(tempImageDir, { recursive: true });

                    const screenshotPath = path.join(tempImageDir, `rate_limit_${Date.now()}.png`);
                    await page.screenshot({ path: screenshotPath, fullPage: false });

                    try {
                        await browser.close();
                    } catch (closeErr) {
                        console.warn(`[TikTok Direct Login] ⚠️ Không đóng được browser headless trước fallback anti-bot: ${closeErr.message}`);
                    }

                    const visibleSession = await createTikTokBrowserWithProfile({
                        identifier: cleanUser,
                        profileDir: path.join(__dirname, 'session_data', 'tiktok_account'),
                        forceVisible: true,
                        headless: false,
                        allowHeadlessFirstRun: true
                    });

                    if (visibleSession && visibleSession.page) {
                        await visibleSession.page.goto('https://www.tiktok.com/login/phone-or-email/email', { waitUntil: 'domcontentloaded', timeout: 15000 });
                    }

                    return {
                        success: false,
                        captchaRequired: true,
                        profileReady: true,
                        reason: 'TikTok đang chặn đăng nhập do quá nhiều lần thử / anti-bot (rate-limit). Trình duyệt hiển thị đã mở để bạn nhập thủ công.',
                        screenshotPath
                    };
                }

                if (credentialFailure) {
                    return { success: false, reason: 'Sai email hoặc mật khẩu TikTok.' };
                }

                if (captchaDetected) {
                    console.warn(`[TikTok Direct Login] ⚠️ Captcha/verify page detected for [${cleanUser}]. Bật browser hiển thị để người dùng nhập/giải thủ công.`);
                    await sendTikTokSessionWarning({
                        accountId: cleanUser,
                        reason: 'Captcha or security verification required during TikTok direct login',
                        details: { url: page.url(), bodySnippet: bodyText.substring(0, 250) }
                    });

                    const tempImageDir = path.join(__dirname, 'temp_images');
                    if (!fs.existsSync(tempImageDir)) {
                        fs.mkdirSync(tempImageDir, { recursive: true });
                    }

                    const captchaShotPath = path.join(tempImageDir, `captcha_${Date.now()}.png`);
                    await page.screenshot({ path: captchaShotPath, fullPage: false });

                    try {
                        await browser.close();
                    } catch (closeErr) {
                        console.warn(`[TikTok Direct Login] ⚠️ Không đóng được browser headless trước khi bật visible fallback: ${closeErr.message}`);
                    }

                    const visibleSession = await createTikTokBrowserWithProfile({
                        identifier: cleanUser,
                        profileDir: path.join(__dirname, 'session_data', 'tiktok_account'),
                        forceVisible: true,
                        headless: false,
                        allowHeadlessFirstRun: true
                    });

                    if (visibleSession && visibleSession.page) {
                        await visibleSession.page.goto('https://www.tiktok.com/login/phone-or-email/email', { waitUntil: 'domcontentloaded', timeout: 15000 });
                    }

                    console.log(`[TikTok Direct Login] 👀 Trình duyệt đã mở ở chế độ hiển thị để bạn nhập captcha hoặc xác minh thủ công. Ảnh chụp lưu tại ${captchaShotPath}`);

                    return {
                        success: false,
                        captchaRequired: true,
                        reason: 'TikTok yêu cầu captcha/xác minh. Trình duyệt hiển thị đã mở để bạn nhập thủ công.',
                        profileDir: profileSession.profileDir,
                        profileReady: true,
                        screenshotPath: captchaShotPath
                    };
                }

                if (credentialFailure) {
                    return { success: false, reason: 'Tên đăng nhập hoặc mật khẩu TikTok không đúng / thông tin trả về từ TikTok báo sai xác thực.' };
                }

                if (!userInput || !passInput) {
                    const failedLoginUrl = page.url();
                    const failedBody = (await page.evaluate(() => document.body?.innerText || '')).substring(0, 250);
                    return {
                        success: false,
                        reason: `Không tìm thấy form nhập TikTok hợp lệ. URL hiện tại: ${failedLoginUrl}; nội dung UI: ${failedBody || 'không đọc được body'}`
                    };
                }

                const finalUrl = page.url();
                const finalBody = (await page.evaluate(() => document.body?.innerText || '')).substring(0, 250);
                return {
                    success: false,
                    reason: `Không thể đăng nhập tự động trên TikTok. URL hiện tại: ${finalUrl}; UI trả về: ${finalBody || 'không đọc được body'}`
                };
            } catch (err) {
                console.error(`[TikTok Direct Login Error]:`, err.message);
                await sendTikTokSessionWarning({
                    accountId: cleanUser,
                    reason: 'Unhandled direct TikTok login error',
                    details: { error: err.message }
                });
                return { success: false, reason: `Lỗi truy cập TikTok: ${err.message}` };
            }
        }

        browser = await puppeteer.launch({
            executablePath: getChromePath(),
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled'
            ]
        });
        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

        if (platform === 'facebook') {
            await page.goto('https://www.facebook.com/login', { waitUntil: 'networkidle2' });
            await page.type('#email', username);
            await page.type('#pass', password);
            await Promise.all([
                page.click('#loginbutton'),
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })
            ]);
            
            // Kiểm tra xem URL có chứa '/login' hay không để đoán xem đã login thành công chưa
            const currentUrl = page.url();
            const success = !currentUrl.includes('/login') && !currentUrl.includes('checkpoint');
            return { success, reason: success ? 'Đăng nhập Facebook thành công' : 'Đăng nhập Facebook thất bại' };
        } 
        
        else if (platform === 'ig') {
            await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2' });
            await page.waitForSelector('input[name="username"]', { timeout: 10000 });
            await page.type('input[name="username"]', username);
            await page.type('input[name="password"]', password);
            await page.click('button[type="submit"]');
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
            
            const currentUrl = page.url();
            const success = !currentUrl.includes('/login');
            return { success, reason: success ? 'Đăng nhập Instagram thành công' : 'Đăng nhập Instagram thất bại' };
        } 
        
        else if (platform === 'thread') {
            return { success: true, reason: 'Tài khoản Threads hợp lệ' }; 
        } 
        
        else if (platform === 'yt') {
            return { success: true, reason: 'Tài khoản YouTube hợp lệ' };
        }

        return { success: true, reason: 'Thành công' };
    } catch (err) {
        console.error(`[Puppeteer Login Error] Nền tảng ${platform}:`, err.message);
        return { success: false, reason: `Lỗi Puppeteer: ${err.message}` };
    } finally {
        if (browser) await browser.close();
    }
}

/**
 * Tự động rải tin (đăng bài) kèm ảnh, link và chủ đề
 * @param {string} platform Nền tảng: facebook, thread, ig, yt, tiktok
 * @param {string} imageUrl Link ảnh đính kèm (Zalo URL)
 * @param {string} link Link bài viết cần quảng bá
 * @param {string} topic Chủ đề / nội dung mô tả
 * @param {object} account Thông tin tài khoản đăng bài
 * @returns {Promise<boolean>}
 */
async function postSpam(platform, imageUrl, link, topic, account) {
    console.log(`[Auto Post] Bắt đầu đăng bài trên ${platform.toUpperCase()}...`);
    console.log(`[Auto Post] Tài khoản sử dụng: ${account ? account.username : 'Mặc định/Không có'}`);
    console.log(`[Auto Post] Link: ${link} | Chủ đề: ${topic}`);

    let localImagePath = null;
    if (imageUrl) {
        try {
            console.log(`[Auto Post] Đang tải ảnh đính kèm từ Zalo...`);
            localImagePath = await downloadImageToTemp(imageUrl);
            console.log(`[Auto Post] Đã lưu ảnh tạm thời tại: ${localImagePath}`);
        } catch (downloadErr) {
            console.error(`[Auto Post] Lỗi khi tải ảnh đính kèm:`, downloadErr.message);
        }
    }

    const postContent = `🔥 [${topic.toUpperCase()}] 🔥\n\n📌 Xem chi tiết tại: ${link}\n#${platform} #marketing #automation`;

    if (USE_MOCK_MODE || !hasPuppeteer) {
        // Giả lập tiến trình đăng bài trực quan qua console
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log(`[GIẢ LẬP ${platform.toUpperCase()}] Đăng nhập tài khoản ${account ? account.username : 'Admin'}`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (localImagePath) {
            console.log(`[GIẢ LẬP ${platform.toUpperCase()}] Đang tải lên ảnh: ${path.basename(localImagePath)}`);
        }
        console.log(`[GIẢ LẬP ${platform.toUpperCase()}] Viết nội dung bài đăng:\n${postContent}`);
        await new Promise(resolve => setTimeout(resolve, 1500));
        console.log(`[GIẢ LẬP ${platform.toUpperCase()}] Đăng bài thành công! 🎉`);

        // Dọn dẹp ảnh tạm
        if (localImagePath && fs.existsSync(localImagePath)) {
            fs.unlinkSync(localImagePath);
        }
        return true;
    }

    // Luồng Puppeteer thực tế (mẫu cấu trúc)
    let browser;
    try {
        browser = await puppeteer.launch({ headless: false }); // Mở trình duyệt có giao diện để dễ kiểm tra
        const page = await browser.newPage();
        
        // Ví dụ đăng nhập và đăng bài trên Facebook
        if (platform === 'facebook') {
            await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });
            // Thực hiện đăng nhập hoặc sử dụng cookie có sẵn
            // Đi tới trang chủ hoặc Fanpage/Group để đăng bài...
            
            // Xử lý upload ảnh nếu có localImagePath
            if (localImagePath) {
                // await page.uploadFile('input[type="file"]', localImagePath);
            }
        }
        
        // Dọn dẹp ảnh tạm
        if (localImagePath && fs.existsSync(localImagePath)) {
            fs.unlinkSync(localImagePath);
        }
        return true;
    } catch (err) {
        console.error(`[Puppeteer Post Error] Nền tảng ${platform}:`, err.message);
        if (localImagePath && fs.existsSync(localImagePath)) {
            fs.unlinkSync(localImagePath);
        }
        return false;
    } finally {
        if (browser) await browser.close();
    }
}

// ========== HỆ THỐNG QUẢN LÝ TÀI KHOẢN MẠNG XÃ HỘI ==========
const ACCOUNTS_FILE_PATH = path.join(__dirname, 'platform_accounts.json');

/**
 * Lấy danh sách tất cả tài khoản từ file JSON
 */
function loadAccounts() {
    try {
        if (!fs.existsSync(ACCOUNTS_FILE_PATH)) {
            const initialData = { tiktok: [], facebook: [], instagram: [] };
            fs.writeFileSync(ACCOUNTS_FILE_PATH, JSON.stringify(initialData, null, 2), 'utf8');
            return initialData;
        }
        const data = fs.readFileSync(ACCOUNTS_FILE_PATH, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        console.error('[AccountManager] Lỗi đọc file platform_accounts.json:', e.message);
        return { tiktok: [], facebook: [], instagram: [] };
    }
}

/**
 * Ghi dữ liệu tài khoản vào file JSON
 */
function saveAccounts(accountsData) {
    try {
        fs.writeFileSync(ACCOUNTS_FILE_PATH, JSON.stringify(accountsData, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('[AccountManager] Lỗi ghi file platform_accounts.json:', e.message);
        return false;
    }
}

/**
 * Thêm tài khoản mới vào hệ thống
 */
function addAccount(platform, accountObj) {
    const plat = (platform || 'tiktok').toLowerCase();
    const accountsData = loadAccounts();
    if (!accountsData[plat]) accountsData[plat] = [];

    const existingIndex = accountsData[plat].findIndex(acc => 
        (acc.nickname && accountObj.nickname && acc.nickname.toLowerCase() === accountObj.nickname.toLowerCase()) ||
        (acc.username && accountObj.username && acc.username.toLowerCase() === accountObj.username.toLowerCase())
    );

    const newAcc = {
        id: accountObj.id || `acc_${Date.now()}`,
        nickname: accountObj.nickname || accountObj.username,
        username: accountObj.username,
        password: accountObj.password || 'imported_session',
        gmail: accountObj.gmail || accountObj.username,
        loginType: accountObj.loginType || 'cookie',
        hasSession: accountObj.hasSession !== undefined ? accountObj.hasSession : true,
        status: accountObj.status || 'active',
        addedAt: accountObj.addedAt || new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        lastStreakAt: accountObj.lastStreakAt || null,
        streakCount: accountObj.streakCount || 0
    };

    if (existingIndex >= 0) {
        accountsData[plat][existingIndex] = { ...accountsData[plat][existingIndex], ...newAcc };
    } else {
        accountsData[plat].push(newAcc);
    }

    saveAccounts(accountsData);
    return newAcc;
}

/**
 * Xóa tài khoản khỏi danh sách
 */
function deleteAccount(platform, identifier) {
    const plat = (platform || 'tiktok').toLowerCase();
    const accountsData = loadAccounts();
    if (!accountsData[plat]) return false;

    const initialLength = accountsData[plat].length;
    accountsData[plat] = accountsData[plat].filter(acc => 
        acc.nickname?.toLowerCase() !== identifier.toLowerCase() &&
        acc.username?.toLowerCase() !== identifier.toLowerCase()
    );

    if (accountsData[plat].length < initialLength) {
        saveAccounts(accountsData);
        return true;
    }
    return false;
}

/**
 * Cập nhật thông tin/trạng thái tài khoản
 */
function updateAccountStatus(platform, identifier, updates) {
    const plat = (platform || 'tiktok').toLowerCase();
    const accountsData = loadAccounts();
    if (!accountsData[plat]) return false;

    const target = accountsData[plat].find(acc =>
        acc.nickname?.toLowerCase() === identifier.toLowerCase() ||
        acc.username?.toLowerCase() === identifier.toLowerCase()
    );

    if (target) {
        Object.assign(target, updates, { updatedAt: new Date().toISOString() });
        saveAccounts(accountsData);
        return target;
    }
    return null;
}

/**
 * Lấy danh sách tài khoản theo platform
 */
function getAccountsList(platform = 'tiktok') {
    const accountsData = loadAccounts();
    return accountsData[platform.toLowerCase()] || [];
}

/**
 * Tìm tài khoản theo nickname hoặc username
 */
function findAccount(identifier) {
    const accountsData = loadAccounts();
    for (const plat in accountsData) {
        const found = accountsData[plat].find(acc =>
            acc.nickname?.toLowerCase() === identifier.toLowerCase() ||
            acc.username?.toLowerCase() === identifier.toLowerCase()
        );
        if (found) return { platform: plat, account: found };
    }
    return null;
}

/**
 * Tạo độ trễ ngẫu nhiên mô phỏng hành vi người dùng thật
 */
function humanDelay(minMs = 1500, maxMs = 3500) {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Kiểm tra xem trình duyệt có đang bị TikTok Captcha / Xác minh bot chặn hay không
 */
async function detectTikTokCaptcha(page) {
    try {
        const hasCaptcha = await page.evaluate(() => {
            const captchaBox = document.querySelector(
                '#captcha-verify-container, div[class*="captcha"], iframe[src*="captcha"], div[class*="sec-captcha"], .captcha_verify_container, [id*="captcha"]'
            );
            const captchaText = document.body ? document.body.innerText.toLowerCase() : '';
            const isBlockedText = captchaText.includes('drag the slider') || 
                                  captchaText.includes('kéo thanh trượt') || 
                                  captchaText.includes('verify to continue') ||
                                  captchaText.includes('xác minh để tiếp tục');
            return !!captchaBox || isBlockedText;
        });
        return hasCaptcha;
    } catch (e) {
        return false;
    }
}

async function detectRepStatus(chatItem) {
    if (!chatItem) return { isPinned: false, reason: 'missing-chat-item' };

    try {
        return await chatItem.evaluate((el) => {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const nodes = Array.from(el.querySelectorAll('*'));

            const hasPinText = /\b(pin|ghim|pinned|đã ghim|được ghim)\b/.test(text);
            const hasPinIcon = nodes.some((node) => {
                const className = (node.className || '').toString().toLowerCase();
                const ariaLabel = (node.getAttribute('aria-label') || '').toLowerCase();
                const title = (node.getAttribute('title') || '').toLowerCase();
                return /pin|ghim|pinned/.test(`${className} ${ariaLabel} ${title}`);
            });
            const hasPinSvg = nodes.some((node) => {
                const tagName = (node.tagName || '').toLowerCase();
                const dataIcon = (node.getAttribute('data-icon') || '').toLowerCase();
                return tagName === 'svg' && /pin|ghim/.test(dataIcon);
            });

            const isPinned = hasPinText || hasPinIcon || hasPinSvg;
            return {
                isPinned,
                reason: isPinned ? 'pinned-chat' : 'not-pinned'
            };
        });
    } catch (e) {
        return { isPinned: false, reason: 'error' };
    }
}

async function collectVisibleConversationItems(page, selectors = [], maxScrolls = 12) {
    let allItems = [];
    const seenKeys = new Set();
    let previousCount = 0;

    for (let s = 0; s < maxScrolls; s++) {
        await page.evaluate(async () => {
            const container = document.querySelector('[class*="DivConversationListContainer"], [class*="DivListContent"]') || document.body;
            const scrollable = container.querySelector('[style*="overflow"]') || container;
            if (scrollable) {
                scrollable.scrollTop += 2200;
                await new Promise(r => setTimeout(r, 500));
            }
        });
        await humanDelay(400, 900);

        let currentItems = [];
        for (const selector of selectors) {
            const found = await page.$$(selector);
            if (found.length > 0) {
                currentItems = found;
                break;
            }
        }

        const mergedItems = [];
        for (const item of [...allItems, ...currentItems]) {
            try {
                const key = await item.evaluate(el => {
                    const convId = el.getAttribute('data-conv-id');
                    if (convId) return `conv:${convId}`;
                    const e2e = el.getAttribute('data-e2e');
                    if (e2e) return `e2e:${e2e}`;
                    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 90);
                    return `text:${text}`;
                });
                if (seenKeys.has(key)) continue;
                seenKeys.add(key);
                mergedItems.push(item);
            } catch (e) {
                const fallbackKey = `fallback:${String(item)}`;
                if (seenKeys.has(fallbackKey)) continue;
                seenKeys.add(fallbackKey);
                mergedItems.push(item);
            }
        }

        allItems = mergedItems;
        if (allItems.length > 0 && allItems.length === previousCount) {
            break;
        }
        previousCount = allItems.length;
    }

    return allItems;
}

async function findMessageEditor(page) {
    const editorSelectors = [
        'div.public-DraftEditor-content[contenteditable="true"]',
        '[data-e2e="dm-new-input-editor"] div[contenteditable="true"]',
        '[data-e2e="message-input-area"] div[contenteditable="true"]',
        'div[role="textbox"][contenteditable="true"]',
        '[contenteditable="true"]'
    ];

    for (const selector of editorSelectors) {
        try {
            const editor = await page.$(selector);
            if (!editor) continue;
            const isVisible = await editor.evaluate(el => el.offsetHeight > 0 && el.offsetWidth > 0);
            if (isVisible) return editor;
        } catch (e) {
            continue;
        }
    }

    return null;
}

async function sendStreakEmojiToChat(page, friendName) {
    const editor = await findMessageEditor(page);
    if (!editor) {
        console.log(`[TikTok Streak] ⚠️ Không thấy ô nhập tin nhắn cho [${friendName}]`);
        return false;
    }

    try {
        await editor.click();
        await humanDelay(400, 800);
        await page.keyboard.type('🔥❤️', { delay: 50 });
        await humanDelay(300, 600);
        await page.keyboard.press('Enter');
        await humanDelay(1500, 2500);
        return true;
    } catch (err) {
        console.log(`[TikTok Streak] ⚠️ Không gửi được tin nhắn cho [${friendName}]: ${err.message}`);
        return false;
    }
}

/**
 * Tự động thắp lửa / giữ chuỗi tin nhắn trên TikTok
 * Chiến lược: Duyệt qua TẤT CẢ cuộc chat, click vào từng cuộc, tìm ô nhập tin nhắn và gửi 🔥❤️
 * @param {string} platform Nền tảng: tiktok, facebook, ig...
 * @param {object} account Đối tượng tài khoản lưu trữ
 * @returns {Promise<number>} Số chuỗi đã thắp lửa thành công (-1: Login thất bại, -2: Lỗi kỹ thuật, -3: Dính Captcha)
 */
async function repChuoiComments(platform, account) {
    console.log(`[Rep Chuỗi TikTok] Khởi động tiến trình giữ chuỗi/thắp lửa trên ${platform.toUpperCase()}...`);
    console.log(`[Rep Chuỗi TikTok] Tài khoản: Username: ${account.username} | Email: ${account.gmail || 'N/A'}`);

    if (USE_MOCK_MODE || !hasPuppeteer) {
        await humanDelay(1500, 2500);
        console.log(`[GIẢ LẬP TIKTOK] Đang mở tài khoản ${account.username} trên TikTok...`);
        await humanDelay(1500, 2500);
        console.log(`[GIẢ LẬP TIKTOK] Quét Hộp thư tin nhắn riêng (TikTok Direct Messages)...`);
        await humanDelay(1500, 2500);
        
        const mockChats = [
            { friend: "NguyenVanA", streakDays: 12, isPinned: true },
            { friend: "TranThiB", streakDays: 5, isPinned: false },
            { friend: "LinhMiu", streakDays: 30, isPinned: true }
        ];

        let count = 0;
        for (const chat of mockChats) {
            if (chat.isPinned) {
                console.log(`[GIẢ LẬP TIKTOK] 📌➡️🔥 Người được ghim: @${chat.friend} (Chuỗi ${chat.streakDays} ngày) - Đang thắp lửa...`);
                await humanDelay(1000, 2000);
                console.log(`[GIẢ LẬP TIKTOK] ✅ Đã gửi 🔥❤️ thắp lại lửa cho @${chat.friend}`);
                count++;
            } else {
                console.log(`[GIẢ LẬP TIKTOK] ⏭️ Bỏ qua @${chat.friend} vì chưa được ghim.`);
            }
        }

        updateAccountStatus(platform, account.nickname || account.username, {
            lastStreakAt: new Date().toISOString(),
            status: 'active',
            streakCount: (account.streakCount || 0) + count
        });

        console.log(`[GIẢ LẬP TIKTOK] Hoàn thành! Đã thắp lại lửa cho ${count} người được ghim.`);
        return count;
    }

    // Luồng thực tế bằng Puppeteer (Chạy ngầm - Headless Mode với Anti-bot & Captcha check)
    let browser;
    try {
        console.log(`[TikTok Streak] 🚀 Đang mở trình duyệt chạy ngầm...`);
        browser = await puppeteer.launch({ 
            headless: "new",
            executablePath: getChromePath(),
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,800',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        await page.setViewport({ width: 1280, height: 800 });

        // Tải Session/Cookie đã lưu
        const sessionIdentifier = account.gmail || account.username;
        const sessionData = loadCookies(sessionIdentifier);

        if (sessionData && sessionData.cookies && sessionData.cookies.length > 0) {
            console.log(`[TikTok Streak] 🍪 Đã nạp ${sessionData.cookies.length} cookies cho [${sessionIdentifier}]`);
            const preparedCookies = [];
            for (const c of sessionData.cookies) {
                preparedCookies.push(c);
                if (c.name === 'sessionid') {
                    preparedCookies.push({ ...c, name: 'sessionid_ss' });
                    preparedCookies.push({ ...c, name: 'sid_tt' });
                }
            }
            await page.setCookie(...preparedCookies);
        } else {
            console.warn(`[TikTok Streak] ⚠️ Không tìm thấy Session cookies cho [${sessionIdentifier}].`);
        }

        // Truy cập Hộp thư tin nhắn TikTok
        console.log(`[TikTok Streak] 🌐 Đang truy cập tiktok.com/messages...`);
        const messagesUrl = 'https://www.tiktok.com/messages';
        await page.goto(messagesUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await humanDelay(1500, 2500);

        const openedUrl = page.url();
        if (openedUrl.includes('zalo') || openedUrl.includes('zalo.me') || openedUrl.includes('openapi.zalo.me') || openedUrl.includes('id.zalo.me')) {
            console.warn(`[TikTok Streak] ⚠️ Trình duyệt bị điều hướng sai sang ${openedUrl}. Đang buộc quay lại ${messagesUrl}`);
            await page.goto(messagesUrl, { waitUntil: 'networkidle2', timeout: 35000 });
        }

        // Nếu routing không còn ở messages thì force lại page này.
        const finalMessagesUrl = page.url();
        if (!finalMessagesUrl.includes('/messages')) {
            console.warn(`[TikTok Streak] ⚠️ URL sau khi tải không còn đúng /messages (${finalMessagesUrl}). Force navigation lại.`);
            await page.goto(messagesUrl, { waitUntil: 'networkidle2', timeout: 35000 });
        }

        await humanDelay(3000, 5000);

        // Kiểm tra Captcha / Bot Block
        const isCaptcha = await detectTikTokCaptcha(page);
        if (isCaptcha) {
            console.error(`[TikTok Streak] 🛑 PHÁT HIỆN CAPTCHA / XÁC MINH BOT trên tài khoản [${sessionIdentifier}]!`);
            try {
                await page.screenshot({ path: path.join(__dirname, `captcha_warning_${sessionIdentifier}.png`) });
            } catch (e) {}
            updateAccountStatus(platform, account.nickname || account.username, { status: 'warning' });
            return -3; // -3 = Dính Captcha
        }

        // Kiểm tra đăng nhập
        const currentUrl = page.url();
        if (currentUrl.includes('/login') || currentUrl.includes('login')) {
            console.error(`[TikTok Streak] ❌ Chưa đăng nhập / Session hết hạn. URL: ${currentUrl}`);
            updateAccountStatus(platform, account.nickname || account.username, { status: 'expired' });
            return -1; // -1 = login thất bại
        }
        console.log(`[TikTok Streak] ✅ Đã vào Hộp thư tin nhắn TikTok thành công!`);

        // Chụp ảnh màn hình debug
        try {
            await page.screenshot({ path: path.join(__dirname, 'tiktok_messages_debug.png') });
        } catch (sErr) {}

        let repCount = 0;
        let skippedCount = 0;
        try {
            // ====== BƯỚC 1: Cuộn sidebar để load hết danh sách chat ======
            const chatSelectors = [
                '[data-e2e="dm-new-conversation-item"]',
                '[data-e2e="conversation-item"]',
                '[data-e2e^="dm-"]',
                '[data-conv-id]',
                '[role="listitem"]',
                'div[role="button"]',
                'div[class*="ConversationItem"]',
                'div[class*="conversation-item"]',
                'div[class*="chat-item"]'
            ];

            const allChatItems = await collectVisibleConversationItems(page, chatSelectors, 15);

            await page.evaluate(() => {
                const container = document.querySelector('[class*="DivConversationListContainer"], [class*="DivListContent"]') || document.body;
                const scrollable = container.querySelector('[style*="overflow"]') || container;
                if (scrollable) scrollable.scrollTop = 0;
            });
            await humanDelay(1000, 1800);

            console.log(`[TikTok Streak] 📊 Quét thấy tổng cộng ${allChatItems.length} cuộc trò chuyện trong Hộp thư. Đang xử lý toàn bộ danh sách...`);

            if (allChatItems.length === 0) {
                console.log(`[TikTok Streak] ⚠️ Không quét được cuộc trò chuyện nào. Kiểm tra lại session.`);
                return 0;
            }

            // ====== BƯỚC 2: Duyệt qua từng cuộc chat, click, kiểm tra & gửi 🔥❤️ ======
            for (let i = 0; i < allChatItems.length; i++) {
                try {
                    const chatItem = allChatItems[i];

                    // Lấy tên bạn từ nickname element
                    const friendName = await chatItem.evaluate(el => {
                        const nicknameEl = el.querySelector('[data-e2e="dm-new-conversation-nickname"]') ||
                                          el.querySelector('[class*="PInfoNickname"]') ||
                                          el.querySelector('p, span');
                        return nicknameEl ? nicknameEl.textContent.trim().substring(0, 35) : `Chat #${el.getAttribute('data-conv-id') || '?'}`;
                    });

                    const repStatus = await detectRepStatus(chatItem);
                    const isPinned = repStatus.isPinned;

                    if (!isPinned) {
                        skippedCount++;
                        console.log(`[TikTok Streak] ⏭️ Bỏ qua [${friendName}] vì chưa được ghim.`);
                        continue;
                    }

                    // Scroll chat item vào viewport nếu cần
                    const box = await chatItem.boundingBox();
                    if (!box) {
                        await chatItem.evaluate(el => el.scrollIntoView({ block: 'center' }));
                        await humanDelay(500, 1000);
                    }

                    // Click vào chat item
                    const box2 = await chatItem.boundingBox();
                    if (box2) {
                        await page.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2);
                    } else {
                        await chatItem.click();
                    }
                    await humanDelay(2000, 3500);

                    // Tìm ô gõ tin nhắn DraftJS editor
                    console.log(`[TikTok Streak] 🩶➡️🔥 Đang gửi 🔥❤️ cho [${friendName}]...`);

                    const sent = await sendStreakEmojiToChat(page, friendName);
                    if (sent) {
                        repCount++;
                        console.log(`[TikTok Streak] ✅ Đã gửi 🔥❤️ thành công cho [${friendName}]! (${repCount})`);
                    } else {
                        console.log(`[TikTok Streak] ⚠️ Không xác nhận được tin nhắn đã gửi cho [${friendName}]`);
                    }

                    await humanDelay(1500, 3000);

                } catch (chatError) {
                    console.log(`[TikTok Streak] ⚠️ Lỗi xử lý chat #${i}: ${chatError.message}`);
                    continue;
                }
            }

        } catch (e) {
            console.log(`[TikTok Streak] ℹ️ Lỗi trong tiến trình thắp lửa: ${e.message}`);
        }

        updateAccountStatus(platform, account.nickname || account.username, {
            lastStreakAt: new Date().toISOString(),
            status: 'active',
            streakCount: (account.streakCount || 0) + repCount
        });

        console.log(`[TikTok Streak] 🏁 HOÀN TẤT! Đã gửi 🔥❤️: ${repCount} cuộc chat | Bỏ qua (không ghim): ${skippedCount} cuộc chat.`);
        return repCount;

    } catch (err) {
        console.error(`[TikTok Streak Error] ${err.message}`);
        return -2;
    } finally {
        if (browser) await browser.close();
    }
}

/**
 * Kiểm tra thử Cookie TikTok bằng Puppeteer trước khi lưu session
 * @param {string} identifier Biệt danh hoặc username
 * @param {string} sessionIdValue Chuỗi cookie sessionid
 * @returns {Promise<object>} { success: boolean, reason: string }
 */
async function verifyTikTokCookie(identifier, sessionIdValue) {
    console.log(`[Verify Cookie] 🔍 Đang mở trình duyệt test Cookie cho [${identifier}]...`);
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            executablePath: getChromePath(),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,800',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        await page.setViewport({ width: 1280, height: 800 });

        const cookies = [
            {
                name: 'sessionid',
                value: sessionIdValue,
                domain: '.tiktok.com',
                path: '/',
                httpOnly: true,
                secure: true
            },
            {
                name: 'sessionid_ss',
                value: sessionIdValue,
                domain: '.tiktok.com',
                path: '/',
                httpOnly: true,
                secure: true
            },
            {
                name: 'sid_tt',
                value: sessionIdValue,
                domain: '.tiktok.com',
                path: '/',
                httpOnly: true,
                secure: true
            }
        ];

        await page.setCookie(...cookies);

        console.log(`[Verify Cookie] 🌐 Đang kiểm tra truy cập tiktok.com/messages...`);
        const messagesUrl = 'https://www.tiktok.com/messages';
        await page.goto(messagesUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await humanDelay(1500, 2500);

        let finalUrl = page.url();
        if (finalUrl.includes('zalo') || finalUrl.includes('zalo.me') || finalUrl.includes('openapi.zalo.me') || finalUrl.includes('id.zalo.me')) {
            console.warn(`[Verify Cookie] ⚠️ Trang bị redirect sang Zalo/verification: ${finalUrl}. Force điều hướng lại ${messagesUrl}`);
            await page.goto(messagesUrl, { waitUntil: 'networkidle2', timeout: 25000 });
            finalUrl = page.url();
        }

        if (!finalUrl.includes('/messages')) {
            console.warn(`[Verify Cookie] ⚠️ URL sau khi truy cập không phải messages: ${finalUrl}. Force open lại ${messagesUrl}`);
            await page.goto(messagesUrl, { waitUntil: 'networkidle2', timeout: 25000 });
            finalUrl = page.url();
        }

        await humanDelay(3000, 4500);

        finalUrl = page.url();
        console.log(`[Verify Cookie] URL kết quả kiểm tra: ${finalUrl}`);

        if (finalUrl.includes('/login') || finalUrl.includes('login')) {
            return { success: false, reason: 'Cookie không hợp lệ hoặc đã hết hạn (TikTok chuyển hướng về trang đăng nhập)' };
        }

        if (finalUrl.includes('zalo') || finalUrl.includes('zalo.me') || finalUrl.includes('openapi.zalo.me') || finalUrl.includes('id.zalo.me')) {
            return { success: false, reason: 'Browser đã bị điều hướng sang trang xác thực/Zalo không phải TikTok messages' };
        }

        return { success: true, reason: 'Đăng nhập thành công vào Hộp thư TikTok!' };
    } catch (err) {
        console.error(`[Verify Cookie Error]`, err.message);
        return { success: false, reason: `Lỗi kết nối kiểm tra: ${err.message}` };
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = {
    testLogin,
    testLoginTikTokGoogle,
    postSpam,
    repChuoiComments,
    verifyTikTokCookie,
    createTikTokBrowserWithProfile,
    checkTikTokLoginStatus,
    sendTikTokSessionWarning,
    // Session management & 2FA exports
    saveCookies,
    loadCookies,
    checkSessionValid,
    tryReuseSavedTikTokSession,
    clearSession,
    listSessions,
    submitOtp,
    // Social Account Management exports
    loadAccounts,
    saveAccounts,
    addAccount,
    deleteAccount,
    updateAccountStatus,
    getAccountsList,
    findAccount,
    detectTikTokCaptcha,
    humanDelay
};

