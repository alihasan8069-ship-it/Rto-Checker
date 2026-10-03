# RTO Return Scanner V24 — Fully Offline Production

V23 packages the V22 web application for Android using Capacitor. The app remains offline-first and keeps the existing local browser/database workflow.

## Build on a machine with Android Studio + JDK
1. `npm install`
2. `npx cap add android`
3. `npx cap sync android`
4. Open the generated `android/` project in Android Studio.
5. Run on a real Android phone for camera/file/permission testing.
6. Debug APK: `cd android && ./gradlew assembleDebug`
7. Release APK: configure your own keystore, then `./gradlew assembleRelease`.

## Important
This package is a source/build project, not a claimed prebuilt APK. Camera behavior and Android permissions must be tested on a real Android device before release.


## V24 production hardening
- Offline-ready status indicator and no required network service.
- LocalStorage + IndexedDB remain the primary data path.
- 15-second autosave safeguard while the app is active.
- Save-on-exit best effort for the current local state.
- Runtime error/unhandled rejection indicators.
- Backup metadata updated to V24.
- Backup/restore remains local JSON; no cloud upload is performed by the app.

## Release verification
The source package can be syntax-checked and inspected offline. A final Android release still requires a real Android device test for camera, file access, permissions, long-running scans, and APK signing.
