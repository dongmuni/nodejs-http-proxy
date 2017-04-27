// jshint esversion: 6

/**
 * http://usejsdoc.org/
 */

'use strict';

const http = require('http');
const url = require('url');
const net = require('net');
const stream = require('stream');
const Transform = stream.Transform;
const textUtil = require('../text-util');
const ByteCounter = textUtil.ByteCounter;
const rawHeadersToMap = textUtil.rawHeadersToMap;
const getOption = textUtil.getOption;

function createDefaultHandler(options)
{
	var logEvent  = getOption(options, 'logEvent', false);
	var logError  = getOption(options, 'logError', true);
	var logAccess = getOption(options, 'logAccess', true);
	
	function proxyConnect(/* IncomingMessage */ req, /* Socket */ cltSocket, /* Buffer */ head) 
	{
		if ( logEvent )
			console.log(`REQ ${cltSocket.remoteAddress} "${req.method} ${req.url} HTTP/${req.httpVersion}"`);
		
		var responseSent = false;
		
		var stat = {
				bytesRead: 0,
				bytesWrite: 0,
				statusCode: 200,
				ellipse: Date.now(),
		};
		
		var reqCounter = new ByteCounter(() => stat.bytesRead = reqCounter.bytesPiped);
		var resCounter = new ByteCounter(() => stat.bytesWrite = resCounter.bytesPiped);
		
		const srvUrl = url.parse(`http://${req.url}`);
		const srvSocket = net.connect(srvUrl.port, srvUrl.hostname, () => {
			
			cltSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			responseSent = true;
			
			srvSocket.write(head);
			
			cltSocket.pipe(reqCounter).pipe(srvSocket);
			srvSocket.pipe(resCounter).pipe(cltSocket);
		});
		
		cltSocket.on('end', (had_error) => {
			if ( logEvent )
				console.log('server "connect" cltSocket "end"');
		});
		
		cltSocket.on('close', (had_error) => {
			if ( logEvent )
				console.log('server "connect" cltSocket "close"');
			stat.ellipse = Date.now() - stat.ellipse;
			if ( logAccess )
				console.log(`RES ${cltSocket.remoteAddress} "${req.method} ${req.url} HTTP/${req.httpVersion}" ${stat.statusCode} ${stat.bytesRead} ${stat.bytesWrite} ${stat.ellipse}`);
		});
		
		cltSocket.on('error', (e) => {
			if ( logError )
			{
				console.log('server "connect" cltSocket "error"');
				console.log(e);
			}
			srvSocket.destroy();
			cltSocket.destroy();
		});
		
		srvSocket.on('end', (had_error) => {
			if ( logEvent )
				console.log('server "connect" srvSocket "end"');
		});
		
		srvSocket.on('close', (had_error) => {
			if ( logEvent )
				console.log('server "connect" srvSocket "close"');
		});
		
		srvSocket.on('error', (e) => {
			if ( !responseSent )
			{
				stat.statusCode = 500;
				cltSocket.write('HTTP/1.1 500 Connection Error\r\n\r\n');
			}
			
			if ( logError )
			{
				console.log('server "connect" srvSocket "error"');
				console.log(e);
			}
			
			cltSocket.destroy();
			srvSocket.destroy();
		});
	}
	
	function proxyRequest(/* IncomingMessage */ req, /* ServerResponse */ res) 
	{
		var stat = {
				bytesRead: 0,
				bytesWrite: 0,
				ellipse: Date.now(),
		};
		
		var reqCounter = new ByteCounter(() => stat.bytesRead = reqCounter.bytesPiped);
		var resCounter = new ByteCounter(() => stat.bytesWrite = resCounter.bytesPiped);
	
		/*********************************************
		 * req handler
		 *********************************************/
		
		// request has been aborted by the client and the network socket has closed.
		req.on('aborted', () => {
			if ( logEvent )
				console.log('server "request" req "aborted"');
		});
		
		// Indicates that the underlying connection was closed. Just like 'end', this event occurs only once per response.
		req.on('close', () => {
			if ( logEvent )
				console.log('server "request" req "close"');
		});
		
		req.on('error', (e) => {
			if ( logError )
			{
				console.log('server "request" req "error"');
				console.log(e);
			}
		});
		
		/*********************************************
		 * res handler
		 *********************************************/
		
		// Indicates that the underlying connection was terminated before response.end() was called or able to flush.
		res.on('close', () => {
			if ( logEvent )
				console.log('server "request" res "close"');
		});
	
		// Emitted when the response has been sent		
		res.on('finish', () => {
			if ( logEvent )
				console.log('server "request" res "finish"');
			
			stat.ellipse = Date.now() - stat.ellipse;
			
			if ( logAccess )
				console.log(`RES ${req.connection.remoteAddress} "${req.method} ${req.url} HTTP/${req.httpVersion}" ${stat.statusCode} ${stat.bytesRead} ${stat.bytesWrite} ${stat.ellipse}`);
		});
		
		res.on('error', (e) => {
			if ( logError )
			{
				console.log('server "request" res "error"');
				console.log(e);
			}
		});
		
		/*********************************************
		 * request proxying
		 *********************************************/
		
		if ( logEvent )
			console.log(`REQ ${req.connection.remoteAddress} "${req.method} ${req.url} HTTP/${req.httpVersion}"`);
		
		if ( !/^http:\/\/[0-9a-z\-]+/i.test(req.url) )
		{
			res.writeHead(404);
			res.end();
			return;
		}
		
		var parsed_url = url.parse(req.url);
		//console.log(parsed_url);
		//console.log(req.rawHeaders);
	
		var requestHeaders = rawHeadersToMap(req.rawHeaders);
		requestHeaders.Connection = 'Keep-Alive';
		var request_options = Object.assign({}, parsed_url, {method: req.method, headers: requestHeaders});
		
		/* ClientRequest */
		var req2 = http.request(request_options);
		
		var responseSent = false;
		
		req2.on('response', (/* IncomingMessge */ res2) => {
			
			res2.on('abort', () => {
				if ( logEvent )
					console.log('server "request" req2 "response" res2 "abort"');
			});
			
			res2.on('close', () => {
				if ( logEvent )
					console.log('server "request" req2 "response" res2 "close"');
			});
			
			res2.on('error', (e) => {
				if ( logError )
				{
					console.log('server "request" req2 "response" res2 "error"');
					console.log(e);
				}
			});
			
			//console.log(res2);
			
			stat.statusCode = res2.statusCode;
			res.writeHead(res2.statusCode, res2.statusMessage, rawHeadersToMap(res2.rawHeaders));
			responseSent = true;
			
			res2.pipe(resCounter).pipe(res);
		});
		
		req2.on('abort', () => {
			if ( logEvent )
				console.log('server "request" req2 "abort"');
		});
		
		req2.on('aborted', () => {
			if ( logEvent )
				console.log('server "request" req2 "aborted"');
		});
		
		req2.on('connect', (/* IncomingMessage*/ res2, /* Socket */ socket, /* Buffer */ head) => {
			if ( logEvent )
				console.log('server "request" req2 "connect"');
		});
		
		req2.on('continue', () => {
			if ( logEvent )
				console.log('server "request" req2 "continue"');
		});
		
		req2.on('socket', (/* Socket */ socket) => {
			if ( logEvent )
				console.log('server "request" req2 "socket"');
		});
		
		req2.on('upgrade', (/* IncomingMessage*/ res2, /* Socket */ socket, /* Buffer */ head) => {
			if ( logEvent )
				console.log('server "request" req2 "upgrade"');
		});
		
		req2.on('error', (e) => {
			if ( !responseSent )
			{
				var content = `<html><body>${e.message}</body></html>`;
				stat.statusCode = 503;
				stat.bytesWrite = Buffer.byteLength(content);
				res.writeHead(503, 'Resource Unavailable');
				res.end(content);
				responseSent = true;
			}
			else
			{
				res.end();
			}
			
			req2.abort();
			
			if ( logError )
			{
				console.log('server "request" req2 "error"');
				console.log(e);
			}
		});
		
		req.pipe(reqCounter).pipe(req2);
	}
	
	return {
		proxyConnect: proxyConnect,
		proxyRequest: proxyRequest	
	};
}

module.exports = {
		createDefaultHandler: createDefaultHandler
};