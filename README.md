# RTO & Customer Return Scanner — Camera Fix Build

This build fixes the mobile web camera startup flow.

## Camera fixes
- Explicit HTTPS / secure-context check
- Requests camera permission once and closes the temporary permission stream
- Uses the rear/environment camera by default
- Supports a selected camera with fallback to rear camera
- Explicitly attaches the stream to the video element and calls `video.play()`
- Adds `autoplay`, `muted`, and `playsinline` to the camera video element
- Uses the browser `BarcodeDetector` when supported for Code 128, Code 39, EAN-13, EAN-8, UPC and QR where the device exposes those formats
- Falls back to ZXing when native BarcodeDetector is unavailable
- Shows useful errors for permission blocked, camera busy, missing camera, HTTPS/security and unavailable selected camera
- Properly stops camera tracks and the native detection loop

## Important
The GitHub Pages site is HTTPS, so browser camera permission should be available. The final camera behavior still needs a real Android-phone test because browser/device permissions and camera hardware vary.
