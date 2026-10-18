package app.bubbledrop.core

import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream

/** Something the user picked to send: a content URI, a file path (APKs) or a test file. */
class SelItem(
    val id: String,
    val name: String,
    val rel: String,
    var size: Long,
    val kind: String = "file",
    val uri: String? = null,
    val path: String? = null,
    val icon: String? = null,
)

/** Where one received file is being written. */
interface Sink {
    val out: OutputStream
    /** Finishes the file and returns where it ended up (path or content URI). */
    fun commit(): String
    fun abort()
}

/** Everything the engine needs from the device it runs on. */
interface Platform {
    val platformName: String
    val dataDir: File
    fun defaultName(): String
    fun webAsset(path: String): ByteArray?
    fun openInput(item: SelItem): InputStream
    fun sizeOf(item: SelItem): Long
    fun createSink(rel: List<String>, mime: String): Sink
    fun saveDirLabel(): String
    fun caps(): JSONObject
    fun notify(title: String, body: String, extra: JSONObject) {}
    fun cancelNotification(tag: String) {}
    /** Blocks until the user has picked (may return empty). */
    fun pick(kind: String): List<SelItem> = emptyList()
    /** Platform-only local actions; null when unknown. */
    fun action(op: String, body: JSONObject, engine: Engine): JSONObject? = null
    fun appIcon(pkg: String): ByteArray? = null
    fun open(loc: String, reveal: Boolean): String? = null
    fun openFolder() {}
    fun copyText(text: String) {}
    fun hotspotState(): JSONObject? = null
    fun onBusy(busy: Boolean) {}
    fun onStatus(summary: String?) {}
    fun onSettings(settings: JSONObject) {}
    fun multicast(acquire: Boolean) {}
    fun log(msg: String, e: Throwable? = null) {
        println("BubbleDrop: $msg ${e?.message ?: ""}")
    }
}
