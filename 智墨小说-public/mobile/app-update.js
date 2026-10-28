/* ============================================================
 * 在线升级（只在 App 内生效，网页版不执行）
 *
 * 流程：
 *   启动 → 拉 {中转地址}/update.json → 比对 versionCode
 *   有新版本 → 底部提示条 → 点「立即升级」
 *     原生：window.ZhimoUpdater.install(url, file) 下载并拉起安装器
 *     兜底：浏览器直接打开 APK 下载
 *
 * update.json 由「发布更新.command」自动生成并上传，不需要手写。
 * ============================================================ */
(function () {
    'use strict';

    var LOCK = window.__ZHIMO_LOCK__ || {};
    if (!LOCK.endpoint) return;

    // 只在 App 壳里跑（网页版没有安装器，跳过）
    var isApp = !!window.ZhimoUpdater ||
        !!(window.Capacitor && (typeof window.Capacitor.isNativePlatform !== 'function' || window.Capacitor.isNativePlatform()));
    if (!isApp) return;

    var BASE = String(LOCK.endpoint).replace(/\/api\/ai\/?$/i, '');
    var UPDATE_URL = BASE + '/update.json';
    var myCode = parseInt(LOCK.versionCode, 10) || 0;
    var bar = null;
    var checking = false;
    var goBtnEl = null;      // 用于失败时把按钮恢复成「立即升级」
    var laterBtnEl = null;
    var watchdog = null;     // 下载一直没动静时兜底恢复按钮

    function el(tag, style, text) {
        var n = document.createElement(tag);
        if (style) n.style.cssText = style;
        if (text) n.textContent = text;
        return n;
    }

    function setMsg(text) {
        var m = bar && bar.querySelector('[data-role="msg"]');
        if (m) m.textContent = text;
    }

    function buildBar(info) {
        if (bar) return bar;
        bar = el('div', [
            'position:fixed', 'left:12px', 'right:12px', 'bottom:16px', 'z-index:2147483000',
            'background:#1f2937', 'color:#fff', 'border-radius:14px', 'padding:14px 16px',
            'box-shadow:0 10px 30px rgba(0,0,0,.35)', 'font-size:14px', 'line-height:1.5',
            'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif'
        ].join(';'));
        bar.setAttribute('data-role', 'update-bar');

        var title = el('div', 'font-weight:600;margin-bottom:4px;', '发现新版本 v' + info.versionName);
        title.setAttribute('data-role', 'title');

        var msg = el('div', 'opacity:.85;margin-bottom:10px;white-space:pre-wrap;',
            (info.notes ? info.notes + '\n' : '') + '大小约 ' + Math.round((info.size || 0) / 1048576 * 10) / 10 + ' MB');
        msg.setAttribute('data-role', 'msg');

        var row = el('div', 'display:flex;gap:10px;');
        var go = el('button', [
            'flex:1', 'border:0', 'border-radius:10px', 'padding:10px 0', 'font-size:15px',
            'font-weight:600', 'color:#111827', 'background:#34d399'
        ].join(';'), '立即升级');
        var later = el('button', [
            'flex:0 0 90px', 'border:1px solid rgba(255,255,255,.35)', 'border-radius:10px',
            'padding:10px 0', 'font-size:15px', 'color:#fff', 'background:transparent'
        ].join(';'), '以后再说');

        goBtnEl = go;
        laterBtnEl = later;

        go.onclick = function () { startUpgrade(info, go, later); };
        later.onclick = function () { bar.parentNode && bar.parentNode.removeChild(bar); bar = null; };

        row.appendChild(go);
        row.appendChild(later);
        bar.appendChild(title);
        bar.appendChild(msg);
        bar.appendChild(row);
        document.body.appendChild(bar);
        return bar;
    }

    /** 把按钮切回可点击状态（下载失败时用） */
    function resetButton() {
        if (!goBtnEl) return;
        goBtnEl.disabled = false;
        goBtnEl.textContent = '立即升级';
        goBtnEl.style.opacity = '1';
        if (laterBtnEl) laterBtnEl.style.display = '';
    }

    function startUpgrade(info, goBtn, laterBtn) {
        goBtn.disabled = true;
        // 点下去就地反馈：按钮变「正在升级」，避免用户以为没反应又连点
        goBtn.textContent = '正在升级';
        goBtn.style.opacity = '0.75';
        laterBtn.style.display = 'none';
        setMsg('正在下载新版本…');

        // 兜底：3 分钟还没走到安装那一步，就把按钮放开让用户重试，
        // 免得网络卡住时按钮永远停在「正在升级」。
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(function () {
            if (!goBtnEl || goBtnEl.textContent !== '正在升级') return;
            setMsg('下载好像卡住了，可以点按钮重试，或到通知栏看看下载进度');
            resetButton();
        }, 180000);

        if (window.ZhimoUpdater && window.ZhimoUpdater.install) {
            var fileName = 'zhimo-novel-' + (info.versionName || 'new') + '.apk';
            try {
                window.ZhimoUpdater.install(info.url, fileName);
            } catch (e) {
                setMsg('调用系统下载失败，已改用浏览器下载');
                window.open(info.url, '_blank');
            }
        } else {
            setMsg('已开始下载，请在通知栏点击安装');
            window.open(info.url, '_blank');
        }
    }

    // 原生回传状态
    window.__zhimoUpdateEvent = function (state, message) {
        if (!bar) return;
        if (state === 'downloading') setMsg('正在下载新版本…');
        else if (state === 'installing') {
            if (watchdog) clearTimeout(watchdog);
            setMsg('下载完成，正在打开安装界面…');
            if (goBtnEl) goBtnEl.textContent = '已下载';
        } else if (state === 'error') {
            if (watchdog) clearTimeout(watchdog);
            setMsg(message || '升级失败，请稍后重试');
            resetButton();   // 失败要能重试，别把按钮卡在「正在升级」
        }
    };

    function check() {
        if (checking) return;
        checking = true;

        var opts = { cache: 'no-store' };
        var timer = null;
        if (typeof AbortController !== 'undefined') {
            var ac = new AbortController();
            opts.signal = ac.signal;
            timer = setTimeout(function () { try { ac.abort(); } catch (e) { } }, 8000);
        }

        fetch(UPDATE_URL, opts).then(function (res) {
            if (timer) clearTimeout(timer);
            if (!res.ok) return null;
            return res.json();
        }).then(function (data) {
            checking = false;
            if (!data || !data.versionCode || !data.url) return;
            if (parseInt(data.versionCode, 10) <= myCode) return;
            buildBar(data);
        }).catch(function () {
            checking = false;
        });
    }

    function boot() {
        setTimeout(check, 3000);
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible' && !bar) setTimeout(check, 800);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
