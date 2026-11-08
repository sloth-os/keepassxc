cmake_minimum_required(VERSION 3.20)
project(keepassxc-web LANGUAGES C CXX)

# C++20: Botan 3.6's secmem.h uses a `requires` clause that is only valid
# syntax under C++20 (its _ITERATOR_DEBUG_LEVEL guard doesn't cover the
# default, non-MSVC case).
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Prebuilt dependencies (scripts/build.sh fills in the default paths; see
# README.md for how each prebuilt is produced).
set(QT_WASM "" CACHE PATH "Qt 6 wasm_singlethread install prefix")
set(QT_HOST "" CACHE PATH "Qt 6 host install prefix (provides moc)")
set(BOTAN "" CACHE PATH "Botan 3 wasm install prefix")
set(ZLIB "" CACHE PATH "zlib wasm install prefix")

foreach(dep IN ITEMS QT_WASM QT_HOST BOTAN ZLIB)
    if(NOT ${dep})
        message(FATAL_ERROR "${dep} must be set on the cmake command line (see scripts/build.sh)")
    endif()
endforeach()
foreach(lib IN ITEMS
        "${QT_WASM}/lib/libQt6Core.a"
        "${QT_WASM}/lib/libQt6BundledPcre2.a"
        "${QT_HOST}/libexec/moc"
        "${BOTAN}/lib/libbotan-3.a"
        "${ZLIB}/lib/libz.a")
    if(NOT EXISTS "${lib}")
        message(FATAL_ERROR "missing prebuilt dependency file: ${lib}")
    endif()
endforeach()

if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/src/core/Database.cpp")
    message(FATAL_ERROR "src/ is empty — run scripts/vendor.sh first")
endif()
if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/data/wordlists/eff_large.wordlist")
    message(FATAL_ERROR "data/wordlists is missing — run scripts/vendor.sh first")
endif()

# ---------------------------------------------------------------------------
# Sources: the vendored KeePassXC headless core (see scripts/vendor.sh).
file(GLOB_RECURSE KPXC_SOURCES CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/*.c")

# Generate moc files for every header that declares Q_OBJECT / Q_GADGET /
# Q_NAMESPACE. The wasm Qt package ships no host tools, so the HOST moc runs
# on the vendored headers; the -f flag makes each generated file include its
# header by a src/-relative path, which the include path below resolves.
set(MOC_EXECUTABLE "${QT_HOST}/libexec/moc")
file(GLOB_RECURSE KPXC_HEADERS CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/src/*.h")
set(MOC_SOURCES "")
foreach(hdr IN LISTS KPXC_HEADERS)
    file(READ "${hdr}" _hdr_content)
    if(_hdr_content MATCHES "Q_OBJECT|Q_GADGET|Q_NAMESPACE")
        cmake_path(RELATIVE_PATH hdr BASE_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/src" OUTPUT_VARIABLE _rel)
        string(REGEX REPLACE "\\.h$" "" _name "${_rel}")
        string(REPLACE "/" "_" _name "${_name}")
        set(_out "${CMAKE_CURRENT_BINARY_DIR}/moc/moc_${_name}.cpp")
        add_custom_command(
            OUTPUT "${_out}"
            COMMAND "${MOC_EXECUTABLE}" "-f${_rel}" "${hdr}" -o "${_out}"
            DEPENDS "${hdr}"
            COMMENT "moc ${_rel}"
            VERBATIM)
        list(APPEND MOC_SOURCES "${_out}")
    endif()
endforeach()
if(NOT MOC_SOURCES)
    message(FATAL_ERROR "no moc candidates found under src/ — vendoring is broken")
endif()

add_executable(keepassxc
    ${KPXC_SOURCES}
    ${MOC_SOURCES}
    "${CMAKE_CURRENT_SOURCE_DIR}/app/wasm/bridge.cpp")

set_target_properties(keepassxc PROPERTIES SUFFIX ".js")

target_include_directories(keepassxc PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/thirdparty/zxcvbn"
    "${CMAKE_CURRENT_SOURCE_DIR}/app"
    "${QT_WASM}/include"
    "${QT_WASM}/include/QtCore"
    "${QT_WASM}/mkspecs/wasm-emscripten"
    "${BOTAN}/include/botan-3"
    "${ZLIB}/include")

# Exception handling: JS-EH everywhere. Botan and libQt6Core.a both contain
# real throw/catch code, so exceptions must be enabled at compile AND link
# time, and DISABLE_EXCEPTION_CATCHING must stay off. (This is why the build
# does not link through Qt6::Platform, which forces
# DISABLE_EXCEPTION_CATCHING=1.)
add_compile_options(-fexceptions -sDISABLE_EXCEPTION_CATCHING=0)

# Static libraries, in dependency order: core objects -> Qt6Core (PCRE2
# bundled separately) -> zlib (for qtiocompressor) -> Botan.
#
# Two zlib copies on purpose: Qt6Core's qresource.cpp references
# z_-prefixed symbols supplied by the Qt prebuilt's own bundled zlib, while
# the vendored qtiocompressor uses plain deflate/inflate from our zlib
# build. The archives define disjoint symbol sets, so they do not collide.
target_link_libraries(keepassxc PRIVATE
    "${QT_WASM}/lib/libQt6Core.a"
    "${QT_WASM}/lib/libQt6BundledPcre2.a"
    "${QT_WASM}/lib/libQt6BundledZLIB.a"
    "${ZLIB}/lib/libz.a"
    "${BOTAN}/lib/libbotan-3.a")

target_link_options(keepassxc PRIVATE
    -fexceptions
    -sDISABLE_EXCEPTION_CATCHING=0
    # Qt6Core wasm uses emscripten::val (emval) internally (qlocale_wasm,
    # qbytearray); the _emval_* helpers are a JS library, enabled by -lembind.
    -lembind
    --no-entry
    -sMODULARIZE=1
    -sEXPORT_NAME=createKeePassXCModule
    -sENVIRONMENT=web,node
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=128MB
    -sSTACK_SIZE=5MB
    -sWASM_BIGINT=1
    -sFORCE_FILESYSTEM=1
    -sEXPORTED_RUNTIME_METHODS=FS,IDBFS,UTF8ToString,allocateUTF8
    -sEXPORTED_FUNCTIONS=_malloc,_free
    -lidbfs.js
    --pre-js=${CMAKE_CURRENT_SOURCE_DIR}/app/wasm/pre.js
    --preload-file=${CMAKE_CURRENT_SOURCE_DIR}/data@/data)
