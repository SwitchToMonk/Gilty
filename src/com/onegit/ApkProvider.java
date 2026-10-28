package com.onegit;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Serves an update APK from the app's own cache to the system package installer
 * as a content:// URI.
 *
 * Android 7+ refuses to hand a file:// path to another app, and the installer
 * runs as a different app, so the update has to travel as a content URI. This
 * app is built without AndroidX and therefore cannot use androidx FileProvider,
 * hence this very small provider of its own.
 *
 * It only ever exposes .apk files that sit in <cache>/updates, it is not
 * exported, and it is only readable by whoever was granted the URI.
 */
public class ApkProvider extends ContentProvider {

    public static final String AUTHORITY = "com.onegit.apk";

    /** Where update APKs are staged. */
    public static File updatesDir(android.content.Context c) {
        File d = new File(c.getCacheDir(), "updates");
        if (!d.exists()) {
            try { d.mkdirs(); } catch (Throwable ignored) { }
        }
        return d;
    }

    public static Uri uriFor(String name) {
        return Uri.parse("content://" + AUTHORITY + "/" + Uri.encode(name));
    }

    private File fileFor(Uri uri) {
        String name = uri == null ? null : uri.getLastPathSegment();
        if (name == null || name.isEmpty()) return null;
        /* one flat folder only - no walking out of it */
        if (name.contains("..") || name.contains("/") || name.contains("\\")) return null;
        return new File(updatesDir(getContext()), name);
    }

    @Override
    public boolean onCreate() { return true; }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File f = fileFor(uri);
        if (f == null || !f.exists()) return null;
        MatrixCursor c = new MatrixCursor(new String[]{"_display_name", "_size"});
        c.addRow(new Object[]{f.getName(), f.length()});
        return c;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = fileFor(uri);
        if (f == null || !f.exists()) throw new FileNotFoundException(String.valueOf(uri));
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) { return "application/vnd.android.package-archive"; }

    @Override
    public Uri insert(Uri uri, ContentValues values) { return null; }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { return 0; }
}
