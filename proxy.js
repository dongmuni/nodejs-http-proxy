// jshint esversion: 6

/**
 * http://usejsdoc.org/
 */

'use strict';

const net 		= require('net');
const http		= require('http');
const textNet	= require('@rankwave/nodejs-text-net');
const createDefaultHandler = require('./default-handler').createDefaultHandler;
const createElasticHandler = require('./elastic-handler').createElasticHandler;
const createElasticWorker  = require('./elastic-worker').createElasticWorker;

function startServer(options)
{
	var textNetOptions = options.textNetOptions;
	var proxyOptions = options.proxyOptions;
	
	/*************************************************************************************************************
	 * worker listener
	 */

	var workerPool = textNet.startWorkerPoolServer(textNetOptions, (server) => {
		console.log(`Worker Server Started (port: ${textNetOptions.port})`);
	});

	/*************************************************************************************************************
	 * proxy handler
	 */

	var defaultHandler = createDefaultHandler(proxyOptions);
	var elasticHandler = createElasticHandler(workerPool, proxyOptions);

	/*************************************************************************************************************
	 * http server
	 */
	
	function createServer(serverOptions)
	{
		var server = http.createServer();

		server.on('checkContinue', (req, res) => {
			console.log('server "checkContinue"');
			res.writeContinue();
			server.emit('request', req, res);
		});

		server.on('connect', (req, socket, head) => {
			if ( workerPool.getPoolSize() > 0 )
			{
				elasticHandler.proxyConnect(req, socket, head);
			}
			else
			{
				defaultHandler.proxyConnect(req, socket, head);
			}
		});

		server.on('request', (req, res) => {
			if ( workerPool.getPoolSize() > 0 )
			{
				elasticHandler.proxyRequest(req, res);
			}
			else
			{
				defaultHandler.proxyRequest(req, res);
			}
		});

		server.listen(serverOptions, () => {
			console.log(`HTTP Server Started (port: ${serverOptions.port})`);
		});
	}
	
	for ( var i = 0 ; i < proxyOptions.ports.length ; i++ )
	{
		var serverOptions = Object.assign({}, proxyOptions, {port: proxyOptions.ports[i]});
		createServer(serverOptions);
	}
}

function startWorker(options)
{
	var textNetOptions = options.textNetOptions;
	var proxyOptions = options.proxyOptions;
	
	/*************************************************************************************************************
	 * proxy handler
	 */

	var elasticWorker = createElasticWorker(proxyOptions);
	
	function onConnected(client)
	{
		client.onSession('HTTP', (session) => elasticWorker.onHttpSession(session));
	}
	
	for ( var i = 0 ; i < textNetOptions.serverAddresses.length ; i++  )
	{
		var workerOptions = Object.assign({}, textNetOptions, textNetOptions.serverAddresses[i]);
		textNet.autoReconnect(workerOptions, onConnected);		
	}
}

module.exports = {
		startServer: startServer,
		startWorker: startWorker
};