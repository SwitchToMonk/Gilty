package com.onegit;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps a long task (an upload, or an app-update download) alive when the app is
 * not in front, and shows it as a live card in the notification shade.
 *
 * The card follows the "live update" style: a context line beside the app name
 * (setSubText), a bold title, a status/ETA line, a thin progress bar and an
 * action row - all rendered by the system, never drawn by us.
 *
 * Android does not kill a process running a foreground service, which is what
 * lets the task finish after the user closes the app.
 */
public class UploadService extends Service {

    /** The live-update card. LOW importance so it never buzzes while updating. */
    public static final String CHANNEL_LIVE = "onegit_live";
    /** Plain fallback, used when the live style is switched off in Settings. */
    public static final String CHANNEL_PLAIN = "onegit_uploads_bg";
    private static final int NOTIF_ID = 41;
    static final String ACTION_CANCEL = "com.onegit.CANCEL_TASK";

    private static volatile String sSub = "Background task";
    private static volatile String sTitle = "Working";
    private static volatile String sText = "";
    private static volatile int sPct = 0;
    private static volatile boolean sRunning = false;
    private static volatile boolean sCancelled = false;
    private static volatile long sLastAt = 0;
    private static volatile long sStartAt = 0;
    private static volatile int sIcon = android.R.drawable.stat_sys_upload;

    public static boolean isRunning() { return sRunning; }

    /** True once the user tapped Cancel - the task should stop at its next step. */
    public static boolean isCancelled() { return sCancelled; }

    /** Tapped from the card's Cancel action. */
    public static void cancel() {
        sCancelled = true;
        sText = "Cancelling...";
    }

    private static boolean liveStyle(Context c) {
        try {
            return c.getSharedPreferences("onegit", Context.MODE_PRIVATE).getBoolean("liveNotif", true);
        } catch (Throwable e) { return true; }
    }

    /** Call when a task starts. sub = context label, title = the task, text = status. */
    public static void begin(Context c, String sub, String title, String text) {
        begin(c, sub, title, text, android.R.drawable.stat_sys_upload);
    }

    public static void begin(Context c, String sub, String title, String text, int smallIcon) {
        sSub = sub == null ? "" : sub;
        sTitle = (title == null || title.isEmpty()) ? "Working" : title;
        sText = text == null ? "" : text;
        sIcon = smallIcon;
        sPct = 0; sLastAt = 0; sStartAt = System.currentTimeMillis();
        sRunning = true; sCancelled = false;
        try {
            Intent i = new Intent(c, UploadService.class);
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
        } catch (Throwable ignored) { }
    }

    /** Progress. Rate-limited: a forty-file upload updates one card, not forty. */
    public static void progress(Context c, String text, int pct) {
        if (!sRunning) return;
        if (text != null) sText = text;
        sPct = Math.max(0, Math.min(100, pct));
        long now = System.currentTimeMillis();
        if (sPct < 100 && now - sLastAt < 1000) return;   /* at most one update a second */
        sLastAt = now;
        post(c, false);
    }

    /** "about 3 minutes left" - the status line the live card is built around. */
    private static String withEta(String status) {
        if (sPct <= 0 || sPct >= 100) return status == null ? "" : status;
        long el = System.currentTimeMillis() - sStartAt;
        if (el < 3000) return status == null ? "" : status;      /* too early to guess */
        long total = el * 100 / sPct;
        long left = Math.max(0, total - el);
        String eta;
        if (left < 45000) eta = "less than a minute left";
        else if (left < 90000) eta = "about a minute left";
        else eta = "about " + Math.round(left / 60000.0) + " minutes left";
        return (status == null || status.isEmpty()) ? eta : (status + " - " + eta);
    }

    /** Call when the task ends. Leaves one summary card behind (unless cancelled). */
    public static void finish(Context c, boolean ok, String summary) {
        boolean cancelled = sCancelled;
        sRunning = false;
        sLastAt = 0;
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                if (cancelled) nm.cancel(NOTIF_ID);
                else nm.notify(NOTIF_ID, build(c, ok ? "Upload finished" : "Upload failed",
                        summary == null ? "" : summary, 100, true));
            }
        } catch (Throwable ignored) { }
        try { c.stopService(new Intent(c, UploadService.class)); } catch (Throwable ignored) { }
    }

    /** A finished download: the notification opens the file that was saved. */
    public static void finishDownload(Context c, boolean ok, String summary, android.net.Uri uri) {
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                Notification n = build(c, ok ? "Download finished" : "Download failed",
                        summary == null ? "" : summary, 100, true);
                if (ok && uri != null) {
                    try {
                        Intent open = new Intent(Intent.ACTION_VIEW);
                        open.setDataAndType(uri, c.getContentResolver().getType(uri));
                        open.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                        PendingIntent pi = PendingIntent.getActivity(c, 9101, open,
                                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                        n.contentIntent = pi;
                    } catch (Throwable ignored) { }
                }
                nm.notify(NOTIF_ID, n);
            }
        } catch (Throwable ignored) { }
        try { c.stopService(new Intent(c, UploadService.class)); } catch (Throwable ignored) { }
    }

    private static void post(Context c, boolean done) {
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIF_ID, build(c, sTitle, withEta(sText), sPct, done));
        } catch (Throwable ignored) { }
    }

    private static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (nm.getNotificationChannel(CHANNEL_LIVE) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL_LIVE, "Live tasks",
                        NotificationManager.IMPORTANCE_LOW);   /* silent while it updates */
                ch.setDescription("Uploads and downloads shown as a live card while they run");
                ch.setShowBadge(false);
                ch.enableVibration(false);
                ch.setSound(null, null);
                nm.createNotificationChannel(ch);
            }
            if (nm.getNotificationChannel(CHANNEL_PLAIN) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL_PLAIN, "Background uploads",
                        NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("Progress of file and release uploads that keep running in the background");
                ch.setShowBadge(false);
                ch.enableVibration(false);
                ch.setSound(null, null);
                nm.createNotificationChannel(ch);
            }
        } catch (Throwable ignored) { }
    }

    private static Notification build(Context c, String title, String text, int pct, boolean done) {
        boolean live = liveStyle(c);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(c, live ? CHANNEL_LIVE : CHANNEL_PLAIN)
                : new Notification.Builder(c);
        b.setSmallIcon(sIcon);
        /* the first line reads "Gitly - <context>", exactly like the live card */
        if (live) b.setSubText(sSub);
        b.setContentTitle(title);
        if (text != null && !text.isEmpty()) b.setContentText(text);
        b.setOnlyAlertOnce(true);
        b.setDefaults(0);
        b.setSound(null);
        b.setVibrate(new long[]{0});
        if (live) {
            b.setCategory(Notification.CATEGORY_PROGRESS);
            b.setPriority(Notification.PRIORITY_HIGH);   /* the channel keeps it silent */
        }
        b.setOngoing(!done);
        b.setAutoCancel(done);
        b.setProgress(100, pct, false);

        if (live && !done) {
            try {
                Intent cx = new Intent(c, CancelReceiver.class).setAction(ACTION_CANCEL);
                PendingIntent pc = PendingIntent.getBroadcast(c, 1, cx,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                b.addAction(new Notification.Action.Builder(null, "Cancel", pc).build());

                Intent ms = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, c.getPackageName())
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                PendingIntent pm = PendingIntent.getActivity(c, 2, ms,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                b.addAction(new Notification.Action.Builder(null, "Manage notifications", pm).build());
            } catch (Throwable ignored) { }
        }
        try {
            Intent open = new Intent(c, MainActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent pi = PendingIntent.getActivity(c, 0, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            b.setContentIntent(pi);
        } catch (Throwable ignored) { }
        return b.build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannels(this);
        if (intent != null && ACTION_CANCEL.equals(intent.getAction())) {
            cancel();
            post(this, false);
            return START_NOT_STICKY;
        }
        try { startForeground(NOTIF_ID, build(this, sTitle, withEta(sText), sPct, false)); } catch (Throwable ignored) { }
        if (!sRunning) { try { stopSelf(); } catch (Throwable ignored) { } }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        try { stopForeground(true); } catch (Throwable ignored) { }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
