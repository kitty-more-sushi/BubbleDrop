package app.bubbledrop.core

import org.json.JSONObject
import java.io.IOException
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.URL
import java.security.SecureRandom
import java.util.Base64

object Ids {
    private val rnd = SecureRandom()
    fun new(n: Int = 9): String {
        val b = ByteArray(n)
        rnd.nextBytes(b)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    }
    fun int(from: Int, until: Int) = from + rnd.nextInt(until - from)
}

private val BAD_CHARS = Regex("[\\u0000-\\u001f<>:\"/\\\\|?*]")
private val RESERVED = Regex("^(con|prn|aux|nul|com\\d|lpt\\d)(\\..*)?$", RegexOption.IGNORE_CASE)

fun safeName(name: String?): String {
    var n = (name ?: "").replace(BAD_CHARS, "_").trimEnd('.', ' ').trim()
    if (n.isEmpty() || n == "." || n == "..") n = "file"
    if (RESERVED.matches(n)) n = "_$n"
    return n.take(180)
}

fun safeRel(rel: String?, name: String?): List<String> {
    val parts = (rel ?: name ?: "").split(Regex("[\\\\/]+")).filter { it.isNotEmpty() && it != "." && it != ".." }.map { safeName(it) }
    return if (parts.isEmpty()) listOf(safeName(name)) else parts.takeLast(12)
}

private val MIME = mapOf(
    "html" to "text/html; charset=utf-8", "css" to "text/css; charset=utf-8", "js" to "text/javascript; charset=utf-8",
    "json" to "application/json", "svg" to "image/svg+xml", "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg",
    "gif" to "image/gif", "webp" to "image/webp", "ico" to "image/x-icon", "woff2" to "font/woff2", "mp4" to "video/mp4",
    "mp3" to "audio/mpeg", "pdf" to "application/pdf", "txt" to "text/plain", "zip" to "application/zip",
    "apk" to "application/vnd.android.package-archive",
)

fun mimeOf(name: String): String = MIME[name.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"

fun fmtSize(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    var n = bytes.toDouble()
    val units = listOf("KB", "MB", "GB", "TB")
    var i = -1
    do { n /= 1024; i++ } while (n >= 1024 && i < units.size - 1)
    return (if (n < 10) String.format("%.1f", n) else String.format("%.0f", n)) + " " + units[i]
}

class LocalAddr(val name: String, val address: String, val prefix: Int, val broadcast: InetAddress?, val ni: NetworkInterface)

// Mobile-data, VPN and virtual interfaces never lead to a nearby device.
private val SKIP_IF = listOf("rmnet", "ccmni", "pdp", "v4-", "clat", "dummy", "tun", "ppp", "ipsec", "seth", "radio", "r_rmnet")
private val VIRTUAL = Regex("vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|tailscale|zerotier", RegexOption.IGNORE_CASE)

fun localIPv4s(): List<LocalAddr> {
    val out = mutableListOf<LocalAddr>()
    val nis = try { NetworkInterface.getNetworkInterfaces()?.toList() ?: emptyList() } catch (e: Exception) { emptyList() }
    for (ni in nis) {
        try {
            if (!ni.isUp || ni.isLoopback) continue
        } catch (e: Exception) { continue }
        val n = ni.name.lowercase()
        if (SKIP_IF.any { n.startsWith(it) }) continue
        for (ia in ni.interfaceAddresses) {
            val a = ia.address as? Inet4Address ?: continue
            if (a.isLinkLocalAddress || a.isLoopbackAddress) continue
            out += LocalAddr(ni.name, a.hostAddress ?: continue, ia.networkPrefixLength.toInt(), ia.broadcast, ni)
        }
    }
    fun rank(a: LocalAddr): Int {
        val ip = a.address
        var r = when {
            ip.startsWith("192.168.") -> 0
            ip.startsWith("10.") -> 1
            Regex("^172\\.(1[6-9]|2\\d|3[01])\\.").containsMatchIn(ip) -> 2
            else -> 3
        }
        if (VIRTUAL.containsMatchIn(a.name + " " + (a.ni.displayName ?: ""))) r += 10
        return r
    }
    return out.sortedBy { rank(it) }
}

fun ipToInt(ip: String): Long = ip.split('.').fold(0L) { acc, o -> (acc shl 8) + o.toLong() }
fun intToIp(n: Long): String = listOf(n shr 24 and 255, n shr 16 and 255, n shr 8 and 255, n and 255).joinToString(".")

class NetError(message: String, val status: Int = 0) : IOException(message)

fun friendly(e: Throwable): String = when {
    e is NetError -> e.message ?: "Error"
    e is ConnectException && (e.message ?: "").contains("refused", true) -> "BubbleDrop is not open on that device"
    e is ConnectException || e is NoRouteToHostException || e is SocketTimeoutException -> "Device not reachable. Are you on the same Wi-Fi or hotspot?"
    else -> (e.message ?: e.javaClass.simpleName).let { if (it.contains("reset", true) || it.contains("broken pipe", true) || it.contains("unexpected end", true)) "Connection lost" else it }
}

fun requestJson(method: String, ip: String, port: Int, path: String, body: JSONObject?, timeoutMs: Int, track: ((HttpURLConnection) -> Unit)? = null): JSONObject {
    val c = URL("http", ip, port, path).openConnection() as HttpURLConnection
    c.requestMethod = method
    c.connectTimeout = minOf(timeoutMs, 6000)
    c.readTimeout = timeoutMs
    c.useCaches = false
    c.instanceFollowRedirects = false
    track?.invoke(c)
    try {
        if (body != null) {
            val b = body.toString().toByteArray(Charsets.UTF_8)
            c.doOutput = true
            c.setFixedLengthStreamingMode(b.size)
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(b) }
        }
        val code = c.responseCode
        val txt = (if (code >= 400) c.errorStream else c.inputStream)?.use { String(it.readBytes(), Charsets.UTF_8) } ?: ""
        val json = try { JSONObject(txt) } catch (e: Exception) { JSONObject() }
        if (code !in 200..299) throw NetError(json.optString("error", "HTTP $code"), code)
        return json
    } finally {
        c.disconnect()
    }
}

fun jo(vararg pairs: Pair<String, Any?>): JSONObject = JSONObject().apply { for ((k, v) in pairs) put(k, v ?: JSONObject.NULL) }
