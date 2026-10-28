/**
 * 智墨小说 · 授权转发服务（Cloudflare Workers + KV）
 * ------------------------------------------------------------
 * 三件事：
 *   1. 校验激活码（每个码有独立有效期，可随时停用/延期）
 *   2. 校验通过才转发到模型（模型的 Key 只存在本服务的环境变量里）
 *   3. 提供管理接口，给「密钥管理.command」用
 *
 * 环境变量：
 *   API_KEY      必填，智谱 API Key（绝不下发给 App）
 *   ADMIN_TOKEN  必填，管理口令（只在本机脚本里用）
 *   UPSTREAM_URL 选填，默认智谱 /chat/completions
 *   MODEL        选填，默认 glm-4.5-flash
 *   MAX_TOKENS   选填，默认 8192
 *   MAX_CONCURRENCY 选填，上游允许的同时在跑请求数，默认 2
 *                （智谱免费档常见 1~2；充值提额后一起调大，两边必须一致）
 * KV 绑定：
 *   LICENSES     存放激活码
 *
 * 接口：
 *   GET  /api/ai            健康检查
 *   POST /api/activate      {license} → 校验激活码
 *   POST /api/ai            {payload}  + 头 x-license → 生成
 *   POST /api/admin         {action,...} + 头 x-admin-token → 管理
 *
 * 用量保护（防共享、防把 Key 跑爆）：
 *   dailyQuota  每个码每天最多生成多少次，0/缺省 = 不限
 *   maxDevices  每个码最多绑定几台设备，0/缺省 = 不限
 *   超限分别返回 429 LICENSE_QUOTA / 403 LICENSE_DEVICE_LIMIT，
 *   这两个是「临时性」错误，客户端不得清掉本机激活码。
 */

const DEFAULT_UPSTREAM = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const DEFAULT_MODEL = 'glm-4.5-flash';
const DAY = 24 * 60 * 60 * 1000;

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-license, x-device, x-gen, x-admin-token',
    'Access-Control-Expose-Headers': 'x-license-days-left, x-license-quota-left',
    'Access-Control-Max-Age': '86400'
};

/* ============ 并发闸门 ============
 * 上游模型对「同时在处理的请求数」有硬上限（免费档常见 1~2），
 * 超了直接 429。客户端的串行只作用于单台手机，用户一多就必然撞墙，
 * 所以在这里统一发号：最多 MAX_CONCURRENCY 个请求同时在跑，其余排队等。
 */
const QUEUE_TIMEOUT = 20000;   // 排队最多等 20 秒，等不到就让客户端稍后重试
const gate = { active: 0, waiters: [] };

function maxConcurrency(env) {
    const n = Math.floor(Number(env && env.MAX_CONCURRENCY));
    return Number.isFinite(n) && n > 0 ? Math.min(50, n) : 2;
}

/** 拿号：有空位立刻返回 true，否则排队，超时返回 false */
function acquireSlot(limit, timeoutMs) {
    if (gate.active < limit) { gate.active += 1; return Promise.resolve(true); }
    return new Promise((resolve) => {
        const waiter = { done: false };
        const timer = setTimeout(() => {
            if (waiter.done) return;
            waiter.done = true;
            const i = gate.waiters.indexOf(waiter);
            if (i >= 0) gate.waiters.splice(i, 1);
            resolve(false);
        }, timeoutMs);
        waiter.resolve = () => {
            if (waiter.done) return;
            waiter.done = true;
            clearTimeout(timer);
            resolve(true);
        };
        gate.waiters.push(waiter);
    });
}

/** 还号：有人排队就把名额直接转交，没人排才真正减一 */
function releaseSlot() {
    const next = gate.waiters.shift();
    if (next && !next.done) { next.resolve(); return; }
    if (gate.active > 0) gate.active -= 1;
}

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS)
    });
}

function fail(code, message, status = 400) {
    return json({ ok: false, error: { code, message } }, status);
}

/** 激活码统一成大写、去空格，大小写不敏感、复制带空格也能用 */
function normLicense(raw) {
    return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 I/O/0/1

function randomCode() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    let s = '';
    for (let i = 0; i < 12; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
    return 'ZM-' + s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
}

function licKey(code) {
    return 'lic:' + code;
}

function statusOf(rec, now) {
    if (!rec) return 'missing';
    if (rec.revoked) return 'revoked';
    if (typeof rec.expireAt === 'number' && rec.expireAt <= now) return 'expired';
    return 'active';
}

function daysLeft(rec, now) {
    if (!rec || rec.revoked) return 0;
    return Math.max(0, Math.ceil((rec.expireAt - now) / DAY));
}

async function readLicense(env, code, now) {
    const raw = await env.LICENSES.get(licKey(code));
    if (!raw) return null;
    try {
        const rec = JSON.parse(raw);
        rec.status = statusOf(rec, now);
        rec.daysLeft = daysLeft(rec, now);
        return rec;
    } catch (e) {
        return null;
    }
}

async function writeLicense(env, code, rec) {
    await env.LICENSES.put(licKey(code), JSON.stringify(rec));
}

/* ============ 额度 / 设备上限（0 表示不限） ============ */

/** 上限归一化：非法值、负数、0 一律当「不限」 */
function limitOf(v, max) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(max, n);
}

function quotaOf(rec) { return limitOf(rec && rec.dailyQuota, 100000); }
function maxDevicesOf(rec) { return limitOf(rec && rec.maxDevices, 50); }

/** 按北京时间切天：用户体感上「今天的额度」在凌晨 0 点重置 */
function dayKey(now) {
    return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function resetHint(now) {
    const left = 24 * 3600 * 1000 - ((now + 8 * 3600 * 1000) % (24 * 3600 * 1000));
    const h = Math.floor(left / 3600000);
    const m = Math.floor((left % 3600000) / 60000);
    return (h > 0 ? h + ' 小时 ' : '') + m + ' 分钟后';
}

/** 90 天内出现过的设备算「在用的设备」，换手机两个月后名额会自动释放 */
function liveDevices(rec, now) {
    const out = {};
    const devs = (rec && rec.devices) || {};
    for (const k of Object.keys(devs)) {
        if (now - devs[k] <= 90 * 86400000) out[k] = devs[k];
    }
    return out;
}

/** KV 里记的当日用量（跨天自动归零） */
function usageToday(rec, now) {
    if (!rec || !rec.usage || rec.usage.day !== dayKey(now)) return 0;
    return Math.max(0, Math.floor(Number(rec.usage.count) || 0));
}

/**
 * 进程内先累加用量：KV 免费额度每天只有 1000 次写入，
 * 每生成一次写一次会瞬间打爆配额，所以用量在内存里攒，最多每 60 秒落盘一次。
 * 代价是 Worker 换实例时最多丢一分钟的计数 —— 这是防滥用，不是计费，够用。
 */
const useMem = new Map(); // code -> { day, count, savedAt }

/**
 * 章内子请求计数（第 2 段起的分段、校对块、补写）。
 * 这些不占额度，但要防着有人拿它们无限刷上游，所以单独记一份。
 */
const subMem = new Map(); // code -> { day, count }

function bumpSub(code, now) {
    const day = dayKey(now);
    let s = subMem.get(code);
    if (!s || s.day !== day) s = { day, count: 0 };
    s.count += 1;
    subMem.set(code, s);
    if (subMem.size > 1000) {
        for (const [k, v] of subMem) if (v.day !== day) subMem.delete(k);
    }
    return s.count;
}

function usedToday(rec, code, now) {
    const kv = usageToday(rec, now);
    const mem = useMem.get(code);
    if (mem && mem.day === dayKey(now)) return Math.max(kv, mem.count);
    return kv;
}

/**
 * 设备标识：App 本地随机生成并持久化，用来统计一个码被几台手机用过。
 * 只接受字母数字下划线短横，避免被塞进奇怪内容。
 */
function deviceOf(request, body) {
    const d = String((body && body.device) || request.headers.get('x-device') || '').trim();
    return /^[A-Za-z0-9_-]{6,64}$/.test(d) ? d : '';
}

/**
 * 超出设备上限 → 返回错误响应；正常 → null。
 * 拿不到设备标识时不拦（老版本 App 的生成请求不带，不能一刀切废掉它们），
 * 但激活接口一定带，真正的门在那里。
 */
function deviceLimitError(rec, dev, now) {
    const max = maxDevicesOf(rec);
    if (!max || !dev) return null;
    const live = liveDevices(rec, now);
    if (live[dev]) return null;
    if (Object.keys(live).length >= max) {
        return fail('LICENSE_DEVICE_LIMIT',
            '该激活码最多绑定 ' + max + ' 台设备，本机不在其中。请联系卖家解绑后重试', 403);
    }
    return null;
}

/**
 * 老版本把设备号存在 App 本地（随机串，d 开头），新版改用系统 ANDROID_ID（a 开头）。
 * 老用户一升级，设备号就变了，「一码一机」会直接把人锁在外面（本次就踩到了）。
 * 规则：新格式可以顶掉码里的旧格式设备，且只可能发生一次（顶掉后就没有 d 了）。
 */
function migrateLegacyDevice(rec, dev, now) {
    if (!dev || dev.charAt(0) !== 'a') return false;
    const live = liveDevices(rec, now);
    if (live[dev]) return false;                       // 本来就在名单里
    const legacy = Object.keys(live).filter(k => k.charAt(0) === 'd');
    if (!legacy.length) return false;                  // 没有旧格式设备可顶
    for (const k of legacy) delete live[k];
    live[dev] = now;
    rec.devices = live;
    return true;
}

/**
 * 一次请求的记账：当日用量、设备、最后使用时间合并成「最多写一次 KV」。
 *   · 设备：同一台 24 小时内只记一次
 *   · 最后使用时间 / 累计次数：10 分钟最多记一次
 *   · 当日用量：60 秒最多落盘一次，额度用满时立刻落盘
 */
async function recordUse(env, code, rec, dev, now, countUsage, forceWrite) {
    const day = dayKey(now);
    let needWrite = false;

    // 只有真正调用了模型才算一次；激活/心跳校验（客户端每 60 秒一次）不计额度
    if (countUsage !== false) {
        let mem = useMem.get(code);
        if (!mem || mem.day !== day) mem = { day, count: usageToday(rec, now), savedAt: 0 };
        mem.count += 1;

        const quota = quotaOf(rec);
        if (!mem.savedAt || now - mem.savedAt >= 60000 || (quota > 0 && mem.count >= quota)) {
            mem.savedAt = now;
            rec.usage = { day, count: mem.count };
            needWrite = true;
        }
        useMem.set(code, mem);

        // 顺手清理前一天的内存条目，避免实例长期存活时无限增长
        if (useMem.size > 1000) {
            for (const [k, v] of useMem) if (v.day !== day) useMem.delete(k);
        }
    }

    if (dev) {
        rec.devices = liveDevices(rec, now);
        if (!rec.devices[dev] || now - rec.devices[dev] >= 24 * 3600 * 1000) {
            rec.devices[dev] = now;
            needWrite = true;
        }
    }

    if (!rec.lastUsedAt || now - rec.lastUsedAt >= 10 * 60 * 1000) {
        rec.lastUsedAt = now;
        rec.uses = (rec.uses || 0) + 1;
        needWrite = true;
    }

    if (forceWrite) needWrite = true;   // 设备迁移这类「改了就必须落盘」的改动
    if (!needWrite) return;
    const out = Object.assign({}, rec);
    delete out.status;
    delete out.daysLeft;
    try { await writeLicense(env, code, out); } catch (e) { /* 记账失败不影响生成 */ }
}

async function handleAdmin(request, env, body) {
    const token = request.headers.get('x-admin-token') || '';
    if (!env.ADMIN_TOKEN) return fail('NO_ADMIN_TOKEN', '服务端未配置 ADMIN_TOKEN', 500);
    if (token !== env.ADMIN_TOKEN) return fail('FORBIDDEN', '管理口令不正确', 403);

    const now = Date.now();
    const action = String((body && body.action) || '').toLowerCase();

    if (action === 'create') {
        const days = Math.min(3650, Math.max(1, parseInt(body.days, 10) || 30));
        const count = Math.min(200, Math.max(1, parseInt(body.count, 10) || 1));
        const note = String(body.note || '').slice(0, 80);
        const dailyQuota = limitOf(body.dailyQuota, 100000);
        const maxDevices = limitOf(body.maxDevices, 50);
        const created = [];
        for (let i = 0; i < count; i++) {
            let code = randomCode();
            // 极小概率重复，重试几次
            for (let t = 0; t < 3; t++) {
                const exists = await env.LICENSES.get(licKey(code));
                if (!exists) break;
                code = randomCode();
            }
            const rec = {
                createdAt: now, expireAt: now + days * DAY, note, revoked: false,
                uses: 0, lastUsedAt: 0, dailyQuota, maxDevices
            };
            await writeLicense(env, code, rec);
            created.push({ code, expireAt: rec.expireAt, days, dailyQuota, maxDevices });
        }
        return json({ ok: true, keys: created });
    }

    if (action === 'list') {
        const out = [];
        let cursor;
        do {
            const page = await env.LICENSES.list({ prefix: 'lic:', cursor });
            const vals = await Promise.all(page.keys.map((k) => env.LICENSES.get(k.name)));
            page.keys.forEach((k, i) => {
                let rec = null;
                try { rec = JSON.parse(vals[i] || 'null'); } catch (e) { rec = null; }
                if (!rec) return;
                out.push({
                    code: k.name.slice(4),
                    createdAt: rec.createdAt,
                    expireAt: rec.expireAt,
                    note: rec.note || '',
                    uses: rec.uses || 0,
                    lastUsedAt: rec.lastUsedAt || 0,
                    status: statusOf(rec, now),
                    daysLeft: daysLeft(rec, now),
                    dailyQuota: quotaOf(rec),
                    todayUsed: usedToday(rec, k.name.slice(4), now),
                    maxDevices: maxDevicesOf(rec),
                    deviceCount: Object.keys(liveDevices(rec, now)).length,
                    lastSeenAt: Math.max(0, ...Object.values(rec.devices || {}))
                });
            });
            cursor = page.list_complete ? null : page.cursor;
        } while (cursor);
        out.sort((a, b) => b.createdAt - a.createdAt);
        return json({ ok: true, keys: out, now });
    }

    const code = normLicense(body && (body.code || body.license));
    if (!code) return fail('NO_CODE', '缺少激活码');
    const rec = await readLicense(env, code, now);
    if (!rec) return fail('NOT_FOUND', '激活码不存在', 404);

    if (action === 'get') {
        return json({
            ok: true,
            key: Object.assign({ code }, rec, {
                dailyQuota: quotaOf(rec),
                todayUsed: usedToday(rec, code, now),
                maxDevices: maxDevicesOf(rec),
                deviceCount: Object.keys(liveDevices(rec, now)).length
            })
        });
    }

    if (action === 'extend') {
        const days = Math.min(3650, Math.max(1, parseInt(body.days, 10) || 30));
        const base = Math.max(now, rec.expireAt || now);
        rec.expireAt = base + days * DAY;
        rec.revoked = false;
        delete rec.status; delete rec.daysLeft;
        await writeLicense(env, code, rec);
        return json({ ok: true, code, expireAt: rec.expireAt });
    }

    if (action === 'setexpire') {
        const t = parseInt(body.expireAt, 10);
        if (!t || t < now) return fail('BAD_TIME', '到期时间必须是将来的毫秒时间戳');
        rec.expireAt = t;
        rec.revoked = false;
        delete rec.status; delete rec.daysLeft;
        await writeLicense(env, code, rec);
        return json({ ok: true, code, expireAt: rec.expireAt });
    }

    if (action === 'revoke' || action === 'unrevoke') {
        rec.revoked = action === 'revoke';
        delete rec.status; delete rec.daysLeft;
        await writeLicense(env, code, rec);
        return json({ ok: true, code, revoked: rec.revoked });
    }

    /** 调整上限；传 0 表示不限，只改传了的那一项 */
    if (action === 'setlimits') {
        if (body.dailyQuota !== undefined) rec.dailyQuota = limitOf(body.dailyQuota, 100000);
        if (body.maxDevices !== undefined) rec.maxDevices = limitOf(body.maxDevices, 50);
        delete rec.status; delete rec.daysLeft;
        await writeLicense(env, code, rec);
        return json({
            ok: true, code,
            dailyQuota: quotaOf(rec),
            maxDevices: maxDevicesOf(rec)
        });
    }

    /** 用户换手机 / 名额被占满时，把已绑定设备清空 */
    if (action === 'resetdevices') {
        rec.devices = {};
        delete rec.status; delete rec.daysLeft;
        await writeLicense(env, code, rec);
        return json({ ok: true, code, deviceCount: 0 });
    }

    /** 手动清零今日用量（比如误拦了客户，不想等到明天） */
    if (action === 'resetusage') {
        rec.usage = { day: dayKey(now), count: 0 };
        useMem.delete(code);
        delete rec.status; delete rec.daysLeft;
        await writeLicense(env, code, rec);
        return json({ ok: true, code, todayUsed: 0 });
    }

    if (action === 'delete') {
        await env.LICENSES.delete(licKey(code));
        return json({ ok: true, code, deleted: true });
    }

    return fail('BAD_ACTION', '不认识的管理动作：' + action);
}

async function handleActivate(request, env, body) {
    const code = normLicense(body && body.license);
    if (!code) return fail('NO_LICENSE', '请输入激活码');
    const now = Date.now();
    const rec = await readLicense(env, code, now);
    if (!rec) return fail('LICENSE_INVALID', '激活码不存在，请检查是否输入有误', 404);
    if (rec.status === 'revoked') return fail('LICENSE_REVOKED', '该激活码已被停用，请联系卖家', 403);
    if (rec.status === 'expired') return fail('LICENSE_EXPIRED', '该激活码已到期，请联系卖家续期', 403);

    const dev = deviceOf(request, body);
    let devErr = deviceLimitError(rec, dev, now);
    // 旧版（随机设备号）升级到新版（系统设备号）时，放行一次自动迁移
    let migrated = false;
    if (devErr && migrateLegacyDevice(rec, dev, now)) { devErr = null; migrated = true; }
    if (devErr) return devErr;

    try { await recordUse(env, code, rec, dev, now, false, migrated); } catch (e) { /* 记账失败不影响激活 */ }

    return json({
        ok: true,
        expireAt: rec.expireAt,
        daysLeft: daysLeft(rec, now),
        deviceCount: Object.keys(liveDevices(rec, now)).length,
        maxDevices: maxDevicesOf(rec),
        dailyQuota: quotaOf(rec),
        todayUsed: usedToday(rec, code, now)
    });
}

async function handleAI(request, env, body) {
    const now = Date.now();
    const code = normLicense(request.headers.get('x-license'));
    if (!code) return fail('LICENSE_MISSING', '请先输入激活码', 401);

    const rec = await readLicense(env, code, now);
    if (!rec) return fail('LICENSE_INVALID', '激活码无效，请重新输入', 401);
    if (rec.status === 'revoked') return fail('LICENSE_REVOKED', '该激活码已被停用，请联系卖家', 403);
    if (rec.status === 'expired') return fail('LICENSE_EXPIRED', '该激活码已到期，请联系卖家续期', 403);

    // 设备上限：防止一个码被拷到一堆手机上共用
    const dev = deviceOf(request, body);
    let devErr = deviceLimitError(rec, dev, now);
    let migrated = false;
    if (devErr && migrateLegacyDevice(rec, dev, now)) { devErr = null; migrated = true; }
    if (devErr) return devErr;

    /**
     * 额度按「章」算，但一章会拆成多次请求（分段 + 全文校对）。
     * 客户端在第 1 段带 x-gen: chapter，后续分段/校对带 x-gen: sub，只有前者扣额度。
     * 没带这个头的一律当「一章」计 —— 宁可多扣，也不能让人伪造 sub 白刷。
     */
    const isSub = String(request.headers.get('x-gen') || '').toLowerCase() === 'sub';

    const quota = quotaOf(rec);
    if (quota > 0) {
        if (!isSub) {
            if (usedToday(rec, code, now) >= quota) {
                return fail('LICENSE_QUOTA',
                    '今天的生成次数已用完（每天 ' + quota + ' 章），' + resetHint(now) + '自动恢复。需要更多请联系卖家',
                    429);
            }
        } else if (bumpSub(code, now) > quota * 30) {
            // 一章最多十几次子请求，30 倍足够宽松；超了基本就是在刷
            return fail('LICENSE_QUOTA', '今天的生成量已超出上限，请明天再试', 429);
        }
    }

    const payload = (body && body.payload) || {};
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    if (!messages.length) return fail('NO_MESSAGES', '缺少 messages');

    const totalChars = messages.reduce((n, m) => n + String((m && m.content) || '').length, 0);
    if (totalChars > 60000) return fail('TOO_LONG', '请求内容过长', 413);

    const maxTokens = Math.min(Number(env.MAX_TOKENS) || 8192, Math.max(256, Number(payload.max_tokens) || 2048));
    const outbound = {
        model: env.MODEL || DEFAULT_MODEL,
        messages,
        stream: !!payload.stream,
        max_tokens: maxTokens
    };
    if (payload.temperature !== undefined) outbound.temperature = payload.temperature;
    if (payload.thinking !== undefined) outbound.thinking = payload.thinking;

    // 先记账（最多一次 KV 写入）再请求上游：放在返回前会拖慢首字
    try { await recordUse(env, code, rec, dev, now, !isSub, migrated); } catch (e) { /* ignore */ }

    /**
     * 并发闸门：上游（智谱）只给 N 个在途请求，超了直接 429。
     * 客户端的「串行」是每台手机各自的，N 个用户同时点就是 N 个并发，
     * 所以必须在这里统一发号，多出来的人排队而不是撞墙。
     */
    const limit = maxConcurrency(env);
    const gotSlot = await acquireSlot(limit, QUEUE_TIMEOUT);
    if (!gotSlot) {
        return fail('BUSY', '当前使用的人较多，请 10 秒后再点一次', 503);
    }
    let slotHeld = true;
    const dropSlot = () => { if (slotHeld) { slotHeld = false; releaseSlot(); } };

    let upstreamRes;
    try {
        upstreamRes = await fetch(env.UPSTREAM_URL || DEFAULT_UPSTREAM, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.API_KEY },
            body: JSON.stringify(outbound)
        });
    } catch (e) {
        dropSlot();
        return fail('UPSTREAM_DOWN', '模型连接失败，请稍后重试', 502);
    }

    const headers = new Headers(CORS);
    headers.set('Content-Type', upstreamRes.headers.get('content-type') || 'application/json; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
    headers.set('x-license-days-left', String(rec.daysLeft));
    if (quota > 0) headers.set('x-license-quota-left', String(Math.max(0, quota - usedToday(rec, code, now))));

    /**
     * 名额要占到响应体传完为止：流式生成期间上游仍算「在途」，
     * 一拿到响应头就放号会让 2 并发实际变成 4 并发。客户端中途断开会走 cancel。
     */
    let bodyOut = upstreamRes.body;
    if (bodyOut && typeof TransformStream !== 'undefined') {
        const guard = setTimeout(dropSlot, 180000); // 兜底：异常情况下 3 分钟必须还号
        try {
            bodyOut = bodyOut.pipeThrough(new TransformStream({
                flush() { clearTimeout(guard); dropSlot(); },
                cancel() { clearTimeout(guard); dropSlot(); }
            }));
        } catch (e) {
            clearTimeout(guard);
            dropSlot();
        }
    } else {
        dropSlot();
    }

    return new Response(bodyOut, { status: upstreamRes.status, headers });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

        if (!env.API_KEY) return fail('NO_API_KEY', '服务端未配置 API_KEY', 500);

        if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/ai')) {
            return json({
                ok: true, service: 'zhimo-ai-proxy', model: env.MODEL || DEFAULT_MODEL,
                licenseRequired: true, maxConcurrency: maxConcurrency(env), inflight: gate.active
            });
        }

        if (request.method !== 'POST') return fail('METHOD', 'Method Not Allowed', 405);

        let body = {};
        if (request.method === 'POST') {
            try {
                body = await request.json();
            } catch (e) {
                return fail('BAD_JSON', '请求体不是合法 JSON');
            }
        }

        if (url.pathname === '/api/activate') return handleActivate(request, env, body);
        if (url.pathname === '/api/admin') return handleAdmin(request, env, body);
        if (url.pathname === '/api/ai') return handleAI(request, env, body);
        return fail('NOT_FOUND', 'Not Found', 404);
    }
};
