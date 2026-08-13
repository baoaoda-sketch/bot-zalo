const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const platformAutomation = require('../platform_automation');

test('tryReuseSavedTikTokSession reuses saved cookies for an existing login session', async () => {
  const identifier = 'reuse-session-test@example.com';
  const sessionDir = path.join(__dirname, '..', 'tiktok_sessions');
  const sessionFile = path.join(sessionDir, `session_${identifier.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);

  if (fs.existsSync(sessionFile)) {
    fs.unlinkSync(sessionFile);
  }

  const saved = platformAutomation.saveCookies(identifier, [
    { name: 'sessionid', value: 'abc123', domain: '.tiktok.com', path: '/', expires: 0 },
    { name: 'sid_tt', value: 'def456', domain: '.tiktok.com', path: '/', expires: 0 }
  ], { userAgent: 'test-agent' });

  assert.equal(saved, true);

  const fakePage = {
    async setCookie(...cookies) {
      this.cookies = cookies;
    },
    async goto() {},
    async evaluate() {
      return 'Welcome back to TikTok';
    },
    async $(selector) {
      return selector === '[data-e2e="user-avatar"]' ? {} : null;
    },
    url() {
      return 'https://www.tiktok.com/@tester';
    }
  };

  const result = await platformAutomation.tryReuseSavedTikTokSession(identifier, fakePage);

  assert.equal(result.success, true);
  assert.equal(result.usedSession, true);
  assert.equal(result.reason, 'Đăng nhập bằng session đã lưu');

  if (fs.existsSync(sessionFile)) {
    fs.unlinkSync(sessionFile);
  }
});
