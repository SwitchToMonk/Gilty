package com.onegit;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;

/**
 * Base for the contribution widgets, styled after the in-app Productivity page.
 * 4x4 shows the full overview (graph + legend, Right now, This year on GitHub),
 * 4x2 shows the graph plus key stats, 2x2 is compact. Stats use the same math
 * as the Productivity page so the numbers always match the app.
 */
public class ContributionWidget extends AppWidgetProvider {

    protected boolean big = false;
    protected boolean small = false;
    protected int weeksLimit = 53;
    /* cell geometry - the 2x1 widget draws much smaller squares so a whole
       compact graph fits in one row */
    protected int cell = 16;
    protected int gap = 4;
    /* graph-only widgets have no text views at all, so nothing may be written
       to them (RemoteViews would fail to apply the update) */
    protected boolean graphOnly = false;

    protected int layoutId() { return R.layout.widget_contrib_graph_2x1; }

    /** True only while Gitly is on screen. The widgets fetch from GitHub only then. */
    static volatile boolean APP_OPEN = false;
    /** the app was opened a moment ago - do not ask GitHub again inside this window */
    private static final long FRESH_MS = 10 * 60 * 1000L;
    /** accounts already fetched (or being fetched) during the current time on screen:
     *  one request per account per open, however many times the app asks to refresh */
    private static final java.util.Set<String> FETCHED_THIS_OPEN =
            java.util.Collections.synchronizedSet(new java.util.HashSet<String>());

    /** called when the app leaves the screen: the next open may fetch once again */
    static void closeOpenSession() { FETCHED_THIS_OPEN.clear(); }

    /** System calls (added, resized, boot, the launcher asking): paint what is
     *  saved - never the network. */
    @Override
    public void onUpdate(final Context ctx, final AppWidgetManager mgr, final int[] ids) {
        for (final int id : ids) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), layoutId());
            Intent i = new Intent(ctx, MainActivity.class);
            i.putExtra("url", "file:///android_asset/www/index.html#/productivity");
            v.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(ctx, 11, i,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            paintSaved(ctx, mgr, id, v);
        }
    }

    private void paintSaved(Context ctx, AppWidgetManager mgr, int id, RemoteViews v) {
        String acct = WidgetData.accountForWidget(ctx, id);
        String cached = WidgetData.getAcct(ctx, "contrib_json", acct, "");
        if (!cached.isEmpty()) {
            try { draw(ctx, mgr, id, v, new JSONObject(cached)); return; } catch (Throwable ignored) { }
        }
        WidgetData.applyBg(ctx, v, R.id.widget_root, R.id.w_card);
        if (!graphOnly) { try { v.setTextViewText(R.id.w_total, "open Gitly"); } catch (Throwable ignored) { } }
        mgr.updateAppWidget(id, v);
    }

    /** repaint from the cached numbers only - used when the accent changes */
    static void repaintAll(Context ctx, Class<? extends ContributionWidget> cls) {
        try {
            AppWidgetManager m = AppWidgetManager.getInstance(ctx);
            int[] ids = m.getAppWidgetIds(new ComponentName(ctx, cls));
            if (ids == null || ids.length == 0) return;
            ContributionWidget w = cls.getDeclaredConstructor().newInstance();
            for (int id : ids) {
                RemoteViews v = new RemoteViews(ctx.getPackageName(), w.layoutId());
                Intent i = new Intent(ctx, MainActivity.class);
                i.putExtra("url", "file:///android_asset/www/index.html#/productivity");
                v.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(ctx, 11, i,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
                w.paintSaved(ctx, m, id, v);
            }
        } catch (Throwable ignored) { }
    }

    /** The ONLY place the widgets reach GitHub. Runs only while the app is open,
     *  fetches once per account (both widgets share it) and at most every 10
     *  minutes, then repaints both widgets from the saved numbers. When the app is
     *  closed it just repaints. */
    static void refreshFromNetwork(final Context ctx) {
        if (!APP_OPEN) { WidgetData.repaintAll(ctx); return; }
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    AppWidgetManager m = AppWidgetManager.getInstance(ctx);
                    java.util.HashSet<String> accts = new java.util.HashSet<String>();
                    Class<?>[] kept = { ContributionGraph2x1.class, ContributionMonthSmall.class };
                    for (Class<?> cls : kept) {
                        int[] ids = m.getAppWidgetIds(new ComponentName(ctx, cls));
                        if (ids != null) for (int id : ids) accts.add(WidgetData.accountForWidget(ctx, id));
                    }
                    boolean any = false;
                    for (String acct : accts) {
                        long at = 0;
                        try { at = Long.parseLong(WidgetData.getAcct(ctx, "contrib_at", acct, "0")); } catch (Throwable ignored) { }
                        if (System.currentTimeMillis() - at < FRESH_MS) continue;
                        String token = WidgetData.tokenFor(ctx, acct);
                        if (token == null || token.isEmpty()) continue;
                        if (!FETCHED_THIS_OPEN.add(acct == null ? "" : acct)) continue;
                        try {
                            JSONObject cc = data(token);
                            WidgetData.putAcct(ctx, "contrib_json", acct, cc.toString());
                            WidgetData.putAcct(ctx, "contrib_at", acct, String.valueOf(System.currentTimeMillis()));
                            any = true;
                        } catch (Throwable ignored) { }
                    }
                    WidgetData.repaintAll(ctx);
                } catch (Throwable ignored) { }
            }
        }).start();
    }

    void draw(Context ctx, AppWidgetManager mgr, int id, RemoteViews v, JSONObject cc) {
        WidgetData.applyBg(ctx, v, R.id.widget_root, R.id.w_card);
        try {
            JSONObject cal = cc.getJSONObject("contributionCalendar");
            int total = cal.optInt("totalContributions", 0);
            JSONArray weeks = cal.optJSONArray("weeks");
            if (weeks == null) return;

            SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd");
            fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
            String today = fmt.format(new Date());
            int cols = weeks.length();
            int[][] grid = new int[cols][7];
            List<Integer> flat = new ArrayList<>();
            Map<String, Integer> byDate = new HashMap<>();
            int todayW = -1, todayD = -1;
            for (int w = 0; w < cols; w++) {
                JSONArray days = weeks.getJSONObject(w).optJSONArray("contributionDays");
                if (days == null) continue;
                for (int d = 0; d < days.length() && d < 7; d++) {
                    JSONObject day = days.getJSONObject(d);
                    int cnt = day.optInt("contributionCount", 0);
                    grid[w][d] = cnt;
                    flat.add(cnt);
                    byDate.put(day.optString("date"), cnt);
                    if (today.equals(day.optString("date"))) { todayW = w; todayD = d; }
                }
            }

            // same math as the app's Productivity page
            int week = sumLast(byDate, 7), month = sumLast(byDate, 30);
            int i = flat.size() - 1;
            while (i >= 0 && flat.get(i) == 0) i--;
            int cur = 0;
            while (i >= 0 && flat.get(i) > 0) { cur++; i--; }
            int longest = 0, run = 0, busiest = 0;
            for (int c : flat) {
                if (c > 0) { run++; if (run > longest) longest = run; } else run = 0;
                if (c > busiest) busiest = c;
            }
            String avg = String.format("%.1f", flat.isEmpty() ? 0f : (float) total / flat.size());

            // slice to the visible window (small widget shows recent weeks only)
            int start = Math.max(0, cols - weeksLimit);
            int[][] g2 = new int[cols - start][7];
            for (int k = 0; k < g2.length; k++) g2[k] = grid[start + k];

            v.setImageViewBitmap(R.id.w_heat, render(ctx, g2, todayW - start, todayD, big));
            mgr.updateAppWidget(id, v);
        } catch (Throwable ignored) { }
    }

    private static int sumLast(Map<String, Integer> byDate, int n) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd");
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        Calendar c = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        int s = 0;
        for (int k = 0; k < n; k++) {
            Integer x = byDate.get(f.format(c.getTime()));
            if (x != null) s += x;
            c.add(Calendar.DATE, -1);
        }
        return s;
    }

    /** One UI contribution palette — same levels as the in-app heatmap: empty cell slightly
     *  lighter than the card background, then the Samsung blue at 40/60/80/100%. */
    /* the palette now comes from the accent chosen in the app - see
       WidgetData.heatLevels - so the widget matches the app's colour scheme */

    private static Typeface FONT;

    private static Typeface font(Context ctx) {
        if (FONT == null) {
            try { FONT = Typeface.createFromAsset(ctx.getAssets(), "www/fonts/OneGitSans.ttf"); }
            catch (Throwable t) { FONT = Typeface.DEFAULT; }
        }
        return FONT;
    }

    Bitmap render(Context ctx, int[][] grid, int tw, int td, boolean legend) {
        int[] palette = WidgetData.heatLevels(ctx);
        int cols = Math.max(grid.length, 1);
        int w = cols * (cell + gap) - gap;
        int h = 7 * (cell + gap) - gap;
        int extra = legend ? 46 : 0;
        Bitmap bm = Bitmap.createBitmap(Math.max(w, 10), Math.max(h + extra, 10), Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bm);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        RectF r = new RectF();
        for (int x = 0; x < cols; x++) {
            for (int y = 0; y < 7; y++) {
                int cnt = x < grid.length ? grid[x][y] : 0;
                // same buckets as the app heatmap: 0 / 1-2 / 3-6 / 7-11 / 12+
                int level = cnt == 0 ? 0 : cnt < 3 ? 1 : cnt < 7 ? 2 : cnt < 12 ? 3 : 4;
                p.setColor(palette[level]);
                r.set(x * (cell + gap), y * (cell + gap), x * (cell + gap) + cell, y * (cell + gap) + cell);
                /* GitHub's squares are only slightly rounded - a fixed 4.5px
                   radius made small cells look like circles, so the radius now
                   scales with the cell size */
                float rad = Math.max(1.5f, cell * 0.22f);
                c.drawRoundRect(r, rad, rad, p);
            }
        }
        /* the ring that used to mark today's cell is gone - the grid now reads
           as a plain heatmap, exactly like the app's own graph */
        // legend row, like the app's "Less ... More"
        if (legend) {
            Paint tp = new Paint(Paint.ANTI_ALIAS_FLAG);
            tp.setTypeface(font(ctx));
            tp.setTextSize(24f);
            tp.setColor(0xFF9A9A9A);
            c.drawText("Less", 2, h + 30, tp);
            int lx = 64;
            for (int l = 0; l < 5; l++) {
                p.setColor(palette[l]);
                r.set(lx, h + 14, lx + 18, h + 32);
                c.drawRoundRect(r, Math.max(1.5f, cell * 0.22f), Math.max(1.5f, cell * 0.22f), p);
                lx += 24;
            }
            tp.setColor(0xFF9A9A9A);
            c.drawText("More", lx + 4, h + 30, tp);
        }
        return bm;
    }

    private static JSONObject data(String token) throws Exception {
        String q = "{\"query\":\"query{viewer{contributionsCollection{totalCommitContributions"
                + " totalPullRequestContributions totalIssueContributions"
                + " totalPullRequestReviewContributions totalRepositoryContributions"
                + " contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}}}\"}";
        HttpURLConnection c = (HttpURLConnection) new URL("https://api.github.com/graphql").openConnection();
        c.setRequestMethod("POST");
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("User-Agent", "Gitly");
        c.setConnectTimeout(12000);
        c.setReadTimeout(20000);
        c.setDoOutput(true);
        c.getOutputStream().write(q.getBytes("UTF-8"));
        InputStream in = c.getInputStream();
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) > 0) bo.write(b, 0, n);
        in.close();
        JSONObject root = new JSONObject(bo.toString("UTF-8"));
        return root.getJSONObject("data").getJSONObject("viewer")
                .getJSONObject("contributionsCollection");
    }
}
