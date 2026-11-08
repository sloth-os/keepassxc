/* config-keepassx.h — static configuration for the WebAssembly build.
 *
 * Derived from src/config-keepassx.h.in of KeePassXC (GPL-2/GPL-3). Instead of
 * running the full upstream CMake configuration, the wasm build ships this
 * fixed header: only the defines actually consumed by the vendored core files
 * are present, everything optional is left undefined (= feature off).
 */

#ifndef KEEPASSX_CONFIG_KEEPASSX_H
#define KEEPASSX_CONFIG_KEEPASSX_H

#define KEEPASSXC_VERSION "2.8.0-web"

/* Shown by Tools::debugInfo(). Upstream derives these in CMake; the web
 * build tracks the development tip and is distributed as a web page. */
#define KEEPASSXC_BUILD_TYPE "Snapshot"
#define KEEPASSXC_DIST_TYPE "Web"

#define KEEPASSX_SOURCE_DIR "/"
#define KEEPASSX_BINARY_DIR "/"

#define KEEPASSX_PREFIX_DIR "/"
#define KEEPASSX_PLUGIN_DIR "/"
/* /data is populated by --preload-file (wordlists) */
#define KEEPASSX_DATA_DIR "/data"

/* Build Scope */
#define WITH_BOTAN3 1

/* Advanced/minor features intentionally undefined (off):
 *   WITH_X11, KPXC_FEATURE_BROWSER, KPXC_FEATURE_SSHAGENT,
 *   KPXC_FEATURE_FDOSECRETS, KPXC_FEATURE_NETWORK, KPXC_FEATURE_UPDATES,
 *   KPXC_FEATURE_DOCS, KEEPASSXC_DIST_*, HAVE_PR_SET_DUMPABLE,
 *   HAVE_RLIMIT_CORE, HAVE_PT_DENY_ATTACH, HAVE_MALLOC_H,
 *   HAVE_MALLOC_USABLE_SIZE, XC_APPLE_COMPILER_SUPPORT_*
 */

#endif // KEEPASSX_CONFIG_KEEPASSX_H
