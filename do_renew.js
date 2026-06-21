/**
 * DigitalPlat 域名自动续期脚本（Node.js 版）
 * 基于 katabump 项目的反检测方案：playwright-extra + puppeteer-extra-plugin-stealth + 独立启动+CDP
 * 
 * 环境变量:
 *   DOMAIN_ACCOUNT: 账号配置，格式: 邮箱:密码,邮箱2:密码2
 *   TELEGRAM_BOT_TOKEN: (可选) Telegram Bot Token
 *   TELEGRAM_CHAT_ID: (可选) Telegram Chat ID
 *   HTTP_PROXY: (可选) HTTP代理，格式: http://user:pass@host:port
 *   CHROME_PATH: (可选) Chrome 路径，默认 /usr/bin/google-chrome
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

// ==================== 配置 ====================
const BASE_URL = 'https://dash.domain.digitalplat.org';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222 + Math.floor(Math.random() * 100);
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
const RENEW_MAX_ATTEMPTS = 3;

process.env.NO_PROXY = 'localhost,127.0.0.1';
const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] HTTP_PROXY 格式无效。');
        process.exit(1);
    }
}

// 应用 stealth 插件
chromium.use(stealth);

// ==================== 辅助函数 ====================
function log(msg) {
    const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    console.log(`[${timestamp}] ${msg}`);
}

function escapeMarkdown(text) {
    return text.replace(/([_*`\[])/g, '\\$1');
}

function maskDomain(domain) {
    if (!domain || !domain.includes('.')) return '***';
    const parts = domain.split('.');
    if (parts.length >= 3) {
        return `***.${parts.slice(-2).join('.')}`;
    }
    return `***.${parts[parts.length - 1]}`;
}

function maskEmail(email) {
    if (!email || !email.includes('@')) return '***';
    const [name, domain] = email.split('@');
    const maskedName = name.length <= 2 ? `${name[0] || '*'}*` : `${name.slice(0, 2)}***`;
    return `${maskedName}@${domain}`;
}

async function sendTelegramMessage(message, imagePath = null) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        if (imagePath && fs.existsSync(imagePath)) {
            const FormData = require('form-data');
            const form = new FormData();
            form.append('chat_id', TELEGRAM_CHAT_ID);
            form.append('photo', fs.createReadStream(imagePath));
            form.append('caption', message);
            const resp = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, form, {
                headers: form.getHeaders()
            });
            if (resp.data && !resp.data.ok) {
                console.error('[Telegram] API 错误:', JSON.stringify(resp.data));
            } else {
                log('[Telegram] 图片消息发送成功');
            }
        } else {
            const resp = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                disable_web_page_preview: true
            });
            if (resp.data && !resp.data.ok) {
                console.error('[Telegram] API 错误:', JSON.stringify(resp.data));
            } else {
                log('[Telegram] 消息发送成功');
            }
        }
    } catch (e) {
        console.error('[Telegram] 发送失败:', e.message);
        if (e.response && e.response.data) {
            console.error('[Telegram] 响应详情:', JSON.stringify(e.response.data));
        }
    }
}

function parseAccounts(accountsStr) {
    const accounts = [];
    if (!accountsStr) return accounts;
    for (const item of accountsStr.split(',')) {
        const trimmed = item.trim();
        if (trimmed.includes(':')) {
            const [email, password] = trimmed.split(':', 2);
            accounts.push({ email: email.trim(), password: password.trim() });
        }
    }
    return accounts;
}

async function saveScreenshot(page, name) {
    try {
        const dir = path.join(process.cwd(), 'screenshots');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const screenshotPath = path.join(dir, `${name}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 5000 });
        log(`截图已保存: ${screenshotPath}`);
        return screenshotPath;
    } catch (e) {
        log(`截图保存失败: ${e.message}`);
        return null;
    }
}

// ==================== 注入脚本：Hook Shadow DOM 获取 Turnstile 坐标 ====================
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook attachShadow 失败:', e);
    }
})();
`;

// ==================== 浏览器启动 ====================
function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            res.resume();
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(3000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

async function launchChrome() {
    log(`[浏览器] 启动 Chrome (路径: ${CHROME_PATH})...`);
    
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data_digitalplat',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-infobars',
        '--disable-extensions',
    ];

    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }

    // 检查是否有 DISPLAY（有头模式）
    if (!process.env.DISPLAY) {
        log('[浏览器] 无头模式');
        args.push('--headless=new');
    } else {
        log('[浏览器] 有头模式（检测到 DISPLAY）');
    }

    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: 'ignore'
    });
    chrome.unref();

    log(`[浏览器] 等待 Chrome 初始化... 调试端口: ${DEBUG_PORT}`);
    for (let i = 0; i < 30; i++) {
        if (await checkPort(DEBUG_PORT)) {
            log(`[浏览器] 启动成功（${i + 1}秒）`);
            return;
        }
        await new Promise(r => setTimeout(r, 1000));
    }

    throw new Error('Chrome 启动失败');
}

// ==================== CDP 点击 ====================
async function dispatchCdpClick(page, x, y) {
    const client = await page.context().newCDPSession(page);
    try {
        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: x,
            y: y,
            button: 'none',
        });
        await new Promise(r => setTimeout(r, 20 + Math.random() * 50));
        
        await client.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: x,
            y: y,
            button: 'left',
            clickCount: 1
        });
        await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
        
        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: x,
            y: y,
            button: 'left',
            clickCount: 1
        });
        return true;
    } catch (e) {
        return false;
    } finally {
        await client.detach().catch(() => {});
    }
}

// ==================== Turnstile 处理 ====================
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                await frame.evaluate(() => { window.__turnstile_data = null; }).catch(() => {});
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                return await dispatchCdpClick(page, clickX, clickY);
            }
        } catch (e) { }
    }
    return false;
}

async function checkTurnstileSuccess(page) {
    try {
        const hasResponseToken = await page.locator('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]').evaluateAll(elements => {
            return elements.some(el => el.value && el.value.trim().length > 0);
        });
        if (hasResponseToken) return true;
    } catch (e) { }
    const frames = page.frames();
    for (const f of frames) {
        if (f.url().includes('cloudflare')) {
            try {
                if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) return true;
            } catch (e) { }
        }
    }
    return false;
}

async function hasTurnstileFrame(page) {
    try {
        const count = await page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').count();
        return count > 0;
    } catch (e) {
        return false;
    }
}

async function solveTurnstileIfPresent(page, stageName = "登录", maxAttempts = 15, waitAfterClick = 6000) {
    log(`[${stageName}] 检测 Turnstile...`);
    let sawTurnstile = false;
    for (let i = 0; i < maxAttempts; i++) {
        if (await hasTurnstileFrame(page)) sawTurnstile = true;
        if (await checkTurnstileSuccess(page)) {
            log(`[${stageName}] ✅ Turnstile 通过`);
            return true;
        }
        const clicked = await attemptTurnstileCdp(page);
        if (clicked) {
            sawTurnstile = true;
            await page.waitForTimeout(waitAfterClick);
            if (await checkTurnstileSuccess(page)) {
                log(`[${stageName}] ✅ Turnstile 通过`);
                return true;
            }
        }
        if (i < maxAttempts - 1) await page.waitForTimeout(1000);
    }
    if (!sawTurnstile) {
        log(`[${stageName}] 未检测到 Turnstile`);
        return true;
    }
    log(`[${stageName}] ⚠️ Turnstile 未通过`);
    return false;
}

// ==================== ALTCHA 处理 ====================
async function getAltchaStatus(page) {
    try {
        return await page.evaluate(() => {
            const normalize = (value) => {
                if (value == null) return '';
                return String(value).trim();
            };
            const widget = document.querySelector('altcha-widget');
            const altchaInputs = Array.from(document.querySelectorAll('input[name="altcha"], textarea[name="altcha"], input[name*="altcha" i], textarea[name*="altcha" i]'));
            const firstFilledInput = altchaInputs.find((input) => normalize(input.value).length > 0);
            const shadowRoot = widget ? widget.shadowRoot : null;
            const checkbox = shadowRoot ? shadowRoot.querySelector('input[type="checkbox"], [role="checkbox"]') : null;
            const stateProp = normalize(widget ? widget.state : '');
            const stateAttr = normalize(widget ? widget.getAttribute('state') : '');
            const valueProp = normalize(widget ? widget.value : '');
            const valueAttr = normalize(widget ? widget.getAttribute('value') : '');
            const hiddenInputValue = normalize(firstFilledInput ? firstFilledInput.value : '');
            const checkboxChecked = checkbox && typeof checkbox.checked === 'boolean' ? checkbox.checked : null;
            const ariaChecked = normalize(checkbox ? checkbox.getAttribute('aria-checked') : '');
            const busyAttr = normalize(widget ? widget.getAttribute('aria-busy') : '');
            const state = stateProp || stateAttr || '';
            const isSolved = state === 'verified' || valueProp.length > 0 || valueAttr.length > 0 || hiddenInputValue.length > 0;
            const isVerifying = !isSolved && (
                state === 'verifying' ||
                state === 'processing' ||
                state === 'working' ||
                checkboxChecked === true ||
                ariaChecked === 'true' ||
                busyAttr === 'true'
            );
            return {
                exists: !!widget || altchaInputs.length > 0,
                solved: isSolved,
                isVerifying,
                state: state || 'unknown',
                hasShadowRoot: !!shadowRoot,
                checkboxChecked,
                ariaChecked,
                valueLength: Math.max(valueProp.length, valueAttr.length),
                hiddenInputLength: hiddenInputValue.length,
                busy: busyAttr === 'true'
            };
        });
    } catch (e) {
        return {
            exists: false,
            solved: false,
            isVerifying: false,
            state: 'error',
            hasShadowRoot: false,
            checkboxChecked: null,
            ariaChecked: '',
            valueLength: 0,
            hiddenInputLength: 0,
            busy: false
        };
    }
}

function formatAltchaStatus(status) {
    const checkedText = status.checkboxChecked === null ? 'unknown' : String(status.checkboxChecked);
    const ariaChecked = status.ariaChecked || 'n/a';
    return `state=${status.state}, solved=${status.solved}, verifying=${status.isVerifying}, shadow=${status.hasShadowRoot}, checked=${checkedText}, ariaChecked=${ariaChecked}, valueLen=${status.valueLength}, hiddenLen=${status.hiddenInputLength}, busy=${status.busy}`;
}

async function attemptAltchaClick(page, currentStatus = null) {
    try {
        const altchaWidget = page.locator('altcha-widget').first();
        if (await altchaWidget.count() > 0) {
            const status = currentStatus || await getAltchaStatus(page);
            if (status.solved) return false;
            if (status.isVerifying) {
                return false;
            }
            await page.waitForTimeout(500);
            await altchaWidget.scrollIntoViewIfNeeded().catch(() => {});
            let boxInfo = await page.evaluate(() => {
                const widget = document.querySelector('altcha-widget');
                if (!widget) return null;
                const pickClickTarget = (root) => {
                    if (!root) return null;
                    return root.querySelector('input[type="checkbox"], [role="checkbox"], label, button');
                };
                if (widget.shadowRoot) {
                    const target = pickClickTarget(widget.shadowRoot);
                    if (target) {
                        const rect = target.getBoundingClientRect();
                        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: true, tagName: target.tagName };
                    }
                }
                const lightDomTarget = pickClickTarget(widget);
                if (lightDomTarget) {
                    const rect = lightDomTarget.getBoundingClientRect();
                    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: true, tagName: lightDomTarget.tagName };
                }
                const rect = widget.getBoundingClientRect();
                return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: false, tagName: widget.tagName };
            });
            if (boxInfo && boxInfo.width > 0 && boxInfo.height > 0) {
                let clickX, clickY;
                if (boxInfo.isExact) {
                    clickX = boxInfo.x + boxInfo.width / 2;
                    clickY = boxInfo.y + boxInfo.height / 2;
                } else {
                    clickX = boxInfo.x + Math.min(25, Math.max(12, boxInfo.width * 0.15));
                    clickY = boxInfo.y + boxInfo.height / 2;
                }
                await dispatchCdpClick(page, clickX, clickY);
                // 额外尝试：直接在 shadow DOM 内触发点击
                await page.evaluate(() => {
                    const widget = document.querySelector('altcha-widget');
                    if (widget && widget.shadowRoot) {
                        const cb = widget.shadowRoot.querySelector('input[type="checkbox"]');
                        if (cb && !cb.checked) {
                            cb.click();
                        }
                    }
                }).catch(() => {});
                return true;
            }
        }
    } catch (e) {}
    return false;
}

async function solveAltchaIfPresent(page, stageName = "续期阶段", maxAttempts = 15, waitAfterClick = 8000) {
    log(`[${stageName}] 检测 ALTCHA...`);
    let sawAltcha = false;
    const startedAt = Date.now();
    const totalWaitBudget = Math.max(waitAfterClick * maxAttempts, waitAfterClick);
    let clickAttempts = 0;
    let lastStatusText = '';
    while (Date.now() - startedAt < totalWaitBudget) {
        const status = await getAltchaStatus(page);
        if (status.exists) sawAltcha = true;
        if (status.solved) {
            log(`[${stageName}] ✅ ALTCHA 通过`);
            return true;
        }
        if (!status.exists) {
            await page.waitForTimeout(1000);
            continue;
        }
        if (status.isVerifying) {
            await page.waitForTimeout(1000);
            continue;
        }
        if (clickAttempts >= maxAttempts) {
            await page.waitForTimeout(1000);
            continue;
        }
        const clicked = await attemptAltchaClick(page, status);
        if (!clicked) {
            await page.waitForTimeout(1000);
            continue;
        }
        clickAttempts += 1;
        const clickStartedAt = Date.now();
        let observedVerification = false;
        while (Date.now() - clickStartedAt < waitAfterClick) {
            await page.waitForTimeout(1000);
            const followupStatus = await getAltchaStatus(page);
            if (followupStatus.exists) sawAltcha = true;
            if (followupStatus.solved) {
                log(`[${stageName}] ✅ ALTCHA 通过`);
                return true;
            }
            if (followupStatus.isVerifying) {
                observedVerification = true;
                continue;
            }
            if (!observedVerification && Date.now() - clickStartedAt >= 2500) {
                break;
            }
        }
    }
    if (!sawAltcha) {
        log(`[${stageName}] 未检测到 ALTCHA`);
        return true;
    }
    log(`[${stageName}] ⚠️ ALTCHA 未通过`);
    return false;
}

// ==================== Cloudflare 等待 ====================
async function waitForCloudflare(page, stageName = "页面", maxWait = 60) {
    log(`[${stageName}] 等待 Cloudflare 安全验证...`);
    const startTime = Date.now();

    for (let i = 0; i < maxWait; i++) {
        try {
            const title = await page.title();

            const cfTitleKeywords = ['请稍候', 'Just a moment', '安全验证', 'Checking', '验证中', '正在进行'];
            const isCfTitle = cfTitleKeywords.some(kw => title.includes(kw));

            let hasCfText = false;
            try {
                hasCfText = await page.evaluate(() => {
                    const text = document.body ? document.body.innerText : '';
                    return text.includes('正在进行安全验证') ||
                           text.includes('Just a moment') ||
                           text.includes('安全验证') ||
                           text.includes('Cloudflare');
                });
            } catch (e) {}

            if (!isCfTitle && !hasCfText) {
                let hasContent = false;
                try {
                    hasContent = await page.evaluate(() => {
                        return document.querySelectorAll('input, button, form, a').length > 0;
                    });
                } catch (e) {}

                if (hasContent || title.length > 0) {
                    const elapsed = (Date.now() - startTime) / 1000;
                    log(`[${stageName}] ✅ Cloudflare 验证通过（${elapsed.toFixed(1)}秒）`);
                    // 等待页面加载完成
                    try {
                        await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
                    } catch (e) {}
                    return true;
                }
            }
        } catch (e) {}

        await page.waitForTimeout(1000);
    }

    const elapsed = (Date.now() - startTime) / 1000;
    log(`[${stageName}] ⚠️ Cloudflare 验证超时（${elapsed.toFixed(1)}秒），继续尝试...`);
    return false;
}

// ==================== 登录 ====================
async function loginToSite(page, email, password) {
    log(`登录 ${maskEmail(email)}...`);

    // 先访问首页，等待 Cloudflare 验证
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000);
    await waitForCloudflare(page, '首页', 60);

    // 直接访问登录页（避免点击登录链接跳转到 Google OAuth）
    // 增加重试机制，解决 ERR_ABORTED 问题
    let loginPageLoaded = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            loginPageLoaded = true;
            break;
        } catch (e) {
            if (attempt < 3) {
                await page.waitForTimeout(2000);
            }
        }
    }

    if (!loginPageLoaded) {
        log('❌ 无法访问登录页');
        await saveScreenshot(page, `login_page_fail_${email.replace(/[^a-z0-9]/gi, '_')}`);
        return false;
    }

    await page.waitForTimeout(2000 + Math.random() * 1000);

    // 等待登录页的 Cloudflare 验证
    await waitForCloudflare(page, '登录页', 60);

    // 检查是否跳转到了 Google 登录页
    const currentUrl = page.url();
    if (currentUrl.includes('google.com') || currentUrl.includes('accounts.google')) {
        log('⚠️ 跳转到了 Google 登录页，尝试返回...');
        await page.goBack();
        await page.waitForTimeout(1000);
    }

    // 等待页面加载
    try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch (e) {}

    // 先解决可能出现的 Turnstile（登录前）
    await solveTurnstileIfPresent(page, '登录前检查', 5, 5000);

    // 填写登录表单
    
    // 尝试多种选择器找到邮箱输入框
    const emailSelectors = [
        'input[name="email"]',
        'input[type="email"]',
        'input[placeholder*="email" i]',
        'input[placeholder*="邮箱" i]',
        'input[id*="email" i]',
        'form input[type="text"]:first-of-type'
    ];

    let emailInput = null;
    for (const selector of emailSelectors) {
        try {
            const locator = page.locator(selector).first();
            if (await locator.count() > 0 && await locator.isVisible({ timeout: 2000 })) {
                emailInput = locator;
                break;
            }
        } catch (e) {}
    }

    if (!emailInput) {
        log('❌ 找不到邮箱输入框');
        await saveScreenshot(page, `login_no_email_input_${email.replace(/[^a-z0-9]/gi, '_')}`);
        return false;
    }

    try {
        // 模拟人类打字
        await emailInput.click();
        await page.waitForTimeout(100 + Math.random() * 200);
        for (const char of email) {
            await emailInput.type(char, { delay: 30 + Math.floor(Math.random() * 50) });
            if (Math.random() < 0.1) {
                await page.waitForTimeout(Math.random() * 300);
            }
        }
    } catch (e) {
        await emailInput.fill(email);
    }

    await page.waitForTimeout(300 + Math.random() * 500);

    // 尝试多种选择器找到密码输入框
    const pwdSelectors = [
        'input[name="password"]',
        'input[type="password"]',
        'input[placeholder*="password" i]',
        'input[placeholder*="密码" i]',
        'input[id*="password" i]'
    ];

    let pwdInput = null;
    for (const selector of pwdSelectors) {
        try {
            const locator = page.locator(selector).first();
            if (await locator.count() > 0 && await locator.isVisible({ timeout: 2000 })) {
                pwdInput = locator;
                break;
            }
        } catch (e) {}
    }

    if (!pwdInput) {
        log('❌ 找不到密码输入框');
        await saveScreenshot(page, `login_no_pwd_input_${email.replace(/[^a-z0-9]/gi, '_')}`);
        return false;
    }

    try {
        await pwdInput.click();
        for (const char of password) {
            await pwdInput.type(char, { delay: 30 + Math.floor(Math.random() * 50) });
            if (Math.random() < 0.1) {
                await page.waitForTimeout(Math.random() * 300);
            }
        }
    } catch (e) {
        await pwdInput.fill(password);
    }

    await page.waitForTimeout(500 + Math.random() * 500);

    // 解决 Turnstile（登录按钮前）
    const turnstileOk = await solveTurnstileIfPresent(page, '登录', 25, 8000);
    if (!turnstileOk) {
        log('⚠️ Turnstile 验证可能未完全通过，继续尝试登录...');
    }

    // 点击登录按钮
    const submitSelectors = [
        'button[type="submit"]',
        'button:has-text("登录")',
        'button:has-text("Sign in")',
        'button:has-text("Login")',
        'button:has-text("继续")',
        'button:has-text("Continue")',
        'input[type="submit"]'
    ];

    let submitBtn = null;
    for (const selector of submitSelectors) {
        try {
            const locator = page.locator(selector).first();
            if (await locator.count() > 0 && await locator.isVisible({ timeout: 2000 })) {
                submitBtn = locator;
                break;
            }
        } catch (e) {}
    }

    if (submitBtn) {
        await submitBtn.click();
    } else {
        log('未找到登录按钮，尝试按 Enter 键...');
        await page.keyboard.press('Enter');
    }

    // 等待登录完成
    await page.waitForTimeout(3000);
    try {
        await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch (e) {}

    // 检查是否登录成功
    if (page.url().includes('/auth/login') || page.url().includes('google.com')) {
        log('❌ 登录失败，仍在登录页面或 Google 登录页');
        await saveScreenshot(page, `login_fail_${email.replace(/[^a-z0-9]/gi, '_')}`);
        return false;
    }

    // 再次检查
    await page.waitForTimeout(2000);
    if (page.url().includes('/auth/login') || page.url().includes('google.com')) {
        log('❌ 登录失败，被重定向回登录页');
        await saveScreenshot(page, `login_fail_redirect_${email.replace(/[^a-z0-9]/gi, '_')}`);
        return false;
    }

    log('✅ 登录成功');
    return true;
}

// ==================== 获取域名列表 ====================
async function getDomainsFromPage(page) {
    try {
        const result = await page.evaluate(async () => {
            try {
                const resp = await fetch('/_panel_api/api/domains', {
                    credentials: 'include',
                    headers: { 'Accept': 'application/json' }
                });
                if (!resp.ok) return { error: resp.status };
                const data = await resp.json();
                return { data };
            } catch (e) {
                return { error: e.message };
            }
        });

        if (result.error) {
            log(`API 请求失败: ${result.error}`);
            return [];
        }

        const data = result.data || {};
        let domainsList = [];

        if (Array.isArray(data)) {
            domainsList = data.map(item => typeof item === 'object' ? item.name : item);
        } else if (typeof data === 'object') {
            for (const key of ['domains', 'initialDomains', 'items', 'data']) {
                if (key in data) {
                    const val = data[key];
                    if (Array.isArray(val)) {
                        domainsList = val.map(item => typeof item === 'object' ? item.name : item);
                        break;
                    } else if (typeof val === 'object' && 'domains' in val) {
                        domainsList = val.domains.map(item => typeof item === 'object' ? item.name : item);
                        break;
                    }
                }
            }
        }

        log(`✅ 获取 ${domainsList.length} 个域名`);
        return domainsList;
    } catch (e) {
        log(`获取域名异常: ${e.message}`);
        return [];
    }
}

// ==================== 获取域名详情 ====================
async function getDomainDetailFromPage(page, domain) {
    try {
        return await page.evaluate(async (domainName) => {
            try {
                const resp = await fetch(`/_panel_api/api/domains/${domainName}`, {
                    credentials: 'include',
                    headers: { 'Accept': 'application/json' }
                });
                if (!resp.ok) return null;
                return await resp.json();
            } catch (e) {
                return null;
            }
        }, domain);
    } catch (e) {
        log(`获取域名详情异常: ${e.message}`);
        return null;
    }
}

// ==================== 续期域名 ====================
async function renewDomainViaPage(page, domain) {
    const maskedDomain = maskDomain(domain);
    log(`🔄 ${maskedDomain}: 续期中...`);

    for (let attempt = 1; attempt <= RENEW_MAX_ATTEMPTS; attempt++) {
        try {
            // 访问域名详情页
            await page.goto(`${BASE_URL}/domains/${domain}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(2000);
            try {
                await page.waitForLoadState('networkidle', { timeout: 10000 });
            } catch (e) {}

            // 查找 Renew 按钮
            let renewBtn = page.locator('button:has-text("Renew"), button:has-text("续期"), a:has-text("Renew"), a:has-text("续期")').first();
            if (await renewBtn.count() === 0) {
                renewBtn = page.locator('[class*="renew" i], [id*="renew" i]').first();
            }

            if (await renewBtn.count() === 0) {
                log(`❌ ${maskedDomain}: 找不到续期按钮`);
                await saveScreenshot(page, `renew_no_button_${domain}`);
                return { success: false, error: '找不到续期按钮' };
            }

            await renewBtn.click();
            await page.waitForTimeout(1500);

            // 等待弹窗
            const modal = page.locator('[role="dialog"], .modal, .modal-content, [class*="modal" i]').filter({ hasText: 'Renew' }).first();
            try {
                await modal.waitFor({ state: 'visible', timeout: 5000 });
            } catch (e) {
                await saveScreenshot(page, `renew_no_modal_${domain}_attempt${attempt}`);
            }

            // 晃动鼠标
            try {
                const box = await modal.boundingBox();
                if (box) {
                    await page.mouse.move(
                        box.x + box.width / 2,
                        box.y + box.height / 2,
                        { steps: 5 }
                    );
                }
            } catch (e) {}

            // 解决 ALTCHA 验证码
            const altchaOk = await solveAltchaIfPresent(page, `续期-${maskedDomain}`, 15, 8000);
            if (!altchaOk) {
                log(`⚠️ ${maskedDomain}: ALTCHA 验证可能未通过，继续尝试`);
            }

            // 点击确认按钮
            let confirmBtn = modal.locator('button:has-text("Renew"), button:has-text("确认"), button:has-text("Confirm")').first();
            if (await confirmBtn.count() === 0) {
                confirmBtn = page.locator('button:has-text("Renew"), button:has-text("确认"), button:has-text("Confirm")').last();
            }

            if (await confirmBtn.count() > 0) {
                await confirmBtn.click();
            } else {
                await page.keyboard.press('Enter');
            }

            await page.waitForTimeout(3000);
            try {
                await page.waitForLoadState('networkidle', { timeout: 10000 });
            } catch (e) {}

            // 检查续期结果
            const successTexts = ['success', '成功', 'renewed', '已续期', 'extended'];
            for (const text of successTexts) {
                try {
                    if (await page.locator(`text=${text}`).first().isVisible({ timeout: 2000 })) {
                        return { success: true, error: null };
                    }
                } catch (e) {}
            }

            // 重新获取域名详情确认
            const detail = await getDomainDetailFromPage(page, domain);
            if (detail) {
                return { success: true, error: null };
            }

            await saveScreenshot(page, `renew_attempt_${domain}_attempt${attempt}`);

            if (attempt < RENEW_MAX_ATTEMPTS) {
                await page.waitForTimeout(2000);
                continue;
            }

        } catch (e) {
            await saveScreenshot(page, `renew_error_${domain}_attempt${attempt}`);
            if (attempt < RENEW_MAX_ATTEMPTS) {
                await page.waitForTimeout(2000);
                continue;
            }
            return { success: false, error: e.message };
        }
    }

    return { success: false, error: `尝试 ${RENEW_MAX_ATTEMPTS} 次后仍未确认成功` };
}

// ==================== 处理单个账号 ====================
async function processAccount(email, password, context) {
    log(`\n${'#'.repeat(60)}`);
    log(`账号: ${maskEmail(email)}`);
    log(`${'#'.repeat(60)}`);

    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
    await page.addInitScript(INJECTED_SCRIPT);

    const results = [];

    try {
        // 登录
        if (!await loginToSite(page, email, password)) {
            log('❌ 登录失败');
            results.push({
                domain: '登录失败',
                success: false,
                oldExpire: '',
                newExpire: '',
                error: '无法登录到控制面板',
                skip: false
            });
            return results;
        }

        await page.waitForTimeout(1000 + Math.random() * 1000);

        // 获取域名列表
        const domains = await getDomainsFromPage(page);
        if (!domains || domains.length === 0) {
            log('未找到域名');
            results.push({
                domain: '无域名',
                success: false,
                oldExpire: '',
                newExpire: '',
                error: '账号下没有域名',
                skip: false
            });
            return results;
        }

        for (const domain of domains) {
            const maskedDomain = maskDomain(domain);
            try {
                // 获取域名详情
                const detail = await getDomainDetailFromPage(page, domain);
                if (!detail) {
                    log(`❌ ${maskedDomain}: 无法获取域名详情`);
                    results.push({
                        domain,
                        success: false,
                        oldExpire: '',
                        newExpire: '',
                        error: '无法获取域名详情',
                        skip: false
                    });
                    continue;
                }

                const domainData = detail.domain || detail;
                const expiryRaw = domainData.expiry_date || domainData.expiry_date_display || '';

                let oldExpire = expiryRaw;
                if (expiryRaw.length === 8) {
                    oldExpire = `${expiryRaw.substring(0, 4)}-${expiryRaw.substring(4, 6)}-${expiryRaw.substring(6, 8)}`;
                }

                // 计算剩余天数
                let daysLeft = -1;
                try {
                    const expireDate = new Date(oldExpire);
                    const now = new Date();
                    daysLeft = Math.ceil((expireDate - now) / (1000 * 60 * 60 * 24));
                } catch (e) {}

                if (daysLeft > 90) {
                    log(`⏭ ${maskedDomain}: 距到期 ${daysLeft} 天，跳过`);
                    results.push({
                        domain,
                        success: false,
                        oldExpire,
                        newExpire: oldExpire,
                        error: `距到期${daysLeft}天，暂不需续期`,
                        skip: true
                    });
                    continue;
                }

                // 执行续期
                log(`🔄 ${maskedDomain}: 正在续期...`);
                const { success: renewSuccess, error: renewError } = await renewDomainViaPage(page, domain);

                if (renewSuccess) {
                    // 重新获取详情确认
                    await page.waitForTimeout(2000);
                    const newDetail = await getDomainDetailFromPage(page, domain);
                    let newExpire = oldExpire;
                    if (newDetail) {
                        const newData = newDetail.domain || newDetail;
                        const newExpiry = newData.expiry_date || newData.expiry_date_display || '';
                        if (newExpiry.length === 8) {
                            newExpire = `${newExpiry.substring(0, 4)}-${newExpiry.substring(4, 6)}-${newExpiry.substring(6, 8)}`;
                        } else {
                            newExpire = newExpiry;
                        }
                    }

                    log(`✅ ${maskedDomain}: 续期成功 (${oldExpire} -> ${newExpire})`);
                    results.push({
                        domain,
                        success: true,
                        oldExpire,
                        newExpire,
                        error: null,
                        skip: false
                    });
                } else {
                    log(`❌ ${maskedDomain}: 续期失败 - ${renewError}`);
                    results.push({
                        domain,
                        success: false,
                        oldExpire,
                        newExpire: oldExpire,
                        error: renewError,
                        skip: false
                    });
                }

            } catch (e) {
                log(`❌ ${maskedDomain}: 处理异常 - ${e.message}`);
                results.push({
                    domain,
                    success: false,
                    oldExpire: '',
                    newExpire: '',
                    error: e.message,
                    skip: false
                });
            }
        }

        // 退出登录
        try {
            await page.goto(`${BASE_URL}/auth/logout`, { timeout: 10000 });
        } catch (e) {}

    } catch (e) {
        log(`账号处理异常: ${e.message}`);
        await saveScreenshot(page, `account_error_${email.replace(/[^a-z0-9]/gi, '_')}`);
        results.push({
            domain: '处理异常',
            success: false,
            oldExpire: '',
            newExpire: '',
            error: e.message.substring(0, 100),
            skip: false
        });
    } finally {
        try {
            await page.close();
        } catch (e) {}
    }

    // 发送通知
    await sendAccountNotification(email, results);
    return results;
}

// ==================== 发送账号通知 ====================
async function sendAccountNotification(email, results) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    if (!results || results.length === 0) return;

    const successCount = results.filter(r => r.success).length;
    const skipCount = results.filter(r => r.skip).length;
    const failCount = results.length - successCount - skipCount;

    let emoji, title;
    if (failCount > 0) {
        emoji = '❌';
        title = `DigitalPlat域名续期异常 - ${email}`;
    } else if (successCount > 0) {
        emoji = '✅';
        title = `DigitalPlat域名续期成功 - ${email}`;
    } else {
        emoji = 'ℹ️';
        title = `DigitalPlat域名检查完成 - ${email}`;
    }

    const lines = [];
    lines.push(`📊 总计: ${results.length} 个域名`);
    lines.push(` ✅ 续期成功: ${successCount}`);
    lines.push(` ⏭️ 跳过: ${skipCount}`);
    lines.push(` ❌ 失败: ${failCount}`);
    lines.push('');

    for (const r of results) {
        let status;
        if (r.skip) {
            status = '⏭️';
        } else if (r.success) {
            status = '✅';
        } else {
            status = '❌';
        }

        const domain = r.domain;
        const expire = r.newExpire || r.oldExpire;

        if (r.success) {
            lines.push(`${status} \`${domain}\` 续期成功`);
            lines.push(`  新到期: ${expire}`);
        } else if (r.skip) {
            lines.push(`${status} \`${domain}\` 无需续期`);
            if (expire) lines.push(`  到期: ${expire}`);
        } else {
            lines.push(`${status} \`${domain}\` 处理失败`);
            if (r.error) lines.push(`  错误: ${r.error.substring(0, 50)}`);
        }
        lines.push('');
    }

    lines.push(`🕒 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    const content = lines.join('\n');
    const fullMessage = `${emoji} ${title}\n\n${content}`;
    await sendTelegramMessage(fullMessage);
}

// ==================== 主函数 ====================
async function main() {
    log('='.repeat(60));
    log('域名自动续期开始（Node.js 版 + katabump 方案）');
    log(`时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    log('='.repeat(60));

    const accountsStr = process.env.DOMAIN_ACCOUNT || '';
    if (!accountsStr) {
        log('错误: 未设置 DOMAIN_ACCOUNT 环境变量');
        process.exit(1);
    }

    const accounts = parseAccounts(accountsStr);
    if (accounts.length === 0) {
        log('错误: 无有效账号配置');
        process.exit(1);
    }

    log(`账号数量: ${accounts.length}`);

    // 启动浏览器
    await launchChrome();

    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            break;
        } catch (e) {
            if (k < 4) {
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }

    if (!browser) {
        log('错误: 无法连接到 Chrome');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    if (!context) {
        console.error('无法获取浏览器上下文，退出。');
        await browser.close();
        process.exit(1);
    }

    // 代理认证处理
    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        log('[代理] 设置认证拦截...');
        await context.route('**/*', (route) => {
            route.continue({
                headers: {
                    ...route.request().headers(),
                    'Proxy-Authorization': 'Basic ' + Buffer.from(`${PROXY_CONFIG.username}:${PROXY_CONFIG.password}`).toString('base64')
                }
            });
        });
    }

    const allResults = [];
    const errors = [];

    for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        try {
            const results = await processAccount(account.email, account.password, context);
            if (results && results.length > 0) {
                allResults.push(...results);
            } else {
                errors.push(`${maskEmail(account.email)}: 未获取到域名或处理失败`);
            }
        } catch (e) {
            errors.push(`${maskEmail(account.email)}: ${e.message}`);
            log(`账号 ${maskEmail(account.email)} 处理异常: ${e.message}`);
        }

        if (i < accounts.length - 1) {
            const sleepTime = 3 + Math.floor(Math.random() * 8);
            await new Promise(r => setTimeout(r, sleepTime * 1000));
        }
    }

    // 汇总
    log('\n' + '='.repeat(60));
    log('任务汇总');
    log('='.repeat(60));

    const successCount = allResults.filter(r => r.success).length;
    const skipCount = allResults.filter(r => r.skip).length;

    for (const r of allResults) {
        let status;
        if (r.skip) {
            status = '⏭';
        } else if (r.success) {
            status = '✓';
        } else {
            status = '✗';
        }
        log(`${status} ${maskDomain(r.domain)}: ${r.oldExpire} -> ${r.newExpire}`);
    }

    log(`\n总计: ${successCount} 成功, ${skipCount} 跳过, ${allResults.length} 总数`);

    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID && errors.length > 0) {
        const errorMsg = errors.map(err => `❌ ${err}`).join('\n');
        const fullMsg = `⚠️ 域名续期任务完成（部分失败）\n\n${errorMsg}\n\n🕒 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
        await sendTelegramMessage(fullMsg);
    }

    // 关闭浏览器
    try {
        await browser.close();
    } catch (e) {}

    const hasSuccess = successCount > 0 || skipCount > 0;
    const hasErrors = errors.length > 0;

    process.exit(hasSuccess && !hasErrors ? 0 : 1);
}

// 运行主函数
main().catch(err => {
    console.error('致命错误:', err);
    process.exit(1);
});
