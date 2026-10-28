package com.onegit;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Repaints the widgets after the phone reboots. */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            /* widgets come back with their cached values instead of sitting empty */
            WidgetData.repaintAll(ctx);
        }
    }
}
