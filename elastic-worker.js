// jshint esversion: 6

'use strict';

const http = require('http');
const url = require('url');
const net = require('net');
const stream = require('stream');
const HTTPParser = require('http-parser-js').HTTPParser;
const rnju = require('@rankwave/nodejs-util');
const zlib = require('zlib');

const Transform = stream.Transform;
const ByteCounter = rnju.stream.ByteCounter;
const rawHeadersToMap = rnju.http.rawHeadersToMap;
const getOption = rnju.common.getOption;

/*
 * HTTPParser {
 *	  '0': [Function],
 *	  '1': [Function],
 *	  '2': [Function],
 *	  '3': [Function],
 *	  type: 'REQUEST',
 *	  state: 'HEADER',
 *	  info: 
 *	   { headers: [ 'User-Agent', 'dmlim-proxy/1.2' ],
 *	     upgrade: true,
 *	     method: 'CONNECT',
 *	     url: 'www.nate.com:80',
 *	     versionMajor: 1,
 *	     versionMinor: 1,
 *	     shouldKeepAlive: true },
 *	  trailers: [],
 *	  line: '',
 *	  isChunked: false,
 *	  connection: '',
 *	  headerSize: 0,
 *	  body_bytes: 0,
 *	  isUserCall: true,
 *	  hadError: false,
 *	  _compatMode0_11: true,
 *	  chunk: <Buffer 43 4f 4e ... >,
 *	  offset: 65,
 *	  end: 83 }
 */

function createElasticWorker(options) {
	var logEvent = getOption(options, 'logEvent', false);
	var logError = getOption(options, 'logError', true);
	var logAccess = getOption(options, 'logAccess', true);
	var compressRequest = getOption(options, 'compressRequest', false);

	function onConnect(info, session, head) {
		if (logEvent) {
			console.log('onConnect');
			console.log(`REQ "${info.method} ${info.url}"`);
		}

		var responseSent = false;
		var isPiped = false;

		var stat = {
			statusCode: 200,
			ellipse: Date.now(),
		};

		var reqCounter = new ByteCounter();
		var resCounter = new ByteCounter();

		const srvUrl = url.parse(`http://${info.url}`);

		/***********************
		 * server socket events 
		 ***********************/

		const srvSocket = net.connect(srvUrl.port, srvUrl.hostname, () => {

			if (logEvent) {
				console.log('onConnect srvSocket "connect"');
			}

			session.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			responseSent = true;

			if (head) {
				srvSocket.write(head);
			}

			session.pipe(reqCounter).pipe(srvSocket);
			srvSocket.pipe(resCounter).pipe(session);
			isPiped = true;
		});

		srvSocket._endEventOccured = false;

		function onSrvSocketClosedOrError() {
			if (!responseSent) {
				stat.statusCode = 500;
				session.write('HTTP/1.1 500 Connection Error\r\n\r\n');
				responseSent = true;
			}

			if (!isPiped) {
				session.end();
			}
			else if (!srvSocket._endEventOccured) {
				session.destroy();
			}
		}

		srvSocket.on('end', (had_error) => {
			if (logEvent) {
				console.log('onConnect srvSocket "end"');
			}
			srvSocket._endEventOccured = true;
			onSrvSocketClosedOrError();
		});

		srvSocket.on('close', (had_error) => {
			if (logEvent) {
				console.log('onConnect srvSocket "close"');
			}
			onSrvSocketClosedOrError();
		});

		srvSocket.on('error', (e) => {
			if (logError) {
				console.log('onConnect srvSocket "error"');
				console.log(e);
			}
			srvSocket.destroy();
			onSrvSocketClosedOrError();
		});

		/***********************
		 * session events 
		 ***********************/

		function onSessionCloseOrError() {
			if (!isPiped) {
				srvSocket.destroy();
			}
		}

		session.on('end', () => {
			if (logEvent) {
				console.log('onConnect session "end"');
			}
			onSessionCloseOrError();
		});

		session.on('close', (had_error) => {
			if (logEvent) {
				console.log('onConnect session "close"');
			}

			if (logAccess) {
				stat.ellipse = Date.now() - stat.ellipse;
				console.log(`RES ${session.address} "${info.method} ${info.url}" ${stat.statusCode} ${reqCounter.bytesPiped} ${resCounter.bytesPiped} ${stat.ellipse}`);
			}
			onSessionCloseOrError();
		});

		session.on('error', (e) => {
			if (logError) {
				console.log('onConnect session "error"');
				console.log(e);
			}
			session.destroy();
			onSessionCloseOrError();
		});

	}

	function onHttpConnectSession(session) {
		if (logEvent) {
			console.log('onHttpConnectSession');
		}

		var reqParser = new HTTPParser(HTTPParser.REQUEST);

		/******************************
		 * reqParser events
		 ******************************/

		reqParser.onHeadersComplete = function (info) {
			if (logEvent) {
				console.log('onHttpSession reqParser "onHeadersComplete"');
			}
			session.removeAllListeners('data');
			session.removeAllListeners('error');
			var head = null;
			if (reqParser.end > reqParser.offset) {
				head = reqParser.chunk.slice(reqParser.offset, reqParser.end);
			}
			onConnect(info, session, head);
		};

		reqParser.onBody = function (data, offset, len) {
			if (logEvent) {
				console.log('onHttpSession reqParser "onBody"');
				console.log(`len: ${len}`);
			}
		};

		reqParser.onHeaders = function (headers) {
			if (logEvent) {
				console.log('onHttpSession reqParser "onHeaders"');
			}
		};

		reqParser.onMessageComplete = function () {
			if (logEvent) {
				console.log('onHttpSession reqParser "onMessageComplete"');
			}
		};

		/******************************
		 * session events
		 ******************************/

		session.on('data', (chunk) => {
			reqParser.execute(chunk);
		});

		session.on('error', (e) => {
			if (logError) {
				console.log('onHttpConnectSession session "error"');
				console.log(e);
			}
		});
	}

	function infoToRequestOptions(info) {
		var request_url = '';
		var requestHeaders = rawHeadersToMap(info.headers);
		requestHeaders.Connection = 'Keep-Alive';

		if (/^http:\/\//.test(info.url)) {
			request_url = info.url;
		}
		else {
			var host = 'localhost';
			for (var name in requestHeaders) {
				if (name.toLowerCase() === 'host') {
					host = requestHeaders[name];
				}
			}
			request_url = `http://${host}${info.url}`;
		}

		var parsed_url = url.parse(request_url);
		return Object.assign({}, parsed_url, { method: info.method, headers: requestHeaders });
	}

	function onHttpRequestSession(session) {
		if (logEvent) {
			console.log('onHttpRequestSession');
		}

		var readable = session;
		if (compressRequest) {
			readable = zlib.createGunzip();
			session.pipe(readable);
		}

		var reqParser = new HTTPParser(HTTPParser.REQUEST);

		/******************************
		 * reqParser events
		 ******************************/

		var req2 = null;

		var stat = {
			bytesRead: 0,
			statusCode: 200,
			ellipse: Date.now(),
		};

		var responseSent = false;
		var isPiped = false;

		var resCounter = new ByteCounter();

		reqParser.onHeadersComplete = function (info) {

			if (logEvent) {
				console.log('onHttpSession reqParser "onHeadersComplete"');
			}

			/******************************************
			 * handle general http request
			 ******************************************/

			stat.method = info.method;
			stat.url = info.url;

			//console.log(info);
			var request_options = infoToRequestOptions(info);
			//console.log(request_options);

			req2 = http.request(request_options);

			/******************************************
			 * error handler
			 ******************************************/

			function onResponseAbortOrError(e) {
				if (!responseSent) {
					var message = e ? e.message : 'ERROR';
					var content = `<html><body>${message}</body></html>`;
					stat.statusCode = 503;
					resCounter.bytesPiped = Buffer.byteLength(content);
					var date = new Date().toUTCString();

					var response = 'HTTP/1.1 500 Server Error\r\n';
					response += 'Content-Type: text/html\r\n';
					response += `Content-Length: ${resCounter.bytesPiped}\r\n`;
					response += `Date: ${date}\r\n\r\n`;
					response += content;

					session.write(response);
					responseSent = true;
				}

				if (!isPiped) {
					session.end();
				}
			}

			/******************************************
			 * res2 events
			 ******************************************/

			req2.on('response', (/* IncomingMessge */ res2) => {

				res2.on('abort', () => {
					if (logEvent) {
						console.log('onHttpSession reqParser "onHeadersComplete" req2 "response" res2 "abort"');
					}
					onResponseAbortOrError();
				});

				res2.on('close', () => {
					if (logEvent) {
						console.log('onHttpSession reqParser "onHeadersComplete" req2 "response" res2 "close"');
					}
					onResponseAbortOrError();
				});

				res2.on('error', (e) => {
					if (logError) {
						console.log('onHttpSession reqParser "onHeadersComplete" req2 "response" res2 "error"');
						console.log(e);
					}
					onResponseAbortOrError(e);
				});

				stat.statusCode = res2.statusCode;

				var responseHeader = `HTTP/1.1 ${res2.statusCode} ${res2.statusMessage}\r\n`;
				var responseHeaders = rawHeadersToMap(res2.rawHeaders);
				for (var name in responseHeaders) {
					if (responseHeaders.hasOwnProperty(name)) {
						responseHeader += name + ': ' + responseHeaders[name] + '\r\n';
					}
				}
				responseHeader += '\r\n';

				var writable = session;

				if (compressRequest) {
					writable = zlib.createGzip();
					writable.pipe(session);
				}

				writable.write(responseHeader);
				responseSent = true;

				res2.pipe(resCounter).pipe(writable);
				isPiped = true;
			});

			/******************************************
			 * req2 events
			 ******************************************/

			req2.on('abort', () => {
				if (logEvent) {
					console.log('onHttpSession reqParser "onHeadersComplete" req2 "abort"');
				}
			});

			req2.on('aborted', () => {
				if (logEvent) {
					console.log('onHttpSession reqParser "onHeadersComplete" req2 "aborted"');
				}
				onResponseAbortOrError(new Error('Request is aborted by the remote server.'));
			});

			req2.on('error', (e) => {
				if (logError) {
					console.log('onHttpSession reqParser "onHeadersComplete" req2 "error"');
					console.log(e);
				}
				onResponseAbortOrError(e);
			});
		};

		reqParser.onBody = function (data, offset, len) {
			if (logEvent) {
				console.log('onHttpSession reqParser "onBody"');
				console.log(`onHttpSession reqParser "onBody": len: ${len}`);
			}
			var chunk = data.slice(offset, offset + len);
			stat.bytesRead += len;
			if (req2) {
				req2.write(chunk);
			}
		};

		reqParser.onMessageComplete = function () {
			if (logEvent) {
				console.log('onHttpSession reqParser "onMessageComplete"');
			}
			if (req2) {
				req2.end();
			}
		};

		/******************************
		 * session events
		 ******************************/

		readable.on('data', (chunk) => {
			if (logEvent) {
				console.log('onHttpSession session "data"');
			}
			reqParser.execute(chunk);
		});

		readable.on('end', (had_error) => {
			if (logEvent) {
				console.log('onHttpSession session "end"');
			}
			reqParser.finish();
		});

		function onSessionCloseOrError() {
			if (!isPiped) {
				if (req2) {
					req2.abort();
				}
			}
		}

		session.on('close', (had_error) => {
			if (logEvent) {
				console.log('onHttpSession session "close"');
			}
			if (logAccess) {
				stat.ellipse = Date.now() - stat.ellipse;
				console.log(`RES ${session.address} "${stat.method} ${stat.url}" ${stat.statusCode} ${stat.bytesRead} ${resCounter.bytesPiped} ${stat.ellipse}`);
			}
			onSessionCloseOrError();
		});

		session.on('error', (e) => {
			if (logError) {
				console.log('onHttpSession session "error"');
				console.log(e);
			}
			session.destroy();
			onSessionCloseOrError();
		});
	}

	function onHttpSession(session) {
		if (logEvent) {
			console.log('onHttpSession');
		}

		var method = session.session_args[0];

		if (method === 'CONNECT') {
			onHttpConnectSession(session);
		}
		else {
			onHttpRequestSession(session);
		}
	}

	return {
		onHttpSession: onHttpSession
	};
}

module.exports = {
	createElasticWorker: createElasticWorker
};