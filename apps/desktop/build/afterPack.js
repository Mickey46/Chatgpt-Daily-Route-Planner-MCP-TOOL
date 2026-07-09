// electron-builder's `identity` option looks up a named identity in the
// keychain -- it doesn't understand codesign's special "-" (ad-hoc) value,
// so setting `identity: "-"` in electron-builder.yml just fails to find a
// matching keychain entry and silently skips signing (confirmed: that's
// exactly what happened on a real build here). Ad-hoc signing ourselves in
// this hook, straight through `codesign`, is the reliable way to get it.
//
// Why this matters: fully unsigned Electron bundles get flagged "damaged"
// by Gatekeeper on modern macOS when downloaded via a browser (quarantine
// attribute set), a harsher message than the old "unidentified developer"
// warning. Ad-hoc signing avoids that -- confirmed by rebuilding with this
// hook and testing a simulated quarantined download (see PACKAGING_NOTES).

const { execFileSync } = require("node:child_process");

exports.default = async function afterPack(context) {
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  // codesign refuses to sign a bundle carrying extended attributes (resource
  // forks / Finder info), which can end up in the build output depending on
  // how files were copied during packaging -- strip them first.
  execFileSync("xattr", ["-cr", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--deep", "--force", "--sign", "-", appPath], { stdio: "inherit" });
};
