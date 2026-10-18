package app.bubbledrop.core

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Thrown by handlers to answer with a status code and a JSON `{error}` body. */
class HttpError(val status: Int, message: String) : Exception(message)

/** Request body limited to Content-Length bytes. */
private class BoundedInput(private val src: InputStream, private var left: Long) : InputStream() {
    override fun read(): Int {
        if (left <= 0) return -1
        val b = src.read()
        if (b >= 0) left--
        return b
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (left <= 0) return -1
        val n = src.read(b, off, minOf(len.toLong(), left).toInt())
        if (n > 0) left -= n
        return n
    }

    override fun available(): Int = minOf(src.available().toLong(), left).toInt()
}

class HttpRequest(
    val method: String,
    val path: String,
    val query: Map<String, String>,
    val headers: Map<String, String>,
    val body: InputStream,
    val remoteIp: String,
    val socket: Socket,
) {
    val contentLength: Long get() = headers["content-length"]?.toLongOrNull() ?: -1

    fun bytes(limit: Int = 4 shl 20): ByteArray {
        if (contentLength > limit) throw HttpError(413, "Body too large")
        return body.readBytes()
    }

    fun json(): JSONObject {
        val b = bytes()
        if (b.isEmpty()) return JSONObject()
        return try {
            JSONObject(String(b, Charsets.UTF_8))
        } catch (e: Exception) {
            throw HttpError(400, "Bad JSON")
        }
    }

    /** True once the client hung up (only meaningful after the body has been read). */
    fun clientGone(): Boolean {
        val old = socket.soTimeout
        return try {
            socket.soTimeout = 1
            socket.getInputStream().read() == -1
        } catch (e: SocketTimeoutException) {
            false
        } catch (e: IOException) {
            true
        } finally {
            try { socket.soTimeout = old } catch (_: Exception) {}
        }
    }
}

class HttpResponse(private val out: OutputStream) {
    @Volatile var sent = false
        private set

    private fun head(code: Int, type: String, length: Long, extra: Map<String, String>) {
        if (sent) throw IllegalStateException("response already sent")
        sent = true
        val sb = StringBuilder("HTTP/1.1 $code ${reason(code)}\r\n")
        sb.append("Content-Type: ").append(type).append("\r\n")
        if (length >= 0) sb.append("Content-Length: ").append(length).append("\r\n")
        sb.append("Connection: close\r\n")
        for ((k, v) in extra) sb.append(k).append(": ").append(v).append("\r\n")
        sb.append("\r\n")
        out.write(sb.toString().toByteArray(Charsets.UTF_8))
    }

    fun send(code: Int, type: String, body: ByteArray, extra: Map<String, String> = emptyMap()) {
        head(code, type, body.size.toLong(), extra)
        out.write(body)
        out.flush()
    }

    fun json(code: Int, obj: JSONObject, extra: Map<String, String> = emptyMap()) =
        send(code, "application/json", obj.toString().toByteArray(Charsets.UTF_8), extra + ("Cache-Control" to "no-store"))

    /** Writes headers and hands back the raw stream for large or endless bodies. */
    fun stream(code: Int, type: String, length: Long, extra: Map<String, String> = emptyMap()): OutputStream {
        head(code, type, length, extra)
        out.flush()
        return out
    }

    private fun reason(code: Int) = when (code) {
        200 -> "OK"; 400 -> "Bad Request"; 401 -> "Unauthorized"; 403 -> "Forbidden"; 404 -> "Not Found"
        409 -> "Conflict"; 410 -> "Gone"; 411 -> "Length Required"; 413 -> "Payload Too Large"; 429 -> "Too Many Requests"
        else -> if (code >= 500) "Server Error" else "OK"
    }
}

/** Tiny HTTP/1.1 server: one thread per connection, Connection: close, Content-Length bodies only. */
class MiniHttpServer(private val handler: (HttpRequest, HttpResponse) -> Unit) {
    private var server: ServerSocket? = null
    private val pool: ExecutorService = Executors.newCachedThreadPool { r -> Thread(r, "bd-http").apply { isDaemon = true } }
    var port = 0
        private set

    fun start(preferred: Int): Int {
        val candidates = listOf(preferred) + (2..11).map { preferred + it }
        var last: Exception? = null
        for (p in candidates) {
            try {
                val s = ServerSocket()
                s.reuseAddress = true
                s.bind(InetSocketAddress("0.0.0.0", p), 64)
                server = s
                port = p
                Thread({ acceptLoop(s) }, "bd-accept").apply { isDaemon = true }.start()
                return p
            } catch (e: IOException) {
                last = e
            }
        }
        throw IOException("No free port for BubbleDrop", last)
    }

    fun stop() {
        try { server?.close() } catch (_: Exception) {}
        pool.shutdownNow()
    }

    private fun acceptLoop(s: ServerSocket) {
        while (!s.isClosed) {
            val sock = try { s.accept() } catch (e: IOException) { break }
            pool.execute { serve(sock) }
        }
    }

    private fun readLine(inp: InputStream): String? {
        val buf = ByteArrayOutputStream()
        while (true) {
            val b = inp.read()
            if (b == -1) return if (buf.size() == 0) null else buf.toString("ISO-8859-1")
            if (b == '\n'.code) break
            if (b != '\r'.code) buf.write(b)
            if (buf.size() > 16384) throw IOException("header line too long")
        }
        return buf.toString("ISO-8859-1")
    }

    private fun decode(s: String) = try { URLDecoder.decode(s, "UTF-8") } catch (_: Exception) { s }

    private fun serve(sock: Socket) {
        try {
            sock.soTimeout = 60_000
            sock.tcpNoDelay = true
            sock.sendBufferSize = 512 * 1024
            sock.receiveBufferSize = 512 * 1024
            val inp = BufferedInputStream(sock.getInputStream(), 256 * 1024)
            val out = java.io.BufferedOutputStream(sock.getOutputStream(), 64 * 1024)
            val line = readLine(inp) ?: return
            val parts = line.split(' ')
            if (parts.size < 2) return
            val headers = HashMap<String, String>()
            var total = 0
            while (true) {
                val h = readLine(inp) ?: break
                if (h.isEmpty()) break
                total += h.length
                if (total > 65536) return
                val i = h.indexOf(':')
                if (i > 0) headers[h.substring(0, i).trim().lowercase()] = h.substring(i + 1).trim()
            }
            val target = parts[1]
            val q = target.indexOf('?')
            val rawPath = if (q >= 0) target.substring(0, q) else target
            val query = HashMap<String, String>()
            if (q >= 0) {
                for (kv in target.substring(q + 1).split('&')) {
                    if (kv.isEmpty()) continue
                    val e = kv.indexOf('=')
                    if (e < 0) query[decode(kv)] = "" else query[decode(kv.substring(0, e))] = decode(kv.substring(e + 1))
                }
            }
            val res = HttpResponse(out)
            if (headers["transfer-encoding"]?.contains("chunked", true) == true) {
                res.json(411, JSONObject().put("error", "Content-Length required"))
                return
            }
            val len = headers["content-length"]?.toLongOrNull() ?: 0L
            val req = HttpRequest(parts[0].uppercase(), decode(rawPath.replace("+", "%2B")), query, headers, BoundedInput(inp, len), sock.inetAddress?.hostAddress ?: "", sock)
            handler(req, res)
            if (!res.sent) res.json(404, JSONObject().put("error", "not found"))
            out.flush()
        } catch (_: Exception) {
            // client went away or bad request: nothing to answer
        } finally {
            try { sock.close() } catch (_: Exception) {}
        }
    }
}
