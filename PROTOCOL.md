# BubbleDrop wire protocol (v1)

Every BubbleDrop app (Windows and Android) runs the same two things:

| Purpose   | Transport | Port  |
|-----------|-----------|-------|
| Discovery | UDP, multicast `239.255.42.99` + subnet broadcast | 47889 |
| Transfers, web share, local UI | HTTP/1.1 on `0.0.0.0` | 47888 (falls back to 47890–47899 if busy) |

Nothing ever leaves the local network. It works on any shared Wi-Fi, a phone hotspot
(no mobile data is used for local traffic), or Android's Local-Only hotspot.

## Discovery

Each device sends this JSON every 2.5 s to the multicast group and to every interface's
broadcast address:

```json
{"bd":1,"t":"hi","id":"…","name":"Kitty's PC","platform":"windows","avatar":"🍓","color":"#ff6fae","port":47888}
```

`t` is `hi` (periodic), `re` (unicast reply sent straight back to a new device) or `bye` (on quit).
A device disappears after 9 s of silence. Fallbacks: manual IP, QR code, or a subnet scan
that calls `GET /api/v1/info` on every host.

## Peer API

| Call | Body / query | Result |
|------|--------------|--------|
| `GET /api/v1/info` | | `{bd, app, id, name, platform, avatar, color, port, version}` |
| `POST /api/v1/offer` | `{bd, from:{…info}, sid, ctoken, text?, items:[{fid,name,rel,size,mime}]}` | Long-polls (≤ 90 s) until the user decides: `{accept:true, sid, token}` or `{accept:false, reason}` |
| `PUT /api/v1/file?sid&token&fid` | raw bytes, `Content-Length` = item size | `{ok:true}` · 403 bad token · 410 cancelled |
| `POST /api/v1/cancel` | `{sid, token}` | Either side cancels. The receiver uses the sender's `sid`/`ctoken` from the offer; the sender uses the receiver's `sid`/`token`. |

`rel` is the item's relative path (`Holiday/day1/img.jpg`) so folders keep their structure.
Text messages are offers with `text` and no items. The sender uploads up to 3 files in parallel.

## Web share (any browser, no app)

When the owner turns it on, `http://<ip>:47888/` serves a page protected by a 4-digit PIN:
`POST /web/auth {pin}` → cookie, `GET /web/files`, `GET /web/dl?id`, `POST /web/upload?name&rel&b` (raw body).

## Local UI API

`/ui/` and `/local/*` answer only loopback requests with a `Host` of `127.0.0.1`/`localhost`
and a per-run token (`x-bd-token` header, or `?t=` for the event stream). The same web UI
drives both apps.
