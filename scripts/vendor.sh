#!/usr/bin/env bash
# Vendor the KeePassXC core sources needed for the WebAssembly build into ./src,
# then apply the portability patches and file replacements.
#
# The clone at KEEPASSXC_SRC (default: ~/Downloads/keepassxc) is never modified;
# all edits happen on the copies in this repository. Re-running is safe: the
# destination tree is wiped and re-created from scratch.
#
# Upstream: https://github.com/keepassxreboot/keepassxc
# Expected clone commit: 6bcb901a (post-2.7.x development tip, verified 2026-11)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_ROOT="${KEEPASSXC_SRC:-$HOME/Downloads/keepassxc}"
SRC="$SRC_ROOT/src"

if [ ! -f "$SRC/core/Database.cpp" ]; then
    echo "error: KeePassXC sources not found at $SRC_ROOT" >&2
    echo "       set KEEPASSXC_SRC=/path/to/keepassxc-clone" >&2
    exit 1
fi

# Headless core: data model, crypto, keys, streams, KDBX format readers/writers.
# Deliberately excluded: GUI, CLI, autotype, network, browser integration,
# importers (Bitwarden/1Password/Proton/KeePass1), YubiKey drivers, Merger,
# DatabaseStats, HibpOffline, Bootstrap/Translator (desktop app plumbing).
CORE_FILES=(
    Alloc.cpp
    AsyncTask.h
    AutoTypeAssociations.cpp AutoTypeAssociations.h
    Base32.cpp Base32.h
    Clock.cpp Clock.h
    Compare.h
    Config.cpp Config.h
    CustomData.cpp CustomData.h
    Database.cpp Database.h
    Endian.h
    Entry.cpp Entry.h
    EntryAttachments.cpp EntryAttachments.h
    EntryAttributes.cpp EntryAttributes.h
    EntryPlaceholders.cpp EntryPlaceholders.h
    EntrySearcher.cpp EntrySearcher.h
    FileWatcher.cpp FileWatcher.h
    Global.h
    Group.cpp Group.h
    Metadata.cpp Metadata.h
    ModifiableObject.cpp ModifiableObject.h
    PassphraseGenerator.cpp PassphraseGenerator.h
    PasswordGenerator.cpp PasswordGenerator.h
    PasswordHealth.cpp PasswordHealth.h
    Resources.cpp Resources.h
    TimeDelta.cpp TimeDelta.h
    TimeInfo.cpp TimeInfo.h
    Tools.cpp Tools.h
    Totp.cpp Totp.h
)

CRYPTO_FILES=(
    Crypto.cpp Crypto.h
    CryptoHash.cpp CryptoHash.h
    Random.cpp Random.h
    SymmetricCipher.cpp SymmetricCipher.h
    kdf/AesKdf.cpp kdf/AesKdf.h
    kdf/Argon2Kdf.cpp kdf/Argon2Kdf.h
    kdf/Kdf.cpp kdf/Kdf.h
)

KEYS_FILES=(
    ChallengeResponseKey.cpp ChallengeResponseKey.h
    CompositeKey.cpp CompositeKey.h
    FileKey.cpp FileKey.h
    Key.h
    PasswordKey.cpp PasswordKey.h
)

STREAMS_FILES=(
    HashedBlockStream.cpp HashedBlockStream.h
    HashingStream.cpp HashingStream.h
    HmacBlockStream.cpp HmacBlockStream.h
    LayeredStream.cpp LayeredStream.h
    qtiocompressor.cpp qtiocompressor.h
    StoreDataStream.cpp StoreDataStream.h
    SymmetricCipherStream.cpp SymmetricCipherStream.h
)

FORMAT_FILES=(
    Kdbx3Reader.cpp Kdbx3Reader.h
    Kdbx3Writer.cpp Kdbx3Writer.h
    Kdbx4Reader.cpp Kdbx4Reader.h
    Kdbx4Writer.cpp Kdbx4Writer.h
    KdbxReader.cpp KdbxReader.h
    KdbxWriter.cpp KdbxWriter.h
    KdbxXmlReader.cpp KdbxXmlReader.h
    KdbxXmlWriter.cpp KdbxXmlWriter.h
    KeePass1.h
    KeePass2.cpp KeePass2.h
    KeePass2RandomStream.cpp KeePass2RandomStream.h
    KeePass2Reader.cpp KeePass2Reader.h
    KeePass2Writer.cpp KeePass2Writer.h
)

copy_group() {
    local group=$1; shift
    mkdir -p "$ROOT/src/$group"
    local f
    for f in "$@"; do
        # entries may live in subdirectories (e.g. crypto/kdf/)
        mkdir -p "$ROOT/src/$group/$(dirname "$f")"
        cp "$SRC/$group/$f" "$ROOT/src/$group/$f"
    done
}

echo "Vendoring KeePassXC core sources from $SRC_ROOT ..."
rm -rf "$ROOT/src" "$ROOT/data"

copy_group core "${CORE_FILES[@]}"
copy_group crypto "${CRYPTO_FILES[@]}"
copy_group keys "${KEYS_FILES[@]}"
copy_group streams "${STREAMS_FILES[@]}"
copy_group format "${FORMAT_FILES[@]}"

# zxcvbn (password entropy estimation, plain C, used by PasswordHealth)
mkdir -p "$ROOT/src/thirdparty/zxcvbn"
cp "$SRC/thirdparty/zxcvbn/"* "$ROOT/src/thirdparty/zxcvbn/"
ls "$ROOT/src/thirdparty/zxcvbn/zxcvbn.c" >/dev/null \
    || { echo "error: zxcvbn sources missing in clone" >&2; exit 1; }

# EFF wordlist for the passphrase generator, shipped via --preload-file as /data
mkdir -p "$ROOT/data/wordlists"
cp "$SRC_ROOT/share/wordlists/eff_large.wordlist" "$ROOT/data/wordlists/"

# License texts (this repository distributes derived builds under the GPL)
for lic in LICENSE.GPL-2 LICENSE.GPL-3; do
    [ -f "$SRC_ROOT/$lic" ] && cp "$SRC_ROOT/$lic" "$ROOT/$lic"
done

echo "Applying patches ..."
shopt -s nullglob
patches=("$ROOT"/patches/*.patch)
[ "${#patches[@]}" -gt 0 ] || { echo "error: no patches found" >&2; exit 1; }
for p in "${patches[@]}"; do
    echo "  $(basename "$p")"
    patch -d "$ROOT" -Np1 --silent < "$p"
done

echo "Applying file replacements ..."
cp "$ROOT/app/replacements/AsyncTask.h" "$ROOT/src/core/AsyncTask.h"

# Completion stamp: build.sh uses this to detect a fully vendored tree.
# A partial run (killed or failed mid-copy) leaves no stamp, so the next
# build re-vendors from scratch instead of configuring against a broken src/.
touch "$ROOT/src/.vendored"

echo "Done. $(find "$ROOT/src" -type f | wc -l) source files vendored."
