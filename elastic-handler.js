// jshint esversion: 6

/**
 * http://usejsdoc.org/
 */

'use strict';

const path = require('path');
const http = require('http');
const url = require('url');
const net = require('net');
const stream = require('stream');
const HTTPParser = require('http-parser-js').HTTPParser;
const rnju = require('@rankwave/nodejs-util');

const Transform = stream.Transform;
const ByteCounter = rnju.stream.ByteCounter;
const rawHeadersToMap = rnju.http.rawHeadersToMap;
const getOption = rnju.common.getOption;
const ipv4 = rnju.common.ipv4;

function createElasticHandler(workerPool, options)
{
	var logEvent  = getOption(options, 'logEvent', false);
	var logError  = getOption(options, 'logError', true);
	var logAccess = getOption(options, 'logAccess', true);
	var lowerCaseHeaderName = getOption(options, 'lowerCaseHeaderName', false);
	
	function proxyConnect(/* IncomingMessage */ req, /* Socket */ cltSocket, /* Buffer */ head) 
	{
		var remoteAddress = ipv4(cltSocket.remoteAddress);
		
		if ( logEvent )
		{
			console.log(`REQ ${remoteAddress} "${req.method} ${req.url} HTTP/${req.httpVersion}"`);
		}
		
		var responseSent = false;
		var isPiped = false;
		
		var stat = {
				statusCode: 200,
				ellipse: Date.now(),
		};
		
		var reqCounter = new ByteCounter();
		var resCounter = new ByteCounter();
		
		var session = workerPool.createSession('HTTP', ['CONNECT']);
		var resParser = new HTTPParser(HTTPParser.RESPONSE);
		
		/*******************/
		/** parser events **/
		/*******************/
		
		/*
		 *	HTTPParser {
		 *	  '0': [Function],
		 *	  '1': [Function],
		 *	  '2': [Function],
		 *	  '3': [Function],
		 *	  type: 'RESPONSE',
		 *	  state: 'HEADER',
		 *	  info: 
		 *	   { headers: 
		 *	      [ 'Date', 'Thu, 13 Apr 2017 11:26:40 GMT',
		 *	        'Server', 'Apache',
		 *	        'Content-Language', 'ko,ko-kr',
		 *	        'cache-control', 'no-cache',
		 *	        'expires', '0',
		 *	        'pragma', 'no-cache',
		 *	        'Content-Type', 'text/html; charset=EUC-KR',
		 *	        'Connection', 'close',
		 *	        'Transfer-Encoding', 'chunked' ],
		 *	     upgrade: false,
		 *	     versionMajor: 1,
		 *	     versionMinor: 1,
		 *	     statusCode: 200,
		 *	     statusMessage: 'OK',
		 *	     shouldKeepAlive: false },
		 *	  trailers: [],
		 *	  line: '',
		 *	  isChunked: true,
		 *	  connection: 'close',
		 *	  headerSize: 0,
		 *	  body_bytes: null,
		 *	  isUserCall: true,
		 *	  hadError: false,
		 *	  _compatMode0_11: true,
		 *	  chunk: <Buffer 48 54 54 ... >,
		 *	  offset: 243,
		 *	  end: 1024 }
		 */
	
		resParser.onHeadersComplete = function(info) {
			var responseHeader = `HTTP/1.1 ${info.statusCode} ${info.statusMessage}\r\n\r\n`;
			stat.statusCode = info.statusCode;
			cltSocket.write(responseHeader);
			responseSent = true;
			
			if ( info.statusCode === 200 )
			{
				session.removeAllListeners('data');
				
				if ( resParser.end > resParser.offset )
				{
					var head = resParser.chunk.slice(resParser.offset, resParser.end);
					cltSocket.write(head);
				}
				
				cltSocket.pipe(reqCounter).pipe(session);
				session.pipe(resCounter).pipe(cltSocket);
				isPiped = true;
			}
			else
			{
				session.destroy();
				cltSocket.destroy();
			}
		};
		
		/**************************/
		/** client socket events **/
		/**************************/
		
		cltSocket._endEventOccured = false;
		
		function onCltSocketCloseOrError()
		{
			if ( !isPiped )
			{
				session.destroy();
			}
			else if ( !cltSocket._endEventOccured )
			{
				session.destroy();
			}
		}
	
		cltSocket.on('end', (had_error) => {
			if ( logEvent )
			{
				console.log('server "connect" cltSocket "end"');
			}
			cltSocket._endEventOccured = true;
			onCltSocketCloseOrError();
		});
		
		cltSocket.on('close', (had_error) => {
			if ( logEvent )
			{
				console.log('server "connect" cltSocket "close"');
			}
			if ( logAccess )
			{
				stat.ellipse = Date.now() - stat.ellipse;
				console.log(`RES ${remoteAddress} "${req.method} ${req.url} HTTP/${req.httpVersion}" ${stat.statusCode} ${reqCounter.bytesPiped} ${resCounter.bytesPiped} ${stat.ellipse}`);
			}
			onCltSocketCloseOrError();
		});
		
		cltSocket.on('error', (e) => {
			cltSocket.destroy();
			onCltSocketCloseOrError();
		});
	
		/***************************/
		/** worker session events **/
		/***************************/
		
		session.on('data', (chunk) => {
			if ( logEvent )
			{
				console.log('server "connect" session "data"');
			}
			resParser.execute(chunk);
		});
		
		function onSessionCloseOrError()
		{
			if ( !isPiped )
			{
				if ( !responseSent )
				{
					stat.statusCode = 500;
					cltSocket.write('HTTP/1.1 500 Connection Error\r\n\r\n');
					responseSent = true;
				}
				cltSocket.end();
			}
		}
		
		session.on('end', () => {
			if ( logEvent )
			{
				console.log('server "connect" session "end"');
			}
			onSessionCloseOrError();
		});
		
		session.on('close', (e) => {
			if ( e ) 
			{
				if ( logError )
				{
					console.log('server "connect" session "close"');
					console.log(e);
				}
			}
			onSessionCloseOrError();
		});
		
		session.on('error', (e) => {
			if ( logError )
			{
				console.log('server "connect" session "error"');
				console.log(e);
			}
			onSessionCloseOrError();
		});
		
		/************************************
		 * send data
		 ************************************/
		
		session.write(`CONNECT ${req.url} HTTP/1.1\r\n\r\n`);
		if ( head && head.length )
		{
			session.write(head);
		}
	}
	
	
	function proxyRequest(/* IncomingMessage */ req, /* ServerResponse */ res) 
	{
		var remoteAddress = ipv4(req.connection.remoteAddress);
		
		var stat = {
				bytesWrite: 0,
				ellipse: Date.now(),
		};
		
		var reqCounter = new ByteCounter();
		
		/*********************************************
		 * request proxying
		 *********************************************/
		
		var responseSent = false;
		
		if ( logEvent )
		{
			console.log(`REQ ${remoteAddress} "${req.method} ${req.url} HTTP/${req.httpVersion}"`);
		}
		
		if ( !/^http:\/\/[0-9a-z\-]+/i.test(req.url) )
		{
			res.writeHead(200);
			res.end('OK');
			return;
		}
		
		var parsed_url = url.parse(req.url);
		var requestHeaders = Object.assign(rawHeadersToMap(req.rawHeaders), {Host: parsed_url.host});
		var requestHeader = `${req.method} ${parsed_url.path} HTTP/${req.httpVersion}\r\n`;
		for ( var name in requestHeaders )
		{
			if ( requestHeaders.hasOwnProperty(name) )
			{
				requestHeader += (lowerCaseHeaderName ? (name + '').toLowerCase() : name) 
								+ ': ' + requestHeaders[name] + '\r\n';
			}
		}
		requestHeader += '\r\n';
		
		var session = workerPool.createSession('HTTP', [req.method]);
		var resParser = new HTTPParser(HTTPParser.RESPONSE);
		
		session.write(requestHeader);
		req.pipe(reqCounter).pipe(session);
		
		/*********************************************
		 * respose parser events
		 *********************************************/
		
		resParser.onHeadersComplete = function(info) {
			if ( logEvent )
			{
				console.log('server "request" resParser "onHeaderComplete"');
			}
			var responseHeaders = rawHeadersToMap(info.headers);
			stat.statusCode = info.statusCode;
			res.writeHead(info.statusCode, info.statusMessage, responseHeaders);
			responseSent = true;
		};
		
		resParser.onBody = function(data, offset, len) {
			//console.log('server "request" resParser "onBody"');
			var chunk = data.slice(offset, offset + len);
			stat.bytesWrite += chunk.length;
			//console.log(`recv body: ${chunk.length}`);
			res.write(chunk);
		};
		
		resParser.onHeaders = function(headers) {
			if ( logEvent )
			{
				console.log('server "request" resParser "onHeaders"');
			}
			var trailers = rawHeadersToMap(headers);
			res.addTrailers(trailers);
		};
		
		resParser.onMessageComplete = function() {
			if ( logEvent )
			{
				console.log('server "request" resParser "onMessageComplete"');
			}
			res.end();
		};
	
		/*********************************************
		 * worker session events
		 *********************************************/
		
		session.on('data', (chunk) => {
			//console.log('server "request" session "data"');
			resParser.execute(chunk);
		});
		
		session.on('end', () => {
			if ( logEvent )
			{
				console.log('server "request" session "end"');
			}
			resParser.finish();
		});
		
		function onSessionCloseOrError()
		{
			if ( !responseSent )
			{
				stat.statusCode = 500;
				res.writeHead(500, 'Connection Error');
				responseSent = true;
			}
			res.end();
		}
		
		session.on('close', (e) => {
			if ( e ) 
			{
				if ( logError )
				{
					console.log('server "request" session "close"');
					console.log(e);
				}
			}
			onSessionCloseOrError();
		});
		
		session.on('error', (e) => {
			if ( logError )
			{
				console.log('server "request" session "error"');
				console.log(e);
			}
			onSessionCloseOrError();
		});
	
		/*********************************************
		 * req handler
		 *********************************************/
	
		function onRequestCloseOrError()
		{
			session.destroy();
		}
	
		// request has been aborted by the client and the network socket has closed.
		req.on('aborted', () => {
			if ( logEvent )
			{
				console.log('server "request" req "aborted"');
			}
			onRequestCloseOrError();
		});
		
		// Indicates that the underlying connection was closed. Just like 'end', this event occurs only once per response.
		req.on('close', () => {
			if ( logEvent )
			{
				console.log('server "request" req "close"');
			}
			onRequestCloseOrError();
		});
		
		req.on('error', (e) => {
			if ( logError )
			{
				console.log('server "request" req "error"');
				console.log(e);
			}
			onRequestCloseOrError();
		});
		
		/*********************************************
		 * res handler
		 *********************************************/
		
		// Emitted when the response has been sent		
		res.on('finish', () => {
			if ( logEvent )
			{
				console.log('server "request" res "finish"');
			}
			
			if ( logAccess )
			{
				stat.ellipse = Date.now() - stat.ellipse;
				console.log(`RES ${remoteAddress} "${req.method} ${req.url} HTTP/${req.httpVersion}" ${stat.statusCode} ${reqCounter.bytesPiped} ${stat.bytesWrite} ${stat.ellipse}`);
			}
		});
		
		// Indicates that the underlying connection was terminated before response.end() was called or able to flush.
		res.on('close', () => {
			if ( logEvent )
			{
				console.log('server "request" res "close"');
			}
			onRequestCloseOrError();
		});
	
		res.on('error', (e) => {
			if ( logEvent )
			{
				console.log('server "request" res "error"');
			}
			onRequestCloseOrError();
		});
	}
	
	return {
		proxyConnect: proxyConnect,
		proxyRequest: proxyRequest,
	};
}

module.exports = {
		createElasticHandler: createElasticHandler	
};