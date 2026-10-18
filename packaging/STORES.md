# Getting BubbleDrop into app stores

All stores below are free. Each needs an account that only the owner can create;
everything else (listing text, icon, screenshots, build recipes) is already in this repo.

| Store | Platform | Status | What the owner does |
|---|---|---|---|
| winget (Windows Package Manager) | Windows | Manifests in `packaging/winget/`, pull request to `microsoft/winget-pkgs` | Comment `@microsoft-github-policy-service agree` on the PR when the CLA bot asks |
| IzzyOnDroid | Android | Ready: APK on GitHub Releases, listing in `fastlane/` | Create a Codeberg account and open the request below |
| F-Droid | Android | Build recipe in `packaging/fdroid/app.bubbledrop.yml` | Create a GitLab account and open a merge request to fdroiddata |
| Microsoft Store | Windows | Not started | Register a free individual developer account in Partner Center (needs ID verification) |

Store listing (title, descriptions, icon, screenshots, changelog) lives in
`fastlane/metadata/android/en-US/`, the standard layout F-Droid and IzzyOnDroid read.

## IzzyOnDroid request

Open a new issue at https://codeberg.org/IzzyOnDroid/repodata/issues with this text:

> **App name:** BubbleDrop
> **Package:** app.bubbledrop
> **Source:** https://github.com/kitty-more-sushi/BubbleDrop
> **APK:** attached to GitHub Releases (https://github.com/kitty-more-sushi/BubbleDrop/releases/latest), file `BubbleDrop-<version>.apk`
> **License:** MIT
> **Description:** Offline file sharing between Android and Windows over Wi-Fi or a local-only hotspot. No internet, no mobile data, no account, no trackers. Fastlane metadata is in the repo.
> **Author:** kitty_no_sushie (I am the developer)

## F-Droid merge request

1. Fork https://gitlab.com/fdroid/fdroiddata.
2. Add `packaging/fdroid/app.bubbledrop.yml` from this repo as `metadata/app.bubbledrop.yml`.
3. Open a merge request titled "New app: BubbleDrop" and fill in the template (it asks you to confirm the app is free software with no proprietary parts; BubbleDrop uses only AndroidX and the Apache-licensed ZXing scanner).

F-Droid builds the APK from source and signs it with its own key, so the F-Droid version and the GitHub APK cannot update each other; users should stay with one source.

## Signing (maintainer note)

GitHub APKs from 1.0.1 on are signed with the release key in `android/bubbledrop-release.jks`
(password in `android/keystore.properties`; both are git-ignored). **Back both files up.**
If the key is lost, existing users can never receive updates to the same app.
Certificate SHA-256: `a79ec0056ff7442cb749e8a5af2d950a282fa5074f641720ad20fc56ab9d9fa8`

---
© 2026 kitty_no_sushie
