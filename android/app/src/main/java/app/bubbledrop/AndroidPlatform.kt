package app.bubbledrop

import android.Manifest
import android.app.DownloadManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Settings
import android.util.Log
import android.webkit.MimeTypeMap
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.bubbledrop.core.Engine
import app.bubbledrop.core.HttpError
import app.bubbledrop.core.Ids
import app.bubbledrop.core.Platform
import app.bubbledrop.core.SelItem
import app.bubbledrop.core.Sink
import app.bubbledrop.core.jo
import app.bubbledrop.core.safeName
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/** What the platform needs from the visible activity (pickers, scanner, permission prompts). */
interface UiHost {
    val isForeground: Boolean
    fun launchPicker(kind: String, cb: (List<Uri>) -> Unit)
    fun launchScan(cb: (String?) -> Unit)
    fun requestPerms(perms: Array<String>, cb: (Boolean) -> Unit)
    fun applyTheme(theme: String)
    fun quit()
}

class AndroidPlatform(private val ctx: Context) : Platform {
    override val platformName = "android"
    override val dataDir: File = File(ctx.filesDir, "bubbledrop")
    @Volatile var host: UiHost? = null
    lateinit var engine: Engine
    private val main = Handler(Looper.getMainLooper())
    private val resolver get() = ctx.contentResolver
    private val wifi get() = ctx.applicationContext.getSystemService(WifiManager::class.java)
    private var mcastLock: WifiManager.MulticastLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val icons = ConcurrentHashMap<String, ByteArray>()

    // ---------- basics ----------

    override fun defaultName(): String {
        val n = try { Settings.Global.getString(resolver, Settings.Global.DEVICE_NAME) } catch (_: Exception) { null }
        if (!n.isNullOrBlank()) return n.take(40)
        val model = Build.MODEL ?: "Android"
        val maker = (Build.MANUFACTURER ?: "").replaceFirstChar { it.uppercase() }
        return (if (model.startsWith(maker, true)) model else "$maker $model").trim().take(40)
    }

    override fun webAsset(path: String): ByteArray? = try { ctx.assets.open("web/$path").use { it.readBytes() } } catch (_: IOException) { null }

    override fun caps() = jo(
        "dragDrop" to false, "pickFolder" to true, "pickMedia" to true, "apps" to true, "hotspot" to true,
        "joinWifi" to false, "scanQr" to true, "chooseSaveDir" to false, "tray" to false,
    )

    override fun saveDirLabel() = "Download/BubbleDrop"

    override fun log(msg: String, e: Throwable?) {
        Log.w("BubbleDrop", msg, e)
    }

    // ---------- reading what we send ----------

    override fun openInput(item: SelItem): InputStream = when {
        item.path != null -> FileInputStream(item.path)
        item.uri != null -> resolver.openInputStream(Uri.parse(item.uri)) ?: throw IOException("Cannot read ${item.name}")
        else -> throw IOException("Nothing to read")
    }

    override fun sizeOf(item: SelItem): Long = when {
        item.path != null -> File(item.path).length()
        item.uri != null -> querySize(Uri.parse(item.uri)) ?: item.size
        else -> item.size
    }

    private fun querySize(uri: Uri): Long? {
        try {
            resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) return c.getLong(0).takeIf { it >= 0 }
            }
        } catch (_: Exception) {}
        return try { resolver.openAssetFileDescriptor(uri, "r")?.use { it.length.takeIf { l -> l >= 0 } } } catch (_: Exception) { null }
    }

    /** Turns a picked/shared URI into something sendable. Unknown sizes get copied to cache first. */
    fun uriToItem(uri: Uri): SelItem? {
        var name: String? = null
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) name = c.getString(0) }
        } catch (_: Exception) {}
        val nm = safeName(name ?: uri.lastPathSegment?.substringAfterLast('/') ?: "file")
        val size = querySize(uri)
        if (size != null) return SelItem(Ids.new(), nm, nm, size, uri = uri.toString())
        return try {
            val f = File(File(ctx.cacheDir, "outgoing").apply { mkdirs() }, Ids.new() + "_" + nm)
            resolver.openInputStream(uri)?.use { inp -> f.outputStream().use { inp.copyTo(it) } } ?: return null
            SelItem(Ids.new(), nm, nm, f.length(), path = f.absolutePath)
        } catch (e: Exception) {
            log("cannot read $uri", e)
            null
        }
    }

    private fun walkTree(tree: Uri): List<SelItem> {
        try { resolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
        val out = mutableListOf<SelItem>()
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        var rootName = "Folder"
        try {
            resolver.query(DocumentsContract.buildDocumentUriUsingTree(tree, rootId), arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) rootName = safeName(c.getString(0))
            }
        } catch (_: Exception) {}
        val cols = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE)
        fun walk(docId: String, prefix: String) {
            resolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId), cols, null, null, null)?.use { c ->
                while (c.moveToNext() && out.size < 20000) {
                    val id = c.getString(0)
                    val name = safeName(c.getString(1))
                    if (c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) walk(id, "$prefix/$name")
                    else out += SelItem(Ids.new(), name, "$prefix/$name", if (c.isNull(3)) 0 else c.getLong(3), uri = DocumentsContract.buildDocumentUriUsingTree(tree, id).toString())
                }
            }
        }
        walk(rootId, rootName)
        return out
    }

    private fun <T> onUi(timeoutMin: Long, block: (CompletableFuture<T>) -> Unit): T {
        val f = CompletableFuture<T>()
        main.post { try { block(f) } catch (e: Exception) { f.completeExceptionally(e) } }
        return f.get(timeoutMin, TimeUnit.MINUTES)
    }

    override fun pick(kind: String): List<SelItem> {
        val h = host ?: throw HttpError(400, "Open BubbleDrop to pick files")
        val uris = onUi<List<Uri>>(20) { f -> h.launchPicker(kind) { f.complete(it) } }
        if (kind == "folder") return uris.firstOrNull()?.let { walkTree(it) } ?: emptyList()
        for (u in uris) try { resolver.takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
        return uris.mapNotNull { uriToItem(it) }
    }

    // ---------- saving what we receive (Download/BubbleDrop via MediaStore) ----------

    override fun createSink(rel: List<String>, mime: String): Sink {
        val name = rel.last()
        val ext = name.substringAfterLast('.', "").lowercase()
        val type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: mime.ifEmpty { "application/octet-stream" }
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, type)
            put(MediaStore.MediaColumns.RELATIVE_PATH, (listOf(Environment.DIRECTORY_DOWNLOADS, "BubbleDrop") + rel.dropLast(1)).joinToString("/"))
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IOException("Cannot save $name")
        val raw = try { resolver.openOutputStream(uri, "w") } catch (e: Exception) { null }
        if (raw == null) {
            resolver.delete(uri, null, null)
            throw IOException("Cannot save $name")
        }
        return object : Sink {
            override val out: OutputStream = BufferedOutputStream(raw, 512 * 1024)
            override fun commit(): String {
                resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                return uri.toString()
            }
            override fun abort() {
                try { out.close() } catch (_: Exception) {}
                try { resolver.delete(uri, null, null) } catch (_: Exception) {}
            }
        }
    }

    override fun open(loc: String, reveal: Boolean): String? {
        if (reveal || loc.isEmpty()) { openFolder(); return null }
        val uri = Uri.parse(loc)
        val type = resolver.getType(uri) ?: "*/*"
        val i = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        return try { ctx.startActivity(i); null } catch (e: ActivityNotFoundException) { "No app on this phone can open that file" } catch (e: SecurityException) { "That file was moved or deleted" }
    }

    override fun openFolder() {
        try { ctx.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
    }

    override fun copyText(text: String) {
        main.post { ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("BubbleDrop", text)) }
    }

    // ---------- notifications ----------

    override fun notify(title: String, body: String, extra: JSONObject) {
        if (host?.isForeground == true) return
        val nm = NotificationManagerCompat.from(ctx)
        if (!nm.areNotificationsEnabled()) return
        val openApp = PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val b = NotificationCompat.Builder(ctx, App.CH_TRANSFERS)
            .setSmallIcon(R.drawable.ic_stat_bubble)
            .setColor(0xFFFF6FAE.toInt())
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openApp)
        try {
            val rid = extra.optString("rid")
            val loc = extra.optString("loc")
            when {
                rid.isNotEmpty() -> {
                    fun act(a: String, code: Int) = PendingIntent.getForegroundService(ctx, code, Intent(ctx, BubbleService::class.java).setAction(a).putExtra("rid", rid), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                    b.setCategory(NotificationCompat.CATEGORY_MESSAGE)
                        .addAction(R.drawable.ic_stat_bubble, "Decline", act(BubbleService.ACTION_DECLINE, rid.hashCode() * 2))
                        .addAction(R.drawable.ic_stat_bubble, "Accept", act(BubbleService.ACTION_ACCEPT, rid.hashCode() * 2 + 1))
                    nm.notify("offer-$rid", ID_OFFER, b.build())
                }
                loc.isNotEmpty() -> {
                    val uri = Uri.parse(loc)
                    val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, resolver.getType(uri) ?: "*/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    b.setContentIntent(PendingIntent.getActivity(ctx, loc.hashCode(), view, PendingIntent.FLAG_IMMUTABLE))
                    nm.notify(ID_DONE + (loc.hashCode() and 0xffff), b.build())
                }
                else -> nm.notify(ID_DONE, b.build())
            }
        } catch (_: SecurityException) {}
    }

    override fun cancelNotification(tag: String) {
        NotificationManagerCompat.from(ctx).cancel(tag, ID_OFFER)
    }

    override fun onStatus(summary: String?) {
        BubbleService.instance?.update(summary)
    }

    override fun onSettings(settings: JSONObject) {
        val theme = settings.optString("theme", "dark")
        main.post { host?.applyTheme(theme) }
    }

    // ---------- power + multicast ----------

    @Synchronized
    override fun multicast(acquire: Boolean) {
        if (acquire && mcastLock == null) {
            mcastLock = wifi.createMulticastLock("bubbledrop").apply { setReferenceCounted(false); acquire() }
        } else if (!acquire) {
            mcastLock?.release()
            mcastLock = null
        }
    }

    @Synchronized
    override fun onBusy(busy: Boolean) {
        if (busy) {
            if (wifiLock == null) wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "bubbledrop:transfer").apply { setReferenceCounted(false); acquire() }
            if (wakeLock == null) wakeLock = ctx.getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "bubbledrop:transfer").apply { setReferenceCounted(false); acquire(6 * 60 * 60 * 1000L) }
        } else {
            wifiLock?.release(); wifiLock = null
            wakeLock?.release(); wakeLock = null
        }
    }

    // ---------- apps ----------

    private fun launchableApps(): List<ApplicationInfo> {
        val pm = ctx.packageManager
        val acts = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
        return acts.map { it.activityInfo.applicationInfo }.distinctBy { it.packageName }.filter {
            it.packageName != ctx.packageName && ((it.flags and ApplicationInfo.FLAG_SYSTEM) == 0 || (it.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0)
        }
    }

    private fun apkFiles(ai: ApplicationInfo): List<File> = listOf(File(ai.sourceDir)) + (ai.splitSourceDirs ?: emptyArray()).map { File(it) }

    override fun appIcon(pkg: String): ByteArray? = icons[pkg] ?: try {
        val d = ctx.packageManager.getApplicationIcon(pkg)
        val bmp = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888)
        d.setBounds(0, 0, 96, 96)
        d.draw(Canvas(bmp))
        ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray().also { icons[pkg] = it }
    } catch (_: Exception) { null }

    // ---------- platform actions ----------

    override fun action(op: String, body: JSONObject, engine: Engine): JSONObject? = when (op) {
        "apps" -> {
            val pm = ctx.packageManager
            val list = launchableApps().map { ai ->
                jo("pkg" to ai.packageName, "label" to pm.getApplicationLabel(ai).toString(), "size" to apkFiles(ai).sumOf { it.length() }, "split" to !ai.splitSourceDirs.isNullOrEmpty())
            }.sortedBy { it.getString("label").lowercase() }
            jo("apps" to JSONArray(list))
        }
        "pick-apps" -> {
            val pm = ctx.packageManager
            val want = body.optJSONArray("pkgs") ?: JSONArray()
            val items = mutableListOf<SelItem>()
            for (i in 0 until want.length()) {
                val pkg = want.getString(i)
                val ai = try { pm.getApplicationInfo(pkg, 0) } catch (_: PackageManager.NameNotFoundException) { continue }
                val label = safeName(pm.getApplicationLabel(ai).toString())
                val ver = try { pm.getPackageInfo(pkg, 0).versionName ?: "" } catch (_: Exception) { "" }
                val files = apkFiles(ai)
                val icon = "/local/appicon?pkg=" + Uri.encode(pkg)
                if (files.size == 1) {
                    val n = safeName(if (ver.isEmpty()) "$label.apk" else "${label}_$ver.apk")
                    items += SelItem(Ids.new(), n, n, files[0].length(), "app", path = files[0].absolutePath, icon = icon)
                } else {
                    // App bundles: send every part in one folder (install with a split-APK installer).
                    for (f in files) items += SelItem(Ids.new(), f.name, "$label/${f.name}", f.length(), "app", path = f.absolutePath, icon = icon)
                }
            }
            jo("added" to engine.addSelection(items))
        }
        "scan-qr" -> {
            val h = host ?: throw HttpError(400, "Open BubbleDrop first")
            jo("text" to onUi<String?>(10) { f -> h.launchScan { f.complete(it) } })
        }
        "hotspot" -> {
            if (body.optBoolean("on")) startHotspot() else stopHotspot()
            jo("ok" to true)
        }
        "open-url" -> {
            val url = body.optString("url")
            if (url.startsWith("http://") || url.startsWith("https://")) {
                try { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
            }
            jo("ok" to true)
        }
        "quit" -> {
            main.post { host?.quit() ?: ctx.startService(Intent(ctx, BubbleService::class.java).setAction(BubbleService.ACTION_STOP)) }
            jo("ok" to true)
        }
        else -> null
    }

    // ---------- local-only hotspot (no mobile data) ----------

    @Volatile private var reservation: WifiManager.LocalOnlyHotspotReservation? = null
    @Volatile private var hs: JSONObject = jo("active" to false)

    override fun hotspotState(): JSONObject = hs

    private fun setHs(o: JSONObject) {
        hs = o
        if (::engine.isInitialized) engine.changed()
    }

    private fun startHotspot() {
        if (reservation != null) return
        val perms = if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.NEARBY_WIFI_DEVICES) else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        if (perms.any { ContextCompat.checkSelfPermission(ctx, it) != PackageManager.PERMISSION_GRANTED }) {
            val h = host ?: throw HttpError(400, "Open BubbleDrop first")
            val ok = onUi<Boolean>(3) { f -> h.requestPerms(perms) { f.complete(it) } }
            if (!ok) {
                setHs(jo("active" to false, "error" to "BubbleDrop needs the ${if (Build.VERSION.SDK_INT >= 33) "Nearby devices" else "Location"} permission to start a hotspot."))
                return
            }
        }
        setHs(jo("active" to false, "starting" to true))
        main.post {
            try {
                wifi.startLocalOnlyHotspot(object : WifiManager.LocalOnlyHotspotCallback() {
                    override fun onStarted(r: WifiManager.LocalOnlyHotspotReservation) {
                        reservation = r
                        var ssid = ""
                        var pass = ""
                        if (Build.VERSION.SDK_INT >= 30) {
                            val c = r.softApConfiguration
                            @Suppress("DEPRECATION")
                            ssid = c.ssid ?: ""
                            pass = c.passphrase ?: ""
                        } else {
                            @Suppress("DEPRECATION")
                            r.wifiConfiguration?.let { ssid = it.SSID ?: ""; pass = it.preSharedKey ?: "" }
                        }
                        setHs(jo("active" to true, "ssid" to ssid.trim('"'), "password" to pass.trim('"')))
                    }

                    override fun onStopped() {
                        reservation = null
                        setHs(jo("active" to false))
                    }

                    override fun onFailed(reason: Int) {
                        reservation = null
                        setHs(jo("active" to false, "error" to when (reason) {
                            ERROR_INCOMPATIBLE_MODE -> "Turn off your normal hotspot first, then try again."
                            ERROR_TETHERING_DISALLOWED -> "This phone doesn't allow hotspots right now."
                            ERROR_NO_CHANNEL -> "No free Wi-Fi channel. Try again in a moment."
                            else -> "Couldn't start the hotspot. Try turning Wi-Fi off and on."
                        }))
                    }
                }, main)
            } catch (e: SecurityException) {
                setHs(jo("active" to false, "error" to "Turn on Location (Android needs it for hotspots), then try again."))
            } catch (e: IllegalStateException) {
                setHs(jo("active" to false, "error" to "A hotspot is already running. Turn it off first."))
            }
        }
    }

    fun stopHotspot() {
        reservation?.close()
        reservation = null
        setHs(jo("active" to false))
    }

    companion object {
        const val ID_OFFER = 2
        const val ID_DONE = 100
    }
}
