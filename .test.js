// jshint esversion: 6

'use strict';

const eproxy = require('./index.js');

let compressRequest = true;

let workerOptions = {
    textNetOptions: {
        // config for active worker
        // serverAddresses: [
        //    { host: 'localhost', port: 9100 }
        // ],
        // autoRegister: true,
        // idlePingTimeout: 30000,
        // reconnectInterval: 3000,

        // config for passive worker
        port: 9102,
        backlog: 1024,
        idleCloseTimeout: 60000,

        // config for log
        logConnection: true,
        logSession: false
    },
    proxyOptions: {
        logEvent: false,
        logError: true,
        logAccess: true,
        compressRequest: compressRequest
    }
};

let serverOptions = {
    textNetOptions: {
        // config for passive server
        // port: 9101,
        // backlog: 1024,
        // idleCloseTimeout: 60000,

        // config for active server
        workerAddresses: [
            { host: 'localhost', port: 9102 }
        ],
        idlePingTimeout: 30000,
        reconnectInterval: 3000,

        // config for log
        logConnection: true,
        logSession: false
    },
    proxyOptions: {
        ports: [9090],
        backlog: 1024,
        logEvent: false,
        logError: true,
        logAccess: true,
        compressRequest: compressRequest
    }
};

var appType = process.argv[2];

if (appType === 'server') {
    eproxy.startServer(serverOptions);
}
else if (appType === 'worker') {
    eproxy.startWorker(workerOptions);
}
