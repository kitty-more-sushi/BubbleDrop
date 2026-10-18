package app.bubbledrop.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.net.DatagramPacket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.URL
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

const val PROTO = 1
const val APP = "BubbleDrop"
const val VERSION = "1.0.0"
const val DEFAULT_PORT = 47888
const val UDP_PORT = 47889
const val MCAST = "239.255.42.99"
private const val ANNOUNCE_MS = 2500L
private const val DEVICE_TTL = 9000L
private const val OFFER_WAIT = 90_000L
private const val PARALLEL = 3
private const val STALL_MS = 60_000
private const val HISTORY_MAX = 500

private val AVATARS = listOf("🍓", "🫧", "🦄", "🐱", "🍒", "🌸", "🐰", "🍭", "🎀", "🐼", "🦊", "🍑")
private val COLORS = listOf("#ff6fae", "#b28dff", "#6fd3ff", "#7ef0c1", "#ffb86b", "#ff8080")
private val HEX = Regex("^#[0-9a-fA-F]{6}$")

private fun now() = System.currentTimeMillis()

class TItem(val fid: String, val name: String, val rel: String, @Volatile var size: Long, val mime: String, val src: SelItem? = null) {
    @Volatile var state = "pending"
    @Volatile var loc = ""
}

class Transfer(val sid: String, val dir: String, val peer: JSONObject, val ctoken: String, val items: List<TItem>, val text: String) {
    @Volatile var status = "waiting"
    @Volatile var active = true
    @Volatile var cancelled = false
    val bytes = AtomicLong()
    @Volatile var total = items.sumOf { it.size }
    @Volatile var speed = 0.0
    @Volatile var current = ""
    @Volatile var error = ""
    val created = now()
    @Volatile var ended = 0L
    @Volatile var lastActivity = created
    var peerSid = ""
    var peerToken = ""
    @Volatile var remoteSid: String? = null
    @Volatile var remoteToken: String? = null
    var saveDir = ""
    val conns: MutableSet<Closeable> = ConcurrentHashMap.newKeySet()
    val byFid = items.associateBy { it.fid }
    var lastT = 0L
    var lastB = 0L
}

class Device(
    val id: String, var name: String, var platform: String, var avatar: String, var color: String,
    var ip: String, var port: Int, @Volatile var lastSeen: Long, var source: String,
) {
    @Volatile var fails = 0
    @Volatile var pinging = false
    fun json() = jo("id" to id, "name" to name, "platform" to platform, "avatar" to avatar, "color" to color, "ip" to ip, "port" to port)
}

class Pending(val rid: String, val from: JSONObject, val items: List<TItem>, val total: Long, val text: String) {
    val ts = now()
    val decision = CompletableFuture<JSONObject>()
}

private class Sse(val out: OutputStream) {
    @Volatile var closed = false
    @Synchronized fun write(s: String) {
        if (closed) return
        try {
            out.write(s.toByteArray(Charsets.UTF_8))
            out.flush()
        } catch (e: IOException) {
            closed = true
        }
    }
}

/**
 * BubbleDrop engine for Android (and JVM tests): the same protocol and local UI API as
 * desktop/core/engine.js. See PROTOCOL.md.
 */
class Engine(val platform: Platform, private val preferredPort: Int = DEFAULT_PORT, private val discovery: Boolean = true) {
    val token = Ids.new(18)
    private val lock = Any()
    lateinit var settings: JSONObject
        private set
    private var history = mutableListOf<JSONObject>()
    @Volatile var historyRev = 0
        private set
    val devices = ConcurrentHashMap<String, Device>()
    val selection = CopyOnWriteArrayList<SelItem>()
    val transfers = ConcurrentHashMap<String, Transfer>()
    val pending = ConcurrentHashMap<String, Pending>()
    private val sse = CopyOnWriteArrayList<Sse>()
    private val http = MiniHttpServer(::handle)
    val port: Int get() = http.port
    private val sched = Executors.newScheduledThreadPool(2) { r -> Thread(r, "bd-sched").apply { isDaemon = true } }
    private val workers = Executors.newCachedThreadPool { r -> Thread(r, "bd-work").apply { isDaemon = true } }
    private val dirty = AtomicBoolean(false)
    @Volatile private var scanning = false
    @Volatile private var udp: MulticastSocket? = null
    private val joined = HashSet<String>()
    @Volatile var started = false
        private set
    var onText: ((JSONObject, String) -> Unit)? = null

    // web share
    @Volatile private var webEnabled = false
    @Volatile private var webPin = ""
    private val webCookies = ConcurrentHashMap.newKeySet<String>()
    private val webFails = ConcurrentHashMap<String, LongArray>()

    private val settingsFile get() = File(platform.dataDir, "settings.json")
    private val historyFile get() = File(platform.dataDir, "history.json")

    // ---------- lifecycle ----------

    fun start() {
        System.setProperty("http.keepAlive", "false")
        platform.dataDir.mkdirs()
        val s = try { JSONObject(settingsFile.readText()) } catch (e: Exception) { JSONObject() }
        settings = JSONObject().apply {
            put("id", s.optString("id").ifEmpty { UUID.randomUUID().toString() })
            put("name", s.optString("name").ifEmpty { platform.defaultName() })
            put("avatar", s.optString("avatar").ifEmpty { AVATARS.random() })
            put("color", s.optString("color").ifEmpty { COLORS.random() })
            put("theme", s.optString("theme").ifEmpty { "dark" })
            put("autoAcceptTrusted", s.optBoolean("autoAcceptTrusted", true))
            put("acceptAll", s.optBoolean("acceptAll", false))
            put("trusted", s.optJSONObject("trusted") ?: JSONObject())
            put("notifications", s.optBoolean("notifications", true))
            put("bubbles", s.optBoolean("bubbles", true))
            put("minimizeToTray", true)
        }
        history = try {
            val a = JSONArray(historyFile.readText())
            MutableList(a.length()) { a.getJSONObject(it) }
        } catch (e: Exception) { mutableListOf() }
        saveSettings()
        http.start(preferredPort)
        if (discovery) startDiscovery()
        sched.scheduleAtFixedRate({ safe { tick() } }, 1, 1, TimeUnit.SECONDS)
        sched.scheduleAtFixedRate({ if (dirty.getAndSet(false)) safe { broadcast(jo("type" to "state", "state" to snapshot())) } }, 120, 120, TimeUnit.MILLISECONDS)
        started = true
        platform.onSettings(settings)
    }

    fun stop() {
        started = false
        try { announce("bye") } catch (_: Exception) {}
        try { udp?.close() } catch (_: Exception) {}
        platform.multicast(false)
        for (t in transfers.values) if (t.active) cancelTransfer(t, true, "Cancelled")
        sse.forEach { it.closed = true; try { it.out.close() } catch (_: Exception) {} }
        http.stop()
        sched.shutdownNow()
        workers.shutdownNow()
        flushHistory()
    }

    private inline fun safe(block: () -> Unit) {
        try { block() } catch (e: Throwable) { platform.log("engine error", e) }
    }

    private fun saveSettings() = synchronized(lock) {
        try { settingsFile.writeText(settings.toString(2)) } catch (e: Exception) { platform.log("settings save failed", e) }
    }

    private fun saveHistorySoon() {
        historyRev++
        sched.schedule({ flushHistory() }, 400, TimeUnit.MILLISECONDS)
        changed()
    }

    private fun flushHistory() = synchronized(lock) {
        try { historyFile.writeText(JSONArray(history.take(HISTORY_MAX)).toString()) } catch (e: Exception) { platform.log("history save failed", e) }
    }

    fun info(): JSONObject = jo(
        "bd" to PROTO, "app" to APP, "version" to VERSION, "id" to settings.getString("id"), "name" to settings.getString("name"),
        "platform" to platform.platformName, "avatar" to settings.getString("avatar"), "color" to settings.getString("color"), "port" to port,
    )

    // ---------- state to UI ----------

    fun changed() = dirty.set(true)

    private fun trusted(): JSONObject = settings.getJSONObject("trusted")

    fun snapshot(): JSONObject = synchronized(lock) {
        val list = transfers.values.sortedByDescending { it.created }.take(40)
        val ips = localIPv4s()
        val caps = jo("dragDrop" to false, "pickFolder" to true, "pickMedia" to false, "apps" to false, "hotspot" to false, "joinWifi" to false, "scanQr" to false, "chooseSaveDir" to false, "tray" to false)
        val pc = platform.caps()
        for (k in pc.keys()) caps.put(k, pc.get(k))
        val sel = selection.toList()
        jo(
            "me" to info().put("ips", JSONArray(ips.map { it.address })),
            "caps" to caps,
            "settings" to JSONObject(settings.toString()).put("saveDir", platform.saveDirLabel()),
            "devices" to JSONArray(devices.values.sortedBy { it.name.lowercase() }.map { d ->
                d.json().put("lastSeen", d.lastSeen).put("source", d.source).put("trusted", trusted().has(d.id)).put("busy", list.any { it.active && it.peer.optString("id") == d.id })
            }),
            "selection" to jo(
                "items" to JSONArray(sel.take(300).map { jo("id" to it.id, "name" to it.name, "size" to it.size, "rel" to it.rel, "kind" to it.kind, "icon" to it.icon) }),
                "count" to sel.size, "total" to sel.sumOf { it.size },
            ),
            "transfers" to JSONArray(list.map { publicTransfer(it) }),
            "incoming" to JSONArray(pending.values.sortedBy { it.ts }.map { p ->
                jo("rid" to p.rid, "from" to p.from, "total" to p.total, "ts" to p.ts, "count" to p.items.size, "text" to p.text,
                    "items" to JSONArray(p.items.take(60).map { jo("fid" to it.fid, "name" to it.name, "rel" to it.rel, "size" to it.size) }))
            }),
            "webshare" to jo("enabled" to webEnabled, "pin" to webPin, "urls" to JSONArray(ips.map { "http://${it.address}:$port/" })),
            "hotspot" to platform.hotspotState(),
            "historyRev" to historyRev,
            "scanning" to scanning,
        )
    }

    private fun publicTransfer(t: Transfer) = jo(
        "sid" to t.sid, "dir" to t.dir, "peer" to t.peer, "status" to t.status, "active" to t.active, "error" to t.error,
        "total" to t.total, "bytes" to t.bytes.get(), "count" to t.items.size, "done" to t.items.count { it.state == "done" },
        "current" to t.current, "speed" to t.speed.toLong(), "text" to t.text.take(200),
        "names" to JSONArray(t.items.take(4).map { it.name }), "created" to t.created, "ended" to t.ended,
    )

    private fun broadcast(ev: JSONObject) {
        val line = "data: $ev\n\n"
        for (c in sse) {
            c.write(line)
            if (c.closed) sse.remove(c)
        }
    }

    fun toast(msg: String, kind: String = "info") = broadcast(jo("type" to "toast", "msg" to msg, "kind" to kind))

    // ---------- HTTP routing ----------

    private fun isLocal(req: HttpRequest): Boolean {
        val host = (req.headers["host"] ?: "").lowercase()
        return req.remoteIp == "127.0.0.1" && Regex("^(127\\.0\\.0\\.1|localhost)(:\\d+)?$").matches(host)
    }

    private fun err(msg: String?) = jo("error" to (msg ?: "error"))

    private fun handle(req: HttpRequest, res: HttpResponse) {
        val p = req.path
        try {
            when {
                p.startsWith("/api/v1/") -> routePeer(req, res, p.removePrefix("/api/v1/"))
                p.startsWith("/local/") -> {
                    if (!isLocal(req)) throw HttpError(403, "forbidden")
                    val tok = req.headers["x-bd-token"] ?: req.query["t"]
                    if (tok != token) throw HttpError(401, "bad token")
                    routeLocal(req, res, p.removePrefix("/local/"))
                }
                p == "/ui" || p == "/ui/" || p == "/ui/index.html" -> {
                    if (!isLocal(req)) throw HttpError(403, "forbidden")
                    val html = platform.webAsset("index.html") ?: throw HttpError(404, "UI missing")
                    res.send(200, "text/html; charset=utf-8", String(html, Charsets.UTF_8).replace("__BD_TOKEN__", token).toByteArray(), mapOf("Cache-Control" to "no-store"))
                }
                p.startsWith("/static/") -> serveStatic(res, p.removePrefix("/static/"))
                p.startsWith("/web/") -> routeWeb(req, res, p.removePrefix("/web/"))
                p == "/" || p == "/index.html" -> serveStatic(res, "share.html")
                p == "/favicon.ico" -> serveStatic(res, "icon.png")
                else -> throw HttpError(404, "not found")
            }
        } catch (e: HttpError) {
            if (!res.sent) res.json(e.status, err(e.message))
        } catch (e: Exception) {
            platform.log("route $p failed", e)
            if (!res.sent) try { res.json(500, err(e.message)) } catch (_: Exception) {}
        }
    }

    private val assetCache = ConcurrentHashMap<String, ByteArray>()

    private fun serveStatic(res: HttpResponse, rel: String) {
        if (rel.contains("..") || rel.startsWith("/")) throw HttpError(403, "forbidden")
        val bytes = assetCache[rel] ?: platform.webAsset(rel)?.also { assetCache[rel] = it } ?: throw HttpError(404, "not found")
        res.send(200, mimeOf(rel), bytes, mapOf("Cache-Control" to "no-cache"))
    }

    // ---------- peer API ----------

    private fun routePeer(req: HttpRequest, res: HttpResponse, op: String) {
        when {
            op == "info" && req.method == "GET" -> res.json(200, info())
            op == "offer" && req.method == "POST" -> onOffer(req, res, req.json())
            op == "file" && req.method == "PUT" -> onFile(req, res)
            op == "cancel" && req.method == "POST" -> {
                val b = req.json()
                val t = transfers[b.optString("sid")]
                if (t == null || t.ctoken != b.optString("token")) throw HttpError(403, "unknown transfer")
                cancelTransfer(t, false, if (t.dir == "in") "Sender cancelled" else "Receiver cancelled")
                res.json(200, jo("ok" to true))
            }
            else -> throw HttpError(404, "unknown call")
        }
    }

    private fun peerFromOffer(req: HttpRequest, from: JSONObject): JSONObject {
        val ip = req.remoteIp.removePrefix("::ffff:")
        val color = from.optString("color")
        return jo(
            "id" to from.optString("id", ip).take(64), "name" to from.optString("name", "Unknown").take(60),
            "platform" to from.optString("platform", "unknown").take(20), "avatar" to from.optString("avatar", "📱").take(8),
            "color" to (if (HEX.matches(color)) color else "#b28dff"), "ip" to ip, "port" to from.optInt("port", DEFAULT_PORT),
        )
    }

    private fun onOffer(req: HttpRequest, res: HttpResponse, b: JSONObject) {
        val from = b.optJSONObject("from") ?: throw HttpError(400, "bad offer")
        val peer = peerFromOffer(req, from)
        upsertDevice(peer, "offer")
        val arr = b.optJSONArray("items") ?: JSONArray()
        val items = (0 until minOf(arr.length(), 100_000)).map { i ->
            val o = arr.getJSONObject(i)
            val name = safeName(o.optString("name"))
            TItem(o.optString("fid"), name, safeRel(o.optString("rel"), name).joinToString("/"), maxOf(0L, o.optLong("size")), o.optString("mime").ifEmpty { mimeOf(name) })
        }
        val text = b.optString("text", "").take(100_000)
        val total = items.sumOf { it.size }

        if (items.isEmpty()) {
            if (text.isEmpty()) throw HttpError(400, "empty offer")
            addHistory(jo("dir" to "in", "peer" to peer, "status" to "done", "text" to text, "items" to JSONArray(), "total" to 0))
            broadcast(jo("type" to "text", "from" to peer, "text" to text))
            notify("💬 Message from ${peer.getString("name")}", text.take(120), jo())
            onText?.invoke(peer, text)
            res.json(200, jo("accept" to true))
            return
        }

        val s = settings
        val auto = s.optBoolean("acceptAll") || (s.optBoolean("autoAcceptTrusted") && trusted().has(peer.getString("id")))
        var decision = jo("accept" to true)
        if (!auto) {
            val p = Pending(Ids.new(), peer, items, total, text)
            pending[p.rid] = p
            changed()
            broadcast(jo("type" to "offer", "rid" to p.rid))
            val what = if (items.size == 1) items[0].name else "${items.size} files"
            notify("${peer.getString("avatar")} ${peer.getString("name")} wants to send you $what", "${fmtSize(total)} · tap to accept", jo("rid" to p.rid))
            val deadline = now() + OFFER_WAIT
            while (true) {
                val d = try { p.decision.get(400, TimeUnit.MILLISECONDS) } catch (e: TimeoutException) { null }
                if (d != null) { decision = d; break }
                if (now() > deadline) { decision = jo("accept" to false, "reason" to "No answer"); break }
                if (req.clientGone()) { decision = jo("accept" to false, "reason" to "gone"); break }
            }
            pending.remove(p.rid)
            platform.cancelNotification("offer-" + p.rid)
            changed()
            if (decision.optBoolean("trust")) trust(peer.getString("id"), peer.getString("name"))
        }
        if (!decision.optBoolean("accept")) {
            res.json(200, jo("accept" to false, "reason" to decision.optString("reason", "Declined")))
            return
        }
        val sid = Ids.new()
        val tok = Ids.new(18)
        val t = Transfer(sid, "in", peer, tok, items, text)
        t.peerSid = b.optString("sid")
        t.peerToken = b.optString("ctoken")
        t.status = "transferring"
        t.saveDir = platform.saveDirLabel()
        transfers[sid] = t
        platform.onBusy(true)
        changed()
        res.json(200, jo("accept" to true, "sid" to sid, "token" to tok))
    }

    private fun onFile(req: HttpRequest, res: HttpResponse) {
        val t = transfers[req.query["sid"]]
        if (t == null || t.dir != "in" || t.ctoken != req.query["token"]) throw HttpError(403, "bad session")
        if (!t.active) throw HttpError(410, "cancelled")
        val item = t.byFid[req.query["fid"]] ?: throw HttpError(409, "bad item")
        synchronized(item) {
            if (item.state == "done" || item.state == "receiving") throw HttpError(409, "bad item")
            item.state = "receiving"
        }
        val len = req.contentLength
        if (len != item.size) { item.state = "pending"; throw HttpError(400, "size mismatch") }
        t.current = item.name
        val closer = Closeable { try { req.socket.close() } catch (_: Exception) {} }
        t.conns.add(closer)
        var got = 0L
        var sink: Sink? = null
        try {
            sink = platform.createSink(safeRel(item.rel, item.name), item.mime)
            val buf = ByteArray(256 * 1024)
            sink.out.use { out ->
                while (got < len) {
                    val n = req.body.read(buf, 0, minOf(buf.size.toLong(), len - got).toInt())
                    if (n < 0) break
                    out.write(buf, 0, n)
                    got += n
                    t.bytes.addAndGet(n.toLong())
                    t.lastActivity = now()
                }
            }
            if (got != len) throw IOException("incomplete")
            item.loc = sink.commit()
            item.state = "done"
            res.json(200, jo("ok" to true))
        } catch (e: Exception) {
            item.state = "failed"
            t.bytes.addAndGet(-got)
            try { sink?.abort() } catch (_: Exception) {}
            if (!res.sent) try { res.json(if (t.active) 500 else 410, err(if (t.active) "write failed" else "cancelled")) } catch (_: Exception) {}
        } finally {
            t.conns.remove(closer)
            checkIncomingDone(t)
            changed()
        }
    }

    private fun checkIncomingDone(t: Transfer) {
        if (!t.active || t.items.any { it.state == "pending" || it.state == "receiving" }) return
        val ok = t.items.count { it.state == "done" }
        finish(t, if (ok == t.items.size) "done" else if (ok > 0) "partial" else "failed", if (ok == t.items.size) "" else "${t.items.size - ok} file(s) failed")
    }

    private fun finish(t: Transfer, status: String, error: String = "", closeConns: Boolean = true) {
        synchronized(t) {
            if (!t.active) return
            t.active = false
        }
        t.status = status
        t.error = error
        t.ended = now()
        t.speed = 0.0
        t.current = ""
        if (closeConns) for (c in t.conns.toList()) try { c.close() } catch (_: Exception) {}
        val items = t.items.filter { t.dir == "out" || it.state == "done" }
        if (t.text.isNotEmpty() || items.isNotEmpty() || status != "cancelled") {
            addHistory(jo(
                "dir" to t.dir, "peer" to t.peer, "status" to status, "error" to error, "text" to t.text, "saveDir" to t.saveDir,
                "items" to JSONArray(items.map { jo("name" to it.name, "rel" to it.rel, "size" to it.size, "loc" to (if (t.dir == "in") it.loc else "")) }),
                "total" to items.sumOf { it.size },
            ))
        }
        val name = t.peer.optString("name")
        if (t.dir == "in" && (status == "done" || status == "partial")) {
            val what = if (items.size == 1) items[0].name else "${items.size} files"
            notify("✨ Received $what", "from $name · ${fmtSize(items.sumOf { it.size })}", jo("loc" to (items.firstOrNull()?.loc ?: ""), "mime" to (items.firstOrNull()?.mime ?: "")))
            toast("Received $what from $name", "success")
        } else if (t.dir == "out" && status == "done") {
            toast("Sent to $name 🎉", "success")
        }
        if (transfers.values.none { it.active }) {
            platform.onBusy(false)
            platform.onStatus(null)
        }
        changed()
    }

    fun cancelTransfer(t: Transfer, tellPeer: Boolean = true, why: String = "Cancelled") {
        if (!t.active) return
        val conns = t.conns.toList()
        val dev = devices[t.peer.optString("id")]
        val ip = dev?.ip ?: t.peer.optString("ip")
        val port = dev?.port ?: t.peer.optInt("port", DEFAULT_PORT)
        val body = if (t.dir == "in") jo("sid" to t.peerSid, "token" to t.peerToken) else t.remoteSid?.let { jo("sid" to it, "token" to t.remoteToken) }
        t.cancelled = true
        finish(t, "cancelled", why, closeConns = false)
        val kill = { for (c in conns) try { c.close() } catch (_: Exception) {} }
        if (tellPeer && body != null && body.optString("sid").isNotEmpty()) {
            workers.execute {
                try { requestJson("POST", ip, port, "/api/v1/cancel", body, 1500) } catch (_: Exception) {}
                kill()
            }
        } else kill()
    }

    // ---------- sending ----------

    fun send(deviceId: String, items: List<SelItem>? = null, text: String? = null): String {
        val dev = devices[deviceId] ?: throw HttpError(404, "That device is gone. Try refreshing.")
        val list = items ?: selection.toList()
        if (list.isEmpty() && text.isNullOrEmpty()) throw HttpError(400, "Pick something to send first")
        if (items == null && text == null) selection.clear()
        val t = Transfer(Ids.new(), "out", dev.json(), Ids.new(18), list.map { TItem(it.id, it.name, it.rel.ifEmpty { it.name }, it.size, mimeOf(it.name), it) }, text ?: "")
        transfers[t.sid] = t
        platform.onBusy(true)
        changed()
        workers.execute { runSend(t, dev) }
        return t.sid
    }

    private fun runSend(t: Transfer, dev: Device) {
        try {
            for (i in t.items) i.size = platform.sizeOf(i.src!!)
            t.total = t.items.sumOf { it.size }
            val offer = jo(
                "bd" to PROTO, "from" to info(), "sid" to t.sid, "ctoken" to t.ctoken, "text" to t.text.ifEmpty { null },
                "items" to JSONArray(t.items.map { jo("fid" to it.fid, "name" to it.name, "rel" to it.rel, "size" to it.size, "mime" to it.mime) }),
            )
            if (offer.isNull("text")) offer.remove("text")
            val resp = requestJson("POST", dev.ip, dev.port, "/api/v1/offer", offer, (OFFER_WAIT + 15_000).toInt()) { c -> t.conns.add(Closeable { c.disconnect() }) }
            if (!t.active) return
            if (!resp.optBoolean("accept")) {
                val r = resp.optString("reason")
                finish(t, "declined", if (r == "gone") "Cancelled" else r.ifEmpty { "Declined" })
                return
            }
            if (t.items.isEmpty()) { finish(t, "done"); return }
            t.remoteSid = resp.getString("sid")
            t.remoteToken = resp.getString("token")
            t.status = "transferring"
            changed()
            val queue = ConcurrentLinkedQueue(t.items)
            val n = minOf(PARALLEL, queue.size)
            val latch = CountDownLatch(n)
            var firstErr: Exception? = null
            repeat(n) {
                workers.execute {
                    try {
                        while (t.active) {
                            val item = queue.poll() ?: break
                            upload(t, dev, item)
                        }
                    } catch (e: Exception) {
                        synchronized(t) { if (firstErr == null) firstErr = e }
                        for (c in t.conns.toList()) try { c.close() } catch (_: Exception) {}
                    } finally {
                        latch.countDown()
                    }
                }
            }
            latch.await()
            firstErr?.let { throw it }
            if (t.active) finish(t, "done")
        } catch (e: Exception) {
            if (!t.active) return
            val st = (e as? NetError)?.status ?: 0
            finish(t, if (st == 410) "cancelled" else "failed", if (st == 410) "Receiver cancelled" else friendly(e))
        }
    }

    private fun upload(t: Transfer, dev: Device, item: TItem) {
        val q = "sid=" + enc(t.remoteSid!!) + "&token=" + enc(t.remoteToken!!) + "&fid=" + enc(item.fid)
        val c = URL("http", dev.ip, dev.port, "/api/v1/file?$q").openConnection() as HttpURLConnection
        c.requestMethod = "PUT"
        c.doOutput = true
        c.useCaches = false
        c.connectTimeout = 8000
        c.readTimeout = STALL_MS
        c.setFixedLengthStreamingMode(item.size)
        c.setRequestProperty("Content-Type", "application/octet-stream")
        val closer = Closeable { c.disconnect() }
        t.conns.add(closer)
        item.state = "sending"
        t.current = item.name
        var sent = 0L
        try {
            platform.openInput(item.src!!).use { inp ->
                c.outputStream.use { out ->
                    val buf = ByteArray(256 * 1024)
                    while (true) {
                        if (!t.active) throw IOException("cancelled")
                        val n = inp.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        sent += n
                        t.bytes.addAndGet(n.toLong())
                    }
                }
            }
            val code = c.responseCode
            val txt = (if (code >= 400) c.errorStream else c.inputStream)?.use { String(it.readBytes(), Charsets.UTF_8) } ?: ""
            if (code != 200) throw NetError(try { JSONObject(txt).optString("error", "HTTP $code") } catch (e: Exception) { "HTTP $code" }, code)
            item.state = "done"
        } catch (e: Exception) {
            t.bytes.addAndGet(-sent)
            item.state = "failed"
            throw e
        } finally {
            t.conns.remove(closer)
            c.disconnect()
            changed()
        }
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    // ---------- selection ----------

    fun addSelection(items: List<SelItem>): Int {
        val have = selection.mapNotNull { it.uri ?: it.path }.toHashSet()
        val fresh = items.filter { (it.uri ?: it.path) == null || (it.uri ?: it.path) !in have }
        selection.addAll(fresh)
        changed()
        return fresh.size
    }

    // ---------- web share ----------

    private fun webAuthed(req: HttpRequest): Boolean {
        val m = Regex("(?:^|;\\s*)bdweb=([\\w-]+)").find(req.headers["cookie"] ?: "") ?: return false
        return webCookies.contains(m.groupValues[1])
    }

    private fun routeWeb(req: HttpRequest, res: HttpResponse, op: String) {
        if (op == "status") {
            res.json(200, jo("enabled" to webEnabled, "name" to settings.getString("name"), "avatar" to settings.getString("avatar"), "authed" to webAuthed(req)))
            return
        }
        if (!webEnabled) throw HttpError(403, "Web share is off on this device")
        if (op == "auth" && req.method == "POST") {
            val f = webFails.getOrPut(req.remoteIp) { longArrayOf(0, 0) }
            if (f[1] > now()) throw HttpError(429, "Too many tries. Wait a minute.")
            val b = req.json()
            if (b.optString("pin") != webPin) {
                f[0]++
                if (f[0] >= 5) { f[1] = now() + 60_000; f[0] = 0 }
                throw HttpError(401, "Wrong PIN")
            }
            val c = Ids.new(18)
            webCookies.add(c)
            res.json(200, jo("ok" to true), mapOf("Set-Cookie" to "bdweb=$c; Path=/; HttpOnly; SameSite=Strict"))
            return
        }
        if (!webAuthed(req)) throw HttpError(401, "PIN required")
        when {
            op == "files" -> res.json(200, jo("files" to JSONArray(selection.map { jo("id" to it.id, "name" to it.name, "size" to it.size, "rel" to it.rel) })))
            op == "dl" -> {
                val item = selection.find { it.id == req.query["id"] } ?: throw HttpError(404, "gone")
                val size = platform.sizeOf(item)
                val out = res.stream(200, mimeOf(item.name), size, mapOf("Content-Disposition" to "attachment; filename*=UTF-8''" + URLEncoder.encode(item.name, "UTF-8").replace("+", "%20")))
                platform.openInput(item).use { it.copyTo(out, 256 * 1024) }
                out.flush()
            }
            op == "upload" && req.method == "POST" -> {
                val name = safeName(req.query["name"])
                val rel = safeRel(req.query["rel"] ?: name, name)
                val len = req.contentLength
                if (len < 0) throw HttpError(411, "Content-Length required")
                val sink = platform.createSink(rel, mimeOf(name))
                var got = 0L
                val loc: String
                try {
                    sink.out.use { out ->
                        val buf = ByteArray(256 * 1024)
                        while (got < len) {
                            val n = req.body.read(buf, 0, minOf(buf.size.toLong(), len - got).toInt())
                            if (n < 0) break
                            out.write(buf, 0, n)
                            got += n
                        }
                    }
                    if (got != len) throw IOException("incomplete")
                    loc = sink.commit()
                } catch (e: Exception) {
                    try { sink.abort() } catch (_: Exception) {}
                    throw HttpError(500, "Upload failed")
                }
                val ip = req.remoteIp
                val batch = req.query["b"] ?: Ids.new()
                val it = jo("name" to name, "rel" to rel.joinToString("/"), "size" to got, "loc" to loc)
                synchronized(lock) {
                    val existing = history.find { h -> h.optString("batch") == batch }
                    if (existing != null) {
                        existing.getJSONArray("items").put(it)
                        existing.put("total", existing.optLong("total") + got)
                    }
                    existing
                }?.let { saveHistorySoon() } ?: addHistory(jo(
                    "dir" to "in", "status" to "done", "items" to JSONArray().put(it), "total" to got, "batch" to batch, "saveDir" to platform.saveDirLabel(),
                    "peer" to jo("id" to "web:$ip", "name" to "Browser ($ip)", "platform" to "web", "avatar" to "🌐", "color" to "#6fd3ff"),
                ))
                toast("Received $name from a browser", "success")
                res.json(200, jo("ok" to true))
            }
            else -> throw HttpError(404, "unknown")
        }
    }

    // ---------- history ----------

    private fun addHistory(h: JSONObject) {
        val peer = h.getJSONObject("peer")
        h.put("id", Ids.new()).put("ts", now())
        h.put("peer", jo("name" to peer.optString("name"), "platform" to peer.optString("platform"), "avatar" to peer.optString("avatar"), "color" to peer.optString("color")))
        synchronized(lock) {
            history.add(0, h)
            while (history.size > HISTORY_MAX) history.removeAt(history.size - 1)
        }
        saveHistorySoon()
    }

    private fun notify(title: String, body: String, extra: JSONObject) {
        if (settings.optBoolean("notifications", true)) try { platform.notify(title, body, extra) } catch (e: Exception) { platform.log("notify failed", e) }
    }

    // ---------- local UI API ----------

    private fun routeLocal(req: HttpRequest, res: HttpResponse, op: String) {
        when (op) {
            "events" -> {
                val out = res.stream(200, "text/event-stream", -1, mapOf("Cache-Control" to "no-store"))
                val c = Sse(out)
                sse.add(c)
                c.write("data: ${jo("type" to "state", "state" to snapshot())}\n\n")
                try {
                    while (!c.closed && started) {
                        Thread.sleep(15_000)
                        c.write(": hb\n\n")
                    }
                } catch (_: InterruptedException) {
                } finally {
                    sse.remove(c)
                }
                return
            }
            "state" -> return res.json(200, snapshot())
            "history" -> return res.json(200, synchronized(lock) { jo("rev" to historyRev, "items" to JSONArray(history.map { JSONObject(it.toString()) })) })
            "appicon" -> {
                val png = platform.appIcon(req.query["pkg"] ?: "") ?: throw HttpError(404, "no icon")
                return res.send(200, "image/png", png, mapOf("Cache-Control" to "max-age=3600"))
            }
        }
        val b = if (req.method == "POST") req.json() else JSONObject()
        res.json(200, localAction(op, b) ?: jo("ok" to true))
    }

    fun localAction(op: String, b: JSONObject): JSONObject? {
        val s = settings
        when (op) {
            "pick" -> return jo("added" to addSelection(platform.pick(b.optString("kind", "files"))))
            "unselect" -> { selection.removeAll { it.id == b.optString("id") }; changed() }
            "clear-selection" -> { selection.clear(); changed() }
            "send" -> return jo("sid" to send(b.optString("deviceId")))
            "send-text" -> {
                val text = b.optString("text").trim()
                if (text.isEmpty()) throw HttpError(400, "Type something first")
                return jo("sid" to send(b.optString("deviceId"), emptyList(), text))
            }
            "respond" -> pending[b.optString("rid")]?.decision?.complete(jo("accept" to b.optBoolean("accept"), "trust" to b.optBoolean("trust"), "reason" to if (b.optBoolean("accept")) "" else "Declined"))
            "cancel" -> transfers[b.optString("sid")]?.let { cancelTransfer(it) }
            "retry" -> {
                val t = transfers[b.optString("sid")] ?: return null
                if (t.dir != "out" || t.active) return null
                val id = t.peer.optString("id")
                if (devices[id] == null) throw HttpError(404, "${t.peer.optString("name")} is not nearby right now")
                val again = t.items.mapNotNull { it.src }.map { SelItem(Ids.new(), it.name, it.rel, it.size, it.kind, it.uri, it.path, it.icon) }
                return jo("sid" to send(id, again, t.text.ifEmpty { null }))
            }
            "dismiss" -> { transfers[b.optString("sid")]?.let { if (!it.active) transfers.remove(it.sid) }; changed() }
            "clear-finished" -> { transfers.values.filter { !it.active }.forEach { transfers.remove(it.sid) }; changed() }
            "connect" -> return jo("device" to connect(b.optString("address")).json())
            "scan" -> workers.execute { safe { scanNetwork() } }
            "refresh" -> workers.execute { safe { announce("hi") } }
            "settings" -> {
                synchronized(lock) {
                    for (k in listOf("name", "avatar", "color", "theme")) if (b.has(k)) s.put(k, b.optString(k).take(60))
                    for (k in listOf("autoAcceptTrusted", "acceptAll", "notifications", "bubbles", "minimizeToTray")) if (b.has(k)) s.put(k, b.optBoolean(k))
                    if (s.optString("name").isBlank()) s.put("name", platform.defaultName())
                }
                saveSettings()
                platform.onSettings(s)
                workers.execute { safe { announce("hi") } }
                changed()
            }
            "untrust" -> { trusted().remove(b.optString("id")); saveSettings(); changed() }
            "trust" -> trust(b.optString("id"), b.optString("name"))
            "webshare" -> {
                webEnabled = b.optBoolean("enabled")
                if (webEnabled) webPin = Ids.int(1000, 10000).toString() else webCookies.clear()
                changed()
            }
            "open" -> {
                val h = synchronized(lock) { history.find { it.optString("id") == b.optString("id") } } ?: return null
                val it = h.getJSONArray("items").optJSONObject(b.optInt("idx", 0))
                if (b.optBoolean("reveal") || it == null) platform.openFolder()
                else platform.open(it.optString("loc"), false)?.let { e -> throw HttpError(400, e) }
            }
            "open-folder" -> platform.openFolder()
            "history-remove" -> { synchronized(lock) { history.removeAll { it.optString("id") == b.optString("id") } }; saveHistorySoon() }
            "history-clear" -> { synchronized(lock) { history.clear() }; saveHistorySoon() }
            "copy" -> platform.copyText(b.optString("text"))
            else -> {
                val r = platform.action(op, b, this) ?: throw HttpError(404, "Unknown action $op")
                changed()
                return r
            }
        }
        return null
    }

    private fun trust(id: String, name: String) {
        if (id.isEmpty()) return
        synchronized(lock) { trusted().put(id, name.take(60).ifEmpty { id }) }
        saveSettings()
        changed()
    }

    // ---------- devices ----------

    private fun upsertDevice(d: JSONObject, source: String): Device? {
        val id = d.optString("id")
        if (id.isEmpty() || id == settings.getString("id")) return null
        val old = devices[id]
        val color = d.optString("color")
        val dev = Device(
            id, d.optString("name", "Device").take(60), d.optString("platform", "unknown").take(20), d.optString("avatar", "📱").take(8),
            if (HEX.matches(color)) color else "#b28dff", d.optString("ip"), d.optInt("port", DEFAULT_PORT), now(),
            if (old != null && old.source == "manual" && source != "udp") "manual" else source,
        )
        devices[id] = dev
        if (old == null || old.name != dev.name || old.ip != dev.ip || old.avatar != dev.avatar || old.color != dev.color) changed()
        return dev
    }

    fun connect(address: String): Device {
        val a = address.trim()
        val m = Regex("^(?:bubbledrop|http)://\\[?([\\w.:-]+?)]?(?::(\\d+))?(?:/.*)?$", RegexOption.IGNORE_CASE).find(a)
            ?: Regex("^([\\d.]+)(?::(\\d+))?$").find(a)
            ?: throw HttpError(400, "That does not look like an address. Try 192.168.1.20")
        val ip = m.groupValues[1]
        val port = m.groupValues[2].toIntOrNull() ?: DEFAULT_PORT
        val inf = try { requestJson("GET", ip, port, "/api/v1/info", null, 4000) } catch (e: Exception) { throw HttpError(502, friendly(e)) }
        if (inf.optString("app") != APP) throw HttpError(502, "That is not a BubbleDrop device")
        if (inf.optString("id") == settings.getString("id")) throw HttpError(400, "That is this device 🙂")
        val dev = upsertDevice(inf.put("ip", ip).put("port", port), "manual")!!
        toast("Connected to ${dev.name}", "success")
        return dev
    }

    private fun scanNetwork() {
        if (scanning) return
        scanning = true
        changed()
        try {
            val targets = mutableListOf<String>()
            for (a in localIPv4s().take(3)) {
                val prefix = maxOf(a.prefix, 24)
                val mask = if (prefix >= 32) 0xffffffffL else (0xffffffffL shl (32 - prefix)) and 0xffffffffL
                val net = ipToInt(a.address) and mask
                val count = 1L shl (32 - prefix)
                for (i in 1 until count - 1) {
                    val ip = intToIp(net + i)
                    if (ip != a.address) targets += ip
                }
            }
            val queue = ConcurrentLinkedQueue(targets)
            val found = AtomicLong()
            val pool = Executors.newFixedThreadPool(48)
            repeat(48) {
                pool.execute {
                    while (true) {
                        val ip = queue.poll() ?: break
                        try {
                            val inf = requestJson("GET", ip, DEFAULT_PORT, "/api/v1/info", null, 900)
                            if (inf.optString("app") == APP && inf.optString("id") != settings.getString("id")) {
                                upsertDevice(inf.put("ip", ip), "manual")
                                found.incrementAndGet()
                            }
                        } catch (_: Exception) {}
                    }
                }
            }
            pool.shutdown()
            pool.awaitTermination(2, TimeUnit.MINUTES)
            val n = found.get()
            toast(if (n > 0) "Found $n device${if (n > 1) "s" else ""}" else "No devices found. Make sure BubbleDrop is open on the other device.", if (n > 0) "success" else "info")
        } finally {
            scanning = false
            changed()
        }
    }

    private fun tick() {
        val t0 = now()
        for (d in devices.values.toList()) {
            if (transfers.values.any { it.active && it.peer.optString("id") == d.id }) { d.lastSeen = t0; continue }
            if (d.source == "manual") {
                if (t0 - d.lastSeen > 5000 && !d.pinging) {
                    d.pinging = true
                    workers.execute {
                        try {
                            requestJson("GET", d.ip, d.port, "/api/v1/info", null, 2500)
                            d.lastSeen = now(); d.fails = 0
                        } catch (e: Exception) {
                            if (++d.fails >= 3) { devices.remove(d.id); changed() }
                        } finally { d.pinging = false }
                    }
                }
            } else if (t0 - d.lastSeen > DEVICE_TTL) {
                devices.remove(d.id)
                changed()
            }
        }
        var status: String? = null
        for (t in transfers.values) {
            if (!t.active) continue
            val dt = (t0 - (if (t.lastT == 0L) t0 else t.lastT)) / 1000.0
            val b = t.bytes.get()
            if (dt > 0) {
                val inst = (b - t.lastB) / dt
                t.speed = if (t.speed > 0) t.speed * 0.6 + inst * 0.4 else inst
            }
            t.lastT = t0
            t.lastB = b
            if (t.dir == "in" && t.conns.isEmpty() && t0 - t.lastActivity > STALL_MS) {
                finish(t, if (t.items.any { it.state == "done" }) "partial" else "failed", "Sender stopped responding")
                continue
            }
            if (t.status == "transferring") {
                val pct = if (t.total > 0) (b * 100 / t.total) else 0
                status = "${if (t.dir == "in") "Receiving from" else "Sending to"} ${t.peer.optString("name")} · $pct% · ${fmtSize(t.speed.toLong())}/s"
            }
            changed()
        }
        platform.onStatus(status)
    }

    // ---------- discovery ----------

    private fun startDiscovery() {
        platform.multicast(true)
        val sock = MulticastSocket(null)
        sock.reuseAddress = true
        sock.broadcast = true
        sock.bind(InetSocketAddress(UDP_PORT))
        try { sock.timeToLive = 2 } catch (_: Exception) {}
        try { sock.loopbackMode = true } catch (_: Exception) {}
        udp = sock
        joinGroups()
        Thread({ receiveLoop(sock) }, "bd-udp").apply { isDaemon = true }.start()
        sched.scheduleAtFixedRate({ safe { joinGroups(); announce("hi") } }, 0, ANNOUNCE_MS, TimeUnit.MILLISECONDS)
    }

    private fun joinGroups() {
        val sock = udp ?: return
        val group = InetAddress.getByName(MCAST)
        for (a in localIPv4s()) {
            val key = a.ni.name + "/" + a.address
            if (!joined.add(key)) continue
            try { sock.joinGroup(InetSocketAddress(group, UDP_PORT), a.ni) } catch (_: Exception) {}
        }
    }

    private fun packet(t: String) = info().put("t", t).toString().toByteArray(Charsets.UTF_8)

    private fun announce(t: String) {
        val sock = udp ?: return
        val msg = packet(t)
        fun send(addr: InetAddress) = try { sock.send(DatagramPacket(msg, msg.size, addr, UDP_PORT)) } catch (_: Exception) {}
        val group = InetAddress.getByName(MCAST)
        for (a in localIPv4s()) {
            a.broadcast?.let { send(it) }
            try {
                sock.networkInterface = a.ni
                send(group)
            } catch (_: Exception) {}
        }
        send(InetAddress.getByName("255.255.255.255"))
    }

    private fun receiveLoop(sock: MulticastSocket) {
        val buf = ByteArray(4096)
        while (!sock.isClosed) {
            val pkt = DatagramPacket(buf, buf.size)
            try { sock.receive(pkt) } catch (e: IOException) { if (sock.isClosed) break else continue }
            safe {
                val m = JSONObject(String(pkt.data, pkt.offset, pkt.length, Charsets.UTF_8))
                if (m.optInt("bd") != PROTO) return@safe
                val id = m.optString("id")
                if (id.isEmpty() || id == settings.getString("id")) return@safe
                if (m.optString("t") == "bye") {
                    if (devices.remove(id) != null) changed()
                    return@safe
                }
                val isNew = !devices.containsKey(id)
                val from = pkt.address
                upsertDevice(m.put("ip", from.hostAddress), "udp")
                if (m.optString("t") == "hi" && isNew) {
                    val reply = packet("re")
                    sock.send(DatagramPacket(reply, reply.size, from, UDP_PORT))
                }
            }
        }
    }
}
