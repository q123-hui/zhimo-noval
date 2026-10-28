/**
 * 智墨小说生成器 - 核心应用
 * 支持一键生成完整小说 + 本地AI接入 + 模型配置记录
 */

var REMOTE_STORE_PORT = 18799;

// ============ 锁定模式（分享版手机 App） ============
// 打包 App 分享给别人时，由 locked-config.js 注入 window.__ZHIMO_LOCK__：
// 只保留一个固定的 AI 接口，界面上不出现任何 AI 配置，用户既看不到也改不了。
var ZHIMO_LOCK = (typeof window !== 'undefined' && window.__ZHIMO_LOCK__ && window.__ZHIMO_LOCK__.enabled)
    ? window.__ZHIMO_LOCK__ : null;

/** 本机保存的激活码（真 Key 只在服务端，客户端只有这一串授权码） */
var ZHIMO_LICENSE_KEY = 'zhimo_license_v1';

function zimoGetLicense() {
    try { return (localStorage.getItem(ZHIMO_LICENSE_KEY) || '').trim(); } catch (e) { return ''; }
}

function zimoClearLicense(msg) {
    try { localStorage.removeItem(ZHIMO_LICENSE_KEY); } catch (e) { /* ignore */ }
    if (typeof window.__zhimoLicenseFail === 'function') {
        window.__zhimoLicenseFail(msg || '激活码已失效，请重新输入');
    }
}

/**
 * 本机设备标识：首次生成后长期保存。
 * 服务端用它统计「一个码用了几台手机」，超过上限就拒绝（防止激活码被到处转发）。
 * 注意要和 lock-ui.js 用同一个 localStorage key，否则会被算成两台设备。
 */
function zimoDeviceId() {
    // 必须和 lock-ui.js 的 getDeviceId() 完全一致，否则同一台手机在「激活」和「生成」
    // 两条链路上会被算成两台设备。优先取原生的 ANDROID_ID：卸载重装不变。
    try {
        var native = window.ZhimoUpdater && window.ZhimoUpdater.deviceId
            ? window.ZhimoUpdater.deviceId() : '';
        if (native && /^[A-Za-z0-9_-]{6,64}$/.test(native)) return native;
    } catch (e) { /* 桥不可用就退回本地随机值 */ }

    var KEY = 'zhimo_device_id';
    var id = '';
    try { id = localStorage.getItem(KEY) || ''; } catch (e) { id = ''; }
    if (!id) {
        id = 'd' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-6);
        try { localStorage.setItem(KEY, id); } catch (e) { /* 隐私模式忽略 */ }
    }
    return id;
}

/**
 * 这些错误码代表激活码本身没了（失效/到期/停用），必须清掉本机授权、退回激活页。
 * 额度用尽、设备超限是「临时性」错误，清了码用户反而更懵 —— 只提示，不踢人。
 */
function zimoLicenseFatal(errCode) {
    return errCode === 'LICENSE_MISSING' ||
        errCode === 'LICENSE_INVALID' ||
        errCode === 'LICENSE_REVOKED' ||
        errCode === 'LICENSE_EXPIRED';
}

class NovelGenerator {
    constructor() {
        this.data = this.loadData();
        this.currentChapter = null;
        this.currentCharacter = null;
        this.generatedContent = '';
        this.fullNovelContent = '';
        this.dirty = false;
        this.currentAbort = null;
        // 按章节独立的后台续写任务：chapterId -> job（可多章同时进行）
        this.continueJobs = new Map();
        this.failedChapters = [];
        this.novelStartTime = null;
        this.rewriteSelection = null;
        this.rewriteResult = '';
        // 按章节独立的后台润色任务：chapterId -> job（与 AI 续写同构，可多章并行）
        this.polishJobs = new Map();
        // 按章节独立的后台整章生成任务：chapterId -> job（可多章并行，关闭弹窗后继续）
        this.fullChapterJobs = new Map();
        this.polishView = null;
        // 润色替换前的正文备份（最多留 20 份，可撤销）
        this.polishBackups = Array.isArray(this.data.polishBackups) ? this.data.polishBackups.slice(0, 20) : [];
        this.init();
    }

    // ============ 数据管理 ============

    getDefaultData() {
        return {
            works: [],
            activeWorkId: '',
            settings: {
                aiProvider: 'custom',
                apiKey: '',
                aiModel: '',
                apiUrl: '',
                writingStyle: 'balanced',
                genLength: 'chapter',
                streamEnabled: true,
                autoSaveInterval: 30,
                theme: 'light',
                fontSize: 16,
                lineHeight: 1.8
            },
            modelProfiles: [],
            deletedWorkIds: [],
            deletedProfileIds: [],
            polishBackups: [],
            // 短故事模式用过的角色名（跨故事全局去重，避免多个短故事重名）
            shortStoryNames: [],
            updatedAt: 0
        };
    }

    /** 创建一部新作品的空白数据结构 */
    createWorkData(novelInfo) {
        const now = Date.now();
        return {
            id: 'w_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 6),
            novel: Object.assign({
                title: '', author: '', genre: 'fantasy', theme: '', synopsis: '', wordGoal: 0,
                createdAt: now, updatedAt: now
            }, novelInfo || {}),
            characters: [],
            world: {
                era: '', society: '', tech: '', geography: '',
                factions: '', power: '', rules: '', religion: '',
                customs: '', language: ''
            },
            chapters: [],
            memory: {
                mode: 'smart', charDepth: 'detail', plotRange: 5,
                rules: '', history: []
            },
            activities: []
        };
    }

    /** 把任意来源的作品对象补齐为完整结构 */
    normalizeWork(w) {
        const base = this.createWorkData((w && w.novel) || {});
        const work = Object.assign({}, base, w || {}, {
            id: (w && w.id) || base.id,
            novel: Object.assign({}, base.novel, (w && w.novel) || {}),
            world: Object.assign({}, base.world, (w && w.world) || {}),
            memory: Object.assign({}, base.memory, (w && w.memory) || {}),
            characters: (w && w.characters) || [],
            chapters: (w && w.chapters) || [],
            activities: (w && w.activities) || []
        });
        // 润色标记基线：旧章节没有 polishedAt 时，以当前 updatedAt 作为基线，
        // 避免升级后一次性把所有旧章都标成「待润色」；之后只要正文被改动就会触发标记。
        (work.chapters || []).forEach(ch => {
            if (typeof ch.polishedAt !== 'number') {
                ch.polishedAt = ch.updatedAt || ch.createdAt || 0;
            }
        });
        return work;
    }

    /** 判断某章是否需要润色：有正文、且最近一次改动晚于最近一次润色 */
    needsPolish(ch) {
        if (!ch || !ch.content || !ch.content.trim()) return false;
        // 从未记录过润色时间（理论上 normalizeWork 已补基线，这里再兜底一次）
        if (typeof ch.polishedAt !== 'number') return false;
        return (ch.updatedAt || 0) > ch.polishedAt;
    }

    /**
     * 加载数据。支持两种结构：
     *  - 新版：{ works: [...], activeWorkId, settings, modelProfiles }
     *  - 旧版：单作品平铺结构（自动迁移为第一部作品）
     * AI 设置与模型配置为全局数据，不随作品切换。
     */
    loadData() {
        const data = this.getDefaultData();
        let parsed = null;
        let fromLocal = false;
        // 1) 优先使用本地服务器注入的共享数据（网页版与桌面 App 共用同一份文件）
        if (window.__STORE_BOOT && typeof window.__STORE_BOOT === 'object' && Array.isArray(window.__STORE_BOOT.works)) {
            parsed = window.__STORE_BOOT;
        } else {
            // 2) 否则回退到浏览器 localStorage（如直接双击 index.html 打开时）
            try {
                const saved = localStorage.getItem('novelGeneratorData');
                if (saved) { parsed = JSON.parse(saved); fromLocal = true; }
            } catch (e) {
                console.error('加载数据失败:', e);
            }
        }
        // 若共享文件为空、但本地 localStorage 有数据 → 稍后自动迁移到共享文件
        this.needMigrateToServer = !!(window.__STORE_API && fromLocal &&
            !(window.__STORE_BOOT && Array.isArray(window.__STORE_BOOT.works)));
        if (parsed) {
            data.updatedAt = parsed.updatedAt || 0;
            if (parsed.settings) data.settings = Object.assign({}, data.settings, parsed.settings);
            if (Array.isArray(parsed.modelProfiles)) data.modelProfiles = parsed.modelProfiles;
            if (Array.isArray(parsed.deletedWorkIds)) data.deletedWorkIds = parsed.deletedWorkIds.slice();
            if (Array.isArray(parsed.deletedProfileIds)) data.deletedProfileIds = parsed.deletedProfileIds.slice();
            if (!Array.isArray(data.deletedProfileIds)) data.deletedProfileIds = [];
            if (Array.isArray(parsed.shortStoryNames)) data.shortStoryNames = parsed.shortStoryNames.slice();
            if (Array.isArray(parsed.works) && parsed.works.length > 0) {
                data.works = parsed.works.map(w => this.normalizeWork(w));
                data.activeWorkId = parsed.activeWorkId || data.works[0].id;
            } else if (parsed.novel || parsed.chapters || parsed.characters || parsed.world || parsed.activities) {
                // 旧版单作品数据迁移
                const work = this.normalizeWork({
                    novel: parsed.novel,
                    characters: parsed.characters,
                    world: parsed.world,
                    chapters: parsed.chapters,
                    memory: parsed.memory,
                    activities: parsed.activities
                });
                data.works = [work];
                data.activeWorkId = work.id;
                console.log('已将旧版单作品数据迁移为多作品结构');
            }
        }
        // 应用删除墓碑：已删除的作品不再出现（即使共享文件里被旧数据并集还原）
        if (Array.isArray(data.deletedWorkIds) && data.deletedWorkIds.length) {
            const del = new Set(data.deletedWorkIds);
            data.works = (data.works || []).filter(w => w && !del.has(w.id));
        }
        if (!data.works.length) data.works = [this.createWorkData()];
        if (!data.works.some(w => w.id === data.activeWorkId)) data.activeWorkId = data.works[0].id;
        if (!Array.isArray(data.shortStoryNames)) data.shortStoryNames = [];
        return data;
    }

    /** 当前作品：所有小说内容都挂在作品下，AI 设置为全局 */
    get work() {
        if (!Array.isArray(this.data.works)) this.data.works = [];
        let w = this.data.works.find(x => x.id === this.data.activeWorkId);
        if (!w) w = this.data.works[0];
        if (!w) {
            w = this.createWorkData();
            this.data.works.push(w);
        }
        if (this.data.activeWorkId !== w.id) this.data.activeWorkId = w.id;
        return w;
    }

    saveData() {
        try {
            // 锁定模式：本地留档里绝不留接口地址/模型/密钥，导出作品时也不会带出去
            if (ZHIMO_LOCK && this.data && this.data.settings) {
                this.data.settings.apiKey = '';
                this.data.settings.apiUrl = '';
                this.data.settings.aiModel = '';
                this.data.modelProfiles = [];
            }
            this.sanitizeChapters();
            this.work.novel.updatedAt = Date.now();
            // 整体版本号：共享数据轮询用它判断「哪一端更新」，避免旧副本把新内容写回来
            this.data.updatedAt = Date.now();
            const json = JSON.stringify(this.data);
            localStorage.setItem('novelGeneratorData', json);
            this.syncToServer(json);
            this._lastSavedBlob = json;
            // 记下本地保存时间：避免下方轮询在异步 PUT 落地前读到旧数据，把刚删除/刚修改的配置「复活」
            this._lastSaveTs = Date.now();
            this.updateStorageInfo();
        } catch (e) {
            console.error('保存数据失败:', e);
            this.showNotification('保存失败：存储空间不足', 'error');
        }
    }

    /**
     * 章节兜底规整（任何创建入口最终都会经过 saveData，所以这里做最后一道保险）：
     *  - 同一部作品内不允许出现同名章节，撞车时用该章正文提炼一个不同标题
     *  - 章节号统一按顺序连续编号，避免出现多个「第2章」
     */
    sanitizeChapters() {
        const chs = this.work && this.work.chapters;
        if (!Array.isArray(chs) || chs.length < 2) return;
        const used = new Set();
        for (let i = 0; i < chs.length; i++) {
            const c = chs[i];
            const key = this.normChapterKey(c.title);
            if (!key) continue;
            if (used.has(key)) {
                c.title = this.deriveTitleFromPlot(c.content || '', c.title, used);
            } else {
                used.add(key);
            }
        }
        chs.sort((a, b) => (a.number || 0) - (b.number || 0));
        chs.forEach((c, i) => { c.number = i + 1; });
    }

    /**
     * 把数据写入本地服务器的共享文件（网页版与桌面 App 共用）。
     * 无服务器（直接双击 html）时静默跳过，仅用 localStorage。
     */
    syncToServer(json) {
        if (!window.__STORE_API) return;
        try {
            fetch(window.__STORE_API, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: json || JSON.stringify(this.data)
            }).catch(() => { /* 网络异常时忽略，localStorage 仍保留一份 */ });
        } catch (e) { /* 忽略 */ }
    }

    updateStorageInfo() {
        const data = JSON.stringify(this.data);
        const size = new Blob([data]).size;
        const maxSize = 5 * 1024 * 1024;
        const percent = Math.min(100, size / maxSize * 100).toFixed(1);
        const usedEl = document.getElementById('storageUsed');
        const textEl = document.getElementById('storageText');
        if (usedEl) usedEl.style.width = percent + '%';
        if (textEl) {
            textEl.textContent = window.__STORE_API
                ? (size/1024).toFixed(1) + ' KB · 已与 App 共享'
                : '⚠️ 仅存本地（未与 App 共享，请用 start.command 打开网页）';
        }
    }

    /** 候选的共享数据接口地址：页面同源 / App 固定端口 / 网页服务器常见端口 */
    _storeCandidates() {
        const list = [];
        if (location.protocol === 'http:' || location.protocol === 'https:') {
            list.push(location.origin + '/api/data');
        }
        list.push('http://127.0.0.1:' + REMOTE_STORE_PORT + '/api/data');
        [8080, 8081, 8082, 8090, 8091, 8092].forEach(p => {
            list.push('http://127.0.0.1:' + p + '/api/data');
        });
        return list;
    }

    /**
     * 当页面不是由我们的本地服务器提供（如 file:// 直接打开，或端口被其它静态服务器占用）时，
     * 依次探测本机所有可能的共享数据接口（App 固定端口、网页服务器常见端口、同源接口），
     * 连上后与另一端共享同一份数据。这样「打开任意一端即可自动同步另一端」。
     */
    connectRemoteStore() {
        if (typeof fetch !== 'function') return;
        if (window.__STORE_API) return;
        if (this._connectingRemote) return;
        this._connectingRemote = true;
        const self = this;
        (async () => {
            const candidates = self._storeCandidates();
            for (const url of candidates) {
                let data;
                try {
                    const r = await fetch(url, { method: 'GET', cache: 'no-store' });
                    if (!r.ok) continue;
                    const txt = await r.text();
                    // 只认「我们的」共享接口（返回包含 works/settings 的 JSON），其它静态服务器会被跳过
                    if (txt.indexOf('"works"') === -1 && txt.indexOf('"settings"') === -1) continue;
                    data = JSON.parse(txt);
                    if (!data || typeof data !== 'object') continue;
                } catch (e) { continue; }
                // 找到共享接口：先把本地离线数据并入共享文件（服务端做并集合并），再读回最新数据
                try {
                    await fetch(url, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(self.data)
                    });
                } catch (e) { /* 忽略推送失败，稍后轮询会重试 */ }
                let merged = data;
                try {
                    const r2 = await fetch(url, { method: 'GET', cache: 'no-store' });
                    if (r2.ok) { const d2 = await r2.json(); if (d2 && typeof d2 === 'object') merged = d2; }
                } catch (e) { /* 沿用已取到的 data */ }
                window.__STORE_API = url;
                window.__STORE_BOOT = merged;
                // 采用共享文件前先留一份本地快照：随后用合并规则把本地更新的章节拿回来，
                // 避免「离线时写的内容」被共享文件里的旧副本覆盖
                const localSnapshot = JSON.parse(JSON.stringify(self.data));
                self.data = self.loadData();
                self.mergeRemoteData(localSnapshot);
                self._lastSavedBlob = JSON.stringify(self.data);
                self.loadSettings();
                self.renderAll();
                self.updateStorageInfo();
                self.updateMockBadges();
                self.renderOriginBanner();
                self.showNotification('已连接到共享数据服务器，数据已同步', 'success');
                self._connectingRemote = false;
                return;
            }
            self._connectingRemote = false; // 没找到任何服务器，稍后轮询会自动重试
        })();
    }

    /**
     * 合并另一端推送来的数据：不再整份覆盖，而是按更新时间逐章取舍。
     * 典型事故：网页里刚润色保存（章节 updatedAt 最新），桌面 App 仍持旧副本并推送，
     * 旧轮询会把新章节还原成旧内容；合并后较新的一侧永远获胜，旧副本会被推回去覆盖掉。
     */
    mergeRemoteData(remote) {
        if (!remote || typeof remote !== 'object' || !Array.isArray(remote.works)) return false;
        const local = this.data;
        const remoteById = new Map(remote.works.map(w => [w.id, w]));
        let changed = false;

        (local.works || []).forEach(lw => {
            const rw = remoteById.get(lw.id);
            if (!rw) return;
            if (!Array.isArray(lw.chapters)) lw.chapters = [];
            const rById = new Map((rw.chapters || []).map(c => [c.id, c]));
            lw.chapters.forEach(lc => {
                const rc = rById.get(lc.id);
                if (!rc) return;
                if ((rc.updatedAt || 0) > (lc.updatedAt || 0)) {
                    // 这一章远端更新；但当前正在编辑且未保存时以编辑器为准。
                    // 该章有后台任务（续写/润色）时也一律跳过：任务里的正文才是最新的，
                    // 被远端旧副本覆盖会表现为「刚写进去又回到原样」
                    const editing = this.currentChapter && this.currentChapter.id === lc.id;
                    const liveTask = this.hasRunningChapterTask(lc.id);
                    if (editing && (this.dirty || this.currentAbort || liveTask)) return;
                    if (liveTask) return;
                    Object.keys(lc).forEach(k => delete lc[k]);
                    Object.assign(lc, rc);
                    changed = true;
                    if (editing) {
                        const ta = document.getElementById('chapterContent');
                        if (ta) ta.value = lc.content || '';
                        this.updateEditorWordCount();
                    }
                }
            });
            // 另一端新建的章节
            (rw.chapters || []).forEach(rc => {
                if (!lw.chapters.some(c => c.id === rc.id)) {
                    lw.chapters.push(rc);
                    changed = true;
                }
            });
        });

        // 非章节数据：整体更新时间更新的一侧为准；本地更新则把本地版本推回去，治好被旧副本占用的共享文件
        const remoteTs = remote.updatedAt || 0;
        const localTs = local.updatedAt || 0;
        if (remoteTs > localTs) {
            if (remote.settings) local.settings = remote.settings;
            if (Array.isArray(remote.modelProfiles)) local.modelProfiles = remote.modelProfiles;
            if (Array.isArray(remote.deletedWorkIds)) local.deletedWorkIds = remote.deletedWorkIds;
            if (Array.isArray(remote.deletedProfileIds)) local.deletedProfileIds = remote.deletedProfileIds;
            if (remote.activeWorkId) local.activeWorkId = remote.activeWorkId;
            (local.works || []).forEach(lw => {
                const rw = remoteById.get(lw.id);
                if (!rw) return;
                ['novel', 'world', 'characters', 'memory', 'activities'].forEach(k => {
                    if (rw[k] !== undefined) lw[k] = rw[k];
                });
            });
            local.updatedAt = remoteTs;
            changed = true;
        } else if (localTs > remoteTs) {
            this.syncToServer(JSON.stringify(local));
        }
        return changed;
    }

    /** 合并/切换章节后，把当前章节与编辑器对齐（编辑器有未保存改动时以编辑器为准） */
    syncEditorWithMergedChapter() {
        const ta = document.getElementById('chapterContent');
        if (!ta || !this.currentChapter) return;
        // AI 正在往编辑器里流式写入（或本章正在后台润色）：此时不要用同步来的副本覆盖编辑器
        if (this.currentAbort) return;
        if (this.hasRunningChapterTask(this.currentChapter.id)) return;
        const current = ta.value;
        const stored = this.currentChapter.content || '';
        if (current === stored) return;
        if (this.dirty && current.trim()) {
            this.currentChapter.content = current;
            this.saveData();
        } else {
            ta.value = stored;
            this.updateEditorWordCount();
            const titleEl = document.getElementById('chapterTitle');
            if (titleEl) titleEl.value = this.currentChapter.title || '';
        }
    }

    /** 轮询共享数据文件：另一端改动后自动同步到当前页面（无需手动刷新） */
    startSharedPolling() {
        this._lastSavedBlob = JSON.stringify(this.data);
        this._connectTries = 0;
        setInterval(async () => {
            const api = window.__STORE_API;
            if (!api || typeof fetch !== 'function') {
                // 尚未连上 App：每隔约 12 秒重试一次（比如用户稍后才打开桌面 App）
                if (!api && typeof fetch === 'function' && (++this._connectTries % 3 === 0)) this.connectRemoteStore();
                return;
            }
            // 本地刚保存过：等异步 PUT 落盘再读，避免读到旧数据把刚删除/刚改的配置「复活」
            if (this._lastSaveTs && (Date.now() - this._lastSaveTs) < 3000) return;
            try {
                const r = await fetch(api, { method: 'GET', cache: 'no-store' });
                if (!r.ok) return;
                const data = await r.json();
                if (!data || typeof data !== 'object') return;
                const blob = JSON.stringify(data);
                if (blob === this._lastSavedBlob) return;
                window.__STORE_BOOT = data;
                const before = JSON.stringify(this.data);
                // 按更新时间逐章合并，避免旧副本把刚保存的内容还原
                const merged = this.mergeRemoteData(data);
                this._lastSavedBlob = JSON.stringify(this.data);
                this.syncEditorWithMergedChapter();
                if (merged || JSON.stringify(this.data) !== before) {
                    this.loadSettings();
                    this.renderAll();
                    this.updateStorageInfo();
                    this.updateMockBadges();
                    this.renderOriginBanner();
                    this.showNotification('已合并另一端的数据（按保存时间保留较新版本）', 'success');
                }
            } catch (e) { /* 忽略瞬时错误 */ }
        }, 4000);
    }

    addActivity(action, detail) {
        detail = detail || '';
        this.work.activities.unshift({ action, detail, time: Date.now() });
        if (this.work.activities.length > 50) {
            this.work.activities = this.work.activities.slice(0, 50);
        }
        this.saveData();
        this.renderActivities();
    }

    // ============ 初始化 ============

    init() {
        this.bindEvents();
        this.loadSettings();
        this.renderAll();
        this.startAutoSave();
        this.updateStorageInfo();
        this.renderPromptChips();
        this.updateMockBadges();
        this.renderOriginBanner();
        // 首次接入共享存储时，把已有的浏览器 localStorage 数据迁移到共享文件
        if (this.needMigrateToServer) {
            this.needMigrateToServer = false;
            this.syncToServer();
        }
        // 锁定模式（手机 App）：不连本机共享数据服务，数据只存在手机本地
        if (!ZHIMO_LOCK) {
            // 网页若以 file:// 直接打开，尝试连上本机 App 的固定端口共享数据
            if (!window.__STORE_API) this.connectRemoteStore();
            // 开启共享数据轮询（另一端改动后自动同步，无需手动刷新）
            this.startSharedPolling();
        }
    }

    bindEvents() {
        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
        });

        const novelInputs = ['novelTitle', 'authorName', 'novelGenre', 'novelTheme', 'novelSynopsis', 'wordGoal'];
        novelInputs.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', () => this.saveNovelInfo());
                el.addEventListener('input', () => this.saveNovelInfo());
            }
        });

        const worldInputs = ['worldEra', 'worldSociety', 'worldTech', 'worldGeography',
                            'worldFactions', 'worldPower', 'worldRules', 'worldReligion',
                            'worldCustoms', 'worldLanguage'];
        worldInputs.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => this.saveWorldInfo());
        });

        const memoryInputs = ['memoryMode', 'charMemoryDepth', 'plotMemoryRange', 'memoryRules'];
        memoryInputs.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => this.saveMemoryConfig());
        });

        const settingInputs = ['aiProvider', 'apiKey', 'aiModel', 'apiUrl',
                              'writingStyle', 'genLength', 'streamEnabled',
                              'autoSaveInterval', 'theme', 'fontSize', 'lineHeight'];
        settingInputs.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => this.saveSettings());
        });

        const chapterContent = document.getElementById('chapterContent');
        if (chapterContent) {
            chapterContent.addEventListener('input', () => {
                this.updateEditorWordCount();
                this.markDirty();
                // 该章正在后台续写时，用户手动改的字以编辑器为准，同步进任务，避免下一步被覆盖
                if (!this.currentChapter) return;
                const job = this.continueJobs.get(this.currentChapter.id);
                if (job && job.running) job.content = chapterContent.value;
            });
        }

        const rwAction = document.getElementById('rwAction');
        if (rwAction) {
            rwAction.addEventListener('change', (e) => {
                const group = document.getElementById('rwCustomGroup');
                if (group) group.style.display = e.target.value === 'custom' ? 'block' : 'none';
            });
        }

        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) exportBtn.addEventListener('click', () => this.exportData());

        const importBtn = document.getElementById('importBtn');
        if (importBtn) {
            importBtn.addEventListener('click', () => {
                const importFile = document.getElementById('importFile');
                if (importFile) importFile.click();
            });
        }

        const importFile = document.getElementById('importFile');
        if (importFile) importFile.addEventListener('change', (e) => this.importData(e));

        // 导入 TXT：按钮触发隐藏的文件选择框，change 后读取并解析
        const importTxtBtn = document.getElementById('importTxtBtn');
        if (importTxtBtn) importTxtBtn.addEventListener('click', () => {
            const el = document.getElementById('importTxtFile');
            if (el) el.click();
        });
        const importTxtInput = document.getElementById('importTxtFile');
        if (importTxtInput) importTxtInput.addEventListener('change', (e) => this.importTxtFile(e));

        // 系统 / 微信「打开方式」：主进程把被打开的 txt 通过 IPC 传过来
        if (window.desktopAPI && typeof window.desktopAPI.onOpenTxtFile === 'function') {
            window.desktopAPI.onOpenTxtFile((payload) => {
                if (payload && typeof payload.text === 'string') {
                    this.importTxtText(payload.name || '微信导入.txt', payload.text);
                }
            });
        }

        const exportMdBtn = document.getElementById('exportMdBtn');
        if (exportMdBtn) exportMdBtn.addEventListener('click', () => this.exportMarkdown());

        // 批量填充：内联 onclick 已绑定，这里再加一层 addEventListener 双保险（避免极端情况下内联未触发）
        const bulkFillBtn = document.getElementById('bulkFillBtn');
        if (bulkFillBtn) bulkFillBtn.addEventListener('click', () => this.openBulkFillModal());
        const bulkFillApply = document.getElementById('bulkFillApply');
        if (bulkFillApply) bulkFillApply.addEventListener('click', () => this.applyBulkInput());
        const bulkFillExample = document.getElementById('bulkFillExample');
        if (bulkFillExample) bulkFillExample.addEventListener('click', () => this.fillBulkExample());

        const rangeInputs = document.querySelectorAll('input[type="range"]');
        rangeInputs.forEach(input => {
            input.addEventListener('input', (e) => {
                const display = e.target.nextElementSibling;
                if (display && display.classList.contains('range-value')) {
                    let suffix = '';
                    if (e.target.id === 'fontSize') suffix = 'px';
                    else if (e.target.id === 'plotMemoryRange') suffix = ' 章';
                    display.textContent = e.target.value + suffix;
                }
            });
        });

        const aiProvider = document.getElementById('aiProvider');
        if (aiProvider) {
            aiProvider.addEventListener('change', (e) => {
                this.syncApiConfigVisibility();
                this.updateMockBadges();
            });
        }

        const genTypeEl = document.getElementById('genType');
        if (genTypeEl) genTypeEl.addEventListener('change', () => {
            if (genTypeEl.value === 'ending') this.setValue('genInsertMode', 'append');
            this.updateGenContextHint();
        });
        const genPromptEl = document.getElementById('genPrompt');
        if (genPromptEl) genPromptEl.addEventListener('input', () => this.updateGenContextHint());
    }

    switchTab(tabId) {
        // 锁定模式没有「设置」页：任何人（含控制台调用）都进不去
        if (ZHIMO_LOCK && tabId === 'settings') return;
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        const tabEl = document.getElementById(tabId);
        if (tabEl) tabEl.classList.add('active');
        const navEl = document.querySelector('[data-tab="' + tabId + '"]');
        if (navEl) navEl.classList.add('active');

        if (tabId === 'chapters') this.renderChapters();
        if (tabId === 'dashboard') this.renderDashboard();
        if (tabId === 'worldbook') {
            this.renderCharacters();
            this.renderWorld();
            this.renderMemoryPreview();
        }
        if (tabId === 'settings') { this.renderModelProfiles(); this.renderLocalGuide(); }
    }

    /** 作品设定内的子页切换（角色 / 世界观 / 记忆） */
    switchSubTab(name) {
        document.querySelectorAll('.sub-tab-content').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.sub-tab-btn').forEach(el => el.classList.remove('active'));
        const panel = document.getElementById('sub-' + name);
        if (panel) panel.classList.add('active');
        const btn = document.querySelector('.sub-tab-btn[data-sub="' + name + '"]');
        if (btn) btn.classList.add('active');
        if (name === 'characters') this.renderCharacters();
        if (name === 'world') this.renderWorld();
        if (name === 'memory') this.renderMemoryPreview();
    }

    // ============ 本地模型预设 ============

    applyLocalPreset(type) {
        // 覆盖输入框前先保住原配置，避免切到本地模型后原来的云端配置丢失
        const kept = this.ensureCurrentConfigSaved();
        const presets = {
            ollama: { url: 'http://localhost:11434/v1', model: 'qwen3:8b', key: 'ollama' },
            vllm: { url: 'http://localhost:8000/v1', model: 'Qwen/Qwen2.5-7B-Instruct', key: 'EMPTY' },
            lmstudio: { url: 'http://localhost:1234/v1', model: 'local-model', key: 'lm-studio' }
        };
        const p = presets[type];
        if (!p) return;
        this.setValue('aiProvider', 'custom');
        this.setValue('apiUrl', p.url);
        this.setValue('aiModel', p.model);
        this.setValue('apiKey', p.key);
        // setValue 不会触发 change 事件，必须显式保存，否则 data.settings 与界面不同步
        this.saveSettings();
        this.showNotification('已填入 ' + type + ' 预设' +
            (kept ? '；原配置已保留为「' + kept + '」' : '') +
            '，建议点「💾 保存当前配置」把本地模型也存成标签', 'success');
    }

    /** 免费云端模型一键预设（写小说推荐）：只填地址+模型名，API Key 由用户粘贴 */
    applyCloudPreset(type) {
        // 覆盖输入框前先保住原配置，避免切换服务商后原来的配置丢失
        const kept = this.ensureCurrentConfigSaved();
        const presets = {
            zhipu: {
                url: 'https://open.bigmodel.cn/api/paas/v4/',
                model: 'glm-4.7-flash',
                tip: '只选文档明确标注「免费文本模型」的 glm-4.7-flash（推荐，200K）；glm-5.3-flash 只是「普惠」并非免费，勿选。Key 类型必须是「模型标准 API」，不要用 Coding/团队套餐的 Key；国内平台与 api.z.ai 的 Key 不通用。'
            },
            siliconflow: {
                url: 'https://api.siliconflow.cn/v1',
                model: 'Qwen/Qwen3-8B',
                tip: '硅基流动 Qwen3-8B（免费）：注册后在「API 密钥」页创建 Key 即可，新用户会送额度。'
            }
        };
        const p = presets[type];
        if (!p) return;
        this.setValue('aiProvider', 'custom');
        this.setValue('apiUrl', p.url);
        this.setValue('aiModel', p.model);
        // 不覆盖 Key：保留原值并聚焦输入框，方便用户粘贴；为空则加占位提示
        this.saveSettings();
        const keyEl = document.getElementById('apiKey');
        if (keyEl) {
            keyEl.focus();
            if (!keyEl.value) keyEl.placeholder = '在此粘贴你的 API Key';
        }
        this.showNotification('已填入 ' + (type === 'zhipu' ? '智谱 GLM-4.7-Flash' : '硅基流动 Qwen3-8B') +
            ' 的地址与模型名' + (kept ? '；原配置已保留为「' + kept + '」' : '') +
            '。请粘贴 API Key 后点「🔌 测试连接」。', 'success');
        const statusEl = document.getElementById('aiTestStatus');
        if (statusEl) statusEl.innerHTML = 'ℹ️ ' + this.escapeHtml(p.tip);
    }

    /** 覆盖当前输入前，把现有配置自动存成标签（已存在则不重复）；返回保留的标签名 */
    ensureCurrentConfigSaved() {
        const apiUrl = (document.getElementById('apiUrl')?.value || '').trim();
        const aiModel = (document.getElementById('aiModel')?.value || '').trim();
        if (!apiUrl && !aiModel) return '';
        if (!Array.isArray(this.data.modelProfiles)) this.data.modelProfiles = [];
        const exists = this.data.modelProfiles.some(p =>
            (p.apiUrl || '') === apiUrl && (p.aiModel || '') === aiModel);
        if (exists) return '';
        const name = (aiModel || '原配置') + '（自动保留）';
        this.data.modelProfiles.unshift({
            id: Date.now().toString(),
            name: name,
            provider: document.getElementById('aiProvider')?.value || 'custom',
            apiKey: document.getElementById('apiKey')?.value || '',
            aiModel: aiModel,
            apiUrl: apiUrl,
            writingStyle: document.getElementById('writingStyle')?.value || 'balanced',
            genLength: document.getElementById('genLength')?.value || 'chapter',
            createdAt: Date.now()
        });
        this.saveData();
        this.renderModelProfiles();
        return name;
    }

    // ============ 模型配置记录（便捷切换不同模型/服务商） ============

    /** 打开保存配置弹窗（预填当前界面值） */
    saveCurrentAsProfile() {
        const apiKey = document.getElementById('apiKey')?.value || '';
        const aiModel = document.getElementById('aiModel')?.value || '';
        const apiUrl = document.getElementById('apiUrl')?.value || '';

        if (!aiModel && !apiUrl) {
            this.showNotification('请先填写模型和 API 地址', 'warning');
            return;
        }

        const preview = document.getElementById('profilePreview');
        if (preview) {
            preview.innerHTML =
                '<div class="profile-preview-row"><span>模型</span><b>' + this.escapeHtml(aiModel || '未填') + '</b></div>' +
                '<div class="profile-preview-row"><span>地址</span><b>' + this.escapeHtml(this.shortenUrl(apiUrl)) + '</b></div>' +
                '<div class="profile-preview-row"><span>Key</span><b>' + (apiKey ? '已填写（' + apiKey.length + ' 位）' : '未填') + '</b></div>';
        }

        const nameEl = document.getElementById('profileName');
        if (nameEl) nameEl.value = aiModel || '未命名配置';

        const modal = document.getElementById('profileModal');
        if (modal) modal.classList.add('show');
    }

    confirmSaveProfile() {
        const name = document.getElementById('profileName')?.value.trim();
        if (!name) {
            this.showNotification('请输入配置名称', 'warning');
            return;
        }

        const profile = {
            id: Date.now().toString(),
            name: name,
            provider: document.getElementById('aiProvider')?.value || 'custom',
            apiKey: document.getElementById('apiKey')?.value || '',
            aiModel: document.getElementById('aiModel')?.value || '',
            apiUrl: document.getElementById('apiUrl')?.value || '',
            writingStyle: document.getElementById('writingStyle')?.value || 'balanced',
            genLength: document.getElementById('genLength')?.value || 'chapter',
            createdAt: Date.now()
        };

        const existingIdx = this.data.modelProfiles.findIndex(p => p.name === name);
        if (existingIdx >= 0) {
            if (!confirm('已存在同名配置「' + name + '」，是否覆盖？')) return;
            profile.id = this.data.modelProfiles[existingIdx].id;
            profile.createdAt = this.data.modelProfiles[existingIdx].createdAt;
            this.data.modelProfiles[existingIdx] = profile;
        } else {
            this.data.modelProfiles.unshift(profile);
        }

        // 若该配置曾被删除，现在重新保存则撤销其删除墓碑（允许恢复）
        if (!Array.isArray(this.data.deletedProfileIds)) this.data.deletedProfileIds = [];
        this.data.deletedProfileIds = this.data.deletedProfileIds.filter(x => x !== profile.id);

        this.saveData();
        this.closeModal('profileModal');
        this.renderModelProfiles();
        this.showNotification('配置「' + name + '」已保存', 'success');
        this.addActivity('保存模型配置', name);
    }

    /** 一键切换已保存的模型配置 */
    applyModelProfile(id) {
        const profile = this.data.modelProfiles.find(p => p.id === id);
        if (!profile) return;

        this.setValue('aiProvider', profile.provider || 'custom');
        this.setValue('apiKey', profile.apiKey || '');
        this.setValue('aiModel', profile.aiModel || '');
        this.setValue('apiUrl', profile.apiUrl || '');
        this.setValue('writingStyle', profile.writingStyle || 'balanced');
        this.setValue('genLength', profile.genLength || 'chapter');

        // setValue 不触发 change，必须显式保存 + 同步界面显示
        this.saveSettings();
        this.renderModelProfiles();
        this.showNotification('已切换到「' + profile.name + '」', 'success');
    }

    deleteModelProfile(id) {
        const profile = this.data.modelProfiles.find(p => p.id === id);
        if (!profile) return;
        if (!confirm('确定删除配置「' + profile.name + '」吗？')) return;
        this.data.modelProfiles = this.data.modelProfiles.filter(p => p.id !== id);
        // 记删除墓碑：保证删除能同步到共享文件，不会被另一端旧数据并回来
        if (!Array.isArray(this.data.deletedProfileIds)) this.data.deletedProfileIds = [];
        if (this.data.deletedProfileIds.indexOf(id) === -1) this.data.deletedProfileIds.push(id);
        this.saveData();
        this.renderModelProfiles();
        this.showNotification('配置已删除', 'success');
    }

    refreshModelProfiles() {
        this.renderModelProfiles();
        this.showNotification('配置列表已刷新', 'info');
    }

    /** 渲染已保存配置为可点击的标签（chips），点击即切换 */
    renderModelProfiles() {
        const list = document.getElementById('modelProfileList');
        if (!list) return;

        const profiles = this.data.modelProfiles || [];
        if (profiles.length === 0) {
            list.innerHTML = '<div class="empty-state" style="padding:8px;font-size:12px;text-align:left;">暂无保存的配置。填好上方信息后点「💾 保存当前配置」，之后即可一键切换。</div>';
            return;
        }

        const currentModel = document.getElementById('aiModel')?.value || '';
        const currentUrl = document.getElementById('apiUrl')?.value || '';

        list.innerHTML = profiles.map(p => {
            const isActive = p.aiModel === currentModel && p.apiUrl === currentUrl;
            return '<div class="profile-chip ' + (isActive ? 'active' : '') + '" title="点击切换到该配置" ' +
                'onclick="app.applyModelProfile(\'' + p.id + '\')">' +
                '<span class="profile-chip-name">' + this.escapeHtml(p.name) + '</span>' +
                '<span class="profile-chip-meta">' + this.escapeHtml(p.aiModel || '未填模型') + '</span>' +
                '<button class="profile-chip-del" title="删除该配置" ' +
                'onclick="event.stopPropagation();app.deleteModelProfile(\'' + p.id + '\')">✕</button>' +
            '</div>';
        }).join('');
    }

    /** 首次升级：已有 AI 配置但还没保存过方案时，自动存一份，防止之后新增本地模型时丢失 */
    ensureDefaultProfile() {
        const s = this.data.settings;
        if (!s || s.profileSeeded) return;
        s.profileSeeded = true;
        if (!Array.isArray(this.data.modelProfiles)) this.data.modelProfiles = [];
        if ((s.aiModel || s.apiUrl) && this.data.modelProfiles.length === 0) {
            this.data.modelProfiles.push({
                id: Date.now().toString(),
                name: '原配置（' + (s.aiModel || '未命名') + '）',
                provider: s.aiProvider || 'custom',
                apiKey: s.apiKey || '',
                aiModel: s.aiModel || '',
                apiUrl: s.apiUrl || '',
                writingStyle: s.writingStyle || 'balanced',
                genLength: s.genLength || 'chapter',
                createdAt: Date.now()
            });
        }
        this.saveData();
    }

    shortenUrl(url) {
        if (!url) return '未填地址';
        try {
            const u = new URL(url);
            return u.host + u.pathname;
        } catch (e) {
            return url.length > 40 ? url.substring(0, 40) + '...' : url;
        }
    }

    /** 始终显示 API 配置区域（已移除模拟模式，所有生成都调用真实模型） */
    syncApiConfigVisibility() {
        document.querySelectorAll('.api-config').forEach(el => {
            el.style.display = 'block';
        });
    }

    /**
     * 读取设置界面当前的实时值。
     * 程序化填充（预设按钮等）不触发 change 事件，仅依赖 data.settings 可能拿到空地址，
     * 因此所有 AI 调用都以界面实时值为准。
     */
    getLiveAISettings() {
        const s = this.data.settings;
        // 锁定模式：永远只用一个固定接口，界面上的输入框即使存在也不参与
        if (ZHIMO_LOCK) {
            return Object.assign({}, s, {
                aiProvider: 'custom',
                // 客户端不持有任何密钥：Key 只在转发服务端
                apiKey: '',
                aiModel: ZHIMO_LOCK.model || 'glm-4.5-flash',
                apiUrl: ZHIMO_LOCK.apiUrl || 'https://open.bigmodel.cn/api/paas/v4',
                streamEnabled: true
            });
        }
        const val = (id) => {
            const el = document.getElementById(id);
            return el ? el.value : undefined;
        };
        const providerEl = document.getElementById('aiProvider');
        const streamEl = document.getElementById('streamEnabled');
        return {
            ...s,
            aiProvider: providerEl ? providerEl.value : s.aiProvider,
            apiKey: val('apiKey') !== undefined ? val('apiKey') : s.apiKey,
            aiModel: val('aiModel') !== undefined ? val('aiModel') : s.aiModel,
            apiUrl: val('apiUrl') !== undefined ? val('apiUrl') : s.apiUrl,
            writingStyle: val('writingStyle') !== undefined ? val('writingStyle') : s.writingStyle,
            genLength: val('genLength') !== undefined ? val('genLength') : s.genLength,
            streamEnabled: streamEl ? streamEl.checked !== false : s.streamEnabled !== false
        };
    }

    // ============ 本地模型连接诊断 ============

    /** 规范化 API 地址：去掉末尾斜杠和 /chat/completions，保留到 /v1 一级 */
    normalizeApiBase(url) {
        let u = (url || '').trim();
        if (!u) return '';
        u = u.replace(/\/+$/, '');
        u = u.replace(/\/chat\/completions$/i, '');
        return u;
    }

    /** 是否本机/局域网模型服务（本地服务才能安全地传 repeat_penalty 等非标准采样参数） */
    isLocalApiUrl(base) {
        return /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:|\/|$)/i.test(String(base || ''));
    }

    /** 云端请求统一走本机服务器的 /api/ai 转发，绕开浏览器 CORS；本地模型仍直连 */
    getAIProxyUrl() {
        // 锁定模式：只认打包时写入的那一个接口
        if (ZHIMO_LOCK && ZHIMO_LOCK.endpoint) return ZHIMO_LOCK.endpoint;
        try {
            const proto = window.location.protocol;
            if (proto !== 'http:' && proto !== 'https:') return '';
            return window.location.origin + '/api/ai';
        } catch (e) { return ''; }
    }

    /** 渲染本地模型接入指南，并提示当前网页来源（CORS 排查关键信息） */
    renderLocalGuide() {
        const info = document.getElementById('pageOriginInfo');
        if (!info) return;
        if (window.location.protocol === 'file:') {
            info.innerHTML = '⚠️ 检测到当前页面以 <code>file://</code> 方式打开，浏览器会以「空来源」发送请求，Ollama / LM Studio 等本地服务几乎都会拒绝。<br>推荐直接双击本目录的 <code>start.command</code>（自动放行跨域并打开网页）；或手动运行 <code>python3 -m http.server 8080</code> 后访问 <code>http://localhost:8080</code>。';
        } else {
            info.innerHTML = 'ℹ️ 当前网页来源：<code>' + this.escapeHtml(window.location.origin) +
                '</code>。Ollama 新版默认放行 localhost 来源；若测试连接报跨域错误（旧版 Ollama 或非 localhost 地址），请按下述命令放行。';
        }
    }

    /** 把网络错误翻译成用户可操作的中文提示 */
    describeNetworkError(err, base) {
        if (ZHIMO_LOCK) {
            if (err && /服务尚未配置/.test(err.message || '')) return err.message;
            return '网络连接失败，请检查手机网络后重试。';
        }
        const origin = window.location.origin;
        if (err && err.name === 'AbortError') {
            return '请求超时或已中止。请检查网络与地址：' + base;
        }
        // file:// 是最常见的原因，优先提示
        if (window.location.protocol === 'file:') {
            return '页面是以 file:// 双击打开的，浏览器会以「空来源」发送请求，本地模型服务会拒绝（Ollama 对 localhost 来源默认放行，但拒绝空来源）。' +
                '请双击目录下的 start.command（推荐），或运行 python3 -m http.server 8080 后访问 http://localhost:8080。';
        }
        if (err instanceof TypeError) {
            if (!this.isLocalApiUrl(base)) {
                return '云端接口请求失败（浏览器层拦截或网络不通）：' + base +
                    '。当前来源 ' + origin + '。常见原因：跨域预检被拒、代理/VPN、DNS 或证书问题。' +
                    '本应用会把云端请求交给本地服务器转发以规避跨域；若仍失败，请检查本机网络/代理设置，或点「🔌 测试连接」查看具体错误。';
            }
            return '浏览器阻止了请求（跨域 CORS 或服务未启动）。排查步骤：' +
                '1) 确认 ' + base + ' 已启动（Ollama 需先运行 ollama serve）；' +
                '2) 当前网页来源为 ' + origin + '，Ollama 新版默认放行 localhost 来源，一般无需额外设置；' +
                '3) 旧版 Ollama 或从其他地址访问时，需用 OLLAMA_ORIGINS="*" ollama serve 启动；' +
                '4) vLLM 启动时加 --allowed-origins \'["*"]\'；' +
                '5) 如仍失败，可双击目录下的 start.command 一键处理。';
        }
        return (err && err.message) ? err.message : String(err);
    }

    /** 从服务端错误响应里提取可读信息（兼容 OpenAI / 智谱等格式） */
    extractApiError(errText) {
        const raw = String(errText || '').trim();
        if (!raw) return '';
        try {
            const j = JSON.parse(raw);
            const msg = (j.error && (j.error.message || j.error.code)) || j.message || j.msg || j.detail;
            if (msg) return String(msg);
        } catch (e) { /* 非 JSON，按原文截断 */ }
        return raw.substring(0, 200);
    }

    describeHttpError(status, errText) {
        const short = this.extractApiError(errText);
        // 分享版：用户改不了任何配置，把技术报错翻译成一句人话
        if (ZHIMO_LOCK) {
            if (status === 401 || status === 403) return '服务已停用或密钥失效，请联系卖家。';
            if (status === 429) return '当前使用人数较多，请等 1~2 分钟再试。';
            if (status === 404 || status >= 500) return '服务暂时不可用，请稍后重试。';
        }
        if (status === 401 || status === 403) {
            return '鉴权失败（' + status + '）：API Key 被拒绝' + (short ? '（' + short + '）' : '') +
                '。请确认 Key 与接口地址属于同一平台、Key 类型正确且未过期；本地模型可随意填写。';
        }
        if (status === 404) return '接口不存在（404）：请检查 API 地址是否到 /v1 一级，如 http://localhost:11434/v1';
        if (status === 400) return '请求被拒绝（400），通常是模型名称不正确：' + short;
        if (status === 429) {
            return '请求过于频繁（429）：该模型有并发/QPS 限制，免费模型更容易触发' + (short ? '（' + short + '）' : '') +
                '。已自动退避重试仍未通过，请等 1~2 分钟、换一个模型，或改用本地模型。';
        }
        if (status >= 500) return '模型服务内部错误（' + status + '）：' + short;
        return 'API请求失败 [' + status + ']: ' + short;
    }

    /** 测试与本地/在线模型服务的连通性（/models 不可用时自动改用最小对话请求验证） */
    async testAIConnection() {
        const statusEl = document.getElementById('aiTestStatus');
        const raw = document.getElementById('apiUrl')?.value || this.data.settings.apiUrl || '';
        if (!raw) {
            if (statusEl) statusEl.textContent = '⚠️ 请先填写 API 地址';
            this.showNotification('请先填写 API 地址', 'warning');
            return;
        }
        const base = this.normalizeApiBase(raw);
        const apiKey = document.getElementById('apiKey')?.value || '';
        const model = document.getElementById('aiModel')?.value || '';
        if (statusEl) statusEl.textContent = '⏳ 正在连接 ' + base + ' ...';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        const start = Date.now();
        try {
            // 1) 标准 OpenAI 模型列表接口
            let models = [];
            let listNote = '';
            try {
                const res = await fetch(base + '/models', {
                    headers: { 'Authorization': 'Bearer ' + apiKey },
                    signal: controller.signal
                });
                if (res.ok) {
                    const data = await res.json().catch(() => ({}));
                    models = (data.data || data.models || []).map(m => m.id || m.name || m.model).filter(Boolean);
                } else {
                    listNote = 'HTTP ' + res.status + ' ' + this.extractApiError(await res.text().catch(() => ''));
                }
            } catch (e) {
                if (e && e.name === 'AbortError') throw e;
                listNote = (e && e.message) ? e.message : String(e);
            }

            // 2) 用一次最小对话请求「实测」当前模型是否真的可调用
            //    （/models 列表对智谱这类平台并不可靠，可能不含 flash 型号）
            const probe = async () => {
                if (!model) return null;
                const body = {
                    model: model,
                    messages: [{ role: 'user', content: '你好' }],
                    max_tokens: 8,
                    stream: false
                };
                try {
                    const proxyUrl = this.isLocalApiUrl(base) ? '' : this.getAIProxyUrl();
                    const res = proxyUrl
                        ? await fetch(proxyUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url: base + '/chat/completions', apiKey: apiKey, payload: body }),
                            signal: controller.signal
                        })
                        : await fetch(base + '/chat/completions', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': 'Bearer ' + apiKey
                            },
                            body: JSON.stringify(body),
                            signal: controller.signal
                        });
                    if (res.ok) return { ok: true };
                    const errText = await res.text().catch(() => '');
                    return { ok: false, status: res.status, error: this.extractApiError(errText) || ('HTTP ' + res.status) };
                } catch (e) {
                    if (e && e.name === 'AbortError') throw e;
                    return { ok: false, error: (e && e.message) ? e.message : String(e) };
                }
            };

            // 有些服务（如智谱）不提供 /models：直接用模型名探测
            if (!models.length) {
                if (!model) {
                    throw new Error('模型列表接口不可用（' + (listNote || '未返回列表') +
                        '），且未填写模型名。请在「模型」里填写控制台中的模型 ID 后重试。');
                }
                const r = await probe();
                if (!r || !r.ok) {
                    throw new Error('对话接口验证失败：' + ((r && r.error) || '未知错误') +
                        (listNote ? '（模型列表接口：' + listNote + '）' : ''));
                }
                const ms = Date.now() - start;
                if (statusEl) {
                    statusEl.innerHTML = '✅ 连接成功（' + ms + ' ms）<br>模型 <code>' +
                        this.escapeHtml(model) + '</code> 可正常调用（该服务未提供 /models 列表）';
                }
                this.showNotification('连接成功，模型可正常调用', 'success');
                return;
            }

            // 3) /models 成功
            const ms = Date.now() - start;
            const isZhipu = /bigmodel\.cn/i.test(base);
            const zhipuFreeModels = this.getZhipuFreeModels();
            const freeModels = isZhipu ? zhipuFreeModels : models;
            // 当前模型不在 /models 列表里时（智谱常见），再实测一次，避免「显示连接成功但该模型其实不可用」
            const modelProbe = (model && models.indexOf(model) === -1) ? await probe() : null;
            if (statusEl) {
                if (isZhipu) {
                    let html = '✅ 连接成功（' + ms + ' ms），可用模型 ' + models.length + ' 个。<br>' +
                        '🆓 <b>只显示免费文本模型</b>：' + this.escapeHtml(freeModels.join('、')) +
                        '<br>智谱 /models 通常不返回 *-flash 免费型号，这里直接内置免费 ID；选中后请点「测试连接」确认可用。';
                    if (modelProbe) {
                        if (modelProbe.ok) {
                            html += '<br>✅ 当前模型 <code>' + this.escapeHtml(model) + '</code> 已<b>实测可调用</b>。';
                        } else if (modelProbe.status === 429) {
                            html += '<br>⚠️ 当前模型 <code>' + this.escapeHtml(model) + '</code> <b>可调用，但当前被限流（429）</b>，稍后重试即可。';
                        } else {
                            html += '<br>⚠️ 当前模型 <code>' + this.escapeHtml(model) + '</code> <b>实测不可用</b>：' +
                                this.escapeHtml(modelProbe.error || '未知错误') + '。若持续失败，说明该账号未开通此型号，可换其他免费型号。';
                        }
                    }
                    statusEl.innerHTML = html;
                } else {
                    let html = '✅ 连接成功（' + ms + ' ms）' +
                        '，可用模型 ' + models.length + ' 个：' + this.escapeHtml(models.slice(0, 8).join('、')) + (models.length > 8 ? ' 等' : '');
                    if (modelProbe && !modelProbe.ok) {
                        html += '<br>⚠️ 当前模型 <code>' + this.escapeHtml(model) + '</code> 不在列表中且实测不可用：' +
                            this.escapeHtml(modelProbe.error || '未知错误');
                    }
                    statusEl.innerHTML = html;
                }
            }
            this.populateModelDatalist(isZhipu ? zhipuFreeModels : models, isZhipu ? zhipuFreeModels : [], isZhipu);
            this.showNotification(isZhipu ? '已列出免费型号' : '已获取 ' + models.length + ' 个模型', 'success');
        } catch (err) {
            if (statusEl) statusEl.innerHTML = '❌ ' + this.escapeHtml(this.describeNetworkError(err, base));
            this.showNotification('连接失败，请查看设置中的诊断信息', 'error');
        } finally {
            clearTimeout(timer);
        }
    }

    /** 从服务端获取可用模型列表，填充到模型输入框下拉 */
    async fetchModelList() {
        const statusEl = document.getElementById('modelListStatus');
        const raw = document.getElementById('apiUrl')?.value || this.data.settings.apiUrl || '';
        if (!raw) {
            if (statusEl) statusEl.textContent = '⚠️ 请先填写 API 地址';
            this.showNotification('请先填写 API 地址', 'warning');
            return;
        }
        const base = this.normalizeApiBase(raw);
        if (statusEl) statusEl.textContent = '⏳ 正在获取模型列表...';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
            const res = await fetch(base + '/models', {
                headers: { 'Authorization': 'Bearer ' + (document.getElementById('apiKey')?.value || '') },
                signal: controller.signal
            });
            if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
            const data = await res.json();
            const models = (data.data || data.models || []).map(m => m.id || m.name || m.model).filter(Boolean);
            if (!models.length) {
                if (statusEl) statusEl.textContent = '服务未返回模型列表，请手动输入模型名';
                return;
            }
            const isZhipu = /bigmodel\.cn/i.test(base);
            const zhipuFreeModels = this.getZhipuFreeModels();
            this.populateModelDatalist(isZhipu ? zhipuFreeModels : models, isZhipu ? zhipuFreeModels : [], isZhipu);
            if (statusEl) {
                statusEl.textContent = isZhipu
                    ? '✅ 已获取 ' + models.length + ' 个模型；下拉框只显示免费型号（部分免费型号不在 /models 列表里，选中后请点「测试连接」确认）'
                    : '✅ 已获取 ' + models.length + ' 个模型，可从下拉选择';
            }
            this.showNotification(isZhipu ? '已列出免费型号' : '已获取 ' + models.length + ' 个模型', 'success');
        } catch (err) {
            if (statusEl) statusEl.innerHTML = '❌ ' + this.escapeHtml(this.describeNetworkError(err, base));
        } finally {
            clearTimeout(timer);
        }
    }

    /** 智谱文档确认免费的文本模型（/models 常不返回，必须内置） */
    getZhipuFreeModels() {
        return ['glm-4.7-flash', 'glm-4.5-flash', 'glm-4-flash-250414', 'glm-4-flash'];
    }

    populateModelDatalist(models, freeIds, isZhipu) {
        this._modelOptions = Array.isArray(models) ? models.slice() : [];
        this._freeModelSet = new Set(Array.isArray(freeIds) ? freeIds : []);
        this._modelListIsZhipu = !!isZhipu;
        // 兼容旧 datalist（若页面仍保留该元素）
        const dl = document.getElementById('aiModelList');
        if (dl) dl.innerHTML = this._modelOptions.map(m => '<option value="' + this.escapeHtml(m) + '"></option>').join('');
        this.renderModelDropdown();
    }

    /** 渲染自定义模型下拉面板（不依赖 datalist，Safari 也能点开） */
    renderModelDropdown() {
        const dd = document.getElementById('aiModelDropdown');
        if (!dd) return;
        const list = this._modelOptions || [];
        if (!list.length) {
            dd.innerHTML = '<div class="model-dropdown-empty">先点「📥」获取可用模型</div>';
            return;
        }
        const free = this._freeModelSet || new Set();
        dd.innerHTML = list.map(m => {
            const safe = this.escapeHtml(m);
            const tag = free.has(m)
                ? '<span class="model-free-tag">免费</span>'
                : (this._modelListIsZhipu ? '<span class="model-paid-tag">付费</span>' : '');
            return '<div class="model-dropdown-item" data-model="' + safe + '" onclick="app.pickModelOption(this.dataset.model)">' +
                '<span class="model-dropdown-name">' + safe + '</span>' + tag + '</div>';
        }).join('');
    }

    /** 展开/收起模型下拉 */
    toggleModelDropdown(e) {
        if (e) e.stopPropagation();
        const dd = document.getElementById('aiModelDropdown');
        if (!dd) return;
        if (dd.style.display === 'block') {
            dd.style.display = 'none';
            return;
        }
        if (!this._modelOptions || !this._modelOptions.length) this.fetchModelList();
        this.renderModelDropdown();
        dd.style.display = 'block';
        if (!this._dropdownCloseBound) {
            this._dropdownCloseBound = true;
            // 点击页面其它位置时收起
            document.addEventListener('click', () => {
                const d = document.getElementById('aiModelDropdown');
                if (d) d.style.display = 'none';
            });
        }
    }

    /** 从下拉里选中一个模型，填入输入框并保存 */
    pickModelOption(value) {
        if (!value) return;
        const input = document.getElementById('aiModel');
        if (input) input.value = value;
        const dd = document.getElementById('aiModelDropdown');
        if (dd) dd.style.display = 'none';
        this.saveSettings();
        this.showNotification('已选择模型 ' + value, 'success');
    }

    /**
     * file:// 双击打开时显示引导横幅（这是"网页连不上本地模型"最常见的原因）。
     * 浏览器安全策略决定：页面内的代码无法绕过，必须改用本地服务器打开。
     */
    renderOriginBanner() {
        const banner = document.getElementById('originBanner');
        if (!banner) return;
        if (window.location.protocol !== 'file:') {
            banner.style.display = 'none';
            return;
        }
        try {
            if (localStorage.getItem('originBannerDismissed') === '1') {
                banner.style.display = 'none';
                return;
            }
        } catch (e) { /* 隐私模式下忽略 */ }
        // 用当前文件所在目录生成可直接粘贴的启动命令
        let dir = '';
        try {
            const p = decodeURIComponent(window.location.pathname);
            dir = p.substring(0, p.lastIndexOf('/'));
        } catch (e) { /* 忽略 */ }
        const cmdEl = document.getElementById('originCmdText');
        if (cmdEl) {
            cmdEl.textContent = dir
                ? 'cd "' + dir + '" && python3 -m http.server 8080'
                : 'python3 -m http.server 8080';
        }
        banner.style.display = 'flex';
    }

    dismissOriginBanner() {
        const banner = document.getElementById('originBanner');
        if (banner) banner.style.display = 'none';
        try { localStorage.setItem('originBannerDismissed', '1'); } catch (e) { /* 忽略 */ }
    }

    /** 复制文本（带降级方案，file:// 下 clipboard API 可能不可用） */
    copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(
                () => this.showNotification('已复制到剪贴板', 'success'),
                () => this.fallbackCopy(text)
            );
            return;
        }
        this.fallbackCopy(text);
    }

    fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            this.showNotification('已复制到剪贴板', 'success');
        } catch (e) {
            this.showNotification('复制失败，请手动选择文本复制', 'warning');
        }
        document.body.removeChild(ta);
    }

    /** 模拟模式已移除，保留空实现以避免分散在各处的调用报错 */
    updateMockBadges() {
        return;
    }

    // ============ 工作台 ============

    saveNovelInfo() {
        this.work.novel.title = document.getElementById('novelTitle')?.value || '';
        this.work.novel.author = document.getElementById('authorName')?.value || '';
        this.work.novel.genre = document.getElementById('novelGenre')?.value || 'fantasy';
        // 核心主题输入框已替换为作品简介；仅当旧输入框仍存在时才写回 theme，避免清空历史数据
        const themeEl = document.getElementById('novelTheme');
        if (themeEl) this.work.novel.theme = themeEl.value || '';
        const synEl = document.getElementById('novelSynopsis');
        if (synEl) this.work.novel.synopsis = synEl.value || '';
        this.work.novel.wordGoal = parseInt(document.getElementById('wordGoal')?.value) || 0;
        this.saveData();
        this.renderGoalProgress();
        this.updateSynopsisHint();
    }

    /** 作品简介实时字数提示（建议 50 字以上） */
    updateSynopsisHint() {
        const hint = document.getElementById('synopsisHint');
        if (!hint) return;
        const input = document.getElementById('novelSynopsis');
        const len = input ? input.value.trim().length : 0;
        hint.textContent = '建议 50 字以上（当前 ' + len + ' 字）';
        hint.style.color = len >= 50 ? '#16a34a' : '';
    }

    renderDashboard() {
        const n = this.work.novel;
        const novelTitle = document.getElementById('novelTitle');
        const authorName = document.getElementById('authorName');
        const novelGenre = document.getElementById('novelGenre');
        const novelTheme = document.getElementById('novelTheme');
        const novelSynopsis = document.getElementById('novelSynopsis');
        if (novelTitle) novelTitle.value = n.title || '';
        if (authorName) authorName.value = n.author || '';
        if (novelGenre) novelGenre.value = n.genre || 'fantasy';
        if (novelTheme) novelTheme.value = n.theme || '';
        if (novelSynopsis) novelSynopsis.value = n.synopsis || '';
        this.updateSynopsisHint();

        const charCount = document.getElementById('charCount');
        const chapterCount = document.getElementById('chapterCount');
        const wordCount = document.getElementById('wordCount');
        if (charCount) charCount.textContent = this.work.characters.length;
        if (chapterCount) chapterCount.textContent = this.work.chapters.length;
        if (wordCount) wordCount.textContent = this.getTotalWordCount().toLocaleString();

        const wordGoalEl = document.getElementById('wordGoal');
        if (wordGoalEl) wordGoalEl.value = this.work.novel.wordGoal || 0;
        this.renderGoalProgress();

        const resumeBtn = document.getElementById('resumeBtn');
        if (resumeBtn) resumeBtn.style.display = this.work.chapters.length > 0 ? 'inline-flex' : 'none';
        this.renderActivities();
    }

    /** 渲染全书字数目标进度 */
    renderGoalProgress() {
        const goal = this.work.novel.wordGoal || 0;
        const total = this.getTotalWordCount();
        const fill = document.getElementById('goalProgress');
        const text = document.getElementById('goalText');
        if (!fill || !text) return;
        if (goal <= 0) {
            fill.style.width = '0%';
            text.textContent = '未设置目标（当前 ' + total.toLocaleString() + ' 字）';
            return;
        }
        const pct = Math.min(100, total / goal * 100);
        fill.style.width = pct.toFixed(1) + '%';
        text.textContent = total.toLocaleString() + ' / ' + goal.toLocaleString() + ' 字（' + pct.toFixed(1) + '%）';
    }

    // ============ 批量填充（完整输入框） ============

    openBulkFillModal() {
        const m = document.getElementById('bulkFillModal');
        if (!m) return;
        m.classList.add('show');
        const r = document.getElementById('bulkFillResult');
        if (r) r.style.display = 'none';
        const ta = document.getElementById('bulkFillText');
        if (ta) ta.focus();
    }

    closeBulkFillModal() {
        this.closeModal('bulkFillModal');
    }

    /**
     * 一行一个角色的写法：「姓名：女，17岁，广播站成员，性格安静敏感」
     * 能识别出至少一个角色特征才判定为角色，避免把普通标签误当人名。
     */
    tryParseInlineCharacter(key, val, knownLabels) {
        if (!key || key.length < 2 || key.length > 5) return null;
        if (!/^[\u4e00-\u9fa5·]+$/.test(key)) return null;
        if (knownLabels && knownLabels.has(key)) return null;
        if (/^(角色|人物|主角|配角|反派|第.{1,4}章|章节)/.test(key)) return null;
        const v = String(val || '').trim();
        if (v.length < 2) return null;
        if (!/(男|女|岁|性别|年龄|身份|职业|外貌|长相|性格|背景|经历|能力|技能|目标|愿望|弱点|缺陷|阵营|派别|标签|称号|昵称|学生|老师|弟子|会长|队员|成员)/.test(v)) return null;
        const char = { name: key };
        v.split(/[，,、;；]/).map(s => s.trim()).filter(Boolean).forEach(f => this.assignInlineFragment(char, f));
        return char;
    }

    /** 把「性格：安静」「广播站成员」「17岁」这类片段归到对应字段 */
    assignInlineFragment(char, frag) {
        const f = String(frag || '').trim();
        if (!f) return;
        const table = [
            [/^性别[：:]?\s*/, 'gender'], [/^(?:年龄|年纪)[：:]?\s*/, 'age'],
            [/^(?:身份\s*\/?\s*职业|身份|职业|工作)[：:]?\s*/, 'occupation'],
            [/^(?:阵营|派别|立场)[：:]?\s*/, 'faction'],
            [/^(?:外貌特征|外貌|长相|样貌|外形)[：:]?\s*/, 'appearance'],
            [/^(?:性格特点|性格)[：:]?\s*/, 'personality'],
            [/^(?:背景故事|背景|经历|来历)[：:]?\s*/, 'background'],
            [/^(?:能力\s*\/?\s*技能|能力|技能|绝技)[：:]?\s*/, 'abilities'],
            [/^(?:目标\s*\/?\s*愿望|目标|愿望|理想)[：:]?\s*/, 'goals'],
            [/^(?:弱点\s*\/?\s*缺陷|弱点|缺陷)[：:]?\s*/, 'weaknesses'],
            [/^(?:角色标签|标签)[：:]?\s*/, 'tags'],
            [/^(?:别名|称号|昵称|外号)[：:]?\s*/, 'alias']
        ];
        for (let i = 0; i < table.length; i++) {
            const m = f.match(table[i][0]);
            if (!m) continue;
            const value = f.slice(m[0].length).trim();
            if (!value) return;
            const field = table[i][1];
            if (field === 'gender') { char.gender = this.mapGender(value); return; }
            if (field === 'faction') { char.faction = this.mapFaction(value); return; }
            char[field] = char[field] ? char[field] + '，' + value : value;
            return;
        }
        // 纯性别词 / 数字年龄
        if (/^(男|女|男性|女性|male|female)$/i.test(f)) { char.gender = this.mapGender(f); return; }
        const age = f.match(/^(?:年龄|年纪)?\s*(\d{1,3}(?:\.\d)?)\s*岁?$/);
        if (age) { char.age = age[1]; return; }
        // 无标签片段：像身份的进「身份/职业」，其余进「性格特点」
        if (/(学生|老师|弟子|长老|会长|队长|队员|替补|社团|职业|工作|身份|杀手|王爷|皇帝|公子|小姐|医生|律师|主播|社长|队)$/.test(f)) {
            char.occupation = char.occupation ? char.occupation + '，' + f : f;
            return;
        }
        if (f.length <= 4 && /(男|女)/.test(f)) { char.gender = this.mapGender(f); return; }
        char.personality = char.personality ? char.personality + '，' + f : f;
    }

    fillBulkExample() {
        const ta = document.getElementById('bulkFillText');
        if (ta) {
            ta.value = [
                '作品名称：剑来',
                '作者：烽火',
                '作品类型：武侠仙侠',
                '作品简介：少年林雷一夜之间满门被灭，他隐姓埋名拜入青云宗，在宗门与魔教的夹缝中追查真相，最终揭开灭门惨案背后牵连整个王朝的阴谋。',
                '字数目标：100000',
                '',
                '时代背景：大周朝贞观年间，王朝鼎盛却暗流涌动',
                '社会结构：门阀林立，寒门子弟难有出头之日',
                '修炼体系：以气御剑，分九品境界',
                '地理：中州大地，江河纵横，北有雪山南有沧海',
                '势力：剑宗、魔教、朝廷三方鼎立',
                '力量体系：九品制，一品最强',
                '',
                '角色：林雷',
                '别名：剑圣',
                '性别：男',
                '年龄：18',
                '职业：青云宗弟子',
                '阵营：主角',
                '外貌：白衣胜雪，眉目清冷',
                '性格：冷静、坚毅、重情',
                '背景：孤儿，被宗门收养，身负血海深仇',
                '能力：御剑术、剑意雏形',
                '目标：查明灭门真相，复仇',
                '弱点：过于重情，易被牵制',
                '标签：天才，孤儿，复仇者',
                '',
                '角色：萧炎',
                '性别：男',
                '年龄：20',
                '职业：炼药师',
                '性格：果敢、隐忍',
                '背景：没落家族的少主',
                '',
                '第一章 初入江湖',
                '少年背剑走出山门，山下是一片陌生的天地。'
            ].join('\n');
        }
        const r = document.getElementById('bulkFillResult');
        if (r) r.style.display = 'none';
    }

    /** 把任意值转成可读字符串：数组/对象取其名称字段，避免界面上出现 [object Object] */
    toTextValue(v) {
        if (v === null || v === undefined || v === '') return '';
        if (typeof v === 'string') return v.trim();
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (Array.isArray(v)) {
            return v.map(x => this.toTextValue(x)).filter(s => s !== '').join('、');
        }
        if (typeof v === 'object') {
            const keys = ['name', 'title', 'label', 'faction', 'value', 'desc', 'description'];
            for (let i = 0; i < keys.length; i++) {
                const s = this.toTextValue(v[keys[i]]);
                if (s) return s;
            }
            return Object.keys(v).map(k => this.toTextValue(v[k])).filter(s => s !== '').join('、');
        }
        return '';
    }

    /** 归一化章节标题，用于判重（去空白与常见标点） */
    normChapterKey(s) {
        return (s || '').trim().toLowerCase().replace(/[\s·、，。,.!！?？:：;；\-—_()（）\[\]【】「」『』"']/g, '');
    }

    /**
     * 生成不重复的章节标题：标题已占用时自动追加数字后缀（危机四伏 → 危机四伏2）
     * usedKeys 为已占用的归一化标题集合，返回同时会把新标题登记进去
     */
    uniqueChapterTitle(title, usedKeys) {
        const base = (title || '').trim() || '未命名章节';
        const key = this.normChapterKey(base);
        if (!usedKeys.has(key)) { usedKeys.add(key); return base; }
        let i = 2;
        let candidate = base + i;
        while (usedKeys.has(this.normChapterKey(candidate))) { i++; candidate = base + i; }
        usedKeys.add(this.normChapterKey(candidate));
        return candidate;
    }

    /**
     * 从章节情节中提炼一个不重复的标题。
     * AI 经常一批章节全给同一个标题（如多个「危机四伏」），此时用该章自己的情节生成不同标题，
     * 既保证唯一，也不会出现「危机四伏2」这种观感上的重复。
     */
    deriveTitleFromPlot(plot, fallback, usedKeys) {
        const used = usedKeys || new Set();
        const text = (plot || '').trim();
        if (text) {
            const parts = text.split(/[。！？；，,.;!?\n]/).map(s => s.trim()).filter(Boolean);
            for (let i = 0; i < parts.length && i < 8; i++) {
                let p = parts[i].replace(/^(第[0-9零一二三四五六七八九十百]+章[：:，,。\s]*)+/, '').trim();
                if (p.length > 12) p = p.substring(0, 12);
                const k = this.normChapterKey(p);
                if (p.length >= 3 && k && !used.has(k)) { used.add(k); return p; }
            }
        }
        const base = (fallback || '').trim() || '新的篇章';
        let n = 2;
        let cand = base + n;
        while (used.has(this.normChapterKey(cand))) { n++; cand = base + n; }
        used.add(this.normChapterKey(cand));
        return cand;
    }

    /**
     * 判断书名是否空泛（短 + 堆砌「云月影星辰」等意象字）。
     * 小模型常把「新颖独特」理解成四字诗意拼贴（云影逐月/月影流光），这里做自动拦截。
     */
    isVagueTitle(t) {
        const s = (t || '').replace(/[《》\s]/g, '').trim();
        if (!s) return true;
        if (s.length > 6) return false; // 长书名通常自带信息量，如「我在废土世界捡垃圾」
        const imagery = (s.match(/[月影云星辰光雪风寒夜梦浮生流明长歌]/g) || []).length;
        return imagery >= 2;
    }

    /** 生成不与现有作品重名的书名：重名时自动加序号 */
    uniqueWorkTitle(title) {
        const base = (title || '').trim() || '未命名作品';
        const exists = new Set((this.data.works || [])
            .filter(w => !this.work || w.id !== this.work.id)
            .map(w => ((w.novel && w.novel.title) || '').trim())
            .filter(Boolean));
        if (!exists.has(base)) return base;
        let i = 2;
        let cand = base + ' (' + i + ')';
        while (exists.has(cand)) { i++; cand = base + ' (' + i + ')'; }
        return cand;
    }

    /** 把结构化纲要转成「标题：内容」文本，便于用户审阅后一键解析填充 */
    buildOutlineText(d) {
        const WL = { era: '时代背景', society: '社会结构', power: '力量体系', factions: '势力' };
        const GENDER_LABEL = { male: '男', female: '女', other: '其他', unknown: '未知' };
        const FACTION_LABEL = { protagonist: '主角', ally: '盟友', neutral: '中立', antagonist: '反派', hidden: '隐藏身份' };
        const L = [];
        L.push('作品名称：' + (d.title || ''));
        if (d.author) L.push('作者：' + d.author);
        if (d.genre) L.push('作品类型：' + d.genre);
        if (d.synopsis) L.push('作品简介：' + d.synopsis);
        if (d.theme) L.push('核心主题：' + d.theme);
        if (d.world) Object.keys(WL).forEach(k => { const v = this.toTextValue(d.world[k]); if (v) L.push(WL[k] + '：' + v); });
        (d.characters || []).forEach(c => {
            L.push('');
            L.push('角色：' + (c.name || ''));
            if (c.gender) L.push('性别：' + (GENDER_LABEL[c.gender] || c.gender));
            if (c.age) L.push('年龄：' + c.age);
            if (c.occupation) L.push('身份：' + c.occupation);
            if (c.faction) L.push('阵营：' + (FACTION_LABEL[c.faction] || c.faction));
            if (c.personality) L.push('性格：' + c.personality);
            if (c.background) L.push('背景：' + c.background);
            if (c.goals) L.push('目标：' + c.goals);
        });
        (d.chapters || []).forEach(ch => {
            L.push('');
            L.push('第' + this.numCn(ch.number || 1) + '章 ' + (ch.title || ''));
            if (ch.plot) L.push('  ' + ch.plot);
        });
        return L.join('\n');
    }

    numCn(n) {
        const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
        if (n <= 10) return ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][n];
        if (n < 20) return '十' + d[n - 10];
        if (n < 100) { const t = Math.floor(n / 10); const o = n % 10; return d[t] + '十' + (o ? d[o] : ''); }
        return String(n);
    }

    /** 从 AI 返回中稳健提取 JSON（兼容 ```json 代码块与多余说明文字） */
    extractJson(raw) {
        if (!raw) return null;
        let s = (raw || '').trim();
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence) s = fence[1].trim();
        try { return JSON.parse(s); } catch (e) { /* 继续尝试 */ }
        const a = s.indexOf('{');
        const b = s.lastIndexOf('}');
        if (a > -1 && b > a) {
            try { return JSON.parse(s.substring(a, b + 1)); } catch (e) { /* 失败 */ }
        }
        return null;
    }

    /** AI 随机填充小说纲要：按用户设定的角色数/章节数生成，并对结果去重、截断，生成时替换当前作品内容 */
    async aiRandomOutline(opts) {
        opts = opts || {};
        const charCount = Math.min(30, Math.max(1, parseInt(opts.charCount, 10) || 5));
        const chapterCount = Math.min(50, Math.max(1, parseInt(opts.chapterCount, 10) || 5));
        const replace = opts.replace !== false;
        const ta = document.getElementById('bulkFillText');
        const btn = document.getElementById('bulkFillAiOutline');
        const settings = this.getLiveAISettings();
        if (!settings.apiUrl || !settings.aiModel) {
            this.showNotification('请先在「设置」页配置本地模型地址（如 http://localhost:11434/v1）与模型名', 'warning');
            return;
        }
        if (btn) { btn.disabled = true; btn.textContent = '⏳ AI 生成中…'; }
        this.showOutlineProgress();
        const systemPrompt = '你是一位经验丰富的小说大纲师。请随机构思一部完整小说纲要，只输出 JSON，不要任何解释、不要代码块标记。\n' +
            'JSON 结构：{"title":"作品名称","author":"作者笔名","genre":"中文题材(从这些里选一个最贴切的：武侠仙侠/玄幻奇幻/都市异能/现代都市/科幻未来/历史架空/古代言情/民国风云/言情耽美/豪门总裁/校园青春/穿越重生/悬疑推理/军旅谍战/灵异恐怖/商战职场/游戏竞技/二次元同人/现实文学/其他)","synopsis":"50字以上的作品简介（含主角、设定、核心冲突与走向）","theme":"核心主题",' +
            '"world":{"era":"时代背景","society":"社会结构","power":"力量/修炼体系","factions":"势力分布"},' +
            '"characters":[正好 ' + charCount + ' 个有名字的角色，互不相同、不要重复，每个 {"name":"姓名","gender":"男/女","age":"年龄(如 18岁)","occupation":"身份/职业","faction":"阵营(主角/盟友/中立/反派/隐藏身份)","personality":"性格","background":"背景","goals":"目标"}],' +
            '"chapters":[正好 ' + chapterCount + ' 个章节，互不相同、不要重复，每个 {"number":序号,"title":"章节标题","plot":"该章大概情节(只写剧情梗概，不要写正文)"}]}\n' +
            '要求：正好 ' + chapterCount + ' 个章节，每个章节标题必须两两完全不同（禁止出现相同或仅差数字的标题，例如不许出现多个「危机四伏」），plot 必须前后连贯、层层递进、相互关联；角色正好 ' + charCount + ' 个且都要有名字、互不相同；' +
            '其中必须恰有 1 个主角（faction 为「主角」），其余角色阵营合理分布在 盟友/中立/反派/隐藏身份，且每个角色都要填写年龄与身份。\n' +
            '书名命名规则（最重要，违反即判不合格）：\n' +
            '1. 先在内部构思一句具体的高概念（谁 + 在什么特殊设定下 + 面临什么冲突），title、theme、world、chapters 全部围绕它展开；\n' +
            '2. title 必须具体点题、有信息量，能让读者一眼看出题材与冲突，长度 3～12 字；\n' +
            '3. 严禁堆砌意象的空泛诗名：禁止用 云/月/影/星/光/夜/梦/浮生/流光/长歌/风华 等字两两拼成四字书名，「云影逐月」「月影流光」「山海无缘」这类一律不合格；\n' +
            '4. 正面示例风格：《我在废土世界捡垃圾》《宗门里只有我一人修炼》《被退婚后我成了首富》《大理寺卿的宠物猫是凶手》——具体、有钩子、能看出这本书讲什么；\n' +
            '5. author 用普通中文笔名（2～3 个字即可，不要带「墨」「影」「苏」堆砌）。';
        // 把已有书名带进提示词，逼模型换一个完全不同的书名与笔名
        const usedTitles = (this.data.works || [])
            .map(w => ((w.novel && w.novel.title) || '').trim())
            .filter(Boolean);
        const avoidHint = usedTitles.length
            ? ('注意：已存在的作品名有 ' + usedTitles.join('、') + '，本次必须换一个完全不同的书名，笔名也要换，禁止沿用。')
            : '注意：书名与笔名必须新颖独特，避免「迷雾之城」「墨影」这类常见套路组合。';
        const userPrompt = '现在随机生成一部小说纲要，题材任意、每次都不同。' + avoidHint +
            '严格只输出上述 JSON，角色 ' + charCount + ' 个、章节 ' + chapterCount + ' 个。';
        try {
            let data = null;
            let lastTitle = '';
            // 小模型常把「新颖独特」理解成堆诗意意象（云影逐月/月影流光），
            // 书名空泛时带着差评重试一次，逼它按命名规则给出具体点题的书名
            for (let attempt = 1; attempt <= 2; attempt++) {
                const retryHint = lastTitle
                    ? ('\n上一次你生成的书名《' + lastTitle + '》因空泛堆砌意象被判不合格，本次必须严格遵守书名命名规则，给出具体点题、有信息量的书名。')
                    : '';
                const raw = await this.callAIAPI(systemPrompt + retryHint, userPrompt, settings, {
                    maxTokens: 3000,
                    onChunk: (delta, full) => this.updateOutlineProgress(full)
                });
                const data0 = this.extractJson(raw);
                if (!data0 || !data0.title || !Array.isArray(data0.characters) || !data0.characters.length ||
                    !Array.isArray(data0.chapters) || !data0.chapters.length) {
                    throw new Error('AI 返回内容不符合要求（需包含角色与章节）');
                }
                if (attempt < 2 && this.isVagueTitle(data0.title)) {
                    lastTitle = data0.title;
                    this.showNotification('书名《' + data0.title + '》太空泛，正在要求 AI 重新命名…', 'info');
                    continue;
                }
                data = this.normalizeOutline(data0, charCount, chapterCount);
                break;
            }
            const txt = this.buildOutlineText(data);
            if (ta) ta.value = txt;
            this.applyOutlineData(data, { replace });
            this.showNotification('已生成大纲：' + charCount + ' 个角色、' + chapterCount + ' 章', 'success');
        } catch (e) {
            this.showNotification('AI 生成失败：' + (e && e.message ? e.message : e), 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '✨ AI 随机填充小说纲要'; }
            this.hideOutlineProgress();
        }
    }

    /** 对 AI/模拟返回的大纲做去重与数量截断，保证角色数、章节数符合设定且不重复 */
    normalizeOutline(data, charCount, chapterCount) {
        if (!data) return null;
        charCount = Math.max(1, parseInt(charCount, 10) || 5);
        chapterCount = Math.max(1, parseInt(chapterCount, 10) || 5);
        const cseen = new Map();
        const characters = [];
        (data.characters || []).forEach(c => {
            const n = (c && c.name ? c.name : '').trim();
            if (!n) return;
            const key = n.toLowerCase();
            if (cseen.has(key)) return;
            cseen.set(key, true);
            characters.push(c);
        });
        data.characters = characters.slice(0, charCount).map(c => {
            const cc = Object.assign({}, c);
            cc.gender = this.mapGender(cc.gender);
            cc.age = cc.age || '';
            cc.occupation = cc.occupation || '';
            const f = this.mapFaction(cc.faction);
            cc.faction = (f === 'protagonist' || f === 'ally' || f === 'neutral' || f === 'antagonist' || f === 'hidden') ? f : 'neutral';
            return cc;
        });
        // 必须恰有 1 个主角：若模型没给，则把第一个角色设为主角
        if (data.characters.length && !data.characters.some(c => c.faction === 'protagonist')) {
            data.characters[0].faction = 'protagonist';
        }
        // 作品简介统一转成字符串（AI 偶尔返回对象/数组）
        if (data.synopsis) data.synopsis = this.toTextValue(data.synopsis);
        // 世界要素统一转成字符串：AI 常返回 [{name:...}] 这类结构，直接拼接会显示成 [object Object]
        if (data.world && typeof data.world === 'object') {
            Object.keys(data.world).forEach(k => { data.world[k] = this.toTextValue(data.world[k]); });
        }
        // 章节标题必须互不相同：AI 常给一批重复标题，此时用该章自己的情节提炼一个不同标题，
        // 既保证唯一，也不会变成「危机四伏2」这种观感上的重复；同时完整保留章节数量
        const usedTitles = new Set();
        const chapters = [];
        (data.chapters || []).forEach(ch => {
            const plot = (ch && ch.plot ? ch.plot : '').trim();
            const rawTitle = (ch && ch.title ? ch.title : '').trim();
            const key = this.normChapterKey(rawTitle);
            if (!key && !plot) return;
            let title = rawTitle;
            if (!key) {
                title = this.deriveTitleFromPlot(plot, '', usedTitles);
            } else if (usedTitles.has(key)) {
                title = this.deriveTitleFromPlot(plot, rawTitle, usedTitles);
            } else {
                usedTitles.add(key);
            }
            chapters.push(Object.assign({}, ch, { title: title }));
        });
        data.chapters = chapters.slice(0, chapterCount).map((ch, i) => Object.assign({}, ch, { number: i + 1 }));
        return data;
    }

    /** 点击「AI 随机填充小说纲要」时弹出大纲设置（角色数 / 章节数） */
    openOutlineSettings() {
        const modal = document.getElementById('outlineSettingsModal');
        if (modal) modal.classList.add('show');
    }

    confirmOutlineSettings() {
        const cc = document.getElementById('outlineCharCount');
        const ch = document.getElementById('outlineChapterCount');
        const rp = document.getElementById('outlineReplace');
        const charCount = cc ? parseInt(cc.value, 10) : 5;
        const chapterCount = ch ? parseInt(ch.value, 10) : 5;
        const replace = rp ? rp.checked : true;
        this.closeModal('outlineSettingsModal');
        this.aiRandomOutline({ charCount, chapterCount, replace });
    }

    showOutlineProgress() {
        const box = document.getElementById('bulkFillProgress');
        const bar = document.getElementById('bulkFillProgressBar');
        if (box) box.style.display = 'block';
        if (bar) { bar.classList.add('indeterminate'); bar.style.width = ''; }
    }

    hideOutlineProgress() {
        const box = document.getElementById('bulkFillProgress');
        if (box) box.style.display = 'none';
    }

    updateOutlineProgress(fullText) {
        const bar = document.getElementById('bulkFillProgressBar');
        if (!bar || typeof fullText !== 'string') return;
        const estTokens = fullText.length / 2.2;
        const pct = Math.max(8, Math.min(98, estTokens / 3000 * 100));
        bar.classList.remove('indeterminate');
        bar.style.width = pct + '%';
    }

    mapGenre(v) {
        const t = (v || '').trim().toLowerCase();
        // 复合类型（如「武侠仙侠 / 悬疑推理（融合）」）无法整串命中，改为按关键词包含关系取第一个题材
        const composite = (str) => {
            const keys = Object.keys(G).sort((a, b) => b.length - a.length);
            for (let i = 0; i < keys.length; i++) {
                if (keys[i].length >= 2 && str.indexOf(keys[i]) > -1) return G[keys[i]];
            }
            return '';
        };
        const G = {
            '玄幻奇幻': 'fantasy', '玄幻': 'fantasy', '奇幻': 'fantasy', 'fantasy': 'fantasy',
            '武侠仙侠': 'wuxia', '武侠': 'wuxia', '仙侠': 'wuxia', 'wuxia': 'wuxia',
            '都市异能': 'urban', '异能': 'urban', 'urban': 'urban',
            '现代都市': 'modern', '都市生活': 'modern', '都市日常': 'modern', '现代': 'modern', 'modern': 'modern',
            '都市': 'urban',
            '科幻未来': 'scifi', '科幻': 'scifi', 'scifi': 'scifi',
            '历史架空': 'history', '历史': 'history', '架空': 'history', 'history': 'history',
            '古代言情': 'romanceAncient', '古言': 'romanceAncient', '宫廷': 'romanceAncient',
            '宫斗': 'romanceAncient', 'ancientromance': 'romanceAncient',
            '民国风云': 'republic', '民国': 'republic', 'republic': 'republic',
            '言情耽美': 'romance', '言情': 'romance', '耽美': 'romance', '爱情': 'romance', 'romance': 'romance',
            '豪门总裁': 'ceo', '总裁': 'ceo', '豪门': 'ceo', 'ceo': 'ceo',
            '校园青春': 'campus', '校园': 'campus', '青春': 'campus', 'campus': 'campus',
            '穿越重生': 'rebirth', '穿越': 'rebirth', '重生': 'rebirth', 'rebirth': 'rebirth',
            '悬疑推理': 'suspense', '悬疑': 'suspense', '推理': 'suspense', 'suspense': 'suspense',
            '军旅谍战': 'military', '军旅': 'military', '谍战': 'military', '军事': 'military', 'military': 'military',
            '灵异恐怖': 'horror', '灵异': 'horror', '恐怖': 'horror', 'horror': 'horror',
            '商战职场': 'business', '商战': 'business', '职场': 'business', 'business': 'business',
            '游戏竞技': 'game', '游戏': 'game', '竞技': 'game', 'game': 'game',
            '二次元同人': 'fanfic', '二次元': 'fanfic', '同人': 'fanfic', '动漫': 'fanfic', 'fanfic': 'fanfic',
            '现实文学': 'literary', '现实主义': 'literary', '纯文学': 'literary', 'literary': 'literary',
            '其他': 'other', '轻小说': 'other', '无限流': 'other', 'other': 'other'
        };
        return G[t] || composite(t) || 'fantasy';
    }

    mapGender(v) {
        const t = (v || '').trim();
        if (t === '女' || t === 'female') return 'female';
        if (t === '男' || t === 'male') return 'male';
        return 'other';
    }

    mapFaction(v) {
        const t = (v || '').trim();
        if (!t) return '';
        if (t === '主角' || t === '主角阵营' || t === 'protagonist') return 'protagonist';
        if (t === '盟友' || t === 'ally') return 'ally';
        if (t === '中立' || t === 'neutral' || t === 'other') return 'neutral';
        if (t.indexOf('反派') > -1 || t.indexOf('敌对') > -1 || t === 'antagonist') return 'antagonist';
        if (t.indexOf('隐藏') > -1 || t === 'hidden') return 'hidden';
        // 复合描述（如「主角盟友（但立场反复）」「中立偏主角（亦师亦父）」）：按关键词包含关系判断
        if (t.indexOf('主角') > -1) return 'protagonist';
        if (t.indexOf('盟友') > -1 || t.indexOf('同伴') > -1 || t.indexOf('伙伴') > -1) return 'ally';
        if (t.indexOf('中立') > -1) return 'neutral';
        return 'neutral';
    }

    parseCnNum(str) {
        str = (str || '').trim();
        if (str === '') return 0;
        if (/^\d+$/.test(str)) return parseInt(str, 10);
        const d = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
        if (d[str] !== undefined) return d[str];
        if (str === '十') return 10;
        const i = str.indexOf('十');
        if (i > -1) {
            const a = str.substring(0, i);
            const b = str.substring(i + 1);
            const tens = a === '' ? 1 : (d[a] || 0);
            const ones = b === '' ? 0 : (d[b] || 0);
            return tens * 10 + ones;
        }
        return 0;
    }

    /**
     * 规范化单行文本，兼容从 Markdown / 其他 AI 直接粘贴的排版：
     *   「**作品名称：**《书名》」「### 角色一：沈舟」「- 性别：男」「> 第一章 泥鳅」「1. 作者：xx」
     * 只做「去装饰」，不改动正文内容。
     */
    normalizeBulkLine(raw) {
        let s = String(raw == null ? '' : raw).replace(/\u3000/g, ' ').trim();
        if (!s) return '';
        // 反复剥离 Markdown 标题井号 / 引用 / 列表符号 / 序号（可能叠加：> ## 3. 标题）
        for (let i = 0; i < 4; i++) {
            const before = s;
            s = s.replace(/^(?:#{1,6}\s*|>\s*|[-*+•]\s+|\d{1,3}\s*[.、)）]\s*|[（(]\s*[\d一二三四五六七八九十]{1,3}\s*[)）]\s*)/, '').trim();
            if (s === before) break;
        }
        // 去掉加粗/斜体标记：**作品名称：**、**作者**、__主题__、*标签*
        if (s.indexOf('*') > -1) s = s.replace(/\*\*/g, '').replace(/^\*+\s*/, '');
        if (s.indexOf('__') > -1) s = s.replace(/(^|[^A-Za-z0-9_])__([^_]+)__/g, '$1$2');
        // 冒号两侧空格归一：作品名称 : 内容 → 作品名称：内容
        s = s.replace(/^([^：:]{1,20}?)\s*[：:]\s*/, '$1：');
        return s.trim();
    }

    /**
     * 预处理：把「AI 把多个字段挤在同一行」的情况拆成多行。
     * 典型输出：**学业能力：**xxx、**特长能力：**yyy、**社交能力：**zzz、**特殊设定：**www
     * 只拆分「加粗字段头」或「已知字段名」紧跟冒号的情况，绝不误伤正文/对话里的冒号。
     * @param {string} text 原始文本
     * @param {Set<string>} knownKeys 已知字段名集合（FIELD_MAP + CHAR_MAP 的键）
     */
    preprocessBulkText(text, knownKeys) {
        let s = String(text == null ? '' : text).replace(/\r\n/g, '\n');
        if (!s) return s;
        // 1) 加粗字段头：**xxx：**（前面是中文顿号/分号/逗号等分隔符）→ 换行拆开
        s = s.replace(/([、；,，])\s*\*\*\s*([^：:*\n]{1,24}?)\s*[：:]\s*\*\*/g, '\n**$2：**');
        // 2) 已知字段名（非加粗）：、学业能力： → 换行 + 学业能力：
        if (knownKeys && knownKeys.size) {
            const alt = Array.from(knownKeys)
                .sort((a, b) => b.length - a.length)
                .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                .join('|');
            if (alt) s = s.replace(new RegExp('([、；])\\s*(' + alt + ')\\s*[：:]', 'g'), '\n$2：');
        }
        return s;
    }

    /**
     * 把 Markdown 表格转成「标题：内容」行，让后续按行解析的流程直接吃。
     * 很多 AI 大纲用表格列角色（「| 角色 | 性别 | 年龄 | 身份 | 阵营 | 一句话特征 |」），
     * 原来的逐行解析看到的是没有冒号的「| ... |」，整张表都会被丢进未识别。
     * 三种情况：
     *   1) 角色表（表头含 角色/姓名/名字）→ 每行转成 角色：姓名 / 性别：… / 年龄：… 等
     *   2) 两列表（| 字段 | 值 |）        → 字段：值
     *   3) 其它多列表                   → 整表并入「设定补充」，作为记忆规则保留
     */
    convertBulkTables(lines) {
        const out = [];
        const isRow = (l) => /^\s*\|.*\|\s*$/.test(String(l || ''));
        const cell = (row) => String(row).replace(/^\s*\|/, '').replace(/\|\s*$/, '')
            .split('|').map(c => c.replace(/\*\*/g, '').replace(/`/g, '').trim());
        for (let i = 0; i < lines.length;) {
            if (!isRow(lines[i])) { out.push(lines[i]); i++; continue; }
            const rows = [];
            while (i < lines.length && isRow(lines[i])) { rows.push(lines[i]); i++; }
            const parsed = rows.map(cell).filter(r => r.some(c => c));
            for (let k = parsed.length - 1; k >= 0; k--) {
                if (parsed[k].every(c => /^:?-{2,}:?$/.test(c) || c === '')) parsed.splice(k, 1);
            }
            if (!parsed.length) continue;
            const header = (parsed[0] || []).map(h => h.replace(/\s/g, ''));
            const isRole = header.some(h => /^(角色|姓名|名字|名称|人物|角色名|人物名)$/.test(h));
            if (isRole) {
                parsed.slice(1).forEach(r => {
                    const push = (k, v) => { if (k && v) out.push(k + '：' + v); };
                    r.forEach((c, idx) => {
                        if (!c) return;
                        const h = header[idx] || '';
                        if (idx === 0) push('角色', c);
                        else if (/性别/.test(h)) push('性别', c);
                        else if (/年龄|年纪/.test(h)) push('年龄', c);
                        else if (/身份|职业|工作/.test(h)) push('身份', c);
                        else if (/阵营|派别|立场/.test(h)) push('阵营', c);
                        else if (/特征|性格|一句话|特点|标签|个性/.test(h)) push('性格', c);
                        else if (/外貌|外形|长相|颜值/.test(h)) push('外貌', c);
                        else if (/能力|技能|天赋/.test(h)) push('能力', c);
                        else if (/背景|经历|出身/.test(h)) push('背景', c);
                        else if (/目标|动机|愿望|诉求/.test(h)) push('目标', c);
                        else if (/弱点|缺点|缺陷/.test(h)) push('弱点', c);
                        else if (/关系/.test(h)) push('关系', c);
                    });
                    out.push('');
                });
            } else if (header.length <= 2) {
                parsed.slice(1).forEach(r => { if (r[0] && r[1]) out.push(r[0] + '：' + r[1]); });
            } else {
                // 先开一个空值字段，下面每一行都会作为它的续行并入「记忆规则」；
                // 若这里直接把表头写成值，pendingField 会被清空，后面的行就全落进未识别了
                out.push('设定补充：');
                out.push(header.filter(Boolean).join('，'));
                parsed.slice(1).forEach(r => out.push(r.filter(Boolean).join('，')));
            }
        }
        return out;
    }

    /** 解析「标题：内容」格式的文本，识别为各小说要素 */
    parseBulkInput(text) {
        const result = { novel: {}, world: {}, memory: {}, characters: [], chapters: [], unmatched: [] };
        const FIELD_MAP = {
            '作品名称': ['novel', 'title'], '书名': ['novel', 'title'], '小说名': ['novel', 'title'], '标题': ['novel', 'title'], '名称': ['novel', 'title'], '题目': ['novel', 'title'],
            '作者': ['novel', 'author'], '笔名': ['novel', 'author'],
            '作品类型': ['novel', 'genre'], '类型': ['novel', 'genre'], '题材': ['novel', 'genre'], '分类': ['novel', 'genre'], 'genre': ['novel', 'genre'],
            '核心主题': ['novel', 'theme'], '主题': ['novel', 'theme'], '中心思想': ['novel', 'theme'], '主旨': ['novel', 'theme'],
            '作品简介': ['novel', 'synopsis'], '简介': ['novel', 'synopsis'], '内容简介': ['novel', 'synopsis'], '作品梗概': ['novel', 'synopsis'], '故事简介': ['novel', 'synopsis'], '故事梗概': ['novel', 'synopsis'], '一句话简介': ['novel', 'synopsis'], '文案': ['novel', 'synopsis'], '核心梗概': ['novel', 'synopsis'], '剧情梗概': ['novel', 'synopsis'], '内容梗概': ['novel', 'synopsis'], '故事主线': ['novel', 'synopsis'], '主线': ['novel', 'synopsis'],
            '字数目标': ['novel', 'wordGoal'], '字数': ['novel', 'wordGoal'], '目标字数': ['novel', 'wordGoal'],
            '时代背景': ['world', 'era'], '时代': ['world', 'era'], '背景设定': ['world', 'era'], '时间背景': ['world', 'era'],
            '社会结构': ['world', 'society'], '社会': ['world', 'society'], '阶层': ['world', 'society'],
            '科技': ['world', 'tech'], '科技水平': ['world', 'tech'], '修炼体系': ['world', 'tech'], '修炼': ['world', 'tech'],
            '地理': ['world', 'geography'], '地图': ['world', 'geography'], '地理设定': ['world', 'geography'],
            '势力': ['world', 'factions'], '势力分布': ['world', 'factions'], '门派': ['world', 'factions'],
            '力量体系': ['world', 'power'], '力量等级': ['world', 'power'], '等级': ['world', 'power'], '武力': ['world', 'power'],
            '规则': ['world', 'rules'], '世界规则': ['world', 'rules'], '特殊规则': ['world', 'rules'],
            '宗教': ['world', 'religion'], '信仰': ['world', 'religion'],
            '习俗': ['world', 'customs'], '风俗': ['world', 'customs'], '礼仪': ['world', 'customs'],
            '语言': ['world', 'language'], '文字': ['world', 'language'],
            '记忆规则': ['memory', 'rules'], '牢记': ['memory', 'rules'], '设定补充': ['memory', 'rules'], '补充说明': ['memory', 'rules'],
            '写作提示': ['memory', 'rules'], '创作提示': ['memory', 'rules'], '写作要求': ['memory', 'rules'],
            '题目说明': ['memory', 'rules'], '题目释义': ['memory', 'rules'], '命名说明': ['memory', 'rules'],
            '全文收束意象': ['memory', 'rules'], '收束意象': ['memory', 'rules'], '全文收束': ['memory', 'rules'],
            '梗概': ['memory', 'rules'], '大纲': ['memory', 'rules'],
            // 其他 AI 常写的收尾说明，统一收进「记忆规则」，避免落进未识别列表
            '全书主题呼应': ['memory', 'rules'], '主题呼应': ['memory', 'rules'], '结尾呼应': ['memory', 'rules'],
            '核心冲突': ['memory', 'rules'], '创作说明': ['memory', 'rules'], '备注': ['memory', 'rules'], '说明': ['memory', 'rules'],
            // 校园 / 现代题材常见设定（此前整段会被判为「未识别」）。
            // 各字段落到互不相同的世界观槽位，避免互相覆盖；与通用标签（时代背景/社会结构…）同槽时由
            // setField 做追加合并，不会丢内容。
            '学业能力': ['world', 'tech'], '学业': ['world', 'tech'], '学业体系': ['world', 'tech'], '成绩': ['world', 'tech'], '成绩体系': ['world', 'tech'],
            '特长能力': ['world', 'power'], '特长': ['world', 'power'],
            '社交能力': ['world', 'customs'], '社交': ['world', 'customs'], '人缘': ['world', 'customs'],
            '班级': ['world', 'society'], '班级设定': ['world', 'society'], '社团': ['world', 'society'],
            '特殊设定': ['world', 'rules'], '特殊规则': ['world', 'rules'], '校园设定': ['world', 'rules'], '学校设定': ['world', 'rules'],
            '校园传说': ['world', 'rules'], '传说': ['world', 'rules'],
            '校园': ['world', 'era'], '校园背景': ['world', 'era'], '学校': ['world', 'era'], '故事舞台': ['world', 'era'],
            '主要场景': ['world', 'era'], '场景设定': ['world', 'era'], '地点': ['world', 'era']
        };
        // 章节正文标签：出现在章节里时并入该章正文（此前会被当成「未识别」，导致整章梗概丢失）
        const CHAPTER_LABELS = /^(本章|本章的)?(情节梗概|剧情梗概|故事梗概|内容梗概|梗概|情节|剧情|大纲|内容|正文|摘要|本章内容|本章情节|本章悬念|悬念|转折|伏笔|看点|结尾|收尾)$/;
        // 纯小节标题（无冒号）：直接跳过，不计入未识别
        const SECTION_ONLY = /^(?:[一二三四五六七八九十0-9]+个)?(?:角色设定|人物设定|人物介绍|角色介绍|角色信息|人物信息|主要角色|角色列表|角色速览|作品信息|小说要素|小说要素设定|要素设定|小说设定|作品设定|世界观设定|世界设定|小说信息|基本信息|设定集|设定|世界观|故事定位|章节概要|章节大纲|章节列表|正文情节大纲|情节大纲|全书概要|故事概要|故事梗概|目录|角色|人物|小说大纲|全书设定|写作提示|关键情感节点分布|关键情感节点|正文情节|收尾)(?:清单|一览|列表|表|汇总)?(?:（[^）]*）|\([^)]*\))?$/;
        const CHAR_MAP = {
            '姓名': 'name', '名字': 'name', '角色名': 'name', '人物名': 'name', '全名': 'name',
            '别名': 'alias', '称号': 'alias', '别名/称号': 'alias', '别名称号': 'alias',
            '昵称': 'alias', '外号': 'alias',
            '性别': 'gender', '年龄': 'age', '年纪': 'age',
            '职业': 'occupation', '身份': 'occupation', '工作': 'occupation',
            '身份/职业': 'occupation', '身份职业': 'occupation',
            '阵营': 'faction', '派别': 'faction', '立场': 'faction',
            '外貌': 'appearance', '长相': 'appearance', '样貌': 'appearance', '外形': 'appearance',
            '外貌特征': 'appearance',
            '性格': 'personality', '性格特点': 'personality',
            '背景': 'background', '经历': 'background', '来历': 'background', '背景故事': 'background',
            '能力': 'abilities', '技能': 'abilities', '绝技': 'abilities',
            '能力/技能': 'abilities', '能力技能': 'abilities',
            '目标': 'goals', '追求': 'goals', '理想': 'goals',
            '目标/愿望': 'goals', '目标愿望': 'goals', '愿望': 'goals',
            '弱点': 'weaknesses', '缺陷': 'weaknesses', '破绽': 'weaknesses',
            '弱点/缺陷': 'weaknesses', '弱点缺陷': 'weaknesses',
            '标签': 'tags', 'tag': 'tags', '角色标签': 'tags'
        };
        // 角色块起始标签：必须是「角色 / 角色五 / 人物设定 / 主角 / 反派」这类纯标题，
        // 不能再把「角色标签：…」当成新角色起头（此前一个角色会被切成四五个）
        const CHAR_START = /^(?:主要)?(?:角色|人物)(?:[一二三四五六七八九十百\d]*)?(?:设定|信息|列表|清单|一览|档案)?$|^(?:主角|配角|反派|龙套|路人甲?)$/;
        // 已知标签集合：用于判断「xx：yy」里的 xx 是字段名还是人名
        const KNOWN_LABELS = new Set(Object.keys(FIELD_MAP).concat(Object.keys(CHAR_MAP)));

        const setField = (g, k, v) => {
            if (g === 'novel') {
                if (k === 'wordGoal') {
                    // 兼容「350,000」「350000 字」「35万字」等写法
                    const cleaned = String(v).replace(/[^\d.万wWkK]/g, '');
                    let n = parseFloat(cleaned.replace(/万/g, ''));
                    if (cleaned.indexOf('万') > -1) n *= 10000;
                    else if (/[wW]/.test(cleaned)) n *= 10000;
                    else if (/[kK]/.test(cleaned)) n *= 1000;
                    if (!isNaN(n) && n > 0) result.novel.wordGoal = Math.round(n);
                } else if (k === 'genre') {
                    result.novel.genre = this.mapGenre(v);
                } else if (k === 'title') {
                    // 去掉书名外层装饰符号：《暗河行舟》→ 暗河行舟
                    result.novel.title = String(v).replace(/^[《【\[（(「“‘"'\s]+/, '').replace(/[》】\]）)」”’"'\s]+$/, '');
                } else if (k === 'synopsis') {
                    // 多段简介追加而非覆盖
                    const prev = result.novel.synopsis;
                    result.novel.synopsis = (prev && prev !== v)
                        ? String(prev).replace(/\s+$/, '') + '\n' + v
                        : v;
                } else {
                    result.novel[k] = v;
                }
            } else if (g === 'world') {
                // 同一槽位被不同标签填写时追加而非覆盖：
                // 例如「时代背景」和「校园」都落到 era，覆盖会让其中一个凭空消失
                const prev = result.world[k];
                result.world[k] = (prev && prev !== v)
                    ? String(prev).replace(/[；;、，,]\s*$/, '') + '；' + v
                    : v;
            } else if (g === 'memory') {
                // 简介/梗概/全书主题呼应等都汇到 memory.rules，同样做追加，避免互相顶掉
                const prev = result.memory[k];
                result.memory[k] = (prev && prev !== v)
                    ? String(prev).replace(/\s+$/, '') + '\n' + v
                    : v;
            }
        };
        const setCharField = (sub, v) => {
            if (sub === 'gender') v = this.mapGender(v);
            else if (sub === 'faction') v = this.mapFaction(v);
            else if (sub === 'tags') v = v.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
            currentChar[sub] = v;
        };

        // 先把 Markdown 表格转成「标题：内容」行（角色表 / 两列表 / 说明表），
        // 否则整张表都是没有冒号的 "| ... |"，会被整表丢进未识别
        const lines = this.convertBulkTables(
            this.preprocessBulkText(text, new Set(Object.keys(FIELD_MAP).concat(Object.keys(CHAR_MAP)))).split('\n'));
        // 大纲若用「场景一/二/三」再细分，「第N幕」就只当分节标题，避免两种层级各生成一章
        const hasSceneHead = /^\s*(?:#{1,6}\s*|\*\*\s*)*场景\s*[0-9零一二三四五六七八九十百]+\s*[：:]/m.test(text);
        let current = 'none';
        let pendingField = null;
        let currentChar = null;
        let lastCharField = null;
        let currentChapter = null;
        let autoCharIdx = 0;
        // 角色块收尾：有字段但漏写姓名时自动补一个名字，避免整段角色信息被丢弃
        const flushChar = () => {
            if (!currentChar) return;
            // 清掉多行字段首尾的空行（列表块结束后常留下空行）
            Object.keys(currentChar).forEach(k => {
                if (typeof currentChar[k] === 'string') currentChar[k] = currentChar[k].replace(/^\s+|\s+$/g, '');
            });
            const hasField = Object.keys(currentChar).some(k =>
                k !== 'name' && currentChar[k] !== undefined && currentChar[k] !== null && currentChar[k] !== '');
            if (!currentChar.name && hasField) currentChar.name = '未命名角色' + (++autoCharIdx);
            if (currentChar.name) result.characters.push(currentChar);
            currentChar = null;
        };
        const flushChapter = () => {
            if (!currentChapter) return;
            // 清掉「### 第一章 | ** 标题 **」这类写法残留在标题里的竖线和空白
            if (currentChapter.title) {
                currentChapter.title = currentChapter.title.replace(/^[|｜\s]+/, '').replace(/\s+$/, '').trim()
                    || '未命名章节';
            }
            result.chapters.push(currentChapter);
        };
        const flushPending = () => { if (pendingField && pendingField.buf && pendingField.buf.trim()) { setField(pendingField.g, pendingField.k, pendingField.buf.trim()); pendingField = null; } };
        const endContext = () => { flushPending(); flushChar(); flushChapter(); };

        for (let i = 0; i < lines.length; i++) {
            const rawLine = lines[i] || '';
            const line = this.normalizeBulkLine(rawLine);
            // 原行是否为列表项 / 多级标题 / 缩进：用于判断「xx：yy」是字段还是字段里的续行
            const isBullet = /^\s*(?:[-*+•]\s+|\d{1,3}\s*[.、)）]|[（(]\s*[\d一二三四五六七八九十]{1,3}\s*[)）]|#{1,6}\s)/.test(rawLine);
            const isIndented = /^\s{2,}\S/.test(rawLine);
            if (/^[-=_*~—·\s]{3,}$/.test(line)) continue; // 分隔线 --- === ***
            if (line === '') {
                if (current === 'field' && pendingField) pendingField.buf += '\n';
                else if (current === 'char' && lastCharField) currentChar[lastCharField] = (currentChar[lastCharField] || '') + '\n';
                else if (current === 'chapter' && currentChapter) currentChapter.content += '\n';
                continue;
            }
            const colon = line.match(/^(.+?)[：:](.*)$/);
            if (colon) {
                const key = colon[1].trim();
                const val = colon[2].trim();
                if (key === '章节' || key === '章' || key === '章节标题' || key === '本章标题') {
                    endContext();
                    currentChapter = { number: 0, title: val || '未命名章节', content: '' };
                    current = 'chapter'; currentChar = null; pendingField = null; lastCharField = null;
                    continue;
                }
                // 「场景一：看房」：现代都市/短篇大纲常用「幕/场景」而不是「章」，同样当章节起点
                const sceneKey = key.match(/^场景\s*([0-9零一二三四五六七八九十百]+)$/);
                if (sceneKey) {
                    endContext();
                    currentChapter = {
                        number: this.parseCnNum(sceneKey[1]) || 0,
                        title: String(val || '').trim().replace(/（.*?）|\(.*?\)/g, '').trim() || ('场景' + sceneKey[1]),
                        content: ''
                    };
                    current = 'chapter'; currentChar = null; pendingField = null; lastCharField = null;
                    continue;
                }
                // 「第一幕：搬进来就后悔了」：已有更细的「场景N」时只当分节，否则当章节
                const actKey = key.match(/^第\s*([0-9零一二三四五六七八九十百]+)\s*幕$/);
                if (actKey) {
                    endContext();
                    // 必须把 currentChapter 置空：否则下一次 endContext() 会把刚 flush 的同一章再推进 chapters，出现重复章节
                    current = 'none'; currentChar = null; currentChapter = null; pendingField = null; lastCharField = null;
                    if (!hasSceneHead) {
                        currentChapter = {
                            number: this.parseCnNum(actKey[1]) || 0,
                            title: String(val || '').trim().replace(/（.*?）|\(.*?\)/g, '').trim() || ('第' + actKey[1] + '幕'),
                            content: ''
                        };
                        current = 'chapter';
                    }
                    continue;
                }
                if (CHAR_START.test(key)) {
                    endContext();
                    currentChar = { name: val || '' };
                    current = 'char'; currentChapter = null; pendingField = null; lastCharField = null;
                    continue;
                }
                // 一行一个角色：「林知夏：女，17岁，广播站成员，性格安静敏感」
                if (!currentChapter) {
                    const inlineChar = this.tryParseInlineCharacter(key, val, KNOWN_LABELS);
                    if (inlineChar) {
                        endContext();
                        currentChar = inlineChar;
                        current = 'char'; currentChapter = null; pendingField = null; lastCharField = null;
                        continue;
                    }
                }
                // 「本章情节梗概：」「本章悬念：」等：并入当前章节正文，避免整段梗概被丢弃
                if (currentChapter && CHAPTER_LABELS.test(key)) {
                    current = 'chapter'; pendingField = null; currentChar = null; lastCharField = null;
                    if (val) currentChapter.content += (currentChapter.content ? '\n' : '') + val;
                    continue;
                }
                const fm = FIELD_MAP[key];
                if (fm) {
                    endContext();
                    if (val !== '') { setField(fm[0], fm[1], val); pendingField = null; }
                    else pendingField = { g: fm[0], k: fm[1], buf: '' };
                    current = 'field'; currentChar = null; currentChapter = null;
                    continue;
                }
                // 角色字段（年龄/性别/性格/外貌…）出现时，若前面没有「角色：姓名」标题，
                // 自动补一个角色块——很多 AI 输出会漏掉这一行，此前整段都会被判为"未识别"
                if (!currentChar && CHAR_MAP[key]) {
                    currentChar = { name: '' };
                    current = 'char'; currentChapter = null; pendingField = null; lastCharField = null;
                }
                if (currentChar && CHAR_MAP[key]) {
                    const sub = CHAR_MAP[key];
                    if (val !== '') { setCharField(sub, val); lastCharField = null; }
                    else lastCharField = sub;
                    current = 'char';
                    continue;
                }
                // 没见过的「xx：yy」按上下文兜底，避免整段内容被丢进未识别：
                // ① 在「字段」里且原行是列表项/缩进 → 当成该字段的续行（如 社会结构 下的「- 庙堂：…」）
                // ② 在「角色」里且原行是列表项/缩进 → 当成该角色字段的续行（如 能力 下的「- 心印·逆读：…」）
                // ③ 在「章节」里 → 当成正文（正文本身就有「他说：…」这类冒号）
                if (current === 'field' && pendingField && (isBullet || isIndented)) {
                    pendingField.buf += (pendingField.buf ? '\n' : '') + line;
                    continue;
                }
                if (current === 'char' && currentChar && lastCharField && (isBullet || isIndented)) {
                    currentChar[lastCharField] = (currentChar[lastCharField] ? currentChar[lastCharField] + '\n' : '') + line;
                    continue;
                }
                if (current === 'chapter' && currentChapter) {
                    // 已知标签上面都已处理过，剩下的都是正文本身（正文里常有「他说：…」这类冒号）
                    currentChapter.content += (currentChapter.content ? '\n' : '') + line;
                    continue;
                }
                // 没见过的「xx：yy」：正在写角色时绝不切断角色块——
                // 整行并入上一个人物字段（没有则进背景），只记一条未识别提示
                if (current === 'char' && currentChar) {
                    const target = lastCharField || 'background';
                    currentChar[target] = (currentChar[target] ? currentChar[target] + '\n' : '') + line;
                    result.unmatched.push(key + (val ? '：' + val : ''));
                    continue;
                }
                endContext();
                result.unmatched.push(key + (val ? '：' + val : ''));
                current = 'none'; pendingField = null; currentChar = null; currentChapter = null;
                continue;
            }
            // 「场景一：看房」也当作章节起点——现代都市/短篇大纲常用「幕/场景」而不是「章」
            const scene = line.match(/^场景\s*([0-9零一二三四五六七八九十百]+)\s*[：:]\s*(.*)$/);
            if (scene) {
                endContext();
                currentChapter = {
                    number: this.parseCnNum(scene[1]) || 0,
                    title: (scene[2] || '').trim().replace(/（.*?）|\(.*?\)/g, '').trim() || ('场景' + scene[1]),
                    content: ''
                };
                current = 'chapter'; currentChar = null; pendingField = null; lastCharField = null;
                continue;
            }
            // 「第一幕：搬进来就后悔了」：没有更细的「场景N」时当章节，否则只当分节标题
            const act = line.match(/^第\s*([0-9零一二三四五六七八九十百]+)\s*幕\s*[：:]\s*(.*)$/);
            if (act) {
                endContext();
                current = 'none'; currentChar = null; currentChapter = null; pendingField = null; lastCharField = null;
                if (!hasSceneHead) {
                    currentChapter = {
                        number: this.parseCnNum(act[1]) || 0,
                        title: (act[2] || '').trim().replace(/（.*?）|\(.*?\)/g, '').trim() || ('第' + act[1] + '幕'),
                        content: ''
                    };
                    current = 'chapter';
                }
                continue;
            }
            const chap = line.match(/^第\s*([0-9零一二三四五六七八九十百千万]+)\s*章\s*(.*)$/);
            if (chap) {
                const chapNum = this.parseCnNum(chap[1]);
                if (current === 'chapter' && currentChapter && chapNum <= currentChapter.number) {
                    currentChapter.content += (currentChapter.content ? '\n' : '') + line;
                    continue;
                }
                endContext();
                currentChapter = { number: chapNum, title: chap[2].trim() || '未命名章节', content: '' };
                current = 'chapter'; currentChar = null; pendingField = null; lastCharField = null;
                continue;
            }
            // 文档大标题里直接带书名（「# 《月租一千八》正文情节大纲」）：顺手取书名，不计未识别
            if (current === 'none' && !result.novel.title) {
                const bt = line.match(/^《([^》]{1,30})》/);
                if (bt) { result.novel.title = bt[1].trim(); continue; }
            }
            // 「五、写作提示」这类带序号前缀的小节名：先剥掉序号拿到本名，再判断
            const secBare = line.replace(/^[一二三四五六七八九十0-9]+\s*个?\s*[、.．]\s*/, '');
            const numSec = secBare !== line ? secBare : null;
            if (numSec && current !== 'chapter' && FIELD_MAP[numSec] && numSec !== '标题') {
                const fm2 = FIELD_MAP[numSec];
                pendingField = { g: fm2[0], k: fm2[1], buf: '' };
                current = 'field'; currentChar = null; currentChapter = null; lastCharField = null;
                continue;
            }
            // 纯小节标题（「## 角色设定」「章节概要」等）：只切换上下文，不计入未识别
            if (SECTION_ONLY.test(line) || (numSec && SECTION_ONLY.test(numSec))) {
                endContext();
                current = 'none'; pendingField = null; currentChar = null; currentChapter = null;
                continue;
            }
            // 无冒号的「文档标题」行（如「小说要素设定」「本书设定」）：当前没有上下文时按小节标题跳过。
            // 否则它会作为「未识别」项出现在结果里，导致「要素明明已解析成功，却仍提示未识别」的困惑。
            if (current === 'none' && line.length <= 16 && !/[。！？…，,；;、：:【】《》（）()]/.test(line)) {
                continue;
            }
            if (current === 'field' && pendingField) pendingField.buf += (pendingField.buf ? '\n' : '') + line;
            else if (current === 'char' && lastCharField) currentChar[lastCharField] = (currentChar[lastCharField] ? currentChar[lastCharField] + '\n' : '') + line;
            else if (current === 'chapter' && currentChapter) currentChapter.content += (currentChapter.content ? '\n' : '') + line;
            else result.unmatched.push(line);
        }
        endContext();
        return result;
    }

    applyBulkInput(opts) {
        opts = opts || {};
        const ta = document.getElementById('bulkFillText');
        if (!ta) return;
        const result = this.parseBulkInput(ta.value);
        if (!result.novel.title && !result.novel.author && !result.novel.theme && !result.novel.synopsis &&
            !Object.keys(result.world).length && !result.memory.rules &&
            !result.characters.length && !result.chapters.length) {
            this.showNotification('没有识别到可填充的要素，请检查格式是否为「标题：内容」', 'warning');
            return;
        }
        if (opts.replace) {
            this.work.characters = [];
            this.work.chapters = [];
        }
        if (result.novel && Object.keys(result.novel).length) Object.assign(this.work.novel, result.novel);
        const wkeys = Object.keys(result.world);
        for (let i = 0; i < wkeys.length; i++) {
            const v = result.world[wkeys[i]];
            if (v !== undefined && v !== '') this.work.world[wkeys[i]] = v;
        }
        if (result.memory.rules) this.work.memory.rules = result.memory.rules;
        result.characters.forEach((c) => {
            if (!c.name) return;
            const exist = this.work.characters.find((x) => x.name === c.name);
            if (exist) {
                Object.keys(c).forEach((k) => {
                    if (k !== 'name' && c[k] !== undefined && c[k] !== null && c[k] !== '') exist[k] = c[k];
                });
            } else {
                // 过滤 undefined，避免 Object.assign 把默认阵营/性别覆盖成 undefined
                const clean = {};
                Object.keys(c).forEach((k) => {
                    if (c[k] !== undefined && c[k] !== null && c[k] !== '') clean[k] = c[k];
                });
                this.work.characters.push(Object.assign({
                    id: 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
                    createdAt: Date.now()
                }, clean));
            }
        });
        let nextNum = this.work.chapters.reduce((m, ch) => Math.max(m, ch.number || 0), 0);
        const usedTitles = new Set(this.work.chapters.map(c => this.normChapterKey(c.title)));
        const seenContent = new Set(this.work.chapters.map(c => this.normChapterKey(c.content)).filter(Boolean));
        let dropped = 0;
        let renamed = 0;
        result.chapters.forEach((ch) => {
            const content = ch.content || '';
            const ck = this.normChapterKey(content);
            // 正文完全相同的章节视为纯重复，直接丢弃（AI 常把同一章输出好几遍）
            if (ck && seenContent.has(ck)) { dropped++; return; }
            if (ck) seenContent.add(ck);
            // 同名章节：用该章自己的正文提炼一个不同标题，而不是加 2/3
            // 清洗「### 第一章 | ** 标题 **」这种写法残留在标题里的竖线
            const rawTitle = (ch.title || '').replace(/^[|｜\s]+/, '').trim() || '未命名章节';
            let title = rawTitle;
            if (usedTitles.has(this.normChapterKey(rawTitle))) {
                title = this.deriveTitleFromPlot(content, rawTitle, usedTitles);
                renamed++;
            } else {
                usedTitles.add(this.normChapterKey(rawTitle));
            }
            this.work.chapters.push({
                id: 'ch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                number: ++nextNum,
                title: title,
                content: content,
                summary: '',
                characters: [],
                createdAt: Date.now(),
                updatedAt: Date.now(),
                polishedAt: 0
            });
        });
        // 统一重排章节号：解析出的序号可能重复（如出现多个「第2章」），这里按顺序改成 1,2,3…
        this.work.chapters.sort((a, b) => (a.number || 0) - (b.number || 0));
        this.work.chapters.forEach((c, i) => { c.number = i + 1; });
        const notes = [];
        if (dropped) notes.push('丢弃 ' + dropped + ' 个正文完全重复的章节');
        if (renamed) notes.push(renamed + ' 个同名章节已按内容重新命名');
        if (notes.length) this.showNotification(notes.join('，'), 'warning');
        this.renderAll();
        this.saveData();
        const parts = [];
        const nKeys = Object.keys(result.novel).length;
        if (nKeys) parts.push('作品信息 ' + nKeys + ' 项');
        const wn = Object.keys(result.world).length;
        if (wn) parts.push('世界观 ' + wn + ' 项');
        if (result.memory.rules) parts.push('记忆规则 1 项');
        if (result.characters.length) parts.push('角色 ' + result.characters.length + ' 个');
        if (result.chapters.length) parts.push('章节 ' + result.chapters.length + ' 章');
        const msg = parts.length ? ('已填入：' + parts.join('、') + (result.unmatched.length ? '；未识别 ' + result.unmatched.length + ' 项' : '')) : '未识别到要素';
        this.showNotification(msg, result.unmatched.length && !parts.length ? 'warning' : 'success');
        const rp = document.getElementById('bulkFillResult');
        if (rp) {
            rp.style.display = 'block';
            let html = parts.length ? ('<div class="bulk-ok">✅ ' + this.escapeHtml(parts.join('、')) + '</div>') : '<div class="bulk-warn">⚠️ 未识别到任何要素</div>';
            if (result.unmatched.length) html += '<div class="bulk-warn">⚠️ 未识别（' + this.escapeHtml(result.unmatched.slice(0, 10).join('、')) + (result.unmatched.length > 10 ? '…' : '') + '）</div>';
            else html += '<div class="bulk-ok">所有要素均已识别并填入</div>';
            rp.innerHTML = html;
        }
    }

    /** 将结构化的 AI/模拟大纲直接写入当前作品（用于一键生成，避免经文本解析造成的重复/丢字段） */
    applyOutlineData(data, opts) {
        opts = opts || {};
        if (opts.replace) {
            this.work.characters = [];
            this.work.chapters = [];
        }
        const normKey = s => (s || '').trim().toLowerCase().replace(/[\s·、，。,.!！?？:：;；\-—_()（）\[\]【】「」『』"']/g, '');
        if (data && data.novel) {
            const n = {};
            if (data.title) n.title = this.uniqueWorkTitle(data.title);
            if (data.author) n.author = data.author;
            if (data.genre) n.genre = this.mapGenre(data.genre);
            if (data.synopsis) n.synopsis = data.synopsis;
            if (data.theme) n.theme = data.theme;
            if (data.wordGoal) n.wordGoal = data.wordGoal;
            Object.assign(this.work.novel, n);
        }
        if (data && data.world) Object.assign(this.work.world, data.world);
        const existingNames = new Set(this.work.characters.map(c => normKey(c.name)));
        (data && data.characters || []).forEach(c => {
            if (!c || !c.name) return;
            const nkey = normKey(c.name);
            // 追加模式下跳过与已有角色同名的重复角色
            if (opts.replace !== true && nkey && existingNames.has(nkey)) return;
            if (nkey) existingNames.add(nkey);
            this.work.characters.push(Object.assign({
                id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                createdAt: Date.now()
            }, c));
        });
        const usedTitles = new Set(this.work.chapters.map(c => this.normChapterKey(c.title)));
        let nextNum = this.work.chapters.reduce((m, c) => Math.max(m, c.number || 0), 0) + 1;
        let renamed = 0;
        let skipped = 0;
        (data && data.chapters || []).forEach((ch) => {
            const rawTitle = (ch && ch.title) || '未命名章节';
            const tkey = this.normChapterKey(rawTitle);
            if (!tkey) return;
            // 追加模式下跳过与已有章节同名的章节（延续原行为）
            if (opts.replace !== true && usedTitles.has(tkey)) { skipped++; return; }
            // 无论追加还是替换，都保证书名内章节标题唯一：重复的用该章情节提炼一个不同标题
            let title = rawTitle;
            if (usedTitles.has(tkey)) {
                title = this.deriveTitleFromPlot((ch && (ch.plot || ch.content)) || '', rawTitle, usedTitles);
                renamed++;
            } else usedTitles.add(tkey);
            this.work.chapters.push({
                id: 'ch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                number: nextNum++,
                title: title,
                content: (ch && (ch.plot || ch.content)) || '',
                summary: '',
                characters: [],
                createdAt: Date.now(),
                updatedAt: Date.now(),
                polishedAt: 0
            });
        });
        const notes = [];
        if (renamed) notes.push(renamed + ' 个重复章节标题已自动区分命名');
        if (skipped) notes.push(skipped + ' 个与已有章节同名的章节已跳过');
        if (notes.length) this.showNotification(notes.join('，'), 'warning');
        this.renderAll();
        this.saveData();
    }

    /** 从工作台一键继续上次写作 */
    resumeWriting() {
        if (this.work.chapters.length === 0) {
            this.showNotification('还没有章节，先去新建一章吧', 'info');
            return;
        }
        const sorted = [...this.work.chapters].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        this.switchTab('chapters');
        this.loadChapter(sorted[0].id);
        this.showNotification('已打开最近编辑：第' + sorted[0].number + '章《' + sorted[0].title + '》', 'info');
    }

    renderActivities() {
        const list = document.getElementById('activityList');
        if (!list) return;
        if (this.work.activities.length === 0) {
            list.innerHTML = '<p class="empty-state">暂无活动记录</p>';
            return;
        }
        list.innerHTML = this.work.activities.slice(0, 10).map(a => {
            return '<div class="activity-item">' +
                '<div>' + this.escapeHtml(a.action) + ' ' + this.escapeHtml(a.detail) + '</div>' +
                '<div class="activity-time">' + this.formatTime(a.time) + '</div>' +
            '</div>';
        }).join('');
    }

    getTotalWordCount() {
        return this.work.chapters.reduce(function(sum, ch) {
            return sum + (ch.content ? ch.content.length : 0);
        }, 0);
    }

    // ============ 角色管理 ============

    openCharacterModal(character) {
        this.currentCharacter = character || null;
        const modal = document.getElementById('characterModal');
        if (!modal) return;
        if (character) {
            this.setValue('charName', character.name || '');
            this.setValue('charAlias', character.alias || '');
            this.setValue('charGender', character.gender || 'male');
            this.setValue('charAge', character.age || '');
            this.setValue('charOccupation', character.occupation || '');
            this.setValue('charFaction', character.faction || 'protagonist');
            this.setValue('charAppearance', character.appearance || '');
            this.setValue('charPersonality', character.personality || '');
            this.setValue('charBackground', character.background || '');
            this.setValue('charAbilities', character.abilities || '');
            this.setValue('charGoals', character.goals || '');
            this.setValue('charWeaknesses', character.weaknesses || '');
            this.setValue('charTags', (character.tags || []).join(', '));
            this.renderRelations(character.relations || []);
        } else {
            this.clearCharacterForm();
        }
        modal.classList.add('show');
    }

    setValue(id, value) {
        const el = document.getElementById(id);
        if (el) el.value = value;
    }

    /* ============ 角色一键导入 ============ */

    /**
     * 一键导入模板：只给「标签：」，不带任何示例内容，
     * 用户复制后直接在冒号后面写自己的设定即可。
     */
    fillCharImportTemplate() {
        const ta = document.getElementById('charImportText');
        if (!ta) return;
        ta.value = [
            '姓名：',
            '别名/称号：',
            '性别：',
            '年龄：',
            '身份/职业：',
            '阵营：',
            '外貌特征：',
            '性格特点：',
            '背景故事：',
            '能力/技能：',
            '目标/愿望：',
            '弱点/缺陷：',
            '角色标签：'
        ].join('\n');
        const st = document.getElementById('charImportStatus');
        if (st) st.textContent = '已填入空白模板，直接在冒号后写内容，再点「⚡ 解析并填入」。';
    }

    /** 解析规则：按关键字匹配表单字段；写在前面的关键字更长、优先命中 */
    charImportRules() {
        return [
            { field: 'name', keys: ['姓名', '名字', '角色名', '名称', '角色'] },
            { field: 'alias', keys: ['别名/称号', '别名称号', '别名', '称号', '昵称', '外号'] },
            { field: 'age', keys: ['年龄', '年纪'] },
            { field: 'gender', keys: ['性别'] },
            { field: 'occupation', keys: ['身份/职业', '身份职业', '身份', '职业', '工作'] },
            { field: 'faction', keys: ['阵营', '派别', '立场'] },
            { field: 'appearance', keys: ['外貌特征', '外貌', '长相', '样貌', '外形'] },
            { field: 'personality', keys: ['性格特点', '性格'] },
            { field: 'background', keys: ['背景故事', '背景', '经历', '来历'] },
            { field: 'abilities', keys: ['能力/技能', '能力技能', '能力', '技能', '绝技'] },
            { field: 'goals', keys: ['目标/愿望', '目标愿望', '目标', '愿望', '理想'] },
            { field: 'weaknesses', keys: ['弱点/缺陷', '弱点缺陷', '弱点', '缺陷'] },
            { field: 'tags', keys: ['角色标签', '标签'] }
        ];
    }

    /** 解析「标签：内容」文本为角色字段；返回 {fields, unmatched} */
    parseCharacterImport(text) {
        const src = String(text || '');
        const pairs = [];
        this.charImportRules().forEach(r => r.keys.forEach(k => pairs.push({ field: r.field, key: k })));
        // 长关键字优先，避免「身份」抢先于「身份/职业」
        pairs.sort((a, b) => b.key.length - a.key.length);
        const fields = {};
        const unmatched = [];
        src.split('\n').forEach(raw => {
            let line = String(raw || '').trim();
            if (!line) return;
            line = line.replace(/^[-•·*]\s*/, '').replace(/^\d+\s*[.、)）]\s*/, '');
            const m = line.match(/^([^：:]{1,12})\s*[：:]\s*(.+)$/);
            if (!m) { if (line.length > 1) unmatched.push(line); return; }
            const label = m[1].trim();
            let value = m[2].trim().replace(/^[《【\[（(「]\s*/, '').replace(/\s*[》】\]）)」]$/, '');
            // 只剥最外层成对的引号（整串只有一对时才剥），
            // 否则 "许老师"、"美院许教授" 两端的引号会被误吃
            if (value.length > 2) {
                const q = value[0];
                const close = q === '\u201c' ? '\u201d' : q;
                if ((q === '"' || q === '\u201c' || q === "'") && value[value.length - 1] === close) {
                    const cnt = value.split(q).length - 1;
                    if (cnt === 2) value = value.slice(1, -1);
                }
            }
            if (!value) return;
            const hit = pairs.find(p => label === p.key) || pairs.find(p => label.indexOf(p.key) >= 0);
            if (!hit) { unmatched.push(line); return; }
            if (hit.field === 'gender') { fields.gender = this.mapGender(value); return; }
            if (hit.field === 'faction') { fields.faction = this.mapFaction(value); return; }
            const single = ['name', 'alias', 'age', 'occupation'].indexOf(hit.field) >= 0;
            if (single || !fields[hit.field]) fields[hit.field] = value;
            else fields[hit.field] = fields[hit.field] + '；' + value;
        });
        return { fields: fields, unmatched: unmatched };
    }

    /** 角色导入用到的全部标签集合 */
    characterImportLabels() {
        if (this._charImportLabels) return this._charImportLabels;
        const keys = [];
        this.charImportRules().forEach(r => r.keys.forEach(k => keys.push(k)));
        this._charImportLabels = new Set(keys);
        return this._charImportLabels;
    }

    /**
     * 把粘贴内容按角色切成多块：支持「角色X：姓名」/「姓名：…」起头，
     * 也支持一行一个角色（「林知夏：女，17岁，广播站成员」）。
     */
    parseCharacterBlocks(text) {
        const src = String(text || '');
        if (!src.trim()) return [];
        const labels = this.characterImportLabels();
        const HEADER = /^(?:角色|人物)[一二三四五六七八九十百\d]*\s*[：:]/;
        const NAMELINE = /^(?:姓名|名字|角色名)\s*[：:]/;
        const groups = [];
        let cur = null;
        const startNew = () => { cur = []; groups.push(cur); };
        src.split('\n').forEach(raw => {
            const line = String(raw || '').trim();
            if (!line) return;
            let isHeader = HEADER.test(line) || NAMELINE.test(line);
            if (!isHeader) {
                const m = line.match(/^([^：:]{1,12})\s*[：:]\s*(.+)$/);
                if (m && !labels.has(m[1].trim()) &&
                    this.tryParseInlineCharacter(m[1].trim(), m[2], labels)) isHeader = true;
            }
            if (isHeader || !cur) startNew();
            cur.push(line);
        });
        const out = [];
        groups.forEach(lines => {
            let fields = null;
            // 整块就是一行「姓名：特征…」时用行内解析
            if (lines.length === 1) {
                const m = lines[0].match(/^([^：:]{1,12})\s*[：:]\s*(.+)$/);
                if (m && !labels.has(m[1].trim())) {
                    const inlineChar = this.tryParseInlineCharacter(m[1].trim(), m[2], labels);
                    if (inlineChar) fields = inlineChar;
                }
            }
            if (!fields) fields = this.parseCharacterImport(lines.join('\n')).fields;
            if (fields && Object.keys(fields).length) out.push(fields);
        });
        // 同名块合并：「角色五：周正邦」后紧跟「姓名：周正邦」会被切成两块，这里合回一块
        const merged = [];
        const byName = new Map();
        out.forEach(f => {
            if (!f.name) { merged.push(f); return; }
            if (byName.has(f.name)) {
                const target = byName.get(f.name);
                Object.keys(f).forEach(k => {
                    if (k === 'name') return;
                    if (f[k] !== undefined && f[k] !== null && f[k] !== '') target[k] = f[k];
                });
            } else {
                byName.set(f.name, f);
                merged.push(f);
            }
        });
        return merged;
    }

    /** 把解析好的字段写进角色表单，返回填入的中文栏位名 */
    applyCharacterFieldsToForm(fields) {
        const labels = {
            name: '姓名', alias: '别名', age: '年龄', gender: '性别', occupation: '身份',
            faction: '阵营', appearance: '外貌', personality: '性格', background: '背景',
            abilities: '能力', goals: '目标', weaknesses: '弱点', tags: '标签'
        };
        const filled = [];
        Object.keys(fields || {}).forEach(f => {
            const id = 'char' + f.charAt(0).toUpperCase() + f.slice(1);
            const el = document.getElementById(id);
            if (!el) return;
            el.value = fields[f];
            filled.push(labels[f] || f);
        });
        return filled;
    }

    /** 解析并填入角色表单：识别到多个角色时只填第 1 个，其余引导去批量导入 */
    importCharacterFields() {
        const ta = document.getElementById('charImportText');
        const st = document.getElementById('charImportStatus');
        if (!ta) return;
        if (!ta.value.trim()) {
            if (st) st.textContent = '请先粘贴内容，或点「📋 填入模板」看格式。';
            this.showNotification('导入内容为空', 'warning');
            return;
        }
        const blocks = this.parseCharacterBlocks(ta.value);

        // 多个角色：填第 1 个进表单，并提示可以用「👥 批量添加角色」一次导入全部
        if (blocks.length > 1) {
            const first = blocks[0];
            const filled = this.applyCharacterFieldsToForm(first);
            const names = blocks.map(b => b.name || '未命名').join('、');
            if (st) {
                st.textContent = '检测到 ' + blocks.length + ' 个角色（' + names + '）。' +
                    '下方表单已填入第 1 个「' + (first.name || '未命名') + '」' +
                    (filled.length ? '（' + filled.join('、') + '）' : '') +
                    '；要一次导入全部 ' + blocks.length + ' 个，请点「👥 批量添加角色」。';
            }
            this.showNotification('检测到 ' + blocks.length + ' 个角色，已填入第 1 个；点「👥 批量添加角色」可一次全部导入', 'info');
            return { fields: first, blocks: blocks };
        }

        const res = this.parseCharacterImport(ta.value);
        const filled = this.applyCharacterFieldsToForm(res.fields);
        if (st) {
            st.textContent = filled.length
                ? '已填入 ' + filled.length + ' 项：' + filled.join('、') +
                  (res.unmatched.length ? '；未识别 ' + res.unmatched.length + ' 行（' + res.unmatched.slice(0, 2).join('；') + '…）' : '。')
                : '没有识别到可用字段，请检查格式是否为「标签：内容」。';
        }
        this.showNotification(filled.length ? '已导入 ' + filled.length + ' 个角色字段' : '未识别到字段，请检查格式', filled.length ? 'success' : 'warning');
        return res;
    }

    /** 角色字段 → 批量填充用的标准标签 */
    characterBulkLabel(k) {
        return {
            name: '姓名', alias: '别名/称号', age: '年龄', gender: '性别', occupation: '身份/职业',
            faction: '阵营', appearance: '外貌特征', personality: '性格特点', background: '背景故事',
            abilities: '能力/技能', goals: '目标/愿望', weaknesses: '弱点/缺陷', tags: '角色标签'
        }[k];
    }

    /** 读取当前角色表单，组织成一个角色字段对象（用于把表单内容也一起批量导入） */
    readCharacterForm() {
        const val = id => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
        return {
            name: val('charName'),
            alias: val('charAlias'),
            age: val('charAge'),
            gender: val('charGender'),
            occupation: val('charOccupation'),
            faction: val('charFaction'),
            appearance: val('charAppearance'),
            personality: val('charPersonality'),
            background: val('charBackground'),
            abilities: val('charAbilities'),
            goals: val('charGoals'),
            weaknesses: val('charWeaknesses'),
            tags: val('charTags')
        };
    }

    /**
     * 「👥 批量添加角色」：把导入框里的一次性内容（一个或多个角色）转成规范格式，
     * 交给「批量填充」一次入库。导入框为空时，退回用当前表单内容导入单个角色。
     */
    sendCharactersToBulk() {
        const ta = document.getElementById('charImportText');
        const bulk = document.getElementById('bulkFillText');
        if (!ta || !bulk) return;
        const blocks = ta.value.trim() ? this.parseCharacterBlocks(ta.value) : [];
        // 导入框为空但表单已填：把当前表单作为第一个角色一起导入
        if (!blocks.length) {
            const form = this.readCharacterForm();
            if (!form.name) {
                this.showNotification('请先在上方粘贴多个角色内容（或先填好单个角色表单）', 'warning');
                return;
            }
            blocks.push(form);
        }
        const lines = [];
        blocks.forEach((b, idx) => {
            if (idx) lines.push('');
            lines.push('角色：' + (b.name || ''));
            Object.keys(b).forEach(k => {
                if (k === 'name' || !this.characterBulkLabel(k)) return;
                let v = Array.isArray(b[k]) ? b[k].join('，') : b[k];
                if (v === undefined || v === null || v === '') return;
                if (k === 'gender') v = (v === 'female' ? '女' : v === 'male' ? '男' : v);
                if (k === 'faction') {
                    v = ({ protagonist: '主角阵营', ally: '盟友', neutral: '中立', antagonist: '反派', hidden: '隐藏身份' })[v] || v;
                }
                lines.push(this.characterBulkLabel(k) + '：' + v);
            });
        });
        bulk.value = lines.join('\n');
        this.closeModal('characterModal');
        this.openBulkFillModal();
        this.applyBulkInput();
    }

    clearCharacterForm() {
        const fields = ['charName', 'charAlias', 'charAge', 'charOccupation',
                       'charAppearance', 'charPersonality', 'charBackground',
                       'charAbilities', 'charGoals', 'charWeaknesses', 'charTags'];
        fields.forEach(f => this.setValue(f, ''));
        this.setValue('charGender', 'male');
        this.setValue('charFaction', 'protagonist');
        const relContainer = document.getElementById('charRelations');
        if (relContainer) relContainer.innerHTML = '';
    }

    renderRelations(relations) {
        const container = document.getElementById('charRelations');
        if (!container) return;
        const otherChars = this.work.characters
            .filter(c => !this.currentCharacter || c.id !== this.currentCharacter.id)
            .map(c => '<option value="' + c.id + '">' + this.escapeHtml(c.name) + '</option>')
            .join('');
        container.innerHTML = relations.map(function(rel, idx) {
            return '<div class="relation-row" data-idx="' + idx + '">' +
                '<select class="rel-target"><option value="">选择角色</option>' + otherChars + '</select>' +
                '<input type="text" class="rel-type" placeholder="关系类型" value="' + this.escapeHtml(rel.type || '') + '">' +
                '<button class="btn-small" onclick="this.parentElement.remove()">删除</button>' +
            '</div>';
        }.bind(this)).join('');
        relations.forEach(function(rel, idx) {
            const row = container.children[idx];
            if (row && rel.targetId) {
                const select = row.querySelector('.rel-target');
                if (select) select.value = rel.targetId;
            }
        });
    }

    addRelationField() {
        const container = document.getElementById('charRelations');
        if (!container) return;
        const otherChars = this.work.characters
            .filter(c => !this.currentCharacter || c.id !== this.currentCharacter.id)
            .map(c => '<option value="' + c.id + '">' + this.escapeHtml(c.name) + '</option>')
            .join('');
        const div = document.createElement('div');
        div.className = 'relation-row';
        div.innerHTML = '<select class="rel-target"><option value="">选择角色</option>' + otherChars + '</select>' +
            '<input type="text" class="rel-type" placeholder="关系类型">' +
            '<button class="btn-small" onclick="this.parentElement.remove()">删除</button>';
        container.appendChild(div);
    }

    saveCharacter() {
        const nameEl = document.getElementById('charName');
        const name = nameEl ? nameEl.value.trim() : '';
        if (!name) {
            this.showNotification('请输入角色姓名', 'warning');
            return;
        }
        const relations = [];
        document.querySelectorAll('#charRelations .relation-row').forEach(function(row) {
            const targetSelect = row.querySelector('.rel-target');
            const typeInput = row.querySelector('.rel-type');
            const targetId = targetSelect ? targetSelect.value : '';
            const type = typeInput ? typeInput.value.trim() : '';
            if (targetId && type) relations.push({ targetId, type });
        });
        const getVal = (id) => {
            const el = document.getElementById(id);
            return el ? el.value.trim() : '';
        };
        const character = {
            id: this.currentCharacter ? this.currentCharacter.id : Date.now().toString(),
            name,
            alias: getVal('charAlias'),
            gender: document.getElementById('charGender')?.value || 'male',
            age: getVal('charAge'),
            occupation: getVal('charOccupation'),
            faction: document.getElementById('charFaction')?.value || 'protagonist',
            appearance: getVal('charAppearance'),
            personality: getVal('charPersonality'),
            background: getVal('charBackground'),
            abilities: getVal('charAbilities'),
            goals: getVal('charGoals'),
            weaknesses: getVal('charWeaknesses'),
            tags: getVal('charTags').split(/[,，]/).map(t => t.trim()).filter(Boolean),
            relations,
            createdAt: this.currentCharacter ? this.currentCharacter.createdAt : Date.now()
        };
        if (this.currentCharacter) {
            const idx = this.work.characters.findIndex(c => c.id === this.currentCharacter.id);
            if (idx >= 0) this.work.characters[idx] = character;
        } else {
            this.work.characters.push(character);
        }
        this.saveData();
        this.closeModal('characterModal');
        this.renderCharacters();
        this.addActivity(this.currentCharacter ? '更新角色' : '创建角色', character.name);
        this.showNotification('角色 ' + character.name + ' 已保存', 'success');
    }

    deleteCharacter(id) {
        if (!confirm('确定要删除这个角色吗？')) return;
        const char = this.work.characters.find(c => c.id === id);
        this.work.characters = this.work.characters.filter(c => c.id !== id);
        this.saveData();
        this.renderCharacters();
        this.addActivity('删除角色', char ? char.name : '');
    }

    renderCharacters() {
        const list = document.getElementById('characterList');
        if (!list) return;
        if (this.work.characters.length === 0) {
            list.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;">暂无角色，点击上方按钮添加</div>';
            return;
        }
        const factionNames = {
            protagonist: '主角阵营', ally: '盟友', neutral: '中立',
            antagonist: '反派', hidden: '隐藏身份'
        };
        list.innerHTML = this.work.characters.map(char => {
            const factionLabel = factionNames[char.faction] || char.faction;
            const aliasHtml = char.alias ? '<div class="char-alias">' + this.escapeHtml(char.alias) + '</div>' : '';
            const genderText = char.gender === 'male' ? '男' : char.gender === 'female' ? '女' : char.gender;
            const genderHtml = char.gender ? '性别：' + genderText + '<br>' : '';
            const ageHtml = char.age ? '年龄：' + this.escapeHtml(char.age) + '<br>' : '';
            const occupationHtml = char.occupation ? '身份：' + this.escapeHtml(char.occupation) + '<br>' : '';
            const personalityShort = char.personality ? char.personality.substring(0, 50) : '';
            const personalityHtml = char.personality ? '性格：' + this.escapeHtml(personalityShort) + (char.personality.length > 50 ? '...' : '') + '<br>' : '';
            const tagsHtml = char.tags && char.tags.length > 0 ?
                '<div class="char-tags">' + char.tags.map(t => '<span class="tag">' + this.escapeHtml(t) + '</span>').join('') + '</div>' : '';
            return '<div class="character-card">' +
                '<div class="card-actions">' +
                    '<button onclick="app.editCharacter(\'' + char.id + '\')">✏️</button>' +
                    '<button onclick="app.deleteCharacter(\'' + char.id + '\')">🗑️</button>' +
                '</div>' +
                '<div class="char-header">' +
                    '<div>' +
                        '<div class="char-name">' + this.escapeHtml(char.name) + '</div>' +
                        aliasHtml +
                    '</div>' +
                    '<span class="char-faction faction-' + char.faction + '">' + factionLabel + '</span>' +
                '</div>' +
                '<div class="char-info">' + genderHtml + ageHtml + occupationHtml + personalityHtml + '</div>' +
                tagsHtml +
            '</div>';
        }).join('');
    }

    editCharacter(id) {
        const char = this.work.characters.find(c => c.id === id);
        if (char) this.openCharacterModal(char);
    }

    // ============ 世界观 ============

    saveWorldInfo() {
        this.work.world = {
            era: document.getElementById('worldEra')?.value || '',
            society: document.getElementById('worldSociety')?.value || '',
            tech: document.getElementById('worldTech')?.value || '',
            geography: document.getElementById('worldGeography')?.value || '',
            factions: document.getElementById('worldFactions')?.value || '',
            power: document.getElementById('worldPower')?.value || '',
            rules: document.getElementById('worldRules')?.value || '',
            religion: document.getElementById('worldReligion')?.value || '',
            customs: document.getElementById('worldCustoms')?.value || '',
            language: document.getElementById('worldLanguage')?.value || ''
        };
        this.saveData();
        this.addActivity('更新世界观设定');
    }

    renderWorld() {
        const w = this.work.world;
        // 世界要素统一规整为字符串：兼容早期/AI 返回的 [{...}] 结构，避免输入框里出现 [object Object]
        ['era', 'society', 'tech', 'geography', 'factions', 'power', 'rules', 'religion', 'customs', 'language']
            .forEach(k => { w[k] = this.toTextValue(w[k]); });
        this.setValue('worldEra', w.era);
        this.setValue('worldSociety', w.society);
        this.setValue('worldTech', w.tech);
        this.setValue('worldGeography', w.geography);
        this.setValue('worldFactions', w.factions);
        this.setValue('worldPower', w.power);
        this.setValue('worldRules', w.rules);
        this.setValue('worldReligion', w.religion);
        this.setValue('worldCustoms', w.customs);
        this.setValue('worldLanguage', w.language);
    }

    // ============ 章节管理 ============

    openChapterModal() {
        const modal = document.getElementById('chapterModal');
        if (!modal) return;
        this.setValue('newChapterNum', this.work.chapters.length + 1);
        this.setValue('newChapterTitle', '');

        const charOptions = this.work.characters.map(c =>
            '<option value="' + c.id + '">' + this.escapeHtml(c.name) + '</option>'
        ).join('');
        const newChapterChars = document.getElementById('newChapterChars');
        if (newChapterChars) newChapterChars.innerHTML = charOptions;
        modal.classList.add('show');
    }

    createNewChapter() {
        const numEl = document.getElementById('newChapterNum');
        const titleEl = document.getElementById('newChapterTitle');
        const num = parseInt(numEl ? numEl.value : 1) || 1;
        const rawTitle = titleEl ? (titleEl.value.trim() || '第' + num + '章') : '第' + num + '章';
        // 手动新建同样避免同名章节
        const title = this.uniqueChapterTitle(rawTitle, new Set(this.work.chapters.map(c => this.normChapterKey(c.title))));
        const newChapterChars = document.getElementById('newChapterChars');
        const chapter = {
            id: Date.now().toString(),
            number: num,
            title,
            summary: '',
            characters: newChapterChars ? Array.from(newChapterChars.selectedOptions).map(o => o.value) : [],
            content: '',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            polishedAt: 0
        };
        const idx = this.work.chapters.findIndex(ch => ch.number > num);
        if (idx >= 0) this.work.chapters.splice(idx, 0, chapter);
        else this.work.chapters.push(chapter);
        this.saveData();
        this.closeModal('chapterModal');
        this.renderChapters();
        this.loadChapter(chapter.id);
        this.addActivity('创建章节', title);
    }

    loadChapter(id) {
        const chapter = this.work.chapters.find(c => c.id === id);
        if (!chapter) return;
        // 切换章节前先把当前章节编辑器里的改动落盘，避免切章丢字
        if (this.currentChapter && this.currentChapter.id !== id) {
            const cur = document.getElementById('chapterContent');
            if (cur && this.dirty) {
                this.currentChapter.content = cur.value;
                this.currentChapter.updatedAt = Date.now();
                this.saveData();
                this.dirty = false;
            }
        }
        this.currentChapter = chapter;
        // 该章若有后台续写任务，编辑器显示任务里的最新正文（可能比已保存的更多）
        const job = this.continueJobs.get(id);
        if (job) chapter.content = job.content;
        this.setValue('chapterTitle', chapter.title);
        this.setValue('chapterContent', chapter.content || '');
        this.updateEditorWordCount();
        this.renderChapterList();
        this.updateMemoryTags();
        this.dirty = false;
        if (job && job.running) {
            this.setSaveStatus('dirty', 'AI 正在续写本章（已新增 ' + job.added + ' 字）...');
        } else {
            this.setSaveStatus('', '已加载');
        }
        this.refreshTaskUI();
    }

    /** silent=true：静默保存（连续续写每轮都会存一次，不要刷「章节已保存」提示） */
    saveChapter(silent) {
        if (!this.currentChapter) return;
        const titleEl = document.getElementById('chapterTitle');
        const contentEl = document.getElementById('chapterContent');
        const prevTitle = this.currentChapter.title;
        const prevContent = this.currentChapter.content;
        const newTitle = titleEl ? titleEl.value : prevTitle;
        const newContent = contentEl ? contentEl.value : prevContent;
        const changed = newContent !== prevContent || newTitle !== prevTitle;
        this.currentChapter.title = newTitle;
        this.currentChapter.content = newContent;
        // 仅在内容/标题真正变化时更新 updatedAt：否则「保存」会把旧章误标成「待润色」
        if (changed) this.currentChapter.updatedAt = Date.now();
        this.saveData();
        this.dirty = false;
        this.setSaveStatus('saved', '✓ 已保存 ' + this.nowTime());
        this.renderChapters();
        if (silent === true) return;
        this.showNotification('章节已保存', 'success');
        this.addActivity('保存章节', this.currentChapter.title);
    }

    deleteChapter(id) {
        let target = this.work.chapters.find(c => c.id === id);
        // 兼容早期没有 id 的章节数据：按章节号兜底匹配
        if (!target && id !== undefined && id !== null && /^\d+$/.test(String(id))) {
            const num = parseInt(id, 10);
            target = this.work.chapters.find(c => (c.number || 0) === num);
        }
        if (!target) {
            this.showNotification('未找到该章节（可能已被删除）', 'error');
            return;
        }
        const title = target.title || '未命名章节';
        if (!confirm('确定要删除「第 ' + target.number + ' 章 ' + title + '」吗？\n\n此操作不可恢复！')) return;
        // 该章若正在后台续写 / 润色，先停掉，避免继续往已删除的章节里写
        const job = this.continueJobs.get(target.id);
        if (job) {
            job.running = false;
            try { job.abort.abort(); } catch (e) { /* 忽略 */ }
            this.continueJobs.delete(target.id);
            this.refreshTaskUI();
        }
        const pjob = this.polishJobs.get(target.id);
        if (pjob) {
            pjob.running = false;
            try { pjob.abort.abort(); } catch (e) { /* 忽略 */ }
            this.polishJobs.delete(target.id);
            this.refreshTaskUI();
        }
        const fjob = this.fullChapterJobs.get(target.id);
        if (fjob) {
            fjob.running = false;
            try { fjob.abort.abort(); } catch (e) { /* 忽略 */ }
            this.fullChapterJobs.delete(target.id);
            this.refreshTaskUI();
        }
        this.work.chapters = this.work.chapters.filter(c => c !== target);
        // 删除后重新编号，避免出现断号或重复的章节号
        this.work.chapters.sort((a, b) => (a.number || 0) - (b.number || 0));
        this.work.chapters.forEach((c, i) => { c.number = i + 1; });
        if (this.currentChapter && (this.currentChapter === target || this.currentChapter.id === target.id)) {
            this.currentChapter = null;
            this.setValue('chapterTitle', '');
            this.setValue('chapterContent', '');
            this.setSaveStatus('', '');
        }
        this.saveData();
        this.renderAll();
        this.showNotification('已删除「第' + target.number + '章 ' + title + '」', 'success');
        this.addActivity('删除章节', title);
    }

    /** 删除当前正在编辑的章节（编辑器底栏「🗑 删除本章」入口） */
    deleteCurrentChapter() {
        if (!this.currentChapter) {
            this.showNotification('请先在左侧章节列表中选择要删除的章节', 'info');
            return;
        }
        this.deleteChapter(this.currentChapter.id || this.currentChapter.number);
    }

    /** 找出正文里所有「乱码片段」：[{ start, len, missing, before, after }] */
    collectBrokenSpans(text) {
        const s = String(text || '');
        const spans = [];
        const re = /[\uFFFD]+|锟斤拷/g;
        let m;
        while ((m = re.exec(s))) {
            const raw = m[0];
            // UTF-8 三字节汉字被逐字节解码 → 3 个替换符 ≈ 1 个字
            const missing = Math.max(1, Math.round(raw.length / 3));
            spans.push({
                start: m.index,
                len: raw.length,
                missing: missing,
                before: s.slice(Math.max(0, m.index - 100), m.index),
                after: s.slice(m.index + raw.length, m.index + raw.length + 100)
            });
        }
        return spans;
    }

    /** 把模型补全出来的文字收敛成"N 个字"，去掉解释、引号、换行 */
    sanitizeCompletion(raw, missing) {
        let c = String(raw || '')
            .replace(/[\r\n\t]+/g, '')
            .replace(/[“”"'‘’「」『』（）()【】\[\]]/g, '')
            .replace(/^(补全|补充|缺失内容|答案|结果)[:：]?\s*/, '')
            .replace(/[^\u4e00-\u9fa5，。！？、；：…—]/g, '');
        const want = Math.max(1, missing);
        if (c.length > want + 2) c = c.slice(0, want + 1);
        return c;
    }

    /** 调模型补全一处乱码（只产出缺失的 1~3 个字） */
    async completeBrokenSpan(span, settings) {
        const system = '你是中文小说校订助手。用户给你一段正文，其中 ▢ 表示若干字因编码损坏丢失。' +
            '请根据上下文补出这些字，使句子通顺、符合人物与情节。只输出补全的文字本身，不要解释、不要引号、不要重复上下文。';
        const user = '【前文】' + span.before + '▢' + span.after +
            '\n\n【缺失字数】' + span.missing +
            '\n【要求】只补出 ▢ 处的 ' + span.missing + ' 个字，让它与前文、后文自然衔接；只输出这 ' + span.missing + ' 个字。';
        const raw = await this.callAIAPI(system, user, settings, { maxTokens: 60, onChunk: () => {} });
        return this.sanitizeCompletion(raw, span.missing);
    }

    /**
     * 修复乱码：先删掉损坏字符，再按上下文调用模型补出丢失的字。
     * 模型不可用 / 补全失败时退化为纯删除，保证正文干净。
     */
    async repairBrokenChars() {
        if (!this.work || !Array.isArray(this.work.chapters)) return;
        if (this._repairing) { this.showNotification('正在修复中，请稍候', 'info'); return; }

        const targets = [];
        this.work.chapters.forEach(ch => {
            const spans = this.collectBrokenSpans(ch.content);
            if (spans.length) targets.push({ chapter: ch, spans: spans, fromEditor: false });
        });
        // 编辑器里可能有尚未保存的正文
        const ta = document.getElementById('chapterContent');
        const editorDirty = !!(ta && this.currentChapter && ta.value !== (this.currentChapter.content || ''));
        if (editorDirty) {
            const spans = this.collectBrokenSpans(ta.value);
            if (spans.length) targets.push({ chapter: this.currentChapter, spans: spans, fromEditor: true });
        }
        if (!targets.length) { this.showNotification('没有发现乱码字符', 'info'); return; }

        const spanCount = targets.reduce((n, t) => n + t.spans.length, 0);
        const names = targets.map(t => '第' + (t.chapter.number || '?') + '章').join('、');
        if (!confirm('检测到 ' + names + ' 共 ' + spanCount + ' 处乱码（���）。\n\n' +
            '将删除乱码字符，再调用 AI 按上下文补回丢失的字（共 ' + spanCount + ' 处，可能需要一会儿）。\n' +
            '若模型不可用，则只删除不补全。是否继续？')) return;

        const settings = this.getLiveAISettings();
        this._repairing = true;
        let done = 0, filled = 0, kept = 0, aiFailed = false, aiTried = 0;
        try {
            for (const target of targets) {
                const original = target.fromEditor ? ta.value : String(target.chapter.content || '');
                let text = original;
                // 从后往前替换，避免前面的偏移量失效
                const spans = target.spans.slice().sort((a, b) => b.start - a.start);
                for (const span of spans) {
                    let fill = '';
                    // 模型第一次就失败（没配 key / 网络不通）时不再重试，剩余的直接删除
                    if (!aiFailed && aiTried < 80) {
                        aiTried++;
                        try {
                            fill = await this.completeBrokenSpan(span, settings);
                        } catch (e) {
                            aiFailed = true;
                            fill = '';
                        }
                    }
                    done++;
                    this.setSaveStatus('saving', '修复乱码 ' + done + '/' + spanCount + '…');
                    if (fill) {
                        filled++;
                        text = text.slice(0, span.start) + fill + text.slice(span.start + span.len);
                    } else {
                        kept++;
                        text = text.slice(0, span.start) + text.slice(span.start + span.len);
                    }
                    // 轻微间隔，避免本地/免费额度被瞬间打满
                    if (done % 3 === 0) await this.delay(120);
                }
                target.chapter.content = this.stripBrokenChars(text);
                target.chapter.updatedAt = Date.now();
                if (target.fromEditor && ta) ta.value = target.chapter.content;
            }
            this.saveData();
            this.updateEditorWordCount();
            this.renderChapterList();
            this.setSaveStatus('saved', '✓ 已保存 ' + this.nowTime());
            this.showNotification('乱码修复完成：补回 ' + filled + ' 处' +
                (kept ? '，另有 ' + kept + ' 处未能补全已删除' : '') + '（' + names + '）', 'success');
        } catch (e) {
            this.showNotification('修复乱码失败：' + ((e && e.message) || e), 'error');
        } finally {
            this._repairing = false;
        }
    }

    /** 一键移除标题重复的章节（保留最先出现的一章），用于清理 AI 生成的重复章节 */
    dedupeChapters() {
        const seen = new Set();
        const kept = [];
        let removed = 0;
        const norm = s => (s || '').trim().toLowerCase().replace(/[\s·、，。,.!！?？:：;；\-—_()（）\[\]【】「」『』"']/g, '');
        [...this.work.chapters].sort((a, b) => (a.number || 0) - (b.number || 0)).forEach(ch => {
            const key = norm(ch.title);
            if (key && seen.has(key)) { removed++; return; }
            if (key) seen.add(key);
            kept.push(ch);
        });
        if (!removed) { this.showNotification('没有发现重复章节', 'info'); return; }
        kept.forEach((c, i) => { c.number = i + 1; });
        this.work.chapters = kept;
        // 被移除的章节若还在后台续写 / 润色，一并停掉
        Array.from(this.continueJobs.keys()).forEach(cid => {
            if (!kept.some(c => c.id === cid)) {
                const j = this.continueJobs.get(cid);
                if (j) {
                    j.running = false;
                    try { j.abort.abort(); } catch (e) { /* 忽略 */ }
                }
                this.continueJobs.delete(cid);
            }
        });
        Array.from(this.polishJobs.keys()).forEach(cid => {
            if (!kept.some(c => c.id === cid)) {
                const j = this.polishJobs.get(cid);
                if (j) {
                    j.running = false;
                    try { j.abort.abort(); } catch (e) { /* 忽略 */ }
                }
                this.polishJobs.delete(cid);
            }
        });
        Array.from(this.fullChapterJobs.keys()).forEach(cid => {
            if (!kept.some(c => c.id === cid)) {
                const j = this.fullChapterJobs.get(cid);
                if (j) {
                    j.running = false;
                    try { j.abort.abort(); } catch (e) { /* 忽略 */ }
                }
                this.fullChapterJobs.delete(cid);
            }
        });
        if (this.currentChapter && !kept.some(c => c.id === this.currentChapter.id)) {
            this.currentChapter = null;
            this.setValue('chapterTitle', '');
            this.setValue('chapterContent', '');
        }
        this.saveData();
        this.renderAll();
        this.showNotification('已移除 ' + removed + ' 个重复章节', 'success');
        this.addActivity('章节去重', '移除 ' + removed + ' 章');
    }

    renderChapters() {
        this.renderChapterList();
        this.updateEditorWordCount();
        this.renderGoalProgress();
    }

    renderChapterList() {
        const list = document.getElementById('chapterList');
        if (!list) return;
        this.work.chapters.sort((a, b) => a.number - b.number);
        const countEl = document.getElementById('chapterListCount');
        if (countEl) countEl.textContent = this.work.chapters.length ? ('共 ' + this.work.chapters.length + ' 章') : '';
        if (this.work.chapters.length === 0) {
            list.innerHTML = '<div class="empty-state">暂无章节</div>';
            return;
        }
        list.innerHTML = this.work.chapters.map(ch => {
            const job = ch.id ? this.continueJobs.get(ch.id) : null;
            const running = !!(job && job.running);
            const pjob = ch.id ? this.polishJobs.get(ch.id) : null;
            const polishing = !!(pjob && pjob.running);
            const fjob = ch.id ? this.fullChapterJobs.get(ch.id) : null;
            const generating = !!(fjob && fjob.running);
            const wordCount = job ? job.content.length
                : (fjob && fjob.result ? fjob.result.length : (ch.content ? ch.content.length : 0));
            const isActive = this.currentChapter && this.currentChapter.id === ch.id;
            const needPolish = this.needsPolish(ch);
            // 每章各自独立的开关：✨ 续写 / 🪄 润色 / 📖 整章生成，运行中显示 ⏹，多章可同时跑
            const aiBtn = ch.id
                ? '<button class="ch-ai-btn' + (running ? ' running' : '') + '" title="' +
                    (running ? '停止本章续写' : '为本章启动 AI 续写（可与其它章节同时进行）') +
                    '" onclick="event.stopPropagation(); app.toggleContinueJob(\'' + ch.id + '\')">' +
                    (running ? '⏹' : '✨') + '</button>'
                : '';
            const polishBtn = ch.id
                ? '<button class="ch-polish-btn' + (polishing ? ' running' : '') + '" title="' +
                    (polishing ? '停止本章润色' : '后台润色本章（可与其它章节同时进行）') +
                    '" onclick="event.stopPropagation(); app.togglePolishJob(\'' + ch.id + '\')">' +
                    (polishing ? '⏹' : '🪄') + '</button>'
                : '';
            const genBtn = ch.id
                ? '<button class="ch-gen-btn' + (generating ? ' running' : '') + '" title="' +
                    (generating ? '停止本章整章生成' : '后台生成本章整章（用本章概要作核心事件；无概要则打开弹窗）') +
                    '" onclick="event.stopPropagation(); app.quickGenerateFullChapter(\'' + ch.id + '\')">' +
                    (generating ? '⏹' : '📖') + '</button>'
                : '';
            return '<div class="chapter-item ' + (isActive ? 'active ' : '') +
                    ((running || polishing || generating) ? 'continuing' : '') +
                    '" onclick="app.loadChapter(\'' + ch.id + '\')">' +
                '<div class="ch-num">第 ' + ch.number + ' 章' +
                    (running ? ' <span class="ch-live" title="AI 续写中">●</span>' : '') +
                    (polishing ? ' <span class="ch-live ch-live-polish" title="后台润色中">●</span>' : '') +
                    (generating ? ' <span class="ch-live ch-live-gen" title="整章生成中">●</span>' : '') + '</div>' +
                '<div class="ch-title">' + this.escapeHtml(ch.title) +
                    (needPolish ? ' <span class="ch-need-polish" title="本章已修改但尚未润色（点 🪄 润色即可清除此标记）">待润色</span>' : '') +
                '</div>' +
                '<div class="ch-word-count">' + wordCount.toLocaleString() + ' 字</div>' +
                aiBtn + polishBtn + genBtn +
                '<button class="ch-del-btn" title="删除本章" onclick="event.stopPropagation(); app.deleteChapter(\'' + ch.id + '\')">🗑</button>' +
            '</div>';
        }).join('');
    }

    updateEditorWordCount() {
        const content = document.getElementById('chapterContent')?.value || '';
        const count = content.length;
        const editorWordCount = document.getElementById('editorWordCount');
        if (editorWordCount) editorWordCount.textContent = count.toLocaleString();
    }

    // ============ 写作状态与便捷操作 ============

    markDirty() {
        this.dirty = true;
        this.setSaveStatus('dirty', '● 未保存');
    }

    /**
     * 编辑器底栏的状态文字（「正在后台生成第 N 章…已输出 M 字」这类）。
     * 文字放在内层 span 里：外层负责裁切，内层负责滚动，
     * 否则手机上一行放不下时会被直接切掉，还会把「保存」按钮顶出屏幕。
     */
    setSaveStatus(type, text) {
        const el = document.getElementById('saveStatus');
        if (!el) return;

        let inner = el.querySelector('.save-status-text');
        if (!inner) {
            el.textContent = '';
            inner = document.createElement('span');
            inner.className = 'save-status-text';
            el.appendChild(inner);
        }

        // 只增删类型 class，不整体重设 className：整段重设会让滚动动画每 400ms 从头开始
        if (el.dataset.type !== (type || '')) {
            if (el.dataset.type) el.classList.remove(el.dataset.type);
            if (type) el.classList.add(type);
            el.dataset.type = type || '';
        }

        const s = text || '';
        if (inner.textContent !== s) inner.textContent = s;
        this.syncStatusMarquee(el, inner);
    }

    /** 文字比容器宽就左右来回滚，宽度够就静止（别让状态栏一直晃） */
    syncStatusMarquee(el, inner) {
        const avail = el.clientWidth;
        const full = inner.offsetWidth;
        if (!avail || !full) return;   // 编辑器不在屏幕上，量不到尺寸，等下一次 400ms 刷新

        const shift = Math.round(full - avail);
        if (shift > 4) {
            if (!el.classList.contains('marquee')) el.classList.add('marquee');
            el.style.setProperty('--shift', (-shift) + 'px');
            // 大约每秒走 40px：200px 的溢出量 → 5 秒走完，来回一轮 10 秒，不至于等太久
            el.style.setProperty('--dur', Math.max(4, Math.min(12, Math.round(shift / 40))) + 's');
        } else if (el.classList.contains('marquee')) {
            el.classList.remove('marquee');
            el.style.removeProperty('--shift');
            el.style.removeProperty('--dur');
        }
    }

    nowTime() {
        const d = new Date();
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    toggleFocusMode() {
        document.body.classList.toggle('focus-mode');
        const btn = document.getElementById('focusExitBtn');
        const on = document.body.classList.contains('focus-mode');
        if (btn) btn.style.display = on ? 'block' : 'none';
        const isApp = !!(window.ZhimoFiles || window.ZhimoUpdater || window.Capacitor);
        if (on) this.showNotification(isApp ? '已进入专注模式，点右下角「退出专注模式」返回' : '已进入专注模式，按 Esc 退出', 'info');
    }

    /** 切换到上一章 / 下一章 */
    loadAdjacentChapter(dir) {
        if (this.work.chapters.length === 0) {
            this.showNotification('暂无章节', 'info');
            return;
        }
        const sorted = [...this.work.chapters].sort((a, b) => a.number - b.number);
        let idx = sorted.findIndex(c => this.currentChapter && c.id === this.currentChapter.id);
        if (idx < 0) idx = dir > 0 ? -1 : sorted.length;
        const target = sorted[idx + dir];
        if (!target) {
            this.showNotification(dir > 0 ? '已经是最后一章了' : '已经是第一章了', 'info');
            return;
        }
        if (this.dirty && this.currentChapter) this.saveChapter();
        this.loadChapter(target.id);
    }



    downloadText(text, filename, type) {
        const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * 把字节解码为字符串，自动识别 UTF-8 / GBK(GB18030)。
     * WeChat / 网文 txt 常是 GBK 编码，直接按 UTF-8 读会满屏乱码，这里做一次容错。
     * @param {ArrayBuffer|Uint8Array} buffer
     */
    decodeBytes(buffer) {
        const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        let utf8;
        try { utf8 = new TextDecoder('utf-8', { fatal: false }).decode(u8); } catch (e) { utf8 = ''; }
        const bad = (utf8.match(/�/g) || []).length;
        if (bad > 0 && bad > utf8.length / 200) {
            try { return new TextDecoder('gb18030', { fatal: false }).decode(u8); } catch (e) { /* 回退 UTF-8 */ }
        }
        return utf8;
    }

    /**
     * 把一段 txt 文本按章节拆成结构化数据，用于「导入 TXT」。
     * 识别策略：
     *  - 强标记：第X章/第X回/卷X/Chapter X/楔子·番外·尾声等 → 直接分章；
     *  - 弱标记：「1.」「一、」「（2）」这类数字编号，仅当出现 ≥2 处时才视为分章，避免误拆正文里的编号列表；
     *  - 没有任何分章标记时，整本作为一章《正文》。
     * 书名/作者从开头若干行推断（如《书名》、作者：XXX），推断不到则用文件名兜底。
     * @param {string} text 文件原文
     * @param {string} fallbackName 文件名（作为书名兜底）
     * @returns {{title:string, author:string, chapters:Array<{title:string, content:string}>}}
     */
    parseTxt(text, fallbackName) {
        const CN_NUM = '零一二三四五六七八九十百千万两';
        const clean = String(text == null ? '' : text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
        const lines = clean.split('\n');

        const strongRe = new RegExp(
            '^(?:第[' + CN_NUM + '0-9]+[章回卷节部分篇集]' +
            '|卷[' + CN_NUM + '0-9]+' +
            '|chapter\\s*[' + CN_NUM + '0-9]+' +
            '|楔子|引子|序章|序言|前言|题记|尾声|番外|后记|附录|外传|终章)' +
            '\\s*[:：]?\\s*(.*)$', 'i');
        const weakRe = new RegExp('^[（(]?[' + CN_NUM + '0-9]+[)）]?[.．、]\\s*(.*)$');

        const breaks = [];   // { i, title, isWeak }
        let weakCount = 0;
        lines.forEach((line, i) => {
            const s = line.trim();
            if (!s) return;
            const sm = s.match(strongRe);
            if (sm) { breaks.push({ i: i, title: (sm[1] || '').trim(), isWeak: false }); return; }
            const wm = s.match(weakRe);
            if (wm) { weakCount++; breaks.push({ i: i, title: (wm[1] || '').trim(), isWeak: true }); }
        });
        if (weakCount < 2) breaks.forEach((b, k) => { if (b.isWeak) breaks[k] = null; });
        const realBreaks = breaks.filter(Boolean);

        const chapters = [];
        if (realBreaks.length === 0) {
            let body = lines.join('\n');
            body = body.replace(/^[《「“『].+?[》」”』]\s*\n/, '');
            body = body.replace(/^(?:作者|著|文|撰|原作者)\s*[:：].+\n/, '');
            chapters.push({ title: '正文', content: body.trim() });
        } else {
            for (let k = 0; k < realBreaks.length; k++) {
                const start = realBreaks[k].i;
                const end = (k + 1 < realBreaks.length) ? realBreaks[k + 1].i : lines.length;
                const body = [];
                for (let j = start + 1; j < end; j++) body.push(lines[j]);
                let title = realBreaks[k].title;
                if (!title) title = lines[start].trim().replace(/^[:：\s]+/, '');
                chapters.push({ title: title || ('第' + (k + 1) + '章'), content: body.join('\n').replace(/\n{3,}/g, '\n\n').trim() });
            }
        }

        // 书名 / 作者：只看首个分章标记之前的内容行
        let title = '', author = '';
        const firstStrong = realBreaks.find(b => !b.isWeak);
        const headEnd = firstStrong ? firstStrong.i : (realBreaks.length ? realBreaks[0].i : lines.length);
        for (let i = 0; i < headEnd; i++) {
            const s = lines[i].trim();
            if (!s) continue;
            if (!title) {
                const m = s.match(/^[《「“『](.+?)[》」”』]$/);
                if (m && m[1].length >= 1 && m[1].length <= 30) { title = m[1]; continue; }
            }
            const au = s.match(/^(?:作者|著|文|撰|原作者)\s*[:：]\s*(.+)$/);
            if (au) { author = au[1].trim(); continue; }
            if (!title && s.length <= 25 && !/[。！？!?，,]/.test(s) &&
                !/^第|^chapter|^卷|^[0-9（(]/.test(s)) {
                title = s;
            }
        }
        if (!title && fallbackName) title = String(fallbackName).replace(/\.txt$/i, '').trim();

        const result = chapters
            .map(c => ({ title: (c.title || '').replace(/^[:：\s]+/, '').trim() || '正文', content: c.content || '' }))
            .filter(c => c.content || c.title);
        return { title: title || '导入的小说', author: author || '', chapters: result };
    }

    /**
     * 导入一段 txt 文本：解析并新建一部作品，自动切到该作品并打开第一章。
     * 供「导入 TXT」按钮与系统/微信「打开方式」共用。
     * @param {string} name 文件名（书名兜底）
     * @param {string} text 文件全文
     */
    importTxtText(name, text) {
        try {
            const parsed = this.parseTxt(text, name);
            const work = this.createWorkData({
                title: parsed.title || (name ? String(name).replace(/\.txt$/i, '') : '导入的小说'),
                author: parsed.author || '',
                genre: 'fantasy'
            });
            work.chapters = parsed.chapters.map((c, i) => ({
                id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + i,
                number: i + 1,
                title: c.title || ('第' + (i + 1) + '章'),
                content: c.content || '',
                characters: [],
                createdAt: Date.now(),
                updatedAt: Date.now()
            }));
            if (this.dirty && this.currentChapter) this.saveChapter();
            this.data.works.push(work);
            this.data.activeWorkId = work.id;
            this.currentChapter = null;
            this.saveData();
            this.renderAll();
            this.switchTab('chapters');
            if (work.chapters[0]) this.loadChapter(work.chapters[0].id);
            const words = work.chapters.reduce((s, c) => s + (c.content ? c.content.length : 0), 0);
            this.showNotification('已导入《' + work.novel.title + '》：' + work.chapters.length + ' 章 · ' + words + ' 字', 'success');
            this.addActivity('导入TXT', work.novel.title);
        } catch (err) {
            this.showNotification('导入失败：' + (err && err.message ? err.message : '解析错误'), 'error');
        }
    }

    /** 「导入 TXT」按钮：读取本地文件 → 解码 → 交给 importTxtText */
    importTxtFile(event) {
        const file = event && event.target && event.target.files && event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const buf = e.target.result;
                const text = this.decodeBytes(buf);
                this.importTxtText(file.name, text);
            } catch (err) {
                this.showNotification('读取文件失败：' + (err && err.message ? err.message : err), 'error');
            }
        };
        reader.readAsArrayBuffer(file);
        event.target.value = '';
    }

    /**
     * 桌面端走主进程的原生「保存到…」对话框：路径由用户选、由主进程直接写盘，
     * 因此一定能落到用户指定的位置；网页端回退为浏览器下载。
     * @param {string} filename 建议文件名
     * @param {string} text     内容
     * @param {string} type     MIME 类型
     * @returns {Promise<{ok:boolean, path?:string, canceled?:boolean}>}
     */
    async saveTextFile(filename, text, type) {
        // 手机 App：交给原生写入「手机/Download/智墨小说/」
        const filesApi = window.ZhimoFiles;
        if (filesApi && typeof filesApi.save === 'function') {
            try {
                const res = String(filesApi.save(filename, text, type || 'text/plain') || '');
                if (res.indexOf('ok:') === 0) return { ok: true, path: res.slice(3) };
                return { ok: false, reason: res.replace(/^err:/, '') || '保存失败' };
            } catch (e) {
                return { ok: false, reason: (e && e.message) || '保存失败' };
            }
        }

        const api = window.desktopAPI;
        if (api && typeof api.saveTextFile === 'function') {
            try {
                const res = await api.saveTextFile(filename, text, type || '');
                if (res && res.ok) return { ok: true, path: res.filePath };
                return { ok: false, canceled: !!(res && res.reason === 'canceled'), reason: res && res.reason };
            } catch (e) {
                return { ok: false, reason: (e && e.message) || 'save-failed' };
            }
        }
        // 网页端：退化为浏览器下载
        this.downloadText(text, filename, type);
        return { ok: true };
    }

    /** 统一的导出结果提示 */
    exportNotify(res, okMsg) {
        if (res && res.ok) {
            this.showNotification(res.path ? '已导出到：' + res.path : okMsg, 'success');
        } else if (!(res && res.canceled)) {
            this.showNotification('导出失败：' + ((res && res.reason) || '未知错误'), 'error');
        }
    }

    /**
     * 章节标题行：第N章 + 标题。
     * 标题本身已经写成「第N章 xxx」时，不要把编号再拼一次（否则导出成「第1章 第1章」）。
     */
    chapterHeading(ch) {
        const num = (ch && ch.number) || 1;
        const title = String((ch && ch.title) || '').trim();
        if (/^第[0-9一二三四五六七八九十百千]+章/.test(title)) return title;
        return '第' + num + '章' + (title ? ' ' + title : '');
    }

    /** 导出当前章节为 txt */
    async exportCurrentChapter() {
        if (!this.currentChapter) {
            this.showNotification('请先选择一个章节', 'warning');
            return;
        }
        const ch = this.currentChapter;
        const content = document.getElementById('chapterContent')?.value || ch.content || '';
        const res = await this.saveTextFile(
            '第' + ch.number + '章_' + ch.title + '.txt',
            this.chapterHeading(ch) + '\n\n' + content,
            'text/plain;charset=utf-8'
        );
        this.exportNotify(res, '当前章节已导出');
    }

    /** 复制当前章节正文到剪贴板（含章节标题，优先取编辑器里未保存的最新内容） */
    copyCurrentChapter() {
        if (!this.currentChapter) {
            this.showNotification('请先选择一个章节', 'warning');
            return;
        }
        const ch = this.currentChapter;
        const editor = document.getElementById('chapterContent');
        const content = editor ? editor.value : (ch.content || '');
        if (!content.trim()) {
            this.showNotification('当前章节还没有正文', 'warning');
            return;
        }
        this.copyText(this.chapterHeading(ch) + '\n\n' + content);
    }

    insertFormat(before, after) {
        const textarea = document.getElementById('chapterContent');
        if (!textarea) return;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const text = textarea.value;
        const selected = text.substring(start, end);
        textarea.value = text.substring(0, start) + before + selected + after + text.substring(end);
        textarea.focus();
        textarea.selectionStart = start + before.length;
        textarea.selectionEnd = start + before.length + selected.length;
    }

    // ============ 上下文记忆系统 ============

    saveMemoryConfig() {
        this.work.memory = {
            mode: document.getElementById('memoryMode')?.value || 'smart',
            charDepth: document.getElementById('charMemoryDepth')?.value || 'detail',
            plotRange: parseInt(document.getElementById('plotMemoryRange')?.value) || 5,
            rules: document.getElementById('memoryRules')?.value || '',
            history: this.work.memory.history
        };
        this.saveData();
        this.renderMemoryPreview();
    }

    /** 把已保存的记忆配置回填到面板：不回填的话面板是空的，
     *  用户改动任一项都会把 memory.rules 等已保存内容覆盖成空 */
    loadMemoryConfig() {
        const m = this.work.memory || {};
        this.setValue('memoryMode', m.mode || 'smart');
        this.setValue('charMemoryDepth', m.charDepth || 'detail');
        const range = document.getElementById('plotMemoryRange');
        if (range) range.value = m.plotRange || 5;
        const scope = document.getElementById('memoryScope');
        if (scope) scope.value = m.scope || 'recent';
        const rules = document.getElementById('memoryRules');
        if (rules) rules.value = m.rules || '';
        this.renderMemoryPreview();
    }

    /**
     * 跨段重复检测：把新写内容里「已经在正文出现过」的段落/句子去掉。
     * 解决 AI 续写循环把同一个场景（如生日邀请、去家里吃饭）再写一遍的问题。
     * 用「包含度」而非相似度：新内容有 60% 以上的 6-gram 已在正文中出现，即视为重复。
     */
    removeRepeatedAgainstChapter(text, chapterText) {
        const src = String(text || '');
        if (!src.trim()) return '';
        const chapter = String(chapterText || '').replace(/\s+/g, '');
        if (!chapter) return src;
        const normP = p => p.replace(/\s+/g, '');
        const grams = (s, n = 6) => {
            const set = new Set();
            for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n));
            return set;
        };
        const chapterGrams = grams(chapter);
        // 一段/一句有多少比例的 6-gram 已经在正文里出现过
        const containment = (s) => {
            const A = grams(s);
            if (A.size < 2) return 0;
            let inter = 0;
            for (const x of A) if (chapterGrams.has(x)) inter++;
            return inter / A.size;
        };
        let dropped = 0;
        const paras = src.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
        const kept = [];
        for (const p of paras) {
            const key = normP(p);
            let dup = false;
            if (key.length >= 20) {
                // 长段：原样已在正文中，或 60% 以上内容重复
                dup = chapter.indexOf(key) > -1 || containment(key) >= 0.6;
            } else if (key.length >= 12) {
                // 短段（多为对话）：原样在正文中出现，或 90% 以上重复才算，避免误伤
                dup = chapter.indexOf(key) > -1 || containment(key) >= 0.9;
            }
            if (dup) { dropped++; continue; }
            if (key.length >= 40) {
                // 长段内部再把「已在正文出现过」的长句清掉，保留本段其余部分
                const rebuilt = p.split(/(?<=[。！？!?…])/).map(s => {
                    const sk = normP(s);
                    if (sk.length >= 12 && containment(sk) >= 0.7) { dropped++; return ''; }
                    return s;
                }).join('');
                if (rebuilt.trim()) kept.push(rebuilt.trim());
                continue;
            }
            kept.push(p);
        }
        return kept.join('\n\n');
    }

    /** 统计套话超量使用：返回 [「轻声×5」...]，用于给用户明确提示 */
    countClicheOveruse(text, limit) {
        const max = limit || 2;
        const t = String(text || '');
        const words = ['微微一笑', '勾了勾嘴角', '轻声', '低声', '目光', '眼神', '心中涌起', '涌起一股',
                       '仿佛', '似乎', '淡淡地', '不易察觉', '若有所思', '温柔地', '心跳加速', '相视一笑'];
        const out = [];
        words.forEach(w => {
            const c = t.split(w).length - 1;
            if (c > max) out.push(w + '×' + c);
        });
        return out;
    }

    /** 角色性别转中文，避免模型在「他/她」之间漂移 */
    genderLabel(g) {
        const m = { male: '男', female: '女', other: '其他', unknown: '未知' };
        return m[g] || '';
    }

    /** 常见套话/固定搭配清单：用于检测本章反复出现的“反应句” */
    getStockPhrases() {
        return ['微微一笑', '相视一笑', '嘴角勾起', '不易察觉', '狡黠', '眨了眨眼', '耸了耸肩',
                '轻轻点了点头', '深吸一口气', '轻声道', '低声说', '目光', '眼神', '瞬间', '心跳',
                '露出一丝', '促狭', '温柔地', '感激地', '似乎', '仿佛', '心中涌起', '不由',
                // 时间过渡与场景描写套话：续写里最容易反复出现的一类
                '夜色渐深', '夜幕降临', '华灯初上', '时光飞逝', '转眼间', '次第亮起',
                '清晨的阳光', '夕阳西下', '第二天一早', '望着窗外的星空'];
    }

    /**
     * AI 生成最典型的「动作/镜头复读」指纹：同一组写法（手指飞舞、嗡鸣、眼中红光、
     * 没有时间了、不像人类更像机器）在长章里反复刷屏。逐字套话检测抓不到它们（每次措辞略变），
     * 所以用正则按「意象」识别，作为签约自检的一项硬指标，并供润色时重点禁用。
     */
    getAiTells() {
        return [
            { label: '手指飞舞/快速敲击', re: /手指在[^。，]{0,10}(飞舞|快速敲击|飞快敲击|快速操作|飞速)/g },
            { label: '义体/设备嗡鸣', re: /(义体|轮椅|设备|装置)[^。，]{0,8}嗡鸣/g },
            { label: '眼中闪烁红光', re: /(眼睛|眼中|双眼)[^。，]{0,6}闪烁(着|出)?红光/g },
            { label: '动作不像人类更像机器', re: /(动作|举止|步态)[^。，]{0,6}(不像人类|更像机器|机械)/g },
            { label: '没有时间了', re: /没有时间了/g },
            { label: '需要(更多)?时间', re: /需要(更多)?时间/g }
        ];
    }

    /**
     * 角色自我相遇 / 重复出场检测：同一角色既被写成「上前敲门/来到门前」，
     * 门开后里面出来的又是这个角色（等于自己遇到自己）。这是长文生成最常见的连续性硬伤。
     * 返回命中角色名数组（去重）。
     */
    detectSelfMeeting(src) {
        const hits = [];
        const seen = new Set();
        const re = /([一-龥]{2,3})(?:上前|走过去|快步|主动|轻轻)?敲门|([一-龥]{2,3})来到[^。，]{0,12}(?:门前|门口|门外)/g;
        let m;
        while ((m = re.exec(src))) {
            const name = m[1] || m[2];
            if (!name || name.length < 2 || seen.has(name)) continue;
            const after = src.slice(m.index, m.index + 320);
            // 门开后，同一名字又作为「屋内人」出现（回答/打量/站在/看向/开口……）
            if (/门(开了|开了一条缝|被打开|吱呀|应声而开)/.test(after) &&
                new RegExp(name + '(回答|打量|站在|看向|开口|问|说|迎上来|从里面|推开门)').test(after)) {
                hits.push(name);
                seen.add(name);
            }
        }
        return hits;
    }

    /** 统计本章已反复使用的套话表达式，返回 [{phrase, count}]（出现 ≥2 次才列入） */
    getChapterStockPhrases(text) {
        const src = String(text || '');
        const out = [];
        const seen = new Set();
        this.getStockPhrases().forEach(p => {
            if (!p || seen.has(p)) return;
            seen.add(p);
            const c = src.split(p).length - 1;
            if (c >= 2) out.push({ phrase: p, count: c });
        });
        return out.sort((a, b) => b.count - a.count).slice(0, 14);
    }

    /**
     * 生成「本章禁用表达」提示块：前文已出现 ≥2 次的套话一律禁用，并给出替代方向。
     * 这是动态的——每轮续写都按当前正文重算，所以模型不会反复复用同一批反应句。
     */
    buildBannedPhraseNotice(text) {
        const list = this.getChapterStockPhrases(text);
        // 除了固定套话表，再统计本章真正高频的用词（3~4 字组合），
        // 避免模型每轮都反复用同一批比喻、动作和形容
        const words = this.getOverusedWords(text);
        const lines = [];
        list.forEach(x => lines.push('· 「' + x.phrase + '」前文已出现 ' + x.count + ' 次，本次严禁再出现'));
        words.forEach(x => lines.push('· 「' + x.phrase + '」前文已出现 ' + x.count + ' 次，本次换用别的具体写法，不要同义改头换面后再重复'));
        if (!lines.length) return '';
        return '【本章禁用表达（前文已多次出现，本次禁止再用）】\n' + lines.join('\n') +
            '\n【替代要求】改用只属于当下场景的具体动作与细节：谁的手/呼吸/视线落在哪里、物件的声响与温度、' +
            '只有这个场景才会发生的举动；情绪反应要落到人物内部——这一个具体念头是什么、他在担心什么、' +
            '身体有什么反应、哪句话他忍住没说；不要用概括性表情词和固定搭配；' +
            '同一个动作全章写一次就够，换个主语或换个说法重复也算重复。';
    }

    /**
     * 统计本章反复出现的分句 / 词组，返回 [{phrase, count}]。
     * 先找重复分句（最贴近「重复语句」的真实信号），没有明显重复时再退回 4 字组合统计。
     */
    getOverusedWords(text, limit) {
        let src = String(text || '');
        if (src.length > 40000) src = src.slice(-40000);   // 只看最近部分，保证响应速度
        if (src.replace(/\s/g, '').length < 600) return [];

        const cand = [];
        // 1) 反复出现的分句：4~18 字，出现 2 次以上（长分句）/ 3 次以上（短分句）
        const clauses = new Map();
        src.split(/[。！？…；，、\n\r\t（）“”"'’‘《》\s]+/).forEach(part => {
            const p = String(part).replace(/[^\u4e00-\u9fa5]/g, '');
            if (p.length < 4 || p.length > 18) return;
            clauses.set(p, (clauses.get(p) || 0) + 1);
        });
        clauses.forEach((c, p) => {
            if (c >= (p.length >= 6 ? 2 : 3)) cand.push({ phrase: p, count: c, weight: c * p.length });
        });
        // 2) 分句里没有明显重复：退回 4 字组合统计，抓「反复用同一批词」的情况
        if (!cand.length) {
            const norm = src.replace(/[^\u4e00-\u9fa5]/g, '');
            const grams = new Map();
            for (let i = 0; i + 4 <= norm.length; i++) {
                const g = norm.slice(i, i + 4);
                grams.set(g, (grams.get(g) || 0) + 1);
            }
            grams.forEach((c, g) => { if (c >= 4) cand.push({ phrase: g, count: c, weight: c * 4 }); });
        }
        if (!cand.length) return [];
        cand.sort((a, b) => b.weight - a.weight);
        const picked = [];
        for (const it of cand) {
            if (picked.length >= (limit || 6)) break;
            // 与已选词互相包含的跳过，避免「看着手机 / 着手机 / 手机」反复列出
            if (picked.some(p => p.phrase.indexOf(it.phrase) >= 0 || it.phrase.indexOf(p.phrase) >= 0)) continue;
            picked.push(it);
        }
        return picked;
    }

    /** 情感基调选项（key 与 index.html 的 fcTone 一致） */
    getToneNames() {
        return {
            tense: '紧张刺激', warm: '温馨动人', romantic: '心动暧昧', light: '轻松诙谐',
            sad: '悲伤沉重', lonely: '孤独压抑', mysterious: '悬疑神秘', epic: '史诗宏大',
            calm: '平静舒缓', uplifting: '热血励志', nostalgic: '青涩怀旧', healing: '温暖治愈'
        };
    }

    /**
     * 每种情感基调对应的「写作与作词」要求。
     * 模型不会自己揣摩基调，必须把用词、句式、节奏、对话密度写清楚，它才会真的照着写。
     */
    getToneGuide(tone) {
        const guides = {
            tense: '【基调落地要求·紧张刺激】1. 句式：以 10~25 字短句为主，多用动词，删掉可有可无的形容词；' +
                '2. 用词：具体、带声响与速度感（脚步、喘息、指节、秒表、回音），杜绝"仿佛/似乎/心中涌起"这类虚词；' +
                '3. 节奏：动作与反应交错，一句压迫接一句；对话短促，可用打断、省略号、单字回复；' +
                '4. 视角贴着当下人物，不写上帝视角总结；结尾停在一个未解决的问题上。',
            warm: '【基调落地要求·温馨动人】1. 句式：长短交错，允许舒缓的长句写细节；' +
                '2. 用词：写具体的生活物件（保温杯、袖口、楼道声控灯、热气），用温度、气味、触感替代抽象抒情；' +
                '3. 对话自然、有来有回，可以出现沉默与欲言又止；' +
                '4. 情绪由小事托出，不直接说"感动/幸福"；结尾落在一个人为另一个人做的小动作上。',
            romantic: '【基调落地要求·心动暧昧】1. 句式：多用短句与停顿，句子之间留呼吸；' +
                '2. 用词：写距离与细节（视线的落点、指尖的距离、声音放低的幅度），避免直白的"心跳加速/喜欢"；' +
                '3. 对话要"话里有话"、留半句；肢体与眼神先于告白；' +
                '4. 情绪靠"差一点就..."的瞬间推进，结尾停在一个没被说破的动作上。',
            light: '【基调落地要求·轻松诙谐】1. 句式：短句、口语化，节奏轻快，可用插话与自嘲；' +
                '2. 用词：新鲜俏皮的比喻（生活化、不套话），允许语气词与网络年代感的口语；' +
                '3. 对话承担主要笑点：答非所问、吐槽、反差；叙述负责拆台；' +
                '4. 不写抒情长段与总结句，结尾用一句轻巧的话收。',
            sad: '【基调落地要求·悲伤沉重】1. 句式：缓而沉，多用完整句，少用惊叹号；' +
                '2. 用词：克制、准确，写"留下的东西"（空位、旧物、习惯动作），不堆砌悲情形容词；' +
                '3. 对话简短、有回避与答非所问；沉默比说话多；' +
                '4. 情绪只点一次，不重复渲染；结尾让读者自己发现那件没说出口的事。',
            lonely: '【基调落地要求·孤独压抑】1. 句式：句中多用逗号拖长节奏，制造走不出去的感觉；' +
                '2. 用词：冷色调、空旷感（回声、白噪、隔音、反光），人物对环境的感受强于环境本身；' +
                '3. 对话稀少且低效，多用独白与内心反复；' +
                '4. 结尾不给安慰，停在"还得继续"的状态上。',
            mysterious: '【基调落地要求·悬疑神秘】1. 句式：长短交错，关键信息用短句单独成句；' +
                '2. 用词：写"不对劲的细节"（顺序不对的鞋、多出来的一把伞、太干净的桌面），而不是形容词；' +
                '3. 只给线索不给解释；对话留漏洞、留试探；' +
                '4. 结尾抛出一个新问题，让人想往下看。',
            epic: '【基调落地要求·史诗宏大】1. 句式：允许排比与长句，气势要起来；' +
                '2. 用词：开阔、有空间的比喻（山河、风声、钟声、队列），写出人的渺小与选择的分量；' +
                '3. 对话简短有力，多用宣告、誓言或反问；' +
                '4. 结尾落在"代价"与"决心"上，不落在儿女情长上。',
            calm: '【基调落地要求·平静舒缓】1. 句式：稳定，长短有规律，不用陡然的短句打断；' +
                '2. 用词：日常、干净，写光影、天气、远处的声音，多用五感中的轻触感；' +
                '3. 对话少而轻，可有大量留白与心理活动；' +
                '4. 结尾收在一种"今天也就这样过去了"的安定感上。',
            uplifting: '【基调落地要求·热血励志】1. 句式：短句为主，关键处用重复与排比推高情绪；' +
                '2. 用词：有力量、有方向感（呼吸、步伐、掌心、握紧），可以适度直接用喊出来的短句；' +
                '3. 对话要有鼓点感，一句比一句重；' +
                '4. 结尾落在"决定去做"而不是"做到了"，留一口气。',
            nostalgic: '【基调落地要求·青涩怀旧】1. 句式：带回忆的松弛感，可有较长的叙述句；' +
                '2. 用词：年代感与校园具体物（粉笔灰、课间操广播、塑料尺、冰棍纸），多写光线与季节；' +
                '3. 对话稚气、认真、略带笨拙，符合学生身份；' +
                '4. 结尾带一点"当时不知道"的回望感，但不直接抒情。',
            healing: '【基调落地要求·温暖治愈】1. 句式：柔缓，长句写陪伴，短句写被点亮的瞬间；' +
                '2. 用词：具象的温柔（热汤、毯子、路灯、雨伞倾向），避免空泛的"温暖/治愈"；' +
                '3. 对话体贴不煽情，多为关心与陪伴的日常；' +
                '4. 结尾落在一个"有人陪/有人懂"的小动作上。'
        };
        return guides[tone] || guides.warm;
    }

    /** 把角色的关系列表转成「对方（关系）」文本，供提示词使用 */
    formatCharRelations(char) {
        if (!char || !Array.isArray(char.relations) || !char.relations.length) return '';
        return char.relations.map(r => {
            const target = this.work.characters.find(x => x.id === r.targetId);
            return target ? (target.name + (r.type ? '（' + r.type + '）' : '')) : '';
        }).filter(Boolean).join('、');
    }

    buildContextMemory(workArg, chapterArg) {
        // 后台任务用「任务所属作品/章节」构建上下文，避免用户切章后上下文串台
        const work = workArg || this.work;
        const chapter = chapterArg || this.currentChapter;
        const memory = work.memory;
        const parts = [];
        const novel = work.novel;
        parts.push('【作品信息】\n作品：《' + (novel.title || '未命名') + '》\n类型：' + this.getGenreName(novel.genre) + '\n简介：' + (novel.synopsis || '未设定') + '\n主题：' + (novel.theme || '未设定') + '\n');
        const world = this.work.world;
        if (world.era || world.geography) {
            parts.push('【世界观】\n时代：' + (world.era || '未设定') + '\n地理：' + (world.geography ? world.geography.substring(0, 200) : '未设定') + '\n力量体系：' + (world.power ? world.power.substring(0, 200) : '未设定') + '\n');
        }
        const chars = work.characters;
        if (chars.length > 0) {
            const charSection = ['【角色档案】'];
            chars.forEach(char => {
                const rel = this.formatCharRelations(char);
                const gender = this.genderLabel(char.gender);
                if (memory.charDepth === 'basic') {
                    const factionText = char.faction === 'protagonist' ? '主角阵营' : char.faction === 'antagonist' ? '反派' : '其他';
                    charSection.push(char.name + '：' + (char.occupation || '无身份') + (gender ? '，' + gender : '') + '，' + factionText);
                } else if (memory.charDepth === 'detail') {
                    charSection.push(char.name + (char.alias ? '（' + char.alias + '）' : '') + '：' + (char.occupation || '无身份') + (gender ? '，' + gender : '') + '，性格' + (char.personality || '未设定') + '，' + (char.goals ? '目标是' + char.goals : '') + (rel ? '，关系：' + rel : ''));
                } else {
                    charSection.push(char.name + (char.alias ? '（' + char.alias + '）' : '') + '\n身份：' + (char.occupation || '未设定') + '\n性别：' + (gender || '未设定') + '\n性格：' + (char.personality || '未设定') + '\n背景：' + (char.background ? char.background.substring(0, 100) : '未设定') + '\n能力：' + (char.abilities || '未设定') + '\n目标：' + (char.goals || '未设定') + '\n弱点：' + (char.weaknesses || '未设定') + '\n关系：' + (rel || '未设定'));
                }
            });
            parts.push(charSection.join('\n'));
        }
        const scope = document.getElementById('memoryScope')?.value || 'recent';
        let relevantChapters = [];
        if (chapter) {
            const idx = work.chapters.findIndex(c => c.id === chapter.id);
            if (scope === 'chapter') relevantChapters = [chapter];
            else if (scope === 'recent') relevantChapters = work.chapters.slice(Math.max(0, idx - 2), idx);
            else relevantChapters = work.chapters.slice(0, idx);
        }
        if (relevantChapters.length > 0) {
            const chapterSection = ['【前文剧情】'];
            relevantChapters.forEach(ch => {
                const summary = ch.summary || (ch.content ? ch.content.substring(0, 100) : '无内容');
                chapterSection.push('第' + ch.number + '章《' + ch.title + '》：' + summary);
            });
            parts.push(chapterSection.join('\n'));
        }
        if (chapter) {
            parts.push('【当前章节】\n第' + chapter.number + '章《' + chapter.title + '》\n概要：' + (chapter.summary || '无') + '\n');
            // 补上一章结尾：跨章续写时最常见的问题是「接不上上一章」，摘要不够具体
            const idx = work.chapters.findIndex(c => c.id === chapter.id);
            if (idx > 0) {
                const prev = work.chapters[idx - 1];
                if (prev && prev.content) {
                    parts.push('【上一章结尾（用于衔接，禁止复述）】\n' + prev.content.slice(-400));
                }
            }
        }
        if (memory.rules) parts.push('【硬设定（你写下的设定，优先级最高，不得违反）】\n' + memory.rules + '\n');
        // 连续性硬约束：把常见 AI 翻车点写成明确禁令，配合下面的确定性去重一起用
        parts.push('【连续性硬约束（违反任何一条都算写错）】\n' +
            '1. 角色性别、身份、关系、称谓必须与【角色档案】一致；不得把已设定身份的角色安排成其他身份，也不得让同一个角色同时出现在两个地点做两件事（例如学生在教室里说话，同时又在全校广播里播音）。引用话语必须说清是谁说的。\n' +
            '2. 时间必须向前：不得出现「晚自习已经开始」又写「夕阳余晖」这类时间倒退；需要跳转时间必须用一句话交代。\n' +
            '3. 不得重写已经发生过的事件：新内容必须是剧情推进，不得把同一场景换几句话再写一遍。\n' +
            '4. 数字、规则、道具状态前后必须一致（如排名分段规则、某件道具只有一件）；不得与【硬设定】冲突。\n' +
            '5. 称呼必须与前文一致，不得突然改用昵称；昵称首次出现必须在前文有铺垫。\n' +
            '6. 埋下的伏笔要回收，不得在结尾留下未解释的新悬念。\n' +
            '7. 套话、修饰词每个最多用一次（如「微微一笑」「轻声」「目光」「仿佛」「似乎」「心中涌起」）。');
        return parts.join('\n\n');
    }

    getGenreName(genre) {
        const names = {
            fantasy: '玄幻奇幻', wuxia: '武侠仙侠', urban: '都市异能', modern: '现代都市',
            scifi: '科幻未来', history: '历史架空', romanceAncient: '古代言情',
            republic: '民国风云', romance: '言情耽美', ceo: '豪门总裁',
            campus: '校园青春', rebirth: '穿越重生', suspense: '悬疑推理',
            military: '军旅谍战', horror: '灵异恐怖', business: '商战职场',
            game: '游戏竞技', fanfic: '二次元同人', literary: '现实文学',
            other: '其他'
        };
        return names[genre] || genre;
    }

    renderMemoryPreview() {
        const preview = document.getElementById('memoryPreview');
        if (!preview) return;
        const context = this.buildContextMemory();
        preview.textContent = context || '暂无记忆内容';
    }

    updateMemoryTags() {
        const container = document.getElementById('memoryTags');
        if (!container) return;
        const tags = [];
        if (this.currentChapter) {
            tags.push('第' + this.currentChapter.number + '章');
            const charNames = (this.currentChapter.characters || [])
                .map(id => {
                    const c = this.work.characters.find(ch => ch.id === id);
                    return c ? c.name : null;
                })
                .filter(Boolean);
            if (charNames.length) tags.push.apply(tags, charNames);
        }
        container.innerHTML = tags.map(t => '<span class="memory-tag">' + this.escapeHtml(t) + '</span>').join('');
    }

    // ============ AI 生成 ============

    generateContent(type) {
        const modal = document.getElementById('generateModal');
        if (!modal) return;
        this.setValue('genType', type);
        const charOptions = this.work.characters.map(c =>
            '<option value="' + c.id + '">' + this.escapeHtml(c.name) + '</option>'
        ).join('');
        const genChars = document.getElementById('genChars');
        if (genChars) genChars.innerHTML = charOptions;
        const genResult = document.getElementById('genResult');
        const genBtn = document.getElementById('genBtn');
        const genStopBtn = document.getElementById('genStopBtn');
        if (genResult) genResult.style.display = 'none';
        if (genBtn) genBtn.style.display = 'inline-flex';
        if (genStopBtn) genStopBtn.style.display = 'none';
        this.updateMockBadges();
        this.updateGenContextHint();
        modal.classList.add('show');
    }

    async executeGeneration() {
        const type = document.getElementById('genType')?.value || 'continue';
        const prompt = document.getElementById('genPrompt')?.value.trim() || '';
        const genChars = document.getElementById('genChars');
        const selectedChars = genChars ? Array.from(genChars.selectedOptions).map(o => o.value) : [];
        const genBtn = document.getElementById('genBtn');
        const genStopBtn = document.getElementById('genStopBtn');
        const resultDiv = document.getElementById('genResult');
        const contentDiv = resultDiv ? resultDiv.querySelector('.result-content') : null;

        if (resultDiv) resultDiv.style.display = 'block';
        if (contentDiv) contentDiv.textContent = '';
        if (genBtn) { genBtn.style.display = 'inline-flex'; genBtn.disabled = true; genBtn.textContent = '生成中...'; }
        if (genStopBtn) genStopBtn.style.display = 'inline-flex';
        this.currentAbort = new AbortController();

        try {
            let streamedFull = '';
            const result = await this.callAI(type, prompt, selectedChars, {
                signal: this.currentAbort.signal,
                onChunk: (delta, full) => {
                    streamedFull = full;
                    if (contentDiv) {
                        contentDiv.textContent = full;
                        contentDiv.scrollTop = contentDiv.scrollHeight;
                    }
                }
            });
            // 成功生成；若接口返回空串则回退到已流式输出的内容
            this.generatedContent = this.limitTextLength(
                this.stripChapterHeadings(this.dedupeParagraphs(result || streamedFull || '')), 4500);
            if (contentDiv) contentDiv.textContent = this.generatedContent;
            if (!this.generatedContent) {
                this.showNotification('生成结果为空，请重试或调整提示', 'error');
            } else if (this.generatedContent.length < 3000) {
                this.showNotification('生成完成，共 ' + this.generatedContent.length +
                    ' 字，低于 3000 字；可点「重新生成」或再点一次补足', 'warning');
            } else {
                if (genBtn) genBtn.style.display = 'none';
                this.showNotification('生成完成，共 ' + this.generatedContent.length + ' 字', 'success');
            }
        } catch (error) {
            const stopped = error.message && error.message.indexOf('已停止') >= 0;
            if (streamedFull) {
                // 手动停止或中途出错：保留已生成的部分文字，仍然可以插入编辑器
                this.generatedContent = streamedFull;
                this.showNotification((stopped ? '已停止生成' : '生成失败') +
                    '：已生成 ' + streamedFull.length + ' 字，可插入或点「重新生成」',
                    stopped ? 'info' : 'warning');
            } else if (stopped) {
                this.showNotification('已停止生成', 'info');
            } else {
                this.showNotification('生成失败：' + error.message, 'error');
            }
            if (genBtn) genBtn.style.display = 'inline-flex';
        } finally {
            if (genBtn) { genBtn.disabled = false; genBtn.textContent = '开始生成'; }
            if (genStopBtn) genStopBtn.style.display = 'none';
            this.currentAbort = null;
        }
    }

    /** 停止正在进行的生成 */
    stopGeneration() {
        if (this.currentAbort) {
            this.currentAbort.abort();
            this.showNotification('正在停止...', 'info');
        }
        this.continueLoop = false;   // 兼容旧逻辑：让「连续续写」在当前这段结束后不再开启下一段
        // 续写按钮的状态按「当前章节是否有后台任务」重新计算，不要盲目重置成「AI续写」
        this.refreshTaskUI();
    }

    async callAI(type, userPrompt, selectedChars, opts = {}) {
        const settings = this.getLiveAISettings();
        const memory = this.buildContextMemory();
        const endingMode = this.isEndingRequest(type, userPrompt);
        const typePrompts = {
            continue: '根据前文内容，从最后一句紧接着自然地续写下一段。保持文风一致、推进剧情发展；不要重复前文已有的内容，不要另起新标题，也不要输出空行开头。',
            ending: '先通读【本章全文】，理解本章的人物、场景、冲突与伏笔，然后写出本章的收尾段落：回收本章埋下的关键伏笔与核心冲突，给读者一个阶段性的落点与余味；不要开启新的支线，不要写下一章的开头，也不要复述前文。',
            dialogue: '生成一段角色对话。对话要符合角色性格，推动剧情或展现人物关系。',
            action: '生成一段动作场景描写。注意节奏感和画面感。',
            description: '生成一段环境或场景描写。营造氛围，服务于剧情。',
            psychological: '生成一段心理描写。展现角色的内心活动和情感变化。',
            battle: '生成一段战斗场景。注意战斗逻辑、节奏和紧张感。',
            transition: '生成一段过渡文字。自然地连接前后场景。'
        };
        const stylePrompts = {
            balanced: '文风均衡，描写与叙述并重。',
            descriptive: '文风细腻丰富，注重细节描写。',
            concise: '文风简洁明快，直奔主题。',
            classical: '文风古典文雅，用词考究。',
            modern: '文风现代口语化，通俗易懂。'
        };
        const lengthPrompts = {
            short: '生成约200字的内容。',
            medium: '生成约500字的内容。',
            long: '生成约1000字的内容。',
            chapter: '生成约3000字的完整章节内容。'
        };
        let charInfo = '';
        if (selectedChars.length > 0) {
            const chars = selectedChars.map(id => this.work.characters.find(c => c.id === id)).filter(Boolean);
            charInfo = '\n\n重点角色（身份/性别/关系为硬设定，不得改写）：\n' + chars.map(c => {
                const rel = this.formatCharRelations(c);
                const gender = this.genderLabel(c.gender);
                return c.name + '：身份 ' + (c.occupation || '未设定') +
                    (gender ? '，性别 ' + gender : '') +
                    '；性格 ' + (c.personality || '未设定') +
                    (c.goals ? '；目标 ' + c.goals : '') +
                    (rel ? '；关系 ' + rel : '');
            }).join('\n');
        }
        const longForm = type === 'continue' || endingMode;
        const lengthRule = longForm
            ? '本次正文写 3000~4500 字：必须写到 3000 字以上，最多 4500 字；不足 3000 字不要收尾。'
            : (lengthPrompts[settings.genLength] || lengthPrompts.medium);
        const systemPrompt = '你是一位专业的小说创作助手。请根据提供的上下文信息创作内容。\n' +
            (stylePrompts[settings.writingStyle] || stylePrompts.balanced) + '\n' +
            lengthRule + '\n' +
            '要求：\n1. 保持与设定一致的文风\n2. 角色行为符合其性格设定\n3. 情节要合理推进\n' +
            '4. 不要打破第四面墙\n5. 适当使用描写、对话、心理等手法\n6. 直接输出内容，不要加解释\n' +
            '7. 严禁复述：不得重复「前文」中已出现过的句子、段落或情节，换个说法重复也不行；也不要自我重复（同一句意思只写一次）\n' +
            '8. 若用户给出「本次生成要求」，它是最高优先级，必须实实在在体现在正文里；与上面的长度/文风要求冲突时以它为准（例如要求「收束本章」就应收尾，而不是继续铺开新线索）\n' +
            '9. 角色一致性：姓名、性别、身份、关系必须与设定一致；不得把学生写成广播员/老师等未设定身份，不得改变角色性格\n' +
            '10. 禁止套话：这些词全文中最多出现一次（「微微一笑、轻声、目光、仿佛、似乎、心中涌起、不易察觉、眨了眨眼、耸耸肩、相视一笑、深吸一口气」）；同一句意思只写一次，换个说法重复出现也算重复\n' +
            '11. 严禁输出章节标题（如「第4章」「第4章《…》」）、序号、分隔线、「下一章」之类的内容\n' +
            '12. 场景承接：必须从【前文】最后一句的场景、时间、地点继续；如需时间跳跃，必须用一句话交代，不得突然跳场\n' +
            '13. 严谨用字：不写错别字、不写同音误字，人物姓名必须与【角色档案】完全一致（差一个字也算错）；不确定的词改用常用表达，不要生造词\n' +
            '14. 约束优先：正文只写「本次生成要求」指定的内容；未要求的转折、角色、场景一律不写；每段都必须服务于约束，禁止为凑字数添加无关描写\n' +
            '15. 开头禁忌：严禁用时间过渡套话开场（如「夜色渐深」「时光飞逝」「转眼间」「第二天」「清晨的阳光」「夜幕降临」「华灯初上」）；第一句必须是此刻正在发生的动作、对话或眼前细节\n' +
            '16. 情绪衔接禁忌：前文最后一段若是抒情、总结、感慨式收尾，不要顺着再抒情/再总结；下一句必须落到具体动作、对话或场景细节上，把情节继续往前推\n' +
            '【标点规范】对话、心理活动、引用一律使用中文全角引号“”或「」，禁止输出英文半角双引号 " 与单引号 \' ；所有标点均使用中文全角（包括逗号、句号、叹号、问号、书名号）' +
            (longForm
                ? '\n17. 先通读再动笔：先通读【本章全文】（或【本章脉络】+【本章结尾】），在心里梳理时间线、地点、在场人物、各自的处境与目标，以及最后一句正在发生的动作；续写必须顺着这条线往下走，不得跳回更早的场景，不得与已经发生的事实矛盾（谁在场、谁受伤、天色、地点、已说过的承诺）\n' +
                  '18. 紧接上文：第一句必须直接接住最后一句的动作/对话/情绪，写「紧接着发生的事」；不要重新进场景、不要重新介绍人物、不要复述任何已经写过的内容\n' +
                  '19. 用词去重：本章已反复出现的词、比喻、反应句（见【本章禁用表达】）本次一律不再使用；同一个形容词或动作在一段里最多出现一次；人物对话不要每句都用「他说/她说/XX说」，用动作、语气或直接对话带出说话人\n' +
                  '20. 句式节奏：长短句交替，避免连续三句同一结构；每段至少有一处具体感官细节（声音、温度、光线、触感、气味），不要用空泛形容词堆砌情绪'
                : '');
        // 前文来源：同一页可能有多个章节在并行续写，所以优先用调用方传入的「该任务自己的正文」
        // （opts.contextText）；只有没传时才退回编辑器里「尚未保存的最新正文」。
        const ta = document.getElementById('chapterContent');
        const liveContent = (typeof opts.contextText === 'string')
            ? opts.contextText
            : ((ta && typeof ta.value === 'string' && ta.value.trim())
                ? ta.value
                : ((this.currentChapter && this.currentChapter.content) || ''));
        // 上下文范围：续写与收束都要求模型「先通读本章全文」，再接着最后一句往下写。
        // 章节短 → 原文全给；章节长 → 开头原文 + 中段段落骨架 + 结尾原文（仍覆盖全章脉络），
        // 这样模型不会只看到尾巴就瞎写，也不会因为上下文超限而丢设定。
        const settings0 = this.getLiveAISettings();
        const isLocalModel = this.isLocalApiUrl(this.normalizeApiBase(settings0.apiUrl || ''));
        const CHAPTER_CONTEXT_LIMIT = isLocalModel ? 9000 : 18000;
        const chartTruncated = liveContent.length > CHAPTER_CONTEXT_LIMIT;
        // 空章节不能"从新场景开始写"——那正是每章都以「清晨的阳光」重开的根源。
        // 改为接上一章结尾继续，模型才有真实的前情可续。
        const isBlankChapter = !liveContent.trim();
        const prevTail = isBlankChapter ? String(opts.prevTail || '') : '';
        const rawContext = !isBlankChapter
            ? this.buildFullChapterContext(liveContent, CHAPTER_CONTEXT_LIMIT)
            : (prevTail
                ? '【上一章结尾（本章还没有正文：请从这里接着往下写，不要重新开场、不要重写已经发生过的清晨/起床/进办公室等场面）】\n' + prevTail
                : '（本章还没有正文；请从上一章结束之后接着写，不要重写一个早晨、也不要另起一个新场景的开场白）');
        // 上下文里去掉章节标题行，避免模型照着抄「第4章《…》」
        const currentContent = this.stripChapterHeadings(rawContext) || rawContext;
        const parts = [
            memory,
            endingMode ? typePrompts.ending : (typePrompts[type] || typePrompts.continue),
            charInfo,
            // 把「先通读、再续接」变成可执行的流程，而不是一句泛泛的要求
            longForm
                ? '【续写流程（必须按顺序执行）】\n' +
                  '1. 先通读下面的「' + (isBlankChapter ? '上一章结尾' : '本章全文') + '」' + (chartTruncated ? '（中段是按段落抽出的剧情骨架，用来把握脉络）' : '') + '；\n' +
                  (isBlankChapter
                      ? '2. 在心里用一句话概括：上一章最后停在哪、谁在场、下一步要发生什么；本章第一段就是那件事的继续，不是新的早晨；\n'
                      : '2. 在心里用一句话概括：此刻谁、在哪、正在做什么、手里/心里还悬着什么；\n') +
                  '3. 从最后一句之后紧接着写「下一步发生的事」，时间、地点、在场人物必须与上文对得上；\n' +
                  '4. 写的时候避开本章已用过的句子、比喻和反应句，不复述、不总结、不重新开场。'
                : '',
            (endingMode ? '【本章全文（请通读，禁止复述其中任何句子）】\n' : '【本章全文（仅供衔接，禁止复述其中任何句子）】\n') + currentContent,
            // 已有章节的开场句清单：防止每章都用同一句「清晨的阳光……」重新开篇
            longForm ? this.buildOpeningBanNotice(this.findWorkById(opts.workId || (this.work && this.work.id))) : '',
            // 本章已反复出现的套话 / 高频用词：动态禁用，避免每轮都复用同一批表达
            this.buildBannedPhraseNotice(liveContent)
        ];
        parts.push(endingMode
            ? '【输出要求】紧接「本章全文」最后一句之后写本章结尾；把当前冲突/伏笔收住，不要开启新支线；只输出结尾正文，不要标题、序号、解释，也不要写「下一章」的引子。'
            : '【输出要求】直接从「前文」最后一句之后接着写；第一句不能是前文内容的重复或改写；' +
              '第一句必须是此刻正在发生的动作、对话或眼前细节，严禁用「夜色渐深/转眼间/第二天/清晨的阳光」这类时间过渡套话开场；' +
              '只输出正文，不要标题、序号、解释，也不要「续写」「前文」之类的字样。');
        // 「生成提示」拆成编号约束，放在 prompt 最末尾，逐条执行
        const constraints = this.parseConstraints(userPrompt);
        if (constraints.length) {
            parts.push('【本次生成要求（最高优先级，逐条执行，禁止自由发挥）】\n' +
                constraints.map((c, i) => (i + 1) + '. ' + c).join('\n') + '\n' +
                '执行规则：以上每一条都必须落实；不得遗漏、不得只做一部分；不得添加要求之外的情节/角色/设定；完成后逐条自检。');
        }
        const fullPrompt = parts.filter(Boolean).join('\n\n');
        const apiOpts = Object.assign({}, opts);
        if (longForm && !apiOpts.maxTokens) apiOpts.maxTokens = 5000;
        if (apiOpts.noExtend) delete apiOpts.noExtend;
        const raw = await this.callAIAPI(systemPrompt, fullPrompt, settings, apiOpts);
        // 去复述、去重复段落、去模型自带的章节标题
        let finalText = this.stripChapterHeadings(
            this.dedupeParagraphs(this.stripRepeatedLead(raw, liveContent))
        );
        // 不足 3000 字时自动补写一次（quickContinue 自己控制轮次，传 noExtend 跳过）
        if (longForm && !opts.noExtend && finalText.length < 3000 &&
            !(opts.signal && opts.signal.aborted)) {
            const need = 3000 - finalText.length;
            const extendPrompt = fullPrompt + '\n\n【已写正文（禁止重复，接着往下写）】\n' + finalText +
                '\n\n【补写要求】当前只有 ' + finalText.length + ' 字，至少再补 ' + need +
                ' 字，使总字数达到 3000 字以上、不超过 4500 字；保持同一场景与文风，不得重复已有句子。';
            try {
                const more = await this.callAIAPI(systemPrompt, extendPrompt, settings,
                    Object.assign({}, apiOpts, { maxTokens: Math.min(3000, Math.ceil(need * 1.6)), onChunk: () => {} }));
                if (more) {
                    finalText = finalText + '\n\n' +
                        this.stripChapterHeadings(this.dedupeParagraphs(this.stripRepeatedLead(more, finalText)));
                }
            } catch (e) { /* 补写失败则保留已有内容 */ }
        }
        // 兜底：任何路径产生的编码损坏字符都不许进入正文
        finalText = this.stripBrokenChars(finalText);
        if (longForm) finalText = this.trimIncompleteTail(finalText);
        // 去掉与本章正文重复的段落（AI 循环续写常把同一个场景再写一遍）
        finalText = this.removeRepeatedAgainstChapter(finalText, liveContent);
        // 兜底：模型仍用套路句 / 别章用过的开场句起笔时直接跳过这一段，
        // 否则每章都会以「清晨的阳光透过窗户……」重新开篇
        if (longForm && finalText.trim()) {
            const openings = this.collectChapterOpenings(this.work);
            const fixedOpening = this.stripFormulaicOpening(finalText, openings);
            if (fixedOpening && fixedOpening !== finalText) {
                finalText = fixedOpening;
                this.showNotification('已自动跳过套路化开场（清晨的阳光 / 与已有章节重复的开场句）', 'info');
            }
        }
        if (finalText) this.warnIfClichéHeavy(finalText, '本次输出');
        // 错别字：本地确定性修正 + 模型校对一遍。
        // 连续续写每轮都会自己修一次，传 noProofread 可跳过多余的 AI 校对请求（多章并行时很关键）
        if (finalText && !opts.noProofread) {
            const typo = await this.polishTypos(finalText, '本次输出');
            finalText = typo.text;
        }
        return this.limitTextLength(finalText, 4500);
    }

    /** 是否要求「收束/结束本章」：显式类型，或提示词命中关键词 */
    isEndingRequest(type, prompt) {
        if (type === 'ending') return true;
        return /收束|收尾|结尾|结束本章|本章结束|本章收尾|告一段落|做个了结/.test(String(prompt || ''));
    }

    /** 单次 AI 续写的字数范围 */
    getContinueBounds() {
        return { min: 3000, max: 4500 };
    }

    /** 按句末标点截断到 maxChars 以内，尽量不截半句 */
    limitTextLength(text, maxChars) {
        const t = String(text || '');
        if (!maxChars || t.length <= maxChars) return t;
        const cut = t.slice(0, maxChars);
        const idx = Math.max(
            cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'),
            cut.lastIndexOf('…'), cut.lastIndexOf('\n')
        );
        return idx >= Math.floor(maxChars * 0.6) ? cut.slice(0, idx + 1) : cut;
    }

    /** 去掉结尾没写完的半句（模型撞到 max_tokens 时常见） */
    trimIncompleteTail(text) {
        const t = String(text || '').trim();
        if (!t) return t;
        if (/[。！？…”』」]$/.test(t)) return t;
        const idx = Math.max(t.lastIndexOf('。'), t.lastIndexOf('！'), t.lastIndexOf('？'), t.lastIndexOf('…'));
        return idx >= 0 ? t.slice(0, idx + 1) : t;
    }

    /** 去掉生成文本中完全重复的段落（模型原地打转时最常见） */
    dedupeParagraphs(text) {
        const paras = String(text || '').split(/\n\s*\n/);
        const seen = new Set();
        const out = [];
        for (const raw of paras) {
            const p = raw.trim();
            if (!p) continue;
            const key = p.replace(/\s+/g, '');
            if (key.length >= 20 && seen.has(key)) continue;
            seen.add(key);
            out.push(p);
        }
        return out.join('\n\n');
    }

    /* ============ 错别字防线 ============ */

    /** 常见同音/近形错别字表（只收高频且几乎不会误伤的） */
    getCommonTypoMap() {
        return {
            // 只收「本身不是任何正常用词」的别字。
            // 反面教材：'在也'=>再也 会把「现在也没」改成「现再也没」，
            // '在见'=>再见 会把「在见识」改成「再见识」，'坐位'=>座位 会把「坐位子上」改成「座位子上」。
            // 凡是某个别字同时是正常用词的子串，一律不收，交给有上下文的 AI 校对去判断。
            '己经': '已经', '以经': '已经', '自已': '自己', '自巳': '自己',
            '名子': '名字',
            '那怕': '哪怕', '象貌': '相貌', '好象': '好像',
            '竟争': '竞争', '按装': '安装', '既使': '即使',
            '暴漏': '暴露', '一如继往': '一如既往', '心浮气燥': '心浮气躁',
            '精神焕散': '精神涣散', '疲倦不堪': '疲倦不堪', '小心义义': '小心翼翼',
            '受益非浅': '受益匪浅', '相形见拙': '相形见绌', '穿流不息': '川流不息',
            '兴高彩烈': '兴高采烈', '走头无路': '走投无路', '再接再励': '再接再厉',
            '永往直前': '勇往直前', '换然一新': '焕然一新', '自立更生': '自力更生',
            '各书己见': '各抒己见', '灰心伤气': '灰心丧气', '直接了当': '直截了当',
            '义气用事': '意气用事', '记念': '纪念',
            '既往不究': '既往不咎', '遗笑大方': '贻笑大方', '委屈求全': '委曲求全',
            '声音日記': '声音日记', '部份': '部分', '按耐不住': '按捺不住', '暗然失色': '黯然失色',
            '白晰': '白皙', '一摸一样': '一模一样', '记算': '计算',
            '烦脑': '烦恼', '糊塗': '糊涂',
            // AI 生成里高频出现的「漏字」：人物名后直接跟副词却说「趣地说」
            '趣地说': '打趣地说',
            // AI 生成中文小说时高频出现的形近/音近错字（都是无歧义的通用词，按固定表替换安全）
            '帐蓬': '帐篷', '安祥': '安详', '沉缅': '沉湎', '粗旷': '粗犷', '峻工': '竣工',
            '狼籍': '狼藉', '罗嗦': '啰嗦', '莫明其妙': '莫名其妙',
            '霓红灯': '霓虹灯', '徘回': '徘徊', '倾刻': '顷刻', '撒骄': '撒娇', '闪铄': '闪烁',
            '甚致': '甚至', '签暑': '签署', '铁揪': '铁锹', '通霄': '通宵', '蜿延': '蜿蜒',
            '嘻戏': '嬉戏', '朔洗': '洗漱', '消毁': '销毁', '心季': '心悸',
            '宣嚣': '喧嚣', '悬掉': '悬挂', '宣染': '渲染', '一揽无余': '一览无余',
            '追朔': '追溯', '姿式': '姿势', '兹润': '滋润', '子细': '仔细', '自毫': '自豪',
            '总然': '纵然', '阻寒': '阻塞', '作崇': '作祟', '只尺': '咫尺', '义器': '仪器',
            '愚味': '愚昧', '元霄': '元宵', '愠酿': '酝酿', '支掌': '支撑', '温揉': '温柔',
            '稳键': '稳健', '诱或': '诱惑', '忐忐': '忐忑', '调济': '调剂',
            '寂漠': '寂静', '布署': '部署',
            // 真实案例：把「跟校医理论」写成「跟校理论理」（两字颠倒）
            '校理论理': '校医理论'
        };
    }

    /**
     * 这些正常用词里含有「别字子串」。正文里只要出现它们，就禁止做会把它们打碎的替换。
     * 例：正文有「现在也没」时不许把「在也」换成「再也」；有「低语到天亮」时不许换成「低语道天亮」。
     * 这是给「子串替换」这类纠错上的通用保险，本地表和 AI 校对都走这里。
     */
    getTypoGuardPhrases() {
        return ['现在也', '在也好', '在也罢', '在次日', '在其次', '在见识', '在见过', '在见解', '在见面',
                '由中间', '由中心', '由中断', '坐位子', '坐位上', '坐位', '低语到', '自言自语到', '开口到',
                '喃喃自语到', '沉默寡言', '涩涩地', '沉默', '羞色', '由中场', '由中医'];
    }

    /** 一次替换是否会破坏正文里的正常用词 */
    isRiskyReplacement(from, text) {
        const f = String(from || '');
        if (f.length < 2) return false;
        const src = String(text || '');
        return this.getTypoGuardPhrases().some(p => p.indexOf(f) >= 0 && src.indexOf(p) >= 0);
    }

    /** 收集作品里的专有名词（角色名/别名/章节标题/作品名），用于识别人名写错 */
    collectProperNouns() {
        const names = new Set();
        const add = (s) => {
            const t = String(s || '').trim();
            if (t.length >= 2 && t.length <= 6 && /^[\u4e00-\u9fa5A-Za-z·]+$/.test(t)) names.add(t);
        };
        (this.work.characters || []).forEach(c => { add(c.name); add(c.alias); });
        (this.work.chapters || []).forEach(ch => add(ch.title));
        add(this.work.novel && this.work.novel.title);
        return [...names];
    }

    /** 常见词保护名单：這些人名近似写法本身就是正常词，不能改 */
    properNounStopExtra() {
        return ['陆地', '岛屿', '思考', '思念', '林间', '夏季', '半夏', '知了', '知识',
                '闻名', '远亲', '周家', '明显', '明月', '明亮', '留念', '纪念', '周年',
                '林叶', '知音', '声音', '音色', '夏夜', '夜里', '夜晚', '晚间',
                '陆路', '岛屿', '陈年', '旧事', '念书', '书页', '页码'];
    }

    /**
     * 删掉「整段重复」：长文生成时模型经常把一整句/一整段原样再写一遍
     * （真实事故：同一段对话在章里出现两次、同一场交涉换个说法再来一遍）。
     * 归一化后完全相同的行只保留第一次；为保留「首尾呼应」这种正常写法，
     * 开头第一行与最后三行不参与去重。
     */
    dropDuplicateParagraphs(text) {
        const src = String(text || '');
        if (!src.trim()) return src;
        const lines = src.split('\n');
        if (lines.length < 6) return src;
        const norm = (s) => String(s || '').replace(/[\s，。！？、；：“”‘’「」『』…—~,.!?;:'"()（）]/g, '');
        const seen = {};
        const guardTail = lines.length - 3;
        const kept = [];
        lines.forEach((line, i) => {
            const k = norm(line);
            if (k.length >= 12 && i >= 1 && i < guardTail) {
                if (seen[k]) return;
                seen[k] = 1;
            }
            kept.push(line);
        });
        return kept.join('\n');
    }

    /** 常见姓氏：用于识别「姓氏对得上、名字写错」这类姓名笔误 */
    getSurnameChars() {
        return '林陈周苏李王张刘吴孙郑赵黄何高罗梁谢唐韩冯曾萧程蔡彭潘袁董余叶杜戴夏钟田胡凌霍虞万管卢莫房裘应宗丁宣邓郁单杭洪包诸左石崔吉龚嵇邢滑裴陆荣翁荀羊惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符景詹束龙';
    }

    /** 「姓氏+X」构成的正常词：正文出现它们时，不许把 X 改成角色名 */
    getNameStopWords() {
        return ['林业', '林立', '林肯', '林场', '林间', '林叶', '林子', '雨林', '林荫', '凌晨', '林立',
            '陈列', '陈年', '陈旧', '陈设', '陈词', '陈醋', '陈规', '周期', '周年', '周全', '周末', '周边',
            '周围', '周报', '周旋', '苏州', '苏醒', '江苏', '李子', '行李', '桃李', '王者', '王牌', '君王',
            '大王', '张望', '紧张', '张扬', '开张', '郑重', '黄色', '黄昏', '何时', '高手', '高度', '罗列',
            '谢谢', '拒绝', '唐朝', '曾经', '萧条', '程度', '任何', '余额', '叶子', '杜绝', '夏夜', '钟头',
            '田地', '陵墓', '万一', '管理', '命令', '房子', '解决', '龙门', '自己', '自然', '自信', '自我',
            '自由', '海洋', '游戏', '中央', '中午', '高中'];
    }

    /**
     * 人名误写检查：候选串是否「角色名的笔误」。
     * 与旧的同音判断互为补充——同音判断管「读音写错」，这里管「形近写错/漏字」：
     *   林简→林栀（形近）、陈橙→陈橙橙（漏末字）。
     * 三道保险让它不会误伤正文：
     *   1) 姓氏必须对得上（中文人名姓在前，正常用词极少能同时满足「同姓 + 只差一字」）；
     *   2) 候选不能是「姓氏+X」类正常词，也不能是别的角色名；
     *   3) 原型名要在文中出现 ≥3 次，而笔误写法只能出现 ≤2 次。
     */
    isNameTypo(cand, name, names, src) {
        if (!cand || !name || cand === name) return false;
        if (cand.length < 2 || cand.length > 4) return false;
        if (names.indexOf(cand) >= 0) return false;                 // 本来就是别的角色名
        if (this.getNameStopWords().indexOf(cand) >= 0) return false;
        if (this.isRiskyReplacement(cand, src)) return false;
        if (this.getSurnameChars().indexOf(cand[0]) < 0) return false;   // 姓氏必须对得上
        if (cand[0] !== name[0]) return false;
        if (this.countOccur(src, name) < 2) return false;           // 原型名得是立住的人物
        if (cand.length === name.length) {
            let diff = 0, pos = -1;
            for (let k = 0; k < name.length; k++) {
                if (cand[k] !== name[k]) { diff++; pos = k; }
            }
            if (diff !== 1) return false;
            // 写错的那个字不能是高频虚词：「是鱼」「的字」这类正常用词片段就是被这条拦住的
            if ('的是了在和有我你他她它这那不就很都也太上中下大小来去说看吃喝买卖走跑坐站起里外前后个把被让从对着跟为以所与及或但如若因所以着'.indexOf(cand[pos]) >= 0) return false;
            // 笔误落在候选最后一个字，且这个字是常见动作词时，多半不是名字写错，
            // 而是「名字漏了末字 + 后面的动作」：陈橙橙 写成「陈橙挑眉」时该修的是「陈橙」，
            // 而不是把整串改成「陈橙橙」（那样会把「挑」吃掉）。这类交给漏字路径处理。
            if (pos === cand.length - 1 &&
                '挑眉笑说问答看放眼走站坐抬低点摇皱沉愣怔叹喊叫应转回醒住停伸摸拿放推拉拽抱牵陪劝骂夸赞冲朝奔跑退进出入睡咳嗽摇'.indexOf(cand[pos]) >= 0) return false;
            return (this.countOccur(src, cand) - this.countOccur(src, name)) <= 2;
        }
        // 漏字：候选正好是角色名去掉最后一个字（陈橙 → 陈橙橙）
        if (cand.length === name.length - 1 && name.slice(0, cand.length) === cand) {
            return (this.countOccur(src, cand) - this.countOccur(src, name)) <= 2;
        }
        return false;
    }
    /**
     * 签约自检：按网文编辑实际评审标准给正文打分。
     * 返回 [{ name, ok, detail, level }]，level=block 是编辑一眼就会拒的硬伤。
     * 用途：提交签约前自己先过一遍，避免浪费签约机会。
     */
    auditTextForSigning(text) {
        const src = String(text || '');
        const len = src.length;
        if (!src.trim()) return [{ name: '正文', ok: false, detail: '没有可检查的正文', level: 'block' }];
        const out = [];
        const add = (name, ok, detail, level, data) => out.push({
            name: name, ok: !!ok, detail: detail, level: level || 'warn', data: data || null
        });
        const per1k = (n) => len ? (n / (len / 1000)) : 0;
        const paras = src.split('\n').filter(p => p.trim());

        // 1) 标点：英文引号 / 「..」省略号是 AI 生成最直接的指纹
        const asciiQuote = src.split('"').length - 1;
        const asciiSingle = src.split("'").length - 1;
        const dotEllipsis = (src.match(/\.{2,}|。{3,}/g) || []).length;
        const cnOpen = src.split('\u201c').length - 1;
        const cnClose = src.split('\u201d').length - 1;
        add('标点规范（英文引号 / 省略号）',
            asciiQuote === 0 && asciiSingle === 0 && dotEllipsis === 0 && Math.abs(cnOpen - cnClose) <= 1,
            '英文双引号 ' + asciiQuote + ' 个、英文单引号 ' + asciiSingle + ' 个、「..」省略号 ' + dotEllipsis +
            ' 个、全角引号 ' + cnOpen + '/' + cnClose + ' 对（前三项必须为 0）', 'block');

        // 2) AI 套话密度
        const cliches = ['微微一笑', '轻声', '目光', '一丝', '似乎', '仿佛', '不禁', '微微', '轻轻', '嘴角',
            '习惯性', '难以言状', '勾起', '闪过', '涌起', '深吸', '氤氲', '弥漫', '思绪', '氛围', '侧脸', '心跳'];
        let total = 0; const hits = [];
        cliches.forEach(w => {
            const c = src.split(w).length - 1;
            if (c) { total += c; hits.push(w + '×' + c); }
        });
        hits.sort((a, b) => parseInt(b.split('×')[1]) - parseInt(a.split('×')[1]));
        // data.words 供「定向修补」按词表逐词替换用
        const wordData = hits.map(h => ({ w: h.split('×')[0], n: parseInt(h.split('×')[1]) }));
        add('AI 套话密度', per1k(total) < 1,
            '共 ' + total + ' 处、' + per1k(total).toFixed(1) + ' 次/千字（应低于 1）；最频繁：' +
            hits.slice(0, 6).join('、'), 'block', { words: wordData });

        // 3) 跨段原句复读（模型抄自己）
        const lines = src.split('\n');
        const norm = (s) => String(s).replace(/[\s，。！？、；：""''「」『』…—~,.!?;:'"()（）]/g, '');
        const freq = {};
        lines.forEach(l => {
            const k = norm(l);
            if (k.length >= 12) freq[k] = (freq[k] || 0) + 1;
        });
        const dupLines = Object.keys(freq).filter(k => freq[k] >= 2);
        add('重复段落 / 台词', dupLines.length === 0,
            dupLines.length + ' 段与前文完全相同（应为 0）' +
            (dupLines.length ? '，例：' + dupLines.slice(0, 2).map(k => k.slice(0, 28)).join(' / ') : ''), 'block');

        // 4) 开篇钩子：前 300 字内必须有冲突/悬念/反常，且不许用时间+天气起笔
        const bodyHead = src.replace(/^\s*第[0-9一二三四五六七八九十百千]+章[^\n]*\n+/, '').slice(0, 300);
        const weatherOpen = /^\s*(清晨|早晨|上午|中午|下午|傍晚|黄昏|夜里|深夜|凌晨|天刚亮|这天|那天|第二天|次日|转眼)/.test(bodyHead.trim());
        const hookWords = /(突然|忽然|竟然|才发现|不可能|为什么|谁知|谁料|不料|下一秒|猛的|猛地|一把|一头|不对劲|不对|从没|从来没|明明|冷汗|手心|攥|缩|僵|屏住|发抖|发凉|血迹|不见|消失|拦住|堵|闯|抢|摔|喊|逼|压|喘|谁|哪|锁|半截|少了一|多了一)/;
        const hasHook = hookWords.test(bodyHead);
        add('开篇 300 字内有钩子', hasHook && !weatherOpen,
            (weatherOpen ? '用了时间+天气起笔；' : '') +
            (hasHook ? '前 300 字有悬念或冲突' : '前 300 字只有日常描写，没有冲突/悬念/反常'), 'block');

        // 4.5) 章节三段结构（总—分—总）：开头有钩子 + 中间有剧情展开 + 结尾收束，不能只剩开头+结尾
        const tailText = src.slice(-220);
        const tailEndsWell = /[。！？]/.test(tailText.slice(-80));
        const tooShort = len < 1200;
        add('章节三段结构（开头/剧情/结尾）', !tooShort && tailEndsWell && hasHook,
            (tooShort ? '全文仅 ' + len + ' 字，难以容纳开头+剧情+结尾；' : '') +
            (hasHook ? '开头有钩子；' : '开头缺钩子；') +
            (tailEndsWell ? '结尾已收束' : '结尾 220 字内未见句末标点，疑似被截断/未收束'), 'warn');

        // 4.6) 结局完整 / 关键剧情收束（平台重点治理：仓促收尾、敷衍草率终止）
        const tail300 = src.slice(-300);
        const perfunctory = /今天先这样|日子就这样过去|就这样结束了|算是结束了|暂告一段落|到此为止/.test(tail300);
        const endsWithPunct = /[。！？]/.test(src.replace(/\s+$/, '').slice(-1));
        add('结局完整/关键剧情收束', !perfunctory && endsWithPunct,
            (perfunctory ? '结尾含敷衍式收束语（今天先这样/就这样结束等），属平台重点治理的仓促收尾；' : '') +
            (endsWithPunct ? '结尾有句末标点、未戛然而止' : '结尾疑似被截断、未正常收束'), 'block');

        // 4.7) 文笔空洞 / 词藻堆砌（平台重点治理：行文冗余、词藻堆砌）
        const empties = ['深邃', '神秘', '阴沉', '诡异', '精致', '微妙', '难以言喻', '氤氲', '弥漫', '空灵', '寂寥', '苍凉', '悲凉', '萧索', '肃杀', '幽深', '缥缈', '斑驳', '嶙峋'];
        let empTotal = 0; const empHit = [];
        empties.forEach(w => { const c = src.split(w).length - 1; if (c) { empTotal += c; empHit.push(w + '×' + c); } });
        empHit.sort((a, b) => parseInt(b.split('×')[1]) - parseInt(a.split('×')[1]));
        add('文笔空洞/词藻堆砌', per1k(empTotal) < 1.5,
            '空泛高级形容词（深邃/神秘/阴沉…）共 ' + empTotal + ' 处、' + per1k(empTotal).toFixed(1) +
            '/千字（应 < 1.5）；最多：' + empHit.slice(0, 6).join('、'), 'warn');

        // 4.8) 句式多样性（平台重点治理：句式呆板）
        const sents = src.split(/[。！？]/).map(s => s.replace(/\s/g, '').length).filter(n => n > 0);
        let stiff = '通过';
        if (sents.length >= 10) {
            const mean = sents.reduce((a, b) => a + b, 0) / sents.length;
            const variance = sents.reduce((a, b) => a + (b - mean) * (b - mean), 0) / sents.length;
            const cv = Math.sqrt(variance) / mean;
            if (cv < 0.35) stiff = '句长过于整齐（变异系数 ' + cv.toFixed(2) + '，<0.35），疑似句式呆板';
            else if (mean > 42) stiff = '平均句长 ' + mean.toFixed(0) + ' 字偏长，节奏沉闷';
        }
        add('句式多样性', stiff === '通过', stiff, 'warn');

        // 5) 旁白式解说（编辑叫"作者在替读者做题"）
        const telling = (src.match(/[她他](知道|明白|清楚|意识到)/g) || []).length +
            (src.match(/大家都知道|谁都看得出来|足以说明|这说明/g) || []).length;
        add('旁白式解说', per1k(telling) < 1,
            '「她知道/他明白/这说明」类 ' + telling + ' 处、' + per1k(telling).toFixed(1) + ' 次/千字（应 < 1）', 'warn');

        // 5.5) 全知叙述者剧透 / 旁白总结句（"她在替读者做事"的另一面：跳出来剧透或收束）
        const intrude = (src.match(/她不知道的是|他不知道的是|殊不知|读者会(明白|知道|看出)|不用说读者|之谜解开了|故事还没完|谜底/g) || []).length;
        add('全知剧透/旁白总结', intrude === 0,
            '全知叙述者剧透或旁白收束句 ' + intrude + ' 处（应为 0；秘密要让角色自己发现，叙述者不能跳出来剧透或总结）', 'block');

        // 6) 标签式人设
        const tagChar = (src.match(/表面[^。，]{0,12}(实则|其实|实际上)/g) || []).length +
            (src.match(/外人眼中|在别人眼里|所有人都以为/g) || []).length;
        add('人设不标签化', tagChar <= 2,
            '「表面X实则Y / 外人眼中」类 ' + tagChar + ' 处（别超过 2）', 'warn');

        // 7) 对白占比
        const dlg = src.match(/[\u201c"][^\u201d"]{1,60}[\u201d"]/g) || [];
        const dlgLen = dlg.reduce((s, x) => s + x.length, 0);
        const ratio = len ? (dlgLen / len * 100) : 0;
        add('对白占比', ratio <= 35,
            '对白约占 ' + ratio.toFixed(0) + '%（应低于 35%，靠情节推进而不是问答）', 'warn');

        // 7.5) 乒乓式对话（AI 生成最典型的指纹）：连续多段都是「引号+说话人」的纯对话回合
        //      判定：段落含引号，且去掉引号后只剩下说话人标签（长度≤8 且无叙述性标点），几乎没有叙述。
        const isPureTurn = (p) => {
            if (p.indexOf('\u201c') < 0 && p.indexOf('"') < 0) return false; // 不含引号不算
            const quoteChars = (p.match(/[\u201c"][^\u201d"]{1,40}[\u201d"]/g) || [])
                .reduce((s, x) => s + x.length, 0);
            const remainder = p.replace(/[\u201c"][^\u201d"]{1,40}[\u201d"]/g, '');
            // 引号之外只剩「林晚问。」这类短标签、且不含叙述性标点（，：、；——）才算纯对话回合
            return remainder.length <= 8 && /[，：、；—]/.test(remainder) === false;
        };
        let maxRun = 0, curRun = 0;
        paras.forEach(p => {
            if (isPureTurn(p)) { curRun++; if (curRun > maxRun) maxRun = curRun; }
            else curRun = 0;
        });
        add('乒乓式对话', maxRun <= 3,
            '最长连续纯对话回合 ' + maxRun + ' 段（应 ≤ 3；连续一问一句对答是 AI 指纹，编辑会拒）', 'block', { maxRun: maxRun });

        // 7.6) AI 复述动作/镜头：同一组「手指飞舞/嗡鸣/眼中红光/没有时间了」反复刷屏
        const tells = this.getAiTells();
        const tellHits = [];
        let tellTotal = 0;
        tells.forEach(t => {
            const c = (src.match(t.re) || []).length;
            if (c) { tellTotal += c; tellHits.push(t.label + '×' + c); }
        });
        add('AI 复述动作/镜头', per1k(tellTotal) < 1.2,
            '「手指飞舞/嗡鸣/眼中红光/没有时间了」类 ' + tellTotal + ' 处、' + per1k(tellTotal).toFixed(1) +
            ' 次/千字（应 < 1.2）；最频繁：' + tellHits.slice(0, 5).join('、'), 'warn');

        // 7.7) 角色自我相遇 / 重复出场（长文生成最常见的连续性硬伤，编辑会直接拒）
        const selfMeet = this.detectSelfMeeting(src);
        add('角色自我相遇/重复出场', selfMeet.length === 0,
            selfMeet.length ? ('以下角色既去敲门/到门前，门开后里面出来的又是他自己：' + selfMeet.join('、') +
                '——这是「角色自己遇到自己」的硬伤，必须删掉重复出场、统一为已在该队伍/已认识')
                : '未检测到角色自我相遇', 'block');

        // 8) 段落节奏：番茄是手机阅读，1-3 句一段最合适；碎成一个词一段、或整段不分行都要改
        const avg = paras.length ? (len / paras.length) : 0;
        add('段落节奏', avg >= 25 && avg <= 150,
            '平均段长 ' + avg.toFixed(0) + ' 字（手机阅读建议 25-150 字；低于 25 是碎片化，高于 150 是大段不分行）', 'warn');
        return out;
    }

    /** 整本签约自检：逐章跑 auditTextForSigning，汇总成弹窗报告 */
    runSigningAudit() {
        const chapters = ((this.work && this.work.chapters) || []).slice()
            .sort((a, b) => (a.number || 0) - (b.number || 0));
        if (!chapters.length) { this.showNotification('当前作品还没有章节', 'warning'); return; }
        const all = chapters.map(ch => ({
            ch: ch,
            items: this.auditTextForSigning(ch.content || '')
        }));
        const isBlock = (x) => x.items.some(i => !i.ok && i.level === 'block');
        const isWarn = (x) => !isBlock(x) && x.items.some(i => !i.ok);
        const badChapters = all.filter(isBlock);
        const warnChapters = all.filter(isWarn);
        const goodChapters = all.filter(x => !isBlock(x) && !isWarn(x));
        const totalWords = chapters.reduce((s, c) => s + (c.content || '').length, 0);

        let html = '<div class="audit-summary">' +
            '<span class="audit-chip ok">通过 ' + goodChapters.length + ' 章</span>' +
            '<span class="audit-chip warn">待改 ' + warnChapters.length + ' 章</span>' +
            '<span class="audit-chip bad">硬伤 ' + badChapters.length + ' 章</span>' +
            '<span class="audit-chip">全书 ' + totalWords.toLocaleString() + ' 字</span></div>';
        const group = (title, list, cls) => {
            if (!list.length) return '';
            let h = '<div class="audit-group ' + cls + '"><h4>' + title + '（' + list.length + '）</h4>';
            list.forEach(x => {
                h += '<div class="audit-ch"><b>第' + (x.ch.number || '?') + '章 ' +
                    this.escapeHtml(x.ch.title || '未命名') + '</b><ul>' +
                    x.items.filter(i => !i.ok).map(i => '<li class="' + (i.level === 'block' ? 'lv-block' : 'lv-warn') + '">' +
                        this.escapeHtml(i.name) + '：' + this.escapeHtml(i.detail) + '</li>').join('') + '</ul></div>';
            });
            return h + '</div>';
        };
        html += group('硬伤（编辑一眼就会拒）', badChapters, 'is-block') +
            group('可以更好', warnChapters, 'is-warn') +
            group('全部通过', goodChapters, 'is-ok');
        const box = document.getElementById('signingAuditBody');
        const modal = document.getElementById('signingAuditModal');
        if (!box || !modal) { this.showNotification('自检面板不存在', 'error'); return; }
        box.innerHTML = html;
        modal.classList.add('show');
        this.showNotification('签约自检：硬伤 ' + badChapters.length + ' 章、待改 ' + warnChapters.length +
            ' 章、通过 ' + goodChapters.length + ' 章', badChapters.length ? 'warning' : 'success');
    }

    /** 计算某段正文的对白占比（%）：沿用自检里的同一把尺子，保证「查」和「修」口径一致 */
    getDialogueRatio(text) {
        const s = String(text || '');
        if (!s) return 0;
        const dlg = s.match(/[“"][^”"]{1,60}[”"]/g) || [];
        const dlgLen = dlg.reduce((a, x) => a + x.length, 0);
        return s.length ? (dlgLen / s.length * 100) : 0;
    }

    /**
     * 「🛠 一键修复硬伤」：对自检报出的问题逐章自动修复，修完自动重新自检。
     * 修复分三层，从便宜到贵：
     *   1) 确定性修复（不耗模型）：英文引号转全角、删重复段落、清旁白剧透；
     *   2) 模型定向修补（复用 repairSigningDefects）：开篇钩子、套话、乒乓对话、角色自我相遇/连续性；
     *   3) 对白占比过高：分块把部分直接对话改成叙述/动作，压到 35% 以下。
     * 只处理「有问题的章节」，全部通过则不动；任何一步失败都不会中断其它章节。
     */
    async fixSigningProblems() {
        if (this._fixingSigning) return;
        const chapters = ((this.work && this.work.chapters) || []).slice();
        if (!chapters.length) { this.showNotification('当前作品还没有章节', 'warning'); return; }
        const targets = [];
        chapters.forEach(ch => {
            const items = this.auditTextForSigning(ch.content || '').filter(i => !i.ok);
            if (items.length) targets.push({ ch: ch, items: items });
        });
        if (!targets.length) { this.showNotification('没有需要修复的问题，全部通过 ✅', 'success'); return; }

        this._fixingSigning = true;
        const btn = document.getElementById('signingFixBtn');
        const statusEl = document.getElementById('signingAuditStatus');
        const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
        if (btn) { btn.disabled = true; btn.textContent = '🛠 修复中…'; }
        const settings = this.getLiveAISettings();
        let changed = 0;
        const details = [];
        try {
            for (let ti = 0; ti < targets.length; ti++) {
                const ch = targets[ti].ch;
                const items = targets[ti].items;
                const label = '第' + (ch.number || '?') + '章';
                setStatus('正在修复 ' + label + '（' + (ti + 1) + '/' + targets.length + '）…');
                let text = String(ch.content || '');
                const before = text;

                // 1) 确定性修复（不耗模型，先把最硬的格式问题清掉）
                if (items.some(i => i.name.indexOf('标点') >= 0)) text = this.sanitizeQuotes(text);
                if (items.some(i => i.name.indexOf('重复段落') >= 0)) text = this.dropDuplicateParagraphs(text);
                if (items.some(i => i.name.indexOf('全知剧透') >= 0)) text = this.stripNarratorIntrusion(text);

                // 2) 模型定向修补（仅当还有需要模型的 block 项时才调用，避免白烧调用）
                const needModel = items.some(i => i.level === 'block' && /开篇|套话|乒乓|自我相遇/.test(i.name));
                if (needModel) {
                    const pseudoJob = {
                        reportText: '', progress: {},
                        chapterLabel: label, chapterNumber: ch.number, chapterId: ch.id
                    };
                    try {
                        const fixed = await this.repairSigningDefects(text, pseudoJob, null);
                        if (fixed && fixed.trim()) text = fixed;
                    } catch (e) { /* 单项失败不中断整章 */ }
                }

                // 3) 对白占比过高：只挑最严重的几块并行改写（提速），只跑一轮
                if (this.getDialogueRatio(text) > 35) {
                    setStatus(label + '：对白占比 ' + this.getDialogueRatio(text).toFixed(0) + '%，正在并行压低…');
                    try {
                        const reduced = await this.repairDialogueRatio(text, null, settings, function (d, t) {
                            setStatus(label + '：对白修复 ' + d + '/' + t + ' 块…');
                        });
                        if (reduced && reduced.trim()) text = reduced;
                    } catch (e) { /* 失败保留原文 */ }
                }

                // 兜底：模型改写可能把全角引号又写成英文半角（上次修复后仍剩 266 个英文引号就是这原因），
                // 所以在整章改完后必须再规整一次标点，保证「英文引号/省略号」这项硬伤一定清零。
                text = this.sanitizeQuotes(text);

                // 记录本章修复后的真实数字，写进状态栏：用户能直接看到「确实变了」
                const afterItems = this.auditTextForSigning(text).filter(i => !i.ok);
                const leftBlock = afterItems.filter(i => i.level === 'block').length;
                const leftWarn = afterItems.length - leftBlock;
                const eq = text.split('"').length - 1;
                const op = (text.match(/“/g) || []).length, cl = (text.match(/”/g) || []).length;
                details.push(label + '：英文引号 ' + eq + '、全角 ' + op + '/' + cl +
                    '、对白 ' + this.getDialogueRatio(text).toFixed(0) + '%、硬伤 ' + leftBlock + '、待改 ' + leftWarn);

                if (text !== before) {
                    ch.content = text;
                    ch.updatedAt = Date.now();
                    changed++;
                    if (this.currentChapter && this.currentChapter.id === ch.id) {
                        this.currentChapter.content = text;
                        const ta = document.getElementById('chapterContent');
                        if (ta) ta.value = text;
                        // 编辑器与章节内容强制一致，避免随后的一次自动保存把旧文本又写回来
                        this.dirty = false;
                        this.setSaveStatus('saved', '✓ 已修复 ' + this.nowTime());
                    }
                }
            }
            this.saveData();
            setStatus('修复完成：' + details.join('；'));
            this.runSigningAudit();
            this.showNotification('一键修复完成：已更新 ' + changed + ' 章（' + details.join('；') + '）', 'success');
        } catch (e) {
            this.showNotification('修复失败：' + ((e && e.message) || e), 'error');
        } finally {
            this._fixingSigning = false;
            const b2 = document.getElementById('signingFixBtn');
            if (b2) { b2.disabled = false; b2.textContent = '🛠 一键修复硬伤'; }
        }
    }

    /**
     * 确定性「开篇站位」：把删除成本最低的 AI 软开场处理掉，让章首 300 字内出现张力。
     * 处理两类（都是删字，不动后面任何情节）：
     *   1. 整段是时间+天气/环境/传说铺垫、且段内没有任何冲突或悬念线索 → 整段删掉；
     *   2. 段首一句是「清晨的阳光…」这类起笔句 → 只删这一句，保留该段其余内容。
     * 保守上限：最多处理前 2 段、累计不超过 350 字，避免把正文掏空。
     */
    upgradeOpeningForSigning(text) {
        let s = String(text || '');
        if (!s.trim()) return s;
        const hook = /(突然|忽然|竟然|才发现|不可能|为什么|谁知|谁料|不料|下一秒|猛的|一把|一头|不对劲|不对|从没|从来没|明明|冷汗|手心|攥|缩|僵|屏住|发抖|发凉|血迹|不见|消失|拦住|堵|闯|抢|摔|喊|逼|压|喘|谁|哪|锁|半截|少了一|多了一|[？?！!])/;
        const atmosphere = /^[^。]{0,40}(阳光|夜色|夜幕|天空|风|雨|雪|灯|教室|走廊|街道|清晨|早晨|傍晚|夜里|凌晨)/;
        const legend = /(传说|据说|听说|没有人知道|谁都知道|都知道|鲜为人知|据说)/;
        let removed = 0;
        for (let guard = 0; guard < 2; guard++) {
            if (!s.trim() || removed > 350) break;
            const nl = s.indexOf('\n');
            const firstPara = (nl >= 0 ? s.slice(0, nl) : s).trim();
            if (!firstPara) break;
            // 段内已有张力 → 不动
            if (hook.test(firstPara)) break;
            const firstSentence = firstPara.split('。')[0];
            const isAtmo = (atmosphere.test(firstSentence) || legend.test(firstSentence)) &&
                firstPara.length <= 140 &&                       // 只动短小纯粹铺陈段
                firstPara.indexOf('\u201c') < 0 && firstPara.indexOf('"') < 0 &&   // 不含对白
                !/^[\s\S]{0,20}[说问道答走抬伸拿放推拉拽笑叹皱愣跳扑奔]/.test(firstPara);  // 段首没有动作戏
            if (!isAtmo) break;
            const rest = nl >= 0 ? s.slice(nl + 1).replace(/^\s+/, '') : '';
            if (rest.trim().length < 250) break;      // 后面没内容就别掏空正文
            s = rest;
            removed += firstPara.length;
        }
        return s.trim();
    }

    /**
     * 定向修补：开篇钩子专修。
     * 只重写开头一小段（默认前 1200 字），要求在不改任何事实的前提下，
     * 把本章的冲突/悬念提到最前面；其余正文原样附上供参考，只回传重写后的开头。
     * 这是「黄金三章」里唯一无法用删字解决的一项，必须模型重写。
     */
    async repairOpeningHook(text, signal, settings) {
        const src = String(text || '');
        if (!src.trim()) return src;
        const head = src.slice(0, 1200);
        const prompt = [
            '【任务】重写下面这段小说开头。这是全章的第一段，编辑只看前 300 字决定去留，' +
            '现在这段是日常流水，必须改成能让读者立刻上钩的开头。',
            '【硬性要求】',
            '1. 前 300 字内必须出现冲突、悬念、反常或抉择（谁在拦着、什么不对劲、他必须选什么）；',
            '2. 不许用「清晨的阳光 / 夜色渐深 / 第二天」这类时间+天气起笔，不许从上学、吃饭、走路这类日常写起；',
            '3. 所有事实、人物、关系、时间点都必须与原文完全一致，不许新增人物、新情节、新设定；',
            '4. 保留原文已有的世界观信息和悬念，只是换一种更有张力的进场方式；可以删掉纯环境铺垫；',
            '5. 口语化、通俗，不要翻译腔；不要用「一丝」「微微」「仿佛」这类空泛词；',
            '6. 输出 200-500 字，只输出重写后的开头正文，不要解释、不要标题。',
            '【本章开头原文（供参考事实，重写后不必保留其写法）】\n' + head,
            '【本章后续内容（只供核对事实，不要写进来）】\n' +
            (src.length > 1200 ? src.slice(1200, 2400) : '')
        ].join('\n\n');
        try {
            const res = await this.callAIAPI(
                '你是资深网文编辑，擅长把平淡的开头改成有钩子的开头，只改写法不改事实。',
                prompt, settings || this.getLiveAISettings(),
                { signal: signal, maxTokens: 1400, onChunk: () => {} });
            const newHead = this.stripChapterHeadings(String(res || '').trim());
            if (!newHead || newHead.length < 120 || newHead.length > 1600) return src;   // 长度异常就不采用
            return (newHead + '\n\n' + src.slice(head.length)).replace(/\n{3,}/g, '\n\n');
        } catch (e) { return src; }
    }

    /**
     * 定向修补：套话清扫。
     * data.words 是本章自检统计出的高频套话词表；把含这些词的句子交给模型逐句换成具体表达，
     * 其余不动。长文分块处理。
     */
    async repairCliches(text, words, signal, settings) {
        let src = String(text || '');
        if (!src.trim() || !words || !words.length) return src;
        const list = words.map(x => x.w + '（' + x.n + ' 次）').join('、');
        const CHUNK = 2600;
        for (let i = 0; i < src.length; i += CHUNK) {
            if (signal && signal.aborted) break;
            const part = src.slice(i, i + CHUNK);
            const prompt = [
                '【任务】把下面这段正文里反复出现的套话表达，换成只属于当下场景的具体写法。',
                '【本章高频套话（这些词已经用得太多了，必须大幅减少）】' + list,
                '【硬性要求】',
                '1. 同一个套话词在本段最多保留 1 处，其余全部换成不同的具体动作、身体反应或细节；' +
                '「微微一笑」可以换成「压了下嘴角」「别过脸」「笑出声」这类只有当下才会做的动作；',
                '2. 不许用近义词替换来糊弄（把「微微」换成「稍稍」不算改）；要换成完全不同的具体表达；',
                '3. 情节、人物、对话、时间线一律不变；不新增内容；',
                '4. 输出字数与本段基本一致（不低于 90%）；只输出修改后的正文，不要解释。',
                '【本段正文】\n' + part
            ].join('\n\n');
            try {
                const res = await this.callAIAPI(
                    '你是苛刻的文字编辑，专治套话复用，只做替换不做改写。',
                    prompt, settings || this.getLiveAISettings(),
                    { signal: signal, maxTokens: 4000, onChunk: () => {} });
                const fixed = this.stripChapterHeadings(String(res || '').trim());
                // 字数差太多说明模型跑偏了，宁可不改
                if (fixed && Math.abs(fixed.length - part.length) <= part.length * 0.2) {
                    src = src.slice(0, i) + fixed + src.slice(i + CHUNK);
                }
            } catch (e) { /* 单块失败跳过 */ }
        }
        return src;
    }

    /**
     * 定向修补：拆掉「乒乓式对话」。
     * 把连续多段「引号+说话人」的纯对话回合，插入动作/神态/环境/心理，或合并成带叙述的对话段，
     * 把一问一句的 AI 对答节奏打断。长文分块处理，只动乒乓段、不破坏其它部分。
     */
    async repairPingPong(text, signal, settings) {
        let src = String(text || '');
        if (!src.trim()) return src;
        const isPureTurn = (p) => {
            if (p.indexOf('\u201c') < 0 && p.indexOf('"') < 0) return false;
            const quoteChars = (p.match(/[\u201c"][^\u201d"]{1,40}[\u201d"]/g) || [])
                .reduce((s, x) => s + x.length, 0);
            const remainder = p.replace(/[\u201c"][^\u201d"]{1,40}[\u201d"]/g, '');
            return remainder.length <= 8 && /[，：、；—]/.test(remainder) === false;
        };
        // 只挑出「连续 ≥3 段纯对话」的乒乓块来修，别的段落原样保留。按行切分块，避免切断句子。
        const lines = src.split('\n');
        const CHUNK = 2600;
        const isRun = (arr) => { let run = 0; for (const p of arr) { if (isPureTurn(p)) { run++; if (run >= 3) return true; } else run = 0; } return false; };
        let out = [];
        let i = 0;
        while (i < lines.length) {
            let j = i + 1;
            while (j < lines.length && lines.slice(i, j).join('\n').length < CHUNK) j++;
            const part = lines.slice(i, j).join('\n');
            // 这块里有没有乒乓块？没有就原样保留，省一次调用
            if (!isRun(lines.slice(i, j))) { out.push(part); i = j; continue; }
            const prompt = [
                '【任务】改写下面这段正文，专门拆掉「乒乓式对话」（两人一问一句、句句对答又互相确认、' +
                '连续多段只有引号加说话人、没有一点叙述的写法）。这是 AI 生成最明显的指纹，编辑会直接拒稿。',
                '【改写方法（必须做到）】',
                '1. 在每两句对话之间，插入动作、神态、环境或心理描写，把节奏切断——不要连续 3 段以上都是纯对话；',
                '2. 把十几回合的逐句追问合并、推进：能一句话说清的信息不要拆成问答；让对话承载冲突或信息，而不是填充字数；',
                '3. 减少「XX问／XX说／XX答」这种每句都带说话人的标签，用动作、语气、眼神或上下文带出说话人；',
                '4. 情节、人物、台词的信息量一律不变：只是把纯对话拆开、补进叙述，不新增情节、不改原意、不删关键信息。',
                '5. 输出字数与本段基本一致（不低于 90%）；只输出修改后的正文，不要解释、不要标题。',
                '【本段正文】\n' + part
            ].join('\n\n');
            try {
                const res = await this.callAIAPI(
                    '你是资深网文编辑，专治「乒乓式对话」，只拆节奏不改情节。',
                    prompt, settings || this.getLiveAISettings(),
                    { signal: signal, maxTokens: 4000, onChunk: () => {} });
                const fixed = this.stripChapterHeadings(String(res || '').trim());
                // 字数差太多说明模型跑偏，宁可不改
                if (fixed && Math.abs(fixed.length - part.length) <= part.length * 0.35) {
                    out.push(fixed);
                } else {
                    out.push(part);
                }
            } catch (e) { out.push(part); }
            i = j;
        }
        return out.join('\n');
    }

    /**
     * 润色收尾的「定向修补」：按签约自检未过的项逐项修，修完自检，最多多轮，直到硬伤清零。
     * 关注点：宁可多花时间，也不要把有硬伤的稿子交上去。
     *   标点 / 重复段落 → 确定性处理，不花模型调用；
     *   开篇无钩子      → 开篇专修（只重写前 1200 字，事实不变）；
     *   AI 套话密度     → 按自检统计出的词表逐块清扫。
     */
    /**
     * 定向修补：跨段连续性硬伤。
     * 用整章全文作为上下文（repairSigningDefects 传入的就是整章），让模型找出并修掉
     * 「角色自己遇到自己（重复出场）」「时间线/设定前后矛盾（义体是否已装回、轮椅是否已坏却还在用）」这类
     * 单段润色看不到的矛盾。只改矛盾处，其余不动。
     */
    async repairContinuity(text, signal, settings) {
        const src = String(text || '');
        if (!src.trim() || src.length < 800) return src;
        const prompt = [
            '【任务】通读下面这整章小说，找出并修掉「连续性硬伤」，其余一律不动。',
            '【要修的硬伤类型】',
            '1. 角色自我相遇 / 重复出场：某个角色既被写成随队同行或已离开某地，后面又写成去敲该地的门、或初次见到某人——也就是同一角色自己遇到自己。修法：删掉重复的出场，让该角色自始至终是同一处的人（例如把敲门人换成当时带路/同行的另一个人，门内出来的才是该角色）。',
            '2. 时间线 / 设定前后矛盾：同一件物品或身体部位在前文被「断开/烧毁/坏掉」，后文却还在正常使用却没有交代修复，或反之。修法：在中间补一句衔接（如「路上苏姐换上备件」「他此前已把义体重新接回」），不要大改情节。',
            '【硬性要求】',
            '1. 只改矛盾处，情节、对话、人物、世界观一律不变；',
            '2. 不要新增人物、新场景、新情节；',
            '3. 口语化、通俗，不要翻译腔；',
            '4. 输出整章修改后的全文（字数与原文字数基本一致，不低于 92%、不高于 130%），只输出正文，不要解释、不要标题。',
            '【整章正文】\n' + src
        ].join('\n\n');
        try {
            const res = await this.callAIAPI(
                '你是资深网文责编，专治长文生成的连续性硬伤，只修矛盾不改故事。',
                prompt, settings || this.getLiveAISettings(),
                { signal: signal, maxTokens: 8000, onChunk: () => {} });
            const fixed = this.stripChapterHeadings(String(res || '').trim());
            if (fixed && fixed.length >= src.length * 0.92 && fixed.length <= src.length * 1.3) {
                return fixed;
            }
            return src;
        } catch (e) { return src; }
    }

    async repairSigningDefects(text, job, signal) {
        const src = String(text || '');
        if (!src.trim() || (signal && signal.aborted)) return src;
        const settings = this.getLiveAISettings();
        const MAX_ROUNDS = 3;
        const guard = src.length;
        const note = (t) => {
            job.reportText = (job.reportText || '') + t;
            this.syncPolishUI();
        };
        // 质量为先：每项修补按「当前仍失败」的硬伤逐轮重跑，直到修净或达到 MAX_ROUNDS；
        // 已通过的项不会再出现在 bad 里，因此不会白跑——只在「没修干净」时才多花调用重来。
        for (let round = 1; round <= MAX_ROUNDS; round++) {
            const audit = this.auditTextForSigning(text);
            const bad = audit.filter(i => !i.ok && i.level === 'block');
            if (!bad.length) {
                note(' 签约自检：硬伤已清零 ✅（第 ' + round + ' 轮确认）');
                return text;
            }
            const names = bad.map(i => i.name);
            job.progress = { index: round, total: MAX_ROUNDS };
            // 注意：这里只能「追加」，不能把 reportText 截断重写——
            // 否则第 2、3 轮会把前面几轮的修补记录擦掉，用户看不到完整过程。
            note(' 签约自检还有 ' + bad.length + ' 项硬伤（' + names.join('、') +
                '），正在第 ' + round + '/' + MAX_ROUNDS + ' 轮定向修补…');
            this.renderJobsBar();

            let next = text;
            bad.forEach(item => {
                if (item.name.indexOf('标点') >= 0) next = this.sanitizeQuotes(next);
                else if (item.name.indexOf('重复段落') >= 0) next = this.dropDuplicateParagraphs(next);
            });
            if (bad.some(i => i.name.indexOf('全知剧透') >= 0)) {
                const before = next;
                next = this.stripNarratorIntrusion(next);
                if (next !== before) note(' 全知剧透清除：已删掉叙述者跳出来剧透/总结的句子。');
            }
            const needHook = bad.some(i => i.name.indexOf('开篇') >= 0);
            const clicheItem = bad.find(i => i.name.indexOf('套话') >= 0);
            if (needHook) {
                const fixed = await this.repairOpeningHook(next, signal, settings);
                if (fixed && fixed !== next) {
                    next = fixed;
                    note(' 开篇专修：已重写开头，让前 300 字直接进冲突/悬念。');
                }
            }
            if (clicheItem && clicheItem.data && clicheItem.data.words) {
                const before = next;
                next = await this.repairCliches(next, clicheItem.data.words.slice(0, 8), signal, settings);
                if (next !== before) note(' 套话清扫：已按词表替换 ' +
                    clicheItem.data.words.slice(0, 8).map(x => x.w).join('、') + '。');
            }
            const pingItem = bad.find(i => i.name.indexOf('乒乓') >= 0);
            if (pingItem) {
                const before = next;
                next = await this.repairPingPong(next, signal, settings);
                if (next !== before) note(' 乒乓对话拆解：已在问答之间补入动作/神态/心理，打断一问一句对答。');
            }
            const contItem = bad.find(i => i.name.indexOf('自我相遇') >= 0);
            if (contItem) {
                const before = next;
                next = await this.repairContinuity(next, signal, settings);
                if (next !== before) note(' 连续性修复：已修掉角色自我相遇 / 时间线前后矛盾。');
            }
            // 兜底：任何一轮都不许把正文改残
            if (!next.trim() || next.length < guard * 0.7 || next.length > guard * 1.4) {
                note(' 本轮修补结果异常（字数偏差过大），已放弃本轮，保留上一版。');
                next = text;
            }
            if (next === text) {
                note(' 第 ' + round + ' 轮没有可执行的改动，停止后续轮次（可能仍需你手动处理）。');
                break;                       // 没有进展就别再烧调用
            }
            text = next;
        }
        // 兜底：模型修补可能把引号又写成英文半角，返回前再规整一次标点
        return this.sanitizeQuotes(text);
    }

    /**
     * 对白占比过高时的分块修复（提速版）：
     * 按 2600 字切块，只挑「对白占比明显偏高」的块（>38%），按比例从高到低最多处理 4 块，
     * 并以 3 路并发请求模型，把部分直接对话改成间接转述/动作/心理；只跑一轮，避免几十次串行调用。
     * onProgress(done, total) 用于在弹窗状态栏显示进度。
     */
    async repairDialogueRatio(text, signal, settings, onProgress) {
        const src = String(text || '');
        if (!src.trim()) return src;
        const chunks = this.splitTextForPolish(src, 2600);
        if (!chunks.length) return src;
        const ratios = chunks.map(c => this.getDialogueRatio(c));
        // 只取最严重的、最多 4 块：整章压对白不必逐块全改，改最差几块就能明显拉低整体占比
        const idxs = ratios.map((r, i) => ({ r: r, i: i }))
            .filter(x => x.r > 38)
            .sort((a, b) => b.r - a.r)
            .slice(0, 4)
            .map(x => x.i);
        if (!idxs.length) return src;   // 没有明显超标的块，直接返回，省掉所有模型调用

        const fixedMap = {};
        const CONC = 3;
        const total = idxs.length;
        let doneN = 0;
        const editOne = async (ci) => {
            const c = chunks[ci];
            const cRatio = ratios[ci];
            const prompt = [
                '【任务】把下面这段小说里的部分「直接对话」改成「间接转述 / 动作 / 心理描写」，把本段对白占比压到 35% 以下，其余一律不动。',
                '【硬性要求】',
                '1. 所有信息、情节、人物关系必须保留，不能删掉任何关键对话里的事实；只是把一部分「某某说：……」「……？」这种直接引语，改写成叙述（如「他把来意说了」「她只回了两个字」）或动作/神态带出；',
                '2. 不要把对话改成大段旁白，也不要新增情节、新角色；',
                '3. 字数与原段基本一致（不低于 90%、不高于 115%）；',
                '4. 保留原有的中文全角标点风格，只输出改写后的正文，不要解释、标题。',
                '【本段正文】\n' + c
            ].join('\n\n');
            try {
                const res = await this.callAIAPI(
                    '你是资深小说编辑，擅长把过量对话改成自然的叙述与动作，只改表达、不改内容。',
                    prompt, settings || this.getLiveAISettings(),
                    { signal: signal, maxTokens: Math.min(8000, Math.max(3500, Math.ceil(c.length * 1.6))), onChunk: () => {} });
                // 模型常把引号又写成英文半角，这里先规整；再只接受「确实把对白压下来」的结果
                const fixed = this.sanitizeQuotes(this.stripChapterHeadings(String(res || '').trim()));
                const fRatio = this.getDialogueRatio(fixed);
                const lenOk = fixed && fixed.length >= c.length * 0.9 && fixed.length <= c.length * 1.15;
                if (lenOk && (fRatio < cRatio || fRatio <= 35)) fixedMap[ci] = fixed;
            } catch (e) { /* 单块失败保留原文 */ }
            doneN++;
            if (typeof onProgress === 'function') { try { onProgress(doneN, total); } catch (e) {} }
        };
        // 3 路并发：8 块串行要 8 个来回，并发后只需 1~2 个来回
        for (let s = 0; s < idxs.length; s += CONC) {
            if (signal && signal.aborted) break;
            await Promise.all(idxs.slice(s, s + CONC).map(editOne));
        }
        return chunks.map((c, i) => (fixedMap[i] !== undefined ? fixedMap[i] : c)).join('\n\n');
    }

    /** 统计子串出现次数 */
    countOccur(str, sub) {
        if (!str || !sub) return 0;
        let n = 0, i = 0;
        while ((i = str.indexOf(sub, i)) >= 0) { n++; i += sub.length; }
        return n;
    }

    /**
     * 查找确定性可修的错别字：常见别字表 + 人名误写（与角色名仅差 1 个字）。
     * 返回 [{from, to, kind}]，只保留可安全替换的条目。
     */
    findTypos(text) {
        const src = String(text || '');
        if (!src.trim()) return [];
        const fixes = [];
        const seenFrom = new Set();
        const push = (from, to, kind) => {
            if (!from || from === to || seenFrom.has(from)) return;
            if (this.countOccur(src, from) === 0) return;
            // 会把正文里的正常用词打碎的替换，一律不做（详见 getTypoGuardPhrases）
            if (this.isRiskyReplacement(from, src)) return;
            seenFrom.add(from);
            fixes.push({ from: from, to: to, kind: kind });
        };

        // 1) 常见错别字表
        const map = this.getCommonTypoMap();
        Object.keys(map).forEach(w => push(w, map[w], 'common'));

        // 2) 人名误写：原型名在文中出现≥3 次，而某个只差 1 个字（或少末字）的写法只出现 ≤2 次
        //    两条互补的判定路径：
        //      A. 同音字替换（林知夏→林之夏、陆屿→陆与）——只改读音相同的，绝不碰正常用词
        //      B. 姓氏对齐 + 非正常词（林简→林栀、陈橙→陈橙橙）——靠「同姓且只差一字」精准定位姓名笔误
        //    曾经只有「差一个字」这一条，结果把「是鱼」改成「苏鱼」、「小字」改成「小鹿」，正文被改坏。
        const names = this.collectProperNouns();
        const stop = new Set(this.properNounStopExtra());
        names.forEach(name => {
            if (name.length < 2 || name.length > 6) return;
            const nameCount = this.countOccur(src, name);
            if (nameCount < 2) return;                 // 原型名至少出现过 2 次才算立住的人物
            for (let i = 0; i + name.length <= src.length; i++) {
                const sub = src.substr(i, name.length);
                if (sub === name || stop.has(sub) || names.indexOf(sub) >= 0) continue;
                let diff = 0, pos = -1;
                for (let k = 0; k < name.length; k++) {
                    if (sub[k] !== name[k]) { diff++; pos = k; }
                }
                if (diff !== 1) continue;
                if (this.countOccur(src, sub) > 2) continue;
                // A. 同音才修（林知夏→林之夏、陆屿→陆与）
                //    曾经还放过一条「形近也修」，结果把正常用词改成了人名：周围→周砚、林同→林栀。
                //    形近笔误交给有上下文的 AI 校对处理，本地只做「读音相同」这种高置信度判断。
                if (!this.isHomophone(sub[pos], name[pos])) continue;
                push(sub, name, 'name');
            }
            // B. 漏末字：候选正好是角色名去掉最后一个字
            if (name.length > 2) {
                const short = name.slice(0, name.length - 1);
                if (this.isNameTypo(short, name, names, src)) push(short, name, 'name');
            }
        });
        // 同一角色名的多个候选互相包含时，只保留最长、最具体的那个：
        // 「陈橙」既是「陈橙橙」的漏字写法、又出现在写对的「陈橙橙」里，「陈橙挑」才是真正的笔误。
        // 两个都替换会叠成「陈橙橙橙」。
        const nameFixes = fixes.filter(f => f.kind === 'name');
        const kept = nameFixes.filter(f => !nameFixes.some(g =>
            g !== f && g.to === f.to && g.from.length > f.from.length && g.from.indexOf(f.from) >= 0));
        return fixes.filter(f => f.kind !== 'name').concat(kept);
    }

    /** 常用字拼音表：只服务于「人名误写」的同音判断。字表外的字一律判为不同音（宁可不改，也不误伤正文） */
    getPinyinTable() {
        if (this._pinyinTable) return this._pinyinTable;
        const rows = 'a:阿|ai:哀埃挨艾爱暖矮|an:安按岸暗案|ang:昂|ao:奥傲|ba:八巴把爸霸|bai:白百摆败|' +
            'ban:半办般班板|bang:帮邦|bao:包宝保报抱爆|bei:悲杯北被备背|ben:本|bi:必比币笔彼逼鼻|' +
            'bian:边变便遍辨辩|biao:标表|bie:别|bin:宾滨|bing:冰兵并病饼|bo:波博伯薄泊|bu:不步部布补捕|' +
            'cai:才材财采彩菜猜|can:参残惨|cang:苍藏舱|cao:草操曹|ce:册侧测策|ceng:层曾|' +
            'cha:茶查差插叉|chai:拆柴|chan:产缠禅|chang:长常场厂唱尝偿|chao:超抄朝潮吵炒|che:车扯彻|' +
            'chen:沉陈辰尘晨臣衬|cheng:成城程承诚乘惩撑橙珵|chi:吃迟池驰尺齿翅赤匙|chong:冲充崇虫宠|' +
            'chou:抽愁丑臭仇|chu:出初除厨础储楚处触畜锄|chuan:传川穿船串喘|chuang:创窗床闯|' +
            'chui:吹垂锤|chun:春纯唇蠢|ci:次此刺词慈瓷辞|cong:从丛葱聪|cu:粗醋促|cui:催脆翠|cun:村存寸|' +
            'cuo:错措搓|da:大打达答搭|dai:带待代袋戴呆贷|dan:但单担丹胆淡旦弹诞|dang:当党挡荡档|' +
            'dao:到道倒刀岛导蹈盗|de:的得德底|deng:等灯登邓凳瞪|di:地第低底敌滴抵帝递弟堤笛|' +
            'dian:点电店殿典垫颠|diao:掉调钓雕吊|die:跌叠蝶|ding:定顶丁订盯钉鼎|dong:动东冬懂洞栋冻|' +
            'dou:都斗豆抖陡|du:独读度毒肚堵妒渡杜|duan:段短断端|dui:对队堆|dun:顿蹲盾吨|duo:多朵躲夺|' +
            'e:恶饿额鹅蛾厄|en:恩|er:而二儿耳尔洱|fa:发法罚乏伐|fan:反饭犯范泛翻凡繁烦贩|fang:方放房防访仿纺芳|' +
            'fei:非飞费肥废肺沸菲|fen:分份粉奋愤芬纷坟|feng:风封疯峰锋丰枫逢缝冯凤奉|fo:佛|fou:否|' +
            'fu:复副富负父服福夫扶幅府腐附妇肤浮符伏抚辅赴傅付弗|gai:该改概盖钙|gan:干感赶敢甘肝杆|' +
            'gang:刚钢港岗纲|gao:高告搞稿膏|ge:个各格哥歌割搁隔戈鸽|gei:给|gen:跟根|geng:更耕耿|' +
            'gong:工公共功攻供宫弓恭巩|gou:够狗构沟勾购钩|gu:古故顾姑孤骨谷股鼓固估辜|gua:瓜挂刮|' +
            'guai:怪拐乖|guan:关管观馆官冠惯罐|guang:光广逛|gui:贵归鬼柜轨龟规硅|gun:滚|guo:国过果裹锅|' +
            'ha:哈|hai:还海孩害|han:寒喊汉汗含韩涵罕憾|hang:行航|hao:好号毫豪耗浩|he:和何合河喝核荷盒贺鹤褐|' +
            'hei:黑嘿|hen:很恨痕|heng:横恒衡|hong:红洪宏轰虹鸿哄|hou:后厚候侯喉猴|' +
            'hu:呼忽湖胡虎护互糊壶蝴|hua:花华话画化划滑|huai:怀坏|huan:换环欢缓患幻|' +
            'huang:黄皇慌煌晃谎荒|hui:会回灰挥恢辉慧汇惠毁悔徽|hun:混婚昏魂|huo:或火伙活货获祸惑|' +
            'ji:几机记及即集极急级技计基击激迹绩饥鸡吉籍季既继寄剂挤祭济暨忌寂|jia:家加假价架甲嘉夹佳驾嫁|' +
            'jian:见件间简健渐建剑减检捡剪荐鉴兼肩艰尖煎舰践箭|jiang:将讲江降奖姜疆蒋酱匠|' +
            'jiao:叫脚教交角焦骄娇郊浇搅缴|jie:接街节结解姐界借介杰捷截竭揭皆阶届戒洁|' +
            'jin:进今金近紧尽仅禁津谨筋锦晋浸|jing:经精静睛京惊景警竟净境敬竞井镜晶荆|' +
            'jiu:就九久酒旧救究揪舅|ju:举句具据局剧巨聚拒距惧菊橘沮|juan:卷倦捐圈|jue:觉决绝角掘爵|' +
            'jun:军君均俊峻骏|ka:卡咖喀恰掐洽|kai:开凯慨|kan:看刊砍堪|kang:康抗扛|kao:考靠烤|' +
            'ke:可科克刻客课壳咳渴棵|ken:肯啃恳|keng:坑|kong:空孔控|kou:口扣抠寇|ku:苦哭库裤酷枯|' +
            'kua:跨夸|kuai:快块筷|kuan:宽款|kuang:狂况框眶|kui:亏愧溃|kun:困昆|kuo:括扩阔|' +
            'la:拉啦辣蜡|lai:来赖莱|lan:蓝懒篮兰栏拦览烂|lang:狼朗浪廊|lao:老劳牢捞|le:了乐勒|' +
            'lei:类累泪雷垒蕾|leng:冷|li:里理力立利历例离李礼丽梨璃黎粒隶励篱|' +
            'lian:连联练恋脸莲怜廉帘|liang:两亮量凉梁粮良辆|liao:料聊撩疗|lie:列烈猎裂|' +
            'lin:林临邻淋琳霖鳞|ling:领令灵零铃龄陵岭凌|liu:六流留刘柳溜琉|long:龙隆笼聋拢|' +
            'lou:楼漏搂|lu:路陆录露鲁卢绿碌鹿炉庐|luan:乱卵|lun:论轮伦沦|luo:落罗洛络骆裸烙|' +
            'ma:马吗妈麻骂码抹|mai:买卖麦埋迈|man:满慢漫蛮馒曼|mang:忙盲茫芒|mao:毛冒帽猫矛茅貌|' +
            'mei:没美每妹眉梅媒煤霉媚|men:门们闷|meng:梦猛蒙盟孟萌|mi:米密迷秘蜜谜眯|' +
            'mian:面免棉绵眠|miao:秒妙苗描庙渺|mie:灭|min:民敏闽皿|ming:名明命鸣铭冥|' +
            'mo:摸模磨抹末莫墨默陌魔膜|mou:某谋|mu:木目母幕慕牧墓暮睦|na:那拿哪纳娜呐|nai:奶耐乃|' +
            'nan:男南难喃|nao:脑闹恼|ne:呢|nei:内|nen:嫩|neng:能|ni:你尼泥拟逆妮倪|nian:年念粘|' +
            'niang:娘|nie:捏|ning:宁凝拧佞|niu:牛扭|nong:农浓弄|nu:努怒奴|nuan:暖|nuo:诺挪|' +
            'nv:女|ou:偶欧呕|pa:怕爬帕拍|pai:排派牌|pan:盘判叛攀盼|pang:旁胖庞|pao:跑抛炮泡袍|' +
            'pei:陪配赔培佩|pen:盆喷|peng:朋碰棚蓬彭捧|pi:皮批疲脾匹劈屁|pian:片篇骗偏|piao:票飘漂|' +
            'pin:品拼贫|ping:平评瓶凭苹屏乒|po:破坡婆迫泼魄|pu:扑铺普朴谱葡|' +
            'qi:起气七期其奇齐棋旗骑企器汽弃妻欺祈崎|qian:前钱千浅签谦迁牵欠歉铅潜谴|' +
            'qiang:强抢墙枪腔|qiao:桥巧敲悄瞧乔侨|qie:切且窃茄怯|qin:亲琴秦勤寝侵钦|' +
            'qing:请清情青轻晴倾庆顷卿氢|qiong:穷琼|qiu:求球秋丘囚蚯|qu:去取曲区趣屈驱娶渠|' +
            'quan:全权圈劝拳犬|que:却确缺雀鹊|qun:群裙|ran:然染燃|rang:让嚷|rao:绕饶|re:热惹|' +
            'ren:人认任仁忍韧|reng:扔|ri:日|rong:容荣融溶绒熔|rou:肉柔揉|ru:如入儒乳辱褥|ruan:软|' +
            'rui:瑞锐|run:润|ruo:若弱|sa:洒撒萨|sai:赛塞|san:三散伞|sang:桑嗓丧|sao:扫骚嫂|' +
            'se:色涩瑟|sen:森|sha:沙杀傻纱砂刹|shai:筛晒|shan:山善闪扇删珊陕|shang:上商伤尚赏|' +
            'shao:少烧绍勺梢稍|she:设社舍蛇射摄涉赦|shen:深身什神申沈审慎甚伸渗绅|' +
            'sheng:生声升胜省圣剩绳|shi:是时十事使式实识世市师诗史士示视试施失石释拾食誓逝势氏侍饰|' +
            'shou:手收受首售瘦寿授兽熟|shu:书数树属术输舒熟鼠束述暑蜀|shua:刷耍|shuai:帅摔甩衰|' +
            'shuan:栓涮|shuang:双霜爽|shui:水谁睡税|shun:顺瞬舜|shuo:说硕朔|' +
            'si:四死思私司丝似斯撕寺嗣肆|song:送松宋诵颂耸|sou:搜艘|su:苏素速诉塑宿肃|suan:算酸蒜|' +
            'sui:岁随虽碎隧髓|sun:孙损笋|suo:所锁索缩|ta:他她它踏塔塌榻蹋|tai:太台抬态泰胎|' +
            'tan:谈弹探叹摊滩坛贪坦炭|tang:堂糖唐汤躺烫趟|tao:讨套逃桃陶淘掏涛|te:特|teng:疼腾藤|' +
            'ti:提题体替梯踢蹄剃|tian:天田填甜添|tiao:条跳挑调|tie:贴铁|ting:听停厅庭亭挺艇廷|' +
            'tong:同通痛童铜桶筒统捅|tou:头投透偷|tu:图土突途徒吐兔涂屠|tuan:团|tui:推退腿|' +
            'tun:吞屯|tuo:托脱妥拓驼|wa:挖哇娃瓦袜|wai:外歪|wan:万完玩晚碗弯湾挽腕|' +
            'wang:王往望忘网亡汪旺|wei:为位未味委威围维危微违唯惟伟伪尾纬玮蔚慰卫畏|wen:问文温稳闻吻纹蚊|' +
            'weng:翁嗡|wo:我握窝卧|wu:五无误舞屋务物武雾悟捂巫吴吾午污|xi:西希息喜习洗细系戏吸稀溪熄膝媳熙曦|' +
            'xia:下夏吓峡霞侠瞎辖|xian:现先线显险鲜县限闲咸贤嫌掀弦献|xiang:想相向象香乡响项享详巷湘|' +
            'xiao:小笑校消晓肖孝销萧潇梢稍|xie:写些谢鞋血协邪胁斜携屑|xin:心新信辛欣薪馨锌|' +
            'xing:行性形星兴姓型醒幸刑杏|xiong:兄雄胸凶熊汹|xiu:修休羞朽锈秀|xu:许需须续序徐虚嘘蓄婿|' +
            'xuan:选宣悬旋轩喧玄|xue:学血雪削靴穴|xun:寻讯训迅询巡循熏殉|ya:呀压牙亚芽雅哑鸭崖|' +
            'yan:眼言严烟演宴厌雁沿研延掩炎岩颜燕艳盐砚衍|yang:样阳养羊洋仰央痒氧|yao:要摇药腰咬邀妖窑遥耀|' +
            'ye:也业夜叶页野爷冶|yi:一以已意义医衣依疑易益忆议遗仪宜移翼异艺乙抑译谊毅逸疫|' +
            'yin:因音引印银阴隐饮姻|ying:应英影硬营迎赢婴樱鹰颖|yo:哟唷|yong:用永勇涌拥庸佣|' +
            'you:有又右由油游优友尤犹邮幼悠|yu:于与语雨鱼遇预育域欲玉羽屿宇渔愉瑜御狱誉豫郁裕愚娱|' +
            'yuan:元原远院员园愿圆源缘怨渊猿|yue:月越约跃悦岳粤|yun:云运允韵匀蕴晕|za:杂砸|' +
            'zai:在再灾载宰|zan:赞暂咱|zang:藏脏葬|zao:早造遭澡糟燥皂|ze:则责泽择|zeng:增曾赠|' +
            'zha:炸眨渣扎札榨栅|zhai:摘宅窄债|zhan:战站占展沾斩崭栈|zhang:长张章涨帐账丈掌障|' +
            'zhao:找着照招赵罩爪沼|zhe:这着者折哲遮浙|zhen:真镇针珍震阵振|zheng:正整争郑征挣睁蒸症政证|' +
            'zhi:之只知支枝指直值制纸志至治质致置智稚止址旨挚掷脂芝栀桎|zhong:中种重众钟忠终肿|' +
            'zhou:周州洲粥宙骤皱昼|zhu:主住注助祝猪竹逐朱筑煮柱铸驻珠株诸|zhua:抓|zhuan:转专砖赚|' +
            'zhuang:装壮撞状庄桩|zhui:追准锥坠|zhun:准|zhuo:捉桌琢卓浊|zi:子字自紫姿资滋仔籽|' +
            'zong:总纵宗综踪|zou:走奏邹|zu:组足祖租阻族|zuan:钻|zui:最嘴醉罪|zun:尊遵|zuo:做作坐左座昨';
        const map = {};
        rows.split('|').forEach(row => {
            const idx = row.indexOf(':');
            if (idx <= 0) return;
            const p = row.slice(0, idx);
            const chars = row.slice(idx + 1);
            for (let i = 0; i < chars.length; i++) {
                const ch = chars.charAt(i);
                if (!map[ch]) map[ch] = p;
            }
        });
        this._pinyinTable = map;
        return map;
    }

    /** 两个汉字是否同音（声调忽略）。任一字不在字表内就判为不同音：宁可不改，也不误伤正文 */
    isHomophone(a, b) {
        if (!a || !b || a === b) return false;
        const t = this.getPinyinTable();
        const pa = t[a], pb = t[b];
        return !!pa && !!pb && pa === pb;
    }

    /**
     * 把正文里的英文半角引号统一换成中文全角引号。
     * AI 生成中文小说时经常输出 " 这种英文标点（尤其对话），番茄等平台会把它们当格式错误；
     * 这里按出现顺序成对替换成 “” ，单引号 ' 换成 ‘’（用于嵌套）。
     */
    normalizeQuotes(text) {
        const s = String(text || '');
        let open = true;
        let out = s.replace(/"/g, () => { const q = open ? '“' : '”'; open = !open; return q; });
        open = true;
        out = out.replace(/'/g, () => { const q = open ? '‘' : '’'; open = !open; return q; });
        return out;
    }

    /** 删除未闭合 / 孤立的引号：按栈配对，去掉最后没匹配上的开引号，与没有对应开引号的闭引号 */
    removeOrphanQuotes(text) {
        const pairs = [['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』']];
        let s = String(text || '');
        pairs.forEach(([op, cl]) => {
            const stack = [];
            let out = '';
            for (const ch of s) {
                if (ch === op) stack.push(out.length);
                else if (ch === cl) {
                    if (stack.length) stack.pop();
                    else continue; // 没有对应开引号，丢弃这个多余的闭引号
                }
                out += ch;
            }
            if (stack.length) {
                const drop = new Set(stack);
                let rebuilt = '';
                for (let i = 0; i < out.length; i++) if (!drop.has(i)) rebuilt += out[i];
                s = rebuilt;
            }
        });
        return s;
    }

    /**
     * 引号收敛（润色 / 生成后统一执行）：
     * 1) 英文半角引号转中文全角；2) 删空引号对（“”/「」 之间无内容）；
     * 3) 删孤立引号（末尾没闭合的开引号、无对应开引号的闭引号）；
     * 4) 省略号统一成中文「……」；5) 收敛因残行留下的多余空行。
     */
    sanitizeQuotes(text) {
        let s = this.normalizeQuotes(String(text || ''));
        s = s.replace(/“\s*”/g, '').replace(/‘\s*’/g, '')
             .replace(/「\s*」/g, '').replace(/『\s*』/g, '');
        s = this.removeOrphanQuotes(s);
        // 省略号规范：中文省略号只有「……」，把 .. 。。。 ‧‧ 之类的写法统一掉
        s = s.replace(/。{3,}/g, '……').replace(/\.{2,}/g, '……').replace(/‧{2,}/g, '……')
             .replace(/(……)+/g, '……');
        s = s.replace(/\n{3,}/g, '\n\n').trim();
        return s;
    }

    /**
     * 确定性清除「全知叙述者剧透 / 旁白总结句」：把含剧透关键词的整句删掉。
     * 这些句子通常独立成句（如「她不知道的是，……」「XX之谜解开了」「他的故事还没完」），
     * 直接删掉不会破坏上下文；删完若留白过多则压缩空行。
     */
    stripNarratorIntrusion(text) {
        const src = String(text || '');
        if (!src.trim()) return src;
        const bad = /她不知道的是|他不知道的是|殊不知|读者会(明白|知道|看出)|不用说读者|之谜解开了|故事还没完|谜底/;
        // 按句号/叹号/问号/分号/换行切句，删掉命中关键词的句子，其余原样保留
        const parts = src.split(/([。！？；\n])/);
        const kept = [];
        for (let i = 0; i < parts.length; i += 2) {
            const sentence = parts[i] || '';
            const sep = parts[i + 1] || '';
            if (bad.test(sentence)) continue;            // 整句删掉，连标点一起丢
            kept.push(sentence + sep);
        }
        return kept.join('').replace(/\n{3,}/g, '\n\n').trim();
    }

    /**
     * 去掉「把前面的内容又抄一遍」：模型收尾时经常在最后几段把前文的对话原样重复
     * （真实事故：结尾把「我一直以为…」「暗恋会变成双向的奔赴」「谢谢你出现在我生命里」三句对话又写了一遍）。
     * 判断按「台词内容」而不是整行——因为重复时前面的说话人前缀常常不一样（「陆屿轻声说」/「陆屿微笑」）。
     * 两道保险：只处理后 50% 的行，且要求与前面那次至少隔 3 行，避免误删正常的呼应。
     */
    dropRepeatedTail(text) {
        const src = String(text || '');
        if (!src.trim()) return src;
        const norm = (s) => String(s || '').replace(/[\s，。！？、；：""''「」『』…—~,.!?;:'"()（）]/g, '');
        const lines = src.split('\n');
        if (lines.length < 6) return src;
        // 先剥掉开头的说话人（「陆屿微笑：」），再取台词；这样重复时前缀不同也能对上
        const keyOf = (line) => {
            let body = String(line == null ? '' : line);
            const attr = body.match(/^\s*[\u4e00-\u9fa5A-Za-z0-9·]{1,12}[：:]/);
            if (attr) body = body.slice(attr[0].length);
            const m = body.match(/[“「]([^”」]{6,120})[”」]/);
            return m ? norm(m[1]) : norm(body);
        };
        const seen = {};
        lines.forEach((l, i) => {
            const k = keyOf(l);
            if (k.length >= 10 && seen[k] === undefined) seen[k] = i;
        });
        const guard = Math.floor(lines.length * 0.5);
        const kept = [];
        lines.forEach((l, i) => {
            const k = keyOf(l);
            if (i >= guard && k.length >= 10 && seen[k] !== undefined && i - seen[k] >= 3) return;
            kept.push(l);
        });
        return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    /** 应用错别字修正，返回 {text, applied} */
    applyTypoFixes(text, fixes) {
        let out = this.sanitizeQuotes(String(text || ''));
        const applied = [];
        const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 长的先替换：更具体的笔误先修掉，避免「陈橙挑」「陈橙」互相叠乘
        const list = (fixes || this.findTypos(out)).slice()
            .sort((a, b) => (b.from || '').length - (a.from || '').length);
        list.forEach(f => {
            const from = f.from, to = f.to;
            if (!from || !to || from === to) return;
            if (out.indexOf(from) < 0) return;
            if (from.length < to.length && to.slice(0, from.length) === from) {
                // 漏字类修正（陈橙 → 陈橙橙）：只补「后面没跟上完整名字」的那些，
                // 否则会把本来写对的「陈橙橙」改成「陈橙橙橙」
                const next = to.charAt(from.length);
                const re = new RegExp(esc(from) + '(?!' + esc(next) + ')', 'g');
                if (!re.test(out)) return;
                out = out.replace(re, to);
                applied.push(f);
                return;
            }
            out = out.split(from).join(to);
            applied.push(f);
        });
        // 结尾若把前面的对话又抄了一遍，删掉重复部分；
        // 再把整章里「原样重复的段落/台词」去掉（模型常把一场戏写两遍）；最后收一次标点，防止引号失衡
        out = this.dropDuplicateParagraphs(this.dropRepeatedTail(out));
        out = this.sanitizeQuotes(out);
        return { text: out, applied: applied };
    }

    /**
     * 解析校对结果：模型要求「错误=>正确」逐行输出，但它经常自己加序号、换箭头、裹引号。
     * 这里做容错，格式稍歪也能用；解析不出来就返回空（不会误改正文）。
     */
    parseProofreadFixes(res) {
        const out = [];
        const strip = (s) => String(s || '').replace(/^["“'‘【\[（(]+|["”'’】\]）)]+$/g, '').trim();
        String(res || '').split(/\r?\n/).forEach(raw => {
            let line = String(raw || '').trim();
            if (!line) return;
            // 去掉「1. 」「1、」「- 」「· 」这类自作主张的序号
            line = line.replace(/^(?:[-·•*]\s*|\d+[.、)）]\s*)/, '').trim();
            line = strip(line);
            const m = line.match(/^(.{1,20}?)\s*(?:=>|→|⇒|➡|➜|→)\s*(.{1,20})$/);
            if (!m) return;
            const from = strip(m[1]), to = strip(m[2]);
            if (from && to && from !== to) out.push({ from: from, to: to });
        });
        return out;
    }

    /**
     * AI 校对：让模型只挑错别字/漏字/姓名不一致，按「错误=>正确」逐行返回，回填后本地应用。
     * 单向负责“找”，本地负责“改”，避免模型顺手改写文风。
     * 注意：必须分块校完全文。旧实现只校前 6000 字，长章七成正文从未被校对过——
     * 这就是「润色之后还有错别字」的主要原因。
     */
    async proofreadText(text) {
        const src = String(text || '');
        if (src.trim().length < 30) return { text: src, applied: [] };
        const charNames = this.collectProperNouns().filter(n => n && n.length >= 2);
        const nameHit = (s) => charNames.some(n => s.indexOf(n) >= 0);
        const settings = this.getLiveAISettings();
        // 分块：每块单独问一次，块越大模型越容易看漏，2600 字左右一快比较稳
        const CHUNK = 2600;
        const chunks = [];
        for (let i = 0; i < src.length; i += CHUNK) chunks.push(src.slice(i, i + CHUNK));
        let out = src;
        const applied = [];
        for (let i = 0; i < chunks.length; i++) {
            if (!chunks[i].trim()) continue;
            const prompt = [
                '【任务】校对下面的小说正文，只找四类问题：错别字、漏字或多字、与角色档案不一致的姓名写法。',
                charNames.length ? '【角色姓名（必须完全一致）】' + charNames.join('、') : '',
                '【姓名检查（重点）】逐字核对正文里每一个出现的人名：多字（陈橙橙写成陈橙）、少字、写错字（林栀写成林简）、' +
                '突然换成别的写法或昵称，一律按上面的原名输出「错误写法=>正确写法」。人名是本章最高频的词，错一处读者就会出戏。',
                '【输出格式】每行一条：错误写法=>正确写法',
                '只有确实发现错误才输出；没有错误就只输出「无」。不要输出解释、序号或任何改动建议。',
                '【正文】',
                chunks[i]
            ].filter(Boolean).join('\n');
            let res = '';
            try {
                res = await this.callAIAPI('你是嚴謹的语文校对员，只按指定格式输出校对结果。', prompt,
                    settings, { maxTokens: 1200, genType: 'sub', onChunk: () => {} });
            } catch (e) { continue; }   // 单块失败就跳过，不影响其它块
            this.parseProofreadFixes(res).forEach(f => {
                if (!f.from || !f.to || f.from === f.to) return;
                // 长度差太大视为改写而非校错（允许 2 字以内：既拦「整句重写」，也放过常见的多字/漏字）
                if (Math.abs(f.from.length - f.to.length) > 2) return;
                // 会把正常用词打碎的「纠错」一律拒绝（AI 校对常犯：在也=>再也 会把「现在也没」改坏）
                if (this.isRiskyReplacement(f.from, out)) return;
                // 守卫：不许把普通词改写成角色名（详见 findTypos 同名注释）
                if (nameHit(f.to) && !nameHit(f.from)) return;
                if (out.split(f.from).length - 1 === 0) return;
                out = out.split(f.from).join(f.to);
                applied.push({ from: f.from, to: f.to, kind: 'ai' });
            });
        }
        return { text: out, applied: applied };
    }

    /** 生成后的错别字处理：先本地确定性修正，再让模型校对一遍 */
    async polishTypos(text, label) {
        const det = this.applyTypoFixes(text);
        let out = det.text;
        const applied = det.applied.slice();
        if (out.trim().length >= 30) {
            const ai = await this.proofreadText(out);
            if (ai.applied.length) { out = ai.text; applied.push(...ai.applied); }
        }
        if (applied.length && typeof this.showNotification === 'function') {
            this.showNotification((label || '本次输出') + '已修正错别字 ' + applied.length +
                ' 处：' + applied.slice(0, 6).map(f => f.from + '→' + f.to).join('、') +
                (applied.length > 6 ? ' 等' : ''), 'warning');
        }
        return { text: out, applied: applied };
    }

    /** 删掉模型自作主张输出的章节标题行（如「第4章《聚光灯外》」） */
    stripChapterHeadings(text) {
        return String(text || '')
            .split('\n')
            .filter(line => !/^\s*第[0-9一二三四五六七八九十百千]+章(?:[\s《：:]|$)/.test(line))
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    /** 把「生成提示」拆成逐条约束，便于在 prompt 里编号执行 */
    parseConstraints(prompt) {
        const raw = String(prompt || '').trim();
        if (!raw) return [];
        const seen = new Set();
        return raw
            .split(/\n|；|;|。|，|,/)
            .map(s => s.trim())
            .filter(s => s.length >= 2 && !seen.has(s) && seen.add(s))
            .slice(0, 12);
    }

    /** 按 id 取作品（并行任务里当前作品可能不是目标任务所属的作品） */
    findWorkById(id) {
        const works = (this.data && Array.isArray(this.data.works)) ? this.data.works : [];
        return works.find(w => w && w.id === id) || this.work;
    }

    /** 取「上一章」正文的结尾，作为空章节续写时的接续上下文 */
    getPreviousChapterTail(work, chapter, maxLen) {
        const chapters = ((work && work.chapters) || []).slice()
            .sort((a, b) => (a.number || 0) - (b.number || 0));
        if (!chapters.length) return '';
        let idx = chapters.findIndex(c => chapter && (c.id === chapter.id));
        if (idx < 0 && chapter) idx = chapters.findIndex(c => c.number === chapter.number);
        if (idx < 0) idx = chapters.length;
        const limit = maxLen || 1600;
        for (let i = idx - 1; i >= 0; i--) {
            const raw = String(chapters[i] && chapters[i].content || '').trim();
            if (!raw) continue;
            const clean = this.stripChapterHeadings(raw).trim();
            if (!clean) continue;
            return clean.length > limit ? '……' + clean.slice(-limit) : clean;
        }
        return '';
    }

    /**
     * 取「下一章」的上下文，用于让当前章为其铺垫、与之连贯。
     * 优先用下一章正文开头；下一章还没写但有大纲概要时，返回概要；都没有则返回 ''。
     */
    getNextChapterContext(work, chapter, maxLen) {
        const chapters = ((work && work.chapters) || []).slice()
            .sort((a, b) => (a.number || 0) - (b.number || 0));
        if (!chapters.length) return '';
        let idx = chapters.findIndex(c => chapter && c.id === chapter.id);
        if (idx < 0 && chapter) idx = chapters.findIndex(c => c.number === chapter.number);
        if (idx < 0) idx = -1;
        const next = chapters[idx + 1];
        if (!next) return '';
        const limit = maxLen || 1200;
        const raw = String(next.content || '').trim();
        if (raw) {
            const clean = this.stripChapterHeadings(raw).trim();
            return clean.length > limit ? clean.slice(0, limit) + '……' : clean;
        }
        if (next.summary && next.summary.trim()) {
            return '（下一章尚未动笔，仅有概要）' + next.summary.trim();
        }
        return '';
    }

    /** 收集各章已用过的开场句（按章节顺序，去重，最多 15 条） */
    collectChapterOpenings(work) {
        const chapters = ((work && work.chapters) || []).slice()
            .sort((a, b) => (a.number || 0) - (b.number || 0));
        const out = [];
        const seen = new Set();
        chapters.forEach(ch => {
            const raw = String(ch && ch.content || '').trim();
            if (!raw) return;
            const firstPara = (this.stripChapterHeadings(raw).trim().split(/\n+/)[0] || '').trim();
            const sentence = (firstPara.match(/^[^。！？!?…]{4,40}[。！？!?…]?/) || [''])[0].trim();
            const key = sentence.replace(/[\s，。！？、；：""''…—]/g, '');
            if (key.length < 6 || seen.has(key)) return;
            seen.add(key);
            out.push(sentence);
        });
        return out.slice(0, 15);
    }

    /** 生成「禁止重复开场」提示块 */
    buildOpeningBanNotice(work) {
        const list = this.collectChapterOpenings(work);
        if (!list.length) {
            return '【开场硬性要求】不要用「清晨的阳光 / 窗外的阳光 / 夜色渐深 / 夜幕降临 / 华灯初上 / 时光飞逝 / 转眼间 / 第二天 / 次日」这类时间+天气句式起笔；第一句直接写正在发生的动作、对话，或一个具体的声音、触感。';
        }
        return '【已用过的章节开场（禁止再用相同或近似的开头）】\n' +
            list.map(s => '· ' + s).join('\n') +
            '\n【开场硬性要求】上面这些开场句在本作里已经出现过，本次绝不能再用，也不能换几个字再用（等同义改写也算重复）；' +
            '同样不要用「清晨的阳光 / 窗外的阳光 / 阳光透过 / 夜色渐深 / 夜幕降临 / 华灯初上 / 时光飞逝 / 转眼间 / 第二天 / 次日」这类时间+天气句式起笔；' +
            '第一句直接写正在发生的动作、对话，或一个具体的声音、触感，让读者立刻进入事件。';
    }

    /**
     * 收集「本篇已经写过的、不该再出现的句子」：
     *  - 已有章节里重复出现 ≥2 次的句子（典型是每天清晨的广播词、固定开场白）
     *  - 各章首句（与开场禁令配合）
     * 让模型在写下一章时直接避开这些原句，从根上治「同一段广播词在 4 章里各抄一遍」。
     */
    getRepetitiveSentencesNotice(work) {
        const chapters = ((work && work.chapters) || []).slice()
            .sort((a, b) => (a.number || 0) - (b.number || 0));
        const freq = {};
        chapters.forEach(ch => {
            const seenInChapter = {};
            String(this.stripChapterHeadings(String((ch && ch.content) || '')))
                .split(/[。！？!?\n]/).forEach(s => {
                    const t = s.trim().replace(/^["“'‘「『\s]+|["”’」』\s]+$/g, '');
                    if (t.length < 8 || t.length > 45) return;
                    if (seenInChapter[t]) return;           // 同一章内只计一次，避免一章内复读刷权重
                    seenInChapter[t] = 1;
                    freq[t] = (freq[t] || 0) + 1;
                });
        });
        const repeated = Object.keys(freq).filter(s => freq[s] >= 2)
            .sort((a, b) => freq[b] - freq[a]).slice(0, 8);
        const openings = this.collectChapterOpenings(work).slice(0, 6);
        if (!repeated.length && !openings.length) return '';
        const lines = [];
        if (repeated.length) {
            lines.push('【本篇已反复出现的原句（严禁再用，也不能换几个字改写后再用）】\n' +
                repeated.map(s => '· ' + s).join('\n'));
        }
        if (openings.length) {
            lines.push('【已用过的章节开场（相同或近似都不行）】\n' +
                openings.map(s => '· ' + s).join('\n'));
        }
        lines.push('上面这些句子在本作里已经出现过，本章一律不得再出现；本章要写的是新内容、新场景、新进展，' +
            '不得把已经发生过的清晨/广播/教室开场换个章再抄一遍。');
        return lines.join('\n\n');
    }

    /**
     * 输出后兜底：首段若是套路化开场或与已有章节开场重合，跳过这一段。
     * onlyBanned=true 时只拦「与已有章节开场雷同」，不碰「第二天」这类正当转场。
     * 整段删掉太亏时退化为删掉开头那一句（如「清晨的阳光透过窗户，洒在她的侧脸上。」）。
     */
    stripFormulaicOpening(text, openings, onlyBanned) {
        let s = String(text || '');
        const bannedList = openings || [];
        const normKey = (v) => String(v || '').replace(/[\s，。！？、；：""''…—]/g, '');
        for (let pass = 0; pass < 2; pass++) {
            if (!s.trim()) return s;
            const nl = s.indexOf('\n');
            const firstPara = (nl > 0 ? s.slice(0, nl) : s).trim();
            if (!firstPara) return s;
            const head = normKey(firstPara).slice(0, 14);
            const hitBanned = bannedList.some(b => {
                const t = normKey(b).slice(0, 14);
                return t.length >= 6 && head.length >= 6 &&
                    (t === head || t.indexOf(head) > -1 || head.indexOf(t) > -1);
            });
            const hitPattern = !onlyBanned &&
                /^(清晨|早晨|天刚亮|天才亮|阳光透过|窗外的阳光|阳光洒|夜色渐深|夜幕降临|华灯初上|时光飞逝|转眼间|第二天|次日|翌日)/.test(firstPara);
            if (!hitBanned && !hitPattern) return s;

            // 首选：整段跳过
            const rest = s.slice(nl > 0 ? nl : s.length).replace(/^\s+/, '');
            if (rest.trim().length >= 300 && rest.length >= s.length * 0.5) {
                s = rest;
                continue;
            }
            // 次选：只删开头那一句
            const firstSentence = (firstPara.match(/^[^。！？!?…]{2,60}[。！？!?…]/) || [''])[0];
            const afterSentence = firstPara.slice(firstSentence.length).trim();
            if (firstSentence && afterSentence.length >= 30) {
                const merged = afterSentence + (nl > 0 ? '\n' + s.slice(nl + 1) : '');
                if (merged.length >= s.length * 0.5) {
                    s = merged;
                    continue;
                }
            }
            return s;
        }
        return s;
    }

    /**
     * 把本章正文交给模型用于「通读」。
     * 未超过 limit → 原文全文；超过 → 开头原文 + 中段剧情骨架 + 结尾原文。
     * 中段骨架按段落抽首句，覆盖全章脉络，避免只给尾巴导致剧情断线。
     */
    buildFullChapterContext(text, limit) {
        const t = String(text || '').trim();
        if (!t) return '（本章还没有正文）';
        limit = limit || 12000;
        if (t.length <= limit) return t;

        const head = Math.min(3000, Math.floor(limit * 0.22));
        const tail = Math.min(9000, Math.floor(limit * 0.55));
        const midBudget = Math.max(600, limit - head - tail - 160);
        const midStart = head;
        const midEnd = Math.max(midStart, t.length - tail);
        const outline = this.buildMiddleOutline(t.slice(midStart, midEnd), midBudget);
        const omitted = Math.max(0, (midEnd - midStart) - outline.length);

        return t.slice(0, head) +
            '\n\n……（以下是本章中段的剧情骨架：按段落抽取，省略约 ' + omitted + ' 字细节）……\n\n' +
            outline +
            '\n\n……（以下是本章结尾原文，续写请从这里接着写）……\n\n' +
            t.slice(-tail);
    }

    /** 从一段正文抽取「每段/每句的第一个分句」拼成剧情骨架，用于长章节通读 */
    buildMiddleOutline(segment, budget) {
        const s = String(segment || '').trim();
        if (!s) return '';
        // 段落太少（整章一整块）时改按句子切分
        let units = s.split(/\n+/).map(x => x.trim()).filter(Boolean);
        if (units.length < 6) {
            units = s.split(/(?<=[。！？!?…])/).map(x => x.trim()).filter(Boolean);
        }
        const lines = units.map(u => {
            const m = u.match(/^[^。！？!?…]{0,70}[。！？!?…]?/);
            const line = ((m && m[0]) || u).trim();
            return line.length > 80 ? line.slice(0, 80) + '…' : line;
        }).filter(Boolean);
        if (!lines.length) return s.slice(0, budget);

        let out = lines.join('\n');
        if (out.length <= budget) return out;
        // 超预算时等间隔抽样，保住「前 → 后」的推进顺序
        const step = Math.max(1, Math.ceil(lines.length / Math.max(6, Math.floor(budget / 50))));
        out = lines.filter((_, i) => i % step === 0).join('\n');
        if (out.length <= budget) return out;
        return out.slice(0, budget) + '…';
    }

    /**
     * 去除续写开头对「已有正文」的复述，并清理模型自身重复的段落。
     * 7B 级小模型经常先抄上文最后几句再续写，造成「生成内容重复」。
     */
    stripRepeatedLead(text, existing) {
        let out = String(text || '');
        if (!out.trim()) return out;
        const norm = s => String(s || '').replace(/\s+/g, '');
        const existingNorm = norm(existing);
        // 1) 掐掉与「已有正文结尾」重叠的开头：按字符数从多到少找最长重叠
        const tail = existingNorm.slice(-240);
        const lead = norm(out).slice(0, 240);
        for (let k = Math.min(tail.length, lead.length, 200); k >= 8; k--) {
            if (lead.slice(0, k) !== tail.slice(tail.length - k)) continue;
            let cnt = 0, idx = 0;
            for (; idx < out.length && cnt < k; idx++) if (!/\s/.test(out[idx])) cnt++;
            out = out.slice(idx);
            break;
        }
        // 2) 逐行去重：复述上文的行、自我连续重复的行
        const tailLines = new Set(String(existing || '').split('\n')
            .map(l => norm(l)).filter(l => l.length >= 8).slice(-6));
        let prev = '';
        const kept = [];
        out.split('\n').forEach(line => {
            const n = norm(line);
            if (n && n.length >= 8) {
                if (tailLines.has(n)) return;                                  // 复述上文结尾的段落
                if (n === prev) return;                                         // 连续重复同一行
                if (prev && n.length >= 20 && prev.indexOf(n) >= 0) return;     // 被上一行完整包含
                // 整行与已有正文里任意一句完全一致 → 也是在复述，且不跨句边界误伤
                if (n.length >= 12 && existingNorm.indexOf(n) >= 0) return;
            }
            kept.push(line);
            if (n) prev = n;
        });
        out = kept.join('\n');
        // 3) 句子级去重：模型还会在**同一段里**把同一句话写两遍（句级完全重复且 ≥10 字，只留第一句）
        const sentSeen = new Set();
        out = out.split('\n').map(line => {
            // 句末的引号/括号跟着本句走，避免拆出一堆孤立的 ”）
            const sents = line.match(/[^。！？…]*[。！？…][”」』"']*|[^。！？…]+/g);
            if (!sents || sents.length < 2) return line;
            const keep = [];
            sents.forEach(s => {
                const n = norm(s);
                if (n.length >= 10) {
                    if (sentSeen.has(n)) return;
                    sentSeen.add(n);
                }
                keep.push(s);
            });
            return keep.join('');
        }).join('\n');
        // 4) 收尾：去掉开头空行、压缩多余空行
        out = out.replace(/^\s*\n+/, '').replace(/\n{3,}/g, '\n\n');
        return out;
    }

    /** 可被中止的等待 */
    _sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            const abortErr = () => { const e = new Error('生成已停止'); e.name = 'AbortError'; return e; };
            if (signal && signal.aborted) return reject(abortErr());
            const onAbort = () => { clearTimeout(t); if (signal.removeEventListener) signal.removeEventListener('abort', onAbort); reject(abortErr()); };
            const t = setTimeout(() => { if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
            if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort);
        });
    }

    /**
     * 全局串行化云端 AI 请求，并保证相邻请求至少间隔 1.2s。
     * 免费模型通常只允许 1~2 并发，连续点「续写/生成整章」时很容易自己把自己顶到 429。
     */
    async _throttleAI(base, opts = {}) {
        if (this.isLocalApiUrl(base)) return; // 本地模型无频率限制
        if (!this._aiQueue) { this._aiQueue = Promise.resolve(); this._lastAIRequestAt = 0; }
        const minInterval = 600;
        const myTurn = this._aiQueue.then(async () => {
            const wait = this._lastAIRequestAt + minInterval - Date.now();
            if (wait > 0) await this._sleep(wait, opts.signal);
            this._lastAIRequestAt = Date.now();
        });
        this._aiQueue = myTurn.catch(() => {});
        await myTurn;
    }

    /** 对 429 / 5xx / 网络错误做指数退避重试，优先遵守服务端的 Retry-After */
    async _fetchWithBackoff(doFetch, opts = {}) {
        const maxAttempts = 5;
        let waitMs = 1500;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            let res;
            try {
                res = await doFetch();
            } catch (e) {
                if (e && e.name === 'AbortError') throw e;
                // 配置类错误重试也没用，直接抛给用户看
                if (e && /服务尚未配置/.test(e.message || '')) throw e;
                if (attempt >= maxAttempts) throw e;
                const delay = waitMs + Math.floor(Math.random() * 400);
                this.showNotification('网络异常，' + Math.ceil(delay / 1000) + ' 秒后重试（' + attempt + '/' + (maxAttempts - 1) + '）', 'warning');
                await this._sleep(delay, opts.signal);
                waitMs = Math.min(waitMs * 2, 12000);
                continue;
            }
            if (res.ok || res.status === 404) return res;
            const retryable = res.status === 429 || res.status >= 500;
            if (!retryable || attempt >= maxAttempts) return res;
            let delay = waitMs + Math.floor(Math.random() * 400);
            const ra = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
            if (ra) {
                const sec = parseInt(ra, 10);
                if (!isNaN(sec) && sec > 0) delay = Math.max(delay, sec * 1000);
            }
            try { await res.text(); } catch (e) { /* 释放旧响应体 */ }
            const waitSec = Math.ceil(delay / 1000);
            this.showNotification(
                res.status === 429
                    ? '请求过于频繁（限流），' + waitSec + ' 秒后自动重试（' + attempt + '/' + (maxAttempts - 1) + '）'
                    : '服务暂时不可用（' + res.status + '），' + waitSec + ' 秒后重试',
                'warning');
            await this._sleep(delay, opts.signal);
            waitMs = Math.min(waitMs * 2, 12000);
        }
    }

    /**
     * 调用 AI API（OpenAI 兼容协议）—— 支持流式输出、Ollama 原生接口回退、友好错误提示
     * opts: { onChunk(delta, full), signal, apiKey }
     */
    async callAIAPI(systemPrompt, userPrompt, settings, opts = {}) {
        const base = this.normalizeApiBase(settings.apiUrl);
        if (!base) throw new Error(ZHIMO_LOCK ? '服务暂不可用，请稍后重试' : '请先在设置中填写 API 地址（本地模型如 http://localhost:11434/v1）');
        const url = base + '/chat/completions';

        const model = (settings.aiModel || '').toLowerCase();
        const useStream = settings.streamEnabled !== false && typeof opts.onChunk === 'function';

        const requestBody = {
            model: settings.aiModel,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            stream: useStream
        };

        if (model.includes('kimi') || model.includes('moonshot')) {
            // Kimi 系列：temperature 固定，不发送
        } else if (/^o[1-9]/.test(model)) {
            requestBody.temperature = 1;
        } else {
            requestBody.temperature = 0.8;
        }

        // 本地小模型（如 qwen3:1.7b）默认开启「思考」模式会大量挤占正文输出；
        // 显式给定 token 预算，并对 qwen 系列关闭思考，避免输出只有设定的一半
        const lenTokens = opts.maxTokens
            || { short: 600, medium: 1400, long: 2600, chapter: 6000 }[settings.genLength]
            || 2400;
        requestBody.max_tokens = lenTokens;
        requestBody.num_predict = lenTokens;
        // 本地模型采样容易「复读」（重复上一段），加上重复惩罚；云端接口不发送这些字段以免报错
        if (this.isLocalApiUrl(base)) {
            requestBody.repeat_penalty = 1.15;
            requestBody.frequency_penalty = 0.4;
            requestBody.presence_penalty = 0.3;
        }
        if (model.includes('qwen')) {
            requestBody.think = false;
            requestBody.enable_thinking = false;
        }
        // 智谱 GLM-4.5+ 默认可能开启「思考」，会把 token 全花在 reasoning_content 上，
        // 正文为空（表现为点了续写却没反应）。写小说不需要思考，显式关闭。
        if (/bigmodel\.cn/i.test(base) && /^glm-(4\.[5-9]|[5-9])/i.test(model)) {
            requestBody.thinking = { type: 'disabled' };
        }

        // 免费模型有并发/QPS 限制：全局串行 + 最小间隔，避免自己把自己挤到 429
        await this._throttleAI(base, opts);

        const doFetch = async () => {
            // 锁定模式（分享版 App）：只认打包时写入的那一条转发接口，
            // 请求里只有激活码，接口地址与真实 Key 全在服务端
            if (ZHIMO_LOCK) {
                if (!ZHIMO_LOCK.endpoint) throw new Error('服务尚未配置，请联系卖家');
                const lic = zimoGetLicense();
                if (!lic) throw new Error('请先输入激活码');
                return fetch(ZHIMO_LOCK.endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-license': lic,
                        'x-device': zimoDeviceId(),
                        // 服务端按「章」算额度：一章会拆成多次请求，
                        // 第 1 段算一章，后续分段/校对/补写都标 sub，不重复扣额度
                        'x-gen': opts.genType === 'sub' ? 'sub' : 'chapter'
                    },
                    body: JSON.stringify({ payload: requestBody }),
                    signal: opts.signal
                });
            }
            // 云端（非本机）请求走本地服务器转发，避免浏览器跨域预检拦截；本地模型仍直连
            const proxyUrl = this.isLocalApiUrl(base) ? '' : this.getAIProxyUrl();
            if (proxyUrl) {
                return fetch(proxyUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: url, apiKey: settings.apiKey || '', payload: requestBody }),
                    signal: opts.signal
                });
            }
            return fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + (settings.apiKey || '')
                },
                body: JSON.stringify(requestBody),
                signal: opts.signal
            });
        };

        let response;
        try {
            response = await this._fetchWithBackoff(doFetch, opts);
        } catch (e) {
            if (e && e.name === 'AbortError') throw new Error('生成已停止');
            throw new Error(this.describeNetworkError(e, base));
        }

        // 404 时自动回退到 Ollama 原生接口 /api/chat（地址没带 /v1 时很常见）
        if (response.status === 404 && !ZHIMO_LOCK) {
            try {
                return await this.callOllamaNative(base, requestBody, opts);
            } catch (nativeErr) {
                // 最常见原因是「模型名未安装」：自动改成本机已安装的模型再试一次
                const installed = await this.listLocalModels(base);
                if (installed.length && installed.indexOf(settings.aiModel) === -1 && !opts.__modelRetried) {
                    const picked = installed[0];
                    this.showNotification('模型「' + (settings.aiModel || '未设置') + '」未安装，已自动切换为「' + picked + '」', 'warning');
                    settings = Object.assign({}, settings, { aiModel: picked });
                    this.setValue('aiModel', picked);
                    this.saveSettings();
                    return this.callAIAPI(systemPrompt, userPrompt, settings, Object.assign({}, opts, { __modelRetried: true }));
                }
                if (installed.length) {
                    throw new Error('模型「' + (settings.aiModel || '未设置') + '」未安装。本机已安装：' + installed.join('、') +
                        '。请在「设置」页把模型名改成其中一个；或执行 ollama pull ' + (settings.aiModel || '') + ' 安装该模型。');
                }
                throw nativeErr;
            }
        }

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            // 个别模型不接受 thinking 参数：去掉它自动再试一次，避免直接失败
            if (response.status === 400 && /thinking/i.test(errText) && requestBody.thinking && !opts.__noThinking) {
                delete requestBody.thinking;
                return this.callAIAPI(systemPrompt, userPrompt, settings, Object.assign({}, opts, { __noThinking: true }));
            }
            // 激活码失效/到期/被停用：清掉本地授权，立刻退回激活页
            // 额度用尽（429 LICENSE_QUOTA）、设备超限（403 LICENSE_DEVICE_LIMIT）只提示，不清码
            if (ZHIMO_LOCK && (response.status === 401 || response.status === 403 || response.status === 429)) {
                let errObj = null;
                try { errObj = JSON.parse(errText); } catch (e) { errObj = null; }
                const errCode = errObj && errObj.error && errObj.error.code;
                const errMsg = (errObj && errObj.error && errObj.error.message) || '';
                if (errCode && errCode.indexOf('LICENSE_') === 0) {
                    if (zimoLicenseFatal(errCode)) {
                        zimoClearLicense(errMsg);
                        throw new Error(errMsg || '激活码已失效，请重新输入');
                    }
                    throw new Error(errMsg || '暂时无法使用，请稍后再试');
                }
            }
            throw new Error(this.describeHttpError(response.status, errText));
        }

        if (useStream) {
            return this.readSSEStream(response, opts.onChunk, opts.signal);
        }

        const data = await response.json();
        // 有些平台出错也返回 200，只把错误放在 error 字段里
        if (data && data.error) {
            const msg = (data.error.message || data.error.code || '接口返回错误');
            throw new Error(ZHIMO_LOCK ? '服务暂时不可用：' + msg : '接口返回错误：' + msg);
        }
        if (data.choices && data.choices[0] && data.choices[0].message) {
            const msg = data.choices[0].message;
            if (!msg.content && msg.reasoning_content) {
                throw new Error(ZHIMO_LOCK
                    ? '模型这次没有输出正文，请重试一次。'
                    : '模型只返回了思考过程，正文为空（max_tokens 可能被思考耗尽）。已自动关闭思考，请再点一次；仍为空请联系卖家。');
            }
            return this.sanitizeBrokenChars(msg.content);
        }
        throw new Error('API返回格式异常');
    }

    /** 纯清洗：去掉编码损坏产生的替换字符（不改动正常文字） */
    stripBrokenChars(text) {
        const s = String(text == null ? '' : text);
        if (!s) return s;
        if (s.indexOf('\uFFFD') < 0 && s.indexOf('锟斤拷') < 0 && s.indexOf('ï¿½') < 0) return s;
        return s.replace(/\uFFFD+/g, '').replace(/锟斤拷/g, '').replace(/ï¿½/g, '');
    }

    /** 清洗 + 每次会话提示一次（说明乱码来源与处理办法） */
    sanitizeBrokenChars(text) {
        const s = String(text == null ? '' : text);
        if (!s) return s;
        const cleaned = this.stripBrokenChars(s);
        if (cleaned.length !== s.length) {
            this._encodingIssues = (this._encodingIssues || 0) + 1;
            if (this._encodingIssues === 1) {
                this.showNotification('检测到输出里有编码损坏字符（���），已自动清除，不会写进正文。若反复出现，请重启 App 让本地服务加载新代码。', 'warning');
            }
        }
        return cleaned;
    }

    /** 解析 OpenAI 兼容的 SSE 流式响应 */
    async readSSEStream(response, onChunk, signal) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let full = '';
        let reasoning = '';
        while (true) {
            // 主动检查中止信号：部分环境下流不会立即报错，这里保证「停止」一定生效
            if (signal && signal.aborted) throw new Error('生成已停止');
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.indexOf('data:') !== 0) continue;
                const payload = trimmed.slice(5).trim();
                if (payload === '[DONE]') continue;
                try {
                    const json = JSON.parse(payload);
                    const choice = json.choices && json.choices[0];
                    const rawDelta = choice && ((choice.delta && choice.delta.content) || (choice.message && choice.message.content)) || '';
                    const rc = choice && choice.delta && choice.delta.reasoning_content;
                    if (rc) reasoning += rc;
                    // 编码损坏的替换字符（���）在这里就清掉，绝不写进编辑器/正文
                    const delta = this.sanitizeBrokenChars(rawDelta);
                    if (delta) {
                        full += delta;
                        onChunk(delta, full);
                    }
                } catch (e) { /* 忽略不完整的 JSON 行 */ }
            }
        }
        // 流结束：把解码器里残留的半个字符冲出来（不影响正常内容）
        buffer += decoder.decode();
        if (!full && reasoning) {
            throw new Error('模型只返回了思考过程，正文为空（max_tokens 可能被思考耗尽）。已自动关闭思考，请再点一次；仍为空请联系卖家。');
        }
        return full;
    }

    /** 查询 Ollama 原生 /api/tags，返回本机已安装的模型名列表（非 Ollama 服务时返回空数组） */
    async listLocalModels(base) {
        try {
            const root = String(base || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
            const res = await fetch(root + '/api/tags', { method: 'GET' });
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data.models) ? data.models.map(m => m && m.name).filter(Boolean) : [];
        } catch (e) {
            return [];
        }
    }

    /** Ollama 原生 /api/chat 接口（作为 /v1 不可用时的回退） */
    async callOllamaNative(base, requestBody, opts = {}) {
        const useStream = requestBody.stream && typeof opts.onChunk === 'function';
        const payload = {
            model: requestBody.model,
            messages: requestBody.messages,
            stream: useStream,
            ...(requestBody.num_predict ? { num_predict: requestBody.num_predict } : {}),
            ...(requestBody.think !== undefined ? { think: requestBody.think } : {})
        };
        let res;
        try {
            res = await fetch(base + '/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + (requestBody.apiKey || '')
                },
                body: JSON.stringify(payload),
                signal: opts.signal
            });
        } catch (e) {
            if (e && e.name === 'AbortError') throw new Error('生成已停止');
            throw new Error(this.describeNetworkError(e, base));
        }
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error('OpenAI 兼容接口返回 404，已尝试 Ollama 原生接口但仍失败（' + res.status + '）：' + errText.substring(0, 150) +
                '。请检查 API 地址与模型名。');
        }
        if (!useStream) {
            const data = await res.json();
            return this.sanitizeBrokenChars((data.message && data.message.content) || '');
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let full = '';
        while (true) {
            // 主动检查中止信号，保证「停止」一定生效
            if (opts.signal && opts.signal.aborted) throw new Error('生成已停止');
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const t = line.trim();
                if (!t) continue;
                try {
                    const json = JSON.parse(t);
                    const delta = this.sanitizeBrokenChars((json.message && json.message.content) || '');
                    if (delta) {
                        full += delta;
                        opts.onChunk(delta, full);
                    }
                } catch (e) { /* 忽略不完整的 JSON 行 */ }
            }
        }
        buffer += decoder.decode();
        return this.sanitizeBrokenChars(full);
    }

    insertGenerated() {
        if (!this.generatedContent) {
            this.showNotification('没有可插入的内容，请先点击「开始生成」', 'warning');
            return;
        }
        const textarea = document.getElementById('chapterContent');
        if (!textarea) return;
        const mode = document.getElementById('genInsertMode')?.value || 'cursor';
        if (mode === 'append') {
            const cur = textarea.value;
            textarea.value = cur + (cur && !cur.endsWith('\n\n') ? '\n\n' : '') + this.generatedContent;
        } else {
            const cursorPos = textarea.selectionStart;
            const text = textarea.value;
            textarea.value = text.substring(0, cursorPos) + this.generatedContent + text.substring(cursorPos);
        }
        this.updateEditorWordCount();
        this.markDirty();
        this.closeModal('generateModal');
        this.showNotification('内容已插入', 'success');
        if (this.currentChapter) this.saveChapter();
    }

    regenerate() {
        this.executeGeneration();
    }

    /* ============ 多章节并行 AI 续写 ============ */

    /**
     * AI 续写（工具栏按钮 / Ctrl+Enter）：当前章节正在续写就停止，否则启动。
     * 续写任务按章节独立存在，可多章同时进行、互不影响，切换或离开章节也会在后台继续跑。
     */
    quickContinue() {
        if (!this.currentChapter) {
            this.showNotification('请先选择或新建一个章节', 'warning');
            return;
        }
        this.toggleContinueJob(this.currentChapter.id);
    }

    /** 为某一章启动 / 停止续写（章节列表里的 ✨ / ⏹ 按钮走这里） */
    toggleContinueJob(chapterId) {
        if (!chapterId) {
            this.showNotification('该章节缺少 id，请先保存一次再试', 'warning');
            return;
        }
        if (this.continueJobs.has(chapterId)) this.stopContinueJob(chapterId);
        else this.startContinueJob(chapterId);
    }

    getMaxParallelContinue() { return 5; }

    /**
     * 启动一个章节的续写任务。任务自己持有一份正文（job.content），
     * 与编辑器、其他章节完全解耦：只有该章正被打开时才把内容镜像进 textarea。
     */
    startContinueJob(chapterId) {
        const chapter = this.work.chapters.find(c => c.id === chapterId);
        if (!chapter) { this.showNotification('未找到该章节', 'error'); return; }
        if (this.continueJobs.has(chapterId)) return;
        if (this.continueJobs.size >= this.getMaxParallelContinue()) {
            this.showNotification('同时最多 ' + this.getMaxParallelContinue() + ' 章并行续写，请先停止一个任务', 'warning');
            return;
        }
        // 同一章不能同时润色和续写：两者都会改写正文，启动续写前先停掉该章润色
        const pjob = this.polishJobs.get(chapterId);
        if (pjob && pjob.running) {
            pjob.running = false;
            try { pjob.abort.abort(); } catch (e) { /* 忽略 */ }
            this.polishJobs.delete(chapterId);
            this.showNotification('已先停止第 ' + chapter.number + ' 章的润色（润色与续写不能同时改同一章）', 'info');
        }
        // 同一章正在后台生成整章时也先停掉：两者都会改写整章正文
        const fjob = this.fullChapterJobs.get(chapterId);
        if (fjob && fjob.running) {
            fjob.running = false;
            try { fjob.abort.abort(); } catch (e) { /* 忽略 */ }
            this.fullChapterJobs.delete(chapterId);
            this.showNotification('已先停止第 ' + chapter.number + ' 章的整章生成（不能同时改写同一章）', 'info');
        }
        // 正在编辑的章节以「编辑器里尚未保存的正文」为准，其他章节用已保存正文
        if (this.currentChapter && this.currentChapter.id === chapterId) {
            const ta = document.getElementById('chapterContent');
            if (ta && typeof ta.value === 'string') chapter.content = ta.value;
        }
        const job = {
            chapterId: chapterId,
            // 记下所属作品：用户中途切换作品后，任务照样能找回自己的章节继续存盘
            workId: this.work.id,
            chapterNumber: chapter.number,
            chapterTitle: chapter.title,
            abort: new AbortController(),
            running: true,
            content: chapter.content || '',
            baseLen: (chapter.content || '').length,
            added: 0,
            rounds: 0,
            stopReason: '',
            lastNorm: '',
            stallRounds: 0,
            startedAt: Date.now()
        };
        this.continueJobs.set(chapterId, job);
        this.refreshTaskUI();
        this.showNotification('已开始续写「第 ' + chapter.number + ' 章' +
            (chapter.title ? ' ' + chapter.title : '') + '」，可切到别的章节同时续写', 'info');
        // 任务内部已 try/catch，这里再兜一层，防止任何意外错误变成未捕获的 Promise 异常
        this.runContinueJob(job).catch(err => {
            this.continueJobs.delete(job.chapterId);
            this.refreshTaskUI();
            this.showNotification('第 ' + (chapter.number || '?') + ' 章续写异常：' + ((err && err.message) || err), 'error');
        });
    }

    /** 手动停止某一章的续写（其他章节的任务不受影响） */
    stopContinueJob(chapterId) {
        const job = this.continueJobs.get(chapterId);
        if (!job) return;
        job.running = false;
        job.stopReason = job.stopReason || 'user';
        try { job.abort.abort(); } catch (e) { /* 忽略 */ }
        const ch = this.work.chapters.find(c => c.id === chapterId) || {};
        this.showNotification('正在停止「第 ' + (ch.number || '?') + ' 章」的续写...', 'info');
        this.renderJobsBar();
    }

    stopAllContinue() {
        const ids = Array.from(this.continueJobs.keys());
        if (!ids.length) return;
        ids.forEach(id => this.stopContinueJob(id));
    }

    /** 「全部停止」：续写 + 润色 + 整章生成一起停（各自独立收尾，已写内容都会保留） */
    stopAllTasks() {
        this.stopAllContinue();
        Array.from(this.polishJobs.keys()).forEach(id => {
            const j = this.polishJobs.get(id);
            if (j && j.running) this.stopPolishJob(id);
        });
        Array.from(this.fullChapterJobs.keys()).forEach(id => {
            const j = this.fullChapterJobs.get(id);
            if (j && j.running) this.stopFullChapterJob(id);
        });
    }

    /** 跨作品按 id 查找章节（优先当前作品，避免不同作品里的重复 id 抢答） */
    findChapterById(chapterId) {
        if (!chapterId) return null;
        const active = this.work;
        if (active && Array.isArray(active.chapters)) {
            const local = active.chapters.find(c => c.id === chapterId);
            if (local) return local;
        }
        const works = this.data.works || [];
        for (let i = 0; i < works.length; i++) {
            const chs = works[i] && works[i].chapters;
            if (!Array.isArray(chs)) continue;
            const found = chs.find(c => c.id === chapterId);
            if (found) return found;
        }
        return null;
    }

    /** 该章是否有正在改写正文的后台任务（续写 / 润色），用于阻止外部同步覆盖编辑器 */
    hasRunningChapterTask(chapterId) {
        if (!chapterId) return false;
        const c = this.continueJobs.get(chapterId);
        if (c && c.running) return true;
        const p = this.polishJobs.get(chapterId);
        return !!(p && p.running);
    }

    /** 按任务记录的作品 id 找回章节（用户切换作品后仍然有效） */
    findJobChapter(job) {
        const work = (this.data.works || []).find(x => x.id === job.workId) || this.work;
        if (!work || !Array.isArray(work.chapters)) return null;
        return work.chapters.find(c => c.id === job.chapterId) || null;
    }

    /** 点击后台任务面板：跳到该任务所属作品与章节 */
    jumpToContinueJob(chapterId) {
        const job = this.continueJobs.get(chapterId);
        if (!job) return;
        if (this.dirty && this.currentChapter) this.saveChapter(true);
        if (this.data.activeWorkId !== job.workId) {
            this.data.activeWorkId = job.workId;
            this.currentChapter = null;
            this.saveData();
            this.renderAll();
        }
        this.loadChapter(chapterId);
    }

    /** 把任务正文镜像进编辑器（仅当该章正是当前打开的章节） */
    paintJobContent(job) {
        if (!this.currentChapter || this.currentChapter.id !== job.chapterId) return;
        const ta = document.getElementById('chapterContent');
        if (!ta) return;
        if (ta.value === job.content) return;
        const atBottom = ta.scrollHeight - ta.scrollTop - ta.clientHeight < 80;
        ta.value = job.content;
        if (atBottom) ta.scrollTop = ta.scrollHeight;
        ta.selectionStart = ta.selectionEnd = job.content.length;
        this.updateEditorWordCount();
    }

    /** 任务正文落盘：只写这一章，不碰编辑器、不切章节 */
    persistJobContent(job) {
        const chapter = this.findJobChapter(job);
        if (!chapter) return;
        chapter.content = job.content;
        chapter.updatedAt = Date.now();
        this.saveData();
        this.renderChapterList();
        if (this.currentChapter && this.currentChapter.id === job.chapterId) {
            this.setSaveStatus('saved', '✓ 已保存 ' + this.nowTime() +
                '（第 ' + chapter.number + ' 章续写中 · ' + job.rounds + ' 段 / +' + job.added + ' 字）');
        }
    }

    /** 工具栏按钮 + 章节列表 + 后台任务面板 一起刷新 */
    refreshTaskUI() {
        const cj = this.currentChapter ? this.continueJobs.get(this.currentChapter.id) : null;
        const btn = document.getElementById('quickContinueBtn');
        if (btn) {
            btn.disabled = false;
            if (cj && cj.running) {
                btn.classList.add('btn-stopping');
                btn.textContent = '⏹ 停止续写';
            } else {
                btn.classList.remove('btn-stopping');
                btn.textContent = '✨ AI续写';
            }
        }
        const pj = this.currentChapter ? this.polishJobs.get(this.currentChapter.id) : null;
        const pbtn = document.getElementById('polishBtn');
        if (pbtn) {
            if (pj && pj.running) {
                pbtn.classList.add('btn-stopping');
                pbtn.textContent = '⏹ 停止润色';
            } else {
                pbtn.classList.remove('btn-stopping');
                pbtn.textContent = '🪄 润色全章';
            }
        }
        this.renderChapterList();
        this.renderJobsBar();
    }

    /** 侧栏「后台任务」面板：续写 / 润色任务各自独立显示进度与停止按钮 */
    renderJobsBar() {
        const bar = document.getElementById('continueJobsBar');
        if (!bar) return;
        const items = [];
        Array.from(this.continueJobs.values()).forEach(j => {
            items.push({
                kind: 'continue', id: j.chapterId, num: j.chapterNumber, title: j.chapterTitle,
                stat: '+' + (j.added || 0) + ' 字'
            });
        });
        Array.from(this.polishJobs.values()).forEach(j => {
            const stat = j.running
                ? ((j.progress && j.progress.total) ? ('修订 ' + j.progress.index + '/' + j.progress.total + ' 段') : '准备中')
                : (j.status === 'done' ? '待应用' : (j.status === 'error' ? '失败' : '已停止'));
            items.push({
                kind: 'polish', id: j.chapterId, num: j.chapterNumber, title: j.chapterTitle,
                stat: stat, running: !!j.running, hint: j.reportText || ''
            });
        });
        Array.from(this.fullChapterJobs.values()).forEach(j => {
            const p = j.progress || {};
            const stat = j.running
                ? ((p.percent ? ('生成 ' + Math.round(p.percent) + '%') : '准备中'))
                : (j.status === 'done' ? '已完成' : (j.status === 'error' ? '失败' : '已停止'));
            items.push({
                kind: 'fullchapter', id: j.chapterId, num: j.chapterNumber, title: j.chapterTitle,
                stat: stat, running: !!j.running
            });
        });
        if (!items.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
        bar.style.display = 'block';
        bar.innerHTML = '<div class="cj-head"><span>⚙ 后台任务 ' + items.length + ' 个</span>' +
            '<button class="btn-small" onclick="app.stopAllTasks()">⏹ 全部停止</button></div>' +
            items.map(it => {
                let icon, click, act;
                if (it.kind === 'continue') {
                    icon = '✨';
                    click = 'app.jumpToContinueJob(\'' + it.id + '\')';
                    act = 'app.stopContinueJob(\'' + it.id + '\')';
                } else if (it.kind === 'polish') {
                    icon = '🪄';
                    click = 'app.openPolishJob(\'' + it.id + '\')';
                    act = it.running ? ('app.stopPolishJob(\'' + it.id + '\')') : ('app.dismissPolishJob(\'' + it.id + '\')');
                } else {
                    icon = '📖';
                    click = 'app.jumpToFullChapterJob(\'' + it.id + '\')';
                    act = it.running ? ('app.stopFullChapterJob(\'' + it.id + '\')') : ('app.dismissFullChapterJob(\'' + it.id + '\')');
                }
                const running = it.kind === 'continue' ? true : !!it.running;
                const dotClass = it.kind === 'polish' ? 'cj-dot-polish' : (it.kind === 'fullchapter' ? 'cj-dot-fullchapter' : 'cj-dot-continue');
                return '<div class="cj-item" onclick="' + click + '" title="' + this.escapeHtml(it.hint || '点击查看') + '">' +
                    '<span class="cj-dot ' + dotClass + '"></span>' +
                    '<span class="cj-name">' + icon + ' 第 ' + (it.num || '?') + ' 章 ' + this.escapeHtml(it.title || '未命名') + '</span>' +
                    '<span class="cj-stat">' + this.escapeHtml(it.stat) + '</span>' +
                    '<button class="cj-stop" title="' + (running ? '停止这一章' : '关闭这条记录') + '" onclick="event.stopPropagation(); ' + act + '">' + (running ? '⏹' : '×') + '</button>' +
                    '</div>';
            }).join('');
    }

    /** 流式输出期间的状态栏节流刷新，避免每 100ms 重建 DOM */
    scheduleContinueUiRefresh() {
        if (this._continueUiTimer) return;
        this._continueUiTimer = setTimeout(() => {
            this._continueUiTimer = null;
            this.renderJobsBar();
            if (!this.currentChapter) return;
            const job = this.continueJobs.get(this.currentChapter.id);
            if (job && job.running) {
                this.setSaveStatus('dirty', 'AI 正在续写「第 ' + (this.currentChapter.number || '?') +
                    ' 章」第 ' + job.rounds + ' 段 · 已新增 ' + job.added + ' 字...');
            }
        }, 400);
    }

    /**
     * 单章续写主循环：只操作 job.content，每轮都以「本任务自己的最新正文」为上下文
     * （callAI 的 opts.contextText），因此多章并行时上下文互不串、正文互不覆盖。
     */
    async runContinueJob(job) {
        const chapter = this.findJobChapter(job);
        if (!chapter) { this.continueJobs.delete(job.chapterId); this.refreshTaskUI(); return; }
        const label = '第 ' + (job.chapterNumber || chapter.number || '?') + ' 章';
        const signal = job.abort.signal;
        const settings0 = this.getLiveAISettings();
        const isLocal = this.isLocalApiUrl(this.normalizeApiBase(settings0.apiUrl || ''));
        const perRoundCap = isLocal ? 2200 : 4000;
        const { min: MIN_CHARS, max: MAX_CHARS } = this.getContinueBounds();
        const TARGET_CHARS = 3400;
        const MAX_ROUNDS = 50;
        const norm = (s) => String(s || '').replace(/\s+/g, '');
        const trimTailStr = (s) => String(s || '').replace(/\s+$/, '');
        let total = 0;      // 本次任务新增字数
        let failed = null;

        try {
            while (!signal.aborted && job.running && job.rounds < MAX_ROUNDS) {
                job.rounds++;
                job.content = trimTailStr(job.content);
                const insertPos = job.content.length;
                const beforeNorm = norm(job.content);
                let written = 0;
                let started = false;
                let pending = '';
                let flushTimer = null;

                const flush = () => {
                    if (!pending) return;
                    const chunk = pending;
                    pending = '';
                    job.content += chunk;
                    written += chunk.length;
                    job.added = Math.max(0, job.content.length - job.baseLen);
                    this.paintJobContent(job);
                    this.scheduleContinueUiRefresh();
                };
                // 记录本轮未落地的缓冲：中断时定时器可能还没触发，
                // 必须在保存前把它刷进正文，否则会出现「编辑器比已保存内容多一截」
                job._flushPending = flush;
                job._flushTimer = null;
                const appendText = (text) => {
                    let chunk = String(text == null ? '' : text);
                    if (!started) {
                        // 去掉模型自带的开头空行；前文非空且未以空行结尾时，只补一个规范段落分隔
                        chunk = chunk.replace(/^[\r\n\s]+/, '');
                        if (!chunk) return;
                        const before = job.content.slice(0, insertPos + written);
                        if (before.trim() !== '' && !/\n\s*\n\s*$/.test(before)) chunk = '\n\n' + chunk;
                        started = true;
                    }
                    if (!chunk) return;
                    pending += chunk;
                    // 每 100ms 才刷新一次编辑器：逐 token 改写长文会非常卡
                    if (!flushTimer) {
                        flushTimer = setTimeout(() => { flushTimer = null; job._flushTimer = null; flush(); }, 100);
                        job._flushTimer = flushTimer;
                    }
                };

                const remainMax = Math.max(300, MAX_CHARS - total);
                const remainMin = Math.max(0, MIN_CHARS - total);
                const want = Math.min(remainMax, Math.max(remainMin, TARGET_CHARS - total));
                const roundTokens = Math.max(400, Math.min(perRoundCap, Math.ceil(want * 1.5)));
                // 第 2 轮起补一句硬约束：小模型拿到「本章全文」后常会从头复述，
                // 复述内容又会被去重逻辑判为重复，表现为「写完一段又回到开头」
                const roundPrompt = job.rounds > 1
                    ? '接着本章最后一句继续往下写；保持时间、地点、在场人物与前文一致；禁止从头复述、禁止重写已出现过的场景；本章已用过的词句和比喻不要再用'
                    : '接着本章最后一句往下写；保持剧情连贯、语言通顺；不要重复本章已经出现过的词句和表达';
                // 空章节第一轮：把上一章结尾交给模型接续，
                // 否则它只会照着「请从一个新场景开始写」编一个「清晨的阳光……」的开头
                const prevTail = (job.rounds === 1 && !job.content.trim())
                    ? this.getPreviousChapterTail(this.findWorkById(job.workId), chapter, 1800)
                    : '';
                const result = await this.callAI('continue', roundPrompt, [], {
                    signal: signal,
                    maxTokens: roundTokens,
                    noExtend: true,
                    noProofread: true,
                    contextText: job.content,   // ★ 本任务自己的正文，多任务互不干扰
                    prevTail: prevTail,         // 空章节时用作接续上下文
                    workId: job.workId,         // 开场清单按任务所属作品统计
                    onChunk: (delta) => appendText(delta)
                });
                if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
                flush();
                if (written === 0 && result) appendText(result);
                if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
                flush();
                if (signal.aborted || !job.running) break;
                if (written === 0) {
                    if (!result) {
                        this.showNotification(label + '：模型返回空正文（可能把 token 用在了思考上）。已自动关闭思考，请再点一次；仍为空请联系卖家。', 'warning');
                    }
                    break;
                }

                // 本轮「原始产出」：重复检测必须基于它，不能用清理后的文本。
                // 否则一旦本轮被判为重复而整段清空，检测对象就变成空串，判断被整条跳过，
                // 于是「写入 → 清空 → 拿同一份上下文再写入 → 再清空」会一路空转到 50 轮。
                const totalBefore = total;
                const roundText = job.content.slice(insertPos);
                const roundNormRaw = norm(roundText);
                if (roundNormRaw && (roundNormRaw === job.lastNorm || beforeNorm.indexOf(roundNormRaw) > -1)) {
                    // 模型把已有正文原样又写了一遍：本轮作废，直接停下，不再重试
                    job.content = job.content.slice(0, insertPos);
                    this.paintJobContent(job);
                    job.stopReason = 'dup';
                    break;
                }
                job.lastNorm = roundNormRaw;

                // 清理本轮：模型自带的章节标题、本轮内重复段落、超出 4500 字的尾部
                let cleaned = this.stripChapterHeadings(roundText);
                if (!cleaned.trim()) {
                    // 只吐了标题/空行，没有正文：回退本轮，避免把章节标题塞进正文
                    job.content = job.content.slice(0, insertPos);
                    this.paintJobContent(job);
                    break;
                }
                // 跨段去重是「6-gram 包含度」启发式，长章节里容易把整轮新内容误判成重复。
                // 原样重复上面已拦下，所以这里若被清掉一半以上就退回原始输出：
                // 宁可留几句重复，也不能把整轮内容吞掉（那正是「写完又回到开始」的根源之一）。
                const rawLen = Math.max(1, cleaned.trim().length);
                const deduped = this.removeRepeatedAgainstChapter(
                    this.dedupeParagraphs(cleaned), job.content.slice(0, insertPos));
                if (deduped.trim().length >= rawLen * 0.5) {
                    cleaned = deduped;
                } else {
                    console.warn('[续写] 第' + chapter.number + '章跨段去重误删过多（' + deduped.length + '/' + rawLen + ' 字），已保留原始输出');
                }
                // 开场守卫：空章节（insertPos===0）严格拦套路开场；
                // 后续轮次只拦「与其它章节开场几乎一样」的句子，避免误删「第二天」这类正常转场
                const openingGuard = this.stripFormulaicOpening(
                    cleaned, this.collectChapterOpenings(this.findWorkById(job.workId)), insertPos !== 0);
                if (openingGuard && openingGuard !== cleaned) {
                    console.log('[续写] 第' + chapter.number + '章已跳过套路化开场');
                    cleaned = openingGuard;
                }
                cleaned = this.applyTypoFixes(cleaned).text;
                cleaned = this.trimIncompleteTail(cleaned);
                if (totalBefore + cleaned.length > MAX_CHARS) {
                    cleaned = this.limitTextLength(cleaned, MAX_CHARS - totalBefore);
                }
                if (cleaned !== roundText) {
                    job.content = job.content.slice(0, insertPos) + cleaned;
                    this.paintJobContent(job);
                }
                job.content = trimTailStr(job.content);
                // 进度一律按实际增量统计：写进去又被清掉时不能虚增字数
                written = Math.max(0, job.content.length - insertPos);
                total = totalBefore + written;
                job.added = Math.max(0, job.content.length - job.baseLen);
                this.persistJobContent(job);
                this.renderJobsBar();

                if (written < 10) {
                    // 本轮没写进有效内容：连续两轮就停，避免「写入→清空」无限空转
                    if (++job.stallRounds >= 2) { job.stopReason = 'stalled'; break; }
                } else {
                    job.stallRounds = 0;
                }
                // 达到 3000 字下限就停，避免像以前一样一路写到 4500 字以上
                if (total >= MAX_CHARS) { job.stopReason = 'max'; break; }
                if (total >= MIN_CHARS) { job.stopReason = 'min'; break; }
                // 让出一帧：保证界面实时刷新、「停止」按钮随时可点
                await new Promise((r) => setTimeout(r, 150));
            }
        } catch (err) {
            failed = err;
        } finally {
            const aborted = signal.aborted || !job.running;
            job.running = false;
            // 中断时可能还有未触发的 flush 定时器：先清掉、把残余片段刷进正文，
            // 否则它会在保存之后才追加，导致编辑器比已保存内容多一截
            if (job._flushTimer) { clearTimeout(job._flushTimer); job._flushTimer = null; }
            try { if (typeof job._flushPending === 'function') job._flushPending(); } catch (e) { /* 忽略 */ }
            job._flushPending = null;
            try { this.persistJobContent(job); } catch (e) { /* 忽略 */ }
            this.continueJobs.delete(job.chapterId);
            if (this.currentChapter && this.currentChapter.id === job.chapterId) {
                this.paintJobContent(job);
                this.setSaveStatus('saved', '✓ 已保存 ' + this.nowTime());
            }
            this.refreshTaskUI();
            const wrote = job.added || 0;
            const errMsg = failed ? String(failed.message || failed) : '';
            if (aborted || /已停止|abort/i.test(errMsg)) {
                this.showNotification(label + '：已停止续写' + (wrote ? '，共写入 ' + wrote + ' 字' : ''), 'info');
            } else if (failed) {
                this.showNotification(label + '：续写中断：' + errMsg + (wrote ? '，已保留 ' + wrote + ' 字' : ''), wrote ? 'warning' : 'error');
            } else if (job.stopReason === 'dup') {
                this.showNotification(label + '：检测到模型在原地重复，已自动停止（新增 ' + wrote + ' 字）；可换更大模型或精简上下文后重试', 'warning');
            } else if (job.stopReason === 'stalled') {
                this.showNotification(label + '：连续两轮没有写进新内容，已自动停止避免空转（新增 ' + wrote + ' 字）', 'warning');
            } else if (job.rounds >= MAX_ROUNDS) {
                this.showNotification(label + '：已续写 ' + job.rounds + ' 段（' + wrote + ' 字），达到单次上限；再点一次可继续', 'info');
            } else if (job.stopReason === 'min' || job.stopReason === 'max') {
                this.showNotification(label + '：续写完成，共新增 ' + wrote + ' 字（要求 3000~4500 字）', 'success');
            } else if (wrote > 0 && wrote < MIN_CHARS) {
                this.showNotification(label + '：本次只写了 ' + wrote + ' 字，低于 3000 字；可再点一次补足', 'warning');
            } else if (wrote > 0) {
                this.showNotification(label + '：续写完成，共新增 ' + wrote + ' 字（' + job.rounds + ' 段）', 'success');
            }
        }
    }


    /* ============ 润色全章（按章节独立的后台任务） ============ */

    /** 润色弹窗用到的 DOM */
    polishEls() {
        return {
            modal: document.getElementById('polishModal'),
            report: document.getElementById('polishReport'),
            preview: document.getElementById('polishPreview'),
            content: document.getElementById('polishResultContent'),
            count: document.getElementById('polishCount'),
            runBtn: document.getElementById('polishRunBtn'),
            stopBtn: document.getElementById('polishStopBtn'),
            applyBtn: document.getElementById('polishApplyBtn'),
            undoBtn: document.getElementById('polishUndoBtn')
        };
    }

    /** 弹窗当前展示的任务：优先当前章节的任务，其次是上次查看过的任务 */
    getPolishView() {
        const job = this.currentChapter ? this.polishJobs.get(this.currentChapter.id) : null;
        if (job) return job;
        if (this.polishView && (!this.currentChapter || this.polishView.chapterId === this.currentChapter.id)) {
            return this.polishView;
        }
        return {
            status: 'idle', result: '', streamText: '', reportText: '',
            chapterId: null, progress: { index: 0, total: 0 }
        };
    }

    /** 按任务状态刷新弹窗：running / done（待应用）/ applied / error / stopped / idle */
    syncPolishUI() {
        const ui = this.polishEls();
        const st = this.getPolishView();
        if (ui.report) {
            ui.report.textContent = st.reportText || (st.status === 'idle'
                ? '尚未开始检查。本章可直接点「✨ 开始检查并润色」，或回章节列表点 🪄 在后台运行。'
                : '');
        }
        if (ui.preview) {
            const show = st.status === 'running' || st.status === 'done' || st.status === 'applied' ||
                (st.status === 'error' && st.streamText);
            ui.preview.style.display = (st.result || st.streamText) ? 'block' : (show ? 'block' : 'none');
        }
        if (ui.content && (st.streamText || st.result)) {
            ui.content.textContent = st.result || st.streamText;
            ui.content.scrollTop = ui.content.scrollHeight;
        }
        if (ui.count) ui.count.textContent = (st.result || st.streamText || '').length;
        if (ui.runBtn) {
            ui.runBtn.disabled = st.status === 'running';
            ui.runBtn.textContent = st.status === 'running'
                ? '后台处理中...'
                : ((st.status === 'done' || st.status === 'applied') ? '✨ 重新检查并润色' : '✨ 开始检查并润色');
            ui.runBtn.style.display = 'inline-flex';
        }
        if (ui.stopBtn) ui.stopBtn.style.display = st.status === 'running' ? 'inline-flex' : 'none';
        if (ui.applyBtn) {
            const canApply = st.status === 'done' && !!st.result;
            ui.applyBtn.style.display = canApply ? 'inline-flex' : 'none';
        }
        if (ui.undoBtn) ui.undoBtn.style.display = (this.polishBackups && this.polishBackups.length) ? 'inline-flex' : 'none';
    }

    /** 打开润色弹窗：查看当前（或指定）章节的润色进度与结果 */
    openPolishModal(chapterId) {
        if (!this.currentChapter) {
            this.showNotification('请先选择或新建一个章节', 'warning');
            return;
        }
        const id = chapterId || this.currentChapter.id;
        const job = this.polishJobs.get(id) || null;
        if (job) this.polishView = job;
        else if (this.polishView && this.polishView.chapterId !== id) this.polishView = null;
        this.syncPolishUI();
        const ui = this.polishEls();
        if (ui.modal) ui.modal.classList.add('show');
    }

    /** 点击后台任务面板里的润色项：切到该章并打开弹窗 */
    openPolishJob(chapterId) {
        const job = this.polishJobs.get(chapterId);
        if (!job) return;
        if (this.dirty && this.currentChapter) this.saveChapter(true);
        if (this.data.activeWorkId !== job.workId) {
            this.data.activeWorkId = job.workId;
            this.currentChapter = null;
            this.saveData();
            this.renderAll();
        }
        this.loadChapter(chapterId);
        this.polishView = job;
        this.syncPolishUI();
        const ui = this.polishEls();
        if (ui.modal) ui.modal.classList.add('show');
    }

    /**
     * 检查本章重复内容并删除：重复标题行、完全重复段落、高度相似段落、重复句子、没收尾的半句。
     * 只做确定性删除，不改写任何文字。
     */
    analyzeChapterRepetition(text) {
        const src = String(text || '');
        const report = { before: src.length, after: 0, removed: 0, dupHeadings: 0, dupParas: 0, nearParas: 0, dupSentences: 0, incomplete: 0 };
        if (!src.trim()) return { cleaned: '', report };

        const normP = p => p.replace(/\s+/g, '');
        const grams = (s, n = 6) => {
            const set = new Set();
            for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n));
            return set;
        };

        // 1) 标题行去重（按章号+标题归一化，可识别「第4章 xxx」与「第4章《xxx》」这类变体）
        const headingKey = line => {
            const m = String(line).match(/^\s*第([0-9一二三四五六七八九十百千]+)章\s*(.*)$/);
            if (!m) return null;
            return m[1] + '|' + m[2].replace(/[\s《》「」『』：:，。.,、]/g, '');
        };
        const lines = src.split('\n');
        const seenHeading = new Set();
        const lineKept = lines.map(line => {
            const key = headingKey(line);
            if (key === null) return line;
            if (seenHeading.has(key)) { report.dupHeadings++; return null; }
            seenHeading.add(key);
            return line;
        }).filter(l => l !== null);

        // 2) 段落去重（完全重复 + 高度相似）
        const paras = lineKept.join('\n').split(/\n\s*\n/);
        const kept = [];
        for (const raw of paras) {
            const p = raw.trim();
            if (!p) continue;
            const key = normP(p);
            const isHeading = /^\s*第[0-9一二三四五六七八九十百千]+章(?:[\s《：:]|$)/.test(p);
            if (!isHeading && key.length >= 20 && kept.some(k => normP(k) === key)) {
                report.dupParas++;
                continue;
            }
            if (!isHeading && key.length >= 30) {
                const near = kept.some(k => {
                    const other = normP(k);
                    if (other.length < 30) return false;
                    const A = grams(key), B = grams(other);
                    if (!A.size || !B.size) return false;
                    let inter = 0;
                    for (const x of A) if (B.has(x)) inter++;
                    const jac = inter / (A.size + B.size - inter);
                    return jac >= 0.72;
                });
                if (near) { report.nearParas++; continue; }
            }
            kept.push(p);
        }
        let cleaned = kept.join('\n\n');

        // 3) 句子去重：保留第一次出现的完整长句
        const seenSent = new Set();
        cleaned = cleaned.split(/(\n)/).map(seg => {
            if (seg === '\n') return seg;
            return seg.replace(/[^。！？…\n]+[。！？…]/g, s => {
                const key = s.replace(/\s+/g, '');
                if (key.length < 12) return s;
                if (seenSent.has(key)) { report.dupSentences++; return ''; }
                seenSent.add(key);
                return s;
            });
        }).join('');

        // 4) 没收尾的半句
        const before = cleaned;
        cleaned = this.trimIncompleteTail(cleaned);
        if (cleaned.length < before.trim().length) report.incomplete = 1;

        cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
        report.after = cleaned.length;
        report.removed = Math.max(0, src.trim().length - cleaned.length);
        return { cleaned, report };
    }

    /**
     * 让模型把本章核心事件拆成 N 拍，返回每拍的剧情描述。
     * 失败、行数不足或格式不认识时返回 []，调用方自动回退到无大纲模式。
     */
    async planChapterBeats(baseContext, target, segCount, settings, signal, toneLabel, toneGuide) {
        const systemPrompt = '你是小说大纲策划，只输出分节大纲，不写正文、不加任何评论。';
        const userPrompt = [
            baseContext,
            '【本章情感基调】' + (toneLabel || '温馨动人') +
                (toneGuide ? '\n' + toneGuide : ''),
            '【任务】把本章拆成 ' + segCount + ' 拍，必须严格遵循「总—分—总」三幕结构：' +
            '第 1 拍是【起·开头】——立人物、立处境、抛钩子（谁+什么处境+什么将要发生的冲突），不写日常流水；' +
            '第 ' + segCount + ' 拍是【合·结尾】——收束本章核心事件，给阶段性落点或反转钩子，为下章铺垫；' +
            '中间第 2～' + (segCount - 1) + ' 拍都是【承·剧情】——展开冲突、制造波折/反转/意外，是本章的主体。',
            '【输出格式】每拍一行，固定为：',
            '第N拍|角色(起/承/合)|场景（时间/地点）|出场人物|本拍必须发生的事件（含冲突与情绪变化）|不能出现的内容',
            '【要求】1. 严格按时间顺序，每拍必须承接上一拍的结果，不得跳拍；2. 全章合计约 ' + target + ' 字；' +
            '3. 只写大纲，不写正文段落；4. 每拍的情绪走向必须服务于上面的情感基调；5. 不得新增给定信息之外的主要设定；' +
            '6. 中间各拍（承·剧情）必须至少包含一个波折、反转或意外，不能平铺直叙地只做过渡。'
        ].filter(Boolean).join('\n\n');
        const res = await this.callAIAPI(systemPrompt, userPrompt, settings, {
            signal: signal, maxTokens: 1200, onChunk: () => {}
        });
        const beats = [];
        String(res || '').split('\n').forEach(line => {
            const t = line.trim();
            if (!t) return;
            const m = t.match(/^第?\s*(\d{1,2})\s*拍?\s*[|｜：:]/);
            if (m) {
                const idx = parseInt(m[1], 10) - 1;
                const desc = t.slice(m[0].length).trim();
                if (desc && idx >= 0 && idx < segCount) beats[idx] = desc;
                return;
            }
            const bullet = t.match(/^\d{1,2}\s*[.、)）]\s*(.+)$/);
            if (bullet) beats.push(bullet[1].trim());
        });
        const filled = beats.filter(Boolean);
        return filled.length >= Math.max(1, segCount - 1) ? filled.slice(0, segCount) : [];
    }

    /**
     * 把用户在「额外要求」里粘贴的自由文本，解析成可执行的编号硬约束。
     * 用户常把平台公告整段贴进来（含 • 项目符号、斜杠拼接），直接透传模型容易只理解个大概、
     * 漏掉关键项，且「空洞/堆砌/句式呆板」这类抽象质量模型没有客观尺度。这里按关键词归类成
     * 【结构要求 S1..】/【质量红线 Q1..】两组，逐条编号列出，模型更不易漏；未命中关键词的原句另列 O1..。
     */
    normalizeExtraRequirement(raw) {
        const t = String(raw || '').trim();
        if (!t) return '';
        const structure = [];
        const quality = [];
        const others = [];
        if (/(总分总|总[—\-－]?分[—\-－]?总|三幕|有开头|有剧情|有结尾|开头.{0,8}剧情.{0,8}结尾)/.test(t))
            structure.push('严格按「总—分—总」三幕写：开头立人物/处境/抛钩子，中段展开核心冲突与波折，结尾收束');
        if (/(烂尾|不能烂尾|不许烂尾|仓促|敷衍|草率|未收束|结局不完整|收尾不完整)/.test(t))
            structure.push('不许烂尾/仓促收尾：核心事件必须写出结果，关键剧情线必须收束或明确留钩，不得草率终止');
        if (/(冗余|空洞|注水|凑字)/.test(t))
            quality.push('禁止行文冗余/文笔空洞：每句话都要推进剧情或刻画人物，不用空泛描写凑字数');
        if (/(词藻|堆砌|句式呆板|质感)/.test(t))
            quality.push('禁止词藻堆砌/句式呆板：长短句交替，不用空泛高级形容词堆砌，不用排比对仗');
        if (/(格式混乱|片段化|碎片|跳来跳去)/.test(t))
            quality.push('禁止格式混乱/情节片段化：段落规范、情节连续推进不跳拍');
        // 逐条收集未归类的原句，避免漏掉用户特别提的其它要求
        t.split(/[\n•·、；;。]+/).map(s => s.trim())
            .filter(s => s.length >= 4)
            .forEach(p => {
                if (/^(存在|不得存在以下行为|等多个低质特征|等问题?)[,，。]?$/.test(p)) return;
                if (/(总分总|烂尾|冗余|空洞|词藻|堆砌|句式|格式|片段|质感)/.test(p)) return; // 已归类
                others.push(p);
            });
        const uniq = (a) => Array.from(new Set(a));
        const groups = [];
        if (structure.length) groups.push('【结构要求】\n' + uniq(structure).map((s, i) => '  S' + (i + 1) + '. ' + s).join('\n'));
        if (quality.length) groups.push('【质量红线】\n' + uniq(quality).map((s, i) => '  Q' + (i + 1) + '. ' + s).join('\n'));
        if (others.length) groups.push('【其它要求】\n' + uniq(others).slice(0, 8).map((s, i) => '  O' + (i + 1) + '. ' + s).join('\n'));
        return groups.join('\n');
    }

    /** 把正文按段落边界切成不超过 maxChars 的小节，长章节分段交给模型修订，避免截断或缩写 */
    splitTextForPolish(text, maxChars) {
        const src = String(text || '');
        if (src.length <= maxChars) return src.trim() ? [src.trim()] : [];
        const chars = [];
        const paras = src.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
        let cur = '';
        for (const p of paras) {
            if (cur && (cur.length + p.length + 2) > maxChars) {
                chars.push(cur);
                cur = p;
            } else {
                cur = cur ? cur + '\n\n' + p : p;
            }
        }
        if (cur) chars.push(cur);
        return chars.length ? chars : [src.trim()];
    }

    /* ---------- 润色任务：与 AI 续写同构，按章节独立、可并行、后台运行 ---------- */

    getMaxParallelPolish() { return 3; }

    /** 工具栏「🪄 润色全章」：当前章节在跑就停止，否则后台开始（与 AI 续写一致） */
    quickPolish() {
        if (!this.currentChapter) {
            this.showNotification('请先选择或新建一个章节', 'warning');
            return;
        }
        this.togglePolishJob(this.currentChapter.id);
    }

    /** 为某一章启动 / 停止润色（章节列表里的 🪄 / ⏹ 按钮走这里） */
    togglePolishJob(chapterId) {
        const job = this.polishJobs.get(chapterId);
        if (job && job.running) { this.stopPolishJob(chapterId); return; }
        this.startPolishJob(chapterId);
    }

    startPolishJob(chapterId) {
        const chapter = this.findChapterById(chapterId);
        if (!chapter) { this.showNotification('未找到该章节', 'error'); return; }
        const exist = this.polishJobs.get(chapterId);
        if (exist && exist.running) {
            this.showNotification('第 ' + chapter.number + ' 章正在后台润色中，可点「⏹」停止，或点侧栏任务项查看进度', 'info');
            return;
        }
        const runningCount = Array.from(this.polishJobs.values()).filter(j => j.running).length;
        if (runningCount >= this.getMaxParallelPolish()) {
            this.showNotification('同时最多 ' + this.getMaxParallelPolish() + ' 章并行润色，请先停止一个任务', 'warning');
            return;
        }
        // 同一章不能同时续写和润色：两者都会改写正文，启动润色前先停掉该章的续写
        const cjob = this.continueJobs.get(chapterId);
        if (cjob && cjob.running) {
            cjob.running = false;
            try { cjob.abort.abort(); } catch (e) { /* 忽略 */ }
            this.continueJobs.delete(chapterId);
            this.showNotification('已先停止第 ' + chapter.number + ' 章的 AI 续写（润色与续写不能同时改同一章）', 'info');
        }
        // 同一章正在后台生成整章时也先停掉：两者都会改写整章正文
        const fjob = this.fullChapterJobs.get(chapterId);
        if (fjob && fjob.running) {
            fjob.running = false;
            try { fjob.abort.abort(); } catch (e) { /* 忽略 */ }
            this.fullChapterJobs.delete(chapterId);
            this.showNotification('已先停止第 ' + chapter.number + ' 章的整章生成（不能同时改写同一章）', 'info');
        }
        // 正文来源：当前打开的章节用编辑器里未保存的最新内容
        let base = chapter.content || '';
        if (this.currentChapter && this.currentChapter.id === chapterId) {
            const ta = document.getElementById('chapterContent');
            if (ta && typeof ta.value === 'string') base = ta.value;
        }
        if (!base.trim()) {
            this.showNotification('第 ' + chapter.number + ' 章还没有正文，无法润色', 'warning');
            return;
        }

        const job = {
            chapterId: chapterId,
            workId: this.work.id,
            chapterNumber: chapter.number,
            chapterTitle: chapter.title,
            chapterLabel: '第' + chapter.number + '章《' + (chapter.title || '') + '》',
            abort: new AbortController(),
            running: true,
            status: 'running',
            baseContent: base,
            cleaned: '',
            streamText: '',
            result: '',
            reportText: '正在检查本章重复内容，随后分段交给模型修订（可关闭窗口，任务在后台继续）。',
            progress: { index: 0, total: 0 },
            startedAt: Date.now()
        };
        this.polishJobs.set(chapterId, job);
        this.polishView = job;
        this.refreshTaskUI();
        this.showNotification('已开始后台润色「' + job.chapterLabel + '」，可与其它章节同时进行', 'info');
        this.runPolishJob(job).catch(err => {
            job.running = false;
            job.status = 'error';
            job.reportText = (job.reportText || '') + ' 润色异常：' + ((err && err.message) || err);
            this.polishLog('polish-uncaught', {
                chapter: job.chapterLabel,
                message: String((err && err.message) || err),
                stack: String((err && err.stack) || '').slice(0, 1200)
            });
            // 保留失败记录，方便在面板里看原因后用「×」手动关闭
            this.refreshTaskUI();
        });
    }

    /** 手动停止某一章的润色（其他章节的任务不受影响） */
    stopPolishJob(chapterId) {
        const job = this.polishJobs.get(chapterId);
        if (!job) return;
        job.running = false;
        if (job.status === 'running') job.status = 'stopped';
        job.reportText = (job.reportText || '') + ' 已被手动停止。';
        try { job.abort.abort(); } catch (e) { /* 忽略 */ }
        this.showNotification('正在停止第 ' + (job.chapterNumber || '?') + ' 章的润色...', 'info');
        this.syncPolishUI();
        this.refreshTaskUI();
    }

    /** 关闭一条已结束的润色记录（失败/已停止/已应用） */
    dismissPolishJob(chapterId) {
        const job = this.polishJobs.get(chapterId);
        if (!job || job.running) return;
        this.polishJobs.delete(chapterId);
        if (this.polishView === job) this.polishView = null;
        this.refreshTaskUI();
    }

    /** 弹窗里的「⏹ 停止」 */
    stopPolishChapter() {
        if (!this.currentChapter) return;
        this.stopPolishJob(this.currentChapter.id);
    }

    /** 弹窗里的「✨ 开始检查并润色」 */
    runPolishChapter() {
        if (!this.currentChapter) {
            this.showNotification('请先选择或新建一个章节', 'warning');
            return;
        }
        const job = this.polishJobs.get(this.currentChapter.id);
        if (job && job.running) {
            this.showNotification('本章正在后台润色中（关闭弹窗不会中断），可点「⏹ 停止」结束', 'info');
            return;
        }
        this.startPolishJob(this.currentChapter.id);
        this.syncPolishUI();
    }

    /**
     * 润色主流程：先做确定性去重，再分段让模型只做修订。
     * 全程只操作 job 里的数据，不依赖弹窗，也不占用编辑器；完成后自动替换正文（可撤销）。
     */
    async runPolishJob(job) {
        const chapter = this.findJobChapter(job);
        if (!chapter) { this.polishJobs.delete(job.chapterId); this.refreshTaskUI(); return; }
        const label = job.chapterLabel || ('第' + job.chapterNumber + '章');
        const signal = job.abort.signal;

        // 第一步：确定性删除重复内容
        const { cleaned, report } = this.analyzeChapterRepetition(job.baseContent);
        job.report = report;
        // 注意：这里是 let。后面「开篇站位」「签约自检」都会往里追加内容，
        // 若写成 const 会在润色任务刚启动时就抛 Assignment to constant variable，
        // 表现为「点了润色、后台任务里没有任何进度」。
        let reportText = report.removed > 0
            ? '已删除重复内容 ' + report.removed + ' 字：重复标题 ' + report.dupHeadings +
              ' 处、重复段落 ' + report.dupParas + ' 处、高度相似段落 ' + report.nearParas +
              ' 处、重复句子 ' + report.dupSentences + ' 处' +
              (report.incomplete ? '，并去掉没收尾的半句' : '') +
              '。本章原 ' + report.before + ' 字 → 清理后 ' + report.after + ' 字。'
            : '未发现重复内容（原 ' + report.before + ' 字）。';
        job.cleaned = cleaned;
        if (!cleaned.trim()) {
            job.status = 'error';
            job.reportText = reportText + ' 没有可润色的正文。';
            job.running = false;
            this.polishJobs.delete(job.chapterId);
            this.showNotification(label + '：没有可润色的正文', 'warning');
            this.syncPolishUI();
            this.refreshTaskUI();
            return;
        }

        // 第二步：模型在清理后的原文上做通顺度修订（长章节分段，避免截断/缩写）
        // 先做确定性「开篇站位」：软开场（时间天气/环境传说铺垫）是签约硬伤，按删字成本最低的方式处理掉。
        // 注意：cleaned 和 reportText 都是上一步解构/声明出来的常量，这里必须用新变量名，
        // 否则会在润色任务刚启动时就抛 Assignment to constant variable，
        // 表现为「点了润色、后台任务里看不到任何进度」。
        const headFixed = this.upgradeOpeningForSigning(cleaned).replace(/\n{3,}/g, '\n\n').trim();
        const headCut = cleaned.length - headFixed.length;
        const bodyForModel = headFixed || cleaned;
        if (headCut > 0) {
            reportText += ' 开篇站位：删掉软开场 ' + headCut + ' 字（编辑 300 字内看不到冲突/悬念就会拒稿）。';
        }
        const chunks = this.splitTextForPolish(bodyForModel, 2600);
        job.progress = { index: 0, total: chunks.length };
        job.reportText = reportText + ' 正在按 ' + chunks.length + ' 段逐步修订（可关窗，后台继续）。';
        this.syncPolishUI();
        this.renderJobsBar();

        try {
            const settings = this.getLiveAISettings();
            const context = this.buildContextMemory();
            const systemPrompt =
                '你是资深小说责任编辑，只做「顺手改顺」、不做「创作」。把这一段改成更自然、更像真人写的通俗白话：口语化、好懂、流畅，' +
                '去掉生硬的书面腔和明显的 AI 痕迹。直接输出修订后的正文，不要任何解释、评论、前后缀、代码块或标题。';
            const done = [];
            let noResultChunks = 0;   // 完全没有拿到输出的段数（用于区分「全失败」与「部分保留原文」）
            let firstChunkErr = '';   // 第一个底层错误（401/429/内容过滤等），用于给出可执行的失败原因
            for (let i = 0; i < chunks.length; i++) {
                if (signal.aborted) throw new Error('生成已停止');
                job.progress = { index: i + 1, total: chunks.length };
                job.reportText = reportText + ' 正在修订第 ' + (i + 1) + '/' + chunks.length + ' 段（后台运行中）。';
                this.syncPolishUI();
                this.renderJobsBar();
                const userPrompt = [
                    context ? '【作品设定】\n' + context : '',
                    '【本节正文（第 ' + (i + 1) + '/' + chunks.length + ' 节，共 ' + chunks[i].length + ' 字，请在此基础之上修订）】\n' + chunks[i],
                    // 全章统计出的高频套话：修订时优先把它们换成具体动作/细节
                    this.buildBannedPhraseNotice(cleaned),
                    '【修订原则（必须严格遵守）】',
                    '1. 保持情节、场景、对话、人物、设定、时间线不变，只改「说法」，不编新内容。',
                    '2. 口语化、通俗易懂：把书面腔、绕弯的长句改成自然、好懂、像人说话/叙事的短句；该用口语词就用口语词（如「于是」可改「就」、「抵达」可改「到了」），但别用方言、网络梗或粗话。',
                    '3. 去掉 AI 味：不要硬凑比喻（如「就像…」「仿佛…」「宛若…」）、不要堆砌空泛修饰（「微微一笑」「轻声」「目光」「不禁」「似乎」），不要排比对仗，不要结尾强行升华感慨；标点正常，不要滥用破折号、省略号。注意：要删的是「空泛的情绪标签」，不是人物内心本身——人物具体的念头、顾虑、身体反应要留下并改顺畅',
                    '4. 格式朴素：只用正常的段落和中文全角标点，禁止 emoji、markdown、加粗、小标题、序号、代码块；不要冒出英文。',
                    '5. 不新增内容：不加新场景、新角色、新对话、新情节，也不要把短句刻意扩写成大段。',
                    '6. 保护要点，但允许删「没用的字」：情节、关键对话、以及刻画人物的句子（具体的念头、顾虑、性格细节、习惯动作、身体反应）一律保留，只改写法；' +
                    '但下面这些「没有信息量」的内容要删掉或大幅压缩——空泛的环境描写、设定说明与传说铺垫、套话复读的句子、旁白式解说句（「她知道」「这说明」）、标签式人设句（「表面开朗实则敏感」）、' +
                    '问答里既没有信息也没有冲突的回合。允许在同一拍内调整句子顺序，把最有张力的那几句提前',
                    '7. 修正硬伤：前后矛盾（身份/性别/关系/时间/地点）、过渡不顺、指代不清、套话堆砌、错别字与病句、没收尾的半句。特别注意：同一角色不能既「随队同行/已离开某地」、又去敲该地的门或初次见到某人（角色自己遇到自己是硬伤，必须统一为已在该队伍/已认识）。',
                    '8. 依据【硬设定】与【角色档案】修正前后矛盾（性别/身份/关系/称谓/时间顺序等）。',
                    '9. 只改这一节，不续写、不重复前后文；删除无效引号（空引号对、独占一行的残引号、章末未闭合的孤立引号）。',
                    '10. 输出字数与本段基本一致（不低于 85%、不高于 130%），宁可不改也不要压缩。',
                    '11. 套话限额：同一种修辞、同一个动作词（如「微微一笑」「轻声」「目光」「一丝」）在本段最多出现 1 次；' +
                    '本章前文已经用过的表达也不要再用。找不到合适的表达，就换一个完全不同的具体动作，不要退回套话。',
                    '12. 开篇必须重新站位：如果是本章第一段，前 300 字内必须出现冲突、悬念、反常或抉择；' +
                    '原文若是「清晨的阳光…」这类时间+天气起笔，或一大段环境/传说铺垫，先把它删掉或压到一句以内，' +
                    '让本章直接从正在发生的、有张力的事开始。',
                    '13. 本章若是最后一章或本段是结尾，结尾要卡在钩子上（反转、新信息、两难、没说出口的话），不许用感慨句收尾；' +
                    '禁止旁白式下结论（「她知道」「他明白」「这说明」「谁都看得出来」）。',
                    '14. 严禁乒乓式对话（AI 生成最明显的指纹，编辑会直接拒）：如果本节出现两人一问一答、逐句对答又互相确认的来回' +
                    '（连续多段都是「"……"XX问。」接「"……"XX说。」、几乎没有叙述），必须拆开——在问答之间插入动作、神态、环境或心理描写，' +
                    '或把几轮问答合并成一段带叙述的对话；禁止连续 3 段以上只有引号加说话人。读者一眼就能认出这种写法。',
                    '15. 删掉全知叙述者剧透与旁白总结句：如「她不知道的是……」「殊不知」「XX之谜解开了」「他的故事还没完」这类句子一律删掉；' +
                    '秘密要让角色自己当场发现，不能由叙述者提前剧透，也不能在结尾用旁白收束。',
                    '16. 修逻辑矛盾：已经当着相关角色面被披露的事实（身份、秘密、亮出来的钱），后面不能再写「无人知晓/重新隐瞒/大家以为他身无分文」；' +
                    '前面全员已知的事，后面角色不能再去编与之矛盾的谎。已发生并被看见的事不许被撤回或假装没发生。',
                    '17. 修设定自相矛盾：明确给出的规则（一周查几次、月租多少、几个人合租）在正文里要前后一致，不能自打脸。',
                    '18. 删掉重复桥段：同一类冲突场景（床底藏物被翻出、身份当众揭穿、前任送花被赶走、假扮情侣被拆穿）本章只许完整发生一次，' +
                    '后面只能换推进、不能再换个说法重演一遍；凭空冒出的孤立对话断片（无对象、无上下文的引号）也要补上承接或直接删掉。',
                    '19. 换掉反复出现的「动作/镜头」套路：同一章里不要老用「手指在XX上飞舞/快速敲击」「义体/轮椅嗡鸣」「眼中闪烁红光」「动作不像人类更像机器」「没时间了」这类同一组写法；' +
                    '同一个具体动作写完一次就换不同的细节，必要时宁可删掉重复描写，也不要用同义改头换面再重复。',
                    '20. 维持「总—分—总」三幕结构：本章第一段是「起·开头」（立人物/处境/钩子），中间各段是「承·剧情」（展开冲突与波折），最后一段是「合·结尾」（收束+钩子）。' +
                    '修订时只改说法——不得把开篇的钩子写平、不得把中间的冲突写没、不得把结尾的收束改成中途断在动作上。',
                    '21. 杜绝平台重点治理的低质问题：① 行文冗余/文笔空洞——删掉无信息量的环境铺垫、心理独白、设定说明，每句都推进剧情或刻画人物；② 词藻堆砌/句式呆板——长短句交替，删掉空泛高级形容词（深邃/神秘/阴沉/巨大/精致）堆砌，不用排比对仗；③ 仓促收尾/关键剧情未收束——若本段是结尾，必须让核心事件有结果、关键线收束或明确留钩，不得敷衍草率终止。',
                    '【本节正文】'
                ].filter(Boolean).join('\n\n');
                // 单段「自适应 token + 重试 + 兜底原文」：中文约 1 字≈1 token，
                // 固定 4000 会把 2600 字的段落截断；任一段被截断，合并后总字数就会跌破 85%，
                // 触发「字数护栏」把整章判失败——这是「没断网却润色失败」最常见的原因。
                // 所以：按段长给足预算；输出偏短/为空/请求报错就重试一次（再加大预算）；
                // 两次都不行就保留这段原文，绝不让一段拖垮整章。
                const originalChunk = chunks[i];
                // 上限收敛到 8000：2600 汉字的输出约 2600~3500 token，8000 足够；
                // 再高（如 16000/20000）有些免费模型会直接以「max_tokens 过大」返回 400。
                const baseTok = Math.min(8000, Math.max(3500, Math.ceil(originalChunk.length * 1.6)));
                let segRaw = '';
                let lastErr = null;
                for (let attempt = 0; attempt < 2; attempt++) {
                    if (signal && signal.aborted) throw new Error('生成已停止');
                    const maxTok = Math.min(8000, attempt === 0 ? baseTok : baseTok + 2000);
                    try {
                        const part = await this.callAIAPI(systemPrompt, userPrompt, settings, {
                            signal: signal,
                            genType: i === 0 ? 'chapter' : 'sub',
                            maxTokens: maxTok,
                            onChunk: (delta, full) => {
                                // 弹窗只是隐藏、元素仍在 DOM 中；同时写进状态，重开弹窗即可看到进度
                                job.streamText = done.join('\n\n') + (done.length ? '\n\n' : '') + full;
                                this.syncPolishUI();
                            }
                        });
                        const r = this.stripChapterHeadings(String(part || '').trim());
                        // 达标区间 = 原段 85%~130%（与修订规则第 10 条一致）：区间内才采用
                        if (r && r.length >= originalChunk.length * 0.85 && r.length <= originalChunk.length * 1.3) { segRaw = r; break; }
                        // 偏短或空：记一笔，第二次加大预算重试
                        if (r) segRaw = r;
                        if (attempt === 0) {
                            job.reportText = reportText + ' 第 ' + (i + 1) + ' 段输出偏短（' +
                                (r ? r.length : 0) + ' / ' + originalChunk.length + ' 字），已加大 token 预算重试…';
                            this.syncPolishUI();
                        }
                    } catch (e) {
                        if (signal && signal.aborted) throw new Error('生成已停止');
                        if (e && e.name === 'AbortError') throw new Error('生成已停止');
                        lastErr = e;
                        if (!firstChunkErr) firstChunkErr = String((e && e.message) || e);
                        this.polishLog('chunk-error', {
                            chapter: label, index: i + 1, attempt: attempt + 1,
                            maxTokens: maxTok, message: String((e && e.message) || e)
                        });
                        if (attempt === 0) {
                            job.reportText = reportText + ' 第 ' + (i + 1) + ' 段请求失败（' +
                                ((e && e.message) || e) + '），重试一次…';
                            this.syncPolishUI();
                        }
                    }
                }
                // 两次都没拿到可用结果（空、或明显偏短）：保留这段原文，
                // 保证整章仍能完成（只是这段没被润色），也不让个别段拖累整章字数护栏。
                if (!segRaw || segRaw.length < originalChunk.length * 0.85 || segRaw.length > originalChunk.length * 1.3) {
                    if (!segRaw) noResultChunks++;
                    segRaw = originalChunk;
                    job.reportText = reportText + ' 第 ' + (i + 1) + ' 段两轮未达标，已保留原文未改动（其余段照常润色）。';
                    this.syncPolishUI();
                }
                // 改完一段就地校对：模型是按句换词改写的，改写过程中自己就会写错字
                // （真实案例：润色后仍有「鹿物吧」这种错字）。等全文合并再校已经太晚，
                // 而且只校一次的话长章后半段根本校不到。
                const segFixed = segRaw ? (await this.polishTypos(segRaw, '第 ' + (i + 1) + ' 段修订')).text : '';
                done.push(segFixed);
            }
            // 一段都没拿到输出：多半不是网络，而是密钥/额度/模型名/上下文超长这类硬错。
            // 明确报出来，别伪装成「润色完成」。
            if (chunks.length && noResultChunks >= chunks.length) {
                throw new Error('全部 ' + chunks.length + ' 段都没能修订成功' +
                    (firstChunkErr ? '（底层错误：' + firstChunkErr + '）' : '') +
                    '。常见原因：密钥无效/额度用尽/触发限流/模型名错误/上下文超长。请到「设置」检查接口与模型后重试。');
            }
            const merged = this.stripChapterHeadings(done.join('\n\n'));
            // 每段都已校完，这里只做本地确定性修正（错别字表 + 引号/省略号/结尾去重），不再重复请求模型
            const typoFixed = this.applyTypoFixes(merged);
            const result = this.stripBrokenChars(this.trimIncompleteTail(typoFixed.text));
            if (!result) throw new Error('模型没有返回修订结果');
            // 字数护栏：模型截断或擅自压缩/扩写时直接拒绝替换，避免正文被改短
            const base = cleaned.length;
            const ratio = result.length / base;
            if (ratio < 0.85 || ratio > 1.3) {
                job.status = 'error';
                job.result = '';
                job.reportText += ' 修订结果 ' + result.length + ' 字，与清理后正文 ' + base +
                    ' 字相差 ' + Math.round(Math.abs(1 - ratio) * 100) + '%（模型被截断或擅自压缩/扩写），已取消替换，请重试或换模型。';
                this.showNotification(label + '：润色结果字数异常（' + result.length + ' / ' + base + ' 字），已取消替换', 'error');
                return;
            }
            job.result = result;
            job.streamText = result;
            job.status = 'done';
            job.reportText += ' 修订完成：清理后 ' + base + ' 字 → 修订后 ' + result.length + ' 字。';
            // 第三步：定向修补。按签约自检未过的项逐项修，最多 3 轮，直到硬伤清零。
            // 润色可以多花时间——宁可慢，也不要把带硬伤的稿子交上去。
            // 质量优先：修补阶段即使报错，也保留已经修订好的正文，不让整章判失败。
            let repaired = result;
            try {
                repaired = await this.repairSigningDefects(result, job, signal);
            } catch (repairErr) {
                if (signal.aborted) throw repairErr;
                job.reportText += ' 定向修补出错（' + ((repairErr && repairErr.message) || repairErr) +
                    '），已保留修订稿、跳过修补。';
                this.polishLog('repair-error', { chapter: label, message: String((repairErr && repairErr.message) || repairErr) });
                repaired = result;
            }
            if (repaired && repaired.trim() && repaired !== result) {
                const drift = Math.abs(repaired.length - base) / base;
                if (drift <= 0.3) {
                    job.result = repaired;
                    job.streamText = repaired;
                    job.reportText += ' 定向修补后 ' + repaired.length + ' 字。';
                } else {
                    job.reportText += ' 定向修补偏差 ' + Math.round(drift * 100) +
                        '% 过大，已保留修补前版本，请重试。';
                }
            }
            // 修订完立刻按签约标准自检，把结果写进报告：不达标就告诉用户还剩什么
            // 注意：这里必须自检「最终要写进去的版本」（修补后的），否则报告会和实际内容不一致
            try {
                job.audit = this.auditTextForSigning(job.result || result) || [];
            } catch (auditErr) {
                job.audit = [];
                this.polishLog('audit-error', { chapter: label, message: String((auditErr && auditErr.message) || auditErr) });
            }
            const auditBad = job.audit.filter(i => !i.ok && i.level === 'block');
            const auditWarn = job.audit.filter(i => !i.ok && i.level !== 'block');
            if (auditBad.length) {
                job.reportText += ' 签约自检还有 ' + auditBad.length + ' 项硬伤：' +
                    auditBad.map(i => i.name).join('、') + '（建议再润一次或针对性改）。';
                this.showNotification(label + '：已修订，但仍有 ' + auditBad.length +
                    ' 项签约硬伤（' + auditBad.map(i => i.name).join('、') + '），可点「🧾 签约自检」看明细', 'warning');
            } else if (auditWarn.length) {
                job.reportText += ' 签约硬伤已清零，还有 ' + auditWarn.length + ' 项可优化：' +
                    auditWarn.map(i => i.name).join('、') + '。';
                this.showNotification(label + '：修订完成，签约硬伤已清零 ✅', 'success');
            } else {
                job.reportText += ' 签约自检 8 项全部通过 ✅';
                this.showNotification(label + '：修订完成，签约标准 8 项全部通过 ✅', 'success');
            }
            this.warnIfClichéHeavy(job.result || result, '润色结果');
            this.syncPolishUI();
            // 后台自动替换正文（正文在润色期间被改动过则转为「待应用」，不覆盖用户改动）
            this.applyPolishResultToChapter(job, false);
        } catch (error) {
            const msg = (error && error.message) || String(error || '未知错误');
            const stopped = signal.aborted || msg.indexOf('已停止') >= 0;
            job.status = stopped ? 'stopped' : 'error';
            job.reportText = (job.reportText || '') + (stopped ? ' 已被手动停止。' : ' 修订失败：' + msg);
            // 失败原因写进本地日志（~/.zhimo-novel/polish.log），便于定位是密钥/额度/模型/截断还是别的
            this.polishLog('polish-failed', {
                chapter: label,
                message: msg,
                stack: String((error && error.stack) || '').slice(0, 1200),
                lastReport: job.reportText
            });
            this.showNotification(label + (stopped ? '：已停止润色' : '：润色失败 ' + msg), stopped ? 'info' : 'error');
        } finally {
            job.running = false;
            // 已替换 / 已停止的退出任务表；待应用与失败的留在面板里，供手动应用或查看原因
            if (job.status === 'applied' || job.status === 'stopped') this.polishJobs.delete(job.chapterId);
            this.polishView = job;
            this.syncPolishUI();
            this.refreshTaskUI();
        }
    }

    /**
     * 把润色诊断信息写到本地日志（~/.zhimo-novel/polish.log）。
     * 通过本机服务端追加，便于排查「没断网却失败」到底卡在密钥/额度/模型/截断哪一步。
     * 任何情况都不阻塞、不抛错。
     */
    polishLog(tag, detail) {
        try {
            const raw = window.__STORE_API || '/api/data';
            let u;
            try { u = new URL(raw, location.href); } catch (e) { u = new URL('/api/log', location.href); }
            u.pathname = '/api/log';
            u.search = '';
            fetch(u.toString(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({ tag: tag, at: new Date().toISOString() }, detail || {}))
            }).catch(() => {});
        } catch (e) { /* 忽略日志失败，绝不能影响润色主流程 */ }
    }

    /**
     * 套话复用提示：本轮又出现“前文已用过 ≥2 次”的固定搭配时，明确指出是哪几个、各几次。
     * 每个短语只提示一次，避免刷屏。
     */
    warnStockPhrases(roundText, chapterText) {
        const round = String(roundText || '');
        if (!round.trim()) return;
        const hits = [];
        this.getStockPhrases().forEach(p => {
            const inRound = round.split(p).length - 1;
            if (inRound < 1) return;
            const inChapter = String(chapterText || '').split(p).length - 1;
            if (inChapter >= 2) hits.push(p + '（前文 ' + inChapter + ' 次，本轮又 ' + inRound + ' 次）');
        });
        if (!hits.length) return;
        if (!this._stockWarned) this._stockWarned = {};
        const fresh = hits.filter(h => {
            const key = h.split('（')[0];
            if (this._stockWarned[key]) return false;
            this._stockWarned[key] = true;
            return true;
        });
        if (fresh.length && typeof this.showNotification === 'function') {
            this.showNotification('本轮又出现已反复使用的表达：' + fresh.join('、') +
                '。已要求模型停用这些词；要统一清掉可点「🪄 润色全章」', 'warning');
        }
    }

    /** 套话超量时给用户明确提示，便于点「润色全章」统一处理 */
    warnIfClichéHeavy(text, label) {
        const over = this.countClicheOveruse(text, 2);
        if (over.length) {
            this.showNotification((label || '本次输出') + '套话偏多：' + over.join('、') + '；可点「润色全章」统一处理', 'warning');
        }
        return over.length;
    }

    /**
     * 把润色结果写回该章正文。
     * manual=false（后台自动）：正文在润色期间被改动过 → 不覆盖，转为「待应用」等用户确认。
     * manual=true（弹窗按钮）：以用户确认为准，直接替换。
     */
    applyPolishResultToChapter(job, manual) {
        const chapter = this.findJobChapter(job);
        if (!chapter || !job.result) return false;
        const cjob = this.continueJobs.get(job.chapterId);
        if (cjob && cjob.running) {
            job.reportText = (job.reportText || '') + ' 该章正在 AI 续写，已推迟替换。';
            if (manual) this.showNotification('该章正在 AI 续写，请先停止续写再替换润色结果', 'warning');
            return false;
        }
        const cur = chapter.content || '';
        if (!manual && cur !== job.baseContent) {
            job.status = 'done';
            job.pendingApply = true;
            job.reportText = (job.reportText || '') + ' 正文在润色期间发生了变化，已保留结果，请确认后手动应用。';
            this.syncPolishUI();
            this.showNotification((job.chapterLabel || '本章') + '：润色完成，但正文已变化，结果待确认（点侧栏任务项可应用）', 'warning');
            return false;
        }
        // 替换前备份原正文，误操作后可「↩️ 撤销替换」找回
        this.polishBackups.unshift({
            chapterId: chapter.id,
            chapterLabel: job.chapterLabel || ('第' + job.chapterNumber + '章'),
            content: cur,
            at: Date.now()
        });
        if (this.polishBackups.length > 20) this.polishBackups.length = 20;
        this.data.polishBackups = this.polishBackups;

        chapter.content = job.result;
        chapter.updatedAt = Date.now();
        // 润色已替换正文：把「待润色」标记清掉（polishedAt 与 updatedAt 同步，后续改动会再次触发标记）
        chapter.polishedAt = chapter.updatedAt;
        job.applied = true;
        job.status = 'applied';
        job.reportText = (job.reportText || '') + ' 已替换本章正文（误操作可点「↩️ 撤销替换」）。';
        this.saveData();
        if (this.currentChapter && this.currentChapter.id === chapter.id) {
            const ta = document.getElementById('chapterContent');
            if (ta) ta.value = job.result;
            this.updateEditorWordCount();
            this.dirty = false;
            this.setSaveStatus('saved', '✓ 已保存 ' + this.nowTime() + '（已润色）');
        }
        this.renderChapterList();
        this.syncPolishUI();
        this.showNotification((job.chapterLabel || '本章') + '：润色完成并已替换正文（' +
            (job.cleaned ? job.cleaned.length : cur.length) + ' → ' + job.result.length + ' 字，可撤销）', 'success');
        return true;
    }

    /** 用修订结果替换整章正文（弹窗里的手动「应用」按钮） */
    applyPolishResult() {
        const job = this.getPolishView();
        if (!job || !job.result) {
            this.showNotification('没有可应用的润色结果', 'info');
            return;
        }
        if (!this.currentChapter || this.currentChapter.id !== job.chapterId) {
            this.showNotification('修订结果属于' + (job.chapterLabel || '其他章节') + '，请先切回该章节再替换', 'warning');
            return;
        }
        if (!this.applyPolishResultToChapter(job, true)) return;
        this.polishJobs.delete(job.chapterId);
        this.closeModal('polishModal');
        this.refreshTaskUI();
    }

    /** 撤销上一次润色替换：把最近的备份写回编辑器并保存 */
    undoPolishReplace() {
        if (!this.polishBackups.length) {
            this.showNotification('没有可撤销的润色记录', 'info');
            return;
        }
        const idx = this.currentChapter
            ? this.polishBackups.findIndex(b => b.chapterId === this.currentChapter.id)
            : -1;
        if (idx < 0) {
            this.showNotification('备份属于其他章节，请先切回该章节再撤销', 'warning');
            return;
        }
        const backup = this.polishBackups.splice(idx, 1)[0];
        this.data.polishBackups = this.polishBackups;
        this.saveData();
        const textarea = document.getElementById('chapterContent');
        if (this.currentChapter) {
            if (textarea) textarea.value = backup.content;
            this.currentChapter.content = backup.content;
            this.saveChapter();
        }
        this.updateEditorWordCount();
        this.syncPolishUI();
        this.showNotification('已撤销润色替换，恢复 ' + backup.chapterLabel + ' 原文（' + backup.content.length + ' 字）', 'success');
    }

    /** 渲染生成提示词快捷标签 */
    renderPromptChips() {
        const chips = ['加入一个反转', '强化感官描写', '放慢节奏', '加快节奏', '制造悬念', '回收伏笔', '增加对话', '收束本章'];
        const el = document.getElementById('genPromptChips');
        if (!el) return;
        el.innerHTML = chips.map(c => '<span class="prompt-chip" data-chip="' + c + '">' + c + '</span>').join('');
        el.querySelectorAll('.prompt-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const ta = document.getElementById('genPrompt');
                if (!ta) return;
                const chipText = chip.dataset.chip;
                if (chipText === '收束本章') {
                    // 收束本章：自动切到「收束本章」类型 + 追加到末尾，并提示会读取全章
                    this.setValue('genType', 'ending');
                    this.setValue('genInsertMode', 'append');
                    if (!/收束|结尾|收尾|结束本章/.test(ta.value)) {
                        const cur0 = ta.value.trim();
                        ta.value = cur0 ? cur0 + '\n收束本章' : '收束本章';
                    }
                    this.updateGenContextHint();
                    return;
                }
                const cur = ta.value.trim();
                ta.value = cur ? cur + '\n' + chipText : chipText;
                this.updateGenContextHint();
            });
        });
    }

    /** 提示本次会把多少字发给模型：续写只发尾部，收束发送全章 */
    updateGenContextHint() {
        const el = document.getElementById('genContextHint');
        if (!el) return;
        const type = document.getElementById('genType')?.value || 'continue';
        const prompt = document.getElementById('genPrompt')?.value || '';
        const ta = document.getElementById('chapterContent');
        const raw = (ta && typeof ta.value === 'string')
            ? ta.value
            : ((this.currentChapter && this.currentChapter.content) || '');
        const len = raw.trim().length;
        const constraintCount = this.parseConstraints(prompt).length;
        const countHint = constraintCount ? ' 本次将逐条执行 ' + constraintCount + ' 条约束。' : '';
        // send 必须在分支外声明：之前写在 if 里，else 分支引用会抛
        // ReferenceError，导致 generateContent 在弹出模态框前中断（场景生成点了没反应）
        const send = Math.min(len, 8000);
        if (this.isEndingRequest(type, prompt)) {
            el.textContent = '收束模式：把本章全文（' + send + ' 字）发给模型通读，再写 3000~4500 字结尾' +
                (len > 8000 ? '；超过 8000 字时保留开头与结尾' : '') + '。' + countHint;
            el.style.color = '#2563eb';
        } else if (type === 'continue') {
            el.textContent = '续写模式：把本章全部内容（' + send + ' 字）发给模型作为上下文；本次目标 3000~4500 字。' + countHint;
            el.style.color = '';
        } else {
            el.textContent = '场景模式：把本章全部内容（' + send + ' 字）发给模型作为上下文；只生成所选类型的场景片段。' + countHint;
            el.style.color = '';
        }
    }

    // ============ 整章生成 ============

    openFullChapterModal() {
        const modal = document.getElementById('fullChapterModal');
        if (!modal) return;
        const charOptions = this.work.characters.map(c =>
            '<option value="' + c.id + '">' + this.escapeHtml(c.name) + '</option>'
        ).join('');
        const fcChars = document.getElementById('fcChars');
        if (fcChars) fcChars.innerHTML = charOptions;
        const fcEvent = document.getElementById('fcEvent');
        if (fcEvent && this.currentChapter) fcEvent.value = this.currentChapter.summary || '';
        else if (fcEvent) fcEvent.value = '';
        const fcProgress = document.getElementById('fcProgress');
        const fcProgressFill = document.getElementById('fcProgressFill');
        const fcProgressText = document.getElementById('fcProgressText');
        const fcResult = document.getElementById('fcResult');
        const fcAppendBtn = document.getElementById('fcAppendBtn');
        const fcGenBtn = document.getElementById('fcGenBtn');
        if (fcResult) fcResult.style.display = 'none';
        if (fcAppendBtn) fcAppendBtn.style.display = 'none';
        // 该章已在后台生成：显示当前进度，按钮变成「停止」
        const fjob = this.currentChapter ? this.fullChapterJobs.get(this.currentChapter.id) : null;
        if (fjob && fjob.running) {
            if (fcProgress) fcProgress.style.display = 'block';
            const p = fjob.progress || {};
            if (fcProgressFill) fcProgressFill.style.width = (p.percent || 0) + '%';
            if (fcProgressText) fcProgressText.textContent = p.text || '后台生成中…';
            if (fcGenBtn) { fcGenBtn.style.display = 'inline-flex'; fcGenBtn.disabled = false; fcGenBtn.textContent = '正在后台生成（点此停止）'; }
        } else {
            if (fcProgress) { fcProgress.style.display = 'none'; if (fcProgressFill) fcProgressFill.style.width = '0%'; }
            if (fcGenBtn) { fcGenBtn.style.display = 'inline-flex'; fcGenBtn.disabled = false; fcGenBtn.textContent = '开始后台生成整章'; }
        }
        this.updateMockBadges();
        modal.classList.add('show');
    }

    /**
     * 点击「开始生成整章」：启动该章独立的后台任务并关闭弹窗。
     * 关闭弹窗不会中断生成；完成后结果自动写入本章（详见 runFullChapterJob）。
     */
    executeFullChapterGeneration() {
        if (!this.currentChapter) {
            this.showNotification('请先选择或新建一个章节', 'warning');
            return;
        }
        const chapterId = this.currentChapter.id;
        const exist = this.fullChapterJobs.get(chapterId);
        if (exist && exist.running) {
            // 已在后台生成：再点一次即停止
            this.stopFullChapterJob(chapterId);
            return;
        }
        const fcEvent = document.getElementById('fcEvent');
        const eventDesc = fcEvent ? fcEvent.value.trim() : '';
        if (!eventDesc) {
            this.showNotification('请输入本章核心事件描述', 'warning');
            return;
        }
        const fcChars = document.getElementById('fcChars');
        const selectedChars = fcChars ? Array.from(fcChars.selectedOptions).map(o => o.value) : [];
        const fcLength = document.getElementById('fcLength');
        const targetLength = parseInt(fcLength ? fcLength.value : 3000);
        const fcTone = document.getElementById('fcTone');
        const tone = fcTone ? fcTone.value : 'tense';
        const fcExtra = document.getElementById('fcExtra');
        const extraReq = fcExtra ? fcExtra.value.trim() : '';
        const fcAutoPolish = document.getElementById('fcAutoPolish');
        // 生成后是否再润色一遍：网页版有这个勾选项；App 版已把该选项去掉，默认不做自动润色
        const autoPolish = fcAutoPolish ? !!fcAutoPolish.checked : false;
        const job = this.startFullChapterJob(chapterId, {
            eventDesc: eventDesc, selectedChars: selectedChars,
            targetLength: targetLength, tone: tone, extraReq: extraReq, autoPolish: autoPolish
        });
        if (job) {
            // 关闭弹窗，生成转入后台；完成后自动写入本章
            this.closeModal('fullChapterModal');
            this.setSaveStatus('dirty', '整章后台生成中「第 ' + (this.currentChapter.number || '?') + ' 章」…');
        }
    }

    async generateFullChapter(options) {
        // 始终调用真实 AI 模型生成整章
        return this.generateFullChapterWithAI(options);
    }

    /**
     * 调用 AI 生成完整章节：按目标字数分段生成、累加到位。
     * 旧实现把 targetLength*2 直接当 maxTokens，模型输出上限（多为 8K）会被截断，
     * 于是设 8000 字只出 3000 字；现在每段单独请求，最后再做字数校验与补写。
     */
    async generateFullChapterWithAI(options) {
        const { eventDesc, selectedChars, targetLength, tone, extraReq, signal } = options;
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : function () {};
        // 后台任务：显式传入任务所属作品与章节，生成过程不再依赖「当前打开的是哪一章」
        const work = options.work || this.work;
        const chapter = options.chapter || this.currentChapter;
        const target = Math.max(500, parseInt(targetLength, 10) || 3000);
        const chars = (selectedChars || []).map(id => work.characters.find(c => c.id === id)).filter(Boolean);
        const toneNames = this.getToneNames();
        const toneLabel = toneNames[tone] || tone;
        const toneGuide = this.getToneGuide(tone);
        const memory = this.buildContextMemory(work, chapter);
        const settings = this.getLiveAISettings();
        const styleName = this.getStyleName(settings.writingStyle);

        const systemPrompt = '你是一位成熟的类型小说作者，只写小说正文，不写任何解释、标题、序号或分隔线。\n' +
            '风格要求：' + styleName + '\n' +
            '情感基调：' + toneLabel + '\n' + toneGuide + '\n' +
            '写作要求：\n' +
            '1. 口语化、通俗易懂：像真人作者写的一样自然，不端着。书面腔、翻译腔、文艺腔一律换成日常说法（「抵达」改「到了」、「于是」改「就」、「随后」改「接着」）；短句为主，该断就断，别写一长串定语从句式的句子\n' +
            '2. 严禁 AI 味：禁止硬凑比喻（「就像…」「仿佛…」「宛若…」）；禁止空泛修饰堆砌（「一丝」「微微一」「难以言喻」「氤氲」「弥漫」「氛围」）；禁止排比、对仗、四字词连用；禁止结尾升华讲道理。情绪要写成具体的，不要写成「心里涌起一种难以名状的情绪」这种空标签\n' +
            '3. 人物说话像真人：有来有回、有停顿有打断，可以答非所问、可以沉默；不要每个人都说完整流畅的长句，不要用台词解释剧情（禁止「你是说我…所以我…」这种把信息说给读者听的台词）\n' +
            '4. 严格遵守已有世界观和角色设定，不得出现矛盾；角色姓名必须与档案完全一致——写完每个人名都要回头核对：不许漏字（陈橙橙不能写成陈橙）、不许写错字（林栀不能写成林简）、也不许中途换成别的称呼\n' +
            '5. 必须写满本节指定字数（可略多 10%），写不满不许提前收尾；严禁用空话、总结句、排比句凑字数\n' +
            '6. 不得复述前文：不得重复、改写、扩写本章已写内容或其它章节已经写过的任何句子、台词、场景；相同的场面（如每天清晨的打招呼、固定广播词）换个章再抄一遍就是严重失败\n' +
            '    6.1 同一件事在本章只发生一次：同一场交涉、问价、谈判、成交、同一目的的第二次上门、同一个论坛帖子的反应，都不许换个说法再来一遍；本章前面已经发生过的事，后面只能推进、不能重演。' +
            '尤其禁止「同类冲突场景」反复重演——如「床底藏物被房东翻出来」「身份被当众揭穿」「前任/追求者送花被赶走」「两人假扮情侣被拆穿」这种桥段，本章只许完整发生一次，换个说法、换个房间再来一遍就是严重失败（编辑直接拒）。\n' +
            '    6.2 关键事实只交代一次：人物已经知道的消息、已经做完的决定、已经付过的钱，后面直接当成既成事实用，不要再解释一遍、再确认一遍、再谈判一遍\n' +
            '    6.3 数字、金钱、规则必须前后一致且合情理：报价、还价、成交价要能对上；人物不会在没人逼迫的情况下主动把价格抬高十倍；说出去的话、付出的代价、换来的结果要能互相印证（付过钱拆掉的东西，后面不能再戴着；说过摘不了，就不能前面已经摘了）\n' +
            '7. 直接输出正文，不要加「第X章」标题、序号、解释、markdown、表情或代码块\n' +
            '8. 标点规范：对话与引用一律使用中文全角引号“”或「」，禁止英文半角双引号 " 与单引号 \' ；省略号统一用「……」，禁止用「..」或多个句号凑；所有标点使用中文全角\n' +
            '9. 章节连贯：本章必须与上一章自然衔接（承接其结尾的情节/场景/人物，不重写、不矛盾），并为下一章做铺垫；不得与上下章已经发生过的事实、设定、时间线冲突或重复\n' +
            '10. 段落要有呼吸：一个叙事段落 1-3 句（手机阅读，短段落更好读），围绕同一个画面或同一段心理展开；别把一个画面碎成一个词一段，也别把几百字挤成一段。' +
            '叙述、动作、心理、对话四种段落必须交替出现——绝对禁止连续多段都是「引号+说话人」的纯对话；' +
            '每写完一两句对话，就必须用一句话的动作、神态、环境或内心把节奏切断，否则读起来就是 AI 一问一句对答。一个角色在单段里连续说的话也不要超过 4 句。\n' +
            '11. 人物必须立起来，读者要能认识他（本章重头，不许只会写动作不写人）：\n' +
            '    11.1 必须写人物的内心反应：具体的念头、顾虑、犹疑、回忆，以及身体反应（手心出汗、愣住、笑到一半收住、话到嘴边又改口）。要写「具体的那一个念头」，不要写「一种难以名状的情绪」这类标签\n' +
            '    11.2 每个出场人物至少给一个能被读者记住的特征：一个习惯动作、一处执念、一个害怕的东西、一种固定的说话方式；同一个人在不同章里要保持一致，不能一时细心一时粗心\n' +
            '    11.3 用人物自己的选择暴露性格：他在没人看见时做什么、对谁客气对谁敷衍、他在这件事上为什么退让、什么话他始终不说出口——这些都要写出来，让人物自己显形\n' +
            '    11.4 禁止用叙述者替读者下结论（如「他其实很善良」「这说明他在乎她」「大家都看得出来」）；判断权留给读者，你只负责给细节。同一件事不要连续用两句话换着说法重复表达\n' +
            '    11.5 本章写完，读者必须能回答：他是谁、他在乎什么、他怕什么、他为什么这么做。做不到就是本章失败，回头补人物\n' +
            '12. 开篇要有钩子：头两段必须让读者知道「这是谁、他正处于什么处境、有什么事要发生」，同时让主角的性格先露一角——他怎么对待一件小事，就能看出他是谁。可以是一个反常的细节、一个没解释的动作、一句意有所指的话；不许从流水账式的日常流程写起（几点几分起床、按固定顺序先吃什么后吃什么这类罗列）\n' +
            '13. 平台签约标准（编辑按这些拒稿，必须逐条做到）：\n' +
            '    13.1 黄金三章：前三章每一章的前 300 字内必须出现冲突、悬念、反常或抉择；不许用「清晨的阳光 / 夜色渐深」这类时间+天气起笔，更不许从上学、吃饭、走路这类日常流水写起。读者要在前三章内知道「主角想要什么、谁在拦着、失败了会怎样」\n' +
            '    13.2 每章结尾必须卡在钩子上：一个反转、一个新信息、一次两难、或一句没说出口的话；不许「今天先这样」式收尾，不许用感慨句收尾\n' +
            '    13.3 套话限额：同一种修辞、同一个动作词，全章最多出现 1 次（如「微微一笑」「轻声」「目光」「一丝」）；换主语、换同义词重复也算，找不到合适表达就换个完全不同的具体动作\n' +
            '    13.4 禁止标签式人设：不许写「表面开朗实则敏感」「外人眼中高冷」这种设定说明；性格只能靠具体事件和选择让读者自己认出来\n' +
            '    13.5 严禁乒乓式对话（这是 AI 生成最明显的指纹，编辑一眼就拒）：两个人之间不要出现一问一句、逐句追问又互相确认的来回' +
            '（典型如「为什么？」「因为……」「真的？」「真的。」「为什么不信？」「就是不信。」这种句句对答、谁也不往前推情节）。' +
            '每段对话之间必须插进动作、神态、环境或心理把节奏拉开，禁止连续 3 段以上只有引号加说话人、没有一点叙述。' +
            '对白占比不超过全文 35%；问答只能在交换关键信息或制造冲突时出现，禁止一个人把情节原委讲给另一个人听（那是讲给读者听的解说），' +
            '也禁止把本来一句话能说清的事拆成十几回合一问一答来凑字数。\n' +
            '    13.6 段落 1-3 句成段（番茄是手机阅读，短段落更好读）；但同一个画面不要碎成一个词一段，也别把几百字挤成一段不分行\n' +
            '    13.7 严禁旁白式下结论：「她知道」「他明白」「这说明」「谁都看得出来」一律不许出现；情绪与关系只给细节，判断权留给读者。' +
            '更严禁「全知叙述者剧透/跳出来总结」：不许写「她不知道的是……」「他不知道……」「殊不知」「XX之谜解开了」「读者会明白」「不用说读者也看得出来」这类句子——秘密必须由角色自己当场发现，不能由叙述者代劳或提前剧透；结尾也不要写「他的故事还没完」这种旁白收束句。\n' +
            '    13.8 已公开的事实不可逆：一旦某信息已经当着相关角色的面被披露（如身份、秘密当众曝光、钱已亮出来），后续绝不能再写「无人知晓 / 重新隐瞒 / 重新发现 / 大家以为他身无分文」；已经发生并被看见的事，不能被「撤回」或「假装没发生」。前面全员已知道的事，后面角色不能又去编一个与之矛盾的谎。\n' +
            '    13.9 设定必须自洽：明确给出的规则性设定（如「一周查两次」「月租一千八」「六个人合租」）在正文里必须被遵守，不得自相矛盾——不能一面说一周两次，一面连续天天查；不能一面说六个人，一面多出或少了人。\n' +
            '    13.10 新角色与核心冲突要有铺垫：关键新角色（如带来冲突的前任、债主、亲戚）和主要新冲突，在正式出场前至少要有一次提及或伏笔，不能凭空从天而降；前男友、秘密身世这类要靠前稍稍埋线，再出场才有张力。\n' +
            '    13.11 禁止孤立对话碎片：每段对话都必须有明确的说话人和对话对象，且上一段要有承接；绝不允许出现连续多句同一人、没有对方回应、也没有叙述交代的孤立引号（如「"怎么了？"林晚问。」接「"还没睡？"林晚问。」接「"试试看。"林晚说。」这种凭空冒出的断片）；对话卡壳或场景切换时，必须先写一句动作/环境把上下文交代清楚。' +
            '    13.12 杜绝平台重点治理的低质问题（红线，违反直接处置）：\n' +
            '        (a) 行文冗余 / 文笔空洞：每句话都必须推进剧情或刻画人物，禁止用无信息量的环境铺垫、心理独白、设定说明、传说背景来凑字数；写不长就缩短章节，绝不注水。\n' +
            '        (b) 词藻堆砌 / 句式呆板：长短句交替、每段句式各不相同；禁止空泛高级形容词（深邃 / 神秘 / 诡异 / 阴沉 / 巨大 / 精致 / 微妙 / 难以言喻）堆砌情绪，禁止排比对仗，禁止连续多句同一结构。\n' +
            '        (c) 格式混乱 / 情节片段化：严格按「总—分—总」三幕写，情节连续推进、不跳拍，不写互不相关的碎片场景；段落 1-3 句成段、叙述 / 动作 / 心理 / 对话四种交替出现。\n' +
            '        (d) 仓促收尾 / 关键剧情未收束 / 敷衍结束：结尾必须让本章核心事件有阶段性结果，主要人物去向或主要矛盾至少给读者一个落点；禁止「今天先这样」「日子就这样过去」「就这样结束了」式敷衍收尾，禁止核心冲突还没有任何结果就戛然而止；关键剧情线必须收束或明确留钩，不得草率终止。';

        const charInfo = chars.length
            ? '\n出场角色：\n' + chars.map(c => c.name + '：' + (c.personality || '') + '；目标：' + (c.goals || '')).join('\n')
            : '';
        // 弹窗里填写的每一项都是硬性要求：核心事件 / 字数 / 基调 / 出场角色 / 额外要求，
        // 必须逐条落实，不许模型自行取舍、替换或偷工。
        const hardRules = [
            '【本章硬性要求（填写的每一项都必须逐条满足，不得自行取舍、不得替换）】',
            '1. 核心事件：' + eventDesc +
            '\n   —— 本章主线只能是这件事，必须完整写足：起因、经过、结果都要有，不得中途换成别的事件，不得只写个开头就收。',
            '2. 目标字数：约 ' + target + ' 字（上下浮动 15%）。以把故事讲完整为准——情节讲完了就收，绝不为了凑字数注水；' +
            '空泛的环境铺垫、心理独白、设定说明、传说背景都算注水（会触发平台低质处置），禁止用它们凑字数。',
            '3. 情感基调：' + toneLabel + '。全章的用词、句式、节奏、张力都照这个基调走，不许跑成别的风格。',
            chars.length
                ? '4. 出场角色：仅限 ' + chars.map(c => c.name).join('、') + '。只有这些角色可以登场、有姓名、有台词；' +
                  '不许新增主要角色；无名配角（店员、路人、同学甲）也不得塞给名字和成套台词。'
                : '',
            extraReq
                ? '5. 额外要求（最高优先级，逐条落实）：' + extraReq + '\n' +
                  (function (norm) {
                      return norm ? '   ↓ 已把上面的要求解析成编号硬约束，必须逐条做到：\n' + norm + '\n' : '';
                  })(this.normalizeExtraRequirement(extraReq)) +
                  '   —— 每一条都要在正文里看得见结果；若涉及「总分总 / 烂尾 / 冗余 / 空洞 / 词藻 / 句式 / 格式 / 片段化」，' +
                  '一律按 systemPrompt 的 13.12 红线执行（这是硬性要求，不是建议）。' +
                  '若里面提出了问题（例如「某人会来阻止还是帮忙？」），本章必须给出明确答案，不许回避、不许含糊。'
                : '',
            '6. 各项之间若看似冲突，按「额外要求 > 核心事件 > 情感基调 > 出场角色 > 字数」取舍，并在正文里自圆其说。'
        ].filter(Boolean).join('\n');
        const repeatedNotice = this.getRepetitiveSentencesNotice(work);
        const baseContext = memory + '\n\n' + hardRules + charInfo +
            (repeatedNotice ? '\n\n' + repeatedNotice : '') +
            // 本章已有正文里反复出现的套话：生成时直接避开（整章续写/重写都受益）
            (function (self) {
                const live = (typeof options.baseContent === 'string')
                    ? options.baseContent
                    : ((self.currentChapter && chapter && self.currentChapter.id === chapter.id)
                        ? ((document.getElementById('chapterContent') || {}).value || '')
                        : ((chapter && chapter.content) || ''));
                const notice = self.buildBannedPhraseNotice(live);
                return notice ? '\n\n' + notice : '';
            })(this) +
            // 已有章节的开场句：防止每章都用同一句「清晨的阳光……」开篇
            '\n\n' + this.buildOpeningBanNotice(work) +
            // 上下章上下文：让本章既接住上章、又为下章铺垫，整体连贯
            (function (self) {
                const prevTail = self.getPreviousChapterTail(work, chapter, 1500);
                const nextCtx = self.getNextChapterContext(work, chapter, 1200);
                let block = '';
                if (prevTail) block += '\n\n【上一章结尾（本章须从这里自然接住，承接其情节/场景/人物，不重写、不矛盾）】\n' + prevTail;
                if (nextCtx) block += '\n\n【下一章开头/概要（本章结尾要为其做铺垫，与之连贯、不冲突）】\n' + nextCtx;
                return block;
            })(this);

        // 空章节生成时给出上一章结尾，让本章从上一章停下的地方接着写
        const liveNow = (typeof options.baseContent === 'string')
            ? options.baseContent
            : ((document.getElementById('chapterContent') || {}).value || '');
        const prevTail = liveNow.trim() ? '' : this.getPreviousChapterTail(work, chapter, 1500);

        // 分段尺寸：单段 ~2200 字；并强制「总—分—总」三幕——正文足够长时至少拆成 3 段
        // （开头 / 剧情 / 结尾），避免一章只剩「开头+结尾」、把剧情主体挤没。
        const segSize = 2200;
        const segCount = target >= 2000
            ? Math.max(3, Math.ceil(target / segSize))
            : Math.max(1, Math.ceil(target / 2600));
        const done = [];
        let written = 0;
        const emptyRetry = {};
        onProgress(5, '正在请求模型生成整章（共 ' + segCount + ' 段，目标 ' + target + ' 字）...');

        // 分节大纲：先让模型把「本章核心事件」拆成 N 拍，再逐拍写。
        // 没有大纲时模型只知道核心事件和上一段结尾，写到第 3、4 段容易「另起主线」，前后脱节。
        let beats = [];
        if (segCount > 1) {
            try {
                beats = await this.planChapterBeats(baseContext, target, segCount, settings, signal, toneLabel, toneGuide);
            } catch (e) { beats = []; }
            if (beats.length) {
                onProgress(12, '已生成本章分节大纲（' + beats.length + ' 拍），开始逐段写作…');
            }
        }

        for (let i = 0; i < segCount; i++) {
            if (signal && signal.aborted) throw new Error('生成已停止');
            const remain = target - written;
            if (remain < 200) break;
            // 字数按段均分：每拍约 target/segCount 字，最后一段吃掉余数，避免前段占太多导致剧情段被压没
            const partSize = Math.round(target / segCount);
            const want = i === segCount - 1
                ? Math.max(400, target - written)
                : Math.min(segSize, Math.max(400, partSize));
            const writtenText = done.join('\n\n');
            const parts = [
                baseContext,
                '【本节任务】写第 ' + (i + 1) + ' / ' + segCount + ' 节，本节约 ' + want + ' 字。',
                '【本段情感基调（用词、句式、节奏必须照此执行）】' + toneLabel,
                // 本拍剧情 + 前几拍已发生的剧情：保证每段都沿同一条剧情线推进
                beats[i] ? '【本拍剧情（严格按此推进，不得另起主线、不得跳拍）】\n' + beats[i] : '',
                (i > 0 && beats.length)
                    ? '【前几拍已发生（可承接、可呼应伏笔，但不得改写、不得重复）】\n' + beats.slice(0, i).join('\n')
                    : '',
                i === 0
                    ? (prevTail
                        ? '【本段叙事功能：起·开头（总—引入）】本节是本章开篇，要接住上一章结尾的情节（不要重写上一章已经发生过的清晨、起床、上班等场面）。\n【上一章结尾】\n' + prevTail +
                          '\n从这里接着写，第一句直接进入正在发生的事，不要用「清晨的阳光」这类时间+天气句式重新开场，更不许把上一章或前面章节的原句再抄一遍。' +
                          (segCount === 1 ? '\n注意：本章只有这一段，必须在本段内依次完成「开头立人物立处境抛钩子 → 中段展开核心冲突与波折 → 结尾收束并卡在钩子上」，不能只写一个开头就停。' : '')
                        : '【本段叙事功能：起·开头（总—引入）】本节是本章开篇：引入场景与人物，直接切入事件，不要写预告式概述；第一句直接写正在发生的动作或对话，不要用「清晨的阳光/夜色渐深/第二天」这类句式起笔。\n' +
                          '【开篇硬性要求】头两段必须给出「谁 + 什么处境 + 什么将要发生」的钩子——可以是一个反常的细节、一个没解释的动作、一句意有所指的话；' +
                          '严禁从流水账式的日常流程写起（几点几分、按固定顺序先吃什么后吃什么这种罗列）。头两段还要让主角的性格先露一角——他怎么对待眼前的一件小事，就能看出他是谁。叙事段落 2-4 句成段，围绕同一画面展开，不要一句一段。' +
                          (segCount === 1 ? '\n注意：本章只有这一段，必须在本段内依次完成「开头立人物立处境抛钩子 → 中段展开核心冲突与波折 → 结尾收束并卡在钩子上」，不能只写一个开头就停。' : ''))
                    : '以下是本章已写内容，请顺着它的情节与场景继续往下写（尤其注意承接它的结尾），不得重复已有内容：\n【已写正文】\n' +
                      (writtenText.length > 900 ? writtenText.slice(-900) : writtenText) +
                      (i === segCount - 1 ? '' : '\n【本段叙事功能：承·剧情（分—展开）】本段是本章的「剧情」主体：必须展开核心冲突、制造至少一次波折/反转/意外，推进人物关系与悬念；承上启下，不能平铺直叙只做过渡，也不能提前收束（收束留给最后一段）。'),
                '【禁止复述（硬性）】前文（本章已写部分和其它章节）里出现过的句子、台词、广播词、场景开头，' +
                '本章一律不得再写；不能原句照抄，也不能换几个字改写后照抄；本段结尾也不要概括总结本章。',
                i === segCount - 1
                    ? '【本段叙事功能：合·结尾（总—收束）】本节是本章最后一段，必须完成两件事：' +
                      '①把本章核心事件的「结局」写出来——主要人物去向、主要矛盾至少给读者一个阶段性落点，关键剧情线要收束或明确留钩，绝不许核心冲突还没有任何结果就戛然而止，也绝不许用「今天先这样」「日子就这样过去」「就这样结束了」这类敷衍方式草率终止；' +
                      '②与【下一章开头/概要】自然衔接，为后续章节做铺垫，结尾卡在钩子上（一个反转、一个新信息、一次两难、或一句没说出口的话）。' +
                      '不要再开启新支线；不许用感慨句收尾，也不要把本章前面已经写过的对话在结尾再原样重复一遍。'
                    : '本节只负责推进本拍剧情，不要在本节结尾处收束全章（结尾留给最后一段）。',
                '【要求】本节 ' + want + ' 字左右（不得少于 ' + Math.round(want * 0.85) + ' 字）；只输出本节新增正文。\n' +
                '【自检（输出前逐条确认）】1. 本段句式、用词、对话节奏是否都符合情感基调，是否口语自然、没有翻译腔；' +
                '2. 有没有硬凑比喻和「一丝/微微/难以言喻/弥漫/氛围」这类空泛词，有没有排比和结尾讲道理；' +
                '3. 本段有没有写出人物的内心反应（具体念头、顾虑、身体反应）和至少一个能让人记住他的细节？如果通篇只有动作没有内心，就是失败，重写；' +
                '4. 引号是否都是中文全角“”、省略号是否都是「……」、人名有没有漏字写错；' +
                '5. 是否顺着「本拍剧情」推进、没有另起主线，也没有复述前文的句子和台词。'
            ];
            const userPrompt = parts.filter(Boolean).join('\n\n');
            const part = await this.callAIAPI(systemPrompt, userPrompt, settings, {
                signal: signal,
                genType: i === 0 ? 'chapter' : 'sub',
                maxTokens: Math.min(4000, Math.max(800, Math.ceil(want * 1.6))),
                onChunk: (delta, full) => {
                    const totalNow = written + full.length;
                    const pct = Math.min(97, (totalNow / target) * 100);
                    onProgress(pct, '正在生成第 ' + (i + 1) + '/' + segCount + ' 段… 已输出 ' + totalNow + ' / ' + target + ' 字');
                }
            });
            let cleaned = this.stripChapterHeadings(String(part || '').trim());
            cleaned = this.removeRepeatedAgainstChapter(cleaned, writtenText);
            cleaned = this.trimIncompleteTail(cleaned);
            if (cleaned) {
                done.push(cleaned);
                const before = written;
                written += cleaned.length;
                onProgress(Math.min(97, (written / target) * 100),
                    '第 ' + (i + 1) + '/' + segCount + ' 段完成（+' + (written - before) + ' 字，累计 ' + written + ' / ' + target + ' 字）');
            }
            // 模型偶发空段：同一段最多重试 2 次，避免死循环
            if (!cleaned) {
                emptyRetry[i] = (emptyRetry[i] || 0) + 1;
                if (emptyRetry[i] <= 2) { i--; continue; }
                break;
            }
            emptyRetry[i] = 0;
        }

        // 仍不足目标：继续补写直到写满（最多 5 轮）。长章单轮最多只能拿回约 3000 字，
        // 只补 1-3 轮往往补不到 20000，所以这里放开到 5 轮。
        let supply = 0;
        while (written < target * 0.95 && supply < 5) {
            supply++;
            const need = target - written;
            const writtenText = done.join('\n\n');
            const userPrompt = [
                baseContext,
                '【已写正文结尾】\n' + (writtenText.length > 900 ? writtenText.slice(-900) : writtenText),
                '【补写任务（第 ' + supply + ' 轮）】目前本章只有 ' + written + ' 字，距离目标 ' + target + ' 字还差约 ' + need + ' 字。' +
                '请顺着上文继续写，把本章剩余情节补完整并收束全章，补写约 ' + need + ' 字；不得重复已有内容，' +
                '也不要把已经写过的对话、场面、台词再抄一遍；结尾必须给出本章核心事件的最终结果，并且卡在钩子上——一个反转、一个新信息、一次两难，或一句没说出口的话；不许用感慨句收尾。',
                '【要求】只输出补写部分的新正文。'
            ].join('\n\n');
            if (signal && signal.aborted) throw new Error('生成已停止');
            onProgress(Math.min(97, (written / target) * 100), '字数不足，正在补写第 ' + supply + ' 轮…（' + written + ' / ' + target + ' 字）');
            const more = await this.callAIAPI(systemPrompt, userPrompt, settings, {
                signal: signal, genType: 'sub',
                maxTokens: Math.min(4000, Math.ceil(need * 1.6)), onChunk: () => {}
            });
            let cleaned = this.stripChapterHeadings(this.removeRepeatedAgainstChapter(String(more || '').trim(), writtenText));
            cleaned = this.trimIncompleteTail(cleaned);
            if (!cleaned) break;
            done.push(cleaned);
            written += cleaned.length;
        }

        let content = done.join('\n\n').trim();
        // 开场守卫：整章生成同样不许用套路句/别章用过的开场
        content = this.stripFormulaicOpening(content, this.collectChapterOpenings(work), false);
        content = this.applyTypoFixes(content).text;
        // 全文校对错别字（分块，覆盖每一段，不再只校前 6000 字）。
        // 勾了「生成后自动润色」时，润色链路每段都会再校一遍，这里就跳过，避免同一章请求两遍。
        if (options.proofread !== false && content.trim().length >= 30) {
            if (signal && signal.aborted) throw new Error('生成已停止');
            onProgress(99, '正在校对全文错别字…');
            content = (await this.polishTypos(content, '整章生成')).text;
        }
        onProgress(100, '生成完成！共 ' + content.length + ' 字（目标 ' + target + ' 字）');
        this._lastChapterTarget = target;
        return content;
    }

    /* ============ 整章生成：按章节独立的后台任务（关闭弹窗后继续） ============ */

    getMaxParallelFullChapter() { return 3; }

    /** 该章是否正在后台生成整章 */
    isFullChapterRunning(chapterId) {
        const job = chapterId ? this.fullChapterJobs.get(chapterId) : null;
        return !!(job && job.running);
    }

    /**
     * 章节列表里的 📖：用本章概要做核心事件，直接后台生成整章；
     * 本章没有概要时，切到该章并打开弹窗让用户填写。
     */
    quickGenerateFullChapter(chapterId) {
        const chapter = this.findChapterById(chapterId);
        if (!chapter) { this.showNotification('未找到该章节', 'error'); return; }
        if (this.isFullChapterRunning(chapterId)) { this.stopFullChapterJob(chapterId); return; }
        const eventDesc = (chapter.summary || '').trim();
        if (!eventDesc) {
            this.showNotification('第 ' + chapter.number + ' 章还没有概要，请用「📖 生成整章」填写核心事件', 'warning');
            if (!this.currentChapter || this.currentChapter.id !== chapterId) {
                if (this.dirty && this.currentChapter) this.saveChapter(true);
                this.loadChapter(chapterId);
            }
            this.openFullChapterModal();
            return;
        }
        // 目标字数沿用弹窗里的当前选择（默认 8000）
        const fcLength = document.getElementById('fcLength');
        const targetLength = parseInt(fcLength ? fcLength.value : 8000) || 8000;
        const fcTone = document.getElementById('fcTone');
        const tone = fcTone ? fcTone.value : 'tense';
        this.startFullChapterJob(chapterId, { eventDesc: eventDesc, selectedChars: [], targetLength: targetLength, tone: tone, extraReq: '' });
    }

    /**
     * 启动某一章的整章生成任务：关闭弹窗后仍在后台继续，完成后自动写入本章。
     * opts: { eventDesc, selectedChars, targetLength, tone, extraReq }
     */
    startFullChapterJob(chapterId, opts) {
        const chapter = this.findChapterById(chapterId);
        if (!chapter) { this.showNotification('未找到该章节', 'error'); return null; }
        const exist = this.fullChapterJobs.get(chapterId);
        if (exist && exist.running) {
            this.showNotification('第 ' + chapter.number + ' 章正在后台生成整章，可点「⏹」停止，或点侧栏任务项查看进度', 'info');
            return exist;
        }
        const runningCount = Array.from(this.fullChapterJobs.values()).filter(j => j.running).length;
        if (runningCount >= this.getMaxParallelFullChapter()) {
            this.showNotification('同时最多 ' + this.getMaxParallelFullChapter() + ' 章并行生成整章，请先停止一个任务', 'warning');
            return null;
        }
        // 同一章不能同时续写 / 润色 / 整章生成：它们都会改写正文，先停掉其它任务
        this.stopChapterOtherTasks(chapterId, '生成整章');
        // 正文来源：当前打开的章节用编辑器里未保存的最新内容，其余章节用已保存正文
        let baseContent = chapter.content || '';
        if (this.currentChapter && this.currentChapter.id === chapterId) {
            const ta = document.getElementById('chapterContent');
            if (ta && typeof ta.value === 'string') baseContent = ta.value;
        }
        opts = opts || {};
        const job = {
            chapterId: chapterId,
            workId: this.work.id,
            chapterNumber: chapter.number,
            chapterTitle: chapter.title,
            chapterLabel: '第' + chapter.number + '章《' + (chapter.title || '') + '》',
            abort: new AbortController(),
            running: true,
            status: 'running',
            baseContent: baseContent,
            targetLength: Math.max(500, parseInt(opts.targetLength, 10) || 3000),
            progress: { percent: 0, text: '准备生成…' },
            result: '',
            autoPolish: opts.autoPolish !== false,
            startedAt: Date.now()
        };
        this.fullChapterJobs.set(chapterId, job);
        const payload = {
            eventDesc: opts.eventDesc || '',
            selectedChars: opts.selectedChars || [],
            targetLength: job.targetLength,
            tone: opts.tone || 'tense',
            extraReq: opts.extraReq || '',
            work: this.work,
            chapter: chapter,
            baseContent: baseContent,
            // 勾了「生成后自动润色」时，润色每段都会校一遍，这里就不再重复请求
            proofread: !job.autoPolish
        };
        this.refreshTaskUI();
        this.showNotification('已开始后台生成「' + job.chapterLabel + '」，关闭弹窗也不会中断，完成后自动写入本章', 'info');
        this.runFullChapterJob(job, payload).catch(err => {
            job.running = false;
            job.status = 'error';
            job.progress = { percent: job.progress.percent, text: '生成异常：' + ((err && err.message) || err) };
            this.refreshTaskUI();
            this.showNotification('第 ' + (chapter.number || '?') + ' 章整章生成异常：' + ((err && err.message) || err), 'error');
        });
        return job;
    }

    /** 停掉某章上其它会改写正文的任务（续写 / 润色 / 整章生成），except 指定要保留的那类 */
    stopChapterOtherTasks(chapterId, except) {
        if (except !== '续写') {
            const c = this.continueJobs.get(chapterId);
            if (c && c.running) {
                c.running = false;
                try { c.abort.abort(); } catch (e) { /* 忽略 */ }
                this.continueJobs.delete(chapterId);
            }
        }
        if (except !== '润色') {
            const p = this.polishJobs.get(chapterId);
            if (p && p.running) {
                p.running = false;
                try { p.abort.abort(); } catch (e) { /* 忽略 */ }
                this.polishJobs.delete(chapterId);
            }
        }
        if (except !== '生成整章') {
            const f = this.fullChapterJobs.get(chapterId);
            if (f && f.running) {
                f.running = false;
                try { f.abort.abort(); } catch (e) { /* 忽略 */ }
                this.fullChapterJobs.delete(chapterId);
            }
        }
    }

    /** 整章生成主流程：完成后自动写入本章正文（用户期间改过则追加，不覆盖） */
    async runFullChapterJob(job, payload) {
        const chapter = this.findJobChapter(job);
        if (!chapter) { this.fullChapterJobs.delete(job.chapterId); this.refreshTaskUI(); return; }
        const signal = job.abort.signal;
        try {
            const content = await this.generateFullChapter({
                ...payload,
                signal: signal,
                onProgress: (percent, text) => {
                    job.progress = { percent: percent, text: text };
                    this.scheduleFullChapterUiRefresh(job);
                }
            });
            // 停止指令可能在最后一次请求返回后才生效：写盘前再确认一次
            if (signal.aborted) throw new Error('生成已停止');
            if (!content || !content.trim()) throw new Error('模型没有返回正文');
            job.result = content;
            const cur = chapter.content || '';
            if (cur !== job.baseContent && cur.trim()) {
                // 生成期间本章被改动过：追加而不是覆盖，避免丢掉用户的修改
                chapter.content = cur + '\n\n' + content;
            } else {
                chapter.content = content;
            }
            chapter.updatedAt = Date.now();
            job.status = 'done';
            job.progress = { percent: 100, text: '已完成，共 ' + content.length + ' 字' };
            this.saveData();
            this.renderChapterList();
            if (this.currentChapter && this.currentChapter.id === job.chapterId) {
                const ta = document.getElementById('chapterContent');
                if (ta) {
                    ta.value = chapter.content;
                    ta.scrollTop = ta.scrollHeight;
                    this.updateEditorWordCount();
                }
                this.setSaveStatus('saved', '✓ 已保存 ' + this.nowTime() +
                    '（第 ' + chapter.number + ' 章整章生成完成，' + content.length + ' 字）');
            }
            this.addActivity('生成整章', chapter.title || '');
            this.showNotification('「' + (job.chapterLabel || ('第' + chapter.number + '章')) +
                '」整章生成完成，共 ' + content.length + ' 字，已写入本章' +
                (job.autoPolish ? '，正在自动润色一遍…' : ''), 'success');
            // 生成完再润色一遍：提示词无法百分之百保证口语化/去 AI 味，用润色链路做二次把关
            if (job.autoPolish) {
                setTimeout(() => {
                    if (this.fullChapterJobs.has(job.chapterId)) return;   // 用户又起了新任务，别抢
                    if (this.continueJobs.get(job.chapterId)) return;
                    this.startPolishJob(job.chapterId);
                }, 600);
            }
        } catch (error) {
            const msg = (error && error.message) || '';
            const stopped = signal.aborted || msg.indexOf('已停止') >= 0;
            job.status = stopped ? 'stopped' : 'error';
            job.progress = { percent: job.progress.percent, text: stopped ? '已停止' : ('失败：' + msg) };
            this.showNotification('第 ' + (job.chapterNumber || '?') + ' 章整章生成' +
                (stopped ? '已停止' : '失败：' + msg), stopped ? 'info' : 'error');
        } finally {
            job.running = false;
            // 成功已写入正文，任务记录从面板移除；停止/失败的留在面板里供查看
            if (job.status === 'done') this.fullChapterJobs.delete(job.chapterId);
            this.refreshTaskUI();
        }
    }

    /** 手动停止某一章的整章生成（其他章节不受影响） */
    stopFullChapterJob(chapterId) {
        const job = this.fullChapterJobs.get(chapterId);
        if (!job) return;
        job.running = false;
        job.status = 'stopped';
        job.progress = { percent: job.progress.percent, text: '已停止' };
        try { job.abort.abort(); } catch (e) { /* 忽略 */ }
        this.showNotification('正在停止第 ' + (job.chapterNumber || '?') + ' 章的整章生成…', 'info');
        this.refreshTaskUI();
    }

    /** 关闭一条已结束的整章生成记录 */
    dismissFullChapterJob(chapterId) {
        const job = this.fullChapterJobs.get(chapterId);
        if (!job || job.running) return;
        this.fullChapterJobs.delete(chapterId);
        this.refreshTaskUI();
    }

    /** 点击后台任务面板里的整章生成项：跳到该任务所属作品与章节 */
    jumpToFullChapterJob(chapterId) {
        const job = this.fullChapterJobs.get(chapterId);
        if (!job) return;
        if (this.dirty && this.currentChapter) this.saveChapter(true);
        if (this.data.activeWorkId !== job.workId) {
            this.data.activeWorkId = job.workId;
            this.currentChapter = null;
            this.saveData();
            this.renderAll();
        }
        this.loadChapter(chapterId);
    }

    /** 节流刷新整章生成相关的 UI（任务面板 / 状态栏），避免频繁重建 DOM */
    scheduleFullChapterUiRefresh(job) {
        if (this._fullChapterUiTimer) return;
        this._fullChapterUiTimer = setTimeout(() => {
            this._fullChapterUiTimer = null;
            this.renderJobsBar();
            if (this.currentChapter && this.currentChapter.id === job.chapterId) {
                const p = job.progress || {};
                this.setSaveStatus('dirty', '正在后台生成第 ' + (job.chapterNumber || '?') + ' 章整章 · ' + (p.text || ''));
            }
        }, 400);
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    appendFullChapter() {
        if (!this.generatedContent) return;
        const textarea = document.getElementById('chapterContent');
        if (!textarea) return;
        const currentText = textarea.value;
        if (currentText && !currentText.endsWith('\n\n')) {
            textarea.value = currentText + '\n\n' + this.generatedContent;
        } else {
            textarea.value = currentText + this.generatedContent;
        }
        this.updateEditorWordCount();
        this.closeModal('fullChapterModal');
        this.showNotification('整章内容已追加到编辑器', 'success');
        if (this.currentChapter) this.saveChapter();
    }

    // ============ 一键生成完整小说 ============

    async startFullNovelGeneration() {
        if (!this.work.novel.title) {
            this.showNotification('请先填写作品名称', 'warning');
            this.switchTab('dashboard');
            return;
        }
        if (this.work.chapters.length === 0) {
            this.showNotification('请先创建至少一个章节骨架', 'warning');
            this.switchTab('chapters');
            return;
        }

        const modal = document.getElementById('novelProgressModal');
        if (modal) modal.classList.add('show');
        const logEl = document.getElementById('novelLog');
        if (logEl) logEl.innerHTML = '';
        const finalResult = document.getElementById('novelFinalResult');
        if (finalResult) finalResult.style.display = 'none';
        const retryBtn = document.getElementById('novelRetryBtn');
        if (retryBtn) retryBtn.style.display = 'none';

        this.failedChapters = [];
        this.novelStartTime = Date.now();
        this.fullNovelContent = '';
        this.work.chapters.sort((a, b) => a.number - b.number);
        await this.runChapterGeneration(this.work.chapters);

        this.updateNovelProgress(this.work.chapters.length, this.work.chapters.length, '全部章节生成完成！');
        this.renderChapters();

        const finalContent = document.getElementById('novelFinalContent');
        if (finalResult) finalResult.style.display = 'block';
        if (finalContent) finalContent.textContent = this.fullNovelContent.trim();
        if (retryBtn && this.failedChapters.length > 0) retryBtn.style.display = 'inline-flex';

        this.showNotification('完整小说生成完成！', 'success');
        this.addActivity('生成完整小说', this.work.novel.title);
    }

    /** 按章节列表执行生成（整本生成与失败重试共用） */
    async runChapterGeneration(chapters) {
        const skipExisting = document.getElementById('skipExistingChapters')?.checked !== false;
        const total = chapters.length;
        // 秒级刷新「已用时长」：否则一整章生成期间会一直停在 00:00
        this.novelStartTime = Date.now();
        this.updateElapsed();
        if (this._elapsedTimer) clearInterval(this._elapsedTimer);
        this._elapsedTimer = setInterval(() => this.updateElapsed(), 1000);
        // 单章目标字数，用于把「已输出字数」换算成进度条比例
        const settings = this.getLiveAISettings();
        const targetChars = { short: 200, medium: 500, long: 1000, chapter: 3000 }[settings.genLength] || 3000;
        try {
            for (let i = 0; i < total; i++) {
                const chapter = chapters[i];
                const globalIdx = this.work.chapters.findIndex(c => c.id === chapter.id);

                if (skipExisting && chapter.content && chapter.content.length > 100) {
                    this.appendNovelLog(`⏭️ 第${chapter.number}章《${chapter.title}》已有内容，跳过`);
                    this.fullNovelContent += `\n\n第${chapter.number}章 ${chapter.title}\n\n${chapter.content}`;
                    this.updateNovelProgress(i + 1, total, `已完成 ${i + 1} / ${total} 章`);
                    this.updateElapsed();
                    continue;
                }

                this.updateNovelProgress(i, total, `正在生成第 ${chapter.number} 章《${chapter.title}》...`);

                try {
                    const content = await this.generateSingleChapterWithAI(chapter, globalIdx, (delta, full) => {
                        // 流式输出：按已收到字数实时推进进度条（单章内 0%~95%）
                        const frac = Math.min(0.95, full.length / Math.max(targetChars, 1));
                        this.updateNovelProgress(i + frac, total,
                            `正在生成第 ${chapter.number} 章《${chapter.title}》… 已输出 ${full.length} 字`);
                        this.updateElapsed();
                    });
                    chapter.content = content;
                    chapter.updatedAt = Date.now();
                    this.fullNovelContent += `\n\n第${chapter.number}章 ${chapter.title}\n\n${content}`;
                    this.appendNovelLog(`✅ 第${chapter.number}章《${chapter.title}》完成（${content.length} 字）`);
                } catch (err) {
                    this.failedChapters.push(chapter);
                    this.appendNovelLog(`❌ 第${chapter.number}章失败：${err.message}`);
                    this.showNotification(`第${chapter.number}章生成失败，可稍后一键重试`, 'error');
                }

                this.saveData();
                this.updateNovelProgress(i + 1, total, `已完成 ${i + 1} / ${total} 章`);
                this.updateElapsed();
            }
        } finally {
            this.updateElapsed();
            if (this._elapsedTimer) { clearInterval(this._elapsedTimer); this._elapsedTimer = null; }
        }
    }

    updateElapsed() {
        const el = document.getElementById('novelElapsed');
        if (!el || !this.novelStartTime) return;
        const s = Math.floor((Date.now() - this.novelStartTime) / 1000);
        const mm = String(Math.floor(s / 60)).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        el.textContent = '已用时长 ' + mm + ':' + ss;
    }

    /** 重试之前生成失败的章节 */
    retryFailedChapters() {
        if (!this.failedChapters || this.failedChapters.length === 0) {
            this.showNotification('没有失败的章节', 'info');
            return;
        }
        const chapters = this.failedChapters.slice();
        this.failedChapters = [];
        const retryBtn = document.getElementById('novelRetryBtn');
        if (retryBtn) retryBtn.style.display = 'none';
        const finalResult = document.getElementById('novelFinalResult');
        if (finalResult) finalResult.style.display = 'none';
        const modal = document.getElementById('novelProgressModal');
        if (modal) modal.classList.add('show');
        this.appendNovelLog(`🔁 开始重试 ${chapters.length} 个失败章节...`);
        this.runChapterGeneration(chapters).then(() => {
            this.renderChapters();
            if (retryBtn && this.failedChapters.length > 0) retryBtn.style.display = 'inline-flex';
            this.showNotification('重试完成', 'info');
        });
    }

    async generateSingleChapterWithAI(chapter, index, onChunk) {
        const settings = this.getLiveAISettings();
        const prevCurrent = this.currentChapter;
        this.currentChapter = chapter;
        let memory = this.buildContextMemory();
        const prevSummary = index > 0
            ? `\n上一章（第${this.work.chapters[index-1].number}章）末尾内容：${(this.work.chapters[index-1].content || '').slice(-400)}`
            : '\n这是小说的第一章，需要交代背景、引出主角。';
        const chars = (chapter.characters || [])
            .map(id => this.work.characters.find(c => c.id === id))
            .filter(Boolean);
        const charInfo = chars.length
            ? '\n本章出场角色：\n' + chars.map(c =>
                `${c.name}：${c.personality || ''}；目标：${c.goals || ''}；能力：${c.abilities || ''}`
              ).join('\n')
            : '';
        const systemPrompt = `你是一位专业小说作家。请根据上下文信息，撰写第${chapter.number}章《${chapter.title}》。
风格要求：${this.getStyleName(settings.writingStyle)}
字数要求：${this.getLengthName(settings.genLength)}
写作要求：
1. 严格遵守已有世界观和角色设定，不得出现矛盾
2. 承接上一章内容，自然推进剧情，不得复述前文已经写过的句子、台词、场面
3. 本章概要：${chapter.summary || '无'}
4. 合理运用对话、动作、心理、环境描写
5. 直接输出章节正文，不要加任何解释、标题或分隔符\n【口语化与去AI味（同样必须遵守）】口语化、通俗易懂：像真人作者写的一样自然，不端着；书面腔、翻译腔、文艺腔换成日常说法（「抵达」改「到了」、「于是」改「就」），短句为主，别写一长串定语。严禁 AI 味：禁止硬凑比喻（「就像…」「仿佛…」「宛若…」）；禁止空泛修饰堆砌（「一丝」「微微一」「难以言喻」「氤氲」「弥漫」「思绪」「氛围」）；禁止排比、对仗、四字词连用；禁止结尾升华感慨讲道理。人物说话像真人：有来有回、有停顿有打断，禁止用台词把信息解释给读者听；写完人名要检查有没有漏字或写错。格式朴素：只用正常段落和中文全角标点，禁止 emoji、markdown、加粗、小标题、序号、代码块。人物必须立起来：要写人物具体的念头、顾虑、身体反应，每个出场人物至少给一个能被读者记住的特征（习惯动作/执念/害怕的东西/说话方式），让人物用自己的选择暴露性格，不要用叙述者替读者下结论——本章写完，读者要能回答他是谁、他在乎什么、他怕什么。
6. 标点规范：对话与引用一律使用中文全角引号“”或「」，禁止英文半角双引号 " 与单引号 ' ；所有标点使用中文全角`;
        const userPrompt = `${memory}\n\n${charInfo}\n${prevSummary}\n\n请开始撰写本章正文。`;
        this.currentChapter = prevCurrent;
        return this.callAIAPI(systemPrompt, userPrompt, settings, { onChunk });
    }

    // ============ 短故事模式（只给标题+类型，其余模型自由发挥；跨故事角色名不重复） ============

    /** 打开短故事模式弹窗 */
    openShortStoryModal() {
        const modal = document.getElementById('shortStoryModal');
        if (!modal) return;
        this.setValue('ssTitle', '');
        this.setValue('ssExtra', '');
        const len = document.getElementById('ssLength');
        if (len) len.value = 3000;
        const res = document.getElementById('ssResult');
        if (res) res.style.display = 'none';
        const prog = document.getElementById('ssProgress');
        if (prog) prog.style.display = 'none';
        const fill = document.getElementById('ssProgressFill');
        if (fill) fill.style.width = '0%';
        modal.classList.add('show');
        setTimeout(() => { const el = document.getElementById('ssTitle'); if (el) el.focus(); }, 50);
    }

    /** 解析角色 JSON（容错：抓不到 JSON 就按 "name":"X" 兜底） */
    parseCharactersJson(raw) {
        const s = String(raw || '');
        const m = s.match(/\{[\s\S]*\}/);
        if (m) {
            try {
                const o = JSON.parse(m[0]);
                if (o && Array.isArray(o.characters)) return o.characters;
            } catch (e) { /* 继续兜底 */ }
        }
        const out = [];
        const re = /"name"\s*:\s*"([^"]{2,4})"/g;
        let mm;
        while ((mm = re.exec(s))) out.push({ name: mm[1] });
        return out;
    }

    /** 生成一个没用过的中文名（角色名冲突时兜底替换） */
    pickUniqueName(used) {
        const surnames = ['沈', '顾', '陆', '苏', '林', '江', '周', '秦', '程', '温', '裴', '谢', '叶', '宋', '唐', '韩', '许', '白', '洛', '商', '闻', '容', '段', '黎'];
        const given = ['砚舟', '清和', '未晞', '见山', '听澜', '知白', '望舒', '归晚', '亭舟', '见微', '疏影', '长明', '子澈', '明烛', '兰舟', '南舟', '既白', '宴清', '春深', '拾月', '渡舟', '稚川', '照野', '怀瑾'];
        for (let i = 0; i < 400; i++) {
            const n = surnames[Math.floor(Math.random() * surnames.length)] +
                given[Math.floor(Math.random() * given.length)];
            if (!used.has(n)) return n;
        }
        return '无名' + Math.random().toString(36).slice(2, 5);
    }

    /** 归一化角色：保证名字 2~4 字、不与已用名重复、角色之间也不重复 */
    finalizeStoryNames(chars, banned) {
        const used = new Set(banned || []);
        const list = (Array.isArray(chars) && chars.length)
            ? chars
            : [{ name: '', role: '主角' }, { name: '', role: '对手' }, { name: '', role: '关键配角' }];
        const out = [];
        list.slice(0, 6).forEach(c => {
            let name = String((c && c.name) || '').trim();
            if (!/^[\u4e00-\u9fa5]{2,4}$/.test(name) || used.has(name)) name = this.pickUniqueName(used);
            used.add(name);
            out.push({ name: name, role: (c && c.role) || '', trait: (c && c.trait) || '' });
        });
        return out;
    }

    /** 从正文里补充抓取「名叫/叫做 X」的角色名（供后续故事去重，减少漏网） */
    extractStoryNames(text, seed) {
        const found = new Set(seed || []);
        const re = /(?:名叫|叫做)([\u4e00-\u9fa5]{2,3})/g;
        let m;
        while ((m = re.exec(String(text || '')))) found.add(m[1]);
        return Array.from(found);
    }

    /** 记录本次短故事用过的名字，供后续故事去重 */
    addShortStoryNames(names) {
        if (!Array.isArray(this.data.shortStoryNames)) this.data.shortStoryNames = [];
        const set = new Set(this.data.shortStoryNames);
        (names || []).forEach(n => {
            if (n && n.length >= 2 && !set.has(n)) { set.add(n); this.data.shortStoryNames.push(n); }
        });
        if (this.data.shortStoryNames.length > 800) {
            this.data.shortStoryNames = this.data.shortStoryNames.slice(-800);
        }
    }

    /** 第一步：让模型设计角色（必须避开已用名） */
    async designShortStoryCharacters(title, genreLabel, banned, settings) {
        const bannedText = (banned && banned.length) ? banned.join('、') : '无';
        const userPrompt = `为下面这篇短篇小说设计 3~5 个角色（只做设定，不写正文）。\n` +
            `【标题】${title}\n【类型】${genreLabel}\n` +
            `【硬性要求】\n` +
            `1. 姓名必须是 2~3 个汉字，符合该类型小说的人名习惯；\n` +
            `2. 严禁使用以下已经用过的名字（一个字都不能相同）：${bannedText}；\n` +
            `3. 角色彼此之间名字也不能重复；\n` +
            `4. 每个角色给出：姓名、身份/作用、一句话性格或特征；\n` +
            `5. 只输出 JSON，不要解释，格式：\n` +
            `{"characters":[{"name":"张三","role":"主角，……","trait":"……"}]}`;
        const res = await this.callAIAPI(
            '你是短篇小说策划，只输出角色设定 JSON。', userPrompt, settings,
            { maxTokens: 700, onChunk: () => {} });
        return this.parseCharactersJson(res);
    }

    /**
     * 第二步：写正文。短篇（≤4200 字）一次成稿；长篇（>4200 字，最多 2 万字）
     * 按段续写：第 1 段=开头，中间=剧情，最后一段=结尾，逐段推进并传递上文结尾，
     * 保证达到目标字数、三幕齐全、结尾收束不烂尾。
     * onProgress(totalChars, segIndex, segCount) 用于进度显示。
     */
    async generateShortStoryBody(title, genreLabel, length, chars, banned, extra, settings, onProgress) {
        const charText = chars.map(c => '- ' + c.name + '：' + (c.role || '') + (c.trait ? '；' + c.trait : '')).join('\n');
        const bannedText = (banned && banned.length) ? banned.join('、') : '无';
        const systemPrompt = '你是一位成熟的短篇小说作者，只写小说正文，不写标题、解释、序号或分隔线。';
        // 这些要求会原样出现在每一段提示里，保证「所有要求模型都满足」，不会因为分段而丢失
        const common = `【标题】${title}\n【类型】${genreLabel}\n【目标总字数】约 ${length} 字\n` +
            `【固定角色（只能使用这些名字，不得新增有姓名的角色；其他人物一律用「店员/路人/医生」这类称呼）】\n${charText}\n` +
            `【已用过的名字（严禁再次使用，一个字都不能相同）】${bannedText}\n` +
            `【必须全部满足的要求】\n` +
            `1. 三幕结构：开头立冲突/悬念 → 中段展开冲突与波折 → 结尾收束核心事件，给结局或余味；\n` +
            `2. 绝不烂尾：结尾不许用「今天先这样/就这样结束了」敷衍，也不许在冲突没结果时戛然而止；\n` +
            `3. 只使用上面给定的人名，不得新增有名字的角色；\n` +
            `4. 口语化，短句为主、长短句交替；不硬凑比喻、不堆空泛形容词、不排比对仗、不空喊升华；\n` +
            `5. 每句都要推进剧情或刻画人物，不用环境铺垫/心理独白/设定说明凑字数；\n` +
            `6. 段落 1~3 句成段，叙述/动作/心理/对话交替，禁止连续 3 段以上纯对话，对白占比≤35%；\n` +
            `7. 禁止旁白式剧透或总结；标点全用中文全角（“”或「」，……），禁止英文半角 " 和 '。\n` +
            (extra ? `【额外要求（最高优先级，必须满足）】${extra}\n` : '');

        const cleanPart = (part) => {
            let c = this.stripChapterHeadings(String(part || '').trim());
            c = this.sanitizeQuotes(c);
            c = this.trimIncompleteTail(c);
            return c;
        };

        // 短篇：一次成稿
        if (length <= 4200) {
            const userPrompt = `请写一篇完整的短篇小说。\n` + common +
                `【结构】开头立刻进冲突 → 中段展开核心冲突与至少一次波折/反转 → 结尾收束核心事件、给出结局或余味。\n` +
                `【本段约 ${length} 字】只输出正文，不要标题、章节号、解释。\n` +
                `【写完自检】三幕是否齐全、是否收束不烂尾、是否只用给定人名、有没有英文引号或乒乓对话。`;
            const raw = await this.callAIAPI(systemPrompt, userPrompt, settings, {
                maxTokens: Math.min(8000, Math.max(2500, Math.ceil(length * 1.9))),
                onChunk: (d, full) => { if (typeof onProgress === 'function') onProgress(full.length, 1, 1); }
            });
            return cleanPart(raw);
        }

        // 长篇：先不断写「开头/剧情」，字数接近目标后再单独写「结尾」；
        // 模型某段写少了就继续补段，最后只收一次结尾——既不写不够，也不会中途烂尾。
        let written = '';
        let segIdx = 0;
        let totalSegs = 1;
        let consecutiveFails = 0;
        const emit = async (role, roleRule, want) => {
            const tail = written ? written.slice(-700) : '';
            const userPrompt = `请继续写这篇短篇小说的「${role}」部分。\n` + common +
                (tail ? `【已写正文的结尾（只供承接，禁止复述其中任何句子）】\n${tail}\n` : '') +
                `【本段要求】${roleRule}\n本段约写 ${want} 字，只输出本段新增正文，不要重复上文、不要写标题。\n` +
                `【写完自检】是否只用了给定人名、本段是否推进剧情、有没有英文引号或乒乓对话。`;
            let lastErr = null;
            // 每段最多重试 3 次；仍失败且已有内容时返回''（跳过该段继续），绝不让整篇停在半路
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const part = await this.callAIAPI(systemPrompt, userPrompt, settings, {
                        maxTokens: Math.min(7000, Math.max(2400, Math.ceil(want * 2.0))),
                        onChunk: (d, full) => {
                            if (typeof onProgress === 'function') onProgress(written.length + full.length, segIdx + 1, Math.max(totalSegs, segIdx + 1));
                        }
                    });
                    let clean = cleanPart(part);
                    if (written) clean = this.removeRepeatedAgainstChapter(clean, written);
                    // 模型偶尔返回空内容/被去重清空：也算失败，走重试而不是直接吃掉这一段
                    if (!clean || clean.length < 60) throw new Error('本段内容为空或过短');
                    consecutiveFails = 0;
                    return clean;
                } catch (e) {
                    // 用户主动停止：立刻退出，不要傻等重试
                    if (e && (e.name === 'AbortError' || /已停止/.test(e.message || ''))) throw e;
                    lastErr = e;
                    // 连续失败时等更久（限流通常需要 20 秒以上恢复）
                    const wait = consecutiveFails >= 2 ? 20000 : (5000 * (attempt + 1));
                    if (typeof onProgress === 'function') {
                        onProgress(written.length, segIdx + 1, Math.max(totalSegs, segIdx + 1),
                            '第 ' + (segIdx + 1) + ' 段失败，' + Math.ceil(wait / 1000) + ' 秒后重试…');
                    }
                    await this._sleep(wait);
                }
            }
            consecutiveFails++;
            if (!written) throw lastErr;   // 第一段就失败：直接报错
            return '';                     // 已有内容：跳过这一段，继续往下写
        };

        // 段数上限放宽：即使模型每段写得少，也允许继续补段直到接近目标
        const maxStorySegs = Math.min(30, Math.ceil(length / 1200) + 6);
        const segSize = 2000;
        while (segIdx < maxStorySegs && written.length < length * 0.85) {
            const isFirst = written.length === 0;
            const role = isFirst ? '起·开头' : '承·剧情';
            const rule = isFirst
                ? '本节是开头：立刻进入场景，前 300 字内出现冲突、悬念、反常或抉择；不写天气流水账，不要预告式概述。'
                : '本节是剧情中段：承接上文，展开核心冲突，至少一次波折或反转，人物关系/处境发生明显变化；不要收尾，也不要另起主线。';
            const remain = length - written.length;
            const want = Math.min(segSize, Math.max(900, remain));
            totalSegs = segIdx + 2;          // 最后还要留一段写结尾
            const clean = await emit(role, rule, want);
            segIdx++;
            if (!clean) {
                // 连续两段彻底失败（重试也没救回来）：不再硬撑，直接转去写结尾收束
                if (consecutiveFails >= 2) break;
                continue;
            }
            written = written ? written + '\n\n' + clean : clean;
            if (typeof onProgress === 'function') onProgress(written.length, segIdx, totalSegs);
        }
        if (!written) return '';
        // 结尾：只写一次，保证收束
        {
            const want = Math.min(2800, Math.max(600, length - written.length));
            const rule = '本节是结尾：收束核心事件，给出明确结局或余味；关键冲突必须有结果，不许烂尾、不许敷衍收场。';
            const clean = await emit('合·结尾', rule, want);
            if (clean) written = written ? written + '\n\n' + clean : clean;
            if (typeof onProgress === 'function') onProgress(written.length, segIdx + 1, segIdx + 1);
        }
        return written;
    }

    /** 把生成结果保存为一个独立作品（单章），返回作品 id */
    commitShortStory(title, genre, story) {
        const now = Date.now();
        const work = this.createWorkData({ title: title, genre: genre, author: '', createdAt: now, updatedAt: now });
        const chapter = {
            id: 'ch_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
            number: 1,
            title: title,
            content: story,
            characters: [],
            summary: '',
            createdAt: now,
            updatedAt: now,
            polishedAt: now
        };
        work.chapters.push(chapter);
        this.data.works.push(work);
        this.saveData();
        return work.id;
    }

    /** 短故事模式主流程 */
    async startShortStoryGeneration() {
        const title = (document.getElementById('ssTitle')?.value || '').trim();
        const sel = document.getElementById('ssGenre');
        const genre = sel ? sel.value : 'other';
        const genreLabel = (sel && sel.options[sel.selectedIndex]) ? sel.options[sel.selectedIndex].text : '其他';
        const length = Math.max(800, Math.min(20000, parseInt(document.getElementById('ssLength')?.value, 10) || 3000));
        const extra = (document.getElementById('ssExtra')?.value || '').trim();
        if (!title) { this.showNotification('请输入故事标题', 'warning'); return; }

        const btn = document.getElementById('ssGenBtn');
        const prog = document.getElementById('ssProgress');
        const fill = document.getElementById('ssProgressFill');
        const ptext = document.getElementById('ssProgressText');
        if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
        if (prog) prog.style.display = 'block';
        const setP = (pct, txt) => { if (fill) fill.style.width = pct + '%'; if (ptext) ptext.textContent = txt; };
        const settings = this.getLiveAISettings();
        const banned = Array.isArray(this.data.shortStoryNames) ? this.data.shortStoryNames.slice() : [];

        try {
            setP(5, '正在设计角色（避开已用过的名字）…');
            let designed = [];
            try { designed = await this.designShortStoryCharacters(title, genreLabel, banned, settings); }
            catch (e) { designed = []; }
            const chars = this.finalizeStoryNames(designed, banned);
            const names = chars.map(c => c.name);
            setP(15, '角色已定：' + names.join('、') + '，开始写正文…');

            const raw = await this.generateShortStoryBody(title, genreLabel, length, chars, banned, extra, settings,
                (totalChars, si, sc, statusText) => {
                    const pct = Math.min(95, 15 + (totalChars / Math.max(length, 1)) * 80);
                    setP(pct, statusText || ('正在写正文… 第 ' + si + '/' + sc + ' 段，已输出 ' + totalChars + ' 字'));
                });
            let story = this.stripChapterHeadings(String(raw || '').trim());
            story = this.sanitizeQuotes(story);
            story = this.trimIncompleteTail(story) || story;
            if (!story || story.length < 200) throw new Error('生成内容为空或过短');

            setP(97, '正在保存为作品…');
            this.addShortStoryNames(this.extractStoryNames(story, names));
            const workId = this.commitShortStory(title, genre, story);

            setP(100, '完成');
            const resBox = document.getElementById('ssResult');
            const resStats = document.getElementById('ssResultStats');
            const resContent = document.getElementById('ssResultContent');
            if (resBox) resBox.style.display = 'block';
            if (resStats) resStats.textContent = '（' + story.length + ' 字 / 目标 ' + length + ' 字 · 角色：' + names.join('、') + '）';
            if (resContent) resContent.textContent = story;
            const okLen = story.length >= length * 0.7;
            this.showNotification(
                okLen ? '短故事已生成，并保存为独立作品'
                    : '已生成但字数偏少（' + story.length + ' / ' + length + '），可重试或调低目标字数',
                okLen ? 'success' : 'warning');

            this.closeModal('shortStoryModal');
            this.switchWork(workId);
            const w = this.work;
            if (w && w.chapters[0]) this.loadChapter(w.chapters[0].id);
        } catch (e) {
            const msg = (e && e.message) || String(e);
            setP(0, '失败：' + msg);
            this.showNotification('短故事生成失败：' + msg, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '✨ 生成短故事'; }
        }
    }

    updateNovelProgress(current, total, stageText) {
        const fill = document.getElementById('novelProgressFill');
        const text = document.getElementById('novelProgressText');
        const stage = document.getElementById('novelProgressStage');
        // current 允许为小数（单章内按已输出字数推进），进度条平滑变化
        const percent = total > 0 ? Math.max(0, Math.min(100, (current / total) * 100)) : 0;
        if (fill) fill.style.width = percent + '%';
        if (text) {
            const done = Math.min(Math.max(Math.ceil(current - 0.0001), 0), total);
            text.textContent = `${done} / ${total} 章 · ${Math.round(percent)}%`;
        }
        if (stage) stage.textContent = stageText;
    }

    appendNovelLog(text) {
        const logEl = document.getElementById('novelLog');
        if (!logEl) return;
        const div = document.createElement('div');
        div.className = 'novel-log-item';
        div.textContent = text;
        logEl.appendChild(div);
        logEl.scrollTop = logEl.scrollHeight;
    }

    async exportFullNovel() {
        const title = this.work.novel.title || '未命名小说';
        const author = this.work.novel.author || '佚名';
        let text = `《${title}》\n作者：${author}\n`;
        const synopsis = (this.work.novel.synopsis || '').trim();
        if (synopsis) text += `简介：${synopsis}\n`;
        text += '\n';
        this.work.chapters.sort((a, b) => a.number - b.number);
        this.work.chapters.forEach(ch => {
            text += `\n\n${this.chapterHeading(ch)}\n\n${ch.content || ''}`;
        });
        const res = await this.saveTextFile(`${title}_完整小说.txt`, text, 'text/plain;charset=utf-8');
        this.exportNotify(res, '完整小说已导出');
    }

    previewAllChapters() {
        const content = document.getElementById('allChaptersContent');
        if (!content) return;
        if (this.work.chapters.length === 0) {
            this.showNotification('还没有章节可预览', 'info');
            return;
        }
        const sorted = [...this.work.chapters].sort((a, b) => a.number - b.number);
        let text = '《' + (this.work.novel.title || '未命名小说') + '》' +
            (this.work.novel.author ? '　作者：' + this.work.novel.author : '') + '\n\n';
        const synopsis = (this.work.novel.synopsis || '').trim();
        if (synopsis) text += '简介：' + synopsis + '\n\n';
        sorted.forEach(ch => {
            text += '\n第' + ch.number + '章 ' + ch.title + '\n\n' + (ch.content || '（暂无内容）') + '\n';
        });
        content.textContent = text;
        this._allChaptersText = text;
        const modal = document.getElementById('allChaptersModal');
        if (modal) modal.classList.add('show');
    }

    /** 一键复制全部章节内容（与预览框内文本一致：书名/作者 + 每章标题与正文） */
    copyAllChapters() {
        const el = document.getElementById('allChaptersContent');
        const text = (el && el.textContent) || this._allChaptersText || '';
        if (!text.trim()) {
            this.showNotification('暂无可复制的内容', 'warning');
            return;
        }
        this.copyText(text);
    }

    getStyleName(style) {
        const names = { balanced: '均衡', descriptive: '描写丰富', concise: '简洁明快', classical: '古典文雅', modern: '现代口语' };
        return names[style] || style;
    }

    getLengthName(len) {
        const names = { short: '约200字', medium: '约500字', long: '约1000字', chapter: '约3000字' };
        return names[len] || len;
    }

    // ============ 设置 ============

    saveSettings() {
        this.data.settings = {
            aiProvider: document.getElementById('aiProvider')?.value || 'custom',
            apiKey: document.getElementById('apiKey')?.value || '',
            aiModel: document.getElementById('aiModel')?.value || '',
            apiUrl: document.getElementById('apiUrl')?.value || '',
            writingStyle: document.getElementById('writingStyle')?.value || 'balanced',
            genLength: document.getElementById('genLength')?.value || 'chapter',
            streamEnabled: document.getElementById('streamEnabled')?.checked !== false,
            autoSaveInterval: parseInt(document.getElementById('autoSaveInterval')?.value) || 30,
            theme: document.getElementById('theme')?.value || 'light',
            fontSize: parseInt(document.getElementById('fontSize')?.value) || 16,
            lineHeight: parseFloat(document.getElementById('lineHeight')?.value) || 1.8
        };
        this.saveData();
        this.applySettings();
        this.startAutoSave();
        this.syncApiConfigVisibility();
        this.updateMockBadges();
    }

    loadSettings() {
        const s = this.data.settings;
        // 锁定模式：不把任何接口地址 / 模型 / 密钥写回页面，也不生成模型配置快照
        if (ZHIMO_LOCK) {
            this.setValue('apiKey', '');
            this.setValue('apiUrl', '');
            this.setValue('aiModel', '');
            this.setValue('writingStyle', s.writingStyle || 'balanced');
            this.setValue('genLength', s.genLength || 'chapter');
            this.applySettings();
            return;
        }
        // 遗留的「模拟模式」配置已无意义，矫正为「自定义API / 本地模型」，让已配好的本地模型地址继续生效
        const savedProvider = (s.aiProvider && s.aiProvider !== 'mock') ? s.aiProvider : 'custom';
        this.setValue('aiProvider', savedProvider);
        this.setValue('apiKey', s.apiKey || '');
        this.setValue('aiModel', s.aiModel || '');
        this.setValue('apiUrl', s.apiUrl || '');
        this.setValue('writingStyle', s.writingStyle || 'balanced');
        this.setValue('genLength', s.genLength || 'chapter');
        this.setValue('autoSaveInterval', s.autoSaveInterval || 30);
        this.setValue('theme', s.theme || 'light');
        this.setValue('fontSize', s.fontSize || 16);
        this.setValue('lineHeight', s.lineHeight || 1.8);
        const streamEl = document.getElementById('streamEnabled');
        if (streamEl) streamEl.checked = s.streamEnabled !== false;
        this.syncApiConfigVisibility();
        this.renderLocalGuide();
        this.ensureDefaultProfile();
        this.updateMockBadges();
        this.applySettings();
    }

    applySettings() {
        const s = this.data.settings;
        const themes = {
            light: { bg: '#f8fafc', card: '#ffffff', text: '#1e293b' },
            dark: { bg: '#0f172a', card: '#1e293b', text: '#e2e8f0' },
            sepia: { bg: '#f4ecd8', card: '#fdf6e3', text: '#433422' }
        };
        const theme = themes[s.theme] || themes.light;
        document.documentElement.style.setProperty('--bg-primary', theme.bg);
        document.documentElement.style.setProperty('--bg-card', theme.card);
        document.documentElement.style.setProperty('--text-primary', theme.text);
        const content = document.getElementById('chapterContent');
        if (content) {
            content.style.fontSize = (s.fontSize || 16) + 'px';
            content.style.lineHeight = s.lineHeight || 1.8;
        }
    }

    // ============ 导入导出 ============

    /** 导出为 Markdown（方便粘贴到笔记软件或博客） */
    async exportMarkdown() {
        const n = this.work.novel;
        let md = '# 《' + (n.title || '未命名小说') + '》\n\n';
        md += '> 作者：' + (n.author || '佚名') + '　类型：' + this.getGenreName(n.genre) + '\n\n';
        if (n.synopsis) md += '**作品简介**：' + n.synopsis + '\n\n';
        if (n.theme) md += '**核心主题**：' + n.theme + '\n\n';
        this.work.chapters.sort((a, b) => a.number - b.number);
        this.work.chapters.forEach(ch => {
            md += '## 第' + ch.number + '章 ' + ch.title + '\n\n' + (ch.content || '') + '\n\n';
        });
        const res = await this.saveTextFile((n.title || '未命名小说') + '.md', md, 'text/markdown;charset=utf-8');
        this.exportNotify(res, 'Markdown 已导出');
        this.addActivity('导出 Markdown');
    }

    async exportData() {
        if (ZHIMO_LOCK && this.data && this.data.settings) {
            this.data.settings.apiKey = '';
            this.data.settings.apiUrl = '';
            this.data.settings.aiModel = '';
        }
        const dataStr = JSON.stringify(this.data, null, 2);
        const name = (this.work.novel.title || '未命名小说') + '_' + new Date().toISOString().slice(0, 10) + '.json';
        const res = await this.saveTextFile(name, dataStr, 'application/json');
        this.exportNotify(res, '作品已导出');
        if (res && res.ok) this.addActivity('导出作品');
    }

    importData(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const imported = JSON.parse(e.target.result);
                if (!confirm('导入将覆盖当前所有作品与设置，是否继续？')) return;
                // 锁定模式：接口与模型不接受外部文件改写
                if (ZHIMO_LOCK) { delete imported.settings; delete imported.modelProfiles; }
                const data = this.getDefaultData();
                if (imported.settings) data.settings = Object.assign({}, data.settings, imported.settings);
                if (Array.isArray(imported.modelProfiles)) data.modelProfiles = imported.modelProfiles;
                if (Array.isArray(imported.works) && imported.works.length > 0) {
                    data.works = imported.works.map(w => this.normalizeWork(w));
                    data.activeWorkId = imported.activeWorkId || data.works[0].id;
                } else if (imported.novel || imported.chapters || imported.characters || imported.world) {
                    // 旧版单作品导出文件
                    data.works = [this.normalizeWork({
                        novel: imported.novel,
                        characters: imported.characters,
                        world: imported.world,
                        chapters: imported.chapters,
                        memory: imported.memory,
                        activities: imported.activities
                    })];
                    data.activeWorkId = data.works[0].id;
                } else {
                    throw new Error('文件中没有可导入的作品数据');
                }
                this.data = data;
                if (!this.data.works.some(w => w.id === this.data.activeWorkId)) {
                    this.data.activeWorkId = this.data.works[0].id;
                }
                this.currentChapter = null;
                this.currentCharacter = null;
                this.saveData();
                this.renderAll();
                this.showNotification('已导入 ' + this.data.works.length + ' 部作品', 'success');
            } catch (err) {
                this.showNotification('导入失败：' + (err.message || '文件格式错误'), 'error');
            }
        };
        reader.readAsText(file);
        event.target.value = '';
    }

    /**
     * 清空【当前作品】的内容（作品信息、角色、世界观、章节、记忆、活动记录）。
     * AI 服务配置与模型配置记录是全局数据，不会被清除。
     */
    clearCurrentWork() {
        const w = this.work;
        const name = w.novel.title || '未命名作品';
        if (!confirm('确定要清空作品《' + name + '》的所有内容吗？\n\n作品信息、角色、世界观、章节都会被删除，此操作不可恢复！')) return;
        if (!confirm('再次确认：清空后只保留 AI 设置（接口地址、模型配置等），小说内容将全部丢失。')) return;
        const idx = this.data.works.findIndex(x => x.id === w.id);
        if (idx < 0) return;
        // 保留作品 ID 与创建时间，其余内容重置
        this.data.works[idx] = Object.assign(this.createWorkData(), {
            id: w.id,
            novel: Object.assign(this.createWorkData().novel, {
                title: name, author: w.novel.author, genre: w.novel.genre,
                createdAt: w.novel.createdAt
            })
        });
        this.currentChapter = null;
        this.currentCharacter = null;
        this.saveData();
        this.renderAll();
        this.showNotification('《' + name + '》内容已清空（AI 设置已保留）', 'success');
        this.work.activities.unshift({ action: '清空作品内容', detail: name, time: Date.now() });
        this.saveData();
    }

    // ============ 多作品管理 ============

    /** 渲染侧边栏的作品列表框 */
    renderWorkSwitcher() {
        const select = document.getElementById('workSelect');
        if (!select) return;
        const works = this.data.works || [];
        const current = this.work;
        select.innerHTML = works.map(w => {
            const title = (w.novel && w.novel.title) || '未命名作品';
            const words = (w.chapters || []).reduce((s, c) => s + (c.content ? c.content.length : 0), 0);
            const label = title + (words ? '（' + words.toLocaleString() + ' 字）' : '');
            return '<option value="' + w.id + '"' + (w.id === current.id ? ' selected' : '') + '>' +
                this.escapeHtml(label) + '</option>';
        }).join('');
    }

    /** 切换作品 */
    switchWork(id) {
        if (!id || id === this.data.activeWorkId) return;
        if (this.dirty && this.currentChapter) this.saveChapter();
        this.data.activeWorkId = id;
        this.currentChapter = null;
        this.currentCharacter = null;
        this.setValue('chapterTitle', '');
        this.setValue('chapterContent', '');
        this.updateEditorWordCount();
        this.saveData();
        this.renderAll();
        const w = this.work;
        this.showNotification('已切换到《' + (w.novel.title || '未命名作品') + '》', 'success');
    }

    /** 打开新建作品弹窗 */
    openWorkModal() {
        const modal = document.getElementById('workModal');
        if (!modal) return;
        this.setValue('newWorkTitle', '');
        this.setValue('newWorkAuthor', '');
        this.setValue('newWorkGenre', 'fantasy');
        this.setValue('newWorkSynopsis', '');
        modal.classList.add('show');
        setTimeout(() => { const el = document.getElementById('newWorkTitle'); if (el) el.focus(); }, 50);
    }

    /** 创建新作品并切换过去 */
    createNewWork() {
        const title = document.getElementById('newWorkTitle')?.value.trim() || '';
        if (!title) {
            this.showNotification('请输入作品名称', 'warning');
            return;
        }
        const work = this.createWorkData({
            title: title,
            author: document.getElementById('newWorkAuthor')?.value.trim() || '',
            genre: document.getElementById('newWorkGenre')?.value || 'fantasy',
            synopsis: document.getElementById('newWorkSynopsis')?.value.trim() || ''
        });
        if (this.dirty && this.currentChapter) this.saveChapter();
        this.data.works.push(work);
        this.data.activeWorkId = work.id;
        this.currentChapter = null;
        this.setValue('chapterTitle', '');
        this.setValue('chapterContent', '');
        this.saveData();
        this.closeModal('workModal');
        this.renderAll();
        this.switchTab('chapters');
        this.showNotification('新作品《' + title + '》已创建', 'success');
    }

    /** 删除当前作品（整部小说的全部内容都会被删除；AI 设置为全局，不受影响） */
    deleteCurrentWork() {
        const works = this.data.works || [];
        const w = this.work;
        const name = w.novel.title || '未命名作品';
        const chapterCount = (w.chapters || []).length;
        const charCount = (w.characters || []).length;
        if (!confirm('确定要删除作品《' + name + '》吗？\n\n将同时删除该作品的 ' + chapterCount + ' 个章节、' + charCount + ' 个角色与全部设定，此操作不可恢复！\n（AI 服务配置会保留）')) return;
        if (!confirm('再次确认删除《' + name + '》？该操作不可恢复。')) return;

        const idx = works.findIndex(x => x.id === w.id);
        if (idx >= 0) works.splice(idx, 1);
        // 记录删除墓碑，确保删除能同步到共享文件（否则会被服务端并集还原）
        if (!Array.isArray(this.data.deletedWorkIds)) this.data.deletedWorkIds = [];
        if (this.data.deletedWorkIds.indexOf(w.id) === -1) this.data.deletedWorkIds.push(w.id);
        if (!this.data.works.length) {
            const fresh = this.createWorkData();
            this.data.works.push(fresh);
            this.data.activeWorkId = fresh.id;
        } else {
            this.data.activeWorkId = this.data.works[0].id;
        }
        this.currentChapter = null;
        this.currentCharacter = null;
        this.setValue('chapterTitle', '');
        this.setValue('chapterContent', '');
        this.saveData();
        this.renderAll();
        this.showNotification('作品《' + name + '》已删除', 'success');
    }

    /** 清除全部小说数据：删除所有作品（含章节/角色/设定），仅保留 AI 服务配置 */
    clearAllData() {
        if (!confirm('确定要清除全部小说数据吗？\n\n将删除所有作品（含全部章节、角色、世界观与设定），此操作不可恢复！')) return;
        if (!confirm('再次确认：所有小说数据将被永久删除，仅保留 AI 服务配置。')) return;
        // 把当前所有作品 id 记为删除墓碑，确保共享文件里的旧作品也被真正清除
        if (!Array.isArray(this.data.deletedWorkIds)) this.data.deletedWorkIds = [];
        (this.data.works || []).forEach(w => {
            if (w && w.id && this.data.deletedWorkIds.indexOf(w.id) === -1) this.data.deletedWorkIds.push(w.id);
        });
        const fresh = this.createWorkData();
        this.data.works = [fresh];
        this.data.activeWorkId = fresh.id;
        this.currentChapter = null;
        this.currentCharacter = null;
        this.setValue('chapterTitle', '');
        this.setValue('chapterContent', '');
        this.saveData();
        this.renderAll();
        this.showNotification('已清除全部小说数据（AI 设置保留）', 'success');
    }

    // ============ 工具方法 ============

    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('show');
    }

    renderAll() {
        this.renderWorkSwitcher();
        this.renderDashboard();
        this.renderCharacters();
        this.renderWorld();
        this.renderChapters();
        this.renderMemoryPreview();
        this.loadMemoryConfig();
        this.loadSettings();
        this.updateMemoryTags();
        this.renderModelProfiles();
    }

    startAutoSave() {
        if (this.autoSaveTimer) clearInterval(this.autoSaveTimer);
        const interval = (this.data.settings.autoSaveInterval || 30) * 1000;
        this.autoSaveTimer = setInterval(() => {
            if (this.currentChapter && this.dirty) this.saveChapter();
        }, interval);
    }

    showNotification(message, type) {
        type = type || 'info';
        const colors = { success: '#10b981', error: '#ef4444', warning: '#f59e0b', info: '#3b82f6' };
        const div = document.createElement('div');
        div.className = 'app-toast';
        div.style.cssText = 'position: fixed; top: 20px; right: 20px; padding: 12px 20px; background: ' +
            (colors[type] || colors.info) + '; color: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 9999; font-size: 14px; max-width: 360px;';
        div.textContent = message;
        document.body.appendChild(div);
        setTimeout(() => {
            div.style.opacity = '0';
            div.style.transition = 'opacity 0.3s';
            setTimeout(() => div.remove(), 300);
        }, 3000);
    }

    formatTime(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return Math.floor(diff/60000) + '分钟前';
        if (diff < 86400000) return Math.floor(diff/3600000) + '小时前';
        return (date.getMonth()+1) + '月' + date.getDate() + '日 ' + date.getHours() + ':' + String(date.getMinutes()).padStart(2,'0');
    }

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// 全局实例（同时挂到 window，便于调试与自动化测试）
const app = new NovelGenerator();
window.app = app;

// 点击模态框外部关闭
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.classList.remove('show');
    }
});

// 键盘快捷键
document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (app.currentChapter) app.saveChapter();
    }
    // Ctrl/Cmd + Enter：在文章末尾连续 AI 续写
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!document.querySelector('.modal.show')) app.quickContinue();
    }
    // Esc：退出专注模式
    if (e.key === 'Escape' && document.body.classList.contains('focus-mode')) {
        app.toggleFocusMode();
    }
});