// jshint esversion: 6

/**
 * http://usejsdoc.org/
 */

[
	'default-handler', 
	'elastic-handler', 
	'elastic-worker',
	'proxy'
].forEach((path) => Object.assign(module.exports, require(`./${path}`)));
