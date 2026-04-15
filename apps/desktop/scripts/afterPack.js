const { execSync } = require('child_process');
const path = require('path');

// Ad-hoc sign the macOS app bundle when no Developer ID certificate is available.
//
// Why this is needed:
// Electron's prebuilt binary ships with Apple's ad-hoc signature. When
// electron-builder replaces files inside the .app bundle, the signature becomes
// invalid. macOS Gatekeeper treats an invalid signature as "damaged" and refuses
// to open the app. Ad-hoc re-signing produces a valid (self-signed) signature,
// which changes the Gatekeeper prompt from "damaged" to "developer cannot be
// verified" — bypassable via right-click > Open.
//
// This hook runs after packing (app directory ready) but before DMG creation,
// so the DMG contains the properly signed app.
//
// When a real Developer ID certificate is available (CSC_LINK is set),
// this hook does nothing and lets electron-builder handle signing normally.

exports.default = async function (context) {
  if (process.platform !== 'darwin') return;
  if (process.env.CSC_LINK) return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`Ad-hoc code signing: ${appPath}`);
  execSync(`codesign --force --deep -s - "${appPath}"`, { stdio: 'inherit' });
};
