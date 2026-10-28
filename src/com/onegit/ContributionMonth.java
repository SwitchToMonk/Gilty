package com.onegit;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Calendar;
import java.util.Date;
import java.util.HashMap;
import java.util.Map;
import java.util.TimeZone;

/**
 * Contribution widget with big squares.
 *
 * The current month laid out as a calendar of large rounded cells, under the
 * month name, the month's contribution total and how many days of the month had
 * any contribution at all. Sizes and colours come from the same place as the
 * other contribution widgets, so it matches the app's accent.
 */
public class ContributionMonth extends ContributionWidget {

    /* big cells - the ImageView scales the bitmap to fit whatever the widget
       is resized to, so these stay square and stay big */
    { weeksLimit = 53; cell = 44; gap = 8; }

    private static final String[] MONTHS = { "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December" };

    private static final String[] MONTHS_SHORT = { "Jan", "Feb", "Mar", "Apr", "May", "Jun",
            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };

    /* the 2x2 has no room for a full month name next to the total */
    protected boolean shortMonth = false;

    @Override
    protected int layoutId() { return R.layout.widget_contrib_month_small; }

    @Override
    void draw(Context ctx, AppWidgetManager mgr, int id, RemoteViews v, JSONObject cc) {
        WidgetData.applyBg(ctx, v, R.id.widget_root, R.id.w_card);
        try {
            JSONObject cal = cc.getJSONObject("contributionCalendar");
            JSONArray weeks = cal.optJSONArray("weeks");
            if (weeks == null) return;

            /* the calendar spans about a year - index it by date */
            Map<String, Integer> byDate = new HashMap<>();
            for (int w = 0; w < weeks.length(); w++) {
                JSONArray days = weeks.getJSONObject(w).optJSONArray("contributionDays");
                if (days == null) continue;
                for (int d = 0; d < days.length(); d++) {
                    JSONObject day = days.getJSONObject(d);
                    byDate.put(day.optString("date"), day.optInt("contributionCount", 0));
                }
            }

            SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd");
            fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
            Calendar now = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
            String today = fmt.format(new Date());

            Calendar first = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
            first.clear();
            first.set(now.get(Calendar.YEAR), now.get(Calendar.MONTH), 1);
            int daysInMonth = first.getActualMaximum(Calendar.DAY_OF_MONTH);
            int startDow = first.get(Calendar.DAY_OF_WEEK) - 1;               /* 0 = Sunday */
            int rows = (int) Math.ceil((startDow + daysInMonth) / 7.0);

            int[][] grid = new int[rows][7];
            for (int[] row : grid) Arrays.fill(row, -1);                      /* -1: before the 1st */
            int monthTotal = 0, activeDays = 0;
            for (int d = 1; d <= daysInMonth; d++) {
                Calendar day = (Calendar) first.clone();
                day.set(Calendar.DAY_OF_MONTH, d);
                String key = fmt.format(day.getTime());
                int idx = startDow + d - 1;
                if (key.compareTo(today) > 0) { grid[idx / 7][idx % 7] = -2; continue; }   /* still to come */
                Integer hit = byDate.get(key);
                int cnt = hit == null ? 0 : hit;
                grid[idx / 7][idx % 7] = cnt;
                monthTotal += cnt;
                if (cnt > 0) activeDays++;
            }

            v.setImageViewBitmap(R.id.w_grid, renderMonth(ctx, grid));
            v.setTextViewText(R.id.w_month, (shortMonth ? MONTHS_SHORT : MONTHS)[now.get(Calendar.MONTH)]
                    + " " + now.get(Calendar.YEAR));
            v.setTextViewText(R.id.w_total, String.valueOf(monthTotal));
            v.setTextViewText(R.id.w_sub, activeDays + "/" + daysInMonth + " days active");
            try { v.setTextColor(R.id.w_sub, WidgetData.accentColor(ctx)); } catch (Throwable ignored) { }
            mgr.updateAppWidget(id, v);
        } catch (Throwable ignored) { }
    }

    /** 7 columns of weekdays, one row per week of the month. */
    private Bitmap renderMonth(Context ctx, int[][] grid) {
        int[] palette = WidgetData.heatLevels(ctx);
        int rows = Math.max(grid.length, 1);
        int w = 7 * (cell + gap) - gap;
        int h = rows * (cell + gap) - gap;
        Bitmap bm = Bitmap.createBitmap(Math.max(w, 10), Math.max(h, 10), Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bm);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        RectF r = new RectF();
        float rad = Math.max(4f, cell * 0.28f);          /* big, softly rounded squares */
        for (int y = 0; y < rows; y++) {
            for (int x = 0; x < 7; x++) {
                int cnt = y < grid.length ? grid[y][x] : -1;
                if (cnt == -1 || cnt == -2) continue;    /* outside the month, or not yet */
                int level = cnt == 0 ? 0 : cnt < 3 ? 1 : cnt < 7 ? 2 : cnt < 12 ? 3 : 4;
                p.setColor(palette[level]);
                r.set(x * (cell + gap), y * (cell + gap), x * (cell + gap) + cell, y * (cell + gap) + cell);
                c.drawRoundRect(r, rad, rad, p);
            }
        }
        return bm;
    }
}
