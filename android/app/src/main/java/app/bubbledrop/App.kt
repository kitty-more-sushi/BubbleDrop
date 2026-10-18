package app.bubbledrop

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import app.bubbledrop.core.Engine

class App : Application() {
    lateinit var platform: AndroidPlatform
        private set
    @Volatile var engine: Engine? = null
        private set

    override fun onCreate() {
        super.onCreate()
        platform = AndroidPlatform(this)
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_SERVICE, "Ready to receive", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Keeps BubbleDrop visible to nearby devices"
            setShowBadge(false)
        })
        nm.createNotificationChannel(NotificationChannel(CH_TRANSFERS, "Incoming files", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Someone wants to send you something, or a transfer finished"
        })
    }

    /** Starts the engine once; call off the main thread (it opens sockets). */
    @Synchronized
    fun ensureEngine(): Engine {
        engine?.let { return it }
        val e = Engine(platform)
        platform.engine = e
        e.start()
        engine = e
        return e
    }

    @Synchronized
    fun shutdown() {
        engine?.stop()
        engine = null
        platform.stopHotspot()
    }

    companion object {
        const val CH_SERVICE = "service"
        const val CH_TRANSFERS = "transfers"
    }
}
