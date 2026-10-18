package app.bubbledrop

import app.bubbledrop.core.Engine
import app.bubbledrop.core.Ids
import app.bubbledrop.core.Platform
import app.bubbledrop.core.SelItem
import app.bubbledrop.core.Sink
import app.bubbledrop.core.jo
import app.bubbledrop.core.requestJson
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Files
import java.security.MessageDigest
import kotlin.random.Random

/** Engine on plain files, so the Android engine can be tested on the JVM. */
class FilePlatform(val root: File) : Platform {
    override val platformName = "android"
    override val dataDir = File(root, "data")
    val inbox = File(root, "inbox")
    override fun defaultName() = root.name
    override fun webAsset(path: String): ByteArray? = File("../../web/$path").takeIf { it.isFile }?.readBytes()
    override fun openInput(item: SelItem): InputStream = FileInputStream(item.path!!)
    override fun sizeOf(item: SelItem) = File(item.path!!).length()
    override fun saveDirLabel() = inbox.path
    override fun caps() = JSONObject()
    override fun createSink(rel: List<String>, mime: String): Sink {
        var dest = File(inbox, rel.joinToString(File.separator))
        var i = 1
        while (dest.exists()) dest = File(dest.parentFile, "${rel.last().substringBeforeLast('.')} (${i++}).${rel.last().substringAfterLast('.')}")
        dest.parentFile.mkdirs()
        val tmp = File(dest.path + ".part")
        val o = tmp.outputStream()
        return object : Sink {
            override val out: OutputStream = o
            override fun commit(): String { tmp.renameTo(dest); return dest.path }
            override fun abort() { o.close(); tmp.delete() }
        }
    }
}

class EngineTest {
    private val tmp = Files.createTempDirectory("bd-kt").toFile()
    private val engines = mutableListOf<Engine>()

    @After
    fun cleanup() {
        engines.forEach { it.stop() }
        tmp.deleteRecursively()
    }

    private fun engine(name: String, port: Int): Pair<Engine, FilePlatform> {
        val p = FilePlatform(File(tmp, name))
        val e = Engine(p, port, discovery = false)
        e.start()
        engines += e
        return e to p
    }

    private fun waitFor(ms: Long = 20_000, what: String, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) { if (cond()) return; Thread.sleep(50) }
        throw AssertionError("timeout waiting for $what")
    }

    private fun sha(f: File) = MessageDigest.getInstance("SHA-256").digest(f.readBytes()).joinToString("") { "%02x".format(it) }

    private fun sample(name: String, size: Int): File = File(tmp, "src/$name").apply { parentFile.mkdirs(); writeBytes(Random.nextBytes(size)) }

    @Test
    fun kotlinToKotlin() {
        val (a, _) = engine("A", 47980)
        val (b, pb) = engine("B", 47990)
        val dev = a.connect("127.0.0.1:${b.port}")
        assertEquals(b.settings.getString("id"), dev.id)

        val f1 = sample("song.mp3", 3_000_000)
        val f2 = sample("empty.txt", 0)
        a.addSelection(listOf(
            SelItem(Ids.new(), f1.name, "Mix/${f1.name}", f1.length(), path = f1.path),
            SelItem(Ids.new(), f2.name, "Mix/${f2.name}", 0, path = f2.path),
        ))
        val sid = a.send(dev.id)
        waitFor(what = "offer") { b.pending.size == 1 }
        b.localAction("respond", jo("rid" to b.pending.keys.first(), "accept" to true, "trust" to true))
        waitFor(what = "send done") { a.transfers[sid]?.active == false }
        assertEquals(a.transfers[sid]?.error, "done", a.transfers[sid]?.status)
        assertEquals(sha(f1), sha(File(pb.inbox, "Mix/song.mp3")))
        assertEquals(0L, File(pb.inbox, "Mix/empty.txt").length())
        assertTrue(b.settings.getJSONObject("trusted").has(a.settings.getString("id")))

        // trusted now: auto-accepted, and decline path via a text message
        var got: String? = null
        b.onText = { _, t -> got = t }
        a.localAction("send-text", jo("deviceId" to dev.id, "text" to "hi from kotlin 🫧"))
        waitFor(what = "text") { got != null }
        assertEquals("hi from kotlin 🫧", got)
    }

    /** Runs only while desktop/test/interop-peer.js is running (it writes %TEMP%/bd-interop.json). */
    @Test
    fun kotlinAndNodeTalk() {
        val cfgFile = File(System.getProperty("java.io.tmpdir"), "bd-interop.json")
        assumeTrue("Node peer not running", cfgFile.isFile && System.currentTimeMillis() - cfgFile.lastModified() < 10 * 60_000)
        val cfg = JSONObject(cfgFile.readText())
        val nodePort = cfg.getInt("port")
        val nodeToken = cfg.getString("token")
        val nodeInbox = File(cfg.getString("inbox"))
        val (k, pk) = engine("K", 47995)

        // Android -> Windows
        val dev = k.connect("127.0.0.1:$nodePort")
        assertEquals("windows", dev.platform)
        val f = sample("from-android.bin", 5_000_000)
        k.addSelection(listOf(SelItem(Ids.new(), f.name, "Phone/${f.name}", f.length(), path = f.path)))
        val sid = k.send(dev.id)
        waitFor(what = "k->node") { k.transfers[sid]?.active == false }
        assertEquals(k.transfers[sid]?.error, "done", k.transfers[sid]?.status)
        assertEquals(sha(f), sha(File(nodeInbox, "Phone/from-android.bin")))

        // Windows -> Android, driven through the Node engine's own local API
        fun local(op: String, body: JSONObject) = requestJson("POST", "127.0.0.1", nodePort, "/local/$op", body, 10_000) { it.setRequestProperty("x-bd-token", nodeToken) }
        val nf = File(cfg.getString("sample"))
        val kdev = local("connect", jo("address" to "127.0.0.1:${k.port}")).getJSONObject("device")
        local("add-paths", jo("paths" to JSONArray().put(nf.path)))
        local("send", jo("deviceId" to kdev.getString("id")))
        waitFor(what = "node offer") { k.pending.size == 1 }
        k.localAction("respond", jo("rid" to k.pending.keys.first(), "accept" to true))
        waitFor(what = "node->k") { File(pk.inbox, nf.name).let { it.isFile && it.length() == nf.length() } && k.transfers.values.none { it.active } }
        assertEquals(sha(nf), sha(File(pk.inbox, nf.name)))
    }
}
