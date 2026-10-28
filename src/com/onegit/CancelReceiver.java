package com.onegit;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The live card's "Cancel" action lands here. All it does is tell the running
 *  task to stop at its next step - the task itself then winds up cleanly. */
public class CancelReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        try { UploadService.cancel(); } catch (Throwable ignored) { }
    }
}
