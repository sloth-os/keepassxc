/*
 * bridge.cpp — C ABI between the vendored KeePassXC core and the web UI.
 *
 * Every exported function returns a JSON string (statically buffered) in the
 * form {"ok":true,...} or {"ok":false,"error":"..."}. The JS side copies the
 * string out immediately, so reusing one static buffer is safe.
 *
 * The core is synchronous: KDF transforms (Argon2) are the only slow part
 * and the UI shows a busy overlay while a call runs. A null event dispatcher
 * is installed before QCoreApplication is created so the Qt wasm event
 * dispatcher (and its embind/qstdweb glue) is never instantiated.
 */

#include <emscripten.h>

#include <QAbstractEventDispatcher>
#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSharedPointer>
#include <QUuid>

#include "core/Config.h"
#include "core/Database.h"
#include "core/Entry.h"
#include "core/EntrySearcher.h"
#include "core/Group.h"
#include "core/Metadata.h"
#include "core/PasswordGenerator.h"
#include "core/PasswordHealth.h"
#include "core/PassphraseGenerator.h"
#include "core/Totp.h"
#include "crypto/Crypto.h"
#include "crypto/kdf/AesKdf.h"
#include "crypto/kdf/Argon2Kdf.h"
#include "format/KeePass2.h"
#include "keys/CompositeKey.h"
#include "keys/FileKey.h"
#include "keys/PasswordKey.h"

// ---------------------------------------------------------------------------
// Result plumbing

static std::string g_result;
static const char* ok()
{
    g_result = "{\"ok\":true}";
    return g_result.c_str();
}
static const char* okObj(const QJsonObject& obj)
{
    QJsonObject o = obj;
    o["ok"] = true;
    g_result = QString::fromUtf8(QJsonDocument(o).toJson(QJsonDocument::Compact)).toStdString();
    return g_result.c_str();
}
static const char* okArr(const QJsonArray& arr)
{
    QJsonObject o;
    o["ok"] = true;
    o["items"] = arr;
    g_result = QString::fromUtf8(QJsonDocument(o).toJson(QJsonDocument::Compact)).toStdString();
    return g_result.c_str();
}
static const char* fail(const QString& error)
{
    QJsonObject o;
    o["ok"] = false;
    o["error"] = error;
    g_result = QString::fromUtf8(QJsonDocument(o).toJson(QJsonDocument::Compact)).toStdString();
    return g_result.c_str();
}

// ---------------------------------------------------------------------------
// Null event dispatcher: no-op implementation of every pure virtual. Installed
// before QCoreApplication exists, so Qt never constructs QEventDispatcherWasm.

class NullEventDispatcher : public QAbstractEventDispatcher
{
public:
    explicit NullEventDispatcher(QObject* parent = nullptr)
        : QAbstractEventDispatcher(parent)
    {
    }
    bool processEvents(QEventLoop::ProcessEventsFlags) override
    {
        return false;
    }
    void registerSocketNotifier(QSocketNotifier*) override
    {
    }
    void unregisterSocketNotifier(QSocketNotifier*) override
    {
    }
    void registerTimer(int timerId, qint64 interval, Qt::TimerType, QObject*) override
    {
        Q_UNUSED(timerId);
        Q_UNUSED(interval);
    }
    bool unregisterTimer(int timerId) override
    {
        Q_UNUSED(timerId);
        return true;
    }
    bool unregisterTimers(QObject*) override
    {
        return true;
    }
    QList<QAbstractEventDispatcher::TimerInfo> registeredTimers(QObject*) const override
    {
        return {};
    }
    int remainingTime(int timerId) override
    {
        Q_UNUSED(timerId);
        return -1;
    }
    void wakeUp() override
    {
    }
    void interrupt() override
    {
    }
};

// ---------------------------------------------------------------------------
// Global state

static QCoreApplication* g_app = nullptr;
static Database* g_db = nullptr;

#define REQUIRE_DB()                                                                               \
    do {                                                                                           \
        if (!g_db) {                                                                               \
            return fail(QStringLiteral("No database is open."));                                    \
        }                                                                                          \
    } while (false)

static Group* findGroup(const QString& uuidStr)
{
    if (!g_db || uuidStr.isEmpty()) {
        return nullptr;
    }
    const auto groups = g_db->rootGroup()->groupsRecursive(/*includeSelf=*/true);
    for (Group* g : groups) {
        if (g->uuid().toString() == uuidStr) {
            return g;
        }
    }
    return nullptr;
}

static Entry* findEntry(const QString& uuidStr)
{
    if (!g_db || uuidStr.isEmpty()) {
        return nullptr;
    }
    const auto entries = g_db->rootGroup()->entriesRecursive();
    for (Entry* e : entries) {
        if (e->uuid().toString() == uuidStr) {
            return e;
        }
    }
    return nullptr;
}

static bool findGroups(const QString& uuidStr, Group** out)
{
    *out = findGroup(uuidStr);
    return *out != nullptr;
}

// ---------------------------------------------------------------------------
// JSON helpers

static QJsonObject jsonEntry(const Entry* e, bool includeSecrets = false)
{
    QJsonObject o;
    o["uuid"] = e->uuid().toString();
    o["title"] = e->title();
    o["username"] = e->username();
    if (includeSecrets) {
        o["password"] = e->password();
    }
    o["url"] = e->url();
    o["notes"] = e->notes();
    o["icon"] = e->iconNumber();
    o["hasTotp"] = e->hasTotp();
    o["isExpired"] = e->isExpired();
    o["isRecycled"] = e->isRecycled();
    o["tags"] = QJsonArray::fromStringList(e->tagList());
    o["groupUuid"] = e->group() ? e->group()->uuid().toString() : QString();
    return o;
}

static QJsonObject jsonGroup(const Group* g)
{
    QJsonObject o;
    o["uuid"] = g->uuid().toString();
    o["name"] = g->name();
    o["icon"] = g->iconNumber();
    o["isExpanded"] = g->isExpanded();
    o["notes"] = g->notes();
    return o;
}

static QJsonObject jsonTree(const Group* g)
{
    QJsonObject o = jsonGroup(g);
    QJsonArray entries;
    const auto entryList = g->entries();
    for (const Entry* e : entryList) {
        entries.append(jsonEntry(e));
    }
    o["entries"] = entries;
    QJsonArray children;
    const auto childList = g->children();
    for (const Group* c : childList) {
        children.append(jsonTree(c));
    }
    o["children"] = children;
    return o;
}

static QString isoOrNull(const QDateTime& dt)
{
    return dt.isValid() ? dt.toUTC().toString(Qt::ISODate) : QString();
}

static QJsonObject jsonTimes(const Entry* e)
{
    const TimeInfo& t = e->timeInfo();
    QJsonObject o;
    o["created"] = isoOrNull(t.creationTime());
    o["modified"] = isoOrNull(t.lastModificationTime());
    o["accessed"] = isoOrNull(t.lastAccessTime());
    o["expires"] = t.expires();
    o["expiry"] = isoOrNull(t.expiryTime());
    return o;
}

// ---------------------------------------------------------------------------
// Key building

static QSharedPointer<CompositeKey> buildKey(const QJsonObject& keyData, QString* error)
{
    auto key = QSharedPointer<CompositeKey>::create();
    const QString password = keyData["password"].toString();
    const QString keyfilePath = keyData["keyfile"].toString();

    if (!password.isEmpty()) {
        key->addKey(QSharedPointer<PasswordKey>::create(password));
    }
    if (!keyfilePath.isEmpty()) {
        auto fk = QSharedPointer<FileKey>::create();
        QString msg;
        if (!fk->load(keyfilePath, &msg)) {
            *error = QStringLiteral("Failed to load key file: %1").arg(msg);
            return {};
        }
        key->addKey(fk);
    }
    if (key->isEmpty()) {
        *error = QStringLiteral("No credentials supplied: a password or key file is required.");
        return {};
    }
    return key;
}

// ---------------------------------------------------------------------------
// KDF construction

static QSharedPointer<Kdf> makeKdf(const QJsonObject& kdfData, QString* error)
{
    const QString name = kdfData["name"].toString(QStringLiteral("argon2id"));
    QSharedPointer<Kdf> kdf;

    if (name == QLatin1String("argon2d") || name == QLatin1String("argon2id")) {
        auto argon = QSharedPointer<Argon2Kdf>::create(
            name == QLatin1String("argon2d") ? Argon2Kdf::Type::Argon2d : Argon2Kdf::Type::Argon2id);
        const int rounds = kdfData["rounds"].toInt(2);
        const int memoryKiB = kdfData["memoryKiB"].toInt(8192);
        const int parallelism = kdfData["parallelism"].toInt(1);
        if (!argon->setRounds(rounds) || !argon->setMemory(memoryKiB) || !argon->setParallelism(parallelism)) {
            *error = QStringLiteral("Invalid Argon2 parameters.");
            return {};
        }
        kdf = argon;
    } else if (name == QLatin1String("aes")) {
        auto aes = QSharedPointer<AesKdf>::create(false);
        if (!aes->setRounds(kdfData["rounds"].toInt(100000))) {
            *error = QStringLiteral("Invalid AES-KDF rounds.");
            return {};
        }
        kdf = aes;
    } else {
        *error = QStringLiteral("Unknown KDF '%1'.").arg(name);
        return {};
    }
    return kdf;
}

static QString kdfName(const Kdf* kdf)
{
    if (kdf->uuid() == KeePass2::KDF_ARGON2ID) {
        return QStringLiteral("argon2id");
    }
    if (kdf->uuid() == KeePass2::KDF_ARGON2D) {
        return QStringLiteral("argon2d");
    }
    if (kdf->uuid() == KeePass2::KDF_AES_KDBX4) {
        return QStringLiteral("aes");
    }
    if (kdf->uuid() == KeePass2::KDF_AES_KDBX3) {
        return QStringLiteral("aes-kdbx3");
    }
    return kdf->toString();
}

static QString cipherName(const QUuid& uuid)
{
    if (uuid == KeePass2::CIPHER_AES256) {
        return QStringLiteral("aes256");
    }
    if (uuid == KeePass2::CIPHER_TWOFISH) {
        return QStringLiteral("twofish");
    }
    if (uuid == KeePass2::CIPHER_CHACHA20) {
        return QStringLiteral("chacha20");
    }
    return uuid.toString();
}

// ---------------------------------------------------------------------------
// Init / lifecycle

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_init()
{
    if (g_app) {
        return ok();
    }
    static int argc = 1;
    static char argv0[] = "keepassxc-web";
    static char* argv[2] = {argv0, nullptr};
    QCoreApplication::setEventDispatcher(new NullEventDispatcher());
    g_app = new QCoreApplication(argc, argv);

    QDir().mkpath(QStringLiteral("/keepassxc/config"));
    Config::createConfigFromFile(QStringLiteral("/keepassxc/config/keepassxc.ini"),
 QStringLiteral("/keepassxc/config/keepassxc.local.ini"));

    if (!Crypto::init()) {
        return fail(QStringLiteral("Crypto initialization failed: %1").arg(Crypto::errorString()));
    }
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_create_database(const char* pathJson)
{
    const auto doc = QJsonDocument::fromJson(QByteArray(pathJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    QString error;
    auto key = buildKey(args, &error);
    if (!key) {
        return fail(error);
    }
    auto kdf = makeKdf(args["kdf"].toObject(), &error);
    if (!kdf) {
        return fail(error);
    }

    const QString path = args["path"].toString();
    if (path.isEmpty()) {
        return fail(QStringLiteral("A database path is required."));
    }

    auto db = new Database();
    db->setKey(key);
    if (!db->changeKdf(kdf)) {
        const QString keyError = db->keyError();
        delete db;
        return fail(QStringLiteral("Failed to apply the KDF: %1").arg(keyError));
    }
    db->metadata()->setName(args["name"].toString(QStringLiteral("My Database")));

    if (!db->saveAs(path, Database::DirectWrite, {}, &error)) {
        delete db;
        return fail(QStringLiteral("Failed to save the new database: %1").arg(error));
    }

    g_db = db;
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_open(const char* pathJson)
{
    const auto doc = QJsonDocument::fromJson(QByteArray(pathJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    QString error;
    auto key = buildKey(args, &error);
    if (!key) {
        return fail(error);
    }
    const QString path = args["path"].toString();
    if (path.isEmpty()) {
        return fail(QStringLiteral("A database path is required."));
    }

    if (g_db) {
        delete g_db;
        g_db = nullptr;
    }

    auto db = new Database();
    if (!db->open(path, key, &error)) {
        const QString msg = error.isEmpty() ? QStringLiteral("Wrong key or corrupt database.") : error;
        delete db;
        return fail(msg);
    }
    g_db = db;
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_save(const char*)
{
    REQUIRE_DB();
    QString error;
    if (!g_db->save(Database::DirectWrite, {}, &error)) {
        return fail(error.isEmpty() ? QStringLiteral("Save failed.") : error);
    }
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_close(const char*)
{
    delete g_db;
    g_db = nullptr;
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_is_open(const char*)
{
    QJsonObject o;
    o["open"] = g_db != nullptr;
    return okObj(o);
}

// ---------------------------------------------------------------------------
// Reading

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_tree(const char*)
{
    REQUIRE_DB();
    QJsonObject o;
    o["name"] = g_db->metadata()->name();
    o["recycleBinUuid"] = g_db->metadata()->recycleBin()
 ? g_db->metadata()->recycleBin()->uuid().toString()
                              : QString();
    o["root"] = jsonTree(g_db->rootGroup());
    return okObj(o);
}

static const char* entryDetail(const QString& uuid)
{
    Entry* e = findEntry(uuid);
    if (!e) {
        return fail(QStringLiteral("Entry not found: %1").arg(uuid));
    }

    QJsonObject o = jsonEntry(e, /*includeSecrets=*/true);
    o["times"] = jsonTimes(e);
    o["historyCount"] = e->historyItems().size();

    // custom attributes
    QJsonArray attrs;
    const auto keys = e->attributes()->customKeys();
    for (const QString& k : keys) {
        QJsonObject a;
        a["key"] = k;
        a["value"] = e->attributes()->value(k);
        a["isProtected"] = e->attributes()->isProtected(k);
        attrs.append(a);
    }
    o["customAttributes"] = attrs;

    // attachments
    QJsonArray files;
    const auto fkeys = e->attachments()->keys();
    for (const QString& k : fkeys) {
        QJsonObject f;
        f["key"] = k;
        f["size"] = static_cast<int>(e->attachments()->value(k).size());
        files.append(f);
    }
    o["attachments"] = files;

    // totp
    bool totpValid = false;
    const QString code = e->totp(&totpValid);
    o["totp"] = code;
    o["totpValid"] = totpValid;
    const auto settings = e->totpSettings();
    if (settings) {
        o["totpStep"] = static_cast<int>(settings->step);
        o["totpDigits"] = static_cast<int>(settings->digits);
    }
    return okObj(o);
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_entry_detail(const char* uuid)
{
    REQUIRE_DB();
    return entryDetail(uuid ? QString::fromUtf8(uuid) : QString());
}

static const char* attachmentData(const QString& uuid, const QString& fileName)
{
    Entry* e = findEntry(uuid);
    if (!e) {
        return fail(QStringLiteral("Entry not found."));
    }
    const QByteArray data = e->attachments()->value(fileName);
    if (data.isNull() && !e->attachments()->keys().contains(fileName)) {
        return fail(QStringLiteral("Attachment not found: %1").arg(fileName));
    }
    QJsonObject o;
    o["key"] = fileName;
    o["data"] = QString::fromUtf8(data.toBase64());
    return okObj(o);
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_attachment_data(const char* uuid, const char* fileName)
{
    REQUIRE_DB();
    return attachmentData(uuid ? QString::fromUtf8(uuid) : QString(),
                          fileName ? QString::fromUtf8(fileName) : QString());
}

// ---------------------------------------------------------------------------
// Writing

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_add_group(const char* argsJson)
{
    REQUIRE_DB();
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    Group* parent = nullptr;
    if (!findGroups(args["parentUuid"].toString(), &parent) || !parent) {
        return fail(QStringLiteral("Parent group not found."));
    }
    auto group = new Group();
    group->setUuid(QUuid::createUuid());
    group->setName(args["name"].toString(QStringLiteral("New Group")));
    group->setIcon(args["icon"].toInt(48));
    group->setNotes(args["notes"].toString());
    group->setParent(parent);
    QJsonObject res;
    res["uuid"] = group->uuid().toString();
    return okObj(res);
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_update_group(const char* argsJson)
{
    REQUIRE_DB();
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    Group* g = findGroup(args["uuid"].toString());
    if (!g) {
        return fail(QStringLiteral("Group not found."));
    }
    if (args.contains("name")) {
        g->setName(args["name"].toString());
    }
    if (args.contains("icon")) {
        g->setIcon(args["icon"].toInt());
    }
    if (args.contains("notes")) {
        g->setNotes(args["notes"].toString());
    }
    if (args.contains("isExpanded")) {
        g->setExpanded(args["isExpanded"].toBool());
    }
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_move_group(const char* argsJson)
{
    REQUIRE_DB();
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    Group* g = findGroup(args["uuid"].toString());
    if (!g) {
        return fail(QStringLiteral("Group not found."));
    }
    Group* target = nullptr;
    if (!findGroups(args["parentUuid"].toString(), &target) || !target) {
        return fail(QStringLiteral("Target group not found."));
    }
    if (g == target || g->groupsRecursive(/*includeSelf=*/true).contains(target)) {
        return fail(QStringLiteral("Cannot move a group into itself."));
    }
    g->setParent(target);
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_delete_group(const char* argsJson)
{
    REQUIRE_DB();
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    Group* g = findGroup(args["uuid"].toString());
    if (!g) {
        return fail(QStringLiteral("Group not found."));
    }
    if (g == g_db->rootGroup()) {
        return fail(QStringLiteral("Cannot delete the root group."));
    }
    if (g_db->metadata()->recycleBin() && g == g_db->metadata()->recycleBin()) {
        return fail(QStringLiteral("Cannot delete the recycle bin; empty it instead."));
    }
    if (!g->isRecycled() && g_db->metadata()->recycleBinEnabled()) {
        g_db->recycleGroup(g);
    } else {
        delete g;
    }
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_empty_recycle_bin(const char*)
{
    REQUIRE_DB();
    if (!g_db->metadata()->recycleBin()) {
        return ok();
    }
    g_db->emptyRecycleBin();
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_add_entry(const char* argsJson)
{
    REQUIRE_DB();
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    Group* group = nullptr;
    if (!findGroups(args["groupUuid"].toString(), &group) || !group) {
        return fail(QStringLiteral("Group not found."));
    }

    auto entry = new Entry();
    entry->setUuid(QUuid::createUuid());
    entry->setTitle(args["title"].toString(QStringLiteral("New Entry")));
    entry->setUsername(args["username"].toString());
    entry->setPassword(args["password"].toString());
    entry->setUrl(args["url"].toString());
    entry->setNotes(args["notes"].toString());
    entry->setIcon(args["icon"].toInt(0));
    entry->setTags(args["tags"].toString());
    entry->setGroup(group);

    QJsonObject res;
    res["uuid"] = entry->uuid().toString();
    return okObj(res);
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_update_entry(const char* argsJson)
{
    REQUIRE_DB();
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    Entry* e = findEntry(args["uuid"].toString());
    if (!e) {
        return fail(QStringLiteral("Entry not found."));
    }
    e->beginUpdate();
    if (args.contains("title")) {
        e->setTitle(args["title"].toString());
    }
    if (args.contains("username")) {
        e->setUsername(args["username"].toString());
    }
    if (args.contains("password")) {
        e->setPassword(args["password"].toString());
    }
    if (args.contains("url")) {
        e->setUrl(args["url"].toString());
    }
    if (args.contains("notes")) {
        e->setNotes(args["notes"].toString());
    }
    if (args.contains("icon")) {
        e->setIcon(args["icon"].toInt());
    }
    if (args.contains("tags")) {
        e->setTags(args["tags"].toString());
    }
    if (args.contains("expires") || args.contains("expiry")) {
        TimeInfo t = e->timeInfo();
        if (args.contains("expires")) {
            t.setExpires(args["expires"].toBool());
        }
        if (args.contains("expiry")) {
            const QDateTime dt = QDateTime::fromString(args["expiry"].toString(), Qt::ISODate);
            if (dt.isValid()) {
                t.setExpiryTime(dt);
            }
        }
        e->setTimeInfo(t);
    }
    e->endUpdate();
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_move_entry(const char* argsJson)
{
    REQUIRE_DB();
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    Entry* e = findEntry(args["uuid"].toString());
    if (!e) {
        return fail(QStringLiteral("Entry not found."));
    }
    Group* target = nullptr;
    if (!findGroups(args["groupUuid"].toString(), &target) || !target) {
        return fail(QStringLiteral("Target group not found."));
    }
    e->setGroup(target);
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_delete_entry(const char* argsJson)
{
    REQUIRE_DB();
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    Entry* e = findEntry(args["uuid"].toString());
    if (!e) {
        return fail(QStringLiteral("Entry not found."));
    }
    if (!e->isRecycled() && g_db->metadata()->recycleBinEnabled()) {
        g_db->recycleEntry(e);
    } else {
        delete e;
    }
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_restore_entry(const char* argsJson)
{
    REQUIRE_DB();
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    Entry* e = findEntry(args["uuid"].toString());
    if (!e) {
        return fail(QStringLiteral("Entry not found."));
    }
    Group* target = findGroup(args["groupUuid"].toString());
    if (!target) {
        return fail(QStringLiteral("Target group not found."));
    }
    e->beginUpdate();
    e->setGroup(target);
    e->endUpdate();
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_set_totp(const char* argsJson)
{
    REQUIRE_DB();
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    Entry* e = findEntry(args["uuid"].toString());
    if (!e) {
        return fail(QStringLiteral("Entry not found."));
    }

    const QString key = args["key"].toString().trimmed();
    if (key.isEmpty()) {
        // setTotp() opens its own beginUpdate/endUpdate block; wrapping it
        // again trips Q_ASSERT(m_tmpHistoryItem.isNull()) in beginUpdate.
        e->setTotp(nullptr);
        return ok();
    }

    auto settings = Totp::createSettings(key,
                                          args["digits"].toInt(6),
                                          args["step"].toInt(30),
                                          Totp::OTPURL,
                                          args["encoder"].toString(),
                                          static_cast<Totp::Algorithm>(args["algorithm"].toInt(Totp::Sha1)));
    if (!settings) {
        return fail(QStringLiteral("Invalid TOTP secret: expected a Base32 string."));
    }
    const QString validation = Totp::checkValidSettings(settings);
    if (!validation.isEmpty()) {
        return fail(validation);
    }
    e->setTotp(settings);
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_entry_totp(const char* uuid)
{
    REQUIRE_DB();
    Entry* e = findEntry(uuid ? QString::fromUtf8(uuid) : QString());
    if (!e) {
        return fail(QStringLiteral("Entry not found."));
    }
    bool valid = false;
    const QString code = e->totp(&valid);
    QJsonObject o;
    o["code"] = code;
    o["valid"] = valid;
    const auto settings = e->totpSettings();
    if (settings) {
        o["step"] = static_cast<int>(settings->step);
    }
    return okObj(o);
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_add_attachment(const char* argsJson)
{
    REQUIRE_DB();
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    Entry* e = findEntry(args["uuid"].toString());
    if (!e) {
        return fail(QStringLiteral("Entry not found."));
    }
    const QString fileName = args["name"].toString();
    if (fileName.isEmpty()) {
        return fail(QStringLiteral("Attachment name is required."));
    }
    const QByteArray data = QByteArray::fromBase64(args["data"].toString().toUtf8());
    e->beginUpdate();
    e->attachments()->set(fileName, data);
    e->endUpdate();
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_remove_attachment(const char* argsJson)
{
    REQUIRE_DB();
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    Entry* e = findEntry(args["uuid"].toString());
    if (!e) {
        return fail(QStringLiteral("Entry not found."));
    }
    const QString fileName = args["name"].toString();
    if (!e->attachments()->keys().contains(fileName)) {
        return fail(QStringLiteral("Attachment not found: %1").arg(fileName));
    }
    e->beginUpdate();
    e->attachments()->remove(fileName);
    e->endUpdate();
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_set_attribute(const char* argsJson)
{
    REQUIRE_DB();
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    Entry* e = findEntry(args["uuid"].toString());
    if (!e) {
        return fail(QStringLiteral("Entry not found."));
    }
    const QString key = args["key"].toString();
    if (key.isEmpty()) {
        return fail(QStringLiteral("Attribute name is required."));
    }
    e->beginUpdate();
    e->attributes()->set(key, args["value"].toString(), args["protect"].toBool(false));
    e->endUpdate();
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_remove_attribute(const char* argsJson)
{
    REQUIRE_DB();
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    Entry* e = findEntry(args["uuid"].toString());
    if (!e) {
        return fail(QStringLiteral("Entry not found."));
    }
    const QString key = args["key"].toString();
    if (!e->attributes()->customKeys().contains(key)) {
        return fail(QStringLiteral("Attribute not found: %1").arg(key));
    }
    e->beginUpdate();
    e->attributes()->remove(key);
    e->endUpdate();
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_history_restore(const char* argsJson)
{    REQUIRE_DB();
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    Entry* e = findEntry(args["uuid"].toString());
    if (!e) {
        return fail(QStringLiteral("Entry not found."));
    }
    const int index = args["index"].toInt(-1);
    const auto history = e->historyItems();
    if (index < 0 || index >= history.size()) {
        return fail(QStringLiteral("History item not found."));
    }
    e->beginUpdate();
    e->copyDataFrom(history.at(index));
    e->endUpdate();
    return ok();
}

// ---------------------------------------------------------------------------
// Search / reports / generators / info

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_search(const char* term)
{
    REQUIRE_DB();
    const QString q = term ? QString::fromUtf8(term) : QString();
    if (q.trimmed().isEmpty()) {
        return okArr({});
    }
    EntrySearcher searcher;
    const auto found = searcher.search(q, g_db->rootGroup());
    QJsonArray arr;
    for (const Entry* e : found) {
        arr.append(jsonEntry(e));
    }
    return okArr(arr);
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_password_health(const char* password)
{
    const QString pwd = password ? QString::fromUtf8(password) : QString();
    PasswordHealth health(pwd);
    QJsonObject o;
    o["score"] = health.score();
    o["quality"] = static_cast<int>(health.quality());
    o["entropy"] = health.entropy();
    o["reason"] = health.scoreReason();
    o["details"] = health.scoreDetails();
    return okObj(o);
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_generate_password(const char* argsJson)
{
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    PasswordGenerator gen;
    gen.setLength(args["length"].toInt(20));
    gen.setCharClasses(static_cast<PasswordGenerator::CharClasses>(args["charClasses"].toInt(7)));
    gen.setFlags(static_cast<PasswordGenerator::GeneratorFlags>(args["flags"].toInt(3)));
    gen.setExcludedCharacterSet(args["exclude"].toString());
    gen.setCustomCharacterSet(args["custom"].toString());

    if (!gen.isValid()) {
        return fail(QStringLiteral("The requested password settings cannot produce a password."));
    }
    QJsonObject o;
    o["password"] = gen.generatePassword();
    return okObj(o);
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_generate_passphrase(const char* argsJson)
{
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    PassphraseGenerator gen;
    gen.setWordCount(args["wordCount"].toInt(6));
    gen.setWordSeparator(args["separator"].toString(QStringLiteral(" ")));
    gen.setDefaultWordList();
    if (!gen.isWordListValid()) {
        return fail(QStringLiteral("The word list is unavailable; check that /data/wordlists is present."));
    }
    QJsonObject o;
    o["passphrase"] = gen.generatePassphrase();
    return okObj(o);
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_db_info(const char*)
{
    REQUIRE_DB();
    QJsonObject o;
    const auto kdf = g_db->kdf();
    o["kdf"] = kdfName(kdf.data());
    o["kdfRounds"] = kdf->rounds();
    if (kdf->uuid() == KeePass2::KDF_ARGON2ID || kdf->uuid() == KeePass2::KDF_ARGON2D) {
        const auto argon = static_cast<const Argon2Kdf*>(kdf.data());
        o["kdfMemoryMiB"] = static_cast<double>(argon->memory()) / 1024.0;
        o["kdfParallelism"] = static_cast<int>(argon->parallelism());
    }
    o["cipher"] = cipherName(g_db->cipher());
    const quint32 v = g_db->formatVersion();
    o["formatVersion"] =
        QStringLiteral("%1.%2").arg(QString::number(v >> 16), QString::number(v & 0xFFFF));
    o["name"] = g_db->metadata()->name();
    o["entries"] = g_db->rootGroup()->entriesRecursive().size();
    o["path"] = g_db->filePath();
    o["recycleBinEnabled"] = g_db->metadata()->recycleBinEnabled();
    return okObj(o);
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_change_credentials(const char* argsJson)
{
    REQUIRE_DB();
    const auto doc = QJsonDocument::fromJson(QByteArray(argsJson), nullptr);
    if (!doc.isObject()) {
        return fail(QStringLiteral("Invalid arguments."));
    }
    const QJsonObject args = doc.object();

    QString error;
    auto key = buildKey(args, &error);
    if (!key) {
        return fail(error);
    }
    if (!g_db->setKey(key, /*updateChangedTime=*/true, /*updateTransformSalt=*/true)) {
        return fail(QStringLiteral("Failed to change credentials: %1").arg(g_db->keyError()));
    }
    return ok();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* kpx_version(const char*)
{
    QJsonObject o;
    o["version"] = QStringLiteral(KEEPASSXC_VERSION);
    o["crypto"] = QStringLiteral("Botan 3");
    return okObj(o);
}
