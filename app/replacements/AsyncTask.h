/*
 *  AsyncTask.h - WebAssembly replacement for the upstream header.
 *  Copyright (C) 2017 KeePassXC Team <team@keepassxc.org>
 *  Copyright (C) 2026 keepassxc-web contributors
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 2 or (at your option)
 *  version 3 of the License.
 *
 *  The single-threaded WebAssembly runtime has no QtConcurrent thread pool
 *  and no event loop to spin while waiting, so tasks run synchronously.
 */

#ifndef KEEPASSXC_ASYNCTASK_HPP
#define KEEPASSXC_ASYNCTASK_HPP

#include <QObject>

/**
 * Run computations that would normally leave the GUI thread.
 */
namespace AsyncTask
{

    /**
     * Run the given task and return its result. Runs synchronously on wasm.
     *
     * @param task std::function object to run
     * @return task result
     */
    template <typename FunctionObject> decltype(auto) runAndWaitForFuture(FunctionObject task)
    {
        return task();
    }

    /**
     * Run a given task then call the defined callback.
     *
     * @param task std::function object to run
     * @param context QObject responsible for calling this function (unused)
     * @param callback std::function object to run after the task completes
     */
    template <typename FunctionObject, typename FunctionObject2>
    void runThenCallback(FunctionObject task, QObject* context, FunctionObject2 callback)
    {
        Q_UNUSED(context);
        callback(task());
    }

}; // namespace AsyncTask

#endif // KEEPASSXC_ASYNCTASK_HPP
