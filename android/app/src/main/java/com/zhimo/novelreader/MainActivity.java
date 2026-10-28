package com.zhimo.novelreader;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.provider.MediaStore;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.content.FileProvider;

import com.getcapacitor.BridgeActivity;

import java.io.File;

/**
 * 分享版 App：
 *  1. 把安卓返回键交给网页层的「单步返回」逻辑（window.handleAndroidBack）
 *  2. 提供 window.ZhimoUpdater 桥，让网页触发「下载新 APK 并拉起系统安装器」
 *     —— 这样发新版只需要在云端放一个 APK，用户不用手动重装
 */
public class MainActivity extends BridgeActivity {

    private long downloadId = -1L;
    private String pendingApkPath = null;
    private DownloadReceiver receiver = null;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleBackViaJs();
            }
        });

        WebView wv = (getBridge() != null) ? getBridge().getWebView() : null;
        if (wv != null) {
            wv.addJavascriptInterface(new UpdaterBridge(), "ZhimoUpdater");
            wv.addJavascriptInterface(new FilesBridge(), "ZhimoFiles");
        }

        receiver = new DownloadReceiver();
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(receiver, filter);
        }
    }

    @Override
    public void onDestroy() {
        if (receiver != null) {
            try {
                unregisterReceiver(receiver);
            } catch (Exception ignored) {
            }
            receiver = null;
        }
        super.onDestroy();
    }

    // ---------------- 返回键 ----------------

    private void handleBackViaJs() {
        WebView wv = (getBridge() != null) ? getBridge().getWebView() : null;
        if (wv == null) {
            finish();
            return;
        }
        wv.evaluateJavascript(
                "(function(){try{return (window.handleAndroidBack&&window.handleAndroidBack())?'1':'0';}catch(e){return '0';}})()",
                value -> {
                    if (value == null || !value.contains("1")) finish();
                });
    }

    // ---------------- 导出到手机 ----------------

    /**
     * 网页里调 window.ZhimoFiles.save(文件名, 文本, mime)：
     * 直接写进「手机/Download/智墨小说/」，返回 "ok:路径" 或 "err:原因"。
     */
    public class FilesBridge {

        @JavascriptInterface
        public String save(String fileName, String content, String mime) {
            try {
                String name = safeName(fileName);
                byte[] data = (content == null ? "" : content).getBytes("UTF-8");
                String path;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    path = saveViaMediaStore(name, data, mime);
                } else {
                    path = saveLegacy(name, data);
                }
                return "ok:" + path;
            } catch (Exception e) {
                return "err:" + (e.getMessage() == null ? "保存失败" : e.getMessage());
            }
        }
    }

    private static String safeName(String fileName) {
        String n = (fileName == null || fileName.trim().isEmpty()) ? "智墨小说导出.txt" : fileName.trim();
        n = n.replace('/', '_').replace('\\', '_').replace(':', '_').replace("\n", " ");
        return n;
    }

    private String saveViaMediaStore(String name, byte[] data, String mime) throws Exception {
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE,
                (mime == null || mime.isEmpty()) ? "text/plain" : mime.split(";")[0]);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH,
                android.os.Environment.DIRECTORY_DOWNLOADS + "/智墨小说");
        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new Exception("无法创建下载文件");
        java.io.OutputStream os = getContentResolver().openOutputStream(uri);
        if (os == null) throw new Exception("无法写入下载文件");
        os.write(data);
        os.flush();
        os.close();
        return android.os.Environment.DIRECTORY_DOWNLOADS + "/智墨小说/" + name;
    }

    @SuppressWarnings("deprecation")
    private String saveLegacy(String name, byte[] data) throws Exception {
        File dir = new File(android.os.Environment.getExternalStoragePublicDirectory(
                android.os.Environment.DIRECTORY_DOWNLOADS), "智墨小说");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("无法创建目录");
        File out = new File(dir, name);
        java.io.FileOutputStream fos = new java.io.FileOutputStream(out);
        fos.write(data);
        fos.flush();
        fos.close();
        return out.getAbsolutePath();
    }

    // ---------------- 在线升级 ----------------

    /** 网页侧通过 window.ZhimoUpdater.* 调用 */
    public class UpdaterBridge {

        @JavascriptInterface
        public int currentVersionCode() {
            try {
                PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    return (int) pi.getLongVersionCode();
                }
                return pi.versionCode;
            } catch (Exception e) {
                return 0;
            }
        }

        @JavascriptInterface
        public String currentVersionName() {
            try {
                PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                return pi.versionName == null ? "" : pi.versionName;
            } catch (Exception e) {
                return "";
            }
        }

        /**
         * 稳定设备标识：ANDROID_ID 在同一台手机、同一签名、同一用户下，
         * 卸载重装都不会变，用它做「一码一机」绑定，
         * 用户重装 App 就不会被误判成新手机、把名额占死。
         */
        @JavascriptInterface
        public String deviceId() {
            try {
                String id = android.provider.Settings.Secure.getString(
                        getContentResolver(), android.provider.Settings.Secure.ANDROID_ID);
                if (id == null || id.length() < 8) return "";
                return "a" + id;
            } catch (Exception e) {
                return "";
            }
        }

        /** 开始下载并安装；fileName 可空（默认 update.apk） */
        @JavascriptInterface
        public void install(final String apkUrl, final String fileName) {
            runOnUiThread(() -> startDownload(apkUrl, fileName));
        }
    }

    private void startDownload(String apkUrl, String fileName) {
        try {
            File dir = new File(getExternalFilesDir(null), "update");
            if (!dir.exists() && !dir.mkdirs()) {
                notifyJs("error", "无法创建下载目录");
                return;
            }
            File[] olds = dir.listFiles();
            if (olds != null) {
                for (File f : olds) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
            }
            String name = (fileName == null || fileName.trim().isEmpty()) ? "update.apk" : fileName.trim();
            File out = new File(dir, name);
            pendingApkPath = out.getAbsolutePath();

            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                notifyJs("error", "系统下载服务不可用");
                return;
            }
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(apkUrl));
            req.setTitle("智墨小说 新版本");
            req.setDescription("正在下载更新…");
            req.setMimeType("application/vnd.android.package-archive");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationUri(Uri.fromFile(out));
            req.setAllowedOverMetered(true);
            req.setAllowedOverRoaming(true);

            downloadId = dm.enqueue(req);
            notifyJs("downloading", "");
        } catch (Exception e) {
            notifyJs("error", "下载失败：" + e.getMessage());
        }
    }

    private void installApk(String path) {
        try {
            File f = new File(path);
            if (!f.exists() || f.length() == 0) {
                notifyJs("error", "安装包下载不完整，请重试");
                return;
            }
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", f);
            Intent it = new Intent(Intent.ACTION_VIEW);
            it.setDataAndType(uri, "application/vnd.android.package-archive");
            it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(it);
            notifyJs("installing", "");
        } catch (Exception e) {
            notifyJs("error", "已下载完成，但无法拉起安装器（请在系统设置里允许安装未知应用）");
        }
    }

    /** 下载完成回调 */
    private class DownloadReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || !DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) return;
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
            if (id != downloadId) return;
            if (pendingApkPath == null) return;
            installApk(pendingApkPath);
        }
    }

    /** 把状态回传给网页（网页里实现 window.__zhimoUpdateEvent） */
    private void notifyJs(String state, String message) {
        WebView wv = (getBridge() != null) ? getBridge().getWebView() : null;
        if (wv == null) return;
        String js = "(function(){try{if(window.__zhimoUpdateEvent)window.__zhimoUpdateEvent(" +
                quote(state) + "," + quote(message == null ? "" : message) + ");}catch(e){}})()";
        wv.post(() -> wv.evaluateJavascript(js, null));
    }

    private static String quote(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ") + "\"";
    }
}
