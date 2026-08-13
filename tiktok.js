/**
 * tiktok.js - Module tự động hóa TikTok bằng Puppeteer
 * Wraps và export tất cả tính năng từ platform_automation.js cho TikTok
 */

const platformAutomation = require('./platform_automation');

module.exports = {
    ...platformAutomation,
    
    // Explicit TikTok helpers
    repChuoiTikTok: (account) => platformAutomation.repChuoiComments('tiktok', account),
    verifyTikTokCookie: platformAutomation.verifyTikTokCookie,
    loginGoogleTikTok: platformAutomation.testLoginTikTokGoogle,
    getTikTokAccounts: () => platformAutomation.getAccountsList('tiktok')
};
