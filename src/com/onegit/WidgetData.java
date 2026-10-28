package com.onegit;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.TimeZone;

/**
 * Shared plumbing for the home screen widgets.
 *
 * Widgets used to go blank whenever a refresh did not finish: the RemoteViews
 * were rebuilt with empty text and the fetch that followed could fail (no
 * network, token not yet saved, phone freshly booted), which left the widget
 * with nothing to show. Every widget now keeps its last good values here and
 * paints them immediately, so a widget is never empty; refreshAll() is called
 * by the app, by the 15 minute poller and after a reboot so the values stay
 * current without opening the app.
 */
final class WidgetData {

    static final String PREF = "widgetcache";

    private WidgetData() { }

    static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    static String get(Context c, String k, String dflt) {
        try { return sp(c).getString(k, dflt); } catch (Throwable t) { return dflt; }
    }

    static int getInt(Context c, String k, int dflt) {
        try { return sp(c).getInt(k, dflt); } catch (Throwable t) { return dflt; }
    }

    static void put(Context c, String k, String v) {
        try { sp(c).edit().putString(k, v).apply(); } catch (Throwable ignored) { }
    }

    static void putInt(Context c, String k, int v) {
        try { sp(c).edit().putInt(k, v).apply(); } catch (Throwable ignored) { }
    }

    /** Refresh the widgets. The network is used ONLY while the app is open
     *  (ContributionWidget.APP_OPEN); otherwise this just repaints from the
     *  numbers already saved on the device. */
    static void refreshAll(Context ctx) {
        ContributionWidget.refreshFromNetwork(ctx.getApplicationContext());
    }

    /* ---------- accounts: a widget can show a specific account ---------- */

    /** called from the web UI: {"active":"login","accounts":[{"login":..,"token":..}]} */
    static void saveAccounts(Context ctx, String json) {
        try {
            org.json.JSONObject o = new org.json.JSONObject(json == null ? "{}" : json);
            android.content.SharedPreferences.Editor e = sp(ctx).edit();
            /* keep the whole payload as well: the page's own copy lives in
               localStorage, which a full device can clear, and the account list
               is not something anyone should have to type in again */
            e.putString("accountsJson", json == null ? "" : json);
            String active = o.optString("active", "");
            e.putString("activeLogin", active);
            java.util.Map<String, ?> all = sp(ctx).getAll();
            for (String k : all.keySet()) if (k.startsWith("tok.")) e.remove(k);
            org.json.JSONArray arr = o.optJSONArray("accounts");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    org.json.JSONObject a = arr.optJSONObject(i);
                    if (a == null) continue;
                    String l = a.optString("login", ""), t = a.optString("token", "");
                    if (!l.isEmpty() && !t.isEmpty()) e.putString("tok." + l.toLowerCase(), t);
                }
            }
            e.apply();
        } catch (Throwable ignored) { }
    }

    static String activeLogin(Context c) { return get(c, "activeLogin", ""); }

    /** the last account payload the page sent - used to rebuild the list if the
     *  page's own storage is ever wiped */
    static String accountsJson(Context c) { return get(c, "accountsJson", ""); }

    /** the account this particular widget instance was set to show ("" = follow the app) */
    static String widgetAccount(Context c, int id) { return get(c, "wacct." + id, ""); }
    static void setWidgetAccount(Context c, int id, String login) {
        put(c, "wacct." + id, login == null ? "" : login);
    }

    /** every account the app knows about, for the widget picker */
    static java.util.ArrayList<String> logins(Context c) {
        java.util.ArrayList<String> out = new java.util.ArrayList<>();
        try {
            java.util.Map<String, ?> all = sp(c).getAll();
            for (String k : all.keySet()) {
                if (k.startsWith("tok.") && all.get(k) instanceof String && !((String) all.get(k)).isEmpty()) {
                    out.add(k.substring(4));
                }
            }
        } catch (Throwable ignored) { }
        java.util.Collections.sort(out);
        return out;
    }

    static String tokenFor(Context c, String login) {
        if (login != null && !login.isEmpty()) {
            String t = get(c, "tok." + login.toLowerCase(), "");
            if (!t.isEmpty()) return t;
        }
        return token(c);
    }

    /** the login a widget should display: its own choice, else the app's active one */
    static String accountForWidget(Context c, int id) {
        String l = widgetAccount(c, id);
        return (l == null || l.isEmpty()) ? activeLogin(c) : l;
    }

    /* ---------- per-account values ----------
       Pushed numbers are stored per account, so a widget showing account A never
       shows account B's totals. When nothing is stored for the account asked
       for, the unkeyed value is used, so older installs keep working. */
    static String keyFor(String base, String acct) {
        return (acct == null || acct.isEmpty()) ? base : (base + "." + acct.toLowerCase());
    }
    static String getAcct(Context c, String base, String acct, String dflt) {
        String v = get(c, keyFor(base, acct), null);
        if (v == null && acct != null && !acct.isEmpty()) v = get(c, base, null);
        return v == null ? dflt : v;
    }
    static int getIntAcct(Context c, String base, String acct, int dflt) {
        String v = getAcct(c, base, acct, null);
        try { return v == null ? dflt : Integer.parseInt(v); } catch (Throwable t) { return dflt; }
    }
    static void putAcct(Context c, String base, String acct, String v) { put(c, keyFor(base, acct), v); }
    static void putIntAcct(Context c, String base, String acct, int v) { put(c, keyFor(base, acct), String.valueOf(v)); }

    /* ---------- theme: the widgets follow the app's Pitch black setting ---------- */

    static boolean isPitch(Context c) { return "1".equals(get(c, "pitch", "0")); }

    /** called whenever the app reports its theme; repaints only on a change */
    static void setPitch(Context ctx, boolean on) {
        String v = on ? "1" : "0";
        if (!v.equals(get(ctx, "pitch", "0"))) {
            put(ctx, "pitch", v);
            repaintAll(ctx);
        }
    }

    /** apply the theme's backgrounds to a widget (no-op unless pitch black) */
    static void applyBg(Context c, android.widget.RemoteViews v, int rootId, int cardId) {
        if (!isPitch(c)) return;
        try { v.setInt(rootId, "setBackgroundResource", R.drawable.widget_root_bg_pitch); } catch (Throwable ignored) { }
        if (cardId != 0) {
            try { v.setInt(cardId, "setBackgroundResource", R.drawable.widget_card_pitch); } catch (Throwable ignored) { }
        }
    }

    /* ---------- colour: every widget follows the app's chosen accent ---------- */

    /** the accent picked in the app's settings (Gitly blue when unset) */
    static int accentColor(Context c) {
        String h = get(c, "accent", "");
        try {
            if (h != null && h.startsWith("#") && h.length() == 7) {
                return 0xFF000000 | Integer.parseInt(h.substring(1), 16);
            }
        } catch (Throwable ignored) { }
        return 0xFF1B6EF3;
    }

    static int blend(int from, int to, float f) {
        int a = Math.round(android.graphics.Color.alpha(from) + (android.graphics.Color.alpha(to) - android.graphics.Color.alpha(from)) * f);
        int r = Math.round(android.graphics.Color.red(from) + (android.graphics.Color.red(to) - android.graphics.Color.red(from)) * f);
        int g = Math.round(android.graphics.Color.green(from) + (android.graphics.Color.green(to) - android.graphics.Color.green(from)) * f);
        int b = Math.round(android.graphics.Color.blue(from) + (android.graphics.Color.blue(to) - android.graphics.Color.blue(from)) * f);
        return android.graphics.Color.argb(a, r, g, b);
    }

    /** heatmap palette derived from the accent, so the widgets match the app */
    static int[] heatLevels(Context c) {
        int accent = accentColor(c);
        int empty = 0xFF262B33;
        return new int[] { empty, blend(empty, accent, 0.40f), blend(empty, accent, 0.60f),
                blend(empty, accent, 0.80f), accent };
    }

    /** repaint every widget from the cache without touching the network */
    static void repaintAll(Context ctx) {
        final Context c = ctx.getApplicationContext();
        ContributionWidget.repaintAll(c, ContributionGraph2x1.class);
        ContributionWidget.repaintAll(c, ContributionMonthSmall.class);
    }

    static String token(Context c) {
        try {
            String t = c.getSharedPreferences("onegit", Context.MODE_PRIVATE).getString("token", "");
            return t == null ? "" : t;
        } catch (Throwable t) { return ""; }
    }

    static String httpGet(String u, String token) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
        if (token != null && !token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Accept", "application/vnd.github+json");
        c.setRequestProperty("User-Agent", "Gitly");
        c.setConnectTimeout(12000);
        c.setReadTimeout(20000);
        InputStream in = c.getInputStream();
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) > 0) bo.write(b, 0, n);
        in.close();
        return bo.toString("UTF-8");
    }

    static JSONObject graphql(String token, String query) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("https://api.github.com/graphql").openConnection();
        c.setRequestMethod("POST");
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("User-Agent", "Gitly");
        c.setConnectTimeout(12000);
        c.setReadTimeout(20000);
        c.setDoOutput(true);
        OutputStream os = c.getOutputStream();
        os.write(new JSONObject().put("query", query).toString().getBytes("UTF-8"));
        os.close();
        InputStream in = c.getInputStream();
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) > 0) bo.write(b, 0, n);
        in.close();
        return new JSONObject(bo.toString("UTF-8"));
    }

    /** today's contribution count and the current streak, from a calendar's weeks */
    static int[] todayAndStreak(JSONArray weeks) {
        try {
            java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd");
            f.setTimeZone(TimeZone.getTimeZone("UTC"));
            String today = f.format(new java.util.Date());
            int todayCount = -1;
            ArrayList<Integer> flat = new ArrayList<>();
            for (int w = 0; w < weeks.length(); w++) {
                JSONArray days = weeks.getJSONObject(w).optJSONArray("contributionDays");
                if (days == null) continue;
                for (int d = 0; d < days.length(); d++) {
                    JSONObject day = days.getJSONObject(d);
                    flat.add(day.optInt("contributionCount", 0));
                    if (today.equals(day.optString("date"))) todayCount = day.optInt("contributionCount", 0);
                }
            }
            int i = flat.size() - 1;
            while (i >= 0 && flat.get(i) == 0) i--;
            int streak = 0;
            while (i >= 0 && flat.get(i) > 0) { streak++; i--; }
            return new int[] { todayCount < 0 ? 0 : todayCount, streak };
        } catch (Throwable t) { return new int[] { 0, 0 }; }
    }
}
