// jshint esversion: 6

/**
 * http://usejsdoc.org/
 */

'use strict';

const net = require('net');
const os = require('os');
const http = require('http');
const textNet = require('@rankwave/nodejs-text-net');
const createDefaultHandler = require('./default-handler').createDefaultHandler;
const createElasticHandler = require('./elastic-handler').createElasticHandler;
const createElasticWorker = require('./elastic-worker').createElasticWorker;

/*****************************************************************************************************************
 * server main entry point
 */

function startServer(options) {
	var textNetOptions = options.textNetOptions;
	var proxyOptions = options.proxyOptions;
	var workerPool = textNet.createWorkerPool();

	/*************************************************************************************************************
	 * worker listener
	 */

	if (textNetOptions.port) {
		textNetOptions.workerPool = workerPool;
		textNet.startWorkerPoolServer(textNetOptions, (server) => {
			console.log(`Worker Server Started (port: ${textNetOptions.port})`);
		});
	}

	/*************************************************************************************************************
	 * worker connector
	 */

	if (textNetOptions.workerAddresses && textNetOptions.workerAddresses.length) {
		textNetOptions.workerAddresses.forEach(addr => {
			var workerOptions = Object.assign({}, textNetOptions, addr);
			textNet.autoReconnect(workerOptions, (client) => {
				client.on('RGST', (msg) => {
					workerPool.addClient(client);
				});

				client.on('error', (e) => {
					workerPool.deleteClient(client);
				});

				client.on('close', () => {
					workerPool.deleteClient(client);
				});
			});
		});
	}

	/*************************************************************************************************************
	 * proxy handler
	 */

	var defaultHandler = createDefaultHandler(proxyOptions);
	var elasticHandler = createElasticHandler(workerPool, proxyOptions);

	/*************************************************************************************************************
	 * http server
	 */

	function createServer(serverOptions) {
		var server = http.createServer();
		let logEvent = serverOptions && serverOptions.proxyOptions && serverOptions.proxyOptions.logEvent;

		server.on('checkContinue', (req, res) => {
			if (logEvent) {
				console.log('server "checkContinue"');
			}
			res.writeContinue();
			server.emit('request', req, res);
		});

		server.on('connect', (req, socket, head) => {
			if (workerPool.getPoolSize() > 0) {
				elasticHandler.proxyConnect(req, socket, head);
			}
			else {
				defaultHandler.proxyConnect(req, socket, head);
			}
		});

		server.on('request', (req, res) => {
			if (workerPool.getPoolSize() > 0) {
				elasticHandler.proxyRequest(req, res);
			}
			else {
				defaultHandler.proxyRequest(req, res);
			}
		});

		server.listen(serverOptions, () => {
			console.log(`HTTP Server Started (port: ${serverOptions.port})`);
		});
	}

	for (var i = 0; i < proxyOptions.ports.length; i++) {
		var serverOptions = Object.assign({}, proxyOptions, { port: proxyOptions.ports[i] });
		createServer(serverOptions);
	}
}

/*****************************************************************************************************************
 * worker main entry point
 */

function startWorker(options) {
	var textNetOptions = options.textNetOptions;
	var proxyOptions = options.proxyOptions;
	var workerStarting = false;

	/*************************************************************************************************************
	 * proxy handler
	 */

	var elasticWorker = createElasticWorker(proxyOptions);

	function onConnected(client) {
		client.onSession('HTTP', (session) => elasticWorker.onHttpSession(session));
	}

	/*************************************************************************************************************
	 * active worker
	 */

	if (textNetOptions.serverAddresses && textNetOptions.serverAddresses.length) {
		workerStarting = true;
		for (var i = 0; i < textNetOptions.serverAddresses.length; i++) {
			var workerOptions = Object.assign({}, textNetOptions, textNetOptions.serverAddresses[i]);
			textNet.autoReconnect(workerOptions, onConnected);
		}
	}

	/*************************************************************************************************************
	 * passive worker
	 */

	if (textNetOptions.port) {
		workerStarting = true;
		var server = textNet.createServer(textNetOptions);

		server.on('client', (client) => {
			client.sendMessage('RGST', 0, os.hostname());
			if (textNetOptions.logConnection) {
				console.log(`RGST ${os.hostname()} to ${client.address} sent`);
			}
			onConnected(client);
		});

		server.listen({ port: textNetOptions.port, backlog: textNetOptions.backlog }, () => {
			if (textNetOptions.logConnection) {
				console.log(`LISTEN ${textNetOptions.port}`);
			}
		});
	}

	/*************************************************************************************************************
	 * check active or passive error
	 */

	if (!workerStarting) {
		console.error('ERROR: There is neither active nor passive worker config.');
	}
}

module.exports = {
	startServer: startServer,
	startWorker: startWorker
};