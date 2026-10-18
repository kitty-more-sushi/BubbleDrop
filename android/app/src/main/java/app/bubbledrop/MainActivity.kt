package app.bubbledrop

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject
import kotlin.concurrent.thread

class MainActivity : ComponentActivity(), UiHost {
    private lateinit var web: WebView
    private lateinit var root: FrameLayout
    private var home = ""
    private var pageReady = false
    private val pendingJs = mutableListOf<String>()

    private var pickCb: ((List<Uri>) -> Unit)? = null
    private var scanCb: ((String?) -> Unit)? = null
    private var permCb: ((Boolean) -> Unit)? = null

    private val pickFiles = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { deliver(it) }
    private val pickMedia = registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { deliver(it) }
    private val pickTree = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { deliver(listOfNotNull(it)) }
    private val scan = registerForActivityResult(ScanContract()) { r -> scanCb?.invoke(r.contents); scanCb = null }
    private val perms = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { m -> permCb?.invoke(m.values.all { it }); permCb = null }

    @Volatile override var isForeground = false
        private set

    private val app get() = application as App

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#120A1A")) }
        web = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.textZoom = 100
            settings.setSupportZoom(false)
            overScrollMode = WebView.OVER_SCROLL_NEVER
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url.toString()
                    if (url.startsWith(home)) return false
                    try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: Exception) {}
                    return true
                }

                override fun onPageFinished(view: WebView, url: String) {
                    pageReady = true
                    pendingJs.forEach { web.evaluateJavascript(it, null) }
                    pendingJs.clear()
                }
            }
            webChromeClient = android.webkit.WebChromeClient()
        }
        root.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("window.__bdBack ? window.__bdBack() : false") { r -> if (r != "true") moveTaskToBack(true) }
            }
        })

        app.platform.host = this
        BubbleService.start(this)
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPerms(arrayOf(Manifest.permission.POST_NOTIFICATIONS)) {}
        }
        thread(name = "bd-boot") {
            val e = try { app.ensureEngine() } catch (ex: Exception) { null }
            runOnUiThread {
                if (e == null) {
                    web.loadData("<body style='background:#120a1a;color:#fff;font:18px sans-serif;padding:40px'>BubbleDrop could not start its network service. Restart the app.</body>", "text/html", "utf-8")
                } else {
                    home = "http://127.0.0.1:${e.port}/ui/"
                    web.loadUrl(home)
                    applyTheme(e.settings.optString("theme", "dark"))
                    handleShare(intent)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleShare(intent)
    }

    /** "Share → BubbleDrop" from any app: add the files (or the text) to the bubble. */
    private fun handleShare(intent: Intent?) {
        if (intent == null || (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE)) return
        val uris = mutableListOf<Uri>()
        if (intent.action == Intent.ACTION_SEND) IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { uris += it }
        else IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { uris += it }
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        intent.action = Intent.ACTION_MAIN // handle once
        if (uris.isNotEmpty()) {
            thread {
                val items = uris.mapNotNull { app.platform.uriToItem(it) }
                app.engine?.addSelection(items)
                runOnUiThread { js("window.__bdShared && window.__bdShared()") }
            }
        } else if (!text.isNullOrBlank()) {
            js("window.__bdSharedText && window.__bdSharedText(${JSONObject.quote(text)})")
        }
    }

    private fun js(code: String) {
        if (pageReady) web.evaluateJavascript(code, null) else pendingJs += code
    }

    private fun deliver(uris: List<Uri>) {
        val cb = pickCb
        pickCb = null
        cb?.invoke(uris)
    }

    // ---------- UiHost ----------

    override fun launchPicker(kind: String, cb: (List<Uri>) -> Unit) {
        pickCb?.invoke(emptyList())
        pickCb = cb
        when (kind) {
            "media" -> pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
            "folder" -> pickTree.launch(null)
            else -> pickFiles.launch(arrayOf("*/*"))
        }
    }

    override fun launchScan(cb: (String?) -> Unit) {
        scanCb?.invoke(null)
        scanCb = cb
        scan.launch(
            ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Point at the QR code on the other device's Connect page")
                .setBeepEnabled(false).setOrientationLocked(false),
        )
    }

    override fun requestPerms(perms: Array<String>, cb: (Boolean) -> Unit) {
        if (perms.all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }) return cb(true)
        permCb?.invoke(false)
        permCb = cb
        this.perms.launch(perms)
    }

    override fun applyTheme(theme: String) {
        val dark = when (theme) {
            "light" -> false
            "auto" -> (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
            else -> true
        }
        root.setBackgroundColor(Color.parseColor(if (dark) "#120A1A" else "#FFF3F9"))
        WindowInsetsControllerCompat(window, root).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }

    override fun quit() {
        startService(Intent(this, BubbleService::class.java).setAction(BubbleService.ACTION_STOP))
        finishAndRemoveTask()
    }

    override fun onResume() {
        super.onResume()
        isForeground = true
        app.platform.host = this
    }

    override fun onPause() {
        isForeground = false
        super.onPause()
    }

    override fun onDestroy() {
        if (app.platform.host === this) app.platform.host = null
        pickCb?.invoke(emptyList())
        scanCb?.invoke(null)
        permCb?.invoke(false)
        web.destroy()
        super.onDestroy()
    }
}
