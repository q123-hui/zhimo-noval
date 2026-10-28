/* ============================================================
 * 分享版 App 的外壳（只加载在手机 App 包里）
 *  - 激活码门禁：没有有效激活码 → 全屏挡住，进不去
 *  - 激活码有效期由服务端判定，到期/停用后立刻退回门禁
 *  - 侧边栏变抽屉、顶部手机顶栏、返回键处理
 *  - 设置页 / AI 配置入口彻底移除
 * ============================================================ */
(function () {
    'use strict';

    var LOCK = window.__ZHIMO_LOCK__ || {};
    var LICENSE_KEY = 'zhimo_license_v1';

    function readLicense() {
        try { return (localStorage.getItem(LICENSE_KEY) || '').trim(); } catch (e) { return ''; }
    }
    function saveLicense(v) {
        try {
            if (v) localStorage.setItem(LICENSE_KEY, v);
            else localStorage.removeItem(LICENSE_KEY);
        } catch (e) { /* 隐私模式下可能失败，忽略 */ }
    }
    /**
     * 本机设备标识，用于「一个码绑了几台设备」。
     * 优先用原生桥给的 ANDROID_ID —— 卸载重装不变，用户不会因为重装被当成新手机；
     * 桥不可用（网页版/调试）时退回本地随机值。
     */
    function getDeviceId() {
        try {
            var native = window.ZhimoUpdater && window.ZhimoUpdater.deviceId
                ? window.ZhimoUpdater.deviceId() : '';
            if (native && /^[A-Za-z0-9_-]{6,64}$/.test(native)) return native;
        } catch (e) { /* 桥异常就走本地随机值 */ }

        var KEY = 'zhimo_device_id';
        var id = '';
        try { id = localStorage.getItem(KEY) || ''; } catch (e) { id = ''; }
        if (!id) {
            id = 'd' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-6);
            try { localStorage.setItem(KEY, id); } catch (e) { /* 隐私模式忽略 */ }
        }
        return id;
    }

    function activateUrl() {
        var ep = LOCK.endpoint || '';
        return ep ? ep.replace(/\/api\/ai\/?$/i, '/api/activate') : '';
    }

    /**
     * 带超时的 POST：手机网络不通时最多等 ms 毫秒。
     * 没有超时的话，网络被拦时 fetch 会一直挂着，界面就永远停在“验证中…”。
     */
    function postJson(url, payload, ms) {
        var opts = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        };
        var canAbort = (typeof AbortController !== 'undefined');
        var timer = null;
        if (canAbort) {
            var ac = new AbortController();
            opts.signal = ac.signal;
            timer = setTimeout(function () { try { ac.abort(); } catch (e) { /* ignore */ } }, ms || 15000);
        }
        return fetch(url, opts).then(function (res) {
            if (timer) clearTimeout(timer);
            return res.json().catch(function () { return {}; }).then(function (data) {
                return { ok: res.ok, status: res.status, data: data };
            });
        }, function (err) {
            if (timer) clearTimeout(timer);
            throw err;
        });
    }

    function netErrorMessage(err) {
        var aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
        if (aborted) {
            return '请求超时：手机连不上验证服务。请换 WiFi / 流量再试，或联系卖家';
        }
        return '网络连接失败，请检查手机网络后重试';
    }

    function ready(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
        else fn();
    }

    function removeSettingsEntrances() {
        var nav = document.querySelector('.nav-item[data-tab="settings"]');
        if (nav && nav.parentNode) nav.parentNode.removeChild(nav);
        var section = document.getElementById('settings');
        if (section && section.parentNode) section.parentNode.removeChild(section);
    }

    // ---------------- 激活门禁 ----------------
    var gate, gateInput, gateBtn, gateMsg, topSub, topTitleEl;
    var licenseDays = null;

    /**
     * 服务端返回的额度信息（今日用量 / 设备占用），只用于「激活设置」面板展示。
     * 存本地是为了断网时也能看到上次的快照，真正的判定永远在服务端。
     */
    var INFO_KEY = 'zhimo_license_info_v1';

    function saveInfo(d) {
        if (!d) return;
        var info = {
            daysLeft: typeof d.daysLeft === 'number' ? d.daysLeft : 0,
            dailyQuota: d.dailyQuota || 0,
            todayUsed: d.todayUsed || 0,
            deviceCount: d.deviceCount || 0,
            maxDevices: d.maxDevices || 0
        };
        try { localStorage.setItem(INFO_KEY, JSON.stringify(info)); } catch (e) { /* ignore */ }
    }

    function readInfo() {
        try { return JSON.parse(localStorage.getItem(INFO_KEY) || 'null') || {}; } catch (e) { return {}; }
    }

    function clearInfo() {
        try { localStorage.removeItem(INFO_KEY); } catch (e) { /* ignore */ }
    }

    /** 激活 / 心跳校验成功：记下额度快照并放行 */
    function applyActivation(d) {
        saveInfo(d);
        hideGate(d && typeof d.daysLeft === 'number' ? d.daysLeft : undefined);
    }

    var TAB_TITLES = { dashboard: '工作台', chapters: '章节创作', worldbook: '作品设定' };

    /** 顶栏标题跟着当前页走（保留「剩余 N 天」副标题） */
    function updateTopTitle(tab) {
        var name = TAB_TITLES[tab];
        if (!name || !topTitleEl) return;
        var keepSub = topSub && topSub.style.display !== 'none' && topSub.textContent;
        topTitleEl.innerHTML = name +
            (keepSub
                ? '<span class="mt-sub" id="mtSub">' + topSub.textContent + '</span>'
                : '<span class="mt-sub" id="mtSub" style="display:none"></span>');
        topSub = topTitleEl.querySelector('#mtSub');
    }

    function setGateMsg(text, kind) {
        if (!gateMsg) return;
        gateMsg.textContent = text || '';
        gateMsg.className = 'gate-msg' + (kind ? ' gate-' + kind : '');
    }

    function showGate(message) {
        if (!gate) return;
        gate.style.display = 'flex';
        setGateMsg(message || '', message ? 'warn' : '');
        if (gateInput) {
            try { gateInput.value = readLicense(); } catch (e) {}
            setTimeout(function () { try { gateInput.focus(); } catch (e) {} }, 200);
        }
    }

    function hideGate(daysLeft) {
        if (gate) gate.style.display = 'none';
        if (typeof daysLeft === 'number') licenseDays = daysLeft;
        if (topSub) {
            var hasDays = (typeof daysLeft === 'number' && daysLeft > 0);
            topSub.textContent = hasDays ? '剩余 ' + daysLeft + ' 天' : '';
            topSub.style.display = hasDays ? '' : 'none';
        }
    }

    function buildGate() {
        gate = document.createElement('div');
        gate.id = 'zhimoGate';
        gate.className = 'zhimo-gate';
        gate.innerHTML =
            '<div class="gate-card">' +
                '<div class="gate-logo">📖</div>' +
                '<h1>智墨小说</h1>' +
                '<p class="gate-sub">请输入激活码后开始使用</p>' +
                '<input id="gateInput" class="gate-input" type="text" inputmode="text" autocomplete="off" ' +
                    'autocapitalize="characters" spellcheck="false" placeholder="ZM-XXXX-XXXX-XXXX">' +
                '<button id="gateBtn" class="gate-btn">激 活</button>' +
                '<div id="gateMsg" class="gate-msg"></div>' +
                '<div class="gate-foot">激活码由卖家提供 · 到期请联系卖家续期</div>' +
            '</div>';
        document.body.appendChild(gate);
        gateInput = gate.querySelector('#gateInput');
        gateBtn = gate.querySelector('#gateBtn');
        gateMsg = gate.querySelector('#gateMsg');

        gateBtn.addEventListener('click', activate);
        gateInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') activate();
        });
    }

    function activate() {
        var code = (gateInput && gateInput.value || '').trim().toUpperCase().replace(/\s+/g, '');
        if (!code) { setGateMsg('请先输入激活码', 'warn'); return; }
        var url = activateUrl();
        if (!url) { setGateMsg('服务尚未配置，请联系卖家', 'warn'); return; }

        gateBtn.disabled = true;
        gateBtn.textContent = '验证中…';
        setGateMsg('', '');

        postJson(url, { license: code, device: getDeviceId() }, 15000).then(function (r) {
            var d = r.data || {};
            if (r.ok && d.ok) {
                saveLicense(code);
                applyActivation(d);
                setGateMsg('', '');
            } else {
                var msg = (d.error && d.error.message) || '激活失败，请检查激活码';
                setGateMsg(msg, 'warn');
                saveLicense('');
            }
        }).catch(function (err) {
            setGateMsg(netErrorMessage(err), 'warn');
        }).then(function () {
            gateBtn.disabled = false;
            gateBtn.textContent = '激 活';
        });
    }

    /** 静默复核：启动时确认激活码还有效（服务端为准） */
    function verifySilently() {
        var code = readLicense();
        var url = activateUrl();
        if (!code) { showGate(''); return; }
        if (!url) { showGate('服务尚未配置，请联系卖家'); return; }

        postJson(url, { license: code, device: getDeviceId() }, 12000).then(function (r) {
            var d = r.data || {};
            if (r.ok && d.ok) applyActivation(d);
            else {
                var msg = (d.error && d.error.message) || '激活码已失效';
                saveLicense('');
                showGate(msg);
            }
        }).catch(function () {
            // 网络不通时先放行（服务端仍会拦截生成），避免断网进不去
            hideGate();
        });
    }

    /**
     * 运行期巡更：激活码随时可能被停用/到期，只在启动时校验一次的话，
     * 用户不重启 App 就能一直用下去。这里每 60 秒、以及每次切回前台各复核一次；
     * 只有服务端明确回 401/403 才踢人，断网抖动不打断写作。
     */
    function pollLicense() {
        var code = readLicense();
        var url = activateUrl();
        if (!code || !url) return;

        postJson(url, { license: code, device: getDeviceId() }, 12000).then(function (r) {
            var d = r.data || {};
            if (r.ok && d.ok) { applyActivation(d); return; }
            if (r.status === 401 || r.status === 403) {
                var msg = (d.error && d.error.message) || '激活码已失效，请重新输入';
                var code2 = d.error && d.error.code;
                // 设备超限不是「码坏了」，本机保留激活码，用户解绑后重开 App 就能继续
                if (code2 !== 'LICENSE_DEVICE_LIMIT') saveLicense('');
                showGate(msg);
            }
        }).catch(function () { /* 网络不通先放行，下一轮再校验 */ });
    }

    function startLicenseWatch() {
        setInterval(pollLicense, 60000);
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') setTimeout(pollLicense, 600);
        });
    }

    // 生成过程中服务端判定失效：立刻退回门禁
    window.__zhimoLicenseFail = function (message) {
        saveLicense('');
        showGate(message || '激活码已失效，请重新输入');
    };


    // ---------------- 激活设置面板（查看 / 更换 / 退出激活） ----------------
    function maskCode(code) {
        var s = String(code || '');
        if (!s) return '—';
        if (s.length <= 9) return s;
        return s.slice(0, 5) + '****' + s.slice(-4);
    }

    function refreshLicenseSheet() {
        var code = readLicense();
        var cur = document.getElementById('licenseCurrent');
        if (cur) cur.textContent = maskCode(code);

        var st = document.getElementById('licenseStatus');
        if (st) {
            if (!code) st.textContent = '未激活';
            else if (typeof licenseDays === 'number' && licenseDays > 0) st.textContent = '有效 · 剩余 ' + licenseDays + ' 天';
            else st.textContent = '有效';
        }
        var ver = document.getElementById('licenseVersion');
        if (ver) ver.textContent = (LOCK.versionName || '—') + (LOCK.versionCode ? '（' + LOCK.versionCode + '）' : '');

        // 今日用量 / 绑定设备：只有服务端设了上限才需要让用户看见，没上限就不占地方
        var info = readInfo();
        var use = document.getElementById('licenseUsage');
        if (use) {
            if (!code) use.textContent = '—';
            else if (info.dailyQuota > 0) use.textContent = (info.todayUsed || 0) + ' / ' + info.dailyQuota + ' 次';
            else use.textContent = (info.todayUsed || 0) + ' 次（不限）';
        }
        var dev = document.getElementById('licenseDevice');
        if (dev) {
            if (!code) dev.textContent = '—';
            else if (info.maxDevices > 0) dev.textContent = (info.deviceCount || 0) + ' / ' + info.maxDevices + ' 台';
            else dev.textContent = (info.deviceCount || 0) + ' 台（不限）';
        }

        var input = document.getElementById('licenseInput');
        if (input) input.value = '';
        var msg = document.getElementById('licenseMsg');
        if (msg) { msg.textContent = ''; msg.className = 'license-msg'; }
    }

    function openLicenseSheet() {
        refreshLicenseSheet();
        var sheet = document.getElementById('licenseSheet');
        if (sheet) sheet.classList.add('show');
        if (window.__closeDrawer) window.__closeDrawer();
    }

    function closeLicenseSheet() {
        var sheet = document.getElementById('licenseSheet');
        if (sheet) sheet.classList.remove('show');
    }

    function buildLicenseSheet() {
        if (document.getElementById('licenseSheet')) return;

        var sheet = document.createElement('div');
        sheet.id = 'licenseSheet';
        sheet.className = 'license-sheet';
        sheet.innerHTML =
            '<div class="license-panel">' +
                '<div class="license-head">' +
                    '<h3>激活设置</h3>' +
                    '<button class="license-x" id="licenseClose" aria-label="关闭">×</button>' +
                '</div>' +
                '<div class="license-body">' +
                    '<div class="license-row"><span>当前激活码</span><b id="licenseCurrent">—</b></div>' +
                    '<div class="license-row"><span>授权状态</span><b id="licenseStatus">—</b></div>' +
                    '<div class="license-row"><span>今日用量</span><b id="licenseUsage">—</b></div>' +
                    '<div class="license-row"><span>绑定设备</span><b id="licenseDevice">—</b></div>' +
                    '<div class="license-row"><span>App 版本</span><b id="licenseVersion">—</b></div>' +
                    '<div class="license-label">更换激活码</div>' +
                    '<input id="licenseInput" class="license-input" type="text" autocomplete="off" ' +
                        'autocapitalize="characters" spellcheck="false" placeholder="ZM-XXXX-XXXX-XXXX">' +
                    '<div id="licenseMsg" class="license-msg"></div>' +
                    '<button class="btn-primary license-btn" id="licenseSave">验证并更换</button>' +
                    '<button class="btn-secondary license-btn" id="licenseOut">退出激活</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(sheet);

        sheet.addEventListener('click', function (e) {
            if (e.target === sheet) closeLicenseSheet();
        });
        sheet.querySelector('#licenseClose').addEventListener('click', closeLicenseSheet);

        var input = sheet.querySelector('#licenseInput');
        var msg = sheet.querySelector('#licenseMsg');

        function say(text, kind) {
            msg.textContent = text || '';
            msg.className = 'license-msg' + (kind ? ' license-' + kind : '');
        }

        function doChange() {
            var code = (input.value || '').trim().toUpperCase().replace(/\s+/g, '');
            if (!code) { say('请输入激活码', 'warn'); return; }
            var url = activateUrl();
            if (!url) { say('服务尚未配置，请联系卖家', 'warn'); return; }

            var btn = sheet.querySelector('#licenseSave');
            btn.disabled = true;
            btn.textContent = '验证中…';
            say('', '');

            postJson(url, { license: code, device: getDeviceId() }, 15000).then(function (r) {
                var d = r.data || {};
                if (r.ok && d.ok) {
                    saveLicense(code);
                    applyActivation(d);
                    refreshLicenseSheet();
                    say('已更换并生效', 'ok');
                } else {
                    say((d.error && d.error.message) || '激活码无效，请检查后重试', 'warn');
                }
            }).catch(function (err) {
                say(netErrorMessage(err), 'warn');
            }).then(function () {
                btn.disabled = false;
                btn.textContent = '验证并更换';
            });
        }

        sheet.querySelector('#licenseSave').addEventListener('click', doChange);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doChange(); });

        sheet.querySelector('#licenseOut').addEventListener('click', function () {
            if (!window.confirm('退出后需要重新输入激活码才能继续使用，确定吗？')) return;
            saveLicense('');
            clearInfo();
            licenseDays = null;
            closeLicenseSheet();
            showGate('已退出激活，请重新输入激活码');
        });
    }

    // ---------------- 关于与说明 ----------------
    /**
     * 合规上必须有这一页：
     *   · 用户数据会被发给第三方 AI 处理，必须告知（未告知即处理是硬伤）
     *   · 服务商协议要求对「使用了第三方 AI 服务」做真实说明（不写具体服务商与型号）
     *   · AI 生成内容可能有误，需要免责提示
     */
    function buildAboutSheet() {
        if (document.getElementById('aboutSheet')) return;

        var sheet = document.createElement('div');
        sheet.id = 'aboutSheet';
        sheet.className = 'license-sheet';
        sheet.innerHTML =
            '<div class="license-panel">' +
                '<div class="license-head">' +
                    '<h3>关于与说明</h3>' +
                    '<button class="license-x" id="aboutClose" aria-label="关闭">×</button>' +
                '</div>' +
                '<div class="license-body about-body">' +
                    '<div class="license-row"><span>应用名称</span><b>智墨小说</b></div>' +
                    '<div class="license-row"><span>当前版本</span><b id="aboutVersion">—</b></div>' +
                    '<div class="license-label">数据说明</div>' +
                    '<p class="about-p">你填写的正文、章节要点与设定会发送到第三方 AI 服务用于生成内容，' +
                        '生成结果只保存在本机，不会用于模型训练或对外公开。本应用不收集通讯录、短信、位置等信息，' +
                        '仅在本地保存激活码与本机设备标识，用于授权校验。</p>' +
                    '<div class="license-label">服务说明</div>' +
                    '<p class="about-p">文本生成能力由第三方 AI 服务提供，经本应用服务端转发调用，' +
                        '安装包内不含任何密钥。生成内容可能存在事实错误或与设定不符，请自行校对后再使用。</p>' +
                    '<div class="license-label">授权说明</div>' +
                    '<p class="about-p">一码一设备，换手机需先联系卖家解绑；到期后生成功能停用，续期请联系卖家。</p>' +
                    '<div class="license-label">免责声明</div>' +
                    '<p class="about-p">1. 本软件为写作辅助工具，生成内容由人工智能自动产生，可能存在事实错误、' +
                        '逻辑矛盾或与设定不符之处。请在使用前自行审核，因采用生成内容所产生的一切后果由使用者自行承担。</p>' +
                    '<p class="about-p">2. 生成内容的著作权归属，以及是否符合各内容平台的发布规则，' +
                        '请使用者自行判断并承担相应责任。本软件不对发布后产生的收益、处罚、下架等结果负责。</p>' +
                    '<p class="about-p">3. 不得利用本软件生成违法违规、侵犯他人权益或危害公共利益的内容。' +
                        '如有违反，本软件有权立即停用该授权且不予退款，相关法律责任由使用者自负。</p>' +
                    '<p class="about-p">4. 生成能力依赖第三方服务与网络，可能因服务商调整、网络异常等原因中断或延迟，' +
                        '本软件不承担由此产生的间接损失。</p>' +
                    '<p class="about-p">5. 正文保存在本机，请自行备份。卸载、清除数据、更换设备或系统故障' +
                        '导致的内容丢失，本软件不承担恢复义务。</p>' +
                    '<p class="about-p">6. 本软件由个人独立开发，与任何内容平台、应用商店、AI 服务商' +
                        '均无隶属或合作关系。在法律允许的范围内，赔偿责任以使用者实际支付的费用为限。</p>' +
                    '<button class="btn-secondary license-btn" id="aboutOk">我知道了</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(sheet);

        sheet.addEventListener('click', function (e) {
            if (e.target === sheet) closeAboutSheet();
        });
        sheet.querySelector('#aboutClose').addEventListener('click', closeAboutSheet);
        sheet.querySelector('#aboutOk').addEventListener('click', closeAboutSheet);
    }

    function openAboutSheet() {
        buildAboutSheet();
        var v = document.getElementById('aboutVersion');
        if (v) {
            v.textContent = (LOCK.versionName || '—') +
                (LOCK.versionCode ? '（' + LOCK.versionCode + '）' : '');
        }
        document.getElementById('aboutSheet').classList.add('show');
    }

    function closeAboutSheet() {
        var s = document.getElementById('aboutSheet');
        if (s) s.classList.remove('show');
    }

    // ---------------- 手机外壳 ----------------
    function buildShell() {
        var sidebar = document.querySelector('.sidebar');
        if (!sidebar) return;

        var mask = document.createElement('div');
        mask.className = 'sidebar-mask';
        document.body.appendChild(mask);

        var bar = document.createElement('header');
        bar.className = 'mobile-topbar';
        bar.innerHTML =
            '<button class="mt-btn" id="mtMenu" aria-label="打开菜单">☰</button>' +
            '<div class="mt-title" id="mtTitle">' + (LOCK.appName || '智墨小说') +
            '<span class="mt-sub" id="mtSub" style="display:none"></span></div>';
        document.body.appendChild(bar);
        topSub = bar.querySelector('#mtSub');

        var titleEl = bar.querySelector('#mtTitle');
        topTitleEl = titleEl;

        function openDrawer() {
            sidebar.classList.add('open');
            mask.classList.add('show');
        }
        function closeDrawer() {
            sidebar.classList.remove('open');
            mask.classList.remove('show');
        }
        function isOpen() { return sidebar.classList.contains('open'); }

        var btn = bar.querySelector('#mtMenu');
        if (btn) btn.addEventListener('click', function () {
            if (isOpen()) closeDrawer(); else openDrawer();
        });
        mask.addEventListener('click', closeDrawer);

        sidebar.addEventListener('click', function (e) {
            var item = e.target.closest ? e.target.closest('.nav-item') : null;
            if (!item) return;
            closeDrawer();
            updateTopTitle(item.dataset.tab);
            setActiveNav(item.dataset.tab);
        });

        window.__closeDrawer = closeDrawer;
        window.__openDrawer = openDrawer;

        window.handleAndroidBack = function () {
            if (gate && gate.style.display !== 'none') return true; // 门禁上按返回不退出，避免误触
            if (isOpen()) { closeDrawer(); return true; }
            var modal = document.querySelector('.modal.show');
            if (modal) { modal.classList.remove('show'); return true; }
            return false;
        };
    }

    // ---------------- 章节列表：改成下拉框放在章节创作页 ----------------
    /**
     * 章节原来是一整块列表卡片，手机上太占地方：
     * 列表 DOM 收进隐藏容器（app.renderChapters 还要用），
     * 界面上换成「当前章节」下拉框；上下文记忆卡片留在工作台。
     */
    function relocateChapterList() {
        var dashboard = document.getElementById('dashboard');
        var grid = dashboard && dashboard.querySelector('.dashboard-grid');
        var sidebar = document.querySelector('.chapter-sidebar');
        if (!sidebar) return;

        var pool = document.getElementById('chapterListPool');
        if (!pool) {
            pool = document.createElement('div');
            pool.id = 'chapterListPool';
            pool.style.display = 'none';
            document.body.appendChild(pool);
        }

        var cards = sidebar.querySelectorAll('.card');
        for (var i = 0; i < cards.length; i++) {
            var card = cards[i];
            if (card.querySelector('#chapterList') || card.querySelector('.chapter-list-actions')) {
                pool.appendChild(card);          // 章节列表：只留数据，不再显示
            } else if (grid) {
                card.classList.add('dash-chapter-card');
                grid.appendChild(card);          // 上下文记忆：仍在工作台
            }
        }
        if (sidebar.parentNode) sidebar.parentNode.removeChild(sidebar);
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /** 章节创作页顶部：下拉框选章 + 章节数 */
    function buildChapterPicker() {
        var section = document.getElementById('chapters');
        var header = section && section.querySelector('.page-header');
        if (!section || !header || document.getElementById('chapterPickerWrap')) return;

        var wrap = document.createElement('div');
        wrap.id = 'chapterPickerWrap';
        wrap.className = 'chapter-picker';
        wrap.innerHTML =
            '<select id="chapterPicker" aria-label="选择章节"></select>' +
            '<span class="chapter-picker-count" id="chapterPickerCount"></span>';
        header.parentNode.insertBefore(wrap, header.nextSibling);

        var sel = wrap.querySelector('#chapterPicker');
        var count = wrap.querySelector('#chapterPickerCount');

        sel.addEventListener('change', function () {
            if (!sel.value) return;
            if (window.app && typeof window.app.loadChapter === 'function') window.app.loadChapter(sel.value);
        });

        /** 上次写过的那一章（updatedAt 最新），用于进页面时自动打开 */
        function latestChapter(app) {
            var chapters = (app && app.work && app.work.chapters) || [];
            var best = null;
            for (var i = 0; i < chapters.length; i++) {
                var c = chapters[i];
                if (!best || (c.updatedAt || 0) > (best.updatedAt || 0)) best = c;
            }
            return best;
        }

        function rebuild() {
            var app = window.app;
            var chapters = (app && app.work && app.work.chapters) || [];
            var list = chapters.slice().sort(function (a, b) { return (a.number || 0) - (b.number || 0); });

            if (!list.length) {
                sel.innerHTML = '<option value="">暂无章节，点右上角「新建章节」</option>';
                sel.disabled = true;
                if (count) count.textContent = '';
                return;
            }

            sel.disabled = false;
            sel.innerHTML = list.map(function (c) {
                var title = c.title || '未命名';
                return '<option value="' + escapeHtml(c.id) + '">第' + escapeHtml(c.number) + '章 · ' + escapeHtml(title) + '</option>';
            }).join('');
            if (count) count.textContent = list.length + ' 章';

            // 关键：下拉框只「显示」选中项并不会触发 change，
            // 所以这里必须真的把某一章载入编辑器，否则 currentChapter 为空，
            // 保存会静默失败、导出/复制/删除都会说「请先选择章节」。
            var cur = app.currentChapter;
            // 切换作品后，旧作品的章节还挂在 currentChapter 上，这里要作废
            if (cur && cur.id && !list.some(function (c) { return c.id === cur.id; })) cur = null;
            if (!cur || !cur.id) {
                var target = latestChapter(app);
                if (target && typeof app.loadChapter === 'function') {
                    app.loadChapter(target.id);
                    cur = app.currentChapter;
                }
            }
            if (cur && cur.id) sel.value = cur.id;
        }

        wrap.rebuildPicker = rebuild;
        rebuild();

        var listEl = document.getElementById('chapterList');
        if (listEl && typeof MutationObserver !== 'undefined') {
            new MutationObserver(rebuild).observe(listEl, { childList: true });
        }
    }

    /** 编辑器底栏只保留「字数」和「保存」 */
    function simplifyEditorFooter() {
        var actions = document.querySelector('.editor-footer .editor-actions');
        if (!actions) return;
        var buttons = actions.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
            if (buttons[i].textContent.indexOf('保存') === -1) {
                buttons[i].parentNode.removeChild(buttons[i]);
            }
        }
        actions.classList.add('editor-actions-simple');
    }

    /**
     * 工具条：B / I / 引号 / 破折 / 省略 这些符号按钮手机上没人点，
     * 换成复制本章、导出本章、删除本章这些真用得上的操作。
     */
    function rebuildEditorToolbar() {
        var bar = document.querySelector('.editor-toolbar');
        if (!bar || bar.querySelector('.toolbar-extra')) return;

        var buttons = bar.querySelectorAll('.toolbar-btn');
        for (var i = 0; i < buttons.length; i++) {
            var onclick = buttons[i].getAttribute('onclick') || '';
            if (onclick.indexOf('insertFormat') !== -1) {
                buttons[i].parentNode.removeChild(buttons[i]);
            }
        }
        var seps = bar.querySelectorAll('.separator');
        for (var j = 0; j < seps.length; j++) seps[j].parentNode.removeChild(seps[j]);

        var extra = document.createElement('div');
        extra.className = 'toolbar-extra';
        extra.innerHTML =
            '<button class="toolbar-btn btn-util" onclick="app.copyCurrentChapter()" title="复制本章正文到剪贴板">复制本章</button>' +
            '<button class="toolbar-btn btn-util" onclick="app.exportCurrentChapter()" title="导出本章为 txt">导出本章</button>' +
            '<button class="toolbar-btn btn-util btn-util-danger" onclick="app.deleteCurrentChapter()" title="删除本章（不可恢复）">删除本章</button>';
        bar.insertBefore(extra, bar.firstChild);
    }

    // ---------------- 底部导航（常用三个入口 + 更多） ----------------
    function setActiveNav(tab) {
        var items = document.querySelectorAll('#mBottomNav .m-nav-item');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.toggle('active', items[i].getAttribute('data-tab') === tab);
        }
    }

    /**
     * 页面切换时同步底部导航高亮与顶栏标题。
     * 工作台上的「新建章节」、抽屉、导入后跳转等走的都是 app.switchTab，
     * 不会经过底部导航自己，所以这里盯住 .tab-content 的 active 变化，谁的入口都算。
     */
    function watchTabChanges() {
        if (typeof MutationObserver === 'undefined') return;
        var sections = document.querySelectorAll('.tab-content');
        if (!sections.length) return;

        var sync = function () {
            var active = document.querySelector('.tab-content.active');
            if (!active || !active.id || active.id === 'settings') return;
            setActiveNav(active.id);
            updateTopTitle(active.id);
            document.body.classList.toggle('on-chapters', active.id === 'chapters');
            // 章节列表挂在工作台上，切回来时重绘一次，避免显示上次的旧列表
            if (active.id === 'dashboard' && window.app && typeof window.app.renderChapters === 'function') {
                try { window.app.renderChapters(); } catch (e) { /* 渲染失败不影响切换 */ }
            }
            // 进章节页时把下拉框同步到当前正在写的这一章
            if (active.id === 'chapters') {
                var picker = document.getElementById('chapterPickerWrap');
                if (picker && picker.rebuildPicker) picker.rebuildPicker();
            }
        };

        var obs = new MutationObserver(sync);
        for (var i = 0; i < sections.length; i++) {
            obs.observe(sections[i], { attributes: true, attributeFilter: ['class'] });
        }
    }

    /** 底部导航实际高度写进 CSS 变量，编辑底栏才能严丝合缝贴在它上面 */
    function syncFooterOffset() {
        var nav = document.getElementById('mBottomNav');
        if (!nav) return;
        document.documentElement.style.setProperty('--m-nav-h', nav.offsetHeight + 'px');
    }

    /** 抽屉里加一个「激活与版本」入口 */
    function buildSettingsEntry() {
        var menu = document.querySelector('.sidebar .nav-menu');
        if (!menu || document.getElementById('navLicenseSettings')) return;

        var btn = document.createElement('button');
        btn.id = 'navLicenseSettings';
        btn.type = 'button';
        btn.className = 'nav-setting';
        btn.textContent = '激活与版本';
        menu.appendChild(btn);
        btn.addEventListener('click', openLicenseSheet);

        // 合规页：数据说明 / 模型说明 / 授权说明
        var about = document.createElement('button');
        about.id = 'navAbout';
        about.type = 'button';
        about.className = 'nav-setting';
        about.textContent = '关于与说明';
        menu.appendChild(about);
        about.addEventListener('click', openAboutSheet);
    }

    function buildBottomNav() {
        if (document.getElementById('mBottomNav')) return;
        var nav = document.createElement('nav');
        nav.id = 'mBottomNav';
        nav.className = 'm-bottom-nav';
        nav.innerHTML =
            '<button class="m-nav-item active" data-tab="dashboard"><span>工作台</span></button>' +
            '<button class="m-nav-item" data-tab="chapters"><span>章节</span></button>' +
            '<button class="m-nav-item" data-tab="worldbook"><span>设定</span></button>';
        document.body.appendChild(nav);
        watchTabChanges();

        nav.addEventListener('click', function (e) {
            var btn = e.target.closest ? e.target.closest('.m-nav-item') : null;
            if (!btn) return;
            var tab = btn.getAttribute('data-tab');
            if (window.app && typeof window.app.switchTab === 'function') window.app.switchTab(tab);
            setActiveNav(tab);
        });

        var sidebar = document.querySelector('.sidebar');
        if (sidebar) {
            sidebar.addEventListener('click', function (e) {
                var item = e.target.closest ? e.target.closest('.nav-item') : null;
                if (item && item.getAttribute('data-tab')) setActiveNav(item.getAttribute('data-tab'));
            });
        }

        syncFooterOffset();
        setTimeout(syncFooterOffset, 300);
        window.addEventListener('resize', syncFooterOffset);
        window.addEventListener('orientationchange', function () { setTimeout(syncFooterOffset, 250); });
    }

    ready(function () {
        removeSettingsEntrances();
        buildShell();
        buildGate();
        buildLicenseSheet();
        relocateChapterList();
        buildChapterPicker();
        simplifyEditorFooter();
        rebuildEditorToolbar();
        buildSettingsEntry();
        buildBottomNav();
        verifySilently();
        startLicenseWatch();
    });
})();
