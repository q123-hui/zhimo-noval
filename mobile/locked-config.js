/* ============================================================
 * 分享版 App 的唯一配置（用户看不到、也改不了）
 * ------------------------------------------------------------
 * App 只认这一个转发地址，接口地址与 API Key 全部放在转发服务端
 * （server/ai-proxy/），安装包里没有任何密钥，拆包也拿不到。
 *
 * 打包时用环境变量写入，不要手改：
 *     ZHIMO_ENDPOINT="https://你的域名/api/ai" ./scripts/build-app.sh
 * ============================================================ */
window.__ZHIMO_LOCK__ = {
    enabled: true,

    appName: '智墨小说',

    // 【打包时自动写入】唯一转发接口
    endpoint: '',

    // 仅用于界面文案与参数判断，真正的模型由服务端决定
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.5-flash',

    // 【打包时自动写入】当前安装包版本，用于和云端 update.json 比对
    versionCode: 0,
    versionName: '0.0.0'
};
