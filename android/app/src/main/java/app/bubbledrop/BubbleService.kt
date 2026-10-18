package app.bubbledrop

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.bubbledrop.core.jo
import app.bubbledrop.core.localIPv4s
import kotlin.concurrent.thread

/** Foreground service that keeps the engine (and discovery) alive while the app is in the background. */
class BubbleService : Service() {
    private var lastSummary: String? = "init"

    override fun onCreate() {
        super.onCreate()
        instance = this
        startForeground(NOTIF_ID, build(null), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        thread(name = "bd-start") {
            try { (application as App).ensureEngine() } catch (e: Exception) { (application as App).platform.log("engine start failed", e) }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = application as App
        when (intent?.action) {
            ACTION_ACCEPT, ACTION_DECLINE -> {
                val rid = intent.getStringExtra("rid") ?: ""
                NotificationManagerCompat.from(this).cancel("offer-$rid", AndroidPlatform.ID_OFFER)
                thread { app.engine?.localAction("respond", jo("rid" to rid, "accept" to (intent.action == ACTION_ACCEPT))) }
            }
            ACTION_STOP -> {
                thread { app.shutdown() }
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
        }
        return START_STICKY
    }

    fun update(summary: String?) {
        if (summary == lastSummary) return
        lastSummary = summary
        try { NotificationManagerCompat.from(this).notify(NOTIF_ID, build(summary)) } catch (_: SecurityException) {}
    }

    private fun build(summary: String?): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, BubbleService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val ip = localIPv4s().firstOrNull()?.address
        return NotificationCompat.Builder(this, App.CH_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_bubble)
            .setColor(0xFFFF6FAE.toInt())
            .setContentTitle(summary ?: "BubbleDrop is ready to receive 🫧")
            .setContentText(if (summary != null) "Tap to see progress" else if (ip != null) "Visible to nearby devices · $ip" else "Join a Wi-Fi or start a hotspot")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(open)
            .addAction(R.drawable.ic_stat_bubble, "Stop", stop)
            .build()
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val NOTIF_ID = 1
        const val ACTION_ACCEPT = "app.bubbledrop.ACCEPT"
        const val ACTION_DECLINE = "app.bubbledrop.DECLINE"
        const val ACTION_STOP = "app.bubbledrop.STOP"
        @Volatile var instance: BubbleService? = null
            private set

        fun start(ctx: Context) = ContextCompat.startForegroundService(ctx, Intent(ctx, BubbleService::class.java))
    }
}
