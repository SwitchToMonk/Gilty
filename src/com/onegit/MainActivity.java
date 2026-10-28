package com.onegit;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;

public class MainActivity extends Activity {

    private WebView web;
    private static final String DEFAULT_URL = "file:///android_asset/www/index.html";
    private ValueCallback<Uri[]> filePathCb;
    private String pendingGhUrl = null;
    private static final int FILE_REQ = 77;
    private static final int FOLDER_REQ = 78;
    private static final int PICK_FILES_REQ = 79;
    private static final int ASSET_REQ = 80;
    private int folderJob = 0;

    /** One scanned upload job: picked file uris + their repo-relative paths + sizes. */
    private static class Scan {
        int job;
        final java.util.ArrayList<Uri> uris = new java.util.ArrayList<>();
        final java.util.ArrayList<String> paths = new java.util.ArrayList<>();
        final java.util.ArrayList<Long> sizes = new java.util.ArrayList<>();
    }
    private volatile Scan scan;
    private volatile String assetRepo, assetRelease;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        web.setBackgroundColor(Color.parseColor("#F2F2F2"));

        /* opening the app is the most reliable moment to refresh the home screen
           widgets - the network is certainly available here */
        try { WidgetData.refreshAll(this); } catch (Throwable ignored) { }

        // Lets the web UI restyle the Android status/navigation bars per theme
        web.addJavascriptInterface(new Native(), "OneGit");
        /* A link straight to a file (or window.location = a file URL) makes the
           web view do nothing at all - no save, no error - while the page has
           already said it downloaded. Handing those to the same download path
           the rest of the app uses means they actually land. */
        web.setDownloadListener(new android.webkit.DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                try {
                    String name = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType);
                    new Native().download(url, name);
                } catch (Throwable ignored) {
                }
            }
        });
        // Enables JS dialogs (confirm for actions like fork) and the device file
        // picker (used for uploading files to repos and release assets)
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (filePathCb != null) filePathCb.onReceiveValue(null);
                filePathCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(i, "Select files"), FILE_REQ);
                } catch (Exception e) {
                    filePathCb = null;
                    return false;
                }
                return true;
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String u) {
                if (pendingGhUrl != null && u != null && u.startsWith("file://")) {
                    final String link = pendingGhUrl;
                    pendingGhUrl = null;
                    v.evaluateJavascript("window.openGithubUrl && window.openGithubUrl('" + link.replace("\\", "\\\\").replace("'", "\\'") + "')", null);
                }
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    // External web links (github.com pages, token creation, etc.)
                    // open in the browser; the app itself stays on file:// pages.
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, u));
                    } catch (Exception ignored) {
                    }
                    return true;
                }
                return false;
            }
        });

        setContentView(web);

        // Android 13+ requires the runtime notification permission for upload notifications
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1);
            } catch (Throwable ignored) { }
        }

        String gh = ghLinkFromIntent(getIntent());
        if (gh != null) pendingGhUrl = gh;
        String url = getIntent() != null ? getIntent().getStringExtra("url") : null;
        web.loadUrl(url != null ? url : DEFAULT_URL);
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        if (web != null && i != null) {
            String url = i.getStringExtra("url");
            if (url != null) { web.loadUrl(url); return; }
            String gh = ghLinkFromIntent(i);
            if (gh != null) {
                web.evaluateJavascript("window.openGithubUrl && window.openGithubUrl('" + gh.replace("\\", "\\\\").replace("'", "\\'") + "')", null);
            }
        }
    }

    private static String ghLinkFromIntent(Intent i) {
        try {
            if (i == null || i.getData() == null) return null;
            Uri u = i.getData();
            String s = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
            if (!s.equals("http") && !s.equals("https")) return null;
            String h = u.getHost() == null ? "" : u.getHost().toLowerCase();
            if (h.equals("github.com") || h.equals("www.github.com") || h.equals("m.github.com") || h.equals("gist.github.com"))
                return u.toString();
        } catch (Exception ignored) { }
        return null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_REQ) {
            if (filePathCb == null) return;
            java.util.ArrayList<Uri> files = new java.util.ArrayList<>();
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                        files.add(data.getClipData().getItemAt(i).getUri());
                    }
                } else if (data.getData() != null) {
                    files.add(data.getData());
                }
            }
            filePathCb.onReceiveValue(files.toArray(new Uri[0]));
            filePathCb = null;
            return;
        }
        if (requestCode == FOLDER_REQ) {
            final int job = folderJob;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                final Uri treeUri = data.getData();
                try {
                    getContentResolver().takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Exception ignored) { }
                final Scan sc = new Scan();
                sc.job = job;
                final int[] tooBig = {0};
                final boolean[] truncated = {false};
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            walkCollect(sc, treeUri, android.provider.DocumentsContract.getTreeDocumentId(treeUri), "", tooBig, truncated);
                        } catch (Exception ignored) { }
                        scan = sc;
                        long bytes = 0;
                        for (Long s : sc.sizes) bytes += s == null ? 0 : s;
                        evalJs("window.__folderScanned && window.__folderScanned(" + job + "," + sc.uris.size()
                                + "," + bytes + "," + tooBig[0] + "," + truncated[0] + ")");
                    }
                }).start();
            } else {
                evalJs("window.__folderScanned && window.__folderScanned(" + job + ",-1,0,0,false)");
            }
            return;
        }
        if (requestCode == PICK_FILES_REQ) {
            final int job = folderJob;
            java.util.ArrayList<Uri> picked = collectPicked(data);
            for (Uri pu : picked) persistUri(pu);
            if (resultCode == RESULT_OK && !picked.isEmpty()) {
                final Scan sc = new Scan();
                sc.job = job;
                for (Uri u : picked) {
                    String nm = queryName(u);
                    sc.uris.add(u);
                    sc.paths.add(nm == null || nm.isEmpty() ? ("file-" + (sc.uris.size() + 1)) : nm);
                    sc.sizes.add(querySize(u));
                }
                scan = sc;
                long bytes = 0;
                for (Long s : sc.sizes) bytes += s == null || s < 0 ? 0 : s;
                evalJs("window.__folderScanned && window.__folderScanned(" + job + "," + sc.uris.size()
                        + "," + bytes + ",0,false)");
            } else {
                evalJs("window.__folderScanned && window.__folderScanned(" + job + ",-1,0,0,false)");
            }
            return;
        }
        if (requestCode == ASSET_REQ) {
            final String repoFull = assetRepo;
            final String relId = assetRelease;
            assetRepo = null;
            assetRelease = null;
            final java.util.ArrayList<Uri> picked = resultCode == RESULT_OK ? collectPicked(data) : new java.util.ArrayList<Uri>();
            if (repoFull == null || relId == null || picked.isEmpty()) return;
            for (Uri pu : picked) persistUri(pu);
            UploadService.begin(this, "Release upload", "Uploading to a release",
                    "0 of " + picked.size() + " files", android.R.drawable.stat_sys_upload);
            new Thread(new Runnable() {
                @Override
                public void run() {
                    String token = getSharedPreferences("onegit", MODE_PRIVATE).getString("token", "");
                    int ok = 0, fail = 0;
                    String firstErr = "";
                    for (Uri u : picked) {
                        if (UploadService.isCancelled()) break;   /* Cancel tapped on the card */
                        String name = queryName(u);
                        if (name == null || name.isEmpty()) name = "file-" + (ok + fail + 1);
                        try {
                            uploadAssetStream(token, repoFull, relId, u, name, ok + fail + 1, picked.size());
                            ok++;
                        } catch (Exception e) {
                            fail++;
                            if (firstErr.isEmpty()) firstErr = ghErr(e);
                        }
                    }
                    finishUpload(!UploadService.isCancelled() && fail == 0, UploadService.isCancelled()
                            ? ("Upload cancelled - " + ok + " file" + (ok == 1 ? "" : "s") + " had already been added")
                            : (ok + " file" + (ok == 1 ? "" : "s") + " added to the release"
                                + (fail > 0 ? " (" + fail + " failed)" : "")));
                    final int okF = ok, failF = fail;
                    final String errF = firstErr;
                    evalJs("window.__assetDone && window.__assetDone(" + okF + "," + failF + ","
                            + org.json.JSONObject.quote(errF) + ")");
                }
            }).start();
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /* ============ native upload pipeline (folder + multi-file + assets) ============ */

    /** Runs a JS snippet on the UI thread. */
    private void evalJs(final String js) {
        /* An upload can outlive the screen it started from, so this must not
           throw once the WebView is gone. */
        final WebView w = web;
        if (w == null) return;
        try {
            w.post(new Runnable() {
                @Override
                public void run() { try { w.evaluateJavascript(js, null); } catch (Throwable ignored) { } }
            });
        } catch (Throwable ignored) { }
    }

    private static String readAll(java.io.InputStream in) throws java.io.IOException {
        if (in == null) return "";
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        byte[] b = new byte[16384];
        int r;
        while ((r = in.read(b)) > 0) bo.write(b, 0, r);
        try { in.close(); } catch (Exception ignored) { }
        return bo.toString("UTF-8");
    }

    /** Pulls the "message" field out of a GitHub error body, if present. */
    private static String jsonMsg(String body) {
        try {
            String m = new org.json.JSONObject(body).optString("message", "");
            if (m != null && !m.isEmpty()) return " — " + m;
        } catch (Exception ignored) { }
        return "";
    }

    private static String ghErr(Throwable e) {
        String m = e.getMessage();
        if (m == null || m.isEmpty()) m = e.getClass().getSimpleName();
        return m != null && m.length() > 200 ? m.substring(0, 200) : m;
    }

    private String queryName(Uri u) {
        try {
            android.database.Cursor c = getContentResolver().query(u, null, null, null, null);
            if (c != null) {
                try {
                    int idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                    if (idx >= 0 && c.moveToFirst()) {
                        String n = c.getString(idx);
                        if (n != null && !n.isEmpty()) return n;
                    }
                } finally { c.close(); }
            }
        } catch (Exception ignored) { }
        String s = u.getLastPathSegment();
        return s == null ? null : s.replaceAll("[/\\\\]", "_");
    }

    private long querySize(Uri u) {
        try {
            android.database.Cursor c = getContentResolver().query(u, null, null, null, null);
            if (c != null) {
                try {
                    int idx = c.getColumnIndex(android.provider.OpenableColumns.SIZE);
                    if (idx >= 0 && c.moveToFirst() && !c.isNull(idx)) return c.getLong(idx);
                } finally { c.close(); }
            }
        } catch (Exception ignored) { }
        return -1;
    }

    private java.util.ArrayList<Uri> collectPicked(Intent data) {
        java.util.ArrayList<Uri> out = new java.util.ArrayList<>();
        if (data == null) return out;
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                Uri u = data.getClipData().getItemAt(i).getUri();
                if (u != null) out.add(u);
            }
        } else if (data.getData() != null) out.add(data.getData());
        return out;
    }

    /** Collects every file under the picked tree. Each subfolder and each file is
     *  isolated: one unreadable or broken entry never stops the rest of the walk
     *  (that is what used to silently drop whole folders like res/ and src/). */
    private void walkCollect(Scan sc, Uri tree, String parentDocId, String parentPath, int[] tooBig, boolean[] truncated) {
        android.database.Cursor c;
        try {
            c = getContentResolver().query(
                    android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentDocId),
                    new String[]{ android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                            android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE,
                            android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                            android.provider.DocumentsContract.Document.COLUMN_SIZE }, null, null, null);
        } catch (Exception e) { return; }
        if (c == null) return;
        try {
            while (c.moveToNext()) {
                try {
                    String docId = c.getString(0);
                    String mime = c.getString(1);
                    String name = c.getString(2);
                    long size = c.getLong(3);
                    if (docId == null || name == null) continue;
                    if (android.provider.DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                        walkCollect(sc, tree, docId, parentPath + name + "/", tooBig, truncated);
                    } else if (!truncated[0]) {
                        if (sc.uris.size() >= 2000) { truncated[0] = true; return; }
                        if (size >= 100L * 1024 * 1024) { tooBig[0]++; continue; }
                        sc.uris.add(android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, docId));
                        sc.paths.add(parentPath + name);
                        sc.sizes.add(size);
                    }
                } catch (Exception ignored) { }
            }
        } finally {
            try { c.close(); } catch (Exception ignored) { }
        }
    }

    /** Small JSON request helper for api.github.com. */
    private org.json.JSONObject gh(String token, String method, String urlStr, String body) throws Exception {
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(urlStr).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(20000);
            c.setReadTimeout(120000);
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Accept", "application/vnd.github+json");
            c.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
            c.setRequestProperty("User-Agent", "Gitly");
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                byte[] b = body.getBytes("UTF-8");
                c.setFixedLengthStreamingMode(b.length);
                java.io.OutputStream os = c.getOutputStream();
                os.write(b);
                os.close();
            }
            int code = c.getResponseCode();
            String resp = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
            if (code < 200 || code >= 300) throw new Exception("HTTP " + code + jsonMsg(resp));
            return resp == null || resp.isEmpty() ? new org.json.JSONObject() : new org.json.JSONObject(resp);
        } finally {
            try { c.disconnect(); } catch (Exception ignored) { }
        }
    }

    /** Streams one file to the Git blobs API as base64 without ever holding the
     *  whole file (or its encoding) in memory — this is what lifts the old 10 MB cap. */
    private String createBlobStreamed(String token, String owner, String repo, Uri u) throws Exception {
        Exception last = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            java.io.InputStream in = null;
            try {
                in = getContentResolver().openInputStream(u);
                if (in == null) throw new Exception("cannot open file");
                long size = querySize(u);
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(
                        "https://api.github.com/repos/" + owner + "/" + repo + "/git/blobs").openConnection();
                try {
                    c.setRequestMethod("POST");
                    c.setConnectTimeout(20000);
                    c.setReadTimeout(300000);
                    c.setRequestProperty("Authorization", "Bearer " + token);
                    c.setRequestProperty("Accept", "application/vnd.github+json");
                    c.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
                    c.setRequestProperty("User-Agent", "Gitly");
                    c.setRequestProperty("Content-Type", "application/json");
                    c.setDoOutput(true);
                    if (size >= 0) {
                        // {"content":"...","encoding":"base64"} -> 12 + base64 + 22 bytes
                        c.setFixedLengthStreamingMode(34 + 4L * ((size + 2) / 3));
                    } else {
                        c.setChunkedStreamingMode(512 * 1024);
                    }
                    java.io.OutputStream os = c.getOutputStream();
                    os.write("{\"content\":\"".getBytes("US-ASCII"));
                    byte[] chunk = new byte[3 * 512 * 1024];
                    int carry = 0;
                    while (true) {
                        int n = in.read(chunk, carry, chunk.length - carry);
                        if (n <= 0) break;
                        int t = carry + n;
                        int usable = (t / 3) * 3;
                        if (usable > 0) os.write(android.util.Base64.encode(chunk, 0, usable, android.util.Base64.NO_WRAP));
                        carry = t - usable;
                        if (carry > 0) System.arraycopy(chunk, usable, chunk, 0, carry);
                    }
                    if (carry > 0) os.write(android.util.Base64.encode(chunk, 0, carry, android.util.Base64.NO_WRAP));
                    os.write("\",\"encoding\":\"base64\"}".getBytes("US-ASCII"));
                    os.flush();
                    os.close();
                    int code = c.getResponseCode();
                    String resp = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
                    if (code < 200 || code >= 300) throw new Exception("HTTP " + code + jsonMsg(resp));
                    return new org.json.JSONObject(resp).getString("sha");
                } finally {
                    try { c.disconnect(); } catch (Exception ignored) { }
                }
            } catch (Exception e) {
                last = e;
                // only retry transient I/O problems, not HTTP rejections
                if (!(e.getCause() instanceof java.io.IOException) && !(e instanceof java.io.IOException)) break;
            } finally {
                if (in != null) try { in.close(); } catch (Exception ignored) { }
            }
        }
        throw last == null ? new Exception("blob failed") : last;
    }

    private static String resultJs(int job, int ok, int fail, java.util.ArrayList<String> errors) {
        return "window.__folderResult && window.__folderResult(" + job + "," + ok + "," + fail + ","
                + new org.json.JSONArray(errors).toString() + ")";
    }

    /** True when the scanned upload contains a file at the given repo-relative path. */
    private static boolean containsPath(Scan sc, String dir, String path) {
        String prefix = dir == null || dir.isEmpty() ? "" : dir + "/";
        for (String p : sc.paths) if ((prefix + p).equals(path)) return true;
        return false;
    }

    /** Uploads a scanned set of files as ONE commit via the Git Data API,
     *  streaming every file. Files that fail are reported individually —
     *  one bad file no longer aborts the rest of the upload. */
    /** Keeps read access to a picked file once the screen is gone, so the
     *  upload can carry on in the background. */
    private void persistUri(Uri u) {
        if (u == null) return;
        try {
            getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Throwable ignored) { }
    }
    private void persistScan(Scan sc) {
        if (sc == null) return;
        for (Uri u : sc.uris) persistUri(u);
    }

    /** Ends the background-upload notification and remembers the outcome, so the
     *  app can report it the next time it is opened. */
    private void finishUpload(boolean ok, String text) {
        try {
            getSharedPreferences("onegit", MODE_PRIVATE).edit()
                    .putString("uploadResult", new org.json.JSONObject()
                            .put("at", System.currentTimeMillis()).put("ok", ok).put("text", text).toString())
                    .apply();
        } catch (Throwable ignored) { }
        UploadService.finish(this, ok, text);
    }

    /* ---------- one-request commit through GraphQL ----------
       A folder of N files used to cost N+5 paid REST requests (one blob each, then the
       tree, commit and branch update). createCommitOnBranch sends the whole commit as a
       single GraphQL request, which has its own budget. It needs an existing branch,
       so an empty repository and anything too big for one request keep the blob route. */
    private static final long GQL_COMMIT_MAX_BYTES = 8L * 1024 * 1024;
    private static final int GQL_DONE = 1, GQL_NOTHING = 2, GQL_CANCELLED = 3, GQL_FALLBACK = 4;

    /** GitHub understood the request and said no - nothing was written, so the
     *  blob route can safely take over. */
    private static class GqlRejected extends Exception {
        GqlRejected(String m) { super(m); }
    }

    private org.json.JSONObject ghGraphql(String token, String body) throws Exception {
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL("https://api.github.com/graphql").openConnection();
        try {
            c.setRequestMethod("POST");
            c.setConnectTimeout(20000);
            c.setReadTimeout(300000);
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("User-Agent", "Gitly");
            byte[] b = body.getBytes("UTF-8");
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(b.length);
            java.io.OutputStream os = c.getOutputStream();
            os.write(b);
            os.close();
            int code = c.getResponseCode();
            String resp = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
            if (code < 200 || code >= 300) throw new GqlRejected("HTTP " + code + jsonMsg(resp));
            org.json.JSONObject j = new org.json.JSONObject(resp);
            org.json.JSONArray errs = j.optJSONArray("errors");
            if (errs != null && errs.length() > 0) {
                org.json.JSONObject e0 = errs.optJSONObject(0);
                throw new GqlRejected(e0 != null ? e0.optString("message", "GraphQL error") : "GraphQL error");
            }
            return j;
        } finally {
            try { c.disconnect(); } catch (Exception ignored) { }
        }
    }

    private byte[] readUriBytes(Uri u, long sizeHint) throws Exception {
        java.io.InputStream in = getContentResolver().openInputStream(u);
        if (in == null) throw new Exception("cannot open file");
        try {
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream((int) Math.max(32, Math.min(sizeHint, 1 << 20)));
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toByteArray();
        } finally {
            try { in.close(); } catch (Exception ignored) { }
        }
    }

    /** Commits every readable file of the scan in ONE GraphQL request. cnt[0] = files
     *  added, cnt[1] = files that could not be read. Returns GQL_FALLBACK when this route
     *  does not apply (too big, unknown size) or GitHub refused it. */
    private int uploadViaGraphql(String token, String owner, String repo, String branch, String parentSha,
                                 Scan sc, String dir, String message, int job,
                                 java.util.ArrayList<String> errors, int[] cnt) throws Exception {
        int total = sc.uris.size();
        long sum = 0;
        for (int i = 0; i < total; i++) {
            long sz = i < sc.sizes.size() ? sc.sizes.get(i) : -1;
            if (sz < 0) return GQL_FALLBACK;
            sum += sz;
            if (sum > GQL_COMMIT_MAX_BYTES) return GQL_FALLBACK;
        }
        org.json.JSONArray adds = new org.json.JSONArray();
        int ok = 0, fail = 0;
        for (int i = 0; i < total; i++) {
            if (UploadService.isCancelled()) { cnt[0] = 0; cnt[1] = fail; return GQL_CANCELLED; }
            String rel = (dir == null || dir.isEmpty() ? "" : dir + "/") + sc.paths.get(i);
            try {
                byte[] data = readUriBytes(sc.uris.get(i), sc.sizes.get(i));
                adds.put(new org.json.JSONObject().put("path", rel)
                        .put("contents", android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP)));
                ok++;
            } catch (Exception e) {
                fail++;
                if (errors.size() < 8) errors.add(sc.paths.get(i) + ": " + ghErr(e));
            }
            final int done = i + 1;
            evalJs("window.__folderProgress && window.__folderProgress(" + job + "," + done + "," + total + ")");
            UploadService.progress(MainActivity.this, done + " of " + total + " files",
                    (int) (100L * done / Math.max(1, total)));
        }
        cnt[0] = ok; cnt[1] = fail;
        if (ok == 0) return GQL_NOTHING;
        evalJs("window.__folderStage && window.__folderStage(" + job + ","
                + org.json.JSONObject.quote(fail > 0 ? "Committing the " + ok + " files that made it…" : "Creating commit…") + ")");
        String msg = message == null || message.isEmpty() ? "Upload files" : message;
        int nl = msg.indexOf('\n');
        org.json.JSONObject m = new org.json.JSONObject().put("headline", nl < 0 ? msg : msg.substring(0, nl).trim());
        if (nl >= 0 && msg.substring(nl + 1).trim().length() > 0) m.put("body", msg.substring(nl + 1).trim());
        org.json.JSONObject input = new org.json.JSONObject()
                .put("branch", new org.json.JSONObject()
                        .put("repositoryNameWithOwner", owner + "/" + repo).put("branchName", branch))
                .put("message", m)
                .put("expectedHeadOid", parentSha)
                .put("fileChanges", new org.json.JSONObject().put("additions", adds));
        String body = new org.json.JSONObject()
                .put("query", "mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}")
                .put("variables", new org.json.JSONObject().put("input", input)).toString();
        adds = null;
        try {
            ghGraphql(token, body);
        } catch (GqlRejected r) {
            /* refused (permissions, size, branch rules...): nothing was written */
            errors.clear();
            return GQL_FALLBACK;
        }
        return GQL_DONE;
    }

    private void uploadScan(final int job, final Scan sc, final String owner, final String repo,
                            final String dir, final String message) {
        final String token = getSharedPreferences("onegit", MODE_PRIVATE).getString("token", "");
        persistScan(sc);
        UploadService.begin(this, "Background upload", "Uploading to " + owner + "/" + repo,
                "0 of " + sc.uris.size() + " files", android.R.drawable.stat_sys_upload);
        final java.util.ArrayList<String> errors = new java.util.ArrayList<>();
        int ok = 0, fail = 0;
        boolean cancelled = false;
        try {
            org.json.JSONObject repoInfo = gh(token, "GET", "https://api.github.com/repos/" + owner + "/" + repo, null);
            String branch = repoInfo.optString("default_branch", "");
            if (branch == null || branch.isEmpty()) branch = "main";
            String parentSha = null, baseTree = null;
            boolean bootstrapped = false;
            try {
                org.json.JSONObject ref = gh(token, "GET", "https://api.github.com/repos/" + owner + "/" + repo
                        + "/git/ref/heads/" + branch, null);
                parentSha = ref.getJSONObject("object").getString("sha");
            } catch (Exception e) {
                // Empty repository: the Git Data API (blobs/trees/commits/refs) refuses to
                // touch it (409 "Git Repository is empty"), so create the first commit
                // through the Contents API, then chain the real upload onto it.
                bootstrapped = true;
                gh(token, "PUT", "https://api.github.com/repos/" + owner + "/" + repo + "/contents/.gitly-init",
                        new org.json.JSONObject()
                                .put("message", "Initialize repository")
                                .put("content", "Cg==")
                                .put("branch", branch).toString());
                org.json.JSONObject ref = gh(token, "GET", "https://api.github.com/repos/" + owner + "/" + repo
                        + "/git/ref/heads/" + branch, null);
                parentSha = ref.getJSONObject("object").getString("sha");
            }
            org.json.JSONObject pc = gh(token, "GET", "https://api.github.com/repos/" + owner + "/" + repo
                    + "/git/commits/" + parentSha, null);
            org.json.JSONObject t = pc.optJSONObject("tree");
            if (t != null) baseTree = t.optString("sha", null);

            /* existing branch: the whole commit in one GraphQL request (see above) */
            if (!bootstrapped) {
                int[] cnt = new int[2];
                int r = uploadViaGraphql(token, owner, repo, branch, parentSha, sc, dir, message, job, errors, cnt);
                if (r != GQL_FALLBACK) {
                    ok = cnt[0]; fail = cnt[1];
                    if (r == GQL_CANCELLED) {
                        finishUpload(false, "Upload cancelled");
                    } else if (r == GQL_NOTHING) {
                        finishUpload(false, fail + " file" + (fail == 1 ? "" : "s") + " could not be uploaded");
                    } else {
                        finishUpload(fail == 0, ok + " file" + (ok == 1 ? "" : "s") + " added to " + owner + "/" + repo
                                + (fail > 0 ? " (" + fail + " failed)" : ""));
                    }
                    evalJs(resultJs(job, ok, fail, errors));
                    return;
                }
                ok = 0; fail = 0;
            }

            org.json.JSONArray entries = new org.json.JSONArray();
            int total = sc.uris.size();
            for (int i = 0; i < total; i++) {
                if (UploadService.isCancelled()) { cancelled = true; break; }   /* Cancel tapped on the card */
                String rel = (dir == null || dir.isEmpty() ? "" : dir + "/") + sc.paths.get(i);
                try {
                    String sha = createBlobStreamed(token, owner, repo, sc.uris.get(i));
                    entries.put(new org.json.JSONObject()
                            .put("path", rel)
                            .put("mode", "100644")
                            .put("type", "blob")
                            .put("sha", sha));
                    ok++;
                } catch (Exception e) {
                    fail++;
                    if (errors.size() < 8) errors.add(sc.paths.get(i) + ": " + ghErr(e));
                }
                final int done = i + 1;
                evalJs("window.__folderProgress && window.__folderProgress(" + job + "," + done + "," + total + ")");
                UploadService.progress(MainActivity.this, done + " of " + total + " files",
                        (int) (100L * done / Math.max(1, total)));
            }
            if (ok == 0) {
                finishUpload(false, cancelled ? "Upload cancelled"
                        : (fail + " file" + (fail == 1 ? "" : "s") + " could not be uploaded"));
                evalJs(resultJs(job, 0, fail, errors));
                return;
            }
            // If we bootstrapped an empty repo, remove the marker in the real commit,
            // unless the upload itself happens to contain a file with that name.
            if (bootstrapped && !containsPath(sc, dir, ".gitly-init")) {
                entries.put(new org.json.JSONObject()
                        .put("path", ".gitly-init")
                        .put("mode", "100644")
                        .put("type", "blob")
                        .put("sha", org.json.JSONObject.NULL));
            }
            evalJs("window.__folderStage && window.__folderStage(" + job + ","
                    + org.json.JSONObject.quote(fail > 0 ? "Committing the " + ok + " files that made it…" : "Creating commit…") + ")");
            // build the tree in chunks so no single request grows unbounded
            String treeSha = baseTree;
            for (int start = 0; start < entries.length(); start += 750) {
                org.json.JSONArray part = new org.json.JSONArray();
                for (int i = start; i < entries.length() && i < start + 750; i++) part.put(entries.get(i));
                org.json.JSONObject body = new org.json.JSONObject().put("tree", part);
                if (treeSha != null) body.put("base_tree", treeSha);
                treeSha = gh(token, "POST", "https://api.github.com/repos/" + owner + "/" + repo + "/git/trees",
                        body.toString()).getString("sha");
            }
            org.json.JSONObject commitBody = new org.json.JSONObject()
                    .put("message", message == null || message.isEmpty() ? "Upload files" : message)
                    .put("tree", treeSha);
            org.json.JSONArray parents = new org.json.JSONArray();
            if (parentSha != null) parents.put(parentSha);
            commitBody.put("parents", parents);
            String commitSha = gh(token, "POST", "https://api.github.com/repos/" + owner + "/" + repo + "/git/commits",
                    commitBody.toString()).getString("sha");
            if (parentSha != null) {
                try {
                    gh(token, "PATCH", "https://api.github.com/repos/" + owner + "/" + repo + "/git/refs/heads/" + branch,
                            new org.json.JSONObject().put("sha", commitSha).toString());
                } catch (Exception e) {
                    gh(token, "POST", "https://api.github.com/repos/" + owner + "/" + repo + "/git/refs",
                            new org.json.JSONObject().put("ref", "refs/heads/" + branch).put("sha", commitSha).toString());
                }
            } else {
                try {
                    gh(token, "POST", "https://api.github.com/repos/" + owner + "/" + repo + "/git/refs",
                            new org.json.JSONObject().put("ref", "refs/heads/" + branch).put("sha", commitSha).toString());
                } catch (Exception e) {
                    gh(token, "PATCH", "https://api.github.com/repos/" + owner + "/" + repo + "/git/refs/heads/" + branch,
                            new org.json.JSONObject().put("sha", commitSha).toString());
                }
            }
            finishUpload(!cancelled && fail == 0, cancelled
                    ? ("Upload cancelled - " + ok + " file" + (ok == 1 ? "" : "s") + " had already been added")
                    : (ok + " file" + (ok == 1 ? "" : "s") + " added to " + owner + "/" + repo
                        + (fail > 0 ? " (" + fail + " failed)" : "")));
            evalJs(resultJs(job, ok, fail, errors));
        } catch (Exception e) {
            if (errors.size() < 8) errors.add(ghErr(e));
            finishUpload(false, "Upload stopped: " + ghErr(e));
            evalJs(resultJs(job, ok, fail, errors));
        }
    }

    /** Streams one release asset straight to uploads.github.com — no base64,
     *  no memory cap, supports assets up to GitHub's 2 GB per-file limit. */
    private void uploadAssetStream(String token, String repoFull, String releaseId, Uri u, String name,
                                   int fileIndex, int fileTotal) throws Exception {
        String mime = null;
        try { mime = getContentResolver().getType(u); } catch (Exception ignored) { }
        if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
        long size = querySize(u);
        java.io.InputStream in = getContentResolver().openInputStream(u);
        if (in == null) throw new Exception("cannot open file");
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(
                "https://uploads.github.com/repos/" + repoFull + "/releases/" + releaseId
                        + "/assets?name=" + java.net.URLEncoder.encode(name, "UTF-8")).openConnection();
        try {
            c.setRequestMethod("POST");
            c.setConnectTimeout(20000);
            c.setReadTimeout(600000);
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Accept", "application/vnd.github+json");
            c.setRequestProperty("User-Agent", "Gitly");
            c.setRequestProperty("Content-Type", mime);
            c.setDoOutput(true);
            if (size >= 0) c.setFixedLengthStreamingMode(size);
            else c.setChunkedStreamingMode(512 * 1024);
            java.io.OutputStream os = c.getOutputStream();
            byte[] b = new byte[256 * 1024];
            int r;
            long sent = 0;
            int lastPct = -1;
            while ((r = in.read(b)) > 0) {
                os.write(b, 0, r);
                sent += r;
                if (size > 0) {
                    int pct = (int) (sent * 100 / size);
                    if (pct != lastPct) {
                        lastPct = pct;
                        evalJs("window.__assetProgress && window.__assetProgress("
                                + fileIndex + "," + fileTotal + "," + pct + ","
                                + org.json.JSONObject.quote(name) + ")");
                        UploadService.progress(MainActivity.this,
                                "File " + fileIndex + " of " + fileTotal + " - " + pct + "%", pct);
                    }
                }
            }
            os.flush();
            os.close();
            int code = c.getResponseCode();
            String resp = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
            if (code < 200 || code >= 300) throw new Exception("HTTP " + code + jsonMsg(resp));
        } finally {
            try { c.disconnect(); } catch (Exception ignored) { }
            try { in.close(); } catch (Exception ignored) { }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        ContributionWidget.APP_OPEN = true;
        WidgetData.refreshAll(this);
    }

    @Override
    protected void onPause() {
        ContributionWidget.APP_OPEN = false;
        ContributionWidget.closeOpenSession();
        super.onPause();
    }

    private class Native {
        @JavascriptInterface
        public void theme(final String barColor, final boolean lightIcons) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                    int c = Color.parseColor(barColor);
                    getWindow().setStatusBarColor(c);
                    getWindow().setNavigationBarColor(c);
                    web.setBackgroundColor(c);
                    /* the app's theme also drives the widget backgrounds: its
                       Pitch black theme paints them pure black too */
                    try {
                        WidgetData.setPitch(MainActivity.this,
                                "#000000".equalsIgnoreCase(barColor == null ? "" : barColor.trim()));
                    } catch (Throwable ignored) { }
                        if (Build.VERSION.SDK_INT >= 23) {
                            View d = getWindow().getDecorView();
                            int f = d.getSystemUiVisibility();
                            if (lightIcons) f |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                            else f &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                            if (Build.VERSION.SDK_INT >= 26) {
                                if (lightIcons) f |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                                else f &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                            }
                            d.setSystemUiVisibility(f);
                        }
                    } catch (Exception ignored) {
                    }
                }
            });
        }

        /** The phone's own language as a BCP-47 tag ("ko-KR", "en-US", "hi-IN").
         *  This is what "Auto" follows. */
        @JavascriptInterface
        public String deviceLang() {
            try {
                if (android.os.Build.VERSION.SDK_INT >= 24) {
                    android.os.LocaleList ll = getResources().getConfiguration().getLocales();
                    if (ll != null && ll.size() > 0) return ll.get(0).toLanguageTag();
                }
                return java.util.Locale.getDefault().toLanguageTag();
            } catch (Throwable e) { return ""; }
        }

        /** Every language the phone is set to, most preferred first, as JSON. */
        @JavascriptInterface
        public String deviceLangs() {
            try {
                org.json.JSONArray a = new org.json.JSONArray();
                if (android.os.Build.VERSION.SDK_INT >= 24) {
                    android.os.LocaleList ll = getResources().getConfiguration().getLocales();
                    if (ll != null) for (int i = 0; i < ll.size(); i++) a.put(ll.get(i).toLanguageTag());
                } else {
                    a.put(java.util.Locale.getDefault().toLanguageTag());
                }
                return a.toString();
            } catch (Throwable e) { return "[]"; }
        }

        /** The account list the device is holding, so the page can rebuild it if
         *  its own storage was cleared. Empty when there is nothing saved. */
        @JavascriptInterface
        public String accounts() {
            try { return WidgetData.accountsJson(MainActivity.this); } catch (Throwable e) { return ""; }
        }

        /** Fetch a plain page from github.com - its Atom feeds, mainly.
         *  The page cannot read those itself: github.com sends no CORS headers
         *  and the web view is not allowed to ignore that. The device is not
         *  bound by CORS, so it does it. Only https://github.com is accepted,
         *  so this can never become a general-purpose fetcher. */
        @JavascriptInterface
        public String fetchText(final String url) {
            try {
                if (url == null || !url.startsWith("https://github.com/")) return "";
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                c.setRequestProperty("User-Agent", "Gitly");
                c.setRequestProperty("Accept", "application/atom+xml, application/xml, text/xml, text/plain");
                c.setConnectTimeout(15000);
                c.setReadTimeout(20000);
                int code = c.getResponseCode();
                if (code < 200 || code >= 300) { try { c.disconnect(); } catch (Throwable ignored) { } return ""; }
                java.io.InputStream in = c.getInputStream();
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n, total = 0;
                while ((n = in.read(buf)) > 0 && total < 1500000) { bo.write(buf, 0, n); total += n; }
                in.close();
                try { c.disconnect(); } catch (Throwable ignored) { }
                return bo.toString("UTF-8");
            } catch (Throwable e) { return ""; }
        }

        /** Stores the token so home screen widgets can call the GitHub API. */
        @JavascriptInterface
        public void saveToken(final String token) {
            try {
                getSharedPreferences("onegit", MODE_PRIVATE).edit()
                        .putString("token", token == null ? "" : token).apply();
                /* the widgets can only fetch once a token exists */
                WidgetData.refreshAll(MainActivity.this);
            } catch (Exception ignored) {
            }
        }

        /* The web UI sends the account list (and which one is active) so a widget
           can be pinned to a particular account - see WidgetConfigActivity. */
        @JavascriptInterface
        public void saveAccounts(final String json) {
            try { WidgetData.saveAccounts(MainActivity.this, json); } catch (Throwable ignored) { }
        }

        /* the web UI calls this whenever it has fresh data, so the widgets
           track the app without waiting for the next poll */
        @JavascriptInterface
        public void refreshWidgets() {
            try { WidgetData.refreshAll(MainActivity.this); } catch (Throwable ignored) { }
        }

        /* The app tells us the accent colour it is using (named, dynamic or a
           custom hex), so every widget can be drawn in the same colour. */
        @JavascriptInterface
        public void widgetAccent(final String hex) {
            try {
                if (hex != null && hex.startsWith("#") && hex.length() == 7) {
                    String up = hex.toUpperCase();
                    if (!up.equals(WidgetData.get(MainActivity.this, "accent", ""))) {
                        WidgetData.put(MainActivity.this, "accent", up);
                        WidgetData.repaintAll(MainActivity.this);
                    }
                }
            } catch (Throwable ignored) { }
        }

        /* The web UI already knows the login, the unread count and this year's
           contribution numbers, so it hands them over directly. That makes the
           widgets correct the moment the app is used, and because they are
           stored on the device they survive the app being closed - no waiting
           for a background fetch that may fail. */
        @JavascriptInterface
        public void widgetSync(final String json) {
            try {
                org.json.JSONObject o = new org.json.JSONObject(json == null || json.isEmpty() ? "{}" : json);
                String login = o.optString("login", "");
                /* keyed by the account these numbers describe, so a widget pinned
                   to another account never shows them */
                if (!login.isEmpty()) WidgetData.putAcct(MainActivity.this, "w_login", login, login);
                if (o.has("unread")) WidgetData.putIntAcct(MainActivity.this, "w_unread", login, o.optInt("unread", 0));
                String accent = o.optString("accent", "");
                if (accent.startsWith("#") && accent.length() == 7) {
                    WidgetData.put(MainActivity.this, "accent", accent.toUpperCase());
                }
                /* the calendar the app just fetched for its own Productivity screen: keep it
                   on the device as the widgets' data, so they need no request of their own */
                org.json.JSONObject cal = o.optJSONObject("calendar");
                if (cal != null && cal.optJSONObject("contributionCalendar") != null) {
                    WidgetData.putAcct(MainActivity.this, "contrib_json", login, cal.toString());
                    WidgetData.putAcct(MainActivity.this, "contrib_at", login, String.valueOf(System.currentTimeMillis()));
                }
                if (o.has("today")) {
                    WidgetData.putAcct(MainActivity.this, "w_stats", login,
                            o.optInt("today", 0) + " today · " + o.optInt("streak", 0) + "d streak · "
                                    + o.optInt("total", 0) + " this year");
                }
                WidgetData.refreshAll(MainActivity.this);
            } catch (Throwable ignored) { }
        }

        /** Opens the system folder picker so a whole folder can be uploaded to a repo.
     *  The folder is walked and every file is streamed to GitHub natively. */
    @JavascriptInterface
    public void pickFolder() {
        folderJob++;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), FOLDER_REQ);
                } catch (Exception ignored) { }
            }
        });
    }

    /** Opens the system multi-file picker. The picked files go through the same
     *  native single-commit pipeline as folder uploads — no base64 through the
     *  WebView, so large files work too. */
    @JavascriptInterface
    public void pickFiles() {
        folderJob++;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    startActivityForResult(i, PICK_FILES_REQ);
                } catch (Exception ignored) { }
            }
        });
    }

    /** Uploads a previously scanned job as one commit. Progress arrives in
     *  window.__folderProgress; the final report in window.__folderResult. */
    @JavascriptInterface
    public void uploadFolder(final int job, final String owner, final String repo,
                            final String dir, final String message) {
        final Scan sc = scan;
        if (sc == null || sc.job != job) {
            java.util.ArrayList<String> e = new java.util.ArrayList<>();
            e.add("Upload session lost — pick the folder again");
            finishUpload(false, "Upload session lost - pick the folder again");
            evalJs(resultJs(job, 0, 1, e));
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() { uploadScan(job, sc, owner, repo, dir, message); }
        }).start();
    }

    /** Opens the system file picker and streams whatever you pick straight into
     *  a release as assets (up to 2 GB per file — GitHub's release limit).
     *  Reports back through window.__assetDone(ok, fail, message). */
    @JavascriptInterface
    public void pickAssets(final String repoFull, final String releaseId) {
        assetRepo = repoFull;
        assetRelease = releaseId;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    startActivityForResult(i, ASSET_REQ);
                } catch (Exception ignored) { }
            }
        });
    }

        /** The app's real versionName straight from the package manager,
         *  so the web UI never shows a stale installed version. */
        @JavascriptInterface
        public String appVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) { return ""; }
        }

        /** When this app was last installed or updated (epoch ms). Any release
         *  published on GitHub after this moment is an update this device
         *  does not have yet - no version numbers needed. */
        @JavascriptInterface
        public long appInstallTime() {
            try {
                android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                return pi.lastUpdateTime > 0 ? pi.lastUpdateTime : pi.firstInstallTime;
            } catch (Exception e) { return 0; }
        }

        /** Posts a system notification, e.g. when an upload completes. */
        @JavascriptInterface
        public void notify(final String title, final String text) {
            try {
                android.app.NotificationManager nm = (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                if (Build.VERSION.SDK_INT >= 26) {
                    nm.createNotificationChannel(new android.app.NotificationChannel("onegit_uploads",
                            "Uploads", android.app.NotificationManager.IMPORTANCE_DEFAULT));
                }
                android.app.Notification.Builder b = Build.VERSION.SDK_INT >= 26
                        ? new android.app.Notification.Builder(MainActivity.this, "onegit_uploads")
                        : new android.app.Notification.Builder(MainActivity.this);
                b.setSmallIcon(R.mipmap.ic_launcher)
                        .setContentTitle(title == null ? "Gitly" : title)
                        .setContentText(text == null ? "" : text)
                        .setColor(0xFF1B6EF3)
                        .setAutoCancel(true);
                Intent open = new Intent(MainActivity.this, MainActivity.class);
                open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                b.setContentIntent(android.app.PendingIntent.getActivity(MainActivity.this, 21, open,
                        android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE));
                nm.notify(4201, b.build());
            } catch (Exception ignored) { }
        }

        /** Uploads a release asset to uploads.github.com. The WebView cannot do this
         * directly because uploads.github.com sends no CORS headers, so this runs
         * natively. Async: calls window.__uplDone(jobId, ok, message) when finished. */
        @JavascriptInterface
        public void uploadAsset(final int jobId, final String repo, final String releaseId,
                               final String name, final String mime, final String base64) {
            UploadService.begin(MainActivity.this, "Release upload", "Uploading to a release",
                    (name == null || name.isEmpty()) ? "1 file" : name, android.R.drawable.stat_sys_upload);
            new Thread(new Runnable() {
                @Override
                public void run() {
                    String msg = "OK";
                    try {
                        byte[] data = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
                        String token = getSharedPreferences("onegit", MODE_PRIVATE).getString("token", "");
                        java.net.URL url = new java.net.URL("https://uploads.github.com/repos/" + repo
                                + "/releases/" + releaseId + "/assets?name="
                                + java.net.URLEncoder.encode(name, "UTF-8"));
                        java.net.HttpURLConnection c = (java.net.HttpURLConnection) url.openConnection();
                        c.setRequestMethod("POST");
                        c.setRequestProperty("Authorization", "Bearer " + token);
                        c.setRequestProperty("Accept", "application/vnd.github+json");
                        c.setRequestProperty("Content-Type",
                                (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime);
                        c.setRequestProperty("User-Agent", "Gitly");
                        c.setDoOutput(true);
                        c.setFixedLengthStreamingMode(data.length);
                        java.io.OutputStream os = c.getOutputStream();
                        /* stream in chunks and report progress, the same way the
                           folder upload does, so the release page can show a bar */
                        int chunk = 65536, sent = 0, lastPct = -1;
                        while (sent < data.length) {
                            int n = Math.min(chunk, data.length - sent);
                            os.write(data, sent, n);
                            sent += n;
                            int pct = (int) ((long) sent * 100 / Math.max(1, data.length));
                            if (pct != lastPct) {
                                lastPct = pct;
                                evalJs("window.__uplProgress && window.__uplProgress("
                                        + jobId + "," + sent + "," + data.length + ")");
                            }
                        }
                        os.close();
                        int code = c.getResponseCode();
                        if (code < 200 || code >= 300) msg = "HTTP " + code;
                    } catch (Exception e) {
                        msg = e.getClass().getSimpleName();
                    }
                    final String m = msg.replaceAll("[^A-Za-z0-9 .:\\-]", " ");
                    final boolean ok = "OK".equals(msg);
                    web.post(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                finishUpload(ok, ok ? "File uploaded to the release" : ("Upload failed: " + m));
                                web.evaluateJavascript("window.__uplDone && window.__uplDone(" + jobId + "," + ok + ",'" + m + "')", null);
                            } catch (Exception ignored) { }
                        }
                    });
                }
            }).start();
        }

        /** How an upload ended while the app was closed, so the page can say so
         *  when it is opened again. Empty string when there is nothing to report. */
        @JavascriptInterface
        public String uploadState() {
            try { return getSharedPreferences("onegit", MODE_PRIVATE).getString("uploadResult", ""); }
            catch (Throwable e) { return ""; }
        }

        /** Whether long tasks show the live-update card, as chosen in Settings. */
        @JavascriptInterface
        public void setLiveNotifications(final boolean on) {
            try {
                getSharedPreferences("onegit", MODE_PRIVATE).edit().putBoolean("liveNotif", on).apply();
            } catch (Throwable ignored) { }
        }

        @JavascriptInterface
        public void clearUploadState() {
            try { getSharedPreferences("onegit", MODE_PRIVATE).edit().remove("uploadResult").apply(); }
            catch (Throwable ignored) { }
        }

        /** Real download to the device Downloads folder via DownloadManager.
         *
         *  enqueue() only means "queued" - the download itself can still fail,
         *  and when it does the file never arrives while the page has already
         *  said it downloaded. So the job is watched to its end, the page is
         *  told what really happened, and a failed job is re-fetched here
         *  (which writes the file itself and can report the result). */
        @JavascriptInterface
        public void download(final String url, final String filename) {
            final String name = (filename == null || filename.trim().isEmpty())
                    ? "gitly-download" : filename.trim().replaceAll("[^A-Za-z0-9._-]", "_");
            try {
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setTitle(name);
                /* Without an explicit destination the system downloader decides
                   where the file goes, and it is not always the Downloads folder
                   the user looks in. This pins it there. */
                try {
                    req.setDestinationInExternalPublicDir(
                            android.os.Environment.DIRECTORY_DOWNLOADS, name);
                } catch (Throwable ignored) { }
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setAllowedOverMetered(true);
                req.setAllowedOverRoaming(true);
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (dm == null) { downloadAuthed(url, name, ""); return; }
                long id = dm.enqueue(req);
                watchDownload(id, url, name);
            } catch (Throwable e) {
                /* it could not even be queued: fetch it in the app instead */
                downloadAuthed(url, name, "");
            }
        }

        /** Follow a DownloadManager job to the end and say what happened. */
        private void watchDownload(final long id, final String url, final String name) {
            new Thread(new Runnable() { @Override public void run() {
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (dm == null) return;
                boolean done = false;
                for (int i = 0; i < 240 && !done; i++) {
                    try { Thread.sleep(1500); } catch (InterruptedException e) { break; }
                    android.database.Cursor cur = null;
                    try {
                        cur = dm.query(new DownloadManager.Query().setFilterById(id));
                        if (cur == null || !cur.moveToFirst()) continue;
                        int st = cur.getInt(cur.getColumnIndex(DownloadManager.COLUMN_STATUS));
                        if (st == DownloadManager.STATUS_SUCCESSFUL) {
                            done = true;
                            evalJs("window.toast&&toast('Saved to Downloads')");
                        } else if (st == DownloadManager.STATUS_FAILED) {
                            break;   /* fall through to the in-app fetch */
                        }
                    } catch (Throwable ignored) {
                    } finally { try { if (cur != null) cur.close(); } catch (Throwable ignored) { } }
                }
                if (!done) {
                    /* the system downloader could not do it - do it here instead,
                       which also writes the file and reports the outcome */
                    downloadAuthed(url, name, "");
                }
            } }).start();
        }

        /** Downloads a file with the signed-in token and saves it to Downloads.
         *
         *  The system Download Manager carries no token, so a private
         *  repository's archive or release file came back 404 and the user saw
         *  "Download unsuccessful". GitHub serves the same files to an
         *  authenticated request, so this fetches it here instead. Progress and
         *  the result go through the same live notification uploads use. */
        @JavascriptInterface
        public void downloadAuthed(final String url, final String filename, final String accept) {
            if (url == null || url.isEmpty()) return;
            final String name = (filename == null || filename.trim().isEmpty())
                    ? "gitly-download" : filename.trim().replaceAll("[^A-Za-z0-9._-]", "_");
            new Thread(new Runnable() { @Override public void run() {
                java.net.HttpURLConnection c = null;
                try {
                    String token = getSharedPreferences("onegit", MODE_PRIVATE).getString("token", "");
                    UploadService.begin(MainActivity.this, "Download", "Downloading " + name,
                            "Starting...", android.R.drawable.stat_sys_download);
                    c = openSigned(url, token, accept);
                    int code = c.getResponseCode();
                    /* the API answers with a redirect to the file itself */
                    for (int hop = 0; hop < 4; hop++) {
                        if (code != 301 && code != 302 && code != 303 && code != 307 && code != 308) break;
                        String loc = c.getHeaderField("Location");
                        try { c.disconnect(); } catch (Throwable ignored) { }
                        if (loc == null || loc.isEmpty()) break;
                        c = openSigned(loc, "", accept);
                        code = c.getResponseCode();
                    }
                    if (code < 200 || code >= 300) {
                        UploadService.finish(MainActivity.this, false, "Download failed (HTTP " + code + ")");
                        evalJs("window.toast&&toast('Download failed - HTTP " + code + "')");
                        return;
                    }
                    long len = 0;
                    try { len = c.getContentLengthLong(); } catch (Throwable ignored) { }
                    java.io.InputStream in = c.getInputStream();
                    /* one shared save path for every download in the app */
                    String where = saveToDownloads(name, mimeFor(name), in, len);
                    in.close();
                    UploadService.finishDownload(MainActivity.this, true, "Saved " + name + " to " + where, lastDownloadUri);
                    evalJs("window.toast&&toast('Saved " + name + " to " + where + "')");
                } catch (Throwable e) {
                    try { if (c != null) c.disconnect(); } catch (Throwable ignored) { }
                    UploadService.finish(MainActivity.this, false, "Download failed");
                    evalJs("window.toast&&toast('Download failed')");
                }
            } }).start();
        }

        private java.net.HttpURLConnection openSigned(String url, String token, String accept)
                throws java.io.IOException {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("User-Agent", "Gitly");
            if (accept != null && !accept.isEmpty()) c.setRequestProperty("Accept", accept);
            if (token != null && !token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
            return c;
        }

        /** Save a download and PROVE it landed.
         *
         *  The bytes are written to the app's own folder FIRST - that cannot fail
         *  for permission reasons, so there is always a real file on the device.
         *  It is then copied into Download/Gitly so a file manager shows it, and
         *  the copied item is read back to confirm it really holds the bytes.
         *  Only then is success reported; otherwise the caller is told the app
         *  folder path, which is a file that definitely exists. */
        private String saveToDownloads(String name, String mime, java.io.InputStream in, long len)
                throws java.io.IOException {
            java.io.File dir = getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) dir = getFilesDir();
            if (dir == null) throw new java.io.IOException("no storage available");
            if (!dir.exists() && !dir.mkdirs()) throw new java.io.IOException("could not create the app folder");
            java.io.File local = new java.io.File(dir, name);
            java.io.FileOutputStream fo = new java.io.FileOutputStream(local);
            long wrote;
            try {
                wrote = pump(in, fo, len);
                fo.flush();
            } finally { try { fo.close(); } catch (Throwable ignored) { } }
            if (wrote <= 0) { try { local.delete(); } catch (Throwable ignored) { } throw new java.io.IOException("the download was empty"); }
            if (local.length() != wrote) throw new java.io.IOException("the file was not written completely");
            String pub = publishDownload(local, name, mime);
            return pub != null ? pub : local.getAbsolutePath();
        }

        /** Copy a finished file into Download/Gitly, then read it back to be sure. */
        private android.net.Uri lastDownloadUri = null;

        private String publishDownload(java.io.File local, String name, String mime) {
            try {
                lastDownloadUri = null;
                if (android.os.Build.VERSION.SDK_INT >= 29) {
                    android.content.ContentValues cv = new android.content.ContentValues();
                    cv.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name);
                    cv.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mime);
                    cv.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH,
                            android.os.Environment.DIRECTORY_DOWNLOADS + "/Gitly");
                    cv.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1);
                    android.net.Uri item = getContentResolver().insert(
                            android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (item == null) return null;
                    java.io.OutputStream out = null;
                    try {
                        out = getContentResolver().openOutputStream(item);
                        if (out == null) return null;
                        java.io.FileInputStream fi = new java.io.FileInputStream(local);
                        byte[] b = new byte[65536];
                        int r;
                        while ((r = fi.read(b)) > 0) out.write(b, 0, r);
                        fi.close();
                        out.flush();
                    } finally {
                        try { if (out != null) out.close(); } catch (Throwable ignored) { }
                        android.content.ContentValues done = new android.content.ContentValues();
                        done.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0);
                        try { getContentResolver().update(item, done, null, null); } catch (Throwable ignored) { }
                    }
                    /* read it back: the entry must exist and hold the bytes */
                    long size = -1;
                    android.database.Cursor cur = null;
                    try {
                        cur = getContentResolver().query(item,
                                new String[]{android.provider.MediaStore.MediaColumns.SIZE}, null, null, null);
                        if (cur != null && cur.moveToFirst()) size = cur.getLong(0);
                    } finally { try { if (cur != null) cur.close(); } catch (Throwable ignored) { } }
                    if (size == local.length()) { lastDownloadUri = item; return "Download/Gitly"; }
                    return null;
                }
                /* Android 9 and below: write straight into the public folder */
                java.io.File pub = android.os.Environment
                        .getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS);
                if (pub == null) return null;
                java.io.File gitly = new java.io.File(pub, "Gitly");
                if (!gitly.exists() && !gitly.mkdirs()) return null;
                java.io.File dest = new java.io.File(gitly, name);
                java.io.FileInputStream fi = new java.io.FileInputStream(local);
                java.io.FileOutputStream fo2 = new java.io.FileOutputStream(dest);
                byte[] b = new byte[65536];
                int r;
                while ((r = fi.read(b)) > 0) fo2.write(b, 0, r);
                fi.close();
                fo2.flush();
                fo2.close();
                if (dest.length() != local.length()) return null;
                try {
                    DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                    if (dm != null) dm.addCompletedDownload(name, "Gitly", false, mime, dest.getAbsolutePath(), dest.length(), true);
                } catch (Throwable ignored) { }
                return "Download/Gitly";
            } catch (Throwable e) {
                return null;
            }
        }

        private long pump(java.io.InputStream in, java.io.OutputStream out, long len)
                throws java.io.IOException {
            byte[] buf = new byte[65536];
            long total = 0, lastAt = 0;
            int r;
            while ((r = in.read(buf)) > 0) {
                out.write(buf, 0, r);
                total += r;
                long now = System.currentTimeMillis();
                if (now - lastAt > 1000) {
                    lastAt = now;
                    int pct = len > 0 ? (int) Math.min(100, total * 100 / len) : 0;
                    try {
                        UploadService.progress(MainActivity.this,
                                (total / 1048576) + " MB" + (len > 0 ? " of " + (len / 1048576) + " MB" : ""), pct);
                    } catch (Throwable ignored) { }   /* progress must never break the write */
                }
            }
            return total;
        }

        private String mimeFor(String name) {
            String n = name == null ? "" : name.toLowerCase();
            if (n.endsWith(".zip")) return "application/zip";
            if (n.endsWith(".gz") || n.endsWith(".tgz")) return "application/gzip";
            if (n.endsWith(".apk")) return "application/vnd.android.package-archive";
            if (n.endsWith(".png")) return "image/png";
            if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
            if (n.endsWith(".pdf")) return "application/pdf";
            if (n.endsWith(".txt") || n.endsWith(".md")) return "text/plain";
            return "application/octet-stream";
        }

        /** Downloads an update APK inside the app and then opens the system
         *  installer, so an automatic update finishes instead of stopping at
         *  "downloaded". Reports back to the page through toast(). */
        @JavascriptInterface
        public void downloadAndInstall(final String url, final String filename) {
            if (url == null || url.isEmpty()) return;
            final String want = (filename == null || filename.trim().isEmpty())
                    ? "gitly-update.apk" : filename.trim().replaceAll("[^A-Za-z0-9._-]", "_");
            new Thread(new Runnable() { @Override public void run() {
                try {
                    java.io.File dir = ApkProvider.updatesDir(MainActivity.this);
                    java.io.File[] old = dir.listFiles();
                    if (old != null) for (java.io.File f : old) { try { f.delete(); } catch (Throwable ignored) { } }
                    final java.io.File out = new java.io.File(dir,
                            want.toLowerCase().endsWith(".apk") ? want : want + ".apk");
                    UploadService.begin(MainActivity.this, "App update", "Downloading " + want,
                            "Starting...", android.R.drawable.stat_sys_download);

                    java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                    c.setInstanceFollowRedirects(true);
                    c.setRequestProperty("User-Agent", "Gitly-Android");
                    c.setConnectTimeout(15000);
                    c.setReadTimeout(90000);
                    int code = c.getResponseCode();
                    if (code != 200) {
                        UploadService.finish(MainActivity.this, false, "Update download failed (HTTP " + code + ")");
                        evalJs("window.toast&&toast('Update download failed (HTTP " + code + ")')");
                        return;
                    }
                    long len = 0;
                    try { len = c.getContentLengthLong(); } catch (Throwable ignored) { }
                    java.io.InputStream in = c.getInputStream();
                    java.io.FileOutputStream fo = new java.io.FileOutputStream(out);
                    byte[] buf = new byte[32768];
                    int r; long total = 0; long lastPctAt = 0;
                    while ((r = in.read(buf)) > 0) {
                        fo.write(buf, 0, r);
                        total += r;
                        long now = System.currentTimeMillis();
                        if (now - lastPctAt > 1000) {
                            lastPctAt = now;
                            int pct = len > 0 ? (int) Math.min(100, total * 100 / len) : 0;
                            UploadService.progress(MainActivity.this,
                                    (total / 1048576) + " MB" + (len > 0 ? " of " + (len / 1048576) + " MB" : ""), pct);
                        }
                    }
                    fo.flush(); fo.close(); in.close(); c.disconnect();

                    if (total < 4096) {
                        try { out.delete(); } catch (Throwable ignored) { }
                        UploadService.finish(MainActivity.this, false, "Update download was empty");
                        evalJs("window.toast&&toast('Update download was empty')");
                        return;
                    }
                    UploadService.finish(MainActivity.this, true, "Update downloaded - opening the installer");
                    evalJs("window.toast&&toast('Update downloaded - opening the installer')");
                    installApkFile(out);
                } catch (Throwable e) {
                    evalJs("window.toast&&toast('Update download failed')");
                }
            }}).start();
        }

        /** Hands a downloaded APK to the Android package installer. */
        private void installApkFile(final java.io.File apk) {
            runOnUiThread(new Runnable() { @Override public void run() {
                try {
                    /* Android 8+ only lets us install if the user has allowed this
                       app to install unknown apps - take them there once. */
                    if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
                        evalJs("window.toast&&toast('Allow Gitly to install updates, then update again')");
                        try {
                            Intent s = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + getPackageName()));
                            s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(s);
                        } catch (Throwable ignored) { }
                        return;
                    }
                    Uri uri = ApkProvider.uriFor(apk.getName());
                    Intent i = new Intent(Intent.ACTION_VIEW);
                    i.setDataAndType(uri, "application/vnd.android.package-archive");
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Throwable e) {
                    evalJs("window.toast&&toast('Could not open the installer')");
                }
            }});
        }

        /** Fetches any media URL natively and hands the WebView a data: URI
         *  (fallback for images/videos the WebView cannot load itself). */
        @JavascriptInterface
        public void fetchMedia(final String url) {
            if (url == null || url.isEmpty()) return;
            new Thread(new Runnable() { @Override public void run() {
                try {
                    java.net.URL u = new java.net.URL(url);
                    javax.net.ssl.HttpsURLConnection c = (javax.net.ssl.HttpsURLConnection) u.openConnection();
                    c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36");
                    c.setConnectTimeout(12000);
                    c.setReadTimeout(25000);
                    int code = c.getResponseCode();
                    if (code != 200) {
                        evalJs("window.__mediaFetched&&__mediaFetched(" + org.json.JSONObject.quote(url) + ",false,'')");
                        return;
                    }
                    String mime = c.getContentType();
                    if (mime == null || mime.isEmpty() || mime.contains("text/html")) mime = "application/octet-stream";
                    if (mime.contains(";")) mime = mime.split(";")[0].trim();
                    java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                    java.io.InputStream in = c.getInputStream();
                    byte[] b = new byte[16384]; int r;
                    while ((r = in.read(b)) > 0 && bo.size() < 9 * 1024 * 1024) bo.write(b, 0, r);
                    in.close();
                    c.disconnect();
                    String b64 = android.util.Base64.encodeToString(bo.toByteArray(), android.util.Base64.NO_WRAP);
                    evalJs("window.__mediaFetched&&__mediaFetched(" + org.json.JSONObject.quote(url) + ",true," +
                            org.json.JSONObject.quote("data:" + mime + ";base64," + b64) + ")");
                } catch (Exception e) {
                    evalJs("window.__mediaFetched&&__mediaFetched(" + org.json.JSONObject.quote(url) + ",false,'')");
                }
            }}).start();
        }

        /* ===== GitHub OAuth device flow (no client secret needed) ===== */
        private String oauthPost(String urlS, String body) throws Exception {
            java.net.URL u = new java.net.URL(urlS);
            javax.net.ssl.HttpsURLConnection c = (javax.net.ssl.HttpsURLConnection) u.openConnection();
            c.setRequestMethod("POST");
            c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "OneGit");
            c.setDoOutput(true);
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            java.io.OutputStream os = c.getOutputStream();
            os.write(body.getBytes("UTF-8"));
            os.close();
            int code = c.getResponseCode();
            String resp = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
            if (code != 200) throw new Exception("HTTP " + code);
            return resp;
        }

        /** Starts a GitHub device sign-in: returns device_code + user_code to the page. */
        @JavascriptInterface
        public void oauthStart(final String scope) {
            new Thread(new Runnable() { @Override public void run() {
                try {
                    String b = "client_id=" + java.net.URLEncoder.encode("Ov23liY2f5QBeO8CywWt", "UTF-8") +
                            "&scope=" + java.net.URLEncoder.encode(scope == null ? "" : scope, "UTF-8");
                    String resp = oauthPost("https://github.com/login/device/code", b);
                    evalJs("window.__oauthStart&&__oauthStart(true," + org.json.JSONObject.quote(resp) + ")");
                } catch (Exception e) {
                    evalJs("window.__oauthStart&&__oauthStart(false," + org.json.JSONObject.quote(ghErr(e)) + ")");
                }
            }}).start();
        }

        /** Polls GitHub for the OAuth device token once; the page decides to keep polling. */
        @JavascriptInterface
        public void oauthPoll(final String deviceCode) {
            new Thread(new Runnable() { @Override public void run() {
                try {
                    String b = "client_id=" + java.net.URLEncoder.encode("Ov23liY2f5QBeO8CywWt", "UTF-8") +
                            "&device_code=" + java.net.URLEncoder.encode(deviceCode == null ? "" : deviceCode, "UTF-8") +
                            "&grant_type=" + java.net.URLEncoder.encode("urn:ietf:params:oauth:grant-type:device_code", "UTF-8");
                    String resp = oauthPost("https://github.com/login/oauth/access_token", b);
                    evalJs("window.__oauthPoll&&__oauthPoll(true," + org.json.JSONObject.quote(resp) + ")");
                } catch (Exception e) {
                    evalJs("window.__oauthPoll&&__oauthPoll(false," + org.json.JSONObject.quote(ghErr(e)) + ")");
                }
            }}).start();
        }

        /** Downloads a repo file through api.github.com (so it works even when
         *  raw.githubusercontent.com is unreachable) and saves it to Downloads. */
        @JavascriptInterface
        public void apiDownload(final String owner, final String repo, final String path, final String name) {
            final String token = getSharedPreferences("onegit", MODE_PRIVATE).getString("token", "");
            final String safeName = (name == null || name.isEmpty() ? "file" : name)
                    .replaceAll("[^A-Za-z0-9 ._()-]", "_");
            new Thread(new Runnable() { @Override public void run() {
                try {
                    String enc = java.net.URLEncoder.encode(path == null ? "" : path, "UTF-8").replace("%2F", "/");
                    java.net.URL u = new java.net.URL("https://api.github.com/repos/" + owner + "/" + repo
                            + "/contents/" + enc + "?ref=HEAD");
                    javax.net.ssl.HttpsURLConnection c = (javax.net.ssl.HttpsURLConnection) u.openConnection();
                    c.setRequestProperty("Accept", "application/vnd.github.raw");
                    c.setRequestProperty("User-Agent", "OneGit");
                    if (token != null && !token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
                    c.setConnectTimeout(15000);
                    c.setReadTimeout(60000);
                    int code = c.getResponseCode();
                    if (code != 200) {
                        evalJs("window.toast&&toast('Download failed - HTTP " + code + "')");
                        return;
                    }
                    long len = c.getContentLengthLong();
                    if (len > 64L * 1024 * 1024) { evalJs("window.toast&&toast('File is too large to download in-app')"); return; }
                    String mime = c.getContentType();
                    if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
                    if (mime.contains(";")) mime = mime.split(";")[0].trim();
                    java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                    java.io.InputStream in = c.getInputStream();
                    byte[] b = new byte[16384]; int r;
                    while ((r = in.read(b)) > 0) bo.write(b, 0, r);
                    in.close();
                    c.disconnect();
                    byte[] data = bo.toByteArray();
                    if (data.length == 0) { evalJs("window.toast&&toast('Download failed - empty file')"); return; }
                    /* this used to write to MediaStore with no relative path and
                       no pending flag, so the file was saved invisibly - the app
                       said "Saved to Downloads" and the file manager showed
                       nothing. It goes through the one shared save path now. */
                    String where = saveToDownloads(safeName, mime,
                            new java.io.ByteArrayInputStream(data), data.length);
                    try { UploadService.finishDownload(MainActivity.this, true, "Saved " + safeName + " to " + where, lastDownloadUri); } catch (Throwable ignored) { }
                    evalJs("window.toast&&toast('Saved " + safeName + " to " + where + "')");
                } catch (Exception e) {
                    evalJs("window.toast&&toast('Download failed - " + ghErr(e) + "')");
                }
            }}).start();
        }

        /** Native clipboard copy (works even where the web clipboard API does not). */
        @JavascriptInterface
        public void copy(final String text) {
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Gitly", text));
            } catch (Exception ignored) {
            }
        }

        /** Returns the system/wallpaper accent color (Material You) as #RRGGBB, or "". */
        @JavascriptInterface
        public String systemAccent() {
            try {
                if (Build.VERSION.SDK_INT >= 31) {
                    int[] attrs = { android.R.attr.colorAccent };
                    android.content.res.TypedArray ta = obtainStyledAttributes(
                            android.R.style.Theme_DeviceDefault_DayNight, attrs);
                    int color = ta.getColor(0, 0);
                    ta.recycle();
                    if (color != 0) {
                        return String.format("#%06X", (0xFFFFFF & color));
                    }
                }
            } catch (Throwable ignored) { }
            return "";
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
