// Build-environment patch (idempotent). electron-builder generates the NSIS uninstaller by running the
// freshly built installer stub under 32-bit wine on Linux. Where only 64-bit wine is available, use the
// pure-JS UninstallerReader that electron-builder already ships (it is the macOS Catalina code path) and
// fall back to wine only if that fails. Output is byte-identical to a Windows build of the same inputs.
import { readFileSync, writeFileSync } from 'node:fs'
const file = new URL('../node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js', import.meta.url)
let src = readFileSync(file, 'utf8')
const marker = '/* minutes-linux-patch */'
if (!src.includes(marker)) {
  src = src.replace(
    'if ((0, macosVersion_1.isMacOsCatalina)()) {',
    `if (${marker} (0, macosVersion_1.isMacOsCatalina)() || process.platform === "linux") {`
  )
  src = src.replace(
    'builder_util_1.log.warn(`packager.vm is used: ${error.message}`);\n                const vm = await packager.vm.value;\n                await vm.exec(installerPath, []);',
    'if (process.platform === "linux") { builder_util_1.log.warn(`UninstallerReader failed, trying wine: ${error.message}`); await (0, wine_1.execWine)(installerPath, null, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } }); } else {\n                builder_util_1.log.warn(`packager.vm is used: ${error.message}`);\n                const vm = await packager.vm.value;\n                await vm.exec(installerPath, []); }'
  )
  writeFileSync(file, src)
  console.log('patched NsisTarget.js for Linux builds')
} else {
  console.log('NsisTarget.js already patched')
}
