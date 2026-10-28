package com.onegit;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;

/**
 * Shown by the launcher while a widget is being added.
 *
 * When the app has more than one account signed in, the user is asked which
 * account this widget should show - a widget pinned to one account keeps showing
 * it even after you switch accounts in the app. With a single account (or none)
 * there is nothing to ask, so the activity finishes immediately and the widget is
 * placed as usual.
 */
public class WidgetConfigActivity extends Activity {

    private int widgetId = AppWidgetManager.INVALID_APPWIDGET_ID;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        /* backing out of this screen cancels adding the widget */
        setResult(RESULT_CANCELED);

        Bundle extras = getIntent() == null ? null : getIntent().getExtras();
        if (extras != null) widgetId = extras.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);

        final ArrayList<String> accounts = WidgetData.logins(this);
        if (accounts.size() < 2) { accept(null); return; }

        setContentView(build(accounts));
    }

    private View build(final ArrayList<String> accounts) {
        int pad = dp(20);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFF161719);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("Show which account?");
        title.setTextColor(0xFFF2F2F2);
        title.setTextSize(18);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        TextView sub = new TextView(this);
        sub.setText("This widget will keep showing the account you pick, even after you switch accounts in Gitly.");
        sub.setTextColor(0xFFB3B3B3);
        sub.setTextSize(13);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        slp.topMargin = dp(6);
        root.addView(sub, slp);

        ScrollView sc = new ScrollView(this);
        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        sc.addView(list);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        clp.topMargin = dp(14);
        root.addView(sc, clp);

        for (final String login : accounts) {
            list.addView(button(login, login.equalsIgnoreCase(WidgetData.activeLogin(this)), new Runnable() {
                @Override public void run() { accept(login); }
            }));
        }
        list.addView(button("Follow the app (active account)", true, new Runnable() {
            @Override public void run() { accept(null); }
        }));

        Button cancel = new Button(this);
        cancel.setText("Cancel");
        cancel.setTextColor(0xFFB3B3B3);
        cancel.setBackgroundColor(Color.TRANSPARENT);
        cancel.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        });
        LinearLayout.LayoutParams klp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        klp.topMargin = dp(10);
        root.addView(cancel, klp);
        return root;
    }

    private Button button(String label, boolean selected, final Runnable onPick) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(15);
        b.setTextColor(0xFFF2F2F2);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(22));
        bg.setColor(selected ? 0xFF1B6EF3 : 0xFF242527);
        b.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        lp.topMargin = dp(8);
        b.setLayoutParams(lp);
        b.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { onPick.run(); }
        });
        return b;
    }

    /** store the choice, refresh that widget, and let the launcher place it */
    private void accept(String login) {
        try {
            if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
                WidgetData.setWidgetAccount(this, widgetId, login);
                WidgetData.refreshAll(this);
            }
        } catch (Throwable ignored) { }
        Intent out = new Intent();
        out.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        setResult(RESULT_OK, out);
        finish();
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }
}
