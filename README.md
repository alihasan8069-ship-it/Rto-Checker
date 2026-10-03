# RTO Return Scanner V22 — Windows Desktop App

This is the Electron desktop wrapper for the V21 offline browser prototype.

## Development
1. Install Node.js 20+ on Windows.
2. Open this folder in a terminal.
3. Run `npm install`.
4. Run `npm start` to test the desktop app.
5. Run `npm run build:win` to create the Windows installer in `dist/`.

## Important
The desktop shell keeps Node integration disabled and uses context isolation. The app loads the existing local HTML/CSS/JS UI and is designed to operate without a server.
