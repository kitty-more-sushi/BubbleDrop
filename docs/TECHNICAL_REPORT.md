# BubbleDrop: Offline File Sharing Between Windows and Android

*Technical report, version 1.0. Designed by kitty_no_sushie, October 2026.*

## Summary

BubbleDrop moves files, folders, apps and text between Windows PCs and Android phones over a local network, with no internet connection and no mobile data. Two devices only need to share a Wi-Fi network or a phone hotspot. The Windows and Android apps run two independent implementations of one small HTTP and UDP protocol and share a single user interface, so they behave the same on both platforms.

In automated tests on a Windows PC, the engine moved an 80 MB file between two instances in about 0.7 seconds over the loopback interface, two instances found each other on the local network in 2.5 seconds without being given an address, and the Android engine exchanged files with the Windows engine in both directions with matching SHA-256 checksums. The Android app has been built and its engine tested on the Java virtual machine; it has not yet been run on a physical phone.

## Motivation

Moving a file from a phone to a nearby computer is a common task that is still awkward across platforms. Apple's AirDrop works only between Apple devices. Many cross-platform options route files through a cloud service, which uses data, needs an account or an internet connection, and is slow for large videos. BubbleDrop was built for the case where both devices sit in the same room: the transfer should stay on the local network, work when there is no internet at all, and not require an account.

## Design goals

- No internet dependency: discovery, transfer and the interface all run on the local network.
- No account and no server: every device is a peer.
- Consent: nothing is written to a device until its owner accepts, unless the sender is a device the owner marked as trusted.
- One protocol and one interface for both platforms, so features and fixes reach both.
- A fallback for devices without the app: any web browser can send or receive through Web Share.

## Architecture

Each app has three parts:

- **Engine.** Discovery, the peer HTTP server, transfers, history and settings. The Windows engine is written in Node.js ([desktop/core/engine.js](../desktop/core/engine.js)); the Android engine is written in Kotlin ([android/.../core/Engine.kt](../android/app/src/main/java/app/bubbledrop/core/Engine.kt)). They are separate implementations of the same protocol.
- **Local UI API.** The engine serves the interface and a small control API on the same port. Control calls are accepted only from the loopback address, with a Host header of 127.0.0.1 or localhost, and with a random token issued for each run. The Host check blocks DNS-rebinding attacks from web pages, and the token blocks other local web content.
- **Shared interface.** A single HTML, CSS and JavaScript interface ([web/](../web)), rendered by Electron on Windows and by a WebView on Android. It receives live state through server-sent events.

Platform-specific features (file pickers, notifications, the system tray, the Android hotspot, the QR code scanner) are injected into the engine through a small platform interface, so the engine itself has no user-interface code.

## Device discovery

Every 2.5 seconds each device sends a short JSON announcement over UDP port 47889. The announcement goes to the multicast group 239.255.42.99 and to the broadcast address of every active network interface. Sending per interface matters on phones acting as a hotspot, where a plain broadcast to 255.255.255.255 can leave through the mobile-data interface instead of the hotspot. When a device hears an announcement from a peer it does not know, it replies directly to that peer, so two devices usually find each other within one announcement cycle. A peer that stays silent for 9 seconds is removed.

Some networks block multicast or broadcast traffic. For those, BubbleDrop offers three fallbacks: entering the other device's IP address, scanning a QR code that contains the address, and a network scan that queries every host on the local /24 subnet for its device information.

## Transfer protocol

Transfers use plain HTTP/1.1 on TCP port 47888 (or the next free port). The full wire format is in [PROTOCOL.md](../PROTOCOL.md).

1. The sender posts an offer listing every file with its name, relative path, size and type.
2. The receiver holds that request open for up to 90 seconds while its owner decides, then answers with an accept, including a session ID and token, or a decline.
3. The sender uploads each file with a PUT request whose Content-Length must equal the offered size. Up to three files upload in parallel, which helps with many small files such as photo folders.
4. Either side can cancel. Each side holds the other's session ID and cancel token, so the other side reports "cancelled" rather than a broken connection.

Folders keep their structure through the relative path of each file. Receivers clean every path component of characters Windows does not allow and of reserved names, and resolve name collisions by adding a counter, so a file can never be written outside the receive folder. Incoming files are written to a temporary file and renamed only after the full size has arrived. Text messages are offers with no files.

## Working without Wi-Fi

When no Wi-Fi network is available, the Android app can start a local-only hotspot through Android's LocalOnlyHotspot API. This creates a private network with a generated name and password that is not connected to the mobile-data connection, so local transfers cost no data. The phone shows the network details and a Wi-Fi QR code that other phones can scan with their camera. On Windows, BubbleDrop can join that network directly: it writes a WPA2 profile and connects through the built-in netsh tool.

## Web Share

For a device without BubbleDrop, the owner can turn on Web Share. The device then serves a page at its local address, protected by a four-digit PIN. Five wrong PINs lock the requester out for a minute. From that page a visitor can download the files the owner selected and upload files to the owner. Uploads go into the same receive folder and history as normal transfers.

## Platform features

### Windows

- Electron desktop app with drag-and-drop of files and folders.
- Keeps running in the system tray so the PC stays visible to phones, and shows desktop notifications for incoming offers.
- The installer adds a Windows Firewall rule for the app on all network profiles, because phone hotspots are often classed as public networks.
- Received files go to `Downloads\BubbleDrop` by default, and the folder can be changed.

### Android

- Native Kotlin engine with a foreground service of type `connectedDevice`, so the phone keeps receiving while the app is in the background.
- Files are saved to `Download/BubbleDrop` through MediaStore, so no storage permission is needed.
- Pickers for files, photos and videos, and whole folders, plus BubbleDrop as a target in the Android share menu.
- Sharing installed apps as APK files, including all parts of split apps.
- QR code scanner, accept and decline buttons in notifications, and a Wi-Fi lock and wake lock during transfers.

## Security and privacy

No data leaves the local network and the apps contact no server. Every incoming transfer needs the owner's approval unless the sender is trusted. Version 1.0 sends files over unencrypted HTTP, as many local sharing tools do, so it is meant for networks the user trusts, such as a home network or the user's own hotspot. Encrypted transfers with device pairing are planned for a later version.

## Testing

| Test | What it checks | Result |
|---|---|---|
| Windows engine, end to end ([transfer.test.js](../desktop/test/transfer.test.js)) | Decline, accept and trust, folder structure, empty files, 80 MB file, name collisions, receiver cancel with cleanup, text messages, history, local API protection | All passed. 80 MB in about 0.7 s on loopback. |
| Discovery ([discovery.test.js](../desktop/test/discovery.test.js)) | Two engines find each other over UDP without an address | Passed in 2.5 s. |
| Android engine ([EngineTest.kt](../android/app/src/test/java/app/bubbledrop/EngineTest.kt)) | Two Kotlin engines: offer, accept, trust, folder, empty file, text | Passed. |
| Cross-platform | Android engine to Windows engine and back, verified by SHA-256 | Passed in both directions. |
| Windows app | Packaged executable launches and renders the interface | Passed. |
| Android app on a phone | Interface, pickers, MediaStore saving, hotspot, background service | Not yet tested. |

The loopback figure measures the software path only. Real transfers are limited by the Wi-Fi link between the two devices.

## Limitations and next steps

- Test the Android app on several physical phones and Android versions.
- Add encryption and device pairing.
- Resume interrupted transfers.
- Build macOS and Linux versions; the desktop engine is already cross-platform Node.js.
- iPhones can already use Web Share through Safari; a native iOS app would need a separate implementation.

---
© 2026 kitty_no_sushie
